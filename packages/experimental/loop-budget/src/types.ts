/**
 * Pure types of the loop budget: the one home of the `loop/budget`
 * session-event declaration and its payload types.
 * @module @deepseek-ai/dsh-experimental-loop-budget/types
 */

import type { GoalRef } from '@deepseek-ai/dsh-goal'

/** `turn`: limits reset at every `turn/start`; `goal`: limits accumulate while one goal stays active. */
export type BudgetScope = 'turn' | 'goal'

/** The measured quantity. */
export type BudgetKind = 'steps' | 'tokens' | 'usd' | 'wallMs'

/**
 * `stopped`: a limit tripped with no active goal; `paused`: it tripped and the
 * active goal was paused; `completed`: it tripped right after an `ok`
 * `loop/verdict` and the goal was completed; `floor-steer`: the turn was about
 * to end below its work floor.
 */
export type BudgetAction = 'stopped' | 'paused' | 'completed' | 'floor-steer'

/** One budget trip or work-floor record. */
export interface LoopBudget {
  /** Turn in which the record was made. */
  turn: number
  /** Proposed step for a trip; the last started step for a floor record. */
  step: number
  /** Plugin mode at decision time. */
  mode: 'shadow' | 'enforce'
  /** Which accumulator the limit belongs to. */
  scope: BudgetScope
  /** The measured quantity. */
  kind: BudgetKind
  /** Amount used when the record was made. */
  used: number
  /** The configured limit or floor. */
  limit: number
  /** The decision. */
  action: BudgetAction
  /** True iff the plugin acted (`enforce`); false records a `shadow` decision. */
  applied: boolean
  /** `subagent` when the session header names a parent session. */
  source: 'root' | 'subagent'
  /** The active goal tracked at the time, when there is one. */
  goalId?: GoalRef['id']
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One budget trip or work-floor record. Log-only; never derived history. */
    'loop/budget': LoopBudget
  }
}
