/**
 * Graph contract. Registers the `graph_audit` tool: it parses one
 * `dsh-graph/v1` plan, audits it deterministically against the deployment
 * (allowed and registered tools, subagent depth, run budget) and against the
 * plan's own history, records a `graph/plan` event when the input carries a
 * readable plan id, and returns every finding with its remedy. `enforce`
 * admits a version only when no finding has severity `reject`; `shadow`
 * admits every version and still reports its findings. The `graphPlans`
 * projection folds the records into versions, rejection memory, and the
 * latest admitted plan. The `routes` config maps node categories to a
 * provider and model; the routes a plan uses are recorded on its `graph/plan`
 * record, and the read-only `graph_capabilities` tool lists the routes, the
 * granted tools, and the delegation depth.
 * @module @deepseek-ai/dsh-experimental-graph-contract
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { auditPlan, routesFor } from './audit.ts'
import type { AuditEnvironment, AuditResult } from './audit.ts'
import { planSha } from './digest.ts'
import { graphPlansProjection, historyOf } from './projection.ts'
import { parsePlan } from './schema.ts'
import type { GraphNodeBudget, GraphPlanHistory, GraphPlansState, GraphRoute } from './types.ts'

export { auditPlan, cycleBody, planOrder, planWaves, reaches, REJECTION_RULES, rejection, routesFor, runsAsAgent, scopesOverlap } from './audit.ts'
export type { AuditEnvironment, AuditResult, RejectionRule } from './audit.ts'
export { canonicalJson, planSha } from './digest.ts'
export { applyGraphPlanEvent, emptyGraphPlans, graphPlansProjection, historyOf } from './projection.ts'
export { canReopen, canTransition, needSatisfied, NODE_TRANSITIONS, nodeFingerprints } from './run.ts'
export {
  edgeOutcomeSchema,
  GRAPH_FORMAT,
  graphEdgeRecordSchema,
  graphNodeId,
  graphNodeIdSchema,
  graphNodeRecordSchema,
  graphPlanId,
  graphPlanIdSchema,
  graphPlanRecordSchema,
  graphPlanSchema,
  graphPlansStateSchema,
  graphRunId,
  graphRunIdSchema,
  graphRunRecordSchema,
  jsonValueSchema,
  nodeBasisSchema,
  nodeKindSchema,
  nodeStatusSchema,
  normalizeWriteScope,
  parsePlan,
  recoveryStateSchema,
  rejectionSchema,
  routeSchema,
  sessionIdSchema,
  stopReasonSchema,
} from './schema.ts'
export type { ParsedPlan } from './schema.ts'
export type {
  GraphCheck,
  GraphContextScope,
  GraphCycleGuard,
  GraphEdge,
  GraphEdgeOutcome,
  GraphEdgeRecord,
  GraphEdgeRelation,
  GraphInputBinding,
  GraphLevel,
  GraphNode,
  GraphNodeBasis,
  GraphNodeBudget,
  GraphNodeCheck,
  GraphNodeId,
  GraphNodeKind,
  GraphNodeRecord,
  GraphNodeStatus,
  GraphPlan,
  GraphPlanHistory,
  GraphPlanId,
  GraphPlanRecord,
  GraphPlansState,
  GraphPlanVersion,
  GraphRecoveryState,
  GraphRejection,
  GraphRejectionCode,
  GraphRoute,
  GraphRunId,
  GraphRunRecord,
  GraphStopReason,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'graph-contract'
/** Services required by the plugin. */
export const inject = ['tools', 'sessionProjections']

/**
 * Plugin config. `assumption` is mandatory outside `off`: the sentence naming
 * what the audit assumes about the model, so a later model can retire it.
 */
export interface Config {
  /**
   * `off` registers nothing; `shadow` admits every version and reports findings; `enforce` admits only
   * versions without a `reject` finding. Default `shadow`.
   */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Global tools a graph node may declare; default none. */
  allowedTools?: string[]
  /** Tools a node may declare that run shell commands; the audit warns for each such declaration. Default none. */
  shellTools?: string[]
  /** Run limits per kind for one plan's worst case; 0 (default) is unlimited. */
  runBudget?: GraphNodeBudget
  /** Capability routes: a node's category selects the provider and model of its subagent. */
  routes?: GraphRouteConfig[]
  /** Highest `cycleGuard.maxIterations` a plan may declare (default 8). */
  maxCycleIterations?: number
}

