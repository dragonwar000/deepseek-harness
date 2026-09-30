/**
 * Coteccons SSO provider over MSAL Node. Sign-in runs the authorization-code flow with PKCE in the system
 * browser and receives the code on MSAL's loopback listener (`http://localhost:<port>`); the resulting token
 * cache lives in one credential-store grant record, and access tokens refresh silently from it.
 */
import { randomUUID } from 'node:crypto'
import {
  InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type AuthenticationResult, type Configuration,
  type InteractiveRequest, type SilentFlowRequest,
} from '@azure/msal-node'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CotecconsSso, CotecconsSsoTokenUnavailableError, type CotecconsSsoError, type CotecconsSsoSetting, type CotecconsSsoSignInId,
  type CotecconsSsoView,
} from '@deepseek-ai/dsh-coteccons-sso'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import open from 'open'
import { credentialCachePlugin } from './cache.ts'

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
}

type ValidConfig = Required<Omit<Config, 'tenantId' | 'clientId' | 'authority'>> & Pick<Config, 'tenantId' | 'clientId' | 'authority'>

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
  }
}

/** The MSAL operations this provider uses; tests substitute a fake. */
export interface MsalClient {
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>
  getAllAccounts(): Promise<AccountInfo[]>
  getTokenCache(): { removeAccount(account: AccountInfo): Promise<void> }
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
 * Describe a caught failure for the Host log without its payload.
 * @param error - caught value.
 * @returns the error name and code, never token material.
 */
function failureLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? `${error.name}: ${code}` : error.name
}

/**
 * Race an operation against caller cancellation.
 * @param operation - pending operation.
 * @param signal - caller cancellation.
 * @returns the operation's result.
 */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => { reject(signal.reason as Error) }
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', stop as () => void)
  }
}

/**
 * Deliver an OAuth error to MSAL's loopback listener so an abandoned interactive request settles and closes it.
 * @param redirectUri - loopback redirect URI of the pending request.
 */
async function releaseLoopback(redirectUri: string): Promise<void> {
  const target = new URL(redirectUri)
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1'
  target.pathname = '/'
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'error=access_denied&error_description=cancelled',
    })
    await response.body?.cancel()
  } catch (error) {
    console.info('[coteccons-sso] loopback release failed', { error: failureLabel(error) })
  }
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
  private queue: Promise<unknown> = Promise.resolve()
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
    ctx.effect(() => async () => {
      this.closed = true
      this.attempt?.controller.abort()
      await this.attempt?.done
      await this.queue
      this.publish()
    }, 'coteccons-sso: sign-in lifetime')
  }

  async [Service.init](): Promise<void> {
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
    return this.exclusive(async () => {
      await this.forget()
      this.lastError = undefined
      this.publish()
      return this.snapshot()
    })
  }

  override async *watch(signal: AbortSignal): AsyncIterable<CotecconsSsoView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) {
          dirty = false
          yield this.snapshot()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
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
      await this.exclusive(async () => {
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

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch((_reported: unknown) => undefined)
    return result
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
        await this.exclusive(() => this.forget())
        outcome = 'domain-not-allowed'
      } else {
        await this.exclusive(async () => {
          for (const other of await client.getAllAccounts()) {
            if (other.homeAccountId !== account.homeAccountId) await client.getTokenCache().removeAccount(other)
          }
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
