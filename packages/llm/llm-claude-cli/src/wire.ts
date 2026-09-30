/**
 * Decodes what the Claude Code CLI writes on stdout.
 *
 * Three decoders, one per question this package asks the CLI, each validating at the process
 * boundary with zod because the CLI is another process and its output is not typed by our compiler:
 *
 * - `decodeModelRows` reads the CLI's own `list_models` answer, which is where the model catalog
 *   comes from. No vendor model API is contacted.
 * - `decodeAuthStatus` reads `claude auth status --json`. This is the only authentication question,
 *   and it must be asked separately: `list_models` answers successfully even against an
 *   unauthenticated configuration directory, so a catalog cannot prove a login.
 * - `ClaudeCliStreamDecoder` turns one `--output-format stream-json` run into `StreamChunk`s.
 *
 * The streaming decoder switches on the CLI's message tags. Those tags form a merge-extensible
 * vocabulary owned by another product, so unknown tags fall through a documented default rather
 * than failing a run.
 */

import { stripVTControlCharacters } from 'node:util'
import type { ContentBlock, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { CATALOG_REQUEST_ID } from './launch.ts'
import { claudeCliModelId } from './types.ts'
import type { ClaudeCliAuthStatus, ClaudeCliModelRow } from './types.ts'

/** Title-case one effort id for display; the CLI reports ids, not labels. */
function effortName(id: string): string {
  return id === 'xhigh' ? 'Extra high' : `${id.charAt(0).toUpperCase()}${id.slice(1)}`
}

const modelRow = z.object({
  value: z.string().min(1),
  resolvedModel: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  supportedEffortLevels: z.array(z.string().min(1)).optional(),
  isDefault: z.boolean().optional(),
})

const controlResponse = z.object({
  type: z.literal('control_response'),
  response: z.object({ subtype: z.string(), request_id: z.string() }).loose(),
})

const catalogSuccess = z.object({
  subtype: z.literal('success'),
  response: z.object({ models: z.array(modelRow).min(1) }),
})

const authStatus = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  subscriptionType: z.string().optional(),
})

const resultMessage = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  stop_reason: z.string().nullable().optional(),
  // The three fields below only refine how a failed run is described and classified, so a value of
  // an unexpected type is ignored rather than making the whole result unreadable.
  result: z.string().optional().catch(undefined),
  errors: z.array(z.string()).optional().catch(undefined),
  api_error_status: z.number().nullable().optional().catch(undefined),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).optional(),
  }).optional(),
})

/**
 * Characters of the CLI's failure text quoted in a failure message. The CLI's own failure texts
 * are one or two sentences; the bound keeps a provider error body the CLI echoed from filling the
 * turn's error notice.
 */
const FAILURE_TEXT_MAX_CHARS = 500

/**
 * The CLI's two texts for a run it could not authenticate: no credential at all, and a credential
 * the API rejected. Matched only as whole phrases, because other failure texts mention `/login` as
 * advice without the account being signed out.
 */
const SIGNED_OUT_TEXT = /\bnot logged in\b|\bplease run \/login\b/i

/**
 * Reduce CLI failure text to one bounded line with no terminal control sequences.
 * @param text - text the CLI wrote in a result message.
 * @returns the text on one line, at most {@link FAILURE_TEXT_MAX_CHARS} characters and an ellipsis.
 */
function failureText(text: string): string {
  const line = stripVTControlCharacters(text).replace(/[\s\p{Cc}]+/gu, ' ').trim()
  const characters = Array.from(line)
  return characters.length <= FAILURE_TEXT_MAX_CHARS
    ? line
    : `${characters.slice(0, FAILURE_TEXT_MAX_CHARS).join('')}…`
}

/**
 * Describe and classify a run the CLI's terminal `result` reported as failed.
 *
 * The classification reads three independent signals, because no single one is present on every
 * failure: the error kind the CLI attaches to the assistant message that wraps an API error, the
 * HTTP status on the result, and, for the signed-out state only, the CLI's text. `RATE_LIMIT` and
 * `SERVER` are the retry policy's codes for a failure that can succeed when repeated; every other
 * failure keeps `PROVIDER` and the CLI's own words.
 * @param result - the decoded terminal `result` message.
 * @param errorKind - the `error` value of the run's last assistant message, when it carried one.
 * @param signedOut - the failure to report when the CLI could not authenticate the run.
 * @returns the failure for the terminal `finish` chunk.
 */
function resultFailure(
  result: z.infer<typeof resultMessage>,
  errorKind: string | undefined,
  signedOut: LlmFailure,
): LlmFailure {
  const text = failureText(result.result ?? '') || failureText((result.errors ?? []).join('; '))
  const status = result.api_error_status ?? undefined
  const http = status === undefined ? {} : { status }
  if (errorKind === 'authentication_failed' || status === 401 || SIGNED_OUT_TEXT.test(text)) {
    return {
      ...signedOut,
      message: text.length === 0 ? signedOut.message : `${signedOut.message} The CLI reported: ${text}`,
      ...http,
    }
  }
  const code = errorKind === 'rate_limit' || status === 429
    ? 'RATE_LIMIT'
    : errorKind === 'server_error' || errorKind === 'overloaded' || (status !== undefined && status >= 500)
      ? 'SERVER'
      : 'PROVIDER'
  if (text.length > 0) return { message: `Claude Code CLI: ${text}`, code, ...http }
  return {
    // A failed run is reported with subtype `success` when it ended on an API error, so that
    // subtype does not name the failure.
    message: result.subtype === 'success'
      ? 'the Claude Code CLI reported a failed run and gave no reason'
      : `the Claude Code CLI ended the run with ${result.subtype}`,
    code,
    ...http,
  }
}