/** One configured capability route. */
export interface GraphRouteConfig {
  /** Category a plan node declares; unique across routes. */
  category: string
  /** Provider that runs the node's subagent. */
  provider: string
  /** Model id that runs the node's subagent. */
  model: string
  /** Deployment reliability label (default `unverified`). */
  reliability?: 'verified' | 'unverified'
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  allowedTools: z.array(z.string()).default([]),
  shellTools: z.array(z.string()).default([]),
  runBudget: z.object({
    steps: z.number().default(0),
    tokens: z.number().default(0),
    wallMs: z.number().default(0),
  }).default({}),
  routes: z.array(z.object({
    category: z.string().required(),
    provider: z.string().required(),
    model: z.string().required(),
    reliability: z.union(['verified', 'unverified']).default('unverified'),
  })).default([]),
  maxCycleIterations: z.number().default(8),
})

/** Model-facing description of `graph_audit`. */
export const GRAPH_AUDIT_DESCRIPTION = [
  'Audit one dsh-graph/v1 plan before any of it runs. The audit is deterministic and runs nothing. It checks: acyclic needs with one declared edge and artifact per dependency; every node output consumed; from L2, an anchor with verify commands and a fresh verification node; at L3, a human_gate and a stop_handoff; disjoint write scopes for nodes that can run together; allowed tools; the run budget; fallbacks for inputs from nodes that may fail; delegation depth; and acceptance unchanged since the first version. It warns when a node declares a tool that can write files through a shell.',
  'Every call with a valid plan id records a new version of that plan. Fix every rejection it reports, then call again. Warnings do not block admission.',
  'Plan: format "dsh-graph/v1"; id (lower-case, stable across versions); level L1|L2|L3; goal; runInputs (names); nodes; edges; deliverable; acceptance (non-empty list, frozen after the first version).',
  'Node: id; kind execution|verification|anchor|human_gate|reducer|synthesis|stop_handoff; instruction; needs (node ids); inputs [{name, from: "run" or a needed node id, field, fallback?}]; output (object JSON Schema using only type, properties, required, additionalProperties, items, enum, const, oneOf, and annotations; every property declares a type; verification nodes require "verdict": {"type": "string", "enum": ["pass", "fail"]}); tools; writes (workspace-relative path prefixes); verify (shell commands, required for anchors); budget {steps?, tokens?, wallMs?} per attempt; retryBudget; contextScope execution-only|fresh-independent; mayFail; category (optional; one of the categories graph_capabilities lists).',
  'Edge: from; to; relation feeds|verifies|constrains|vetoes|anchors|hands_off; artifact (what crosses the edge); allowedFields (optional); cycleGuard (optional) {maxIterations, until, plateauAfter?, metricCommand?} marks a loop edge: relation feeds, from a node back to itself or to a node it depends on, not listed in needs. When from finishes, the loop runs again unless the until shell command exits 0, maxIterations is reached, or the metricCommand output stayed the same for plateauAfter decisions. Only the from node of a loop may feed nodes outside it.',
  'Status, basis, and version belong to the harness and are rejected inside a plan.',
].join('\n\n')

/** Model-facing description of `graph_capabilities`. */
export const GRAPH_CAPABILITIES_DESCRIPTION = 'List what graph nodes can use in this deployment: each node category with its provider, model, reliability label, and whether the model is available now; the tools a node may declare; and the current and maximum delegation depth. Use only these categories and tools in a dsh-graph/v1 plan.'

const CAPABILITIES_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    categories: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reliability: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
        },
      },
    },
    tools: { type: 'array', required: true, items: { type: 'string' } },
    depth: {
      type: 'object',
      additionalProperties: false,
      properties: { current: { type: 'integer', required: true }, max: { type: 'integer', required: true } },
    },
  },
} as const

/** Canonical value of one `graph_capabilities` call. */
export type GraphCapabilitiesValue = InferValue<typeof CAPABILITIES_VALUE_SCHEMA>

const REJECTION_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    check: { type: 'string', required: true },
    code: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['reject', 'warn'] },
    subject: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    remedy: { type: 'string', required: true },
  },
} as const

const VERSION_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', required: true },
    admitted: { type: 'boolean', required: true },
    codes: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const AUDIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    admitted: { type: 'boolean', required: true },
    mode: { type: 'string', required: true, enum: ['shadow', 'enforce'] },
    sha: { type: 'string', required: true },
    recorded: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planId: { type: 'string', required: true },
        version: { type: 'integer', required: true },
      },
    },
    repeatOf: { type: 'integer' },
    waves: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    previous: { type: 'array', required: true, items: VERSION_VALUE_SCHEMA },
    rejections: { type: 'array', required: true, items: REJECTION_VALUE_SCHEMA },
  },
} as const

/** Canonical value of one `graph_audit` call. */
export type GraphAuditValue = InferValue<typeof AUDIT_VALUE_SCHEMA>

/**
 * One earlier version as a summary fragment.
 * @param version - version summary.
 * @returns `v2 rejected (CYCLE, NOT_CONSUMED)`.
 */
