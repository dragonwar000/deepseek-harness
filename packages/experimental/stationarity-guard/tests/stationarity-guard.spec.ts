import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as StationarityGuard from '../src/index.ts'
import * as StationarityInvariant from '../src/invariant.ts'
import type { Config } from '../src/index.ts'
import type { LoopStationarity } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const CONFIG = {
  mode: 'enforce',
  assumption: 'the model repeats tool calls that return identical results',
  remindAt: { sideEffect: 2, readOnly: 5 },
  stopAt: { sideEffect: 3, readOnly: 6 },
  noopStopAt: 3,
} satisfies Config

interface HarnessOptions {
  goals?: boolean
  invariant?: boolean
}

async function harness(config: Config, options: HarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.invariant === true) {
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(StationarityInvariant)
  }
  if (options.goals === true) await ctx.plugin(GoalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(StationarityGuard, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'read-only probe', parameters: {}, isConcurrencySafe: () => true,
    async execute() { return [{ type: 'text', text: 'same' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'poke', description: 'side-effect poke', parameters: {},
    async execute() { return [{ type: 'text', text: 'same' }] },
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

async function prompt(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

function decisions(agent: Agent): LoopStationarity[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'loop/stationarity'> => e.type === 'loop/stationarity')
    .map(e => e.data)
}

function reminders(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'stationarity-guard')
    .map(e => e.data.content.map(b => b.type === 'text' ? b.text : '').join(''))
}

function turnEnds(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map(e => e.data.reason.kind)
}

const pokes = (count: number, args: object = {}): StreamChunk[][] =>
  Array.from({ length: count }, (_, i) => toolCallResponse(`p${i}`, 'poke', args))

describe('side-effect tier', () => {
  it('reminds at remindAt and rejects the next step at stopAt', async () => {
    const ctx = await harness(CONFIG)
    const { agent, adapter } = await mockAgent(ctx, [...pokes(3), textResponse('unreached')])
    await prompt(ctx, agent, 'go')

    expect(adapter.requests).toHaveLength(3)
    expect(decisions(agent).map(d => [d.action, d.reason, d.tier, d.step, d.repeats, d.applied])).toEqual([
      ['remind', 'repeat', 'sideEffect', 2, 2, true],
      ['stop', 'repeat', 'sideEffect', 3, 3, true],
    ])
    expect(decisions(agent)[0]!.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(reminders(agent)).toHaveLength(1)
    expect(reminders(agent)[0]).toContain('returned identical results 2 times')
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

/** A tool-call response whose argument text is not JSON. */
function malformedPoke(rawCallId: string): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'poke', argumentsDelta: '{bad' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'poke', arguments: '{bad' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('evidence signature', () => {
  it('counts a non-adjacent A,B,A,B,A pattern and ignores argument key order', async () => {
    const ctx = await harness(CONFIG)
    const a1 = toolCallResponse('a1', 'poke', { b: [1], a: 2, c: 3 })
    const b1 = toolCallResponse('b1', 'poke', { x: [2] })
    const a2 = toolCallResponse('a2', 'poke', { a: 2, c: 3, b: [1] })
    const b2 = toolCallResponse('b2', 'poke', { x: [2] })
    const a3 = toolCallResponse('a3', 'poke', { c: 3, b: [1], a: 2 })
    const { agent, adapter } = await mockAgent(ctx, [a1, b1, a2, b2, a3, textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(5)
    expect(decisions(agent).map(d => [d.action, d.step, d.repeats])).toEqual([
      ['remind', 3, 2],
      ['remind', 4, 2],
      ['stop', 5, 3],
    ])
  })

  it('treats malformed argument JSON as its own identity', async () => {
    const ctx = await harness(CONFIG)
    const { agent } = await mockAgent(ctx, [malformedPoke('m1'), malformedPoke('m2'), malformedPoke('m3'), textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(decisions(agent).map(d => [d.action, d.tier, d.repeats])).toEqual([
      ['remind', 'sideEffect', 2],
      ['stop', 'sideEffect', 3],
    ])
  })
})

describe('read-only tier', () => {
  it('stops after noopStopAt consecutive read-only steps without new evidence', async () => {
    const ctx = await harness(CONFIG)
    const probes = Array.from({ length: 4 }, (_, i) => toolCallResponse(`r${i}`, 'probe', {}))
    const { agent, adapter } = await mockAgent(ctx, [...probes, textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(4)
    expect(decisions(agent).map(d => [d.action, d.reason, d.tier, d.repeats, d.noopRun])).toEqual([
      ['stop', 'noop', 'readOnly', 4, 3],
    ])
    expect(turnEnds(agent)).toEqual(['blocked'])
  })

  it('does not count read-only steps with new evidence', async () => {
    const ctx = await harness(CONFIG)
    const probes = Array.from({ length: 4 }, (_, i) => toolCallResponse(`r${i}`, 'probe', { q: i }))
    const { agent, adapter } = await mockAgent(ctx, [...probes, textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(5)
    expect(decisions(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})

describe('reset', () => {
  it('starts over after a human message', async () => {
    const ctx = await harness(CONFIG)
    const { agent } = await mockAgent(ctx, [...pokes(2), textResponse('a'), toolCallResponse('q1', 'poke', {}), textResponse('b')])
    await prompt(ctx, agent, 'go')
    await prompt(ctx, agent, 'again')
    expect(decisions(agent).map(d => [d.action, d.turn])).toEqual([['remind', 1]])
    expect(turnEnds(agent)).toEqual(['completed', 'completed'])
  })

  it('keeps counting across a turn opened by a non-human message', async () => {
    const ctx = await harness(CONFIG)
    const { agent } = await mockAgent(ctx, [...pokes(1), textResponse('a'), toolCallResponse('q1', 'poke', {}), textResponse('b')])
    await prompt(ctx, agent, 'go')
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'test' } }))
    await idle
    expect(decisions(agent).map(d => [d.action, d.turn, d.repeats])).toEqual([['remind', 2, 2]])
    expect(turnEnds(agent)).toEqual(['completed', 'completed'])
  })
})

describe('goal', () => {
  it('blocks an active goal when it stops the turn', async () => {
    const ctx = await harness(CONFIG, { goals: true })
    const { agent } = await mockAgent(ctx, [...pokes(3), textResponse('unreached')])
    ctx.goals.create(agent, { objective: 'loop test' })
    await prompt(ctx, agent, 'go')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', blockedReason: { code: 'stationary' } })
  })
})

describe('shadow mode', () => {
  it('records decisions without reminding or rejecting', async () => {
    const ctx = await harness({ ...CONFIG, mode: 'shadow' })
    const { agent, adapter } = await mockAgent(ctx, [...pokes(3), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(4)
    expect(decisions(agent).map(d => [d.mode, d.action, d.applied])).toEqual([
      ['shadow', 'remind', false],
      ['shadow', 'stop', false],
    ])
    expect(reminders(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})

describe('downstream decision', () => {
  it('returns a downstream rejection unchanged instead of attaching the reminder', async () => {
    const ctx = await harness(CONFIG)
    ctx.on('agent/pre-step', ({ step }, next) => (step === 3 ? Promise.resolve({ kind: 'reject' as const }) : next()))
    const { agent } = await mockAgent(ctx, [...pokes(2), textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(decisions(agent).map(d => [d.action, d.applied])).toEqual([['remind', true]])
    expect(reminders(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('invariant companion', () => {
  it('holds through the real loop when a stop rejects the next step', async () => {
    const ctx = await harness(CONFIG, { invariant: true })
    const { agent } = await mockAgent(ctx, [...pokes(3), textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('config', () => {
  it('fails loud without an assumption', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(StationarityGuard, { ...CONFIG, assumption: ' ' })).rejects.toThrow('`assumption` must name')
  })

  it.each([
    [{ remindAt: { sideEffect: 3, readOnly: 5 } }, 'remindAt.sideEffect (3) must be less than stopAt.sideEffect (3)'],
    [{ noopStopAt: 1 }, 'invalid noopStopAt 1'],
    [{ stopAt: { sideEffect: 3, readOnly: 6.5 } }, 'invalid stopAt.readOnly 6.5'],
  ] satisfies [Config, string][])('fails loud on %j', async (patch, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(StationarityGuard, { ...CONFIG, ...patch })).rejects.toThrow(message)
  })

  it('registers nothing in off mode', async () => {
    const ctx = await harness({ ...CONFIG, mode: 'off' })
    const { agent } = await mockAgent(ctx, [...pokes(3), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(decisions(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})
