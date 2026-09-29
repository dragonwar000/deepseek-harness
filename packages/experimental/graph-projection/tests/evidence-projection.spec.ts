import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyEvidenceEvent, emptyEvidence, evidenceStateSchema, graphEvidenceProjection } from '../src/evidence-projection.ts'
import type { EvidenceState } from '../src/types.ts'

const call = (seq: number, callId: string, name: string, args: string): SessionEvent<'tool/call'> => ({
  type: 'tool/call', seq: SessionSeq(seq), time: 0, data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: args },
})
/** A tool result as agent-loop appends it (citing its call), or a pruner replacement of an earlier result. */
const result = (seq: number, callId: string, text: string, isError = false, replaces?: number): SessionEvent<'tool/result'> => ({
  type: 'tool/result', seq: SessionSeq(seq), time: 0,
  data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError }) },
  ...replaces === undefined
    ? { surfaceOp: 'append' as const, sourceEventSeqs: [SessionSeq(seq - 1)] }
    : { surfaceOp: { op: 'replace' as const, startSeq: SessionSeq(replaces), endSeq: SessionSeq(replaces) }, sourceEventSeqs: [SessionSeq(replaces)] },
})
const start = (seq: number, turn: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn } })

function fold(events: SessionEvent[]): EvidenceState {
  return events.reduce(applyEvidenceEvent, emptyEvidence())
}

describe('graphEvidence projection', () => {
  it('declares a host-only unit at state version 1', () => {
    expect(graphEvidenceProjection).toMatchObject({ key: 'graphEvidence', stateVersion: 1 })
    expect(evidenceStateSchema.safeParse(emptyEvidence()).success).toBe(true)
  })

  it('records call arguments, successful and failed results, and skips replacements and citations', () => {
    const state = fold([
      start(0, 1),
      call(1, 'c1', 'read', '{"path":"src/a.ts"}'),
      result(2, 'c1', 'contents of src/a.ts'),
      call(3, 'c2', 'bash', '{"command":"pnpm test --filter a"}'),
      result(4, 'c2', 'no such file notes/old.md', true),
      result(5, 'c1', 'pruned src/pruned.ts', false, 2),
      call(6, 'c3', 'graph_cite', '{"claim":"src/cited.ts"}'),
      result(7, 'c3', 'graph_cite: path src/cited.ts is parametric'),
      result(8, 'unknown', 'orphan src/orphan.ts'),
      result(9, 'c1', 'nothing path-like'),
    ])
    expect(state.paths).toEqual([
      { text: 'notes/old.md', leaves: [{ kind: 'absence', seq: 4, tool: 'bash' }] },
      { text: 'src/a.ts', leaves: [{ kind: 'tool-record', seq: 1, tool: 'read' }, { kind: 'observed', seq: 2, tool: 'read' }] },
    ])
    expect(state.commands).toEqual([{ text: 'pnpm test --filter a', leaves: [{ kind: 'tool-record', seq: 3, tool: 'bash' }] }])
    expect(state.calls.map(entry => entry.tool)).toEqual(['read', 'bash', 'graph_cite'])
    expect(evidenceStateSchema.safeParse(state).success).toBe(true)
  })

  it('resets at every turn start and leaves unrelated events alone', () => {
    const before = fold([start(0, 1), call(1, 'c1', 'read', '{"path":"src/a.ts"}')])
    expect(applyEvidenceEvent(before, { type: 'step/start', seq: SessionSeq(2), time: 0, data: { turn: 1, step: 2 } })).toBe(before)
    expect(applyEvidenceEvent(before, start(3, 2))).toEqual({ turn: 2, calls: [], paths: [], commands: [], answer: null })
  })
})