function describeVersion(version: GraphAuditValue['previous'][number]): string {
  const codes = version.codes.length > 0 ? ` (${version.codes.join(', ')})` : ''
  return `v${version.version} ${version.admitted ? 'admitted' : 'rejected'}${codes}`
}

/**
 * One finding as a model-facing line.
 * @param entry - finding.
 * @returns `- [CODE] subject: detail. Remedy: remedy`.
 */
function describeRejection(entry: GraphAuditValue['rejections'][number]): string {
  return `- [${entry.code}] ${entry.subject}: ${entry.detail}. Remedy: ${entry.remedy}`
}

/**
 * Render the canonical audit value for the model.
 * @param value - audit value.
 * @returns the model-facing text.
 */
export function renderAudit(value: GraphAuditValue): string {
  const blocking = value.rejections.filter(entry => entry.severity === 'reject')
  const warnings = value.rejections.filter(entry => entry.severity === 'warn')
  let verdict = 'graph_audit: admitted'
  if (!value.admitted) verdict = value.mode === 'shadow' ? 'graph_audit: not admitted, because the plan does not parse; shadow mode admits only a parsed plan' : 'graph_audit: rejected'
  else if (blocking.length > 0) verdict = 'graph_audit: admitted in shadow mode; the rejections below are recorded, not enforced'
  const lines = [
    verdict,
    value.recorded === undefined
      ? 'plan: not recorded, because the input has no valid id'
      : `plan: ${value.recorded.planId} version ${value.recorded.version} sha ${value.sha.slice(0, 12)}`,
  ]
  if (value.repeatOf !== undefined) lines.push(`identical to version ${value.repeatOf}`)
  if (value.previous.length > 0) lines.push(`previous versions: ${value.previous.map(describeVersion).join('; ')}`)
  if (value.waves !== undefined) lines.push(`waves: ${value.waves.map(wave => `[${wave.join(', ')}]`).join(' ')}`)
  if (blocking.length > 0) lines.push(`rejections (${blocking.length}):`, ...blocking.map(describeRejection))
  if (warnings.length > 0) lines.push(`warnings (${warnings.length}):`, ...warnings.map(describeRejection))
  return lines.join('\n')
}

/**
 * The plan id shown on the pending card.
 * @param plan - raw `plan` argument.
 * @returns its id, or a fixed label when absent.
 */
function planLabel(plan: JsonValue): string {
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return 'plan without an id'
  const id = plan['id']
  return typeof id === 'string' ? id : 'plan without an id'
}

/**
 * Install the contract.
 * @param ctx - plugin context; the projection and the tool dispose with it.
 * @param config - validated {@link Config}; blank `assumption`, `run_code` in `allowedTools`, and non-integer or
 *   negative run limits fail the load.
 */
