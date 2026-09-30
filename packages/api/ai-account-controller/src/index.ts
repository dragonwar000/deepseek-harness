/** Authenticated Remote operations for AI Account UI consumers. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-ai-account'
import type { AiAccountId, AiAccountKind, AiAccountSignInId, AiAccountsView } from './types.ts'

/** AI Account commands and a reconnect-safe state stream; configuration directories never cross the wire. */
export class AiAccountController extends TypertRemoteService {
  static inject = ['aiAccount']
  /** @param ctx - Host with the AI Account provider mounted. */
  constructor(ctx: Context) { super(ctx, 'aiAccountController', { namespace: 'aiAccount' }) }
  /**
   * Read the registered accounts and the latest sign-in attempt.
   * @returns the current snapshot.
   */
  @Remote
  getState(): Promise<AiAccountsView> { return this.ctx.aiAccount.getState() }
  /**
   * Start or join an official-CLI sign-in.
   * @param kind - account kind to add or sign back in.
   * @param accountId - registered account to sign back in; omitted to add a new account.
   * @returns the snapshot after the attempt starts.
   */
  @Remote
  startSignIn(kind: AiAccountKind, accountId?: AiAccountId): Promise<AiAccountsView> {
    return this.ctx.aiAccount.startSignIn(kind, accountId)
  }
  /**
   * Ask every account's official CLI whether it is still signed in, subject to the provider's cooldown.
   * @returns the snapshot after the check settles.
   */
  @Remote
  checkLogins(): Promise<AiAccountsView> { return this.ctx.aiAccount.checkLogins() }
  /**
   * Cancel the named sign-in attempt.
   * @param attemptId - attempt to cancel; a stale id leaves a newer attempt running.
   * @returns the snapshot after the attempt settles.
   */
  @Remote
  cancelSignIn(attemptId: AiAccountSignInId): Promise<AiAccountsView> { return this.ctx.aiAccount.cancelSignIn(attemptId) }
  /**
   * Deliver the authorization code the vendor's browser page displayed to the login command reading one.
   * The code reaches the official CLI's terminal and is never stored or logged here.
   * @param attemptId - attempt to complete; a stale id or an attempt reading no code leaves state unchanged.
   * @param code - code the user copied from the vendor's page.
   * @returns the snapshot after the code is delivered.
   */
  @Remote
  submitSignInCode(attemptId: AiAccountSignInId, code: string): Promise<AiAccountsView> {
    return this.ctx.aiAccount.submitSignInCode(attemptId, code)
  }
  /**
   * Make one account the default of its kind.
   * @param accountId - registered account.
   * @returns the snapshot after the change.
   */
  @Remote
  setDefault(accountId: AiAccountId): Promise<AiAccountsView> { return this.ctx.aiAccount.setDefault(accountId) }
  /**
   * Sign one account out through its official CLI and forget it.
   * @param accountId - registered account.
   * @returns the snapshot after removal.
   */
  @Remote
  removeAccount(accountId: AiAccountId): Promise<AiAccountsView> { return this.ctx.aiAccount.remove(accountId) }
  /**
   * Stream complete snapshots, starting with the current one.
   * @param signal - stream lifetime; disconnecting never cancels a sign-in.
   * @returns the snapshot stream.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<AiAccountsView> { return this.ctx.aiAccount.watch(signal) }
}
export default AiAccountController
