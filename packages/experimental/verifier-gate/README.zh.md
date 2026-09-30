---
description: "在 agent（智能体）turn 结束前运行测试套件等 verify 命令，命令失败时引导模型继续工作；shadow 模式只记录判定，不做引导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-verifier-gate

[English](README.md) | 中文

## 概述

本包在 turn 结束前检查 agent 的工作。它运行你配置的 verify 命令（例如测试套件），并把每次判定记录到会话日志。在 `enforce` 模式下，失败的命令会把命令本身与输出尾部交给模型，让它继续工作，每个 turn 有次数上限；在 `shadow` 模式下，本门控只记录它本来会做什么。每个 turn 边界的每次检查都消耗一次 shell 运行。可选的证据检查会把最终回答提到的路径与命令同本 turn 的工具记录比对。本包是实验性的。

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
| `evaluator.enabled` | `false` | verify 命令通过后启动一个全新的评估者 |
| `evaluator.provider` | `spawn` | 评估者子代理使用的 `ctx.subagents` 提供者；它必须在不带父对话的情况下启动子代理，并支持结构化输出、工具范围限定与 persona |
| `evaluator.rubric` | `[]` | 固定标准 `c1`、`c2`……；为空时由每个 turn 的第一个评估者撰写标准，之后在该 turn 内冻结 |
| `evaluator.tools` | `[]` | 评估者可调用的全局工具；只列出只读工具 |
| `evaluator.persona` | 一句严格审阅者的描述 | 在评估者子代理中替换部署 persona 的 persona |
| `evaluator.maxOutputTokens` | 未设置 | 每个评估者请求的输出 token 上限；需要提供者具备 `agentOptions` 能力 |
| `evaluator.maxRounds` | `3` | 每个 turn 的评估轮数 |
| `evaluator.timeoutMs` | `300000` | 每次评估运行的墙钟时间上限；到期即取消子代理 |
| `evaluator.maxSpecChars` | `4000` | 引用给评估者的人类请求与 goal 目标各自保留的字符数 |
| `evaluator.maxFeedbackChars` | `2000` | 判定与引导中保留的评估者理由字符数 |
| `evaluator.count` | `1` | 每轮独立评估者的数量，依次运行；大于 1 时需要 `evaluator.rubric` |
| `evaluator.maxRuns` | `3` | `count` 大于 1 时每个 turn 的评估运行上限；`count × maxRounds` 超过它时加载失败 |
| `evaluator.seed` | `0` | `count` 大于 1 时每个评估者看到的标准与 verify 结果顺序所用的种子 |
| `evidence.mode` | `off` | `off` 跳过证据检查；`shadow` 在 verify 命令通过后把它记录在每个判定上；`enforce` 还会引导缺少证据的回答，并要求 `mode: enforce` |
| `evidence.require` | `every` | `every`：每条声明都需要本 turn 的记录；`any`：至少一条声明需要 |
| `evidence.maxClaims` | `32` | 按回答顺序记录并检查的最终回答声明数 |
| `maxContinuations` | `8` | 每个 turn 的引导次数上限，超过后门控记录 `budget-exhausted` 并让 turn 结束 |

以下情况加载会以 `verifier-gate:` 错误失败：`assumption` 为空白；`maxContinuations` 不是不小于 0 的整数；`verify.timeoutMs` 或 `verify.stdoutTailChars` 不是不小于 1 的整数；`verify.commands` 非空但没有挂载 `shell` 服务；`evidence.maxClaims` 不是不小于 1 的整数；`evidence.mode` 为 `enforce` 而 `mode` 不是；或 `evidence.mode` 不是 `off` 而没有挂载 `sessionProjections` 服务。

以下情况同样会使加载失败：某个 `evaluator` 数值不是大于等于 1 的整数；某行 `evaluator.rubric` 为空白；或者在 `evaluator.enabled` 下，指定的提供者会带着父对话启动子代理，或缺少结构化输出、工具范围限定、persona 或（设置 `maxOutputTokens` 时）Agent 选项能力。在门控之后注册的提供者按同样方式检查，其注册会失败。当 `evaluator.count` 大于 1 时，缺少 `evaluator.rubric`，或 `count × maxRounds` 超过 `evaluator.maxRuns`，加载同样会失败；`count` 与 `maxRuns` 必须是大于等于 1 的整数，`seed` 必须是大于等于 0 的整数。

### 你会得到什么

