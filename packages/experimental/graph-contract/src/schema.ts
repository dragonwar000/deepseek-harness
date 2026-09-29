/**
 * Zod schemas for `dsh-graph/v1` plans, audit findings, `graph/plan` records,
 * and `graphPlans` state; the one parser of model-written plans.
 * @module @deepseek-ai/dsh-experimental-graph-contract/schema
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertObjectJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { REJECTION_RULES, rejection } from './audit.ts'
import type {
  GraphCheck,
  GraphContextScope,
  GraphEdgeRecord,
  GraphEdgeRelation,
  GraphLevel,
  GraphNodeBasis,
  GraphNodeId,
  GraphNodeKind,
  GraphNodeRecord,
  GraphNodeStatus,
  GraphPlan,
  GraphPlanId,
  GraphPlanRecord,
  GraphPlansState,
  GraphRecoveryState,
  GraphRejection,
  GraphRunId,
  GraphRunRecord,
  GraphStopReason,
} from './types.ts'

/** The only plan format this package reads. */
export const GRAPH_FORMAT = 'dsh-graph/v1'

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u

const NODE_KINDS: Record<GraphNodeKind, true> = {
  execution: true, verification: true, anchor: true, human_gate: true, reducer: true, synthesis: true, stop_handoff: true,
}
const EDGE_RELATIONS: Record<GraphEdgeRelation, true> = {
  feeds: true, verifies: true, constrains: true, vetoes: true, anchors: true, hands_off: true,
}
const LEVELS: Record<GraphLevel, true> = { L1: true, L2: true, L3: true }
const CONTEXT_SCOPES: Record<GraphContextScope, true> = { 'execution-only': true, 'fresh-independent': true }
const CHECKS: Record<GraphCheck, true> = {
  schema: true, structure: true, closeness: true, anchor: true, freshness: true, order: true, gates: true,
  writes: true, capability: true, budget: true, inputs: true, depth: true, freeze: true,
}

/** An empty closed object: the output of a node that reports nothing structured. */
const EMPTY_OUTPUT: ObjectJsonSchema = { type: 'object', properties: {}, additionalProperties: false }

/**
 * The keys of a completeness map as a zod enum tuple.
 * @param map - one entry per union member.
 * @returns the keys, in declaration order.
 */
function keysOf<K extends string>(map: Readonly<Record<K, unknown>>): [K, ...K[]] {
  return Object.keys(map) as [K, ...K[]]
}

/**
 * Brand a validated plan id.
 * @param value - text matching the id pattern.
 * @returns the branded id.
 */
export function graphPlanId(value: string): GraphPlanId {
  return brandString<GraphPlanId>(value)
}

/**
 * Brand a validated node id.
 * @param value - text matching the id pattern, other than `run`.
 * @returns the branded id.
 */
export function graphNodeId(value: string): GraphNodeId {
  return brandString<GraphNodeId>(value)
}

/**
 * Normalize one write scope the way Agent Teams normalizes task write scopes.
 * @param value - a workspace-relative path prefix as written.
 * @returns the normalized prefix, or undefined for an empty, absolute, drive, or dot-segment path.
 */
