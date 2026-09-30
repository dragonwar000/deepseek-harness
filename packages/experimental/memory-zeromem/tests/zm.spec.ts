import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { callZeromem, zmArgv, ZeromemProcessError, ZeromemToolError } from '../src/zm.ts'
import type { SpawnChild, ZmOperationSpec } from '../src/zm.ts'
import { cleanup, FAKE_ZM, tempRoot } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  await cleanup()
})

/** The local subprocess provider's spawn. */
async function localSpawn(): Promise<SpawnChild> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  return spec => ctx.subprocess.spawn(spec)
}

/** An operation on a fresh store running the scripted zm in one mode. */
function operation(mode: string, overrides: Partial<ZmOperationSpec> = {}): ZmOperationSpec {
  const { root } = tempRoot()
  return { command: [process.execPath, FAKE_ZM, '--fake-mode', mode], hashEmbedder: false, home: root, timeoutMs: 30_000, graceMs: 500, ...overrides }
}

/** Run one call and return its rejection. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call
  } catch (error) {
    return error as Error
  }
  throw new Error('the call succeeded')
}

describe('callZeromem with the scripted zm', () => {
  it('returns the parsed result of a tool call', async () => {
    const spawn = await localSpawn()
    const value = await callZeromem(spawn, operation('normal'), 'zeromem_stats', {}, new AbortController().signal)
    expect(value).toMatchObject({ turns: 0, sessions: 0, embedder_is_fallback: false })
  })

  it.each([
    ['impostor', ZeromemProcessError, 'did not answer as a zeromem MCP server (server name: other-server)'],
    ['silent', ZeromemProcessError, 'exited without answering zeromem_stats'],
    ['rpc-error', ZeromemProcessError, 'zm refused zeromem_stats: method not found: tools/call'],
    ['bad-result', ZeromemProcessError, 'zm answered zeromem_stats with an unexpected result'],
    ['not-json', ZeromemProcessError, 'zm answered zeromem_stats with text that is not JSON'],
    ['tool-error', ZeromemToolError, 'store is corrupt'],
    ['exit', ZeromemProcessError, 'exited with code 3; zm stderr: zm: database is locked'],
  ] as const)('reports mode %s as a named error', async (mode, type, message) => {
    const spawn = await localSpawn()
    const error = await failureOf(callZeromem(spawn, operation(mode), 'zeromem_stats', {}, new AbortController().signal))
    expect(error).toBeInstanceOf(type)
    expect(error.message).toContain(message)
    expect(error.name).toBe(type.name)
  })

  it('stops a zm that does not answer within timeoutMs', async () => {
    const spawn = await localSpawn()
    const error = await failureOf(callZeromem(spawn, operation('hang', { timeoutMs: 300 }), 'zeromem_stats', {}, new AbortController().signal))
    expect(error.message).toMatch(/did not answer within 300 ms/)
  })

  it('stops a zm whose caller cancelled', async () => {
    const spawn = await localSpawn()
    const controller = new AbortController()
    const call = callZeromem(spawn, operation('hang'), 'zeromem_stats', {}, controller.signal)
    setTimeout(() => { controller.abort() }, 200)
    expect((await failureOf(call)).message).toMatch(/was cancelled/)
  })

  it('places --no-model before the mcp command for the hash embedder', () => {
    expect(zmArgv({ command: ['/bin/zm', '--x'], hashEmbedder: true, home: '/h', timeoutMs: 1, graceMs: 1 })).toEqual(['/bin/zm', '--x', '--no-model', 'mcp', '--home', '/h'])
    expect(zmArgv({ command: ['/bin/zm'], hashEmbedder: false, home: '/h', timeoutMs: 1, graceMs: 1 })).toEqual(['/bin/zm', 'mcp', '--home', '/h'])
  })
})

/** A scripted handle: stdout lines, a settled outcome or failure, and stderr text. */
function scriptedHandle(lines: readonly string[], done: Promise<SubprocessOutcome>, stderr = ''): SubprocessHandle {
  void done.catch((error: unknown) => { void error })
  return {
    stdin: new PassThrough(),
    stdout: Readable.from(lines.map(line => `${line}\n`)),
    stderr: undefined,
    control: undefined,
    collected: { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) } },
    done,
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

const SPEC: ZmOperationSpec = { command: ['/opt/zm'], hashEmbedder: true, home: '/tmp', timeoutMs: 1000, graceMs: 100 }
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'zeromem' } } })

describe('callZeromem with a scripted handle', () => {
  it('reports a spawn the seam refused', async () => {
    const spawn: SpawnChild = () => { throw new Error('EACCES') }
    const error = await failureOf(callZeromem(spawn, SPEC, 'zeromem_stats', {}, new AbortController().signal))
    expect(error).toBeInstanceOf(ZeromemProcessError)
    expect(error.message).toBe('could not start /opt/zm: EACCES')
  })

  it('reports a process that failed to run, with stderr', async () => {
    const spawn: SpawnChild = (spec: SubprocessSpawnSpec) => {
      expect(spec.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } })
      return scriptedHandle([], Promise.reject(new Error('spawn ENOENT')), 'boom')
    }
    const error = await failureOf(callZeromem(spawn, SPEC, 'zeromem_stats', {}, new AbortController().signal))
    expect(error.message).toBe('could not run /opt/zm: spawn ENOENT; zm stderr: boom')
  })

  it('reports a process killed by a signal, ignoring lines that are not responses', async () => {
    const spawn: SpawnChild = () => scriptedHandle([INIT, 'not json', '{"id":"x"}'], Promise.resolve({ exitCode: null, signal: 'SIGKILL' }))
    const error = await failureOf(callZeromem(spawn, SPEC, 'zeromem_stats', {}, new AbortController().signal))
    expect(error.message).toBe('/opt/zm exited with signal SIGKILL')
  })

  it('reports a process that never answered initialize, after a closed stdin pipe', async () => {
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }], isError: false } })
    const spawn: SpawnChild = () => {
      const handle = scriptedHandle([call], Promise.resolve({ exitCode: 0, signal: null }))
      handle.stdin?.on('finish', () => handle.stdin?.emit('error', new Error('EPIPE')))
      return handle
    }
    const error = await failureOf(callZeromem(spawn, SPEC, 'zeromem_stats', {}, new AbortController().signal))
    expect(error.message).toBe('/opt/zm did not answer as a zeromem MCP server (server name: none)')
  })

  it('reads a final line without a terminator', async () => {
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } })
    const spawn: SpawnChild = () => ({ ...scriptedHandle([], Promise.resolve({ exitCode: 0, signal: null })), stdout: Readable.from([`${INIT}\n`, call]) })
    expect(await callZeromem(spawn, SPEC, 'zeromem_stats', {}, new AbortController().signal)).toEqual({ ok: true })
  })
})
