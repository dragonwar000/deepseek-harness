---
description: "实验性知识 seam 的 wiki 文件系统提供方：会话工作区内带 YAML frontmatter 的 Markdown 页面，推导出的链接、关系、touches 边与过期状态，以及带出处、经规则校验的写入，面向决定持久项目知识存放位置的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem

[English](README.md) | 中文

## 概述

本包把 `ctx.knowledge` 注册为会话工作区内一个存放带 YAML frontmatter 的 Markdown 页面的目录，与 overstack llmwiki 的布局兼容。每次读取都通过 `ctx.fs` 加载页面，并推导正文链接、声明的关系以及指向已存在代码路径的 `touches` 边，每条边都带 overstack 的边 id；过期状态只推导一层关系，从不存储。每次写入都检查知识库规则，在 frontmatter 与 Origin 章节中引用其会话事件，并且只在页面仍是读取时的版本时才替换它。本包是实验性的，不承诺稳定性。

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

在带有 `ctx.fs` 提供方的组合中挂载本提供方，再挂载 `@deepseek-ai/dsh-experimental-tool-knowledge` 等消费方。同时挂载 `@deepseek-ai/dsh-experimental-knowledge-rules`，使工具无法在没有出处的情况下修改页面。

### 何时选择

当项目知识应作为可审阅的 Markdown 存放在仓库中、供人与智能体共同阅读，并且每个由智能体写入的页面都要能追溯到它所依据的工具结果时，选择它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
  config:
    root: knowledge
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `knowledge` | 相对会话工作目录的知识库目录 |
| `contentDirs` | `concepts`、`entities`、`sources`、`architecture`、`tours`、`episodes` | 存放页面的顶层目录 |
| `readOnlyDirs` | `raw` | 只有人会修改的顶层目录 |
| `codeExtensions` | `py`、`js`、`ts`、`sh`、`yaml`、`yml`、`json`、`html` | 会成为 `touches` 边的反引号代码路径的扩展名 |
| `maxPages` | `2000` | 一次读取在失败前最多加载的页面数 |

生成的[配置目录](../../../docs/config-catalog.zh.md)列出了所有可接受的字段。

### 页面格式

页面是 `<contentDir>/…/<name>.md`，其 frontmatter 含非空的 `type`，并可选地含 `title`、`updated`、`status`、`relations`（`- {rel: depends-on, to: concepts/backoff.md}`）与 `citation`。`status: archived` 使页面不出现在索引、查询结果与邻居层级中，邻居遍历也不经过它；`read` 与 `cite` 仍返回它。其他 `status` 值会被忽略。frontmatter 无法解析或没有 `type` 的页面会被隔离：它们不出现在任何结果中，只在索引中计数。`README.md` 与 `_template.md` 不是页面；位于知识库根目录以及 `contentDirs` 之外的文件会被忽略。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

### 设计说明

- **推导，从不存储。** 每次调用都会列出内容目录、解析每个页面、对每个反引号候选路径执行 stat，并构建图。当页面声明关系所指向的页面有更晚的 `updated`，或它依赖的页面被另一个页面取代时，该页面过期；按构造，过期状态只有一层关系深。
- **规则在写入路径中运行。** `write` 依次检查只读目录与内容目录（overstack R1、R14、R5）、单个词的 `type` 与非空标题（R9）、至少含一个事件与一个文件的出处，以及关系：每个目标都存在、没有指向自身的关系、不新增对已被取代页面的依赖（R-rel-1、R-rel-3）。渲染出的页面会再次检查 frontmatter 可解析、带出处且有 Origin 章节（R9、R2）。违反规则时返回 `refused`，不写入任何内容。
- **带版本保护的写入。** 写入只在已存在页面仍为它 stat 到的版本时才替换它，并且只在新页面仍不存在时才创建它。
- **排序。** 命中的分数是查询词（字母与数字，转为小写）在页面 id、类型、标题与正文中出现的比例；分数相同时按 id 排序。overstack `mem-rank.py` 对短记忆使用 Jaccard，这会惩罚长页面。
- **带锚点的 Markdown 链接。** `[x](y.md#part)` 链接到 `y.md`；overstack `wiki-graph.py` 会跳过这类链接。
- **没有 `./invariant` 伴随插件。** 本包不发布不变量伴随插件，因为提供方不写入任何会话事件；`knowledge/write` 记录的出处关系由 `@deepseek-ai/dsh-experimental-knowledge/invariant` 检查。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `WikiFilesystemKnowledge`：配置、通过 `ctx.fs` 加载、服务方法 |
| [`src/page.ts`](src/page.ts) | frontmatter 解析、链接提取、页面渲染 |
| [`src/graph.ts`](src/graph.ts) | 构建图、解析引用、过期状态、邻居、引用边 |
| [`src/rank.ts`](src/rank.ts) | 查询排序 |
| [`src/rules.ts`](src/rules.ts) | 知识库规则 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 seam](../knowledge/README.zh.md) — 本包实现的 Service Definition。
- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — 角色与事件。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — 知识库读写所经由的 `ctx.fs` seam。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 `ctx.knowledge` 的消费方：本提供方不注册自己的工具、消息或提示文本，拒绝原因只出现在这些消费方的结果中才会到达模型。

#### KV Cache 影响

无关：本提供方不会向请求中加入任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每次调用完整读取** — 每次调用都会读取所有页面；`maxPages` 限定了开销。
- **过期状态依赖 `updated`** — 人编辑页面却不更新 `updated` 时，页面永远不会因时间而过期。
- **没有章节或会话节点** — 边的目标是页面与代码路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
