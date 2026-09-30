/**
 * Prompt-level tool-call emulation: what lets the CLI transport serve a turn that declares tools,
 * and therefore lets a Claude subscription serve the main chat model.
 *
 * Claude Code accepts no caller-supplied tool definitions and offers no mode that reports a tool
 * call without executing it. So the request's `ToolSchema[]` travels in the system prompt and the
 * model's textual call is read back as a real `tool-call` block. Everything else about the turn —
 * iteration, guards, approvals, compaction — stays in the Harness.
 *
 * Model output is untrusted text, so this module treats a reply as a wire boundary: nothing is
 * repaired, no call is invented, no call is dropped, and every rejection is named. The caller
 * decides between a bounded correction run and a named terminal failure.
 *
 * A call written in any other syntax — a JSON object without its fence, or the XML `<invoke>`
 * elements a model writes for a provider that accepts a `tools` field — is never answer text: the
 * loop ends a turn on a reply with no tool call, so releasing it as text would end the turn and show
 * the user a call that never ran. It is either accepted under `toolCallLenient` or rejected by name.
 */

import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderArgumentsType } from './arguments-type.ts'
import { readInvokeSyntax } from './invoke-syntax.ts'
import { isRecord } from './json.ts'

/**
 * Identity of the pinned preamble wording, recorded in the session event.
 *
 * Model-visible text: a change to {@link buildToolPreamble} changes what the model reads, so it
 * changes this tag too and a session log stays reconstructable.
 *
 * `/1` listed each tool's `parameters` as JSON Schema inside a `json` fence. `/2` lists the type of
 * its `arguments` in the notation of `./arguments-type.ts`, states as a rule of its own that the
 * block is the only way to call a tool and that neither a bare JSON object nor XML tags are one,
 * and uses no fence but the `dsh-tool-call` one. The reply format is the same in
 * both.
 */
export const PREAMBLE_TEMPLATE = 'dsh-tool-call/2'

/** Info string of the fenced block that carries one emulated tool call. */
export const TOOL_CALL_FENCE = 'dsh-tool-call'

/** The reply broke the emulation contract in a way no correction can classify further. */
export const TOOL_CALL_MALFORMED = 'TOOL_CALL_MALFORMED'
/** The reply ended inside an unterminated tool-call block. */
export const TOOL_CALL_TRUNCATED = 'TOOL_CALL_TRUNCATED'
/** The reply called a tool the request never declared. */
export const TOOL_CALL_UNKNOWN_TOOL = 'TOOL_CALL_UNKNOWN_TOOL'
/** One tool-call block exceeded the configured byte cap. */
export const TOOL_CALL_TOO_LARGE = 'TOOL_CALL_TOO_LARGE'
/** The reply carried more tool-call blocks than the configured cap. */
export const TOOL_CALL_LIMIT = 'TOOL_CALL_LIMIT'
/** The reply wrote a complete call to a declared tool in a syntax other than a `dsh-tool-call` block. */
export const TOOL_CALL_UNFENCED = 'TOOL_CALL_UNFENCED'

const FENCE_OPEN = `\`\`\`${TOOL_CALL_FENCE}`
const FENCE_CLOSE = '```'

/** The members a tool-call object carries; an object opening with either may be a call. */
const CALL_MEMBERS = ['"name"', '"arguments"'] as const

