---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-knowledge-events

[English](2026-09-30-knowledge-events.md) | 中文

## 概述

新增仅记录日志的 knowledge/write 与 knowledge/inject 会话事件，由 @deepseek-ai/dsh-experimental-knowledge 声明、知识库消费方写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-knowledge-events
baseline: false
changes:
  - root: "event:knowledge/inject"
    previous: null
    after: "e472cdd6eb69e2b1f370cf990d8b4863aac452735a27b7edf945eee79017156c"
    decision: same-version
  - root: "event:knowledge/write"
    previous: null
    after: "2a3b113cb05f616fac21c4a8701fb388170f1f4ee3f85ca3c1dd802791ef3b41"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是两个没有前身的新普通事件类型，现有日志和读取方不受影响。二者像 loop/verdict 与 graph/plan 一样在 SessionEventMap 中声明为读取时必需，都不会进入模型请求或派生历史。knowledge/inject 记录所描述的索引文本另作为普通 user/message 记录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/knowledge：2 个测试文件，12 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
