/** Credential-free projections of AI Accounts signed in through the official Claude Code and Codex CLIs. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Subscription product an account belongs to: `claude` signs in through Claude Code, `chatgpt` through Codex. */
export type AiAccountKind = 'claude' | 'chatgpt'

/** Host-minted identity of one registered account; it also names the account's CLI configuration directory. */
export type AiAccountId = Branded<'AiAccountId'>

/** Host-minted identity of one sign-in attempt. */
export type AiAccountSignInId = Branded<'AiAccountSignInId'>

/** One registered account. The subscription credential stays in the official CLI's own configuration directory. */
export interface AiAccountView {
  readonly id: AiAccountId
  readonly kind: AiAccountKind
  /** Email the official CLI reported after sign-in; `null` when the CLI reports none (Codex never does). */
  readonly email: string | null
  /** Subscription plan the official CLI reported (for example Claude `max`); `null` when it reports none. */
  readonly plan: string | null
  /** Registration time in milliseconds since the Unix epoch. */
  readonly createdAt: number
  /** Whether delegated product runs of this kind use this account. Each kind has at most one default. */
  readonly isDefault: boolean
  /** Latest conclusive CLI status or OAuth authorization rejection. */
  readonly status: AiAccountStatusView
}

/**
 * Sign-in status from the account's CLI or credential maintenance.
 * `unknown` means no status check has answered conclusively since the provider started.
 */
export type AiAccountStatus = 'signedIn' | 'signedOut' | 'unknown'

/**
 * Latest conclusive CLI status or rejected OAuth grant for one account. A transient network,
 * storage, or CLI failure leaves this value unchanged.
 */
export interface AiAccountStatusView {
  readonly status: AiAccountStatus
  /** Completion time of the check that produced `status`, in milliseconds since the Unix epoch; `null` while `unknown`. */
  readonly checkedAt: number | null
  /** Credential-free CLI sign-out or OAuth rejection explanation; `null` for other statuses. */
  readonly message: string | null
}

/** One account's sign-in status transition between two conclusive status checks. */
export interface AiAccountStatusChange {
  readonly id: AiAccountId
  readonly kind: AiAccountKind
  /** Whether the account was its kind's default when the transition was recorded. */
  readonly isDefault: boolean
  readonly previous: AiAccountStatus
  readonly current: AiAccountStatusView
}

/**
 * Sign-in progress. `waiting-browser` means the Claude CLI waits for browser authorization;
 * `waiting-device-code` means the Codex CLI printed a verification URL and one-time code;
 * `verifying` reads the signed-in identity back from the CLI.
 */
export type AiAccountSignInPhase =
  | 'starting'
  | 'waiting-browser'
  | 'waiting-device-code'
  | 'verifying'
  | 'succeeded'
  | 'cancelled'
  | 'failed'

/**
 * Failure causes rendered through the caller's locale dictionary.
 * `login-failed` is the official CLI's own refusal; `store-failed` means the CLI
 * signed in but this Harness could not record the account, so the attempt was
 * signed back out instead of being reported as a vendor failure.
 */
export type AiAccountSignInError = 'executable-missing' | 'login-failed' | 'timeout' | 'identity-unavailable' | 'store-failed'

/** The latest sign-in attempt; a terminal phase stays visible until the next attempt starts. */
export interface AiAccountSignInView {
  readonly id: AiAccountSignInId
  readonly kind: AiAccountKind
  readonly phase: AiAccountSignInPhase
  /** Browser authorization URL (Claude) or device verification URL (ChatGPT) the CLI printed; `null` until printed. */
  readonly url: string | null
  /** One-time device code the Codex CLI printed; always `null` for Claude. */
  readonly userCode: string | null
  /**
   * Whether the login command is reading an authorization code from its terminal.
   * The Claude CLI's browser page ends on a code the user copies, so this is the
   * channel that completes a Claude sign-in: while true, {@link AiAccount.submitSignInCode}
   * accepts that code. Always `false` for ChatGPT, whose CLI polls for authorization.
   */
  readonly awaitingCode: boolean
  /** Set only in the `failed` phase. */
  readonly errorCode: AiAccountSignInError | null
}

/** Complete account-list snapshot. Accounts are ordered by kind, then registration time. */
export interface AiAccountsView {
  readonly accounts: readonly AiAccountView[]
  readonly signIn: AiAccountSignInView | null
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The default account of one kind changed, including to no default.
     * @mode emit
     * @param kind - account kind whose default changed.
     */
    'ai-account/default-changed'(kind: AiAccountKind): void
    /**
     * A status check changed one registered account's sign-in status. Emitted once per
     * transition, never for a check that confirms the previous status or answers inconclusively.
     * @mode emit
     * @param change - account, previous status, and the new status view.
     */
    'ai-account/status-changed'(change: AiAccountStatusChange): void
  }
}
