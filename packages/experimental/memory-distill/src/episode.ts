/**
 * The episode page of one verified turn: the human request, the final
 * response without statements marked temporary, the changed files, and the
 * verifier verdict. Pure functions; no model is called.
 * @module @deepseek-ai/dsh-experimental-memory-distill/episode
 */

import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEntry, KnowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'

/** Inputs of {@link episodeEntry}. */
export interface EpisodeInput {
  /** Store directory for episode pages. */
  readonly dir: string
  /** Session id. */
  readonly sessionId: string
  /** Turn number. */
  readonly turn: number
  /** `YYYY-MM-DD` of the write. */
  readonly date: string
  /** First human message of the turn, or null. */
  readonly request: string | null
  /** Visible text of the final response. */
  readonly outcome: string
  /** Changed files with the seq of their latest successful change. */
  readonly changes: readonly { readonly path: string; readonly seq: number }[]
  /** Seq of the `ok` verdict, when one was required and recorded. */
  readonly verdictSeq: number | undefined
  /** Markers of temporary statements. */
  readonly markers: readonly string[]
  /** Characters of the request kept. */
  readonly maxRequestChars: number
  /** Characters of the outcome kept. */
  readonly maxOutcomeChars: number
}

const NONE = '(none)'

/** Inputs of {@link episodeContent}. */
export interface EpisodeContentInput {
  /** First human message of the turn, or null. */
  readonly request: string | null
  /** Visible text of the final response. */
  readonly outcome: string
  /** Markers of temporary statements. */
  readonly markers: readonly string[]
  /** Characters of the request kept. */
  readonly maxRequestChars: number
  /** Characters of the outcome kept. */
  readonly maxOutcomeChars: number
}

/** The filtered, bounded text of one episode. */
export interface EpisodeContent {
  /** One line naming the request, at most 80 characters. */
  readonly summary: string
  /** The request without temporary sentences, bounded, or `(none)`. */
  readonly request: string
  /** The final response without temporary sentences, bounded, or `(none)`. */
  readonly outcome: string
}

/**
 * Drop every sentence that contains a temporary marker, and blank lines.
 * @param text - response or request text.
 * @param markers - temporary markers, matched case-insensitively.
 * @returns the remaining text, trimmed.
 */
export function filterTransient(text: string, markers: readonly string[]): string {
  const lowered = markers.map(marker => marker.toLowerCase())
  return text
    .split('\n')
    .map(line => line.split(/(?<=[.!?])\s+/).filter(sentence => !lowered.some(marker => sentence.toLowerCase().includes(marker))).join(' '))
    .filter(line => line.trim() !== '')
    .join('\n')
    .trim()
}

/**
 * Cut text to a character count, marking the cut.
 * @param text - text.
 * @param max - characters kept.
 * @returns the text, or its first `max` characters followed by ` …`.
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()} …` : text
}

/**
 * Page id of one episode.
 * @param dir - store directory for episodes.
 * @param sessionId - session id; characters outside letters, digits, `_` and `-` become `-`, 24 kept.
 * @param turn - turn number.
 * @param date - `YYYY-MM-DD`.
 * @returns the page id.
 */
export function episodeId(dir: string, sessionId: string, turn: number, date: string): KnowledgePageId {
  return knowledgePageId(`${dir}/${date}-${sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)}-t${turn}.md`)
}

/**
 * Filter and bound the request and outcome of one verified turn.
 * @param input - turn text and its limits.
 * @returns the summary line, the request, and the outcome; an empty part reads `(none)`.
 */
export function episodeContent(input: EpisodeContentInput): EpisodeContent {
  const request = filterTransient(input.request ?? '', input.markers)
  const outcome = filterTransient(input.outcome, input.markers)
  const first = request.split('\n', 1).join('').trim()
  return {
    summary: first === '' ? '(no request text)' : clip(first, 80),
    request: request === '' ? NONE : clip(request, input.maxRequestChars),
    outcome: outcome === '' ? NONE : clip(outcome, input.maxOutcomeChars),
  }
}

/**
 * The episode entry of one verified turn.
 * @param input - turn facts.
 * @returns an `episode` page with no relations.
 */
export function episodeEntry(input: EpisodeInput): KnowledgeEntry {
  const content = episodeContent(input)
  return {
    id: episodeId(input.dir, input.sessionId, input.turn, input.date),
    type: 'episode',
    title: `Turn ${input.turn}: ${content.summary}`,
    relations: [],
    body: [
      '## Request',
      '',
      content.request,
      '',
      '## Outcome',
      '',
      content.outcome,
      '',
      '## Files changed',
      '',
      ...input.changes.map(change => `- \`${change.path}\``),
      '',
      '## Verification',
      '',
      input.verdictSeq === undefined ? 'No verifier verdict was recorded for this turn.' : `The verifier gate recorded verdict ok at session event ${input.verdictSeq}.`,
    ].join('\n'),
  }
}
