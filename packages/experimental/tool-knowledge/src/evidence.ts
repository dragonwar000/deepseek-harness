/**
 * The `knowledgeEvidence` projection: for every path an evidence tool (for
 * example `read`) was called with, the seq of its latest successful
 * `tool/result`, folded from `tool/call` and `tool/result`. `knowledge_write`
 * looks up the reads a page cites here.
 * @module @deepseek-ai/dsh-experimental-tool-knowledge/evidence
 */

import { z } from 'zod'
import { pathArgument } from '@deepseek-ai/dsh-experimental-knowledge'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

/** Zod schema of {@link EvidenceState}. */
export const evidenceStateSchema = z.object({
  /** Path argument of evidence calls still waiting for their result, by call id. */
  pending: z.record(z.string(), z.string()),
  /** Seq of the latest successful result, by path argument as the model wrote it. */
  reads: z.record(z.string(), z.number().int().nonnegative()),
})

/** Folded evidence of one session. */
export type EvidenceState = z.infer<typeof evidenceStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Paths evidence tools read, with the seq of their latest successful result. */
    knowledgeEvidence: EvidenceState
  }
}

/**
 * The initial state.
 * @returns no pending calls and no reads.
 */
export function emptyEvidence(): EvidenceState {
  return { pending: {}, reads: {} }
}

/**
 * Fold one session event.
 * @param tools - evidence tool names.
 * @param state - state before the event.
 * @param event - the committed event.
 * @returns the state after the event.
 */
export function applyEvidence(tools: ReadonlySet<string>, state: EvidenceState, event: SessionEvent): EvidenceState {
  switch (event.type) {
    case 'tool/call': {
      if (!tools.has(event.data.name)) return state
      const path = pathArgument(event.data.arguments)
      if (path === undefined) return state
      return { ...state, pending: { ...state.pending, [event.data.callId]: path } }
    }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      const path = state.pending[callId]
      if (path === undefined) return state
      const pending = Object.fromEntries(Object.entries(state.pending).filter(([key]) => key !== callId))
      if (event.data.message.isError === true) return { ...state, pending }
      return { pending, reads: { ...state.reads, [path]: event.seq } }
    }
    default:
      // SessionEventMap is merge-extensible; every other event leaves the evidence unchanged.
      return state
  }
}
