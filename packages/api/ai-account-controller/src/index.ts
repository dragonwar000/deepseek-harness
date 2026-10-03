/** Authenticated Remote operations for AI Account UI consumers. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-ai-account'
import type { AiAccountId, AiAccountKind, AiAccountSignInId, AiAccountStatusChange, AiAccountsView } from './types.ts'

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
   * @param kind - account kind to add.
   * @returns the snapshot after the attempt starts.
   */
  @Remote
  startSignIn(kind: AiAccountKind): Promise<AiAccountsView> { return this.ctx.aiAccount.startSignIn(kind) }
  /**
   * Ask every account's official CLI whether it is still signed in; a call during a running check joins it.
   * @returns the snapshot after the check settles.
   */
  @Remote
  checkStatus(): Promise<AiAccountsView> { return this.ctx.aiAccount.checkStatus() }
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
  /**
   * Stream sign-in status transitions without replaying earlier ones; `watch` carries the current status.
   * @param signal - stream lifetime.
   * @returns each `ai-account/status-changed` payload emitted while subscribed, in emission order.
   */
  @Remote({ mode: 'stream' })
  async *watchStatusChanges(signal: AbortSignal): AsyncIterable<AiAccountStatusChange> {
    const changes: AiAccountStatusChange[] = []
    let wake: (() => void) | undefined
    const stop = this.ctx.on('ai-account/status-changed', (change) => { changes.push(change); wake?.() })
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const change = changes.shift()
        if (change !== undefined) yield change
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      signal.removeEventListener('abort', abort)
    }
  }
}
export default AiAccountController
