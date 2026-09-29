/**
 * Vocabulary of the knowledge capability seam: page and edge identity, the
 * relation set, request and result types of `KnowledgeService`, and the two
 * log-only session events knowledge consumers write.
 * @module @deepseek-ai/dsh-experimental-knowledge/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Store-relative page id: a POSIX path ending in `.md`, for example `concepts/retry.md`. */
export type KnowledgePageId = Branded<'KnowledgePageId'>

/** Stable edge id: `e:` and the first eight hex digits of sha1(`from|to|relation`). */
export type KnowledgeEdgeId = Branded<'KnowledgeEdgeId'>

/** Relations a page declares in its frontmatter `relations` list. */
export type KnowledgeDeclaredRelation =
  | 'derives-from'
  | 'depends-on'
  | 'implements'
  | 'supports'
  | 'contradicts'
  | 'supersedes'

/**
 * Every edge relation. Declared relations come from frontmatter, `wikilink`
 * and `mdlink` from links in the page body, and `touches` from workspace code
 * paths the page names that exist. Only declared relations are ever written.
 */
export type KnowledgeRelation = KnowledgeDeclaredRelation | 'wikilink' | 'mdlink' | 'touches'

/** What an edge target names: a store page or a workspace code path. */
export type KnowledgeNodeKind = 'page' | 'code'

/** One edge of the knowledge graph, derived from the store on every read. */
export interface KnowledgeEdge {
  /** Stable id of this edge. */
  eid: KnowledgeEdgeId
  /** Page the edge starts at. */
  from: KnowledgePageId
  /** Target page id, or the workspace code path of a `touches` edge. */
  to: string
  /** Whether `to` names a page or a code path. */
  toKind: KnowledgeNodeKind
  /** Edge relation. */
  relation: KnowledgeRelation
}

/** One relation a page declares. */
export interface KnowledgeRelationDeclaration {
  /** Declared relation. */
  relation: KnowledgeDeclaredRelation
  /** Target page. */
  to: KnowledgePageId
}

/** Where one request runs. */
export interface KnowledgeScope {
  /** Session working directory the store root and code paths resolve against; absent uses the filesystem provider's default. */
  readonly cwd?: string | undefined
  /** Cancels provider I/O. */
  readonly signal?: AbortSignal | undefined
}

/** One page as the index lists it. */
export interface KnowledgeIndexEntry {
  /** Page id. */
  id: KnowledgePageId
  /** Frontmatter title, or the file name without `.md`. */
  title: string
  /** Frontmatter type. */
  type: string
  /** ISO time of the last provider write, when the page records one. */
  updated?: string
  /** True when a page this page depends on changed after it or was superseded. */
  stale: boolean
}

/** Listing of the store. */
export interface KnowledgeIndex {
  /** Readable pages, newest first. */
  entries: KnowledgeIndexEntry[]
  /** Pages left out because their frontmatter does not parse or has no `type`. */
  quarantined: KnowledgePageId[]
}

/** One ranked query result. */
export interface KnowledgeHit extends KnowledgeIndexEntry {
  /** Fraction of query words the page contains, rounded to three decimals. */
  score: number
}

/** One page with its content. */
export interface KnowledgePage extends KnowledgeIndexEntry {
  /** Relations the page declares. */
  relations: KnowledgeRelationDeclaration[]
  /** The full Markdown file text, frontmatter included. */
  content: string
}

/** Pages within a link distance of one page. */
export interface KnowledgeNeighbors {
  /** Page the distances are measured from. */
  id: KnowledgePageId
  /** `levels[0]` holds the pages one link away, `levels[1]` two links away, and so on. */
  levels: KnowledgePageId[][]
}

/** One page to create or replace. */
export interface KnowledgeEntry {
  /** Page id. */
  id: KnowledgePageId
  /** Frontmatter type, one word such as `concept` or `episode`. */
  type: string
  /** One-line title. */
  title: string
  /** Markdown body; the provider adds frontmatter, the title heading, and the Origin section. */
  body: string
  /** Relations to existing pages. */
  relations: readonly KnowledgeRelationDeclaration[]
}

/** Who asked for a write. */
export type KnowledgeWriter = 'tool' | 'distill'

/** The session events one write is based on. */
export interface KnowledgeCitation {
  /** Session whose events are cited. */
  sessionId: SessionId
  /** Successful `tool/result` events of that session; a write without one is refused. */
  sourceEventSeqs: readonly SessionSeq[]
  /** Workspace files those events read or changed. */
  sources: readonly string[]
  /** Who asked for the write. */
  writer: KnowledgeWriter
}

/** Store rule a refused write broke. */
export type KnowledgeRule =
  | 'layout'
  | 'read-only-dir'
  | 'frontmatter'
  | 'origin'
  | 'citation'
  | 'dangling-relation'
  | 'superseded-dependency'

/** Outcome of one write. */
export type KnowledgeWriteResult =
  | {
    kind: 'written'
    /** Written page. */
    id: KnowledgePageId
    /** Whether the page was created or replaced. */
    operation: 'create' | 'update'
    /** Pages that became stale because of this write. */
    stale: KnowledgePageId[]
  }
  | {
    kind: 'refused'
    /** Broken rule. */
    rule: KnowledgeRule
    /** Model-facing reason naming the fix. */
    reason: string
  }

/** One `knowledge/write` record. */
export interface KnowledgeWriteRecord {
  /** Page the write targeted. */
  id: KnowledgePageId
  /** Who asked for the write. */
  writer: KnowledgeWriter
  /** Writer mode; tool writes are always `enforce`. */
  mode: 'shadow' | 'enforce'
  /** True iff the page was written. */
  applied: boolean
  /** Present iff `applied`. */
  operation?: 'create' | 'update'
  /** Pages that became stale because of this write. */
  stale: KnowledgePageId[]
  /** Successful `tool/result` events the page is based on. */
  sourceEventSeqs: SessionSeq[]
  /** Workspace files those events read or changed. */
  sources: string[]
  /** Present when the store refused the write. */
  refusal?: { rule: KnowledgeRule; reason: string }
}

/** One `knowledge/inject` record. */
export interface KnowledgeInjectRecord {
  /** Pages the injected index lists. */
  ids: KnowledgePageId[]
  /** UTF-8 bytes of the injected index text. */
  bytes: number
  /** Lines of the injected index text. */
  lines: number
  /** Readable pages the line and byte caps left out. */
  omitted: number
  /** Quarantined pages, mentioned only by count. */
  quarantined: number
  /** sha256 hex of the injected index text. */
  digest: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One attempted write to the knowledge store. Log-only; never derived history. */
    'knowledge/write': KnowledgeWriteRecord
    /** One knowledge index injection; the index text is the `user/message` that follows. Log-only; never derived history. */
    'knowledge/inject': KnowledgeInjectRecord
  }
}
