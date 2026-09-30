/**
 * One Microsoft 365 connector: an MSAL public client for one Entra ID enterprise app (Mail, Teams Chat, or Files)
 * whose token cache lives in its own credential record. IT grants or revokes the data kind in Entra ID through the
 * app's user assignment; this class only reports what Entra ID answers and never stores an "allowed" flag.
 */
import { randomUUID } from 'node:crypto'
import { InteractionRequiredAuthError, type AccountInfo, type Configuration } from '@azure/msal-node'
import {
  M365AccessUnavailableError, type M365ConnectAttemptId, type M365ConnectorError, type M365ConnectorId, type M365ConnectorView,
} from '@deepseek-ai/dsh-coteccons-sso'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialCachePlugin } from './cache.ts'
import { abortable, failureLabel, releaseLoopback, type MsalClient } from './util.ts'

const SUCCESS_PAGE = '<!doctype html><meta charset="utf-8"><title>CTD Core</title><p>Microsoft 365 connected. You can close this window and return to CTD Core.</p>'
const ERROR_PAGE = '<!doctype html><meta charset="utf-8"><title>CTD Core</title><p>Microsoft 365 was not connected. Return to CTD Core for the reason.</p>'

/**
 * Map an Entra ID refusal to the connector state IT caused. AADSTS50105: the user is not assigned to the
 * enterprise app. AADSTS7000112 / AADSTS7000111: the app or its service principal is disabled. AADSTS65001 /
 * AADSTS650057 / `consent_required`: the app lacks admin consent.
 * @param error - caught MSAL failure.
 * @returns the matching connector error, or `failed` when the failure names no IT decision.
 */
export function classifyEntraError(error: unknown): M365ConnectorError {
  if (!(error instanceof Error)) return 'failed'
  const fields = error as { errorCode?: unknown; subError?: unknown; errorMessage?: unknown }
  const text = [fields.errorCode, fields.subError, fields.errorMessage, error.message].filter(part => typeof part === 'string').join(' ')
  if (/AADSTS50105\b/.test(text)) return 'not-assigned'
  if (/AADSTS700011[12]\b/.test(text)) return 'disabled-by-admin'
  if (/AADSTS65001\b|AADSTS650057\b|consent_required/.test(text)) return 'consent-required'
  return 'failed'
}

/** Settings and process edges one connector needs. */
export interface ConnectorOptions {
  readonly id: M365ConnectorId
  /** The connector's enterprise app registration; `undefined` leaves it `not-configured`. */
  readonly registration: { readonly clientId: string; readonly authority: string } | undefined
  /** Microsoft Graph scopes requested at sign-in and for every token. */
  readonly scopes: readonly string[]
  readonly credentials: CredentialProvider
  readonly createClient: (configuration: Configuration) => MsalClient
  /** Opens the sign-in page; `undefined` only publishes the URL. */
  readonly launchBrowser: ((url: string) => Promise<void>) | undefined
  readonly signInTimeoutMs: number
  /** Whether an account's sign-in name belongs to an allowed domain. */
  readonly allowed: (account: AccountInfo) => boolean
  /** Called after every committed state change. */
  readonly changed: () => void
}

interface Attempt {
  readonly id: M365ConnectAttemptId
  url: string | null
  readonly controller: AbortController
  done: Promise<void>
}

/** One connector's sign-in, silent refresh, and Entra ID refusal state. */
export class M365Connector {
  private readonly key: CredentialKey
  private client: MsalClient | undefined
  private account: AccountInfo | undefined
  private attempt: Attempt | undefined
  private error: M365ConnectorError | undefined
  private queue: Promise<unknown> = Promise.resolve()

  /** @param options - registration, scopes, and process edges. */
  constructor(private readonly options: ConnectorOptions) {
    this.key = credentialKey('coteccons-sso', `m365-${options.id}`)
    if (options.registration !== undefined) this.client = this.newClient(options.registration)
  }

  /** Restore the stored account; an unreadable cache is discarded. */
  async init(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    try {
      this.account = (await client.getAllAccounts()).find(account => this.options.allowed(account))
    } catch (error) {
      console.info('[coteccons-sso] stored Microsoft 365 token cache is unreadable; disconnecting', { connector: this.options.id, error: failureLabel(error) })
      await this.forget()
    }
  }

  /** @returns the connector's token-free state. */
  view(): M365ConnectorView {
    const id = this.options.id
    if (this.client === undefined) return { id, status: 'not-configured' }
    if (this.attempt !== undefined) return { id, status: 'connecting', attemptId: this.attempt.id, url: this.attempt.url }
    if (this.account !== undefined) return { id, status: 'connected', username: this.account.username }
    if (this.error !== undefined) return { id, status: 'blocked', errorCode: this.error }
    return { id, status: 'disconnected' }
  }

  /** Start an interactive sign-in unless one runs, the connector is connected, or it is not configured. */
  connect(): void {
    const client = this.client
    if (client === undefined || this.account !== undefined || this.attempt !== undefined) return
    const attempt: Attempt = {
      id: randomUUID() as M365ConnectAttemptId, url: null, controller: new AbortController(), done: Promise.resolve(),
    }
    this.attempt = attempt
    this.error = undefined
    attempt.done = this.signIn(client, attempt)
    this.options.changed()
  }

