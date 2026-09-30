/**
 * The pairing check over one content plane, separated from the CLI so its
 * findings can be tested against an in-memory corpus. The check reports every
 * finding with its class; `translation-counterpart.ts` decides which classes
 * fail under the policy in effect.
 */

import { basename } from 'node:path'
import {
  acceptsTranslationCounterpart,
  agentNoteCounterpartFinding,
  missingCounterpartFinding,
  type TranslationCounterpartPolicy,
  type TranslationPairingFinding,
} from './translation-counterpart.ts'
import {
  computeTranslationPairingRecord,
  parseTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairingRecordDiff,
  translationPairPaths,
} from './translation-pairing-record.ts'
import {
  generatedRegions,
  isTranslationPairingManifestExcluded,
  languageSwitcherTargets,
  parseTranslationMarkdown,
  requiresSourceLanguageSwitcher,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
  type TranslationPairingManifest,
} from './translation-pairing.ts'
import {
  hasLanguageSwitcher,
  normalizeTranslationMarkdownLinks,
  translationLinkLocaleViolations,
} from './translation-links.ts'

/** The documents one pairing check reads. */
export interface TranslationPairingCorpus {
  /** Absolute repository root, used only to resolve relative link identities. */
  repoRoot: string
  /** In-scope `.md`, `.zh.md`, and `.i18n.yaml` paths to check, repository-relative. */
  files: Iterable<string>
  manifest: TranslationPairingManifest
  /** Policy applied to link targets that have no counterpart. */
  policy: TranslationCounterpartPolicy
  /** UTF-8 content of one path in the selected content plane, or undefined when absent. */
  read: (file: string) => string | undefined
  /** Whether one path exists in the selected content plane. */
  exists: (file: string) => boolean
}

/** Pairing state of one in-scope English source, as `--list` prints it. */
export type TranslationPairState = 'ok' | 'out-of-sync' | 'missing' | 'english-only'

/** Result of one pairing check. */
export interface TranslationPairingReport {
  findings: TranslationPairingFinding[]
  /** State of every in-scope, non-excluded English source. */
  state: Map<string, TranslationPairState>
  /** Number of pair anchors that have a counterpart or a record. */
  pairs: number
}

/**
 * Check every source and pair in a corpus.
 *
 * @param corpus - Files, manifest, policy, and content-plane readers.
 * @returns Classified findings, per-source state, and the pair count.
 * @throws Error when a file reported as existing cannot be read.
 */
