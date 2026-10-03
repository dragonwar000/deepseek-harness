/**
 * Pure helpers of the knowledge vocabulary: id branding, the declared relation
 * list, and the edge id shared with overstack `wiki-graph.py`.
 * @module @deepseek-ai/dsh-experimental-knowledge/edge
 */

import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KnowledgeDeclaredRelation, KnowledgeEdgeId, KnowledgePageId, KnowledgeRelation } from './types.ts'

/** Declared relations, in documentation order. */
export const DECLARED_RELATIONS: readonly KnowledgeDeclaredRelation[] = [
  'derives-from',
  'depends-on',
  'implements',
  'supports',
  'contradicts',
  'supersedes',
]

const DECLARED = new Set<string>(DECLARED_RELATIONS)

/**
 * Whether a frontmatter or tool value names a declared relation.
 * @param value - candidate relation name.
 * @returns true for one of {@link DECLARED_RELATIONS}.
 */
export function isDeclaredRelation(value: string): value is KnowledgeDeclaredRelation {
  return DECLARED.has(value)
}

/**
 * Brand a store-relative page path; the store validates it.
 * @param value - page path such as `concepts/retry.md`.
 * @returns the branded id.
 */
export function knowledgePageId(value: string): KnowledgePageId {
  return brandString<KnowledgePageId>(value)
}

/**
 * Stable id of one edge, a pure function of its endpoints and relation.
 * @param from - source page id.
 * @param to - target page id or code path.
 * @param relation - edge relation.
 * @returns `e:` and the first eight hex digits of sha1(`from|to|relation`).
 */
export function edgeId(from: string, to: string, relation: KnowledgeRelation): KnowledgeEdgeId {
  const digest = createHash('sha1').update(`${from}|${to}|${relation}`, 'utf8').digest('hex')
  return brandString<KnowledgeEdgeId>(`e:${digest.slice(0, 8)}`)
}
