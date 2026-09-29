/**
 * Graph projection. Registers the `graph` projection (task graphs of admitted
 * `dsh-graph/v1` plans with the graph runner's recorded node states, runs,
 * carried results, and cycle-edge decisions), the `graphEvidence` projection
 * (paths and commands the current turn's tool records mention, and the claims
 * of its latest assistant message), and the read-only `graph_query` and
 * `graph_cite` tools. It writes nothing to the session log.
 * @module @deepseek-ai/dsh-experimental-graph-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { graphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { claimOf, leavesFor } from './evidence.ts'
import { CITE_TOOL, graphEvidenceProjection } from './evidence-projection.ts'
import { graphHistoryProjection, readSpan } from './history.ts'
import { graphProjection, taskOf } from './projection.ts'
import type { EvidenceState, GraphState, GraphTaskNode, HistorySpan, HistoryState } from './types.ts'

export { applyGraphEvent, emptyGraph, graphProjection, graphStateSchema, taskOf } from './projection.ts'
export { argumentStrings, claimOf, claimsOf, commandOf, leavesFor, pathMatches, pathOf, pathsIn, withMentions } from './evidence.ts'
export type { ClaimText } from './evidence.ts'
export { applyEvidenceEvent, CITE_TOOL, emptyEvidence, evidenceStateSchema, graphEvidenceProjection } from './evidence-projection.ts'
export type { EvidenceAnswer, EvidenceClaim, EvidenceLeaf, EvidenceLeafKind, EvidenceMention, EvidenceState } from './types.ts'
export { applyHistoryEvent, emptyHistory, graphHistoryProjection, historyStateSchema, readSpan, transcriptLine } from './history.ts'
export type { HistoryReader } from './history.ts'
export type { HistorySpan, HistoryState } from './types.ts'
export type { GraphCarry, GraphCarryNode, GraphEdgeView, GraphNodeStatus, GraphRunView, GraphState, GraphTask, GraphTaskNode } from './types.ts'

/** Cordis plugin name. */
export const name = 'graph-projection'
/** Services required by the plugin. */
export const inject = ['tools', 'sessionProjections']

/** Limits of history_read. */
export interface HistoryConfig {
  /** Characters of transcript per history_read page (default 8000). */
  maxChars?: number
  /** Spans a listing returns, newest first (default 20). */
  maxListed?: number
  /** Events after the target in one session query read; at most the query service's readWindowMax (default 50). */
  readWindow?: number
}

/** Plugin config. The package constrains nothing, so it has no mode or assumption. */
export interface Config {
  /** history_read limits. */
  history?: HistoryConfig
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  history: z.object({
    maxChars: z.number().default(8000),
    maxListed: z.number().default(20),
    readWindow: z.number().default(50),
  }).default({}),
})

/** Model-facing description of `graph_query`. */
export const GRAPH_QUERY_DESCRIPTION = 'Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state, loop iteration), the waves of nodes that can run together, its runs, and the fire count of each loop edge. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.'

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
    iteration: { type: 'integer' },
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
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { from: { type: 'string', required: true }, to: { type: 'string', required: true }, fireCount: { type: 'integer', required: true }, outcome: { type: 'string' } },
          },
        },
      },
    },
    node: NODE_VALUE_SCHEMA,
  },
} as const

/** Canonical value of one `graph_query` call. */
export type GraphQueryValue = InferValue<typeof QUERY_VALUE_SCHEMA>

/** Model-facing description of `graph_cite`. */
export const GRAPH_CITE_DESCRIPTION = 'Check which tool calls and tool results of the current turn mention a file path or a shell command you are about to name in your answer. Each supporting record is tool-record (a tool call argument names it), observed (a successful tool result names it), or absence (a failed tool result names it). A claim with no record is parametric: nothing in this turn shows it.'

const CITE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['path', 'command', 'unrecognized'] },
    turn: { type: 'integer', required: true },
    leaves: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { type: 'string', required: true }, seq: { type: 'integer', required: true }, tool: { type: 'string', required: true } },
      },
    },
  },
} as const

