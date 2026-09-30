/**
 * Episode distillation into the knowledge store. When a turn stops and the
 * verifier gate recorded verdict `ok` for its final response, the plugin writes
 * one `episode` page through `ctx.knowledge.write`: the human request, the
 * final response without statements marked temporary, the files the turn
 * changed, and the verdict, citing the changing tool results. With a positive
 * `maxEpisodes`, the oldest other episode pages are then archived through the
 * same write path so at most that many stay active. `shadow` records the
 * `knowledge/write` records it would make without writing. No model is called.
 * @module @deepseek-ai/dsh-experimental-memory-distill
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { KnowledgeCitation, KnowledgePageId, KnowledgeWriteRecord, KnowledgeWriteResult } from '@deepseek-ai/dsh-experimental-knowledge'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { episodeEntry } from './episode.ts'
import { applyDistill, distillStateSchema, emptyDistill, parseVerdict } from './fold.ts'
import type { DistillState } from './fold.ts'
import { episodesToArchive, resolveRetention } from './retention.ts'

export { episodeEntry, episodeId, filterTransient } from './episode.ts'
export type { EpisodeInput } from './episode.ts'
export { applyDistill, distillStateSchema, emptyDistill, parseVerdict } from './fold.ts'
export type { DistillState } from './fold.ts'
export { episodesToArchive, resolveRetention } from './retention.ts'
export type { EpisodeRetention } from './retention.ts'

/** Cordis plugin name. */
export const name = 'memory-distill'
/** Services the plugin needs. */
export const inject = ['knowledge', 'sessionProjections']

/** Warning logged once per session when the verifier gate judged a boundary after this plugin checked it. */
export const ORDER_WARNING = 'memory-distill: the verifier gate recorded a verdict after memory-distill checked the same turn boundary, so the turn was not distilled; list the loop guards bundle before the knowledge bundle so the gate runs first.'

/** Distillation settings. `assumption` is mandatory outside `off`. */
export interface Config {
  /** `off` registers nothing; `shadow` records the write it would make; `enforce` writes. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Distill only after a `loop/verdict` of `ok` for the final response (default true). */
  requireVerdict?: boolean
  /** Store directory for episode pages; must be a content directory of the store (default `episodes`). */
  dir?: string
  /**
   * Active episode pages kept. `0` archives none (default `0`); a positive value archives the oldest other episode
   * pages after each written episode, so at most that many stay in the store index.
   */
  maxEpisodes?: number
  /** Tools whose successful calls change their `file_path` or `path` (default `write`, `edit`). */
  changeTools?: string[]
  /** Characters of the request kept (default 1000). */
  maxRequestChars?: number
  /** Characters of the final response kept (default 2000). */
  maxOutcomeChars?: number
  /**
   * Markers of temporary statements, dropped sentence by sentence
   * (default `this session`, `for now`, `today only`, `temporarily`, `for this turn`).
   */
  transientMarkers?: string[]
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  requireVerdict: z.boolean().default(true),
  dir: z.string().default('episodes'),
  maxEpisodes: z.number().default(0),
  changeTools: z.array(z.string()).default(['write', 'edit']),
  maxRequestChars: z.number().default(1000),
  maxOutcomeChars: z.number().default(2000),
  transientMarkers: z.array(z.string()).default(['this session', 'for now', 'today only', 'temporarily', 'for this turn']),
})

/**
 * Fail unless a count setting is a positive integer.
 * @param field - config field name.
 * @param value - configured value.
 */
function requirePositive(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`memory-distill: ${field} must be a positive integer`)
}

