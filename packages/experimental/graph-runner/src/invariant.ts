/** Graph-runner runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import { canReopen, canTransition, cycleBody } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphEdgeRecord, GraphNodeBasis, GraphNodeRecord } from '@deepseek-ai/dsh-experimental-graph-contract'
import { applyGraphEvent, taskOf } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { GraphState, GraphTask, GraphTaskNode } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-graph-runner'
const PROOF: ReadonlySet<GraphNodeBasis> = new Set(['predicate', 'verifier', 'human'])

/** Cordis companion plugin name. */
export const name = 'graph-runner-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Whether one node record contradicts the projected state before it.
 * @param state - projected `graph` state before the record; the record's task and node exist in it.
 * @param record - the `graph/node` payload.
 * @returns the violated relation, or undefined when the record is consistent.
 */
export function nodeViolation(state: GraphState, record: GraphNodeRecord): string | undefined {
  const task = taskOf(state, record.planId)
  const node = task?.nodes.find(entry => entry.id === record.nodeId)
  const declared = task?.plan.nodes.find(entry => entry.id === record.nodeId)
  /* v8 ignore next -- the caller checks this record folds onto the prefix first, which requires the task and the node. */
  if (task === undefined || node === undefined || declared === undefined) return undefined
  if (record.revision !== node.revision + 1) return `revision ${record.revision} does not follow ${node.revision}`
  const iteration = record.iteration ?? 0
  if (iteration !== node.iteration) return reopenViolation(task, node, record, iteration)
  if (!canTransition(node.status, record.status)) return `${node.status} cannot become ${record.status}`
  if (record.status === 'executed' && (node.status === 'pending' || node.status === 'ready') && record.carriedFrom === undefined) {
    return 'a node that never ran became executed without carriedFrom'
  }
  if (record.status === 'executed' && (record.basis === undefined || !PROOF.has(record.basis))) {
    return `executed without proof (basis ${String(record.basis)})`
  }
  if (record.output !== undefined && validateJsonSchemaValue(declared.output, record.output).length > 0) {
    return 'the output does not match the node output schema'
  }
  return undefined
}

/**
 * Whether a record that changes a node's iteration is a legal reopen.
 * @param task - projected task before the record.
 * @param node - projected node before the record.
 * @param record - the record.
 * @param iteration - the record's iteration.
 * @returns the violated relation, or undefined for a legal reopen.
 */
function reopenViolation(task: GraphTask, node: GraphTaskNode, record: GraphNodeRecord, iteration: number): string | undefined {
  if (iteration !== node.iteration + 1) return `iteration ${iteration} does not follow ${node.iteration}`
  if (record.status !== 'pending' || record.attempt !== 0) return 'a reopened node must start pending with attempt 0'
  if (!canReopen(node.status)) return `${node.status} cannot be reopened`
  const fired = task.edges.some(edge => edge.outcome === 'fired' && cycleBody(task.plan, edge).includes(node.id))
  return fired ? undefined : 'reopened without a fired cycle edge whose loop contains it'
}

/**
 * Whether one cycle-edge record contradicts the projected state before it.
 * @param state - projected `graph` state before the record; the record's task and cycle edge exist in it.
 * @param record - the `graph/edge` payload.
 * @returns the violated relation, or undefined when the decision is consistent.
 */
export function edgeViolation(state: GraphState, record: GraphEdgeRecord): string | undefined {
  const task = taskOf(state, record.planId)
  const view = task?.edges.find(edge => edge.from === record.from && edge.to === record.to)
  const guard = task?.plan.edges.find(edge => edge.from === record.from && edge.to === record.to)?.cycleGuard
  const from = task?.nodes.find(node => node.id === record.from)
  /* v8 ignore next -- the caller folds the record first, which requires the task, the cycle edge, and its from node. */
  if (view === undefined || guard === undefined || from === undefined) return undefined
  if (from.status !== 'executed' || from.iteration !== record.iteration) return `decided while ${record.from} is ${from.status} at iteration ${from.iteration}`
  if (view.decided !== null && view.decided >= record.iteration) return `iteration ${record.iteration} of ${record.from} was already decided`
  const expected = record.outcome === 'fired' ? view.fireCount + 1 : view.fireCount
  if (record.fireCount !== expected) return `fire count ${record.fireCount} does not follow ${view.fireCount}`
  const passed = record.checks.some(check => check.exitCode === 0)
  if (passed !== (record.outcome === 'until-met')) return `${record.outcome} with ${passed ? 'a passing' : 'a failing'} until check`
  if (record.outcome === 'fired' && record.fireCount > guard.maxIterations) return `fire ${record.fireCount} exceeds maxIterations ${guard.maxIterations}`
  if (record.outcome === 'exhausted' && view.fireCount < guard.maxIterations) return `exhausted after ${view.fireCount} of ${guard.maxIterations} fires`
  return undefined
}

/**
 * Whether an event is a runner record.
 * @param event - any committed Session event.
 * @returns true for `graph/node`, `graph/run`, and `graph/edge`.
 */
function isRunnerEvent(event: SessionEvent): event is SessionEvent<'graph/node' | 'graph/run' | 'graph/edge'> {
  return event.type === 'graph/node' || event.type === 'graph/run' || event.type === 'graph/edge'
}

/**
 * The violation one runner record makes against the projected prefix.
 * @param prefix - projected `graph` state before the record.
 * @param event - the `graph/node`, `graph/run`, or `graph/edge` event.
 * @returns the fold failure, node violation, or edge violation, or undefined when the record is consistent.
 */
function recordViolation(prefix: GraphState, event: SessionEvent<'graph/node' | 'graph/run' | 'graph/edge'>): string | undefined {
  const folded = applyGraphEvent(prefix, event).failure
  if (folded !== undefined && prefix.failure === undefined) return folded
  if (event.type === 'graph/run') return undefined
  if (event.type === 'graph/edge') {
    const violation = edgeViolation(prefix, event.data)
    return violation === undefined ? undefined : `graph/edge ${event.data.planId}/${event.data.from}->${event.data.to}: ${violation}`
  }
  const violation = nodeViolation(prefix, event.data)
  return violation === undefined ? undefined : `graph/node ${event.data.planId}/${event.data.nodeId}: ${violation}`
}

/**
 * Every `graph/node`, `graph/run`, and `graph/edge` folds onto the projected
 * prefix; every node record is a legal, proven step or a reopen by a fired
 * loop; every edge decision follows the edge's fire count and until check.
 * @param ctx - the registration's child context; its listener disposes with it.
 * @param fail - reports a violation under the graph-runner package name.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    const [session, event] = args as [Session, SessionEvent]
    if (eventName !== 'session/event' || !isRunnerEvent(event)) return
    const prefix = ctx.sessionProjections.stateOf(session, 'graph')
    const violation = prefix === undefined ? undefined : recordViolation(prefix, event)
    if (violation !== undefined) fail(violation)
  }, { global: true })
}, { inject: ['sessionProjections'] })

/**
 * Register the package invariant companion.
 * @param ctx - companion plugin context with the invariant registry.
 * @returns a promise of the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
