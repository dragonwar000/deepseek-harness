---
description: "在一个实验性组合包中提供校验门、停滞护栏、拒绝预算、循环预算、每个 Agent 的基础设施快照与 graph 计划审计和运行器，默认随安装关闭。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-loop-graph-profile` 通过一个组合包启用 [`verifier-gate`](../verifier-gate/README.zh.md)、[`stationarity-guard`](../stationarity-guard/README.zh.md)、[`denial-budget`](../denial-budget/README.zh.md)、[`loop-budget`](../loop-budget/README.zh.md)、[`infra-snapshot`](../infra-snapshot/README.zh.md)、[`graph-contract`](../graph-contract/README.zh.md)、[`graph-projection`](../graph-projection/README.zh.md) 与 [`graph-runner`](../graph-runner/README.zh.md)，并在你把 `stationarity-guard` 切换到 `enforce` 之前，让 `repeat-tool-reminder` 继续运行。每个护栏、graph contract 与 graph runner 都以 `shadow` 模式启动：启用本组合包会记录每个护栏本会做什么，不会改变任何步骤或目标；对模型请求的唯一改变是 `graph_audit`、`graph_capabilities`、`graph_query`、`graph_cite`、`history_read` 与 `graph_run` 的工具定义。本包随 dsh 安装提供，默认关闭；可在插件页开启，或添加到已初始化的 profile。

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
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-loop-graph-profile
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层各行都会用到其中的 `agent/turn-stopping`、`agent/pre-step` 与 `agent/created` 事件。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` 移除本包时，全部八行都会从 profile 的有序层列表中移除。

在 Web 或 Desktop 的插件页开启「循环护栏」，即可同时启用全部八行。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

### 获得的功能

本层插入八行，不改变任何 `dsh-base` 行。`infra-snapshot` 记录主机信息。`graph-contract` 以 `shadow` 模式提供 `graph_audit` 与 `graph_capabilities` 工具：每个被审计的计划版本追加一条 `graph/plan` 记录，且每个版本都被准入；`allowedTools` 初始为空，因此在你的 profile patch 指定图节点可用的工具之前，计划节点声明的每个工具都会被报告为 `CAPABILITY_UNVERIFIED`。当节点声明 `bash` 或 `pwsh`（其写入绕过写入范围检查）时，`graph-contract` 还会以 `SHELL_WRITES_UNCHECKED` 发出警告，并接受至多 8 次迭代的循环边。`graph-projection` 提供针对已准入计划的只读 `graph_query` 工具、列出当前 turn 中提到某个路径或命令的工具记录的 `graph_cite`，以及把被压缩片段作为新工具结果读回到上下文末尾的 `history_read`（上限 `history.maxChars` 8000、`maxListed` 20、`readWindow` 50）。`verifier-gate` 以 `shadow` 模式记录每个最终回答的证据检查（`loop/verdict` 的 `evidence`）。`graph-runner` 以 `shadow` 模式提供 `graph_run` 工具：它在 `spawn` 提供方上为每个代理节点启动一个新子代理来运行已准入计划，并记录节点在写入范围之外的写入而不拒绝它们；未配置能力路由，因此每个节点都使用调用方代理的模型。四个护栏都以 `shadow` 模式启动，并写入 `loop/verdict`、`loop/stationarity`、`loop/denial` 或 `loop/budget` 记录；`loop-budget` 出厂时每项限额都是 `0`（关闭），`verifier-gate` 出厂时没有校验命令，因此在配置之前 `loop-budget` 不会记录任何内容，而 `verifier-gate` 只会记录 `no-commands` 或 `blank-response` 判定。请在你自己的 profile patch 中针对某一行的 id 切换到 `enforce`：

```yaml
- id: stationarity-guard
  config:
    mode: enforce
- id: repeat-tool-reminder   # stationarity-guard now owns repeat reminders
  disabled: true
- id: loop-budget
  config:
    mode: enforce
    turn: { maxSteps: 64 }
- id: graph-contract   # a config patch replaces the whole row config
  config:
    mode: enforce
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
    runBudget: { steps: 0, tokens: 0, wallMs: 0 }
    shellTools: [bash, pwsh]
    maxCycleIterations: 8
- id: verifier-gate   # a config patch replaces the whole row config
  config:
    mode: enforce
    assumption: the model declares a task done before its verify commands pass
    verify: { commands: ["pnpm test"], timeoutMs: 300000, stdoutTailChars: 2000 }
    blankResponse: { maxSteers: 1 }
    evidence: { mode: enforce, require: every, maxClaims: 32 }
    maxContinuations: 8
```

当 `stationarity-guard` 仍处于 `shadow` 模式时，`repeat-tool-reminder` 依然会发送其提示性提醒；启用 `stationarity-guard` 的 `enforce` 时，请如上所示一并禁用它。

本 bundle 不改变压缩。若要让尚未回应的工具结果不参与压力修剪，并停止重复摘要那些摘要未能缩小的历史，请在你自己的 headless profile 中修补 `dsh-base` 的行；配置补丁会替换整行配置，因此需要重新写出 pruner 的预算：

```yaml
- id: tool-result-pruner
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
    protectUnseen: true
