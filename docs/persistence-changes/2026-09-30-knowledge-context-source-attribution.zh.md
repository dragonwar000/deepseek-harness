---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-knowledge-context-source-attribution

[English](2026-09-30-knowledge-context-source-attribution.md) | 中文

## 概述

用 @persistenceAttribution 标注 context-knowledge 的 MessageSourceMap['knowledge-context'] 条目，为 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 增加一个仅用于归因的来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-knowledge-context-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-loop-budget-event"
    after: "72ac21ffd551d21aee204c531274ed1dd1dc05d0819a9d75668d4c78e204b171"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-loop-budget-event"
    after: "e1ab2a2b52ffd259a07204382de664c190cf5ac6fe44589784faa04f325b23a2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-loop-budget-event"
    after: "caf552c5a831de0e7a781287798ae3444ca88abfabc7f92ddbc9ee092d9717c3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-loop-budget-event"
    after: "2e8e49e6243b3ce232b9a317d2dad40a0aea26730f38a4f000cab6678523df41"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

知识索引消息的来源类型只携带归因元数据：读取方无需 context-knowledge 包即可保留其内容与字面类型判别值，该类型除此之外不施加任何校验、重放或权限要求。现有日志与现有来源类型不受影响；不认识 knowledge-context 类型的旧读取方仍按结构读取外层事件并保留该字段。只有 context-knowledge 包自身会在其不变量伴随插件中额外检查自己的类型，以把每条索引消息与其之前的 knowledge/inject 记录对应起来。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/context-knowledge：3 个测试文件通过，其中包括依赖该来源类型的不变量伴随插件测试。pnpm run gen-persistence-catalog 重新生成了持久化目录与 schema。

<a id="dev-note"></a>
## 开发备注

无。
