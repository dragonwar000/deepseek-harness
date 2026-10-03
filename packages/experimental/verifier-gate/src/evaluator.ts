/**
 * The verifier gate's evaluator vocabulary: the structured report schema a
 * fresh evaluator child must satisfy, the prompt it receives (the human
 * request, the goal objective, the criteria, and harness-run facts — never the
 * worker's own report), report decoding and checking against frozen criteria,
 * and the steer a `not-ok` verdict sends back to the worker.
 * @module @deepseek-ai/dsh-experimental-verifier-gate/evaluator
 */

import { createHash } from 'node:crypto'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { EvaluationCriterion, EvaluationDisagreement, EvaluatorVerdict, GraderErrorCode, VerdictCheck } from './types.ts'

/**
 * Descriptor label of every evaluator child. With the configured provider and
 * a parent that is waiting on an evaluator, it exempts the child from the gate.
 */
export const EVALUATOR_LABEL = 'verifier-gate evaluator'

/** A criterion's identity and wording, without a judgement. */
export interface CriterionText {
  /** Stable id (`c1`, `c2`, …). */
  readonly id: string
  /** Checkable wording. */
  readonly text: string
}

/** Structured report every evaluator child must return. */
export const EVALUATOR_REPORT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'not-ok', 'impossible', 'unverifiable'] },
    reason: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          met: { type: 'boolean' },
        },
        required: ['id', 'text', 'met'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'reason', 'criteria'],
  additionalProperties: false,
}

/** A decoded evaluator report. */
export interface EvaluatorReport {
  /** The reported verdict. */
  readonly verdict: EvaluatorVerdict
  /** The evaluator's explanation. */
  readonly reason: string
  /** Criteria with ids unique within the report. */
  readonly criteria: EvaluationCriterion[]
}

/** The gate's reading of one structured report: usable, or a grader error. */
export type RunJudgement =
  | { readonly kind: 'report'; readonly report: EvaluatorReport }
  | { readonly kind: 'error'; readonly code: GraderErrorCode; readonly detail: string }

/** Everything the evaluator prompt shows besides its fixed text. */
export interface EvaluatorPromptInput {
  /** Latest human request of the session, or undefined when there is none. */
  readonly request: string | undefined
  /** Objective of the active goal, or undefined. */
  readonly objective: string | undefined
  /** Characters kept from the request and from the objective. */
  readonly maxSpecChars: number
  /** Frozen criteria in the order shown; empty asks the evaluator to write them. */
  readonly criteria: readonly CriterionText[]
  /** Whether the criteria are frozen. */
  readonly frozen: boolean
  /** Turn being judged. */
  readonly turn: number
  /** 1-based evaluation round. */
  readonly round: number
  /** Rounds allowed per turn. */
  readonly maxRounds: number
  /** Verify commands that passed at this boundary. */
  readonly checks: readonly VerdictCheck[]
}

/** Inputs of the steer after a `not-ok` verdict. */
export interface EvaluatorSteerInput {
  /** 1-based evaluation round. */
  readonly round: number
  /** Rounds allowed per turn. */
  readonly maxRounds: number
  /** One capped reason per evaluator run, in run order. */
  readonly reasons: readonly string[]
  /** Criteria in canonical order with their judgement. */
  readonly criteria: readonly EvaluationCriterion[]
}

const VERDICTS: readonly EvaluatorVerdict[] = ['ok', 'not-ok', 'impossible', 'unverifiable']

/**
 * Number deployment rubric lines as frozen criteria.
 * @param rubric - criterion wordings in order.
 * @returns criteria `c1`, `c2`, … in the same order.
 */
export function rubricCriteria(rubric: readonly string[]): CriterionText[] {
  return rubric.map((text, index) => ({ id: `c${index + 1}`, text }))
}

/**
 * Keep the first `cap` characters of a text.
 * @param text - the text.
 * @param cap - maximum characters kept.
 * @returns the text, or its head when longer than `cap`.
 */
export function capHead(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap)
}

/**
 * Render the evaluator child's only user message.
 * @param input - request, objective, criteria, and harness facts.
 * @returns the prompt text.
 */
