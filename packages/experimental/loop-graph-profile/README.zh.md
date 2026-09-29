---
description: "在一个实验性组合包中提供校验门、停滞护栏、拒绝预算、循环预算与每个 Agent 的基础设施快照，默认随安装关闭。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-loop-graph-profile` 通过一个组合包启用 [`verifier-gate`](../verifier-gate/README.zh.md)、[`stationarity-guard`](../stationarity-guard/README.zh.md)、[`denial-budget`](../denial-budget/README.zh.md)、[`loop-budget`](../loop-budget/README.zh.md) 与 [`infra-snapshot`](../infra-snapshot/README.zh.md)，并在你把 `stationarity-guard` 切换到 `enforce` 之前，让 `repeat-tool-reminder` 继续运行。每个护栏都以 `shadow` 模式启动：仅启用本组合包只会记录每个护栏本会做什么，不会改变任何模型请求、步骤或目标。本包随 dsh 安装提供，默认关闭；可在插件页开启，或添加到已初始化的 profile。

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

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层各行都会用到其中的 `agent/turn-stopping`、`agent/pre-step` 与 `agent/created` 事件。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` 移除本包时，全部五行都会从 profile 的有序层列表中移除。

在 Web 或 Desktop 的插件页开启「循环护栏」，即可同时启用全部五行。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

### 获得的功能

本层插入五行，不改变任何 `dsh-base` 行。`infra-snapshot` 记录主机信息。四个护栏都以 `shadow` 模式启动，并写入 `loop/verdict`、`loop/stationarity`、`loop/denial` 或 `loop/budget` 记录；`loop-budget` 出厂时每项限额都是 `0`（关闭），`verifier-gate` 出厂时没有校验命令，因此这两个护栏在配置之前不会记录任何内容。请在你自己的 profile patch 中针对某一行的 id 切换到 `enforce`：

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
```

当 `stationarity-guard` 仍处于 `shadow` 模式时，`repeat-tool-reminder` 依然会发送其提示性提醒；启用 `stationarity-guard` 的 `enforce` 时，请如上所示一并禁用它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

在 `dsh-base` 之后应用时，该 patch 以稳定的行 id 插入五行，不改变任何 `dsh-base` 行。行顺序即监听器顺序：`verifier-gate` 的 `agent/turn-stopping` 监听器先于 `loop-budget` 注册，因此在门已经引导之后工作量下限才会让位。

该 patch 不携带任何 invariant 行：`dsh-base` 有意不挂载 `@deepseek-ai/dsh-invariants`。挂载该 registry 的 composition 需要自行添加各自的伴生条目——`verifier-gate/invariant`、`stationarity-guard/invariant`、`denial-budget/invariant`、`loop-budget/invariant`——紧跟在其他核心伴生条目之后。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上、插入五行的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | 解析该 patch，并对照每个护栏包各自的 `Config` 校验每一行 |
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

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 `verifier-gate`、`stationarity-guard`、`denial-budget` 与 `loop-budget`：本组合包能产生的所有模型可见消息都归它们所有；`infra-snapshot` 永远不会进入模型请求。

#### KV Cache 影响

与本组合包自身的 composition 无关：每个护栏的消息都是仅追加式的，具体见各自 README；`infra-snapshot` 是仅记录型的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅显式启用**——本包随安装提供但默认关闭；随附 CLI、Web、SDK、ACP 与 Python profile 都不会启用它。
- **默认 shadow**——每个护栏都需要针对自己的行显式添加 `mode: enforce` patch；`verifier-gate` 还需要 `verify.commands`，`loop-budget` 还需要限额。
- **需要 base profile**——本 patch 依赖 `dsh-base` 提供的 `agent/turn-stopping`、`agent/pre-step` 与 `agent/created` 事件，各行都会用到；它不是独立 profile。
- **不含 invariant 行**——挂载 `@deepseek-ai/dsh-invariants` 的 composition 需要自行添加 `verifier-gate/invariant`、`stationarity-guard/invariant`、`denial-budget/invariant` 与 `loop-budget/invariant` 伴生条目；本组合包不添加，与 `dsh-base` 一致。
- **shadow 模式下没有重复提醒的替代**——当 `stationarity-guard` 仍处于 `shadow` 模式时，`repeat-tool-reminder` 依然会发送其提示性提醒；启用 `stationarity-guard` 的 `enforce` 时，请在你自己的 profile patch 中一并禁用它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
