import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { KnowledgeService, knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEdge, KnowledgeEdgeId, KnowledgeIndex, KnowledgePage, KnowledgeScope } from '@deepseek-ai/dsh-experimental-knowledge'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as GraphProjection from '../src/index.ts'
import { citeKnowledge, judgedClaims, knowledgeMounted } from '../src/knowledge.ts'
import type { EvidenceClaim } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const EDGE: KnowledgeEdge = { eid: 'e:11111111' as KnowledgeEdgeId, from: knowledgePageId('concepts/retry.md'), to: 'concepts/backoff.md', toKind: 'page', relation: 'depends-on' }

/** A store with two pages and one edge that counts its reads. */
class FakeKnowledge extends KnowledgeService {
  static root: string | undefined = 'knowledge/'
  indexCalls = 0
  cited: string[] = []

  get storeRoot(): string | undefined {
    return FakeKnowledge.root
  }

  index(_scope: KnowledgeScope): Promise<KnowledgeIndex> {
    this.indexCalls += 1
    const entry = (id: string) => ({ id: knowledgePageId(id), title: id, type: 'concept', stale: false })
    return Promise.resolve({ entries: [entry('concepts/retry.md'), entry('concepts/backoff.md')], quarantined: [] })
  }

  query(): Promise<never[]> {
    return Promise.resolve([])
  }

  read(): Promise<KnowledgePage | undefined> {
    return Promise.resolve(undefined)
  }

  cite(_scope: KnowledgeScope, ref: string): Promise<KnowledgeEdge[]> {
    this.cited.push(ref)
    if (ref === 'e:11111111') return Promise.resolve([EDGE])
    if (ref === 'e:33333333') return Promise.resolve([EDGE, EDGE])
    return Promise.resolve([])
  }

  neighbors(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  write(): Promise<never> {
    return Promise.reject(new Error('read-only fake'))
  }

  includes(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

const claim = (kind: EvidenceClaim['kind'], text: string): EvidenceClaim => ({ kind, text, leaves: [] })
const scope = { cwd: '/work' }

async function withKnowledge(root: string | undefined): Promise<{ ctx: Context; store: FakeKnowledge }> {
  FakeKnowledge.root = root
  const ctx = new Context()
  await ctx.plugin(FakeKnowledge)
  await ctx.fiber.await()
  return { ctx, store: ctx.get('knowledge') as FakeKnowledge }
}

describe('knowledge leaves', () => {
  it('leaves every claim unchanged and drops edge ids without a knowledge store', async () => {
    const ctx = new Context()
    const claims = [claim('path', 'knowledge/concepts/retry.md'), claim('edge', 'e:11111111')]
    expect(knowledgeMounted(ctx)).toBe(false)
    expect(await citeKnowledge(ctx, scope, claims)).toEqual(claims)
    expect(judgedClaims(claims, false)).toEqual([claims[0]])
    expect(judgedClaims(claims, true)).toEqual(claims)
  })

  it('adds a graph-edge leaf for store pages and for edge ids the store resolves to one edge', async () => {
    const { ctx, store } = await withKnowledge('knowledge/')
    expect(knowledgeMounted(ctx)).toBe(true)
    const recorded = { ...claim('path', 'concepts/retry.md'), leaves: [{ kind: 'observed' as const, seq: 4, tool: 'knowledge_query' }] }
    const cited = await citeKnowledge(ctx, scope, [
      claim('path', 'knowledge/concepts/backoff.md'),
      recorded,
      claim('path', 'concepts/missing.md'),
      claim('path', 'other/concepts/retry.md'),
      claim('path', 'src/app.ts'),
      claim('command', 'pnpm test'),
      claim('edge', 'e:11111111'),
      claim('edge', 'e:22222222'),
      claim('edge', 'e:33333333'),
    ])
    expect(cited.map(entry => entry.leaves)).toEqual([
      [{ kind: 'graph-edge', target: 'page', ref: 'concepts/backoff.md' }],
      [{ kind: 'observed', seq: 4, tool: 'knowledge_query' }, { kind: 'graph-edge', target: 'page', ref: 'concepts/retry.md' }],
      [], [], [], [],
      [{ kind: 'graph-edge', target: 'edge', ref: 'e:11111111' }],
      [], [],
    ])
    expect(store.indexCalls).toBe(1)
    expect(store.cited).toEqual(['e:11111111', 'e:22222222', 'e:33333333'])
  })

  it('reads the store only for page and edge claims, and matches page ids alone without a store root', async () => {
    const { ctx, store } = await withKnowledge(undefined)
    expect(await citeKnowledge(ctx, scope, [claim('path', 'src/app.ts'), claim('command', 'pnpm test')])).toHaveLength(2)
    expect(store.indexCalls).toBe(0)
    expect((await citeKnowledge(ctx, scope, [claim('edge', 'e:11111111')]))[0]?.leaves).toHaveLength(1)
    expect(store.indexCalls).toBe(0)
    const pages = await citeKnowledge(ctx, scope, [claim('path', 'concepts/retry.md'), claim('path', 'knowledge/concepts/retry.md')])
    expect(pages.map(entry => entry.leaves.length)).toEqual([1, 0])
  })
})

async function citeRun(ctx: Context, claims: string[]): Promise<Agent> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GraphProjection)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    ...claims.map((text, index) => toolCallResponse(`c${index}`, 'graph_cite', { claim: text })),
    textResponse('done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cite' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

function results(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'tool/result'
    ? [event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')]
    : []))
}

describe('graph_cite with a knowledge store', () => {
  it('reports store pages and edges as graph-edge leaves', async () => {
    const { ctx } = await withKnowledge('knowledge/')
    const agent = await citeRun(ctx, ['knowledge/concepts/retry.md', 'e:11111111', 'e:22222222', 'notes/x.md'])
    expect(results(agent)).toEqual([
      'graph_cite: path knowledge/concepts/retry.md is supported in turn 1 by:\n- graph-edge: knowledge page concepts/retry.md',
      'graph_cite: edge e:11111111 is supported in turn 1 by:\n- graph-edge: knowledge edge e:11111111',
      'graph_cite: edge e:22222222 is parametric: the knowledge store has no edge with this id.',
      'graph_cite: path notes/x.md is parametric: no tool call or tool result in turn 1 mentions it.',
    ])
  })

  it('does not recognize an edge id without a knowledge store', async () => {
    const agent = await citeRun(new Context(), ['e:11111111'])
    expect(results(agent)).toEqual(['graph_cite: "e:11111111" is neither a file path nor a shell command; cite one path or one command.'])
  })
})
