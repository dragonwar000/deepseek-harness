import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeIndexEntry } from '@deepseek-ai/dsh-experimental-knowledge'
import { indexHeader, renderIndex } from '../src/render.ts'

const LIMITS = { maxLines: 200, maxBytes: 25600 }

function entries(count: number, title = 'Page'): KnowledgeIndexEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: knowledgePageId(`concepts/p${String(index).padStart(4, '0')}.md`), title, type: 'concept', updated: '2026-09-20T10:00:00.000Z', stale: false,
  }))
}

describe('renderIndex', () => {
  it('renders nothing for an empty store', () => {
    expect(renderIndex({ entries: [], quarantined: [] }, LIMITS)).toBeUndefined()
  })

  it('lists ids, titles, types, dates, and stale marks, never content', () => {
    const rendered = renderIndex({
      entries: [
        { id: knowledgePageId('concepts/backoff.md'), title: 'Backoff', type: 'concept', updated: '2026-09-25T10:00:00.000Z', stale: false },
        { id: knowledgePageId('concepts/retry.md'), title: 'Retry\npolicy', type: 'concept', updated: '2026-09-20', stale: true },
        { id: knowledgePageId('sources/x.md'), title: 'X', type: 'source', stale: false },
      ],
      quarantined: [knowledgePageId('concepts/broken.md')],
    }, LIMITS)
    expect(rendered?.text).toBe([
      'Knowledge index of the workspace knowledge store, newest first (readable pages: 3). It lists pages, not their content: read a page with knowledge_read before relying on it, and verify statements about code against the current files before asserting them. A page marked stale depends on a page that changed after it or was superseded.',
      '- concepts/backoff.md — Backoff [concept] updated 2026-09-25',
      '- concepts/retry.md — Retry policy [concept] updated 2026-09-20, stale',
      '- sources/x.md — X [source]',
      'Pages left out for unreadable frontmatter: 1.',
    ].join('\n'))
    const { digest, ...record } = rendered!.record
    expect(record).toEqual({
      ids: ['concepts/backoff.md', 'concepts/retry.md', 'sources/x.md'],
      bytes: Buffer.byteLength(rendered!.text, 'utf8'),
      lines: 5,
      omitted: 0,
      quarantined: 1,
    })
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(indexHeader(3)).toBe(rendered!.text.split('\n')[0])
  })

  it('keeps the newest pages within the line cap and names how many it left out', () => {
    const rendered = renderIndex({ entries: entries(300), quarantined: [] }, LIMITS)!
    const lines = rendered.text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(200)
    expect(rendered.record.lines).toBe(lines.length)
    expect(rendered.record.omitted).toBe(300 - rendered.record.ids.length)
    expect(lines.at(-1)).toBe(`Pages not listed here: ${rendered.record.omitted}; search them with knowledge_query.`)
    expect(rendered.record.ids[0]).toBe('concepts/p0000.md')
  })

  it('stays within 25 KB when the full index is larger', () => {
    const rendered = renderIndex({ entries: entries(400, 'T'.repeat(100)), quarantined: [knowledgePageId('concepts/bad.md')] }, LIMITS)!
    expect(rendered.record.bytes).toBeLessThanOrEqual(25600)
    expect(rendered.record.bytes).toBeGreaterThan(20000)
    expect(rendered.record.lines).toBeLessThanOrEqual(200)
    expect(rendered.text.endsWith('Pages left out for unreadable frontmatter: 1.')).toBe(true)
    expect(rendered.text).toContain(`Pages not listed here: ${rendered.record.omitted};`)
  })

  it('shortens long titles to 120 characters and changes the digest with the content', () => {
    const long = renderIndex({ entries: entries(1, 'x'.repeat(300)), quarantined: [] }, LIMITS)!
    expect(long.text.split('\n')[1]).toBe(`- concepts/p0000.md — ${'x'.repeat(120)} [concept] updated 2026-09-20`)
    const other = renderIndex({ entries: entries(1, 'y'), quarantined: [] }, LIMITS)!
    expect(other.record.digest).not.toBe(long.record.digest)
  })
})
