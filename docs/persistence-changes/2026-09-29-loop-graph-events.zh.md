---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-loop-graph-events

[English](2026-09-29-loop-graph-events.md) | 中文

## 概述

新增两个仅记录型 session 事件：infra/snapshot（每个 agent 的主机信息）和 loop/verdict（回合结束前由校验命令、可选的最终回答证据检查（含记录叶与知识库叶）以及启用时由全新评估者子代理作出的门控判定，包括评估轮次、标准、运行与分歧）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-graph-events
baseline: false
changes:
  - root: "event:infra/snapshot"
    previous: null
    after: "02c92aa7bc22aac70994b947cab626d33f76c287ecf3382a00b65d862eef14e2"
    decision: same-version
  - root: "event:loop/verdict"
    previous: null
    after: "5b5b837f917dd9a9d1f8a0b0a57c382c07e0284784775b3b968a9857735aa41f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两者都是没有前序记录的全新普通事件类型，现有日志与读取方不受影响。infra/snapshot 由 @deepseek-ai/dsh-experimental-infra-snapshot 在每个 agent 创建时追加一次；loop/verdict 由 @deepseek-ai/dsh-experimental-verifier-gate 在每个回合结束边界追加一次。两者都在 SessionEventMap 中声明为读取时必需（required-on-read），与 todo/write 相同；不认识该类型的构建会拒绝该日志，除非事件携带 ignorable: true。两个事件都不会进入模型请求或派生历史，因此压缩、投影、回放路径都无需解读它们即可重建会话状态；只有 verifier-gate 的引导消息（另一个 user/message 事件）对模型可见。每个评估者提示词记录在其各自的子会话中。可选的 evidence 字段、evidence-unsupported 与 evidence-unavailable 原因、edge 声明类型以及 graph-edge 叶（目标为 page 或 edge，以及解析得到的 ref，仅在挂载知识库时写入）是后来加入的；在此之前写入的记录仍可解码。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/verifier-gate packages/experimental/infra-snapshot：全部测试文件通过，其中包括评估者、evaluator.count 与证据测试集（含挂载与未挂载知识库两种情形）。pnpm run gen-persistence-catalog 与 pnpm run gen-config-catalog 已根据两个包的 SessionEventMap 与 Config 声明重新生成 known-event-types.ts、persistence-catalog.md/.zh.md/.i18n.yaml、persistence-schema.json 以及 config-catalog.md/.zh.md/.i18n.yaml。

<a id="dev-note"></a>
## 开发备注

无。
