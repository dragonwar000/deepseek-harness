/** Authenticated Remote operations for Coteccons SSO UI consumers. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-coteccons-sso'
import type { CotecconsSsoSignInId, CotecconsSsoView } from './types.ts'

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
}
export default CotecconsSsoController