// Every loop and graph guard repeats this mode-narrowing and assumption check locally: each throws its own
// package-named message.
/* jscpd:ignore-start */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const configured = config.mode as 'off' | 'shadow' | 'enforce'
  if (configured === 'off') return
  const mode = configured
  if ((config.assumption as string).trim() === '') {
    throw new Error('graph-contract: `assumption` must name what the audit assumes about the model')
  }
  /* jscpd:ignore-end */
  const allowedTools = new Set(config.allowedTools as string[])
  if (allowedTools.has(RUN_CODE_NAME)) {
    throw new Error(`graph-contract: allowedTools cannot name ${RUN_CODE_NAME}; it is the PTC transport, not a node tool`)
  }
  const shellTools = new Set(config.shellTools as string[])
  if ([...shellTools].some(tool => tool.trim() === '')) throw new Error('graph-contract: shellTools entries must be non-blank')
  const runBudget = config.runBudget as Required<GraphNodeBudget>
  for (const kind of ['steps', 'tokens', 'wallMs'] as const) {
    const value = runBudget[kind]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`graph-contract: invalid runBudget.${kind} ${value} — must be an integer >= 0`)
    }
  }
  const maxCycleIterations = config.maxCycleIterations as number
  if (!Number.isSafeInteger(maxCycleIterations) || maxCycleIterations < 1) {
    throw new Error(`graph-contract: invalid maxCycleIterations ${maxCycleIterations} — must be an integer >= 1`)
  }

  const routes = new Map<string, GraphRoute>()
  // schemastery's .default() fills `reliability` on every route.
  for (const route of config.routes as GraphRoute[]) {
    if (route.category.trim() === '' || route.provider.trim() === '' || route.model.trim() === '') {
      throw new Error('graph-contract: every route needs a category, a provider, and a model')
    }
    if (routes.has(route.category)) throw new Error(`graph-contract: category ${route.category} is routed twice`)
    routes.set(route.category, { category: route.category, provider: route.provider, model: route.model, reliability: route.reliability })
  }

  ctx.sessionProjections.register(graphPlansProjection)

  function plansOf(session: Session): GraphPlansState {
    const state = ctx.sessionProjections.stateOf(session, 'graphPlans')
    /* v8 ignore next -- apply() registered the graphPlans unit before registering the tool that reads it. */
    if (state === undefined) throw new Error('graph-contract: the graphPlans projection is not registered')
    return state
  }

  function depthOf(agent: Agent): AuditEnvironment['depth'] {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return undefined
    const max = subagents.resolveMaxDepth()
    /* v8 ignore next -- resolveMaxDepth() without an argument returns the configured number; undefined answers only 'provider-managed'. */
    if (max === undefined) return undefined
    return { current: delegationDepthOf(agent), max }
  }

  function environment(agent: Agent, history: GraphPlanHistory | undefined): AuditEnvironment {
    return {
      allowedTools,
      shellTools,
      isRegisteredTool: tool => ctx.tools.get(tool) !== undefined,
      runBudget,
      depth: depthOf(agent),
      frozenAcceptance: history?.acceptance ?? undefined,
      routes,
      maxCycleIterations,
    }
  }

  function audit(agent: Agent, value: JsonValue): GraphAuditValue {
    const state = plansOf(agent.session)
    if (state.failure !== undefined) throw new Error(`graph_audit: the plan history of this session cannot be folded: ${state.failure}`)
    const parsed = parsePlan(value)
    const planId = parsed.ok ? parsed.plan.id : parsed.planId
    const history = planId === undefined ? undefined : historyOf(state, planId)
    const result: AuditResult = parsed.ok
      ? auditPlan(parsed.plan, environment(agent, history))
      : { rejections: parsed.rejections, order: undefined, waves: undefined }
    const sha = planSha(parsed.ok ? parsed.plan : value)
    // Shadow mode records findings without blocking, but only a parsed plan can be admitted.
    const admitted = parsed.ok && (mode === 'shadow' || result.rejections.every(entry => entry.severity !== 'reject'))
    const previous = history === undefined ? [] : history.versions
    const repeatOf = previous.findLast(version => version.sha === sha)?.version
    const version = previous.length + 1
    const used = parsed.ok ? routesFor(parsed.plan, routes) : []
    if (planId !== undefined) {
      agent.session.append('graph/plan', {
        planId,
        version,
        sha,
        mode,
        admitted,
        plan: parsed.ok ? parsed.plan : null,
        rejections: result.rejections,
        ...repeatOf === undefined ? {} : { repeatOf },
        ...used.length === 0 ? {} : { routes: used },
      })
    }
    return {
      admitted,
      mode,
      sha,
      ...planId === undefined ? {} : { recorded: { planId, version } },
      ...repeatOf === undefined ? {} : { repeatOf },
      ...result.waves === undefined ? {} : { waves: result.waves },
      previous: previous.map(entry => ({ version: entry.version, admitted: entry.admitted, codes: entry.codes })),
      rejections: result.rejections,
    }
  }

  ctx.tools.register(defineTool({
    name: 'graph_audit',
    description: GRAPH_AUDIT_DESCRIPTION,
    parameters: {
      plan: { type: 'json', required: true, description: 'One dsh-graph/v1 plan object.' },
    },
    output: {
      schema: AUDIT_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderAudit(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Audit graph plan', kind: 'other', rawInput: planLabel(args.plan) }),
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('graph_audit requires an owning agent session')
      return Promise.resolve(audit(agent, args.plan))
    },
  }))

  function available(route: GraphRoute): Promise<boolean> {
    const llm = ctx.get('llm')
    /* v8 ignore next -- every composition that runs agents mounts ctx.llm; the tool catalog boot never calls execute. */
    if (llm === undefined) return Promise.resolve(false)
    return llm.listModels(route.provider).then(models => models.some(model => model.id === route.model), () => false)
  }

  ctx.tools.register(defineTool({
    name: 'graph_capabilities',
    description: GRAPH_CAPABILITIES_DESCRIPTION,
    parameters: {},
    output: {
      schema: CAPABILITIES_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'List graph capabilities', kind: 'read' }),
    async execute(_args, exec): Promise<GraphCapabilitiesValue> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('graph_capabilities requires an owning agent session')
      const depth = depthOf(agent)
      return {
        categories: await Promise.all([...routes.values()].map(async route => ({ ...route, available: await available(route) }))),
        tools: [...allowedTools].filter(tool => ctx.tools.get(tool) !== undefined).sort(),
        ...depth === undefined ? {} : { depth },
      }
    },
  }))
}
