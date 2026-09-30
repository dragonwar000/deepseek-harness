/**
 * Check English/Chinese pairs for every in-scope document: completeness,
 * matching structure, and recorded per-section hashes. `translation-counterpart.ts`
 * owns the counterpart policy. Under the repository's `optional` policy a
 * missing, incomplete, or out-of-sync counterpart is reported and the gate
 * exits 0; `--policy=required` enforces each of those findings. Under either
 * policy the gate rejects a counterpart or record beside an active Agent Note
 * or an excluded file, a record that cannot be parsed, and a counterpart whose
 * English source is gone.
 * `--list` reports state; `--write <pairs...>` records the named confirmed
 * pairs (`--write --all` records every complete pair); `--cached <pairs...>`
 * checks exact index bytes for hooks. A check or write named with pair paths
 * touches only those pairs, so update iteration does not pay for a corpus
 * scan. Translation quality remains a review responsibility.
 * See `docs/i18n/README.md` for the owning contract.
 */

import { existsSync, globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { enforcedTranslationPairingFindings } from './translation-counterpart.ts'
import { checkTranslationPairing } from './translation-pairing-check.ts'
import { gitIndexPaths, readGitIndexBlob } from './translation-pairing-git.ts'
import {
  computeTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'
import {
  parseTranslationPairingCliArgs,
  parseTranslationPairingManifest,
  isTranslationPairingManifestExcluded,
  isTranslationScopeFile,
  TRANSLATION_SCOPE_GLOB_EXCLUDES,
  translationPairSourcePredicate,
} from './translation-pairing.ts'

const root = resolve(import.meta.dirname, '..')
let request: ReturnType<typeof parseTranslationPairingCliArgs>
try {
  request = parseTranslationPairingCliArgs(process.argv.slice(2))
} catch (error) {
  console.error(`verify-translation-pairing: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const listMode = request.mode === 'list'
const writeMode = request.mode === 'write'
const indexMode = request.input === 'index'
const policy = request.policy
const indexFiles = indexMode ? gitIndexPaths(root) : undefined

const contentCache = new Map<string, Buffer | undefined>()

/** Read one repository path from the selected worktree or index plane. */
function readRepositoryFile(file: string): Buffer | undefined {
  if (contentCache.has(file)) return contentCache.get(file)
  const content = indexMode
    ? indexFiles?.has(file) ? readGitIndexBlob(root, file) : undefined
    : existsSync(join(root, file)) && statSync(join(root, file)).isFile()
      ? readFileSync(join(root, file))
      : undefined
  contentCache.set(file, content)
  return content
}

/** Whether one path exists in the selected content plane. */
function repositoryFileExists(file: string): boolean {
  return indexMode ? indexFiles?.has(file) === true : readRepositoryFile(file) !== undefined
}

/** Discover source Markdown and pairing sidecars before applying the corpus predicate. */
const SCOPE_PATTERNS = [
  '**/*.md',
  '**/*.i18n.yaml',
  '.agents/notes/**/*.md',
  '.agents/notes/**/*.i18n.yaml',
]

const manifestContent = readRepositoryFile('scripts/translation-pairing.manifest.json')
if (manifestContent === undefined) {
  throw new Error('scripts/translation-pairing.manifest.json is missing from the selected content plane')
}
const manifest = parseTranslationPairingManifest(manifestContent.toString('utf8'))
const isTranslationPairSource = translationPairSourcePredicate(manifest)

/**
 * An excluded entry ending in `/` excludes the whole directory. The trailing
 * slash IS the path boundary — `docs/tool-catalog/` cannot prefix-match a
 * sibling like `docs/tool-catalog-notes/x.md` — so directory entries in the
 * manifest must keep their trailing slash.
 */
function isExcluded(file: string): boolean {
  return isTranslationPairingManifestExcluded(file, manifest)
}

const recordContext = { repoRoot: root, isTranslationPairSource, repositoryFileExists, counterpartPolicy: policy }

// Enumerate the scope once: the whole corpus, or exactly the named pairs'
// three files (a named pair whose files are absent is caught by the same
// completeness rules that cover discovered remnants).
const files = new Set<string>()
if (request.scope === 'pairs') {
  for (const anchor of request.anchors) {
    const { source, zh, meta } = translationPairPaths(anchor)
    for (const file of [source, zh, meta]) {
      if (repositoryFileExists(file)) files.add(file)
    }
    // A named worktree anchor with no files still enters the source list so
    // an interactive check reports it. An index check accepts a complete
    // three-file deletion and still rejects every partial deletion below.
    if (!indexMode && !repositoryFileExists(anchor)) files.add(anchor)
  }
} else {
  for (const pattern of SCOPE_PATTERNS) {
    for (const match of globSync(pattern, { cwd: root, exclude: TRANSLATION_SCOPE_GLOB_EXCLUDES })) {
      const normalized = match.split(sep).join('/')
      if (isTranslationScopeFile(normalized)) files.add(normalized)
    }
  }
}
const sources = [...files].filter(f => f.endsWith('.md') && !f.endsWith('.zh.md')).sort()

if (request.scope === 'pairs') {
  const rejected = request.anchors.filter(anchor => !isTranslationScopeFile(anchor) || isExcluded(anchor))
  const absent = request.anchors.filter((anchor) => {
    const { source, zh, meta } = translationPairPaths(anchor)
    return ![source, zh, meta].some(repositoryFileExists)
  })
  if (rejected.length > 0 || (!indexMode && absent.length > 0)) {
    for (const anchor of rejected) {
      console.error(`verify-translation-pairing: ${anchor} is not an in-scope pair (excluded or outside the documentation corpus; see docs/i18n/README.md)`)
    }
    for (const anchor of absent) {
      console.error(`verify-translation-pairing: ${anchor} names no pair on disk (none of its three files exist)`)
    }
    process.exit(2)
  }
}

// --write: (re)record the section hashes for the requested complete pairs, creating
// missing records. A named pair that cannot be recorded (missing counterpart)
// fails loud; corpus scope (--all) skips pairless sources as before.
if (writeMode) {
  let written = 0
  for (const source of sources) {
    if (isExcluded(source)) continue
    const paths = translationPairPaths(source)
    const { zh, meta } = paths
    if (!repositoryFileExists(source) || !repositoryFileExists(zh)) {
      if (request.scope === 'pairs') {
        console.error(`verify-translation-pairing: cannot record ${source}: missing ${repositoryFileExists(source) ? zh : source}`)
        process.exit(2)
      }
      continue
    }
    const sourceContent = readRepositoryFile(source)
    const zhContent = readRepositoryFile(zh)
    if (sourceContent === undefined || zhContent === undefined) throw new Error(`${source}: complete pair became unreadable`)
    let record: string
    try {
      record = renderTranslationPairingRecord(paths, computeTranslationPairingRecord(
        paths,
        sourceContent.toString('utf8'),
        zhContent.toString('utf8'),
        recordContext,
      ))
    } catch (error) {
      console.error(`verify-translation-pairing: cannot record ${source}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
    if (existsSync(join(root, meta)) && readFileSync(join(root, meta), 'utf8') === record) continue
    writeFileSync(join(root, meta), record)
    console.log(`verify-translation-pairing: recorded ${meta}`)
    written++
  }
  console.log(`verify-translation-pairing: ${written} record(s) written; run the check to validate the pairs.`)
  process.exit(0)
}

const report = checkTranslationPairing({
  repoRoot: root,
  files,
  manifest,
  policy,
  read: file => readRepositoryFile(file)?.toString('utf8'),
  exists: repositoryFileExists,
})
const { state } = report
const errors = enforcedTranslationPairingFindings(report.findings, policy)
const reported = report.findings.length - errors.length

if (listMode) {
  const order = { 'out-of-sync': 0, 'missing': 1, 'english-only': 2, 'ok': 3 } as const
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
  for (const [file, status] of rows) {
    console.log(`${status.padEnd(12)} ${file}${status === 'missing' && policy === 'required' ? '  (required)' : ''}`)
  }
  const counts = { 'ok': 0, 'out-of-sync': 0, 'missing': 0, 'english-only': 0 }
  for (const status of state.values()) counts[status]++
  console.log(`verify-translation-pairing: ${counts.ok} ok, ${counts['out-of-sync']} out-of-sync, ${counts['english-only']} english-only, ${counts.missing} missing (of ${state.size} in scope; counterpart policy ${policy})`)
  process.exit(0)
}

if (errors.length === 0) {
  console.log(request.scope === 'pairs'
    ? `verify-translation-pairing: ${report.pairs} named ${indexMode ? 'staged ' : ''}pair(s) checked; the corpus-wide check still runs in doc-sync.`
    : `verify-translation-pairing: ${report.pairs} pair(s) checked across all in-scope documentation.`)
  console.log(reported === 0
    ? `verify-translation-pairing: no findings (counterpart policy ${policy}).`
    : `verify-translation-pairing: ${reported} counterpart finding(s) reported and not enforced (counterpart policy ${policy}); --list names the documents, --policy=required prints and enforces each finding.`)
  process.exit(0)
}

console.error(`verify-translation-pairing: pairing rules violated (counterpart policy ${policy}; see docs/i18n/README.md):`)
for (const message of errors) console.error(`  ${message}`)
process.exit(1)
