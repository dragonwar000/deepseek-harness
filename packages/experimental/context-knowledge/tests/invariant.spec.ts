import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as ContextInvariant from '../src/invariant.ts'

async function open(id: string): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(ContextInvariant)
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return session
}

function inject(session: Session, bytes: number): void {
  session.append('knowledge/inject', { ids: [knowledgePageId('concepts/a.md')], bytes, lines: 1, omitted: 0, quarantined: 0, digest: 'd'.repeat(64) })
}

function message(session: Session, text: string, kind: 'knowledge-context' | 'user' = 'knowledge-context'): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: kind === 'user' ? { kind: 'user' } : { kind: 'knowledge-context', form: 'snapshot', sections: [{ name: 'knowledge-context', text }] },
  }), { surfaceOp: 'append' })
}

const VIOLATION: Partial<InvariantError> = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-context-knowledge' }

describe('context-knowledge invariant', () => {
  it('accepts an index message whose size the record states', async () => {
    const session = await open('ck-ok')
    message(session, 'human', 'user')
    inject(session, 5)
    expect(() => { message(session, 'index') }).not.toThrow()
  })

  it('rejects an index message of another size', async () => {
    const session = await open('ck-size')
    inject(session, 4)
    expect(() => { message(session, 'index') }).toThrow(expect.objectContaining(VIOLATION))
  })

  it('rejects an index message without a record', async () => {
    const session = await open('ck-missing')
    expect(() => { message(session, 'index') }).toThrow(expect.objectContaining(VIOLATION))
  })

  it('rejects a second record in the same turn before delivery, and forgets undelivered records at the next turn', async () => {
    const session = await open('ck-twice')
    inject(session, 5)
    expect(() => { inject(session, 5) }).toThrow(expect.objectContaining(VIOLATION))
    const next = await open('ck-next-turn')
    inject(next, 5)
    next.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    next.append('turn/start', { turn: 2 })
    expect(() => { message(next, 'index') }).toThrow(expect.objectContaining(VIOLATION))
  })
})
