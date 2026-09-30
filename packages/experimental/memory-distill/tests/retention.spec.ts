import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeIndexEntry } from '@deepseek-ai/dsh-experimental-knowledge'
import { nextSlot, resolveRetention, slotId } from '../src/retention.ts'

const entry = (id: string, updated?: string): KnowledgeIndexEntry => ({
  id: knowledgePageId(id), title: id, type: 'episode', stale: false, ...updated === undefined ? {} : { updated },
})

describe('episode retention', () => {
  it('resolves 0 to one page per episode and a positive limit to slots', () => {
    expect(resolveRetention(0)).toEqual({ kind: 'every' })
    expect(resolveRetention(3)).toEqual({ kind: 'slots', count: 3 })
  })

  it.each([-1, 1.5, Number.NaN])('fails loud on maxEpisodes %s', (value) => {
    expect(() => resolveRetention(value)).toThrow('memory-distill: maxEpisodes must be an integer >= 0')
  })

  it('names slot pages under the episode directory', () => {
    expect(slotId('episodes', 2)).toBe('episodes/slot-2.md')
  })

  it('fills the lowest free slot, then replaces the least recently updated one', () => {
    expect(nextSlot('episodes', 3, [entry('episodes/slot-1.md', '2026-09-01'), entry('episodes/slot-3.md', '2026-09-02')])).toBe('episodes/slot-2.md')
    const full = [entry('episodes/slot-1.md', '2026-09-03'), entry('episodes/slot-2.md', '2026-09-01'), entry('episodes/slot-3.md', '2026-09-02')]
    expect(nextSlot('episodes', 3, full)).toBe('episodes/slot-2.md')
    expect(nextSlot('episodes', 2, [entry('episodes/slot-2.md', '2026-09-01'), entry('episodes/slot-1.md', '2026-09-01')])).toBe('episodes/slot-1.md')
    expect(nextSlot('episodes', 2, [entry('episodes/slot-1.md', '2026-09-01'), entry('episodes/slot-2.md')])).toBe('episodes/slot-2.md')
    expect(nextSlot('episodes', 1, [entry('episodes/slot-2.md', '2026-09-01'), entry('notes/slot-1.md', '2026-09-01')])).toBe('episodes/slot-1.md')
  })
})
