---
description: "按 turn 与 goal（目标）限制步数、token、美元花费与墙钟时间，超限时停止 turn 并暂停 goal，并可选工作量下限；shadow 模式只记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loop-budget

[English](README.md) | 中文

## 概述

本包约束一个 turn 与一个活跃 goal：已开始的 step、provider 报告的 token、经配置价格表折算的美元花费，以及墙钟时间，并把首个触发的限额记录为 `loop/budget` 事件。在 `enforce` 模式下，turn 级限额会拒绝下一个 step（该 turn 以 `blocked` 结束）；goal 级限额会暂停该 goal，若最近一次 `loop/verdict` 为 `ok` 且此后未开始过 step，则改为完成它。可选的工作量下限会在每个 turn 至多引导模型一次，当该 turn 即将在未达到配置下限时结束。`shadow` 模式只记录它本来会做什么。实验性，不承诺稳定性。

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

在组合中挂载本插件，设置 `turn`、`goal` 或 `floor` 限额；当任意 `maxUsd` 限额大于 0 时设置 `prices`。

### 何时选择

当一个 turn 或 goal 在步数、token、花费或墙钟时间上可能失控、又没有确定性的停止信号时，或者当一个 turn 往往在完成太少工作时就结束时，选择它。先用 `shadow` 模式测量触发情况，再切换到 `enforce`。goal 级限额需要挂载 `@deepseek-ai/dsh-goal`；goal 的完成判定还需要挂载 `@deepseek-ai/dsh-experimental-verifier-gate` 并上报 `loop/verdict`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-loop-budget'
  config:
    mode: shadow
    assumption: the model does not stop spending on a turn or goal by itself
    turn: { maxSteps: 64 }
    goal: { maxUsd: 5 }
    prices:
      - { provider: deepseek, model: deepseek-chat, inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 }
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 只记录；`enforce` 会拒绝 step、暂停或完成 goal，并为下限引导 |
| `assumption` | 非 `off` 时必填 | 本预算所编码的、关于模型的假设；空白值会使加载失败 |
| `turn.maxSteps` / `maxTokens` / `maxUsd` | `0`（关闭） | 每次 turn 开始时重置的限额 |
| `turn.maxWallMs` | `900000`（15 分钟） | 一个 turn 的墙钟限额，每次 turn 开始时重置；设为 `0` 关闭 |
| `goal.maxSteps` / `maxTokens` / `maxUsd` | `0`（关闭） | 在一个 goal 保持活跃期间累积的限额；恢复的 goal 会重新开始累积 |
| `goal.maxWallMs` | `3600000`（1 小时） | 一个 goal 保持活跃期间累积的墙钟限额；设为 `0` 关闭 |
| `floor.minSteps` / `floor.minTokens` | `0`（关闭） | turn 结束前必须达到的工作量；每个 turn 至多引导一次 |
| `prices[]` | `[]` | 每个精确 `provider`/`model` 路由的每百万 token 美元价格；当任意 `maxUsd` 大于 0 时必填 |

以下情况加载会以 `loop-budget:` 错误失败：`assumption` 为空白；某个计数不是非负整数；某个金额为负数或非有限数；两条价格记录命名了同一路由；设置了 `maxUsd` 却没有 `prices`。当带价格的限额遇到没有价格记录的路由时，该 turn 会以同样的前缀失败。

### 你会得到什么

在每个 step 边界，插件先检查 turn 的累加器，再检查被跟踪的活跃 goal 的累加器（如果有的话），并把首个触发的限额按每个 `(scope, turn 或 goal, kind)` 只记录一次，写成 `loop/budget` 会话事件，携带 turn、拟议的 step、模式、scope（`turn` 或 `goal`）、kind（`steps`、`tokens`、`usd` 或 `wallMs`）、已用量、配置的限额、动作（`stopped`、`paused`、`completed` 或 `floor-steer`）、插件是否已生效、会话的 `root`/`subagent` 归属，以及被跟踪的 goal id（如果有的话）。在 `enforce` 模式下，触发会拒绝拟议的 step，使 turn 以 `blocked` 结束；goal 级触发则改为暂停活跃 goal，除非最近一次 `loop/verdict` 为 `ok` 且此后未开始过 step，此时改为完成该 goal——并且 goal 级触发从不拒绝接纳了人类消息的 step。当设置了 `floor.minSteps` 或 `floor.minTokens`、且该 turn 的结束边界尚无其他监听器已经引导过时，即将在未达下限时结束的 turn 会获得一次工作量下限引导，而不是直接结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件把 `turn/start`、`step/start`、`assistant/message`、`assistant/attempt` 与 `loop/verdict` 会话事件折叠进保存在 `WeakMap<Session, SessionBudget>` 中的按会话累加器。step 数来自循环自身的 step 编号（`agent/pre-step` 处为 `step - 1`，`agent/turn-stopping` 处为最后一个已开始的 step）；token 与美元来自每次已结算模型流的 `usage` chunk，包括失败的 `assistant/attempt`，并按 `request/header` 中精确的 `provider`/`model` 路由定价；墙钟时间来自 turn 的开始时间，或来自本进程首次跟踪到活跃 goal 的时刻。`agent/pre-step` 在每个 step 之前检查累加器，触发时在 `enforce` 模式下拒绝该 step；`agent/turn-stopping` 检查工作量下限，不足时引导。

