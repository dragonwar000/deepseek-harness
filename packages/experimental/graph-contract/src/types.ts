/**
 * Pure types of the graph contract: the `dsh-graph/v1` plan a model writes,
 * audit rejections, the `graph/plan` session-event declaration, and the
 * `graphPlans` projection state.
 * @module @deepseek-ai/dsh-experimental-graph-contract/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Model-chosen plan identity, stable across the versions of one plan. */
export type GraphPlanId = Branded<'GraphPlanId'>

/** Node identity, unique inside one plan; `run` is reserved for run inputs. */
export type GraphNodeId = Branded<'GraphNodeId'>

/** Playbook level: L2 adds anchor and verification duties, L3 adds human and handoff gates. */
export type GraphLevel = 'L1' | 'L2' | 'L3'

/** What a node is for. `anchor` and `human_gate` run no agent. */
export type GraphNodeKind = 'execution' | 'verification' | 'anchor' | 'human_gate' | 'reducer' | 'synthesis' | 'stop_handoff'

/** Why one node depends on another. */
export type GraphEdgeRelation = 'feeds' | 'verifies' | 'constrains' | 'vetoes' | 'anchors' | 'hands_off'

/** Context an agent node starts with. */
export type GraphContextScope = 'execution-only' | 'fresh-independent'

/** One named node input: a run input, or one output property of a needed node. */
export interface GraphInputBinding {
  /** Input name shown to the node. */
  name: string
  /** `run` for a run input, otherwise a node listed in `needs`. */
  from: 'run' | GraphNodeId
  /** Run input name, or an output property declared by the source node. */
  field: string
  /** Value used when the source node failed and declared `mayFail`. */
  fallback?: JsonValue
}

/** Worst-case spend of one attempt of an agent node; an absent field is unbounded. */
export interface GraphNodeBudget {
  /** Agent steps. */
  steps?: number
  /** Model tokens. */
  tokens?: number
  /** Wall-clock milliseconds. */
  wallMs?: number
}

/** One unit of work, as the model declares it. Harness-owned state lives in events, never here. */
export interface GraphNode {
  /** Unique node id. */
  id: GraphNodeId
  /** What the node is for. */
  kind: GraphNodeKind
  /** The whole brief the node's agent receives, besides its inputs. */
  instruction: string
  /** Nodes that must finish first; each needs one declared edge. */
  needs: GraphNodeId[]
  /** Named inputs. */
  inputs: GraphInputBinding[]
  /** Object-rooted JSON Schema of the node's structured result. */
  output: ObjectJsonSchema
  /** Global tools the node's agent may use. */
  tools: string[]
  /** Normalized workspace-relative path prefixes the node may modify. */
  writes: string[]
  /** Shell commands whose exit 0 proves the node; required for anchors. */
  verify: string[]
  /** Per-attempt worst-case spend. */
  budget: GraphNodeBudget
  /** Extra attempts allowed after a retryable failure. */
  retryBudget: number
  /** Context the node's agent starts with. */
  contextScope: GraphContextScope
  /** Whether the plan tolerates this node failing. */
  mayFail: boolean
  /** Capability category; the graph-contract `routes` config maps it to a provider and model. */
  category?: string
}

/** One dependency with the artifact that crosses it. */
export interface GraphEdge {
  /** Needed node. */
  from: GraphNodeId
  /** Needing node. */
  to: GraphNodeId
  /** Why `to` depends on `from`. */
  relation: GraphEdgeRelation
  /** What crosses the edge; blank is rejected by the audit. */
  artifact: string
  /** Output properties of `from` that `to` may read; absent means all. */
  allowedFields?: string[]
}

