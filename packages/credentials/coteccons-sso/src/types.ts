/** Credential-free projections of the Coteccons single sign-on state through Microsoft Entra ID. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Host-minted identity of one interactive sign-in attempt. */
export type CotecconsSsoSignInId = Branded<'CotecconsSsoSignInId'>

/** Deployment setting that must be configured before anyone can sign in. */
export type CotecconsSsoSetting = 'tenantId' | 'clientId'

/**
 * Why the latest sign-in or token refresh failed. `sign-in-failed` covers a browser or Entra ID refusal,
 * `timeout` an unfinished browser sign-in, `domain-not-allowed` an account outside the configured domains, and
 * `session-expired` a stored sign-in that Entra ID no longer refreshes.
 */
export type CotecconsSsoError = 'sign-in-failed' | 'timeout' | 'domain-not-allowed' | 'session-expired'

/** The signed-in Entra ID account. Tokens never appear in this view. */
export interface CotecconsSsoAccountView {
  /** Display name from the ID token; `null` when Entra ID reports none. */
  readonly name: string | null
  /** User principal name or email the account signed in with. */
  readonly username: string
  /** Directory (tenant) id that issued the account's tokens. */
  readonly tenantId: string
}

/**
 * Complete sign-in state. `not-configured` names the missing deployment settings; `error` is a signed-out
 * state that also reports why the latest attempt or refresh failed.
 */
export type CotecconsSsoView =
  | { readonly status: 'not-configured'; readonly missing: readonly CotecconsSsoSetting[] }
  | { readonly status: 'signed-out' }
  | {
    readonly status: 'signing-in'
    readonly attemptId: CotecconsSsoSignInId
    /** Entra ID authorization URL the browser must open; `null` until the loopback listener is ready. */
    readonly url: string | null
  }
  | { readonly status: 'signed-in'; readonly account: CotecconsSsoAccountView }
  | { readonly status: 'error'; readonly errorCode: CotecconsSsoError }