export function checkTranslationPairing(corpus: TranslationPairingCorpus): TranslationPairingReport {
  const { manifest, exists, read } = corpus
  const files = [...corpus.files]
  const translations = files.filter(file => file.endsWith('.zh.md')).sort()
  const metas = files.filter(file => file.endsWith('.i18n.yaml')).sort()
  const sources = files.filter(file => file.endsWith('.md') && !file.endsWith('.zh.md')).sort()
  const isExcluded = (file: string): boolean => isTranslationPairingManifestExcluded(file, manifest)
  const linkContext = {
    repoRoot: corpus.repoRoot,
    isTranslationPairSource: translationPairSourcePredicate(manifest),
    repositoryFileExists: exists,
    counterpartPolicy: corpus.policy,
  }
  const findings: TranslationPairingFinding[] = []
  const state = new Map<string, TranslationPairState>()
  const counterpart = (message: string): void => {
    findings.push({ kind: 'counterpart', message })
  }
  const integrity = (message: string): void => {
    findings.push({ kind: 'integrity', message })
  }

  // 1. A source with no counterpart: an Agent Note never has one; any other
  // source is reported as missing it.
  for (const source of sources) {
    if (isExcluded(source) || exists(translationPairPaths(source).zh)) continue
    if (acceptsTranslationCounterpart(source)) {
      findings.push(missingCounterpartFinding(source))
      state.set(source, 'missing')
    } else {
      state.set(source, 'english-only')
    }
  }

  // 2. Anchor on the union of .zh.md files and .i18n.yaml records so a
  // half-deleted pair is found from either remnant.
  const pairAnchors = new Set<string>()
  for (const zh of translations) pairAnchors.add(zh.replace(/\.zh\.md$/, '.md'))
  for (const meta of metas) pairAnchors.add(meta.replace(/\.i18n\.yaml$/, '.md'))

  for (const source of [...pairAnchors].sort()) {
    const paths = translationPairPaths(source)
    const { zh, meta } = paths
    const have = { source: exists(source), zh: exists(zh), meta: exists(meta) }

    if (isExcluded(source)) {
      if (have.zh) integrity(`${zh}: ${source} is excluded from pairing (generated or bilingual-by-construction); this translation must not exist`)
      if (have.meta) integrity(`${meta}: ${source} is excluded from pairing; this consistency record must not exist`)
      continue
    }
    if (!acceptsTranslationCounterpart(source)) {
      if (have.zh) findings.push(agentNoteCounterpartFinding(zh))
      if (have.meta) findings.push(agentNoteCounterpartFinding(meta))
      if (have.source) state.set(source, 'out-of-sync')
      continue
    }
    if (!have.source) {
      const remnants = [have.zh ? zh : undefined, have.meta ? meta : undefined].filter(file => file !== undefined)
      integrity(`${source}: the English source is gone but ${remnants.join(', ')} remains; delete or move the remnant with its source`)
      continue
    }
    if (!have.zh || !have.meta) {
      counterpart(`${source}: incomplete pair — missing ${have.zh ? meta : zh} (a pair is both languages plus the .i18n.yaml record)`)
      state.set(source, 'out-of-sync')
      continue
    }

    const sourceText = read(source)
    const zhText = read(zh)
    const metaText = read(meta)
    if (sourceText === undefined || zhText === undefined || metaText === undefined) {
      throw new Error(`${source}: complete pair became unreadable`)
    }
    const record = parseTranslationPairingRecord(metaText)
    if (record === undefined) {
      integrity(`${meta}: malformed consistency record (expected \`/<section path>:\` entries, each followed by \`  en: <16-hex>\` and \`  zh: <16-hex>\`)`)
      state.set(source, 'out-of-sync')
      continue
    }

    let current: ReturnType<typeof computeTranslationPairingRecord>
    try {
      current = computeTranslationPairingRecord(paths, sourceText, zhText, linkContext)
    } catch (error) {
      counterpart(`${source} ↔ ${zh}: ${error instanceof Error ? error.message : String(error)}`)
      state.set(source, 'out-of-sync')
      continue
    }
    const recordErrors = translationPairingRecordDiff(record, current).map(message => (
      `${meta}: out of sync — ${message} (bring the other side along, then re-record with --write)`
    ))
    if (recordErrors.length === 0 && renderTranslationPairingRecord(paths, current) !== metaText) {
      recordErrors.push(`${meta}: not in canonical form (re-record with --write)`)
    }
    if (recordErrors.length > 0) {
      for (const message of recordErrors) counterpart(message)
      state.set(source, 'out-of-sync')
      continue
    }
    const sourceSwitcherTargets = languageSwitcherTargets(source)
    const zhSwitcherTargets = languageSwitcherTargets(zh)
    const sourceContext = { ...linkContext, sourcePath: source }
    const zhContext = { ...linkContext, sourcePath: zh }
    for (const violation of [
      ...translationLinkLocaleViolations(sourceText, sourceContext, zhSwitcherTargets),
      ...translationLinkLocaleViolations(zhText, zhContext, sourceSwitcherTargets),
    ]) {
      counterpart(`${violation.sourcePath}:${violation.line}: link target ${JSON.stringify(violation.url)} uses the wrong locale; expected ${JSON.stringify(violation.expectedUrl)}`)
      state.set(source, 'out-of-sync')
    }

    // Generated regions must remain byte-identical after paired document paths
    // are normalized to one semantic target. The structural signature below
    // compares their contents again as part of the whole document; this named
    // check reports any prose, ordering, code, marker, or non-locale URL drift.
    let sourceRegions: string[]
    let zhRegions: string[]
    try {
      sourceRegions = generatedRegions(sourceText).map(region => region.text)
      zhRegions = generatedRegions(zhText).map(region => region.text)
    } catch (error) {
      counterpart(`${source} ↔ ${zh}: ${error instanceof Error ? error.message : String(error)}`)
      state.set(source, 'out-of-sync')
      continue
    }
    const normalizedSourceRegions = sourceRegions.map(region => normalizeTranslationMarkdownLinks(region, sourceContext))
    const normalizedZhRegions = zhRegions.map(region => normalizeTranslationMarkdownLinks(region, zhContext))
    if (normalizedSourceRegions.length !== normalizedZhRegions.length
      || normalizedSourceRegions.some((region, index) => region !== normalizedZhRegions[index])) {
      counterpart(`${source} ↔ ${zh}: generated regions differ beyond paired-document locale paths — regenerate both sides`)
      state.set(source, 'out-of-sync')
    }

    const sourceTree = parseTranslationMarkdown(sourceText)
    const zhTree = parseTranslationMarkdown(zhText)
    const structureErrors: string[] = []
    if (!hasLanguageSwitcher(zhTree, zhText, sourceSwitcherTargets)) {
      structureErrors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
    }
    if (requiresSourceLanguageSwitcher(source) && !hasLanguageSwitcher(sourceTree, sourceText, zhSwitcherTargets)) {
      structureErrors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
    }
    for (const divergence of translationStructureDiff(
      translationStructureSignature(sourceTree, zhSwitcherTargets, { ...sourceContext, markdown: sourceText }),
      translationStructureSignature(zhTree, sourceSwitcherTargets, { ...zhContext, markdown: zhText }),
    )) {
      structureErrors.push(`${source} ↔ ${zh}: ${divergence}`)
    }
    for (const message of structureErrors) counterpart(message)
    if (structureErrors.length > 0) state.set(source, 'out-of-sync')
    if (!state.has(source)) state.set(source, 'ok')
  }

  return { findings, state, pairs: pairAnchors.size }
}
