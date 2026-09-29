---
description: "在前台运行已准入的 dsh-graph/v1 计划：每个节点一个新子代理、基于证据的完成、重试、从会话日志恢复、人工关口与写入范围约束。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-runner

[English](README.md) | 中文

## 概述

本包注册 `graph_run` 工具，它执行某个 `dsh-graph/v1` 计划的最新准入版本并等待其结束。每个代理节点作为带有其声明工具与输出 schema 的新子代理运行；锚点与 verify 命令经过 shell 接缝运行；人工关口询问用户。节点只有带证据时才算 `executed`，循环边会重新运行其循环体，直到 `until` 通过。每次状态变化与循环决策都是一个会话事件，因此之后的调用能从日志恢复。`enforce` 拒绝节点在其写入范围之外的写入；`shadow` 记录它们。本包是实验性的。

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

在 `@deepseek-ai/dsh-experimental-graph-contract`（准入计划并把它们记录为 `graph/plan` 事件）与 `@deepseek-ai/dsh-experimental-graph-projection`（折叠运行器的记录）之后挂载本插件。组合还需要 `ctx.subagents` 以及一个支持工具过滤与输出 schema 的提供方（进程内的 `spawn` 提供方支持），用于锚点与 verify 命令的 shell 接缝，以及计划使用人工关口时带有应答方的 `@deepseek-ai/dsh-user-approval`。`@deepseek-ai/dsh-experimental-loop-graph-profile` 组合包以 `shadow` 模式挂载它。

### 何时选择

当模型需要执行一个多单元计划，而各单元不得自行认证自己的工作时，选择它：每个单元只带着自己的简报与工具运行，完成需要一个通过的命令、一个独立的验证节点或一个人。先以 `shadow` 模式启动，在拒绝之前度量写入范围违规。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-contract'
  config:
    mode: enforce
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
- name: '@deepseek-ai/dsh-experimental-graph-projection'
- name: '@deepseek-ai/dsh-experimental-graph-runner'
  config:
    mode: shadow
    assumption: node agents report completion without proof unless a verifier or a command confirms it
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 记录节点范围之外的写入；`enforce` 拒绝它们 |
| `assumption` | 非 `off` 时必填 | 本运行器所编码的、关于模型的假设；空白值会使加载失败 |
| `provider` | `spawn` | 代理节点使用的子代理提供方；它必须支持工具过滤与输出 schema |
| `maxConcurrent` | `2` | 同时运行的节点数 |
| `maxDispatches` | `0` | 每次运行的代理节点派发数；`0` 表示不限 |
| `maxWallMs` | `0` | 每次运行的墙钟时间；`0` 表示不限 |
| `maxPlanVersions` | `8` | 可以运行的最高计划版本 |
| `verifyTimeoutMs` | `300000` | 每条 verify 命令的超时 |
| `outputTailChars` | `2000` | 每次检查保留的命令输出 |
| `humanTimeoutMs` | `0` | 人工关口超时；`0` 表示一直等到运行停止 |

当 `assumption` 或 `provider` 为空白，或某个计数不是范围内的整数（`maxConcurrent`、`maxPlanVersions`、`verifyTimeoutMs` 与 `outputTailChars` 至少为 1；其他至少为 0）时，加载会以 `graph-runner:` 错误失败。

### 你会得到什么

每次调用返回停止原因及其固定指引，每个节点的状态、依据、尝试次数与原因，以及 `synthesis` 与 `stop_handoff` 节点的输出。停止原因如下：

| 停止原因 | 含义 |
|---|---|
| `GOAL_MET` | 每个节点都带证据完成，或是最终报告 |
| `NO_FURTHER_WORK` | 没有节点能运行：某个未验证的结果需要验证节点或 verify 命令，或某个节点在等待一个未完成的节点 |
| `NO_PROGRESS` | 某个节点在重试后失败，其依赖节点被跳过；用 `graph_audit` 审计修正后的版本 |
| `BUDGET` | `maxDispatches` 或 `maxWallMs` 停止了派发；再次调用 `graph_run` 从记录的状态继续 |
| `HUMAN_STOPPED` | 某个人工关口未被批准，或运行被取消 |
| `ADMISSION_REFUSED` | 计划没有准入版本，或准入版本无法排序 |
| `MAX_ROUNDS` | 准入版本超过 `maxPlanVersions` |

节点状态带有依据：

| 依据 | 何时给出 |
|---|---|
| `predicate` | 节点的 verify 命令以 0 退出（锚点，或带 `verify` 的代理节点） |
| `verifier` | 某个验证节点跨 `verifies` 边为它返回 verdict `pass`，或验证节点本身在没有 verify 命令时通过 |
| `human` | 其 `human_gate` 以 `allowed-once` 被批准 |
| `agentReported` | 子代理以符合 schema 的输出完成，但没有任何东西证明它；节点保持 `unverified` |
| `sessionExited` | 上一次运行在节点处于 `running` 时结束；节点变为 `failed_retryable` |

