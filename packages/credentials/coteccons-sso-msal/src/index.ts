/**
 * Coteccons SSO provider over MSAL Node. Sign-in runs the authorization-code flow with PKCE in the system
 * browser and receives the code on MSAL's loopback listener (`http://localhost:<port>`); the resulting token
 * cache lives in one credential-store grant record, and access tokens refresh silently from it.
 */
import { randomUUID } from 'node:crypto'
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type Configuration } from '@azure/msal-node'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CotecconsSso, CotecconsSsoTokenUnavailableError, type CotecconsSsoError, type CotecconsSsoSetting, type CotecconsSsoSignInId,
  type CotecconsSsoView, type M365ConnectAttemptId, type M365ConnectorId, type M365ConnectorView,
} from '@deepseek-ai/dsh-coteccons-sso'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import open from 'open'
import { credentialCachePlugin } from './cache.ts'
import { M365Connector } from './connector.ts'
import { abortable, failureLabel, keepOnlyAccount, releaseLoopback, SerialQueue, watchSnapshots, type MsalClient } from './util.ts'

export type { MsalClient } from './util.ts'
export { classifyEntraError } from './connector.ts'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/
const HTTPS_URL = /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/

/** Deployment settings for the Entra ID app registration and the tokens it requests. */
export interface Config {
  /** Directory (tenant) id or verified domain; unset leaves the provider `not-configured`. */
  tenantId?: string
  /** Application (client) id of the public-client app registration; unset leaves the provider `not-configured`. */
  clientId?: string
  /** Authority URL; defaults to `https://login.microsoftonline.com/<tenantId>`. */
  authority?: string
  /** Scopes requested at sign-in besides {@link aiScope}. */
  scopes?: string[]
  /** Azure AI resource scope consented at sign-in and used for model requests. */
  aiScope?: string
  /** Lowercase email domains allowed to sign in; empty allows every account of the tenant. */
  allowedDomains?: string[]
  /** Open the sign-in page in the Host's default browser; the URL is always also published in the sign-in state. */
  openBrowser?: boolean
  /** Deadline for one interactive sign-in, including the time the user spends in the browser, in milliseconds. */
  signInTimeoutMs?: number
  /**
   * Microsoft 365 connectors, one Entra ID enterprise app per data kind. IT grants or revokes a kind by
   * assigning users to that app; an omitted connector stays `not-configured`.
   */
  m365?: Partial<Record<M365ConnectorId, M365ConnectorConfig>>
}

/** One Microsoft 365 connector's enterprise app. */
export interface M365ConnectorConfig {
  /** Application (client) id of the connector's public-client app registration; unset leaves the connector `not-configured`. */
  clientId?: string
  /** Microsoft Graph delegated scopes; unset or empty uses the read-only scopes of the data kind. */
  scopes?: string[]
}

/** Read-only Microsoft Graph delegated scopes each data kind needs. */
export const M365_DEFAULT_SCOPES: Readonly<Record<M365ConnectorId, readonly string[]>> = {
  mail: ['User.Read', 'Mail.Read'],
  chat: ['User.Read', 'Chat.Read'],
  files: ['User.Read', 'Files.Read.All', 'Sites.Read.All'],
}

/** Connector ids in the order views report them. */
export const M365_CONNECTORS: readonly M365ConnectorId[] = ['mail', 'chat', 'files']

/** A validated connector entry; an omitted entry has no `clientId` and empty `scopes`. */
type ValidConnectorConfig = Pick<M365ConnectorConfig, 'clientId'> & { scopes: string[] }

type ValidConfig = Required<Omit<Config, 'tenantId' | 'clientId' | 'authority' | 'm365'>> & Pick<Config, 'tenantId' | 'clientId' | 'authority'>
  & { m365: Record<M365ConnectorId, ValidConnectorConfig> }

/** Schemastery validates an omitted connector as an empty object, so {@link resolveConfig} treats an unset `clientId` as not configured. */
const ConnectorConfig: Schema<M365ConnectorConfig, ValidConnectorConfig> = Schema.object({
  clientId: Schema.string().pattern(GUID),
  scopes: Schema.array(Schema.string().min(1)).default([]),
})

/** Validated deployment settings. */
export const Config: Schema<Config, ValidConfig> = Schema.object({
  tenantId: Schema.string().pattern(TENANT),
  clientId: Schema.string().pattern(GUID),
  authority: Schema.string().pattern(HTTPS_URL),
  scopes: Schema.array(Schema.string().min(1)).default(['openid', 'profile', 'offline_access']),
  aiScope: Schema.string().min(1).default('https://cognitiveservices.azure.com/.default'),
  allowedDomains: Schema.array(Schema.string().pattern(DOMAIN)).default([]),
  openBrowser: Schema.boolean().default(true),
  signInTimeoutMs: Schema.number().min(10_000).max(1_800_000).default(300_000),
  m365: Schema.object({ mail: ConnectorConfig, chat: ConnectorConfig, files: ConnectorConfig }).default({}),
})