/** A fence opener line that is not the `dsh-tool-call` one: three backticks, an info string, a newline. */
const OTHER_FENCE_LINE = /^```[\w+.-]*[ \t]*\n/u
/** The start of a fence opener line whose newline has not arrived yet. */
const OTHER_FENCE_PREFIX = /^```[\w+.-]*[ \t]*$/u
/** Info strings of a block that lenient reading accepts a call from: `json`, or none. */
const LENIENT_INFO_STRINGS: ReadonlySet<string> = new Set(['', 'json'])
/** Three backticks that end a block rather than start another opener line. */
const CLOSING_FENCE = /^```(?![\w+.-])/u
/** The `name` member of an object that opens with it, as the JSON string literal the model wrote. */
const LEADING_NAME = /^\{\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")/u

/** How much of a rejected reply a failure message quotes. */
const EXCERPT_CHARS = 200

/** Bounds on what one reply may emit; both are validated `Config` fields upstream. */
export interface EmulationLimits {
  /** Tool-call blocks accepted from one reply. */
  readonly maxCalls: number
  /** Bytes accepted inside one tool-call block. */
  readonly maxBytes: number
}

/** A named rejection of one reply. */
export interface EmulationFailure {
  /** One of the `TOOL_CALL_*` codes in this module. */
  readonly code: string
  /** What the reply did and what a corrected reply must do instead. */
  readonly message: string
}

/**
 * How one request's tool declarations reach the model, decided once before any child is spawned.
 *
 * `none` is a request that declares no tools; `refuse` is the configured refusal that predates
 * emulation; `prompt` carries the preamble the model will read.
 */
export type ToolPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'refuse' }
  | {
    readonly kind: 'prompt'
    /** Declared tools, in request order, as the preamble lists them. */
    readonly tools: readonly ToolSchema[]
    /** The exact text appended to the request's system prompt. */
    readonly preamble: string
    readonly limits: EmulationLimits
    /** Correction runs allowed after a rejected reply. */
    readonly retries: number
    /** Whether a call in one of the three unambiguous near-miss forms is accepted rather than rejected. */
    readonly lenient: boolean
  }

/** The deployment choices that decide a plan. */
export interface ToolPlanConfig {
  readonly toolCalls: 'refuse' | 'prompt'
  readonly toolCallMaxCalls: number
  readonly toolCallMaxBytes: number
  readonly toolCallRetries: number
  readonly toolCallLenient: boolean
}

/**
 * Decide how one request's tools reach the model.
 * @param tools - the request's declared tool schemas, absent or empty when it declares none.
 * @param config - the route's validated tool-call configuration.
 * @returns the plan; `prompt` carries the preamble text the model will read.
 */
export function resolveToolPlan(
  tools: readonly ToolSchema[] | undefined,
  config: ToolPlanConfig,
): ToolPlan {
  if (tools === undefined || tools.length === 0) return { kind: 'none' }
  if (config.toolCalls === 'refuse') return { kind: 'refuse' }
  const limits: EmulationLimits = { maxCalls: config.toolCallMaxCalls, maxBytes: config.toolCallMaxBytes }
  return {
    kind: 'prompt',
    tools,
    preamble: buildToolPreamble(tools, limits),
    limits,
    retries: config.toolCallRetries,
    lenient: config.toolCallLenient,
  }
}

/**
 * Render the preamble the model reads.
 *
 * Pinned verbatim by a test: this is model-visible text, and its wording is what makes the emulated
 * call parseable, so it is not a tunable. It carries no fence except the `dsh-tool-call` one, so
 * the only fenced block the model is shown is the one it must write.
 * @param tools - the request's declared tool schemas, in request order.
 * @param limits - the bounds stated to the model, so a rejection is never a surprise.
 * @returns the preamble text, without a trailing newline.
 */
export function buildToolPreamble(tools: readonly ToolSchema[], limits: EmulationLimits): string {
  const lines: string[] = [
    '## Tool calls',
    '',
    'The harness running this conversation executes tools for you, and reads your calls out of your reply text. Only the tools listed below exist.',
    '',
    `To call a tool, emit a fenced block whose info string is \`${TOOL_CALL_FENCE}\`, holding one JSON object with the members \`name\` and \`arguments\`:`,
    '',
    FENCE_OPEN,
    '{"name": "<a tool name from the list below>", "arguments": {}}',
    FENCE_CLOSE,
    '',
    'The harness rejects a reply that breaks any of these, names which one, and asks you again:',
    '',
    `- The block opens with the line ${FENCE_OPEN} and closes with the line ${FENCE_CLOSE}. It is the only way to call a tool: a JSON object outside such a block is not a call, and neither are XML tags such as \`<invoke>\` or \`<function_calls>\`.`,
    '- `name` is spelled exactly as listed below. No other tool exists.',
    '- `arguments` is a JSON object. The harness passes it to the tool, which checks it against the type listed below and reports a violation to you.',
    `- Each block holds that one JSON object and nothing else, under ${limits.maxBytes} bytes.`,
    `- At most ${limits.maxCalls} blocks in one reply.`,
    '- A reply that calls a tool contains no text outside its blocks, and ends at the closing fence of its last block.',
    '- Never write a tool result yourself. The harness runs the tool and sends you its real result in the next message; anything you write after a block is discarded.',
    '',
    'When no tool is needed, reply with ordinary text and no such block.',
    '',
    '### Tools',
    '',
    'Each tool lists the type of its `arguments`: `?` marks a member that may be left out, and the text after `//` describes the member.',
  ]
  for (const tool of tools) {
    const type = renderArgumentsType(tool.parameters)
    lines.push(
      '',
      `#### ${tool.name}`,
      '',
      tool.description,
      '',
      // A schema the type notation cannot state exactly is listed as it is, never approximated.
      type === undefined ? `arguments, as JSON Schema: ${JSON.stringify(tool.parameters)}` : `arguments: ${type}`,
    )
  }
  return lines.join('\n')
}

