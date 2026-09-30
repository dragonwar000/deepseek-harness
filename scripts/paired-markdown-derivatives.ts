/**
 * Separate Chinese Markdown code blocks from the primary checks performed on
 * their unsuffixed English siblings. Source-oriented gates consume one copy of
 * a byte-identical sequence. A Chinese sequence that differs from its sibling
 * is unchecked under the `optional` counterpart policy, so an out-of-date
 * counterpart cannot fail a source gate, and primary under `required`.
 */

import type { TranslationCounterpartPolicy } from './translation-counterpart.ts'

/** The result of separating canonical blocks from paired Chinese derivatives. */
export interface MarkdownDerivativePartition<T> {
  /** Blocks that still require the caller's owning check. */
  primary: T[]
  /** Chinese blocks covered by the byte-identical unsuffixed sequence. */
  derivatives: T[]
  /** Chinese blocks that differ from the unsuffixed sequence and are left unchecked; empty under `required`. */
  unchecked: T[]
}

/** Return the unsuffixed sibling of a Chinese Markdown path. */
function unsuffixedSibling(doc: string): string | null {
  return doc.endsWith('.zh.md') ? `${doc.slice(0, -'.zh.md'.length)}.md` : null
}

/**
 * Partition `.zh.md` block sequences from primary blocks. A complete
 * byte-identical sequence is derivative. A partial, reordered, changed, or
 * orphan sequence is unchecked under `optional` and stays primary under
 * `required`; the translation-pairing gate reports the cross-language mismatch.
 *
 * @param blocks - Blocks in repository scan order.
 * @param docOf - Repository-relative Markdown path owning a block.
 * @param fingerprintOf - Block kind/info string plus byte-exact body.
 * @param policy - Counterpart policy in effect.
 * @returns Primary, derivative, and unchecked blocks, each preserving order.
 */
export function partitionPairedMarkdownDerivatives<T>(
  blocks: readonly T[],
  docOf: (block: T) => string,
  fingerprintOf: (block: T) => string,
  policy: TranslationCounterpartPolicy,
): MarkdownDerivativePartition<T> {
  const byDoc = new Map<string, T[]>()
  for (const block of blocks) {
    const doc = docOf(block)
    const group = byDoc.get(doc)
    if (group) group.push(block)
    else byDoc.set(doc, [block])
  }

  const derivativeDocs = new Set<string>()
  for (const [doc, candidates] of byDoc) {
    const sibling = unsuffixedSibling(doc)
    if (sibling === null) continue
    const originals = byDoc.get(sibling)
    if (originals === undefined || originals.length !== candidates.length) continue
    if (candidates.every((candidate, index) => {
      const original = originals[index]
      return original !== undefined && fingerprintOf(candidate) === fingerprintOf(original)
    })) {
      derivativeDocs.add(doc)
    }
  }

  const primary: T[] = []
  const derivatives: T[] = []
  const unchecked: T[] = []
  for (const block of blocks) {
    const doc = docOf(block)
    if (derivativeDocs.has(doc)) derivatives.push(block)
    else if (policy === 'optional' && unsuffixedSibling(doc) !== null) unchecked.push(block)
    else primary.push(block)
  }
  return { primary, derivatives, unchecked }
}
