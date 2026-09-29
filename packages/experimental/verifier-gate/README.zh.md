---
description: "在 agent（智能体）turn 结束前运行测试套件等 verify 命令，命令失败时引导模型继续工作；shadow 模式只记录判定，不做引导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-verifier-gate

[English](README.md) | 中文

## 概述

本包在 turn 结束前检查 agent 的工作。它运行你配置的 verify 命令（例如测试套件），并把每次判定记录到会话日志。在 `enforce` 模式下，失败的命令会把命令本身与输出尾部交给模型，让它继续工作，每个 turn 有次数上限；在 `shadow` 模式下，本门控只记录它本来会做什么。每个 turn 边界的每次检查都消耗一次 shell 运行。本包是实验性的，不承诺稳定性。

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

在组合中把本插件挂载在 `shell` 提供者之后，并列出 turn 结束前必须通过的命令。

### 何时选择

当一个确定性命令能判断 agent 的工作是否完成、而模型往往过早宣布完成时，选择它。先用 `shadow` 模式测量门控会反对的频率，再切换到 `enforce`。当不存在快速、确定性的检查时请不要选择，因为每个 turn 边界都会依次运行命令，直到有一个失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-verifier-gate'
  config:
    mode: shadow
    assumption: the model declares a task done before its tests pass
    verify:
      commands: [pnpm test]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 只记录判定；`enforce` 在命令失败后还会引导 |
| `assumption` | 非 `off` 时必填 | 本门控所编码的、关于模型的假设；空白值会使加载失败 |
| `verify.commands` | `[]` | 每个 turn 边界按顺序运行的命令；第一个失败的命令终止本轮运行 |
| `verify.timeoutMs` | `300000` | 交给 shell 提供者的单条命令超时 |
| `verify.stdoutTailChars` | `2000` | 判定与引导中保留的 stdout 与 stderr 尾部字符数 |
| `blankResponse.maxSteers` | `1` | 回复既无工具调用也无可见文本（只有推理或空文本）时，每个 turn 的引导次数上限；`0` 关闭该检查。每次引导也消耗一次续跑 |
| `maxContinuations` | `8` | 每个 turn 的引导次数上限，超过后门控记录 `budget-exhausted` 并让 turn 结束 |

以下情况加载会以 `verifier-gate:` 错误失败：`assumption` 为空白；`maxContinuations` 不是不小于 0 的整数；`verify.timeoutMs` 或 `verify.stdoutTailChars` 不是不小于 1 的整数；`verify.commands` 非空但没有挂载 `shell` 服务。

### 你会得到什么

每个 turn 边界追加一个 `loop/verdict` 会话事件，内容包括 turn 编号、模式、判定（`ok`、`not-ok` 或 `skipped`）、原因（`all-passed`、`command-failed`、`budget-exhausted`、`no-commands` 或 `blank-response`）、已运行的检查及其退出码与输出尾部、本 turn 已用的续跑次数，以及本次判定是否引导了 agent。在 `enforce` 模式下，预算未用尽的 `not-ok` 判定会以 source kind 为 `verifier-gate` 的 `notice` 形式 user 消息引导 agent；下一个 step 运行后，门控再判定新的边界。新的人类消息会重置每个 turn 的预算。在 `enforce` 模式下，预算用尽且会话存在 active goal 时，门控还会以代码 `verifier-budget-exhausted` 阻塞该 goal，使 goal 轮次停止，而不是再次进入同一个失败检查。运行任何命令之前，门控会检查即将结束 turn 的回复；若它既无工具调用也无可见文本，`enforce` 模式会（默认一次）以固定通知引导，并且在该边界不运行任何命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

门控监听 `agent/turn-stopping`；agent-loop 只在 step 完成且没有待处理引导时才 await 该事件。它以 turn 的中止信号通过 `ShellExecutor.resolve()` 与 `execute()` 运行配置的命令，追加 `loop/verdict`，并在反对时调用 `agent.steer()`。随后循环重新读取收件箱并运行下一个 step。每个 turn 的续跑计数保存在以 turn 编号区分的 `WeakMap<Agent, Budget>` 中；当某个 step 接纳了 source kind 为 `user` 的消息时，`agent/pre-step` 监听器会丢弃该计数。

