/**
 * Runs the real Claude Code CLI. The signed-in suite self-skips when the CLI is absent or reports
 * no signed-in account, so it is inert in CI and on a machine whose `claude` is signed out. The
 * signed-out suite needs only the executable: it points the CLI at an empty configuration directory
 * it creates, so it never reads or changes a real account.
 *
 * It proves the facts the unit tests can only assert against a script: the CLI answers this
 * package's `list_models` control request, a run with `--tools ""` returns text without a single
 * tool-use block, and a real model reads the emulation preamble and answers with a parseable
 * `dsh-tool-call` block that this package turns into a real tool call.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { notAuthenticatedFailure } from '../src/catalog.ts'
import * as Route from '../src/index.ts'
import { resolveInferenceSpec } from '../src/launch.ts'
import { startCliRun } from '../src/run.ts'
import { projectRequest } from '../src/serialize.ts'
import { claudeCliModelId } from '../src/types.ts'
import { ClaudeCliStreamDecoder } from '../src/wire.ts'

const run = promisify(execFile)

/** Whether the host has a `claude` executable at all, signed in or not. */
async function cliInstalled(): Promise<boolean> {
  try {
    await run('claude', ['--version'], { timeout: 30_000 })
    return true
  }
  catch {
    // Absent or not executable: the signed-out suite has nothing to run.
    return false
  }
}

/** Whether the host `claude` exists and reports a signed-in account. */
async function signedIn(): Promise<boolean> {
  try {
    const { stdout } = await run('claude', ['auth', 'status', '--json'], { timeout: 30_000 })
    const parsed: unknown = JSON.parse(stdout)
    return typeof parsed === 'object' && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true
  }
  catch {
    // Absent, not executable, or not answering: either way this test has nothing to run against.
    return false
  }
}

const available = await signedIn()
const installed = await cliInstalled()
const contexts: Context[] = []
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-e2e-'))
})

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** Mount the route over the real local subprocess seam and the host CLI. */
async function mount(overrides: Partial<Route.Config> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocess)
  // No AI Account provider: `autoActivate` is off so the route registers against the host CLI's own
  // default configuration directory, which is what this machine is signed into.
  await ctx.plugin(Route, Object.assign(
    { autoActivate: false, workingDirectory: join(root, 'cwd') },
    overrides,
  ))
  ctx.llm.registerAdapter(['claude-cli'], adapterOf(ctx, overrides))
  return ctx
}

/** The route's adapter, reached through a second registration because activation is off here. */
function adapterOf(ctx: Context, overrides: Partial<Route.Config>) {
  const catalog = new Route.ClaudeCliCatalog({
    spawn: spec => ctx.subprocess.spawn(spec),
    resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
    cliPath: 'claude',
    extraArgs: [],
    workingDirectory: join(root, 'cwd'),
    authTimeoutMs: 30_000,
    catalogTimeoutMs: 60_000,
    graceMs: 2_000,
    accountHome: () => undefined,
  })
  return new Route.ClaudeCliAdapter({
    catalog,
    displayName: 'Claude (Claude Code CLI)',
    workingDirectory: join(root, 'cwd'),
    requestTimeoutMs: 300_000,
    maxConcurrent: 1,
    graceMs: 2_000,
    spawn: spec => ctx.subprocess.spawn(spec),
    toolCalls: overrides.toolCalls ?? 'prompt',
    toolCallMaxCalls: 4,
    toolCallMaxBytes: 32_768,
    toolCallRetries: overrides.toolCallRetries ?? 1,
    toolCallLenient: overrides.toolCallLenient ?? true,
    recordEmulation: {
      run: (sessionId, record) => { reach(ctx, sessionId).append('llm/cli-tool-emulation', record) },
      reply: (sessionId, record) => { reach(ctx, sessionId).append('llm/cli-tool-emulation-reply', record) },
    },
  })
}

/** The session an emulation record belongs to, which the test created before its request. */
function reach(ctx: Context, sessionId: SessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`no session ${sessionId}`)
  return session
}

/** Call identity shared by the assistant tool call and the tool result answering it. */
const CALL_ID = ToolCallId('dsh-e2e-call-1')

/** A small, realistic tool set for the emulated turn. */
const TOOLS: readonly ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace and return its contents.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the file.' } },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description: 'Run one shell command and return its combined output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command', 'description'],
    },
  },
]

