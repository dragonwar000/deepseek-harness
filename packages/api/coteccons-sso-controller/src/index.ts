/** Authenticated Remote operations for Coteccons SSO UI consumers. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-coteccons-sso'
import type {
  CotecconsSsoSignInId, CotecconsSsoView, M365ConnectAttemptId, M365ConnectorId, M365ConnectorView,
} from './types.ts'

/** Coteccons SSO commands and a reconnect-safe state stream; access tokens never cross the wire. */
export class CotecconsSsoController extends TypertRemoteService {
  static inject = ['cotecconsSso']
  /** @param ctx - Host with the Coteccons SSO provider mounted. */
  constructor(ctx: Context) { super(ctx, 'cotecconsSsoController', { namespace: 'cotecconsSso' }) }
  /**
   * Read the current sign-in state.
   * @returns the current snapshot.
   */
  @Remote
  getState(): Promise<CotecconsSsoView> { return this.ctx.cotecconsSso.getState() }
  /**
   * Start or join an interactive browser sign-in.
   * @returns the snapshot after the attempt starts.
   */
  @Remote
  startSignIn(): Promise<CotecconsSsoView> { return this.ctx.cotecconsSso.startSignIn() }
  /**
   * Cancel the named sign-in attempt.
   * @param attemptId - attempt to cancel; a stale id leaves a newer attempt running.
   * @returns the snapshot after the attempt settles.
   */
  @Remote
  cancelSignIn(attemptId: CotecconsSsoSignInId): Promise<CotecconsSsoView> { return this.ctx.cotecconsSso.cancelSignIn(attemptId) }
  /**
   * Sign out and delete the stored token cache.
   * @returns the signed-out snapshot.
   */
  @Remote
  signOut(): Promise<CotecconsSsoView> { return this.ctx.cotecconsSso.signOut() }
  /**
   * Stream complete snapshots, starting with the current one.
   * @param signal - stream lifetime; disconnecting never cancels a sign-in.
   * @returns the snapshot stream.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<CotecconsSsoView> { return this.ctx.cotecconsSso.watch(signal) }
  /**
   * Read every Microsoft 365 connector's state.
   * @returns one token-free view per connector.
   */
  @Remote
  getM365State(): Promise<readonly M365ConnectorView[]> { return this.ctx.cotecconsSso.getM365State() }
  /**
   * Start or join a connector's browser sign-in; Entra ID refuses users IT has not assigned.
   * @param id - connector to connect.
   * @returns every connector's state after the attempt starts.
   */
  @Remote
  connectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]> { return this.ctx.cotecconsSso.connectM365(id) }
  /**
   * Connect every configured connector that is not connected, one browser sign-in at a time.
   * @returns every connector's state after the sequence starts.
   */
  @Remote
  connectAllM365(): Promise<readonly M365ConnectorView[]> { return this.ctx.cotecconsSso.connectAllM365() }
  /**
   * Cancel the named connector attempt.
   * @param id - connector whose attempt to cancel.
   * @param attemptId - attempt to cancel; a stale id changes nothing.
   * @returns every connector's state after the attempt settles.
   */
  @Remote
  cancelM365Connect(id: M365ConnectorId, attemptId: M365ConnectAttemptId): Promise<readonly M365ConnectorView[]> {
    return this.ctx.cotecconsSso.cancelM365Connect(id, attemptId)
  }
  /**
   * Forget a connector's stored sign-in on this Host.
   * @param id - connector to disconnect.
   * @returns every connector's state afterwards.
   */
  @Remote
  disconnectM365(id: M365ConnectorId): Promise<readonly M365ConnectorView[]> { return this.ctx.cotecconsSso.disconnectM365(id) }
  /**
   * Stream complete connector snapshots, starting with the current one.
   * @param signal - stream lifetime; disconnecting never cancels an attempt.
   * @returns the snapshot stream.
   */
  @Remote({ mode: 'stream' })
  watchM365(signal: AbortSignal): AsyncIterable<readonly M365ConnectorView[]> { return this.ctx.cotecconsSso.watchM365(signal) }
}
export default CotecconsSsoController
