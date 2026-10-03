/**
 * One zeromem operation as one `zm mcp` process, spawned through the
 * subprocess seam and always torn down. The process receives the MCP
 * `initialize` request, the `notifications/initialized` notification, and one
 * `tools/call` request on stdin, then end of input; `zm` answers each request
 * on one stdout line and exits at end of input. Before every tool call `zm`
 * ingests the store's pending spool files, so an operation also stores every
 * turn spooled before it.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/zm
 */

import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'

/** Bytes of `zm` stderr kept for a failure message. */
const STDERR_LIMIT_BYTES = 8 * 1024
/** MCP request ids of the two requests one operation sends. */
const INITIALIZE_ID = 1
const CALL_ID = 2
/** Code stamped on the timeout reason of one operation. */
const TIMEOUT_CODE = 'memory-zeromem/timeout'

/** The zeromem MCP tools this package calls. */
export type ZeromemTool = 'zeromem_recall' | 'zeromem_stats' | 'zeromem_forget_session'

/** The spawn function of the subprocess seam, taken structurally so tests can pass a scripted stand-in. */
export type SpawnChild = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** A fully resolved operation: the `zm` command line prefix, the store, and its limits. */
export interface ZmOperationSpec {
  /** Resolved executable followed by the configured leading arguments. */
  readonly command: readonly string[]
  /** Adds zeromem's `--no-model` flag, which selects its hash embedder. */
  readonly hashEmbedder: boolean
  /** The store directory, passed as `--home` and used as the working directory. */
  readonly home: string
  readonly timeoutMs: number
  readonly graceMs: number
}

/** A tool result and the `zm` stderr text of the operation. */
export interface ZmAnswer {
  /** The tool result, parsed from zeromem's JSON text. */
  readonly value: unknown
  /** Trimmed stderr text, empty when `zm` wrote none; zeromem reports an embedder load failure there. */
  readonly stderr: string
}

/** `zm` could not be run, did not answer, answered as another program, or exited with a failure. */
export class ZeromemProcessError extends Error {
  /** @param message - what failed, with the `zm` stderr tail when there is one. */
  constructor(message: string) {
    super(message)
    this.name = 'ZeromemProcessError'
  }
}

/** `zm` ran and refused the operation; the message is zeromem's own. */
export class ZeromemToolError extends Error {
  /** @param message - zeromem's error text. */
  constructor(message: string) {
    super(message)
    this.name = 'ZeromemToolError'
  }
}

const responseSchema = z.looseObject({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
})

const initializeSchema = z.looseObject({ serverInfo: z.looseObject({ name: z.string() }) })

const callResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.literal('text'), text: z.string() })).min(1),
  isError: z.boolean(),
})

/**
 * The argv of one operation.
 * @param spec - the resolved operation.
 * @returns the command line.
 */
export function zmArgv(spec: ZmOperationSpec): string[] {
  return [...spec.command, ...spec.hashEmbedder ? ['--no-model'] : [], 'mcp', '--home', spec.home]
}

/**
 * Complete lines of a byte stream.
 * @param stream - the child's stdout.
 * @yields each line without its terminator.
 */
async function* linesOf(stream: Readable): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += String(chunk)
    let end = buffer.indexOf('\n')
    while (end !== -1) {
      yield buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      end = buffer.indexOf('\n')
    }
  }
  if (buffer !== '') yield buffer
}

/**
 * Parse one stdout line as a JSON-RPC response.
 * @param line - one line `zm` wrote.
 * @returns the response, or `undefined` for a line that is not one.
 */
function responseOf(line: string): z.infer<typeof responseSchema> | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    // A line that is not JSON is not a response; zeromem writes diagnostics to stderr, not stdout.
    void error
    return undefined
  }
  const parsed = responseSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Run one zeromem tool in a fresh `zm mcp` process.
 * @param spawn - the subprocess seam's spawn.
 * @param spec - the resolved operation.
 * @param tool - the zeromem tool.
 * @param args - the tool arguments.
 * @param signal - the caller's cancellation.
 * @returns the tool result with the `zm` stderr text.
 * @throws ZeromemProcessError when `zm` fails, times out, or answers as another program.
 * @throws ZeromemToolError when zeromem refuses the call.
 */
