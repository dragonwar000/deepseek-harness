/**
 * The one home of the counterpart requirement: which in-scope documents must
 * merge with a Chinese counterpart. The pairing gate and locale-aware link
 * resolution both read it, so a source exempted here is exempted from the
 * missing-counterpart rejection AND from having links to it switched toward a
 * counterpart that does not exist.
 *
 * Agent Notes are English-only, decided 2026-09-30 and recorded in
 * `.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md`.
 * The exemption is exactly the active Agent Note files, and it removes only the
 * requirement to have a counterpart: a counterpart that does exist is still a
 * pair, checked in full for completeness and consistency. `.agents/notes/README.md`,
 * `docs/**`, `python/**`, package READMEs, and the root paired documents still
 * merge bilingual, and frozen `.agents/notes/archived/**` triplets stay complete
 * under `verify-archived-agent-notes`.
 */

import { isActiveAgentNotePath } from './agent-note-tree.ts'

/** Verdict for one in-scope, non-excluded English source with no Chinese counterpart present. */
export type TranslationCounterpartVerdict =
  | { state: 'english-only' }
  | { state: 'missing'; error: string }

/**
 * Whether one in-scope English source must merge with a Chinese counterpart.
 *
 * @param source - Repository-relative English `.md` path with `/` separators.
 * @returns False only for an active Agent Note, which may merge English-only.
 */
export function requiresTranslationCounterpart(source: string): boolean {
  return !isActiveAgentNotePath(source)
}

/**
 * Decide what an absent Chinese counterpart means for one in-scope,
 * non-excluded English source, and render the gate's rejection when the
 * counterpart is required.
 *
 * @param source - Repository-relative English `.md` path with `/` separators.
 * @returns `english-only` when the source may merge alone, otherwise the rejection.
 */
export function translationCounterpartVerdict(source: string): TranslationCounterpartVerdict {
  if (!requiresTranslationCounterpart(source)) return { state: 'english-only' }
  return {
    state: 'missing',
    error: `${source}: in-scope documentation must merge bilingual (docs/i18n/README.md); add the counterpart and record the pair`,
  }
}
