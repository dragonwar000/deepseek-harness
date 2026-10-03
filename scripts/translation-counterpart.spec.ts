/**
 * Regression tests for the counterpart policy: which pairing findings fail
 * under `optional` and under `required`, that an active Agent Note accepts no
 * counterpart under either, and what a link to a source without a counterpart
 * resolves to.
 */

import { describe, expect, it } from 'vitest'
import {
  acceptsTranslationCounterpart,
  enforcedTranslationPairingFindings,
  isLocaleSwitchedTarget,
  parseTranslationCounterpartPolicy,
  requiresTranslationCounterpart,
  TRANSLATION_COUNTERPART_POLICY,
  type TranslationCounterpartPolicy,
} from './translation-counterpart.ts'
import { checkTranslationPairing } from './translation-pairing-check.ts'
import {
  computeTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'
import { translationPairSourcePredicate } from './translation-pairing.ts'
import { translationLinkLocaleViolations } from './translation-links.ts'

const NOTE = '.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md'
const MANIFEST = { excluded: ['docs/AGENTS.md'] }
const POLICIES = ['optional', 'required'] as const

/** One document's English text and matching Chinese text with the switchers the gate expects. */
function pairText(source: string, body = 'The English statement.', zhBody = '中文陈述。'): { en: string; zh: string } {
  const base = source.slice(source.lastIndexOf('/') + 1)
  return {
    en: `# Guide\n\nEnglish | [中文](${base.replace(/\.md$/, '.zh.md')})\n\n## Usage\n\n${body}\n`,
    zh: `# 指南\n\n[English](${base}) | 中文\n\n## 用法\n\n${zhBody}\n`,
  }
}

/** The three files of a pair whose record matches its two sides. */
function consistentPair(source: string): Record<string, string> {
  const paths = translationPairPaths(source)
  const { en, zh } = pairText(source)
  const present = new Set([paths.source, paths.zh])
  const record = computeTranslationPairingRecord(paths, en, zh, {
    repoRoot: '/nonexistent',
    isTranslationPairSource: translationPairSourcePredicate(MANIFEST),
    repositoryFileExists: file => present.has(file),
  })
  return { [paths.source]: en, [paths.zh]: zh, [paths.meta]: renderTranslationPairingRecord(paths, record) }
}

/** Run the pairing check over an in-memory corpus and apply one policy. */
function check(files: Record<string, string>, policy: TranslationCounterpartPolicy) {
  const report = checkTranslationPairing({
    repoRoot: '/nonexistent',
    files: Object.keys(files),
    manifest: MANIFEST,
    policy,
    read: file => files[file],
    exists: file => Object.hasOwn(files, file),
  })
  return { ...report, failures: enforcedTranslationPairingFindings(report.findings, policy) }
}

describe('the counterpart policy', () => {
  it('makes English the only required language for the repository', () => {
    expect(TRANSLATION_COUNTERPART_POLICY).toBe('optional')
  })

  it('parses only the two policy names', () => {
    expect(POLICIES.map(parseTranslationCounterpartPolicy)).toEqual(['optional', 'required'])
    expect(() => parseTranslationCounterpartPolicy('strict'))
      .toThrow('unknown counterpart policy "strict" (expected optional or required)')
  })

  it.each([
    NOTE,
    '.agents/notes/proposed/feature/2026-09-30-topic.md',
    '.agents/notes/rejected/architecture/2026-01-02-topic.md',
    '.agents/notes/implemented/bug-fix/2026-01-02-a-b-c.md',
  ])('gives an active Agent Note no counterpart under either policy: %s', (source) => {
    expect(acceptsTranslationCounterpart(source)).toBe(false)
    for (const policy of POLICIES) {
      expect(requiresTranslationCounterpart(source, policy)).toBe(false)
      expect(isLocaleSwitchedTarget(source, true, policy)).toBe(false)
    }
  })

  it.each([
    ['a docs page', 'docs/guide.md'],
    ['a package README', 'packages/core/agent/README.md'],
    ['the root README', 'README.md'],
    ['an upgrade guide', 'docs/upgrade-guide/v1.0.0/item/guide.md'],
    ['the Agent Note rules', '.agents/notes/README.md'],
    ['a frozen archived note', '.agents/notes/archived/process/2026-07-26-frozen.md'],
    ['an undated file in a class folder', '.agents/notes/implemented/process/notes.md'],
    ['an unknown class folder', '.agents/notes/implemented/refactor/2026-09-30-topic.md'],
    ['an unknown lifecycle folder', '.agents/notes/accepted/process/2026-09-30-topic.md'],
  ])('requires a counterpart for %s only under the required policy', (_case, source) => {
    expect(acceptsTranslationCounterpart(source)).toBe(true)
    expect(requiresTranslationCounterpart(source, 'optional')).toBe(false)
    expect(requiresTranslationCounterpart(source, 'required')).toBe(true)
    expect(isLocaleSwitchedTarget(source, false, 'optional')).toBe(false)
    expect(isLocaleSwitchedTarget(source, false, 'required')).toBe(true)
    expect(isLocaleSwitchedTarget(source, true, 'optional')).toBe(true)
  })
})

describe('the pairing check under each policy', () => {
  it.each(POLICIES)('passes a consistent pair and an English-only Agent Note under %s', (policy) => {
    const result = check({ ...consistentPair('docs/guide.md'), [NOTE]: '# Agent Note: Example\n' }, policy)
    expect(result.findings).toEqual([])
    expect([...result.state]).toEqual([[NOTE, 'english-only'], ['docs/guide.md', 'ok']])
  })

  it.each([
    ['a docs page', 'docs/new-page.md'],
    ['a package README', 'packages/core/agent/README.md'],
    ['an upgrade guide', 'docs/upgrade-guide/v1.0.0/item/guide.md'],
  ])('reports %s with no counterpart and fails it only under required', (_case, source) => {
    const files = { [source]: '# English only\n' }
    const message = `${source}: no Chinese counterpart (docs/i18n/README.md); the required policy needs the counterpart and its pairing record`
    expect(check(files, 'optional')).toMatchObject({ failures: [], findings: [{ kind: 'counterpart', message }] })
    expect(check(files, 'optional').state.get(source)).toBe('missing')
    expect(check(files, 'required').failures).toEqual([message])
  })

  it('reports an out-of-date counterpart and fails it only under required', () => {
    const files = consistentPair('docs/guide.md')
    files['docs/guide.md'] = pairText('docs/guide.md', 'The English statement, since edited.').en
    const message = 'docs/guide.i18n.yaml: out of sync — section /guide/usage changed since confirmation (en) (bring the other side along, then re-record with --write)'
    expect(check(files, 'optional')).toMatchObject({ failures: [], findings: [{ kind: 'counterpart', message }] })
    expect(check(files, 'optional').state.get('docs/guide.md')).toBe('out-of-sync')
    expect(check(files, 'required').failures).toEqual([message])
  })

  it('reports a counterpart whose structure diverged and fails it only under required', () => {
    const paths = translationPairPaths('docs/guide.md')
    const { en, zh } = pairText('docs/guide.md')
    const diverged = `${zh}\n## 额外章节\n\n多出的内容。\n`
    const files = { [paths.source]: en, [paths.zh]: diverged, [paths.meta]: consistentPair('docs/guide.md')[paths.meta]! }
    const message = 'docs/guide.md ↔ docs/guide.zh.md: docs/guide.md has 2 heading(s) but docs/guide.zh.md has 3'
    expect(check(files, 'optional')).toMatchObject({ failures: [], findings: [{ kind: 'counterpart', message }] })
    expect(check(files, 'required').failures).toEqual([message])
  })

  it('reports a counterpart with no record and fails it only under required', () => {
    const files = consistentPair('docs/guide.md')
    delete files['docs/guide.i18n.yaml']
    const message = 'docs/guide.md: incomplete pair — missing docs/guide.i18n.yaml (a pair is both languages plus the .i18n.yaml record)'
    expect(check(files, 'optional')).toMatchObject({ failures: [], findings: [{ kind: 'counterpart', message }] })
    expect(check(files, 'required').failures).toEqual([message])
  })

  it.each(POLICIES)('rejects a Chinese counterpart or record beside an active Agent Note under %s', (policy) => {
    const paths = translationPairPaths(NOTE)
    expect(check({ [NOTE]: '# Agent Note: Example\n', [paths.zh]: '# Agent Note: 示例\n' }, policy).failures)
      .toEqual([`${paths.zh}: Agent Notes are English-only (.agents/notes/README.md); delete this file`])
    expect(check({ [NOTE]: '# Agent Note: Example\n', [paths.meta]: '/:\n' }, policy).failures)
      .toEqual([`${paths.meta}: Agent Notes are English-only (.agents/notes/README.md); delete this file`])
    const complete = check({ ...consistentPair(NOTE) }, policy)
    expect(complete.failures).toEqual([
      `${paths.zh}: Agent Notes are English-only (.agents/notes/README.md); delete this file`,
      `${paths.meta}: Agent Notes are English-only (.agents/notes/README.md); delete this file`,
    ])
  })

  it.each(POLICIES)('rejects a record that cannot be parsed under %s', (policy) => {
    const files = { ...consistentPair('docs/guide.md'), 'docs/guide.i18n.yaml': 'not: a: record\n' }
    expect(check(files, policy).failures).toEqual([
      'docs/guide.i18n.yaml: malformed consistency record (expected `/<section path>:` entries, each followed by `  en: <16-hex>` and `  zh: <16-hex>`)',
    ])
  })

  it.each(POLICIES)('rejects a counterpart whose English source is gone under %s', (policy) => {
    const files = consistentPair('docs/guide.md')
    delete files['docs/guide.md']
    expect(check(files, policy).failures).toEqual([
      'docs/guide.md: the English source is gone but docs/guide.zh.md, docs/guide.i18n.yaml remains; delete or move the remnant with its source',
    ])
  })

  it.each(POLICIES)('rejects a counterpart of an excluded file under %s', (policy) => {
    expect(check({ 'docs/AGENTS.md': '# Rules\n', 'docs/AGENTS.zh.md': '# 规则\n' }, policy).failures).toEqual([
      'docs/AGENTS.zh.md: docs/AGENTS.md is excluded from pairing (generated or bilingual-by-construction); this translation must not exist',
    ])
  })
})

describe('links to a source without a counterpart', () => {
  const isTranslationPairSource = translationPairSourcePredicate({ excluded: [] })
  const context = (present: readonly string[], counterpartPolicy: TranslationCounterpartPolicy) => ({
    repoRoot: '/nonexistent',
    sourcePath: 'docs/guide.zh.md',
    isTranslationPairSource,
    repositoryFileExists: (file: string): boolean => present.includes(file),
    counterpartPolicy,
  })

  it('keeps the .md path on the Chinese side under optional and expects .zh.md under required', () => {
    const present = ['docs/guide.md', 'docs/guide.zh.md', 'docs/new-page.md']
    expect(translationLinkLocaleViolations('[New](new-page.md)\n', context(present, 'optional'))).toEqual([])
    expect(translationLinkLocaleViolations('[New](new-page.md)\n', context(present, 'required'))).toEqual([{
      sourcePath: 'docs/guide.zh.md', line: 1, url: 'new-page.md', expectedUrl: 'new-page.zh.md',
    }])
  })

  it.each(POLICIES)('switches to a counterpart that exists under %s', (policy) => {
    const present = ['docs/guide.md', 'docs/guide.zh.md', 'docs/new-page.md', 'docs/new-page.zh.md']
    expect(translationLinkLocaleViolations('[New](new-page.md)\n', context(present, policy))).toEqual([{
      sourcePath: 'docs/guide.zh.md', line: 1, url: 'new-page.md', expectedUrl: 'new-page.zh.md',
    }])
  })

  it.each(POLICIES)('keeps the .md path to an Agent Note under %s, even beside a stray counterpart', (policy) => {
    const markdown = `[Decision](../${NOTE})\n`
    expect(translationLinkLocaleViolations(markdown, context([NOTE, 'docs/guide.md', 'docs/guide.zh.md'], policy))).toEqual([])
    expect(translationLinkLocaleViolations(
      markdown,
      context([NOTE, NOTE.replace(/\.md$/, '.zh.md'), 'docs/guide.md', 'docs/guide.zh.md'], policy),
    )).toEqual([])
  })
})
