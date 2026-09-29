import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEntry, KnowledgeCitation } from '@deepseek-ai/dsh-experimental-knowledge'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildGraph } from '../src/graph.ts'
import type { StorePage } from '../src/graph.ts'
import { parsePage, renderPage } from '../src/page.ts'
import { checkEntry, checkLayout, checkPageText, checkCitation, checkRelations, reviewWrite } from '../src/rules.ts'

const id = knowledgePageId
const LAYOUT = { contentDirs: new Set(['concepts', 'sources']), readOnlyDirs: new Set(['raw']) }
const CITATION: KnowledgeCitation = { sessionId: SessionId('s1'), sourceEventSeqs: [SessionSeq(3)], sources: ['src/a.ts'], writer: 'tool' }

function page(path: string, fields: string[]): StorePage {
  const content = `---\n${fields.join('\n')}\n---\n`
  const parsed = parsePage(content)
  if (parsed.kind !== 'page') throw new Error('fixture must parse')
  return { id: id(path), front: parsed.front, body: parsed.body, content }
}

const GRAPH = buildGraph({
  pages: [
    page('concepts/live.md', ['type: concept']),
    page('concepts/old.md', ['type: concept']),
    page('concepts/new.md', ['type: concept', 'relations:', '  - {rel: supersedes, to: concepts/old.md}']),
  ],
  quarantined: [],
  existingCode: new Set(),
  extensions: new Set(),
})

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return { id: id('concepts/x.md'), type: 'concept', title: 'X', body: 'Body', relations: [], ...overrides }
}

describe('layout rules (R1 read-only, R5 content directories)', () => {
  it('accepts a page under a content directory', () => {
    expect(checkLayout('concepts/x.md', LAYOUT)).toEqual({ ok: true })
    expect(checkLayout('sources/deep/y.md', LAYOUT)).toEqual({ ok: true })
  })

  it.each([
    ['raw/x.md', 'read-only-dir'],
    ['notes/x.md', 'layout'],
    ['x.md', 'layout'],
    ['concepts/x.txt', 'layout'],
    ['concepts/../raw/x.md', 'layout'],
    ['/concepts/x.md', 'layout'],
    ['concepts/.hidden.md', 'layout'],
    ['concepts/README.md', 'layout'],
    ['sources/_template.md', 'layout'],
  ])('refuses %s', (path, rule) => {
    expect(checkLayout(path, LAYOUT)).toMatchObject({ ok: false, rule })
  })
})

describe('entry and citation rules', () => {
  it('accepts a one-word type, a title, and a cited event with a source', () => {
    expect(checkEntry(entry())).toEqual({ ok: true })
    expect(checkCitation(CITATION)).toEqual({ ok: true })
  })

  it('refuses a type that is not one word, a blank title, and citation without events or sources', () => {
    expect(checkEntry(entry({ type: 'two words' }))).toMatchObject({ ok: false, rule: 'frontmatter' })
    expect(checkEntry(entry({ title: '  ' }))).toMatchObject({ ok: false, rule: 'frontmatter' })
    expect(checkCitation({ ...CITATION, sourceEventSeqs: [] })).toMatchObject({ ok: false, rule: 'citation' })
    expect(checkCitation({ ...CITATION, sources: [] })).toMatchObject({ ok: false, rule: 'citation' })
  })
})

describe('relation rules (R-rel-1 dangling, R-rel-3 superseded)', () => {
  it('accepts relations to existing pages, including superseding one', () => {
    expect(checkRelations(entry({ relations: [{ relation: 'depends-on', to: id('concepts/live.md') }, { relation: 'supersedes', to: id('concepts/old.md') }] }), GRAPH)).toEqual({ ok: true })
    expect(checkRelations(entry({ id: id('concepts/new.md'), relations: [{ relation: 'supersedes', to: id('concepts/old.md') }, { relation: 'depends-on', to: id('concepts/old.md') }] }), GRAPH)).toEqual({ ok: true })
  })

  it('refuses a relation to a missing page, to itself, or a new dependency on a superseded page', () => {
    expect(checkRelations(entry({ relations: [{ relation: 'supports', to: id('concepts/ghost.md') }] }), GRAPH)).toMatchObject({ ok: false, rule: 'dangling-relation' })
    expect(checkRelations(entry({ relations: [{ relation: 'supports', to: id('concepts/x.md') }] }), GRAPH)).toMatchObject({ ok: false, rule: 'dangling-relation' })
    expect(checkRelations(entry({ relations: [{ relation: 'depends-on', to: id('concepts/old.md') }] }), GRAPH)).toMatchObject({ ok: false, rule: 'superseded-dependency' })
  })
})

describe('page text rules (R9 frontmatter, citation, R2 Origin)', () => {
  it('accepts a rendered page', () => {
    expect(checkPageText(renderPage(entry(), CITATION, '2026-09-30T10:00:00.000Z'))).toEqual({ ok: true })
  })

  it('refuses a page without frontmatter, without citation, or without an Origin section', () => {
    expect(checkPageText('# x\n')).toMatchObject({ ok: false, rule: 'frontmatter' })
    expect(checkPageText('---\ntype: concept\n---\n## Origin\n')).toMatchObject({ ok: false, rule: 'citation' })
    expect(checkPageText('---\ntype: concept\ncitation: {session: s1, seqs: [1], sources: [a], writer: tool}\n---\nbody\n')).toMatchObject({ ok: false, rule: 'origin' })
  })
})

describe('reviewWrite', () => {
  it('stops at the first broken rule in layout, entry, citation, relations order', () => {
    expect(reviewWrite(entry(), CITATION, GRAPH, LAYOUT)).toEqual({ ok: true })
    expect(reviewWrite(entry({ id: id('raw/x.md'), type: 'two words' }), CITATION, GRAPH, LAYOUT)).toMatchObject({ rule: 'read-only-dir' })
    expect(reviewWrite(entry({ type: 'two words' }), { ...CITATION, sourceEventSeqs: [] }, GRAPH, LAYOUT)).toMatchObject({ rule: 'frontmatter' })
    expect(reviewWrite(entry({ relations: [{ relation: 'supports', to: id('concepts/ghost.md') }] }), { ...CITATION, sourceEventSeqs: [] }, GRAPH, LAYOUT)).toMatchObject({ rule: 'citation' })
    expect(reviewWrite(entry({ relations: [{ relation: 'supports', to: id('concepts/ghost.md') }] }), CITATION, GRAPH, LAYOUT)).toMatchObject({ rule: 'dangling-relation' })
  })
})
