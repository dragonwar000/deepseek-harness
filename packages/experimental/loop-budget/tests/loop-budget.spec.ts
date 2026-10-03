import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as VerifierGate from '@deepseek-ai/dsh-experimental-verifier-gate'
import type { VerifyShell } from '@deepseek-ai/dsh-experimental-verifier-gate'
import * as LoopBudget from '../src/index.ts'
import type { Config, RoutePrice } from '../src/index.ts'
import type { LoopBudget as LoopBudgetRecord } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const BASE = { mode: 'enforce', assumption: 'the model does not stop spending by itself' } satisfies Config

interface HarnessOptions {
  goals?: boolean
  verifier?: boolean
  invariant?: boolean
  steerOnce?: boolean
}

/** Verify shell whose every command passes. */
const greenShell: VerifyShell = {
  resolve: request => ({ command: request.command, workdir: '/tmp', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }),
  execute: async spec => ({
    result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
    }),
  }),
}

async function harness(config: Config, options: HarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.invariant === true) {
    await ctx.plugin(InvariantService, { enabled: true })
    // Loaded lazily so the behavior tests run before Step 9 creates the companion.
    await ctx.plugin(await import('../src/invariant.ts'))
  }
  if (options.goals === true) await ctx.plugin(GoalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.verifier === true) {
    ctx.provide('shell', greenShell)
    await ctx.plugin(VerifierGate, { mode: 'enforce', assumption: 'x', verify: { commands: ['true'] } })
  }
  if (options.steerOnce === true) {
    let steered = false
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'one more' }], source: { kind: 'test' } }))
    })
  }
  await ctx.plugin(LoopBudget, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'probe', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({
    name: 'slow', description: 'slow', parameters: {},
    async execute() {
      await new Promise(resolve => setTimeout(resolve, 20))
      return [{ type: 'text', text: 'ok' }]
    },
  }))
  return ctx
}

async function mockAgent(ctx: Context, script: StreamChunk[][]): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  return { agent, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function send(ctx: Context, agent: Agent, text: string, kind: 'user' | 'test' = 'user'): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  const source: MessageSource = kind === 'test' ? { kind: 'test' } : { kind: 'user' }
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
  await idle
}

function budgets(agent: Agent): LoopBudgetRecord[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'loop/budget'> => e.type === 'loop/budget')
    .map(e => e.data)
}

function turnEnds(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map(e => e.data.reason.kind)
}

function steers(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'loop-budget')
    .map(e => e.data.content.map(b => b.type === 'text' ? b.text : '').join(''))
}

const probe = (id: string): StreamChunk[] => toolCallResponse(id, 'probe', {})

/** Replace the usage chunk of a scripted response; `undefined` removes it. */
function withUsage(chunks: StreamChunk[], usage: TokenUsage | undefined): StreamChunk[] {
  return chunks.flatMap((chunk): StreamChunk[] => {
    if (chunk.type !== 'usage') return [chunk]
    return usage === undefined ? [] : [{ type: 'usage', usage }]
  })
}

const PRICE: RoutePrice = { provider: 'mock', model: 'mock', inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, cacheReadPerMTok: 1_000_000, cacheWritePerMTok: 1_000_000 }

