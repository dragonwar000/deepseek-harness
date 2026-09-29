---
description: "把会话日志中已准入的 dsh-graph/v1 计划、graph 运行器记录、轮次证据与被压缩的片段折叠起来，并让模型通过 graph_query、graph_cite 与 history_read 读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-projection

[English](README.md) | 中文

## 概述

本包注册三个会话投影与三个只读工具。`graph` 把已准入的 `graph/plan` 版本以及运行器的 `graph/node`、`graph/run` 与 `graph/edge` 记录折叠为每个计划 id 一张任务图：带状态、依据、尝试次数、恢复状态与循环迭代的节点，波次，运行，循环决策与携带结果；`graph_query` 读取它。`graphEvidence` 折叠当前轮次工具记录提到的路径与命令，以及其最新回答的声明；`graph_cite` 读取它。`graphHistory` 列出被压缩的片段；`history_read` 把其中一个作为转录返回。本包不写入任何会话事件。本包是实验性的，不承诺稳定性。

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

在 `@deepseek-ai/dsh-experimental-graph-contract` 之后挂载本插件，后者写入本包读取的 `graph/plan` 事件。本插件不约束任何东西，只读取日志，因此没有 `mode` 或 `assumption`；它唯一的配置是 `history_read` 的上限。`history_read` 通过 `@deepseek-ai/dsh-session-query-sqlite` 提供的 `ctx.sessionQuery` 读取。`@deepseek-ai/dsh-experimental-loop-graph-profile` 包会挂载它。

### 何时选择

当模型需要在审计或运行之后重新读取已准入计划的结构、波次与节点状态，而不是依赖对话早先的工具结果，需要在提及某个路径或命令之前检查本轮次哪些工具记录提到了它，或需要读回压缩从其上下文中移除的内容时，选择它。graph 运行器需要它，`@deepseek-ai/dsh-experimental-verifier-gate` 的证据检查读取 `graphEvidence`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-projection'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `history.maxChars` | `8000` | 每页 `history_read` 转录的字符数；更长的事件行会被截断到该长度 |
| `history.maxListed` | `20` | `history_read` 列表返回的片段数，最新的在前 |
| `history.readWindow` | `50` | 每次会话查询读取在目标之后的事件数；应不超过会话查询的 `readWindowMax`（默认 50） |

当某个 `history` 字段不是不小于 1 的整数时，加载会以 `graph-projection:` 错误失败。

### 你会得到什么

`graph` 投影为每个有已准入版本的计划 id 保存最新准入版本的任务图。被拒绝或无法解析的版本不会改变任务图。scope 为 `plans` 的 `graph_query` 列出每个已准入计划及其版本、节点数、就绪数与已执行数；scope 为 `plan` 且带 `plan_id` 时返回该计划的节点、波次、运行以及带触发次数的循环边；scope 为 `node` 且带 `plan_id` 与 `node_id` 时返回一个节点及其输出、子会话与记录的原因。

`graphEvidence` 投影在每个 `turn/start` 时重置。声明是最新 assistant 消息提到的文件路径或 shell 命令：包含空白的行内代码是命令，读作路径的行内代码是路径，正文词元只有在以 `/`、`~/`、`../` 开头，或包含 `/` 且以文件名结尾时才是路径；围栏代码被忽略。每条声明带有同一轮次的叶子：`tool-record`（工具调用参数提到它）、`observed`（成功的工具结果提到它）或 `absence`（失败的工具结果提到它）；没有叶子的声明是 parametric。替换的工具结果以及 `graph_cite` 工具自身的调用不是叶子。`graph_cite` 对一条声明分类并返回其叶子。

`graphHistory` 投影记录每个 `compaction/summary` 与 `compaction/prune` 片段及其被遮蔽的 seq。不带 `seq` 的 `history_read` 按最新优先列出片段；带 `seq` 时，它通过 `ctx.sessionQuery.readEvent` 以有界窗口读取该片段的原始事件，并把一页转录作为新的工具结果返回。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`applyGraphEvent` 用 graph-contract 的记录 schema 解码每个 `graph/plan`、`graph/node`、`graph/run` 与 `graph/edge` 载荷。已准入且已解析的 `graph/plan` 用初始状态的节点、它们的 `nodeFingerprints` 与该计划的 `planWaves` 替换该计划 id 的任务图；未准入或未能解析的版本被忽略。`graph/node` 记录替换所指节点的状态、依据、尝试次数、修订号、恢复状态、输出、子会话与原因；`graph/run` 记录追加一次运行或设置其停止原因；`graph/edge` 记录更新其循环边的视图（触发次数、已决策的迭代、结果、指标以及触发时回传的输出）。无法解码的载荷，或与已准入任务不匹配的记录，会设置终止性的 `failure`，此后 `graph_query` 以该原因失败。