export function normalizeWriteScope(value: string): string | undefined {
  const scope = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (scope === '' || scope.startsWith('/') || /^[A-Za-z]:/u.test(scope)) return undefined
  if (scope.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return scope
}

/**
 * Why a value is not an object-rooted JSON Schema in the dsh-tools subset.
 * @param value - candidate node output schema.
 * @returns each violation with its path rooted at `output`, or none when `assertObjectJsonSchema` accepts it.
 */
function outputSchemaViolations(value: unknown): string[] {
  try {
    assertObjectJsonSchema(value)
  } catch (error) {
    /* v8 ignore next -- assertObjectJsonSchema reports every violation as JsonSchemaError; any other throw is a defect and propagates. */
    if (!(error instanceof JsonSchemaError)) throw error
    return error.violations.map(violation => violation.replace(/^schema/u, 'output'))
  }
  return []
}

const unique = (items: readonly unknown[]): boolean => new Set(items).size === items.length
const idText = z.string().regex(ID_PATTERN, 'must start with a lower-case letter and use only a-z, 0-9, "-" and "_", at most 64 characters')
const text = z.string().refine(value => value.trim() !== '', 'must not be blank')
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const nonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const jsonValue = z.json() as z.ZodType<JsonValue>

/** Plan id schema. */
export const graphPlanIdSchema = idText.transform(graphPlanId)
/** Node id schema; `run` is reserved. */
export const graphNodeIdSchema = idText.refine(value => value !== 'run', 'node id "run" is reserved for run inputs').transform(graphNodeId)
/** Node kind schema. */
export const nodeKindSchema = z.enum(keysOf(NODE_KINDS))

const writeScope = z.string().transform((value, ctx) => {
  const scope = normalizeWriteScope(value)
  if (scope === undefined) {
    ctx.addIssue('must be a workspace-relative path prefix without empty, "." or ".." segments')
    return z.NEVER
  }
  return scope
})

const outputSchema = z.custom<ObjectJsonSchema>().superRefine((value, ctx) => {
  for (const violation of outputSchemaViolations(value)) ctx.addIssue(`unsupported output schema: ${violation}`)
})

const bindingSchema = z.object({
  name: text,
  from: z.union([z.literal('run'), graphNodeIdSchema]),
  field: text,
  fallback: jsonValue.optional(),
}).strict()

const nodeSchema = z.object({
  id: graphNodeIdSchema,
  kind: nodeKindSchema,
  instruction: text,
  needs: z.array(graphNodeIdSchema).refine(unique, 'must not repeat a node').default([]),
  inputs: z.array(bindingSchema).refine(bindings => unique(bindings.map(binding => binding.name)), 'input names must be unique').default([]),
  output: outputSchema.default(EMPTY_OUTPUT),
  tools: z.array(text).refine(unique, 'must not repeat a tool').default([]),
  writes: z.array(writeScope).default([]),
  verify: z.array(text).default([]),
  budget: z.object({ steps: positiveInt.optional(), tokens: positiveInt.optional(), wallMs: positiveInt.optional() }).strict().default({}),
  retryBudget: nonNegativeInt.default(0),
  contextScope: z.enum(keysOf(CONTEXT_SCOPES)).default('execution-only'),
  mayFail: z.boolean().default(false),
  category: text.optional(),
}).strict()

const cycleGuardSchema = z.object({
  maxIterations: positiveInt,
  until: text,
  plateauAfter: positiveInt.optional(),
  metricCommand: text.optional(),
}).strict().refine(guard => (guard.plateauAfter === undefined) === (guard.metricCommand === undefined), 'plateauAfter and metricCommand must be set together')

const edgeSchema = z.object({
  from: graphNodeIdSchema,
  to: graphNodeIdSchema,
  relation: z.enum(keysOf(EDGE_RELATIONS)),
  artifact: z.string(),
  allowedFields: z.array(text).optional(),
  cycleGuard: cycleGuardSchema.optional(),
}).strict()

/** One capability route. */
export const routeSchema = z.object({
  category: text,
  provider: text,
  model: text,
  reliability: z.enum(['verified', 'unverified']),
}).strict()

/** Normalized `dsh-graph/v1` plan schema; unknown keys, including harness-owned fields, are rejected. */
export const graphPlanSchema = z.object({
  format: z.literal(GRAPH_FORMAT),
  id: graphPlanIdSchema,
  level: z.enum(keysOf(LEVELS)),
  goal: text,
  runInputs: z.array(text).refine(unique, 'must not repeat a run input').default([]),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  deliverable: text,
  acceptance: z.array(text).min(1),
}).strict() as z.ZodType<GraphPlan>

/** One audit finding. */
export const rejectionSchema = z.object({
  check: z.enum(keysOf(CHECKS)),
  code: z.enum(keysOf(REJECTION_RULES)),
  severity: z.enum(['reject', 'warn']),
  subject: z.string(),
  detail: z.string(),
  remedy: z.string(),
}).strict() as z.ZodType<GraphRejection>

/** `graph/plan` payload schema, used to decode durable events. */
export const graphPlanRecordSchema = z.object({
  planId: graphPlanIdSchema,
  version: positiveInt,
  sha: z.string().regex(/^[0-9a-f]{64}$/u),
  mode: z.enum(['shadow', 'enforce']),
  admitted: z.boolean(),
  plan: graphPlanSchema.nullable(),
  rejections: z.array(rejectionSchema),
  repeatOf: positiveInt.optional(),
  routes: z.array(routeSchema).optional(),
}).strict() as z.ZodType<GraphPlanRecord>

/** `graphPlans` projection state schema. */
export const graphPlansStateSchema = z.object({
  plans: z.array(z.object({
    planId: graphPlanIdSchema,
    versions: z.array(z.object({
      version: positiveInt,
      sha: z.string(),
      mode: z.enum(['shadow', 'enforce']),
      admitted: z.boolean(),
      codes: z.array(z.enum(keysOf(REJECTION_RULES))),
    }).strict()),
    acceptance: z.array(z.string()).nullable(),
    admitted: z.object({ version: positiveInt, plan: graphPlanSchema, routes: z.array(routeSchema) }).strict().nullable(),
  }).strict()),
  failure: z.string().optional(),
}).strict() as z.ZodType<GraphPlansState>

/** Parse outcome: a normalized plan, or `SCHEMA_INVALID` findings with the plan id when one is readable. */
export type ParsedPlan =
  | { readonly ok: true; readonly plan: GraphPlan }
  | { readonly ok: false; readonly planId: GraphPlanId | undefined; readonly rejections: GraphRejection[] }

/**
 * Render a zod issue path in the `plan.nodes[0].id` form.
 * @param path - issue path.
 * @returns the dotted subject.
 */
function subjectOf(path: readonly PropertyKey[]): string {
  return `plan${path.map(key => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('')}`
}

/**
 * Read a valid plan id from input that failed to parse.
 * @param value - the raw input.
 * @returns the id, or undefined when absent or invalid.
 */
function readPlanId(value: unknown): GraphPlanId | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined
  const id = graphPlanIdSchema.safeParse(value.id)
  return id.success ? id.data : undefined
}

