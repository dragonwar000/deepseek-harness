/** Coteccons SSO Service Definition: sign one Coteccons staff account in through Microsoft Entra ID and mint its tokens on the Host. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CotecconsSsoSignInId, CotecconsSsoView, M365ConnectAttemptId, M365ConnectorError, M365ConnectorId, M365ConnectorView,
} from './types.ts'
export type {
  CotecconsSsoAccountView, CotecconsSsoError, CotecconsSsoSetting, CotecconsSsoSignInId, CotecconsSsoView,
  M365ConnectAttemptId, M365ConnectorError, M365ConnectorId, M365ConnectorView,
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

/** Why {@link CotecconsSso.getM365AccessToken} has no token: the connector's state, or `not-configured`/`disconnected`. */
export type M365AccessUnavailableReason = M365ConnectorError | 'not-configured' | 'disconnected'

/** One Microsoft 365 connector cannot supply a token; IT must grant access or the user must connect it in Settings. */
export class M365AccessUnavailableError extends Error {
  /**
   * @param connector - connector that has no token.
   * @param reason - why no token is available.
   * @param options - optional underlying failure.
   */
  constructor(readonly connector: M365ConnectorId, readonly reason: M365AccessUnavailableReason, options?: ErrorOptions) {
    super(`coteccons-sso: no Microsoft 365 ${connector} access (${reason})`, options)
    this.name = 'M365AccessUnavailableError'
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

  /**
   * Read every Microsoft 365 connector's state, in `mail`, `chat`, `files` order.
   * @returns one token-free view per connector.
   */
  abstract getM365State(): Promise<readonly M365ConnectorView[]>

  /**
   * Join the connector's active attempt or start an interactive browser sign-in against its enterprise app.
   * Entra ID refuses the sign-in when IT has not assigned the user, which leaves the connector `blocked`.
   * @param id - connector to connect.
   * @returns every connector's state after the attempt starts.
   */
  abstract connectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]>

  /**
   * Connect every configured connector that is not connected, one browser sign-in at a time, in the background.
   * A connector IT has not granted ends `blocked` without stopping the others; a second call while the sequence
   * runs joins it.
   * @returns every connector's state after the sequence starts, without waiting for the user.
   */
  abstract connectAllM365(): Promise<readonly M365ConnectorView[]>

  /**
   * Cancel the named connector attempt.
   * @param id - connector whose attempt to cancel.
   * @param attemptId - attempt identity; any other id leaves state unchanged.
   * @returns every connector's state after the attempt settles.
   */
  abstract cancelM365Connect(id: M365ConnectorId, attemptId: M365ConnectAttemptId): Promise<readonly M365ConnectorView[]>

  /**
   * Forget the connector's stored sign-in on this Host. IT-side assignment is unchanged.
   * @param id - connector to disconnect.
   * @returns every connector's state afterwards.
   */
  abstract disconnectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]>

  /**
   * Subscribe to complete connector snapshots, starting with the current one.
   * @param signal - subscription lifetime; ending it never cancels an attempt.
   * @returns snapshots as any connector changes.
   */
  abstract watchM365(signal: AbortSignal): AsyncIterable<readonly M365ConnectorView[]>

  /**
   * Return a current Microsoft Graph token for one connector, refreshing it silently. Host-only; the token must
   * never reach a Client, a log, or the session log.
   * @param id - connector whose enterprise app issues the token.
   * @param signal - caller cancellation.
   * @returns the bearer token value.
   * @throws M365AccessUnavailableError when the connector is not configured, not connected, or blocked by Entra ID.
   */
  abstract getM365AccessToken(id: M365ConnectorId, signal?: AbortSignal): Promise<string>
}
export default CotecconsSso
