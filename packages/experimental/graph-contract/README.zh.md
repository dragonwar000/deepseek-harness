---
description: "在任何内容运行之前确定性地审计 dsh-graph/v1 计划：graph_audit 报告每个结构性拒绝及其固定修复方法，并把每个版本记录为 graph/plan 事件；shadow 模式准入每个成功解析的计划并只记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-contract

[English](README.md) | 中文

## 概述

本包定义 `dsh-graph/v1` 计划格式，并注册 `graph_audit` 与 `graph_capabilities` 工具。`graph_audit` 解析一个计划，在不运行任何内容的情况下审计它，返回每个发现及其固定修复方法，并在计划 id 可读时追加一个 `graph/plan` 事件，因此版本、拒绝记忆、准入与能力路由都能从日志重建。`enforce` 只准入没有 `reject` 发现的版本；`shadow` 准入每个成功解析的版本。本包还声明 `graph/node`、`graph/run` 与 `graph/edge` 事件，以及 graph 运行器与投影共用的节点生命周期与循环规则。本包是实验性的。

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

在模型规划多单元工作（并行执行、独立验证者与综合步骤）的组合中挂载本插件。挂载 `@deepseek-ai/dsh-subagent` 以便运行深度检查，并挂载 `@deepseek-ai/dsh-experimental-graph-projection` 让模型读取已准入的任务图。`@deepseek-ai/dsh-experimental-loop-graph-profile` 包以 `shadow` 模式挂载这两个 graph 包。

### 何时选择

当计划在任何部分运行之前需要经过检查的结构时选择它：无环、每个输出都被消费、有全新的验证者、并行节点的写入范围互不相交，以及有界的最坏情况预算。先用 `shadow` 模式观察真实计划产生哪些发现，再切换到 `enforce`。不要把它用于直线式的单步工作；链条不会从图中获益，审计会以 `LINEAR_PLAN` 发出警告。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-contract'
  config:
    mode: shadow
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
    routes:
      - { category: coding, provider: deepseek, model: deepseek-chat }
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `off` 不注册任何东西；`shadow` 准入每个成功解析的版本并仍报告发现，并以 `admitted: false` 记录无法解析的版本；`enforce` 只在没有严重级别为 `reject` 的发现时准入版本 |
| `assumption` | 非 `off` 时必填 | 本审计所编码的、关于模型的假设；空白值会使加载失败 |
| `allowedTools` | `[]` | 图节点可以声明的全局工具；`run_code` 会使加载失败 |
| `shellTools` | `[]` | 节点可声明的、运行 shell 命令的工具；agent 节点每声明一个都会得到 `SHELL_WRITES_UNCHECKED` 警告 |
| `runBudget.steps` | `0` | agent 节点最坏情况步数之和的上限（单次尝试预算 × (retryBudget + 1)）；`0` 表示不限 |
| `runBudget.tokens` | `0` | token 的同类上限 |
| `runBudget.wallMs` | `0` | 沿 needs 的最坏情况墙钟时间关键路径的上限；`0` 表示不限 |
| `maxCycleIterations` | `8` | 计划可声明的最大 `cycleGuard.maxIterations`；超过时报告 `BUDGET_EXCEEDED` |
| `routes` | `[]` | 能力路由 `{category, provider, model, reliability}`；节点的 `category` 必须有路由。`reliability` 是部署标签，默认 `unverified` |

当 `assumption` 为空白、`allowedTools` 含 `run_code`，某个 `runBudget` 字段不是不小于 0 的整数、某个 `shellTools` 条目为空白、`maxCycleIterations` 不是不小于 1 的整数、某条路由的 category、provider 或 model 为空白，或某个类别被路由两次时，加载会以 `graph-contract:` 错误失败。

### 你会得到什么

每次带有可读计划 id 的调用追加一个 `graph/plan` 事件；`graphPlans` 投影保存每个版本、其代码、由第一个成功解析的版本冻结的 acceptance，以及最新准入的计划。审计按以下顺序报告这些代码：

