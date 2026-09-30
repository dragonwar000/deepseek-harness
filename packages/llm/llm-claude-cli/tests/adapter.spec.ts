import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter, TOOL_CALLS_UNSUPPORTED, UNKNOWN_MODEL } from '../src/adapter.ts'
import { ClaudeCliCatalog } from '../src/catalog.ts'
import { FakeCli, streamLines } from './harness.ts'
import type { FakeCliScript } from './harness.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-adapter-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One user turn with the given text. */
function user(text: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** An adapter over a scripted CLI. */
function build(script: FakeCliScript = {}, overrides: { readonly maxConcurrent?: number } = {}) {
  const cli = new FakeCli(script)
  const shared = {
    spawn: cli.spawn,
    workingDirectory: join(root, 'cwd'),
    graceMs: 10,
  }
  const catalog = new ClaudeCliCatalog({
    ...shared,
    resolveExecutable: cli.resolveExecutable,
    cliPath: 'claude',
    extraArgs: [],
    authTimeoutMs: 400,
    catalogTimeoutMs: 400,
    accountHome: () => '/accounts/claude/one',
  })
  const adapter = new ClaudeCliAdapter({
    ...shared,
    catalog,
    providerName: 'claude-cli',
    displayName: 'Claude (Claude Code CLI)',
    requestTimeoutMs: 400,
    maxConcurrent: overrides.maxConcurrent ?? 2,
  })
  return { cli, catalog, adapter }
}

/** A minimal request over this route. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'claude-cli', model: 'opus', messages: [user('hello')], ...overrides }
}

/** Drain one stream into an array. */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

/** Await a rejection and return it as an LlmError. */
async function rejection(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(() => undefined, (value: unknown) => value)
  if (!(error instanceof LlmError)) throw new Error(`expected an LlmError, got ${String(error)}`)
  return error
}

describe('ClaudeCliAdapter.providerInfo', () => {
  it('describes the route with the configured display name', () => {
    expect(build().adapter.providerInfo('claude-cli'))
      .toEqual({ id: 'claude-cli', name: 'Claude (Claude Code CLI)' })
  })
})

describe('ClaudeCliAdapter.listModels', () => {
  it('advertises the CLI models with the CLI own names and descriptions', async () => {
    const models = await build().adapter.listModels('claude-cli')
    expect(models).toEqual([
      {
        provider: 'claude-cli',
        id: 'opus',
        name: 'Opus 5.5',
        description: 'For complex work and everyday tasks',
        inputModalities: ['text'],
      },
      { provider: 'claude-cli', id: 'haiku', name: 'Haiku 4.5', inputModalities: ['text'] },
    ])
  })

  it('throws rather than listing nothing, so the picker shows the reason', async () => {
    const error = await rejection(build({ catalog: () => undefined }).adapter.listModels('claude-cli'))
    expect(error.message).toMatch(/listed no models/)
  })
})

describe('ClaudeCliAdapter.resolveModel', () => {
  it('reports the effort levels the CLI declared for the model', async () => {
    expect(await build().adapter.resolveModel('claude-cli', 'opus')).toEqual({
      provider: 'claude-cli',
      id: 'opus',
      name: 'Opus 5.5',
      description: 'For complex work and everyday tasks',
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
  })

  it('omits reasoning for a model the CLI reported no efforts for', async () => {
    const resolved = await build().adapter.resolveModel('claude-cli', 'haiku')
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.name).toBe('Haiku 4.5')
  })

  it('names an id the CLI does not list, and the ids it does', async () => {
    const error = await rejection(build().adapter.resolveModel('claude-cli', 'gpt-6'))
    expect(error.code).toBe(UNKNOWN_MODEL)
    expect(error.message).toMatch(/opus, haiku/)
  })
})

describe('ClaudeCliAdapter.stream', () => {
  it('refuses a request that declares tools, naming the limit and the alternative', () => {
    const { adapter } = build()
    let thrown: unknown
    try {
      adapter.stream(request({ tools: [{ name: 'read', description: 'read', parameters: {} }] }))
    }
    catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).code).toBe(TOOL_CALLS_UNSUPPORTED)
    expect((thrown as LlmError).message).toMatch(/no caller-supplied tool definitions/)
    expect((thrown as LlmError).message).toMatch(/API-key model route/)
  })

  it('accepts a request whose tools array is empty', async () => {
    const chunks = await collect(build().adapter.stream(request({ tools: [] })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams the text and the usage of one CLI run', async () => {
    const chunks = await collect(build({ inference: () => streamLines('Three items.') }).adapter.stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['Three items.'])
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('writes the request as one stream-json user turn, since the CLI ignores injected assistant turns', async () => {
    const { cli, adapter } = build()
    await collect(adapter.stream(request({
      messages: [user('first'), { role: 'user', content: [{ type: 'text', text: 'second' }] }],
    })))
    const written = cli.callsOf('inference')[0]?.stdin ?? ''
    const parsed = JSON.parse(written.trim()) as { type: string; message: { content: { text: string }[] } }
    expect(parsed.type).toBe('user')
    expect(parsed.message.content[0]?.text).toBe('User: first\n\nUser: second')
  })

  it('sends a single-message request verbatim, with no transcript wrapper', async () => {
    const { cli, adapter } = build()
    await collect(adapter.stream(request({ messages: [user('just this')] })))
    const parsed = JSON.parse((cli.callsOf('inference')[0]?.stdin ?? '').trim()) as { message: { content: { text: string }[] } }
    expect(parsed.message.content[0]?.text).toBe('just this')
  })

  it('substitutes the harness system prompt for the CLI own', async () => {
    const { cli, adapter } = build()
    await collect(adapter.stream(request({ system: 'You are a build assistant.' })))
    const argv = cli.callsOf('inference')[0]?.spec.argv ?? []
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You are a build assistant.')
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
  })

  it('never writes an Anthropic credential into the child environment', async () => {
    const { cli, adapter } = build()
    await collect(adapter.stream(request()))
    for (const spawn of cli.spawns) {
      // Only the account directory is ever set, and the version probe names not even that.
      expect(Object.keys(spawn.spec.env ?? {}))
        .toEqual(spawn.call === 'version' ? [] : ['CLAUDE_CONFIG_DIR'])
    }
  })

  it('gives every run its own session id', async () => {
    const { cli, adapter } = build()
    await collect(adapter.stream(request()))
    await collect(adapter.stream(request()))
    const ids = cli.callsOf('inference').map((spawn) => {
      const argv = spawn.spec.argv
      return argv[argv.indexOf('--session-id') + 1]
    })
    expect(ids[0]).not.toBe(ids[1])
    expect(cli.callsOf('inference')[0]?.spec.argv).toContain('--no-session-persistence')
  })

  it('refuses a model the CLI does not list before it spawns a child', async () => {
    const { cli, adapter } = build()
    const error = await rejection(collect(adapter.stream(request({ model: 'gpt-6' }))))
    expect(error.code).toBe(UNKNOWN_MODEL)
    expect(cli.callsOf('inference')).toHaveLength(0)
  })

  it('refuses a request with no text to send', async () => {
    const { adapter } = build()
    await expect(collect(adapter.stream(request({ messages: [user('   ')] }))))
      .rejects.toThrow(/no text/)
  })

  it('caps concurrent CLI children at maxConcurrent', async () => {
    const { cli, adapter } = build({}, { maxConcurrent: 1 })
    // Warm the catalog so the counted spawns are only inference children.
    await adapter.listModels('claude-cli')
    const runs = [request(), request(), request()].map(async (options) => {
      for await (const chunk of adapter.stream(options)) {
        // With a limit of one, no other inference child may be alive while this one streams.
        expect(cli.callsOf('inference').filter(spawn => spawn.terminateCalls === 0)).toHaveLength(1)
        expect(chunk.type.length).toBeGreaterThan(0)
      }
    })
    await Promise.all(runs)
    expect(cli.callsOf('inference')).toHaveLength(3)
  })

  it('never lets the slot count dip while it hands a slot to a waiter', async () => {
    const { cli, adapter } = build({}, { maxConcurrent: 1 })
    await adapter.listModels('claude-cli')
    // A run started in the same turn as another finishing must still wait for the slot.
    const first = collect(adapter.stream(request()))
    const second = collect(adapter.stream(request()))
    const third = collect(adapter.stream(request()))
    await Promise.all([first, second, third])
    expect(cli.callsOf('inference')).toHaveLength(3)
    for (const spawn of cli.callsOf('inference')) expect(spawn.terminateCalls).toBe(1)
  })

  it('ends the run, names the truncation, and joins the child when the deadline elapses', async () => {
    const { cli, adapter } = build({ hang: ['inference'] })
    const chunks = await collect(adapter.stream(request()))
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.message)
      .toMatch(/exited before it reported a result/)
    expect(cli.callsOf('inference')[0]?.terminateCalls).toBe(1)
    expect(cli.callsOf('inference')[0]?.doneAwaited).toBe(true)
  })

  it('ends the run when the caller aborts', async () => {
    const controller = new AbortController()
    const { cli, adapter } = build({ hang: ['inference'] })
    // Warm the catalog first, so the abort lands on the inference child rather than on a probe.
    await adapter.listModels('claude-cli')
    const pending = collect(adapter.stream(request({ signal: controller.signal })))
    await Promise.resolve()
    controller.abort()
    const finish = (await pending).at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
    expect(cli.callsOf('inference')[0]?.terminateCalls).toBe(1)
    expect(cli.callsOf('inference')[0]?.spec.signal?.aborted).toBe(true)
  })

  it('refuses before spawning when the caller has already aborted', async () => {
    const { cli, adapter } = build()
    const error = await rejection(collect(adapter.stream(request({ signal: AbortSignal.abort() }))))
    expect(error.code).toBe('CLI_NOT_AUTHENTICATED')
    expect(cli.callsOf('inference')).toHaveLength(0)
  })

  it('quotes the CLI stderr tail in a truncation failure', async () => {
    const { adapter } = build({ hang: ['inference'], stderr: 'claude: out of memory' })
    const finish = (await collect(adapter.stream(request()))).at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.message)
      .toMatch(/claude: out of memory/)
  })

  it('reports the CLI own error result and stops reading after it', async () => {
    const { cli, adapter } = build({
      inference: () => [
        '{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":null}',
        '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}',
      ],
    })
    const chunks = await collect(adapter.stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.message)
      .toMatch(/error_max_turns/)
    expect(cli.callsOf('inference')[0]?.terminateCalls).toBe(1)
  })
})
