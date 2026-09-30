# 知识库

[English](knowledge.md) | 中文

实验性的知识[能力 seam](../glossary.zh.md#capability-seam)列出、搜索、读取、引用和写入一个比会话存活更久的知识库的页面。其 Service Definition 是 [dsh-experimental-knowledge](../../packages/experimental/knowledge/README.zh.md)（`ctx.knowledge`）。该 seam 是可选的，不属于[智能体循环主干](core.zh.md)。其 Service Provider 是 [dsh-experimental-knowledge-wiki-filesystem](../../packages/experimental/knowledge-wiki-filesystem/README.zh.md)，一个位于会话工作区内、通过 `ctx.fs` 读写的 Markdown wiki。

源码：[`packages/experimental/knowledge/src/types.ts`](../../packages/experimental/knowledge/src/types.ts)

## 页面与边

页面 id 是相对知识库、以 `.md` 结尾的 POSIX 路径。边在每次读取时从已存储的页面推导：正文链接（`wikilink`、`mdlink`）、页面在 frontmatter 中声明的六种关系（`derives-from`、`depends-on`、`implements`、`supports`、`contradicts`、`supersedes`），以及指向页面所提及且存在的工作区代码路径的 `touches` 边。每条边的 id 是 `e:` 加 sha1(`from|to|relation`) 的八位十六进制数字，与 overstack `wiki-graph.py` 相同。当页面声明关系所指向的页面在它之后更新，或它依赖一个已被取代的页面时，该页面过期；过期状态只推导一层关系，从不存储。

## 作用范围

每个服务方法都接收会话工作目录与取消信号，因为知识库根目录在文件系统提供方的执行环境中相对会话工作区解析。

## 写入与出处

`write` 检查每条知识库规则，违反时返回带被违反规则的 `refused`，而不是抛出异常。每次写入都引用页面所依据的成功 `tool/result` 事件；未引用任何事件的写入会被拒绝，本包的不变量伴随插件会拒绝引用不是同一会话成功工具结果的已应用 `knowledge/write`。

## 会话事件

| 事件 | 写入方 | 内容 |
|---|---|---|
| `knowledge/write` | 知识库消费方 | 页面 id、写入者、模式、是否已应用、操作、过期页面、被引用的事件与文件、拒绝原因 |
| `knowledge/inject` | 索引消费方 | 列出的页面 id、字节数、行数、省略与隔离的数量、注入索引的摘要 |

二者都仅记录日志且读取时必需；注入的索引本身是一条普通的 `user/message`。

## 包

| 角色 | 包 |
|---|---|
| Service Definition | [dsh-experimental-knowledge](../../packages/experimental/knowledge/README.zh.md) |
| Service Provider | [dsh-experimental-knowledge-wiki-filesystem](../../packages/experimental/knowledge-wiki-filesystem/README.zh.md) |
| 守卫 | [dsh-experimental-knowledge-rules](../../packages/experimental/knowledge-rules/README.zh.md) |
| 消费方 | [dsh-experimental-tool-knowledge](../../packages/experimental/tool-knowledge/README.zh.md) — `knowledge_query`、`knowledge_read`、`knowledge_cite`、`knowledge_write` |
| 消费方 | [dsh-experimental-context-knowledge](../../packages/experimental/context-knowledge/README.zh.md) — 索引消息与 `knowledge/inject` |
| 消费方 | [dsh-experimental-memory-distill](../../packages/experimental/memory-distill/README.zh.md) — 校验通过的 turn 之后的 episode 页面 |

知识组合包还以关闭状态携带 [dsh-experimental-memory-zeromem](../../packages/experimental/memory-zeromem/README.zh.md)。它不属于这个 seam：它把对话轮次存入 zeromem 存储，并通过自己的 `memory_recall` 工具提供，从不作为知识页面。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledge--knowledgeservice-abstract-seam"></a>

### `ctx.knowledge` — `KnowledgeService` (abstract seam)

Abstract knowledge store. Subclass it and load the subclass as a plugin; it registers as `ctx.knowledge` (one provider per context: loading a second throws). Every provider honors:

- A page whose entry was written with status `archived` is left out of `index`, `query`, and `neighbors`; `read` and `cite` still return it.
- Reads derive edges, staleness, and ranking from the stored pages on every call; nothing derivable is stored.
- `write` returns `refused` for an entry that breaks a store rule, including an empty `citation.sourceEventSeqs`, and throws only on I/O failure.
- `includes` answers whether a workspace path lies inside the store, so a guard can refuse writes that bypass `write`.

```ts cordis-catalog
/**
 * List the readable pages that are not archived, newest first, and the quarantined ones.
 * @param scope - session working directory and cancellation.
 * @returns the store listing.
 */
abstract index(scope: KnowledgeScope): Promise<KnowledgeIndex>

/**
 * Rank pages that are not archived by the query words they contain.
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
 * Pages that are not archived within `depth` links of one page, in either
 * direction; links through an archived page are not followed.
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