/** Canonical value of one `graph_cite` call. */
export type GraphCiteValue = InferValue<typeof CITE_VALUE_SCHEMA>

/**
 * Render one citation for the model.
 * @param value - citation value.
 * @returns the model-facing text.
 */
export function renderCite(value: GraphCiteValue): string {
  if (value.kind === 'unrecognized') return `graph_cite: ${JSON.stringify(value.claim)} is neither a file path nor a shell command; cite one path or one command.`
  if (value.leaves.length === 0) return `graph_cite: ${value.kind} ${value.claim} is parametric: no tool call or tool result in turn ${value.turn} mentions it.`
  return [
    `graph_cite: ${value.kind} ${value.claim} is supported in turn ${value.turn} by:`,
    ...value.leaves.map(leaf => `- ${leaf.kind}: ${leaf.tool} (#${leaf.seq})`),
  ].join('\n')
}

/** Model-facing description of `history_read`. */
export const HISTORY_READ_DESCRIPTION = 'Read back conversation that compaction replaced or shortened in your context. Without seq, list the compacted spans of this session, newest first: each has a seq, a kind (summary: a span replaced by a checkpoint; prune: a tool result shortened in place), its first and last event number, and its item count. With seq from that list, return the span as a transcript starting at offset; a page that stops early names the next offset. The transcript arrives as this tool result; nothing earlier in your context changes.'

const SPAN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    kind: { type: 'string', required: true },
    start: { type: 'integer', required: true },
    end: { type: 'integer', required: true },
    items: { type: 'integer', required: true },
  },
} as const

const HISTORY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    spans: { type: 'array', items: SPAN_VALUE_SCHEMA },
    total: { type: 'integer' },
    span: SPAN_VALUE_SCHEMA,
    offset: { type: 'integer' },
    transcript: { type: 'string' },
    nextOffset: { type: 'integer' },
  },
} as const

/** Canonical value of one `history_read` call. */
export type HistoryReadValue = InferValue<typeof HISTORY_VALUE_SCHEMA>

/**
 * One span as the model sees it.
 * @param span - projected span.
 * @returns the span with its item count.
 */
function spanView(span: HistorySpan): NonNullable<HistoryReadValue['span']> {
  return { seq: span.seq, kind: span.kind, start: span.start, end: span.end, items: span.items.length }
}

/**
 * Render one history_read value for the model.
 * @param value - a listing or a page.
 * @returns the model-facing text.
 */
export function renderHistory(value: HistoryReadValue): string {
  if (value.spans !== undefined) {
    if (value.spans.length === 0) return 'history_read: nothing in this session was compacted.'
    return [
      `history_read: ${value.spans.length} of ${String(value.total)} compacted spans, newest first:`,
      ...value.spans.map(span => `- seq ${span.seq}: ${span.kind}, events #${span.start}-#${span.end}, ${span.items} items`),
    ].join('\n')
  }
  /* v8 ignore next -- execute returns span, offset, and transcript together whenever it returns no listing. */
  if (value.span === undefined || value.offset === undefined || value.transcript === undefined) return 'history_read: empty page'
  const last = value.nextOffset ?? value.span.items
  const lines = [`history_read: span seq ${value.span.seq} (${value.span.kind}), items ${value.offset + 1}-${last} of ${value.span.items}:`, value.transcript]
  if (value.nextOffset !== undefined) lines.push(`More: call history_read with seq ${value.span.seq} and offset ${value.nextOffset}.`)
  return lines.join('\n')
}

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
    ...node.iteration > 0 ? { iteration: node.iteration } : {},
    ...node.basis === undefined ? {} : { basis: node.basis },
    ...full && node.output !== undefined ? { output: node.output } : {},
    ...full && node.childSession !== undefined ? { childSession: node.childSession } : {},
    ...full && node.detail !== undefined ? { detail: node.detail } : {},
  }
}

