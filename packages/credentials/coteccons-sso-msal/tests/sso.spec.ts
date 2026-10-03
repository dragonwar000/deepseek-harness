/** Entra ID sign-in, silent refresh, sign-out, domain policy, and token-cache persistence against a fake MSAL client. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionRequiredAuthError, TokenCacheContext, type AccountInfo } from '@azure/msal-node'
import { Context } from '@deepseek-ai/cordis'
import { CotecconsSsoTokenUnavailableError, type CotecconsSsoSignInId, type CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import open from 'open'
import MsalCotecconsSso, { openInDefaultBrowser, resolveConfig, type Config } from '../src/index.ts'
import { AUTHORIZE, CLIENT, FakeMsal, TENANT, account } from './fake-msal.ts'
import { credentialCachePlugin, storedCache } from '../src/cache.ts'

vi.mock('open', () => ({ default: vi.fn(() => Promise.resolve({})) }))

const CONFIGURED = { tenantId: TENANT, clientId: CLIENT } satisfies Config
const KEY = credentialKey('coteccons-sso', 'token-cache')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

interface Fixture {
  readonly ctx: Context
  readonly sso: MsalCotecconsSso
  readonly clients: FakeMsal[]
  readonly opened: string[]
  readonly credentials: LocalCredentialProvider
  readonly path: string
}

async function mount(
  config: Config = CONFIGURED,
  options: { path?: string; openBrowser?: (url: string) => Promise<void>; realMsal?: boolean } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coteccons-sso-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const path = options.path ?? join(dir, '.credentials.yaml')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  const clients: FakeMsal[] = []
  const opened: string[] = []
  const openBrowser = options.openBrowser ?? ((url: string) => { opened.push(url); return Promise.resolve() })
  // The Loader constructs services with (ctx, config); this subclass supplies the MSAL and browser doubles.
  class FixtureSso extends MsalCotecconsSso {
    constructor(scope: Context, value: Config) {
      super(scope, value, options.realMsal === true ? {} : {
        createClient: (configuration) => { const client = new FakeMsal(configuration); clients.push(client); return client },
        openBrowser,
      })
    }
  }
  await ctx.plugin(FixtureSso, config)
  const sso = ctx.get('cotecconsSso') as MsalCotecconsSso
  return { ctx, sso, clients, opened, credentials: ctx.get('credentials') as LocalCredentialProvider, path }
}

/** @returns the latest client the provider built. */
function latest(fixture: Fixture): FakeMsal {
  const client = fixture.clients.at(-1)
  if (client === undefined) throw new Error('no msal client')
  return client
}

async function signIn(fixture: Fixture, signedIn: AccountInfo | null = account('a.nguyen@coteccons.vn')): Promise<CotecconsSsoView> {
  const started = await fixture.sso.startSignIn()
  expect(started.status).toBe('signing-in')
  await vi.waitFor(() => { expect(latest(fixture).interactive).toBeDefined() })
  await vi.waitFor(async () => { expect((await fixture.sso.getState()).status === 'signing-in' && fixture.opened.length > 0).toBe(true) })
  await latest(fixture).finish(signedIn)
  await vi.waitFor(async () => { expect((await fixture.sso.getState()).status).not.toBe('signing-in') })
  return fixture.sso.getState()
}

