/**
 * Loop budget. Per turn and per active goal it tracks started steps,
 * provider-reported tokens with their configured USD price, and wall time.
 * At every step boundary the first exhausted limit is recorded as
 * `loop/budget`; in `enforce` mode the step is rejected (the turn ends
 * `blocked`) and an active goal is paused — or completed when the latest
 * `loop/verdict` was `ok` and no step started since. A goal limit never
 * rejects a step that admits a human message. An optional work floor steers
 * once per turn when a turn is about to end below `floor.minSteps` or
 * `floor.minTokens`.
 * @module @deepseek-ai/dsh-experimental-loop-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalService, GoalView } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-verifier-gate/types'
import type { BudgetAction, BudgetKind, BudgetScope, LoopBudget } from './types.ts'

export type { BudgetAction, BudgetKind, BudgetScope, LoopBudget } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Work-floor steer submitted when a turn would end below its floor.
     * @persistenceAttribution
     */
    'loop-budget': { kind: 'loop-budget' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'loop-budget'

/** Limits for one scope; 0 disables a limit. */
export interface BudgetLimits {
  /** Started steps. */
  maxSteps?: number
  /** Provider-reported tokens: uncached input, cache read, cache write, and output. */
  maxTokens?: number
  /** USD priced through `prices`. */
  maxUsd?: number
  /** Milliseconds since the turn started, or since the goal was first tracked. */
  maxWallMs?: number
}

/** Minimum work per turn before it may end; 0 disables a floor. */
export interface WorkFloor {
  /** Started steps. */
  minSteps?: number
  /** Provider-reported tokens. */
  minTokens?: number
}

/** USD per million tokens for one exact provider/model route. */
export interface RoutePrice {
  /** Provider route as logged in `request/header`. */
  provider: string
  /** Model id as logged in `request/header`. */
  model: string
  /** Uncached input tokens. */
  inputPerMTok: number
  /** Output tokens. */
  outputPerMTok: number
  /** Cache-read tokens (default 0). */
  cacheReadPerMTok?: number
  /** Cache-write tokens (default 0). */
  cacheWritePerMTok?: number
}

/**
 * Plugin config. `assumption` is mandatory outside `off`: the sentence naming
 * what the budget assumes about the model, so a later model can retire it.
 */
export interface Config {
  /** `off` registers nothing; `shadow` records only; `enforce` rejects, pauses, and steers. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Per-turn limits. */
  turn?: BudgetLimits
  /** Per-active-goal limits. */
  goal?: BudgetLimits
  /** Per-turn work floor. */
  floor?: WorkFloor
  /** Route prices; required when any `maxUsd` is above 0. */
  prices?: RoutePrice[]
}

/**
 * One fresh limits schema per scope.
 * @returns the limits schema.
 */
function limitsSchema(): z<BudgetLimits> {
  return z.object({
    maxSteps: z.number().default(0),
    maxTokens: z.number().default(0),
    maxUsd: z.number().default(0),
    maxWallMs: z.number().default(0),
  })
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  turn: limitsSchema().default({}),
  goal: limitsSchema().default({}),
  floor: z.object({
    minSteps: z.number().default(0),
    minTokens: z.number().default(0),
  }).default({}),
  prices: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    inputPerMTok: z.number().required(),
    outputPerMTok: z.number().required(),
    cacheReadPerMTok: z.number().default(0),
    cacheWritePerMTok: z.number().default(0),
  })).default([]),
})

/** Spend accumulated by one scope. */
interface Spend {
  steps: number
  tokens: number
  usd: number
}

/** Per-session accumulators. */
interface SessionBudget {
  turnStartedAt: number
  lastStep: number
  turnSpend: Spend
  goalId: GoalView['id'] | undefined
  goalSince: number
  goalSpend: Spend
  unpricedRoute: string | undefined
  verdictOk: boolean
  stepsSinceVerdict: number
  floorTurn: number | undefined
  reported: Set<string>
}

/** One exhausted limit or unmet floor. */
interface Trip {
  scope: BudgetScope
  kind: BudgetKind
  used: number
  limit: number
}

/** The live goal service and the active goal it reported. */
interface TrackedGoal {
  service: GoalService
  view: GoalView
}

const zeroSpend = (): Spend => ({ steps: 0, tokens: 0, usd: 0 })

/**
 * Tokens one settlement charged.
 * @param usage - provider usage.
 * @returns uncached input + cache read + cache write + output.
 */
function tokensOf(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
}

/**
 * Reject a count that is not a non-negative integer.
 * @param field - config path named in the error.
 * @param value - the validated number.
 */
function requireCount(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`loop-budget: invalid ${field} ${value} — must be an integer >= 0`)
  }
}

/**
 * Reject an amount that is not a finite non-negative number.
 * @param field - config path named in the error.
 * @param value - the validated number.
 */