/**
 * Install the projections and the read-only tools.
 * @param ctx - plugin context; every registration disposes with it.
 * @param config - validated {@link Config}; a history limit that is not an integer >= 1 fails the load.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees every history field after validation.
  const history = config.history as Required<HistoryConfig>
  for (const field of ['maxChars', 'maxListed', 'readWindow'] as const) {
    const value = history[field]
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`graph-projection: invalid history.${field} ${value} — must be an integer >= 1`)
  }
  ctx.sessionProjections.register(graphProjection)
  ctx.sessionProjections.register(graphEvidenceProjection)
  ctx.sessionProjections.register(graphHistoryProjection)

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
            ...task.edges.length === 0 ? {} : {
              edges: task.edges.map(edge => ({
                from: edge.from,
                to: edge.to,
                fireCount: edge.fireCount,
                ...edge.outcome === undefined ? {} : { outcome: edge.outcome },
              })),
            },
          },
        })
      }
      const node = task.nodes.find(entry => entry.id === args.node_id)
      if (node === undefined) throw new Error(`graph_query: plan ${args.plan_id} has no node ${args.node_id}`)
      return Promise.resolve({ node: nodeView(node, true) })
    },
  }))
  function evidenceOf(session: Session): EvidenceState {
    const state = ctx.sessionProjections.stateOf(session, 'graphEvidence')
    /* v8 ignore next -- apply() registered the graphEvidence unit before registering the tool that reads it. */
    if (state === undefined) throw new Error('graph-projection: the graphEvidence projection is not registered')
    return state
  }

  ctx.tools.register(defineTool({
    name: CITE_TOOL,
    description: GRAPH_CITE_DESCRIPTION,
    parameters: {
      claim: { type: 'string', required: true, description: 'One file path or one shell command from your answer.' },
    },
    output: {
      schema: CITE_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderCite(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Cite ${args.claim}`, kind: 'read' }),
    execute(args, exec): Promise<GraphCiteValue> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('graph_cite requires an owning agent session')
      const state = evidenceOf(agent.session)
      const claim = claimOf(args.claim)
      if (claim === undefined) return Promise.resolve({ claim: args.claim, kind: 'unrecognized', turn: state.turn, leaves: [] })
      const leaves = leavesFor(claim, state.paths, state.commands)
      return Promise.resolve({ claim: claim.text, kind: claim.kind, turn: state.turn, leaves })
    },
  }))
  function historyOf(session: Session): HistoryState {
    const state = ctx.sessionProjections.stateOf(session, 'graphHistory')
    /* v8 ignore next -- apply() registered the graphHistory unit before registering the tool that reads it. */
    if (state === undefined) throw new Error('graph-projection: the graphHistory projection is not registered')
    return state
  }

  ctx.tools.register(defineTool({
    name: 'history_read',
    description: HISTORY_READ_DESCRIPTION,
    parameters: {
      seq: { type: 'integer', description: 'Seq of a compacted span from the listing; omit to list spans.' },
      offset: { type: 'integer', description: 'Item to start at inside the span; default 0.' },
    },
    output: {
      schema: HISTORY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderHistory(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: args.seq === undefined ? 'List compacted history' : `Read compacted history ${args.seq}`, kind: 'read' }),
    async execute(args, exec): Promise<HistoryReadValue> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('history_read requires an owning agent session')
      const spans = historyOf(agent.session).spans
      if (args.seq === undefined) return { spans: spans.slice(-history.maxListed).reverse().map(spanView), total: spans.length }
      const span = spans.find(entry => entry.seq === args.seq)
      if (span === undefined) throw new Error(`history_read: no compacted span has seq ${args.seq}; call history_read without seq to list them`)
      const offset = args.offset ?? 0
      if (offset < 0 || offset >= span.items.length) throw new Error(`history_read: offset ${offset} is outside the span's ${span.items.length} items`)
      const reader = ctx.get('sessionQuery')
      if (reader === undefined) throw new Error('history_read: mount @deepseek-ai/dsh-session-query-sqlite; no session query service is available')
      const page = await readSpan(reader, agent.session.id, span, offset, history, exec.signal)
      const next = page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }
      return { span: spanView(span), offset, transcript: page.transcript, ...next }
    },
  }))
}