### 设计说明

- **就绪是派生的；其他状态都是记录的。** 每次变化后，尚未开始的节点在 graph-contract 的 `needSatisfied` 对每个 need 都成立时为 `ready`，否则为 `pending`。其他状态都是该节点最新的 `graph/node` 记录。
- **携带结果。** 新版本准入时，`carry` 保留被替换版本中已执行的节点及其指纹与依据，使运行器能携带指纹未变的节点。
- **每个计划 id 一张任务图。** 之后准入的版本会替换更早的任务图，并把它移到列表末尾；其运行列表从空开始。
- **容忍 shadow 准入。** 在 `shadow` 模式下准入的计划可能带有对未声明节点的 need 或环；这些节点不进入任何波次。
- **循环迭代是记录的。** `iteration` 更高的 `graph/node` 记录会重新打开节点；就绪状态再次由 needs 派生。
- **证据是启发式的。** `graphEvidence` 是 `turn/start`、`tool/call`、`tool/result` 与 `assistant/message` 的纯折叠，不调用模型。`assistant/message` 不能引用来源事件，文件系统观察是 Cordis 事件而非会话事件，也没有把声明关联到代码的服务，因此叶子只来自该轮次的工具记录，也不存在 `graph/claim` 事件：声明与叶子可从日志重建。
- **折叠不读取配置。** 投影缓存只按 `stateVersion` 作为键，因此每个可配置上限都在工具或关口读取状态时才生效。
- **历史是读取，不是恢复。** `history_read` 从不改写 surface；它通过会话查询服务异步读取旧事件，并在末尾返回它们。
- **不匹配的记录会终止性失败。** 针对非当前任务版本、计划未声明的节点的节点或运行记录，或没有开始的停止，都会设置 `failure`。
- **没有 `./invariant` 伴随插件。** 本包不发布运行时不变量伴随插件：这些投影是本包对 graph 事件与证据的唯一观察。证据关系由 `@deepseek-ai/dsh-experimental-verifier-gate/invariant` 检查，它把每条记录的 `loop/verdict` 证据与 `graphEvidence` 比较。准入关系由 `@deepseek-ai/dsh-experimental-graph-contract/invariant` 检查，节点状态转换关系由 `@deepseek-ai/dsh-experimental-graph-runner/invariant` 检查，后者把每条记录与本投影比较。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、投影注册，以及 `graph_query`、`graph_cite` 与 `history_read` 工具 |
| [`src/types.ts`](src/types.ts) | `graph`、`graphEvidence` 与 `graphHistory` 状态类型及投影状态声明 |
| [`src/projection.ts`](src/projection.ts) | `graph` 投影折叠 |
| [`src/evidence.ts`](src/evidence.ts) | 声明、路径、命令与叶子的纯函数 |
| [`src/evidence-projection.ts`](src/evidence-projection.ts) | `graphEvidence` 投影折叠 |
| [`src/history.ts`](src/history.ts) | `graphHistory` 投影与分页转录读取器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Graph 契约包](../graph-contract/README.zh.md)——本投影折叠的计划格式、审计与 `graph/plan` 事件。
- [Graph 运行器包](../graph-runner/README.zh.md)——写入本投影折叠的 `graph/node` 与 `graph/run` 记录的 `graph_run` 工具。
- [Loop graph 配置包](../loop-graph-profile/README.zh.md)——挂载这些 graph 包的可选包。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。
- [最终回答证据说明](../../../.agents/notes/implemented/architecture/2026-09-30-graph-evidence-heuristic-claims.zh.md)——为什么声明与叶子是对本轮次工具记录的启发式折叠.

-----

<a id="model-experience"></a>
## 模型体验

### graph_query 工具

#### 模型看到什么

