---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-graph-node-run-events

[English](2026-09-29-graph-node-run-events.md) | 中文

## 概述

新增仅记录日志的 graph/node 与 graph/run 会话事件，由 @deepseek-ai/dsh-experimental-graph-contract 声明、@deepseek-ai/dsh-experimental-graph-runner 写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-graph-node-run-events
baseline: false
changes:
  - root: "event:graph/node"
    previous: null
    after: "6d27af626def7a874a97e4f750bbd96d015195fd1a8472286d10095c77e16803"
    decision: same-version
  - root: "event:graph/run"
    previous: null
    after: "d3c0b323291b3fd396ec50af064f84f347b7d5df62fbec370268a744b856fc4e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是两个没有前身的新普通事件类型，现有日志和读取方不受影响。二者像 graph/plan 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，只有 graph 投影与 runner 不变量读取它们。进入后续节点提示的节点输出也记录在该子会话的 user 消息中。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/graph-contract：6 个测试文件，106 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
