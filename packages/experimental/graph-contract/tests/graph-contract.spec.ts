import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as GraphContract from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { GraphPlanRecord } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const ENFORCE = {
  mode: 'enforce',
  assumption: 'the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification',
  allowedTools: ['read', 'edit'],
} satisfies Config

const VERDICT_OUTPUT = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }

function diamond(acceptance: string[] = ['pnpm test passes']): Record<string, unknown> {
  return {
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship the fix',
    nodes: [
      { id: 'spec', kind: 'anchor', instruction: 'Spec exists', verify: ['test -f SPEC.md'] },
      { id: 'build', kind: 'execution', instruction: 'Fix it', needs: ['spec'], tools: ['read', 'edit'], writes: ['src'] },
      { id: 'check', kind: 'verification', instruction: 'Check it', needs: ['build'], tools: ['read'], contextScope: 'fresh-independent', output: VERDICT_OUTPUT },
      { id: 'report', kind: 'synthesis', instruction: 'Report it', needs: ['check'] },
    ],
    edges: [
      { from: 'spec', to: 'build', relation: 'anchors', artifact: 'SPEC.md' },
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      { from: 'check', to: 'report', relation: 'feeds', artifact: 'verdict' },
    ],
    deliverable: 'A verified fix', acceptance,
  }
}

function cyclic(): Record<string, unknown> {
  const plan = diamond()
  const nodes = plan['nodes'] as Record<string, unknown>[]
  nodes[0]!['needs'] = ['report']
  ;(plan['edges'] as Record<string, unknown>[]).push({ from: 'report', to: 'spec', relation: 'feeds', artifact: 'loop' })
  return plan
}

async function harness(config: Config, subagents = true): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (subagents) await ctx.plugin(SubagentRuntime)
  for (const name of ['read', 'edit']) {
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  }
  await ctx.plugin(GraphContract, config)
  return ctx
}

async function audit(ctx: Context, plans: unknown[]): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    ...plans.map((plan, index) => toolCallResponse(`c${index}`, 'graph_audit', { plan })),
    textResponse('done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan the change' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

function records(agent: Agent): GraphPlanRecord[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'graph/plan' ? [event.data] : []))
}

function results(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')]
    : []))
}

describe('graph_audit', () => {
  it('records a rejected version, then admits the fixed version with rejection memory', async () => {
    const ctx = await harness(ENFORCE)
    const agent = await audit(ctx, [cyclic(), diamond()])
    expect(records(agent).map(entry => [entry.version, entry.admitted, entry.rejections.map(item => item.code)])).toEqual([[1, false, ['CYCLE']], [2, true, []]])
    const [first, second] = results(agent)
    expect(first).toContain('graph_audit: rejected')
    expect(first).toContain('- [CYCLE] spec,build,check,report: nodes spec, build, check, report cannot be ordered by their needs. Remedy: Remove a dependency')
    expect(second).toContain('graph_audit: admitted')
    expect(second).toContain('previous versions: v1 rejected (CYCLE)')
    expect(second).toContain('waves: [spec] [build] [check] [report]')
    const state = ctx.sessionProjections.stateOf(agent.session, 'graphPlans')
    expect(state?.plans[0]?.admitted?.version).toBe(2)
  })

  it('marks an identical resubmission as a repeat', async () => {
    const ctx = await harness(ENFORCE)
    const agent = await audit(ctx, [cyclic(), cyclic()])
    expect(records(agent)[1]?.repeatOf).toBe(1)
    expect(results(agent)[1]).toContain('identical to version 1')
  })

  it('admits every version in shadow mode and still reports its findings', async () => {
    const ctx = await harness({ ...ENFORCE, mode: 'shadow' })
    const agent = await audit(ctx, [cyclic()])
    expect(records(agent)[0]).toMatchObject({ mode: 'shadow', admitted: true })
    expect(results(agent)[0]).toContain('graph_audit: admitted in shadow mode; the rejections below are recorded, not enforced')
  })

  it('records an unparsed plan with a readable id and skips input without one', async () => {
    const ctx = await harness(ENFORCE)
    const agent = await audit(ctx, [{ id: 'ship', format: 'dsh-graph/v1' }, { goal: 'no id' }])
    expect(records(agent)).toEqual([expect.objectContaining({ version: 1, plan: null, admitted: false })])
    expect(results(agent)[1]).toContain('plan: not recorded, because the input has no valid id')
  })

  it('freezes acceptance after the first parsed version', async () => {
    const ctx = await harness(ENFORCE)
    const agent = await audit(ctx, [diamond(), diamond(['something else'])])
    expect(records(agent)[1]).toMatchObject({ admitted: false, rejections: [expect.objectContaining({ code: 'ACCEPTANCE_CHANGED' })] })
  })

  it('reads tool registration and subagent depth from the deployment', async () => {
    const noSubagents = await harness({ ...ENFORCE, allowedTools: ['read'] }, false)
    const agent = await audit(noSubagents, [diamond()])
    expect(records(agent)[0]?.rejections.map(entry => entry.subject)).toEqual(['build:edit', 'subagents'])
  })

  it('lists warnings separately from rejections', async () => {
    const ctx = await harness(ENFORCE)
    const chain = {
      format: 'dsh-graph/v1', id: 'chain', level: 'L1', goal: 'Two steps',
      nodes: [
        { id: 'first', kind: 'execution', instruction: 'First', tools: ['read'] },
        { id: 'second', kind: 'execution', instruction: 'Second', needs: ['first'], tools: ['read'] },
      ],
      edges: [{ from: 'first', to: 'second', relation: 'hands_off', artifact: 'summary' }],
      deliverable: 'Done', acceptance: ['done'],
    }
    const agent = await audit(ctx, [chain])
    expect(records(agent)[0]).toMatchObject({ admitted: true })
    expect(results(agent)[0]).toContain('warnings (1):\n- [LINEAR_PLAN] chain:')
    expect(results(agent)[0]).not.toContain('rejections (')
  })

  it('refuses a call with no owning agent', async () => {
    const ctx = await harness(ENFORCE)
    const result = await ctx.tools.execute({ callId: ToolCallId('direct'), name: 'graph_audit', arguments: { plan: diamond() }, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
  })

  it('presents the call with the plan id', async () => {
    const ctx = await harness(ENFORCE)
    const definition = ctx.tools.get('graph_audit')
    expect(definition?.presentCall?.({ plan: { id: 'ship' } })).toEqual({ card: 'generic', title: 'Audit graph plan', kind: 'other', rawInput: 'ship' })
    expect(definition?.presentCall?.({ plan: ['not', 'a', 'plan'] })).toMatchObject({ rawInput: 'plan without an id' })
    expect(definition?.presentCall?.({ plan: { id: 3 } })).toMatchObject({ rawInput: 'plan without an id' })
  })

  it('registers nothing when off', async () => {
    const ctx = await harness({ mode: 'off' })
    expect(ctx.tools.get('graph_audit')).toBeUndefined()
  })

  it.each<[Config, RegExp]>([
    [{ ...ENFORCE, assumption: '  ' }, /`assumption` must name/],
    [{ ...ENFORCE, allowedTools: ['run_code'] }, /allowedTools cannot name run_code/],
    [{ ...ENFORCE, runBudget: { steps: -1 } }, /invalid runBudget\.steps -1/],
    [{ ...ENFORCE, runBudget: { wallMs: 1.5 } }, /invalid runBudget\.wallMs 1\.5/],
  ])('fails the load on %o', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(GraphContract, config)).rejects.toThrow(message)
  })
})

