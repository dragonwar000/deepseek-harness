/**
 * The Harness's own agent loop, driven end to end by a real Claude subscription over the CLI.
 *
 * This is the claim prompt-level tool emulation exists to support: the model reads tools it was
 * never handed through an API field, reports a call as text, the Harness's tool registry executes
 * it, and the next step answers from the real result. Self-skips when the installed `claude` is
 * absent or reports no signed-in account, so it is inert in CI.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-loop-'))
  await writeFile(join(root, 'marker.txt'), 'DSH-LOOP-MARKER-7431\n')
})

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** The session an emulation record belongs to, which this test created through the loop. */
function reach(ctx: Context, sessionId: SessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`no session ${sessionId}`)
  return session
}

/** Mount the production loop with one real tool and the CLI-backed model route. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocess)
  const cwd = join(root, 'cwd')
  const catalog = new Route.ClaudeCliCatalog({
    spawn: spec => ctx.subprocess.spawn(spec),
    resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
    cliPath: 'claude',
    extraArgs: [],
    workingDirectory: cwd,
    authTimeoutMs: 30_000,
    catalogTimeoutMs: 60_000,
    graceMs: 2_000,
    // No AI Account provider here, so the CLI runs against its own default configuration
    // directory, which is the login this machine already has.
    accountHome: () => undefined,
  })
  ctx.llm.registerAdapter(['claude-cli'], new Route.ClaudeCliAdapter({
    catalog,
    displayName: 'Claude (Claude Code CLI)',
    workingDirectory: cwd,
    requestTimeoutMs: 300_000,
    maxConcurrent: 1,
    graceMs: 2_000,
    spawn: spec => ctx.subprocess.spawn(spec),
    toolCalls: 'prompt',
    toolCallMaxCalls: 4,
    toolCallMaxBytes: 32_768,
    toolCallRetries: 1,
    toolCallLenient: true,
    recordEmulation: {
      run: (sessionId, record) => { reach(ctx, sessionId).append('llm/cli-tool-emulation', record) },
      reply: (sessionId, record) => { reach(ctx, sessionId).append('llm/cli-tool-emulation-reply', record) },
    },
  }))
  ctx.tools.register(defineTool({
    name: 'read_marker_file',
    description: 'Read the contents of one file in the workspace.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the file to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { contents: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.contents }],
    },
    async execute(args) {
      const { readFile } = await import('node:fs/promises')
      return { contents: await readFile(args.path, 'utf8') }
    },
  }))
  return ctx
}

describe.skipIf(!available)('llm-claude-cli driving the production agent loop', () => {
  it('runs a real tool the model called through the prompt, then answers from its result', async () => {
    const ctx = await mount()
    const loop = await mountAgentLoopTestHarness(ctx)
    const agent = await loop.create(
      `claude-cli-loop-${Date.now()}` as SessionId,
      { provider: 'claude-cli', model: 'sonnet' },
      { cwd: root },
    )
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `Read the file ${join(root, 'marker.txt')} with the read_marker_file tool and reply with exactly the marker string it contains.`,
      }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const call = events.find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && call.data.name).toBe('read_marker_file')
    expect(events.some(event => event.type === 'tool/result')).toBe(true)
    const emulated = events.filter(event => event.type === 'llm/cli-tool-emulation')
    // One record per CLI run: the call step and the answering step, plus any correction run.
    expect(emulated.length).toBeGreaterThanOrEqual(2)
    expect(emulated[0]?.data.tools).toContain('read_marker_file')
    // The production loop drains each stream to its end, so every run's reply is logged after it.
    const read = events.filter(event => event.type === 'llm/cli-tool-emulation-reply')
    expect(read).toHaveLength(emulated.length)
    expect(read.reduce((calls, event) => calls + event.data.calls, 0)).toBe(1)
    const answers = events.filter(event => event.type === 'assistant/message')
    const text = answers.at(-1)?.type === 'assistant/message'
      ? answers.at(-1)?.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      : ''
    expect(text).toContain('DSH-LOOP-MARKER-7431')
  }, 600_000)
})
