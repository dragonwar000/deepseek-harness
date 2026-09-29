/**
 * Wiki filesystem provider of the knowledge seam: a directory of Markdown
 * pages with YAML frontmatter inside the session workspace, read and written
 * through `ctx.fs`, so sandboxed and remote filesystem providers carry it.
 * Edges, staleness, and ranking are derived on every call; nothing derivable
 * is stored.
 * @module @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { KnowledgeService, knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type {
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeNeighbors,
  KnowledgePage,
  KnowledgePageId,
  KnowledgeCitation,
  KnowledgeScope,
  KnowledgeWriteResult,
} from '@deepseek-ai/dsh-experimental-knowledge'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { buildGraph, citeEdges, entryOf, indexEntries, neighborLevels, pageOf, staleAfterWrite, stalePages } from './graph.ts'
import type { StoreGraph, StorePage } from './graph.ts'
import { codePathCandidates, parsePage, renderPage } from './page.ts'
import { rankPages } from './rank.ts'
import { checkPageText, reviewWrite } from './rules.ts'
import type { StoreLayout } from './rules.ts'

/** Store location, layout, and limits. Invalid values fail plugin load. */
export interface Config {
  /** Store directory, relative to the session working directory (default `knowledge`). */
  root?: string
  /** Top-level directories that hold pages (default `concepts`, `entities`, `sources`, `architecture`, `tours`, `episodes`). */
  contentDirs?: string[]
  /** Top-level directories only people change; writes into them are refused (default `raw`). */
  readOnlyDirs?: string[]
  /**
   * File extensions of backticked code paths that become `touches` edges when the file exists
   * (default `py`, `js`, `ts`, `sh`, `yaml`, `yml`, `json`, `html`).
   */
  codeExtensions?: string[]
  /** Most pages one read loads before it fails (default 2000). */
  maxPages?: number
}

type ResolvedConfig = Required<Config>

const SEGMENT = /^[A-Za-z0-9_-]+$/
const EXTENSION = /^[A-Za-z0-9]+$/
const SKIPPED = new Set(['README.md', '_template.md'])

/**
 * Filesystem resolution options of one scope.
 * @param scope - session working directory and cancellation.
 * @returns options for `ctx.fs.resolve`.
 */
function resolveOptions(scope: KnowledgeScope): { cwd?: string; signal?: AbortSignal } {
  return {
    ...scope.cwd === undefined ? {} : { cwd: scope.cwd },
    ...scope.signal === undefined ? {} : { signal: scope.signal },
  }
}

/**
 * Fail unless every value is one path segment.
 * @param field - config field name.
 * @param values - configured values.
 * @param pattern - accepted form.
 */
function requireSegments(field: string, values: readonly string[], pattern: RegExp): void {
  for (const value of values) {
    if (!pattern.test(value)) throw new Error(`knowledge-wiki-filesystem: ${field} entry ${JSON.stringify(value)} must be one path segment of letters, digits, _ or -`)
  }
}

/** Knowledge store kept as a Markdown wiki inside the session workspace. */
export class WikiFilesystemKnowledge extends KnowledgeService {
  static inject = ['fs']

  static Config: z<Config> = z.object({
    root: z.string().default('knowledge'),
    contentDirs: z.array(z.string()).default(['concepts', 'entities', 'sources', 'architecture', 'tours', 'episodes']),
    readOnlyDirs: z.array(z.string()).default(['raw']),
    codeExtensions: z.array(z.string()).default(['py', 'js', 'ts', 'sh', 'yaml', 'yml', 'json', 'html']),
    maxPages: z.number().default(2000),
  })

  private readonly root: string
  private readonly layout: StoreLayout
  private readonly extensions: ReadonlySet<string>
  private readonly maxPages: number