/** One `dsh-graph/v1` plan version. */
export interface GraphPlan {
  /** Always `dsh-graph/v1`. */
  format: 'dsh-graph/v1'
  /** Plan id, stable across versions. */
  id: GraphPlanId
  /** Playbook level. */
  level: GraphLevel
  /** What the plan achieves. */
  goal: string
  /** Names of values a run supplies to `from: 'run'` bindings. */
  runInputs: string[]
  /** Units of work. */
  nodes: GraphNode[]
  /** Dependencies with artifacts. */
  edges: GraphEdge[]
  /** Human-readable deliverable. */
  deliverable: string
  /** Human-readable acceptance criteria, frozen by the first parsed version. */
  acceptance: string[]
}

/** One configured capability route. */
export interface GraphRoute {
  /** Category a node declares. */
  category: string
  /** Provider route for the node's subagent. */
  provider: string
  /** Model id for the node's subagent. */
  model: string
  /** Deployment label; `unverified` until the deployment marks the route verified. */
  reliability: 'verified' | 'unverified'
}

/** Every audit rejection code. */
export type GraphRejectionCode =
  | 'SCHEMA_INVALID'
  | 'CYCLE'
  | 'ISOLATED_NODE'
  | 'NOT_CONSUMED'
  | 'MISSING_ANCHOR'
  | 'VERIFIER_NOT_FRESH'
  | 'VERDICT_UNDECLARED'
  | 'SYNTHESIS_BEFORE_VERIFY'
  | 'MISSING_HUMAN_GATE'
  | 'MISSING_STOP_HANDOFF'
  | 'WRITE_SCOPE_OVERLAP'
  | 'CAPABILITY_UNVERIFIED'
  | 'BUDGET_EXCEEDED'
  | 'INPUT_MAY_BE_ABSENT'
  | 'EDGE_WITHOUT_ARTIFACT'
  | 'DEPTH_EXCEEDED'
  | 'ACCEPTANCE_CHANGED'
  | 'LINEAR_PLAN'

/** Invariant family a rejection belongs to. */
export type GraphCheck =
  | 'schema'
  | 'structure'
  | 'closeness'
  | 'anchor'
  | 'freshness'
  | 'order'
  | 'gates'
  | 'writes'
  | 'capability'
  | 'budget'
  | 'inputs'
  | 'depth'
  | 'freeze'

/** One audit finding. `reject` blocks admission in `enforce` mode; `warn` never does. */
export interface GraphRejection {
  /** Invariant family. */
  check: GraphCheck
  /** Stable machine code. */
  code: GraphRejectionCode
  /** Whether the finding blocks admission. */
  severity: 'reject' | 'warn'
  /** What the finding is about: a node id, `from->to`, `node:tool`, a field path, or the plan id. */
  subject: string
  /** What is wrong. */
  detail: string
  /** Fixed, code-specific way to fix it. */
  remedy: string
}

/** The durable record of one `graph_audit` call whose input carried a readable plan id. */
export interface GraphPlanRecord {
  /** Plan id read from the input. */
  planId: GraphPlanId
  /** 1 + the number of earlier records with this plan id. */
  version: number
  /** Hex SHA-256 of the canonical JSON of the parsed plan, or of the raw input when parsing failed. */
  sha: string
  /** Plugin mode at audit time. */
  mode: 'shadow' | 'enforce'
  /** `shadow`: always true. `enforce`: true iff no rejection has severity `reject`. */
  admitted: boolean
  /** The normalized plan, or null when the input did not parse. */
  plan: GraphPlan | null
  /** Every finding, in report order. */
  rejections: GraphRejection[]
  /** The latest earlier version of this plan id with the same `sha`. */
  repeatOf?: number
  /** Routes of the categories the plan uses, as configured at audit time. */
  routes?: GraphRoute[]
}

/** One version in the plan history. */
export interface GraphPlanVersion {
  /** Version number. */
  version: number
  /** Digest of that version. */
  sha: string
  /** Mode at audit time. */
  mode: 'shadow' | 'enforce'
  /** Admission of that version. */
  admitted: boolean
  /** Codes of every finding of that version, in report order. */
  codes: GraphRejectionCode[]
}