| 代码 | 检查 | 严重级别 | 何时拒绝 |
|---|---|---|---|
| `SCHEMA_INVALID` | `schema` | reject | 计划无法解析（包括 `status`、`basis`、`version` 等未知键），或 id 重复、needs 或边指向未声明的节点、边既不是 need 也不是格式正确的循环边、循环体在其 `from` 节点之前供给循环之外的节点、输出 schema 使用了不支持的关键字或属性缺少类型（详情给出路径与原因），或输入绑定了未声明的运行输入、`needs` 之外的节点、未声明的输出属性，或边不允许的字段 |
| `CYCLE` | `structure` | reject | needs 中存在环；循环只能由不属于 need 的 `cycleGuard` 边声明 |
| `ISOLATED_NODE` | `closeness` | reject | 两个及以上节点的计划中，某节点既无 needs 也无依赖方 |
| `NOT_CONSUMED` | `closeness` | reject | 某节点的输出不到达任何节点，且它不是 `synthesis` 或 `stop_handoff` 节点（没有此类节点的计划可以以一个汇点结束） |
| `MISSING_ANCHOR` | `anchor` | reject | 某锚点没有声明 `verify` 命令，或 L2、L3 计划没有带命令且有出向 `anchors` 边的锚点 |
| `VERIFIER_NOT_FRESH` | `freshness` | reject | 验证节点不是 `fresh-independent`，或通过 `feeds` 边由执行节点供给，或 L2、L3 计划没有验证节点 |
| `VERDICT_UNDECLARED` | `freshness` | reject | 验证节点的输出没有要求带 `pass` 与 `fail` 枚举的 `verdict` |
| `SYNTHESIS_BEFORE_VERIFY` | `order` | reject | 综合节点的传递 needs 中没有验证节点 |
| `MISSING_HUMAN_GATE` | `gates` | reject | L3 计划没有 `human_gate` 节点 |
| `MISSING_STOP_HANDOFF` | `gates` | reject | L3 计划没有 `stop_handoff` 节点 |
| `WRITE_SCOPE_OVERLAP` | `writes` | reject | 两个可在同一波次运行的节点写入前缀重叠 |
| `SHELL_WRITES_UNCHECKED` | `writes` | warn | agent 节点声明了 `shellTools` 中的工具；经由它的写入绕过 fs 写入接缝，runner 无法按节点写入范围约束它们 |
| `CAPABILITY_UNVERIFIED` | `capability` | reject | 工具是 `run_code`、不在 `allowedTools` 中或不是已注册的全局工具；`anchor` 或 `human_gate` 节点声明了工具或类别；agent 节点的类别没有配置路由；或存在 agent 节点但未挂载子代理服务 |
| `BUDGET_EXCEEDED` | `budget` | reject | 设置了运行上限而某 agent 节点未声明该类预算、最坏情况超过上限（循环体节点计为 `maxIterations + 1` 次），或某个 `cycleGuard` 超过 `maxCycleIterations` |
| `INPUT_MAY_BE_ABSENT` | `inputs` | reject | 输入绑定到 `mayFail: true` 的节点且未声明 `fallback` |
| `EDGE_WITHOUT_ARTIFACT` | `structure` | reject | 某个 need 没有声明的边，或边的 artifact 为空白 |
| `DEPTH_EXCEEDED` | `depth` | reject | agent 节点的运行深度会超过子代理深度上限 |
| `ACCEPTANCE_CHANGED` | `freeze` | reject | acceptance 与第一个成功解析的版本冻结的列表不同 |
| `LINEAR_PLAN` | `structure` | warn | 两个及以上节点、没有验证节点的计划是一条链 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`graph_audit` 接收一个 `json` 参数。`parsePlan` 在这个解析器边界用严格的 zod schema 校验它，填充节点默认值并规范化写入范围。`auditPlan` 是一个纯函数，作用于已解析的计划和一个显式的 `AuditEnvironment`；后者由 `Config`、`ctx.tools.get`、`ctx.subagents.resolveMaxDepth`、`delegationDepthOf` 与 `graphPlans` 投影构建。结构错误会停止审计；环会跳过需要顺序的检查。工具在工具管线内追加 `graph/plan`，并返回一个渲染为模型可见文本的结构化值。

### 设计说明

