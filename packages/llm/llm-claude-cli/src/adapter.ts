/**
 * The `LlmAdapter` whose transport is the Claude Code CLI as a child process.
 *
 * What this adapter does NOT do, deliberately: it sends no HTTP request of its own. The mandatory
 * `attributionHeaders()` contract on `LlmAdapter` binds adapters that call a provider endpoint; this
 * one hands the request to the vendor's own CLI, which owns the connection and the credential. That
 * is also why no Anthropic credential is ever read, written, or passed: the only environment entry
 * this package sets is `CLAUDE_CONFIG_DIR`.
 *
 * How it carries tools: in the prompt. The CLI exposes no way to pass caller-supplied tool
 * definitions and get the model's tool call back for the caller to run; its only tool mechanism is
 * MCP, where the CLI invokes the tool inside its own loop. So `src/emulate.ts` declares the
 * request's tools as system-prompt text and reads the model's fenced call back as a real
 * `tool-call` block, which keeps iteration, guards, approvals, and compaction in the Harness. A
 * deployment that prefers the earlier refusal sets `toolCalls: 'refuse'`.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClaudeCliCatalog } from './catalog.ts'
import {
  correctionNotice,
  PREAMBLE_TEMPLATE,
  resolveToolPlan,
  ToolCallEmulator,
} from './emulate.ts'
import type { EmulationFailure, ToolPlan } from './emulate.ts'
import { resolveInferenceSpec } from './launch.ts'
import { startCliRun } from './run.ts'
import type { CliRunDeps } from './run.ts'
import { projectRequest } from './serialize.ts'
import type { ProjectedRequest } from './serialize.ts'
import { claudeCliModelId } from './types.ts'
import type {
  ClaudeCliLaunch,
  ClaudeCliModelRow,
  CliToolEmulation,
  CliToolEmulationCorrection,
  CliToolEmulationReply,
} from './types.ts'
import { ClaudeCliStreamDecoder } from './wire.ts'

/** The request declared tools and the route is configured to refuse rather than emulate them. */
export const TOOL_CALLS_UNSUPPORTED = 'TOOL_CALLS_UNSUPPORTED'
/** The request named a model the CLI does not list for this account. */
export const UNKNOWN_MODEL = 'UNKNOWN_MODEL'
/** Tool emulation was requested for a session whose log cannot be reached. */
export const EMULATION_NOT_LOGGABLE = 'EMULATION_NOT_LOGGABLE'

/** The prompt plan of a request whose tools are emulated. */
type PromptPlan = Extract<ToolPlan, { kind: 'prompt' }>

/**
 * Records the emulated CLI runs of a request in the session log.
 *
 * The plugin binds this to the session store. Either method throws a named {@link LlmError} rather
 * than skipping the record, because the preamble is model-visible input and the Harness requires
 * every model-visible input to be reconstructable from the log.
 */
export interface EmulationRecorder {
  /**
   * Record one run before it happens, so its preamble and correction notice are logged first.
   * @param sessionId - the session the request belongs to.
   * @param record - the run's model-visible additions.
   */
  run(sessionId: Branded<'SessionId'>, record: CliToolEmulation): void
  /**
   * Record how one run's reply was read, after the run.
   * @param sessionId - the session the request belongs to.
   * @param record - the calls accepted, the text dropped, and the rejection if there was one.
   */
  reply(sessionId: Branded<'SessionId'>, record: CliToolEmulationReply): void
}

/** Everything the adapter needs; each value is a validated `Config` field upstream. */
export interface ClaudeCliAdapterDeps {
  readonly catalog: ClaudeCliCatalog
  /**
   * Route name reported by `providerInfo`. The route *id* is not carried here: `registerAdapter`
   * passes it to every call, so one adapter instance can serve a route under any id the composition
   * chose without holding a second copy that could disagree.
   */
  readonly displayName: string
  readonly workingDirectory: string
  readonly requestTimeoutMs: number
  readonly maxConcurrent: number
  readonly graceMs: number
  readonly spawn: CliRunDeps['spawn']
  /** Whether a request that declares tools is emulated in the prompt or refused. */
  readonly toolCalls: 'refuse' | 'prompt'
  /** Tool-call blocks accepted from one emulated reply. */
  readonly toolCallMaxCalls: number
  /** Bytes accepted inside one tool-call block. */
  readonly toolCallMaxBytes: number
  /** Correction runs allowed after a rejected reply that handed over no answer text yet. */
  readonly toolCallRetries: number
  /** Whether a call in one of the three unambiguous near-miss forms is accepted rather than rejected. */
  readonly toolCallLenient: boolean
  readonly recordEmulation: EmulationRecorder
}

