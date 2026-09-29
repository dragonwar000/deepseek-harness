import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import { buildGraph, citeEdges, indexEntries, neighborLevels, pageOf, staleAfterWrite, stalePages, stemOf } from '../src/graph.ts'
import type { StorePage } from '../src/graph.ts'
import { parsePage } from '../src/page.ts'
import { rankPages, words } from '../src/rank.ts'

const id = knowledgePageId

function page(path: string, fields: string[], body = ''): StorePage {
  const content = `---\n${fields.join('\n')}\n---\n${body}`
  const parsed = parsePage(content)
  if (parsed.kind !== 'page') throw new Error(`fixture ${path} must parse`)
  return { id: id(path), front: parsed.front, body: parsed.body, content }
}

const EXTENSIONS = new Set(['ts'])

function graph(pages: StorePage[], existingCode: string[] = []) {
  return buildGraph({ pages, quarantined: [id('sources/z.md'), id('concepts/y.md')], existingCode: new Set(existingCode), extensions: EXTENSIONS })
}

describe('buildGraph', () => {
  const pages = [
    page('concepts/a.md', ['type: concept', 'title: A', 'updated: 2026-09-01'], 'see [[b]] and [[ghost]] and [[a]] and [[b]] and [[concepts/b]]\n[entity](../entities/c.md) [none](../entities/none.md)\n`src/a.ts` `src/gone.ts`\n'),
    page('concepts/b.md', ['type: concept', 'updated: 2026-09-02', 'relations:', '  - {rel: supports, to: a}', '  - {rel: depends-on, to: ghost}'], 'no links\n'),
    page('entities/c.md', ['type: entity'], '[[a]]\n'),
  ]

  it('derives body links, declared relations, and touches edges with overstack edge ids', () => {
    const built = graph(pages, ['src/a.ts'])
    expect(built.edges.map(edge => [edge.eid, edge.from, edge.to, edge.relation, edge.toKind])).toEqual([
      ['e:66cfc7bf', 'concepts/a.md', 'concepts/b.md', 'wikilink', 'page'],
      ['e:4ea1977e', 'concepts/a.md', 'entities/c.md', 'mdlink', 'page'],
      ['e:ed60c90a', 'concepts/a.md', 'src/a.ts', 'touches', 'code'],
      ['e:53bd0641', 'concepts/b.md', 'concepts/a.md', 'supports', 'page'],
      ['e:93bd1e1d', 'entities/c.md', 'concepts/a.md', 'wikilink', 'page'],
    ])
    expect(built.broken).toEqual([{ from: 'concepts/a.md', target: 'ghost' }])
    expect(built.quarantined).toEqual(['concepts/y.md', 'sources/z.md'])
  })

  it('rebuilds the same edges from the same pages', () => {
    expect(graph(pages, ['src/a.ts']).edges).toEqual(graph([...pages].reverse(), ['src/a.ts']).edges)
  })

  it('resolves ids, ids without .md, and unique file names, but not ambiguous ones', () => {
    const built = graph([...pages, page('entities/b.md', ['type: entity'])])
    expect(built.resolve('concepts/a')).toBe('concepts/a.md')
    expect(built.resolve('./entities/c.md')).toBe('entities/c.md')
    expect(built.resolve('c')).toBe('entities/c.md')
    expect(built.resolve('b')).toBeUndefined()
    expect(built.resolve('missing')).toBeUndefined()
    expect(stemOf('concepts/a.md')).toBe('a')
    expect(stemOf('concepts/readme')).toBe('readme')
    expect(pageOf(built, id('concepts/a.md')).front.title).toBe('A')
  })

  it('cites the edges of a page, one edge by id, and nothing for an unknown reference', () => {
    const built = graph(pages, ['src/a.ts'])
    expect(citeEdges(built, 'a').map(edge => edge.eid)).toContain('e:53bd0641')
    expect(citeEdges(built, 'e:53bd0641')).toHaveLength(1)
    expect(citeEdges(built, 'e:00000000')).toEqual([])
    expect(citeEdges(built, 'missing')).toEqual([])
  })

  it('walks only page edges and judges staleness only by declared relations', () => {
    const built = graph(pages, ['src/a.ts'])
    expect(neighborLevels(built, id('concepts/a.md'), 1)).toEqual([['concepts/b.md', 'entities/c.md']])
    expect([...stalePages(built)]).toEqual([])
  })

  it('lists neighbors by distance over page edges in both directions', () => {
    const built = graph([...pages, page('tours/d.md', ['type: tour'], '[[c]]\n'), page('tours/lonely.md', ['type: tour'])])
    expect(neighborLevels(built, id('concepts/b.md'), 3)).toEqual([['concepts/a.md'], ['entities/c.md'], ['tours/d.md']])
    expect(neighborLevels(built, id('concepts/b.md'), 1)).toEqual([['concepts/a.md']])
    expect(neighborLevels(built, id('tours/lonely.md'), 2)).toEqual([])
  })
})

