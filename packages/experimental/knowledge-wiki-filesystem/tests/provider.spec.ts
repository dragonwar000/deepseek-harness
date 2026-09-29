import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type { KnowledgeEntry, KnowledgeCitation } from '@deepseek-ai/dsh-experimental-knowledge'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import WikiFilesystemKnowledge from '../src/index.ts'
import { page, workspace } from './workspace.ts'
import type { Workspace } from './workspace.ts'

const id = knowledgePageId
const CITATION: KnowledgeCitation = { sessionId: SessionId('s1'), sourceEventSeqs: [SessionSeq(7), SessionSeq(9)], sources: ['src/retry.ts'], writer: 'tool' }
const opened: Workspace[] = []

async function open(files: Record<string, string>, config = {}): Promise<Workspace> {
  const ws = await workspace(files, config)
  opened.push(ws)
  return ws
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ws of opened.splice(0)) await ws.dispose()
})

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return { id: id('concepts/retry.md'), type: 'concept', title: 'Retry policy', body: 'Retries back off; see [[backoff]].', relations: [], ...overrides }
}

describe('reading the store', () => {
  it('returns an empty index when the store directory is absent', async () => {
    const ws = await open({})
    expect(await ws.ctx.knowledge.index({})).toEqual({ entries: [], quarantined: [] })
    expect(ws.ctx.knowledge.storeRoot).toBe('knowledge')
  })

  it('lists readable pages newest first and quarantines unreadable frontmatter', async () => {
    const ws = await open({
      'knowledge/concepts/retry.md': page(['type: concept', 'title: Retry policy', 'updated: 2026-09-20'], 'Retry.'),
      'knowledge/concepts/nested/backoff.md': page(['type: concept', 'title: Backoff', 'updated: 2026-09-25'], 'Backoff.'),
      'knowledge/concepts/broken.md': '---\ntype: [unclosed\n---\n',
      'knowledge/sources/plain.md': '# No frontmatter\n',
      'knowledge/concepts/README.md': '# ignored\n',
      'knowledge/concepts/notes.txt': 'ignored\n',
      'knowledge/drafts/x.md': page(['type: draft']),
      'knowledge/index.md': page(['type: index']),
    })
    expect(await ws.ctx.knowledge.index({ cwd: ws.dir, signal: new AbortController().signal })).toEqual({
      entries: [
        { id: 'concepts/nested/backoff.md', title: 'Backoff', type: 'concept', updated: '2026-09-25', stale: false },
        { id: 'concepts/retry.md', title: 'Retry policy', type: 'concept', updated: '2026-09-20', stale: false },
      ],
      quarantined: ['concepts/broken.md', 'sources/plain.md'],
    })
  })

  it('derives touches edges only to code paths that exist, on every read, ignoring stored code relations', async () => {
    const ws = await open({
      'knowledge/concepts/retry.md': page(['type: concept', 'relations:', '  - {rel: implements, path: src/retry.ts}'], 'Code: `src/retry.ts` and `src/missing.ts`.'),
    })
    expect(await ws.ctx.knowledge.cite({}, 'retry')).toEqual([])
    ws.write('src/retry.ts', 'export {}\n')
    expect(await ws.ctx.knowledge.cite({}, 'retry')).toEqual([
      { eid: 'e:80571cf8', from: 'concepts/retry.md', to: 'src/retry.ts', toKind: 'code', relation: 'touches' },
    ])
  })

  it('ranks, reads, cites, and walks neighbors', async () => {
    const ws = await open({
      'knowledge/concepts/retry.md': page(['type: concept', 'title: Retry policy', 'relations:', '  - {rel: depends-on, to: backoff}'], 'Retries use exponential delay.'),
      'knowledge/concepts/backoff.md': page(['type: concept', 'title: Backoff'], 'Exponential backoff; see [[jitter]].'),
      'knowledge/concepts/jitter.md': page(['type: concept', 'title: Jitter'], 'Random spread.'),
    })
    expect((await ws.ctx.knowledge.query({}, 'exponential retry', 5)).map(hit => [hit.id, hit.score])).toEqual([
      ['concepts/retry.md', 1],
      ['concepts/backoff.md', 0.5],
    ])
    const read = await ws.ctx.knowledge.read({}, 'retry')
    expect(read).toMatchObject({ id: 'concepts/retry.md', title: 'Retry policy', relations: [{ relation: 'depends-on', to: 'backoff' }], stale: false })
    expect(read?.content).toContain('Retries use exponential delay.')
    expect(await ws.ctx.knowledge.read({}, 'ghost')).toBeUndefined()
    expect((await ws.ctx.knowledge.cite({}, 'backoff')).map(edge => edge.relation)).toEqual(['wikilink', 'depends-on'])
    expect(await ws.ctx.knowledge.neighbors({}, 'retry', 2)).toEqual({ id: 'concepts/retry.md', levels: [['concepts/backoff.md'], ['concepts/jitter.md']] })
    expect(await ws.ctx.knowledge.neighbors({}, 'ghost', 2)).toBeUndefined()
  })
})

