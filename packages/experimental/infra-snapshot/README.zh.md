---
description: "记录 node 版本、平台、CPU 数量、内存与沙箱模式的每 Agent infra/snapshot 会话事件，供维护者与 Agent 比较或审计某次运行实际所在的主机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-infra-snapshot

[English](README.md) | 中文

## 概述

本包在创建 Agent 时追加一条 `infra/snapshot` 会话事件，记录该次运行实际依赖的主机事实：Node 版本、平台、架构、逻辑 CPU 数量、总内存,以及所挂载 shell 的默认沙箱模式。它的存在是为了让基础设施可以从会话日志中重建,而不是被假定——只有两次运行的快照一致时,比较它们的行为差异才有意义。该事件在每个 Agent 创建时追加一次,除这一次追加外没有其他运行时开销。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一次运行的主机基础设施必须能从其会话日志中重建时——比较两次运行、诊断依赖环境的行为,或审计某个部署实际运行的主机——挂载本插件。

### 何时选用

当基础设施相关的比较有意义时选用它:基准测试运行、绑定到特定主机的错误报告,或任何假定两个会话运行在可比硬件上的评估。当部署已经在别处记录了主机事实(其自身的机群清单或遥测)、再保留一份按会话的副本没有额外价值时,跳过它。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-infra-snapshot'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `[]` | 需要记录快照的会话启动来源(`startup`、`resume`、`clear`、`compact`);为空表示记录所有来源 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-infra-snapshot)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本插件监听 `agent/created`,Cordis 会在 Agent 创建完成前等待该监听器,因此调用方观察到新创建的 Agent 时,`infra/snapshot` 事件必定已经存在。`sources` 按 `SessionStartSource`(`startup` | `resume` | `clear` | `compact`)过滤;默认的空列表记录所有来源,而当 `sources` 非空且不包含某个来源时,该 Agent 不会追加任何事件。

主机事实取自 `process.version`、`process.platform`、`process.arch`、`os.cpus().length` 与 `os.totalmem()`(四舍五入为 MiB)。`sandboxMode` 读取可选的 `ctx.shell` 服务的 `sandboxMode` getter,在没有挂载 shell 或所挂载的执行器默认不做沙箱化时回退为 `'none'`——本包不添加任何沙箱化,也从不调用 `resolve`/`execute`。

### 源码索引

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口:`Config` 模式、`agent/created` 监听器、主机事实采集 |
| [`src/types.ts`](src/types.ts) | `InfraSnapshot` 负载类型与 `infra/snapshot` 的 `SessionEventMap` 声明 |
| — | 未发布运行时不变量伴生包:一次独立的追加、没有跨事件关系可供伴生包观察。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话事件日志](../../../docs/subsystems/session.zh.md)——`infra/snapshot` 加入的仅追加日志。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-infra-snapshot)——每个可接受的配置字段。
- [`dsh-shell`](../../shell/shell/README.zh.md)——本包读取 `sandboxMode` 的可选 `ctx.shell` 服务。

-----

<a id="model-experience"></a>
## 模型体验

无,因为本插件只追加一条仅记录日志的 `infra/snapshot` 会话事件,从不进入模型请求。

#### KV 缓存影响

独立:该事件仅记录日志,从不进入请求。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- **没有模型/推理力度字段**——这些字段已经存在于 `request/header` 中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是面向维护者的工作上下文:尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由记录在上面各节、包代码以及所链接的 Agent Notes 中。

本包在 `290926-dsh-loop-graph` 计划的 Task 2 中被搭建,与并行构建的 `@deepseek-ai/dsh-experimental-verifier-gate`(Task 1)同期完成。该计划中有两处共享文件的登记属于后续集成步骤,而非本包自身行为的一部分:在 `SENTENCE_MODEL_EXPERIENCE`(`scripts/verify-package-readme-model-experience.ts`)中为 `packages/experimental/infra-snapshot` 添加条目(使 doc-sync 的模型体验门禁接受上面的 `None, as ` 句式),以及在 `packages/experimental/README.md` 与 `tsconfig.host.json` 中为本包添加行(待计划的 bundle 任务落地时一并添加)。本包自身的 `tsconfig.base.json` 源码解析别名已在本次变更中一并添加,与所有其他 `packages/experimental/*` 包手写别名的做法一致。

</details>
