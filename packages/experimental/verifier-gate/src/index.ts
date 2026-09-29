/**
 * Turn-stopping verifier gate. Before a turn may end it first checks the
 * settled response: a blank response (no tool call and no text with visible
 * characters) is steered to continue at most `blankResponse.maxSteers` times
 * per turn. Otherwise it runs the configured verify commands through the
 * shell seam; in `enforce` mode a red command steers the agent to keep
 * working (bounded by `maxContinuations`). When the commands pass and
 * `evaluator.enabled` is set, one or `evaluator.count` fresh evaluator
 * children, started one after another through `ctx.subagents`, judge the
 * work against the human request and frozen criteria without seeing the
 * conversation or the model's report. In `enforce` mode `not-ok` steers
 * with the unmet and the already-met criteria;
 * `impossible`, `unverifiable`, a run without a usable report, and an
 * exhausted budget block the session's active goal. When `evidence.mode` is
 * not `off`, the claims of the final answer (paths and commands it names) are
 * checked against the turn's tool records from the `graphEvidence`
 * projection after the commands pass and recorded on the verdict; in
 * `enforce` an unsupported answer is steered. `shadow` mode only
 * records what it would have done. A failed step never reaches this gate
 * (agent-loop runs `agent/turn-stopping` only after a completed step), so the
 * gate needs no failed-step guard.
 * @module @deepseek-ai/dsh-experimental-verifier-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-experimental-graph-projection/types'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import {
  EVALUATOR_LABEL,
  EVALUATOR_REPORT_SCHEMA,
  capHead,
  consensus,
  evaluatorPrompt,
  evaluatorSteerText,
  judgeReport,
  rubricCriteria,
  shuffle,
} from './evaluator.ts'
import type { ConsensusInput, CriterionText } from './evaluator.ts'
import { freshProviderProblem, runFresh } from './fresh-run.ts'
import type { FreshRunOutcome } from './fresh-run.ts'
import type {
  EvaluationRecord,
  EvaluationRun,
  EvaluatorVerdict,
  GraderErrorCode,
  LoopEvidence,
  LoopVerdict,
  VerdictCheck,
} from './types.ts'

export type {
  EvaluationCriterion,
  EvaluationDisagreement,
  EvaluationRecord,
  EvaluationRun,
  EvaluatorVerdict,
  GraderErrorCode,
  LoopEvidence,
  LoopEvidenceClaim,
  LoopEvidenceLeaf,
  LoopVerdict,
  LoopVerdictKind,
  LoopVerdictReason,
  VerdictCheck,
} from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Steering the gate submits after a blank response, a red verify command, or an evaluator objection in `enforce` mode.
     * @persistenceAttribution
     */
    'verifier-gate': { kind: 'verifier-gate' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'verifier-gate'

/** The shell operations the gate uses; `ShellExecutor` satisfies it structurally. */
export interface VerifyShell {
  /**
   * Fill implementation defaults into one request.
   * @param request - the verify command with the gate's timeout and turn signal.
   * @returns the resolved spec to execute.
   */
  resolve(request: ShellExecRequest): ShellExecSpec
  /**
   * Start one resolved command.
   * @param spec - the spec returned by {@link VerifyShell.resolve}.
   * @returns a handle whose `result()` settles with the foreground outcome.
   */
  execute(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
}

/** Verify-command settings. */
export interface VerifyConfig {
  /** Commands run in order at every turn-stopping boundary; empty records `no-commands`. */
  commands?: string[]
  /** Per-command timeout in milliseconds, handed to the shell seam (default 300000). */
  timeoutMs?: number
  /** Characters of the stdout and stderr tail kept in the verdict and steer (default 2000). */
  stdoutTailChars?: number
}

/** Blank-response settings. */
export interface BlankResponseConfig {
  /** Steers per turn after a response with no tool call and no visible text; `0` disables the check (default 1). */
  maxSteers?: number
}

/** Evaluator settings; the evaluator runs only with `enabled`. */
export interface EvaluatorConfig {
  /** Start a fresh evaluator after the verify commands pass (default false). */
  enabled?: boolean
  /** `ctx.subagents` provider for evaluator children; it must start children without the parent conversation (default `spawn`). */
  provider?: string
  /** Fixed criteria `c1`, `c2`, …; empty lets the first evaluator of a turn write them (default none). */
  rubric?: string[]
  /** Global tools the evaluator may call; list read-only tools only (default none). */
  tools?: string[]
  /** Persona that replaces the deployment persona for the evaluator child. */
  persona?: string
  /** Output-token cap for each evaluator request; unset inherits the parent route. Needs the provider's `agentOptions` capability. */
  maxOutputTokens?: number
  /** Evaluation rounds per turn (default 3). */
  maxRounds?: number
  /** Wall-clock limit per evaluator run in milliseconds (default 300000). */
  timeoutMs?: number
  /** Characters of the human request and of the goal objective quoted to the evaluator (default 4000). */
  maxSpecChars?: number
  /** Characters of the evaluator reason kept in the verdict and the steer (default 2000). */
  maxFeedbackChars?: number
  /** Independent evaluators per round, run one after another; above 1 needs `rubric` (default 1). */
  count?: number
  /** With `count` above 1, the ceiling on evaluator runs per turn; `count × maxRounds` above it fails the load (default 3). */
  maxRuns?: number
  /** Seed of each evaluator's order of criteria and verify results when `count` is above 1 (default 0). */
  seed?: number
}

/** Evidence settings; the check runs only outside `off`. */
export interface EvidenceConfig {
  /**
   * `off` skips the check; `shadow` records it on every verdict; `enforce` also steers an unsupported answer and needs
   * gate `mode: enforce`. Default `off`.
   */
  mode?: 'off' | 'shadow' | 'enforce'
  /** `every`: each claim needs a record; `any`: at least one claim does (default `every`). */
  require?: 'every' | 'any'
  /** Claims recorded and checked per answer, in answer order (default 32). */
  maxClaims?: number
}

/**
 * Plugin config. `assumption` is mandatory outside `off`: the sentence naming
 * what the gate assumes about the model, so a later model can retire it.
 */
export interface Config {
  /** `off` registers nothing; `shadow` records verdicts only; `enforce` steers. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Verify-command settings. */
  verify?: VerifyConfig
  /** Blank-response settings. */
  blankResponse?: BlankResponseConfig
  /** Evaluator settings. */
  evaluator?: EvaluatorConfig
  /** Evidence settings. */
  evidence?: EvidenceConfig
  /** Maximum steers per turn before the gate records `budget-exhausted` (default 8). */
  maxContinuations?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  verify: z.object({
    commands: z.array(z.string()).default([]),
    timeoutMs: z.number().default(300_000),
    stdoutTailChars: z.number().default(2000),
  }).default({}),
  blankResponse: z.object({
    maxSteers: z.number().default(1),
  }).default({}),
  evaluator: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default('spawn'),
    rubric: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    persona: z.string().default('You are a strict, independent reviewer. You judge finished work against its request and never do the work yourself.'),
    maxOutputTokens: z.number(),
    maxRounds: z.number().default(3),
    timeoutMs: z.number().default(300_000),
    maxSpecChars: z.number().default(4000),
    maxFeedbackChars: z.number().default(2000),
    count: z.number().default(1),
    maxRuns: z.number().default(3),
    seed: z.number().default(0),
  }).default({}),
  evidence: z.object({
    mode: z.union(['off', 'shadow', 'enforce']).default('off'),
    require: z.union(['every', 'any']).default('every'),
    maxClaims: z.number().default(32),
  }).default({}),
  maxContinuations: z.number().default(8),
})