/**
 * The notice a correction run carries, so the model reads why its last reply was rejected.
 * @param failure - the rejection to state.
 * @returns the verbatim text appended to the request.
 */
export function correctionNotice(failure: EmulationFailure): string {
  return `Your previous reply was rejected and no tool ran. ${failure.message} Answer the last message again, following the tool-call format exactly.`
}

/**
 * One piece of a reply: text for the user, or the raw JSON of one tool call.
 *
 * `lenient` marks a call read from a near-miss form instead of a `dsh-tool-call` block.
 */
export type ReplySegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'call'; readonly raw: string; readonly lenient: boolean }

/** Quote a bounded excerpt of untrusted model text for a failure message. */
function excerpt(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`
}

/** Whether text parses as a JSON object, which is how a closing fence is told from one inside a string. */
function isJsonObject(text: string): boolean {
  try {
    return isRecord(JSON.parse(text))
  }
  catch {
    // Not JSON yet: either the block is still arriving or the fence sits inside a string value.
    return false
  }
}

/** Longest suffix of `text` that could still become the fence opener. */
function heldFenceLength(text: string): number {
  for (let length = Math.min(text.length, FENCE_OPEN.length - 1); length > 0; length -= 1) {
    if (FENCE_OPEN.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/**
 * Find where the JSON object opening at the start of `text` closes.
 * @param text - text whose first character is `{`.
 * @returns the index of the matching `}`, or -1 when the object has not closed yet.
 */
function objectEnd(text: string): number {
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Find where a call written in another syntax could next start: an object, an XML tag, or a fence
 * line.
 * @param text - the unreleased reply text.
 * @param from - the index to search from.
 * @returns the index of the next `{`, `<`, or three backticks, or `text.length` when there is none.
 */
function candidateStart(text: string, from: number): number {
  const starts = ['{', '<', FENCE_CLOSE].map(start => text.indexOf(start, from)).filter(index => index >= 0)
  return Math.min(text.length, ...starts)
}

/** A call to a declared tool written in a syntax other than a `dsh-tool-call` block. */
interface Attempt {
  /** The declared tool it calls. */
  readonly name: string
  /** Characters of reply text it spans, including a fence or wrapper tag that belongs to it. */
  readonly length: number
  /** Whether it is a JSON object or XML `<invoke>` syntax. */
  readonly syntax: 'json' | 'invoke'
  /** Whether it closed; one that did not was cut off by the end of the reply or by the byte cap. */
  readonly complete: boolean
  /** Its call as JSON, when it is in a form lenient reading accepts. */
  readonly acceptable: string | undefined
}

/** What the text at one candidate position turned out to be. */
type Verdict =
  /** Undecided until more of the reply arrives. */
  | { readonly kind: 'pending' }
  /**
   * Not a call: this many characters are ordinary reply text. `fenceLine` marks a line that opens
   * or closes a fenced code block.
   */
  | { readonly kind: 'text'; readonly length: number; readonly fenceLine: boolean }
  | { readonly kind: 'attempt'; readonly attempt: Attempt }

/** The verdict for a candidate character that starts nothing. */
const ONE_CHARACTER: Verdict = { kind: 'text', length: 1, fenceLine: false }

/** What a corrected reply must do, stated in every rejection of a call written in another syntax. */
const REQUIRED_BLOCK = `The harness reads a call only from a block that opens with the line ${FENCE_OPEN}, holds one JSON object with the members \`name\` and \`arguments\`, and closes with the line ${FENCE_CLOSE}.`

/**
 * Name why a call written in another syntax is rejected.
 * @param attempt - the call as the scanner classified it.
 * @param text - the reply text it spans.
 * @param final - whether the reply has ended.
 * @param maxBytes - the byte cap an attempt that never closed outgrew, when the reply has not ended.
 * @returns the rejection, which states the required block and, for XML, that XML is not accepted.
 */
function rejection(attempt: Attempt, text: string, final: boolean, maxBytes: number): EmulationFailure {
  const xml = attempt.syntax === 'invoke'
  const written = xml ? 'as XML <invoke> tags' : 'outside a tool-call block'
  const rule = `${xml ? 'XML function-call syntax is not accepted on this route. ' : ''}${REQUIRED_BLOCK}`
  if (attempt.complete) {
    return {
      code: TOOL_CALL_UNFENCED,
      message: `A call to \`${attempt.name}\` was written ${written}: ${excerpt(text)}. ${rule}`,
    }
  }
  return final
    ? {
      code: TOOL_CALL_TRUNCATED,
      message: `The reply ended inside a call to \`${attempt.name}\` written ${written}: ${excerpt(text)}. ${rule}`,
    }
    : {
      code: TOOL_CALL_TOO_LARGE,
      message: `A call to \`${attempt.name}\` written ${written} exceeded ${maxBytes} bytes without closing. ${rule}`,
    }
}

/** What a {@link ReplyScanner} reads one reply against. */
export interface ReplyScannerOptions {
  /** The bounds the preamble stated to the model. */
  readonly limits: EmulationLimits
  /** The tools the request declared; only a call naming one of them is a call. */
  readonly tools: readonly ToolSchema[]
  /**
   * Whether a call in one of three near-miss forms is accepted instead of rejected. Two are JSON: a
   * block opened with `json` or no info string, and a bare object followed by a closing fence,
   * either holding exactly the members `name` and `arguments` with object `arguments`. The third is
   * a complete XML `<invoke>` element each of whose parameters the tool declares one type for.
   */
  readonly lenient: boolean
}

/**
 * Splits one assistant reply into plain text and fenced tool-call blocks as it arrives.
 *
 * Text is released as soon as it can be neither the start of a fence nor the start of a call in
 * another syntax, so a plain answer still streams. Three things are held back: the few characters
 * that could still open a fence; a JSON object that opens with `"name"` or `"arguments"`, together
 * with a fence opener line directly above it; and an XML `<invoke>` element outside a fenced code
 * block, together with a `<function_calls>` tag directly before it. Such text is held until it
 * closes, until it turns out not to name a declared tool, or until it outgrows `limits.maxBytes`,
 * whichever is first.
 *
 * A call written in another syntax is accepted only in the forms
 * {@link ReplyScannerOptions.lenient} names, and only when that option is on. Any other sets
 * {@link failure}: a call is never released as text and never dropped.
 */
export class ReplyScanner {
  /** Set once the reply broke the contract; the scanner then produces nothing more. */
  failure: EmulationFailure | undefined

  private buffer = ''
  private collecting = false
  /** Whether a closing fence was seen inside the block being collected. */
  private closed = false
  private calls = 0
  private readonly limits: EmulationLimits
  private readonly lenient: boolean
  /** Declared tool names, keyed by the JSON string literal a reply would carry. */
  private readonly names: ReadonlyMap<string, string>
  /** Declared tools by name. */
  private readonly tools: ReadonlyMap<string, ToolSchema>
  /** Whether the text released so far ends inside a fenced code block. */
  private fenced = false

  /**
   * @param options - the bounds and the declared tools this reply is read against.
   */
  constructor(options: ReplyScannerOptions) {
    this.limits = options.limits
    this.lenient = options.lenient
    this.names = new Map(options.tools.map(tool => [JSON.stringify(tool.name), tool.name]))
    this.tools = new Map(options.tools.map(tool => [tool.name, tool]))
  }

  /**
   * Feed one text delta.
   * @param delta - the text the model just produced.
   * @returns the segments it completed, possibly none.
   */
  push(delta: string): readonly ReplySegment[] {
    if (this.failure !== undefined) return []
    this.buffer += delta
    return this.drain(false)
  }

  /**
   * Close the reply.
   * @returns the remaining segments; an unterminated block sets {@link failure} instead.
   */
  finish(): readonly ReplySegment[] {
    if (this.failure !== undefined) return []
    return this.drain(true)
  }

  /** Release everything the buffer now determines. */
  private drain(final: boolean): readonly ReplySegment[] {
    const segments: ReplySegment[] = []
    for (;;) {
      if (this.collecting) {
        const raw = this.takeBlock()
        if (raw === undefined) {
          if (this.buffer.length > this.limits.maxBytes) {
            this.failure = {
              code: TOOL_CALL_TOO_LARGE,
              message: `One tool-call block exceeded ${this.limits.maxBytes} bytes without closing.`,
            }
          }
          else if (final) {
            this.failure = this.closed
              ? {
                code: TOOL_CALL_MALFORMED,
                message: `A tool-call block did not hold one JSON object: ${excerpt(this.buffer)}.`,
              }
              : {
                code: TOOL_CALL_TRUNCATED,
                message: `The reply ended inside an unterminated tool-call block: ${excerpt(this.buffer)}.`,
              }
          }
          return segments
        }
        if (!this.admit()) return segments
        segments.push({ kind: 'call', raw, lenient: false })
        this.collecting = false
        continue
      }
      const open = this.buffer.indexOf(FENCE_OPEN)
      const found = this.nextCandidate(open < 0 ? this.buffer.length : open, final)
      if (found !== undefined) {
        if (found.at > 0) segments.push({ kind: 'text', text: this.buffer.slice(0, found.at) })
        this.buffer = this.buffer.slice(found.at)
        if (found.verdict.kind === 'pending') return segments
        const { attempt } = found.verdict
        const text = this.buffer.slice(0, attempt.length)
        this.buffer = this.buffer.slice(attempt.length)
        if (this.lenient && attempt.acceptable !== undefined) {
          if (!this.admit()) return segments
          segments.push({ kind: 'call', raw: attempt.acceptable, lenient: true })
          continue
        }
        this.failure = rejection(attempt, text, final, this.limits.maxBytes)
        return segments
      }
      if (open >= 0) {
        if (open > 0) segments.push({ kind: 'text', text: this.buffer.slice(0, open) })
        this.buffer = this.buffer.slice(open + FENCE_OPEN.length)
        this.collecting = true
        this.closed = false
        continue
      }
      const held = final ? 0 : heldFenceLength(this.buffer)
      const release = this.buffer.slice(0, this.buffer.length - held)
      this.buffer = this.buffer.slice(this.buffer.length - held)
      if (release.length > 0) segments.push({ kind: 'text', text: release })
      return segments
    }
  }

  /**
   * Count one more call against the cap.
   * @returns whether the reply may carry it; when not, {@link failure} names the cap.
   */
  private admit(): boolean {
    this.calls += 1
    if (this.calls <= this.limits.maxCalls) return true
    this.failure = {
      code: TOOL_CALL_LIMIT,
      message: `The reply carried more than ${this.limits.maxCalls} tool-call blocks.`,
    }
    return false
  }

  /**
   * Take the JSON of the block being collected, if its closing fence has arrived.
   *
   * A closing fence is only the real one when the text before it parses as a JSON object, so a
   * fence inside a string argument — a tool writing Markdown, say — does not end the block early.
   */
  private takeBlock(): string | undefined {
    for (let from = 0; ;) {
      const close = this.buffer.indexOf(FENCE_CLOSE, from)
      if (close < 0) return undefined
      this.closed = true
      const raw = this.buffer.slice(0, close).trim()
      if (isJsonObject(raw)) {
        this.buffer = this.buffer.slice(close + FENCE_CLOSE.length)
        return raw
      }
      from = close + FENCE_CLOSE.length
    }
  }

  /**
   * Find the first position before `limit` that is, or may still become, a call written in a syntax
   * other than a `dsh-tool-call` block.
   * @param limit - where the next `dsh-tool-call` opener starts, or the buffer length.
   * @param final - whether the reply has ended, so nothing more can arrive.
   * @returns the position and its verdict, or `undefined` when the text up to `limit` holds none.
   */
  private nextCandidate(
    limit: number,
    final: boolean,
  ): { readonly at: number; readonly verdict: Exclude<Verdict, { kind: 'text' }> } | undefined {
    for (let at = candidateStart(this.buffer, 0); at < limit;) {
      const verdict = this.classify(this.buffer.slice(at), final)
      if (verdict.kind !== 'text') return { at, verdict }
      // Text verdicts are reached once each, because everything before the returned position is
      // released by the caller, so a fence line toggles the block state exactly once.
      if (verdict.fenceLine) this.fenced = !this.fenced
      at = candidateStart(this.buffer, at + verdict.length)
    }
    return undefined
  }

  /** Classify text that starts with `{`, `<`, or three backticks. */
  private classify(text: string, final: boolean): Verdict {
    if (text.startsWith('{')) return this.classifyObject(text, final)
    return text.startsWith('<') ? this.classifyTag(text, final) : this.classifyFence(text, final)
  }

  /**
   * Classify text that starts with `<`.
   *
   * Inside a fenced code block it is text: an answer that explains the XML syntax writes it there.
   * A JSON call is not given that exemption, because a fenced JSON object is a form models do call
   * tools in.
   */
  private classifyTag(text: string, final: boolean): Verdict {
    if (this.fenced) return ONE_CHARACTER
    const reading = readInvokeSyntax(text, this.tools)
    switch (reading.kind) {
      case 'text': return ONE_CHARACTER
      case 'partial': {
        if (this.mayWait(text.length, final)) return { kind: 'pending' }
        // The element can no longer close within bounds. One that names a declared tool is a call
        // the model was writing, so it is rejected whole rather than shown as text.
        return reading.name === undefined
          ? ONE_CHARACTER
          : { kind: 'attempt', attempt: { name: reading.name, length: text.length, syntax: 'invoke', complete: false, acceptable: undefined } }
      }
      case 'complete': return {
        kind: 'attempt',
        attempt: { name: reading.name, length: reading.length, syntax: 'invoke', complete: true, acceptable: reading.call },
      }
    }
  }

  /** Whether a candidate spanning `length` characters may wait for more of the reply. */
  private mayWait(length: number, final: boolean): boolean {
    return !final && length <= this.limits.maxBytes
  }

  /**
   * Classify text that starts with `{`.
   *
   * Only an object that opens with `"name"` or `"arguments"` is ever held, and one that opens with
   * an undeclared `name` is released as soon as that name is complete, so a JSON example in an
   * answer — a `package.json`, say — pauses the stream for one member at most.
   */
  private classifyObject(text: string, final: boolean): Verdict {
    const opening = text.slice(1).trimStart()
    if (!CALL_MEMBERS.some(member => opening.startsWith(member))) {
      const arriving = CALL_MEMBERS.some(member => member.startsWith(opening))
      return arriving && this.mayWait(text.length, final) ? { kind: 'pending' } : ONE_CHARACTER
    }
    const literal = LEADING_NAME.exec(text)?.[1]
    const leading = literal === undefined ? undefined : this.names.get(literal)
    if (literal !== undefined && leading === undefined) return ONE_CHARACTER
    const end = objectEnd(text)
    if (end < 0) {
      if (this.mayWait(text.length, final)) return { kind: 'pending' }
      // The object can no longer close within bounds. One that already names a declared tool is a
      // call the model was writing, so it is rejected whole rather than shown as text.
      return leading === undefined
        ? ONE_CHARACTER
        : { kind: 'attempt', attempt: { name: leading, length: text.length, syntax: 'json', complete: false, acceptable: undefined } }
    }
    const raw = text.slice(0, end + 1)
    const called = this.calledTool(raw)
    if (called === undefined) return ONE_CHARACTER
    // A closing fence after the object belongs to the call: the model wrote the block and left out
    // its opener line. Three backticks that start another opener line do not.
    const tail = text.slice(end + 1).trimStart()
    if (FENCE_CLOSE.startsWith(tail) && this.mayWait(text.length, final)) return { kind: 'pending' }
    const closed = CLOSING_FENCE.test(tail)
    return {
      kind: 'attempt',
      attempt: {
        name: called.name,
        length: closed ? text.length - tail.length + FENCE_CLOSE.length : end + 1,
        syntax: 'json',
        complete: true,
        acceptable: closed && called.exact ? raw : undefined,
      },
    }
  }

  /**
   * Classify text that starts with three backticks and is not the `dsh-tool-call` opener.
   *
   * A fence opener line is held only until the first character under it arrives. It is part of a
   * call when a call object follows directly; otherwise it is ordinary text, and the block under it
   * streams as any other text does.
   */
  private classifyFence(text: string, final: boolean): Verdict {
    const line = OTHER_FENCE_LINE.exec(text)?.[0]
    if (line === undefined) {
      return OTHER_FENCE_PREFIX.test(text) && this.mayWait(text.length, final)
        ? { kind: 'pending' }
        : { kind: 'text', length: FENCE_CLOSE.length, fenceLine: false }
    }
    const body = text.slice(line.length)
    const lead = body.length - body.trimStart().length
    if (lead === body.length && this.mayWait(text.length, final)) return { kind: 'pending' }
    const ordinary: Verdict = { kind: 'text', length: line.length, fenceLine: true }
    if (body[lead] !== '{') return ordinary
    const inner = this.classifyObject(body.slice(lead), final)
    switch (inner.kind) {
      case 'pending': return inner
      case 'text': return ordinary
      case 'attempt': return {
        kind: 'attempt',
        attempt: {
          ...inner.attempt,
          length: line.length + lead + inner.attempt.length,
          acceptable: LENIENT_INFO_STRINGS.has(line.slice(FENCE_CLOSE.length).trim())
            ? inner.attempt.acceptable
            : undefined,
        },
      }
    }
  }

  /**
   * Read a balanced `{…}` text as a call to a declared tool.
   * @param raw - text whose braces balance.
   * @returns the tool it names when it is JSON carrying an `arguments` member, and whether it is
   *   exactly the object the contract asks for: those two members, with object `arguments`.
   */
  private calledTool(raw: string): { readonly name: string; readonly exact: boolean } | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      // Braces balance but the text is not JSON, so no tool could be run from it.
      return undefined
    }
    // `objectEnd` closes only on a balanced `{…}`, so text that parses is always an object.
    const call = parsed as Record<string, unknown>
    const name = call['name']
    if (typeof name !== 'string' || !this.names.has(JSON.stringify(name)) || !('arguments' in call)) {
      return undefined
    }
    return { name, exact: Object.keys(call).length === 2 && isRecord(call['arguments']) }
  }
}