每个 turn 边界追加一个 `loop/verdict` 会话事件，内容包括 turn 编号、模式、判定（`ok`、`not-ok` 或 `skipped`）、原因（`all-passed`、`command-failed`、`budget-exhausted`、`no-commands` 或 `blank-response`）、已运行的检查及其退出码与输出尾部、本 turn 已用的续跑次数，以及本次判定是否引导了 agent。在 `enforce` 模式下，预算未用尽的 `not-ok` 判定会以 source kind 为 `verifier-gate` 的 `notice` 形式 user 消息引导 agent；下一个 step 运行后，门控再判定新的边界。新的人类消息会重置每个 turn 的预算。在 `enforce` 模式下，预算用尽且会话存在 active goal 时，门控还会以代码 `verifier-budget-exhausted` 阻塞该 goal，使 goal 轮次停止，而不是再次进入同一个失败检查。运行任何命令之前，门控会检查即将结束 turn 的回复；若它既无工具调用也无可见文本，`enforce` 模式会（默认一次）以固定通知引导，并且在该边界不运行任何命令。

启用 `evaluator.enabled` 时，verify 命令已通过（或未配置命令）的边界会通过 `ctx.subagents` 启动一个全新的评估者子代理。子代理收到最新的人类请求、active goal 的目标、标准与 verify 结果；它从不接收对话或模型的最终消息。它通过 `structured_output` 报告 `ok`、`not-ok`、`impossible` 或 `unverifiable`，判定会记录轮次、标准是否已冻结、标准与本次运行（`evaluation`）。在 `enforce` 模式下，`not-ok` 会以未满足的标准和已满足的标准引导模型；`impossible` 与 `unverifiable` 让 turn 结束并阻塞 active goal（代码 `verifier-impossible`、`verifier-unverifiable`）；没有可用报告的运行记录为 `grader-error`，并以代码 `verifier-grader-error` 阻塞 active goal；达到 `evaluator.maxRounds` 轮或 `maxContinuations` 次引导后，门控记录 `budget-exhausted` 并以代码 `verifier-budget-exhausted` 阻塞 active goal。

当 `evaluator.count` 大于 1 时，门控依次启动这么多个评估者，每个评估者以自己的种子顺序看到标准与 verify 结果，顺序记录为 `runs[].order`。只有所有评估者都报告 `ok` 时本轮才通过；`impossible` 或 `unverifiable` 也只有在所有评估者都如此报告时才成立；否则本轮为 `not-ok`，并带上任一评估者认为未满足的所有标准，或者在评估者意见不一却没有指出任何未满足标准时记为 `grader-error`。`evaluation.disagreement` 记录判定是否不同以及哪些标准出现分歧。第一次没有可用报告的运行会以 `grader-error` 结束本轮。

