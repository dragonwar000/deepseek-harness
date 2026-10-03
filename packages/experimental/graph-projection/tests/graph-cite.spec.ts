import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as GraphProjection from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function run(script: ReturnType<typeof textResponse>[]): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GraphProjection)
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, async execute() { return [{ type: 'text', text: 'contents of src/app.ts' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'fail', description: 'fail', parameters: {}, async execute() { throw new Error('missing notes/old.md') } }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix it' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { ctx, agent }
}

function results(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')]
    : []))
}

describe('graph_cite', () => {
  it('cites the records of the current turn, never its own calls, and classifies claims', async () => {
    const { ctx, agent } = await run([
      toolCallResponse('r', 'read', { path: 'src/app.ts' }),
      toolCallResponse('f', 'fail', { path: 'notes/old.md' }),
      toolCallResponse('g1', 'graph_cite', { claim: 'src/app.ts' }),
      toolCallResponse('g2', 'graph_cite', { claim: 'pnpm test' }),
      toolCallResponse('g3', 'graph_cite', { claim: 'hello' }),
      toolCallResponse('g4', 'graph_cite', { claim: 'notes/old.md' }),
      textResponse('Updated `src/app.ts`; ran `pnpm lint`.'),
    ])
    const texts = results(agent)
    expect(texts[2]).toMatch(/^graph_cite: path src\/app\.ts is supported in turn 1 by:\n/)
    expect(texts[2]).toMatch(/\n- tool-record: read \(#\d+\)\n- observed: read \(#\d+\)$/)
    expect(texts[3]).toBe('graph_cite: command pnpm test is parametric: no tool call or tool result in turn 1 mentions it.')
    expect(texts[4]).toBe('graph_cite: "hello" is neither a file path nor a shell command; cite one path or one command.')
    expect(texts[5]).toMatch(/- tool-record: fail \(#\d+\)\n- absence: fail \(#\d+\)$/)
    const answer = ctx.sessionProjections.stateOf(agent.session, 'graphEvidence')?.answer
    expect(answer?.claims.map(claim => [claim.kind, claim.text, claim.leaves.map(leaf => leaf.kind)])).toEqual([
      ['path', 'src/app.ts', ['tool-record', 'observed']],
      ['command', 'pnpm lint', []],
    ])
  })

  it('presents the call with the claim and refuses a call with no owning agent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GraphProjection)
    expect(ctx.tools.get('graph_cite')?.presentCall?.({ claim: 'src/a.ts' })).toEqual({ card: 'generic', title: 'Cite src/a.ts', kind: 'read' })
    const direct = await ctx.tools.execute({ callId: ToolCallId('direct-cite'), name: 'graph_cite', arguments: { claim: 'src/a.ts' }, signal: new AbortController().signal })
    expect(direct.isError).toBe(true)
  })
})
