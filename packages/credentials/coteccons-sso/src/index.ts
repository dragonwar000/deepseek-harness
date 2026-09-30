/** Coteccons SSO Service Definition: sign one Coteccons staff account in through Microsoft Entra ID and mint its tokens on the Host. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { CotecconsSsoSignInId, CotecconsSsoView } from './types.ts'
export type {
  CotecconsSsoAccountView, CotecconsSsoError, CotecconsSsoSetting, CotecconsSsoSignInId, CotecconsSsoView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cotecconsSso: CotecconsSso
  }
}

/** Why {@link CotecconsSso.getAccessToken} has no token to return. */
export type CotecconsSsoTokenUnavailableReason = 'not-configured' | 'signed-out' | 'session-expired'

/** No signed-in account can supply an access token; the user must sign in again from Settings. */
export class CotecconsSsoTokenUnavailableError extends Error {
  /**
   * @param reason - why no token is available.
   * @param options - optional underlying failure.
   */
  constructor(readonly reason: CotecconsSsoTokenUnavailableReason, options?: ErrorOptions) {
    super(`coteccons-sso: no access token (${reason})`, options)
    this.name = 'CotecconsSsoTokenUnavailableError'
  }
}

/**
 * One Entra ID sign-in per Host. Views never carry tokens; {@link getAccessToken} is Host-only and its
 * result must never be sent to a Client, logged, or stored outside the provider's token cache.
 */
export abstract class CotecconsSso extends Service {
  /** @param ctx - context owning this sign-in implementation. */
  constructor(ctx: Context) { super(ctx, 'cotecconsSso') }

  /**
   * Resource scope consented at sign-in for Azure AI requests, such as `https://cognitiveservices.azure.com/.default`.
   * Model routes request tokens for exactly this scope.
   */
  abstract readonly aiScope: string

  /**
   * Read the current sign-in state.
   * @returns a snapshot without tokens.
   */
  abstract getState(): Promise<CotecconsSsoView>

  /**
   * Join the active attempt or start an interactive browser sign-in. While the deployment is not configured
   * or an account is signed in, the state is returned unchanged.
   * @returns the snapshot after the attempt starts, without waiting for the user.
   */
  abstract startSignIn(): Promise<CotecconsSsoView>

  /**
   * Cancel the named attempt.
   * @param id - attempt identity from this Host; any other id leaves state unchanged.
   * @returns the snapshot after the attempt settles.
   */
  abstract cancelSignIn(id: CotecconsSsoSignInId): Promise<CotecconsSsoView>

  /**
   * Forget the signed-in account and delete its stored token cache.
   * @returns the signed-out snapshot.
   */
  abstract signOut(): Promise<CotecconsSsoView>

  /**
   * Subscribe to complete snapshots, starting with the current one.
   * @param signal - subscription lifetime; ending it never cancels a sign-in.
   * @returns snapshots as the state changes.
   */
  abstract watch(signal: AbortSignal): AsyncIterable<CotecconsSsoView>

  /**
   * Return a current access token for the signed-in account, refreshing it silently when it expired.
   * @param scope - resource scope the token is for.
   * @param signal - caller cancellation.
   * @returns the bearer token value.
   * @throws CotecconsSsoTokenUnavailableError when the deployment is not configured, nobody is signed in,
   * or Entra ID requires the user to sign in again.
   */
  abstract getAccessToken(scope: string, signal?: AbortSignal): Promise<string>
}
export default CotecconsSso
