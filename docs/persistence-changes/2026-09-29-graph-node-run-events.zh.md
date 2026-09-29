---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-graph-node-run-events

[English](2026-09-29-graph-node-run-events.md) | 中文

## 概述

新增仅记录日志的 graph/node 与 graph/run 会话事件，由 @deepseek-ai/dsh-experimental-graph-contract 声明、@deepseek-ai/dsh-experimental-graph-runner 写入。graph/node 记录可带有节点的循环迭代序号。

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
    after: "f8c0f9a529e2ea6e1943e450e8c5e5dc2494353e527fad2a57617da51d89a2fa"
    decision: same-version
  - root: "event:graph/run"
    previous: null
    after: "d3c0b323291b3fd396ec50af064f84f347b7d5df62fbec370268a744b856fc4e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是两个没有前身的新普通事件类型，现有日志和读取方不受影响。二者像 graph/plan 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，只有 graph 投影与 runner 不变量读取它们。进入后续节点提示的节点输出也记录在该子会话的 user 消息中。在其之前写入的记录没有可选的 iteration 字段，按迭代 0 读取。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/graph-contract：全部测试文件通过。

<a id="dev-note"></a>
## 开发备注

无。