/** Fixed steer after a blank response; it never names a way to disable the gate. */
const BLANK_RESPONSE_STEER = 'Your last response had no visible text and no tool call, so this turn cannot end on it.\n'
  + 'Continue the task: take the next action with a tool call, or state the result in text.'

/**
 * Model-facing steer text for a red check: names the command and the output
 * tail, never advertises how to disable the gate.
 * @param check - the first failing check.
 * @returns the steer text.
 */
function steerText(check: VerdictCheck): string {
  return `verify command failed (exit ${check.exitCode ?? 'signal'}${check.timedOut ? ', timed out' : ''}): ${check.command}\n`
    + `Output tail:\n${check.outputTail}\n`
    + 'Fix the cause, rerun the failing check yourself, and only then finish.'
}

/** First line of the evidence steer; the unsupported claims follow, one per line. */
export const EVIDENCE_STEER_HEAD = 'Your answer names files or commands that no tool call or tool result in this turn shows:'
/** Last line of the evidence steer. */
export const EVIDENCE_STEER_TAIL = 'Check each one with a tool now, or remove it from the answer, then finish.'

/**
 * Model-facing steer for an unsupported answer; it never names a way to disable the check.
 * @param unsupported - claim texts without a leaf.
 * @returns the steer text.
 */
function evidenceSteerText(unsupported: readonly string[]): string {
  return [EVIDENCE_STEER_HEAD, ...unsupported.map(claim => `- ${claim}`), EVIDENCE_STEER_TAIL].join('\n')
}