describe('staleness', () => {
  it('marks a page stale when a page it declares a relation to is newer, one relation deep only', () => {
    const built = graph([
      page('concepts/a.md', ['type: concept', 'updated: 2026-09-30T10:00:00.000Z']),
      page('concepts/b.md', ['type: concept', 'updated: 2026-09-20T10:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/a.md}']),
      page('concepts/c.md', ['type: concept', 'updated: 2026-09-25T10:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/b.md}']),
      page('concepts/d.md', ['type: concept', 'relations:', '  - {rel: supports, to: concepts/a.md}']),
      page('concepts/e.md', ['type: concept', 'updated: 2026-09-01T10:00:00.000Z', 'relations:', '  - {rel: supports, to: concepts/f.md}']),
      page('concepts/f.md', ['type: concept']),
    ])
    expect([...stalePages(built)]).toEqual(['concepts/b.md'])
    const fresh = graph([
      page('concepts/a.md', ['type: concept', 'updated: 2026-09-01T10:00:00.000Z']),
      page('concepts/b.md', ['type: concept', 'updated: 2026-09-20T10:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/a.md}']),
      page('concepts/c.md', ['type: concept', 'updated: 2026-09-30T10:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/b.md}']),
    ])
    expect([...stalePages(fresh)]).toEqual([])
  })

  it('marks dependents of a superseded page stale', () => {
    const built = graph([
      page('concepts/old.md', ['type: concept']),
      page('concepts/new.md', ['type: concept', 'relations:', '  - {rel: supersedes, to: concepts/old.md}']),
      page('concepts/user.md', ['type: concept', 'relations:', '  - {rel: depends-on, to: concepts/old.md}']),
    ])
    expect([...stalePages(built)]).toEqual(['concepts/user.md'])
  })

  it('reports the pages a write makes stale: declared backlinks and dependents of a page it supersedes', () => {
    const built = graph([
      page('concepts/a.md', ['type: concept']),
      page('concepts/b.md', ['type: concept', 'relations:', '  - {rel: depends-on, to: concepts/a.md}']),
      page('concepts/c.md', ['type: concept', 'relations:', '  - {rel: depends-on, to: concepts/old.md}']),
      page('concepts/old.md', ['type: concept'], '[[a]]\n'),
    ])
    expect(staleAfterWrite(built, { id: id('concepts/a.md'), type: 'concept', title: 'A', body: '', relations: [] })).toEqual(['concepts/b.md'])
    expect(staleAfterWrite(built, {
      id: id('concepts/new.md'), type: 'concept', title: 'New', body: '',
      relations: [{ relation: 'supersedes', to: id('concepts/old.md') }, { relation: 'supports', to: id('concepts/a.md') }],
    })).toEqual(['concepts/c.md'])
    expect(staleAfterWrite(built, { id: id('concepts/b.md'), type: 'concept', title: 'B', body: '', relations: [] })).toEqual([])
  })
})

describe('index and ranking', () => {
  const built = graph([
    page('concepts/retry.md', ['type: concept', 'title: Retry policy', 'updated: 2026-09-20'], 'Retries back off with exponential delay.\n'),
    page('concepts/backoff.md', ['type: concept', 'title: Backoff', 'updated: 2026-09-25'], 'Exponential backoff with jitter.\n'),
    page('sources/zeta.md', ['type: source'], 'x\n'),
    page('sources/untitled.md', ['type: source'], 'Nothing relevant.\n'),
  ])

  it('lists pages newest first, then by id, with the file name as a missing title', () => {
    expect(indexEntries(built)).toEqual([
      { id: 'concepts/backoff.md', title: 'Backoff', type: 'concept', updated: '2026-09-25', stale: false },
      { id: 'concepts/retry.md', title: 'Retry policy', type: 'concept', updated: '2026-09-20', stale: false },
      { id: 'sources/untitled.md', title: 'untitled', type: 'source', stale: false },
      { id: 'sources/zeta.md', title: 'zeta', type: 'source', stale: false },
    ])
  })

  it('ranks by the share of query words a page contains and drops pages without any', () => {
    expect(rankPages(built, 'exponential retry', 10).map(hit => [hit.id, hit.score])).toEqual([
      ['concepts/retry.md', 1],
      ['concepts/backoff.md', 0.5],
    ])
    expect(rankPages(built, 'exponential retry', 1)).toHaveLength(1)
    expect(rankPages(built, 'concepts', 10).map(hit => hit.id)).toEqual(['concepts/backoff.md', 'concepts/retry.md'])
    expect(rankPages(built, '  ', 10)).toEqual([])
    expect(rankPages(built, 'zebra', 10)).toEqual([])
    expect([...words('重试 Retry-policy 2')]).toEqual(['重试', 'retry', 'policy', '2'])
  })
})