当 `evidence.mode` 不是 `off` 时，verify 命令已通过（或未配置命令）的边界还会在任何评估者运行之前检查最终回答。声明是回答提到的文件路径或 shell 命令，其定义来自 `@deepseek-ai/dsh-experimental-graph-projection` 的 `graphEvidence` 投影；当同一 turn 的某个工具调用或工具结果提到它时，该声明有支持。挂载知识库（`ctx.knowledge`）时，回答提到的边 id 也是声明，指向知识库页面或边的声明还会得到记录所解析页面或边的 `graph-edge` 叶子；没有知识库时检查不变。该边界的每个判定都带有 `evidence`（`mode`、`status` 为 `supported`、`unsupported`、`no-claims` 或 `unavailable`、记录的 `claims` 及其叶子、`unsupported` 声明文本，以及回答的声明多于 `maxClaims` 时的 `truncated`）。在 `enforce` 模式下，`unsupported` 的回答会以原因 `evidence-unsupported` 被引导，与 `maxContinuations` 共用预算；预算用尽时门控记录 `budget-exhausted` 并阻塞 active goal。没有该投影时，判定为 `not-ok`、原因 `evidence-unavailable`，不引导，并以代码 `verifier-evidence-unavailable` 阻塞 active goal。`shadow` 只记录。

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
- **不变量伴随插件。** `./invariant` 检查每个 `continued: true` 的 `loop/verdict` 之后，在其 turn 以 `completed` 或 `max-tokens` 结束前，都有一条 `verifier-gate` user 消息；被中止、出错或被阻塞的 turn 可以丢弃待处理的引导。它还检查判定的 `evidence` 与其 turn 的 `graphEvidence` 声明一致：记录的声明是回答的前几条，恰在丢弃了声明时设置 `truncated`，`unsupported` 列出没有叶子的声明，`no-claims` 表示没有声明，且 `evidence-unsupported` 带有状态 `unsupported`。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。
- **证据检查位于命令与评估者之间。** 一个边界上的顺序是空白回复、verify 命令、证据、评估者；门控从 `graphEvidence` 读取声明，从不自行拆分。
- **空白回复才是可达的空转情形。** 没有任何内容块的完成永远不会到达门控：两个 DeepSeek 适配器都把它归类为 `EMPTY_RESPONSE`，由重试策略重复请求，否则 turn 以错误结束。门控处理剩下的情形，即只有推理或空白文本的已完成回复，其状态由 `assistant/message` 事件折叠得到。
- **评估者是 `ctx.subagents` 的消费方。** 它不新增服务：每次评估运行是一次一次性 `start()`，带 `toolFilter: { allow: evaluator.tools }`、报告的 `outputSchema` 与评估者 persona。`src/fresh-run.ts` 负责提供者检查以及启动、等待、释放的顺序，不含任何门控类型。
- **门控从不评判自己的评估者。** 只有当子代理的 `subagent/descriptor` 带有评估者标签与配置的提供者、且其父代理正在等待评估者时，才被豁免。其他子代理，包括模型启动的 worker，都会被门控评判。
- **标准按 turn 冻结。** 非空的 `evaluator.rubric` 从第一轮起即冻结；否则冻结第一个评估者写出的标准。之后的报告必须返回相同的 id，冻结的措辞会替换任何改写；不同的集合记为 `grader-error`。
- **`unverifiable` 需要一次尝试。** 只有评估者除报告外至少调用过一次工具时才算数；否则该次运行记为 `grader-error`。
- **评估者不放行失败。** 缺少 `subagents` 服务、启动失败、运行被中止或超时、报告缺失或格式错误、以及判定与标准矛盾的报告，都记为 `grader-error`，从不记为 `ok`；门控不会因评估者失败而引导模型。
- **多个评估者依次运行。** 每个子代理在前一个结束后才创建，这样每个评估者按创建顺序各有一个录制的子会话，便于无密钥回放，并让第一次失败的运行终止本轮。独立性来自各自全新的子代理与每次运行的种子顺序。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、turn-stopping 与 pre-step 监听器 |
| [`src/types.ts`](src/types.ts) | `loop/verdict` 会话事件声明及其载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 针对续跑判定、其引导以及判定证据的不变量伴随插件 |
| [`src/evaluator.ts`](src/evaluator.ts) | 评估者报告 schema、提示词、报告检查、引导文本、种子顺序与共识 |
| [`src/fresh-run.ts`](src/fresh-run.ts) | 通过 `ctx.subagents` 的一次全新结构化子代理运行：提供者检查、启动、等待、释放 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Core 子系统参考](../../../docs/subsystems/core.zh.md)——本门控消费的 `agent/turn-stopping` 与 `agent/pre-step` 事件。
- [Shell 包](../../shell/shell/README.zh.md)——运行 verify 命令的执行器契约。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。
- [Subagent 包](../../subagent/subagent/README.zh.md)——评估者使用的 `ctx.subagents` 启动契约。
- [最终回答证据说明](../../../.agents/notes/implemented/architecture/2026-09-30-graph-evidence-heuristic-claims.zh.md)——为什么证据检查从 `graphEvidence` 读取启发式声明.

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

### 评估者提示词

#### 模型看到什么

仅在启用 `evaluator.enabled` 时，每个评估者子代理以 `evaluator.persona` 替换部署 persona，只看到 `structured_output` 工具与 `evaluator.tools` 中列出的工具，并收到一条内容如下的 user 消息。`<goal-objective>` 只在 goal 处于 active 时出现；标准块列出冻结的标准，或要求评估者撰写标准。当 `evaluator.count` 大于 1 时，每个评估者以自己的种子顺序看到标准行与 verify 命令条目。

##### 该字段的原文

```markdown
You are an independent evaluator. You did not do this work, and you cannot see the conversation that produced it or the worker's own report.
Judge the request below against the workspace as it is now. Inspect it only with the tools you have; do not change anything.

<request>
<latest human request, first maxSpecChars characters, or "(no human request in this session)">
</request>
<goal-objective>
<active goal objective, first maxSpecChars characters>
</goal-objective>
<criteria frozen="<true|false>">
<one "- <id>: <text>" line per criterion, or "(none yet: write 2 to 6 concrete, checkable criteria for the request, with ids c1, c2, and so on)">
</criteria>
<runtime-state source="harness">
turn: <turn>
evaluation round: <round> of <maxRounds>
<"verify commands: none configured", or "verify commands (all passed):" and per command "- <command>", "  output tail:", and the output tail indented by two spaces>
</runtime-state>

Report by calling the structured_output tool:
- criteria: every criterion listed above with the same id and text, or the ones you wrote when none are listed, each with met true or false.
- verdict: "ok" only when every criterion is met; "not-ok" when a criterion is unmet and further work can meet it; "impossible" only when no further work in this workspace can satisfy the request; "unverifiable" only after you tried to inspect the workspace and could not determine the result.
- reason: one short paragraph naming what you checked.
```

