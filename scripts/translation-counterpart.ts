/**
 * The one home of the Chinese-counterpart policy. English is the only required
 * documentation language; the pairing gate, locale-aware link resolution, and
 * the archive verifier read the rules below instead of restating them.
 *
 * - `TRANSLATION_COUNTERPART_POLICY` is the repository switch. Under
 *   `optional`, a missing, incomplete, or out-of-sync counterpart is reported
 *   and never fails a gate. Under `required`, each of those findings fails.
 * - An active Agent Note accepts no counterpart under either policy: a `.zh.md`
 *   or `.i18n.yaml` beside one is rejected.
 * - A finding about a file that must not exist, a record that cannot be parsed,
 *   or a counterpart whose English source is gone fails under either policy.
 *
 * `.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md`
 * records the decision. Client UI locale dictionaries are product behavior and
 * are outside this policy.
 */

import { isActiveAgentNotePath } from './agent-note-tree.ts'

/** Whether an in-scope document must merge with a consistent Chinese counterpart. */
export type TranslationCounterpartPolicy = 'optional' | 'required'

/** The policy every documentation gate applies unless a caller names another. */
export const TRANSLATION_COUNTERPART_POLICY: TranslationCounterpartPolicy = 'optional'

/** One pairing-gate finding and the class that decides whether it fails the gate. */
export interface TranslationPairingFinding {
  /**
   * `integrity` fails under either policy. `counterpart` concerns a missing,
   * incomplete, or out-of-sync counterpart and fails only under `required`.
   */
  kind: 'integrity' | 'counterpart'
  message: string
}

/**
 * Parse a policy name received from a command line.
 *
 * @param value - Candidate policy name.
 * @returns The policy.
 * @throws Error when the name is not a policy.
 */
export function parseTranslationCounterpartPolicy(value: string): TranslationCounterpartPolicy {
  if (value === 'optional' || value === 'required') return value
  throw new Error(`unknown counterpart policy ${JSON.stringify(value)} (expected optional or required)`)
}

/**
 * Whether an English source may have a Chinese counterpart at all.
 *
 * @param source - Repository-relative English `.md` path with `/` separators.
 * @returns False only for an active Agent Note.
 */
export function acceptsTranslationCounterpart(source: string): boolean {
  return !isActiveAgentNotePath(source)
}

/**
 * Whether an English source must merge with a Chinese counterpart.
 *
 * @param source - Repository-relative English `.md` path with `/` separators.
 * @param policy - Policy in effect.
 * @returns True when the source accepts a counterpart and the policy requires one.
 */
export function requiresTranslationCounterpart(source: string, policy: TranslationCounterpartPolicy): boolean {
  return policy === 'required' && acceptsTranslationCounterpart(source)
}

/**
 * Whether links to an English source switch to its `.zh.md` path on the
 * Chinese side of a pair. A target that has no counterpart and needs none keeps
 * its `.md` path on both sides.
 *
 * @param source - Repository-relative English `.md` path of the link target.
 * @param counterpartExists - Whether the target's `.zh.md` exists in the selected content plane.
 * @param policy - Policy in effect.
 * @returns True when the Chinese side must link to the `.zh.md` path.
 */
export function isLocaleSwitchedTarget(
  source: string,
  counterpartExists: boolean,
  policy: TranslationCounterpartPolicy,
): boolean {
  return acceptsTranslationCounterpart(source) && (counterpartExists || requiresTranslationCounterpart(source, policy))
}

/**
 * Finding for a Chinese counterpart or pairing record that sits beside an
 * active Agent Note.
 *
 * @param file - Repository-relative `.zh.md` or `.i18n.yaml` path.
 * @returns The `integrity` finding.
 */
export function agentNoteCounterpartFinding(file: string): TranslationPairingFinding {
  return {
    kind: 'integrity',
    message: `${file}: Agent Notes are English-only (.agents/notes/README.md); delete this file`,
  }
}

/**
 * Finding for an in-scope English source that accepts a counterpart and has none.
 *
 * @param source - Repository-relative English `.md` path with `/` separators.
 * @returns The `counterpart` finding.
 */
export function missingCounterpartFinding(source: string): TranslationPairingFinding {
  return {
    kind: 'counterpart',
    message: `${source}: no Chinese counterpart (docs/i18n/README.md); the required policy needs the counterpart and its pairing record`,
  }
}

/**
 * Select the findings that fail the gate.
 *
 * @param findings - Every finding from one pairing check.
 * @param policy - Policy in effect.
 * @returns Messages of the failing findings, in their reported order.
 */
export function enforcedTranslationPairingFindings(
  findings: readonly TranslationPairingFinding[],
  policy: TranslationCounterpartPolicy,
): string[] {
  return findings
    .filter(finding => finding.kind === 'integrity' || policy === 'required')
    .map(finding => finding.message)
}
