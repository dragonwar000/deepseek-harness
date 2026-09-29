import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as DenialBudget from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { LoopDenial } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const CONFIG = {
  mode: 'enforce',
  assumption: 'the model retries denied actions instead of changing approach',
  maxConsecutive: 2,
  maxTotal: 5,
} satisfies Config

interface HarnessOptions {
  /** Mount ApprovalService; a string answers every request, `'none'` mounts it with no answerer. */
  approval?: ApprovalOutcome | 'none'
  goals?: boolean
  invariant?: boolean
}

async function harness(config: Config, options: HarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.invariant === true) {
    await ctx.plugin(InvariantService, { enabled: true })
    // Loaded lazily so the behavior tests run before the companion exists.
    await ctx.plugin(await import('../src/invariant.ts'))
  }
  if (options.goals === true) await ctx.plugin(GoalService)
  const outcome = options.approval
  if (outcome !== undefined) {
    await ctx.plugin(ApprovalService)
    if (outcome !== 'none') ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DenialBudget, config)
  for (const name of ['danger', 'refused', 'probe', 'skip', 'gated']) {
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  }
  ctx.tools.register(defineContentToolFixture({ name: 'boom', description: 'boom', parameters: {}, async execute() { throw new Error('boom failed') } }))
  ctx.tools.guard(exec => (exec.name === 'danger' ? 'danger is blocked by policy' : undefined))
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'skip') return Promise.resolve<PreToolDecision>({ kind: 'cancel' })
    if (exec.name === 'refused') return Promise.resolve<PreToolDecision>({ kind: 'deny', reason: 'refused by a pre-execute listener' })
    if (exec.name === 'gated') return Promise.resolve<PreToolDecision>({ kind: 'ask', reason: 'gated needs a human' })
    return next()
  })
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

function denials(agent: Agent): LoopDenial[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'loop/denial'> => e.type === 'loop/denial')
    .map(e => e.data)
}

function resultText(agent: Agent, callId: string): string {
  const event = agent.session.snapshotEvents()
    .find((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result' && e.data.message.toolCallId === ToolCallId(callId))
  return event === undefined ? '' : event.data.message.content.map(b => b.type === 'text' ? b.text : '').join('')
}

function turnEnds(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map(e => e.data.reason.kind)
}

const call = (id: string, name: string): StreamChunk[] => toolCallResponse(id, name, {})

describe('enforce mode', () => {
  it('appends the fixed advice to each denial and stops at the consecutive budget when no approval channel exists', async () => {
    const ctx = await harness(CONFIG)
    const { agent, adapter } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('unreached')])
    await prompt(ctx, agent, 'go')

    expect(adapter.requests).toHaveLength(2)
    expect(resultText(agent, 'd1')).toContain('danger is blocked by policy')
    expect(resultText(agent, 'd1')).toContain(DenialBudget.DENIAL_ADVICE)
    expect(denials(agent).map(d => [d.decision, d.consecutive, d.total, d.toolName, d.applied, d.approval])).toEqual([
      ['counted', 1, 1, 'danger', true, undefined],
      ['counted', 2, 2, 'danger', true, undefined],
      ['stopped', 2, 2, 'danger', true, 'unavailable'],
    ])
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('approval escalation', () => {
  it('continues after an allowed-once approval and resets the counts', async () => {
    const ctx = await harness(CONFIG, { approval: 'allowed-once' })
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('ok')])
    await prompt(ctx, agent, 'go')
    expect(denials(agent).map(d => [d.decision, d.approval])).toEqual([
      ['counted', undefined],
      ['counted', undefined],
      ['approved', 'allowed-once'],
    ])
    const asked = agent.session.snapshotEvents().find((e): e is SessionEvent<'approval/asked'> => e.type === 'approval/asked')
    expect(asked?.data).toMatchObject({ toolName: 'danger', callId: ToolCallId('d2') })
    expect(turnEnds(agent)).toEqual(['completed'])
  })

  it('stops and blocks an active goal after a rejected approval', async () => {
    const ctx = await harness(CONFIG, { approval: 'rejected', goals: true })
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('unreached')])
    ctx.goals.create(agent, { objective: 'denial test' })
    await prompt(ctx, agent, 'go')
    expect(denials(agent).at(-1)).toMatchObject({ decision: 'stopped', approval: 'rejected' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', blockedReason: { code: 'denial-budget' } })
    expect(turnEnds(agent)).toEqual(['blocked'])
  })

  it('stops without touching the goal registry when no goal is current', async () => {
    const ctx = await harness(CONFIG, { approval: 'none', goals: true })
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(denials(agent).at(-1)).toMatchObject({ decision: 'stopped', approval: 'unavailable' })
    expect(ctx.goals.get(agent)).toBeUndefined()
    expect(turnEnds(agent)).toEqual(['blocked'])
  })
})

describe('denial sources', () => {
  const WIDE = { ...CONFIG, maxConsecutive: 10, maxTotal: 10 } satisfies Config

  it('counts a guard denial, a pre-execute deny, and each approval non-grant, and advises on each', async () => {
    const cases: [HarnessOptions, string, string][] = [
      [{}, 'danger', 'danger is blocked by policy'],
      [{}, 'refused', 'refused by a pre-execute listener'],
      [{ approval: 'rejected' }, 'gated', 'the user rejected tool "gated"'],
      [{ approval: 'none' }, 'gated', 'no approval channel is available'],
      [{}, 'gated', 'gated needs a human'],
    ]
    for (const [options, tool, reason] of cases) {
      const ctx = await harness(WIDE, options)
      const { agent } = await mockAgent(ctx, [call('c1', tool), textResponse('done')])
      await prompt(ctx, agent, 'go')
      expect(resultText(agent, 'c1')).toContain(reason)
      expect(resultText(agent, 'c1')).toContain(DenialBudget.DENIAL_ADVICE)
      expect(denials(agent).map(d => [d.decision, d.toolName, d.callId])).toEqual([['counted', tool, ToolCallId('c1')]])
    }
  })

  it('does not count a failed tool body, a cancelled call, or an approved ask', async () => {
    const ctx = await harness({ ...CONFIG, maxConsecutive: 1 }, { approval: 'allowed-once' })
    const { agent } = await mockAgent(ctx, [call('b1', 'boom'), call('s1', 'skip'), call('g1', 'gated'), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(resultText(agent, 'b1')).toContain('boom failed')
    expect(resultText(agent, 'b1')).not.toContain(DenialBudget.DENIAL_ADVICE)
    expect(resultText(agent, 's1')).toContain('aborted before dispatch')
    expect(resultText(agent, 's1')).not.toContain(DenialBudget.DENIAL_ADVICE)
    expect(resultText(agent, 'g1')).toBe('ok')
    expect(denials(agent)).toEqual([])
    expect(turnEnds(agent)).toEqual(['completed'])
  })

  it('leaves a downstream block of a denial unchanged', async () => {
    const ctx = await harness(WIDE)
    ctx.on('tools/post-execute', () => Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'blocked downstream' }] }))
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(resultText(agent, 'd1')).toBe('blocked downstream')
    expect(denials(agent)).toHaveLength(1)
  })
})

