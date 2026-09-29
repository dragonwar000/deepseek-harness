/**
 * Node lifecycle rules shared by the graph runner, the graph projection, and
 * the runner invariant: the status transition table, need satisfaction, and
 * node fingerprints that carry results across plan versions.
 * @module @deepseek-ai/dsh-experimental-graph-contract/run
 */

import { planOrder } from './audit.ts'
import { planSha } from './digest.ts'
import type { GraphNodeId, GraphNodeStatus, GraphPlan } from './types.ts'

/**
 * Legal next statuses. `pending`/`ready` → `executed` is legal only for a
 * record with `carriedFrom`; the runner invariant checks that condition.
 */
export const NODE_TRANSITIONS: Readonly<Record<GraphNodeStatus, readonly GraphNodeStatus[]>> = {
  pending: ['running', 'waiting_human', 'executed', 'skipped'],
  ready: ['running', 'waiting_human', 'executed', 'skipped'],
  running: ['executed', 'unverified', 'failed_retryable', 'failed', 'ready', 'cancelled'],
  waiting_human: ['executed', 'failed', 'cancelled'],
  unverified: ['executed', 'failed_retryable'],
  failed_retryable: ['running', 'failed'],
  cancelled: ['running', 'waiting_human', 'skipped'],
  executed: [],
  failed: [],
  skipped: [],
}

/**
 * Whether one status may follow another.
 * @param from - current status.
 * @param to - proposed status.
 * @returns true when the table lists `to` after `from`.
 */
export function canTransition(from: GraphNodeStatus, to: GraphNodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to)
}

/**
 * Whether one need of a node no longer blocks it.
 * @param plan - the plan.
 * @param status - current status of every node that has one.
 * @param nodeId - the needing node.
 * @param need - the needed node.
 * @returns true for an executed need, a failed need declared `mayFail`, or an unverified need across a `verifies` edge.
 */
export function needSatisfied(
  plan: GraphPlan,
  status: ReadonlyMap<GraphNodeId, GraphNodeStatus>,
  nodeId: GraphNodeId,
  need: GraphNodeId,
): boolean {
  const current = status.get(need)
  if (current === 'executed') return true
  if (current === 'failed') return plan.nodes.some(node => node.id === need && node.mayFail)
  return current === 'unverified' && plan.edges.some(edge => edge.from === need && edge.to === nodeId && edge.relation === 'verifies')
}

/**
 * Read a map entry the caller has proved present.
 * @param map - lookup table.
 * @param key - a key known to be present.
 * @returns the value.
 */
function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key)
  /* v8 ignore next -- nodeFingerprints reads only nodes and needs already placed by the topological order. */
  if (value === undefined) throw new Error(`graph run rules: no entry for ${String(key)}`)
  return value
}

/**
 * Fingerprint every orderable node: the digest of the node itself and the
 * fingerprints of its needs, so changing one node changes every dependent.
 * @param plan - the plan.
 * @returns node id → hex SHA-256; nodes on a cycle or with an undeclared need are absent.
 */
export function nodeFingerprints(plan: GraphPlan): ReadonlyMap<GraphNodeId, string> {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const fingerprints = new Map<GraphNodeId, string>()
  for (const id of planOrder(plan).order) {
    const node = must(nodes, id)
    fingerprints.set(id, planSha({ node, needs: node.needs.map(need => must(fingerprints, need)) }))
  }
  return fingerprints
}