/** App registration facts every MSAL call needs. */
export interface Registration {
  readonly tenantId: string
  readonly clientId: string
  readonly authority: string
}

/** Configuration with every default applied. */
export interface ResolvedConfig {
  /** The app registration, or the settings still missing. */
  readonly registration: Registration | { readonly missing: readonly CotecconsSsoSetting[] }
  readonly signInScopes: readonly string[]
  readonly aiScope: string
  readonly allowedDomains: readonly string[]
  readonly openBrowser: boolean
  readonly signInTimeoutMs: number
  /** Each configured connector's app and Graph scopes (full resource URIs). */
  readonly m365: Partial<Record<M365ConnectorId, { readonly clientId: string; readonly scopes: readonly string[] }>>
}

/**
 * Qualify a bare Graph permission name with the Graph resource URI so MSAL requests a Graph token.
 * @param scope - permission name or full scope.
 * @returns the full scope.
 */
function graphScope(scope: string): string {
  return scope.includes('/') || ['openid', 'profile', 'offline_access', 'email'].includes(scope)
    ? scope
    : `https://graph.microsoft.com/${scope}`
}

/**
 * Validate the configuration and apply its defaults.
 * @param config - raw plugin configuration.
 * @returns the configuration every operation reads.
 * @throws when a set field is malformed.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const valid = Config(config)
  const missing = (['tenantId', 'clientId'] as const).filter(field => valid[field] === undefined)
  const registration = valid.tenantId === undefined || valid.clientId === undefined
    ? { missing }
    : {
      tenantId: valid.tenantId,
      clientId: valid.clientId,
      authority: valid.authority ?? `https://login.microsoftonline.com/${valid.tenantId}`,
    }
  return {
    registration,
    signInScopes: [...new Set([...valid.scopes, valid.aiScope])],
    aiScope: valid.aiScope,
    allowedDomains: valid.allowedDomains,
    openBrowser: valid.openBrowser,
    signInTimeoutMs: valid.signInTimeoutMs,
    m365: Object.fromEntries(M365_CONNECTORS.flatMap((id) => {
      const { clientId, scopes } = valid.m365[id]
      if (clientId === undefined) {
        if (scopes.length > 0) throw new TypeError(`coteccons-sso: m365.${id} sets scopes without clientId`)
        return []
      }
      return [[id, { clientId, scopes: (scopes.length > 0 ? scopes : M365_DEFAULT_SCOPES[id]).map(graphScope) }]]
    })),
  }
}

/** Replaceable process edges: MSAL client construction and browser launch. */
export interface Internals {
  /** Build the MSAL client for one configuration. */
  createClient?: (configuration: Configuration) => MsalClient
  /** Hand one URL to the Host's default browser. */
  openBrowser?: (url: string) => Promise<void>
}

const SUCCESS_PAGE = '<!doctype html><meta charset="utf-8"><title>CTD Core</title><p>Signed in. You can close this window and return to CTD Core.</p>'
const ERROR_PAGE = '<!doctype html><meta charset="utf-8"><title>CTD Core</title><p>Sign-in did not complete. Return to CTD Core and try again.</p>'

interface Attempt {
  readonly id: CotecconsSsoSignInId
  url: string | null
  readonly controller: AbortController
  done: Promise<void>
}

/**
 * Hand one URL to the Host's default browser.
 * @param url - page to open.
 */
export async function openInDefaultBrowser(url: string): Promise<void> {
  await open(url)
}

/** MSAL implementation of {@link CotecconsSso}. */
export class MsalCotecconsSso extends CotecconsSso {
  static inject = ['credentials']
  static Config = Config

  override readonly aiScope: string
  private readonly config: ResolvedConfig
  private readonly createClient: (configuration: Configuration) => MsalClient
  private readonly launchBrowser: (url: string) => Promise<void>
  private client: MsalClient | undefined
  private account: AccountInfo | undefined
  private attempt: Attempt | undefined
  private lastError: CotecconsSsoError | undefined
  private readonly listeners = new Set<() => void>()
  private readonly m365Listeners = new Set<() => void>()
  private readonly connectors: Readonly<Record<M365ConnectorId, M365Connector>>
  private readonly queue = new SerialQueue()
  private closed = false

