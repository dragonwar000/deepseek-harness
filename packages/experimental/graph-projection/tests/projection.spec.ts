import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { graphPlanId, parsePlan } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphPlan, GraphPlanRecord } from '@deepseek-ai/dsh-experimental-graph-contract'
import { applyGraphEvent, emptyGraph, graphProjection, taskOf } from '../src/projection.ts'
import type { GraphState } from '../src/types.ts'

function plan(id = 'ship', extra: string[] = []): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id, level: 'L1', goal: 'Two steps',
    nodes: [
      { id: 'first', kind: 'execution', instruction: 'First' },
      { id: 'second', kind: 'execution', instruction: 'Second', needs: ['first', ...extra] },
    ],
    edges: [{ from: 'first', to: 'second', relation: 'hands_off', artifact: 'summary' }],
    deliverable: 'Done', acceptance: ['done'],
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

const record = (version: number, overrides: Partial<GraphPlanRecord> = {}): GraphPlanRecord => ({
  planId: graphPlanId('ship'), version, sha: 'c'.repeat(64), mode: 'enforce', admitted: true, plan: plan(), rejections: [], ...overrides,
})

function fold(records: GraphPlanRecord[]): GraphState {
  const session = Session.create(SessionId('graph'))
  let state = emptyGraph()
  for (const entry of records) state = applyGraphEvent(state, session.append('graph/plan', entry))
  return state
}

describe('graph projection', () => {
  it('declares a versioned host-only unit', () => {
    expect(graphProjection).toMatchObject({ key: 'graph', stateVersion: 1 })
    expect(graphProjection.init()).toEqual({ graphs: [] })
  })

  it('builds the task graph of the admitted version with derived status and waves', () => {
    const task = taskOf(fold([record(1)]), graphPlanId('ship'))
    expect(task).toEqual({
      planId: 'ship',
      version: 1,
      waves: [['first'], ['second']],
      nodes: [
        { id: 'first', kind: 'execution', needs: [], status: 'ready' },
        { id: 'second', kind: 'execution', needs: ['first'], status: 'pending' },
      ],
    })
  })

  it('ignores refused and unparsed versions and replaces the graph on a later admission', () => {
    const state = fold([
      record(1),
      record(2, { admitted: false, rejections: [{ check: 'structure', code: 'CYCLE', severity: 'reject', subject: 'x', detail: 'x', remedy: 'x' }] }),
      record(3, { plan: null, admitted: false, rejections: [{ check: 'schema', code: 'SCHEMA_INVALID', severity: 'reject', subject: 'plan', detail: 'x', remedy: 'x' }] }),
      record(4, { planId: graphPlanId('docs'), plan: plan('docs') }),
      record(5),
    ])
    expect(state.graphs.map(task => [task.planId, task.version])).toEqual([['docs', 4], ['ship', 5]])
    expect(taskOf(state, graphPlanId('none'))).toBeUndefined()
  })

  it('keeps a shadow-admitted plan whose needs cannot all be placed out of the waves', () => {
    const state = fold([record(1, { mode: 'shadow', plan: plan('ship', ['ghost']) })])
    expect(taskOf(state, graphPlanId('ship'))?.waves).toEqual([['first']])
  })

  it('fails terminally on an undecodable payload and returns the same state for other events', () => {
    const broken = fold([record(1, { sha: 'nope' }), record(2)])
    expect(broken.failure).toMatch(/does not decode/)
    expect(broken.graphs).toEqual([])
    const session = Session.create(SessionId('other'))
    const state = emptyGraph()
    expect(applyGraphEvent(state, session.append('turn/start', { turn: 1 }))).toBe(state)
  })
})