/** One tool call read out of a reply. */
export interface EmulatedCall {
  readonly name: string
  /** JSON arguments text, re-serialized from the object the model wrote. */
  readonly arguments: string
}

/** What one tool-call block turned out to be. */
export type ReadCallResult =
  | { readonly kind: 'call'; readonly call: EmulatedCall }
  | { readonly kind: 'failure'; readonly failure: EmulationFailure }

/**
 * Read one tool-call block against the request's declarations.
 *
 * Structure is checked here; the `parameters` schema is not. The Harness's tool layer owns schema
 * conformance and already reports a violation to the model as a tool result, so the arguments are
 * forwarded exactly as written rather than validated twice by two different validators.
 * @param raw - the JSON text between the fences.
 * @param tools - the tools this request declared.
 * @returns the call, or the named reason it cannot be one.
 */
export function readToolCall(raw: string, tools: readonly ToolSchema[]): ReadCallResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    // Unreachable through ReplyScanner, which only closes a block on parseable JSON, but this
    // function is the one place that states the contract, so it states this part too.
    return {
      kind: 'failure',
      failure: { code: TOOL_CALL_MALFORMED, message: `A tool-call block was not JSON: ${excerpt(raw)}.` },
    }
  }
  if (!isRecord(parsed)) {
    return {
      kind: 'failure',
      failure: {
        code: TOOL_CALL_MALFORMED,
        message: `A tool-call block held ${Array.isArray(parsed) ? 'an array' : 'a non-object'} instead of one JSON object: ${excerpt(raw)}.`,
      },
    }
  }
  const name = parsed['name']
  if (typeof name !== 'string' || name.length === 0) {
    return {
      kind: 'failure',
      failure: {
        code: TOOL_CALL_MALFORMED,
        message: `A tool-call block carried no \`name\` string: ${excerpt(raw)}.`,
      },
    }
  }
  if (!tools.some(tool => tool.name === name)) {
    return {
      kind: 'failure',
      failure: {
        code: TOOL_CALL_UNKNOWN_TOOL,
        message: `No tool named \`${name}\` is available. The available tools are: ${tools.map(tool => tool.name).join(', ')}.`,
      },
    }
  }
  const args = parsed['arguments']
  if (args === undefined || args === null) return { kind: 'call', call: { name, arguments: '{}' } }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return {
      kind: 'failure',
      failure: {
        code: TOOL_CALL_MALFORMED,
        message: `The \`arguments\` of \`${name}\` were not a JSON object: ${excerpt(raw)}.`,
      },
    }
  }
  return { kind: 'call', call: { name, arguments: JSON.stringify(args) } }
}

