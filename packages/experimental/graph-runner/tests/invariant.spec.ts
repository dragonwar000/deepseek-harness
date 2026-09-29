import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { graphNodeId, graphPlanId, graphRunId, nodeFingerprints, parsePlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphNodeRecord, GraphPlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import * as RunnerInvariant from '../src/invariant.ts'
import { l2Plan } from './harness.ts'

function plan(): GraphPlan {
  const parsed = parsePlan(l2Plan())
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

async function open(id: string, withProjection = true): Promise<{ session: Session; graph: GraphPlan }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantService, { enabled: true })
  if (withProjection) await ctx.plugin(GraphProjection)
  await ctx.plugin(RunnerInvariant)
  const session = ctx.sessions.create(SessionId(id))
  const graph = plan()
  session.append('graph/plan', { planId: graphPlanId('ship'), version: 1, sha: 'f'.repeat(64), mode: 'enforce', admitted: true, plan: graph, rejections: [] })
  session.append('graph/run', { runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, phase: 'start', mode: 'enforce' })
  return { session, graph }
}

function record(graph: GraphPlan, node: string, revision: number, overrides: Partial<GraphNodeRecord>): GraphNodeRecord {
  return {
    runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, nodeId: graphNodeId(node), status: 'running',
    recoveryState: 'pristine', attempt: 1, revision, fingerprint: nodeFingerprints(graph).get(graphNodeId(node))!, ...overrides,
  }
}

const VIOLATION: Partial<InvariantError> = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-graph-runner' }

describe('graph-runner invariant', () => {
  it('accepts a legal node lifecycle and a run stop after its start', async () => {
    const { session, graph } = await open('gr-ok')
    expect(() => {
      session.append('graph/node', record(graph, 'build', 1, { status: 'running' }))
      session.append('graph/node', record(graph, 'build', 2, { status: 'unverified', basis: 'agentReported', output: { summary: 'x' } }))
      session.append('graph/node', record(graph, 'build', 3, { status: 'executed', basis: 'verifier', output: { summary: 'x' } }))
      session.append('graph/node', record(graph, 'spec', 1, { status: 'executed', basis: 'predicate', carriedFrom: 1 }))
      session.append('graph/run', { runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, phase: 'stop', mode: 'enforce', stopReason: 'NO_FURTHER_WORK' })
    }).not.toThrow()
  })

  it.each<[string, (graph: GraphPlan) => GraphNodeRecord[]]>([
    ['an illegal transition', graph => [record(graph, 'build', 1, { status: 'failed_retryable' })]],
    ['a revision gap', graph => [record(graph, 'build', 2, { status: 'running' })]],
    ['executed without proof', graph => [record(graph, 'build', 1, { status: 'running' }), record(graph, 'build', 2, { status: 'executed', basis: 'agentReported', output: { summary: 'x' } })]],
    ['executed from pending without carriedFrom', graph => [record(graph, 'spec', 1, { status: 'executed', basis: 'predicate' })]],
    ['output that misses the node schema', graph => [record(graph, 'build', 1, { status: 'running' }), record(graph, 'build', 2, { status: 'unverified', basis: 'agentReported', output: { wrong: 1 } })]],
    ['a version that is not admitted', graph => [record(graph, 'build', 1, { version: 2 })]],
  ])('rejects %s', async (_label, build) => {
    const { session, graph } = await open('gr-bad')
    const records = build(graph)
    for (const entry of records.slice(0, -1)) session.append('graph/node', entry)
    expect(() => session.append('graph/node', records.at(-1)!)).toThrow(expect.objectContaining(VIOLATION))
  })

  it('ignores graph events when the graph projection is not mounted and ignores other events', async () => {
    const { session, graph } = await open('gr-absent', false)
    expect(() => session.append('graph/node', record(graph, 'build', 5, { status: 'failed' }))).not.toThrow()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })
})