/**
 * Keep the last `cap` characters of the combined streams.
 * @param result - the settled shell result.
 * @param cap - maximum characters kept.
 * @returns the tail of stdout, a newline, and stderr.
 */
function tail(result: ShellRunResult, cap: number): string {
  const joined = `${result.stdout.text}\n${result.stderr.text}`
  return joined.length <= cap ? joined : joined.slice(joined.length - cap)
}

/**
 * Reject a numeric setting that is not an integer at or above `min`.
 * @param field - config path named in the error.
 * @param value - the validated number.
 * @param min - the smallest accepted value.
 */
function requireInteger(field: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`verifier-gate: invalid ${field} ${value} — must be an integer >= ${min}`)
  }
}

/**
 * Whether a settled response gives the user nothing: no tool call and no text
 * block with visible characters. Reasoning blocks are not output.
 * @param content - the assistant message content.
 * @returns true for a blank response.
 */
function isBlank(content: readonly ContentBlock[]): boolean {
  return content.every(block => block.type === 'reasoning' || (block.type === 'text' && block.text.trim() === ''))
}

/**
 * Join the text blocks of a message.
 * @param content - the message content.
 * @returns the text blocks separated by newlines.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Per-agent steering and evaluation state for one turn. */
interface Budget {
  turn: number
  continuation: number
  blankSteers: number
  /** Evaluation rounds already run in this turn. */
  evaluationRounds: number
  /** Criteria frozen for this turn: the rubric, or the first round's criteria. */
  criteria: readonly CriterionText[] | undefined
}

/** One evaluator run as the gate read it: a usable report or a grader error. */
type JudgedRun =
  | { readonly kind: 'report'; readonly verdict: EvaluatorVerdict; readonly run: EvaluationRun }
  | { readonly kind: 'error'; readonly code: GraderErrorCode; readonly run: EvaluationRun }

/** Facts about a run that hold whether or not it produced a usable report. */
type RunFacts = Pick<EvaluationRun, 'childId' | 'stopReason' | 'toolCalls' | 'order'>

/** Appends one `loop/verdict` for the boundary being judged. */
type Recorder = (verdict: Omit<LoopVerdict, 'turn' | 'mode' | 'continuation'>) => void

/**
 * Record a run that produced no usable report.
 * @param code - the grader-error classification.
 * @param detail - what went wrong; recorded as the run reason.
 * @param facts - child id, stop reason, and tool-call count known so far.
 * @returns the judged run.
 */