  /**
   * Validate the configuration.
   * @param ctx - plugin context providing `ctx.fs`.
   * @param config - schemastery-resolved configuration.
   * @throws when a field is invalid.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    const root = resolved.root.trim().replace(/\/+$/, '')
    if (root === '') throw new Error('knowledge-wiki-filesystem: root must name a directory')
    if (resolved.contentDirs.length === 0) throw new Error('knowledge-wiki-filesystem: contentDirs must name at least one directory')
    requireSegments('contentDirs', resolved.contentDirs, SEGMENT)
    requireSegments('readOnlyDirs', resolved.readOnlyDirs, SEGMENT)
    requireSegments('codeExtensions', resolved.codeExtensions, EXTENSION)
    const shared = resolved.readOnlyDirs.find(dir => resolved.contentDirs.includes(dir))
    if (shared !== undefined) throw new Error(`knowledge-wiki-filesystem: readOnlyDirs and contentDirs share ${shared}`)
    if (!Number.isSafeInteger(resolved.maxPages) || resolved.maxPages < 1) throw new Error('knowledge-wiki-filesystem: maxPages must be a positive integer')
    this.root = root
    this.layout = { contentDirs: new Set(resolved.contentDirs), readOnlyDirs: new Set(resolved.readOnlyDirs) }
    this.extensions = new Set(resolved.codeExtensions)
    this.maxPages = resolved.maxPages
  }

  /**
   * The configured store directory.
   * @returns the root without a trailing slash.
   */
  get storeRoot(): string {
    return this.root
  }

  /**
   * List the readable pages, newest first, and the quarantined ones.
   * @param scope - session working directory and cancellation.
   * @returns the store listing.
   */
  async index(scope: KnowledgeScope): Promise<KnowledgeIndex> {
    const graph = await this.load(scope)
    return { entries: indexEntries(graph), quarantined: [...graph.quarantined] }
  }

  /**
   * Rank pages by the query words they contain.
   * @param scope - session working directory and cancellation.
   * @param text - query text.
   * @param limit - maximum hits.
   * @returns hits, best first.
   */
  async query(scope: KnowledgeScope, text: string, limit: number): Promise<KnowledgeHit[]> {
    return rankPages(await this.load(scope), text, limit)
  }

  /**
   * Read one page.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference.
   * @returns the page, or `undefined`.
   */
  async read(scope: KnowledgeScope, ref: string): Promise<KnowledgePage | undefined> {
    const graph = await this.load(scope)
    const id = graph.resolve(ref)
    if (id === undefined) return undefined
    const page = pageOf(graph, id)
    return { ...entryOf(page, stalePages(graph).has(id)), relations: [...page.front.relations], content: page.content }
  }

  /**
   * Edges of one page, or one edge by id.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference or `e:` edge id.
   * @returns matching edges.
   */
  async cite(scope: KnowledgeScope, ref: string): Promise<KnowledgeEdge[]> {
    return citeEdges(await this.load(scope), ref)
  }

  /**
   * Pages within `depth` links of one page.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference.
   * @param depth - maximum distance.
   * @returns the levels, or `undefined` for an unknown page.
   */
  async neighbors(scope: KnowledgeScope, ref: string, depth: number): Promise<KnowledgeNeighbors | undefined> {
    const graph = await this.load(scope)
    const id = graph.resolve(ref)
    return id === undefined ? undefined : { id, levels: neighborLevels(graph, id, depth) }
  }

