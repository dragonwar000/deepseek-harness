/**
 * Shared structural source of truth for the Agent Note tree. Lifecycle and class
 * sets are closed under `.agents/notes/README.md`; importing this module is pure.
 */

import { globSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const agentNoteRoot = resolve(import.meta.dirname, '../.agents/notes')

/** The closed set of active Agent Note lifecycles (top-level folders under .agents/notes/). */
const AGENT_NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const

/**
 * The closed set of Agent Note classes (nested folder under each lifecycle). Adding a
 * class is a deliberate act: extend this list AND the README's Classification
 * section. The gate rejects any folder not listed here.
 */
export const AGENT_NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] as const

/** Historical implemented notes live outside the active lifecycle tree. */
const AGENT_NOTE_ARCHIVE = 'archived'

/** Non-Agent Note Markdown allowed to sit directly at a lifecycle root. */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** Repository-relative prefix of the Agent Note tree. */
const AGENT_NOTE_TREE_PREFIX = '.agents/notes/'

/** Dated Agent Note filename grammar: `yyyy-mm-dd-topic-title.md`. */
const AGENT_NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}-.+\.md$/

/**
 * Whether a repository-relative path is an English Agent Note in the active
 * lifecycle tree: `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`.
 * A `.zh.md` counterpart, the tree's `README`/`AGENTS.md`/`CLAUDE.md`
 * instruction pages, and every frozen path under `archived/` are not Agent Note
 * files and do not match.
 *
 * @param file - Repository-relative path with `/` separators.
 * @returns True for an English Agent Note in the active lifecycle tree.
 */
export function isActiveAgentNotePath(file: string): boolean {
  if (!file.startsWith(AGENT_NOTE_TREE_PREFIX)) return false
  const segments = file.slice(AGENT_NOTE_TREE_PREFIX.length).split('/')
  if (segments.length !== 3) return false
  const [lifecycle, cls, base] = segments
  if (lifecycle === undefined || cls === undefined || base === undefined) return false
  return (AGENT_NOTE_LIFECYCLES as readonly string[]).includes(lifecycle)
    && (AGENT_NOTE_CLASSES as readonly string[]).includes(cls)
    && !base.endsWith('.zh.md')
    && AGENT_NOTE_FILENAME.test(base)
}

/** One Agent Note file, as discovered by the walker. */
export interface AgentNote {
  lifecycle: string
  /** Path relative to .agents/notes. */
  rel: string
  /** `yyyy-mm-dd` from the filename. */
  date: string
}

/**
 * Walk the Agent Note tree, enforcing the structure rules. Returns every valid Agent Note
 * plus one error string per violation (unknown lifecycle or class folder, bad
 * depth, or bad filename). Callers treat a non-empty error list as fatal.
 */
export function walkAgentNoteTree(): { notes: AgentNote[]; errors: string[] } {
  const notes: AgentNote[] = []
  const errors: string[] = []
  // The lifecycle set is closed too: any directory under .agents/notes/ that is not
  // a known lifecycle would otherwise hold Agent Notes invisible to the walk below.
  for (const entry of readdirSync(agentNoteRoot, { withFileTypes: true })) {
    if (entry.name === 'INDEX.md') {
      errors.push('structure: INDEX.md — centralized Agent Note indexes are forbidden; browse the lifecycle/class tree or search the repository')
      continue
    }
    if (entry.isDirectory()
      && entry.name !== AGENT_NOTE_ARCHIVE
      && !(AGENT_NOTE_LIFECYCLES as readonly string[]).includes(entry.name)) {
      errors.push(`structure: ${entry.name}/ — unknown lifecycle folder (allowed: ${AGENT_NOTE_LIFECYCLES.join(', ')}, plus ${AGENT_NOTE_ARCHIVE}/)`)
    }
  }
  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    for (const match of globSync(`${lifecycle}/**/*.md`, { cwd: agentNoteRoot }).map(path => path.split(sep).join('/')).sort()) {
      const segs = match.split('/')
      // Allowlisted file directly at the lifecycle root (e.g. implemented/AGENTS.md).
      if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
      // Agent Notes are English-only; the pairing gate rejects a `.zh.md` here
      // (scripts/translation-counterpart.ts), so this walk does not report it twice.
      if (match.endsWith('.zh.md')) continue
      const cls = segs[1]
      const base = segs[2]
      if (segs.length !== 3 || cls === undefined || base === undefined) {
        errors.push(`structure: ${match} — expected {lifecycle}/{class}/file.md (got depth ${segs.length})`)
        continue
      }
      if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(cls)) {
        errors.push(`structure: ${match} — unknown class folder "${cls}" (allowed: ${AGENT_NOTE_CLASSES.join(', ')})`)
        continue
      }
      if (!AGENT_NOTE_FILENAME.test(base)) {
        errors.push(`structure: ${match} — filename must be yyyy-mm-dd-topic.md`)
        continue
      }
      notes.push({ lifecycle, rel: match, date: base.slice(0, 10) })
    }
  }
  return { notes, errors }
}
