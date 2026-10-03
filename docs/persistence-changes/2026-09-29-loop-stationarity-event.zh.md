---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-loop-stationarity-event

[English](2026-09-29-loop-stationarity-event.md) | 中文

## 概述

新增仅记录日志的 loop/stationarity 会话事件，由 @deepseek-ai/dsh-experimental-stationarity-guard 写入，并为其 MessageSourceMap['stationarity-guard'] 条目标注 @persistenceAttribution。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-stationarity-event
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "3d7b62c64e9b2014f237699321d7530e29d12a3e67c3681ee14aadd72a6db037"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "d3022f6ccd233db7d5e50dcdd88845e869003977530f50b8e2473799b705ce21"
    decision: same-version
  - root: "event:loop/stationarity"
    previous: null
    after: "705bbf86ac1cc0d348e09065d8bae5a5d001e24f26839c85698231a081304047"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "19469489e228fffacc2e2590361b079cc35d5de0d04c6be3d19218b66e439f08"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "7f81530fa8b38cb794a35f45b660b6e28eb6298161724c9f58ca3d0d93766934"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

loop/stationarity 是没有前身的新普通事件类型，现有日志和读取方不受影响。它像 loop/verdict 一样在 SessionEventMap 中声明为读取时必需，从不进入模型请求或派生历史，也没有投影需要它来重建会话状态。护栏的提醒消息携带仅记录归属的来源类型，与 verifier-gate 的先例一致（docs/persistence-changes/2026-09-29-verifier-gate-source-attribution.md）：读取方无需 stationarity-guard 包即可保留其内容与字面 kind 判别符，该 kind 除此保留义务外不施加任何校验、重放或权限要求。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/stationarity-guard：2 个测试文件，20 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
