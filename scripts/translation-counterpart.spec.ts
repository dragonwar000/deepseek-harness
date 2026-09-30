/**
 * Regression tests for the English-only Agent Note rule: which sources may
 * merge without a Chinese counterpart, what a link to one resolves to, and that
 * an Agent Note pair which does exist is still checked for consistency.
 */

import { describe, expect, it } from 'vitest'
import {
  requiresTranslationCounterpart,
  translationCounterpartVerdict,
} from './translation-counterpart.ts'
import {
  computeTranslationPairingRecord,
  translationPairPaths,
  translationPairingRecordDiff,
} from './translation-pairing-record.ts'
import {
  parseTranslationMarkdown,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'
import { translationLinkLocaleViolations } from './translation-links.ts'

const NOTE = '.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md'
const isTranslationPairSource = translationPairSourcePredicate({ excluded: [] })

/** Link-resolution inputs whose content plane is exactly the listed paths. */
function context(present: readonly string[]) {
  const files = new Set(present)
  return {
    repoRoot: '/nonexistent',
    isTranslationPairSource,
    repositoryFileExists: (file: string): boolean => files.has(file),
  }
}

/** Ordered semantic link targets of one side of a pair. */
function linkTargets(sourcePath: string, markdown: string, present: readonly string[]) {
  return translationStructureSignature(
    parseTranslationMarkdown(markdown),
    [],
    { ...context(present), sourcePath, markdown },
  ).links
}

describe('the counterpart requirement', () => {
  it.each([
    NOTE,
    '.agents/notes/proposed/feature/2026-09-30-topic.md',
    '.agents/notes/rejected/architecture/2026-01-02-topic.md',
    '.agents/notes/implemented/bug-fix/2026-01-02-a-b-c.md',
  ])('lets an active Agent Note merge English-only: %s', (source) => {
    expect(requiresTranslationCounterpart(source)).toBe(false)
    expect(translationCounterpartVerdict(source)).toEqual({ state: 'english-only' })
  })

  it.each([
    ['a docs page', 'docs/guide.md'],
    ['a nested docs page', 'docs/cookbook/adding-a-tool.md'],
    ['a package README', 'packages/core/agent/README.md'],
    ['the root README', 'README.md'],
    ['a root paired document', 'CONTRIBUTING.md'],
    ['a python page', 'python/sdk/guide.md'],
    ['the Agent Note index', '.agents/notes/README.md'],
    ['a frozen archived note', '.agents/notes/archived/process/2026-07-26-frozen.md'],
    ['an undated file in a class folder', '.agents/notes/implemented/process/notes.md'],
    ['a file at a lifecycle root', '.agents/notes/implemented/2026-09-30-topic.md'],
    ['an unknown class folder', '.agents/notes/implemented/refactor/2026-09-30-topic.md'],
    ['an unknown lifecycle folder', '.agents/notes/accepted/process/2026-09-30-topic.md'],
  ])('still requires a counterpart for %s', (_case, source) => {
    expect(requiresTranslationCounterpart(source)).toBe(true)
    expect(translationCounterpartVerdict(source)).toEqual({
      state: 'missing',
      error: `${source}: in-scope documentation must merge bilingual (docs/i18n/README.md); add the counterpart and record the pair`,
    })
  })
})

describe('links to an English-only Agent Note', () => {
  const markdown = '[Decision](../.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md)\n'

  it('leaves both sides of a pair pointing at the note’s .md path', () => {
    const present = [NOTE, 'docs/guide.md', 'docs/guide.zh.md']
    expect(translationLinkLocaleViolations(markdown, {
      ...context(present), sourcePath: 'docs/guide.zh.md',
    })).toEqual([])
    expect(translationStructureDiff(
      { headings: [], code: [], tables: [], lists: [], links: linkTargets('docs/guide.md', markdown, present) },
      { headings: [], code: [], tables: [], lists: [], links: linkTargets('docs/guide.zh.md', markdown, present) },
    )).toEqual([])
  })

  it('switches the Chinese side back to .zh.md once the note gains a counterpart', () => {
    const present = [NOTE, NOTE.replace(/\.md$/, '.zh.md'), 'docs/guide.md', 'docs/guide.zh.md']
    expect(translationLinkLocaleViolations(markdown, {
      ...context(present), sourcePath: 'docs/guide.zh.md',
    })).toEqual([{
      sourcePath: 'docs/guide.zh.md',
      line: 1,
      url: '../.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md',
      expectedUrl: '../.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.zh.md',
    }])
  })
})

describe('an Agent Note pair that does exist', () => {
  const paths = translationPairPaths(NOTE)
  const en = '# Agent Note: Example\n\nStatus: implemented\n\n## Problem\n\nThe English statement.\n'
  const zh = '# Agent Note: Example\n\nStatus: implemented\n\n## Problem\n\n中文陈述。\n'
  const present = [NOTE, paths.zh]

  it('reports drift when one side changes without re-recording', () => {
    const confirmed = computeTranslationPairingRecord(paths, en, zh, context(present))
    const drifted = computeTranslationPairingRecord(
      paths,
      en,
      zh.replace('中文陈述。', '改写后的中文陈述。'),
      context(present),
    )
    expect(translationPairingRecordDiff(confirmed, drifted))
      .toEqual(['section /agent-note-example/problem changed since confirmation (zh)'])
  })

  it('reports a structural divergence between its two sides', () => {
    expect(translationStructureDiff(
      translationStructureSignature(parseTranslationMarkdown(en), [], { ...context(present), sourcePath: NOTE, markdown: en }),
      translationStructureSignature(
        parseTranslationMarkdown(`${zh}\n## 额外章节\n`),
        [],
        { ...context(present), sourcePath: paths.zh, markdown: `${zh}\n## 额外章节\n` },
      ),
    )).toEqual(['heading (depth) #3 diverges between the pair: nothing vs 2'])
  })
})