describe('writing pages', () => {
  it('writes frontmatter, citation, and an Origin section, then replaces the page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
    const ws = await open({ 'knowledge/concepts/backoff.md': page(['type: concept', 'title: Backoff']) })
    const first = await ws.ctx.knowledge.write({}, entry({ relations: [{ relation: 'depends-on', to: id('backoff') }] }), CITATION)
    expect(first).toEqual({ kind: 'written', id: 'concepts/retry.md', operation: 'create', stale: [] })
    expect(readFileSync(join(ws.dir, 'knowledge/concepts/retry.md'), 'utf8')).toBe([
      '---',
      'type: "concept"',
      'title: "Retry policy"',
      'updated: "2026-09-30T10:00:00.000Z"',
      'relations:',
      '  - {rel: depends-on, to: concepts/backoff.md}',
      'citation:',
      '  session: "s1"',
      '  seqs: [7, 9]',
      '  sources: ["src/retry.ts"]',
      '  writer: tool',
      '---',
      '',
      '# Retry policy',
      '',
      'Retries back off; see [[backoff]].',
      '',
      '## Origin',
      '',
      '- Session: `s1`',
      '- Source events: 7, 9',
      '- Sources: `src/retry.ts`',
      '- Writer: tool',
      '',
    ].join('\n'))
    vi.setSystemTime(new Date('2026-09-30T11:00:00.000Z'))
    expect(await ws.ctx.knowledge.write({ cwd: ws.dir }, entry({ body: 'Changed.' }), CITATION)).toMatchObject({ kind: 'written', operation: 'update' })
    expect(readFileSync(join(ws.dir, 'knowledge/concepts/retry.md'), 'utf8')).toContain('updated: "2026-09-30T11:00:00.000Z"')
  })

  it('makes pages relating to a written page stale, one relation deep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
    const ws = await open({
      'knowledge/concepts/a.md': page(['type: concept', 'updated: 2026-09-01T00:00:00.000Z']),
      'knowledge/concepts/b.md': page(['type: concept', 'updated: 2026-09-02T00:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/a.md}']),
      'knowledge/concepts/c.md': page(['type: concept', 'updated: 2026-09-03T00:00:00.000Z', 'relations:', '  - {rel: depends-on, to: concepts/b.md}']),
    })
    expect(await ws.ctx.knowledge.write({}, entry({ id: id('concepts/a.md'), title: 'A', body: 'A changed.' }), CITATION))
      .toEqual({ kind: 'written', id: 'concepts/a.md', operation: 'update', stale: ['concepts/b.md'] })
    const stale = (await ws.ctx.knowledge.index({})).entries.filter(item => item.stale).map(item => item.id)
    expect(stale).toEqual(['concepts/b.md'])
  })

  it('reports dependents of a superseded page and refuses a new dependency on it', async () => {
    const ws = await open({
      'knowledge/concepts/old.md': page(['type: concept']),
      'knowledge/concepts/user.md': page(['type: concept', 'relations:', '  - {rel: depends-on, to: concepts/old.md}']),
    })
    expect(await ws.ctx.knowledge.write({}, entry({ id: id('concepts/new.md'), relations: [{ relation: 'supersedes', to: id('old') }] }), CITATION))
      .toEqual({ kind: 'written', id: 'concepts/new.md', operation: 'create', stale: ['concepts/user.md'] })
    expect(await ws.ctx.knowledge.write({}, entry({ id: id('concepts/late.md'), relations: [{ relation: 'depends-on', to: id('old') }] }), CITATION))
      .toMatchObject({ kind: 'refused', rule: 'superseded-dependency' })
  })

  it.each([
    ['layout', entry({ id: id('notes/x.md') }), CITATION],
    ['read-only-dir', entry({ id: id('raw/x.md') }), CITATION],
    ['citation', entry(), { ...CITATION, sourceEventSeqs: [] }],
    ['dangling-relation', entry({ relations: [{ relation: 'supports', to: id('ghost') }] }), CITATION],
    ['frontmatter', entry({ type: 'two words' }), CITATION],
  ] as const)('refuses a %s violation and writes nothing', async (rule, refused, citation) => {
    const ws = await open({})
    expect(await ws.ctx.knowledge.write({}, refused, citation)).toMatchObject({ kind: 'refused', rule })
    expect(existsSync(join(ws.dir, 'knowledge', refused.id))).toBe(false)
  })
})

