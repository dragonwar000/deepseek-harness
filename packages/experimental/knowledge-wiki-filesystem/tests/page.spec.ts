import { describe, expect, it } from 'vitest'
import { knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { codePathCandidates, mdlinkTargets, oneLine, parsePage, renderPage, stripCode, wikilinkTargets } from '../src/page.ts'

/** overstack wiki-graph.py `_REL_RE`, used to prove written relations stay readable by the Python tools. */
const OVERSTACK_REL = /\{[ \t]*rel[ \t]*:[ \t]*([\w-]+)[ \t]*,[ \t]*to[ \t]*:[ \t]*([^}\s]+)[ \t]*\}/

describe('parsePage', () => {
  it('reads type, title, updated, declared relations, citation, and the Origin section', () => {
    const parsed = parsePage([
      '---',
      'type: concept',
      'title: Retry policy',
      'updated: 2026-09-20',
      'relations:',
      '  - {rel: supports, to: concepts/a.md}',
      '  - {rel: khong-hop-le, to: concepts/a.md}',
      '  - {rel: implements, path: src/retry.ts}',
      '  - plain',
      'citation:',
      '  session: s1',
      '  seqs: [3]',
      '  sources: [src/retry.ts]',
      '  writer: tool',
      '---',
      '',
      '# Retry policy',
      '',
      '## Origin',
      '- Session: `s1`',
      '',
    ].join('\n'))
    expect(parsed).toEqual({
      kind: 'page',
      front: {
        type: 'concept',
        title: 'Retry policy',
        updated: '2026-09-20',
        relations: [{ relation: 'supports', to: 'concepts/a.md' }],
        citation: { session: 's1', seqs: [3], sources: ['src/retry.ts'], writer: 'tool' },
      },
      body: '\n# Retry policy\n\n## Origin\n- Session: `s1`\n',
      origin: true,
    })
  })

  it('keeps a page without title, updated, relations, citation, or Origin', () => {
    expect(parsePage('---\ntype: note\ntitle: ""\n---\nBody\n')).toEqual({ kind: 'page', front: { type: 'note', relations: [] }, body: 'Body\n', origin: false })
  })

  it('quarantines a page without frontmatter, with broken YAML, or without a type', () => {
    expect(parsePage('# No frontmatter\n')).toEqual({ kind: 'quarantined', reason: 'The page has no YAML frontmatter block.' })
    const broken = parsePage('---\ntype: [unclosed\n---\n')
    expect(broken.kind).toBe('quarantined')
    expect(broken.kind === 'quarantined' && broken.reason.startsWith('The frontmatter is not YAML: ')).toBe(true)
    for (const block of ['title: x', 'type: ""', 'type: "   "', '- type: concept']) {
      expect(parsePage(`---\n${block}\n---\n`)).toEqual({ kind: 'quarantined', reason: 'The frontmatter is not a mapping with a non-empty type.' })
    }
  })
})

describe('links', () => {
  it('ignores links inside code and keeps wikilink targets without anchors or aliases, once each', () => {
    const body = 'See [[b]], [[b#part]], [[c|alias]], [[ ]], `[[inline]]`\n```\n[[fenced]]\n```\n'
    expect(stripCode('a `x` b')).toBe('a   b')
    expect(wikilinkTargets(body)).toEqual(['b', 'c'])
  })

  it('keeps Markdown links to .md files outside code', () => {
    expect(mdlinkTargets('[x](../entities/x.md) [y](y.md#part) [z](z.txt) `[w](w.md)` [x](../entities/x.md)')).toEqual(['../entities/x.md', 'y.md'])
  })

  it('offers backticked paths with a directory and a configured extension as code candidates', () => {
    const extensions = new Set(['ts', 'py'])
    expect(codePathCandidates('`src/a.ts` `a.ts` `src/b.md` `lib/c.py` plain src/d.ts `src/a.ts`', extensions)).toEqual(['src/a.ts', 'lib/c.py'])
  })
})

describe('renderPage', () => {
  const citation = { sessionId: SessionId('s1'), sourceEventSeqs: [SessionSeq(7), SessionSeq(9)], sources: ['src/retry.ts'], writer: 'tool' as const }

  it('writes frontmatter, a title heading, the body, and an Origin section that parse back', () => {
    const content = renderPage({
      id: knowledgePageId('concepts/retry.md'), type: 'concept', title: 'Retry\npolicy', body: '  Retries back off.  ',
      relations: [{ relation: 'depends-on', to: knowledgePageId('concepts/backoff.md') }],
    }, citation, '2026-09-30T10:00:00.000Z')
    expect(content).toBe([
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
      'Retries back off.',
      '',
      '## Origin',
      '',
      '- Session: `s1`',
      '- Source events: 7, 9',
      '- Sources: `src/retry.ts`',
      '- Writer: tool',
      '',
    ].join('\n'))
    expect(OVERSTACK_REL.exec(content)?.slice(1)).toEqual(['depends-on', 'concepts/backoff.md'])
    const parsed = parsePage(content)
    expect(parsed.kind === 'page' && parsed.front).toEqual({
      type: 'concept', title: 'Retry policy', updated: '2026-09-30T10:00:00.000Z',
      relations: [{ relation: 'depends-on', to: 'concepts/backoff.md' }],
      citation: { session: 's1', seqs: [7, 9], sources: ['src/retry.ts'], writer: 'tool' },
    })
    expect(parsed.kind === 'page' && parsed.origin).toBe(true)
  })

  it('omits the relations block and the body when both are empty', () => {
    const content = renderPage({ id: knowledgePageId('concepts/x.md'), type: 'concept', title: 'X', body: ' ', relations: [] }, citation, 't')
    expect(content).not.toContain('relations:')
    expect(content).toContain('# X\n\n## Origin')
    expect(oneLine('  a \n b\t')).toBe('a b')
  })
})
