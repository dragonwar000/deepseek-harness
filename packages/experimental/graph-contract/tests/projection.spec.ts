import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyGraphPlanEvent, emptyGraphPlans, graphPlansProjection, historyOf } from '../src/projection.ts'
import { graphPlanId, parsePlan } from '../src/schema.ts'
import type { GraphPlan, GraphPlanRecord, GraphPlansState } from '../src/types.ts'

function plan(acceptance: string[] = ['tests pass'], id = 'ship'): GraphPlan {
  const parsed = parsePlan({
    format: 'dsh-graph/v1', id, level: 'L1', goal: 'One change',
    nodes: [{ id: 'build', kind: 'execution', instruction: 'Make the change' }],
    deliverable: 'The change', acceptance,
  })
  if (!parsed.ok) throw new Error('fixture plan must parse')
  return parsed.plan
}

function record(version: number, overrides: Partial<GraphPlanRecord> = {}): GraphPlanRecord {
  return {
    planId: graphPlanId('ship'), version, sha: 'a'.repeat(64), mode: 'enforce', admitted: true,
    plan: plan(), rejections: [], ...overrides,
  }
}

function fold(records: GraphPlanRecord[]): GraphPlansState {
  const session = Session.create(SessionId('fold'))
  let state = emptyGraphPlans()
  for (const entry of records) state = applyGraphPlanEvent(state, session.append('graph/plan', entry))
  return state
}

describe('graphPlans projection', () => {
  it('declares a versioned host-only unit', () => {
    expect(graphPlansProjection).toMatchObject({ key: 'graphPlans', stateVersion: 2 })
    expect(graphPlansProjection.init()).toEqual({ plans: [] })
  })

  it('folds versions, freezes the first acceptance, and keeps the latest admitted plan', () => {
    const state = fold([
      record(1, { admitted: false, rejections: [{ check: 'structure', code: 'CYCLE', severity: 'reject', subject: 'a,b', detail: 'x', remedy: 'y' }] }),
      record(2, { plan: plan(['tests pass', 'docs updated']) }),
      record(3, { admitted: false, plan: plan(['other']) }),
    ])
    const history = historyOf(state, graphPlanId('ship'))
    expect(history?.versions.map(version => [version.version, version.admitted, version.codes])).toEqual([[1, false, ['CYCLE']], [2, true, []], [3, false, []]])
    expect(history?.acceptance).toEqual(['tests pass'])
    expect(history?.admitted?.version).toBe(2)
  })

  it('takes acceptance from the first parsed version when version 1 did not parse', () => {
    const state = fold([record(1, { plan: null, admitted: false }), record(2, { plan: plan(['later']) })])
    expect(historyOf(state, graphPlanId('ship'))?.acceptance).toEqual(['later'])
  })

  it('tracks plan ids separately and updates each in place', () => {
    const state = fold([
      record(1),
      record(1, { planId: graphPlanId('docs'), plan: plan(['docs'], 'docs') }),
      record(2),
    ])
    expect(state.plans.map(history => [history.planId, history.versions.length])).toEqual([['ship', 2], ['docs', 1]])
    expect(historyOf(state, graphPlanId('none'))).toBeUndefined()
  })

  it('fails terminally on a version gap and on an undecodable payload', () => {
    const gap = fold([record(1), record(3), record(2)])
    expect(gap.failure).toMatch(/has version 3; expected 2/)
    expect(historyOf(gap, graphPlanId('ship'))?.versions).toHaveLength(1)
    const broken = fold([record(1, { sha: 'not-hex' })])
    expect(broken.failure).toMatch(/does not decode/)
  })

  it('returns the same state for other events', () => {
    const session = Session.create(SessionId('other'))
    const state = emptyGraphPlans()
    expect(applyGraphPlanEvent(state, session.append('turn/start', { turn: 1 }))).toBe(state)
  })

  it('keeps the recorded routes of the latest admitted version', () => {
    const route = { category: 'coding', provider: 'p', model: 'm', reliability: 'verified' as const }
    const state = fold([record(1), record(2, { routes: [route] })])
    expect(historyOf(state, graphPlanId('ship'))?.admitted).toMatchObject({ version: 2, routes: [route] })
    expect(historyOf(fold([record(1)]), graphPlanId('ship'))?.admitted?.routes).toEqual([])
  })
})
