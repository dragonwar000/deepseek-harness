import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-experimental-verifier-gate'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyDistill, emptyDistill, parseVerdict } from '../src/fold.ts'
import type { DistillState } from '../src/fold.ts'

const TOOLS = new Set(['write', 'edit'])

function fold(append: (session: Session) => void): DistillState {
  const session = Session.create(SessionId('fold'))
  append(session)
  return session.snapshotEvents().reduce((state, event: SessionEvent) => applyDistill(TOOLS, state, event), emptyDistill())
}

function change(session: Session, callId: string, name: string, path: string, isError = false): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify({ file_path: path }) })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }], isError }),
  }, { surfaceOp: 'append' })
}

function verdict(session: Session, turn: number, kind: 'ok' | 'not-ok'): void {
  session.append('loop/verdict', { turn, mode: 'shadow', verdict: kind, reason: kind === 'ok' ? 'all-passed' : 'command-failed', checks: [], continuation: 0, continued: false })
}

describe('applyDistill', () => {
  it('keeps the human request, the latest change per path, the final response, and a verdict at that response', () => {
    const state = fold((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'verifier-gate', form: 'notice', summary: 'steer' } }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Add retry' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      change(session, 'w1', 'write', 'src/a.ts')
      change(session, 'r1', 'read', 'src/b.ts')
      change(session, 'e1', 'edit', 'src/c.ts', true)
      change(session, 'w2', 'write', 'src/a.ts')
      session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('bad'), name: 'write', arguments: '{}' })
      verdict(session, 2, 'ok')
    })
    expect(state).toMatchObject({ turn: 1, request: 'Add retry', pending: {}, changes: [{ path: 'src/a.ts', seq: 11 }], verdict: null, distilled: false })
  })

  it('ties a verdict to the latest response and marks a distilled turn', () => {
    const session = Session.create(SessionId('fold-verdict'))
    session.append('turn/start', { turn: 1 })
    verdict(session, 1, 'not-ok')
    const events = session.snapshotEvents()
    let state = events.reduce((current, event: SessionEvent) => applyDistill(TOOLS, current, event), emptyDistill())
    expect(state.verdict).toEqual({ seq: 1, verdict: 'not-ok', boundary: null })
    state = applyDistill(TOOLS, state, { type: 'knowledge/write', seq: SessionSeq(2), time: 0, data: { id: knowledgePageId('episodes/x.md'), writer: 'tool', mode: 'enforce', applied: true, operation: 'create', stale: [], sourceEventSeqs: [], sources: [] } })
    expect(state.distilled).toBe(false)
    state = applyDistill(TOOLS, state, { type: 'knowledge/write', seq: SessionSeq(3), time: 0, data: { id: knowledgePageId('episodes/x.md'), writer: 'distill', mode: 'shadow', applied: false, stale: [], sourceEventSeqs: [], sources: [] } })
    expect(state.distilled).toBe(true)
    expect(applyDistill(TOOLS, state, { type: 'turn/start', seq: SessionSeq(4), time: 0, data: { turn: 2 } })).toEqual(emptyDistill(2))
  })

  it('ignores a loop/verdict with fields this build does not read', () => {
    const foreign = JSON.parse('{"type":"loop/verdict","seq":5,"time":0,"data":{"turn":"one"}}') as SessionEvent
    expect(applyDistill(TOOLS, emptyDistill(1), foreign)).toEqual(emptyDistill(1))
    expect(parseVerdict({ turn: 1, verdict: 'ok', extra: true })).toEqual({ turn: 1, verdict: 'ok' })
    expect(parseVerdict(null)).toBeUndefined()
  })
})
