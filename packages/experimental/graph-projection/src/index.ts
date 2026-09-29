/**
 * Graph projection. Registers the `graph` projection (task graphs of admitted
 * `dsh-graph/v1` plans with the graph runner's recorded node states, runs, and
 * carried results) and the read-only `graph_query` tool over it. It writes
 * nothing to the session log.
 * @module @deepseek-ai/dsh-experimental-graph-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import { graphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { graphProjection, taskOf } from './projection.ts'
import type { GraphState, GraphTaskNode } from './types.ts'

export { applyGraphEvent, emptyGraph, graphProjection, graphStateSchema, taskOf } from './projection.ts'
export type { GraphCarry, GraphCarryNode, GraphNodeStatus, GraphRunView, GraphState, GraphTask, GraphTaskNode } from './types.ts'

/** Cordis plugin name. */
export const name = 'graph-projection'
/** Services required by the plugin. */
export const inject = ['tools', 'sessionProjections']

/** Model-facing description of `graph_query`. */
export const GRAPH_QUERY_DESCRIPTION = 'Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state), the waves of nodes that can run together, and its runs. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.'

const NODE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    needs: { type: 'array', required: true, items: { type: 'string' } },
    status: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    recoveryState: { type: 'string', required: true },
    basis: { type: 'string' },
    output: { type: 'json' },
    childSession: { type: 'string' },
    detail: { type: 'string' },
  },
} as const

const QUERY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', required: true },
          version: { type: 'integer', required: true },
          nodes: { type: 'integer', required: true },
          ready: { type: 'integer', required: true },
          executed: { type: 'integer', required: true },
        },
      },
    },
    graph: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planId: { type: 'string', required: true },
        version: { type: 'integer', required: true },
        waves: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
        nodes: { type: 'array', required: true, items: NODE_VALUE_SCHEMA },
        runs: {
          type: 'array',
          required: true,
          items: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', required: true }, stopReason: { type: 'string' } } },
        },
      },
    },
    node: NODE_VALUE_SCHEMA,
  },
} as const

/** Canonical value of one `graph_query` call. */
export type GraphQueryValue = InferValue<typeof QUERY_VALUE_SCHEMA>

/**
 * One node as the model sees it: without the internal revision and fingerprint.
 * @param node - projected node.
 * @param full - include output, child session, and reason.
 * @returns the node view.
 */
function nodeView(node: GraphTaskNode, full: boolean): NonNullable<GraphQueryValue['node']> {
  return {
    id: node.id,
    kind: node.kind,
    needs: node.needs,
    status: node.status,
    attempt: node.attempt,
    recoveryState: node.recoveryState,
    ...node.basis === undefined ? {} : { basis: node.basis },
    ...full && node.output !== undefined ? { output: node.output } : {},
    ...full && node.childSession !== undefined ? { childSession: node.childSession } : {},
    ...full && node.detail !== undefined ? { detail: node.detail } : {},
  }
}

/**
 * Install the projection and the query tool.
 * @param ctx - plugin context; both registrations dispose with it.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(graphProjection)

  function graphOf(session: Session): GraphState {
    const state = ctx.sessionProjections.stateOf(session, 'graph')
    /* v8 ignore next -- apply() registered the graph unit before registering the tool that reads it. */
    if (state === undefined) throw new Error('graph-projection: the graph projection is not registered')
    if (state.failure !== undefined) throw new Error(`graph_query: the task graphs of this session cannot be folded: ${state.failure}`)
    return state
  }

  ctx.tools.register(defineTool({
    name: 'graph_query',
    description: GRAPH_QUERY_DESCRIPTION,
    parameters: {
      scope: { type: 'string', required: true, enum: ['plans', 'plan', 'node'], description: 'plans lists admitted plans; plan returns one plan; node returns one node.' },
      plan_id: { type: 'string', description: 'Plan id; required for scope "plan" and "node".' },
      node_id: { type: 'string', description: 'Node id; required for scope "node".' },
    },
    output: {
      schema: QUERY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      if (args.scope === 'plans') return { card: 'generic', title: 'Query graph plans', kind: 'read' }
      const plan = args.plan_id ?? 'plan'
      return { card: 'generic', title: args.scope === 'node' ? `Query graph ${plan} node ${args.node_id ?? '?'}` : `Query graph ${plan}`, kind: 'read' }
    },
    execute(args, exec): Promise<GraphQueryValue> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('graph_query requires an owning agent session')
      const state = graphOf(agent.session)
      if (args.scope === 'plans') {
        return Promise.resolve({
          plans: state.graphs.map(task => ({
            planId: task.planId,
            version: task.version,
            nodes: task.nodes.length,
            ready: task.nodes.filter(node => node.status === 'ready').length,
            executed: task.nodes.filter(node => node.status === 'executed').length,
          })),
        })
      }
      if (args.scope === 'node' && (args.plan_id === undefined || args.node_id === undefined)) {
        throw new Error('graph_query: scope "node" requires plan_id and node_id')
      }
      if (args.plan_id === undefined) throw new Error('graph_query: scope "plan" requires plan_id')
      const task = taskOf(state, graphPlanId(args.plan_id))
      if (task === undefined) throw new Error(`graph_query: no admitted plan ${args.plan_id}; audit it with graph_audit first`)
      if (args.scope === 'plan') {
        return Promise.resolve({
          graph: {
            planId: task.planId,
            version: task.version,
            waves: task.waves,
            nodes: task.nodes.map(node => nodeView(node, false)),
            runs: task.runs,
          },
        })
      }
      const node = task.nodes.find(entry => entry.id === args.node_id)
      if (node === undefined) throw new Error(`graph_query: plan ${args.plan_id} has no node ${args.node_id}`)
      return Promise.resolve({ node: nodeView(node, true) })
    },
  }))
}
