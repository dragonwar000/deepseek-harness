---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-loop-denial-event

[English](2026-09-29-loop-denial-event.md) | 中文

## 概述

新增仅记录日志的 loop/denial 会话事件，由 @deepseek-ai/dsh-experimental-denial-budget 写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-denial-event
baseline: false
changes:
  - root: "event:loop/denial"
    previous: null
    after: "52ff900df9dcdaa61a565eefb84b5f635d65b2c2193577d35d473182a9246cab"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是没有前身的新普通事件类型，现有日志和读取方不受影响。它像 loop/verdict 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，也没有投影需要它来重建会话状态。模型可见的提示属于普通 tool/result 内容。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/denial-budget：2 个测试文件，21 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
