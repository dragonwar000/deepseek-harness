import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyEvidence, emptyEvidence } from '../src/evidence.ts'

const TOOLS = new Set(['read', 'str_replace_editor'])

function fold(append: (session: Session) => void): ReturnType<typeof emptyEvidence> {
  const session = Session.create(SessionId('evidence'))
  append(session)
  return session.snapshotEvents().reduce((state, event: SessionEvent) => applyEvidence(TOOLS, state, event), emptyEvidence())
}

function callAndResult(session: Session, callId: string, name: string, args: string, isError: boolean): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: args })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'x' }], isError }),
  }, { surfaceOp: 'append' })
}

describe('applyEvidence', () => {
  it('records the latest successful result of each path an evidence tool read', () => {
    const state = fold((session) => {
      session.append('turn/start', { turn: 1 })
      callAndResult(session, 'r1', 'read', '{"file_path":"src/a.ts"}', false)
      callAndResult(session, 'r2', 'str_replace_editor', '{"command":"view","path":"src/b.ts"}', false)
      callAndResult(session, 'r3', 'read', '{"file_path":"src/a.ts"}', false)
    })
    expect(state).toEqual({ pending: {}, reads: { 'src/a.ts': 6, 'src/b.ts': 4 } })
  })

  it('ignores other tools, calls without a path, failed results, and unknown results', () => {
    const state = fold((session) => {
      session.append('turn/start', { turn: 1 })
      callAndResult(session, 'b1', 'bash', '{"command":"cat src/a.ts"}', false)
      callAndResult(session, 'r1', 'read', '{}', false)
      callAndResult(session, 'r2', 'read', '{"file_path":"src/a.ts"}', true)
      session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('open'), name: 'read', arguments: '{"file_path":"src/c.ts"}' })
    })
    expect(state).toEqual({ pending: { open: 'src/c.ts' }, reads: {} })
  })
})
