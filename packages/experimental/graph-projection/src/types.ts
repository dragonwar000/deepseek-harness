/**
 * Pure types of the graph projection: the `graph` task-graph state folded
 * from admitted `graph/plan` versions.
 * @module @deepseek-ai/dsh-experimental-graph-projection/types
 */

import type { GraphNodeId, GraphNodeKind, GraphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract/types'

/** Derived node status: `ready` when every needed node is done. Nothing is done before a runner records it. */
export type GraphNodeStatus = 'pending' | 'ready'

/** One node of an admitted plan with its derived status. */
export interface GraphTaskNode {
  /** Node id. */
  id: GraphNodeId
  /** Node kind. */
  kind: GraphNodeKind
  /** Needed nodes. */
  needs: GraphNodeId[]
  /** Derived status. */
  status: GraphNodeStatus
}

/** The task graph of the latest admitted version of one plan. */
export interface GraphTask {
  /** Plan id. */
  planId: GraphPlanId
  /** Admitted version this task graph shows. */
  version: number
  /** Nodes that can run together, wave by wave. */
  waves: GraphNodeId[][]
  /** Nodes in plan order. */
  nodes: GraphTaskNode[]
}

/** `graph` projection state; a set `failure` is terminal. */
export interface GraphState {
  /** One task graph per admitted plan id, most recently admitted last. */
  graphs: GraphTask[]
  /** Why a `graph/plan` event could not be folded. */
  failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Task graphs of admitted plans. */
    graph: GraphState
  }
}
