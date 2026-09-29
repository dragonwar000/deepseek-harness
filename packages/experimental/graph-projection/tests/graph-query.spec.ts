import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as GraphContract from '@deepseek-ai/dsh-experimental-graph-contract'
import { graphPlanId } from '@deepseek-ai/dsh-experimental-graph-contract'
import * as GraphProjection from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const PLAN = {
  format: 'dsh-graph/v1', id: 'ship', level: 'L1', goal: 'Two steps',
  nodes: [
    { id: 'first', kind: 'execution', instruction: 'First' },
    { id: 'second', kind: 'execution', instruction: 'Second', needs: ['first'] },
  ],
  edges: [{ from: 'first', to: 'second', relation: 'hands_off', artifact: 'summary' }],
  deliverable: 'Done', acceptance: ['done'],
}

async function run(calls: { name: string; args: object }[]): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(GraphContract, { mode: 'enforce', assumption: 'multi-unit plans need a deterministic audit' })
  await ctx.plugin(GraphProjection)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    ...calls.map((call, index) => toolCallResponse(`q${index}`, call.name, call.args)),
    textResponse('done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan and query' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { ctx, agent }
}

function results(agent: Agent): { text: string; isError: boolean }[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [{ text: event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''), isError: event.data.message.isError === true }]
    : []))
}

describe('graph_query', () => {
  it('lists admitted plans and returns one plan with waves and derived status', async () => {
    const { agent } = await run([
      { name: 'graph_audit', args: { plan: PLAN } },
      { name: 'graph_query', args: { scope: 'plans' } },
      { name: 'graph_query', args: { scope: 'plan', plan_id: 'ship' } },
    ])
    const [, plans, one] = results(agent)
    expect(JSON.parse(plans!.text)).toEqual({ plans: [{ planId: 'ship', version: 1, nodes: 2, ready: 1 }] })
    expect(JSON.parse(one!.text)).toEqual({
      graph: {
        planId: 'ship', version: 1, waves: [['first'], ['second']],
        nodes: [
          { id: 'first', kind: 'execution', needs: [], status: 'ready' },
          { id: 'second', kind: 'execution', needs: ['first'], status: 'pending' },
        ],
      },
    })
  })

  it('names the missing argument and the unknown plan as tool errors', async () => {
    const { agent } = await run([
      { name: 'graph_query', args: { scope: 'plan' } },
      { name: 'graph_query', args: { scope: 'plan', plan_id: 'ghost' } },
    ])
    const [missing, unknown] = results(agent)
    expect(missing?.isError).toBe(true)
    expect(missing?.text).toContain('scope "plan" requires plan_id')
    expect(unknown?.isError).toBe(true)
    expect(unknown?.text).toContain('no admitted plan ghost')
  })

  it('refuses a call with no owning agent and presents the scope', async () => {
    const { ctx } = await run([])
    const result = await ctx.tools.execute({ callId: ToolCallId('direct'), name: 'graph_query', arguments: { scope: 'plans' }, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(ctx.tools.get('graph_query')?.presentCall?.({ scope: 'plan', plan_id: 'ship' })).toEqual({ card: 'generic', title: 'Query graph ship', kind: 'read' })
    expect(ctx.tools.get('graph_query')?.presentCall?.({ scope: 'plans' })).toEqual({ card: 'generic', title: 'Query graph plans', kind: 'read' })
    expect(ctx.tools.get('graph_query')?.presentCall?.({ scope: 'plan' })).toEqual({ card: 'generic', title: 'Query graph plan', kind: 'read' })
  })

  it('refuses to answer when the task graphs cannot be folded', async () => {
    const { ctx, agent } = await run([])
    agent.session.append('graph/plan', { planId: graphPlanId('ship'), version: 1, sha: 'not-hex', mode: 'enforce', admitted: true, plan: null, rejections: [] })
    const result = await ctx.tools.execute({ callId: ToolCallId('unfolded'), name: 'graph_query', arguments: { scope: 'plans' }, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('the task graphs of this session cannot be folded')
  })
})
