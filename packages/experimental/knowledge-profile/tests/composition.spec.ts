/**
 * The shipped knowledge bundle patch, booted through the Loader over a minimal
 * agent composition, offers the three read tools, adds the store index to the
 * first request, and refuses a file tool write into the store. Beside the
 * graph projection it also supports a cited store page with a graph-edge leaf.
 * With its disabled memory-zeromem row switched on by a profile patch, the
 * bundle stores a completed turn and recalls it from a later session through a
 * scripted zm.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import { STORE_WRITE_REASON } from '@deepseek-ai/dsh-experimental-knowledge-rules'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { boot, cleanup, FAKE_ZM, recallRoundTrip, storeRoot } from './loader-harness.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup()
})

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
    expect(tools.filter(tool => tool.startsWith('memory_'))).toEqual([])
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

  it('supports a cited store page with a graph-edge leaf when the graph projection is mounted', async () => {
    const { ctx, workspace } = await boot(new Map([['@deepseek-ai/dsh-experimental-graph-projection', GraphProjection]]))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'graph_cite', { claim: 'knowledge/concepts/retry.md' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('knowledge-cite'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Cite the retry page.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result' ? [event.data.message.content] : []))
    expect(results).toEqual([[{ type: 'text', text: 'graph_cite: path knowledge/concepts/retry.md is supported in turn 1 by:\n- graph-edge: knowledge page concepts/retry.md' }]])
  })

  it('stores a completed turn and recalls it from a later session once a profile patch enables memory-zeromem', async () => {
    const { ctx, workspace } = await boot(new Map(), [{
      id: 'memory-zeromem',
      disabled: false,
      config: { zmPath: process.execPath, zmArgs: [FAKE_ZM], embedder: 'hash', storeRoot: storeRoot() },
    }])
    const trip = await recallRoundTrip(ctx, workspace)
    expect(trip.tools).toEqual(expect.arrayContaining(['memory_recall', 'memory_stats']))
    expect(trip.recall).toContain('earlier')
    expect(trip.recall).toContain('Our retries use jittered backoff.')
    expect(trip.recall).not.toContain('What did we decide')
  })

  it('runs the zm named by DSH_ZEROMEM_ZM when the patch keeps the row\'s empty zmPath', async () => {
    vi.stubEnv('DSH_ZEROMEM_ZM', process.execPath)
    const { ctx, workspace } = await boot(new Map(), [{
      id: 'memory-zeromem',
      disabled: false,
      config: { zmPath: '', zmArgs: [FAKE_ZM], embedder: 'hash', storeRoot: storeRoot() },
    }])
    const trip = await recallRoundTrip(ctx, workspace)
    expect(trip.isError).toBe(false)
    expect(trip.recall).toContain('Our retries use jittered backoff.')
  })
})