/**
 * Register the fold, the turn-stopping listener, and the order check.
 * @param ctx - plugin context; every registration disposes with it.
 * @param config - distillation settings.
 * @throws when a setting is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode as 'off' | 'shadow' | 'enforce'
  if (mode === 'off') return
  if ((config.assumption as string).trim() === '') throw new Error('memory-distill: assumption must state what this mechanism assumes about the model')
  const dir = config.dir as string
  if (!/^[A-Za-z0-9_-]+$/.test(dir)) throw new Error('memory-distill: dir must be one path segment of letters, digits, _ or -')
  const changeTools = config.changeTools as string[]
  if (changeTools.length === 0 || changeTools.some(tool => tool.trim() === '')) throw new Error('memory-distill: changeTools must name at least one tool and no blank one')
  const maxRequestChars = config.maxRequestChars as number
  const maxOutcomeChars = config.maxOutcomeChars as number
  requirePositive('maxRequestChars', maxRequestChars)
  requirePositive('maxOutcomeChars', maxOutcomeChars)
  const markers = config.transientMarkers as string[]
  if (markers.some(marker => marker.trim() === '')) throw new Error('memory-distill: transientMarkers entries must not be blank')
  const requireVerdict = config.requireVerdict as boolean
  const retention = resolveRetention(config.maxEpisodes as number)
  const tools = new Set(changeTools)

  ctx.sessionProjections.register({
    key: 'memoryDistill',
    stateVersion: 1,
    stateSchema: distillStateSchema,
    init: () => emptyDistill(),
    apply: (state, event) => applyDistill(tools, state, event),
  })

  function stateOf(session: Session): DistillState {
    const state = ctx.sessionProjections.stateOf(session, 'memoryDistill')
    /* v8 ignore next -- apply() registered the unit before the listener that reads it */
    if (state === undefined) throw new Error('memory-distill: the memoryDistill projection is not registered')
    return state
  }

  const awaiting = new WeakMap<Session, number>()
  const warned = new WeakSet<Session>()
  ctx.on('session/event', (session, event) => {
    const type: string = event.type
    if (type !== 'loop/verdict') return
    const turn = awaiting.get(session)
    const data: unknown = event.data
    if (turn === undefined || parseVerdict(data)?.turn !== turn) return
    awaiting.delete(session)
    if (warned.has(session)) return
    warned.add(session)
    ctx.logger.warn(ORDER_WARNING)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const state = stateOf(agent.session)
    if (state.turn !== turn || state.distilled || state.boundary === null) return
    const verdict = state.verdict?.boundary === state.boundary ? state.verdict : null
    if (verdict === null && requireVerdict) {
      awaiting.set(agent.session, turn)
      return
    }
    if ((verdict !== null && verdict.verdict !== 'ok') || state.changes.length === 0) return
    const scope = { cwd: agent.session.header.cwd, signal }
    const entry = episodeEntry({
      dir,
      sessionId: agent.session.id,
      turn,
      date: new Date().toISOString().slice(0, 10),
      request: state.request,
      outcome: state.outcome,
      changes: state.changes,
      verdictSeq: verdict?.seq,
      markers,
      maxRequestChars,
      maxOutcomeChars,
    })
    const archive = retention.kind === 'every' ? [] : episodesToArchive(dir, retention.count, (await ctx.knowledge.index(scope)).entries, entry.id)
    const sourceEventSeqs = state.changes.map(change => SessionSeq(change.seq))
    const sources = state.changes.map(change => change.path)
    const citation: KnowledgeCitation = { sessionId: agent.session.id, sourceEventSeqs, sources, writer: 'distill' }
    const base = (id: KnowledgePageId) => ({ id, writer: 'distill' as const, mode, sourceEventSeqs, sources })
    const record = (id: KnowledgePageId, result: KnowledgeWriteResult): KnowledgeWriteRecord => result.kind === 'written'
      ? { ...base(id), applied: true, operation: result.operation, stale: result.stale }
      : { ...base(id), applied: false, stale: [], refusal: { rule: result.rule, reason: result.reason } }
    if (mode === 'shadow') {
      for (const id of [entry.id, ...archive]) agent.session.append('knowledge/write', { ...base(id), applied: false, stale: [] })
      return
    }
    const written = await ctx.knowledge.write(scope, entry, citation)
    agent.session.append('knowledge/write', record(entry.id, written))
    if (written.kind !== 'written') return
    for (const id of archive) {
      const page = await ctx.knowledge.read(scope, id)
      if (page === undefined) continue
      const archived = { id, type: page.type, title: page.title, body: page.body, relations: page.relations, status: 'archived' as const }
      agent.session.append('knowledge/write', record(id, await ctx.knowledge.write(scope, archived, citation)))
    }
  })
}