describe.skipIf(!available)('llm-claude-cli against the installed Claude Code CLI', () => {
  it('lists models from the CLI own control request, never from a model API', async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels('claude-cli')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.id.length > 0)).toBe(true)
  }, 120_000)

  it('answers a text request with no tool use at all', async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels('claude-cli')
    const haiku = models.find(model => model.id === 'haiku') ?? models[0]
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: haiku?.id ?? 'haiku',
      system: 'Answer with exactly the word asked for and nothing else.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
    })) chunks.push(chunk)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    expect(text).toContain('PONG')
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.outputTokens).toBeGreaterThan(0)
  }, 300_000)

  it('refuses a request that declares tools when configured to refuse rather than emulate', async () => {
    const ctx = await mount({ toolCalls: 'refuse' })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: 'haiku',
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read README.md' }] }],
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
    // The message rather than the code: the e2e program resolves its own copy of the error class, so
    // `normalizeLlmFailure` cannot recognize the Harness taxonomy here. `plugin.spec.ts` pins the code.
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.message)
      .toMatch(/no caller-supplied tool definitions/)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
  }, 120_000)

  it('reads a real tool call out of a real model reply, and logs the run that carried the preamble', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create()
    const request: GenerateOptions = {
      provider: 'claude-cli',
      model: 'sonnet',
      tools: [...TOOLS],
      messages: [
        createSystemMessage('You are DeepSeek Harness, a coding agent. Use a tool when one is needed.'),
        { role: 'user', content: [{ type: 'text', text: 'Read the file /etc/hosts and tell me its first line.' }] },
      ],
      sessionId: session.id,
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk)
    const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(call?.type === 'tool-call-delta' && call.name).toBe('read_file')
    const args = call?.type === 'tool-call-delta'
      ? JSON.parse(call.argumentsDelta) as { path?: string }
      : {}
    expect(args.path).toBe('/etc/hosts')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const logged = session.snapshotEvents().filter(event => event.type === 'llm/cli-tool-emulation')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data)
      .toMatchObject({ template: Route.PREAMBLE_TEMPLATE, tools: ['read_file', 'bash'], attempt: 1 })
    // A model that follows the contract is read from the fence, never leniently.
    const read = session.snapshotEvents().filter(event => event.type === 'llm/cli-tool-emulation-reply')
    expect(read.map(event => event.data)).toEqual([{
      provider: 'claude-cli',
      model: 'sonnet',
      attempt: 1,
      calls: 1,
      lenientCalls: 0,
      discardedChars: expect.any(Number) as number,
    }])
  }, 300_000)

  it('answers from a tool result it is handed, so a second loop step completes', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: 'sonnet',
      tools: [...TOOLS],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read /etc/hosts and tell me its first line, verbatim.' }] },
        createAssistantMessage({
          content: [{ type: 'tool-call', id: CALL_ID, name: 'read_file', arguments: '{"path":"/etc/hosts"}' }],
          source: { provider: 'claude-cli', model: 'sonnet' },
        }),
        createToolResultMessage({
          callId: CALL_ID,
          content: [{ type: 'text', text: '1\u2192# DSH-E2E-MARKER' }],
          isError: false,
        }),
      ],
      sessionId: session.id,
    })) chunks.push(chunk)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    expect(text).toContain('DSH-E2E-MARKER')
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  }, 300_000)
})

describe.skipIf(!installed)('llm-claude-cli against a signed-out configuration directory', () => {
  /** An empty directory the CLI has never signed in to. */
  async function emptyAccountHome(): Promise<string> {
    const home = join(root, 'signed-out-home')
    await mkdir(home, { recursive: true })
    return home
  }

  it('refuses to list models with the named error that says where to sign in', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocess)
    const accountHome = await emptyAccountHome()
    const catalog = new Route.ClaudeCliCatalog({
      spawn: spec => ctx.subprocess.spawn(spec),
      resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
      cliPath: 'claude',
      extraArgs: [],
      workingDirectory: join(root, 'cwd'),
      authTimeoutMs: 30_000,
      catalogTimeoutMs: 60_000,
      graceMs: 2_000,
      accountHome: () => accountHome,
    })
    await expect(catalog.rows()).rejects.toMatchObject(notAuthenticatedFailure(accountHome))
  }, 120_000)

  it('names the signed-out account when an inference run itself reports the missing login', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocess)
    const accountHome = await emptyAccountHome()
    const cwd = join(root, 'cwd')
    await mkdir(cwd, { recursive: true })
    const projected = projectRequest(
      [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
      'Answer with exactly the word asked for and nothing else.',
      undefined,
      undefined,
    )
    // The catalog probe is skipped on purpose: it asks `auth status` first and would refuse before
    // a run starts. This is the run a route makes once its catalog is cached and the login lapses.
    const spec = resolveInferenceSpec(
      { executable: 'claude', extraArgs: [], accountHome },
      { model: claudeCliModelId('haiku'), system: projected.system, sessionId: randomUUID() },
    )
    const cli = startCliRun(
      { spawn: child => ctx.subprocess.spawn(child), cwd, graceMs: 2_000 },
      { ...spec, stdinPayload: projected.stdinPayload },
      AbortSignal.timeout(90_000),
    )
    const chunks: StreamChunk[] = []
    try {
      const decoder = new ClaudeCliStreamDecoder(notAuthenticatedFailure(accountHome))
      for await (const line of cli.lines()) {
        chunks.push(...decoder.push(line))
        if (decoder.resultSeen) break
      }
    }
    finally {
      await cli.dispose()
    }
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected an error finish')
    expect(finish.reason.failure.code).toBe(Route.CLI_NOT_AUTHENTICATED)
    expect(finish.reason.failure.message).toBe(
      `${notAuthenticatedFailure(accountHome).message} The CLI reported: Not logged in · Please run /login`,
    )
  }, 120_000)
})
