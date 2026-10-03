/**
 * Verified episodes for Zero-Mem. The projection folds one turn's request,
 * changed files, final response, and verifier verdict with memory-distill's
 * fold. {@link verifiedEpisode} decides whether the completed turn is verified,
 * and {@link renderEpisode} writes the spool text. No model is called.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/episode
 */

import { z } from 'zod'
import { applyDistill, distillStateSchema, emptyDistill } from '@deepseek-ai/dsh-experimental-memory-distill'
import type { EpisodeContent } from '@deepseek-ai/dsh-experimental-memory-distill'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

const episodeTurnSchema = z.object({
  turn: z.number().int(),
  facts: distillStateSchema,
  /** Seq of the latest user-kind message of the turn, or null before one. */
  input: z.number().int().nonnegative().nullable(),
  /** Event time, in epoch milliseconds, of the latest final response, or null. */
  responseTime: z.number().int().nonnegative().nullable(),
})

/** Zod schema of {@link ZeromemEpisodeState}. */
export const zeromemEpisodeStateSchema = z.object({
  open: episodeTurnSchema.nullable(),
  completed: episodeTurnSchema.nullable(),
})

/** Folded facts of one turn. */
export type EpisodeTurn = z.infer<typeof episodeTurnSchema>

/** Folded facts of the open turn and of the last completed turn that ended with reason `completed`. */
export type ZeromemEpisodeState = z.infer<typeof zeromemEpisodeStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Facts of the open turn and of the last completed turn that a verified episode needs. */
    zeromemEpisode: ZeromemEpisodeState
  }
}

/**
 * The state of a session with no turn yet.
 * @returns no open and no completed turn.
 */
export function emptyZeromemEpisode(): ZeromemEpisodeState {
  return { open: null, completed: null }
}

/**
 * Fold one session event.
 * @param changeTools - tools whose successful calls change their `file_path` or `path`.
 * @param state - state before the event.
 * @param event - the committed event.
 * @returns the state after the event.
 */
export function applyZeromemEpisode(
  changeTools: ReadonlySet<string>,
  state: ZeromemEpisodeState,
  event: SessionEvent,
): ZeromemEpisodeState {
  switch (event.type) {
    case 'turn/start':
      return { ...state, open: { turn: event.data.turn, facts: emptyDistill(event.data.turn), input: null, responseTime: null } }
    case 'turn/end': {
      const open = state.open
      if (open === null || open.turn !== event.data.turn) return state
      return { open: null, completed: event.data.reason.kind === 'completed' ? open : null }
    }
    default:
      return state.open === null ? state : { ...state, open: foldOpen(changeTools, state.open, event) }
  }
}

/**
 * Fold one event into the open turn.
 * @param changeTools - tools whose successful calls change their `file_path` or `path`.
 * @param open - facts of the open turn before the event.
 * @param event - the committed event.
 * @returns the facts after the event.
 */
function foldOpen(changeTools: ReadonlySet<string>, open: EpisodeTurn, event: SessionEvent): EpisodeTurn {
  const facts = applyDistill(changeTools, open.facts, event)
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user' ? { ...open, facts, input: event.seq } : { ...open, facts }
    case 'assistant/message':
      // An interrupted message is not a final response, so no earlier verdict can apply to it.
      if (event.data.interrupted === true) return { ...open, facts: { ...facts, boundary: null, outcome: '' }, responseTime: null }
      return { ...open, facts, responseTime: event.time }
    default:
      return { ...open, facts }
  }
}

/** Why a completed turn is not a verified episode. */
export type EpisodeRefusal = 'no-changes' | 'no-response' | 'no-verdict' | 'verdict-not-ok' | 'input-after-verdict' | 'changed-after-verdict'

/** Whether a completed turn is a verified episode, and the events it cites. */
export type EpisodeVerdict =
  | {
    readonly kind: 'verified'
    /** Seq of the final response. */
    readonly response: number
    /** Event time of the final response, in epoch milliseconds. */
    readonly responseTime: number
    /** Seq of the `ok` verdict. */
    readonly verdictSeq: number
    /** Latest successful change of each changed file. */
    readonly changes: readonly { readonly path: string; readonly seq: number }[]
  }
  | { readonly kind: 'refused'; readonly reason: EpisodeRefusal }

