/**
 * Turn-stopping verifier gate. Before a turn may end it runs the configured
 * verify commands through the shell seam; in `enforce` mode a red command
 * steers the agent to keep working (bounded by `maxContinuations`), and an
 * exhausted budget blocks the session's active goal so goal rounds stop
 * re-entering the same red check. `shadow` mode only records what it would
 * have done. A failed step never reaches this gate (agent-loop runs
 * `agent/turn-stopping` only after a completed step), so the gate needs no
 * failed-step guard.
 * @module @deepseek-ai/dsh-experimental-verifier-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-goal'
import type { LoopVerdict, VerdictCheck } from './types.ts'

export type { LoopVerdict, LoopVerdictKind, LoopVerdictReason, VerdictCheck } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Steering the gate submits after a blank response or a red verify command in `enforce` mode.
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

/** Per-agent steering counters for one turn. */
interface Budget {
  turn: number
  continuation: number
  blankSteers: number
}

/**
 * Install the gate.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - validated {@link Config}; blank `assumption`, invalid numbers, and commands without a mounted `shell` fail the load.
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
  const maxContinuations = config.maxContinuations as number
  requireInteger('maxContinuations', maxContinuations, 0)
  requireInteger('blankResponse.maxSteers', blankResponse.maxSteers, 0)
  requireInteger('verify.timeoutMs', verify.timeoutMs, 1)
  requireInteger('verify.stdoutTailChars', verify.stdoutTailChars, 1)
  if (verify.commands.length > 0 && ctx.get('shell') === undefined) {
    throw new Error('verifier-gate: `verify.commands` is set but no `shell` service is mounted')
  }

  const budgets = new WeakMap<Agent, Budget>()
  // Turn number of the latest settled response while it is blank, folded from the log.
  const blankTurns = new WeakMap<Session, number>()

  function budgetOf(agent: Agent, turn: number): Budget {
    const current = budgets.get(agent)
    if (current !== undefined && current.turn === turn) return current
    const fresh: Budget = { turn, continuation: 0, blankSteers: 0 }
    budgets.set(agent, fresh)
    return fresh
  }

  // Enforce-mode exhaustion ends automatic goal rounds: another round would meet the same red check.
  function blockGoal(agent: Agent, failed: VerdictCheck): void {
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goals === undefined || goal === undefined || goal.phase !== 'active') return
    goals.block(agent, { id: goal.id, revision: goal.revision }, {
      code: 'verifier-budget-exhausted',
      message: `verify command still failing after ${maxContinuations} continuation(s): ${failed.command}`,
    })
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

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    if (isBlank(event.data.message.content)) blankTurns.set(session, event.data.turn)
    else blankTurns.delete(session)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const budget = budgetOf(agent, turn)
    const record = (verdict: Pick<LoopVerdict, 'verdict' | 'reason' | 'checks' | 'continued'>): void => {
      agent.session.append('loop/verdict', { turn, mode, continuation: budget.continuation, ...verdict })
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

    if (verify.commands.length === 0) {
      record({ verdict: 'skipped', reason: 'no-commands', checks: [], continued: false })
      return
    }
    const checks = await runChecks(signal)
    const failed = checks.find(check => check.exitCode !== 0)
    if (failed === undefined) {
      record({ verdict: 'ok', reason: 'all-passed', checks, continued: false })
      return
    }
    if (mode === 'shadow') {
      record({ verdict: 'not-ok', reason: 'command-failed', checks, continued: false })
      return
    }
    if (budget.continuation >= maxContinuations) {
      record({ verdict: 'not-ok', reason: 'budget-exhausted', checks, continued: false })
      blockGoal(agent, failed)
      return
    }
    record({ verdict: 'not-ok', reason: 'command-failed', checks, continued: true })
    budget.continuation += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: steerText(failed) }],
      source: { kind: 'verifier-gate', form: 'notice', summary: boundContextSummary(`verify failed: ${failed.command}`) },
    }))
  })

  // Human input starts a new judgement; the continuation budget resets.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) budgets.delete(agent)
    return next()
  })
}