need 在它为 `executed`、带 `mayFail` 的 `failed`（此时绑定收到其 `fallback`），或跨 `verifies` 边的 `unverified` 时被满足。新的准入版本会携带被替换版本中指纹（节点本身及其 needs 的指纹）未变的已执行节点；之前存在但指纹改变的节点会以恢复状态 `patched` 重新运行。

**循环。** 当 `cycleGuard` 边的 `from` 节点变为 `executed` 时，runner 针对该节点的这次迭代对边决策一次，并记录一个 `graph/edge` 事件：`until` 命令以 0 退出 ⇒ `until-met`；已用完 `maxIterations` 次触发 ⇒ `exhausted`；`metricCommand` 的值在 `plateauAfter` 次决策中保持不变 ⇒ `plateau`；否则 ⇒ `fired`。一次触发会把循环体（`cycleBody`）的每个节点以 `pending`、attempt 0 和下一个 `iteration` 重新打开，循环目标的下一份简报会带上按边的 `allowedFields` 限定的 `from` 输出。需要 `from` 节点的节点会等待决策记录完成。在决策之前停止的运行会在下一次运行开始时补做决策；`until-met`、`exhausted` 与 `plateau` 结束循环而不让节点失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`graph_run` 从 `graphPlans` 投影读取最新准入版本及其记录的路由，从 `graph` 投影读取节点状态，然后 `runGraph` 循环：它让超过 `retryBudget` 的节点失败，按计划顺序派发每个可派发节点直到 `maxConcurrent`，并等待一个运行中的节点结束。代理节点以 `ctx.subagents.start(provider, { prompt, parent, signal, toolFilter, outputSchema, agentOptions? })` 启动，并总是在 `finally` 中释放。已完成子代理的结构化输出先按节点 schema 校验，然后按顺序运行节点的 verify 命令，遇到第一次失败即停止。验证节点会裁决自身以及它所验证的每个 `unverified` 节点：`pass` 且命令通过会使它们变为 `executed`；其他情况使它们变为 `failed_retryable`。没有运行中的节点时，`NO_PROGRESS` 停止会先跳过每个 need 在无 `mayFail` 时失败或已被跳过的开放节点。

### 设计说明

- **前台运行，而不是后台作业。** 作业注册表在内存中且不可恢复，`ctx.approval.request()` 需要一个打开的回合，而作业完成以通知消息返回。运行占住调用它的工具调用，因此人工关口在调用方代理上询问，`exec.signal` 取消运行，会话日志是唯一的恢复状态。
- **用写入范围代替 worktree。** 子会话继承父会话的工作目录，一次性请求没有工作目录字段，因此 worktree 不会改变节点工具写入的位置。审计保持可一起运行的节点写入前缀互不相交，以 `{ prepend: true }` 注册的 `fs/write-intent` 与 `fs/edit-intent` 监听器检查被跟踪子代理的每次写入并总是调用 `next()`，不占用观察策略的决策槽。
- **`maxPlanVersions` 限制重新规划。** 目标轮次统计的是目标驱动的回合，而不是计划版本。
- **`maxConcurrent` 是唯一的并发上限。** `maxActiveSubagents` 只作用于可继续的子代理。
- **不按类型设置 persona。** 节点简报说明节点的角色；验证节点的简报还会加上要检查的产物、验收标准与 verdict 规则。更早的失败痕迹从不包含在内。
- **关口在调用方代理上询问。** 子代理会拒绝审批请求。请求指明 `graph_run` 与调用 id；`humanTimeoutMs` 限制等待；只有 `allowed-once` 表示批准。
- **路由来自日志。** 带类别的节点在准入版本记录的路由上运行；提供方必须支持 agent options。
- **不变量伴随插件。** `./invariant` 把每个 `graph/node`、`graph/run` 与 `graph/edge` 与其之前的 `graph` 投影比较：记录能折叠到前缀上，状态转换在 `NODE_TRANSITIONS` 中或该记录是一次重新打开（`pending`、attempt 0、下一个迭代、来自 `canReopen` 接受的状态、位于已触发循环的循环体内），修订号紧接上一个，从未运行的节点只有带 `carriedFrom` 才能变为 `executed`，`executed` 带有 `predicate`、`verifier` 或 `human` 依据，且输出符合节点的输出 schema。边决策要求其 `from` 节点在所记录的迭代处为 `executed` 且尚未决策、触发次数紧接上一次、恰在 `until` 检查通过时为 `until-met`、触发次数不超过 `maxIterations`，且只在最后一次触发之后为 `exhausted`。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 和 graph 投影一起挂载。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、fs 写入范围监听器与 `graph_run` 工具 |
| [`src/runner.ts`](src/runner.ts) | `runGraph`：调度、派发、裁决、重试、恢复、携带、循环决策与停止原因 |
| [`src/cycle.ts`](src/cycle.ts) | 纯循环辅助函数：指标读取、平台期规则与触发时回传的输出 |
| [`src/prompt.ts`](src/prompt.ts) | 节点简报 |
| [`src/write-scope.ts`](src/write-scope.ts) | 针对被跟踪子会话的写入范围检查 |
| [`src/invariant.ts`](src/invariant.ts) | 针对节点生命周期与循环决策记录的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Graph 契约包](../graph-contract/README.zh.md)——计划格式、审计、路由，以及 `graph/node` 与 `graph/run` 词汇。
- [Graph 投影包](../graph-projection/README.zh.md)——本运行器读取的任务图与 `graph_query`。
- [子代理包](../../subagent/subagent/README.zh.md)——启动每个节点的 `ctx.subagents` 接缝。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。
- [循环边说明](../../../.agents/notes/implemented/architecture/2026-09-30-graph-cycle-edges-reopen-loops.zh.md)——运行器如何对循环边决策并重新打开其循环体.