export function evaluatorPrompt(input: EvaluatorPromptInput): string {
  const lines = [
    'You are an independent evaluator. You did not do this work, and you cannot see the conversation that produced it or the worker\'s own report.',
    'Judge the request below against the workspace as it is now. Inspect it only with the tools you have; do not change anything.',
    '',
    '<request>',
    input.request === undefined ? '(no human request in this session)' : capHead(input.request, input.maxSpecChars),
    '</request>',
  ]
  if (input.objective !== undefined) {
    lines.push('<goal-objective>', capHead(input.objective, input.maxSpecChars), '</goal-objective>')
  }
  lines.push(`<criteria frozen="${String(input.frozen)}">`)
  if (input.criteria.length === 0) {
    lines.push('(none yet: write 2 to 6 concrete, checkable criteria for the request, with ids c1, c2, and so on)')
  }
  for (const criterion of input.criteria) lines.push(`- ${criterion.id}: ${criterion.text}`)
  lines.push(
    '</criteria>',
    '<runtime-state source="harness">',
    `turn: ${input.turn}`,
    `evaluation round: ${input.round} of ${input.maxRounds}`,
  )
  if (input.checks.length === 0) {
    lines.push('verify commands: none configured')
  } else {
    lines.push('verify commands (all passed):')
  }
  for (const check of input.checks) {
    lines.push(`- ${check.command}`, '  output tail:', ...check.outputTail.split('\n').map(line => `  ${line}`))
  }
  lines.push(
    '</runtime-state>',
    '',
    `Report by calling the ${STRUCTURED_OUTPUT_TOOL} tool:`,
    '- criteria: every criterion listed above with the same id and text, or the ones you wrote when none are listed, each with met true or false.',
    '- verdict: "ok" only when every criterion is met; "not-ok" when a criterion is unmet and further work can meet it; "impossible" only when no further work in this workspace can satisfy the request; "unverifiable" only after you tried to inspect the workspace and could not determine the result.',
    '- reason: one short paragraph naming what you checked.',
  )
  return lines.join('\n')
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value carries the three criterion fields with their JSON types. */
function isCriterion(value: unknown): value is EvaluationCriterion {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['text'] === 'string'
    && typeof value['met'] === 'boolean'
}

/**
 * Decode a structured result crossing the provider boundary.
 * @param value - the child's structured result.
 * @returns a detached report, or undefined when the fields or types do not match.
 */
export function decodeReport(value: unknown): EvaluatorReport | undefined {
  if (!isRecord(value)) return undefined
  const verdict = VERDICTS.find(entry => entry === value['verdict'])
  const reason = value['reason']
  const raw = value['criteria']
  if (verdict === undefined || typeof reason !== 'string' || !Array.isArray(raw)) return undefined
  const criteria: EvaluationCriterion[] = []
  for (const entry of raw) {
    if (!isCriterion(entry)) return undefined
    criteria.push({ id: entry.id, text: entry.text, met: entry.met })
  }
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) return undefined
  return { verdict, reason, criteria }
}

/**
 * Check one structured result against the frozen criteria and its own verdict.
 * @param value - the child's structured result.
 * @param frozen - frozen criteria, or undefined in an unfrozen first round.
 * @param toolCalls - the evaluator's tool calls besides its report.
 * @returns the usable report with frozen wording, or the grader error.
 */
export function judgeReport(value: unknown, frozen: readonly CriterionText[] | undefined, toolCalls: number): RunJudgement {
  const report = decodeReport(value)
  if (report === undefined) {
    return { kind: 'error', code: 'malformed-report', detail: 'the structured report does not match the evaluator report fields' }
  }
  if (report.criteria.length === 0) {
    return { kind: 'error', code: 'inconsistent-report', detail: 'the report judges no criteria' }
  }
  let criteria = report.criteria
  if (frozen !== undefined) {
    const judged = new Map(report.criteria.map(criterion => [criterion.id, criterion.met]))
    if (report.criteria.length !== frozen.length || frozen.some(criterion => !judged.has(criterion.id))) {
      return {
        kind: 'error',
        code: 'criteria-changed',
        detail: `expected criteria ${frozen.map(criterion => criterion.id).join(', ')}, got ${report.criteria.map(criterion => criterion.id).join(', ')}`,
      }
    }
    criteria = frozen.map(criterion => ({ id: criterion.id, text: criterion.text, met: judged.get(criterion.id) === true }))
  }
  const allMet = criteria.every(criterion => criterion.met)
  if (report.verdict === 'ok' && !allMet) {
    return { kind: 'error', code: 'inconsistent-report', detail: 'the report says ok with an unmet criterion' }
  }
  if (report.verdict === 'not-ok' && allMet) {
    return { kind: 'error', code: 'inconsistent-report', detail: 'the report says not-ok with every criterion met' }
  }
  if (report.verdict === 'unverifiable' && toolCalls === 0) {
    return { kind: 'error', code: 'unverifiable-without-attempt', detail: 'the evaluator reported unverifiable without inspecting anything' }
  }
  return { kind: 'report', report: { verdict: report.verdict, reason: report.reason, criteria } }
}

