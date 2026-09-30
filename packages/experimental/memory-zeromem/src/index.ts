/**
 * Conversation memory backed by zeromem (the `zm` CLI, a Rust implementation
 * of Zero-Mem). When a turn ends, the plugin adds the turn's human messages
 * and its final assistant text to the session's zeromem store as one spool
 * file; tool calls, tool output, reasoning, and injected context are never
 * stored. No model is called. The model reads the store through
 * `memory_recall` and `memory_stats`, and with `allowForget` deletes one
 * earlier session through the approval-gated `memory_forget_session`. Every
 * store operation runs one `zm mcp` process through `ctx.subprocess`, which
 * first ingests the pending spool files. With the default embedder every
 * operation first checks that the model directory holds the embedding model,
 * and fails when `zm` answers on its hash embedder.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { applyZeromemTurn, emptyZeromemTurn, zeromemTurnStateSchema } from './fold.ts'
import type { TurnText, ZeromemTurnState } from './fold.ts'
import { deletedTurnsOf, recallOf, statsOf } from './results.ts'
import { isForgotten, markForgotten, prepareStore, resolveStore, resolveStoreRoot, sourceUuid, spoolTurns } from './store.ts'
import type { SpoolTurn, StoreScope } from './store.ts'
import { checkZeromemModel, resolveModelDir, ZeromemEmbedderError, ZM_MODELS_ENV } from './model.ts'
import { callZeromem } from './zm.ts'
import type { ZeromemTool, ZmAnswer, ZmOperationSpec } from './zm.ts'

export { applyZeromemTurn, emptyZeromemTurn, zeromemTurnStateSchema } from './fold.ts'
export type { TurnText, TurnTexts, ZeromemTurnState } from './fold.ts'
export { deletedTurnsOf, recallOf, statsOf } from './results.ts'
export type { MemoryStats, Recall, RecalledTurn } from './results.ts'
export { isForgotten, markForgotten, prepareStore, resolveStore, resolveStoreRoot, sourceUuid, spoolTurns, ZeromemStoreError } from './store.ts'
export type { SpoolTurn, StoreRequest, StoreScope, StoreSpec, ZeromemSourceUuid } from './store.ts'
export { callZeromem, zmArgv, ZeromemProcessError, ZeromemToolError } from './zm.ts'
export type { SpawnChild, ZeromemTool, ZmAnswer, ZmOperationSpec } from './zm.ts'
export { checkZeromemModel, resolveModelDir, ZEROMEM_MODEL_FILES, ZEROMEM_MODEL_FOLDER, ZeromemEmbedderError, ZeromemModelError, ZM_MODELS_ENV } from './model.ts'

/** Cordis plugin name. */
export const name = 'memory-zeromem'
/** Services the plugin needs. */
export const inject = ['tools', 'subprocess', 'sessionProjections']

/** Deployment settings. Invalid values fail plugin load. */
export interface Config {
  /** `zm` executable: a name on `PATH` or an absolute path; empty selects `DSH_ZEROMEM_ZM`, then `zm` on `PATH` (default empty). */
  zmPath?: string
  /** Arguments placed before zeromem's own, for a `zm` run through an interpreter (default none). */
  zmArgs?: string[]
  /**
   * `default` runs bge-small-en-v1.5 from `modelDir` and needs a `zm` built with zeromem's fastembed feature;
   * `hash` passes `--no-model` for lexical recall (default `default`).
   */
  embedder?: 'default' | 'hash'
  /** Absolute directory holding the embedding model; empty selects `DSH_ZEROMEM_MODELS`, then `<store root>/models` (default empty). */
  modelDir?: string
  /** `workspace` keeps one store per session working directory; `global` shares one store (default `workspace`). */
  scope?: StoreScope
  /** Absolute directory holding the stores; empty selects `<harness home>/zeromem` (default empty). */
  storeRoot?: string
  /** Leave the calling session's turns out of `memory_recall` results (default true). */
  excludeCurrentSession?: boolean
  /** Store turns of subagent child sessions too (default false). */
  ingestSubagentSessions?: boolean
  /** Register the approval-gated `memory_forget_session` tool (default false). */
  allowForget?: boolean
  /** Turns `memory_recall` returns when the call names no `limit` (default 5). */
  defaultResults?: number
  /** Largest `limit` of `memory_recall` (default 10). */
  maxResults?: number
  /** Characters of text per recalled turn (default 2000). */
  maxTurnChars?: number
  /** Characters stored per message (default 16000). */
  maxIngestChars?: number
  /** Deadline of one `zm` operation, including the ingestion of pending turns (default 120000). */
  timeoutMs?: number
  /** Grace before a terminated `zm` is killed (default 2000). */
  graceMs?: number
  /** Concurrent `zm` processes this plugin runs (default 1). */
  maxConcurrent?: number
}

