/**
 * Stationarity guard. It folds each completed step's root tool calls and
 * their results from the session log into one evidence signature, counts
 * that signature's occurrences since the last human message (adjacent or
 * not), and counts consecutive read-only steps that added no new call/result
 * pair. At the next step boundary it reminds the model or rejects the step,
 * which ends the turn `blocked` and blocks an active goal. `shadow` mode
 * records the same decisions without acting.
 *
 * It also hashes the content of every file the turn wrote, read through
 * `ctx.fs` at the step boundary after a write. A content state that recurs
 * since the last human message, for example after an edit is reverted or
 * re-applied, stops the turn with the same `repeat` decision.
 * @module @deepseek-ai/dsh-experimental-stationarity-guard
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-tools'
import type { LoopStationarity, StationarityTier } from './types.ts'

export type { LoopStationarity, StationarityAction, StationarityReason, StationarityTier } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Reminder the guard adds to the next step when a step's evidence repeats.
     * @persistenceAttribution
     */
    'stationarity-guard': { kind: 'stationarity-guard' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'stationarity-guard'
/** The guard classifies calls through the tool registry and hashes written files through the filesystem. */
export const inject = ['tools', 'fs']

/** Per-tier repeat thresholds. */
export interface TierThresholds {
  /** Steps with at least one exclusive (side-effecting) call. */
  sideEffect?: number
  /** Steps whose every call is concurrency-safe (read-only). */
  readOnly?: number
}

/**
 * Plugin config. `assumption` is mandatory outside `off`: the sentence naming
 * what the guard assumes about the model, so a later model can retire it.
 */
export interface Config {
  /** `off` registers nothing; `shadow` records decisions only; `enforce` reminds and stops. Default `shadow`. */
  mode?: 'off' | 'shadow' | 'enforce'
  /** The assumption this mechanism encodes about the model; blank is a load error. */
  assumption?: string
  /** Signature occurrences that add one reminder (default side-effect 4, read-only 8). */
  remindAt?: TierThresholds
  /** Signature occurrences that stop the turn (default side-effect 8, read-only 12). */
  stopAt?: TierThresholds
  /** Consecutive read-only steps without new evidence that stop the turn (default 4). */
  noopStopAt?: number
  /** Tools whose `file_path` or `path` argument names a file the turn writes (default `write`, `edit`). */
  writeTools?: string[]
  /** Occurrences of one written-file state, since the last human message, that stop the turn (default 2). */
  stateRepeatStopAt?: number
  /**
   * Largest file read to hash its content. A larger file, or one whose size the backend does not report, hashes its
   * version token instead (default 262144).
   */
  maxHashBytes?: number
}

/**
 * One fresh tier schema per field.
 * @param sideEffect - default for side-effect steps.
 * @param readOnly - default for read-only steps.
 * @returns the tier schema.
 */
function tierSchema(sideEffect: number, readOnly: number): z<TierThresholds> {
  return z.object({
    sideEffect: z.number().default(sideEffect),
    readOnly: z.number().default(readOnly),
  })
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'enforce']).default('shadow'),
  assumption: z.string().default(''),
  remindAt: tierSchema(4, 8).default({}),
  stopAt: tierSchema(8, 12).default({}),
  noopStopAt: z.number().default(4),
  writeTools: z.array(z.string()).default(['write', 'edit']),
  stateRepeatStopAt: z.number().default(2),
  maxHashBytes: z.number().default(262_144),
})

/** One root tool call of a step, folded from `tool/call`. */
interface StepCall {
  readonly callId: ToolCallId
  readonly name: string
  /** Parsed arguments, or the raw text when the model emitted malformed JSON. */
  readonly args: unknown
  /** Key-sorted JSON of `args`. */
  readonly canonical: string
}

/** One step's calls and the hash of each call's result. */
interface StepBatch {
  readonly turn: number
  readonly step: number
  readonly calls: StepCall[]
  readonly results: Map<ToolCallId, string>
}

