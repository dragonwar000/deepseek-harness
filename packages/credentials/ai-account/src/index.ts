/** AI Account Service Definition: register Claude and ChatGPT subscription accounts signed in through their official CLIs. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AiAccountId, AiAccountKind, AiAccountSignInId, AiAccountsView } from './types.ts'
export type {
  AiAccountId, AiAccountKind, AiAccountSignInError, AiAccountSignInId, AiAccountSignInPhase, AiAccountSignInView, AiAccountStatus,
  AiAccountStatusChange, AiAccountStatusView, AiAccountView, AiAccountsView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiAccount: AiAccount
  }
}

/**
 * Account registry with one CLI configuration directory per account. Implementations use
 * the official CLIs for authorization and maintain their subscription credentials for later runs.
 * Credentials are never included in account snapshots or remote responses.
 */
export abstract class AiAccount extends Service {
  /** @param ctx - context owning this account implementation. */
  constructor(ctx: Context) { super(ctx, 'aiAccount') }

  /**
   * Read the registered accounts and the latest sign-in attempt.
   * @returns a snapshot without credentials or directory paths.
   */
  abstract getState(): Promise<AiAccountsView>

  /**
   * Join the active sign-in attempt or start the official CLI login for a new account.
   * @param kind - account kind to add.
   * @returns the snapshot after the attempt starts, without waiting for authorization.
   */
  abstract startSignIn(kind: AiAccountKind): Promise<AiAccountsView>

  /**
   * Cancel the named attempt and discard its unfinished configuration directory.
   * @param id - attempt identity from this Host; any other id leaves state unchanged.
   * @returns the snapshot after the attempt settles.
   */
  abstract cancelSignIn(id: AiAccountSignInId): Promise<AiAccountsView>

  /**
   * Deliver the authorization code the vendor's browser page displayed to the login
   * command that is reading one, completing the attempt. Implementations pass the code
   * to the official CLI and never store or inspect it.
   * @param id - attempt identity from this Host; any other id, or an attempt whose
   * `awaitingCode` is false, leaves state unchanged.
   * @param code - code the user copied from the vendor's page.
   * @returns the snapshot after the code is delivered, without waiting for the CLI to finish.
   */
  abstract submitSignInCode(id: AiAccountSignInId, code: string): Promise<AiAccountsView>

  /**
   * Make one account the default of its kind.
   * @param id - registered account.
   * @returns the snapshot after the default changes.
   * @throws when no account has this id.
   */
  abstract setDefault(id: AiAccountId): Promise<AiAccountsView>

  /**
   * Sign the account out through its official CLI, delete its configuration directory, and forget it.
   * Removing the default promotes the oldest remaining account of the same kind.
   * @param id - registered account.
   * @returns the snapshot after removal.
   * @throws when no account has this id.
   */
  abstract remove(id: AiAccountId): Promise<AiAccountsView>

  /**
   * Run every registered account's official CLI status command now and record each conclusive
   * answer in `AiAccountView.status`, emitting `ai-account/status-changed` once per transition.
   * A call while a check runs joins that check instead of starting another.
   * @returns the snapshot after the check settles.
   */
  abstract checkStatus(): Promise<AiAccountsView>

  /**
   * Subscribe to complete snapshots, starting with the current one.
   * @param signal - subscription lifetime; ending it never cancels a sign-in.
   * @returns snapshots as accounts or the attempt change.
   */
  abstract watch(signal: AbortSignal): AsyncIterable<AiAccountsView>

  /**
   * Resolve the configuration directory of the default account of one kind, for launching that
   * kind's official CLI (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex).
   * @param kind - account kind.
   * @returns the absolute directory, or `undefined` when the kind has no default account.
   */
  abstract defaultHome(kind: AiAccountKind): string | undefined

  /**
   * Refresh expiring subscription credentials before launching a product CLI.
   * @param kind - product whose configuration directory is being used.
   * @param home - CLI directory; an unregistered directory is left untouched.
   * @param signal - caller cancellation; shared maintenance remains owned by the provider.
   * @returns completion once the account credentials are ready; directories without refreshable OAuth retain CLI-managed auth.
   * @throws when credential maintenance fails or the registered account is being removed.
   */
  abstract prepareHome(kind: AiAccountKind, home: string, signal: AbortSignal): Promise<void>
}
export default AiAccount
