/**
 * The `LlmAdapter` whose transport is the Claude Code CLI as a child process.
 *
 * What this adapter does NOT do, deliberately: it sends no HTTP request of its own. The mandatory
 * `attributionHeaders()` contract on `LlmAdapter` binds adapters that call a provider endpoint; this
 * one hands the request to the vendor's own CLI, which owns the connection and the credential. That
 * is also why no Anthropic credential is ever read, written, or passed: the only environment entry
 * this package sets is `CLAUDE_CONFIG_DIR`.
 *
 * What it refuses: a request that declares tools. The CLI exposes no way to pass caller-supplied
 * tool definitions and get the model's tool call back for the caller to run; its only tool mechanism
 * is MCP, where the CLI invokes the tool inside its own loop. Silently dropping the declarations
 * would give the Harness's agent loop a model that can never call a tool, so the request fails with
 * a named error instead.
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
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClaudeCliCatalog } from './catalog.ts'
import { resolveInferenceSpec } from './launch.ts'
import { startCliRun } from './run.ts'
import type { CliRunDeps } from './run.ts'
import { stdinLines } from './serialize.ts'
import { claudeCliModelId } from './types.ts'
import type { ClaudeCliModelRow } from './types.ts'
import { ClaudeCliStreamDecoder } from './wire.ts'

/** The request declared tools, which this transport cannot carry. */
export const TOOL_CALLS_UNSUPPORTED = 'TOOL_CALLS_UNSUPPORTED'
/** The request named a model the CLI does not list for this account. */
export const UNKNOWN_MODEL = 'UNKNOWN_MODEL'

/** Everything the adapter needs; each value is a validated `Config` field upstream. */
export interface ClaudeCliAdapterDeps {
  readonly catalog: ClaudeCliCatalog
  readonly providerName: string
  readonly displayName: string
  readonly workingDirectory: string
  readonly requestTimeoutMs: number
  readonly maxConcurrent: number
  readonly graceMs: number
  readonly spawn: CliRunDeps['spawn']
}

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
    await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    this.active += 1
  }

  /** Release a slot, waking the longest waiter. */
  release(): void {
    this.active -= 1
    this.waiting.shift()?.()
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
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new LlmError(
        `The ${this.deps.displayName} route cannot carry a request that declares tools: the Claude Code CLI accepts no caller-supplied tool definitions, so the model could never call one. Use an API-key model route for turns with tools, and this route for text-only requests.`,
        TOOL_CALLS_UNSUPPORTED,
      )
    }
    return this.run(options)
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

  /** Run one CLI child and translate its stdout, always tearing the child down. */
  private async *run(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const payload = stdinLines(options.messages)
    await this.row(options.model, options.signal)
    const launch = await this.deps.catalog.launch(options.signal)
    await this.gate.acquire()
    try {
      const spec = resolveInferenceSpec(launch, {
        model: claudeCliModelId(options.model),
        system: options.system,
        // A fresh id per request, with `--no-session-persistence`, keeps concurrent children from
        // sharing a transcript inside one configuration directory.
        sessionId: randomUUID(),
      })
      const run = startCliRun(
        this.runDeps,
        { ...spec, stdinPayload: payload },
        deadline(this.deps.requestTimeoutMs, options.signal),
      )
      try {
        const decoder = new ClaudeCliStreamDecoder()
        for await (const line of run.lines()) {
          yield* decoder.push(line)
          // The CLI emits one result per user turn and this run writes exactly one, so the first
          // result ends the response; reading further would block on a child awaiting more input.
          if (decoder.resultSeen) return
        }
        const tail = run.stderrTail().trim()
        for (const chunk of decoder.finish()) {
          yield tail.length === 0 || chunk.type !== 'finish' || chunk.reason.kind !== 'error'
            ? chunk
            : {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { ...chunk.reason.failure, message: `${chunk.reason.failure.message}. The CLI reported: ${tail}` },
              },
            }
        }
      }
      finally {
        await run.dispose()
      }
    }
    finally {
      this.gate.release()
    }
  }
}