/** Per-session fold state. */
interface SessionFold {
  open: StepBatch | undefined
  completed: StepBatch | undefined
  signatures: Map<string, number>
  ledger: Set<string>
  noopRun: number
  /** Files written since the last human message. */
  writes: Set<string>
  /** The step that last wrote a file and has not been judged yet. */
  writeStep: { turn: number; step: number } | undefined
  /** Occurrences of each written-file state since the last human message. */
  states: Map<string, number>
}

/** A decision before the mode is applied. */
type Verdict = Omit<LoopStationarity, 'mode' | 'applied'>

/**
 * Hex sha256 of a string.
 * @param text - input text.
 * @returns lower-case hex digest.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Deep key-sort of a parsed-JSON value so argument objects that differ only
 * in property order canonicalize identically.
 * @param value - `JSON.parse` output or a raw string.
 * @returns the key-sorted value.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value === null || typeof value !== 'object') return value
  const entries: [string, unknown][] = Object.entries(value)
  entries.sort(([left], [right]) => (left < right ? -1 : 1))
  return Object.fromEntries(entries.map(([key, item]) => [key, sortJsonValue(item)]))
}

/**
 * Parse the model's raw argument text.
 * @param raw - `tool/call.arguments`.
 * @returns the parsed value, or `raw` itself when it is not JSON.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // SyntaxError: the model emitted malformed JSON; the raw text is the call's identity.
    return raw
  }
}

/**
 * The file a write-tool call names.
 * @param args - parsed arguments of the call.
 * @returns the trimmed `file_path`, else `path`, or `undefined` when neither is a non-blank string.
 */
function writtenPathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const named = args as { file_path?: unknown; path?: unknown }
  const candidate = typeof named.file_path === 'string' ? named.file_path : named.path
  if (typeof candidate !== 'string') return undefined
  const path = candidate.trim()
  return path === '' ? undefined : path
}

/**
 * Reject a threshold that is not an integer of at least 2.
 * @param field - config path named in the error.
 * @param value - the validated number.
 */
function requireThreshold(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`stationarity-guard: invalid ${field} ${value} — must be an integer >= 2`)
  }
}

/**
 * Model-facing reminder; it never names a way to disable the guard.
 * @param verdict - the remind decision.
 * @returns the reminder text.
 */
function reminderText(verdict: Verdict): string {
  return `Stationarity check: this exact set of tool calls has now returned identical results ${verdict.repeats} times since the last user message.\n`
    + 'Repeating it will not produce new information. Inspect the latest results, then take a different action or finish with the evidence you already have.'
}

