/** Microsoft 365 connectors: IT-controlled Entra ID refusals, per-connector token caches, and isolation from the main sign-in. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionRequiredAuthError, ServerError } from '@azure/msal-node'
import { Context } from '@deepseek-ai/cordis'
import { M365AccessUnavailableError, type M365ConnectAttemptId, type M365ConnectorView } from '@deepseek-ai/dsh-coteccons-sso'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MsalCotecconsSso, { classifyEntraError, resolveConfig, type Config, type Internals } from '../src/index.ts'
import { AUTHORIZE, CLIENT, FakeMsal, TENANT, account } from './fake-msal.ts'

vi.mock('open', () => ({ default: vi.fn(() => Promise.resolve({})) }))

const MAIL = '413217b2-54b5-4400-8c08-2d3efeb0b0d6'
const CHAT = '62549918-2243-445b-b247-017577289854'
const CONFIGURED = { tenantId: TENANT, clientId: CLIENT, m365: { mail: { clientId: MAIL }, chat: { clientId: CHAT } } } satisfies Config
const MAIL_KEY = credentialKey('coteccons-sso', 'm365-mail')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function mount(config: Config = CONFIGURED, path?: string, openBrowser: Internals['openBrowser'] = () => Promise.resolve()) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coteccons-m365-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = path ?? join(dir, '.credentials.yaml')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: file, watch: false })
  const clients: FakeMsal[] = []
  class FixtureSso extends MsalCotecconsSso {
    constructor(scope: Context, value: Config) {
      super(scope, value, {
        createClient: (configuration) => { const client = new FakeMsal(configuration); clients.push(client); return client },
        openBrowser,
      })
    }
  }
  await ctx.plugin(FixtureSso, config)
  const sso = ctx.get('cotecconsSso') as MsalCotecconsSso
  const credentials = ctx.get('credentials') as LocalCredentialProvider
  /** @returns the latest MSAL client built for one app registration. */
  const client = (clientId: string): FakeMsal => {
    const found = clients.filter(entry => entry.configuration.auth.clientId === clientId).at(-1)
    if (found === undefined) throw new Error(`no client for ${clientId}`)
    return found
  }
  return { ctx, sso, credentials, client, path: file }
}

function view(views: readonly M365ConnectorView[], id: string): M365ConnectorView | undefined {
  return views.find(entry => entry.id === id)
}

async function connect(fixture: Awaited<ReturnType<typeof mount>>, clientId = MAIL, id: 'mail' | 'chat' = 'mail') {
  await fixture.sso.connectM365(id)
  await vi.waitFor(() => { expect(fixture.client(clientId).interactive).toBeDefined() })
  await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), id)).toMatchObject({ status: 'connecting', url: expect.any(String) as string }) })
}

describe('configuration', () => {
  it('qualifies Graph scopes with the resource URI and defaults each kind to read-only scopes', () => {
    expect(resolveConfig(CONFIGURED).m365).toEqual({
      mail: { clientId: MAIL, scopes: ['https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.Read'] },
      chat: { clientId: CHAT, scopes: ['https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Chat.Read'] },
    })
    expect(resolveConfig({ ...CONFIGURED, m365: { files: { clientId: MAIL, scopes: ['openid', 'https://x.test/y'] } } }).m365)
      .toEqual({ files: { clientId: MAIL, scopes: ['openid', 'https://x.test/y'] } })
    expect(() => resolveConfig({ m365: { mail: { scopes: ['Mail.Read'] } } })).toThrow('sets scopes without clientId')
    expect(() => resolveConfig({ m365: { mail: { clientId: 'nope' } } })).toThrow()
  })

  it('maps Entra ID codes to the IT decision that caused them', () => {
    expect(classifyEntraError(new ServerError('invalid_grant', 'corr', 'AADSTS50105: The signed in user is not assigned to a role'))).toBe('not-assigned')
    expect(classifyEntraError(new ServerError('unauthorized_client', 'corr', 'AADSTS7000112: Application is disabled.'))).toBe('disabled-by-admin')
    expect(classifyEntraError(new InteractionRequiredAuthError('consent_required', 'consent'))).toBe('consent-required')
    expect(classifyEntraError(new Error('AADSTS650057 invalid resource'))).toBe('consent-required')
    expect(classifyEntraError(new Error('network down'))).toBe('failed')
    expect(classifyEntraError('opaque')).toBe('failed')
  })
})

