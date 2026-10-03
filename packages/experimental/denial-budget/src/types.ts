/**
 * Pure types of the denial budget: the one home of the `loop/denial`
 * session-event declaration and its payload types.
 * @module @deepseek-ai/dsh-experimental-denial-budget/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

/**
 * `counted`: one policy-denied root call; `approved`: the budget was reached
 * and an approval answered `allowed-once`; `stopped`: the budget was reached
 * and the next step was (or in `shadow` would have been) rejected.
 */
export type DenialDecision = 'counted' | 'approved' | 'stopped'

/** One denial-budget record. */
export interface LoopDenial {
  /** Turn in which the record was made. */
  turn: number
  /** Plugin mode at decision time. */
  mode: 'shadow' | 'enforce'
  /** The denied tool; for `approved`/`stopped`, the most recent denied tool. */
  toolName: string
  /** The denied call; for `approved`/`stopped`, the most recent denied call. */
  callId: ToolCallId
  /** Denied calls in a row, with no allowed call between them. */
  consecutive: number
  /** Denied calls since the last human message. */
  total: number
  /** The decision. */
  decision: DenialDecision
  /** True iff the plugin acted (`enforce`); false records a `shadow` decision. */
  applied: boolean
  /** Approval outcome that decided an `enforce` trip; absent for `counted` and in `shadow`. */
  approval?: ApprovalOutcome
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One denial count or denial-budget decision. Log-only; never derived history. */
    'loop/denial': LoopDenial
  }
}
