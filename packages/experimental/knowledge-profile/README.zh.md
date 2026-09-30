---
description: "在一个实验性组合包中提供 Markdown wiki 知识库、失败即拒绝的写入守卫、只读知识工具、有上限的上下文索引，以及在校验通过的 turn 之后以 shadow 模式提炼 episode，默认随安装关闭。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-knowledge-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-knowledge-profile` 通过一个组合包启用 [`knowledge-wiki-filesystem`](../knowledge-wiki-filesystem/README.zh.md)、[`knowledge-rules`](../knowledge-rules/README.zh.md)、[`tool-knowledge`](../tool-knowledge/README.zh.md)、[`context-knowledge`](../context-knowledge/README.zh.md) 与 [`memory-distill`](../memory-distill/README.zh.md)。对模型请求的唯一改变是三个读取工具的定义，以及知识库有页面时的索引消息。`memory-distill` 以 `shadow` 模式启动。第六行 [`memory-zeromem`](../memory-zeromem/README.zh.md) 以禁用状态提供：它需要 zeromem 的 `zm` 可执行文件，并把对话文本存到磁盘，因此由 profile patch 开启。本包随安装提供，默认关闭；可在插件页开启，或添加到已初始化的 profile。

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

### 安装到 profile

将本包添加到已初始化的 profile：

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-knowledge-profile
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，它提供这些行所用的文件系统、工具与会话投影服务，以及 `agent/pre-step` 与 `agent/turn-stopping` 事件。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-knowledge-profile` 移除本包时，全部六行都会从 profile 的有序层列表中移除。

在 Web 或 Desktop 的插件页开启「知识库」，即可同时启用五个启用行；`memory-zeromem` 保持禁用，直到 profile patch 启用它。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

### 获得的功能

本层插入六行，不改变任何 `dsh-base` 行。`knowledge-wiki-filesystem` 把页面保存在 `<session cwd>/knowledge` 下。`knowledge-rules` 拒绝会直接改变知识库的文件工具写入与 shell 命令，因此页面只能通过 `knowledge_write` 或 `memory-distill` 改变。`tool-knowledge` 以 `read-only` 启动，提供 `knowledge_query`、`knowledge_read` 与 `knowledge_cite`。`context-knowledge` 在索引变化的 turn 的第一步加入知识库索引（从不包含页面内容），上限为 200 行与 25600 字节。`memory-distill` 以 `shadow` 模式启动：在校验门记录 verdict `ok` 之后，它把本会写入的 episode 页面记录为一条 `applied: false` 的 `knowledge/write`。`memory-zeromem` 以 `disabled: true` 插入。

### 与循环护栏组合包的顺序

`memory-distill` 必须在 `verifier-gate` 之后注册其 `agent/turn-stopping` 监听器：请在 profile 的层列表中把循环护栏组合包放在本组合包之前。顺序错误时不会提炼任何 turn，`memory-distill` 每个会话记录一次如下警告：

```text
memory-distill: the verifier gate recorded a verdict after memory-distill checked the same turn boundary, so the turn was not distilled; list the loop guards bundle before the knowledge bundle so the gate runs first.
```

只有 `verifier-gate` 配置了 `verify.commands` 时才会出现 `ok` 结论；没有循环护栏组合包，或校验门没有校验命令时，`memory-distill` 不记录任何内容。

### 开启写入

在你自己的 profile patch 中按 id 修补这些行。config patch 会替换整个行配置，因此请重写每个字段：

```yaml
- id: tool-knowledge
  config:
    mode: read-write
    evidenceTools: [read]
    maxResults: 10
    maxPageChars: 20000
    maxDepth: 2
- id: memory-distill
  config:
    mode: enforce
    assumption: a turn whose verify commands passed holds project facts worth recalling in later sessions
    requireVerdict: true
    dir: episodes
    changeTools: [write, edit]
    maxRequestChars: 1000
    maxOutcomeChars: 2000
    transientMarkers: [this session, for now, today only, temporarily, for this turn]
