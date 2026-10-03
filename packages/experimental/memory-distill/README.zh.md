---
description: "实验性知识 seam 的 episode 提炼：在校验门为 turn 的最终回复记录 verdict ok 之后，写入一个 episode 页面，包含请求、过滤后的最终回复与变更的文件，并引用改变这些文件的工具结果，并可归档较旧的 episode，面向希望跨会话记住已校验 turn 的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-distill

[English](README.md) | 中文

## 概述

对于校验门判定为 `ok` 且变更了文件的 turn，本包向 `ctx.knowledge` 知识库写入一个 `episode` 页面。页面包含用户的请求、去掉标记为临时语句后的最终回复、变更的文件与校验结论，并引用改变这些文件的成功工具结果。`maxEpisodes` 为正数时，较旧的 episode 页面会被归档，从不删除。默认的 `shadow` 模式只记录它将执行的 `knowledge/write` 记录。不调用任何模型。请把它挂载在校验门之后。本包是实验性的，不承诺稳定性。

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

在知识库提供方、会话投影服务以及配置了 `verify.commands` 的 `@deepseek-ai/dsh-experimental-verifier-gate` 之后挂载本插件。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-memory-distill'
  config:
    mode: enforce
    assumption: a turn whose verify commands passed holds project facts worth recalling in later sessions
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何内容；`shadow` 记录它将执行的写入；`enforce` 执行写入 |
| `assumption` | 无 | 本机制对模型所做的假设；在 `off` 之外为空白即加载错误 |
| `requireVerdict` | `true` | 仅在 turn 的最终回复有 `ok` 的 `loop/verdict` 之后提炼 |
| `dir` | `episodes` | episode 页面所在的知识库目录；必须是知识库的内容目录 |
| `maxEpisodes` | `0` | 保持活跃的 episode 页面数：`0` 不归档任何页面；正数在每次写入 episode 后归档其余最旧的 episode 页面，使知识库索引中最多保留这么多个 |
| `changeTools` | `write`、`edit` | 成功调用会改变其 `file_path` 或 `path` 的工具 |
| `maxRequestChars` | `1000` | 保留的请求字符数 |
| `maxOutcomeChars` | `2000` | 保留的最终回复字符数 |
| `transientMarkers` | `this session`、`for now`、`today only`、`temporarily`、`for this turn` | 临时语句的标记，按句删除 |

当 `assumption` 在 `off` 之外为空白、`dir` 不是单个路径段、`changeTools` 为空或含空白项、某个字符上限不是正整数、`maxEpisodes` 不是至少为 0 的整数，或某个标记为空白时，加载以 `memory-distill:` 错误失败。

### 与校验门的顺序

`agent/turn-stopping` 按注册顺序运行监听器；请在 profile 的层列表中把 `@deepseek-ai/dsh-experimental-loop-graph-profile` 放在 `@deepseek-ai/dsh-experimental-knowledge-profile` 之前。当校验门在本插件检查过某个边界之后才判定它时，该 turn 不会被提炼，插件每个会话记录一次下面的警告。

```text
memory-distill: the verifier gate recorded a verdict after memory-distill checked the same turn boundary, so the turn was not distilled; list the loop guards bundle before the knowledge bundle so the gate runs first.
```

### 校验命令决定结果

循环守卫组合包附带的 verifier-gate 没有校验命令，它记录 `skipped`，从不记录 `ok`；要写入 episode，请配置 `verify.commands`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`memoryDistill` 投影折叠当前 turn：第一条来源类型为 `user` 的 `user/message`、`changeTools` 调用对每个路径最近一次成功的变更、最近一条 `assistant/message` 及其文本、同一 turn 中与该消息关联的 `loop/verdict`，以及本写入方是否已记录过 `knowledge/write`。一个未使用 `prepend` 注册的 `agent/turn-stopping` 监听器在以下情况写入 episode：与最终回复关联的结论为 `ok`，或 `requireVerdict` 关闭且没有与之关联的结论；并且该 turn 至少变更了一个文件。