/** The open output text block being assembled for the consumer. */
interface OpenText {
  readonly index: number
  text: string
}

/**
 * Rewrites one CLI reply's stream so a fenced tool call becomes a real `tool-call` block.
 *
 * Block indexes are reallocated here, because one CLI text block can become any mix of text and
 * tool-call blocks. Reasoning passes through under a stable remapping.
 */
export class ToolCallEmulator {
  /** Set once the reply broke the contract; the terminal finish then names it. */
  failure: EmulationFailure | undefined

  private readonly tools: readonly ToolSchema[]
  private readonly scanner: ReplyScanner
  private readonly remap = new Map<number, number>()
  private nextIndex = 0
  private open: OpenText | undefined
  /**
   * Whitespace the reply opened with, not yet handed over. It is held so a reply that turns out to
   * be one rejected call can still be replaced by a correction run, and it is dropped without being
   * counted when a call follows, since a reply that calls a tool carries no text.
   */
  private lead = ''
  private accepted = 0
  private acceptedLeniently = 0
  private discarded = 0
  private handed = false

  /**
   * @param plan - the prompt plan whose declarations and bounds this reply is read against.
   */
  constructor(plan: Extract<ToolPlan, { kind: 'prompt' }>) {
    this.tools = plan.tools
    this.scanner = new ReplyScanner({ limits: plan.limits, tools: plan.tools, lenient: plan.lenient })
  }