describe('turn limits', () => {
  it('rejects the step after turn.maxSteps and records the trip', async () => {
    const ctx = await harness({ ...BASE, turn: { maxSteps: 2 } }, { goals: true })
    const { agent, adapter } = await mockAgent(ctx, [probe('p1'), probe('p2'), probe('p3'), textResponse('unreached')])
    await send(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(2)
    expect(budgets(agent)).toEqual([{
      turn: 1, step: 3, mode: 'enforce', scope: 'turn', kind: 'steps', used: 2, limit: 2,
      action: 'stopped', applied: true, source: 'root',
    }])
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('turn limits (continued)', () => {
  it('counts provider tokens and skips a settlement without usage', async () => {
    const ctx = await harness({ ...BASE, turn: { maxTokens: 30 } })
    const { agent, adapter } = await mockAgent(ctx, [withUsage(probe('p0'), undefined), probe('p1'), probe('p2'), textResponse('unreached')])
    await send(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(3)
    expect(budgets(agent).map(b => [b.scope, b.kind, b.used, b.limit, b.action])).toEqual([['turn', 'tokens', 30, 30, 'stopped']])
  })

  it('prices uncached, cached, and output tokens in USD', async () => {
    const ctx = await harness({ ...BASE, turn: { maxUsd: 20 }, prices: [PRICE] })
    const cached = withUsage(probe('p2'), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 })
    const { agent } = await mockAgent(ctx, [probe('p1'), cached, textResponse('unreached')])
    await send(ctx, agent, 'go')
    expect(budgets(agent).map(b => [b.kind, b.used, b.limit])).toEqual([['usd', 22, 20]])
  })

  it('trips on wall time since the turn started', async () => {
    const ctx = await harness({ ...BASE, turn: { maxWallMs: 5 } })
    const { agent } = await mockAgent(ctx, [toolCallResponse('s1', 'slow', {}), textResponse('unreached')])
    await send(ctx, agent, 'go')
    const [trip] = budgets(agent)
    expect(trip).toMatchObject({ kind: 'wallMs', limit: 5, action: 'stopped' })
    expect(trip!.used).toBeGreaterThanOrEqual(5)
  })

  it('fails the turn loud when a priced limit meets an unpriced route', async () => {
    const ctx = await harness({ ...BASE, turn: { maxUsd: 1 }, prices: [{ provider: 'other', model: 'x', inputPerMTok: 1, outputPerMTok: 1 }] })
    const { agent } = await mockAgent(ctx, [probe('p1'), textResponse('unreached')])
    await send(ctx, agent, 'go')
    const end = agent.session.snapshotEvents().find((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    expect(end?.data.reason.kind === 'error' ? end.data.reason.error.message : '').toContain('no price row matches route mock/mock')
  })
})

describe('goal limits', () => {
  it('pauses the active goal and rejects the step', async () => {
    const ctx = await harness({ ...BASE, goal: { maxSteps: 2 } }, { goals: true })
    const { agent, adapter } = await mockAgent(ctx, [probe('p1'), probe('p2'), probe('p3'), textResponse('unreached')])
    const created = ctx.goals.create(agent, { objective: 'budget test' })
    await send(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(2)
    expect(budgets(agent)).toMatchObject([{ scope: 'goal', kind: 'steps', used: 2, limit: 2, action: 'paused', goalId: created.id }])
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    expect(turnEnds(agent)).toEqual(['blocked'])
  })

  it('completes the goal instead when the latest verdict was ok with no step since', async () => {
    const ctx = await harness({ ...BASE, goal: { maxSteps: 1 } }, { goals: true, verifier: true })
    const { agent, adapter } = await mockAgent(ctx, [textResponse('done'), textResponse('unreached')])
    ctx.goals.create(agent, { objective: 'verdict first' })
    await send(ctx, agent, 'go')
    await send(ctx, agent, 'next round', 'test')
    expect(adapter.requests).toHaveLength(1)
    expect(budgets(agent).map(b => [b.scope, b.action])).toEqual([['goal', 'completed']])
    expect(ctx.goals.get(agent)?.phase).toBe('complete')
    expect(turnEnds(agent)).toEqual(['completed', 'blocked'])
  })

  it('pauses the goal but still admits a human prompt, then stops tracking the paused goal', async () => {
    const ctx = await harness({ ...BASE, goal: { maxSteps: 1 } }, { goals: true })
    const { agent } = await mockAgent(ctx, [textResponse('a'), textResponse('b'), textResponse('c')])
    ctx.goals.create(agent, { objective: 'human first' })
    await send(ctx, agent, 'go')
    await send(ctx, agent, 'again')
    await send(ctx, agent, 'more')
    expect(budgets(agent).map(b => [b.turn, b.scope, b.action])).toEqual([[2, 'goal', 'paused']])
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    expect(turnEnds(agent)).toEqual(['completed', 'completed', 'completed'])
  })
})

describe('work floor', () => {
  it('steers once when a turn would end below floor.minSteps', async () => {
    const ctx = await harness({ ...BASE, floor: { minSteps: 2 } })
    const { agent, adapter } = await mockAgent(ctx, [textResponse('short'), textResponse('more')])
    await send(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(2)
    expect(budgets(agent).map(b => [b.kind, b.used, b.limit, b.action])).toEqual([['steps', 1, 2, 'floor-steer']])
    expect(steers(agent)).toHaveLength(1)
    expect(steers(agent)[0]).toContain('Work floor not reached for this turn: 1 of 2 steps.')
  })

  it('steers once when a turn would end below floor.minTokens', async () => {
    const ctx = await harness({ ...BASE, floor: { minTokens: 1000 } })
    const { agent } = await mockAgent(ctx, [textResponse('x'), textResponse('y')])
    await send(ctx, agent, 'go')
    expect(budgets(agent).map(b => [b.kind, b.used, b.limit])).toEqual([['tokens', 11, 1000]])
    expect(steers(agent)).toHaveLength(1)
  })

  it('yields to a steer another listener already submitted', async () => {
    const ctx = await harness({ ...BASE, floor: { minSteps: 2 } }, { steerOnce: true })
    const { agent } = await mockAgent(ctx, [textResponse('short'), textResponse('more')])
    await send(ctx, agent, 'go')
    expect(budgets(agent)).toEqual([])
    expect(steers(agent)).toEqual([])
  })
})

describe('shadow mode and attribution', () => {
  it('records each trip once and the floor without rejecting or steering', async () => {
    const ctx = await harness({ ...BASE, mode: 'shadow', turn: { maxSteps: 1 }, floor: { minSteps: 5 } })
    const { agent, adapter } = await mockAgent(ctx, [probe('p1'), probe('p2'), textResponse('done')])
    await send(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(3)
    expect(budgets(agent).map(b => [b.kind, b.action, b.applied])).toEqual([
      ['steps', 'stopped', false],
      ['steps', 'floor-steer', false],
    ])
    expect(steers(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })

  it('attributes a subagent session', async () => {
    const ctx = await harness({ ...BASE, mode: 'shadow', turn: { maxSteps: 1 } })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([probe('p1'), textResponse('done')]))
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { parentSession: SessionId('root'), origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await send(ctx, agent, 'go')
    expect(budgets(agent).map(b => b.source)).toEqual(['subagent'])
  })
})

describe('invariant companion', () => {
  it('holds through the real loop', async () => {
    const ctx = await harness({ ...BASE, turn: { maxSteps: 2 } }, { invariant: true })
    const { agent } = await mockAgent(ctx, [probe('p1'), probe('p2'), probe('p3')])
    await send(ctx, agent, 'go')
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('config', () => {
  it('fails loud without an assumption', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(LoopBudget, { ...BASE, assumption: '' })).rejects.toThrow('`assumption` must name')
  })

  it.each([
    [{ turn: { maxSteps: -1 } }, 'invalid turn.maxSteps -1'],
    [{ goal: { maxUsd: -1 } }, 'invalid goal.maxUsd -1'],
    [{ floor: { minTokens: 1.5 } }, 'invalid floor.minTokens 1.5'],
    [{ prices: [{ provider: 'mock', model: 'mock', inputPerMTok: -1, outputPerMTok: 1 }] }, 'invalid prices[0].inputPerMTok -1'],
    [{ prices: [PRICE, PRICE] }, 'duplicate price for mock/mock'],
    [{ turn: { maxUsd: 1 } }, '`maxUsd` is set but `prices` is empty'],
  ] satisfies [Config, string][])('fails loud on %j', async (patch, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(LoopBudget, { ...BASE, ...patch })).rejects.toThrow(message)
  })

  it('bounds wall time by default and leaves the other limits off', () => {
    const config = LoopBudget.Config({ ...BASE })
    expect(config.turn).toEqual({ maxSteps: 0, maxTokens: 0, maxUsd: 0, maxWallMs: 900_000 })
    expect(config.goal).toEqual({ maxSteps: 0, maxTokens: 0, maxUsd: 0, maxWallMs: 3_600_000 })
  })

  it('keeps a wall clock the deployment sets, including 0 for no limit', () => {
    expect(LoopBudget.Config({ ...BASE, turn: { maxWallMs: 0 } }).turn?.maxWallMs).toBe(0)
    expect(LoopBudget.Config({ ...BASE, goal: { maxWallMs: 60_000 } }).goal?.maxWallMs).toBe(60_000)
  })

  it('registers nothing in off mode', async () => {
    const ctx = await harness({ ...BASE, mode: 'off', turn: { maxSteps: 1 } })
    const { agent } = await mockAgent(ctx, [probe('p1'), textResponse('done')])
    await send(ctx, agent, 'go')
    expect(budgets(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})
