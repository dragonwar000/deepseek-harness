/**
 * A sign-in in a real Loader composition reaches the chat model picker.
 *
 * The picker's list is `llm.listProviders()` joined with `llm.listModels()`
 * (through the session controller's model catalog), so those two reads are
 * what these tests assert: a signed-in provider must appear in both without a
 * restart and without a `providers` profile, and leave both on sign-out.
 *
 * Only the vendor's browser conversation is doubled. Everything else — the
 * Loader, the credential store on disk, the authorization seam, the pi-ai
 * collection, and the route registry — is the shipped code.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { Credential } from '@earendil-works/pi-ai'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

/** What the doubled login commits, set per test before the attempt runs. */
const granted = vi.hoisted(() => ({ credential: undefined as Credential | undefined }))

// pi-ai's own `login` is the one external conversation here: it opens a browser
// or polls a device endpoint. Everything else on the collection stays real, so
// the adapter still resolves this route's catalog through the shipped code.
vi.mock('../src/models.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/models.ts')>()
  return {
    ...original,
    createModels: (options?: Parameters<typeof original.createModels>[0]) => {
      const models = original.createModels(options)
      return Object.assign(models, {
        login: async (providerId: string): Promise<Credential | undefined> => {
          if (granted.credential === undefined) throw new Error('the test set no credential to grant')
          // Exactly where a real pi-ai login leaves it: the harness store,
          // through the same `CredentialStore` the adapter reads.
          await options?.credentials?.modify(providerId, () => Promise.resolve(granted.credential))
          return granted.credential
        },
      })
    },
  }
})

const LlmPiAi = await import('@deepseek-ai/dsh-llm-pi-ai')
const { recordKeyFor } = LlmPiAi

let root: string | undefined
let context: Context | undefined

beforeEach(() => { granted.credential = undefined })

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the dormant composition with the credential store and the sign-in seam. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-sign-in-'))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath }
}

/** Run one real authorization attempt, granting `credential` at the end of it. */
async function signIn(ctx: Context, provider: string, method: string, credential: Credential): Promise<void> {
  granted.credential = credential
  await expect(ctx.authorization.begin({
    key: recordKeyFor(provider),
    method,
    interaction: { notify: () => undefined, prompt: () => Promise.reject(new Error('unexpected prompt')) },
  })).resolves.toEqual({ status: 'authorized' })
}

/** The route ids the chat model picker would list, with their model counts. */
async function pickerRoutes(ctx: Context): Promise<Record<string, number>> {
  const listed: Record<string, number> = {}
  for (const provider of ctx.llm.listProviders()) {
    listed[provider.id] = (await ctx.llm.listModels(provider.id)).length
  }
  return listed
}

describe('a sanctioned sign-in in a real composition', () => {
  it('puts the provider and its catalog models in the picker, with no profile and no restart', async () => {
    const { ctx } = await loadComposition()
    // The shipped posture: the sign-in is offered, no route exists.
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.authorization.describe(recordKeyFor('deepseek'))?.methods.map(one => one.id)).toEqual(['api-key'])

    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })

    await vi.waitFor(async () => {
      expect(Object.keys(await pickerRoutes(ctx))).toEqual(['deepseek'])
    }, { timeout: 5000 })
    // The models are the installed catalog's, which is what makes the route
    // usable without anyone describing it.
    const models = await ctx.llm.listModels('deepseek')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === 'deepseek')).toBe(true)
    // The route authenticates from the stored record, so the profile the user
    // never wrote stays absent.
    expect(await ctx.credentials.readRecord(recordKeyFor('deepseek')))
      .toEqual({ kind: 'api-key', key: 'sk-test-key' })
  })

  it('takes the route and its models away again on sign-out', async () => {
    const { ctx } = await loadComposition()
    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })
    await vi.waitFor(async () => {
      expect(Object.keys(await pickerRoutes(ctx))).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // Signing out is the documented `deleteRecord` on the stored record.
    await ctx.credentials.deleteRecord(recordKeyFor('deepseek'))

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([])
    }, { timeout: 5000 })
    await expect(ctx.llm.listModels('deepseek')).rejects.toThrow(/deepseek/)
  })

  it('activates an OAuth grant the vendor issues to third-party clients', async () => {
    const { ctx } = await loadComposition()
    await signIn(ctx, 'openrouter', 'oauth', {
      type: 'oauth', access: 'at', refresh: 'rt', expires: Date.now() + 3_600_000,
    })

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openrouter'])
    }, { timeout: 5000 })
  })
})

