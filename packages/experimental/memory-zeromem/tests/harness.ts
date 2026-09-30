/** Agent-level harness: the real local subprocess provider running the scripted `zm`, driven by a scripted model. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as MemoryZeromem from '../src/index.ts'
import type { Config, SpoolTurn } from '../src/index.ts'
import { resolveStore, ZEROMEM_MODEL_FILES, ZEROMEM_MODEL_FOLDER } from '../src/index.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The scripted `zm` entry file. */
export const FAKE_ZM = fileURLToPath(new URL('./fake-zm.mjs', import.meta.url))

const roots: string[] = []
const contexts: Context[] = []

/** Dispose every booted context, then remove every temporary directory. */
export async function cleanup(): Promise<void> {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
}

/** Harness options. */
export interface BootOptions {
  /** Plugin settings merged over the harness defaults. */
  config?: Config
  /** `--fake-mode` of the scripted `zm`. */
  mode?: string
  /** Register an approval answerer with this outcome. */
  approval?: ApprovalOutcome
}

/** A booted composition. */
export interface Booted {
  ctx: Context
  root: string
  workspace: string
  storeRoot: string
  /** Fiber of the memory-zeromem plugin. */
  fiber: Fiber
  /** Formats passed to ctx.logger.warn. */
  warnings: unknown[]
  /** Scripted model responses per session; later turns append to the same script. */
  scripts: Map<string, StreamChunk[][]>
}

/**
 * Temporary root with a workspace directory.
 * @returns the root and the workspace inside it.
 */
export function tempRoot(): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-zeromem-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return { root, workspace }
}

/**
 * Mount the agent stack, the local subprocess provider, and the plugin running the scripted `zm`.
 * @param options - plugin settings, scripted failure, and approval outcome.
 * @returns the booted composition.
 */
export async function boot(options: BootOptions = {}): Promise<Booted> {
  const { root, workspace } = tempRoot()
  const storeRoot = join(root, 'stores')
  const ctx = new Context()
  contexts.push(ctx)
  const warnings: unknown[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((format: unknown) => {
    warnings.push(format)
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  if (options.approval !== undefined) {
    await ctx.plugin(ApprovalService)
    const outcome = options.approval
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
  }
  const config: Config = Object.assign({
    zmPath: process.execPath,
    zmArgs: [FAKE_ZM, ...options.mode === undefined ? [] : ['--fake-mode', options.mode]],
    embedder: 'hash',
    storeRoot,
  }, options.config)
  const fiber = await ctx.plugin(MemoryZeromem, config)
  return { ctx, root, workspace, storeRoot, fiber, warnings, scripts: new Map() }
}

/**
 * Run one user turn with a scripted model and wait for idle.
 * @param booted - the composition.
 * @param sessionId - the session id.
 * @param text - the user message.
 * @param responses - scripted model responses.
 * @param meta - session metadata; the default working directory is the workspace.
 * @returns the idle agent.
 */
export async function turn(
  booted: Booted,
  sessionId: string,
  text: string,
  responses: StreamChunk[][],
  meta: { readonly cwd?: string } = { cwd: booted.workspace },
): Promise<Agent> {
  const script = booted.scripts.get(sessionId)
  if (script === undefined) {
    const fresh = [...responses]
    booted.scripts.set(sessionId, fresh)
    booted.ctx.llm.registerAdapter([sessionId], new MockAdapter(fresh))
  } else {
    script.push(...responses)
  }
  const existing = booted.ctx.agents.get(SessionId(sessionId))
  const agent = existing ?? await booted.ctx.agentLoop.create(SessionId(sessionId), { provider: sessionId, model: 'mock' }, meta)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

/**
 * Unload the plugin; its disposal waits for every queued spool write.
 * @param booted - the composition.
 */
export async function flush(booted: Booted): Promise<void> {
  await booted.fiber.dispose()
}

/**
 * Every spooled turn of a store, oldest file first.
 * @param home - the store directory.
 * @returns the spooled turns.
 */
export function spooled(home: string): SpoolTurn[] {
  const spool = join(home, 'spool')
  if (!existsSync(spool)) return []
  return readdirSync(spool).filter(name => name.endsWith('.jsonl')).sort()
    .flatMap(name => readFileSync(join(spool, name), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as SpoolTurn))
}

/**
 * The workspace store directory of the harness.
 * @param booted - the composition.
 * @param cwd - the session working directory; the default is the workspace.
 * @returns the store directory.
 */
export function workspaceHome(booted: Booted, cwd = booted.workspace): string {
  return resolveStore({ scope: 'workspace', storeRoot: booted.storeRoot, cwd, models: join(booted.storeRoot, 'models') }).home
}

/**
 * Invocations the scripted `zm` recorded in a store.
 * @param home - the store directory.
 * @returns each invocation's arguments and working directory.
 */
export function zmCalls(home: string): { argv: string[]; cwd: string }[] {
  const file = join(home, 'fake-calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { argv: string[]; cwd: string })
}

/**
 * Tool results of a session in order.
 * @param agent - the idle agent.
 * @returns text and error flag of each result.
 */
export function results(agent: Agent): { text: string; isError: boolean }[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [{ text: event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''), isError: event.data.message.isError === true }]
    : []))
}

/** Commit id the fake model directory's `refs/main` names. */
export const FAKE_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'

/**
 * A model directory holding empty stand-ins for every file `zm` reads, in the Hugging Face cache layout.
 * @param directory - where to create it; the default is a fresh temporary directory.
 * @returns the model directory.
 */
export function fakeModel(directory = join(tempRoot().root, 'model')): string {
  const folder = join(directory, ZEROMEM_MODEL_FOLDER)
  for (const file of ZEROMEM_MODEL_FILES) {
    const path = join(folder, 'snapshots', FAKE_MODEL_REVISION, ...file.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }
  mkdirSync(join(folder, 'refs'), { recursive: true })
  writeFileSync(join(folder, 'refs', 'main'), FAKE_MODEL_REVISION)
  return directory
}
