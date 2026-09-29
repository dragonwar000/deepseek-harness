---
description: "当 agent（智能体）的工具 step 反复返回相同结果时提醒或停止它；shadow 模式只记录判定，不采取行动。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-stationarity-guard

[English](README.md) | 中文

## 概述

本包检测反复运行相同工具调用并得到相同结果的 agent。每个工具 step 之后，它计算该 step 的调用与结果签名，统计该签名自上一条人类消息以来出现的次数，并统计连续没有产生任何新内容的只读 step 数。在 `enforce` 模式下，签名达到提醒阈值时它添加一条提醒，计数达到停止阈值时它结束 turn；在 `shadow` 模式下，它只记录本来会做什么。本包是实验性的，不承诺稳定性。

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

在具有 `tools` 注册表和 agent loop 的组合中挂载本插件。

### 何时选择

当 agent 把 step 和 token 花在结果不再变化的重复工具调用上时选择它，包括连续重复检测器发现不了的交替模式，例如 A、B、A、B。先用 `shadow` 模式测量护栏会采取行动的频率，再切换到 `enforce`。当某个工作流需要合理地轮询工具直到结果变化时请不要选择，因为结果不变的轮询会被计为重复。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-stationarity-guard'
  config:
    mode: shadow
    assumption: the model repeats tool calls that return identical results
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 只记录判定；`enforce` 会提醒并停止 |
| `assumption` | 非 `off` 时必填 | 本护栏所编码的、关于模型的假设；空白值会使加载失败 |
| `remindAt.sideEffect` / `remindAt.readOnly` | `4` / `8` | 同一 step 签名出现多少次时添加一条提醒 |
| `stopAt.sideEffect` / `stopAt.readOnly` | `8` / `12` | 同一 step 签名出现多少次时停止 turn |
| `noopStopAt` | `4` | 连续多少个没有新调用/结果对的只读 step 会停止 turn |

以下情况加载会以 `stationarity-guard:` 错误失败：`assumption` 为空白；某个阈值不是不小于 2 的整数；某一层级的 `remindAt` 不小于其 `stopAt`。

### 你会得到什么

在达到阈值的工具 step 之后的 step 边界，护栏追加一个 `loop/stationarity` 会话事件，内容包括被判定的 turn 与 step、模式、step 签名、层级（`sideEffect` 或 `readOnly`）、签名出现次数、只读无进展连续数、动作（`remind` 或 `stop`）、原因（`repeat` 或 `noop`），以及护栏是否实际采取了行动。在 `enforce` 模式下，`remind` 会把一条 source kind 为 `stationarity-guard` 的 `notice` 形式 user 消息加入下一个 step 的输入；`stop` 会拒绝下一个 step，于是 turn 以 `turn/end` 原因 `blocked` 结束，活动中的会话 goal 以代码 `stationary` 被阻塞。新的人类消息会重置所有计数。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

一个 `session/event` 监听器把会话日志中的 `step/start`、`tool/call`、`tool/result` 与 `step/end` 折叠成每个发起过工具调用的已完成 step 的一个批次；折叠状态保存在 `WeakMap<Session, SessionFold>` 中，且该监听器从不追加事件。一个 `agent/pre-step` 监听器在下一个 step 边界判定待处理的批次：它确定层级，更新签名计数与证据账本，达到阈值时追加 `loop/stationarity`，然后要么调用 `next()`，要么把提醒追加到下游的 `enter` 决定中，要么返回 `{ kind: 'reject' }`。

### 设计说明

- **一个签名同时覆盖调用与证据。** 签名是该 step 已排序的（工具名、按键排序的参数、结果哈希）三元组的 sha256，因此重新排列并行调用不算进展，而测试输出发生变化的“修改后测试”循环也不会被计为重复。
- **重复不要求相邻。** 计数按签名从上一条人类消息起累积，因此 A、B、A、B 模式也会达到阈值。
- **层级来自工具注册表。** 只有当 `ctx.tools.executionMode()` 对每个调用都返回 `parallel` 时，step 才是 `readOnly`；任何独占调用都会让它成为 `sideEffect`。
- **折叠读取日志，而不是工具管线。** `tools/result` 不携带 turn 或 step，因此护栏改为读取 `tool/call`、`tool/result` 与 `step/end` 会话事件。
- **停止就是被拒绝的 step。** 拒绝 `agent/pre-step` 会让 agent-loop 以 `blocked` 结束 turn；护栏还会以代码 `stationary` 阻塞活动中的 goal，并且不新增 turn 结束原因。
- **只有人类输入会重置。** 输入中包含 source kind 为 `user` 的消息的 step 会清空所有计数；goal 轮次、引导以及护栏自己的提醒都不会。
- **提醒从不说明如何关闭护栏。**
- **在 `enforce` 模式下接替 `repeat-tool-reminder`。** 本护栏处于 `shadow` 模式时，组合保持 `@deepseek-ai/dsh-repeat-tool-reminder` 运行；在把本护栏切换到 `enforce` 的同一个 profile 补丁中将其禁用。
- **不变量伴随插件。** `./invariant` 检查在一次实际生效的 `stop` 之后，会话的下一个 `step/start` 或 `turn/end` 必须是原因为 `blocked`、`aborted` 或 `error` 的 `turn/end`。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、会话事件折叠、pre-step 监听器 |
| [`src/types.ts`](src/types.ts) | `loop/stationarity` 会话事件声明及其载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 针对实际生效的停止及其后续 turn 结束的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统参考](../../../docs/subsystems/core.zh.md)——本护栏消费的 `agent/pre-step` 与 `session/event` 事件。
- [Tools 包](../../core/tools/README.zh.md)——`executionMode()` 以及层级背后的并发安全分类。
- [Goal 包](../../goal/goal/README.zh.md)——护栏在停止时阻塞的 goal 生命周期。
- [Repeat-tool-reminder 包](../../guard/repeat-tool-reminder/README.zh.md)——本护栏在 `enforce` 模式下取代的连续重复提醒。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 重复 step 之后的提醒

#### 模型看到什么

仅在 `enforce` 模式下，某个 step 的签名达到其层级的 `remindAt` 之后，在随后的 step 边界，模型会收到一条追加到该 step 输入中的 `notice` 形式 user 消息：

##### 该字段的原文

```markdown
Stationarity check: this exact set of tool calls has now returned identical results <repeats> times since the last user message.
Repeating it will not produce new information. Inspect the latest results, then take a different action or finish with the evidence you already have.
```

#### Token 影响

`shadow` 模式下以及低于 `remindAt` 的 step 均为零 token。每条提醒增加一条约 60 token 的保留消息。停止不发送任何内容：该 step 被拒绝，turn 结束。

#### KV Cache 影响

只追加：提醒加入新 step 位于可复用请求前缀之后的末尾 user 输入；更早的内容都不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **计数只在内存中**——恢复的会话从零重新开始计数。
- **`run_code` 内的子调度不参与折叠**——只有根 `tool/call` 事件进入签名；PTC 子调度记录为 `tool/ptc-dispatch`，不被计数。
- **`shadow` 期间存在两个重复检测器**——`repeat-tool-reminder` 仍会提醒，而 `stationarity-guard` 只记录 `loop/stationarity`；把本护栏切换到 `enforce` 却未禁用该提醒，模型可能对同一个循环收到两条提醒。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