- **计划是不可变输入。** 由 harness 拥有的字段（`status`、`basis`、`version`）是未知键，会导致解析失败，因此模型无法设置它们。版本由 harness 分配：同一计划 id 的已有记录数加一。
- **拒绝记忆存在会话日志中。** `graph_audit` 报告每个更早的版本及其代码，`repeatOf` 指出摘要相同的最近一个更早版本。无法解析的计划只要 id 可读，仍以 `plan: null` 被记录。
- **写入范围是路径前缀。** 它们按 Agent Teams 写入范围的方式规范化；两个节点只有在互不为对方的传递 need 时才可能共享波次，此时它们的前缀不得重叠。
- **预算没有 USD。** `ctx.llm` 不提供价格，因此运行预算覆盖步数、token（跨尝试求和）与墙钟时间（关键路径，因为一个波次并行运行）。
- **循环是回边。** `needs` 中的环会被拒绝。循环是带 `cycleGuard` 且不属于 need 的边：关系为 `feeds`，从节点指回自身或其某个传递 need。循环体（`cycleBody`）是沿 needs 从 `to` 到 `from` 路径上的所有节点；只有 `from` 可以供给循环体之外的节点，因此波次、指纹与结果沿用仍保持同一个无环顺序。每个循环体节点的最坏情况预算乘以 `maxIterations + 1`。`graph/edge` 记录每次决策；`canReopen` 给出触发的循环可以重新打开的状态。
- **路由被记录，而不是之后再查。** 节点的 `category` 选择其子代理的提供方与模型，而模型选择会进入模型请求，因此 `graph_audit` 把已准入计划所用类别的已配置路由记录在其 `graph/plan` 记录中；graph 运行器只从该记录读取路由。`graph_capabilities` 列出已配置的路由及 `available`（调用时该模型出现在 `ctx.llm.listModels` 中）、已注册的允许工具与委派深度。路由不带价格，因为 `ctx.llm` 不提供价格。
- **运行器词汇位于本包。** `graph/node`、`graph/run` 与 `graph/edge` 在本包中声明，连同 `NODE_TRANSITIONS`、`needSatisfied` 与 `nodeFingerprints`，使运行器与投影共用一个定义而不互相依赖。need 在它为 `executed`、带 `mayFail` 的 `failed`，或跨 `verifies` 边的 `unverified` 时被满足。节点指纹摘要节点本身及其 needs 的指纹，因此改变一个节点会改变每个依赖它的节点。
- **输出 schema 与子代理一致。** `output` 是 `ctx.subagents.start` 接受的、以 object 为根的 JSON Schema 子集；`SCHEMA_INVALID` 发现会给出每个违规在 `output` 下的路径及原因。
- **经由 shell 的写入只警告、不检查。** 工具定义不带副作用类别，因此由部署在 `shellTools` 中列出其 shell 工具；审计对它们只发出警告，从不阻止准入。
- **不变量伴随插件。** `./invariant` 检查版本连续、准入与模式和发现一致、`plan: null` 带有 `SCHEMA_INVALID`，以及变更的 acceptance 带有 `ACCEPTANCE_CHANGED`。组合需把伴随插件与 `@deepseek-ai/dsh-invariants` 一起挂载。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时校验、`graph_audit` 与 `graph_capabilities` 工具与结果渲染 |
| [`src/types.ts`](src/types.ts) | 计划、路由、发现、`graph/plan`、`graph/node`、`graph/run` 与 `graph/edge` 事件，以及 `graphPlans` 状态类型 |
| [`src/schema.ts`](src/schema.ts) | 模型所写计划的 zod 解析器，以及记录与状态的 schema |
| [`src/audit.ts`](src/audit.ts) | 拒绝规则、波次、顺序、循环体与审计 |
| [`src/digest.ts`](src/digest.ts) | 规范 JSON 与计划摘要 |
| [`src/projection.ts`](src/projection.ts) | `graphPlans` 投影 |
| [`src/run.ts`](src/run.ts) | 节点状态转换表、need 满足条件、节点指纹与循环重新打开 |
| [`src/invariant.ts`](src/invariant.ts) | 针对版本与准入的不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Graph 投影包](../graph-projection/README.zh.md)——已准入计划的任务图，通过 `graph_query` 读取。
- [Graph 运行器包](../graph-runner/README.zh.md)——在记录的路由上执行已准入计划的 `graph_run` 工具。
- [Loop graph 配置包](../loop-graph-profile/README.zh.md)——挂载这些 graph 包的可选包。
- [实验性分组地图](../README.zh.md)——同组实验性包与发布策略。
- [循环边说明](../../../.agents/notes/implemented/architecture/2026-09-30-graph-cycle-edges-reopen-loops.md)——为什么循环是以记录的迭代重新打开其循环体的回边.

-----

<a id="model-experience"></a>
## 模型体验

### graph_audit 工具

#### 模型看到什么

插件挂载时（除 `off` 外的任何模式），模型会得到一个名为 `graph_audit` 的工具，它有一个必填的 `plan` 参数（任意 JSON 值），描述如下：

##### 该字段的原文

