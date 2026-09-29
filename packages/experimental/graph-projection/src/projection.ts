/**
 * The `graph` projection: the task graph of the latest admitted version of
 * each plan, folded from `graph/plan` events. Status is derived, never set:
 * a node with no needs is `ready`, every other node is `pending` until a
 * runner records its needs as done.
 * @module @deepseek-ai/dsh-experimental-graph-projection/projection
 */

import { z } from 'zod'
import { graphNodeIdSchema, graphPlanIdSchema, graphPlanRecordSchema, nodeKindSchema, planWaves } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { GraphState, GraphTask } from './types.ts'

const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/** `graph` state schema. */
export const graphStateSchema = z.object({
  graphs: z.array(z.object({
    planId: graphPlanIdSchema,
    version: positiveInt,
    waves: z.array(z.array(graphNodeIdSchema)),
    nodes: z.array(z.object({
      id: graphNodeIdSchema,
      kind: nodeKindSchema,
      needs: z.array(graphNodeIdSchema),
      status: z.enum(['pending', 'ready']),
    }).strict()),
  }).strict()),
  failure: z.string().optional(),
}).strict() as z.ZodType<GraphState>

/**
 * The state before any admitted plan.
 * @returns no task graphs.
 */
export function emptyGraph(): GraphState {
  return { graphs: [] }
}

/**
 * The task graph of one plan id.
 * @param state - folded state.
 * @param planId - plan id.
 * @returns its task graph, or undefined when no version was admitted.
 */
export function taskOf(state: GraphState, planId: GraphPlanId): GraphTask | undefined {
  return state.graphs.find(task => task.planId === planId)
}

/**
 * Fold one event: an admitted `graph/plan` with a parsed plan replaces that
 * plan id's task graph; a payload that does not decode sets `failure`.
 * @param state - state before the event.
 * @param event - any committed Session event.
 * @returns the same state when nothing changes, otherwise the next state.
 */
export function applyGraphEvent(state: GraphState, event: SessionEvent): GraphState {
  if (event.type !== 'graph/plan' || state.failure !== undefined) return state
  const decoded = graphPlanRecordSchema.safeParse(event.data)
  if (!decoded.success) return { ...state, failure: `graph/plan at seq ${event.seq} does not decode: ${decoded.error.message}` }
  const record = decoded.data
  if (!record.admitted || record.plan === null) return state
  const plan = record.plan
  const task: GraphTask = {
    planId: plan.id,
    version: record.version,
    waves: planWaves(plan),
    nodes: plan.nodes.map(node => ({ id: node.id, kind: node.kind, needs: [...node.needs], status: node.needs.length === 0 ? 'ready' : 'pending' })),
  }
  return { graphs: [...state.graphs.filter(entry => entry.planId !== plan.id), task] }
}

/** Host-only projection unit registered by the graph-projection plugin. */
export const graphProjection = {
  key: 'graph',
  stateVersion: 1,
  stateSchema: graphStateSchema,
  init: emptyGraph,
  apply: applyGraphEvent,
} satisfies ProjectionDefinition<'graph', GraphState>
