/**
 * Model-facing tools of the knowledge seam: `knowledge_query`,
 * `knowledge_read`, `knowledge_cite`, and, in `read-write` mode,
 * `knowledge_write`. A write always asks the user, cites the successful reads
 * of its sources in this session, and appends a `knowledge/write` record.
 * @module @deepseek-ai/dsh-experimental-tool-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DECLARED_RELATIONS, knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEntry, KnowledgeScope, KnowledgeWriteRecord } from '@deepseek-ai/dsh-experimental-knowledge'
import type {} from '@deepseek-ai/dsh-fs'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { applyEvidence, emptyEvidence, evidenceStateSchema } from './evidence.ts'
import type { EvidenceState } from './evidence.ts'

export { applyEvidence, emptyEvidence, evidenceStateSchema } from './evidence.ts'
export type { EvidenceState } from './evidence.ts'

/** Cordis plugin name. */
export const name = 'tool-knowledge'
/** Services the tools need. */
export const inject = ['knowledge', 'fs', 'tools', 'sessionProjections']

/** Tool settings. Invalid values fail plugin load. */
export interface Config {
  /** `read-only` registers the three read tools; `read-write` adds `knowledge_write`. Default `read-only`. */
  mode?: 'read-only' | 'read-write'
  /** Tools whose successful calls count as reads of their `file_path` or `path` argument (default `read`). */
  evidenceTools?: string[]
  /** Most hits one `knowledge_query` returns (default 10). */
  maxResults?: number
  /** Characters of page text one `knowledge_read` returns (default 20000). */
  maxPageChars?: number
  /** Largest `depth` of `knowledge_cite` (default 2). */
  maxDepth?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['read-only', 'read-write']).default('read-only'),
  evidenceTools: z.array(z.string()).default(['read']),
  maxResults: z.number().default(10),
  maxPageChars: z.number().default(20000),
  maxDepth: z.number().default(2),
})

/** Model-facing description of `knowledge_query`. */
export const KNOWLEDGE_QUERY_DESCRIPTION = 'Search the knowledge store of this workspace: durable pages about the project that earlier sessions and people recorded. Returns pages ranked by the share of query words they contain, with id, title, type, last update, and stale (a page it depends on changed after it or was superseded). Read a page with knowledge_read before relying on it.'

/** Model-facing description of `knowledge_read`. */
export const KNOWLEDGE_READ_DESCRIPTION = 'Read one knowledge page by id (for example concepts/retry.md), by id without .md, or by a file name that is unique in the store. Returns its title, type, last update, stale flag, declared relations, and Markdown text. Pages can be outdated: verify statements about code against the current files before asserting them.'

/** Model-facing description of `knowledge_cite`. */
export const KNOWLEDGE_CITE_DESCRIPTION = 'List the edges that start or end at one knowledge page, each with a stable edge id (e: and 8 hex digits) you can cite: body links (wikilink, mdlink), declared relations (derives-from, depends-on, implements, supports, contradicts, supersedes), and touches edges to workspace code paths the page names. Pass an edge id as ref to look up that one edge. depth from 1 also returns the pages within that many links.'

/**
 * Model-facing description of `knowledge_write`.
 * @param evidenceTools - configured evidence tools.
 * @returns the description naming them.
 */
export function knowledgeWriteDescription(evidenceTools: readonly string[]): string {
  return `Create or replace one knowledge page. id is a path such as concepts/retry.md inside one of the store's content directories. sources must list workspace files you read in this session with ${evidenceTools.join(' or ')}; the harness cites those reads in the page and refuses a page without them. relations may point only at existing pages. The user approves every write. Record durable facts about the project, not plans, progress, or temporary state of this session.`
}

const ENTRY_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  type: { type: 'string', required: true },
  updated: { type: 'string' },
  stale: { type: 'boolean', required: true },
} as const

const RELATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    relation: { type: 'string', required: true, enum: DECLARED_RELATIONS },
    to: { type: 'string', required: true },
  },
} as const

const QUERY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { ...ENTRY_PROPERTIES, score: { type: 'number', required: true } } } },
  },
} as const

const READ_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        ...ENTRY_PROPERTIES,
        relations: { type: 'array', required: true, items: RELATION_SCHEMA },
        content: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
      },
    },
  },
} as const

const CITE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    edges: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          eid: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          toKind: { type: 'string', required: true },
          relation: { type: 'string', required: true },
        },
      },
    },
    neighbors: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
} as const

const WRITE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    operation: { type: 'string', required: true },
    stale: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Canonical value of one `knowledge_cite` call. */
