/**
 * Denial budget. A tool call that a policy stage denied — a
 * `tools/pre-execute` deny, an approval non-grant, or a `ToolGuard` — fails
 * without entering `tools/execute` and is not a pre-dispatch cancellation;
 * this plugin counts those calls per session since the last human message.
 * In `enforce` mode it appends one fixed advisory sentence to each denial and,
 * once `maxConsecutive` or `maxTotal` is reached, asks `ctx.approval` at the
 * next step boundary: `allowed-once` resets the counts, any other outcome
 * rejects the step (the turn ends `blocked`) and blocks an active goal.
 * `shadow` records the same decisions without acting.
 * @module @deepseek-ai/dsh-experimental-denial-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-goal'
import type { DenialDecision, LoopDenial } from './types.ts'

export type { DenialDecision, LoopDenial } from './types.ts'

/** Cordis plugin name. */
export const name = 'denial-budget'

/**
 * Plugin config. `assumption` is mandatory outside `off`: the sentence naming
 * what the budget assumes about the model, so a later model can retire it.
 */
export interface Config {
  /** `off` registers nothing; `shadow` records only; `enforce` advises, asks, and stops. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Denied calls in a row that trip the budget (default 3). */
  maxConsecutive?: number
  /** Denied calls since the last human message that trip the budget (default 20). */
  maxTotal?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  maxConsecutive: z.number().default(3),
  maxTotal: z.number().default(20),
})

/** Fixed advice appended to every denial in `enforce` mode; it never names a way around the policy. */
export const DENIAL_ADVICE = 'Take a safer approach; do not retry this exact action or work around the denial.'

const ADVICE_BLOCK: ContentBlock = { type: 'text', text: DENIAL_ADVICE }

/** The accept variant that may replace content; a value-bearing accept cannot apply to a failed result. */
type ContentAccept = Extract<PostToolDecision, { kind: 'accept'; value?: never }>

/**
 * Narrow a post-execute decision to the content-replacing accept variant.
 * @param decision - the downstream decision.
 * @returns whether `decision` is an accept without a replacement value.
 */
function isContentAccept(decision: PostToolDecision): decision is ContentAccept {
  return decision.kind === 'accept' && decision.value === undefined
}

/** The most recent denied call. */
interface DeniedCall {
  toolName: string
  callId: ToolCallId
}

/** Per-session denial counts; `last` is set whenever a count is above zero. */
interface DenialCount {
  turn: number
  consecutive: number
  total: number
  last: DeniedCall | undefined
}

/**
 * Reject a count that is not an integer of at least 1.
 * @param field - config path named in the error.
 * @param value - the validated number.
 */
function requireCount(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`denial-budget: invalid ${field} ${value} — must be an integer >= 1`)
  }
}

/**
 * Install the budget.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - validated {@link Config}; blank `assumption` and invalid counts fail the load.
 */
// Every loop guard repeats this mode-narrowing and assumption check locally: each throws its own
// package-named message, and a nested `function record(...)` needs `mode` re-bound to a narrowed
// const because TypeScript does not carry outer control-flow narrowing into a function declaration.
/* jscpd:ignore-start */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const configured = config.mode as 'off' | 'shadow' | 'enforce'
  if (configured === 'off') return
  const mode = configured
  if ((config.assumption as string).trim() === '') {
    throw new Error('denial-budget: `assumption` must name what this budget assumes about the model')
  }
  /* jscpd:ignore-end */
  const maxConsecutive = config.maxConsecutive as number
  const maxTotal = config.maxTotal as number
  requireCount('maxConsecutive', maxConsecutive)
  requireCount('maxTotal', maxTotal)

  const dispatched = new WeakSet<object>()
  const counts = new WeakMap<Session, DenialCount>()

  function countOf(session: Session): DenialCount {
    let count = counts.get(session)
    if (count === undefined) {
      count = { turn: 0, consecutive: 0, total: 0, last: undefined }
      counts.set(session, count)
    }
    return count
  }

  function clear(count: DenialCount): void {
    count.consecutive = 0
    count.total = 0
    count.last = undefined
  }

  /** A policy stage denied the call: it failed without a dispatch and was not cancelled before dispatch. */
  function isDenial(exec: ToolExecution, result: Readonly<ToolExecutionResult>): boolean {
    return result.isError && !dispatched.has(exec) && result.error.info?.code !== TOOL_ABORTED_BEFORE_DISPATCH
  }

  function record(agent: Agent, count: DenialCount, last: DeniedCall, decision: DenialDecision, approval?: ApprovalOutcome): void {
    const entry: LoopDenial = {
      turn: count.turn,
      mode,
      toolName: last.toolName,
      callId: last.callId,
      consecutive: count.consecutive,
      total: count.total,
      decision,
      applied: mode === 'enforce',
      ...approval === undefined ? {} : { approval },
    }
    agent.session.append('loop/denial', entry)
  }

  async function ask(agent: Agent, count: DenialCount, last: DeniedCall, signal: AbortSignal): Promise<ApprovalOutcome> {
    const approval = ctx.get('approval')
    if (approval === undefined) return 'unavailable'
    return approval.request({
      agent,
      toolName: last.toolName,
      callId: last.callId,
      reason: `${count.consecutive} consecutive and ${count.total} total tool calls were denied since the last user message; allow the agent to continue?`,
      signal,
    })
  }

  function blockGoal(agent: Agent, count: DenialCount): void {
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goals === undefined || goal === undefined || goal.phase !== 'active') return
    goals.block(agent, { id: goal.id, revision: goal.revision }, {
      code: 'denial-budget',
      message: `Stopped after ${count.consecutive} consecutive and ${count.total} total denied tool calls.`,
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') countOf(session).turn = event.data.turn
  })

  ctx.on('tools/execute', (exec, next) => {
    dispatched.add(exec)
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    if (mode !== 'enforce' || exec.agent === undefined || !isDenial(exec, result) || !isContentAccept(downstream)) {
      return downstream
    }
    return { ...downstream, content: [...downstream.content ?? result.content, ADVICE_BLOCK] }
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const count = countOf(agent.session)
    if (!isDenial(exec, result)) {
      count.consecutive = 0
      return undefined
    }
    count.consecutive += 1
    count.total += 1
    const last: DeniedCall = { toolName: exec.name, callId: exec.callId }
    count.last = last
    record(agent, count, last, 'counted')
    return undefined
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const count = countOf(agent.session)
    if (messages.some(message => message.source.kind === 'user')) {
      clear(count)
      return next()
    }
    const last = count.last
    if (last === undefined || (count.consecutive < maxConsecutive && count.total < maxTotal)) return next()
    if (mode === 'shadow') {
      record(agent, count, last, 'stopped')
      clear(count)
      return next()
    }
    const outcome = await ask(agent, count, last, signal)
    if (outcome === 'allowed-once') {
      record(agent, count, last, 'approved', outcome)
      clear(count)
      return next()
    }
    record(agent, count, last, 'stopped', outcome)
    blockGoal(agent, count)
    clear(count)
    return { kind: 'reject' }
  })
}
