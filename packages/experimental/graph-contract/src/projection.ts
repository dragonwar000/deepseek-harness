/**
 * The `graphPlans` projection: plan versions, rejection memory, and the
 * latest admitted plan of every plan id, folded from `graph/plan` events.
 * @module @deepseek-ai/dsh-experimental-graph-contract/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { graphPlanRecordSchema, graphPlansStateSchema } from './schema.ts'
import type { GraphPlanHistory, GraphPlanId, GraphPlansState } from './types.ts'

/**
 * The state before any `graph/plan` event.
 * @returns an empty history list.
 */
export function emptyGraphPlans(): GraphPlansState {
  return { plans: [] }
}

/**
 * The history of one plan id.
 * @param state - folded state.
 * @param planId - plan id.
 * @returns its history, or undefined before its first version.
 */
export function historyOf(state: GraphPlansState, planId: GraphPlanId): GraphPlanHistory | undefined {
  return state.plans.find(history => history.planId === planId)
}

/**
 * Fold one event. A payload that does not decode, or a version that is not
 * the next one for its plan id, sets a terminal `failure`.
 * @param state - state before the event.
 * @param event - any committed Session event.
 * @returns the same state for other events, otherwise the next state.
 */
export function applyGraphPlanEvent(state: GraphPlansState, event: SessionEvent): GraphPlansState {
  if (event.type !== 'graph/plan' || state.failure !== undefined) return state
  const decoded = graphPlanRecordSchema.safeParse(event.data)
  if (!decoded.success) return { ...state, failure: `graph/plan at seq ${event.seq} does not decode: ${decoded.error.message}` }
  const record = decoded.data
  const previous = historyOf(state, record.planId)
  const expected = previous === undefined ? 1 : previous.versions.length + 1
  if (record.version !== expected) {
    return { ...state, failure: `graph/plan ${record.planId} at seq ${event.seq} has version ${record.version}; expected ${expected}` }
  }
  const history: GraphPlanHistory = {
    planId: record.planId,
    versions: [
      ...previous === undefined ? [] : previous.versions,
      {
        version: record.version,
        sha: record.sha,
        mode: record.mode,
        admitted: record.admitted,
        codes: record.rejections.map(entry => entry.code),
      },
    ],
    acceptance: previous?.acceptance ?? record.plan?.acceptance ?? null,
    admitted: record.admitted && record.plan !== null ? { version: record.version, plan: record.plan } : previous?.admitted ?? null,
  }
  const plans = previous === undefined
    ? [...state.plans, history]
    : state.plans.map(entry => (entry.planId === record.planId ? history : entry))
  return { plans }
}

/** Host-only projection unit registered by the graph-contract plugin. */
export const graphPlansProjection = {
  key: 'graphPlans',
  stateVersion: 1,
  stateSchema: graphPlansStateSchema,
  init: emptyGraphPlans,
  apply: applyGraphPlanEvent,
} satisfies ProjectionDefinition<'graphPlans', GraphPlansState>
