---
description: "实验性知识 seam 面向模型的工具：knowledge_query、knowledge_read、knowledge_cite，以及需审批、页面引用本会话成功读取的 knowledge_write，面向让模型读取并记录持久项目知识的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-knowledge

[English](README.md) | 中文

## 概述

本包注册 `ctx.knowledge` 面向模型的工具。在默认的 `read-only` 模式下，它注册 `knowledge_query`、`knowledge_read` 与 `knowledge_cite`；`read-write` 另加 `knowledge_write`。每次 `knowledge_write` 都会询问用户，只接受在同一会话中被证据工具成功读取过的来源，把这些读取作为页面的出处引用，并为每次到达知识库的尝试追加一条 `knowledge/write` 记录，包括被知识库拒绝的尝试。本包是实验性的，不承诺稳定性。

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

在 `@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem` 等知识库提供方、`ctx.fs` 提供方与会话投影服务之后挂载本插件。在 `read-write` 模式下同时挂载 `@deepseek-ai/dsh-experimental-knowledge-rules`，使文件与 shell 工具无法直接修改页面；并挂载审批提供方，否则每次 `knowledge_write` 都会被拒绝。

### 何时选择

当模型需要查阅之前的会话与人记录的项目知识，并在 `read-write` 模式下记录它通过读取工作区文件核实过的持久事实时，选择它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-tool-knowledge'
  config:
    mode: read-write
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `read-only` | `read-only` 注册三个读取工具；`read-write` 另加 `knowledge_write` |
| `evidenceTools` | `read` | 成功调用即算作读取其 `file_path` 或 `path` 参数的工具 |
| `maxResults` | `10` | 一次 `knowledge_query` 最多返回的命中数 |
| `maxPageChars` | `20000` | 一次 `knowledge_read` 返回的页面文本字符数 |
| `maxDepth` | `2` | `knowledge_cite` 的最大 `depth` |

当 `evidenceTools` 为空或含空白项，或计数字段不是正整数时，加载会以 `tool-knowledge:` 错误失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`knowledge_write` 为每个来源查找证据工具最新一次成功 `tool/result` 的 seq，该工具的路径参数须解析到同一个 `ctx.fs` 目标；然后构建条目，并以这些 seq 调用 `ctx.knowledge.write`。写入成功的页面返回其 id、操作与因此过期的页面；被拒绝的页面返回一个指出被违反规则的工具错误。

### 设计说明

- **出处来自日志。** `knowledgeEvidence` 投影折叠 `tool/call` 与 `tool/result`：带 `file_path` 或 `path` 参数的证据工具调用会等待其结果，成功的结果把自己的 seq 记录在该路径下。来源按 `ctx.fs.resolve` 的 `targetKey` 与读取匹配，因此 `src/a.ts` 与 `./src/a.ts` 是同一个文件。从未被成功读取的来源会在调用知识库之前被拒绝，且不记录 `knowledge/write`。
- **总是询问。** 以 `prepend: true` 注册的 `tools/pre-execute` 监听器先调用 `next()`，再把 `knowledge_write` 的 `allow` 改为 `ask`，因此更早的监听器返回的 `allow` 无法跳过询问。没有审批提供方时，注册表会拒绝调用。子会话会拒绝所有审批，因此子代理或 graph 节点中的 `knowledge_write` 总是被拒绝。
- **每次尝试都记录。** 到达知识库的写入会追加一条带被引用 seq 与文件的 `knowledge/write` 记录，无论知识库写入还是拒绝了该页面；`@deepseek-ai/dsh-experimental-knowledge` 不变量检查每条已应用记录的引用。
- **不是会话搜索。** `knowledge_query` 只对知识库页面排序；搜索之前的会话使用会话查询工具。
- **检索下限。** [`tests/retrieval-eval.spec.ts`](tests/retrieval-eval.spec.ts) 以 `limit: 3` 在 20 页的夹具 wiki 与 20 个留出问题（[`tests/retrieval-fixture.ts`](tests/retrieval-fixture.ts)）上运行 `knowledge_query`，并要求平均 recall@3 至少为 0.8；设定该下限时，wiki 文件系统排序的实测值为 0.825。它不调用模型。使召回低于下限的排序改动会让单元测试失败；排序改进后应提高下限。
- **没有 `./invariant` 伴随插件。** 本包不发布不变量伴随插件，因为它写入的每条记录都是 knowledge/write，其出处由 @deepseek-ai/dsh-experimental-knowledge 不变量检查。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、四个工具与审批监听器 |
| [`src/evidence.ts`](src/evidence.ts) | `knowledgeEvidence` 投影折叠 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 seam](../knowledge/README.zh.md) — `ctx.knowledge` 与 `knowledge/write` 事件。
- [wiki 文件系统提供方](../knowledge-wiki-filesystem/README.zh.md) — 这些工具背后的知识库规则与页面格式。
- [知识规则守卫](../knowledge-rules/README.zh.md) — 拒绝对知识库的直接文件与 shell 写入。
- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — 角色与事件。

