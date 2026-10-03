import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeIndexEntry } from '@deepseek-ai/dsh-experimental-knowledge'
import { episodesToArchive, resolveRetention } from '../src/retention.ts'

const entry = (id: string, updated?: string, type = 'episode'): KnowledgeIndexEntry => ({
  id: knowledgePageId(id), title: id, type, stale: false, ...updated === undefined ? {} : { updated },
})
const NEW = knowledgePageId('episodes/2026-09-30-s-t9.md')

describe('episode retention', () => {
  it('resolves 0 to no archiving and a positive limit to the latest pages kept', () => {
    expect(resolveRetention(0)).toEqual({ kind: 'every' })
    expect(resolveRetention(3)).toEqual({ kind: 'latest', count: 3 })
  })

  it.each([-1, 1.5, Number.NaN])('fails loud on maxEpisodes %s', (value) => {
    expect(() => resolveRetention(value)).toThrow('memory-distill: maxEpisodes must be an integer >= 0')
  })

  it('archives nothing while the written page and the others fit the limit exactly', () => {
    const entries = [entry('episodes/a.md', '2026-09-02'), entry('episodes/b.md', '2026-09-01')]
    expect(episodesToArchive('episodes', 3, entries, NEW)).toEqual([])
  })

  it('archives the oldest others beyond the limit, newest first, ordering ties by id and undated pages last', () => {
    const entries = [
      entry('episodes/c.md', '2026-09-03'),
      entry('episodes/a.md', '2026-09-01'),
      entry('episodes/b.md', '2026-09-01'),
      entry('episodes/undated.md'),
    ]
    expect(episodesToArchive('episodes', 2, entries, NEW)).toEqual(['episodes/b.md', 'episodes/a.md', 'episodes/undated.md'])
    expect(episodesToArchive('episodes', 1, entries, NEW)).toEqual(['episodes/c.md', 'episodes/b.md', 'episodes/a.md', 'episodes/undated.md'])
  })

  it('counts only episode pages in the directory and never archives the page being written', () => {
    const entries = [
      entry(NEW, '2026-09-30'),
      entry('episodes/old.md', '2026-09-01'),
      entry('episodes/note.md', '2026-08-01', 'concept'),
      entry('elsewhere/old.md', '2026-08-01'),
    ]
    expect(episodesToArchive('episodes', 1, entries, NEW)).toEqual(['episodes/old.md'])
    expect(episodesToArchive('episodes', 2, entries, NEW)).toEqual([])
  })
})
