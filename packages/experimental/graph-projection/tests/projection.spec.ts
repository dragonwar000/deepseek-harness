import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { graphNodeId, graphPlanId, graphRunId, nodeFingerprints, parsePlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphEdgeRecord, GraphNodeRecord, GraphPlan, GraphPlanRecord, GraphRunRecord } from '@deepseek-ai/dsh-experimental-graph-contract'
import { applyGraphEvent, emptyGraph, graphProjection, taskOf } from '../src/projection.ts'
import type { GraphState } from '../src/types.ts'

const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }

function plan(build = 'Build it', extraNeeds: string[] = []): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship',
    nodes: [
      { id: 'build', kind: 'execution', instruction: build },
      { id: 'check', kind: 'verification', instruction: 'Check it', needs: ['build', ...extraNeeds], contextScope: 'fresh-independent', output: VERDICT },
    ],
    edges: [{ from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' }],
    deliverable: 'Shipped', acceptance: ['tests pass'],
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

const planRecord = (version: number, graph: GraphPlan = plan(), overrides: Partial<GraphPlanRecord> = {}): GraphPlanRecord => ({
  planId: graphPlanId('ship'), version, sha: 'e'.repeat(64), mode: 'enforce', admitted: true, plan: graph, rejections: [], ...overrides,
})

function nodeRecord(
  graph: GraphPlan,
  version: number,
  node: string,
  revision: number,
  overrides: Partial<GraphNodeRecord>,
): GraphNodeRecord {
  return {
    runId: graphRunId('r1'), planId: graphPlanId('ship'), version, nodeId: graphNodeId(node), status: 'running',
    recoveryState: 'pristine', attempt: 1, revision, fingerprint: nodeFingerprints(graph).get(graphNodeId(node)) ?? '0'.repeat(64), ...overrides,
  }
}

const runRecord = (phase: 'start' | 'stop', overrides: Partial<GraphRunRecord> = {}): GraphRunRecord => ({
  runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, phase, mode: 'enforce', ...overrides,
})

type Entry = ['graph/plan', GraphPlanRecord] | ['graph/node', GraphNodeRecord] | ['graph/run', GraphRunRecord] | ['graph/edge', GraphEdgeRecord]

function fold(entries: Entry[]): GraphState {
  const session = Session.create(SessionId('graph'))
  let state = emptyGraph()
  for (const entry of entries) {
    const event = entry[0] === 'graph/plan' ? session.append('graph/plan', entry[1])
      : entry[0] === 'graph/node' ? session.append('graph/node', entry[1])
        : entry[0] === 'graph/run' ? session.append('graph/run', entry[1])
          : session.append('graph/edge', entry[1])
    state = applyGraphEvent(state, event)
  }
  return state
}

describe('graph projection v2', () => {
  it('declares state version 3', () => {
    expect(graphProjection).toMatchObject({ key: 'graph', stateVersion: 3 })
    expect(graphProjection.init()).toEqual({ graphs: [] })
  })

  it('starts an admitted version with pristine pending nodes and derives readiness', () => {
    const task = taskOf(fold([['graph/plan', planRecord(1)]]), graphPlanId('ship'))
    expect(task?.nodes.map(node => [node.id, node.status, node.attempt, node.revision])).toEqual([['build', 'ready', 0, 0], ['check', 'pending', 0, 0]])
    expect(task?.carry).toBeNull()
    expect(task?.runs).toEqual([])
  })

  it('folds node changes, re-derives readiness across a verifies edge, and records runs', () => {
    const graph = plan()
    const state = fold([
      ['graph/plan', planRecord(1, graph)],
      ['graph/run', runRecord('start')],
      ['graph/node', nodeRecord(graph, 1, 'build', 1, { status: 'running' })],
      ['graph/node', nodeRecord(graph, 1, 'build', 2, { status: 'unverified', basis: 'agentReported', output: { summary: 'x' }, childSession: SessionId('child-1'), detail: 'done' })],
      ['graph/run', runRecord('stop', { stopReason: 'NO_FURTHER_WORK' })],
    ])
    const task = taskOf(state, graphPlanId('ship'))
    expect(task?.nodes[0]).toMatchObject({ status: 'unverified', basis: 'agentReported', output: { summary: 'x' }, childSession: 'child-1', attempt: 1, revision: 2 })
    expect(task?.nodes[1]?.status).toBe('ready')
    expect(task?.runs).toEqual([{ runId: 'r1', stopReason: 'NO_FURTHER_WORK' }])
  })

  it('carries executed nodes of the replaced version with their fingerprints', () => {
    const first = plan()
    const second = plan('Build it again')
    const state = fold([
      ['graph/plan', planRecord(1, first)],
      ['graph/node', nodeRecord(first, 1, 'build', 1, { status: 'running' })],
      ['graph/node', nodeRecord(first, 1, 'build', 2, { status: 'executed', basis: 'predicate', output: { summary: 'x' } })],
      ['graph/node', nodeRecord(first, 1, 'check', 1, { status: 'running' })],
      ['graph/node', nodeRecord(first, 1, 'check', 2, { status: 'executed', basis: 'verifier' })],
      ['graph/plan', planRecord(2, second)],
    ])
    const task = taskOf(state, graphPlanId('ship'))
    expect(task?.version).toBe(2)
    expect(task?.carry).toEqual({
      version: 1,
      nodes: [
        { nodeId: 'build', fingerprint: nodeFingerprints(first).get(graphNodeId('build')), basis: 'predicate', output: { summary: 'x' } },
        { nodeId: 'check', fingerprint: nodeFingerprints(first).get(graphNodeId('check')), basis: 'verifier' },
      ],
    })
  })

  it('keeps other plans and runs apart and carries only executed nodes', () => {
    const graph = plan()
    const docs = { ...plan(), id: graphPlanId('docs') }
    const state = fold([
      ['graph/plan', planRecord(1, graph)],
      ['graph/plan', planRecord(1, docs, { planId: graphPlanId('docs') })],
      ['graph/run', runRecord('start')],
      ['graph/run', runRecord('start', { runId: graphRunId('r2') })],
      ['graph/run', runRecord('stop', { runId: graphRunId('r2'), stopReason: 'BUDGET' })],
      ['graph/node', nodeRecord(graph, 1, 'build', 1, { status: 'running' })],
      ['graph/node', nodeRecord(graph, 1, 'build', 2, { status: 'executed', basis: 'predicate' })],
      ['graph/plan', planRecord(2, plan('Build it again'))],
    ])
    expect(taskOf(state, graphPlanId('docs'))?.nodes[0]?.status).toBe('ready')
    const task = taskOf(state, graphPlanId('ship'))
    expect(task?.carry).toEqual({ version: 1, nodes: [{ nodeId: 'build', fingerprint: nodeFingerprints(graph).get(graphNodeId('build')), basis: 'predicate' }] })
    const before = taskOf(fold([
      ['graph/plan', planRecord(1, graph)],
      ['graph/run', runRecord('start')],
      ['graph/run', runRecord('start', { runId: graphRunId('r2') })],
      ['graph/run', runRecord('stop', { runId: graphRunId('r2'), stopReason: 'BUDGET' })],
    ]), graphPlanId('ship'))
    expect(before?.runs).toEqual([{ runId: 'r1' }, { runId: 'r2', stopReason: 'BUDGET' }])
  })

  it('gives a node that cannot be ordered an empty fingerprint and ignores refused versions', () => {
    const state = fold([
      ['graph/plan', planRecord(1, plan('Build it', ['ghost']), { mode: 'shadow' })],
      ['graph/plan', planRecord(2, plan(), { admitted: false })],
    ])
    const task = taskOf(state, graphPlanId('ship'))
    expect(task?.version).toBe(1)
    expect(task?.nodes[1]?.fingerprint).toBe('')
  })

  it.each<[string, Entry[], RegExp]>([
    ['a node record for a version that is not the task', [['graph/plan', planRecord(1)], ['graph/node', nodeRecord(plan(), 2, 'build', 1, {})]], /has no admitted task/],
    ['a node record for an unknown node', [['graph/plan', planRecord(1)], ['graph/node', nodeRecord(plan(), 1, 'ghost', 1, {})]], /unknown node ghost/],
    ['a run stop without a start', [['graph/plan', planRecord(1)], ['graph/run', runRecord('stop', { stopReason: 'GOAL_MET' })]], /no started run/],
    ['a run for a plan without a task', [['graph/run', runRecord('start')]], /has no admitted task/],
    ['an undecodable plan record', [['graph/plan', planRecord(1, plan(), { sha: 'x' })]], /does not decode/],
    ['an undecodable node record', [['graph/plan', planRecord(1)], ['graph/node', nodeRecord(plan(), 1, 'build', 1, { fingerprint: 'x' })]], /does not decode/],
    ['an undecodable run record', [['graph/plan', planRecord(1)], ['graph/run', runRecord('start', { version: 0 })]], /does not decode/],
  ])('fails terminally on %s', (_label, entries, message) => {
    const state = fold([...entries, ['graph/plan', planRecord(9)]])
    expect(state.failure).toMatch(message)
  })

  it('keeps a stop recorded without a reason', () => {
    const state = fold([['graph/plan', planRecord(1)], ['graph/run', runRecord('start')], ['graph/run', runRecord('stop')]])
    expect(taskOf(state, graphPlanId('ship'))?.runs).toEqual([{ runId: 'r1' }])
  })

  it('returns the same state for other events', () => {
    const session = Session.create(SessionId('other'))
    const state = emptyGraph()
    expect(applyGraphEvent(state, session.append('turn/start', { turn: 1 }))).toBe(state)
  })
})

function loopPlan(): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship',
    nodes: [
      { id: 'build', kind: 'execution', instruction: 'Build it' },
      { id: 'check', kind: 'verification', instruction: 'Check it', needs: ['build'], contextScope: 'fresh-independent', output: VERDICT },
    ],
    edges: [
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      { from: 'check', to: 'build', relation: 'feeds', artifact: 'notes', cycleGuard: { maxIterations: 2, until: 'pnpm test', plateauAfter: 1, metricCommand: 'count' } },
    ],
    deliverable: 'Shipped', acceptance: ['tests pass'],
  })
  if (!parsed.ok) throw new Error('loop plan must parse')
  return parsed.plan
}

