import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { graphNodeId, graphPlanId, graphRunId, nodeFingerprints, parsePlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphEdgeRecord, GraphNodeRecord, GraphPlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import * as RunnerInvariant from '../src/invariant.ts'
import { l2Plan, loopPlan } from './harness.ts'

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

function loop(): GraphPlan {
  const parsed = parsePlan(loopPlan({ maxIterations: 1, until: 'loop-until' }))
  if (!parsed.ok) throw new Error('loop plan must parse')
  return parsed.plan
}

async function openLoop(id: string): Promise<{ session: Session; graph: GraphPlan }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(GraphProjection)
  await ctx.plugin(RunnerInvariant)
  const session = ctx.sessions.create(SessionId(id))
  const graph = loop()
  session.append('graph/plan', { planId: graphPlanId('ship'), version: 1, sha: 'f'.repeat(64), mode: 'enforce', admitted: true, plan: graph, rejections: [] })
  session.append('graph/run', { runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, phase: 'start', mode: 'enforce' })
  return { session, graph }
}

function edge(overrides: Partial<GraphEdgeRecord>): GraphEdgeRecord {
  return {
    runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, from: graphNodeId('check'), to: graphNodeId('build'),
    iteration: 0, fireCount: 1, outcome: 'fired', checks: [{ command: 'loop-until', exitCode: 1, timedOut: false, outputTail: '' }], ...overrides,
  }
}

type Step = ['node', GraphNodeRecord] | ['edge', GraphEdgeRecord]

function append(session: Session, step: Step): void {
  if (step[0] === 'node') session.append('graph/node', step[1])
  else session.append('graph/edge', step[1])
}

/** check executed at iteration 0. */
const checked = (graph: GraphPlan): Step[] => [
  ['node', record(graph, 'check', 1, { status: 'running' })],
  ['node', record(graph, 'check', 2, { status: 'executed', basis: 'verifier', output: { verdict: 'pass' } })],
]

describe('graph-runner invariant loops', () => {
  it('accepts a fire, the reopen of the loop body, and an exhausted decision after the last fire', async () => {
    const { session, graph } = await openLoop('gr-loop-ok')
    const steps: Step[] = [
      ...checked(graph),
      ['edge', edge({})],
      ['node', record(graph, 'build', 1, { status: 'pending', attempt: 0, iteration: 1 })],
      ['node', record(graph, 'check', 3, { status: 'pending', attempt: 0, iteration: 1 })],
      ['node', record(graph, 'check', 4, { status: 'running', iteration: 1 })],
      ['node', record(graph, 'check', 5, { status: 'executed', basis: 'verifier', output: { verdict: 'pass' }, iteration: 1 })],
      ['edge', edge({ iteration: 1, fireCount: 1, outcome: 'exhausted' })],
    ]
    expect(() => { for (const step of steps) append(session, step) }).not.toThrow()
  })

  it.each<[string, (graph: GraphPlan) => Step[]]>([
    ['a decision before from is executed', () => [['edge', edge({})]]],
    ['a second decision of one iteration', graph => [...checked(graph), ['edge', edge({ outcome: 'until-met', fireCount: 0, checks: [{ command: 'loop-until', exitCode: 0, timedOut: false, outputTail: '' }] })], ['edge', edge({})]]],
    ['a fire count that skips', graph => [...checked(graph), ['edge', edge({ fireCount: 2 })]]],
    ['until-met with a failing until check', graph => [...checked(graph), ['edge', edge({ outcome: 'until-met', fireCount: 0 })]]],
    ['a fire with a passing until check', graph => [...checked(graph), ['edge', edge({ checks: [{ command: 'loop-until', exitCode: 0, timedOut: false, outputTail: '' }] })]]],
    ['exhausted before the last fire', graph => [...checked(graph), ['edge', edge({ outcome: 'exhausted', fireCount: 0 })]]],
    ['a fire beyond maxIterations', graph => [
      ...checked(graph), ['edge', edge({})],
      ['node', record(graph, 'check', 3, { status: 'pending', attempt: 0, iteration: 1 })],
      ['node', record(graph, 'check', 4, { status: 'running', iteration: 1 })],
      ['node', record(graph, 'check', 5, { status: 'executed', basis: 'verifier', output: { verdict: 'pass' }, iteration: 1 })],
      ['edge', edge({ iteration: 1, fireCount: 2 })],
    ]],
    ['a reopen without a fired edge', graph => [['node', record(graph, 'build', 1, { status: 'pending', attempt: 0, iteration: 1 })]]],
    ['a reopen that skips an iteration', graph => [...checked(graph), ['edge', edge({})], ['node', record(graph, 'build', 1, { status: 'pending', attempt: 0, iteration: 2 })]]],
    ['a reopen that is not pending', graph => [...checked(graph), ['edge', edge({})], ['node', record(graph, 'build', 1, { status: 'running', attempt: 0, iteration: 1 })]]],
    ['a reopen of a running node', graph => [
      ['node', record(graph, 'build', 1, { status: 'running' })],
      ...checked(graph), ['edge', edge({})],
      ['node', record(graph, 'build', 2, { status: 'pending', attempt: 0, iteration: 1 })],
    ]],
  ])('rejects %s', async (_label, build) => {
    const { session, graph } = await openLoop('gr-loop-bad')
    const steps = build(graph)
    for (const step of steps.slice(0, -1)) append(session, step)
    expect(() => { append(session, steps.at(-1)!) }).toThrow(expect.objectContaining(VIOLATION))
  })
})
