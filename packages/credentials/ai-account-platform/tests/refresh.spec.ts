/** Account-local persistence, request coalescing, cancellation, and removal during OAuth refresh. */
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AiAccountId, AiAccountKind } from '@deepseek-ai/dsh-ai-account'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlatformAiAccount, { type Config } from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
})
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-cli.cjs', import.meta.url))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function mount(kind: AiAccountKind = 'claude', config: Config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-refresh-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const id = randomUUID() as AiAccountId
  const home = join(root, kind === 'claude' ? 'claude' : 'codex', id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'fake-signed-in'), 'yes')
  const file = join(home, kind === 'claude' ? '.credentials.json' : 'auth.json')
  const original = kind === 'claude'
    ? { extra: 'kept', claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, subscriptionType: 'max' } }
    : { extra: 'kept', tokens: { access_token: 'opaque', refresh_token: 'old-refresh', id_token: 'id-kept', account_id: 'account-kept' } }
  await writeFile(file, JSON.stringify(original), { mode: 0o600 })
  await writeFile(join(root, 'accounts.json'), JSON.stringify({ version: 1,
    accounts: [{ id, kind, email: 'test@example.com', plan: null, createdAt: 1 }], defaults: { [kind]: id },
  }))
  // Fake CLI chooses a kind from its basename; put it outside that kind's directory.
  const bin = join(root, 'bin')
  await mkdir(bin)
  const cli = join(bin, kind === 'claude' ? 'claude' : 'codex')
  copyFileSync(FAKE_CLI, cli)
  chmodSync(cli, 0o755)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(PlatformAiAccount, { root, claudeCliPath: cli, codexCliPath: cli, statusCheckIntervalMs: 0, ...config })
  return { ctx, service: ctx.aiAccount, kind, home, file, original, id }
}

const ready = (): Response => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3_600 })
const signal = (): AbortSignal => new AbortController().signal