/** Config with every default applied. */
type ValidConfig = Required<Config>

/** Schemastery validator for {@link Config}. */
export const Config: z<Config, ValidConfig> = z.object({
  zmPath: z.string().default(''),
  zmArgs: z.array(z.string()).default([]),
  embedder: z.union(['default', 'hash'] as const).default('default'),
  modelDir: z.string().default(''),
  scope: z.union(['workspace', 'global'] as const).default('workspace'),
  storeRoot: z.string().default(''),
  excludeCurrentSession: z.boolean().default(true),
  ingestSubagentSessions: z.boolean().default(false),
  allowForget: z.boolean().default(false),
  defaultResults: z.natural().min(1).default(5),
  maxResults: z.natural().min(1).default(10),
  maxTurnChars: z.natural().min(1).default(2000),
  maxIngestChars: z.natural().min(1).default(16000),
  timeoutMs: z.natural().min(1).default(120_000),
  graceMs: z.natural().min(1).default(2_000),
  maxConcurrent: z.natural().min(1).default(1),
})

/**
 * Model-facing description of `memory_recall`.
 * @param scope - store scope.
 * @param excludeCurrentSession - whether the calling session is left out.
 * @returns the description.
 */
export function memoryRecallDescription(scope: StoreScope, excludeCurrentSession: boolean): string {
  const where = scope === 'workspace' ? 'in this workspace' : 'in any workspace'
  const current = excludeCurrentSession ? 'the current session is left out' : 'the current session is included'
  return `Search what the user and you said in earlier sessions ${where}. Returns the most relevant stored turns, each with its session id, time, speaker (user or assistant), text, and kind: match answers the query, context is linked to a match. Only user messages and final assistant replies are stored, never tool calls or tool output; ${current}. Recalled text records what was said then: verify it against the current files before relying on it.`
}

/** Model-facing description of `memory_stats`. */
export const MEMORY_STATS_DESCRIPTION = 'Count the stored turns and sessions that memory_recall searches.'

/** Model-facing description of `memory_forget_session`. */
export const MEMORY_FORGET_SESSION_DESCRIPTION = 'Permanently delete every stored turn of one earlier session, named by the session id memory_recall returned. Use only when the user asks to forget that session; the user approves every deletion. The current session cannot be deleted, and later turns of a deleted session are not stored.'

const RECALL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turns: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true },
          time: { type: 'string', required: true },
          speaker: { type: 'string', required: true },
          text: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['match', 'context'] },
          truncated: { type: 'boolean' },
        },
      },
    },
  },
} as const

const STATS_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turns: { type: 'integer', required: true },
    sessions: { type: 'integer', required: true },
  },
} as const

const FORGET_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session: { type: 'string', required: true },
    deletedTurns: { type: 'integer', required: true },
  },
} as const

/** A resolved `memory_recall` call. */
export interface RecallSpec {
  readonly query: string
  readonly topK: number
}

/**
 * Resolve the arguments of one `memory_recall` call.
 * @param request - the model's `query` and optional `limit`.
 * @param bounds - the configured default and largest limit.
 * @returns the query and the number of turns to request.
 * @throws when the query is blank or the limit is outside 1 to `maxResults`.
 */
export function resolveRecall(
  request: { readonly query: string; readonly limit?: number | undefined },
  bounds: { readonly defaultResults: number; readonly maxResults: number },
): RecallSpec {
  const query = request.query.trim()
  if (query === '') throw new Error('memory_recall: query must name what to look for')
  const topK = request.limit ?? bounds.defaultResults
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > bounds.maxResults) throw new Error(`memory_recall: limit must be between 1 and ${bounds.maxResults}`)
  return { query, topK }
}