-----

<a id="model-experience"></a>
## 模型体验

### knowledge_query 工具

#### 模型看到什么

挂载本插件后，模型会得到一个名为 `knowledge_query` 的只读工具，带必需的 `query` 字符串、可选的整数 `limit`（1 到 `maxResults`）以及下列描述。结果是紧凑 JSON `{"hits":[{"id","title","type","updated","stale","score"}]}`；超出范围的 `limit` 是指出范围的工具错误。

##### 该字段的原文

```markdown
Search the knowledge store of this workspace: durable pages about the project that earlier sessions and people recorded. Returns pages ranked by the share of query words they contain, with id, title, type, last update, and stale (a page it depends on changed after it or was superseded). Read a page with knowledge_read before relying on it.
```

#### Token 影响

挂载期间始终存在：工具定义在每个请求中约 140 个 token。每次调用添加的结果每个命中约 25 个 token，最多 `maxResults` 个命中。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后的仅追加工具结果。

### knowledge_read 工具

#### 模型看到什么

挂载本插件后，模型会得到一个名为 `knowledge_read` 的只读工具，带必需的 `ref` 字符串以及下列描述。结果是紧凑 JSON `{"page":{"id","title","type","updated","stale","relations","content","truncated"}}`，文件文本被截断到 `maxPageChars` 个字符；不指向任何可读页面的引用是建议使用 `knowledge_query` 的工具错误。

##### 该字段的原文

```markdown
Read one knowledge page by id (for example concepts/retry.md), by id without .md, or by a file name that is unique in the store. Returns its title, type, last update, stale flag, declared relations, and Markdown text. Pages can be outdated: verify statements about code against the current files before asserting them.
```

#### Token 影响

挂载期间始终存在：工具定义在每个请求中约 120 个 token。每次调用添加页面文本，最多 `maxPageChars` 个字符（约 `maxPageChars / 4` 个 token），外加约 40 个 token 的字段。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后的仅追加工具结果。

### knowledge_cite 工具

#### 模型看到什么

挂载本插件后，模型会得到一个名为 `knowledge_cite` 的只读工具，带必需的 `ref` 字符串、可选的整数 `depth`（0 到 `maxDepth`）以及下列描述。结果是紧凑 JSON `{"edges":[{"eid","from","to","toKind","relation"}],"neighbors":[[…]]}`；`neighbors` 按链接距离列出页面 id，只在 `depth` 大于 0 且引用的是页面时出现。超出范围的 `depth` 是指出范围的工具错误。

##### 该字段的原文

```markdown
List the edges that start or end at one knowledge page, each with a stable edge id (e: and 8 hex digits) you can cite: body links (wikilink, mdlink), declared relations (derives-from, depends-on, implements, supports, contradicts, supersedes), and touches edges to workspace code paths the page names. Pass an edge id as ref to look up that one edge. depth from 1 also returns the pages within that many links.
```

#### Token 影响

挂载期间始终存在：工具定义在每个请求中约 170 个 token。每次调用每条边约添加 30 个 token，外加列出的邻居 id。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后的仅追加工具结果。

### knowledge_write 工具

#### 模型看到什么

在 `read-write` 模式下，模型会得到一个名为 `knowledge_write` 的工具，带必需的 `id`、`type`、`title`、`body` 与 `sources`，可选的 `relations`（取六种声明关系之一的 `{relation, to}`），以及下列描述；描述会写出所配置的证据工具（这里显示默认的 `read`）。每次调用前都会询问用户。写入成功的页面返回 `{"id","operation","stale"}`。空的 `sources` 列表、本会话中未被成功读取的来源、被拒绝或不可用的审批，以及知识库拒绝（`knowledge_write refused (<rule>): <reason>`）都是工具错误。

##### 该字段的原文

```markdown
Create or replace one knowledge page. id is a path such as concepts/retry.md inside one of the store's content directories. sources must list workspace files you read in this session with read; the harness cites those reads in the page and refuses a page without them. relations may point only at existing pages. The user approves every write. Record durable facts about the project, not plans, progress, or temporary state of this session.
```

#### Token 影响

仅在 `read-write` 模式下存在：工具定义在每个请求中约 340 个 token。每次调用添加约 20 个 token 的结果外加过期页面 id，或一句错误说明。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后的仅追加工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只通过证据工具读取** — 由 shell 命令或脚本读取的文件不能作为来源；先用证据工具读取它。
- **没有 Web 卡片** — 待定卡片是通用的 host presenter。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
