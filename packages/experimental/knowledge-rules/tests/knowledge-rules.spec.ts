import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { KnowledgeService } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEdge, KnowledgeHit, KnowledgeIndex, KnowledgeNeighbors, KnowledgePage, KnowledgeWriteResult } from '@deepseek-ai/dsh-experimental-knowledge'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as KnowledgeRules from '../src/index.ts'
import { STORE_WRITE_REASON } from '../src/shell.ts'

/** A provider whose store is not a workspace directory and whose containment check fails. */
class DetachedKnowledge extends KnowledgeService {
  get storeRoot(): undefined {
    return undefined
  }

  index(): Promise<KnowledgeIndex> {
    return Promise.resolve({ entries: [], quarantined: [] })
  }

  query(): Promise<KnowledgeHit[]> {
    return Promise.resolve([])
  }

  read(): Promise<KnowledgePage | undefined> {
    return Promise.resolve(undefined)
  }

  cite(): Promise<KnowledgeEdge[]> {
    return Promise.resolve([])
  }

  neighbors(): Promise<KnowledgeNeighbors | undefined> {
    return Promise.resolve(undefined)
  }

  write(): Promise<KnowledgeWriteResult> {
    return Promise.reject(new Error('not used'))
  }

  includes(): Promise<boolean> {
    return Promise.reject(new Error('containment unavailable'))
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function mount(provider: 'wiki' | 'detached', shellTools?: string[]): Promise<{ ctx: Context; dir: string; rules: Fiber }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-knowledge-rules-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries({ 'knowledge/concepts/a.md': '---\ntype: concept\n---\nA\n', 'notes.md': 'notes\n' })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(provider === 'wiki' ? WikiFilesystemKnowledge : DetachedKnowledge, {})
  const rules = await ctx.plugin(KnowledgeRules, shellTools === undefined ? {} : { shellTools })
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Stub shell.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('ran'),
  }))
  return { ctx, dir, rules }
}

function call(ctx: Context, name: string, args: object): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId: ToolCallId(`${name}-${JSON.stringify(args).length}`), name, arguments: args, signal: new AbortController().signal })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('knowledge-rules', () => {
  it('refuses a write tool call into the store and writes nothing', async () => {
    const { ctx, dir } = await mount('wiki')
    const result = await call(ctx, 'write', { file_path: 'knowledge/concepts/b.md', content: '---\ntype: concept\n---\n' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(STORE_WRITE_REASON)
    expect(existsSync(join(dir, 'knowledge/concepts/b.md'))).toBe(false)
  })

  it('refuses an edit tool call on a store page and leaves it unchanged', async () => {
    const { ctx, dir } = await mount('wiki')
    await call(ctx, 'read', { file_path: 'knowledge/concepts/a.md' })
    const result = await call(ctx, 'edit', { file_path: 'knowledge/concepts/a.md', old_string: 'A', new_string: 'B' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(STORE_WRITE_REASON)
    expect(readFileSync(join(dir, 'knowledge/concepts/a.md'), 'utf8')).toBe('---\ntype: concept\n---\nA\n')
  })

  it('lets writes outside the store through to the observation policy', async () => {
    const { ctx, dir } = await mount('wiki')
    const result = await call(ctx, 'write', { file_path: 'notes/new.md', content: 'new\n' })
    expect(result.isError).toBe(false)
    expect(readFileSync(join(dir, 'notes/new.md'), 'utf8')).toBe('new\n')
    const notes = await ctx.fs.resolve('notes.md')
    // The observation policy, not this guard, refuses an edit without an owning read.
    await expect(ctx.waterfall('fs/edit-intent', notes, undefined, () => undefined)).rejects.toThrow('edit requires reading')
  })

  it('refuses shell commands that change the store and runs the others', async () => {
    const { ctx } = await mount('wiki')
    const denied = await call(ctx, 'bash', { command: 'echo x > knowledge/concepts/a.md' })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain(STORE_WRITE_REASON)
    expect(text(await call(ctx, 'bash', { command: 'cat knowledge/concepts/a.md' }))).toBe('ran')
  })

  it('checks only the configured shell tools, and only a string command argument', async () => {
    const { ctx } = await mount('wiki', ['pwsh'])
    expect(text(await call(ctx, 'bash', { command: 'echo x > knowledge/concepts/a.md' }))).toBe('ran')
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'Stub shell without a command argument.',
      parameters: { script: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ran'),
    }))
    expect(text(await call(ctx, 'pwsh', { script: 'Set-Content knowledge/a.md x' }))).toBe('ran')
  })

  it('fails closed when the store cannot answer containment, and skips the shell check without a workspace root', async () => {
    const { ctx } = await mount('detached')
    const result = await call(ctx, 'write', { file_path: 'notes/new.md', content: 'new\n' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('containment unavailable')
    expect(text(await call(ctx, 'bash', { command: 'echo x > knowledge/concepts/a.md' }))).toBe('ran')
  })

  it('removes its intent listeners and shell guard when disposed', async () => {
    const { ctx, dir, rules } = await mount('wiki')
    await rules.dispose()
    expect((await call(ctx, 'write', { file_path: 'knowledge/concepts/b.md', content: 'direct\n' })).isError).toBe(false)
    expect(readFileSync(join(dir, 'knowledge/concepts/b.md'), 'utf8')).toBe('direct\n')
    expect(text(await call(ctx, 'bash', { command: 'echo x > knowledge/concepts/a.md' }))).toBe('ran')
  })

  it('fails loud on a blank shell tool name', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(WikiFilesystemKnowledge, {})
    await expect(ctx.plugin(KnowledgeRules, { shellTools: [' '] })).rejects.toThrow('shellTools entries must be tool names')
  })
})
