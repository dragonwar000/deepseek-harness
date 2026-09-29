/**
 * The shipped knowledge bundle patch, booted through the Loader over a minimal
 * agent composition, offers the three read tools, adds the store index to the
 * first request, and refuses a file tool write into the store.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
import { STORE_WRITE_REASON } from '@deepseek-ai/dsh-experimental-knowledge-rules'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import * as MemoryDistill from '@deepseek-ai/dsh-experimental-memory-distill'
import * as ToolKnowledge from '@deepseek-ai/dsh-experimental-tool-knowledge'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import InvariantService from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
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
  ['@deepseek-ai/dsh-experimental-knowledge/invariant', KnowledgeInvariant],
  ['@deepseek-ai/dsh-experimental-context-knowledge/invariant', ContextKnowledgeInvariant],
])

const BUNDLE_ROWS = new Map<string, unknown>([
  ['@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem', WikiFilesystemKnowledge],
  ['@deepseek-ai/dsh-experimental-knowledge-rules', KnowledgeRules],
  ['@deepseek-ai/dsh-experimental-tool-knowledge', ToolKnowledge],
  ['@deepseek-ai/dsh-experimental-context-knowledge', ContextKnowledge],
  ['@deepseek-ai/dsh-experimental-memory-distill', MemoryDistill],
])

const PAGE = '---\ntype: concept\ntitle: Retry policy\nupdated: 2026-09-20T10:00:00.000Z\n---\n\n# Retry policy\n\nRequests retry three times.\n\n## Origin\n\n- Seeded by the composition test.\n'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
async function boot(): Promise<{ ctx: Context; workspace: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-profile-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(dirname(join(workspace, 'knowledge/concepts/retry.md')), { recursive: true })
  writeFileSync(join(workspace, 'knowledge/concepts/retry.md'), PAGE)
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([...BASE_ROWS.keys()].map(name => ({
    name,
    config: name === '@deepseek-ai/dsh-invariants'
      ? { enabled: true }
      : name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : name === '@deepseek-ai/dsh-fs-local' ? { cwd: workspace } : {},
  }))))
  const manifest = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string } } }
  const patchPath = resolve(fileURLToPath(new URL('..', import.meta.url)), manifest.dsh.bundle.patch)
  const patches = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = fixtureModules(new Map([...BASE_ROWS, ...BUNDLE_ROWS]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, workspace }
}

describe('knowledge bundle Loader composition', () => {
  it('offers the read tools, adds the index to the first request, and refuses a direct store write', async () => {
    const { ctx, workspace } = await boot()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const adapter = new MockAdapter([
      toolCallResponse('w1', 'write', { file_path: 'knowledge/concepts/new.md', content: 'x' }),
      toolCallResponse('q1', 'knowledge_query', { query: 'retry' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('knowledge-profile'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'What do we know about retries?' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const tools = (adapter.requests[0]?.tools ?? []).map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['knowledge_query', 'knowledge_read', 'knowledge_cite']))
    expect(tools).not.toContain('knowledge_write')
    const index = (adapter.requests[0]?.messages ?? []).filter(message => JSON.stringify(message.content).includes('Knowledge index of the workspace knowledge store'))
    expect(index).toHaveLength(1)
    expect(JSON.stringify(index[0]?.content)).toContain('- concepts/retry.md — Retry policy [concept] updated 2026-09-20')

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'knowledge/inject')).toHaveLength(1)
    const results = events.flatMap(event => (event.type === 'tool/result' ? [event.data.message] : []))
    expect(results[0]).toMatchObject({ isError: true })
    expect(JSON.stringify(results[0]?.content)).toContain(STORE_WRITE_REASON)
    expect(existsSync(join(workspace, 'knowledge/concepts/new.md'))).toBe(false)
    expect(results[1]?.isError).not.toBe(true)
    expect(JSON.stringify(results[1]?.content)).toContain('concepts/retry.md')
    expect(events.filter(event => event.type === 'knowledge/write')).toEqual([])
  })
})