/**
 * Install the guard.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - validated {@link Config}; blank `assumption` and invalid thresholds fail the load.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const mode = config.mode as 'off' | 'shadow' | 'enforce'
  if (mode === 'off') return
  // A `const` narrowed here keeps the active modes inside hoisted helpers below.
  const activeMode: 'shadow' | 'enforce' = mode
  if ((config.assumption as string).trim() === '') {
    throw new Error('stationarity-guard: `assumption` must name what this guard assumes about the model')
  }
  const remindAt = config.remindAt as Required<TierThresholds>
  const stopAt = config.stopAt as Required<TierThresholds>
  const noopStopAt = config.noopStopAt as number
  for (const tier of ['sideEffect', 'readOnly'] as const) {
    requireThreshold(`remindAt.${tier}`, remindAt[tier])
    requireThreshold(`stopAt.${tier}`, stopAt[tier])
    if (remindAt[tier] >= stopAt[tier]) {
      throw new Error(`stationarity-guard: remindAt.${tier} (${remindAt[tier]}) must be less than stopAt.${tier} (${stopAt[tier]})`)
    }
  }
  requireThreshold('noopStopAt', noopStopAt)
  const writeTools = new Set(config.writeTools as string[])
  if (writeTools.size === 0 || [...writeTools].some(tool => tool.trim() === '')) {
    throw new Error('stationarity-guard: writeTools must name at least one tool and no blank one')
  }
  const stateRepeatStopAt = config.stateRepeatStopAt as number
  requireThreshold('stateRepeatStopAt', stateRepeatStopAt)
  const maxHashBytes = config.maxHashBytes as number
  if (!Number.isSafeInteger(maxHashBytes) || maxHashBytes < 1) {
    throw new Error(`stationarity-guard: maxHashBytes ${maxHashBytes} must be a positive integer`)
  }

  const folds = new WeakMap<Session, SessionFold>()

  function foldOf(session: Session): SessionFold {
    let fold = folds.get(session)
    if (fold === undefined) {
      fold = {
        open: undefined,
        completed: undefined,
        signatures: new Map(),
        ledger: new Set(),
        noopRun: 0,
        writes: new Set(),
        writeStep: undefined,
        states: new Map(),
      }
      folds.set(session, fold)
    }
    return fold
  }

  /**
   * Hash the content of each written file as it is now. A file the backend cannot read as text contributes its
   * version token, and a file larger than `maxHashBytes` or of unknown size contributes its version token without
   * being read, so the hash still changes when the file does.
   * @param session - the session whose working directory resolves relative paths.
   * @param paths - files written since the last human message.
   * @param signal - cancellation of the step boundary.
   * @returns the sha256 hex of the sorted path and content-digest pairs.
   */
  async function writtenStateOf(session: Session, paths: ReadonlySet<string>, signal: AbortSignal): Promise<string> {
    const cwd = session.header.cwd
    const entries: [string, string][] = []
    for (const path of [...paths].sort()) {
      const target = await ctx.fs.resolve(path, cwd === undefined ? { signal } : { cwd, signal })
      const info = await ctx.fs.stat(target, signal)
      if (info === undefined) {
        entries.push([path, 'absent'])
      } else if (info.size === undefined || info.size > maxHashBytes) {
        entries.push([path, `version:${info.version}`])
      } else {
        entries.push([path, await readDigest(target, info.version, signal)])
      }
    }
    return sha256(JSON.stringify(entries))
  }

  /**
   * Digest of one file's text, or a fixed marker plus its version when the text cannot be read.
   * @param target - the resolved file.
   * @param version - the file's freshness token, used when the text is unreadable.
   * @param signal - cancellation.
   * @returns the content digest or the unreadable marker.
   */
  async function readDigest(target: Parameters<typeof ctx.fs.readText>[0], version: string, signal: AbortSignal): Promise<string> {
    try {
      return sha256(await ctx.fs.readText(target, signal))
    } catch {
      // Unreadable text (binary or invalid UTF-8): hash the version token so a rewrite still changes the state.
      return `unreadable:${version}`
    }
  }

  function tierOf(batch: StepBatch, agent: Agent, signal: AbortSignal): StationarityTier {
    const readOnly = batch.calls.every(call =>
      ctx.tools.executionMode({ callId: call.callId, name: call.name, arguments: call.args, agent, signal }).kind === 'parallel')
    return readOnly ? 'readOnly' : 'sideEffect'
  }

  function judge(fold: SessionFold, batch: StepBatch, tier: StationarityTier): Verdict | undefined {
    const pairs = batch.calls
      .map(call => JSON.stringify([call.name, call.canonical, String(batch.results.get(call.callId))]))
      .sort()
    const signature = sha256(JSON.stringify(pairs))
    const repeats = (fold.signatures.get(signature) ?? 0) + 1
    fold.signatures.set(signature, repeats)
    const fresh = pairs.some(pair => !fold.ledger.has(pair))
    for (const pair of pairs) fold.ledger.add(pair)
    fold.noopRun = tier === 'readOnly' && !fresh ? fold.noopRun + 1 : 0
    const base = { turn: batch.turn, step: batch.step, signature, tier, repeats, noopRun: fold.noopRun }
    if (repeats >= stopAt[tier]) return { ...base, action: 'stop', reason: 'repeat' }
    if (fold.noopRun >= noopStopAt) return { ...base, action: 'stop', reason: 'noop' }
    if (repeats === remindAt[tier]) return { ...base, action: 'remind', reason: 'repeat' }
    return undefined
  }

  function blockGoal(agent: Agent, verdict: Verdict): void {
    const goals = ctx.get('goals')
    const goal = goals?.get(agent)
    if (goals === undefined || goal === undefined || goal.phase !== 'active') return
    goals.block(agent, { id: goal.id, revision: goal.revision }, {
      code: 'stationary',
      message: `Stopped by the stationarity guard (${verdict.reason}: ${verdict.repeats} repeats, ${verdict.noopRun} read-only steps without new evidence).`,
    })
  }

  function reminder(verdict: Verdict): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: reminderText(verdict) }],
      source: { kind: 'stationarity-guard', form: 'notice', summary: boundContextSummary(`stationary: ${verdict.repeats} identical steps`) },
    })
  }

  /**
   * Append one decision and report whether the guard rejects the step.
   * @param agent - the agent whose step boundary this is.
   * @param verdict - the decision before the mode is applied.
   * @returns true when the mode is `enforce` and the decision is a stop.
   */
  function record(agent: Agent, verdict: Verdict): boolean {
    const applied = activeMode === 'enforce'
    agent.session.append('loop/stationarity', { ...verdict, mode: activeMode, applied })
    if (!applied || verdict.action !== 'stop') return false
    blockGoal(agent, verdict)
    return true
  }

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'step/start':
        foldOf(session).open = { turn: event.data.turn, step: event.data.step, calls: [], results: new Map() }
        return
      case 'tool/call': {
        const args = parseArguments(event.data.arguments)
        const canonical = JSON.stringify(sortJsonValue(args))
        const fold = foldOf(session)
        fold.open?.calls.push({ callId: event.data.callId, name: event.data.name, args, canonical })
        const path = writeTools.has(event.data.name) ? writtenPathOf(args) : undefined
        if (path !== undefined && fold.open !== undefined) {
          fold.writes.add(path)
          fold.writeStep = { turn: fold.open.turn, step: fold.open.step }
        }
        return
      }
      case 'tool/result': {
        const { message } = event.data
        foldOf(session).open?.results.set(message.toolCallId, sha256(JSON.stringify([message.isError === true, message.content])))
        return
      }
      case 'step/end': {
        const fold = foldOf(session)
        const open = fold.open
        fold.open = undefined
        if (open !== undefined && open.calls.length > 0) fold.completed = open
        return
      }
      default:
        // SessionEventMap is merge-extensible; every other event leaves the fold unchanged.
        return
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const fold = foldOf(agent.session)
    // Human input changes the context; repetition across it is not a loop.
    if (messages.some(message => message.source.kind === 'user')) {
      fold.completed = undefined
      fold.signatures.clear()
      fold.ledger.clear()
      fold.noopRun = 0
      fold.writes.clear()
      fold.writeStep = undefined
      fold.states.clear()
      return next()
    }
    const written = fold.writeStep
    if (written !== undefined) {
      fold.writeStep = undefined
      const state = await writtenStateOf(agent.session, fold.writes, signal)
      const count = (fold.states.get(state) ?? 0) + 1
      fold.states.set(state, count)
      if (count >= stateRepeatStopAt) {
        const verdict: Verdict = {
          turn: written.turn, step: written.step, signature: state, tier: 'sideEffect',
          repeats: count, noopRun: fold.noopRun, action: 'stop', reason: 'repeat',
        }
        if (record(agent, verdict)) return { kind: 'reject' }
      }
    }
    const batch = fold.completed
    fold.completed = undefined
    if (batch === undefined) return next()
    const verdict = judge(fold, batch, tierOf(batch, agent, signal))
    if (verdict === undefined) return next()
    if (record(agent, verdict)) return { kind: 'reject' }
    // A reminder is added only when enforced; shadow records the decision and changes nothing.
    if (mode !== 'enforce') return next()
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, reminder(verdict)] }
  })
}
