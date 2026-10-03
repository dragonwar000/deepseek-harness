import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { DECLARED_RELATIONS, edgeId, isDeclaredRelation, KnowledgeService, knowledgePageId, pathArgument, foldToolPath } from '../src/index.ts'
import type {
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeNeighbors,
  KnowledgePage,
  KnowledgeCitation,
  KnowledgeScope,
  KnowledgeWriteResult,
} from '../src/index.ts'

/** Minimal provider: pins the seam contract, not store behavior. */
class StubKnowledge extends KnowledgeService {
  written: { entry: KnowledgeEntry; citation: KnowledgeCitation }[] = []

  get storeRoot(): string {
    return 'knowledge'
  }

  index(): Promise<KnowledgeIndex> {
    return Promise.resolve({ entries: [], quarantined: [] })
  }

  query(_scope: KnowledgeScope, text: string, limit: number): Promise<KnowledgeHit[]> {
    return Promise.resolve([{ id: knowledgePageId('concepts/a.md'), title: text, type: 'concept', stale: false, score: limit }])
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

  write(_scope: KnowledgeScope, entry: KnowledgeEntry, citation: KnowledgeCitation): Promise<KnowledgeWriteResult> {
    this.written.push({ entry, citation })
    return Promise.resolve({ kind: 'written', id: entry.id, operation: 'create', stale: [] })
  }

  includes(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

describe('knowledge seam', () => {
  it('registers as ctx.knowledge and forwards calls to the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(StubKnowledge)
    expect(ctx.knowledge.storeRoot).toBe('knowledge')
    expect(await ctx.knowledge.query({}, 'retry', 3)).toEqual([{ id: 'concepts/a.md', title: 'retry', type: 'concept', stale: false, score: 3 }])
    const entry: KnowledgeEntry = { id: knowledgePageId('concepts/a.md'), type: 'concept', title: 'A', body: 'Body', relations: [] }
    const citation: KnowledgeCitation = { sessionId: SessionId('s1'), sourceEventSeqs: [SessionSeq(4)], sources: ['src/a.ts'], writer: 'tool' }
    expect(await ctx.knowledge.write({ cwd: '/w' }, entry, citation)).toEqual({ kind: 'written', id: 'concepts/a.md', operation: 'create', stale: [] })
    expect((ctx.knowledge as StubKnowledge).written).toEqual([{ entry, citation }])
  })

  it('rejects a second provider and releases the service on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubKnowledge)
    await expect(ctx.plugin(StubKnowledge)).rejects.toThrow()
    await fiber.dispose()
    expect((ctx as Context & { knowledge?: KnowledgeService }).knowledge).toBeUndefined()
  })
})

describe('knowledge vocabulary', () => {
  it('computes the same edge ids as overstack wiki-graph.py', () => {
    expect(edgeId('concepts/a.md', 'concepts/b.md', 'wikilink')).toBe('e:66cfc7bf')
    expect(edgeId('concepts/b.md', 'concepts/a.md', 'supports')).toBe('e:53bd0641')
    expect(edgeId('concepts/a.md', 'concepts/b.md', 'mdlink')).toBe('e:7046ceb9')
    expect(edgeId('concepts/retry.md', 'src/retry.ts', 'touches')).toBe('e:80571cf8')
  })

  it('accepts the six declared relations only', () => {
    expect(DECLARED_RELATIONS).toEqual(['derives-from', 'depends-on', 'implements', 'supports', 'contradicts', 'supersedes'])
    for (const relation of DECLARED_RELATIONS) expect(isDeclaredRelation(relation)).toBe(true)
    for (const relation of ['wikilink', 'mdlink', 'touches', 'khong-hop-le']) expect(isDeclaredRelation(relation)).toBe(false)
  })

  it('reads the path argument of a logged file tool call', () => {
    expect(pathArgument('{"file_path":" src/a.ts "}')).toBe('src/a.ts')
    expect(pathArgument('{"path":"src/b.ts"}')).toBe('src/b.ts')
    expect(pathArgument('{"file_path":"  "}')).toBeUndefined()
    expect(pathArgument('{"command":"cat a"}')).toBeUndefined()
    expect(pathArgument('[1]')).toBeUndefined()
    expect(pathArgument('{not json')).toBeUndefined()
  })

  it('tracks the path of a pending tool call until its result settles it', () => {
    const tools = new Set(['write'])
    const session = Session.create(SessionId('tool-path'))
    const call = (callId: string, name: string, args: string) => session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: args })
    const result = (callId: string, isError: boolean) => session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }], isError }),
    }, { surfaceOp: 'append' })
    expect(foldToolPath(tools, {}, call('r1', 'read', '{"file_path":"a.ts"}'))).toBeUndefined()
    expect(foldToolPath(tools, {}, call('w0', 'write', '{}'))).toBeUndefined()
    expect(foldToolPath(tools, {}, session.append('turn/start', { turn: 1 }))).toBeUndefined()
    const pending = foldToolPath(tools, { w0: 'b.ts' }, call('w1', 'write', '{"file_path":"a.ts"}'))?.pending ?? {}
    expect(pending).toEqual({ w0: 'b.ts', w1: 'a.ts' })
    expect(foldToolPath(tools, pending, result('other', false))).toBeUndefined()
    const done = result('w1', false)
    expect(foldToolPath(tools, pending, done)).toEqual({ pending: { w0: 'b.ts' }, completed: { path: 'a.ts', seq: done.seq } })
    expect(foldToolPath(tools, pending, result('w0', true))).toEqual({ pending: { w1: 'a.ts' } })
  })

  it('appends both knowledge events to a session', () => {
    const session = Session.create(SessionId('events'))
    const write = session.append('knowledge/write', {
      id: knowledgePageId('concepts/a.md'), writer: 'tool', mode: 'enforce', applied: true, operation: 'create',
      stale: [], sourceEventSeqs: [SessionSeq(0)], sources: ['src/a.ts'],
    })
    const inject = session.append('knowledge/inject', {
      ids: [knowledgePageId('concepts/a.md')], bytes: 120, lines: 3, omitted: 0, quarantined: 0, digest: 'a'.repeat(64),
    })
    expect([write.type, inject.type]).toEqual(['knowledge/write', 'knowledge/inject'])
  })
})