export async function callZeromem(
  spawn: SpawnChild,
  spec: ZmOperationSpec,
  tool: ZeromemTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ZmAnswer> {
  const argv = zmArgv(spec)
  using limit = deadline(signal, spec.timeoutMs, TIMEOUT_CODE)
  let handle: SubprocessHandle
  try {
    handle = spawn({
      argv,
      cwd: spec.home,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: STDERR_LIMIT_BYTES } },
      graceMs: spec.graceMs,
      env: {},
      signal: limit.signal,
    })
  } catch (error) {
    throw new ZeromemProcessError(`could not start ${argv[0]}: ${(error as Error).message}`)
  }
  const { stdin, stdout } = handle
  const stderrReader = handle.collected.stderr
  /* v8 ignore next 3 -- the dispositions above always produce piped stdin and stdout and a collected stderr */
  if (stdin === undefined || stdout === undefined || stderrReader === undefined) {
    throw new ZeromemProcessError('the subprocess seam provided no stdin, stdout, or stderr for zm')
  }
  // A zm that exits before reading closes the pipe; the exit outcome reports that failure.
  stdin.on('error', (error) => { void error })
  stdin.end([
    { jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-memory-zeromem', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: CALL_ID, method: 'tools/call', params: { name: tool, arguments: args } },
  ].map(message => `${JSON.stringify(message)}\n`).join(''))

  const stderr = (): string => stderrReader.readFrom(0).text.trim()
  const failure = (what: string): ZeromemProcessError => {
    const tail = stderr()
    return new ZeromemProcessError(tail === '' ? what : `${what}; zm stderr: ${tail}`)
  }
  let server: string | undefined
  let response: z.infer<typeof responseSchema> | undefined
  try {
    for await (const line of linesOf(stdout)) {
      const message = responseOf(line)
      if (message?.id === INITIALIZE_ID) server = initializeSchema.safeParse(message.result).data?.serverInfo.name
      else if (message?.id === CALL_ID) response = message
    }
    const outcome = await handle.done
    if (timeoutOf(limit.signal) !== undefined) throw failure(`${argv[0]} did not answer within ${spec.timeoutMs} ms`)
    if (signal.aborted) throw failure(`${argv[0]} was cancelled`)
    if (outcome.exitCode !== 0) throw failure(`${argv[0]} exited with ${outcome.exitCode === null ? `signal ${outcome.signal}` : `code ${outcome.exitCode}`}`)
  } catch (error) {
    if (error instanceof ZeromemProcessError) throw error
    throw failure(`could not run ${argv[0]}: ${(error as Error).message}`)
  } finally {
    handle.terminate()
    await handle.waitForExit()
    await handle.done.catch((error: unknown) => { void error })
  }
  if (server !== 'zeromem') throw failure(`${argv[0]} did not answer as a zeromem MCP server (server name: ${server ?? 'none'})`)
  if (response === undefined) throw failure(`${argv[0]} exited without answering ${tool}`)
  if (response.error !== undefined) throw new ZeromemProcessError(`zm refused ${tool}: ${response.error.message}`)
  const result = callResultSchema.safeParse(response.result)
  if (!result.success) throw new ZeromemProcessError(`zm answered ${tool} with an unexpected result`)
  const text = result.data.content.map(block => block.text).join('')
  if (result.data.isError) throw new ZeromemToolError(text)
  try {
    return { value: JSON.parse(text) as unknown, stderr: stderr() }
  } catch (error) {
    throw new ZeromemProcessError(`zm answered ${tool} with text that is not JSON: ${(error as Error).message}`)
  }
}
