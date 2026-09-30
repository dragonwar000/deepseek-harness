/**
 * Episode retention. With a positive `maxEpisodes` the plugin keeps at most
 * that many episode pages active: after writing an episode it archives the
 * oldest others by rewriting them with status `archived` through
 * `ctx.knowledge.write`, so every archival is checked by the store rules,
 * logged as a `knowledge/write`, and the page stays readable.
 * @module @deepseek-ai/dsh-experimental-memory-distill/retention
 */

import type { KnowledgeIndexEntry, KnowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'

/** How many episode pages stay active. */
export type EpisodeRetention =
  | { readonly kind: 'every' }
  | { readonly kind: 'latest'; readonly count: number }

/**
 * Resolve the configured episode limit.
 * @param maxEpisodes - configured `maxEpisodes`.
 * @returns `every` for 0 (no page is archived), otherwise the `count` of active episode pages kept.
 * @throws when the value is not an integer >= 0.
 */
export function resolveRetention(maxEpisodes: number): EpisodeRetention {
  if (!Number.isSafeInteger(maxEpisodes) || maxEpisodes < 0) throw new Error('memory-distill: maxEpisodes must be an integer >= 0')
  return maxEpisodes === 0 ? { kind: 'every' } : { kind: 'latest', count: maxEpisodes }
}

/**
 * Episode pages to archive so that the page being written and the newest
 * others add up to at most `count` active episode pages. Episode pages are the
 * index entries of type `episode` under `dir`; newer means a later `updated`,
 * then a later id, and a page without `updated` is the oldest.
 * @param dir - store directory for episodes.
 * @param count - active episode pages kept, at least 1.
 * @param entries - active pages of the store, before the write.
 * @param written - id of the episode page being written.
 * @returns the ids to archive, newest first.
 */
export function episodesToArchive(
  dir: string,
  count: number,
  entries: readonly KnowledgeIndexEntry[],
  written: KnowledgePageId,
): KnowledgePageId[] {
  const key = (entry: KnowledgeIndexEntry): string => `${entry.updated ?? ''}\u0000${entry.id}`
  return entries
    .filter(entry => entry.type === 'episode' && entry.id.startsWith(`${dir}/`) && entry.id !== written)
    .sort((left, right) => (key(left) < key(right) ? 1 : -1))
    .slice(count - 1)
    .map(entry => entry.id)
}