  /** Tool calls accepted from this reply. */
  get calls(): number {
    return this.accepted
  }

  /** Tool calls accepted from a near-miss JSON form or XML element rather than from a `dsh-tool-call` block. */
  get lenientCalls(): number {
    return this.acceptedLeniently
  }

  /** Reply characters dropped because they followed an accepted tool call. */
  get discardedChars(): number {
    return this.discarded
  }

  /**
   * Whether any text chunk has been produced yet.
   *
   * Until it is true the whole reply can still be replaced by a correction run; afterwards the
   * consumer has seen answer text, so a rejection can only be a terminal failure. A tool call does
   * not set it: the caller holds a reply's call chunks until the reply ends, so a later rejection
   * in the same reply still replaces the whole reply and no call runs from a rejected one.
   */
  get committed(): boolean {
    return this.handed
  }

  /**
   * Rewrite one chunk of the CLI's decoded stream.
   * @param chunk - one chunk as the CLI stream decoder produced it.
   * @returns the chunks the consumer should see, possibly none.
   */
  push(chunk: StreamChunk): readonly StreamChunk[] {
    switch (chunk.type) {
      case 'block-start':
        // A text block is opened lazily: what it becomes depends on what its deltas say.
        return chunk.blockType === 'text' ? [] : [{ ...chunk, index: this.mapped(chunk.index) }]
      case 'text-delta':
        return this.segments(this.scanner.push(chunk.text))
      case 'reasoning-delta':
        return [{ ...chunk, index: this.mapped(chunk.index) }]
      case 'block-end':
        return chunk.block.type === 'text'
          ? [...this.segments(this.scanner.finish()), ...this.endText()]
          : [{ ...chunk, index: this.mapped(chunk.index) }]
      case 'finish':
        return [this.terminal(chunk)]
      case 'usage':
      case 'tool-call-delta':
        // `usage` needs no rewriting, and `tool-call-delta` cannot arrive: the CLI reports text,
        // and this class is what turns text into a tool call.
        return [chunk]
    }
  }