  /**
   * @param ctx - context providing the credential store.
   * @param config - app registration and token settings.
   * @param internals - replaceable MSAL construction and browser launch.
   */
  constructor(ctx: Context, config: Config = {}, internals: Internals = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.aiScope = this.config.aiScope
    this.createClient = internals.createClient ?? (configuration => new PublicClientApplication(configuration))
    this.launchBrowser = internals.openBrowser ?? openInDefaultBrowser
    const registration = this.registration()
    this.connectors = Object.fromEntries(M365_CONNECTORS.map((id) => {
      const connector = this.config.m365[id]
      return [id, new M365Connector({
        id,
        registration: registration === undefined || connector === undefined
          ? undefined
          : { clientId: connector.clientId, authority: registration.authority },
        scopes: connector?.scopes ?? [],
        credentials: ctx.credentials,
        createClient: this.createClient,
        launchBrowser: this.config.openBrowser ? this.launchBrowser : undefined,
        signInTimeoutMs: this.config.signInTimeoutMs,
        allowed: account => this.allowed(account),
        changed: () => { this.publishM365() },
      })]
    })) as Record<M365ConnectorId, M365Connector>
    ctx.effect(() => async () => {
      this.closed = true
      this.attempt?.controller.abort()
      await this.attempt?.done
      await Promise.all(Object.values(this.connectors).map(connector => connector.close()))
      await this.queue.idle()
      this.publish()
      this.publishM365()
    }, 'coteccons-sso: sign-in lifetime')
  }

  async [Service.init](): Promise<void> {
    await Promise.all(Object.values(this.connectors).map(connector => connector.init()))
    const registration = this.registration()
    if (registration === undefined) return
    this.client = this.newClient(registration)
    let accounts: AccountInfo[]
    try {
      accounts = await this.client.getAllAccounts()
    } catch (error) {
      // An unreadable stored cache would fail every later sign-in too, so it is discarded.
      console.info('[coteccons-sso] stored token cache is unreadable; signing out', { error: failureLabel(error) })
      await this.forget()
      return
    }
    this.account = accounts.find(account => this.allowed(account))
  }

  override getState(): Promise<CotecconsSsoView> {
    return Promise.resolve(this.snapshot())
  }

  override startSignIn(): Promise<CotecconsSsoView> {
    if (this.closed) return Promise.reject(new Error('coteccons-sso: provider closed'))
    const client = this.client
    if (client !== undefined && this.account === undefined && this.attempt === undefined) {
      const attempt: Attempt = {
        id: randomUUID() as CotecconsSsoSignInId, url: null, controller: new AbortController(), done: Promise.resolve(),
      }
      this.attempt = attempt
      this.lastError = undefined
      attempt.done = this.signIn(client, attempt)
      this.publish()
    }
    return this.getState()
  }

  override async cancelSignIn(id: CotecconsSsoSignInId): Promise<CotecconsSsoView> {
    const attempt = this.attempt
    if (attempt?.id === id) {
      attempt.controller.abort()
      await attempt.done
    }
    return this.snapshot()
  }

  override async signOut(): Promise<CotecconsSsoView> {
    const attempt = this.attempt
    attempt?.controller.abort()
    await attempt?.done
    return this.queue.run(async () => {
      await this.forget()
      this.lastError = undefined
      this.publish()
      return this.snapshot()
    })
  }

  override watch(signal: AbortSignal): AsyncIterable<CotecconsSsoView> {
    return watchSnapshots(this.listeners, () => this.closed, () => this.snapshot(), signal)
  }

  override getM365State(): Promise<readonly M365ConnectorView[]> {
    return Promise.resolve(this.m365Snapshot())
  }