describe('capability routes', () => {
  const ROUTES = { ...ENFORCE, routes: [{ category: 'coding', provider: 'mock', model: 'mock-large' }, { category: 'review', provider: 'gone', model: 'x', reliability: 'verified' as const }] }

  it('records the routes a plan uses on graph/plan', async () => {
    const ctx = await harness(ROUTES)
    const plan = diamond()
    ;(plan['nodes'] as Record<string, unknown>[])[1]!['category'] = 'coding'
    const agent = await audit(ctx, [plan])
    expect(records(agent)[0]).toMatchObject({ admitted: true, routes: [{ category: 'coding', provider: 'mock', model: 'mock-large', reliability: 'unverified' }] })
  })

  it('lists routes with availability, granted tools, and depth', async () => {
    const ctx = await harness(ROUTES)
    vi.spyOn(ctx.llm, 'listModels').mockImplementation(provider => (provider === 'mock'
      ? Promise.resolve([{ provider: 'mock', id: 'mock-large', name: 'Mock large' }])
      : Promise.reject(new Error(`unknown provider ${provider}`))))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('c0', 'graph_capabilities', {}), textResponse('done')]))
    const agent = await ctx.agentLoop.create(SessionId('caps'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'what can nodes use?' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(JSON.parse(results(agent)[0]!)).toEqual({
      categories: [
        { category: 'coding', provider: 'mock', model: 'mock-large', reliability: 'unverified', available: true },
        { category: 'review', provider: 'gone', model: 'x', reliability: 'verified', available: false },
      ],
      tools: ['edit', 'read'],
      depth: { current: 0, max: 1 },
    })
    expect(ctx.tools.get('graph_capabilities')?.presentCall?.({})).toEqual({ card: 'generic', title: 'List graph capabilities', kind: 'read' })
  })

  it('omits depth without a subagent service and refuses a call with no owning agent', async () => {
    const ctx = await harness(ENFORCE, false)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('c0', 'graph_capabilities', {}), textResponse('done')]))
    const agent = await ctx.agentLoop.create(SessionId('caps-nodepth'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(JSON.parse(results(agent)[0]!)).toEqual({ categories: [], tools: ['edit', 'read'] })
    const direct = await ctx.tools.execute({ callId: ToolCallId('direct-caps'), name: 'graph_capabilities', arguments: {}, signal: new AbortController().signal })
    expect(direct.isError).toBe(true)
  })

  it.each<[Config, RegExp]>([
    [{ ...ENFORCE, routes: [{ category: ' ', provider: 'p', model: 'm' }] }, /every route needs a category, a provider, and a model/],
    [{ ...ENFORCE, routes: [{ category: 'a', provider: 'p', model: 'm' }, { category: 'a', provider: 'q', model: 'n' }] }, /category a is routed twice/],
  ])('fails the load on bad routes %#', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(GraphContract, config)).rejects.toThrow(message)
  })
})
