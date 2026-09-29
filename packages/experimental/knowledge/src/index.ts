/**
 * Service Definition of the knowledge capability seam (`ctx.knowledge`): an
 * abstract service that lists, searches, reads, cites, and writes the pages of
 * one knowledge store without saying where the store lives. Providers subclass
 * {@link KnowledgeService}; consumers inject `knowledge`.
 * @module @deepseek-ai/dsh-experimental-knowledge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeNeighbors,
  KnowledgePage,
  KnowledgeCitation,
  KnowledgeScope,
  KnowledgeWriteResult,
} from './types.ts'

export { DECLARED_RELATIONS, edgeId, isDeclaredRelation, knowledgePageId } from './edge.ts'
export { foldToolPath, pathArgument } from './tool-path.ts'
export type { PendingToolPaths, ToolPathFold } from './tool-path.ts'
export type {
  KnowledgeDeclaredRelation,
  KnowledgeEdge,
  KnowledgeEdgeId,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeIndex,
  KnowledgeIndexEntry,
  KnowledgeInjectRecord,
  KnowledgeNeighbors,
  KnowledgeNodeKind,
  KnowledgePage,
  KnowledgePageId,
  KnowledgeCitation,
  KnowledgeRelation,
  KnowledgeRelationDeclaration,
  KnowledgeRule,
  KnowledgeScope,
  KnowledgeWriteRecord,
  KnowledgeWriter,
  KnowledgeWriteResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: KnowledgeService
  }
}

/**
 * Abstract knowledge store. Subclass it and load the subclass as a plugin; it
 * registers as `ctx.knowledge` (one provider per context: loading a second
 * throws). Every provider honors:
 * - Reads derive edges, staleness, and ranking from the stored pages on every
 *   call; nothing derivable is stored.
 * - `write` returns `refused` for an entry that breaks a store rule, including
 *   an empty `citation.sourceEventSeqs`, and throws only on I/O failure.
 * - `includes` answers whether a workspace path lies inside the store, so a
 *   guard can refuse writes that bypass `write`.
 */
export abstract class KnowledgeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  /**
   * The store location as configured, relative to the session working directory.
   * @returns the configured root path, or `undefined` when the store is not a workspace directory.
   */
  abstract get storeRoot(): string | undefined

  /**
   * List the readable pages, newest first, and the quarantined ones.
   * @param scope - session working directory and cancellation.
   * @returns the store listing.
   */
  abstract index(scope: KnowledgeScope): Promise<KnowledgeIndex>

  /**
   * Rank pages by the query words they contain.
   * @param scope - session working directory and cancellation.
   * @param text - query text.
   * @param limit - maximum hits.
   * @returns hits with a score above zero, best first.
   */
  abstract query(scope: KnowledgeScope, text: string, limit: number): Promise<KnowledgeHit[]>

  /**
   * Read one page by id, id without `.md`, or a file name unique in the store.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference.
   * @returns the page, or `undefined` when the reference names no readable page.
   */
  abstract read(scope: KnowledgeScope, ref: string): Promise<KnowledgePage | undefined>

  /**
   * Edges that start or end at one page, or the one edge with an edge id.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference or `e:` edge id.
   * @returns matching edges; empty when the reference matches nothing.
   */
  abstract cite(scope: KnowledgeScope, ref: string): Promise<KnowledgeEdge[]>

  /**
   * Pages within `depth` links of one page, in either direction.
   * @param scope - session working directory and cancellation.
   * @param ref - page reference.
   * @param depth - maximum link distance, at least 1.
   * @returns the pages by distance, or `undefined` when the reference names no readable page.
   */
  abstract neighbors(scope: KnowledgeScope, ref: string, depth: number): Promise<KnowledgeNeighbors | undefined>

  /**
   * Create or replace one page after checking every store rule.
   * @param scope - session working directory and cancellation.
   * @param entry - page to write.
   * @param citation - the session events the page is based on.
   * @returns `written` with the pages that became stale, or `refused` with the broken rule.
   */
  abstract write(scope: KnowledgeScope, entry: KnowledgeEntry, citation: KnowledgeCitation): Promise<KnowledgeWriteResult>

  /**
   * Whether a workspace path lies inside the store.
   * @param scope - session working directory and cancellation.
   * @param path - absolute path, or a path relative to `scope.cwd`.
   * @returns true for the store root and every path below it.
   */
  abstract includes(scope: KnowledgeScope, path: string): Promise<boolean>
}

export default KnowledgeService
