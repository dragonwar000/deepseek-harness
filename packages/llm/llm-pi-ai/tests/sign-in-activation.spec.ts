/** Lifecycle edges of sign-in route activation: coalescing, failure, and disposal. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A scratch directory removed after the test. */
async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-activation-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A context with the registry, ready for a credential plane to be added. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  return ctx
}

/** The route ids currently registered. */
function routes(ctx: Context): string[] {
  return ctx.llm.listProviders().map(provider => provider.id).toSorted()
}

describe('activation over a real credential store', () => {
  it('coalesces a burst of record writes into one settled route set', async () => {
    const ctx = await boot()
    const dir = await home()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await liveConfig(ctx, LlmPiAi, {})

    // Three commits with no await between them: the first refresh is still
    // reading the store when the second and third events arrive, so they must
    // fold into one more pass rather than three.
    await Promise.all([
      ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('deepseek'), () =>
        Promise.resolve({ kind: 'api-key' as const, key: 'k1' })),
      ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('openrouter'), () =>
        Promise.resolve({ kind: 'api-key' as const, key: 'k2' })),
      ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('groq'), () =>
        Promise.resolve({ kind: 'api-key' as const, key: 'k3' })),
    ])

    await vi.waitFor(() => {
      expect(routes(ctx)).toEqual(['deepseek', 'groq', 'openrouter'])
    }, { timeout: 5000 })
  })

  it('ignores a record another plugin owns', async () => {
    const ctx = await boot()
    const dir = await home()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await liveConfig(ctx, LlmPiAi, {})

    // Another scope's record: its payload is written in a format this plugin
    // never agreed to, so it says nothing about this plugin's routes.
    await ctx.credentials.modifyRecord(credentialKey('other-plugin', 'default'), () =>
      Promise.resolve({ kind: 'grant' as const, payload: { token: 'x' } }))
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('deepseek'), () =>
      Promise.resolve({ kind: 'api-key' as const, key: 'k1' }))

    await vi.waitFor(() => {
      expect(routes(ctx)).toEqual(['deepseek'])
    }, { timeout: 5000 })
  })

  it('registers no route for a grant no installed provider can use', async () => {
    const ctx = await boot()
    const dir = await home()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await liveConfig(ctx, LlmPiAi, {})

    // A route pi-ai never shipped: nothing can derive request auth from the
    // grant, and no installed provider offers a key to point at instead.
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('acme-gateway'), () =>
      Promise.resolve({ kind: 'grant' as const, payload: { type: 'oauth', access: 'a' } }))
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('deepseek'), () =>
      Promise.resolve({ kind: 'api-key' as const, key: 'k1' }))

    await vi.waitFor(() => {
      expect(routes(ctx)).toEqual(['deepseek'])
    }, { timeout: 5000 })
  })

  it('drops the activated routes when the credential plane leaves', async () => {
    const ctx = await boot()
    const dir = await home()
    const credentials = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await credentials.await()
    await liveConfig(ctx, LlmPiAi, {})
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('deepseek'), () =>
      Promise.resolve({ kind: 'api-key' as const, key: 'k1' }))
    await vi.waitFor(() => {
      expect(routes(ctx)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A route whose store is gone could not authenticate its next request, so
    // it goes with the store rather than staying and failing.
    await credentials.dispose()
    expect(routes(ctx)).toEqual([])
  })

  it('leaves the route set alone when the credential plane leaves with nothing activated', async () => {
    const ctx = await boot()
    const dir = await home()
    const credentials = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await credentials.await()
    const live = await liveConfig(ctx, LlmPiAi, { providers: { deepseek: { models: [{ id: 'deepseek-chat' }] } } })
    await live.fiber.await()
    expect(routes(ctx)).toEqual(['deepseek'])

    await credentials.dispose()
    // The declared route never depended on the activation, so it stays.
    expect(routes(ctx)).toEqual(['deepseek'])
  })
})

describe('activation when the store cannot be read', () => {
  /** A credential plane whose record listing is the only method these tests reach. */
  function listingStore(listRecords: () => Promise<readonly CredentialRecordEntry[]>): Record<string, unknown> {
    return {
      listRecords,
      readRecord: () => Promise.resolve(undefined),
      modifyRecord: () => Promise.resolve(undefined),
      deleteRecord: () => Promise.resolve(),
      resolve: () => Promise.resolve(undefined),
      describe: () => Promise.resolve({ configured: false, writable: false }),
      describeRecord: () => Promise.resolve({ configured: false, writable: false }),
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    }
  }

  it('keeps the current route set and reports the failure', async () => {
    const ctx = await boot()
    ctx.provide('credentials', listingStore(() => Promise.reject(new Error('store unreadable'))) as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const live = await liveConfig(ctx, LlmPiAi, { providers: { deepseek: { models: [{ id: 'deepseek-chat' }] } } })
    await live.fiber.await()

    // A store that cannot be read says nothing about which sign-ins exist, so
    // the declared route keeps serving rather than being withdrawn.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not resolve the routes stored sign-ins activate'))
    }, { timeout: 5000 })
    expect(routes(ctx)).toEqual(['deepseek'])
  })

  it('folds events arriving mid-read into one further pass', async () => {
    const ctx = await boot()
    let release: (() => void) | undefined
    const opened = new Promise<void>((resolve) => { release = resolve })
    let listings = 0
    let stored: readonly CredentialRecordEntry[] = []
    ctx.provide('credentials', listingStore(async () => {
      listings += 1
      // Only the first listing waits, so the queued pass reads the store as it
      // stands once the burst has finished arriving.
      if (listings === 1) await opened
      return stored
    }) as never)
    const live = await liveConfig(ctx, LlmPiAi, {})

    // The mount's own read is outstanding. Two more commits announce
    // themselves while it is, and both must fold into a single further pass.
    stored = [
      { key: LlmPiAi.recordKeyFor('deepseek'), kind: 'api-key' },
      { key: LlmPiAi.recordKeyFor('groq'), kind: 'api-key' },
    ]
    ctx.emit('credentials/record-updated', LlmPiAi.recordKeyFor('deepseek'))
    ctx.emit('credentials/record-updated', LlmPiAi.recordKeyFor('groq'))
    release?.()

    await vi.waitFor(() => {
      expect(routes(ctx)).toEqual(['deepseek', 'groq'])
    }, { timeout: 5000 })
    // Two listings, not three: the burst cost one extra pass, not one each.
    expect(listings).toBe(2)
    expect(live.fiber.state).toBeDefined()
  })

  it('registers nothing when the plugin is disposed while the store is still answering', async () => {
    const ctx = await boot()
    let release: (() => void) | undefined
    const answered = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('credentials', listingStore(async () => {
      await answered
      return [{ key: LlmPiAi.recordKeyFor('deepseek'), kind: 'api-key' }]
    }) as never)
    const live = await liveConfig(ctx, LlmPiAi, {})

    // The read is outstanding; taking the plugin away now must leave the
    // registry untouched, because its disposer has already run.
    await live.fiber.dispose()
    release?.()
    await answered
    // One macrotask for the resumed read to reach the registration it must not make.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(routes(ctx)).toEqual([])
  })
})