describe('store boundary and configuration', () => {
  it('answers whether a path lies inside the store', async () => {
    const ws = await open({ 'knowledge/concepts/a.md': page(['type: concept']), 'notes.md': 'x' })
    expect(await ws.ctx.knowledge.includes({}, 'knowledge/concepts/a.md')).toBe(true)
    expect(await ws.ctx.knowledge.includes({ cwd: ws.dir }, join(ws.dir, 'knowledge/concepts/new.md'))).toBe(true)
    expect(await ws.ctx.knowledge.includes({}, 'knowledge')).toBe(true)
    expect(await ws.ctx.knowledge.includes({}, 'notes.md')).toBe(false)
    expect(await ws.ctx.knowledge.includes({}, 'knowledge-other/a.md')).toBe(false)
  })

  it('uses a configured root and trims a trailing slash', async () => {
    const ws = await open({ 'team/wiki/concepts/a.md': page(['type: concept']) }, { root: 'team/wiki/' })
    expect(ws.ctx.knowledge.storeRoot).toBe('team/wiki')
    expect((await ws.ctx.knowledge.index({})).entries.map(item => item.id)).toEqual(['concepts/a.md'])
  })

  it('refuses to read a store with more pages than maxPages', async () => {
    const ws = await open({ 'knowledge/concepts/a.md': page(['type: concept']), 'knowledge/concepts/b.md': page(['type: concept']) }, { maxPages: 1 })
    await expect(ws.ctx.knowledge.index({})).rejects.toThrow('more than maxPages (1)')
  })

  it('rejects a store root that is a file', async () => {
    const ws = await open({ knowledge: 'not a directory' })
    await expect(ws.ctx.knowledge.index({})).rejects.toThrow('is not a directory')
  })

  it('releases ctx.knowledge when disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem)
    const fiber = await ctx.plugin(WikiFilesystemKnowledge, {})
    expect(ctx.knowledge.storeRoot).toBe('knowledge')
    await fiber.dispose()
    expect(ctx.get('knowledge')).toBeUndefined()
  })

  it.each([
    [{ root: ' ' }, 'root must name a directory'],
    [{ contentDirs: [] }, 'contentDirs must name at least one directory'],
    [{ contentDirs: ['a/b'] }, 'contentDirs entry "a/b"'],
    [{ readOnlyDirs: ['concepts'] }, 'readOnlyDirs and contentDirs share concepts'],
    [{ codeExtensions: ['.ts'] }, 'codeExtensions entry ".ts"'],
    [{ maxPages: 0 }, 'maxPages must be a positive integer'],
  ])('fails loud on invalid configuration %#', async (config, message) => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem)
    await expect(ctx.plugin(WikiFilesystemKnowledge, config)).rejects.toThrow(message)
  })
})