  override connectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]> {
    if (this.closed) return Promise.reject(new Error('coteccons-sso: provider closed'))
    this.connectors[id].connect()
    return this.getM365State()
  }

  override async cancelM365Connect(id: M365ConnectorId, attemptId: M365ConnectAttemptId): Promise<readonly M365ConnectorView[]> {
    await this.connectors[id].cancel(attemptId)
    return this.m365Snapshot()
  }

  override async disconnectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]> {
    await this.connectors[id].disconnect()
    return this.m365Snapshot()
  }

  override watchM365(signal: AbortSignal): AsyncIterable<readonly M365ConnectorView[]> {
    return watchSnapshots(this.m365Listeners, () => this.closed, () => this.m365Snapshot(), signal)
  }

  override getM365AccessToken(id: M365ConnectorId, signal?: AbortSignal): Promise<string> {
    return this.connectors[id].token(signal)
  }

  private m365Snapshot(): readonly M365ConnectorView[] {
    return M365_CONNECTORS.map(id => this.connectors[id].view())
  }

  private publishM365(): void {
    for (const listener of this.m365Listeners) listener()
  }

  override async getAccessToken(scope: string, signal?: AbortSignal): Promise<string> {
    const client = this.client
    if (client === undefined) throw new CotecconsSsoTokenUnavailableError('not-configured')
    const account = this.account
    if (account === undefined) throw new CotecconsSsoTokenUnavailableError('signed-out')
    try {
      const result = await abortable(client.acquireTokenSilent({ account, scopes: [scope] }), signal)
      return result.accessToken
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error
      console.info('[coteccons-sso] silent refresh requires sign-in', { error: failureLabel(error) })
      await this.queue.run(async () => {
        if (this.account !== account) return
        await this.forget()
        this.lastError = 'session-expired'
        this.publish()
      })
      throw new CotecconsSsoTokenUnavailableError('session-expired', { cause: error })
    }
  }

  private registration(): Registration | undefined {
    const registration = this.config.registration
    return 'missing' in registration ? undefined : registration
  }

  private newClient(registration: Registration): MsalClient {
    const key = credentialKey('coteccons-sso', 'token-cache')
    return this.createClient({
      auth: { clientId: registration.clientId, authority: registration.authority },
      cache: {
        cachePlugin: credentialCachePlugin(this.ctx.credentials, key, registration, (error) => {
          console.info('[coteccons-sso] token cache write failed', { error: failureLabel(error) })
        }),
      },
    })
  }

  /** Whether an account's sign-in name is in an allowed domain; every account passes when no domain is configured. */
  private allowed(account: AccountInfo): boolean {
    if (this.config.allowedDomains.length === 0) return true
    const domain = account.username.slice(account.username.lastIndexOf('@') + 1).toLowerCase()
    return account.username.includes('@') && this.config.allowedDomains.includes(domain)
  }

  private snapshot(): CotecconsSsoView {
    const registration = this.config.registration
    if ('missing' in registration) return { status: 'not-configured', missing: registration.missing }
    if (this.attempt !== undefined) return { status: 'signing-in', attemptId: this.attempt.id, url: this.attempt.url }
    if (this.account !== undefined) {
      const { name, username, tenantId } = this.account
      return { status: 'signed-in', account: { name: name ?? null, username, tenantId } }
    }
    if (this.lastError !== undefined) return { status: 'error', errorCode: this.lastError }
    return { status: 'signed-out' }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  /** Delete the stored cache and drop MSAL's in-memory copy of it. */
  private async forget(): Promise<void> {
    this.account = undefined
    await this.ctx.credentials.deleteRecord(credentialKey('coteccons-sso', 'token-cache'))
    const registration = this.registration()
    /* v8 ignore next -- forget runs only after a client was built from a complete registration. */
    if (registration !== undefined) this.client = this.newClient(registration)
  }

  /** Run one attempt to its terminal state; never rejects. */
  private async signIn(client: MsalClient, attempt: Attempt): Promise<void> {
    const deadline = AbortSignal.timeout(this.config.signInTimeoutMs)
    const signal = AbortSignal.any([attempt.controller.signal, deadline])
    let redirectUri: string | null = null
    const release = (): void => { if (redirectUri !== null) void releaseLoopback(redirectUri) }
    signal.addEventListener('abort', release, { once: true })
    let outcome: CotecconsSsoError | undefined
    try {
      const result = await client.acquireTokenInteractive({
        scopes: [...this.config.signInScopes],
        prompt: 'select_account',
        successTemplate: SUCCESS_PAGE,
        errorTemplate: ERROR_PAGE,
        openBrowser: async (url) => {
          redirectUri = new URL(url).searchParams.get('redirect_uri')
          if (signal.aborted) { release(); return }
          attempt.url = url
          this.publish()
          if (!this.config.openBrowser) return
          try {
            await this.launchBrowser(url)
          } catch (error) {
            console.info('[coteccons-sso] browser launch failed; the sign-in link stays available', { error: failureLabel(error) })
          }
        },
      })
      const account = result.account
      if (account === null || !this.allowed(account)) {
        await this.queue.run(() => this.forget())
        outcome = 'domain-not-allowed'
      } else {
        await this.queue.run(async () => {
          await keepOnlyAccount(client, account)
          this.account = account
        })
      }
    } catch (error) {
      console.info('[coteccons-sso] sign-in failed', { error: failureLabel(error) })
      outcome = attempt.controller.signal.aborted ? undefined : deadline.aborted ? 'timeout' : 'sign-in-failed'
    } finally {
      signal.removeEventListener('abort', release)
    }
    this.attempt = undefined
    this.lastError = outcome
    this.publish()
  }
}
export default MsalCotecconsSso
