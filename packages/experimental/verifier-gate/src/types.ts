/**
 * Pure types of the verifier gate: the one home of the `loop/verdict`
 * session-event declaration and its payload types.
 * @module @deepseek-ai/dsh-experimental-verifier-gate/types
 */

/** One verify command the gate ran for a turn-stopping decision. */
export interface VerdictCheck {
  /** The exact command handed to the shell seam. */
  command: string
  /** Exit code, or null when the process died from a signal or preparation expired. */
  exitCode: number | null
  /** True when the executor's own deadline cut the command short. */
  timedOut: boolean
  /** Tail of stdout and stderr, capped by `verify.stdoutTailChars`. */
  outputTail: string
}

/** Gate decision for one turn-stopping boundary. */
export type LoopVerdictKind = 'ok' | 'not-ok' | 'skipped'

/** Why the gate reached its decision. */
export type LoopVerdictReason = 'all-passed' | 'command-failed' | 'budget-exhausted' | 'no-commands'

/**
 * The durable record of one gate decision. `continued: true` means the gate
 * steered the agent (enforce mode, `not-ok`, continuation budget left).
 */
export interface LoopVerdict {
  /** The turn whose stopping boundary was judged. */
  turn: number
  /** Plugin mode at decision time. */
  mode: 'shadow' | 'enforce'
  /** The decision itself. */
  verdict: LoopVerdictKind
  /** Why the gate decided `verdict`. */
  reason: LoopVerdictReason
  /** Commands run in order; the first failing command ends the list. */
  checks: VerdictCheck[]
  /** Continuations already spent on this turn before this decision. */
  continuation: number
  /** True iff this decision steered the agent to keep working. */
  continued: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One gate decision per turn-stopping boundary. Log-only; never derived history. */
    'loop/verdict': LoopVerdict
  }
}
