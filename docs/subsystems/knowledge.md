# Knowledge Store

English | [中文](knowledge.zh.md)

The experimental knowledge [capability seam](../glossary.md#capability-seam) lists, searches, reads, cites, and writes the pages of one knowledge store that outlives sessions. Its Service Definition is [dsh-experimental-knowledge](../../packages/experimental/knowledge/README.md) (`ctx.knowledge`). The seam is optional and not part of the [agent-loop spine](core.md). Its Service Provider is [dsh-experimental-knowledge-wiki-filesystem](../../packages/experimental/knowledge-wiki-filesystem/README.md), a Markdown wiki inside the session workspace read and written through `ctx.fs`.

Source: [`packages/experimental/knowledge/src/types.ts`](../../packages/experimental/knowledge/src/types.ts)

## Pages and edges

A page id is a store-relative POSIX path ending in `.md`. Edges are derived from the stored pages on every read: body links (`wikilink`, `mdlink`), the six relations a page declares in frontmatter (`derives-from`, `depends-on`, `implements`, `supports`, `contradicts`, `supersedes`), and `touches` edges to workspace code paths the page names that exist. Each edge id is `e:` plus eight hex digits of sha1(`from|to|relation`), identical to overstack `wiki-graph.py`. A page is stale when a page it declares a relation to was updated after it, or when it depends on a superseded page; staleness is derived one relation deep and never stored.

## Scope

Every service method takes the session working directory and a cancellation signal, because the store root resolves against the session workspace in the filesystem provider's execution world.

## Writes and citations

`write` checks every store rule and returns `refused` with the broken rule instead of throwing. Each write cites the successful `tool/result` events its page is based on; a write citing none is refused, and the package's invariant companion rejects an applied `knowledge/write` whose citations are not successful tool results of the same session.

## Session events

| Event | Written by | Content |
|---|---|---|
| `knowledge/write` | store consumers | page id, writer, mode, whether applied, operation, stale pages, cited events and files, refusal |
| `knowledge/inject` | index consumers | listed page ids, bytes, lines, omitted and quarantined counts, digest of the injected index |

Both are log-only and required-on-read; the injected index itself is an ordinary `user/message`.

## Packages

| Role | Package |
|---|---|
| Service Definition | [dsh-experimental-knowledge](../../packages/experimental/knowledge/README.md) |
| Service Provider | [dsh-experimental-knowledge-wiki-filesystem](../../packages/experimental/knowledge-wiki-filesystem/README.md) |
| Guard | [dsh-experimental-knowledge-rules](../../packages/experimental/knowledge-rules/README.md) |
| Consumer | [dsh-experimental-tool-knowledge](../../packages/experimental/tool-knowledge/README.md) — `knowledge_query`, `knowledge_read`, `knowledge_cite`, `knowledge_write` |
| Consumer | [dsh-experimental-context-knowledge](../../packages/experimental/context-knowledge/README.md) — index message and `knowledge/inject` |
| Consumer | [dsh-experimental-memory-distill](../../packages/experimental/memory-distill/README.md) — episode pages after a verified turn |

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledge--knowledgeservice-abstract-seam"></a>

### `ctx.knowledge` — `KnowledgeService` (abstract seam)

Abstract knowledge store. Subclass it and load the subclass as a plugin; it registers as `ctx.knowledge` (one provider per context: loading a second throws). Every provider honors:

- Reads derive edges, staleness, and ranking from the stored pages on every call; nothing derivable is stored.
- `write` returns `refused` for an entry that breaks a store rule, including an empty `citation.sourceEventSeqs`, and throws only on I/O failure.
- `includes` answers whether a workspace path lies inside the store, so a guard can refuse writes that bypass `write`.

```ts cordis-catalog
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
```

Source: [`packages/experimental/knowledge/src/index.ts`](../../packages/experimental/knowledge/src/index.ts)
<!-- END GENERATED cordis-surface -->