/** Folded history of one plan id. */
export interface GraphPlanHistory {
  /** Plan id. */
  planId: GraphPlanId
  /** Every audited version, oldest first. */
  versions: GraphPlanVersion[]
  /** Acceptance of the first parsed version, or null before any version parsed. */
  acceptance: string[] | null
  /** The latest admitted version with its plan and recorded routes, or null. */
  admitted: { version: number; plan: GraphPlan; routes: GraphRoute[] } | null
}

/** `graphPlans` projection state. A set `failure` is terminal. */
export interface GraphPlansState {
  /** One history per plan id, in first-audit order. */
  plans: GraphPlanHistory[]
  /** Why a `graph/plan` event could not be folded. */
  failure?: string
}

/** Identity of one graph_run call. */
export type GraphRunId = Branded<'GraphRunId'>

/** Harness-owned node status; only the graph runner writes it. */
export type GraphNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_human'
  | 'executed'
  | 'unverified'
  | 'failed_retryable'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/** Why a node has its status. `executed` needs `predicate`, `verifier`, or `human`. */
export type GraphNodeBasis = 'predicate' | 'verifier' | 'agentReported' | 'human' | 'sessionExited'

/** Recovery rung a node reached: retried inside a run, or patched by a new plan version. */
export type GraphRecoveryState = 'pristine' | 'retried' | 'patched'

/** Why a graph run stopped. */
export type GraphStopReason = 'GOAL_MET' | 'NO_FURTHER_WORK' | 'MAX_ROUNDS' | 'NO_PROGRESS' | 'ADMISSION_REFUSED' | 'HUMAN_STOPPED' | 'BUDGET'

/** One verify command the runner ran for a node. */
export interface GraphNodeCheck {
  /** The command handed to the shell seam. */
  command: string
  /** Exit code, or null when the command did not run to an exit. */
  exitCode: number | null
  /** Whether the executor's deadline cut it short. */
  timedOut: boolean
  /** Tail of stdout and stderr. */
  outputTail: string
}

/** One node status change written by the graph runner. */
export interface GraphNodeRecord {
  /** Run that made the change. */
  runId: GraphRunId
  /** Plan id. */
  planId: GraphPlanId
  /** Admitted version the run executes. */
  version: number
  /** Node id. */
  nodeId: GraphNodeId
  /** New status. */
  status: GraphNodeStatus
  /** Why the node has this status, when the status carries a basis. */
  basis?: GraphNodeBasis
  /** Recovery rung. */
  recoveryState: GraphRecoveryState
  /** Dispatches of this node so far in this plan version. */
  attempt: number
  /** 1 + the number of earlier records for this plan, version, and node. */
  revision: number
  /** Node fingerprint: digest of the node and its needs' fingerprints. */
  fingerprint: string
  /** Child session of the attempt that produced this status. */
  childSession?: SessionId
  /** Structured output of the attempt. */
  output?: JsonValue
  /** Verify commands run for this status. */
  checks?: GraphNodeCheck[]
  /** Version whose executed result this record carries over. */
  carriedFrom?: number
  /** Writes outside the node's write scopes during the attempt. */
  violations?: string[]
  /** Human-readable reason. */
  detail?: string
}

/** Start or stop of one graph_run call. */
export interface GraphRunRecord {
  /** Run id. */
  runId: GraphRunId
  /** Plan id. */
  planId: GraphPlanId
  /** Admitted version. */
  version: number
  /** Start or stop. */
  phase: 'start' | 'stop'
  /** Runner mode. */
  mode: 'shadow' | 'enforce'
  /** Stop reason; set on `stop`. */
  stopReason?: GraphStopReason
  /** What the stop means for the caller. */
  detail?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One graph_audit result for a plan with a readable id. Log-only; never derived history. */
    'graph/plan': GraphPlanRecord
    /** One node status change by the graph runner. Log-only; never derived history. */
    'graph/node': GraphNodeRecord
    /** Start or stop of one graph run. Log-only; never derived history. */
    'graph/run': GraphRunRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Plan versions, rejection memory, and the latest admitted plan per plan id. */
    graphPlans: GraphPlansState
  }
}