插件挂载时，模型会得到一个名为 `graph_query` 的只读工具，它有必填的 `scope` 参数（`plans`、`plan` 或 `node`）、可选的 `plan_id` 与 `node_id`，描述如下。结果是紧凑的 JSON：`plans` 返回 `{"plans":[{"planId","version","nodes","ready","executed"}]}`，`plan` 返回 `{"graph":{"planId","version","waves","nodes":[{"id","kind","needs","status","attempt","recoveryState","iteration","basis"}],"runs":[{"runId","stopReason"}],"edges":[{"from","to","fireCount","outcome"}]}}`（`iteration` 只在大于 0 时出现，`edges` 只在计划有循环边时出现），`node` 返回 `{"node":{…, "output", "childSession", "detail"}}`；缺少参数、计划未知或节点未知时，会返回指明问题的工具错误。

##### 该字段的原文

```markdown
Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state, loop iteration), the waves of nodes that can run together, its runs, and the fire count of each loop edge. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 190 个 token。每次调用增加一个与计划大小成比例的工具结果（每个节点约 25 个 token），外加被查询节点的输出。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后、只追加的工具结果。

### graph_cite 工具

#### 模型看到什么

插件挂载时，模型会得到一个名为 `graph_cite` 的只读工具，它有一个必填的 `claim` 字符串参数，描述如下。结果是三种文本之一：`graph_cite: <path|command> <claim> is supported in turn <n> by:` 后跟每个叶子一行 `- <tool-record|observed|absence>: <tool> (#<seq>)`；`graph_cite: <path|command> <claim> is parametric: no tool call or tool result in turn <n> mentions it.`；或 `graph_cite: "<claim>" is neither a file path nor a shell command; cite one path or one command.`

##### 该字段的原文

```markdown
Check which tool calls and tool results of the current turn mention a file path or a shell command you are about to name in your answer. Each supporting record is tool-record (a tool call argument names it), observed (a successful tool result names it), or absence (a failed tool result names it). A claim with no record is parametric: nothing in this turn shows it.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 95 个 token。每次调用增加一个一到四行的结果。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是只追加的工具结果。

### history_read 工具

#### 模型看到什么

插件挂载时，模型会得到一个名为 `history_read` 的只读工具，它有可选的整数参数 `seq` 与 `offset`，描述如下。不带 `seq` 时，结果按最新优先列出被压缩的片段（`- seq <n>: summary|prune, events #<start>-#<end>, <k> items`）；带 `seq` 时，结果是一页转录（`#<seq> User|Assistant|Tool result: <text>`，其他事件类型以类型名表示），截断到 `history.maxChars` 个字符，页面提前停止时后跟 `More: call history_read with seq <n> and offset <m>.`。未知的 `seq`、超出片段的 offset，或没有会话查询服务的部署，都会返回工具错误。

##### 该字段的原文

```markdown
Read back conversation that compaction replaced or shortened in your context. Without seq, list the compacted spans of this session, newest first: each has a seq, a kind (summary: a span replaced by a checkpoint; prune: a tool result shortened in place), its first and last event number, and its item count. With seq from that list, return the span as a transcript starting at offset; a page that stops early names the next offset. The transcript arrives as this tool result; nothing earlier in your context changes.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 150 个 token。每次读取增加一个工具结果，包含至多 `history.maxChars` 个字符的转录（约 `maxChars / 4` 个 token）以及一行标题。

#### KV Cache 影响

history_read 的结果是追加在模型已见全部内容之后的新工具结果；更早的消息、检查点或工具结果都不会改变，因此缓存的提示前缀仍可复用。再次读取某个片段会在末尾重新发送其内容，而不会在原位置恢复它。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **声明只有路径与命令**——正文中的事实、围栏代码以及正文中不带斜杠的文件名都不是声明；只要某个调用提到了命令声明，无论该调用的退出状态如何，该声明都被视为有支持。
- **转录文本是搜索文本**——各行来自 `@deepseek-ai/dsh-session-query` 的 `extractSessionEventText`：推理块被丢弃，工具调用渲染为其名称与原始参数，图像不渲染任何内容。
- **读取会克隆实时日志**——会话查询服务在每次窗口读取时为实时会话创建快照，因此一个较长的片段会产生多次完整日志复制。
- **没有 Web 卡片**——待处理卡片使用通用的 host 呈现器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
