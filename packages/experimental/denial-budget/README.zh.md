---
description: "统计被策略拒绝的工具调用，附加固定的“更安全做法”提示，并在 agent（智能体）超出拒绝预算继续运行前请求批准；shadow 模式只记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-denial-budget

[English](README.md) | 中文

## 概述

本包统计被策略拒绝的工具调用：guard、`tools/pre-execute` 的 deny，或未获授予的批准。在 `enforce` 模式下，它会在每个被拒绝的结果后追加一句固定的话，告诉模型换一种更安全的做法；当拒绝次数达到配置的预算时，它会在 agent 继续之前请求人类批准；未获授予时 turn 以 `blocked` 结束，活动中的 goal 被阻塞。在 `shadow` 模式下，它只记录本来会做什么。每次计数与决定都是一个会话事件。本包是实验性的，不承诺稳定性。

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

在带有工具策略（guard、`tools/pre-execute` 监听器或需要批准的工具）的组合中挂载本插件。当需要由人类决定 agent 是否在超出预算后继续时，同时挂载带有应答方的 `@deepseek-ai/dsh-user-approval`。

### 何时选择

当模型不断重试被策略拒绝的动作、而不是换一种做法时，选择它。先用 `shadow` 模式测量预算会被触发的频率，再切换到 `enforce`。在拒绝属于预期且无害的无头部署中请不要使用 `enforce`，因为没有批准应答方时，每次触发都会结束 turn。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-denial-budget'
  config:
    mode: shadow
    assumption: the model retries denied actions instead of changing approach
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 只记录；`enforce` 追加提示、请求批准并停止 |
| `assumption` | 非 `off` 时必填 | 本预算所编码的、关于模型的假设；空白值会使加载失败 |
| `maxConsecutive` | `3` | 触发预算的连续被拒绝调用数 |
| `maxTotal` | `20` | 触发预算的、自上一条人类消息以来的被拒绝调用总数 |

当 `assumption` 为空白，或某个计数不是不小于 1 的整数时，加载会以 `denial-budget:` 错误失败。

### 你会得到什么

每个被拒绝的调用追加一个决定为 `counted` 的 `loop/denial` 会话事件，内容包括 turn、模式、被拒绝的工具名与调用 id、连续计数和总计数。被允许的调用会重置连续计数；新的人类消息会重置两个计数。任一计数达到上限时，下一个 step 边界会再记录一条 `loop/denial`。在 `enforce` 模式下，插件先调用 `ctx.approval.request()`：`allowed-once` 记录 `approved`、重置计数并让 step 运行；其他任何结果记录带该结果的 `stopped`，reject 该 step 使 turn 以 `blocked` 结束，并以代码 `denial-budget` 阻塞活动中的 goal。在 `shadow` 模式下，插件以 `applied: false` 记录 `stopped`，重置计数并让 step 运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

注册表把每一次策略拒绝都变成一个失败结果，它到达 `tools/post-execute` 与 `tools/result`，但从不进入 `tools/execute`。插件在 `WeakSet` 中标记每个进入其 `tools/execute` 监听器的执行；当某个失败结果的执行从未被标记、且错误代码不是 `ABORTED_BEFORE_DISPATCH` 时，将其视为一次拒绝。计数保存在 `WeakMap<Session, DenialCount>` 中；一个 `session/event` 监听器从 `turn/start` 记录当前 turn。预算决定在 `agent/pre-step` 中执行，这是插件唯一能在不取消 turn 的情况下结束 turn 的位置。

### 设计说明

- **什么算作拒绝。** `tools/pre-execute` 的 deny、批准未授予的 `ask`（`rejected`、被应答方 `cancelled`、`unavailable` 或没有批准服务），以及 `ToolGuard` 给出的理由都计数。工具体自身的失败、经由派发到达的未知工具、对已派发调用的 post-execute block，以及派发前的取消都不计数。没有 agent 的调用会被忽略。
- **在 `tools/result` 计数。** `tools/result` 是每个监听器都会收到的 emit 事件。`tools/pre-execute` 监听器看不到 guard 拒绝、批准结果，也看不到排在它前面、且不调用 `next()` 的监听器给出的拒绝。
- **提示保留原始理由。** 在 `enforce` 模式下，post-execute 监听器把固定句子追加在注册表的 `Error: <reason>` 文本之后，因此模型仍能知道被拒绝的是什么。该句子从不说明如何关闭策略或预算。下游 post-execute 对拒绝结果的 `block` 保持不变。
- **触发时总是请求批准。** 没有无头标志；批准失败即关闭。未挂载批准服务，或服务没有应答方，都得到 `unavailable`，从而停止 turn。
- **记录只进日志。** `loop/denial` 在 `SessionEventMap` 中声明、读取时必需，且从不进入派生历史；只有追加的提示对模型可见，作为普通工具结果的一部分。
- **不变量伴随插件。** `./invariant` 检查每个决定为 `approved` 的 `loop/denial` 之前，都有一个在该会话最近一次 `counted` 拒绝之后记录的、结果为 `allowed-once` 的 `approval/decided` 事件。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、工具管线与 pre-step 监听器、`DENIAL_ADVICE` |
| [`src/types.ts`](src/types.ts) | `loop/denial` 会话事件声明及其载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 针对 approved 决定及其批准审计的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统参考](../../../docs/subsystems/core.zh.md)——本预算消费的 `tools/*` 管线与 `agent/pre-step` 事件。
- [用户批准包](../../interaction/user-approval/README.zh.md)——决定 agent 是否在超出预算后继续的批准接缝。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 被拒绝工具调用上的提示

#### 模型看到什么

仅在 `enforce` 模式下，每个被策略阶段拒绝的工具结果都保留原来的 `Error: <reason>` 文本，并多出一个文本块：

##### 该字段的原文

```markdown
Take a safer approach; do not retry this exact action or work around the denial.
```

#### Token 影响

`enforce` 模式下每个被拒绝的调用约 20 个 token；`shadow` 模式下为零。触发预算不增加任何模型可见内容：批准问题发给人类应答方，停止则 reject 该 step。

#### KV Cache 影响

只追加：提示是位于可复用请求前缀之后的新工具结果的一部分。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **计数只在内存中**——恢复的会话从零开始计数。
- **批准问题以工具为范围**——`@deepseek-ai/dsh-user-approval` 针对单个工具提问，因此升级问题在 `approval/asked` 中写出的是最近一次被拒绝的工具与调用，而不是 turn 的继续。以继续为范围的批准请求需要修改发布版批准包。
- **`run_code` 内的子派发拒绝也计数**——嵌套调用携带父调用的 agent，因此其拒绝计入同一预算。
- **策略管线之前的失败会计数但没有提示**——在 `tools/pre-execute` 运行之前就失败的调用，例如直接调用被 `ptc` 呈现模式保留给 `run_code` 的工具，会被计为拒绝，但会跳过 `tools/post-execute`，因此其结果不带提示。
- **外围派发包装器可能隐藏一次派发**——排在本插件之前、不调用 `next()` 就返回失败结果的 `tools/execute` 监听器，会让该调用被计为拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