  /** Translate the scanner's segments, dropping whatever followed an accepted call. */
  private segments(segments: readonly ReplySegment[]): readonly StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const segment of segments) {
      if (segment.kind === 'text') {
        if (this.accepted > 0) {
          // Text after a call is the model narrating a result it never received. The preamble
          // forbids it and says it is discarded; the session event records how much was dropped.
          this.discarded += segment.text.length
          continue
        }
        chunks.push(...this.emitLedText(segment.text))
        continue
      }
      chunks.push(...this.emitCall(segment.raw))
      if (this.failure !== undefined) break
      if (segment.lenient) this.acceptedLeniently += 1
    }
    this.failure ??= this.scanner.failure
    return chunks
  }

  /** Hand over text, unless it only extends the whitespace the reply opened with. */
  private emitLedText(text: string): readonly StreamChunk[] {
    if (this.handed) return this.emitText(text)
    this.lead += text
    if (this.lead.trim().length === 0) return []
    const led = this.lead
    this.lead = ''
    return this.emitText(led)
  }

  /** Append text to the open output block, opening one when needed. */
  private emitText(text: string): readonly StreamChunk[] {
    this.handed = true
    const open = this.open
    if (open !== undefined) {
      open.text += text
      return [{ type: 'text-delta', index: open.index, text }]
    }
    const index = this.nextIndex
    this.nextIndex += 1
    this.open = { index, text }
    return [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
    ]
  }

  /** Close the open output text block, if there is one. */
  private closeText(): readonly StreamChunk[] {
    const open = this.open
    if (open === undefined) return []
    this.open = undefined
    return [{ type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }]
  }

  /**
   * End one CLI text block: a reply that was whitespace and nothing else is handed over as written,
   * because it is neither a call nor a rejection.
   */
  private endText(): readonly StreamChunk[] {
    const lead = this.lead
    this.lead = ''
    const kept = lead.length > 0 && this.accepted === 0 && this.failure === undefined
    return [...(kept ? this.emitText(lead) : []), ...this.closeText()]
  }

  /** Turn one accepted block into a real tool-call block, or name why it is not one. */
  private emitCall(raw: string): readonly StreamChunk[] {
    const result = readToolCall(raw, this.tools)
    if (result.kind === 'failure') {
      this.failure = result.failure
      return []
    }
    const closing = this.closeText()
    this.lead = ''
    const index = this.nextIndex
    this.nextIndex += 1
    this.accepted += 1
    const id = ToolCallId(`claude-cli-${index}`)
    return [
      ...closing,
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index,
        id,
        name: result.call.name,
        argumentsDelta: result.call.arguments,
      },
      {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: result.call.name, arguments: result.call.arguments },
      },
    ]
  }

  /** Reallocate one CLI block index for a block that passes through unchanged. */
  private mapped(index: number): number {
    const known = this.remap.get(index)
    if (known !== undefined) return known
    const next = this.nextIndex
    this.nextIndex += 1
    this.remap.set(index, next)
    return next
  }

  /** Decide the terminal finish: a rejection names itself, and an accepted call reports itself. */
  private terminal(chunk: Extract<StreamChunk, { type: 'finish' }>): StreamChunk {
    const failure = this.failure
    if (failure !== undefined) {
      return { type: 'finish', reason: { kind: 'error', failure } }
    }
    return this.accepted > 0 && chunk.reason.kind === 'stop'
      ? { type: 'finish', reason: { kind: 'tool-calls' } }
      : chunk
  }
}