/** How one emulated reply was read; absent for a request that declared no tools. */
type ReplyReading = Pick<CliToolEmulationReply, 'calls' | 'lenientCalls' | 'discardedChars' | 'rejection'>

/** What one CLI run produced. */
type AttemptOutcome =
  | { readonly kind: 'done'; readonly reading: ReplyReading | undefined }
  /** The reply was rejected before anything reached the consumer, so it can be replaced. */
  | { readonly kind: 'retry'; readonly failure: EmulationFailure; readonly reading: ReplyReading }

/** A counting gate over concurrent CLI children, so a busy session cannot fork a process per turn. */
class Concurrency {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  /** Wait for a slot. */
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    // The count is not raised on this side: `release` hands this waiter the slot it already holds,
    // so the total never dips between the release and the woken continuation.
    await new Promise<void>((resolve) => { this.waiting.push(resolve) })
  }

  /** Hand the slot to the longest waiter, or give it up when none is waiting. */
  release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next()
  }
}

/** Combine the caller's cancellation with this request's own deadline. */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Streams Harness model calls through the Claude Code CLI. */
export class ClaudeCliAdapter extends LlmAdapter {
  private readonly deps: ClaudeCliAdapterDeps
  private readonly runDeps: CliRunDeps
  private readonly gate: Concurrency