/**
 * Parse one model-written plan.
 * @param value - the raw `plan` tool argument.
 * @returns the normalized plan, or one `SCHEMA_INVALID` finding per zod issue.
 */
export function parsePlan(value: unknown): ParsedPlan {
  const parsed = graphPlanSchema.safeParse(value)
  if (parsed.success) return { ok: true, plan: parsed.data }
  return {
    ok: false,
    planId: readPlanId(value),
    rejections: parsed.error.issues.map(issue => rejection('SCHEMA_INVALID', subjectOf(issue.path), issue.message)),
  }
}

const NODE_STATUSES: Record<GraphNodeStatus, true> = {
  pending: true, ready: true, running: true, waiting_human: true, executed: true,
  unverified: true, failed_retryable: true, failed: true, cancelled: true, skipped: true,
}
const NODE_BASES: Record<GraphNodeBasis, true> = { predicate: true, verifier: true, agentReported: true, human: true, sessionExited: true }
const RECOVERY_STATES: Record<GraphRecoveryState, true> = { pristine: true, retried: true, patched: true }
const STOP_REASONS: Record<GraphStopReason, true> = {
  GOAL_MET: true, NO_FURTHER_WORK: true, MAX_ROUNDS: true, NO_PROGRESS: true, ADMISSION_REFUSED: true, HUMAN_STOPPED: true, BUDGET: true,
}

/**
 * Brand a run id.
 * @param value - opaque run id text.
 * @returns the branded id.
 */
export function graphRunId(value: string): GraphRunId {
  return brandString<GraphRunId>(value)
}

/** Run id schema. */
export const graphRunIdSchema = z.string().min(1).transform(graphRunId)
/** Node status schema. */
export const nodeStatusSchema = z.enum(keysOf(NODE_STATUSES))
/** Node basis schema. */
export const nodeBasisSchema = z.enum(keysOf(NODE_BASES))
/** Recovery state schema. */
export const recoveryStateSchema = z.enum(keysOf(RECOVERY_STATES))
/** Stop reason schema. */
export const stopReasonSchema = z.enum(keysOf(STOP_REASONS))
/** Session id schema for recorded child sessions. */
export const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
/** Lossless JSON value schema. */
export const jsonValueSchema = jsonValue

const checkSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  outputTail: z.string(),
}).strict()

/** `graph/node` payload schema. */
export const graphNodeRecordSchema = z.object({
  runId: graphRunIdSchema,
  planId: graphPlanIdSchema,
  version: positiveInt,
  nodeId: graphNodeIdSchema,
  status: nodeStatusSchema,
  basis: nodeBasisSchema.optional(),
  recoveryState: recoveryStateSchema,
  attempt: nonNegativeInt,
  revision: positiveInt,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  iteration: nonNegativeInt.optional(),
  childSession: sessionIdSchema.optional(),
  output: jsonValue.optional(),
  checks: z.array(checkSchema).optional(),
  carriedFrom: positiveInt.optional(),
  violations: z.array(z.string()).optional(),
  detail: z.string().optional(),
}).strict() as z.ZodType<GraphNodeRecord>

/** `graph/run` payload schema. */
export const graphRunRecordSchema = z.object({
  runId: graphRunIdSchema,
  planId: graphPlanIdSchema,
  version: positiveInt,
  phase: z.enum(['start', 'stop']),
  mode: z.enum(['shadow', 'enforce']),
  stopReason: stopReasonSchema.optional(),
  detail: z.string().optional(),
}).strict() as z.ZodType<GraphRunRecord>

/** Cycle-edge outcome schema. */
export const edgeOutcomeSchema = z.enum(['fired', 'until-met', 'exhausted', 'plateau'])

/** `graph/edge` payload schema. */
export const graphEdgeRecordSchema = z.object({
  runId: graphRunIdSchema,
  planId: graphPlanIdSchema,
  version: positiveInt,
  from: graphNodeIdSchema,
  to: graphNodeIdSchema,
  iteration: nonNegativeInt,
  fireCount: nonNegativeInt,
  outcome: edgeOutcomeSchema,
  checks: z.array(checkSchema),
  metric: z.string().optional(),
  output: jsonValue.optional(),
}).strict() as z.ZodType<GraphEdgeRecord>