  /**
   * Cancel the named attempt.
   * @param attemptId - attempt to cancel; another id changes nothing.
   */
  async cancel(attemptId: M365ConnectAttemptId): Promise<void> {
    const attempt = this.attempt
    if (attempt === undefined || attempt.id !== attemptId) return
    attempt.controller.abort()
    await attempt.done
  }

  /** Forget the stored sign-in and any refusal. */
  async disconnect(): Promise<void> {
    const attempt = this.attempt
    attempt?.controller.abort()
    await attempt?.done
    await this.exclusive(async () => {
      await this.forget()
      this.error = undefined
      this.options.changed()
    })
  }

  /**
   * Return a Graph token, refreshing silently. An Entra ID refusal deletes this connector's cache only.
   * @param signal - caller cancellation.
   * @returns the bearer token value.
   */
  async token(signal?: AbortSignal): Promise<string> {
    const { id } = this.options
    const client = this.client
    if (client === undefined) throw new M365AccessUnavailableError(id, 'not-configured')
    const account = this.account
    if (account === undefined) throw new M365AccessUnavailableError(id, this.error ?? 'disconnected')
    try {
      const result = await abortable(client.acquireTokenSilent({ account, scopes: [...this.options.scopes] }), signal)
      return result.accessToken
    } catch (error) {
      const classified = classifyEntraError(error)
      if (classified === 'failed' && !(error instanceof InteractionRequiredAuthError)) throw error
      const blocked = classified === 'failed' ? 'revoked' : classified
      console.info('[coteccons-sso] Microsoft 365 access refused by Entra ID', { connector: id, reason: blocked, error: failureLabel(error) })
      await this.exclusive(async () => {
        if (this.account !== account) return
        await this.forget()
        this.error = blocked
        this.options.changed()
      })
      throw new M365AccessUnavailableError(id, blocked, { cause: error })
    }
  }

  /** End an active attempt and wait for queued work. */
  async close(): Promise<void> {
    this.attempt?.controller.abort()
    await this.attempt?.done
    await this.queue
  }

  private newClient(registration: { readonly clientId: string; readonly authority: string }): MsalClient {
    return this.options.createClient({
      auth: { clientId: registration.clientId, authority: registration.authority },
      cache: {
        cachePlugin: credentialCachePlugin(this.options.credentials, this.key, registration, (error) => {
          console.info('[coteccons-sso] Microsoft 365 token cache write failed', { connector: this.options.id, error: failureLabel(error) })
        }),
      },
    })
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch((_reported: unknown) => undefined)
    return result
  }

  /** Delete this connector's stored cache and drop MSAL's in-memory copy. */
  private async forget(): Promise<void> {
    this.account = undefined
    await this.options.credentials.deleteRecord(this.key)
    /* v8 ignore next -- forget runs only after a client was built from a complete registration. */
    if (this.options.registration !== undefined) this.client = this.newClient(this.options.registration)
  }

  /** Run one attempt to its terminal state; never rejects. */
  private async signIn(client: MsalClient, attempt: Attempt): Promise<void> {
    const deadline = AbortSignal.timeout(this.options.signInTimeoutMs)
    const signal = AbortSignal.any([attempt.controller.signal, deadline])
    let redirectUri: string | null = null
    const release = (): void => { if (redirectUri !== null) void releaseLoopback(redirectUri) }
    signal.addEventListener('abort', release, { once: true })
    let outcome: M365ConnectorError | undefined
    try {
      const result = await client.acquireTokenInteractive({
        scopes: [...this.options.scopes],
        prompt: 'select_account',
        successTemplate: SUCCESS_PAGE,
        errorTemplate: ERROR_PAGE,
        openBrowser: async (url) => {
          redirectUri = new URL(url).searchParams.get('redirect_uri')
          if (signal.aborted) { release(); return }
          attempt.url = url
          this.options.changed()
          const launch = this.options.launchBrowser
          if (launch === undefined) return
          try {
            await launch(url)
          } catch (error) {
            console.info('[coteccons-sso] browser launch failed; the sign-in link stays available', { error: failureLabel(error) })
          }
        },
      })
      const account = result.account
      if (account === null || !this.options.allowed(account)) {
        await this.exclusive(() => this.forget())
        outcome = 'failed'
      } else {
        await this.exclusive(async () => {
          for (const other of await client.getAllAccounts()) {
            if (other.homeAccountId !== account.homeAccountId) await client.getTokenCache().removeAccount(other)
          }
          this.account = account
        })
      }
    } catch (error) {
      console.info('[coteccons-sso] Microsoft 365 sign-in failed', { connector: this.options.id, error: failureLabel(error) })
      outcome = attempt.controller.signal.aborted ? undefined : deadline.aborted ? 'failed' : classifyEntraError(error)
    } finally {
      signal.removeEventListener('abort', release)
    }
    this.attempt = undefined
    this.error = outcome
    this.options.changed()
  }
}