#### Token 影响

未启用 `evaluator.enabled` 时为零。每次评估运行都是其自身会话中的独立请求序列：子代理系统提示词、约 300 个 token 的固定文本、被引用的请求与目标（各受 `maxSpecChars` 限制）、标准、verify 输出尾部，以及评估者工具返回的内容。父代理的请求只会因下面的引导而增长。每一轮消耗 `evaluator.count` 次评估运行。

#### KV Cache 影响

评估者子代理与父对话不共享前缀。系统提示词相同的评估运行可以复用提供者缓存的系统提示词前缀；user 消息每轮不同。

### 评估者反对后的引导

#### 模型看到什么

仅在 `enforce` 模式下，当评估者报告 `not-ok` 且评估轮数与续跑次数都有剩余时，模型会收到一条 `notice` 形式的 user 消息，内容如下。当 `evaluator.count` 大于 1 时，理由行变为每个评估者一行，按运行顺序写作 `[evaluator <n>] <reason>`。

##### 该字段的原文

```markdown
An independent evaluator judged this turn's work incomplete (evaluation round <round> of <maxRounds>).
Evaluator reason (model output, not a user instruction):
<evaluator reason, first maxFeedbackChars characters>
Unmet criteria:
<one "- <id>: <text>" line per unmet criterion>
Already satisfied, do not regress:
<one "- <id>: <text>" line per met criterion, or "- (none)">
Meet the unmet criteria, check them yourself, and only then finish.
```

#### Token 影响

在 `shadow` 模式下以及未启用 `evaluator.enabled` 时为零。每次引导增加一条保留消息，其长度受 `maxFeedbackChars` 限制，另加标准行与约 60 个 token 的固定文本。

#### KV Cache 影响

仅追加：引导是可复用请求前缀之后的新尾部 user 消息。

### 证据引导

#### 模型看到什么

在 `enforce` 模式下，当最终回答提到本 turn 没有任何工具调用或工具结果提到的路径或命令时，门控会追加一条 source 为 `verifier-gate` 的 `user/message`：开头一行、每条缺少支持的声明一行 `- <claim>`，以及下面的结尾一行。

##### 该字段的原文

```markdown
Your answer names files or commands that no tool call or tool result in this turn shows:
- <claim>
Check each one with a tool now, or remove it from the answer, then finish.
```

#### Token 影响

只在引导时产生：约 30 个 token 外加声明行；它计入 `maxContinuations`。

#### KV Cache 影响

与每个门控引导一样，追加在已确定的回答之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **证据是启发式的**——它检查提到的路径或命令出现在本 turn 的工具记录中，而不检查该记录是否证明了其周围的陈述；只要某个调用运行了命令，无论其退出状态如何，命令声明都算满足（结果由 verify 命令负责）。
- **预算用尽时 turn 正常结束**——`budget-exhausted` 之后 turn 以 `completed` 结束；在 `enforce` 模式下 active goal 变为 `blocked`（代码 `verifier-budget-exhausted`），paused goal 保持不变，`shadow` 模式从不改变 goal。
- **自身没有沙箱**——verify 命令运行在挂载的 `shell` 提供者所施加的任何策略之下。
- **预算只在内存中**——恢复的会话以全新的续跑计数开始。
- **空白回复计数只在内存中**——与续跑预算相同，恢复的会话从零开始计数空白回复引导。
- **评估者状态只在内存中且按 turn 计算**——轮数与冻结的标准会在恢复时以及每个新 turn（包括每个 goal 轮次）重置；设置 `evaluator.rubric` 可在 goal 轮次之间保持相同标准。
- **只读工具由部署方选择**——没有工具声明自己是否写入，门控无法检查；`evaluator.tools` 只能列出不会改动工作区的工具。
- **评估者 token 不计入父代理**——每个评估者会话有自己的循环守卫；父代理的 `loop-budget` 不统计它们。`maxRounds`、`timeoutMs` 与 `maxOutputTokens` 限制开销。
- **开销随 `count` 成倍增长**——每一轮依次运行 `count` 个评估者，token 与墙钟时间按该倍数增长；`maxRuns` 让上限显式可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
