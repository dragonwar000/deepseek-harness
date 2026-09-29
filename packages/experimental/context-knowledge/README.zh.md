---
description: "实验性知识 seam 的知识索引上下文：在知识库索引发生变化的 turn 的第一步，加入一条有上限的 snapshot 消息，列出页面 id、标题、类型、更新日期与过期标记，从不包含页面内容，面向让模型知道有哪些项目知识的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-knowledge

[English](README.md) | 中文

## 概述

本包把 `ctx.knowledge` 知识库的索引加入模型请求。在 turn 的第一步，当索引与本会话上次收到的索引不同时，它追加一条 `knowledge/inject` 记录，并加入一条 snapshot 形式的 user 消息，列出页面 id、标题、类型、更新日期与过期标记，从不包含页面内容。该消息不超过 `maxLines` 行与 `maxBytes` 字节。本包是实验性的，不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem` 等知识库提供方与会话投影服务之后挂载本插件。同时挂载 `@deepseek-ai/dsh-experimental-tool-knowledge`，让模型能读取索引列出的页面。

### 何时选择

当模型无需先搜索就应知道工作区知识库保存了哪些持久项目知识时，选择它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-context-knowledge'
  config:
    maxLines: 200
    maxBytes: 25600
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxLines` | `200` | 索引消息的最多行数，含标题行与尾注；至少 3 |
| `maxBytes` | `25600` | 索引消息的最多 UTF-8 字节数；至少 1024 |

当某个上限不是整数或低于其最小值时，加载以 `context-knowledge:` 错误失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一个以 `prepend: true` 注册的 `agent/pre-step` 监听器先调用 `next()`；对被拒绝的 step、第一步之后的 step、空知识库或未变化的索引，它原样返回下游决定。否则它用会话工作目录读取 `ctx.knowledge.index`，渲染索引，追加 `knowledge/inject`（含列出的 id、准确的字节数与行数、被省略与被隔离的页面数，以及文本的 sha256 摘要），并把文本作为 `knowledge-context` user 消息加在该 step 的其他消息之后。

### 设计说明

- **索引，而非内容。** 每行列出一个页面；页面文本只通过 `@deepseek-ai/dsh-experimental-tool-knowledge` 的 `knowledge_read` 到达模型，知识组合包会把它与本插件一起挂载。
- **仅在变化时。** `knowledgeContext` 投影折叠本会话最后一条 `knowledge/inject` 的摘要；知识库未变化的 turn 不增加 token。
- **日期，而非时长。** 每行给出页面最后写入的日期而不是时长，因此未变化的知识库每天渲染出相同的文本，由模型自己计算时长。
- **上限内最新优先。** 页面按最新优先列出；达到上限时最旧的页面被省略，并由一条尾注计数。frontmatter 无法读取的页面在第二条尾注中计数。
- **`./invariant` 伴随插件。** 伴随插件检查每条 `knowledge-context` 消息都跟在同一 turn 的一条 `knowledge/inject` 之后，且其 `bytes` 等于消息文本的 UTF-8 长度；并检查一个 turn 同时最多只有一条未送达的 inject。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、`knowledgeContext` 投影与 pre-step 监听器 |
| [`src/render.ts`](src/render.ts) | 在行数与字节上限内渲染索引 |
| [`src/invariant.ts`](src/invariant.ts) | inject 记录与索引消息的一致性 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 seam](../knowledge/README.zh.md) — `ctx.knowledge` 与 `knowledge/inject` 事件。
- [知识工具](../tool-knowledge/README.zh.md) — 读取索引所列页面的工具。
- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — 角色与事件。

-----

<a id="model-experience"></a>
## 模型体验

### 知识索引消息

#### 模型看到什么

在知识库索引发生变化的 turn 的第一步，模型会在该 step 的其他消息之后收到一条 snapshot 形式的 user 消息。其第一行是下面的标题行，其中 `N` 是可读页面数。之后每行的形式为 `- <page id> — <title> [<type>] updated <YYYY-MM-DD>, stale`：页面记录了日期时才有日期，过期页面才有 `, stale`，标题截断为 120 个字符。其后最多有两条尾注。

##### 该字段的原文

```markdown
Knowledge index of the workspace knowledge store, newest first (readable pages: N). It lists pages, not their content: read a page with knowledge_read before relying on it, and verify statements about code against the current files before asserting them. A page marked stale depends on a page that changed after it or was superseded.
Pages not listed here: N; search them with knowledge_query.
Pages left out for unreadable frontmatter: N.
```

#### Token 影响

标题行约 70 个 token，每个列出的页面约 15 到 25 个 token，最多 `maxBytes` 字节（默认 25,600 字节约为 6,000 到 7,000 个 token）。当知识库没有页面，或索引自本会话上一条索引消息以来没有变化时为零。

#### KV Cache 影响

仅追加：消息加在可复用前缀之后并保留在历史中；系统提示不变。只有索引变化时才会加入新消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **turn 内的知识库变化** — turn 中写入的页面在下一个 turn 才出现在索引中。
- **每个 turn 都读取** — 每个 turn 的第一步都读取整个知识库来计算摘要，受提供方 `maxPages` 限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
