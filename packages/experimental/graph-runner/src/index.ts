/**
 * Graph runner. Registers `graph_run`, which executes the latest admitted
 * version of one `dsh-graph/v1` plan inside the calling tool call and returns
 * the stop reason with every node's state. When a loop edge's from node
 * finishes, the runner decides the edge with its `until` command and reopens
 * the loop body on a fire. The plugin also checks every write
 * and edit made by a running node's subagent against the node's write scopes:
 * `enforce` refuses a write outside them, `shadow` only records it.
 * @module @deepseek-ai/dsh-experimental-graph-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { graphPlanId, graphRunId, historyOf, planOrder } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { GraphPlansState, GraphStopReason } from '@deepseek-ai/dsh-experimental-graph-contract'
import { taskOf } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { GraphState } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runGraph, STOP_DETAILS } from './runner.ts'
import type { RunSettings } from './runner.ts'
import { WriteScopes } from './write-scope.ts'

export { runGraph, STOP_DETAILS } from './runner.ts'
export type { RunApproval, RunNodeResult, RunOutcome, RunRequest, RunServices, RunSettings, RunShell, RunSubagents } from './runner.ts'
export { metricOf, plateaued, plateauOf, sentBack } from './cycle.ts'
export { INTERRUPTED_NOTE, LOOP_FEEDBACK_NOTE, nodePrompt } from './prompt.ts'
export type { PromptFeedback, PromptInput } from './prompt.ts'
export { WriteScopes, writeViolation } from './write-scope.ts'

/** Cordis plugin name. */
export const name = 'graph-runner'
/** Services required by the plugin. */
export const inject = ['tools', 'sessionProjections', 'subagents']

/** Plugin config. `assumption` is mandatory outside `off`. */
export interface Config {
  /** `off` registers nothing; `shadow` records writes outside a node's scopes; `enforce` refuses them. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Subagent provider for agent nodes; it must support `toolFilter` and `outputSchema`. Default `spawn`. */
  provider?: string
  /** Nodes running at once (default 2). */
  maxConcurrent?: number
  /** Agent-node dispatches per run; 0 (default) is unlimited. */
  maxDispatches?: number
  /** Wall time per run in milliseconds; 0 (default) is unlimited. */
  maxWallMs?: number
  /** Highest plan version that may run (default 8). */
  maxPlanVersions?: number
  /** Timeout per verify command in milliseconds (default 300000). */
  verifyTimeoutMs?: number
  /** Characters of command output kept per check (default 2000). */
  outputTailChars?: number
  /** Human gate timeout in milliseconds; 0 (default) waits until the run stops. */
  humanTimeoutMs?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  provider: z.string().default('spawn'),
  maxConcurrent: z.number().default(2),
  maxDispatches: z.number().default(0),
  maxWallMs: z.number().default(0),
  maxPlanVersions: z.number().default(8),
  verifyTimeoutMs: z.number().default(300_000),
  outputTailChars: z.number().default(2000),
  humanTimeoutMs: z.number().default(0),
})

/** Model-facing description of `graph_run`. */
export const GRAPH_RUN_DESCRIPTION = [
  'Run the latest admitted version of one dsh-graph/v1 plan and wait for it to stop. Each agent node runs as a fresh subagent that sees only its instruction, its inputs, and its declared tools, and returns its declared output. Anchors and verify commands run as shell commands; a human_gate asks the user.',
  'A node counts as executed only with proof: its verify commands passed, a verification node returned verdict "pass" for it, or the user granted its gate. A result without proof stays unverified. Failed nodes are retried up to their retryBudget. A loop edge runs its loop again when its from node finishes and its until command fails, at most maxIterations times; the reopened target sees the output the edge sends back.',
  'The result names the stop reason and every node\'s status. After NO_PROGRESS, fix the plan and audit a new version with graph_audit; unchanged finished nodes are carried over. After BUDGET, call graph_run again to continue.',
].join('\n\n')

