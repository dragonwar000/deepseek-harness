/**
 * Loader harness for the knowledge bundle tests: the shipped patch over a minimal agent composition,
 * with optional extra base rows and profile patches.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ContextKnowledge from '@deepseek-ai/dsh-experimental-context-knowledge'
import * as ContextKnowledgeInvariant from '@deepseek-ai/dsh-experimental-context-knowledge/invariant'
import * as KnowledgeInvariant from '@deepseek-ai/dsh-experimental-knowledge/invariant'
import * as KnowledgeRules from '@deepseek-ai/dsh-experimental-knowledge-rules'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import * as MemoryDistill from '@deepseek-ai/dsh-experimental-memory-distill'
import * as MemoryZeromem from '@deepseek-ai/dsh-experimental-memory-zeromem'
import * as ToolKnowledge from '@deepseek-ai/dsh-experimental-tool-knowledge'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import InvariantService from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const BASE_ROWS = new Map<string, unknown>([
  ['@deepseek-ai/dsh-invariants', InvariantService],
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
  ['@deepseek-ai/dsh-fs-observation-policy', FsPolicy],
  ['@deepseek-ai/dsh-tool-fs', ToolFs],
  ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
  ['@deepseek-ai/dsh-experimental-knowledge/invariant', KnowledgeInvariant],
  ['@deepseek-ai/dsh-experimental-context-knowledge/invariant', ContextKnowledgeInvariant],
])

const BUNDLE_ROWS = new Map<string, unknown>([
  ['@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem', WikiFilesystemKnowledge],
  ['@deepseek-ai/dsh-experimental-knowledge-rules', KnowledgeRules],
  ['@deepseek-ai/dsh-experimental-tool-knowledge', ToolKnowledge],
  ['@deepseek-ai/dsh-experimental-context-knowledge', ContextKnowledge],
  ['@deepseek-ai/dsh-experimental-memory-distill', MemoryDistill],
  ['@deepseek-ai/dsh-experimental-memory-zeromem', MemoryZeromem],
])

/** Scripted stand-in for zeromem's zm, owned by the memory-zeromem package tests. */
export const FAKE_ZM = fileURLToPath(new URL('../../memory-zeromem/tests/fake-zm.mjs', import.meta.url))

const PAGE = '---\ntype: concept\ntitle: Retry policy\nupdated: 2026-09-20T10:00:00.000Z\n---\n\n# Retry policy\n\nRequests retry three times.\n\n## Origin\n\n- Seeded by the composition test.\n'

/** Temporary directories removed by {@link cleanup}. */
export const roots: string[] = []
const contexts: Context[] = []

/** Dispose every booted context, then remove every temporary directory. */
export async function cleanup(): Promise<void> {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/**
 * A Loader module source that serves only the fixture modules.
 * @param modules - specifier to module.
 * @returns the loader.
 */
function fixtureModules(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/**
 * Boot the base rows through the Loader with the shipped bundle patch applied.
 * @returns the context and the session working directory.
 */
export async function boot(
  extraRows: ReadonlyMap<string, unknown> = new Map(),
  profilePatches: readonly PatchOptions[] = [],
): Promise<{ ctx: Context; workspace: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-profile-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(dirname(join(workspace, 'knowledge/concepts/retry.md')), { recursive: true })
  writeFileSync(join(workspace, 'knowledge/concepts/retry.md'), PAGE)
  const configPath = join(root, 'cordis.yml')
  const baseRows = new Map([...BASE_ROWS, ...extraRows])
  writeFileSync(configPath, JSON.stringify([...baseRows.keys()].map(name => ({
    name,
    config: name === '@deepseek-ai/dsh-invariants'
      ? { enabled: true }
      : name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : name === '@deepseek-ai/dsh-fs-local' ? { cwd: workspace } : {},
  }))))
  const manifest = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string } } }
  const patchPath = resolve(fileURLToPath(new URL('..', import.meta.url)), manifest.dsh.bundle.patch)
  const patches = [...yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as PatchOptions[], ...profilePatches]
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = fixtureModules(new Map([...baseRows, ...BUNDLE_ROWS]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, workspace, root }
}

/** What the memory round trip observed. */
export interface RecallRoundTrip {
  /** Tool names of the first session's first request. */
  readonly tools: readonly string[]
  /** JSON of the later session's `memory_recall` result content. */
  readonly recall: string
  /** Whether that result is an error. */
  readonly isError: boolean
}

/**
 * Store one turn in an earlier session, then call `memory_recall` from a later session in the same workspace.
 * @param ctx - booted composition with memory-zeromem enabled.
 * @param workspace - session working directory.
 * @returns the offered tools and the recall result.
 */
export async function recallRoundTrip(ctx: Context, workspace: string): Promise<RecallRoundTrip> {
  const first = new MockAdapter([textResponse('Noted: retries use jittered backoff.')])
  ctx.llm.registerAdapter(['first'], first)
  const earlier = await ctx.agentLoop.create(SessionId('earlier'), { provider: 'first', model: 'mock' }, { cwd: workspace })
  earlier.followup(createUserMessage({ content: [{ type: 'text', text: 'Our retries use jittered backoff.' }], source: { kind: 'user' } }))
  await earlier.whenIdle()
  const second = new MockAdapter([toolCallResponse('r1', 'memory_recall', { query: 'jittered backoff retries' }), textResponse('done')])
  ctx.llm.registerAdapter(['second'], second)
  const later = await ctx.agentLoop.create(SessionId('later'), { provider: 'second', model: 'mock' }, { cwd: workspace })
  later.followup(createUserMessage({ content: [{ type: 'text', text: 'What did we decide about retries?' }], source: { kind: 'user' } }))
  await later.whenIdle()
  const result = later.session.snapshotEvents().find(event => event.type === 'tool/result')
  return {
    tools: (first.requests[0]?.tools ?? []).map(tool => tool.name),
    recall: result?.type === 'tool/result' ? JSON.stringify(result.data.message.content) : '',
    isError: result?.type === 'tool/result' && result.data.message.isError === true,
  }
}

/**
 * A model directory holding empty stand-ins for every file `zm` reads, removed by {@link cleanup}.
 * @returns its path.
 */
export function fakeModel(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-knowledge-profile-model-'))
  roots.push(directory)
  const revision = 'ea104dacec62c0de699686887e3f920caeb4f3e3'
  const folder = join(directory, MemoryZeromem.ZEROMEM_MODEL_FOLDER)
  for (const file of MemoryZeromem.ZEROMEM_MODEL_FILES) {
    const path = join(folder, 'snapshots', revision, ...file.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  mkdirSync(join(folder, 'refs'))
  writeFileSync(join(folder, 'refs', 'main'), revision)
  return directory
}

/**
 * A temporary store root removed by {@link cleanup}.
 * @returns its path.
 */
export function storeRoot(): string {
  const stores = mkdtempSync(join(tmpdir(), 'dsh-knowledge-profile-zeromem-'))
  roots.push(stores)
  return stores
}