/** Environment variable naming an absolute `zm` path; Desktop sets it to the `zm` it carries. */
export const ZM_PATH_ENV = 'DSH_ZEROMEM_ZM'

/** Where the resolved `zm` came from. */
export type ZmSource = 'config' | 'environment' | 'path'

/** The `zm` to run and the setting that selected it. */
export interface ZmSpec {
  /** Absolute path, or a command name looked up on `PATH`. */
  readonly zmPath: string
  readonly source: ZmSource
}

/**
 * Select the `zm` executable: a non-empty `zmPath`, then a non-empty {@link ZM_PATH_ENV}, then `zm` on `PATH`.
 * @param request - the configured `zmPath` (empty when unset) and the value of {@link ZM_PATH_ENV}.
 * @returns the selected executable and its source.
 * @throws ZeromemExecutableError when {@link ZM_PATH_ENV} is set to a relative path.
 */
export function resolveZm(request: { readonly zmPath: string; readonly environment: string | undefined }): ZmSpec {
  if (request.zmPath !== '') return { zmPath: request.zmPath, source: 'config' }
  const environment = request.environment ?? ''
  if (environment === '') return { zmPath: 'zm', source: 'path' }
  const spec: ZmSpec = { zmPath: environment, source: 'environment' }
  if (!isAbsolute(environment)) throw new ZeromemExecutableError(spec, { cause: new Error(`${ZM_PATH_ENV} must be an absolute path`) })
  return spec
}

const INSTALL_HINT = 'build zeromem (cargo install --git https://github.com/ptaranat/zeromem --locked zeromem) or set zmPath to the absolute path of zm'

/** The selected `zm` could not be found. */
export class ZeromemExecutableError extends Error {
  /**
   * @param spec - the selected executable and its source.
   * @param options - the lookup failure.
   */
  constructor(spec: ZmSpec, options: ErrorOptions) {
    const what = spec.source === 'config'
      ? `the zm executable ${spec.zmPath} set by zmPath was not found`
      : spec.source === 'environment'
        ? `the zm executable ${spec.zmPath} named by ${ZM_PATH_ENV} is not an absolute path to an existing file`
        : `no zm executable is on PATH, and neither zmPath nor ${ZM_PATH_ENV} is set (CTD Core Desktop sets ${ZM_PATH_ENV} only on platforms whose build carries zm)`
    super(`memory-zeromem: ${what}; ${INSTALL_HINT}`, options)
    this.name = 'ZeromemExecutableError'
  }
}

/**
 * Run work with at most `size` calls in flight, first come first served.
 * @param size - the number of concurrent calls.
 * @returns the gate.
 */
function gate(size: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0
  const queued: (() => void)[] = []
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < size) running += 1
    // A released slot passes straight to the next queued call, so `running` stays counted.
    else await new Promise<void>((resolve) => { queued.push(resolve) })
    try {
      return await work()
    } finally {
      const next = queued.shift()
      if (next === undefined) running -= 1
      else next()
    }
  }
}

/**
 * Validate settings, resolve `zm` with {@link resolveZm} and the model directory with {@link resolveModelDir}, and
 * register the fold, the ingestion listener, and the tools.
 * @param ctx - plugin context; every registration disposes with it.
 * @param config - validated deployment settings.
 * @throws when a setting is invalid, `zm` cannot be found, or the default embedder's model is incomplete.
 */
