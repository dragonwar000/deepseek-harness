/**
 * Pure types of the graph projection: the `graph` task-graph state folded
 * from admitted `graph/plan` versions and the runner's `graph/node` and
 * `graph/run` records.
 * @module @deepseek-ai/dsh-experimental-graph-projection/types
 */

import type {
  GraphNodeBasis,
  GraphNodeId,
  GraphNodeKind,
  GraphNodeStatus,
  GraphPlan,
  GraphPlanId,
  GraphRecoveryState,
  GraphRunId,
  GraphStopReason,
} from '@deepseek-ai/dsh-experimental-graph-contract/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type { GraphNodeStatus } from '@deepseek-ai/dsh-experimental-graph-contract/types'

/** One node of the admitted version with its latest recorded state. */
export interface GraphTaskNode {
  /** Node id. */
  id: GraphNodeId
  /** Node kind. */
  kind: GraphNodeKind
  /** Needed nodes. */
  needs: GraphNodeId[]
  /** Latest recorded status; `pending`/`ready` are derived from needs. */
  status: GraphNodeStatus
  /** Recovery rung. */
  recoveryState: GraphRecoveryState
  /** Dispatches so far in this version. */
  attempt: number
  /** Number of `graph/node` records folded for this node in this version. */
  revision: number
  /** Node fingerprint; empty for a node that cannot be ordered. */
  fingerprint: string
  /** Basis of the latest status. */
  basis?: GraphNodeBasis
  /** Structured output of the latest attempt. */
  output?: JsonValue
  /** Child session of the latest attempt. */
  childSession?: SessionId
  /** Reason recorded with the latest status. */
  detail?: string
}

/** One executed node of the version a new admission replaced. */
export interface GraphCarryNode {
  /** Node id. */
  nodeId: GraphNodeId
  /** Its fingerprint in the replaced version. */
  fingerprint: string
  /** Its basis. */
  basis: GraphNodeBasis
  /** Its output. */
  output?: JsonValue
}

/** Executed results a new version may carry over. */
export interface GraphCarry {
  /** Replaced version. */
  version: number
  /** Its executed nodes. */
  nodes: GraphCarryNode[]
}

/** One run of the current version. */
export interface GraphRunView {
  /** Run id. */
  runId: GraphRunId
  /** Stop reason once the run stopped. */
  stopReason?: GraphStopReason
}

/** The task graph of the latest admitted version of one plan. */
export interface GraphTask {
  /** Plan id. */
  planId: GraphPlanId
  /** Admitted version. */
  version: number
  /** The admitted plan. */
  plan: GraphPlan
  /** Nodes that can run together, wave by wave. */
  waves: GraphNodeId[][]
  /** Nodes in plan order. */
  nodes: GraphTaskNode[]
  /** Executed results of the replaced version, or null for a first version. */
  carry: GraphCarry | null
  /** Runs of this version, oldest first. */
  runs: GraphRunView[]
}

/** `graph` projection state; a set `failure` is terminal. */
export interface GraphState {
  /** One task graph per admitted plan id, most recently admitted last. */
  graphs: GraphTask[]
  /** Why a graph event could not be folded. */
  failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Task graphs of admitted plans with runner state. */
    graph: GraphState
  }
}
