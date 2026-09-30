/**
 * Pure types of the graph projection: the `graph` task-graph state folded
 * from admitted `graph/plan` versions and the runner's `graph/node`,
 * `graph/run`, and `graph/edge` records.
 * @module @deepseek-ai/dsh-experimental-graph-projection/types
 */

import type {
  GraphEdgeOutcome,
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
  /** Loop iteration; 0 before any cycle edge reopened the node. */
  iteration: number
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

/** Decision state of one cycle edge of the admitted version. */
export interface GraphEdgeView {
  /** Node the edge leaves. */
  from: GraphNodeId
  /** Node the loop restarts at. */
  to: GraphNodeId
  /** Fires so far in this version. */
  fireCount: number
  /** Iteration of `from` at the latest decision, or null before any decision. */
  decided: number | null
  /** Latest outcome. */
  outcome?: GraphEdgeOutcome
  /** Metric values of every decision that read one, oldest first. */
  metrics: string[]
  /** Output the latest decision sent back; set only by a fire. */
  output?: JsonValue
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
  /** Cycle edges of this version with their decisions, in declaration order. */
  edges: GraphEdgeView[]
}

/** `graph` projection state; a set `failure` is terminal. */
export interface GraphState {
  /** One task graph per admitted plan id, most recently admitted last. */
  graphs: GraphTask[]
  /** Why a graph event could not be folded. */
  failure?: string
}

/** Kind of record that mentions a claimed path or command. */
export type EvidenceLeafKind = 'tool-record' | 'observed' | 'absence'

/** One record of the current turn that mentions a path or command. */
export interface EvidenceLeaf {
  /** `tool-record`: a tool call argument; `observed`: a successful tool result; `absence`: a failed tool result. */
  kind: EvidenceLeafKind
  /** Seq of the `tool/call` or `tool/result` event. */
  seq: number
  /** Tool name. */
  tool: string
}

/**
 * One knowledge store entry that a claim names: a page (`target: 'page'`) or an
 * edge (`target: 'edge'`). Found by asking the mounted `knowledge` service when
 * a claim is judged; it is never part of the `graphEvidence` fold.
 */
export interface KnowledgeLeaf {
  /** Always `graph-edge`. */
  kind: 'graph-edge'
  /** Whether the claim names a store page or a store edge. */
  target: 'page' | 'edge'
  /** The page id or the `e:` edge id the store resolved. */
  ref: string
}

/** A record leaf of the turn, or a knowledge store leaf. */
export type CitedLeaf = EvidenceLeaf | KnowledgeLeaf

/** What a claim names: a file path, a shell command, or a knowledge edge id (`e:` and eight hex digits). */
export type EvidenceClaimKind = 'path' | 'command' | 'edge'

/** One claim with its record leaves and, when the knowledge service is mounted, its knowledge leaf. */
export interface CitedClaim {
  /** Path, command, or edge id. */
  kind: EvidenceClaimKind
  /** Normalized text. */
  text: string
  /** Record leaves in kind order, then at most one `graph-edge` leaf. */
  leaves: CitedLeaf[]
}

/** One path or command the current turn's records mention, with the latest leaf of each kind. */
export interface EvidenceMention {
  /** Normalized path or command. */
  text: string
  /** Latest leaf per kind, in kind order. */
  leaves: EvidenceLeaf[]
}

/** One path, command, or knowledge edge id an assistant message names; no leaf means parametric. */
export interface EvidenceClaim {
  /** Path, command, or edge id; edge ids never have record leaves. */
  kind: EvidenceClaimKind
  /** Normalized text. */
  text: string
  /** Records of the turn that mention it, latest per kind. */
  leaves: EvidenceLeaf[]
}

/** Claims of the latest assistant message. */
export interface EvidenceAnswer {
  /** Turn of the message. */
  turn: number
  /** Seq of the `assistant/message` event. */
  seq: number
  /** Claims in answer order. */
  claims: EvidenceClaim[]
}

/** `graphEvidence` projection state: the current turn's records and the claims of its latest assistant message. */
export interface EvidenceState {
  /** Turn the records belong to. */
  turn: number
  /** Tool calls of the turn, to name results. */
  calls: { callId: string; tool: string }[]
  /** Mentioned paths, sorted. */
  paths: EvidenceMention[]
  /** Mentioned commands, sorted. */
  commands: EvidenceMention[]
  /** Claims of the turn's latest assistant message, or null before one. */
  answer: EvidenceAnswer | null
}

/** One span that compaction replaced (`summary`) or shortened in place (`prune`). */
export interface HistorySpan {
  /** Seq of the `compaction/summary` or `compaction/prune` event; the span's id for history_read. */
  seq: number
  /** Which compaction produced it. */
  kind: 'summary' | 'prune'
  /** First shadowed surface seq. */
  start: number
  /** Last shadowed surface seq. */
  end: number
  /** Every shadowed surface seq, in surface order. */
  items: number[]
}

/** `graphHistory` projection state. */
export interface HistoryState {
  /** Spans in log order. */
  spans: HistorySpan[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Task graphs of admitted plans with runner state. */
    graph: GraphState
    /** Heuristic evidence of the current turn and the claims of its latest assistant message. */
    graphEvidence: EvidenceState
    /** Spans that compaction replaced or shortened, readable with history_read. */
    graphHistory: HistoryState
  }
}
