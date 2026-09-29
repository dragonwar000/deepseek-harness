---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-graph-plan-event

[English](2026-09-29-graph-plan-event.md) | 中文

## 概述

新增仅记录日志的 graph/plan 会话事件，由 @deepseek-ai/dsh-experimental-graph-contract 在每次输入带有可读计划 id 的 graph_audit 调用时写入，并带有计划所用类别的可选 routes、每个计划节点的可选 category、SHELL_WRITES_UNCHECKED 警告代码，以及记录的计划中可选的 cycleGuard 边。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-graph-plan-event
baseline: false
changes:
  - root: "event:graph/plan"
    previous: null
    after: "6021c0913fd7ca9a06eb9621db858f3746456d9d2a4d62cd1af8a8480333d666"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是没有前身的新普通事件类型，现有日志和读取方不受影响。它像 loop/verdict 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，只有 graphPlans 与 graph 投影、graph 运行器以及不变量伴随插件读取它。模型可见的审计文本属于普通 tool/result 内容。graph 运行器只从该记录读取节点路由，因此每个节点子代理的模型路由都能从日志重建。新增的警告代码扩展了拒绝代码枚举，cycleGuard 是可选的边字段；在此之前写入的记录仍可解码。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/graph-contract packages/experimental/graph-projection packages/experimental/graph-runner：全部测试文件通过。

<a id="dev-note"></a>
## 开发备注

无。
