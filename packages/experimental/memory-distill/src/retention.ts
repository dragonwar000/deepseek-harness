/**
 * Episode retention. With a positive `maxEpisodes` the plugin writes episodes
 * to that many slot pages (`<dir>/slot-<k>.md`) and, once every slot holds a
 * page, replaces the least recently updated one through
 * `ctx.knowledge.write`, so the store never holds more than `maxEpisodes`
 * slot pages and no page is removed outside the knowledge write path.
 * @module @deepseek-ai/dsh-experimental-memory-distill/retention
 */

import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeIndexEntry, KnowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'

/** How many episode pages the store keeps. */
export type EpisodeRetention =
  | { readonly kind: 'every' }
  | { readonly kind: 'slots'; readonly count: number }

/**
 * Resolve the configured episode limit.
 * @param maxEpisodes - configured `maxEpisodes`.
 * @returns `every` for 0 (one dated page per episode, none replaced), otherwise `count` slots.
 * @throws when the value is not an integer >= 0.
 */
export function resolveRetention(maxEpisodes: number): EpisodeRetention {
  if (!Number.isSafeInteger(maxEpisodes) || maxEpisodes < 0) throw new Error('memory-distill: maxEpisodes must be an integer >= 0')
  return maxEpisodes === 0 ? { kind: 'every' } : { kind: 'slots', count: maxEpisodes }
}

/**
 * Page id of one slot.
 * @param dir - store directory for episodes.
 * @param slot - slot number, from 1.
 * @returns `<dir>/slot-<slot>.md`.
 */
export function slotId(dir: string, slot: number): KnowledgePageId {
  return knowledgePageId(`${dir}/slot-${slot}.md`)
}

/**
 * The slot the next episode goes to: the lowest slot without a readable page,
 * otherwise the slot whose page was updated first (lowest slot on a tie).
 * @param dir - store directory for episodes.
 * @param count - number of slots.
 * @param entries - readable pages of the store.
 * @returns the slot page id.
 */
export function nextSlot(dir: string, count: number, entries: readonly KnowledgeIndexEntry[]): KnowledgePageId {
  const updated = new Map(entries.map(entry => [String(entry.id), entry.updated ?? '']))
  let oldest = slotId(dir, 1)
  let oldestTime: string | undefined
  for (let slot = 1; slot <= count; slot += 1) {
    const id = slotId(dir, slot)
    const time = updated.get(String(id))
    if (time === undefined) return id
    if (oldestTime === undefined || time < oldestTime) {
      oldest = id
      oldestTime = time
    }
  }
  return oldest
}
