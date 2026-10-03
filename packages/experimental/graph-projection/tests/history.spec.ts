import { describe, expect, it } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import { applyHistoryEvent, emptyHistory, graphHistoryProjection, historyStateSchema, readSpan, transcriptLine } from '../src/history.ts'
import type { HistoryReader } from '../src/history.ts'

const user = (seq: number, text: string): SessionEvent => ({
  type: 'user/message', seq: SessionSeq(seq), time: 0, surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
})

/** A reader over fixed events that records the seq of every read. */
function reader(events: SessionEvent[]): HistoryReader & { reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow> {
      reads.push(request.seq)
      const window = events.filter(event => event.seq >= request.seq && event.seq <= request.seq + (request.after ?? 0))
      return Promise.resolve({ events: window } as SessionEventWindow)
    },
  }
}

describe('graphHistory projection', () => {
  it('records summary and prune spans in log order and ignores other events', () => {
    const summary: SessionEvent = {
      type: 'compaction/summary', seq: SessionSeq(9), time: 0,
      data: {
        compactionId: CompactionId('c1'), summary: [{ type: 'text', text: 's' }], shadowedRange: { start: SessionSeq(2), end: SessionSeq(5) },
        shadowedSeqs: [SessionSeq(2), SessionSeq(3), SessionSeq(5)], shadowedTokenCount: 10, provider: 'p', model: 'm',
      },
    }
    const prune: SessionEvent = {
      type: 'compaction/prune', seq: SessionSeq(11), time: 0,
      data: { shadowedRange: { start: SessionSeq(7), end: SessionSeq(7) }, shadowedSeqs: [SessionSeq(7)], shadowedTokenCount: 3 },
    }
    const state = [summary, user(10, 'x'), prune].reduce(applyHistoryEvent, emptyHistory())
    expect(state.spans).toEqual([
      { seq: 9, kind: 'summary', start: 2, end: 5, items: [2, 3, 5] },
      { seq: 11, kind: 'prune', start: 7, end: 7, items: [7] },
    ])
    expect(historyStateSchema.safeParse(state).success).toBe(true)
    expect(graphHistoryProjection).toMatchObject({ key: 'graphHistory', stateVersion: 1 })
  })
})

describe('transcripts', () => {
  it('labels surface events, names other events by type, and truncates a long line', () => {
    expect(transcriptLine(user(2, 'hello'), 100)).toBe('#2 User: hello')
    const call: SessionEvent = { type: 'tool/call', seq: SessionSeq(3), time: 0, data: { turn: 1, step: 1, callId: ToolCallId('c'), name: 'read', arguments: '{}' } }
    expect(transcriptLine(call, 100)).toBe('#3 tool/call: read\n{}')
    expect(transcriptLine(user(4, 'a'.repeat(50)), 20)).toBe(`#4 User: ${'a'.repeat(11)} …[truncated]`)
  })

  it('reads items in span order with bounded windows, reusing what a window returned', async () => {
    const events = [user(2, 'two'), user(3, 'three'), user(5, 'five'), user(6, 'six')]
    const source = reader(events)
    const page = await readSpan(source, SessionId('s'), { seq: 9, kind: 'summary', start: 5, end: 3, items: [5, 2, 3] }, 0, { maxChars: 1000, readWindow: 1 })
    expect(page).toEqual({ transcript: '#5 User: five\n#2 User: two\n#3 User: three' })
    expect(source.reads).toEqual([5, 2])
  })

  it('stops a page at maxChars and resumes at the returned offset', async () => {
    const text = 'a'.repeat(30)
    const source = reader([user(2, text), user(3, text), user(4, text)])
    const span = { seq: 9, kind: 'summary' as const, start: 2, end: 4, items: [2, 3, 4] }
    const first = await readSpan(source, SessionId('s'), span, 0, { maxChars: 70, readWindow: 50 })
    expect(first).toEqual({ transcript: `#2 User: ${text}`, nextOffset: 1 })
    const second = await readSpan(source, SessionId('s'), span, 1, { maxChars: 80, readWindow: 50 })
    expect(second).toEqual({ transcript: `#3 User: ${text}\n#4 User: ${text}` })
  })
})