/**
 * Decide whether a completed turn is a verified episode. The verdict must name the final response, must be `ok`,
 * and must follow every change and every user message of the turn; otherwise the turn is refused.
 * @param turn - facts of the completed turn.
 * @returns the cited events when verified, else the refusal reason. A turn with no changed file is refused as `no-changes`.
 */
export function verifiedEpisode(turn: EpisodeTurn): EpisodeVerdict {
  const { facts } = turn
  if (facts.changes.length === 0) return { kind: 'refused', reason: 'no-changes' }
  if (facts.boundary === null || facts.outcome.trim() === '' || turn.responseTime === null) return { kind: 'refused', reason: 'no-response' }
  const verdict = facts.verdict
  if (verdict === null || verdict.boundary !== facts.boundary) return { kind: 'refused', reason: 'no-verdict' }
  if (verdict.verdict !== 'ok') return { kind: 'refused', reason: 'verdict-not-ok' }
  if (turn.input !== null && turn.input > verdict.seq) return { kind: 'refused', reason: 'input-after-verdict' }
  if (facts.changes.some(change => change.seq > verdict.seq)) return { kind: 'refused', reason: 'changed-after-verdict' }
  return { kind: 'verified', response: facts.boundary, responseTime: turn.responseTime, verdictSeq: verdict.seq, changes: facts.changes }
}

/** Events an episode cites. */
interface EpisodeRefs {
  readonly turn: number
  readonly response: number
  readonly verdictSeq: number
  readonly changes: readonly { readonly path: string; readonly seq: number }[]
}

/** Inputs of {@link renderEpisode}. */
export interface EpisodeRender extends EpisodeRefs {
  /** Filtered, bounded request and outcome. */
  readonly content: EpisodeContent
  /** Most characters the text may hold. */
  readonly maxChars: number
}

/**
 * The lines of an episode around its request and outcome.
 * @param refs - the turn and the events it cites.
 * @param request - request text, already bounded.
 * @param outcome - outcome text, already bounded.
 * @returns the lines in spool order.
 */
function episodeLines(refs: EpisodeRefs, request: string, outcome: string): string[] {
  return [
    '# Verified episode',
    `Turn: ${refs.turn}`,
    `Final response event: ${refs.response}`,
    `Verifier event: ${refs.verdictSeq}; verdict: ok`,
    '',
    '## Request',
    '',
    request,
    '',
    '## Outcome',
    '',
    outcome,
    '',
    '## Files changed',
    '',
    ...refs.changes.map(change => `- ${change.path} — successful tool result event ${change.seq}`),
    '',
    '## Verification',
    '',
    `The verifier accepted the final response at event ${refs.response}.`,
  ]
}

/**
 * Cut text to a character count, marking the cut with ` …`.
 * @param text - text.
 * @param room - characters available.
 * @returns the text when it fits, else a cut no longer than `room`; empty when `room` is below 3.
 */
function fitText(text: string, room: number): string {
  if (text.length <= room) return text
  if (room < 3) return ''
  return `${text.slice(0, room - 2).trimEnd()} …`
}

/**
 * The spool text of one verified episode. The identifiers, verdict, and changed files are never cut; the request
 * and then the outcome shrink to the room the rest leaves.
 * @param input - the cited events, the bounded content, and the character limit.
 * @returns the text, or undefined when the identifiers and changed files alone exceed the limit.
 */
export function renderEpisode(input: EpisodeRender): string | undefined {
  const fixed = episodeLines(input, '', '').join('\n').length
  const room = input.maxChars - fixed
  if (room < 0) return undefined
  const request = fitText(input.content.request, room)
  const outcome = fitText(input.content.outcome, room - request.length)
  return episodeLines(input, request, outcome).join('\n')
}

/**
 * The fewest characters an episode text can take: its fixed lines with the largest event numbers, no request, outcome,
 * or changed file. A `maxEpisodeChars` below this cannot hold the identifiers and verification, so load refuses it.
 * @returns the character count.
 */
export function episodeFixedChars(): number {
  const largest = Number.MAX_SAFE_INTEGER
  return episodeLines({ turn: largest, response: largest, verdictSeq: largest, changes: [] }, '', '').join('\n').length
}
