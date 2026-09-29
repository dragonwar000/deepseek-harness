---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-graph-edge-event

[English](2026-09-30-graph-edge-event.md) | 中文

## 概述

新增仅记录日志的 graph/edge 会话事件，由 @deepseek-ai/dsh-experimental-graph-contract 声明，@deepseek-ai/dsh-experimental-graph-runner 在每次循环边决策时写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-graph-edge-event
baseline: false
changes:
  - root: "event:graph/edge"
    previous: null
    after: "a84af717c367337f8538f5208528b01805f55bbb7acb6da5ea4d7b163cb3d30d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是没有前身的新普通事件类型，现有日志和读取方不受影响。它像 graph/node 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，只有 graph 投影与 runner 不变量读取它。触发的循环边回传的输出也记录在为重新打开节点撰写简报的子会话 user 消息中。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/graph-contract：全部测试文件通过。

<a id="dev-note"></a>
## 开发备注

无。