describe('Microsoft 365 connectors', () => {
  it('reports each connector, connects one, and serves Graph tokens from its own cache record', async () => {
    const fixture = await mount()
    expect(await fixture.sso.getM365State()).toEqual([
      { id: 'mail', status: 'disconnected' }, { id: 'chat', status: 'disconnected' }, { id: 'files', status: 'not-configured' },
    ])
    await expect(fixture.sso.getM365AccessToken('mail')).rejects.toMatchObject({ connector: 'mail', reason: 'disconnected' })
    await expect(fixture.sso.getM365AccessToken('files')).rejects.toMatchObject({ reason: 'not-configured' })
    await connect(fixture)
    expect(fixture.client(MAIL).interactive?.request.scopes).toEqual(['https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.Read'])
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'connected', username: 'a.nguyen@coteccons.vn' }) })
    expect(await fixture.sso.getM365AccessToken('mail')).toBe('access:https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read')
    expect((await fixture.credentials.readRecord(MAIL_KEY))?.kind).toBe('grant')
    expect(await fixture.sso.getState()).toEqual({ status: 'signed-out' })
    const restarted = await mount(CONFIGURED, fixture.path)
    expect(view(await restarted.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' })
    expect(await restarted.sso.disconnectM365('mail')).toContainEqual({ id: 'mail', status: 'disconnected' })
    expect(await restarted.credentials.readRecord(MAIL_KEY)).toBeUndefined()
  })

  it('blocks a user IT has not assigned without touching other connectors', async () => {
    const fixture = await mount()
    await connect(fixture)
    fixture.client(MAIL).interactive?.reject(new ServerError('invalid_grant', 'corr', 'AADSTS50105: not assigned'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'not-assigned' }) })
    await expect(fixture.sso.getM365AccessToken('mail')).rejects.toMatchObject({ reason: 'not-assigned' })
    expect(view(await fixture.sso.getM365State(), 'chat')).toEqual({ id: 'chat', status: 'disconnected' })
  })

  it('revokes only the refused connector when Entra ID stops refreshing it', async () => {
    const fixture = await mount()
    await connect(fixture)
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' }) })
    fixture.client(MAIL).silent.mockRejectedValueOnce(new InteractionRequiredAuthError('invalid_grant', 'AADSTS50173 revoked'))
    const refused = await fixture.sso.getM365AccessToken('mail').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(M365AccessUnavailableError)
    expect(refused).toMatchObject({ reason: 'revoked' })
    expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'revoked' })
    expect(await fixture.credentials.readRecord(MAIL_KEY)).toBeUndefined()
  })

  it('reports an unassigned refresh and rethrows transport failures unchanged', async () => {
    const fixture = await mount()
    await connect(fixture)
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' }) })
    const network = new Error('network down')
    fixture.client(MAIL).silent.mockRejectedValueOnce(network)
    await expect(fixture.sso.getM365AccessToken('mail')).rejects.toBe(network)
    fixture.client(MAIL).silent.mockRejectedValueOnce(new ServerError('invalid_grant', 'corr', 'AADSTS50105: not assigned'))
    await expect(fixture.sso.getM365AccessToken('mail')).rejects.toMatchObject({ reason: 'not-assigned' })
  })

  it('cancels only the named attempt and streams connector snapshots', async () => {
    const fixture = await mount()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      fixture.client(MAIL).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response(null))
    })
    const lifetime = new AbortController()
    const seen: Array<readonly M365ConnectorView[]> = []
    const reading = (async () => {
      for await (const views of fixture.sso.watchM365(lifetime.signal)) {
        seen.push(views)
        if (seen.length >= 2 && view(views, 'mail')?.status === 'disconnected') lifetime.abort()
      }
    })()
    await connect(fixture)
    const attempt = view(await fixture.sso.getM365State(), 'mail')
    if (attempt?.status !== 'connecting') throw new Error('expected an attempt')
    expect(view(await fixture.sso.cancelM365Connect('mail', 'other' as M365ConnectAttemptId), 'mail')).toMatchObject({ status: 'connecting' })
    expect(view(await fixture.sso.cancelM365Connect('mail', attempt.attemptId), 'mail')).toEqual({ id: 'mail', status: 'disconnected' })
    await reading
    expect(seen.map(views => view(views, 'mail')?.status)).toEqual(expect.arrayContaining(['disconnected', 'connecting']))
  })
})