```

之后每次 `knowledge_write` 都会询问用户，并引用本会话对其来源的读取。在某行的 id 上设置 `disabled: true` 即可禁用该行。

### 开启对话记忆

`memory-zeromem` 需要 zeromem 的 `zm` 可执行文件；[其 README](../memory-zeromem/README.zh.md#use-this-package) 说明如何构建。启用后，它把用户消息与最终助手回复的文本（从不包括工具输出）存入 `<harness home>/zeromem` 下按工作区划分的存储，并提供 `memory_recall` 与 `memory_stats`。在你的 profile patch 中启用它，并重写该行配置：

```yaml
- id: memory-zeromem
  disabled: false
  config:
    zmPath: zm
    embedder: default
    scope: workspace
    excludeCurrentSession: true
    ingestSubagentSessions: false
    allowForget: false
    defaultResults: 5
    maxResults: 10
    maxTurnChars: 2000
    maxIngestChars: 16000
    timeoutMs: 120000
    graceMs: 2000
    maxConcurrent: 1
```

`zm` 不在 `PATH` 上时，把 `zmPath` 设为绝对路径；对于未启用 fastembed 特性构建的 `zm`，设置 `embedder: hash`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

在 `dsh-base` 之后应用时，patch 插入六个具有稳定 id 的行，不改变任何 `dsh-base` 行。行顺序即监听器顺序：知识库先于其守卫与消费方加载，`memory-distill` 位于它们之后；禁用的 `memory-zeromem` 行排在其后，且不依赖其他行。

patch 不含不变量行：`dsh-base` 有意不挂载 `@deepseek-ai/dsh-invariants`。挂载该注册表的组合需自行在其他核心伴随插件旁边添加 `knowledge/invariant` 与 `context-knowledge/invariant` 伴随插件。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 在 `dsh-base` 之上插入六行（其中一行禁用）的有序 patch |
| [`src/index.ts`](src/index.ts) | 空的模块入口；patch 才是运行时内容 |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | 解析 patch，按各包 `Config` 校验每一行，检查只有 `memory-zeromem` 以禁用状态提供，并检查与循环护栏组合包相互独立 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | 通过 Loader 启动 patch，检查请求中的工具、索引消息与知识库守卫；并在 patch 启用 `memory-zeromem` 后，经由脚本化的 `zm` 存储一个轮次并召回它 |
| — | 不发布运行时不变量伴随插件；本包只携带静态 profile patch。每个行对应的包自行负责其不变量。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) — 孵化状态与发布策略。
- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — seam、其角色与事件。
- [基础组合包](../../bundle/base/README.zh.md) — 本 patch 扩展的 profile 层。
- [循环护栏组合包](../loop-graph-profile/README.zh.md) — `memory-distill` 等待的校验门。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 tool-knowledge、context-knowledge 与 memory-zeromem，它们拥有本组合包可能产生的全部工具定义与索引消息；knowledge-wiki-filesystem、knowledge-rules 与 memory-distill 自身不向请求添加内容。

#### KV Cache 影响

三个读取工具的定义在组合包加载时一次性加入稳定的工具前缀。索引消息仅追加，且只在索引变化时加入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限主动开启** — 本包随安装提供但默认关闭；任何已发布的 CLI、Web、SDK、ACP 或 Python profile 都不会启用它。
- **默认只读且为 shadow** — 在 agent 能改变知识库之前，`tool-knowledge` 需要 `mode: read-write`，`memory-distill` 需要 `mode: enforce`。
- **工具在每个请求中消耗 token** — 组合包启用期间，三个读取工具的定义为每个请求增加约 430 个 token；`read-write` 为 `knowledge_write` 再增加约 340 个，启用的 `memory-zeromem` 为 `memory_recall` 与 `memory_stats` 增加约 220 个。
- **需要基础 profile** — patch 依赖 `dsh-base`；它不是独立的 profile。
- **层顺序** — 只有循环护栏组合包在层列表中排在前面时，`memory-distill` 才会提炼。
- **没有不变量行** — 挂载 `@deepseek-ai/dsh-invariants` 的组合必须自行添加 `knowledge/invariant` 与 `context-knowledge/invariant` 伴随插件；本组合包与 `dsh-base` 一样不添加。
- **graph 节点无法写入知识** — graph 节点只有 graph contract 的 `allowedTools` 列出的工具，且子会话会拒绝所有审批，因此节点中的 `knowledge_write` 总是被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
