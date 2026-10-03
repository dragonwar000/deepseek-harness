import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ContextKnowledge from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const HEADER = 'Knowledge index of the workspace knowledge store'
const PAGE = '---\ntype: concept\ntitle: Retry policy\nupdated: 2026-09-20\n---\n\nRetries back off.\n'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  ctx: Context
  agent: Agent
  adapter: MockAdapter
  dir: string
}

async function setup(
  files: Record<string, string>,
  responses: StreamChunk[][],
  config: Config = {},
  extra?: (ctx: Context) => void,
): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-context-knowledge-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(WikiFilesystemKnowledge, {})
  await ctx.plugin(ContextKnowledge, config)
  extra?.(ctx)
  const adapter = new MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, dir }
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function headerCount(adapter: MockAdapter, request: number): number {
  return (adapter.requests[request]?.messages ?? []).filter(message => JSON.stringify(message.content).includes(HEADER)).length
}

function injects(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'knowledge/inject').length
}

describe('context-knowledge', () => {
  it('adds the index at the first step of a turn and again only after the store changes', async () => {
    const { agent, adapter, dir } = await setup({ 'knowledge/concepts/retry.md': PAGE }, [textResponse('a'), textResponse('b'), textResponse('c')])
    await turn(agent, 'one')
    await turn(agent, 'two')
    writeFileSync(join(dir, 'knowledge/concepts/backoff.md'), '---\ntype: concept\ntitle: Backoff\n---\n')
    await turn(agent, 'three')
    expect([headerCount(adapter, 0), headerCount(adapter, 1), headerCount(adapter, 2)]).toEqual([1, 1, 2])
    expect(injects(agent)).toBe(2)
  })

  it('records the listed ids and the exact size of the injected message', async () => {
    const { agent } = await setup({ 'knowledge/concepts/retry.md': PAGE }, [textResponse('a')])
    await turn(agent, 'one')
    const events = agent.session.snapshotEvents()
    const record = events.find(event => event.type === 'knowledge/inject')
    const message = events.find(event => event.type === 'user/message' && event.data.source.kind === 'knowledge-context')
    expect(record?.type === 'knowledge/inject' && record.data).toMatchObject({ ids: ['concepts/retry.md'], lines: 2, omitted: 0, quarantined: 0 })
    const text = message?.type === 'user/message' ? message.data.content.map(block => (block.type === 'text' ? block.text : '')).join('') : ''
    expect(record?.type === 'knowledge/inject' && record.data.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(message?.type === 'user/message' && message.data.source).toEqual({ kind: 'knowledge-context', form: 'snapshot', sections: [{ name: 'knowledge-context', text }] })
  })

  it('adds nothing for an empty store', async () => {
    const { agent, adapter } = await setup({}, [textResponse('a')])
    await turn(agent, 'one')
    expect(headerCount(adapter, 0)).toBe(0)
    expect(injects(agent)).toBe(0)
  })

  it('adds the index only at the first step of a turn', async () => {
    const { agent, adapter } = await setup({ 'knowledge/concepts/retry.md': PAGE }, [toolCallResponse('n1', 'noop', {}), textResponse('done')], {}, (ctx) => {
      ctx.tools.register(defineTool({
        name: 'noop',
        description: 'Does nothing.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ok'),
      }))
    })
    await turn(agent, 'one')
    expect([headerCount(adapter, 0), headerCount(adapter, 1)]).toEqual([1, 1])
    expect(injects(agent)).toBe(1)
  })

  it('leaves a rejected step alone', async () => {
    const { agent } = await setup({ 'knowledge/concepts/retry.md': PAGE }, [textResponse('a')], {}, (ctx) => {
      ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    })
    await turn(agent, 'one')
    expect(injects(agent)).toBe(0)
  })

  it.each([
    [{ maxLines: 2 }, 'maxLines must be an integer of at least 3'],
    [{ maxBytes: 1000 }, 'maxBytes must be an integer of at least 1024'],
  ])('fails loud on invalid limits %#', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(WikiFilesystemKnowledge, {})
    await expect(ctx.plugin(ContextKnowledge, config)).rejects.toThrow(message)
  })
})