describe('Microsoft 365 connector sign-in', () => {
  it('starts one attempt per connector and none once it is connected', async () => {
    const fixture = await mount()
    await connect(fixture)
    const interactive = vi.spyOn(fixture.client(MAIL), 'acquireTokenInteractive')
    await fixture.sso.connectM365('mail')
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' }) })
    expect(view(await fixture.sso.connectM365('mail'), 'mail')).toMatchObject({ status: 'connected' })
    expect(interactive).not.toHaveBeenCalled()
  })

  it('publishes the sign-in link when the browser launch fails or is disabled', async () => {
    const failing = await mount(CONFIGURED, undefined, () => Promise.reject(new Error('no display')))
    await connect(failing)
    expect(view(await failing.sso.getM365State(), 'mail')).toMatchObject({ status: 'connecting', url: AUTHORIZE })
    const opened: string[] = []
    const disabled = await mount({ ...CONFIGURED, openBrowser: false }, undefined, (url) => { opened.push(url); return Promise.resolve() })
    await connect(disabled)
    expect(view(await disabled.sso.getM365State(), 'mail')).toMatchObject({ status: 'connecting', url: AUTHORIZE })
    expect(opened).toEqual([])
    for (const fixture of [failing, disabled]) fixture.client(MAIL).interactive?.reject(new Error('closed'))
  })

  it('refuses an account outside the allowed domains and a sign-in that returns no account', async () => {
    const fixture = await mount({ ...CONFIGURED, allowedDomains: ['coteccons.vn'] })
    await connect(fixture)
    await fixture.client(MAIL).finish(account('someone@gmail.com'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'failed' }) })
    expect(await fixture.credentials.readRecord(MAIL_KEY)).toBeUndefined()
    await connect(fixture)
    await fixture.client(MAIL).finish(null)
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'failed' }) })
  })

  it('fails an unfinished sign-in at the sign-in timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => { vi.useRealTimers() })
    const fixture = await mount({ ...CONFIGURED, signInTimeoutMs: 10_000 })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => { controller.abort(new DOMException('timed out', 'TimeoutError')) }, ms)
      return controller.signal
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      fixture.client(MAIL).interactive?.reject(new Error('released'))
      return Promise.resolve(new Response(null))
    })
    await connect(fixture)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'failed' }) })
  })

  it('only releases the loopback when the browser callback arrives after cancellation', async () => {
    const fixture = await mount()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
    await connect(fixture)
    const attempt = view(await fixture.sso.getM365State(), 'mail')
    if (attempt?.status !== 'connecting') throw new Error('expected an attempt')
    const cancelled = fixture.sso.cancelM365Connect('mail', attempt.attemptId)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
    await fixture.client(MAIL).interactive?.request.openBrowser(AUTHORIZE)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL('http://127.0.0.1:53123/'))
    fixture.client(MAIL).interactive?.reject(new Error('released'))
    expect(view(await cancelled, 'mail')).toEqual({ id: 'mail', status: 'disconnected' })
  })

  it('cancels an attempt whose sign-in URL names no loopback without releasing anything', async () => {
    const fixture = await mount()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null))
    fixture.client(MAIL).authorizeUrl = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`
    await connect(fixture)
    const attempt = view(await fixture.sso.getM365State(), 'mail')
    if (attempt?.status !== 'connecting') throw new Error('expected an attempt')
    const cancelled = fixture.sso.cancelM365Connect('mail', attempt.attemptId)
    fixture.client(MAIL).interactive?.reject(new Error('cancelled'))
    expect(view(await cancelled, 'mail')).toEqual({ id: 'mail', status: 'disconnected' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Microsoft 365 connector storage', () => {
  it('discards an unreadable connector cache at startup', async () => {
    const fixture = await mount()
    await fixture.credentials.modifyRecord(MAIL_KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, clientId: MAIL, authority: `https://login.microsoftonline.com/${TENANT}`, cache: '{' } }))
    const restarted = await mount(CONFIGURED, fixture.path)
    expect(view(await restarted.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'disconnected' })
    expect(await restarted.credentials.readRecord(MAIL_KEY)).toBeUndefined()
  })

  it('keeps a connector connected for this process when the store refuses its cache write', async () => {
    const fixture = await mount()
    vi.spyOn(fixture.credentials, 'modifyRecord').mockRejectedValue(new Error('read-only'))
    await connect(fixture)
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' }) })
    expect(await fixture.sso.getM365AccessToken('mail')).toContain('Mail.Read')
    expect(await fixture.credentials.readRecord(MAIL_KEY)).toBeUndefined()
  })

  it('clears the connector once when concurrent refreshes are both refused', async () => {
    const fixture = await mount()
    await connect(fixture)
    await fixture.client(MAIL).finish(account('a.nguyen@coteccons.vn'))
    await vi.waitFor(async () => { expect(view(await fixture.sso.getM365State(), 'mail')).toMatchObject({ status: 'connected' }) })
    fixture.client(MAIL).silent.mockRejectedValue(new InteractionRequiredAuthError('invalid_grant', 'AADSTS50173 revoked'))
    const deletions = vi.spyOn(fixture.credentials, 'deleteRecord')
    const refusals = await Promise.all([fixture.sso.getM365AccessToken('mail'), fixture.sso.getM365AccessToken('mail')].map(token => token.catch((error: unknown) => error)))
    expect(refusals).toEqual([expect.objectContaining({ reason: 'revoked' }), expect.objectContaining({ reason: 'revoked' })])
    expect(deletions).toHaveBeenCalledTimes(1)
    expect(view(await fixture.sso.getM365State(), 'mail')).toEqual({ id: 'mail', status: 'blocked', errorCode: 'revoked' })
  })

  it('refuses to start a connector sign-in after disposal', async () => {
    const fixture = await mount()
    await fixture.ctx.fiber.dispose()
    await expect(fixture.sso.connectM365('mail')).rejects.toThrow('coteccons-sso: provider closed')
  })
})
