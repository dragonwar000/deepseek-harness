import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { canReopen, canTransition, needSatisfied, NODE_TRANSITIONS, nodeFingerprints } from '../src/run.ts'
import { graphEdgeRecordSchema, graphNodeId, graphNodeRecordSchema, graphPlanId, graphRunId, graphRunRecordSchema, parsePlan } from '../src/schema.ts'
import type { GraphNodeStatus, GraphPlan } from '../src/types.ts'

function plan(overrides: { buildInstruction?: string; reportNeeds?: string[] } = {}): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id: 'ship', level: 'L2', goal: 'Ship',
    nodes: [
      { id: 'build', kind: 'execution', instruction: overrides.buildInstruction ?? 'Build it', mayFail: true },
      { id: 'check', kind: 'verification', instruction: 'Check it', needs: ['build'], contextScope: 'fresh-independent',
        output: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false } },
      { id: 'report', kind: 'synthesis', instruction: 'Report it', needs: overrides.reportNeeds ?? ['check'] },
    ],
    edges: [
      { from: 'build', to: 'check', relation: 'verifies', artifact: 'src/' },
      { from: 'check', to: 'report', relation: 'feeds', artifact: 'verdict' },
    ],
    deliverable: 'Shipped', acceptance: ['tests pass'],
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

const id = graphNodeId
const status = (entries: [string, GraphNodeStatus][]): ReadonlyMap<ReturnType<typeof graphNodeId>, GraphNodeStatus> =>
  new Map(entries.map(([key, value]) => [id(key), value]))

describe('node transitions', () => {
  it('ends in executed, failed, or skipped and never leaves them', () => {
    for (const terminal of ['executed', 'failed', 'skipped'] as const) expect(NODE_TRANSITIONS[terminal]).toEqual([])
    expect(canTransition('running', 'unverified')).toBe(true)
    expect(canTransition('unverified', 'executed')).toBe(true)
    expect(canTransition('executed', 'running')).toBe(false)
    expect(canTransition('failed_retryable', 'running')).toBe(true)
    expect(canTransition('waiting_human', 'running')).toBe(false)
  })
})

describe('needSatisfied', () => {
  it('accepts executed needs, failed mayFail needs, and unverified needs across a verifies edge only', () => {
    const graph = plan()
    expect(needSatisfied(graph, status([['build', 'executed']]), id('check'), id('build'))).toBe(true)
    expect(needSatisfied(graph, status([['build', 'failed']]), id('check'), id('build'))).toBe(true)
    expect(needSatisfied(graph, status([['build', 'unverified']]), id('check'), id('build'))).toBe(true)
    expect(needSatisfied(graph, status([['check', 'unverified']]), id('report'), id('check'))).toBe(false)
    expect(needSatisfied(graph, status([['check', 'failed']]), id('report'), id('check'))).toBe(false)
    expect(needSatisfied(graph, status([['build', 'running']]), id('check'), id('build'))).toBe(false)
    expect(needSatisfied(graph, status([]), id('check'), id('build'))).toBe(false)
  })
})

describe('nodeFingerprints', () => {
  it('is stable for an unchanged node and changes for every dependent of a changed node', () => {
    const before = nodeFingerprints(plan())
    const same = nodeFingerprints(plan())
    const after = nodeFingerprints(plan({ buildInstruction: 'Build it differently' }))
    expect(same.get(id('report'))).toBe(before.get(id('report')))
    for (const node of ['build', 'check', 'report']) expect(after.get(id(node))).not.toBe(before.get(id(node)))
    expect(before.get(id('build'))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves nodes that cannot be ordered without a fingerprint', () => {
    const dangling = nodeFingerprints(plan({ reportNeeds: ['check', 'ghost'] }))
    expect(dangling.has(id('report'))).toBe(false)
    expect(dangling.has(id('check'))).toBe(true)
  })
})

describe('runner records', () => {
  it('decodes node and run records and appends them as session events', () => {
    const node = {
      runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, nodeId: id('build'), status: 'executed' as const,
      basis: 'predicate' as const, recoveryState: 'pristine' as const, attempt: 1, revision: 2, fingerprint: 'd'.repeat(64),
      output: { summary: 'ok' }, childSession: SessionId('child-1'), checks: [{ command: 'pnpm test', exitCode: 0, timedOut: false, outputTail: '' }],
    }
    expect(graphNodeRecordSchema.safeParse(node).success).toBe(true)
    expect(graphNodeRecordSchema.safeParse({ ...node, status: 'blocked' }).success).toBe(false)
    const run = { runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, phase: 'stop' as const, mode: 'enforce' as const, stopReason: 'GOAL_MET' as const }
    expect(graphRunRecordSchema.safeParse(run).success).toBe(true)
    const session = Session.create(SessionId('records'))
    expect(session.append('graph/node', node).type).toBe('graph/node')
    expect(session.append('graph/run', run).type).toBe('graph/run')
  })
})

describe('loop records', () => {
  it('reopens any node that is neither running nor waiting for a human', () => {
    expect(canReopen('executed')).toBe(true)
    expect(canReopen('failed')).toBe(true)
    expect(canReopen('running')).toBe(false)
    expect(canReopen('waiting_human')).toBe(false)
  })

  it('decodes edge records and node iterations and appends them as session events', () => {
    const edge = {
      runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, from: id('check'), to: id('build'), iteration: 0, fireCount: 1,
      outcome: 'fired' as const, checks: [{ command: 'pnpm test', exitCode: 1, timedOut: false, outputTail: 'FAIL' }], metric: '3', output: { verdict: 'fail' },
    }
    expect(graphEdgeRecordSchema.safeParse(edge).success).toBe(true)
    expect(graphEdgeRecordSchema.safeParse({ ...edge, outcome: 'looped' }).success).toBe(false)
    const node = {
      runId: graphRunId('r1'), planId: graphPlanId('ship'), version: 1, nodeId: id('build'), status: 'pending' as const,
      recoveryState: 'pristine' as const, attempt: 0, revision: 4, fingerprint: 'd'.repeat(64), iteration: 1,
    }
    expect(graphNodeRecordSchema.safeParse(node).success).toBe(true)
    const session = Session.create(SessionId('loop-records'))
    expect(session.append('graph/edge', edge).type).toBe('graph/edge')
    expect(session.append('graph/node', node).type).toBe('graph/node')
  })
})