const NODE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    status: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    iteration: { type: 'integer' },
    basis: { type: 'string' },
    output: { type: 'json' },
    detail: { type: 'string' },
  },
} as const

const RUN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', required: true },
    version: { type: 'integer' },
    runId: { type: 'string' },
    stopReason: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    nodes: { type: 'array', required: true, items: NODE_RESULT_SCHEMA },
  },
} as const

/** Canonical value of one `graph_run` call. */
export type GraphRunValue = InferValue<typeof RUN_VALUE_SCHEMA>

/**
 * Render the canonical run value for the model.
 * @param value - run value.
 * @returns the model-facing text.
 */
export function renderRun(value: GraphRunValue): string {
  const head = [`graph_run: ${value.stopReason}`, `plan ${value.planId}`]
  if (value.version !== undefined) head.push(`version ${value.version}`)
  if (value.runId !== undefined) head.push(`run ${value.runId}`)
  const lines = [head.join(' — '), value.detail]
  for (const node of value.nodes) {
    const basis = node.basis === undefined ? '' : ` (${node.basis})`
    const detail = node.detail === undefined ? '' : ` — ${node.detail}`
    const iteration = node.iteration === undefined ? '' : `, iteration ${node.iteration}`
    lines.push(`- ${node.id}: ${node.status}${basis}, attempt ${node.attempt}${iteration}${detail}`)
  }
  for (const node of value.nodes) {
    if ((node.kind === 'synthesis' || node.kind === 'stop_handoff') && node.output !== undefined) {
      lines.push(`result of ${node.id}: ${JSON.stringify(node.output)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Validate the run inputs a plan declares.
 * @param value - the raw `inputs` argument.
 * @param names - the plan's `runInputs`.
 * @returns the inputs by name.
 */
function runInputsOf(value: JsonValue | undefined, names: readonly string[]): Readonly<Record<string, JsonValue>> {
  const record = value ?? {}
  if (typeof record !== 'object' || Array.isArray(record)) throw new Error('graph_run: inputs must be an object of run inputs')
  const missing = names.filter(name => !Object.hasOwn(record, name))
  if (missing.length > 0) throw new Error(`graph_run: missing run inputs ${missing.join(', ')}`)
  return record
}

/**
 * Reject a count below its minimum.
 * @param field - config field named in the error.
 * @param value - validated number.
 * @param min - smallest accepted integer.
 */
function requireCount(field: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`graph-runner: invalid ${field} ${value} — must be an integer >= ${min}`)
  }
}

/**
 * Install the runner.
 * @param ctx - plugin context; the tool and the fs listeners dispose with it.
 * @param config - validated {@link Config}; a blank `assumption` or `provider` and out-of-range counts fail the load.
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
    throw new Error('graph-runner: `assumption` must name what the runner assumes about the model')
  }
  /* jscpd:ignore-end */
  const provider = config.provider as string
  if (provider.trim() === '') throw new Error('graph-runner: provider must name a subagent provider')
  const maxPlanVersions = config.maxPlanVersions as number
  requireCount('maxConcurrent', config.maxConcurrent as number, 1)
  requireCount('maxDispatches', config.maxDispatches as number, 0)
  requireCount('maxWallMs', config.maxWallMs as number, 0)
  requireCount('maxPlanVersions', maxPlanVersions, 1)
  requireCount('verifyTimeoutMs', config.verifyTimeoutMs as number, 1)
  requireCount('outputTailChars', config.outputTailChars as number, 1)
  requireCount('humanTimeoutMs', config.humanTimeoutMs as number, 0)
  const settings: RunSettings = {
    mode,
    provider,
    maxConcurrent: config.maxConcurrent as number,
    maxDispatches: config.maxDispatches as number,
    maxWallMs: config.maxWallMs as number,
    verifyTimeoutMs: config.verifyTimeoutMs as number,
    outputTailChars: config.outputTailChars as number,
    humanTimeoutMs: config.humanTimeoutMs as number,
  }
  const scopes = new WriteScopes()

  function enforceScope(target: FsTarget, actor: object | undefined): void {
    const violation = scopes.check(actor, target.displayPath)
    if (violation !== undefined && mode === 'enforce') throw new Error(`graph_run write scope: ${violation}`)
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    enforceScope(target, actor)
    return await next()
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    enforceScope(target, actor)
    return await next()
  }, { prepend: true })

  function plansOf(session: Session): GraphPlansState {
    const state = ctx.sessionProjections.stateOf(session, 'graphPlans')
    if (state === undefined) throw new Error('graph_run: mount @deepseek-ai/dsh-experimental-graph-contract; no plan history is registered')
    return state
  }

  function graphOf(session: Session): GraphState {
    const state = ctx.sessionProjections.stateOf(session, 'graph')
    if (state === undefined) throw new Error('graph_run: mount @deepseek-ai/dsh-experimental-graph-projection; no task graph is registered')
    return state
  }

  function refused(planId: string, stopReason: GraphStopReason, detail: string): GraphRunValue {
    return { planId, stopReason, detail: `${detail} ${STOP_DETAILS[stopReason]}`, nodes: [] }
  }

  ctx.tools.register(defineTool({
    name: 'graph_run',
    description: GRAPH_RUN_DESCRIPTION,
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Id of a plan with an admitted version.' },
      inputs: { type: 'json', description: 'Object with a value for every name in the plan\'s runInputs.' },
    },
    output: {
      schema: RUN_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
    },
    presentCall: args => ({ card: 'generic', title: `Run graph ${args.plan_id}`, kind: 'execute' }),
    async execute(args, exec): Promise<GraphRunValue> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('graph_run requires an owning agent session')
      const planId = graphPlanId(args.plan_id)
      const admitted = historyOf(plansOf(agent.session), planId)?.admitted ?? null
      if (admitted === null) return refused(args.plan_id, 'ADMISSION_REFUSED', `Plan ${args.plan_id} has no admitted version.`)
      if (admitted.version > maxPlanVersions) {
        return refused(args.plan_id, 'MAX_ROUNDS', `Version ${admitted.version} exceeds the limit of ${maxPlanVersions} plan versions.`)
      }
      if (planOrder(admitted.plan).cyclic.length > 0) {
        return refused(args.plan_id, 'ADMISSION_REFUSED', 'The admitted version cannot be ordered; it was admitted in shadow mode.')
      }
      const task = taskOf(graphOf(agent.session), planId)
      /* v8 ignore next -- the graph projection folds every admitted graph/plan that graphPlans folds, so the task exists. */
      if (task === undefined) throw new Error(`graph_run: no task graph for plan ${args.plan_id}`)
      const inputs = runInputsOf(args.inputs, admitted.plan.runInputs)
      const found = ctx.subagents.getProvider(provider)
      if (found === undefined) throw new Error(`graph_run: subagent provider ${provider} is not registered`)
      if (!found.capabilities.toolFilter || !found.capabilities.outputSchema) {
        throw new Error(`graph_run: subagent provider ${provider} cannot restrict tools and enforce an output schema`)
      }
      if (admitted.routes.length > 0 && !found.capabilities.agentOptions) {
        throw new Error(`graph_run: subagent provider ${provider} cannot choose a model for routed categories`)
      }
      const runId = graphRunId(randomUUID())
      const outcome = await runGraph(
        { subagents: ctx.subagents, shell: ctx.get('shell'), approval: ctx.get('approval'), scopes },
        settings,
        {
          agent, callId: exec.callId, signal: exec.signal, runId,
          plan: admitted.plan, version: admitted.version, task, inputs, routes: admitted.routes,
        },
      )
      const { stopReason, detail, nodes } = outcome
      return { planId: args.plan_id, version: admitted.version, runId, stopReason, detail, nodes }
    },
  }))
}