-----

<a id="model-experience"></a>
## 模型体验

### graph_run 工具

#### 模型看到什么

插件挂载时（除 `off` 外的任何模式），模型会得到 `graph_run`，它有必填的 `plan_id` 与可选的 `inputs` 对象，描述如下：

##### 该字段的原文

```markdown
Run the latest admitted version of one dsh-graph/v1 plan and wait for it to stop. Each agent node runs as a fresh subagent that sees only its instruction, its inputs, and its declared tools, and returns its declared output. Anchors and verify commands run as shell commands; a human_gate asks the user.

A node counts as executed only with proof: its verify commands passed, a verification node returned verdict "pass" for it, or the user granted its gate. A result without proof stays unverified. Failed nodes are retried up to their retryBudget. A loop edge runs its loop again when its from node finishes and its until command fails, at most maxIterations times; the reopened target sees the output the edge sends back.

The result names the stop reason and every node's status. After NO_PROGRESS, fix the plan and audit a new version with graph_audit; unchanged finished nodes are carried over. After BUDGET, call graph_run again to continue.
```

#### Token 影响

挂载期间始终生效：工具定义在调用方会话的每个请求中约占 270 个 token。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀。

### graph_run 结果

#### 模型看到什么

每次调用返回如下形式的文本；方括号部分按调用填充，没有数据的行会省略；`iteration` 只在循环重新打开节点之后出现。计划缺失、运行输入缺失或提供方不可用时，会返回指明问题的工具错误。

##### 该字段的原文

```markdown
graph_run: <STOP_REASON> — plan <id> — version <n> — run <run id>
<fixed guidance for the stop reason>
- <node>: <status> (<basis>), attempt <n>, iteration <k> — <reason>
result of <synthesis or stop_handoff node>: <JSON output>
```

#### Token 影响

每次运行增加一个工具结果，每个节点约 20 个 token，外加最终输出。

#### KV Cache 影响

只追加：每个结果都是位于可复用请求前缀之后的新工具结果。

### 节点简报

#### 模型看到什么

每个代理节点的子代理收到一条由 `nodePrompt` 构建的 user 消息：它的角色与计划、计划目标、它的指令、已解析的输入（缺失时为 `not provided`）、它的工具与写入限制，以及对验证节点而言要检查的产物、验收标准与 verdict 规则。在一次被中断的尝试之后，它还会收到中断说明；被触发的循环边重新打开的节点还会在其输入之后收到循环反馈，其中带有该边回传的输出（`from` 节点没有产出时为 `none`）。

##### 中断说明的原文

```markdown
A previous attempt of this node stopped before it finished; inspect the workspace for partial changes before acting.
```

##### 循环反馈的原文

```markdown
Loop feedback from <from> (fire <n>): <JSON output>
Revise your result using this feedback.
```

#### Token 影响

每个节点简报是其子会话的第一条消息，约 80 个 token，外加输入与验收标准；重新打开的节点的简报还会加上其循环边回传输出的长度。

#### KV Cache 影响

节点简报开启新的子会话，不触及调用方会话的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **shell 写入不受范围约束**——只有经过 fs 接缝的写入（`write`、`edit`）会经过写入意图检查；带 shell 工具的节点可以在其沙箱允许的任何位置写入；当部署在 `shellTools` 中列出该工具时，`graph_audit` 会以 `SHELL_WRITES_UNCHECKED` 发出警告。
- **循环退出不是失败**——`exhausted` 与 `plateau` 保留最后的结果；由下游验证决定它是否足够好。
- **循环护栏在每个节点中运行**——`verifier-gate` 等监听器也作用于子会话，因此根会话的 verify 命令也会在每个节点回合结束时运行。
- **只支持前台**——调用方回合会等待运行结束；后台运行延后实现。
- **每次运行没有 token 或 USD 预算**——子代理结果不带用量；`maxDispatches` 与 `maxWallMs` 限制一次运行。
- **没有 `any_of` 汇合**——节点等待它的所有 needs；`mayFail` 加 `fallback` 表达可能失败的分支。
- **没有 Web 卡片**——待处理卡片使用通用的 host 呈现器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