describe('account credential maintenance', () => {
  it.each(['claude', 'chatgpt'] as const)('persists rotated %s credentials and keeps snapshots free of tokens', async (kind) => {
    const fixture = await mount(kind)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ready())
    vi.stubGlobal('fetch', fetch)
    await fixture.service.prepareHome(kind, fixture.home, signal())
    const saved: unknown = JSON.parse(readFileSync(fixture.file, 'utf8'))
    expect(saved).toMatchObject(kind === 'claude'
      ? { extra: 'kept', claudeAiOauth: { accessToken: 'new-access', refreshToken: 'new-refresh', subscriptionType: 'max' } }
      : { extra: 'kept', tokens: { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'id-kept', account_id: 'account-kept' } })
    expect(JSON.stringify(await fixture.service.getState())).not.toMatch(/old-refresh|new-refresh|new-access/)
    if (process.platform !== 'win32') expect(statSync(fixture.file).mode & 0o777).toBe(0o600)
    await fixture.service.prepareHome(kind, fixture.home, signal())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('joins simultaneous launches and a status check for the same account', async () => {
    const fixture = await mount()
    const entered = deferred<undefined>()
    const reply = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(undefined); return reply.promise })
    vi.stubGlobal('fetch', fetch)
    const first = fixture.service.prepareHome('claude', fixture.home, signal())
    await entered.promise
    const second = fixture.service.prepareHome('claude', fixture.home, signal())
    const status = fixture.service.checkStatus()
    reply.resolve(ready())
    await Promise.all([first, second, status])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await fixture.service.getState()).accounts[0]!.status.status).toBe('signedIn')
  })

  it('serializes refreshes from independent provider instances sharing one account directory', async () => {
    const fixture = await mount()
    const other = new Context()
    cleanups.push(() => other.fiber.dispose())
    await other.plugin(LocalSubprocessRuntime)
    await other.plugin(PlatformAiAccount, { root: join(fixture.home, '..', '..'), statusCheckIntervalMs: 0 })
    const entered = deferred<undefined>()
    const reply = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(undefined); return reply.promise })
    vi.stubGlobal('fetch', fetch)
    const first = fixture.service.prepareHome('claude', fixture.home, signal())
    await entered.promise
    const second = other.aiAccount.prepareHome('claude', fixture.home, signal())
    reply.resolve(ready())
    await Promise.all([first, second])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves a login replacement that arrives while the token request is running', async () => {
    const fixture = await mount()
    const entered = deferred<undefined>()
    const reply = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(undefined); return reply.promise }))
    const run = fixture.service.prepareHome('claude', fixture.home, signal())
    await entered.promise
    const replacement = JSON.stringify({ claudeAiOauth: { accessToken: 'replacement', refreshToken: 'replacement-refresh', expiresAt: Date.now() + 3_600_000 } })
    await writeFile(fixture.file, replacement)
    reply.resolve(ready())
    await run
    expect(await readFile(fixture.file, 'utf8')).toBe(replacement)
  })

  it('retains credentials on a transient failure and retries on the next launch', async () => {
    const fixture = await mount()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('secret', { status: 503 })).mockResolvedValueOnce(ready())
    vi.stubGlobal('fetch', fetch)
    await expect(fixture.service.prepareHome('claude', fixture.home, signal())).rejects.toThrow('HTTP 503')
    expect(JSON.parse(await readFile(fixture.file, 'utf8'))).toEqual(fixture.original)
    expect((await fixture.service.getState()).accounts[0]!.status.status).toBe('unknown')
    await fixture.service.prepareHome('claude', fixture.home, signal())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected grant as signed out without exposing its response', async () => {
    const fixture = await mount()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response('secret rejection', { status: 400 })))
    const changes: string[] = []
    fixture.ctx.on('ai-account/status-changed', (change) => { changes.push(change.current.status) })
    const view = await fixture.service.checkStatus()
    expect(view.accounts[0]!.status).toMatchObject({ status: 'signedOut', message: 'The account authorization expired or was revoked. Sign in again.' })
    expect(changes).toEqual(['signedOut'])
    expect(JSON.stringify(view)).not.toContain('secret rejection')
    expect(JSON.parse(await readFile(fixture.file, 'utf8'))).toEqual(fixture.original)
  })

  it('cancels one waiting caller without cancelling another caller or the shared refresh', async () => {
    const fixture = await mount()
    const entered = deferred<undefined>()
    const reply = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(undefined); return reply.promise }))
    const controller = new AbortController()
    const first = fixture.service.prepareHome('claude', fixture.home, controller.signal)
    const rejected = expect(first).rejects.toThrow('caller stopped')
    await entered.promise
    const second = fixture.service.prepareHome('claude', fixture.home, signal())
    controller.abort(new Error('caller stopped'))
    await rejected
    reply.resolve(ready())
    await second
    expect(JSON.parse(await readFile(fixture.file, 'utf8'))).toMatchObject({ claudeAiOauth: { accessToken: 'new-access' } })
  })

  it('unloads only after a running refresh has stopped and leaves credentials unchanged', async () => {
    const fixture = await mount()
    const entered = deferred<undefined>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      entered.resolve(undefined)
      return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    }))
    const run = fixture.service.prepareHome('claude', fixture.home, signal())
    const rejected = expect(run).rejects.toThrow()
    await entered.promise
    await fixture.ctx.fiber.dispose()
    await rejected
    expect(JSON.parse(await readFile(fixture.file, 'utf8'))).toEqual(fixture.original)
  })

  it.skipIf(process.platform === 'win32')('waits for refresh before removing an account and never restores its directory', async () => {
    const fixture = await mount()
    const entered = deferred<undefined>()
    const reply = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { entered.resolve(undefined); return reply.promise }))
    const run = fixture.service.prepareHome('claude', fixture.home, signal())
    await entered.promise
    const removing = fixture.service.remove(fixture.id)
    reply.resolve(ready())
    await Promise.all([run, removing])
    expect((await fixture.service.getState()).accounts).toEqual([])
    await expect(readFile(fixture.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves unregistered homes and disabled maintenance untouched', async () => {
    const fixture = await mount('claude', { refreshEnabled: false })
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    await fixture.service.prepareHome('claude', fixture.home, signal())
    await fixture.service.prepareHome('claude', join(fixture.home, 'unregistered'), signal())
    expect(fetch).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('refuses a credential symlink without touching its target', async () => {
    const fixture = await mount()
    const original = readFileSync(fixture.file, 'utf8')
    const target = join(fixture.home, 'other')
    writeFileSync(target, original)
    rmSync(fixture.file)
    await symlink(target, fixture.file)
    await expect(fixture.service.prepareHome('claude', fixture.home, signal())).rejects.toThrow('could not be read')
    expect(readFileSync(target, 'utf8')).toBe(original)
  })
})
