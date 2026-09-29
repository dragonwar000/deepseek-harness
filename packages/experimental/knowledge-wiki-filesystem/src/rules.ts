/**
 * Store rules every provider write passes (port of overstack R1
 * `no_write_raw.py` and R14 `patterns_guard.py` as read-only directories, R5
 * `folder_structure.py` as content directories, R9 `okf_frontmatter.py`, R2
 * `origin_required.py`, and R-rel-1/R-rel-3 of `rel_integrity.py`), plus the
 * citation rule. Pure functions.
 * @module @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem/rules
 */

import type { KnowledgeEntry, KnowledgeCitation, KnowledgeRule } from '@deepseek-ai/dsh-experimental-knowledge'
import type { StoreGraph } from './graph.ts'
import { parsePage } from './page.ts'

/** Where pages may be written. */
export interface StoreLayout {
  /** Top-level directories that hold pages. */
  readonly contentDirs: ReadonlySet<string>
  /** Top-level directories only people change. */
  readonly readOnlyDirs: ReadonlySet<string>
}

/** Outcome of one rule check. */
export type RuleVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: KnowledgeRule; readonly reason: string }

const PAGE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/
const TYPE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/
const RESERVED = new Set(['README.md', '_template.md'])
const PASS: RuleVerdict = { ok: true }

/**
 * A refusal.
 * @param rule - broken rule.
 * @param reason - sentence naming the fix.
 * @returns the verdict.
 */
function refuse(rule: KnowledgeRule, reason: string): RuleVerdict {
  return { ok: false, rule, reason }
}

/**
 * R1/R14 read-only directories and R5 content directories.
 * @param id - store-relative page path.
 * @param layout - content and read-only directories.
 * @returns the verdict.
 */
export function checkLayout(id: string, layout: StoreLayout): RuleVerdict {
  const top = id.split('/', 1).join('')
  if (layout.readOnlyDirs.has(top)) return refuse('read-only-dir', `${top}/ is read-only in the knowledge store; only people change it.`)
  const dirs = [...layout.contentDirs].join(', ')
  if (!PAGE_PATH.test(id)) return refuse('layout', `Page id ${JSON.stringify(id)} must be a relative path ending in .md inside one of: ${dirs}.`)
  if (!layout.contentDirs.has(top)) return refuse('layout', `${top}/ is not a content directory; use one of: ${dirs}.`)
  if (RESERVED.has(id.slice(id.lastIndexOf('/') + 1))) return refuse('layout', `${id} uses a reserved file name; choose another page name.`)
  return PASS
}

/**
 * R9 frontmatter fields the entry supplies.
 * @param entry - page to write.
 * @returns the verdict.
 */
export function checkEntry(entry: KnowledgeEntry): RuleVerdict {
  if (!TYPE_WORD.test(entry.type)) return refuse('frontmatter', `type ${JSON.stringify(entry.type)} must be one word such as concept, entity, source, or episode.`)
  if (entry.title.trim() === '') return refuse('frontmatter', 'title must not be blank.')
  return PASS
}

/**
 * The citation rule: a page cites at least one event and one file.
 * @param citation - cited events and files.
 * @returns the verdict.
 */
export function checkCitation(citation: KnowledgeCitation): RuleVerdict {
  if (citation.sourceEventSeqs.length === 0 || citation.sources.length === 0) {
    return refuse('citation', 'A page must cite at least one successful tool result and the workspace files it read or changed.')
  }
  return PASS
}

/**
 * R-rel-1 dangling targets and R-rel-3 new dependencies on superseded pages.
 * @param entry - page to write, relation targets already resolved to ids.
 * @param graph - store snapshot before the write.
 * @returns the verdict.
 */
export function checkRelations(entry: KnowledgeEntry, graph: StoreGraph): RuleVerdict {
  const superseded = new Set<string>(graph.edges.filter(edge => edge.relation === 'supersedes' && edge.from !== entry.id).map(edge => edge.to))
  for (const relation of entry.relations) {
    if (relation.to === entry.id) return refuse('dangling-relation', `${entry.id} cannot declare a relation to itself.`)
    if (!graph.pages.has(relation.to)) {
      return refuse('dangling-relation', `${relation.relation} target ${relation.to} is not a readable page in the store; write that page first or drop the relation.`)
    }
    if (relation.relation === 'depends-on' && superseded.has(relation.to)) {
      return refuse('superseded-dependency', `${relation.to} is superseded; depend on the page that supersedes it.`)
    }
  }
  return PASS
}

/**
 * R9 parseable frontmatter with a type, recorded citation, and R2 Origin section.
 * @param content - full page text.
 * @returns the verdict.
 */
export function checkPageText(content: string): RuleVerdict {
  const page = parsePage(content)
  if (page.kind === 'quarantined') return refuse('frontmatter', page.reason)
  if (page.front.citation === undefined) return refuse('citation', 'The frontmatter has no citation with a session, source event seqs, sources, and writer.')
  if (!page.origin) return refuse('origin', 'The page has no "## Origin" section.')
  return PASS
}

/**
 * Every entry rule in order: layout, entry fields, citation, relations.
 * @param entry - page to write, relation targets already resolved.
 * @param citation - cited events and files.
 * @param graph - store snapshot before the write.
 * @param layout - content and read-only directories.
 * @returns the first refusal, or pass.
 */
export function reviewWrite(entry: KnowledgeEntry, citation: KnowledgeCitation, graph: StoreGraph, layout: StoreLayout): RuleVerdict {
  for (const verdict of [checkLayout(entry.id, layout), checkEntry(entry), checkCitation(citation)]) {
    if (!verdict.ok) return verdict
  }
  return checkRelations(entry, graph)
}