function errorRun(code: GraderErrorCode, detail: string, facts: RunFacts): JudgedRun {
  return { kind: 'error', code, run: { ...facts, reason: detail, criteria: [], error: code } }
}

/**
 * Install the gate.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - validated {@link Config}; blank `assumption`, invalid numbers, a blank rubric
 * line, commands without a mounted `shell`, an unfit evaluator provider, `evidence.mode: enforce` outside gate
 * `enforce`, and an evidence check without `sessionProjections` fail the load.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const mode = config.mode as 'off' | 'shadow' | 'enforce'
  if (mode === 'off') return
  if ((config.assumption as string).trim() === '') {
    throw new Error('verifier-gate: `assumption` must name what this gate assumes about the model')
  }
  const verify = config.verify as Required<VerifyConfig>
  const blankResponse = config.blankResponse as Required<BlankResponseConfig>
  const evaluator = config.evaluator as Required<Omit<EvaluatorConfig, 'maxOutputTokens'>> & Pick<EvaluatorConfig, 'maxOutputTokens'>
  const maxContinuations = config.maxContinuations as number
  requireInteger('maxContinuations', maxContinuations, 0)
  const evidence = config.evidence as Required<EvidenceConfig>
  requireInteger('evidence.maxClaims', evidence.maxClaims, 1)
  if (evidence.mode === 'enforce' && mode !== 'enforce') throw new Error('verifier-gate: evidence.mode enforce needs mode enforce')
  if (evidence.mode !== 'off' && ctx.get('sessionProjections') === undefined) {
    throw new Error('verifier-gate: evidence.mode needs the sessionProjections service; mount @deepseek-ai/dsh-experimental-graph-projection for the graphEvidence projection')
  }
  requireInteger('blankResponse.maxSteers', blankResponse.maxSteers, 0)
  requireInteger('verify.timeoutMs', verify.timeoutMs, 1)
  requireInteger('verify.stdoutTailChars', verify.stdoutTailChars, 1)
  requireInteger('evaluator.maxRounds', evaluator.maxRounds, 1)
  requireInteger('evaluator.timeoutMs', evaluator.timeoutMs, 1)
  requireInteger('evaluator.maxSpecChars', evaluator.maxSpecChars, 1)
  requireInteger('evaluator.maxFeedbackChars', evaluator.maxFeedbackChars, 1)
  if (evaluator.maxOutputTokens !== undefined) requireInteger('evaluator.maxOutputTokens', evaluator.maxOutputTokens, 1)
  if (evaluator.rubric.some(text => text.trim() === '')) {
    throw new Error('verifier-gate: `evaluator.rubric` entries must be non-blank')
  }
  requireInteger('evaluator.count', evaluator.count, 1)
  requireInteger('evaluator.maxRuns', evaluator.maxRuns, 1)
  requireInteger('evaluator.seed', evaluator.seed, 0)
  if (evaluator.count > 1 && evaluator.rubric.length === 0) {
    throw new Error('verifier-gate: evaluator.count above 1 needs a fixed evaluator.rubric so every evaluator judges the same criteria')
  }
  if (evaluator.count > 1 && evaluator.count * evaluator.maxRounds > evaluator.maxRuns) {
    throw new Error(`verifier-gate: evaluator.count × evaluator.maxRounds = ${evaluator.count * evaluator.maxRounds} exceeds evaluator.maxRuns ${evaluator.maxRuns}; raise maxRuns to accept that many evaluator runs per turn`)
  }
  if (verify.commands.length > 0 && ctx.get('shell') === undefined) {
    throw new Error('verifier-gate: `verify.commands` is set but no `shell` service is mounted')
  }
  if (evaluator.enabled) {
    const checkProvider = (provider: SubagentProvider): void => {
      const problem = freshProviderProblem(provider, evaluator.maxOutputTokens !== undefined)
      if (problem !== undefined) throw new Error(`verifier-gate: evaluator ${problem}`)
    }
    const registered = ctx.get('subagents')?.getProvider(evaluator.provider)
    if (registered !== undefined) checkProvider(registered)
    // A provider mounted after the gate is checked when it registers; its registration fails loud.
    ctx.on('subagent/provider-added', (provider) => {
      if (provider.name === evaluator.provider) checkProvider(provider)
    })
  }
  const rubric = rubricCriteria(evaluator.rubric)

  const budgets = new WeakMap<Agent, Budget>()
  // Turn number of the latest settled response while it is blank, folded from the log.
  const blankTurns = new WeakMap<Session, number>()
  // Latest human request text per session, folded from the log.
  const requests = new WeakMap<Session, string>()
  // Parent sessions whose gate is waiting on an evaluator child right now.
  const evaluating = new Set<SessionId>()
  // Evaluator children of this gate: never judged here; their inspecting tool calls are counted.
  const evaluatorSessions = new WeakSet<Session>()
  const evaluatorToolCalls = new Map<SessionId, number>()

  function budgetOf(agent: Agent, turn: number): Budget {
    const current = budgets.get(agent)
    if (current !== undefined && current.turn === turn) return current
    const fresh: Budget = {
      turn,
      continuation: 0,
      blankSteers: 0,
      evaluationRounds: 0,
      criteria: rubric.length > 0 ? rubric : undefined,
    }
    budgets.set(agent, fresh)
    return fresh
  }

  // Enforce mode ends automatic goal rounds when another round cannot change the gate's answer.
  function blockGoal(agent: Agent, code: string, message: string): void {
    if (mode !== 'enforce') return
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goals === undefined || goal === undefined || goal.phase !== 'active') return
    goals.block(agent, { id: goal.id, revision: goal.revision }, { code, message })
  }

  function judgeEvidence(session: Session, turn: number): LoopEvidence {
    const checkMode = evidence.mode as 'shadow' | 'enforce'
    const projections = ctx.get('sessionProjections')
    /* v8 ignore next -- the load check requires sessionProjections whenever the evidence check runs. */
    const state = projections === undefined ? undefined : projections.stateOf(session, 'graphEvidence')
    if (state === undefined) return { mode: checkMode, status: 'unavailable', claims: [], unsupported: [] }
    /* v8 ignore next -- agent-loop appends the turn's assistant/message after turn/start and before agent/turn-stopping. */
    const all = state.answer !== null && state.answer.turn === turn ? state.answer.claims : []
    const claims = all.slice(0, evidence.maxClaims)
    const unsupported = claims.filter(claim => claim.leaves.length === 0).map(claim => claim.text)
    const failing = evidence.require === 'every' ? unsupported.length > 0 : unsupported.length === claims.length
    let status: LoopEvidence['status'] = failing ? 'unsupported' : 'supported'
    if (claims.length === 0) status = 'no-claims'
    return { mode: checkMode, status, claims, unsupported, ...all.length > claims.length ? { truncated: true } : {} }
  }

  function enforceEvidence(agent: Agent, budget: Budget, checks: VerdictCheck[], found: LoopEvidence, record: Recorder): boolean {
    if (found.status === 'unavailable') {
      record({ verdict: 'not-ok', reason: 'evidence-unavailable', checks, continued: false })
      blockGoal(agent, 'verifier-evidence-unavailable', 'the graphEvidence projection is not registered, so the evidence of this turn cannot be judged')
      return true
    }
    if (found.status !== 'unsupported') return false
    if (budget.continuation >= maxContinuations) {
      record({ verdict: 'not-ok', reason: 'budget-exhausted', checks, continued: false })
      blockGoal(agent, 'verifier-budget-exhausted', `the answer still names ${found.unsupported.length} claim(s) without evidence after ${maxContinuations} continuation(s)`)
      return true
    }
    record({ verdict: 'not-ok', reason: 'evidence-unsupported', checks, continued: true })
    budget.continuation += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: evidenceSteerText(found.unsupported) }],
      source: { kind: 'verifier-gate', form: 'notice', summary: boundContextSummary(`evidence: ${found.unsupported.length} unsupported claim(s)`) },
    }))
    return true
  }

  async function runChecks(signal: AbortSignal): Promise<VerdictCheck[]> {
    const shell: VerifyShell | undefined = ctx.get('shell')
    if (shell === undefined) throw new Error('verifier-gate: the `shell` service is no longer mounted')
    const checks: VerdictCheck[] = []
    for (const command of verify.commands) {
      const execution = await shell.execute(shell.resolve({ command, timeoutMs: verify.timeoutMs, signal }))
      const result = await execution.result()
      checks.push({ command, exitCode: result.exitCode, timedOut: result.timedOut, outputTail: tail(result, verify.stdoutTailChars) })
      if (result.exitCode !== 0) break
    }
    return checks
  }

  async function evaluateOnce(
    agent: Agent,
    turn: number,
    round: number,
    run: number,
    checks: readonly VerdictCheck[],
    frozen: readonly CriterionText[] | undefined,
    signal: AbortSignal,
  ): Promise<JudgedRun> {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return errorRun('no-subagents', 'no `subagents` service is mounted', { toolCalls: 0 })
    const goal = ctx.get('goals')?.get(agent)
    const canonical = frozen ?? []
    // Several evaluators each see the criteria and verify results in their own seeded order.
    const key = `${evaluator.seed}:${turn}:${round}:${run}`
    const shuffled = evaluator.count > 1 ? shuffle(canonical, `${key}:criteria`) : undefined
    const prompt = evaluatorPrompt({
      request: requests.get(agent.session),
      objective: goal?.phase === 'active' ? goal.objective : undefined,
      maxSpecChars: evaluator.maxSpecChars,
      criteria: shuffled === undefined ? canonical : shuffled.items,
      frozen: frozen !== undefined,
      turn,
      round,
      maxRounds: evaluator.maxRounds,
      checks: shuffled === undefined ? checks : shuffle(checks, `${key}:checks`).items,
    })
    const ordered = shuffled === undefined ? {} : { order: shuffled.order }
    evaluating.add(agent.session.id)
    let outcome: FreshRunOutcome
    try {
      outcome = await runFresh(subagents, {
        provider: evaluator.provider,
        label: EVALUATOR_LABEL,
        parent: agent,
        prompt: [{ type: 'text', text: prompt }],
        persona: evaluator.persona,
        toolFilter: { allow: evaluator.tools },
        outputSchema: EVALUATOR_REPORT_SCHEMA,
        ...evaluator.maxOutputTokens === undefined ? {} : { agentOptions: { maxTokens: evaluator.maxOutputTokens } },
        timeoutMs: evaluator.timeoutMs,
        signal,
      })
    } finally {
      evaluating.delete(agent.session.id)
    }
    if (outcome.kind === 'failed') {
      return errorRun(outcome.stage === 'start' ? 'start-failed' : 'run-failed', outcome.message, {
        toolCalls: 0,
        ...ordered,
        ...outcome.childId === undefined ? {} : { childId: outcome.childId },
      })
    }
    const toolCalls = evaluatorToolCalls.get(outcome.childId) ?? 0
    evaluatorToolCalls.delete(outcome.childId)
    const facts: RunFacts = { childId: outcome.childId, stopReason: outcome.stopReason, toolCalls, ...ordered }
    if (outcome.stopReason !== 'completed') {
      return errorRun('run-failed', `the evaluator run ended ${outcome.stopReason}`, facts)
    }
    if (outcome.structured === undefined) {
      return errorRun('no-report', 'the evaluator finished without a structured report', facts)
    }
    const judgement = judgeReport(outcome.structured, frozen, toolCalls)
    if (judgement.kind === 'error') return errorRun(judgement.code, judgement.detail, facts)
    const { verdict, reason, criteria } = judgement.report
    return { kind: 'report', verdict, run: { ...facts, verdict, reason: capHead(reason, evaluator.maxFeedbackChars), criteria } }
  }

  async function judge(
    agent: Agent,
    turn: number,
    budget: Budget,
    checks: VerdictCheck[],
    signal: AbortSignal,
    record: Recorder,
  ): Promise<void> {
    if (budget.evaluationRounds >= evaluator.maxRounds) {
      record({ verdict: 'not-ok', reason: 'budget-exhausted', checks, continued: false })
      blockGoal(agent, 'verifier-budget-exhausted', `the evaluator round budget (${evaluator.maxRounds}) is spent for this turn`)
      return
    }
    budget.evaluationRounds += 1
    const round = budget.evaluationRounds
    const frozen = budget.criteria
    const graderError = (failed: Extract<JudgedRun, { kind: 'error' }>, runs: EvaluationRun[]): void => {
      record({ verdict: 'grader-error', reason: 'evaluator-error', checks, continued: false, evaluation: { round, frozen: frozen !== undefined, criteria: [], runs } })
      blockGoal(agent, 'verifier-grader-error', `the evaluator produced no usable report (${failed.code}): ${failed.run.reason}`)
    }
    // Evaluators run one after another; the first run without a usable report ends the round.
    const head = await evaluateOnce(agent, turn, round, 1, checks, frozen, signal)
    if (head.kind === 'error') {
      graderError(head, [head.run])
      return
    }
    const runs: EvaluationRun[] = [head.run]
    const rest: ConsensusInput[] = []
    for (let run = 2; run <= evaluator.count; run += 1) {
      const next = await evaluateOnce(agent, turn, round, run, checks, frozen, signal)
      runs.push(next.run)
      if (next.kind === 'error') {
        graderError(next, runs)
        return
      }
      rest.push({ verdict: next.verdict, criteria: next.run.criteria })
    }
    const agreed = consensus({ verdict: head.verdict, criteria: head.run.criteria }, rest)
    const evaluation: EvaluationRecord = {
      round,
      frozen: frozen !== undefined,
      criteria: agreed.criteria,
      runs,
      ...evaluator.count > 1 ? { disagreement: agreed.disagreement } : {},
    }
    const reasons = runs.map(entry => entry.reason)
    if (agreed.verdict === undefined) {
      record({ verdict: 'grader-error', reason: 'evaluator-error', checks, continued: false, evaluation })
      blockGoal(agent, 'verifier-grader-error', `the evaluators reached no consensus: ${reasons.join(' | ')}`)
      return
    }
    budget.criteria ??= agreed.criteria.map(({ id, text }) => ({ id, text }))
    if (agreed.verdict === 'ok') {
      record({ verdict: 'ok', reason: 'evaluator-passed', checks, continued: false, evaluation })
      return
    }
    if (agreed.verdict === 'impossible' || agreed.verdict === 'unverifiable') {
      record({
        verdict: agreed.verdict,
        reason: agreed.verdict === 'impossible' ? 'evaluator-impossible' : 'evaluator-unverifiable',
        checks,
        continued: false,
        evaluation,
      })
      blockGoal(agent, `verifier-${agreed.verdict}`, `the evaluator judged the request ${agreed.verdict}: ${reasons.join(' | ')}`)
      return
    }
    if (mode === 'shadow') {
      record({ verdict: 'not-ok', reason: 'evaluator-failed', checks, continued: false, evaluation })
      return
    }
    if (round >= evaluator.maxRounds || budget.continuation >= maxContinuations) {
      record({ verdict: 'not-ok', reason: 'budget-exhausted', checks, continued: false, evaluation })
      blockGoal(agent, 'verifier-budget-exhausted', `the evaluator still finds the work incomplete after ${round} round(s)`)
      return
    }
    record({ verdict: 'not-ok', reason: 'evaluator-failed', checks, continued: true, evaluation })
    budget.continuation += 1
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: evaluatorSteerText({ round, maxRounds: evaluator.maxRounds, reasons, criteria: agreed.criteria }),
      }],
      source: {
        kind: 'verifier-gate',
        form: 'notice',
        summary: boundContextSummary(`evaluator: ${agreed.criteria.filter(criterion => !criterion.met).length} criteria unmet`),
      },
    }))
  }

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'assistant/message':
        if (isBlank(event.data.message.content)) blankTurns.set(session, event.data.turn)
        else blankTurns.delete(session)
        return
      case 'user/message':
        if (event.data.source.kind === 'user') requests.set(session, textOf(event.data.content))
        return
      case 'subagent/descriptor':
        if (event.data.label === EVALUATOR_LABEL
          && event.data.provider === evaluator.provider
          && [...evaluating].some(id => id === session.header.parentSession)) {
          evaluatorSessions.add(session)
        }
        return
      case 'tool/call':
        if (evaluatorSessions.has(session) && event.data.name !== STRUCTURED_OUTPUT_TOOL) {
          evaluatorToolCalls.set(session.id, (evaluatorToolCalls.get(session.id) ?? 0) + 1)
        }
        return
      default:
        // SessionEventMap is merge-extensible; every other event leaves the gate's folds unchanged.
        return
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    // The parent's gate judges its evaluator child; the child's own boundary is not judged again.
    if (evaluatorSessions.has(agent.session)) return
    const budget = budgetOf(agent, turn)
    let found: LoopEvidence | undefined
    const record: Recorder = (verdict) => {
      agent.session.append('loop/verdict', { turn, mode, continuation: budget.continuation, ...verdict, ...found === undefined ? {} : { evidence: found } })
    }

    if (blankTurns.get(agent.session) === turn
      && budget.blankSteers < blankResponse.maxSteers
      && budget.continuation < maxContinuations) {
      budget.blankSteers += 1
      if (mode === 'shadow') {
        record({ verdict: 'not-ok', reason: 'blank-response', checks: [], continued: false })
        return
      }
      record({ verdict: 'not-ok', reason: 'blank-response', checks: [], continued: true })
      budget.continuation += 1
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: BLANK_RESPONSE_STEER }],
        source: { kind: 'verifier-gate', form: 'notice', summary: boundContextSummary('blank response: continue the task') },
      }))
      return
    }

    const checks: VerdictCheck[] = verify.commands.length === 0 ? [] : await runChecks(signal)
    const failed = checks.find(check => check.exitCode !== 0)
    if (failed !== undefined) {
      if (mode === 'shadow') {
        record({ verdict: 'not-ok', reason: 'command-failed', checks, continued: false })
        return
      }
      if (budget.continuation >= maxContinuations) {
        record({ verdict: 'not-ok', reason: 'budget-exhausted', checks, continued: false })
        blockGoal(agent, 'verifier-budget-exhausted', `verify command still failing after ${maxContinuations} continuation(s): ${failed.command}`)
        return
      }
      record({ verdict: 'not-ok', reason: 'command-failed', checks, continued: true })
      budget.continuation += 1
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: steerText(failed) }],
        source: { kind: 'verifier-gate', form: 'notice', summary: boundContextSummary(`verify failed: ${failed.command}`) },
      }))
      return
    }
    if (evidence.mode !== 'off') {
      found = judgeEvidence(agent.session, turn)
      if (evidence.mode === 'enforce' && enforceEvidence(agent, budget, checks, found, record)) return
    }
    if (evaluator.enabled) {
      await judge(agent, turn, budget, checks, signal, record)
      return
    }
    if (checks.length === 0) {
      record({ verdict: 'skipped', reason: 'no-commands', checks, continued: false })
      return
    }
    record({ verdict: 'ok', reason: 'all-passed', checks, continued: false })
  })

  // Human input starts a new judgement; the continuation budget resets.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) budgets.delete(agent)
    return next()
  })
}