export type KnowledgeCiteValue = InferValue<typeof CITE_VALUE_SCHEMA>

/**
 * Fail unless a count setting is a positive integer.
 * @param field - config field name.
 * @param value - configured value.
 */
function requirePositive(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`tool-knowledge: ${field} must be a positive integer`)
}

/**
 * The `id` argument of a pending `knowledge_write`, for the approval prompt.
 * @param args - parsed arguments.
 * @returns the page id, or `(unnamed)`.
 */
function pageArgument(args: unknown): string {
  return typeof args === 'object' && args !== null && 'id' in args && typeof args.id === 'string' ? args.id : '(unnamed)'
}

/**
 * Scope of a tool call.
 * @param exec - the call.
 * @returns the calling session's working directory and the call's signal.
 */
function scopeOf(exec: Pick<ToolExecution, 'agent' | 'signal'>): KnowledgeScope {
  return { cwd: exec.agent?.session.header.cwd, signal: exec.signal }
}

/**
 * Register the evidence projection, the tools, and the approval listener.
 * @param ctx - plugin context; every registration disposes with it.
 * @param config - tool settings.
 * @throws when a setting is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode as 'read-only' | 'read-write'
  const evidenceTools = config.evidenceTools as string[]
  const maxResults = config.maxResults as number
  const maxPageChars = config.maxPageChars as number
  const maxDepth = config.maxDepth as number
  if (evidenceTools.length === 0) throw new Error('tool-knowledge: evidenceTools must name at least one tool')
  if (evidenceTools.some(tool => tool.trim() === '')) throw new Error('tool-knowledge: evidenceTools entries must be tool names')
  requirePositive('maxResults', maxResults)
  requirePositive('maxPageChars', maxPageChars)
  requirePositive('maxDepth', maxDepth)
  const evidence = new Set(evidenceTools)
  const evidenceList = evidenceTools.join(' or ')

  ctx.sessionProjections.register({
    key: 'knowledgeEvidence',
    stateVersion: 1,
    stateSchema: evidenceStateSchema,
    init: emptyEvidence,
    apply: (state, event) => applyEvidence(evidence, state, event),
  })

  function evidenceOf(session: Session): EvidenceState {
    const state = ctx.sessionProjections.stateOf(session, 'knowledgeEvidence')
    /* v8 ignore next -- apply() registered the unit before registering the tool that reads it */
    if (state === undefined) throw new Error('tool-knowledge: the knowledgeEvidence projection is not registered')
    return state
  }

  /**
   * Seqs of the latest successful reads of every source.
   * @param session - calling session.
   * @param sources - workspace files the page is based on.
   * @param cwd - calling session's working directory.
   * @param signal - the call's cancellation.
   * @returns sorted distinct seqs.
   * @throws when a source is missing or was not read successfully.
   */
  async function citedReads(
    session: Session,
    sources: readonly string[],
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<SessionSeq[]> {
    if (sources.length === 0) throw new Error(`knowledge_write: sources must list at least one workspace file you read in this session with ${evidenceList}`)
    const options = { ...cwd === undefined ? {} : { cwd }, signal }
    const readTargets = new Map<string, number>()
    for (const [path, seq] of Object.entries(evidenceOf(session).reads)) {
      const key = (await ctx.fs.resolve(path, options)).targetKey
      readTargets.set(key, Math.max(seq, readTargets.get(key) ?? seq))
    }
    const seqs = new Set<number>()
    for (const source of sources) {
      const seq = readTargets.get((await ctx.fs.resolve(source, options)).targetKey)
      if (seq === undefined) throw new Error(`knowledge_write: ${source} was not read successfully in this session; read it with ${evidenceList} first`)
      seqs.add(seq)
    }
    return [...seqs].sort((left, right) => left - right).map(seq => SessionSeq(seq))
  }

  ctx.tools.register(defineTool({
    name: 'knowledge_query',
    description: KNOWLEDGE_QUERY_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Words to search for.' },
      limit: { type: 'integer', description: `Most hits to return, 1 to ${maxResults} (default ${maxResults}).` },
    },
    output: { schema: QUERY_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Search knowledge: ${args.query}`, kind: 'search' }),
    async execute(args, exec): Promise<InferValue<typeof QUERY_VALUE_SCHEMA>> {
      const limit = args.limit ?? maxResults
      if (limit < 1 || limit > maxResults) throw new Error(`knowledge_query: limit must be between 1 and ${maxResults}`)
      return { hits: await ctx.knowledge.query(scopeOf(exec), args.query, limit) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_read',
    description: KNOWLEDGE_READ_DESCRIPTION,
    parameters: {
      ref: { type: 'string', required: true, description: 'Page id, id without .md, or a unique file name.' },
    },
    output: { schema: READ_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Read knowledge page ${args.ref}`, kind: 'read' }),
    async execute(args, exec): Promise<InferValue<typeof READ_VALUE_SCHEMA>> {
      const page = await ctx.knowledge.read(scopeOf(exec), args.ref)
      if (page === undefined) throw new Error(`knowledge_read: no readable knowledge page ${args.ref}; search with knowledge_query`)
      const truncated = page.content.length > maxPageChars
      return { page: { ...page, content: truncated ? page.content.slice(0, maxPageChars) : page.content, truncated } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_cite',
    description: KNOWLEDGE_CITE_DESCRIPTION,
    parameters: {
      ref: { type: 'string', required: true, description: 'Page reference, or an edge id such as e:1a2b3c4d.' },
      depth: { type: 'integer', description: `Link distance of neighbor pages to include, 0 to ${maxDepth} (default 0).` },
    },
    output: { schema: CITE_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Cite knowledge ${args.ref}`, kind: 'read' }),
    async execute(args, exec): Promise<KnowledgeCiteValue> {
      const depth = args.depth ?? 0
      if (depth < 0 || depth > maxDepth) throw new Error(`knowledge_cite: depth must be between 0 and ${maxDepth}`)
      const scope = scopeOf(exec)
      const edges = await ctx.knowledge.cite(scope, args.ref)
      const around = depth === 0 ? undefined : await ctx.knowledge.neighbors(scope, args.ref, depth)
      return { edges, ...around === undefined ? {} : { neighbors: around.levels } }
    },
  }))

  if (mode === 'read-only') return

  ctx.tools.register(defineTool({
    name: 'knowledge_write',
    description: knowledgeWriteDescription(evidenceTools),
    parameters: {
      id: { type: 'string', required: true, description: 'Page path such as concepts/retry.md.' },
      type: { type: 'string', required: true, description: 'One word such as concept, entity, source, or episode.' },
      title: { type: 'string', required: true, description: 'One-line title.' },
      body: { type: 'string', required: true, description: 'Markdown body; the harness adds frontmatter, the title heading, and the Origin section.' },
      relations: { type: 'array', items: RELATION_SCHEMA, description: 'Relations to existing pages.' },
      sources: { type: 'array', required: true, items: { type: 'string' }, description: `Workspace files you read with ${evidenceList} that the page is based on.` },
    },
    output: { schema: WRITE_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: `Write knowledge page ${args.id}`, kind: 'edit' }),
    async execute(args, exec): Promise<InferValue<typeof WRITE_VALUE_SCHEMA>> {
      const agent = exec.agent
      /* v8 ignore next -- knowledge_write always asks, and the tool registry denies an ask that has no owning agent */
      if (agent === undefined) throw new Error('knowledge_write requires an owning agent session')
      const scope = scopeOf(exec)
      const sourceEventSeqs = await citedReads(agent.session, args.sources, scope.cwd, exec.signal)
      const entry: KnowledgeEntry = {
        id: knowledgePageId(args.id),
        type: args.type,
        title: args.title,
        body: args.body,
        relations: (args.relations ?? []).map(relation => ({ relation: relation.relation, to: knowledgePageId(relation.to) })),
      }
      const result = await ctx.knowledge.write(scope, entry, { sessionId: agent.session.id, sourceEventSeqs, sources: args.sources, writer: 'tool' })
      const record: KnowledgeWriteRecord = result.kind === 'written'
        ? { id: entry.id, writer: 'tool', mode: 'enforce', applied: true, operation: result.operation, stale: result.stale, sourceEventSeqs, sources: [...args.sources] }
        : { id: entry.id, writer: 'tool', mode: 'enforce', applied: false, stale: [], sourceEventSeqs, sources: [...args.sources], refusal: { rule: result.rule, reason: result.reason } }
      agent.session.append('knowledge/write', record)
      if (result.kind === 'refused') throw new Error(`knowledge_write refused (${result.rule}): ${result.reason}`)
      return { id: result.id, operation: result.operation, stale: result.stale }
    },
  }))

  // Outermost, so an earlier listener's allow cannot skip the question.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (exec.name !== 'knowledge_write' || decision.kind !== 'allow') return decision
    const page = pageArgument(exec.arguments)
    return {
      kind: 'ask',
      reason: `knowledge_write changes the shared knowledge page ${page}`,
      displayReason: { en: `Write knowledge page ${page}`, zh: `写入知识页面 ${page}` },
    }
  }, { prepend: true })
}