  /**
   * @param deps - the catalog probe, the route's display identity, and the run limits.
   */
  constructor(deps: ClaudeCliAdapterDeps) {
    super()
    this.deps = deps
    this.runDeps = { spawn: deps.spawn, cwd: deps.workingDirectory, graceMs: deps.graceMs }
    this.gate = new Concurrency(deps.maxConcurrent)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.deps.displayName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Throwing rather than returning an empty list is the point: `buildModelCatalog` turns a throw
    // into a `ModelCatalogFailure` the picker shows with this message, while an empty list would
    // drop the provider group with no explanation.
    const rows = await this.deps.catalog.rows()
    return rows.map(row => ({
      provider,
      id: row.id,
      name: row.displayName,
      ...(row.description === undefined ? {} : { description: row.description }),
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const row = await this.row(model, signal)
    return {
      provider,
      id: row.id,
      name: row.displayName,
      ...(row.description === undefined ? {} : { description: row.description }),
      inputModalities: ['text'],
      ...(row.efforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts: row.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
          },
        }),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const plan = resolveToolPlan(options.tools, this.deps)
    if (plan.kind === 'refuse') {
      throw new LlmError(
        `The ${this.deps.displayName} route is configured to refuse a request that declares tools: the Claude Code CLI accepts no caller-supplied tool definitions, so the model could never call one. Set this route's toolCalls to "prompt" to declare the tools in the prompt instead, or use an API-key model route for turns with tools.`,
        TOOL_CALLS_UNSUPPORTED,
      )
    }
    return this.run(options, plan)
  }

  /** Find the CLI row for one model id, so an unlisted id fails before a child is spawned. */
  private async row(model: string, signal: AbortSignal | undefined): Promise<ClaudeCliModelRow> {
    const rows = await this.deps.catalog.rows(signal)
    const row = rows.find(candidate => candidate.id === model)
    if (row === undefined) {
      throw new LlmError(
        `The Claude Code CLI does not list the model ${model}. Available ids: ${rows.map(candidate => candidate.id).join(', ')}.`,
        UNKNOWN_MODEL,
      )
    }
    return row
  }

  /**
   * Serve one request, retrying a rejected emulated reply while nothing has reached the consumer.
   *
   * A correction run is only possible before the first text chunk is handed over: afterwards the
   * consumer has seen answer text that a second run would contradict, so a rejection can only be a
   * named terminal failure. A reply that has produced only tool calls is held back until it ends,
   * so a rejection later in the same reply replaces it whole and none of its calls run.
   */
  private async *run(options: GenerateOptions, plan: ToolPlan): AsyncGenerator<StreamChunk> {
    const prompt = plan.kind === 'prompt' ? plan : undefined
    await this.row(options.model, options.signal)
    const launch = await this.deps.catalog.launch(options.signal)
    await this.gate.acquire()
    try {
      const runs = prompt === undefined ? 1 : prompt.retries + 1
      let correction: CliToolEmulationCorrection | undefined
      for (let attempt = 1; ; attempt += 1) {
        if (prompt !== undefined) this.record(options, prompt, attempt, correction)
        const projected = projectRequest(
          options.messages,
          options.system,
          prompt?.preamble,
          correction?.text,
        )
        const outcome = yield* this.attempt(launch, options, projected, prompt)
        this.recordReply(options, attempt, outcome.reading)
        if (outcome.kind === 'done') return
        if (attempt >= runs) {
          yield { type: 'finish', reason: { kind: 'error', failure: outcome.failure } }
          return
        }
        correction = { code: outcome.failure.code, text: correctionNotice(outcome.failure) }
      }
    }
    finally {
      this.gate.release()
    }
  }

  /** Run one CLI child and translate its stdout, always tearing the child down. */
  private async *attempt(
    launch: ClaudeCliLaunch,
    options: GenerateOptions,
    projected: ProjectedRequest,
    prompt: PromptPlan | undefined,
  ): AsyncGenerator<StreamChunk, AttemptOutcome> {
    const spec = resolveInferenceSpec(launch, {
      model: claudeCliModelId(options.model),
      system: projected.system,
      // A fresh id per request, with `--no-session-persistence`, keeps concurrent children from
      // sharing a transcript inside one configuration directory.
      sessionId: randomUUID(),
    })
    const run = startCliRun(
      this.runDeps,
      { ...spec, stdinPayload: projected.stdinPayload },
      deadline(this.deps.requestTimeoutMs, options.signal),
    )
    try {
      const decoder = new ClaudeCliStreamDecoder()
      const emulator = prompt === undefined ? undefined : new ToolCallEmulator(prompt)
      const pending: StreamChunk[] = []
      const take = (chunks: readonly StreamChunk[]): void => {
        for (const chunk of chunks) pending.push(...(emulator === undefined ? [chunk] : emulator.push(chunk)))
      }
      for await (const line of run.lines()) {
        take(decoder.push(line))
        if (emulator?.failure !== undefined && !emulator.committed) {
          return { kind: 'retry', failure: emulator.failure, reading: reading(emulator) }
        }
        if (emulator === undefined || emulator.committed) yield* pending.splice(0)
        // The CLI emits one result per user turn and this run writes exactly one, so the first
        // result ends the response; reading further would block on a child awaiting more input.
        if (decoder.resultSeen) break
      }
      if (!decoder.resultSeen) {
        const tail = run.stderrTail().trim()
        take(decoder.finish().map(chunk => withStderrTail(chunk, tail)))
      }
      // A reply that handed over no answer text — tool calls only, or reasoning only — reaches the
      // consumer here, once it has ended without a rejection.
      yield* pending.splice(0)
      return { kind: 'done', reading: emulator === undefined ? undefined : reading(emulator) }
    }
    finally {
      await run.dispose()
    }
  }

  /**
   * Log one emulated run's model-visible additions before the run happens.
   * @throws LlmError `EMULATION_NOT_LOGGABLE` when the request names a session the log cannot reach.
   */
  private record(
    options: GenerateOptions,
    plan: PromptPlan,
    attempt: number,
    correction: CliToolEmulationCorrection | undefined,
  ): void {
    const sessionId = options.sessionId
    // A request with no session identity has no session log; its one-shot caller owns whatever
    // record it keeps, exactly as it does for the messages it assembled.
    if (sessionId === undefined) return
    this.deps.recordEmulation.run(sessionId, {
      provider: options.provider,
      model: options.model,
      template: PREAMBLE_TEMPLATE,
      preambleChars: plan.preamble.length,
      tools: plan.tools.map(tool => tool.name),
      attempt,
      ...(correction === undefined ? {} : { correction }),
    })
  }

  /**
   * Log how one emulated run's reply was read, after the run.
   * @throws LlmError `EMULATION_NOT_LOGGABLE` when the request names a session the log cannot reach.
   */
  private recordReply(options: GenerateOptions, attempt: number, read: ReplyReading | undefined): void {
    const sessionId = options.sessionId
    if (read === undefined || sessionId === undefined) return
    this.deps.recordEmulation.reply(sessionId, {
      provider: options.provider,
      model: options.model,
      attempt,
      ...read,
    })
  }
}

/** Read the counts and the rejection off the emulator that finished reading one reply. */
function reading(emulator: ToolCallEmulator): ReplyReading {
  return {
    calls: emulator.calls,
    lenientCalls: emulator.lenientCalls,
    discardedChars: emulator.discardedChars,
    ...(emulator.failure === undefined ? {} : { rejection: emulator.failure.code }),
  }
}

/** Append the child's stderr tail to a transport failure, so a dead CLI says why it died. */
function withStderrTail(chunk: StreamChunk, tail: string): StreamChunk {
  if (tail.length === 0 || chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        ...chunk.reason.failure,
        message: `${chunk.reason.failure.message}. The CLI reported: ${tail}`,
      },
    },
  }
}
