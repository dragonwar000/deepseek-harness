import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as GraphContract from '../src/index.ts'
import * as GraphContractInvariant from '../src/invariant.ts'
import { graphPlanId, parsePlan } from '../src/schema.ts'
import type { GraphPlan, GraphPlanRecord, GraphRejection } from '../src/types.ts'

async function open(id: string, withContract = true): Promise<Session> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantService, { enabled: true })
  if (withContract) await ctx.plugin(GraphContract, { mode: 'enforce', assumption: 'multi-unit plans need a deterministic audit' })
  await ctx.plugin(GraphContractInvariant)
  return ctx.sessions.create(SessionId(id))
}

function plan(acceptance: string[] = ['tests pass']): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id: 'ship', level: 'L1', goal: 'One change',
    nodes: [{ id: 'build', kind: 'execution', instruction: 'Make the change' }],
    deliverable: 'The change', acceptance,
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

const finding = (code: GraphRejection['code'], severity: GraphRejection['severity'] = 'reject'): GraphRejection =>
  ({ check: 'structure', code, severity, subject: 'ship', detail: 'x', remedy: 'y' })

const record = (version: number, overrides: Partial<GraphPlanRecord> = {}): GraphPlanRecord => ({
  planId: graphPlanId('ship'), version, sha: 'b'.repeat(64), mode: 'enforce', admitted: true, plan: plan(), rejections: [], ...overrides,
})

const VIOLATION: Partial<InvariantError> = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-graph-contract' }

describe('graph-contract invariant', () => {
  it('accepts a rejected version followed by an admitted one and a warning-only admission', async () => {
    const session = await open('gc-ok')
    expect(() => session.append('graph/plan', record(1, { admitted: false, rejections: [finding('CYCLE')] }))).not.toThrow()
    expect(() => session.append('graph/plan', record(2, { rejections: [finding('LINEAR_PLAN', 'warn')] }))).not.toThrow()
  })

  it.each<[string, GraphPlanRecord[]]>([
    ['a version gap', [record(1), record(3)]],
    ['an admitted enforce version with a reject finding', [record(1, { rejections: [finding('CYCLE')] })]],
    ['a refused enforce version without a reject finding', [record(1, { admitted: false })]],
    ['a refused shadow version', [record(1, { mode: 'shadow', admitted: false, rejections: [finding('CYCLE')] })]],
    ['an unparsed plan without SCHEMA_INVALID', [record(1, { plan: null, admitted: false, rejections: [finding('CYCLE')] })]],
    ['changed acceptance without ACCEPTANCE_CHANGED', [record(1), record(2, { plan: plan(['other']) })]],
  ])('rejects %s', async (_label, sequence) => {
    const session = await open('gc-bad')
    const last = sequence.at(-1)!
    for (const entry of sequence.slice(0, -1)) session.append('graph/plan', entry)
    expect(() => session.append('graph/plan', last)).toThrow(expect.objectContaining(VIOLATION))
  })

  it('accepts a changed acceptance that carries ACCEPTANCE_CHANGED', async () => {
    const session = await open('gc-frozen')
    session.append('graph/plan', record(1))
    expect(() => session.append('graph/plan', record(2, { plan: plan(['other']), admitted: false, rejections: [finding('ACCEPTANCE_CHANGED')] }))).not.toThrow()
  })

  it('ignores graph/plan when the graph-contract plugin is not mounted', async () => {
    const session = await open('gc-absent', false)
    expect(() => session.append('graph/plan', record(7, { admitted: false }))).not.toThrow()
  })

  it('ignores other events', async () => {
    const session = await open('gc-other')
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })

  it('lets graph_audit refuse a history that cannot be folded when the companion is not mounted', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(GraphContract, { mode: 'enforce', assumption: 'multi-unit plans need a deterministic audit' })
    const agent = await ctx.agentLoop.create(SessionId('gc-unfolded'), { provider: 'mock', model: 'mock' })
    agent.session.append('graph/plan', record(1, { sha: 'not-hex' }))
    const result = await ctx.tools.execute({ callId: ToolCallId('unfolded'), name: 'graph_audit', arguments: { plan: {} }, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('the plan history of this session cannot be folded')
  })
})