function withoutOutput(record: GraphEdgeRecord): GraphEdgeRecord {
  const { output: _output, ...rest } = record
  return rest
}

function withoutMetric(record: GraphEdgeRecord): GraphEdgeRecord {
  const { metric: _metric, ...rest } = record
  return rest
}

const edgeRecord = (overrides: Partial<GraphEdgeRecord> = {}): GraphEdgeRecord => ({
  runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, from: graphNodeId('check'), to: graphNodeId('build'),
  iteration: 0, fireCount: 1, outcome: 'fired', checks: [{ command: 'pnpm test', exitCode: 1, timedOut: false, outputTail: 'FAIL' }],
  metric: '4', output: { verdict: 'fail' }, ...overrides,
})

describe('graph projection v3 loops', () => {
  it('seeds one view per cycle edge and folds decisions and node iterations', () => {
    const graph = loopPlan()
    const seeded = taskOf(fold([['graph/plan', planRecord(1, graph)]]), graphPlanId('ship'))
    expect(seeded?.edges).toEqual([{ from: 'check', to: 'build', fireCount: 0, decided: null, metrics: [] }])
    expect(seeded?.nodes.map(node => node.iteration)).toEqual([0, 0])
    const state = fold([
      ['graph/plan', planRecord(1, graph)],
      ['graph/edge', edgeRecord()],
      ['graph/node', nodeRecord(graph, 1, 'build', 1, { status: 'pending', attempt: 0, iteration: 1 })],
      ['graph/edge', withoutOutput(edgeRecord({ iteration: 1, outcome: 'plateau' }))],
    ])
    const task = taskOf(state, graphPlanId('ship'))
    expect(task?.edges).toEqual([{ from: 'check', to: 'build', fireCount: 1, decided: 1, outcome: 'plateau', metrics: ['4', '4'] }])
    expect(task?.nodes.find(node => node.id === 'build')).toMatchObject({ iteration: 1, status: 'ready', attempt: 0 })
  })

  it('keeps the output of a fire and leaves metrics unchanged without a metric', () => {
    const graph = loopPlan()
    const task = taskOf(fold([['graph/plan', planRecord(1, graph)], ['graph/edge', withoutMetric(edgeRecord())]]), graphPlanId('ship'))
    expect(task?.edges[0]).toEqual({ from: 'check', to: 'build', fireCount: 1, decided: 0, outcome: 'fired', metrics: [], output: { verdict: 'fail' } })
  })

  it('updates only the decided edge of a plan with several loops', () => {
    const graph = loopPlan()
    const guard = { maxIterations: 1, until: 'true' }
    graph.edges.push(
      { from: graphNodeId('check'), to: graphNodeId('check'), relation: 'feeds', artifact: 'self', cycleGuard: guard },
      { from: graphNodeId('build'), to: graphNodeId('build'), relation: 'feeds', artifact: 'self', cycleGuard: guard },
    )
    const task = taskOf(fold([['graph/plan', planRecord(1, graph)], ['graph/edge', edgeRecord()]]), graphPlanId('ship'))
    expect(task?.edges.map(edge => [edge.from, edge.to, edge.fireCount])).toEqual([['check', 'build', 1], ['check', 'check', 0], ['build', 'build', 0]])
  })

  it.each<[string, GraphEdgeRecord, RegExp]>([
    ['an undecodable record', { ...edgeRecord(), outcome: 'looped' as never }, /graph\/edge at seq \d+ does not decode/],
    ['a version without a task', edgeRecord({ version: 2 }), /plan ship version 2 has no admitted task/],
    ['an edge without cycleGuard', edgeRecord({ from: graphNodeId('build'), to: graphNodeId('check') }), /build->check is not a cycle edge/],
  ])('fails terminally on %s', (_label, record, message) => {
    const state = fold([['graph/plan', planRecord(1, loopPlan())], ['graph/edge', record]])
    expect(state.failure).toMatch(message)
  })
})
