import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as GraphProjection from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function mount(config: Config, withQuery = true): Promise<{ ctx: Context; lead: { agent?: Agent } }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GraphProjection, config)
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, async execute() { return [{ type: 'text', text: 'contents of src/a.ts' }] } }))
  const lead: { agent?: Agent } = {}
  if (withQuery) {
    ctx.provide('sessionQuery', {
      readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow> {
        const last = request.seq + (request.after ?? 0)
        const events = lead.agent!.session.snapshotEvents().filter(event => event.seq >= request.seq && event.seq <= last)
        return Promise.resolve({ events } as SessionEventWindow)
      },
    })
  }
  return { ctx, lead }
}

function results(agent: Agent): { text: string; isError: boolean }[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [{ text: event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''), isError: event.data.message.isError === true }]
    : []))
}

async function prompt(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('history_read', () => {
  it('lists compacted spans newest first and reads one back as a new tool result', async () => {
    const { ctx, lead } = await mount({ history: { maxChars: 8000, maxListed: 1, readWindow: 50 } })
    const ids = { summary: 0, bad: 0 }
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('r', 'read', { path: 'src/a.ts' }),
      textResponse('Done with `src/a.ts`.'),
      toolCallResponse('h1', 'history_read', {}),
      () => toolCallResponse('h2', 'history_read', { seq: ids.summary }),
      () => toolCallResponse('h3', 'history_read', { seq: ids.bad }),
      () => toolCallResponse('h4', 'history_read', { seq: ids.summary, offset: 99 }),
      () => toolCallResponse('h5', 'history_read', { seq: ids.summary, offset: -1 }),
      textResponse('ok'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
    lead.agent = agent
    await prompt(agent, 'first task')
    const events = agent.session.snapshotEvents()
    const seqOf = (type: string, nth = 0): SessionSeq => events.filter(event => event.type === type)[nth]!.seq
    const items = [seqOf('user/message'), seqOf('tool/call'), seqOf('tool/result'), seqOf('assistant/message', 1)]
    const summary = agent.session.append('compaction/summary', {
      compactionId: CompactionId('c1'), summary: [{ type: 'text', text: 'checkpoint' }], shadowedRange: { start: items[0]!, end: items[3]! },
      shadowedSeqs: items, shadowedTokenCount: 10, provider: 'mock', model: 'mock',
    })
    const prune = agent.session.append('compaction/prune', { shadowedRange: { start: items[2]!, end: items[2]! }, shadowedSeqs: [items[2]!], shadowedTokenCount: 5 })
    ids.summary = summary.seq
    ids.bad = prune.seq + 100
    await prompt(agent, 'look back')
    const [, list, read, unknown, offset, negative] = results(agent)
    expect(list!.text).toBe(`history_read: 1 of 2 compacted spans, newest first:\n- seq ${prune.seq}: prune, events #${items[2]}-#${items[2]}, 1 items`)
    expect(read!.text).toBe([
      `history_read: span seq ${summary.seq} (summary), items 1-4 of 4:`,
      `#${items[0]} User: first task`,
      `#${items[1]} tool/call: read\n{"path":"src/a.ts"}`,
      `#${items[2]} Tool result: contents of src/a.ts`,
      `#${items[3]} Assistant: Done with \`src/a.ts\`.`,
    ].join('\n'))
    expect(unknown).toMatchObject({ isError: true })
    expect(unknown!.text).toContain(`no compacted span has seq ${ids.bad}`)
    expect(offset).toMatchObject({ isError: true })
    expect(offset!.text).toContain('offset 99 is outside the span\'s 4 items')
    expect(negative).toMatchObject({ isError: true })
    expect(negative!.text).toContain('offset -1 is outside the span\'s 4 items')
  })

  it('reports an empty history, a page that continues, and a missing query service', async () => {
    const { ctx, lead } = await mount({ history: { maxChars: 30, maxListed: 20, readWindow: 50 } }, false)
    const ids = { summary: 0 }
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('h0', 'history_read', {}),
      textResponse('nothing yet'),
      () => toolCallResponse('h1', 'history_read', { seq: ids.summary }),
      textResponse('ok'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
    lead.agent = agent
    await prompt(agent, 'first task')
    const first = agent.session.snapshotEvents().find(event => event.type === 'user/message')!.seq
    ids.summary = agent.session.append('compaction/summary', {
      compactionId: CompactionId('c2'), summary: [{ type: 'text', text: 'c' }], shadowedRange: { start: first, end: first },
      shadowedSeqs: [first], shadowedTokenCount: 1, provider: 'mock', model: 'mock',
    }).seq
    await prompt(agent, 'look back')
    const [empty, missing] = results(agent)
    expect(empty!.text).toBe('history_read: nothing in this session was compacted.')
    expect(missing).toMatchObject({ isError: true })
    expect(missing!.text).toContain('no session query service is available')
  })

  it('continues a long span with nextOffset', async () => {
    const { ctx, lead } = await mount({ history: { maxChars: 60, maxListed: 20, readWindow: 50 } })
    const ids = { summary: 0 }
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('a'.repeat(30)),
      () => toolCallResponse('h1', 'history_read', { seq: ids.summary }),
      textResponse('ok'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
    lead.agent = agent
    await prompt(agent, 'b'.repeat(30))
    const events = agent.session.snapshotEvents()
    const items = [events.find(event => event.type === 'user/message')!.seq, events.find(event => event.type === 'assistant/message')!.seq]
    ids.summary = agent.session.append('compaction/summary', {
      compactionId: CompactionId('c3'), summary: [{ type: 'text', text: 'c' }], shadowedRange: { start: items[0]!, end: items[1]! },
      shadowedSeqs: items, shadowedTokenCount: 1, provider: 'mock', model: 'mock',
    }).seq
    await prompt(agent, 'look back')
    const read = results(agent)[0]!
    expect(read.text).toMatch(new RegExp(`^history_read: span seq ${ids.summary} \\(summary\\), items 1-1 of 2:\\n#\\d+ User: b{30}\\nMore: call history_read with seq ${ids.summary} and offset 1\\.$`, 'u'))
  })

  it.each<[Config, RegExp]>([
    [{ history: { maxChars: 0 } }, /invalid history\.maxChars 0/],
    [{ history: { maxListed: 1.5 } }, /invalid history\.maxListed 1\.5/],
    [{ history: { readWindow: -1 } }, /invalid history\.readWindow -1/],
  ])('fails the load on %o', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(GraphProjection, config)).rejects.toThrow(message)
  })

  it('presents the call and refuses a call with no owning agent', async () => {
    const { ctx } = await mount({})
    const tool = ctx.tools.get('history_read')
    expect(tool?.presentCall?.({})).toEqual({ card: 'generic', title: 'List compacted history', kind: 'read' })
    expect(tool?.presentCall?.({ seq: 7 })).toEqual({ card: 'generic', title: 'Read compacted history 7', kind: 'read' })
    const direct = await ctx.tools.execute({ callId: ToolCallId('direct-history'), name: 'history_read', arguments: {}, signal: new AbortController().signal })
    expect(direct.isError).toBe(true)
  })
})