### 设计说明

- **没有失败 step 守卫。** 抛出异常的 step 会在 `agent/turn-stopping` 运行之前以 `turn/end` 原因 `error` 关闭 turn，因此门控从不判定失败的 step。
- **不放行失败。** 失败、超时或被信号杀死的命令都是 `not-ok`。shell 基础设施故障，或加载后消失的 `shell` 服务，会让监听器 reject，并以原因 `error` 结束 turn。
- **引导从不说明如何关闭门控。** 它只写出失败的命令、退出状态与输出尾部。
- **判定只进日志。** `loop/verdict` 在 `SessionEventMap` 中声明、读取时必需，且从不进入派生历史；只有引导消息对模型可见。
- **不变量伴随插件。** `./invariant` 检查每个 `continued: true` 的 `loop/verdict` 之后，在其 turn 以 `completed` 或 `max-tokens` 结束前，都有一条 `verifier-gate` user 消息；被中止、出错或被阻塞的 turn 可以丢弃待处理的引导。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。
- **空白回复才是可达的空转情形。** 没有任何内容块的完成永远不会到达门控：两个 DeepSeek 适配器都把它归类为 `EMPTY_RESPONSE`，由重试策略重复请求，否则 turn 以错误结束。门控处理剩下的情形，即只有推理或空白文本的已完成回复，其状态由 `assistant/message` 事件折叠得到。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、turn-stopping 与 pre-step 监听器 |
| [`src/types.ts`](src/types.ts) | `loop/verdict` 会话事件声明及其载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 针对续跑判定及其引导的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统参考](../../../docs/subsystems/core.zh.md)——本门控消费的 `agent/turn-stopping` 与 `agent/pre-step` 事件。
- [Shell 包](../../shell/shell/README.zh.md)——运行 verify 命令的执行器契约。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 验证命令失败后的引导

#### 模型看到什么

仅在 `enforce` 模式下，某条 verify 命令失败后，每个 turn 至多 `maxContinuations` 次，模型会收到一条 `notice` 形式的 user 消息，文本如下。`<exit>` 是退出码或 `signal`；只有执行器的截止时间截断了命令时才出现 `, timed out`。

##### 该字段的原文

```markdown
verify command failed (exit <exit>[, timed out]): <command>
Output tail:
<last stdoutTailChars characters of stdout, a newline, and stderr>
Fix the cause, rerun the failing check yourself, and only then finish.
```

#### Token 影响

所有检查通过时、`shadow` 模式下以及预算用尽后，均为零 token。每次引导增加一条保留的消息，长度受 `stdoutTailChars` 约束，另加命令本身与约 120 个字符的固定文本。

#### KV Cache 影响

只追加：引导是位于可复用请求前缀之后的一条新的末尾 user 消息，门控不改变任何更早的请求内容。

### 空白回复后的引导

#### 模型看到什么

仅在 `enforce` 模式下，当将要结束 turn 的回复既无工具调用也无可见文本时，每个 turn 至多 `blankResponse.maxSteers` 次，模型会收到一条 `notice` 形式的 user 消息，内容如下：

##### 该字段的原文

```markdown
Your last response had no visible text and no tool call, so this turn cannot end on it.
Continue the task: take the next action with a tool call, or state the result in text.
```

#### Token 影响

在 `shadow` 模式、`maxSteers: 0` 以及有可见文本或工具调用的回复中为零。每次引导增加一条约 35 个 token 的保留消息。

#### KV Cache 影响

仅追加：引导是可复用请求前缀之后的新尾部 user 消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **没有证据检查**——最终 assistant 消息中的声明不会与工具结果比对；只有配置的命令做决定。
- **预算用尽时 turn 正常结束**——`budget-exhausted` 之后 turn 以 `completed` 结束；在 `enforce` 模式下 active goal 变为 `blocked`（代码 `verifier-budget-exhausted`），paused goal 保持不变，`shadow` 模式从不改变 goal。
- **自身没有沙箱**——verify 命令运行在挂载的 `shell` 提供者所施加的任何策略之下。
- **预算只在内存中**——恢复的会话以全新的续跑计数开始。
- **空白回复计数只在内存中**——与续跑预算相同，恢复的会话从零开始计数空白回复引导。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
