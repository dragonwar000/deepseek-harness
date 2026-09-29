/**
 * Ranking of store pages for a query (port of overstack `mem-rank.py` token
 * overlap, scored as the share of query words a page contains).
 * @module @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem/rank
 */

import type { KnowledgeHit } from '@deepseek-ai/dsh-experimental-knowledge'
import { compareText, entryOf, stalePages } from './graph.ts'
import type { StoreGraph } from './graph.ts'

const WORD = /[\p{L}\p{N}]+/gu

/**
 * Lowercased letter-and-digit words of a text.
 * @param text - any text.
 * @returns the distinct words.
 */
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD) ?? [])
}

/**
 * Rank pages by the share of query words found in their id, type, title, and body.
 * @param graph - store snapshot.
 * @param text - query text.
 * @param limit - maximum hits.
 * @returns hits scoring above zero, best first, then by id.
 */
export function rankPages(graph: StoreGraph, text: string, limit: number): KnowledgeHit[] {
  const query = words(text)
  if (query.size === 0) return []
  const stale = stalePages(graph)
  const hits: KnowledgeHit[] = []
  for (const page of graph.pages.values()) {
    const bag = words(`${page.id} ${page.front.type} ${page.front.title ?? ''} ${page.body}`)
    let found = 0
    for (const word of query) if (bag.has(word)) found += 1
    if (found > 0) hits.push({ ...entryOf(page, stale.has(page.id)), score: Math.round((found / query.size) * 1000) / 1000 })
  }
  return hits.sort((left, right) => right.score - left.score || compareText(left.id, right.id)).slice(0, limit)
}
