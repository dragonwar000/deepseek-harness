/**
 * The knowledge graph of one store snapshot, rebuilt on every read (port of
 * overstack `wiki-graph.py` `build_graph`, `resolve_page`, `cmd_neighbors`, and
 * `cmd_cite`): body links, declared relations, and `touches` edges to code
 * paths that exist, with stable edge ids. Staleness is derived one relation
 * deep and never stored.
 * @module @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem/graph
 */

import { posix } from 'node:path'
import { edgeId, isDeclaredRelation, knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type {
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeIndexEntry,
  KnowledgeNodeKind,
  KnowledgePageId,
  KnowledgeRelation,
} from '@deepseek-ai/dsh-experimental-knowledge'
import { codePathCandidates, mdlinkTargets, wikilinkTargets } from './page.ts'
import type { PageFront } from './page.ts'

/** One readable page of the store. */
export interface StorePage {
  /** Page id. */
  readonly id: KnowledgePageId
  /** Parsed frontmatter. */
  readonly front: PageFront
  /** Text after the frontmatter block. */
  readonly body: string
  /** Full file text. */
  readonly content: string
}

/** One store snapshot with its derived edges. */
export interface StoreGraph {
  /** Readable pages by id. */
  readonly pages: ReadonlyMap<KnowledgePageId, StorePage>
  /** Pages left out for unreadable frontmatter, sorted. */
  readonly quarantined: readonly KnowledgePageId[]
  /** Derived edges in page order. */
  readonly edges: readonly KnowledgeEdge[]
  /** Wikilinks whose target resolves to no page. */
  readonly broken: readonly { readonly from: KnowledgePageId; readonly target: string }[]
  /**
   * Resolve a page reference: exact id, id without `.md`, or a file name unique in the store.
   * @param ref - page reference.
   * @returns the page id, or `undefined` for no page or an ambiguous file name.
   */
  readonly resolve: (ref: string) => KnowledgePageId | undefined
}

/** Inputs of {@link buildGraph}. */
export interface GraphInput {
  /** Readable pages. */
  readonly pages: readonly StorePage[]
  /** Quarantined page ids. */
  readonly quarantined: readonly KnowledgePageId[]
  /** Candidate code paths that exist in the workspace. */
  readonly existingCode: ReadonlySet<string>
  /** Accepted code file extensions without the dot. */
  readonly extensions: ReadonlySet<string>
}

/**
 * Order distinct strings.
 * @param left - one string.
 * @param right - a different string.
 * @returns -1 when `left` sorts first, else 1.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : 1
}

/**
 * Look up a key the graph itself produced.
 * @param value - the lookup result.
 * @param what - what was looked up, for the error.
 * @returns the value.
 */
function must<T>(value: T | undefined, what: string): T {
  /* v8 ignore next -- callers only look up ids the same graph produced */
  if (value === undefined) throw new Error(`knowledge graph: missing ${what}`)
  return value
}

/**
 * File name of a page id without `.md`.
 * @param id - page id or path.
 * @returns the stem.
 */
export function stemOf(id: string): string {
  const base = posix.basename(id)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/**
 * The resolver of one page set.
 * @param pages - readable pages.
 * @returns a function resolving a reference to a page id.
 */
function pageResolver(pages: ReadonlyMap<KnowledgePageId, StorePage>): (ref: string) => KnowledgePageId | undefined {
  const byStem = new Map<string, KnowledgePageId[]>()
  for (const id of pages.keys()) byStem.set(stemOf(id), [...byStem.get(stemOf(id)) ?? [], id])
  return (ref) => {
    const clean = ref.trim().replace(/^\.\//, '')
    const id = knowledgePageId(clean.endsWith('.md') ? clean : `${clean}.md`)
    if (pages.has(id)) return id
    const matches = byStem.get(stemOf(id)) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }
}

/**
 * Build the graph of one store snapshot.
 * @param input - pages, quarantine list, existing code paths, extensions.
 * @returns the snapshot with its edges.
 */
export function buildGraph(input: GraphInput): StoreGraph {
  const pages = new Map(input.pages.map(page => [page.id, page] as const))
  const resolve = pageResolver(pages)
  const edges: KnowledgeEdge[] = []
  const broken: { from: KnowledgePageId; target: string }[] = []
  for (const page of [...pages.values()].sort((left, right) => compareText(left.id, right.id))) {
    const seen = new Set<string>()
    const add = (to: string, toKind: KnowledgeNodeKind, relation: KnowledgeRelation): void => {
      const key = `${to}|${relation}`
      if (to === page.id || seen.has(key)) return
      seen.add(key)
      edges.push({ eid: edgeId(page.id, to, relation), from: page.id, to, toKind, relation })
    }
    for (const name of wikilinkTargets(page.body)) {
      const target = resolve(name)
      if (target === undefined) broken.push({ from: page.id, target: name })
      else add(target, 'page', 'wikilink')
    }
    for (const link of mdlinkTargets(page.body)) {
      const target = knowledgePageId(posix.normalize(posix.join(posix.dirname(page.id), link)))
      if (pages.has(target)) add(target, 'page', 'mdlink')
    }
    for (const relation of page.front.relations) {
      const target = resolve(relation.to)
      if (target !== undefined) add(target, 'page', relation.relation)
    }
    for (const path of codePathCandidates(page.body, input.extensions)) {
      if (input.existingCode.has(path)) add(path, 'code', 'touches')
    }
  }
  return { pages, quarantined: [...input.quarantined].sort(compareText), edges, broken, resolve }
}

/**
 * One readable page by an id the graph resolved.
 * @param graph - store snapshot.
 * @param id - page id from `graph.resolve` or `graph.pages`.
 * @returns the page.
 */
export function pageOf(graph: StoreGraph, id: KnowledgePageId): StorePage {
  return must(graph.pages.get(id), id)
}

/**
 * Pages that are stale: a page they declare a relation to was updated after
 * them, or they depend on a page another page supersedes. One relation deep.
 * @param graph - store snapshot.
 * @returns the stale page ids in edge order.
 */
export function stalePages(graph: StoreGraph): ReadonlySet<KnowledgePageId> {
  const superseded = new Set(graph.edges.filter(edge => edge.relation === 'supersedes').map(edge => edge.to))
  const stale = new Set<KnowledgePageId>()
  for (const edge of graph.edges) {
    if (!isDeclaredRelation(edge.relation)) continue
    if (edge.relation === 'depends-on' && superseded.has(edge.to)) {
      stale.add(edge.from)
      continue
    }
    const from = pageOf(graph, edge.from).front.updated
    const to = pageOf(graph, knowledgePageId(edge.to)).front.updated
    if (from !== undefined && to !== undefined && Date.parse(to) > Date.parse(from)) stale.add(edge.from)
  }
  return stale
}

/**
 * Pages a write makes stale: pages declaring a relation to the written page,
 * and dependents of every page the entry supersedes.
 * @param graph - store snapshot before the write.
 * @param entry - the page being written.
 * @returns sorted page ids, without the written page.
 */
export function staleAfterWrite(graph: StoreGraph, entry: KnowledgeEntry): KnowledgePageId[] {
  const stale = new Set<KnowledgePageId>()
  const superseded = new Set<string>(entry.relations.filter(relation => relation.relation === 'supersedes').map(relation => relation.to))
  for (const edge of graph.edges) {
    if (edge.from === entry.id || !isDeclaredRelation(edge.relation)) continue
    if (edge.to === entry.id) stale.add(edge.from)
    if (edge.relation === 'depends-on' && superseded.has(edge.to)) stale.add(edge.from)
  }
  return [...stale].sort(compareText)
}

/**
 * The index entry of one page.
 * @param page - readable page.
 * @param stale - whether the page is stale.
 * @returns the entry.
 */
export function entryOf(page: StorePage, stale: boolean): KnowledgeIndexEntry {
  return {
    id: page.id,
    title: page.front.title ?? stemOf(page.id),
    type: page.front.type,
    ...page.front.updated === undefined ? {} : { updated: page.front.updated },
    stale,
  }
}

/**
 * Index entries, newest first, then by id; pages without `updated` last.
 * @param graph - store snapshot.
 * @returns the entries.
 */
export function indexEntries(graph: StoreGraph): KnowledgeIndexEntry[] {
  const stale = stalePages(graph)
  return [...graph.pages.values()]
    .map(page => entryOf(page, stale.has(page.id)))
    .sort((left, right) => {
      const a = left.updated ?? ''
      const b = right.updated ?? ''
      return a === b ? compareText(left.id, right.id) : compareText(b, a)
    })
}

/**
 * Pages within `depth` links of one page over page-to-page edges in either direction.
 * @param graph - store snapshot.
 * @param id - start page.
 * @param depth - maximum distance.
 * @returns sorted pages per distance, nearest first, without empty levels.
 */
export function neighborLevels(graph: StoreGraph, id: KnowledgePageId, depth: number): KnowledgePageId[][] {
  const adjacent = new Map<KnowledgePageId, Set<KnowledgePageId>>()
  const link = (from: KnowledgePageId, to: KnowledgePageId): void => {
    const set = adjacent.get(from) ?? new Set<KnowledgePageId>()
    set.add(to)
    adjacent.set(from, set)
  }
  for (const edge of graph.edges) {
    if (edge.toKind !== 'page') continue
    link(edge.from, knowledgePageId(edge.to))
    link(knowledgePageId(edge.to), edge.from)
  }
  const levels: KnowledgePageId[][] = []
  const seen = new Set<KnowledgePageId>([id])
  let frontier: KnowledgePageId[] = [id]
  for (let distance = 1; distance <= depth && frontier.length > 0; distance += 1) {
    const next: KnowledgePageId[] = []
    for (const node of frontier) {
      for (const neighbor of adjacent.get(node) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        next.push(neighbor)
      }
    }
    if (next.length > 0) levels.push(next.sort(compareText))
    frontier = next
  }
  return levels
}

/**
 * Edges of one page, or the one edge with an edge id.
 * @param graph - store snapshot.
 * @param ref - page reference or `e:` edge id.
 * @returns matching edges.
 */
export function citeEdges(graph: StoreGraph, ref: string): KnowledgeEdge[] {
  if (ref.startsWith('e:')) return graph.edges.filter(edge => edge.eid === ref)
  const id = graph.resolve(ref)
  if (id === undefined) return []
  return graph.edges.filter(edge => edge.from === id || edge.to === id)
}