```markdown
Audit one dsh-graph/v1 plan before any of it runs. The audit is deterministic and runs nothing. It checks: acyclic needs with one declared edge and artifact per dependency; every node output consumed; from L2, an anchor with verify commands and a fresh verification node; at L3, a human_gate and a stop_handoff; disjoint write scopes for nodes that can run together; allowed tools; the run budget; fallbacks for inputs from nodes that may fail; delegation depth; and acceptance unchanged since the first version. It warns when a node declares a tool that can write files through a shell.

Every call with a valid plan id records a new version of that plan. Fix every rejection it reports, then call again. Warnings do not block admission.

Plan: format "dsh-graph/v1"; id (lower-case, stable across versions); level L1|L2|L3; goal; runInputs (names); nodes; edges; deliverable; acceptance (non-empty list, frozen after the first version).

Node: id; kind execution|verification|anchor|human_gate|reducer|synthesis|stop_handoff; instruction; needs (node ids); inputs [{name, from: "run" or a needed node id, field, fallback?}]; output (object JSON Schema using only type, properties, required, additionalProperties, items, enum, const, oneOf, and annotations; every property declares a type; verification nodes require "verdict": {"type": "string", "enum": ["pass", "fail"]}); tools; writes (workspace-relative path prefixes); verify (shell commands, required for anchors); budget {steps?, tokens?, wallMs?} per attempt; retryBudget; contextScope execution-only|fresh-independent; mayFail; category (optional; one of the categories graph_capabilities lists).

Edge: from; to; relation feeds|verifies|constrains|vetoes|anchors|hands_off; artifact (what crosses the edge); allowedFields (optional); cycleGuard (optional) {maxIterations, until, plateauAfter?, metricCommand?} marks a loop edge: relation feeds, from a node back to itself or to a node it depends on, not listed in needs. When from finishes, the loop runs again unless the until shell command exits 0, maxIterations is reached, or the metricCommand output stayed the same for plateauAfter decisions. Only the from node of a loop may feed nodes outside it.

Status, basis, and version belong to the harness and are rejected inside a plan.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 620 个 token。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀。

### graph_audit 结果

#### 模型看到什么

每次调用返回如下形式的文本；方括号部分按调用填充，没有数据的行会省略。没有有效计划 id 的输入会在第二行得到 `plan: not recorded, because the input has no valid id`。

##### 该字段的原文

```markdown
graph_audit: <admitted | rejected | admitted in shadow mode; the rejections below are recorded, not enforced | not admitted, because the plan does not parse; shadow mode admits only a parsed plan>
plan: <plan id> version <n> sha <first 12 hex digits>
identical to version <k>
previous versions: v<n> <admitted|rejected> (<CODE>, <CODE>); …
waves: [<node>, <node>] [<node>] …
rejections (<count>):
- [<CODE>] <subject>: <detail>. Remedy: <remedy>
warnings (<count>):
- [<CODE>] <subject>: <detail>. Remedy: <remedy>
```

#### Token 影响

每次调用增加一个工具结果，其大小随发现数量（每个发现约 40 个 token）与计划历史增长。

#### KV Cache 影响

只追加：每个结果都是位于可复用请求前缀之后的新工具结果。

### graph_capabilities 工具

#### 模型看到什么

插件挂载时（除 `off` 外的任何模式），模型会得到一个名为 `graph_capabilities` 的只读工具，它没有参数，描述如下。结果是紧凑的 JSON：`{"categories":[{"category","provider","model","reliability","available"}],"tools":[…],"depth":{"current","max"}}`；未挂载子代理服务时没有 `depth`。

##### 该字段的原文

```markdown
List what graph nodes can use in this deployment: each node category with its provider, model, reliability label, and whether the model is available now; the tools a node may declare; and the current and maximum delegation depth. Use only these categories and tools in a dsh-graph/v1 plan.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约占 70 个 token。每次调用每条路由返回约 20 个 token。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是位于可复用前缀之后、只追加的工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是本包当前的约束。

- **拒绝记忆以会话为范围**——新会话从空历史开始；基于存储的记忆延后实现。
- **没有 USD 成本**——`runBudget` 只有步数、token 与墙钟时间。
- **经由 shell 的写入只警告、不检查**——声明了 `shellTools` 中工具的节点可以写到其写入范围之外；审计报告 `SHELL_WRITES_UNCHECKED`，runner 无法检测此类写入。
- **工具注册在审计时读取**——之后才注册的工具（例如由 MCP 注册）按调用时刻的注册表判定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
