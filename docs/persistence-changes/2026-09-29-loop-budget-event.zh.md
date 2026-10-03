---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-loop-budget-event

[English](2026-09-29-loop-budget-event.md) | 中文

## 概述

新增仅记录日志的 loop/budget 会话事件，由 @deepseek-ai/dsh-experimental-loop-budget 写入，并为其 MessageSourceMap['loop-budget'] 条目标注 @persistenceAttribution。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-budget-event
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-loop-stationarity-event"
    after: "4f8af840a8d3e8fdda28b6e43cecbc5f1bd6403df0d7fff8eaad686f9c63c615"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-loop-stationarity-event"
    after: "f2abe51d974abfb1a64bd4bd2d4300384045c33265d468eb67b11e61ecf31e7f"
    decision: same-version
  - root: "event:loop/budget"
    previous: null
    after: "151e7acda0708d10be7e8396b570ac0ee707c213cc54f6493f22c613e5ccf380"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-loop-stationarity-event"
    after: "46db6ba7e8d22f934a7aeb5b66a00f9d5e56c0c3357b2513c932cc878b770754"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-loop-stationarity-event"
    after: "91c9e948a6a0796fc221d01915f6a9705e9f1fca9bf37193c0b6cfa4a6798c0c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

loop/budget 是没有前身的新普通事件类型，现有日志和读取方不受影响。它像 loop/verdict 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，也没有投影需要它来重建会话状态。工作量下限引导消息携带仅记录归属的来源类型，与 verifier-gate 的先例一致（docs/persistence-changes/2026-09-29-verifier-gate-source-attribution.md）：读取方无需 loop-budget 包即可保留其内容与字面 kind 判别符，该 kind 除此保留义务外不施加任何校验、重放或权限要求。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/loop-budget：2 个测试文件，25 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