/** Parse one line as JSON, or `undefined` when it is blank or not JSON. */
function parseLine(line: string): unknown {
  if (line.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed
  }
  catch {
    // Not JSON: the CLI also writes human-readable notices on stdout, and a run must survive one.
    return undefined
  }
}

/** What one stdout line said about the catalog: the rows, a refusal, or nothing about it. */
export type CatalogAnswer =
  | { readonly kind: 'rows'; readonly rows: readonly ClaudeCliModelRow[] }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Decode the CLI's answer to this package's one `list_models` control request.
 *
 * Returns rather than throws, because this is a process boundary: a refusal is data the caller
 * reports verbatim, not an exception to unwrap.
 * @param line - one line of the CLI's stdout.
 * @returns the rows, the refusal reason, or `undefined` when the line is not this probe's answer.
 */
export function decodeModelRows(line: string): CatalogAnswer | undefined {
  const parsed = controlResponse.safeParse(parseLine(line))
  if (!parsed.success || parsed.data.response.request_id !== CATALOG_REQUEST_ID) return undefined
  const success = catalogSuccess.safeParse(parsed.data.response)
  if (!success.success) {
    const reason = parsed.data.response['error']
    return {
      kind: 'refused',
      reason: typeof reason === 'string'
        ? reason
        : 'the Claude Code CLI answered list_models with a payload this build cannot read',
    }
  }
  return { kind: 'rows', rows: success.data.response.models.map(row => ({
    id: claudeCliModelId(row.value),
    resolvedModel: row.resolvedModel,
    displayName: row.displayName,
    ...(row.description === undefined ? {} : { description: row.description }),
    efforts: (row.supportedEffortLevels ?? []).map(id => ({ id, name: effortName(id) })),
    isDefault: row.isDefault === true,
  })) }
}

/**
 * Decode `claude auth status --json`.
 * @param stdout - the command's complete stdout.
 * @returns the login state the CLI reported, or `undefined` when its output cannot be read; a login
 *   state is never guessed.
 */
export function decodeAuthStatus(stdout: string): ClaudeCliAuthStatus | undefined {
  const parsed = authStatus.safeParse(parseLine(stdout))
  if (!parsed.success) return undefined
  return {
    loggedIn: parsed.data.loggedIn,
    authMethod: parsed.data.authMethod,
    subscriptionType: parsed.data.subscriptionType,
  }
}

/**
 * Split a byte stream into complete lines across chunk boundaries.
 * @returns a function taking one decoded chunk and returning the lines it completed.
 */
export function lineSplitter(): (chunk: string) => readonly string[] {
  let pending = ''
  return (chunk) => {
    pending += chunk
    const lastBreak = pending.lastIndexOf('\n')
    if (lastBreak < 0) return []
    const complete = pending.slice(0, lastBreak).split('\n')
    pending = pending.slice(lastBreak + 1)
    return complete
  }
}

/** Map one CLI usage object onto the Harness's disjoint token counts. */
function tokenUsage(usage: z.infer<typeof resultMessage>['usage']): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const thinking = usage.output_tokens_details?.thinking_tokens
  return {
    // The CLI already reports `input_tokens` excluding both cache columns, which is exactly the
    // disjoint accounting `TokenUsage` requires, so nothing is subtracted here.
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cache_creation_input_tokens }),
    ...(thinking === undefined ? {} : { reasoningTokens: thinking }),
  }
}

/** One block the decoder is currently assembling. */
interface OpenBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning'
  text: string
}

/**
 * Turns one `--output-format stream-json` run into the Harness stream protocol.
 *
 * Usage is emitted once, from the terminal `result` message, after every `block-end` and before the
 * terminal `finish`, which is the order `StreamChunk` requires. A run that ends without a `result`
 * finishes with a named error rather than a clean stop, so a truncated child is never mistaken for
 * a complete answer. A `result` that reports a failed run finishes with the CLI's own text and a
 * code the retry policy can route on.
 */
export class ClaudeCliStreamDecoder {
  /** Whether the CLI's terminal `result` message has been seen. */
  resultSeen = false

  /** Open blocks by the CLI's content-block index. */
  private readonly open = new Map<number, OpenBlock>()

  /** The `error` kind of the run's last assistant message, which the CLI sets on an API error. */
  private errorKind: string | undefined

  private readonly signedOut: LlmFailure

