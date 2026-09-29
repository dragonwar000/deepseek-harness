import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { knowledgePageId } from '../src/index.ts'
import * as KnowledgeInvariant from '../src/invariant.ts'
import type { KnowledgeWriteRecord } from '../src/types.ts'

/** A session whose events from `seed` precede the invariant; without `seed` the invariant sees `turn/start` at seq 0. */
async function open(id: string, seed?: (session: Session) => void): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (seed === undefined) {
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(KnowledgeInvariant)
    const session = ctx.sessions.create(SessionId(id))
    session.append('turn/start', { turn: 1 })
    return session
  }
  const session = ctx.sessions.create(SessionId(id))
  seed(session)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(KnowledgeInvariant)
  return session
}

function result(session: Session, callId: string, isError: boolean): SessionSeq {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'read' }], isError }),
  }, { surfaceOp: 'append' }).seq
}

function write(sourceEventSeqs: SessionSeq[], applied = true): KnowledgeWriteRecord {
  return {
    id: knowledgePageId('concepts/a.md'), writer: 'tool', mode: applied ? 'enforce' : 'shadow', applied,
    ...applied ? { operation: 'create' as const } : {}, stale: [], sourceEventSeqs, sources: ['src/a.ts'],
  }
}

const VIOLATION: Partial<InvariantError> = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-knowledge' }

describe('knowledge invariant', () => {
  it('accepts an applied write citing an earlier successful tool result', async () => {
    const session = await open('kn-ok')
    const seq = result(session, 'r1', false)
    expect(() => session.append('knowledge/write', write([seq]))).not.toThrow()
  })

  it('rejects an applied write citing a failed tool result', async () => {
    const session = await open('kn-failed')
    const seq = result(session, 'r1', true)
    expect(() => session.append('knowledge/write', write([seq]))).toThrow(expect.objectContaining(VIOLATION))
  })

  it('rejects an applied write citing an event that is not a tool result', async () => {
    const session = await open('kn-kind')
    expect(() => session.append('knowledge/write', write([SessionSeq(0)]))).toThrow(expect.objectContaining(VIOLATION))
  })

  it('rejects an applied write without a source event', async () => {
    const session = await open('kn-empty')
    expect(() => session.append('knowledge/write', write([]))).toThrow(expect.objectContaining(VIOLATION))
  })

  it('ignores a write that was not applied', async () => {
    const session = await open('kn-shadow')
    expect(() => session.append('knowledge/write', write([], false))).not.toThrow()
  })

  it('skips citations older than the first event this process observed', async () => {
    const session = await open('kn-resumed', (seeded) => {
      seeded.append('turn/start', { turn: 1 })
      seeded.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId('old'), content: [{ type: 'text', text: 'read' }], isError: false }),
      }, { surfaceOp: 'append' })
    })
    expect(() => session.append('knowledge/write', write([SessionSeq(1)]))).not.toThrow()
  })
})