describe('a consumer-subscription sign-in in a real composition', () => {
  it('stores the account but registers no main-model route', async () => {
    const { ctx } = await loadComposition()
    await signIn(ctx, 'openai-codex', 'oauth', {
      type: 'oauth', access: 'at', refresh: 'rt', expires: Date.now() + 3_600_000,
    })

    // The grant is stored — the account exists, and delegated runs can use it.
    expect(await ctx.credentials.readRecord(recordKeyFor('openai-codex'))).toMatchObject({ kind: 'grant' })

    // Nothing may send it as this harness's own credential, so the picker
    // stays empty. Asserted after a sanctioned sign-in has landed, so this is
    // not merely observing that activation had not run yet.
    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })
    await vi.waitFor(async () => {
      expect(Object.keys(await pickerRoutes(ctx))).toEqual(['deepseek'])
    }, { timeout: 5000 })
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('openai-codex')
  })

  it('withholds an Anthropic subscription grant while its API key activates the same route', async () => {
    const { ctx } = await loadComposition()
    await signIn(ctx, 'anthropic', 'oauth', {
      type: 'oauth', access: 'subscription-access-token', refresh: 'rt', expires: Date.now() + 3_600_000,
    })
    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })
    await vi.waitFor(async () => {
      expect(Object.keys(await pickerRoutes(ctx))).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // The alternative the product points at: the same record id, the other
    // method. One record per provider, so this replaces the grant.
    await signIn(ctx, 'anthropic', 'api-key', { type: 'api_key', key: 'sk-ant-api-test' })
    await vi.waitFor(async () => {
      expect(Object.keys(await pickerRoutes(ctx)).toSorted()).toEqual(['anthropic', 'deepseek'])
    }, { timeout: 5000 })
  })
})

describe('settings-declared routes beside a sign-in', () => {
  it('keeps a declared profile in charge of its own route', async () => {
    const { ctx, settingsPath } = await loadComposition()
    // A profile for the very provider being signed into, with the route's
    // display name and catalog narrowed the way the Models page writes them.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        displayName: Pinned DeepSeek',
      '        models:',
      '          - id: deepseek-chat',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'Pinned DeepSeek' }])
    }, { timeout: 5000 })

    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })

    // The sign-in authenticates the declared route; it does not replace it, so
    // the narrowed catalog and the label both survive.
    await vi.waitFor(async () => {
      expect(await pickerRoutes(ctx)).toEqual({ deepseek: 1 })
    }, { timeout: 5000 })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'Pinned DeepSeek' }])
  })

  it('activates a stored sign-in the moment its profile stops declaring the route', async () => {
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        displayName: Pinned DeepSeek',
      '        models:',
      '          - id: deepseek-chat',
      '',
    ].join('\n'))
    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })
    await vi.waitFor(async () => {
      expect(await pickerRoutes(ctx)).toEqual({ deepseek: 1 })
    }, { timeout: 5000 })

    // The profile goes away; the stored sign-in keeps the route alive, now
    // serving the whole installed catalog instead of the narrowed list.
    await writeFile(settingsPath, '[]\n')
    await vi.waitFor(async () => {
      const listed = await pickerRoutes(ctx)
      expect(Object.keys(listed)).toEqual(['deepseek'])
      expect(listed.deepseek).toBeGreaterThan(1)
    }, { timeout: 5000 })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek', name: 'deepseek' }])
  })

  it('withdraws and then refuses sign-in routes when the deployment pins its routes', async () => {
    const { ctx, settingsPath } = await loadComposition()
    await signIn(ctx, 'deepseek', 'api-key', { type: 'api_key', key: 'sk-test-key' })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // Turning activation off takes the route back, leaving the stored sign-in
    // in place: the credential is still the account holder's, it simply drives
    // nothing this deployment did not declare.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    signInRoutes: false',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([])
    }, { timeout: 5000 })
    expect(await ctx.credentials.readRecord(recordKeyFor('deepseek'))).toEqual({ kind: 'api-key', key: 'sk-test-key' })

    // A sign-in arriving while it is off adds nothing either.
    await signIn(ctx, 'openrouter', 'oauth', {
      type: 'oauth', access: 'at', refresh: 'rt', expires: Date.now() + 3_600_000,
    })
    await vi.waitFor(async () => {
      expect(await ctx.credentials.readRecord(recordKeyFor('openrouter'))).not.toBeUndefined()
    }, { timeout: 5000 })
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