  /**
   * @param signedOut - the failure to report when the CLI could not authenticate the run; the
   *   caller owns its wording because it knows whether an account is registered.
   */
  constructor(signedOut: LlmFailure) {
    this.signedOut = signedOut
  }

  /**
   * Feed one line of stdout.
   * @param line - one complete line, without its newline.
   * @returns the chunks that line produced, possibly none.
   */
  push(line: string): readonly StreamChunk[] {
    const message = parseLine(line)
    if (typeof message !== 'object' || message === null) return []
    const tag = (message as { type?: unknown }).type
    if (tag === 'result') return this.result(message)
    if (tag === 'stream_event') return this.streamEvent((message as { event?: unknown }).event)
    if (tag === 'assistant') {
      // An assistant message contributes only its error kind: text and reasoning already arrive
      // through `stream_event`.
      const kind = (message as { error?: unknown }).error
      this.errorKind = typeof kind === 'string' ? kind : undefined
      return []
    }
    // `system`, `user`, `rate_limit_event` and anything this build does not know: the CLI's message
    // vocabulary is merge-extensible and owned by another product. Text and reasoning already
    // arrive through `stream_event`, and usage through `result`, so nothing here carries harness
    // meaning.
    return []
  }

  /**
   * Close a run whose child exited.
   * @returns the terminal chunks, naming the truncation when no `result` arrived.
   */
  finish(): readonly StreamChunk[] {
    if (this.resultSeen) return []
    return [{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'the Claude Code CLI exited before it reported a result',
          code: 'TRANSPORT',
        },
      },
    }]
  }

  /** Translate one wrapped Anthropic streaming event. */
  private streamEvent(event: unknown): readonly StreamChunk[] {
    if (typeof event !== 'object' || event === null) return []
    const record = event as Record<string, unknown>
    switch (record['type']) {
      case 'content_block_start': return this.blockStart(record)
      case 'content_block_delta': return this.blockDelta(record)
      case 'content_block_stop': return this.blockStop(record)
      default:
        // `message_start`, `message_delta`, `message_stop`, `signature_delta` and any event a later
        // CLI adds: the Harness takes its stop reason and usage from the terminal `result` message,
        // so none of these adds anything.
        return []
    }
  }

  private blockStart(record: Record<string, unknown>): readonly StreamChunk[] {
    const index = record['index']
    const blockType = (record['content_block'] as { type?: unknown } | undefined)?.type
    if (typeof index !== 'number') return []
    const kind = blockType === 'text' ? 'text' : blockType === 'thinking' ? 'reasoning' : undefined
    if (kind === undefined) {
      // `tool_use` cannot appear: the adapter refuses a request that declares tools before it
      // spawns, and every run passes `--tools ""`. Anything else is a block type this build has no
      // representation for, and dropping it is better than inventing one.
      return []
    }
    this.open.set(index, { index, kind, text: '' })
    return [{ type: 'block-start', index, blockType: kind }]
  }

  private blockDelta(record: Record<string, unknown>): readonly StreamChunk[] {
    const index = record['index']
    if (typeof index !== 'number') return []
    const block = this.open.get(index)
    if (block === undefined) return []
    const delta = record['delta'] as Record<string, unknown> | undefined
    const text = delta?.['type'] === 'text_delta'
      ? delta['text']
      : delta?.['type'] === 'thinking_delta' ? delta['thinking'] : undefined
    if (typeof text !== 'string' || text.length === 0) return []
    block.text += text
    return [block.kind === 'text'
      ? { type: 'text-delta', index, text }
      : { type: 'reasoning-delta', index, text }]
  }

  private blockStop(record: Record<string, unknown>): readonly StreamChunk[] {
    const index = record['index']
    if (typeof index !== 'number') return []
    const block = this.open.get(index)
    if (block === undefined) return []
    this.open.delete(index)
    const content: ContentBlock = block.kind === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'reasoning', text: block.text }
    return [{ type: 'block-end', index, block: content }]
  }

  /** Translate the terminal `result` message into any pending closes, usage, and one finish. */
  private result(message: object): readonly StreamChunk[] {
    const parsed = resultMessage.safeParse(message)
    if (!parsed.success) {
      this.resultSeen = true
      return [{
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'the Claude Code CLI reported a result this build cannot read',
            code: 'TRANSPORT',
          },
        },
      }]
    }
    this.resultSeen = true
    const chunks: StreamChunk[] = []
    // A CLI that ends a run mid-block leaves an open index; close it so the assembled message keeps
    // the text the model did produce.
    for (const index of [...this.open.keys()].sort((left, right) => left - right)) {
      chunks.push(...this.blockStop({ index }))
    }
    const usage = tokenUsage(parsed.data.usage)
    if (usage !== undefined) chunks.push({ type: 'usage', usage })
    const failed = parsed.data.is_error || parsed.data.subtype !== 'success'
    if (failed) {
      chunks.push({
        type: 'finish',
        reason: { kind: 'error', failure: resultFailure(parsed.data, this.errorKind, this.signedOut) },
      })
      return chunks
    }
    chunks.push({
      type: 'finish',
      reason: parsed.data.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
    })
    return chunks
  }
}