export async function apply(ctx: Context, config: ValidConfig): Promise<void> {
  resolveStoreRoot(config.storeRoot)
  const models = resolveModelDir({ modelDir: config.modelDir, storeRoot: config.storeRoot, environment: process.env[ZM_MODELS_ENV] })
  const semantic = config.embedder === 'default'
  if (config.defaultResults > config.maxResults) throw new Error('memory-zeromem: defaultResults must not exceed maxResults')
  const zm = resolveZm({ zmPath: config.zmPath, environment: process.env[ZM_PATH_ENV] })
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable(zm.zmPath)
  } catch (error) {
    throw new ZeromemExecutableError(zm, { cause: error })
  }
  if (semantic) await checkZeromemModel(models)
  const command = [executable, ...config.zmArgs]
  const disposal = new AbortController()
  const limited = gate(config.maxConcurrent)
  const pending = new Set<Promise<void>>()
  // Spool writes run one at a time, in turn order.
  let writes: Promise<void> = Promise.resolve()
  ctx.effect(() => async () => {
    disposal.abort()
    await Promise.all(pending)
  }, 'memory-zeromem: abort zm operations and finish spool writes')

  ctx.sessionProjections.register({
    key: 'zeromemTurn',
    stateVersion: 1,
    stateSchema: zeromemTurnStateSchema,
    init: emptyZeromemTurn,
    apply: (state, event) => applyZeromemTurn(config.maxIngestChars, state, event),
  })

  function stateOf(session: Session): ZeromemTurnState {
    const state = ctx.sessionProjections.stateOf(session, 'zeromemTurn')
    /* v8 ignore next -- apply() registered the unit before the listener that reads it */
    if (state === undefined) throw new Error('memory-zeromem: the zeromemTurn projection is not registered')
    return state
  }

  /**
   * Run one zeromem tool against a session's store.
   * @param cwd - the calling session's working directory.
   * @param tool - the zeromem tool.
   * @param args - its arguments.
   * @param signal - the call's cancellation.
   * @returns the store directory and the answer.
   * @throws ZeromemModelError when the default embedder's model left the model directory.
   */
  async function operate(
    cwd: string | undefined,
    tool: ZeromemTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ home: string; answer: ZmAnswer }> {
    const store = resolveStore({ scope: config.scope, storeRoot: config.storeRoot, cwd, models })
    await prepareStore(store)
    // A missing file would make zm download it at its latest revision.
    if (semantic) await checkZeromemModel(models)
    // Turns that ended before this call are spooled first, so zm ingests them before it answers.
    await writes
    const { timeoutMs, graceMs } = config
    const spec: ZmOperationSpec = { command, hashEmbedder: !semantic, home: store.home, timeoutMs, graceMs }
    const spawn = (spawnSpec: Parameters<Context['subprocess']['spawn']>[0]) => ctx.subprocess.spawn(spawnSpec)
    const answer = await limited(() => callZeromem(spawn, spec, tool, args, AbortSignal.any([signal, disposal.signal])))
    return { home: store.home, answer }
  }

  /**
   * Refuse a result `zm` computed on its hash embedder when the default embedder was configured.
   * @param fallback - whether zeromem reported its hash embedder.
   * @param answer - the answer, whose stderr names the load failure.
   * @throws ZeromemEmbedderError for a fallback under the default embedder.
   */
  const requireEmbedder = (fallback: boolean, answer: ZmAnswer): void => {
    if (fallback && semantic) throw new ZeromemEmbedderError(executable, models, answer.stderr)
  }

  // Turn number of the last completed turn this process spooled, per session.
  const spooled = new WeakMap<Session, number>()
  const warnedNoWorkspace = new WeakSet<Session>()

  /**
   * Spool the session's last completed turn unless this process already did.
   * @param session - the session whose turn ended or whose next turn started.
   */
  function ingest(session: Session): void {
    if (session.header.origin === 'subagent' && !config.ingestSubagentSessions) return
    const completed = stateOf(session).completed
    if (completed === null || (spooled.get(session) ?? Number.NEGATIVE_INFINITY) >= completed.turn) return
    if (config.scope === 'workspace' && session.header.cwd === undefined) {
      if (warnedNoWorkspace.has(session)) return
      warnedNoWorkspace.add(session)
      ctx.logger.warn(`memory-zeromem: session ${session.id} has no working directory, so its turns are not stored; set scope: global to store them`)
      return
    }
    spooled.set(session, completed.turn)
    const texts: [TurnText, SpoolTurn['speaker']][] = [
      ...completed.requests.map((text): [TurnText, 'user'] => [text, 'user']),
      ...completed.reply === null ? [] : [[completed.reply, 'assistant'] as [TurnText, 'assistant']],
    ]
    // Fork-inherited events belong to the parent session, which stored them under its own id.
    const turns = texts.filter(([text]) => session.isOwnSeq(SessionSeq(text.seq))).map(([text, speaker]): SpoolTurn => ({
      session_id: session.id,
      speaker,
      text: text.text,
      ts: Math.floor(text.time / 1000),
      uuid: sourceUuid(session.id, text.seq),
    }))
    if (turns.length === 0) return
    const turn = completed.turn
    const write = writes.then(async () => {
      const store = resolveStore({ scope: config.scope, storeRoot: config.storeRoot, cwd: session.header.cwd, models })
      await prepareStore(store)
      if (await isForgotten(store.home, session.id)) return
      await spoolTurns(store.home, turns)
    }).catch((error: unknown) => {
      // Let the next turn boundary of this session retry its last completed turn.
      spooled.delete(session)
      ctx.logger.warn(`memory-zeromem: could not store turn ${turn} of session ${session.id}`)
      ctx.logger.warn(error)
    })
    writes = write
    pending.add(write)
    void write.finally(() => pending.delete(write))
  }

  ctx.on('session/event', (session, event) => {
    // turn/start also covers a resumed session whose last turn the previous process did not store.
    if (event.type === 'turn/end' || event.type === 'turn/start') ingest(session)
  })

  const sessionOf = (exec: Pick<ToolExecution, 'agent'>): Session | undefined => exec.agent?.session

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: memoryRecallDescription(config.scope, config.excludeCurrentSession),
    parameters: {
      query: { type: 'string', required: true, description: 'Words or a question about the earlier conversation.' },
      limit: { type: 'integer', description: `Most turns to return, 1 to ${config.maxResults} (default ${config.defaultResults}).` },
    },
    output: { schema: RECALL_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Recall earlier sessions: ${args.query}`, kind: 'search' }),
    async execute(args, exec): Promise<InferValue<typeof RECALL_VALUE_SCHEMA>> {
      const spec = resolveRecall(args, config)
      const session = sessionOf(exec)
      const exclude = config.excludeCurrentSession && session !== undefined ? { exclude_session: session.id } : {}
      const { answer } = await operate(session?.header.cwd, 'zeromem_recall', { query: spec.query, top_k: spec.topK, ...exclude }, exec.signal)
      const recall = recallOf(answer.value, config.maxTurnChars)
      requireEmbedder(recall.fallbackEmbedder, answer)
      return { turns: recall.turns }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: MEMORY_STATS_DESCRIPTION,
    parameters: {},
    output: { schema: STATS_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Count stored sessions', kind: 'read' }),
    async execute(_args, exec): Promise<InferValue<typeof STATS_VALUE_SCHEMA>> {
      const { answer } = await operate(sessionOf(exec)?.header.cwd, 'zeromem_stats', {}, exec.signal)
      const stats = statsOf(answer.value)
      requireEmbedder(stats.fallbackEmbedder, answer)
      return { turns: stats.turns, sessions: stats.sessions }
    },
  }))

  if (!config.allowForget) return

  ctx.tools.register(defineTool({
    name: 'memory_forget_session',
    description: MEMORY_FORGET_SESSION_DESCRIPTION,
    parameters: {
      session: { type: 'string', required: true, description: 'Session id from a memory_recall result.' },
    },
    output: { schema: FORGET_VALUE_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: `Forget stored session ${args.session}`, kind: 'delete' }),
    async execute(args, exec): Promise<InferValue<typeof FORGET_VALUE_SCHEMA>> {
      const current = sessionOf(exec)
      const target = SessionId(args.session.trim())
      if (target === '') throw new Error('memory_forget_session: session must be a session id from a memory_recall result')
      if (target === current?.id) throw new Error('memory_forget_session: the current session cannot be deleted')
      const { home, answer } = await operate(current?.header.cwd, 'zeromem_forget_session', { session_id: target }, exec.signal)
      await markForgotten(home, target)
      return { session: target, deletedTurns: deletedTurnsOf(answer.value) }
    },
  }))

  // Outermost, so an earlier listener's allow cannot skip the question.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (exec.name !== 'memory_forget_session' || decision.kind !== 'allow') return decision
    const args = exec.arguments
    const target = typeof args === 'object' && args !== null && 'session' in args && typeof args.session === 'string' ? args.session : '(unnamed)'
    return {
      kind: 'ask',
      reason: `memory_forget_session permanently deletes the stored turns of session ${target}`,
      displayReason: { en: `Forget stored session ${target}`, zh: `删除已存储的会话 ${target}` },
    }
  }, { prepend: true })
}
