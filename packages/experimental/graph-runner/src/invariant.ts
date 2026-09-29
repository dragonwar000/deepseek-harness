/** Graph-runner runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import { canTransition } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphNodeBasis, GraphNodeRecord } from '@deepseek-ai/dsh-experimental-graph-contract'
import { applyGraphEvent, taskOf } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { GraphState } from '@deepseek-ai/dsh-experimental-graph-projection'
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
  if (node === undefined || declared === undefined) return undefined
  if (record.revision !== node.revision + 1) return `revision ${record.revision} does not follow ${node.revision}`
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
 * Whether an event is a runner record.
 * @param event - any committed Session event.
 * @returns true for `graph/node` and `graph/run`.
 */
function isRunnerEvent(event: SessionEvent): event is SessionEvent<'graph/node' | 'graph/run'> {
  return event.type === 'graph/node' || event.type === 'graph/run'
}

/**
 * The violation one runner record makes against the projected prefix.
 * @param prefix - projected `graph` state before the record.
 * @param event - the `graph/node` or `graph/run` event.
 * @returns the fold failure or node violation, or undefined when the record is consistent.
 */
function recordViolation(prefix: GraphState, event: SessionEvent<'graph/node' | 'graph/run'>): string | undefined {
  const folded = applyGraphEvent(prefix, event).failure
  if (folded !== undefined && prefix.failure === undefined) return folded
  if (event.type === 'graph/run') return undefined
  const violation = nodeViolation(prefix, event.data)
  return violation === undefined ? undefined : `graph/node ${event.data.planId}/${event.data.nodeId}: ${violation}`
}

/**
 * Every `graph/node` and `graph/run` folds onto the projected prefix, and
 * every node record is a legal, proven step from the node's projected state.
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