describe('counting', () => {
  it('resets the consecutive count on an allowed call but keeps the total', async () => {
    const ctx = await harness(CONFIG)
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('p1', 'probe'), call('d2', 'danger'), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(denials(agent).map(d => [d.decision, d.consecutive, d.total])).toEqual([
      ['counted', 1, 1],
      ['counted', 1, 2],
    ])
    expect(turnEnds(agent)).toEqual(['completed'])
  })

  it('trips on the total budget', async () => {
    const ctx = await harness({ ...CONFIG, maxConsecutive: 10, maxTotal: 2 })
    const { agent, adapter } = await mockAgent(ctx, [call('d1', 'danger'), call('p1', 'probe'), call('d2', 'danger'), textResponse('unreached')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(3)
    expect(denials(agent).at(-1)).toMatchObject({ decision: 'stopped', consecutive: 1, total: 2 })
  })

  it('starts over after a human message', async () => {
    const ctx = await harness(CONFIG)
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), textResponse('a'), call('d2', 'danger'), textResponse('b')])
    await prompt(ctx, agent, 'go')
    await prompt(ctx, agent, 'again')
    expect(denials(agent).map(d => [d.turn, d.consecutive, d.total])).toEqual([[1, 1, 1], [2, 1, 1]])
    expect(turnEnds(agent)).toEqual(['completed', 'completed'])
  })

  it('ignores a direct registry call that has no agent', async () => {
    const ctx = await harness(CONFIG)
    const result = await ctx.tools.execute({ callId: ToolCallId('direct'), name: 'danger', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.content.map(b => b.type === 'text' ? b.text : '').join('')).not.toContain(DenialBudget.DENIAL_ADVICE)
  })
})

describe('shadow mode', () => {
  it('records the trip without advising or stopping', async () => {
    const ctx = await harness({ ...CONFIG, mode: 'shadow' })
    const { agent, adapter } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(adapter.requests).toHaveLength(3)
    expect(resultText(agent, 'd1')).not.toContain(DenialBudget.DENIAL_ADVICE)
    expect(denials(agent).map(d => [d.decision, d.applied, d.approval])).toEqual([
      ['counted', false, undefined],
      ['counted', false, undefined],
      ['stopped', false, undefined],
    ])
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})

describe('invariant companion', () => {
  it('holds through the real loop when an approval continues the turn', async () => {
    const ctx = await harness(CONFIG, { approval: 'allowed-once', invariant: true })
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('ok')])
    await prompt(ctx, agent, 'go')
    expect(denials(agent).at(-1)).toMatchObject({ decision: 'approved' })
    expect(turnEnds(agent)).toEqual(['completed'])
  })
})

describe('config', () => {
  it('fails loud without an assumption', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(DenialBudget, { ...CONFIG, assumption: '' })).rejects.toThrow('`assumption` must name')
  })

  it.each([
    [{ maxConsecutive: 0 }, 'invalid maxConsecutive 0'],
    [{ maxTotal: 1.5 }, 'invalid maxTotal 1.5'],
  ] satisfies [Config, string][])('fails loud on %j', async (patch, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(DenialBudget, { ...CONFIG, ...patch })).rejects.toThrow(message)
  })

  it('registers nothing in off mode', async () => {
    const ctx = await harness({ ...CONFIG, mode: 'off' })
    const { agent } = await mockAgent(ctx, [call('d1', 'danger'), call('d2', 'danger'), textResponse('done')])
    await prompt(ctx, agent, 'go')
    expect(denials(agent)).toEqual([])
    expect(resultText(agent, 'd1')).not.toContain(DenialBudget.DENIAL_ADVICE)
  })
})