- id: compaction-basic
  config:
    convergence: refuse
```

Web preset 在各自的 preset group 中带有自己的 `compaction-basic` 与 `tool-result-pruner` 行，因此该补丁不会作用到它们。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

在 `dsh-base` 之后应用时，该 patch 以稳定的行 id 插入八行，不改变任何 `dsh-base` 行。行顺序即监听器顺序：`verifier-gate` 的 `agent/turn-stopping` 监听器先于 `loop-budget` 注册，因此在门已经引导之后工作量下限才会让位。

该 patch 不携带任何 invariant 行：`dsh-base` 有意不挂载 `@deepseek-ai/dsh-invariants`。挂载该 registry 的 composition 需要自行添加各自的伴生条目——`verifier-gate/invariant`、`stationarity-guard/invariant`、`denial-budget/invariant`、`loop-budget/invariant`、`graph-contract/invariant`、`graph-runner/invariant`——紧跟在其他核心伴生条目之后。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上、插入八行的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | 解析该 patch，并对照每个护栏包、graph-contract 与 graph-runner 各自的 `Config` 校验对应行 |
| — | 不发布运行时不变式伴生入口；本包只携带静态 profile patch。各行所属的包各自拥有自己的不变式故事。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布规则。
- [Verifier gate](../verifier-gate/README.zh.md)——本组合包启用的回合结束校验门。
- [Infra snapshot](../infra-snapshot/README.zh.md)——本组合包启用的每 Agent 主机信息事件。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。
- [Stationarity guard](../stationarity-guard/README.zh.md)——本组合包启用的步骤重复护栏。
- [Denial budget](../denial-budget/README.zh.md)——本组合包启用的策略拒绝护栏。
- [Loop budget](../loop-budget/README.zh.md)——本组合包启用的回合/目标支出护栏。
- [Graph contract](../graph-contract/README.zh.md)——本组合包启用的计划审计工具。
- [Graph projection](../graph-projection/README.zh.md)——本组合包启用的任务图查询工具。
- [Graph runner](../graph-runner/README.zh.md)——本组合包启用的计划执行工具。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 `verifier-gate`、`stationarity-guard`、`denial-budget`、`loop-budget`、`graph-contract`、`graph-projection` 与 `graph-runner`：本组合包能产生的所有模型可见消息与工具定义都归它们所有；`infra-snapshot` 永远不会进入模型请求。

#### KV Cache 影响

与本组合包自身的 composition 无关：每个护栏的消息都是仅追加式的，具体见各自 README；`infra-snapshot` 是仅记录型的；`graph_audit`、`graph_capabilities`、`graph_query`、`graph_cite`、`history_read` 与 `graph_run` 的定义在组合包加载时一次性加入稳定的工具前缀；`history_read` 的结果追加在末尾，从不改写更早的上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅显式启用**——本包随安装提供但默认关闭；随附 CLI、Web、SDK、ACP 与 Python profile 都不会启用它。
- **默认 shadow**——每个护栏、`graph-contract` 与 `graph-runner` 都需要针对自己的行显式添加 `mode: enforce` patch；`verifier-gate` 还需要 `verify.commands`，`loop-budget` 还需要限额，`graph-contract` 还需要 `allowedTools`。
- **graph 工具在每个请求中消耗 token**——启用本组合包期间，无论模型是否用图来规划，`graph_audit`、`graph_capabilities`、`graph_query`、`graph_cite`、`history_read` 与 `graph_run` 的定义都会为每个请求增加约 1,400 个 token。
- **需要 base profile**——本 patch 依赖 `dsh-base` 提供的 `agent/turn-stopping`、`agent/pre-step` 与 `agent/created` 事件，各行都会用到；它不是独立 profile。
- **不含 invariant 行**——挂载 `@deepseek-ai/dsh-invariants` 的 composition 需要自行添加 `verifier-gate/invariant`、`stationarity-guard/invariant`、`denial-budget/invariant`、`loop-budget/invariant`、`graph-contract/invariant` 与 `graph-runner/invariant` 伴生条目；本组合包不添加，与 `dsh-base` 一致。
- **shadow 模式下没有重复提醒的替代**——当 `stationarity-guard` 仍处于 `shadow` 模式时，`repeat-tool-reminder` 依然会发送其提示性提醒；启用 `stationarity-guard` 的 `enforce` 时，请在你自己的 profile patch 中一并禁用它。
- **压缩设置不随 bundle 提供**——`protectUnseen`、`convergence` 与 `authoritativeRequest` 仍需在每个 profile 中自行开启，因为 bundle 补丁会替换 `dsh-base` 整行配置，且无法作用到 Web profile 中各 preset 的压缩行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
