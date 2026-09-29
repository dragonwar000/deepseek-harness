/**
 * Pure types of the verifier gate: the one home of the `loop/verdict`
 * session-event declaration and its payload types.
 * @module @deepseek-ai/dsh-experimental-verifier-gate/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

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

/**
 * Gate decision for one turn-stopping boundary. `impossible`, `unverifiable`,
 * and `grader-error` come only from the evaluator; none of them counts as done.
 */
export type LoopVerdictKind = 'ok' | 'not-ok' | 'skipped' | 'impossible' | 'unverifiable' | 'grader-error'

/**
 * Why the gate reached its decision. `blank-response`: the settled response had
 * no tool call and no visible text. `evaluator-*`: an evaluator report decided;
 * `evaluator-error`: no evaluator run produced a usable report.
 * `evidence-unsupported`: the final answer names paths or commands no record
 * of the turn mentions; `evidence-unavailable`: the `graphEvidence` projection
 * is not registered.
 */
export type LoopVerdictReason =
  | 'all-passed'
  | 'command-failed'
  | 'budget-exhausted'
  | 'no-commands'
  | 'blank-response'
  | 'evaluator-passed'
  | 'evaluator-failed'
  | 'evaluator-impossible'
  | 'evaluator-unverifiable'
  | 'evaluator-error'
  | 'evidence-unsupported'
  | 'evidence-unavailable'

/** What one evaluator reported about the work. */
export type EvaluatorVerdict = 'ok' | 'not-ok' | 'impossible' | 'unverifiable'

/** One criterion as an evaluator judged it. */
export interface EvaluationCriterion {
  /** Stable id (`c1`, `c2`, …), unchanged once the criteria freeze. */
  id: string
  /** Checkable wording; the frozen wording wins over a later rewording. */
  text: string
  /** Whether the evaluator found the criterion satisfied. */
  met: boolean
}

/**
 * Why an evaluator run produced no usable report: no subagent service, the
 * child failed to start or to complete, no or malformed structured report, a
 * verdict that contradicts the criteria, criteria that differ from the frozen
 * set, or `unverifiable` without any inspecting tool call.
 */
export type GraderErrorCode =
  | 'no-subagents'
  | 'start-failed'
  | 'run-failed'
  | 'no-report'
  | 'malformed-report'
  | 'inconsistent-report'
  | 'criteria-changed'
  | 'unverifiable-without-attempt'

/** One evaluator child run. */
export interface EvaluationRun {
  /** Child session id; absent when the child never started. */
  childId?: SessionId
  /**
   * The child's `SubagentStopReason` (`completed`, `aborted`, `error`, `max-tokens`, `refusal`, or a provider-added
   * reason); absent when it never started. Typed as a string so this module, which `loop-budget` imports, pulls in no
   * `dsh-subagent` project.
   */
  stopReason?: string
  /** Tool calls the evaluator made besides its structured report. */
  toolCalls: number
  /** The reported verdict; absent on a grader error. */
  verdict?: EvaluatorVerdict
  /** The report reason capped by `evaluator.maxFeedbackChars`, or the grader-error detail. */
  reason: string
  /** Criteria as this run judged them, in canonical order; empty on a grader error. */
  criteria: EvaluationCriterion[]
  /** Set exactly when the run produced no usable report. */
  error?: GraderErrorCode
  /** Canonical positions of the criteria in the order this run was shown them; present when `evaluator.count` is above 1. */
  order?: number[]
}

/** How the evaluators of one round disagreed. */
export interface EvaluationDisagreement {
  /** True when the runs did not all report the same verdict. */
  verdicts: boolean
  /** Ids of criteria some runs found met and others did not. */
  criteria: string[]
}

/** The evaluator's part of one gate decision. */
export interface EvaluationRecord {
  /** 1-based evaluation round within the turn. */
  round: number
  /** True when the criteria were fixed before this round (rubric or an earlier round). */
  frozen: boolean
  /** Criteria the decision used, in canonical order. */
  criteria: EvaluationCriterion[]
  /** Evaluator runs in run order. */
  runs: EvaluationRun[]
  /** Disagreement between the round's runs; present when `evaluator.count` is above 1. */
  disagreement?: EvaluationDisagreement
}

/** One record of the turn that mentions a claimed path or command. */
export interface LoopEvidenceLeaf {
  /** `tool-record`: a tool call argument; `observed`: a successful tool result; `absence`: a failed tool result. */
  kind: 'tool-record' | 'observed' | 'absence'
  /** Seq of the record's event. */
  seq: number
  /** Tool name. */
  tool: string
}

/** One path or command the final answer names; no leaf means parametric. */
export interface LoopEvidenceClaim {
  /** Path or command. */
  kind: 'path' | 'command'
  /** Normalized text. */
  text: string
  /** Records of the turn that mention it. */
  leaves: LoopEvidenceLeaf[]
}

/** The evidence check of one turn-stopping boundary, as the gate used it. */
export interface LoopEvidence {
  /** `evidence.mode` at decision time. */
  mode: 'shadow' | 'enforce'
  /** `no-claims`: the answer names nothing checkable; `unavailable`: the graphEvidence projection is not registered. */
  status: 'supported' | 'unsupported' | 'no-claims' | 'unavailable'
  /** The first `evidence.maxClaims` claims of the answer, in answer order. */
  claims: LoopEvidenceClaim[]
  /** Texts of the recorded claims without a leaf. */
  unsupported: string[]
  /** Set when the answer had more claims than `evidence.maxClaims`. */
  truncated?: true
}

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
  /**
   * Commands run in order; the first failing command ends the list. Empty for `no-commands`, `blank-response`, and a
   * gate without commands.
   */
  checks: VerdictCheck[]
  /** Continuations already spent on this turn before this decision. */
  continuation: number
  /** True iff this decision steered the agent to keep working. */
  continued: boolean
  /** The evaluator's round, criteria, and runs; present when an evaluator round ran. */
  evaluation?: EvaluationRecord
  /** The evidence check; present when `evidence.mode` is not `off` and the verify commands passed. */
  evidence?: LoopEvidence
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One gate decision per turn-stopping boundary. Log-only; never derived history. */
    'loop/verdict': LoopVerdict
  }
}