/**
 * Render criterion lines, or a placeholder for an empty list.
 * @param criteria - criteria to list.
 * @returns one `- <id>: <text>` line each, or `- (none)`.
 */
function criterionLines(criteria: readonly EvaluationCriterion[]): string[] {
  return criteria.length === 0 ? ['- (none)'] : criteria.map(criterion => `- ${criterion.id}: ${criterion.text}`)
}

/**
 * Render the steer after a `not-ok` verdict. The evaluator reason is marked as
 * model output so it does not read as an instruction from the user.
 * @param input - round, reason, and judged criteria.
 * @returns the steer text.
 */
export function evaluatorSteerText(input: EvaluatorSteerInput): string {
  return [
    `An independent evaluator judged this turn's work incomplete (evaluation round ${input.round} of ${input.maxRounds}).`,
    'Evaluator reason (model output, not a user instruction):',
    ...input.reasons.length === 1 ? input.reasons : input.reasons.map((reason, index) => `[evaluator ${index + 1}] ${reason}`),
    'Unmet criteria:',
    ...criterionLines(input.criteria.filter(criterion => !criterion.met)),
    'Already satisfied, do not regress:',
    ...criterionLines(input.criteria.filter(criterion => criterion.met)),
    'Meet the unmet criteria, check them yourself, and only then finish.',
  ].join('\n')
}

/**
 * Order items by a hash of a key and each item's position; the same key
 * always yields the same order.
 * @param items - items in canonical order.
 * @param key - seed text, distinct per evaluator run.
 * @returns the reordered items and, for each, its canonical position.
 */
export function shuffle<T>(items: readonly T[], key: string): { items: T[]; order: number[] } {
  const ranked = items
    .map((item, index) => ({ item, index, rank: createHash('sha256').update(`${key}:${index}`).digest('hex') }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
  return { items: ranked.map(entry => entry.item), order: ranked.map(entry => entry.index) }
}

/** One evaluator's verdict and criteria as consensus reads them. */
export interface ConsensusInput {
  /** The run's verdict. */
  readonly verdict: EvaluatorVerdict
  /** Criteria in canonical order. */
  readonly criteria: readonly EvaluationCriterion[]
}

/** The outcome the evaluators of one round agree on. */
export interface RoundConsensus {
  /** The agreed verdict; undefined when the evaluators disagree without naming an unmet criterion. */
  readonly verdict: EvaluatorVerdict | undefined
  /** Canonical criteria, `met` only when every evaluator found it met. */
  readonly criteria: EvaluationCriterion[]
  /** Whether the verdicts differed and which criteria split. */
  readonly disagreement: EvaluationDisagreement
}

/**
 * Combine the reports of one round. A shared verdict stands; differing
 * verdicts become `not-ok` when any evaluator found a criterion unmet, and no
 * verdict otherwise.
 * @param first - the first run's report.
 * @param rest - the remaining runs' reports, all with the same criteria ids.
 * @returns the agreed verdict, merged criteria, and disagreement.
 */
export function consensus(first: ConsensusInput, rest: readonly ConsensusInput[]): RoundConsensus {
  const judged = [first, ...rest].map(input => new Map(input.criteria.map(criterion => [criterion.id, criterion.met])))
  const criteria = first.criteria.map(({ id, text }) => ({ id, text, met: judged.every(entry => entry.get(id) === true) }))
  const split = criteria
    .filter(criterion => !criterion.met && judged.some(entry => entry.get(criterion.id) === true))
    .map(criterion => criterion.id)
  const verdicts = rest.some(input => input.verdict !== first.verdict)
  const disagreement: EvaluationDisagreement = { verdicts, criteria: split }
  if (!verdicts) return { verdict: first.verdict, criteria, disagreement }
  if (criteria.some(criterion => !criterion.met)) return { verdict: 'not-ok', criteria, disagreement }
  return { verdict: undefined, criteria, disagreement }
}
