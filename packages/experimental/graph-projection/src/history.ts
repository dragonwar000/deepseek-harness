/**
 * The `graphHistory` projection and the transcript reader behind
 * history_read: every span that compaction replaced (`compaction/summary`)
 * or shortened in place (`compaction/prune`), and a bounded, paged rendering
 * of its original events read through the session query service.
 * @module @deepseek-ai/dsh-experimental-graph-projection/history
 */

import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type { HistorySpan, HistoryState } from './types.ts'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/** `graphHistory` state schema. */
export const historyStateSchema = z.object({
  spans: z.array(z.object({
    seq: count,
    kind: z.enum(['summary', 'prune']),
    start: count,
    end: count,
    items: z.array(count),
  }).strict()),
}).strict() as z.ZodType<HistoryState>

/**
 * The state before any compaction.
 * @returns no spans.
 */
export function emptyHistory(): HistoryState {
  return { spans: [] }
}

/**
 * Fold one event.
 * @param state - state before the event.
 * @param event - any committed Session event.
 * @returns the same state for unrelated events, otherwise the state with one more span.
 */
export function applyHistoryEvent(state: HistoryState, event: SessionEvent): HistoryState {
  switch (event.type) {
    case 'compaction/summary':
    case 'compaction/prune':
      return {
        spans: [...state.spans, {
          seq: event.seq,
          kind: event.type === 'compaction/summary' ? 'summary' : 'prune',
          start: event.data.shadowedRange.start,
          end: event.data.shadowedRange.end,
          items: [...event.data.shadowedSeqs],
        }],
      }
    // SessionEventMap is merge-extensible; every other event leaves the spans unchanged.
    default: return state
  }
}

/** Host-only projection unit registered by the graph-projection plugin. */
export const graphHistoryProjection = {
  key: 'graphHistory',
  stateVersion: 1,
  stateSchema: historyStateSchema,
  init: emptyHistory,
  apply: applyHistoryEvent,
} satisfies ProjectionDefinition<'graphHistory', HistoryState>

/** The event read history_read uses; the session query service satisfies it structurally. */
export interface HistoryReader {
  /**
   * Read one event and the raw events after it.
   * @param request - session, target seq, and the number of following events.
   * @param signal - cancellation of the history_read call.
   * @returns the target and its window.
   */
  readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
}

const LABELS: Readonly<Record<string, string>> = {
  'user/message': 'User',
  'assistant/message': 'Assistant',
  'tool/result': 'Tool result',
  'system/message': 'System',
  'developer/message': 'Developer',
}

/**
 * One transcript line.
 * @param event - an original event of a compacted span.
 * @param maxChars - the page budget; a longer line is cut to it.
 * @returns `#<seq> <Role>: <text>`, the event type standing in for the role of a non-message event.
 */
export function transcriptLine(event: SessionEvent, maxChars: number): string {
  const line = `#${event.seq} ${LABELS[event.type] ?? event.type}: ${extractSessionEventText(event)}`
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)} …[truncated]`
}

/**
 * Read an entry the caller has cached.
 * @param map - cache.
 * @param key - a key the caller cached.
 * @returns the value.
 */
function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key)
  /* v8 ignore next -- readEvent returns its target seq inside the window, so every requested seq is cached before it is read. */
  if (value === undefined) throw new Error(`history_read: seq ${String(key)} was not read`)
  return value
}

/**
 * One page of a compacted span as a transcript, in the span's surface order.
 * @param reader - the session query service.
 * @param sessionId - the calling session.
 * @param span - the span.
 * @param offset - index of the first item of the page.
 * @param limits - page budget in characters and events per read.
 * @param signal - cancellation of the history_read call.
 * @returns the transcript, and the offset of the next page when the budget stopped it.
 */
export async function readSpan(
  reader: HistoryReader,
  sessionId: SessionId,
  span: HistorySpan,
  offset: number,
  limits: { readonly maxChars: number; readonly readWindow: number },
  signal?: AbortSignal,
): Promise<{ transcript: string; nextOffset?: number }> {
  const wanted = new Set(span.items)
  const cache = new Map<number, SessionEvent>()
  const lines: string[] = []
  let used = 0
  for (const seq of span.items.slice(offset)) {
    if (!cache.has(seq)) {
      const window = await reader.readEvent({ sessionId, seq: SessionSeq(seq), after: limits.readWindow }, signal)
      for (const event of window.events) {
        if (wanted.has(event.seq)) cache.set(event.seq, event)
      }
    }
    const line = transcriptLine(must(cache, seq), limits.maxChars)
    if (lines.length > 0 && used + line.length > limits.maxChars) return { transcript: lines.join('\n'), nextOffset: offset + lines.length }
    lines.push(line)
    used += line.length + 1
  }
  return { transcript: lines.join('\n') }
}
