/**
 * The `graph` projection: the task graph of the latest admitted version of
 * each plan with the runner's recorded node states and runs. `pending` and
 * `ready` are derived from needs after every change; every other status is
 * the latest `graph/node` record.
 * @module @deepseek-ai/dsh-experimental-graph-projection/projection
 */

import { z } from 'zod'
import {
  graphNodeIdSchema,
  graphNodeRecordSchema,
  graphPlanIdSchema,
  graphPlanRecordSchema,
  graphPlanSchema,
  graphRunIdSchema,
  graphRunRecordSchema,
  jsonValueSchema,
  nodeBasisSchema,
  nodeFingerprints,
  nodeKindSchema,
  needSatisfied,
  nodeStatusSchema,
  planWaves,
  recoveryStateSchema,
  sessionIdSchema,
  stopReasonSchema,
} from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { GraphCarry, GraphState, GraphTask, GraphTaskNode } from './types.ts'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/** `graph` state schema. */
export const graphStateSchema = z.object({
  graphs: z.array(z.object({
    planId: graphPlanIdSchema,
    version: count.min(1),
    plan: graphPlanSchema,
    waves: z.array(z.array(graphNodeIdSchema)),
    nodes: z.array(z.object({
      id: graphNodeIdSchema,
      kind: nodeKindSchema,
      needs: z.array(graphNodeIdSchema),
      status: nodeStatusSchema,
      recoveryState: recoveryStateSchema,
      attempt: count,
      revision: count,
      fingerprint: z.string(),
      basis: nodeBasisSchema.optional(),
      output: jsonValueSchema.optional(),
      childSession: sessionIdSchema.optional(),
      detail: z.string().optional(),
    }).strict()),
    carry: z.object({
      version: count.min(1),
      nodes: z.array(z.object({
        nodeId: graphNodeIdSchema,
        fingerprint: z.string(),
        basis: nodeBasisSchema,
        output: jsonValueSchema.optional(),
      }).strict()),
    }).strict().nullable(),
    runs: z.array(z.object({ runId: graphRunIdSchema, stopReason: stopReasonSchema.optional() }).strict()),
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
 * Re-derive `pending`/`ready` for every node that has not started.
 * @param task - task graph after a change.
 * @returns the task with derived readiness.
 */
function derive(task: GraphTask): GraphTask {
  const status = new Map(task.nodes.map(node => [node.id, node.status]))
  return {
    ...task,
    nodes: task.nodes.map((node) => {
      if (node.status !== 'pending' && node.status !== 'ready') return node
      const ready = node.needs.every(need => needSatisfied(task.plan, status, node.id, need))
      return { ...node, status: ready ? 'ready' : 'pending' }
    }),
  }
}

/**
 * Replace one plan's task graph.
 * @param state - current state.
 * @param task - the new task graph.
 * @returns the next state.
 */
function withTask(state: GraphState, task: GraphTask): GraphState {
  return { graphs: state.graphs.map(entry => (entry.planId === task.planId ? task : entry)) }
}

function applyPlan(state: GraphState, event: SessionEvent<'graph/plan'>): GraphState {
  const decoded = graphPlanRecordSchema.safeParse(event.data)
  if (!decoded.success) return { ...state, failure: `graph/plan at seq ${event.seq} does not decode: ${decoded.error.message}` }
  const record = decoded.data
  if (!record.admitted || record.plan === null) return state
  const plan = record.plan
  const previous = taskOf(state, plan.id)
  const carry: GraphCarry | null = previous === undefined ? null : {
    version: previous.version,
    nodes: previous.nodes.flatMap(node => (node.status === 'executed' && node.basis !== undefined
      ? [{ nodeId: node.id, fingerprint: node.fingerprint, basis: node.basis, ...node.output === undefined ? {} : { output: node.output } }]
      : [])),
  }
  const fingerprints = nodeFingerprints(plan)
  const nodes: GraphTaskNode[] = plan.nodes.map(node => ({
    id: node.id,
    kind: node.kind,
    needs: [...node.needs],
    status: 'pending',
    recoveryState: 'pristine',
    attempt: 0,
    revision: 0,
    fingerprint: fingerprints.get(node.id) ?? '',
  }))
  const task = derive({ planId: plan.id, version: record.version, plan, waves: planWaves(plan), nodes, carry, runs: [] })
  return { graphs: [...state.graphs.filter(entry => entry.planId !== plan.id), task] }
}

function applyNode(state: GraphState, event: SessionEvent<'graph/node'>): GraphState {
  const decoded = graphNodeRecordSchema.safeParse(event.data)
  if (!decoded.success) return { ...state, failure: `graph/node at seq ${event.seq} does not decode: ${decoded.error.message}` }
  const record = decoded.data
  const task = taskOf(state, record.planId)
  if (task === undefined || task.version !== record.version) {
    return { ...state, failure: `graph/node at seq ${event.seq}: plan ${record.planId} version ${record.version} has no admitted task` }
  }
  if (!task.nodes.some(node => node.id === record.nodeId)) {
    return { ...state, failure: `graph/node at seq ${event.seq}: unknown node ${record.nodeId}` }
  }
  const nodes = task.nodes.map((node): GraphTaskNode => (node.id !== record.nodeId ? node : {
    id: node.id,
    kind: node.kind,
    needs: node.needs,
    status: record.status,
    recoveryState: record.recoveryState,
    attempt: record.attempt,
    revision: record.revision,
    fingerprint: node.fingerprint,
    ...record.basis === undefined ? {} : { basis: record.basis },
    ...record.output === undefined ? {} : { output: record.output },
    ...record.childSession === undefined ? {} : { childSession: record.childSession },
    ...record.detail === undefined ? {} : { detail: record.detail },
  }))
  return withTask(state, derive({ ...task, nodes }))
}

function applyRun(state: GraphState, event: SessionEvent<'graph/run'>): GraphState {
  const decoded = graphRunRecordSchema.safeParse(event.data)
  if (!decoded.success) return { ...state, failure: `graph/run at seq ${event.seq} does not decode: ${decoded.error.message}` }
  const record = decoded.data
  const task = taskOf(state, record.planId)
  if (task === undefined || task.version !== record.version) {
    return { ...state, failure: `graph/run at seq ${event.seq}: plan ${record.planId} version ${record.version} has no admitted task` }
  }
  if (record.phase === 'start') return withTask(state, { ...task, runs: [...task.runs, { runId: record.runId }] })
  if (!task.runs.some(run => run.runId === record.runId && run.stopReason === undefined)) {
    return { ...state, failure: `graph/run at seq ${event.seq}: run ${record.runId} stops with no started run` }
  }
  const stopped = { runId: record.runId, ...record.stopReason === undefined ? {} : { stopReason: record.stopReason } }
  const runs = task.runs.map(run => (run.runId === record.runId ? stopped : run))
  return withTask(state, { ...task, runs })
}

/**
 * Fold one event. Undecodable records and records that do not match the
 * admitted task set a terminal `failure`.
 * @param state - state before the event.
 * @param event - any committed Session event.
 * @returns the same state for unrelated events, otherwise the next state.
 */
export function applyGraphEvent(state: GraphState, event: SessionEvent): GraphState {
  if (state.failure !== undefined) return state
  switch (event.type) {
    case 'graph/plan': return applyPlan(state, event)
    case 'graph/node': return applyNode(state, event)
    case 'graph/run': return applyRun(state, event)
    // SessionEventMap is merge-extensible; every other event leaves the task graphs unchanged.
    default: return state
  }
}

/** Host-only projection unit registered by the graph-projection plugin. */
export const graphProjection = {
  key: 'graph',
  stateVersion: 2,
  stateSchema: graphStateSchema,
  init: emptyGraph,
  apply: applyGraphEvent,
} satisfies ProjectionDefinition<'graph', GraphState>
