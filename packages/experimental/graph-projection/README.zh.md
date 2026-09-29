---
description: "把会话日志中已准入的 dsh-graph/v1 计划与 graph 运行器记录折叠为带节点状态、携带结果与运行的任务图，并让模型通过 graph_query 读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-projection

[English](README.md) | 中文

## 概述

本包注册 `graph` 会话投影和只读的 `graph_query` 工具。投影把 `@deepseek-ai/dsh-experimental-graph-contract` 记录的已准入 `graph/plan` 版本，以及 `@deepseek-ai/dsh-experimental-graph-runner` 写入的 `graph/node` 与 `graph/run` 记录，折叠为每个计划 id 一张任务图：节点及其 needs、状态、依据、尝试次数与恢复状态，可以一起运行的节点波次，当前版本的运行，以及被替换版本的已执行结果。工具让模型列出已准入的计划，并读取一个计划或一个节点。本包不写入任何会话事件。本包是实验性的，不承诺稳定性。

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

在 `@deepseek-ai/dsh-experimental-graph-contract` 之后挂载本插件，后者写入本包读取的 `graph/plan` 事件。本插件没有配置：它不约束任何东西，只读取日志，因此没有 `mode` 或 `assumption`。`@deepseek-ai/dsh-experimental-loop-graph-profile` 包会挂载它。

### 何时选择

当模型需要在审计或运行之后重新读取已准入计划的结构、波次与节点状态，而不是依赖对话早先的工具结果时，选择它。graph 运行器需要它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-projection'
```

### 你会得到什么

`graph` 投影为每个有已准入版本的计划 id 保存最新准入版本的任务图。被拒绝或无法解析的版本不会改变任务图。scope 为 `plans` 的 `graph_query` 列出每个已准入计划及其版本、节点数、就绪数与已执行数；scope 为 `plan` 且带 `plan_id` 时返回该计划的节点、波次与运行；scope 为 `node` 且带 `plan_id` 与 `node_id` 时返回一个节点及其输出、子会话与记录的原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`applyGraphEvent` 用 graph-contract 的记录 schema 解码每个 `graph/plan`、`graph/node` 与 `graph/run` 载荷。已准入且已解析的 `graph/plan` 用初始状态的节点、它们的 `nodeFingerprints` 与该计划的 `planWaves` 替换该计划 id 的任务图；未准入或未能解析的版本被忽略。`graph/node` 记录替换所指节点的状态、依据、尝试次数、修订号、恢复状态、输出、子会话与原因；`graph/run` 记录追加一次运行或设置其停止原因。无法解码的载荷，或与已准入任务不匹配的记录，会设置终止性的 `failure`，此后 `graph_query` 以该原因失败。

### 设计说明

- **就绪是派生的；其他状态都是记录的。** 每次变化后，尚未开始的节点在 graph-contract 的 `needSatisfied` 对每个 need 都成立时为 `ready`，否则为 `pending`。其他状态都是该节点最新的 `graph/node` 记录。
- **携带结果。** 新版本准入时，`carry` 保留被替换版本中已执行的节点及其指纹与依据，使运行器能携带指纹未变的节点。
- **每个计划 id 一张任务图。** 之后准入的版本会替换更早的任务图，并把它移到列表末尾；其运行列表从空开始。
- **容忍 shadow 准入。** 在 `shadow` 模式下准入的计划可能带有对未声明节点的 need 或环；这些节点不进入任何波次。
- **不匹配的记录会终止性失败。** 针对非当前任务版本、计划未声明的节点的节点或运行记录，或没有开始的停止，都会设置 `failure`。
- **没有 `./invariant` 伴随插件。** 本包不发布运行时不变量伴随插件：投影是本包对 graph 事件的唯一观察。准入关系由 `@deepseek-ai/dsh-experimental-graph-contract/invariant` 检查，节点状态转换关系由 `@deepseek-ai/dsh-experimental-graph-runner/invariant` 检查，后者把每条记录与本投影比较。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：投影注册与 `graph_query` 工具 |
| [`src/types.ts`](src/types.ts) | `graph` 状态类型与投影状态声明 |
| [`src/projection.ts`](src/projection.ts) | `graph` 投影折叠 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Graph 契约包](../graph-contract/README.zh.md)——本投影折叠的计划格式、审计与 `graph/plan` 事件。
- [Graph 运行器包](../graph-runner/README.zh.md)——写入本投影折叠的 `graph/node` 与 `graph/run` 记录的 `graph_run` 工具。
- [Loop graph 配置包](../loop-graph-profile/README.zh.md)——挂载这些 graph 包的可选包。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### graph_query 工具

#### 模型看到什么

插件挂载时，模型会得到一个名为 `graph_query` 的只读工具，它有必填的 `scope` 参数（`plans`、`plan` 或 `node`）、可选的 `plan_id` 与 `node_id`，描述如下。结果是紧凑的 JSON：`plans` 返回 `{"plans":[{"planId","version","nodes","ready","executed"}]}`，`plan` 返回 `{"graph":{"planId","version","waves","nodes":[{"id","kind","needs","status","attempt","recoveryState","basis"}],"runs":[{"runId","stopReason"}]}}`，`node` 返回 `{"node":{…, "output", "childSession", "detail"}}`；缺少参数、计划未知或节点未知时，会返回指明问题的工具错误。

##### 该字段的原文

```markdown
Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state), the waves of nodes that can run together, and its runs. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 170 个 token。每次调用增加一个与计划大小成比例的工具结果（每个节点约 25 个 token），外加被查询节点的输出。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后、只追加的工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **没有证据图**——声明、引用与历史查找不属于本包。
- **没有 Web 卡片**——待处理卡片使用通用的 host 呈现器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