function requireAmount(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`loop-budget: invalid ${field} ${value} — must be a finite number >= 0`)
  }
}

/**
 * Model-facing work-floor steer; it never names a way to disable the budget.
 * @param short - the unmet floor.
 * @returns the steer text.
 */
function floorText(short: Trip): string {
  return `Work floor not reached for this turn: ${short.used} of ${short.limit} ${short.kind}.\n`
    + 'Before finishing, do adjacent useful work on the same request, such as verifying the change or covering a case you have not checked, then finish.'
}

/**
 * Install the budget.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - validated {@link Config}; blank `assumption`, invalid
 * numbers, duplicate prices, and `maxUsd` without `prices` fail the load.
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
    throw new Error('loop-budget: `assumption` must name what this budget assumes about the model')
  }
  /* jscpd:ignore-end */
  const turnLimits = config.turn as Required<BudgetLimits>
  const goalLimits = config.goal as Required<BudgetLimits>
  const floor = config.floor as Required<WorkFloor>
  for (const [scope, limits] of [['turn', turnLimits], ['goal', goalLimits]] as const) {
    requireCount(`${scope}.maxSteps`, limits.maxSteps)
    requireCount(`${scope}.maxTokens`, limits.maxTokens)
    requireAmount(`${scope}.maxUsd`, limits.maxUsd)
    requireCount(`${scope}.maxWallMs`, limits.maxWallMs)
  }
  requireCount('floor.minSteps', floor.minSteps)
  requireCount('floor.minTokens', floor.minTokens)
  const prices = new Map<string, Required<RoutePrice>>()
  for (const [index, price] of (config.prices as Required<RoutePrice>[]).entries()) {
    requireAmount(`prices[${index}].inputPerMTok`, price.inputPerMTok)
    requireAmount(`prices[${index}].outputPerMTok`, price.outputPerMTok)
    requireAmount(`prices[${index}].cacheReadPerMTok`, price.cacheReadPerMTok)
    requireAmount(`prices[${index}].cacheWritePerMTok`, price.cacheWritePerMTok)
    const key = `${price.provider}/${price.model}`
    if (prices.has(key)) throw new Error(`loop-budget: duplicate price for ${key}`)
    prices.set(key, price)
  }
  const chargesUsd = turnLimits.maxUsd > 0 || goalLimits.maxUsd > 0
  if (chargesUsd && prices.size === 0) {
    throw new Error('loop-budget: `maxUsd` is set but `prices` is empty')
  }

  const budgets = new WeakMap<Session, SessionBudget>()

  function budgetOf(session: Session): SessionBudget {
    let budget = budgets.get(session)
    if (budget === undefined) {
      budget = {
        turnStartedAt: Date.now(), lastStep: 0, turnSpend: zeroSpend(),
        goalId: undefined, goalSince: 0, goalSpend: zeroSpend(),
        unpricedRoute: undefined, verdictOk: false, stepsSinceVerdict: 0,
        floorTurn: undefined, reported: new Set(),
      }
      budgets.set(session, budget)
    }
    return budget
  }

  function priceOf(session: Session, usage: TokenUsage, budget: SessionBudget): number {
    if (!chargesUsd) return 0
    const header = session.requestHeader()
    /* v8 ignore next -- agent-loop appends request/header inside the step before any assistant settlement */
    if (header === undefined) throw new Error('loop-budget: assistant settlement without a request header')
    const key = `${header.config.provider}/${header.config.model}`
    const price = prices.get(key)
    if (price === undefined) {
      budget.unpricedRoute = key
      return 0
    }
    return (usage.inputTokens * price.inputPerMTok
      + usage.outputTokens * price.outputPerMTok
      + (usage.cacheReadTokens ?? 0) * price.cacheReadPerMTok
      + (usage.cacheWriteTokens ?? 0) * price.cacheWritePerMTok) / 1_000_000
  }

  function charge(session: Session, event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>): void {
    const chunk = lastAssistantStreamChunk(event.data.stream, 'usage')
    if (chunk === undefined) return
    const budget = budgetOf(session)
    const tokens = tokensOf(chunk.usage)
    const usd = priceOf(session, chunk.usage, budget)
    budget.turnSpend.tokens += tokens
    budget.turnSpend.usd += usd
    if (budget.goalId !== undefined) {
      budget.goalSpend.tokens += tokens
      budget.goalSpend.usd += usd
    }
  }

  function trackGoal(agent: Agent, budget: SessionBudget): TrackedGoal | undefined {
    const service = ctx.get('goals')
    const view = service?.get(agent)
    if (service === undefined || view === undefined || view.phase !== 'active') {
      budget.goalId = undefined
      return undefined
    }
    if (budget.goalId !== view.id) {
      budget.goalId = view.id
      budget.goalSince = Date.now()
      budget.goalSpend = zeroSpend()
    }
    return { service, view }
  }

  function firstTrip(budget: SessionBudget, step: number, goal: TrackedGoal | undefined): Trip | undefined {
    const now = Date.now()
    const checks: Trip[] = [
      { scope: 'turn', kind: 'steps', used: step - 1, limit: turnLimits.maxSteps },
      { scope: 'turn', kind: 'tokens', used: budget.turnSpend.tokens, limit: turnLimits.maxTokens },
      { scope: 'turn', kind: 'usd', used: budget.turnSpend.usd, limit: turnLimits.maxUsd },
      { scope: 'turn', kind: 'wallMs', used: now - budget.turnStartedAt, limit: turnLimits.maxWallMs },
    ]
    if (goal !== undefined) {
      checks.push(
        { scope: 'goal', kind: 'steps', used: budget.goalSpend.steps, limit: goalLimits.maxSteps },
        { scope: 'goal', kind: 'tokens', used: budget.goalSpend.tokens, limit: goalLimits.maxTokens },
        { scope: 'goal', kind: 'usd', used: budget.goalSpend.usd, limit: goalLimits.maxUsd },
        { scope: 'goal', kind: 'wallMs', used: now - budget.goalSince, limit: goalLimits.maxWallMs },
      )
    }
    return checks.find(check => check.limit > 0 && check.used >= check.limit)
  }

  function record(agent: Agent, turn: number, step: number, trip: Trip, action: BudgetAction, goalId: GoalView['id'] | undefined): void {
    const entry: LoopBudget = {
      turn, step, mode, ...trip, action,
      applied: mode === 'enforce',
      source: agent.session.header.parentSession === undefined ? 'root' : 'subagent',
      ...goalId === undefined ? {} : { goalId },
    }
    agent.session.append('loop/budget', entry)
  }

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start': {
        const budget = budgetOf(session)
        budget.turnStartedAt = event.time
        budget.lastStep = 0
        budget.turnSpend = zeroSpend()
        return
      }
      case 'step/start': {
        const budget = budgetOf(session)
        budget.lastStep = event.data.step
        budget.stepsSinceVerdict += 1
        if (budget.goalId !== undefined) budget.goalSpend.steps += 1
        return
      }
      case 'assistant/message':
      case 'assistant/attempt':
        charge(session, event)
        return
      case 'loop/verdict': {
        const budget = budgetOf(session)
        budget.verdictOk = event.data.verdict === 'ok'
        budget.stepsSinceVerdict = 0
        return
      }
      default:
        // SessionEventMap is merge-extensible; every other event leaves the accumulators unchanged.
        return
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const budget = budgetOf(agent.session)
    if (budget.unpricedRoute !== undefined) {
      throw new Error(`loop-budget: maxUsd is set but no price row matches route ${budget.unpricedRoute}; add it to \`prices\``)
    }
    const goal = trackGoal(agent, budget)
    const trip = firstTrip(budget, step, goal)
    if (trip === undefined) return next()
    const key = `${trip.scope}:${trip.scope === 'turn' ? turn : String(budget.goalId)}:${trip.kind}`
    if (budget.reported.has(key)) return next()
    budget.reported.add(key)
    const action: BudgetAction = budget.verdictOk && budget.stepsSinceVerdict === 0
      ? 'completed'
      : goal === undefined ? 'stopped' : 'paused'
    record(agent, turn, step, trip, action, goal?.view.id)
    if (mode === 'shadow') return next()
    if (goal !== undefined) {
      const ref = { id: goal.view.id, revision: goal.view.revision }
      if (action === 'completed') goal.service.complete(agent, ref)
      else goal.service.pause(agent, ref)
    }
    // A goal limit pauses the goal but never refuses a human prompt.
    if (trip.scope === 'goal' && messages.some(message => message.source.kind === 'user')) return next()
    return { kind: 'reject' }
  })

  if (floor.minSteps === 0 && floor.minTokens === 0) return
  ctx.on('agent/turn-stopping', ({ agent, turn }): void => {
    const budget = budgetOf(agent.session)
    // Another listener already objected, or this turn already had its floor steer.
    if (budget.floorTurn === turn || agent.inbox.nextStep.length > 0) return
    const short: Trip | undefined = budget.lastStep < floor.minSteps
      ? { scope: 'turn', kind: 'steps', used: budget.lastStep, limit: floor.minSteps }
      : budget.turnSpend.tokens < floor.minTokens
        ? { scope: 'turn', kind: 'tokens', used: budget.turnSpend.tokens, limit: floor.minTokens }
        : undefined
    if (short === undefined) return
    budget.floorTurn = turn
    record(agent, turn, budget.lastStep, short, 'floor-steer', budget.goalId)
    if (mode === 'shadow') return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: floorText(short) }],
      source: { kind: 'loop-budget', form: 'notice', summary: boundContextSummary(`work floor: ${short.used}/${short.limit} ${short.kind}`) },
    }))
  })
}
