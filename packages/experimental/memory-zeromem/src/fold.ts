/**
 * The `zeromemTurn` projection: the stored text of the open turn and of the
 * last completed turn. A turn contributes each human `user/message` (source
 * kind `user`) and its last uninterrupted assistant text; tool calls, tool
 * results, reasoning, and injected context never enter the state. The last
 * completed turn stays in the state until the next turn completes, so a
 * resumed session can still store a turn whose ingestion the previous process
 * did not finish.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/fold
 */

import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

const textSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  text: z.string(),
})

const turnSchema = z.object({
  turn: z.number().int(),
  requests: z.array(textSchema),
  reply: textSchema.nullable(),
})

/** Zod schema of {@link ZeromemTurnState}. */
export const zeromemTurnStateSchema = z.object({
  open: turnSchema.nullable(),
  completed: turnSchema.nullable(),
})

/** One stored text: the event it came from, the event time in epoch milliseconds, and the bounded text. */
export type TurnText = z.infer<typeof textSchema>

/** The stored texts of one turn. */
export type TurnTexts = z.infer<typeof turnSchema>

/** Folded texts of the open turn and of the last completed turn. */
export type ZeromemTurnState = z.infer<typeof zeromemTurnStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Texts of the open and the last completed turn that conversation memory stores. */
    zeromemTurn: ZeromemTurnState
  }
}

/**
 * The state of a session with no turn yet.
 * @returns no open and no completed turn.
 */
export function emptyZeromemTurn(): ZeromemTurnState {
  return { open: null, completed: null }
}

/**
 * Visible text of content blocks, cut to a character bound.
 * @param blocks - message content.
 * @param maxChars - most characters kept.
 * @returns the trimmed text blocks joined, at most `maxChars` characters.
 */
function boundedText(blocks: readonly ContentBlock[], maxChars: number): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('').trim().slice(0, maxChars)
}

/**
 * Fold one session event.
 * @param maxChars - most characters stored per text.
 * @param state - state before the event.
 * @param event - the committed event.
 * @returns the state after the event.
 */
export function applyZeromemTurn(maxChars: number, state: ZeromemTurnState, event: SessionEvent): ZeromemTurnState {
  switch (event.type) {
    case 'turn/start':
      return { ...state, open: { turn: event.data.turn, requests: [], reply: null } }
    case 'user/message': {
      if (state.open === null || event.data.source.kind !== 'user') return state
      const text = boundedText(event.data.content, maxChars)
      if (text === '') return state
      return { ...state, open: { ...state.open, requests: [...state.open.requests, { seq: event.seq, time: event.time, text }] } }
    }
    case 'assistant/message': {
      if (state.open === null || event.data.interrupted === true) return state
      const text = boundedText(event.data.message.content, maxChars)
      if (text === '') return state
      return { ...state, open: { ...state.open, reply: { seq: event.seq, time: event.time, text } } }
    }
    case 'turn/end':
      return state.open?.turn === event.data.turn ? { open: null, completed: state.open } : state
    default:
      // SessionEventMap is merge-extensible; no other event changes the stored texts.
      return state
  }
}