### 设计说明

- **页面内容。** `episodes/<YYYY-MM-DD>-<session>-t<turn>.md`，类型为 `episode`，含 Request、Outcome、Files changed 与 Verification 各节；提供方加入 frontmatter、标题行与 Origin 一节。
- **通过归档保留。** `resolveRetention` 把 `maxEpisodes` 解析为不归档（`0`）或保持活跃的 episode 页面数。给定数量时，插件在写入前读取知识库索引；episode 写入后，把 `dir` 下除最新的 `maxEpisodes - 1` 个之外的其余 `episode` 页面全部归档（较新指 `updated` 较晚，其次 id 较大）。归档会读取页面，并经由 `ctx.knowledge.write` 以状态 `archived` 写回其标题、正文与关系，引用与新 episode 相同的工具结果，因此它经过知识库规则检查，并以 operation 为 `update` 的 `knowledge/write` 记录。已归档页面离开索引、查询结果与邻居层级，但仍可通过 `knowledge_read` 与 `knowledge_cite` 读取；插件从不删除页面。选用 frontmatter 状态而不是 `supersedes` 关系，是因为较新的 episode 并不取代较旧 episode 的事实，而且被取代的页面仍会留在索引中。在 `shadow` 模式下，插件为每个将要归档的页面记录一条 `knowledge/write`。
- **引用来自变更。** 页面引用每个变更文件最近一次变更的成功 `tool/result`；没有变更文件的 turn 不会被提炼，因为它的页面无从引用。
- **删除临时语句。** 请求与回复中包含已配置标记（不区分大小写）的句子会被删除。
- **共享内容。** `episodeContent` 对一个轮次的请求与回复应用标记过滤和长度上限。它是纯函数导出：`memory-zeromem` 用它生成已验证 episode 的文本，因此两个存储删除相同的语句，而无需复制该规则。
- **每个 turn 一次。** 折叠在本写入方的第一条 `knowledge/write` 时把 turn 标记为已提炼，因此同一 turn 中被引导继续的部分不会再次提炼。
- **不接收压缩摘要。** 摘要是模型输出而不是工具结果，因此无法被引用。
- **与校验门相互独立。** 校验门的 `loop/verdict` 按事件名读取并用 zod 校验；本包在运行时不依赖校验门。
- **没有 `./invariant` 伴随插件。** 本包不发布不变量伴随插件，因为它写入的每条记录都是 knowledge/write，其引用由 @deepseek-ai/dsh-experimental-knowledge 不变量检查。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、投影注册、turn-stopping 监听器与顺序警告 |
| [`src/fold.ts`](src/fold.ts) | `memoryDistill` 投影折叠与结论解析 |
| [`src/retention.ts`](src/retention.ts) | `maxEpisodes` 解析与待归档 episode 页面的选择 |
| [`src/episode.ts`](src/episode.ts) | episode 页面 id、标记过滤、共享的 `episodeContent` 与页面条目 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 seam](../knowledge/README.zh.md) — `ctx.knowledge` 与 `knowledge/write` 事件。
- [校验门](../verifier-gate/README.zh.md) — 本插件等待的 `loop/verdict`。
- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — 角色与事件。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过知识库：episode 页面只通过索引消息与知识工具到达模型；本插件不添加消息、工具或提示文本。

#### KV Cache 影响

无关：本插件的任何内容都不会直接进入请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **层顺序** — 校验门必须先注册其 `agent/turn-stopping` 监听器；本插件只发出警告，不会重新排序。
- **不提炼摘要** — 压缩摘要不会被提炼。
- **episode 文件从不删除** — 归档约束的是索引而不是知识库：已归档页面仍是文件，提供方的 `maxPages` 限制一次读取加载的页面数，已归档页面也计入。一次归档会把页面的引用与 Origin 一节替换为触发它的工具结果；页面 id 保留原始会话与 turn。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
