/**
 * Runs the real Claude Code CLI. Self-skips when the CLI is absent or reports no signed-in account,
 * so it is inert in CI and on a machine whose `claude` is signed out.
 *
 * It proves the two facts the unit tests can only assert against a script: the CLI answers this
 * package's `list_models` control request, and a run with `--tools ""` returns text without a single
 * tool-use block.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Route from '../src/index.ts'

const run = promisify(execFile)

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
async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocess)
  // No AI Account provider: `autoActivate` is off so the route registers against the host CLI's own
  // default configuration directory, which is what this machine is signed into.
  await ctx.plugin(Route, { autoActivate: false, workingDirectory: join(root, 'cwd') })
  ctx.llm.registerAdapter(['claude-cli'], adapterOf(ctx))
  return ctx
}

/** The route's adapter, reached through a second registration because activation is off here. */
function adapterOf(ctx: Context) {
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
    providerName: 'claude-cli',
    displayName: 'Claude (Claude Code CLI)',
    workingDirectory: join(root, 'cwd'),
    requestTimeoutMs: 300_000,
    maxConcurrent: 1,
    graceMs: 2_000,
    spawn: spec => ctx.subprocess.spawn(spec),
  })
}

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

  it('refuses a request that declares tools rather than dropping the declarations', async () => {
    const ctx = await mount()
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
})