  /**
   * Check every rule, then create or replace the page under a version guard.
   * @param scope - session working directory and cancellation.
   * @param entry - page to write; relation targets may be references.
   * @param citation - the session events the page is based on.
   * @returns `written` with newly stale pages, or `refused`.
   */
  async write(scope: KnowledgeScope, entry: KnowledgeEntry, citation: KnowledgeCitation): Promise<KnowledgeWriteResult> {
    const graph = await this.load(scope)
    const resolved: KnowledgeEntry = {
      ...entry,
      relations: entry.relations.map(relation => ({ relation: relation.relation, to: graph.resolve(relation.to) ?? relation.to })),
    }
    const verdict = reviewWrite(resolved, citation, graph, this.layout)
    if (!verdict.ok) return { kind: 'refused', rule: verdict.rule, reason: verdict.reason }
    const content = renderPage(resolved, citation, new Date().toISOString())
    const rendered = checkPageText(content)
    /* v8 ignore next -- reviewWrite accepted every field renderPage writes, so the page parses with citation and an Origin section */
    if (!rendered.ok) return { kind: 'refused', rule: rendered.rule, reason: rendered.reason }
    const target = await this.ctx.fs.resolve(`${this.root}/${resolved.id}`, resolveOptions(scope))
    const existing = await this.ctx.fs.stat(target, scope.signal)
    const intent: FsWriteIntent = existing === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: existing.version }
    const outcome = await this.ctx.fs.writeText(target, content, intent, scope.signal)
    return { kind: 'written', id: resolved.id, operation: outcome.operation, stale: staleAfterWrite(graph, resolved) }
  }

  /**
   * Whether a path lies inside the store.
   * @param scope - session working directory and cancellation.
   * @param path - absolute path or a path relative to `scope.cwd`.
   * @returns true for the root and every path below it.
   */
  async includes(scope: KnowledgeScope, path: string): Promise<boolean> {
    const options = resolveOptions(scope)
    const root = await this.ctx.fs.resolve(this.root, options)
    const target = await this.ctx.fs.resolve(path, options)
    return this.ctx.fs.contains(root, target)
  }

  /**
   * Read every page of the store and build its graph.
   * @param scope - session working directory and cancellation.
   * @returns the snapshot.
   */
  private async load(scope: KnowledgeScope): Promise<StoreGraph> {
    const options = resolveOptions(scope)
    const root = await this.ctx.fs.resolve(this.root, options)
    const info = await this.ctx.fs.stat(root, scope.signal)
    const files: { id: KnowledgePageId; target: FsTarget }[] = []
    if (info !== undefined) {
      if (info.type !== 'directory') throw new Error(`knowledge-wiki-filesystem: ${root.displayPath} is not a directory`)
      for (const entry of await this.ctx.fs.listDir(root, scope.signal)) {
        if (entry.type === 'directory' && this.layout.contentDirs.has(entry.name)) await this.walk(entry.target, entry.name, files, root, scope.signal)
      }
    }
    const pages: StorePage[] = []
    const quarantined: KnowledgePageId[] = []
    for (const file of files) {
      const content = await this.ctx.fs.readText(file.target, scope.signal)
      const parsed = parsePage(content)
      if (parsed.kind === 'quarantined') quarantined.push(file.id)
      else pages.push({ id: file.id, front: parsed.front, body: parsed.body, content })
    }
    return buildGraph({ pages, quarantined, existingCode: await this.existingCode(pages, scope), extensions: this.extensions })
  }

  /**
   * Collect `.md` pages below one content directory.
   * @param dir - directory target.
   * @param prefix - store-relative path of `dir`.
   * @param files - accumulator.
   * @param root - store root, for the limit error.
   * @param signal - cancellation.
   */
  private async walk(
    dir: FsTarget,
    prefix: string,
    files: { id: KnowledgePageId; target: FsTarget }[],
    root: FsTarget,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const entry of await this.ctx.fs.listDir(dir, signal)) {
      const path = `${prefix}/${entry.name}`
      if (entry.type === 'directory') {
        await this.walk(entry.target, path, files, root, signal)
        continue
      }
      if (entry.type !== 'file' || !entry.name.endsWith('.md') || SKIPPED.has(entry.name)) continue
      files.push({ id: knowledgePageId(path), target: entry.target })
      if (files.length > this.maxPages) {
        throw new Error(`knowledge-wiki-filesystem: ${root.displayPath} holds more than maxPages (${this.maxPages}) pages; raise maxPages or split the store`)
      }
    }
  }

  /**
   * Candidate code paths of every page that exist as files.
   * @param pages - readable pages.
   * @param scope - session working directory and cancellation.
   * @returns the existing paths.
   */
  private async existingCode(pages: readonly StorePage[], scope: KnowledgeScope): Promise<Set<string>> {
    const options = resolveOptions(scope)
    const existing = new Set<string>()
    for (const path of new Set(pages.flatMap(page => codePathCandidates(page.body, this.extensions)))) {
      const info = await this.ctx.fs.stat(await this.ctx.fs.resolve(path, options), scope.signal)
      if (info?.type === 'file') existing.add(path)
    }
    return existing
  }
}

export default WikiFilesystemKnowledge
