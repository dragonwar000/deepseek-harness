/**
 * The `memoryDistill` projection: facts of the open turn that an episode
 * needs — the human request, the latest successful change per path, the final
 * response, a verifier verdict tied to that response, and whether the turn was
 * already distilled. The verifier gate's `loop/verdict` is read by name and
 * validated here, so this package does not depend on the gate.
 * @module @deepseek-ai/dsh-experimental-memory-distill/fold
 */

import { z } from 'zod'
import { foldToolPath } from '@deepseek-ai/dsh-experimental-knowledge'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

/** Zod schema of {@link DistillState}. */
export const distillStateSchema = z.object({
  turn: z.number().int().nullable(),
  request: z.string().nullable(),
  pending: z.record(z.string(), z.string()),
  changes: z.array(z.object({ path: z.string(), seq: z.number().int().nonnegative() })),
  boundary: z.number().int().nonnegative().nullable(),
  outcome: z.string(),
  verdict: z.object({
    seq: z.number().int().nonnegative(),
    verdict: z.string(),
    boundary: z.number().int().nonnegative().nullable(),
  }).nullable(),
  distilled: z.boolean(),
})

/** Folded facts of the open turn. */
export type DistillState = z.infer<typeof distillStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Facts of the open turn that an episode page needs. */
    memoryDistill: DistillState
  }
}

const verdictSchema = z.looseObject({ turn: z.number().int(), verdict: z.string() })

/**
 * The state at the start of a turn.
 * @param turn - the turn, or null before the first.
 * @returns empty facts.
 */
export function emptyDistill(turn: number | null = null): DistillState {
  return { turn, request: null, pending: {}, changes: [], boundary: null, outcome: '', verdict: null, distilled: false }
}

/**
 * The fields of a `loop/verdict` payload this package reads.
 * @param data - payload of an event named `loop/verdict`.
 * @returns turn and verdict, or `undefined` when the payload lacks them.
 */
export function parseVerdict(data: unknown): { turn: number; verdict: string } | undefined {
  const parsed = verdictSchema.safeParse(data)
  return parsed.success ? { turn: parsed.data.turn, verdict: parsed.data.verdict } : undefined
}

/**
 * Visible text of content blocks.
 * @param blocks - message content.
 * @returns the text blocks joined.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
}

/**
 * Fold one session event.
 * @param changeTools - tools whose successful calls change their `file_path` or `path`.
 * @param state - state before the event.
 * @param event - the committed event.
 * @returns the state after the event.
 */
export function applyDistill(changeTools: ReadonlySet<string>, state: DistillState, event: SessionEvent): DistillState {
  switch (event.type) {
    case 'turn/start':
      return emptyDistill(event.data.turn)
    case 'user/message':
      return state.request !== null || event.data.source.kind !== 'user' ? state : { ...state, request: textOf(event.data.content) }
    case 'tool/call':
    case 'tool/result': {
      const folded = foldToolPath(changeTools, state.pending, event)
      if (folded === undefined) return state
      const { pending, completed } = folded
      if (completed === undefined) return { ...state, pending }
      return { ...state, pending, changes: [...state.changes.filter(change => change.path !== completed.path), completed] }
    }
    case 'assistant/message':
      return { ...state, boundary: event.seq, outcome: textOf(event.data.message.content) }
    case 'knowledge/write':
      return event.data.writer === 'distill' ? { ...state, distilled: true } : state
    default: {
      // SessionEventMap is merge-extensible; only the verifier gate's loop/verdict, read by name, changes the fold.
      const type: string = event.type
      if (type !== 'loop/verdict') return state
      const data: unknown = event.data
      const verdict = parseVerdict(data)
      if (verdict === undefined || verdict.turn !== state.turn) return state
      return { ...state, verdict: { seq: event.seq, verdict: verdict.verdict, boundary: state.boundary } }
    }
  }
}