### 设计说明

- **判定先于预算。** 仅当最近一次 `loop/verdict` 为 `ok` 且此后未开始过 step 时，goal 级触发才会完成 goal 而不是暂停它——门控的判定比预算更新。
- **goal 级限额从不阻塞人类。** scope 为 `goal` 的触发仍会接纳携带 source kind 为 `user` 消息的 step；只有 `turn` 级限额会无条件拒绝。
- **不复用 token-meter。** `ctx.tokenMeter` 衡量的是下一次调用的请求塑形压力，而非花费；本插件改为读取每次已结算流的 `usage` chunk，因为失败的尝试依然消耗 token。
- **没有内置价格表。** dsh 自身没有美元定价；`prices[]` 是部署方声明的配置，在加载时校验，带价格的限额遇到不匹配的路由时会在最早可判定处（下一次 `agent/pre-step`）让该 turn 响亮失败。
- **下限会让位于其他引导。** 它会先检查 `agent.inbox.nextStep`，因此从不会与在同一边界已经反对过的其他监听器（例如 `verifier-gate`）相争；组合应把 `verifier-gate` 排在 `loop-budget` 之前。
- **累加器是进程内状态，不是派生历史。** `loop/budget` 只进日志，并在 `SessionEventMap` 中声明为读取时必需；只有下限引导（一条独立的 `user/message` 事件）对模型可见。
- **不变量伴随插件。** `./invariant` 检查每个 turn 级、kind 为 `steps` 的 `loop/budget` 是否恰好报告了其 turn 目前已记录的 `step/start` 事件数。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、累加器折叠、pre-step 与 turn-stopping 监听器 |
| [`src/types.ts`](src/types.ts) | `loop/budget` 会话事件声明及其载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 针对 turn 级 step 计数的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统参考](../../../docs/subsystems/core.zh.md)——本预算消费的 `agent/pre-step` 与 `agent/turn-stopping` 事件。
- [Goal 包](../../goal/goal/README.zh.md)——goal 级限额驱动的 `pause`/`complete` 操作。
- [Verifier gate](../verifier-gate/README.zh.md)——决定 `paused` 还是 `completed` 的 `loop/verdict` 事件。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 工作量下限引导

#### 模型看到什么

仅在 `enforce` 模式下，每个 turn 至多一次，当该 turn 即将在未达到 `floor.minSteps` 或 `floor.minTokens` 时结束、且该边界尚无其他监听器引导过时，模型会收到一条 `notice` 形式的 user 消息：

##### 该字段的原文

```markdown
Work floor not reached for this turn: <used> of <limit> <steps|tokens>.
Before finishing, do adjacent useful work on the same request, such as verifying the change or covering a case you have not checked, then finish.
```

#### Token 影响

未配置下限时、`shadow` 模式下，以及每次限额触发时（触发会拒绝该 step，不发送任何内容），均为零 token。每次下限引导增加一条约 45 token 的保留消息。

#### KV Cache 影响

只追加：引导是位于可复用请求前缀之后的一条新的末尾 user 消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **累加器只在内存中**——恢复的会话会重新开始每个累加器，且 goal 的墙钟限额是从本进程首次看到该 goal 活跃时开始计算，而不是从 goal 最初创建时开始。
- **美元需要价格表**——dsh 没有内置的 provider 定价；每个带价格的路由都必须出现在 `prices[]` 中。
- **goal 的完成依赖 `verifier-gate`**——若没有挂载上报 `loop/verdict` 的 verifier，goal 级限额永远不会完成 goal，只会暂停它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