describe('configuration', () => {
  it('applies defaults and derives the authority from the tenant', () => {
    expect(resolveConfig(CONFIGURED)).toEqual({
      registration: { tenantId: TENANT, clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` },
      signInScopes: ['openid', 'profile', 'offline_access', 'https://cognitiveservices.azure.com/.default'],
      aiScope: 'https://cognitiveservices.azure.com/.default',
      allowedDomains: [],
      openBrowser: true,
      signInTimeoutMs: 300_000,
      m365: {},
    })
    expect(resolveConfig({ ...CONFIGURED, authority: 'https://login.example.test/tenant' }).registration)
      .toMatchObject({ authority: 'https://login.example.test/tenant' })
    expect(resolveConfig({ clientId: CLIENT }).registration).toEqual({ missing: ['tenantId'] })
  })

  it('rejects malformed identifiers, authorities, and domains at load', () => {
    expect(() => resolveConfig({ clientId: 'not-a-guid' })).toThrow()
    expect(() => resolveConfig({ tenantId: 'bad tenant' })).toThrow()
    expect(() => resolveConfig({ ...CONFIGURED, authority: 'http://login.microsoftonline.com/x' })).toThrow()
    expect(() => resolveConfig({ ...CONFIGURED, allowedDomains: ['Coteccons.VN'] })).toThrow()
    expect(() => resolveConfig({ ...CONFIGURED, signInTimeoutMs: 5 })).toThrow()
  })
})

describe('MsalCotecconsSso', () => {
  it('reports not-configured without building an MSAL client and refuses tokens', async () => {
    const fixture = await mount({})
    expect(await fixture.sso.getState()).toEqual({ status: 'not-configured', missing: ['tenantId', 'clientId'] })
    expect(await fixture.sso.startSignIn()).toEqual({ status: 'not-configured', missing: ['tenantId', 'clientId'] })
    expect(fixture.clients).toEqual([])
    await expect(fixture.sso.getAccessToken(fixture.sso.aiScope)).rejects.toMatchObject({ reason: 'not-configured' })
    expect(fixture.sso.aiScope).toBe('https://cognitiveservices.azure.com/.default')
  })

  it('signs in through the browser, persists the cache in the credential store, and restores it on the next boot', async () => {
    const fixture = await mount()
    expect(await fixture.sso.getState()).toEqual({ status: 'signed-out' })
    await expect(fixture.sso.getAccessToken('scope')).rejects.toBeInstanceOf(CotecconsSsoTokenUnavailableError)
    const state = await signIn(fixture)
    expect(state).toEqual({ status: 'signed-in', account: { name: 'Nguyen Van A', username: 'a.nguyen@coteccons.vn', tenantId: TENANT } })
    expect(fixture.opened).toEqual([AUTHORIZE])
    const request = latest(fixture).interactive?.request
    expect(request?.scopes).toEqual(['openid', 'profile', 'offline_access', 'https://cognitiveservices.azure.com/.default'])
    expect(request?.prompt).toBe('select_account')
    expect(latest(fixture).configuration.auth).toEqual({ clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` })

    const record = await fixture.credentials.readRecord(KEY)
    expect(record?.kind).toBe('grant')
    expect(storedCache(record, { clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` })).toContain('a.nguyen@coteccons.vn')
    expect(readFileSync(fixture.path, 'utf8')).toContain('coteccons-sso/token-cache')

    const restarted = await mount(CONFIGURED, { path: fixture.path })
    expect(await restarted.sso.getState()).toMatchObject({ status: 'signed-in', account: { username: 'a.nguyen@coteccons.vn' } })
  })

  it('keeps only the newly signed-in account and joins an active attempt', async () => {
    const fixture = await mount()
    await signIn(fixture, account('first@coteccons.vn'))
    await fixture.sso.signOut()
    const started = await fixture.sso.startSignIn()
    expect(await fixture.sso.startSignIn()).toEqual(started)
    await vi.waitFor(() => { expect(latest(fixture).interactive).toBeDefined() })
    latest(fixture).accounts = [account('stale@coteccons.vn')]
    await latest(fixture).finish(account('second@coteccons.vn', null))
    await vi.waitFor(async () => { expect((await fixture.sso.getState()).status).toBe('signed-in') })
    expect(await fixture.sso.getState()).toEqual({
      status: 'signed-in', account: { name: null, username: 'second@coteccons.vn', tenantId: TENANT },
    })
    expect((await latest(fixture).getAllAccounts()).map(entry => entry.username)).toEqual(['second@coteccons.vn'])
    expect(await fixture.sso.startSignIn()).toMatchObject({ status: 'signed-in' })
  })

  it('refreshes tokens silently for the requested scope and honors caller cancellation', async () => {
    const fixture = await mount()
    await signIn(fixture)
    expect(await fixture.sso.getAccessToken(fixture.sso.aiScope)).toBe('access:https://cognitiveservices.azure.com/.default')
    expect(latest(fixture).silent).toHaveBeenLastCalledWith({
      account: expect.objectContaining({ username: 'a.nguyen@coteccons.vn' }) as AccountInfo, scopes: [fixture.sso.aiScope],
    })
    const aborted = new AbortController()
    aborted.abort(new Error('caller stopped'))
    await expect(fixture.sso.getAccessToken('scope', aborted.signal)).rejects.toThrow('caller stopped')
    const late = new AbortController()
    latest(fixture).silent.mockReturnValueOnce(new Promise(() => {}))
    const pending = fixture.sso.getAccessToken('scope', late.signal)
    late.abort(new Error('late stop'))
    await expect(pending).rejects.toThrow('late stop')
    const live = new AbortController()
    expect(await fixture.sso.getAccessToken('scope', live.signal)).toBe('access:scope')
    const failure = new Error('network down')
    latest(fixture).silent.mockRejectedValueOnce(failure)
    await expect(fixture.sso.getAccessToken('scope')).rejects.toBe(failure)
    expect((await fixture.sso.getState()).status).toBe('signed-in')
  })

  it('signs out when Entra ID requires interaction and reports the expired session', async () => {
    const fixture = await mount()
    await signIn(fixture)
    latest(fixture).silent.mockRejectedValueOnce(new InteractionRequiredAuthError('invalid_grant', 'correlation'))
    await expect(fixture.sso.getAccessToken('scope')).rejects.toMatchObject({ reason: 'session-expired' })
    expect(await fixture.sso.getState()).toEqual({ status: 'error', errorCode: 'session-expired' })
    expect(await fixture.credentials.readRecord(KEY)).toBeUndefined()
    await expect(fixture.sso.getAccessToken('scope')).rejects.toMatchObject({ reason: 'signed-out' })
  })

  it('signs out by deleting the cache record', async () => {
    const fixture = await mount()
    await signIn(fixture)
    expect(await fixture.sso.signOut()).toEqual({ status: 'signed-out' })
    expect(await fixture.credentials.readRecord(KEY)).toBeUndefined()
    expect((await latest(fixture).getAllAccounts())).toEqual([])
    const restarted = await mount(CONFIGURED, { path: fixture.path })
    expect(await restarted.sso.getState()).toEqual({ status: 'signed-out' })
  })

  it('rejects accounts outside the allowed domains and discards their tokens', async () => {
    const fixture = await mount({ ...CONFIGURED, allowedDomains: ['coteccons.vn'] })
    expect(await signIn(fixture, account('guest@gmail.com'))).toEqual({ status: 'error', errorCode: 'domain-not-allowed' })
    expect(await fixture.credentials.readRecord(KEY)).toBeUndefined()
    expect(await signIn(fixture, account('no-domain'))).toEqual({ status: 'error', errorCode: 'domain-not-allowed' })
    expect(await signIn(fixture, null)).toEqual({ status: 'error', errorCode: 'domain-not-allowed' })
    expect(await signIn(fixture, account('B.Tran@Coteccons.VN'))).toMatchObject({ status: 'signed-in' })
    const narrowed = await mount({ ...CONFIGURED, allowedDomains: ['ctd.vn'] }, { path: fixture.path })
    expect(await narrowed.sso.getState()).toEqual({ status: 'signed-out' })
  })

  it('cancels a pending sign-in by releasing the loopback listener', async () => {
    const fixture = await mount()
    const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      latest(fixture).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response('ok'))
    })
    const started = await fixture.sso.startSignIn()
    if (started.status !== 'signing-in') throw new Error('expected an attempt')
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toMatchObject({ url: AUTHORIZE }) })
    expect(await fixture.sso.cancelSignIn('other' as CotecconsSsoSignInId)).toMatchObject({ status: 'signing-in' })
    expect(await fixture.sso.cancelSignIn(started.attemptId)).toEqual({ status: 'signed-out' })
    expect(fetches).toHaveBeenCalledExactlyOnceWith(new URL('http://127.0.0.1:53123/'), expect.objectContaining({
      method: 'POST', body: 'error=access_denied&error_description=cancelled',
    }) as RequestInit)
  })

  it('releases the listener when cancellation precedes the browser hand-off and when the release fails', async () => {
    const fixture = await mount(CONFIGURED, { openBrowser: () => Promise.reject(new Error('no display')) })
    const release = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('refused'))
    let hold: (() => void) | undefined
    const client = await vi.waitFor(() => latest(fixture))
    client.acquireTokenInteractive = request => new Promise((_resolve, reject) => {
      client.interactive = { request, resolve: () => {}, reject }
      hold = () => { void request.openBrowser(AUTHORIZE).then(() => { reject(new Error('listener closed')) }) }
    })
    const started = await fixture.sso.startSignIn()
    if (started.status !== 'signing-in') throw new Error('expected an attempt')
    const cancelled = fixture.sso.cancelSignIn(started.attemptId)
    hold?.()
    expect(await cancelled).toEqual({ status: 'signed-out' })
    expect(release).toHaveBeenCalledOnce()
    expect((await fixture.sso.getState())).toEqual({ status: 'signed-out' })
  })

  it('surfaces the sign-in link when the browser cannot open and times out an unfinished sign-in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => { vi.useRealTimers() })
    const fixture = await mount({ ...CONFIGURED, signInTimeoutMs: 10_000 }, { openBrowser: () => Promise.reject(new Error('no display')) })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => { controller.abort(new DOMException('timed out', 'TimeoutError')) }, ms)
      return controller.signal
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      latest(fixture).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response(null))
    })
    await fixture.sso.startSignIn()
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toMatchObject({ status: 'signing-in', url: AUTHORIZE }) })
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toEqual({ status: 'error', errorCode: 'timeout' }) })
  })

  it('reports a refused sign-in and skips the browser when disabled', async () => {
    const fixture = await mount({ ...CONFIGURED, openBrowser: false })
    await fixture.sso.startSignIn()
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toMatchObject({ url: AUTHORIZE }) })
    expect(fixture.opened).toEqual([])
    latest(fixture).interactive?.reject(new Error('AADSTS65001'))
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toEqual({ status: 'error', errorCode: 'sign-in-failed' }) })
    latest(fixture).interactive = undefined
    await fixture.sso.startSignIn()
    await vi.waitFor(() => { expect(latest(fixture).interactive).toBeDefined() })
    latest(fixture).interactive?.reject('opaque failure')
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toEqual({ status: 'error', errorCode: 'sign-in-failed' }) })
  })

  it('streams snapshots until the subscriber leaves', async () => {
    const fixture = await mount()
    const lifetime = new AbortController()
    const seen: CotecconsSsoView[] = []
    const reading = (async () => {
      for await (const view of fixture.sso.watch(lifetime.signal)) {
        seen.push(view)
        if (view.status === 'signed-in') lifetime.abort()
      }
    })()
    await signIn(fixture)
    await reading
    expect(seen.map(view => view.status)).toEqual(expect.arrayContaining(['signed-out', 'signing-in', 'signed-in']))
    expect(seen.at(-1)?.status).toBe('signed-in')
  })

  it('discards an unreadable stored cache and ignores records for another registration', async () => {
    const fixture = await mount()
    await fixture.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}`, cache: '{' } }))
    const restarted = await mount(CONFIGURED, { path: fixture.path })
    expect(await restarted.sso.getState()).toEqual({ status: 'signed-out' })
    expect(await restarted.credentials.readRecord(KEY)).toBeUndefined()
    const owner = { clientId: CLIENT, authority: 'a' }
    expect(storedCache(undefined, owner)).toBeUndefined()
    expect(storedCache({ kind: 'api-key', key: 'k' }, owner)).toBeUndefined()
    expect(storedCache({ kind: 'grant', payload: null }, owner)).toBeUndefined()
    expect(storedCache({ kind: 'grant', payload: { version: 1, clientId: 'other', authority: 'a', cache: '{}' } }, owner)).toBeUndefined()
    expect(storedCache({ kind: 'grant', payload: { version: 1, clientId: CLIENT, authority: 'a', cache: '{}' } }, owner)).toBe('{}')
  })

  it('keeps serving from memory when the credential store refuses a write', async () => {
    const fixture = await mount()
    vi.spyOn(fixture.credentials, 'modifyRecord').mockRejectedValue(new Error('read-only'))
    expect(await signIn(fixture)).toMatchObject({ status: 'signed-in' })
    expect(await fixture.sso.getAccessToken('scope')).toBe('access:scope')
  })

  it('refuses new work after disposal and ends an active attempt', async () => {
    const fixture = await mount()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      latest(fixture).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response(null))
    })
    await fixture.sso.startSignIn()
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toMatchObject({ url: AUTHORIZE }) })
    await fixture.ctx.fiber.dispose()
    expect(await fixture.sso.getState()).toEqual({ status: 'signed-out' })
    await expect(fixture.sso.startSignIn()).rejects.toThrow('provider closed')
  })

  it('releases a 127.0.0.1 loopback listener at its own address', async () => {
    const fixture = await mount()
    latest(fixture).authorizeUrl = `https://login.microsoftonline.com/t/authorize?redirect_uri=${encodeURIComponent('http://127.0.0.1:40000/')}`
    const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      latest(fixture).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response(null))
    })
    const started = await fixture.sso.startSignIn()
    if (started.status !== 'signing-in') throw new Error('expected an attempt')
    await vi.waitFor(async () => { expect(await fixture.sso.getState()).toMatchObject({ url: expect.stringContaining('127.0.0.1') as string }) })
    await fixture.sso.cancelSignIn(started.attemptId)
    expect(fetches.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:40000/'))
  })

  it('expires the session once when concurrent refreshes both require interaction', async () => {
    const fixture = await mount()
    await signIn(fixture)
    latest(fixture).silent.mockRejectedValue(new InteractionRequiredAuthError('invalid_grant', 'correlation'))
    const results = await Promise.allSettled([fixture.sso.getAccessToken('a'), fixture.sso.getAccessToken('b')])
    expect(results.map(entry => entry.status)).toEqual(['rejected', 'rejected'])
    expect(await fixture.sso.getState()).toEqual({ status: 'error', errorCode: 'session-expired' })
  })

  it('builds a real MSAL client from the registration without network access', async () => {
    const fixture = await mount(CONFIGURED, { realMsal: true })
    expect(await fixture.sso.getState()).toEqual({ status: 'signed-out' })
    expect(fixture.clients).toEqual([])
  })

  it('opens the default browser through the open package', async () => {
    await openInDefaultBrowser('https://login.microsoftonline.com/')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://login.microsoftonline.com/')
  })

  it('writes the store only when MSAL reports a changed cache', async () => {
    const fixture = await mount()
    const modify = vi.spyOn(fixture.credentials, 'modifyRecord')
    const owner = { clientId: CLIENT, authority: 'https://login.microsoftonline.com/t' }
    const plugin = credentialCachePlugin(fixture.credentials, KEY, owner, () => {})
    await plugin.afterCacheAccess(new TokenCacheContext({ deserialize: () => {}, serialize: () => '{}' }, false))
    expect(modify).not.toHaveBeenCalled()
  })

  it('reports a failed sign-out and keeps accepting later operations', async () => {
    const fixture = await mount()
    await signIn(fixture)
    vi.spyOn(fixture.credentials, 'deleteRecord').mockRejectedValueOnce(new Error('store locked'))
    await expect(fixture.sso.signOut()).rejects.toThrow('store locked')
    expect(await fixture.sso.signOut()).toEqual({ status: 'signed-out' })
  })
})
