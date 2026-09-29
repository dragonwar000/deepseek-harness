---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-verifier-gate-source-attribution

[English](2026-09-29-verifier-gate-source-attribution.md) | 中文

## 概述

为 verifier-gate 的 MessageSourceMap['verifier-gate'] 声明加上 @persistenceAttribution 限定，为 user/message、developer/message、agent/inbox/spliced 与 session/title-llm-request 新增一个仅归属型 source kind。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-verifier-gate-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "92cf526183edb4cab80fcbf8677933aab152e65a5466134af3c5df1bee0b2472"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "c3932d2e2c41698de74ed3cca9c7dd8a889292b49a9368058726e600c5ae3b73"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "e4f22257eebf78472ab503fa476b8da877e541531c2b0a866b98f080ab89f8a2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "48d6b40a7a5be4fb4510fe6daecb2d41fe5400f704e6cb10b5bdbbf66a911d04"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

verifier-gate 引导消息的 source kind 只携带归属元数据：读取方无需 verifier-gate 包即可保留其内容与字面 kind 判别符，该 kind 除此保留承诺外不施加任何校验、回放或权限要求。现有日志与现有 source kind 不受影响；不认识 verifier-gate kind 的旧读取方仍会按结构读取外层事件并保留该字段。只有 verifier-gate 包自身会在其 invariant 伴生模块中检查自己的 kind，用于将 continued 的 loop/verdict 与其产生的引导消息关联起来。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/verifier-gate：25 个测试通过，包含依赖该 source kind 的 invariant 伴生测试。pnpm run gen-persistence-catalog 重新生成 known-event-types.ts、persistence-catalog.md/.zh.md/.i18n.yaml 与 persistence-schema.json；pnpm --silent run verify-persistence-changes --json 将受影响的四个根重新分类为 attribution-kind-added、same-version。

<a id="dev-note"></a>
## 开发备注

无。
