---
description: "在一个实验性组合包中提供回合结束前的校验命令门与每个 Agent 的基础设施快照，默认随安装关闭。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-loop-graph-profile` 让 [`verifier-gate`](../verifier-gate/README.zh.md) 与 [`infra-snapshot`](../infra-snapshot/README.zh.md) 通过一个组合包启用。`verifier-gate` 在回合结束前运行配置的校验命令，在 `enforce` 模式下会在命令失败时把模型引导回去继续工作；`infra-snapshot` 记录一次运行实际依赖的主机信息。本包随 dsh 安装提供，默认关闭；`verifier-gate` 从 `shadow` 模式开始：仅启用本组合包只会记录判定，不会引导模型。可在插件页开启，或添加到已初始化的 profile。

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

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层两行都会用到其中的 `agent/turn-stopping` 与 `agent/created` 事件。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` 移除本包时，两行都会从 profile 的有序层列表中移除。

在 Web 或 Desktop 的插件页开启「循环护栏」，即可同时启用两行。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

### 获得的功能

本层以出厂默认插入 `infra-snapshot`（记录每个会话起始来源），并以 `shadow` 模式、空的 `verify.commands` 插入 `verifier-gate`，因此仅启用本组合包不会改变任何可观察行为：`verifier-gate` 会在每个回合边界记录 `loop/verdict{verdict: 'skipped', reason: 'no-commands'}`，直到某个 profile patch 提供命令为止。请在你自己的 profile patch 中针对 `verifier-gate` 这一行配置命令并切换到 `enforce`：

```yaml
- id: verifier-gate
  config:
    mode: enforce
    verify:
      commands: [pnpm test]
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-base` 之后应用时，它以稳定的行 id 插入 `infra-snapshot` 与 `verifier-gate`，不禁用任何行，因此两行都能叠加在出厂 Web 层之上而不触碰已有 id。

该 patch 不携带 `verifier-gate/invariant` 行：`dsh-base` 有意不挂载 `@deepseek-ai/dsh-invariants`，本组合包叠加在 `dsh-base` 之上时同样不挂载。若某个 composition 挂载了该 registry，例如 [`packages/bundle/sdk-minimal/cordis.patch.yml`](../../bundle/sdk-minimal/cordis.patch.yml)，则由它自己添加 `- id: verifier-gate-invariant` / `name: '@deepseek-ai/dsh-experimental-verifier-gate/invariant'`，紧跟在其他核心 invariant 伴生条目之后。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上、插入 `infra-snapshot` 与 `verifier-gate` 的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| — | 不发布运行时不变式伴生入口；本包只携带静态 profile patch。`verifier-gate` 与 `infra-snapshot` 各自拥有自己的不变式故事。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布规则。
- [Verifier gate](../verifier-gate/README.zh.md)——本组合包启用的回合结束校验门。
- [Infra snapshot](../infra-snapshot/README.zh.md)——本组合包启用的每 Agent 主机信息事件。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 `verifier-gate`：本组合包能产生的所有模型可见引导都归它所有；`infra-snapshot` 永远不会进入模型请求。

#### KV Cache 影响

与本组合包自身的 composition 无关：`infra-snapshot` 是仅记录型的，`verifier-gate` 的 KV Cache 影响是仅追加式的，具体见其各自 README。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅显式启用**——本包随安装提供但默认关闭；随附 CLI、Web、SDK、ACP 与 Python profile 都不会启用它。
- **默认 shadow**——仅启用本组合包不会改变任何模型可见行为；`verify.commands` 与 `mode: enforce` 需要针对 `verifier-gate` 行显式添加 profile patch。
- **需要 base profile**——本 patch 依赖 `dsh-base` 提供的 `agent/turn-stopping`、`agent/pre-step` 与 `agent/created` 事件，两行都会用到；它不是独立 profile。
- **不含 invariant 行**——挂载 `@deepseek-ai/dsh-invariants` 的 composition 需要自行添加 `verifier-gate/invariant` 伴生条目；本组合包不添加，与 `dsh-base` 一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
