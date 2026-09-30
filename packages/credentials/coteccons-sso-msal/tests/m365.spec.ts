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
import MsalCotecconsSso, { classifyEntraError, resolveConfig, type Config } from '../src/index.ts'
import { CLIENT, FakeMsal, TENANT, account } from './fake-msal.ts'

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

async function mount(config: Config = CONFIGURED, path?: string) {
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
        openBrowser: () => Promise.resolve(),
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
  return { sso, credentials, client, path: file }
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
