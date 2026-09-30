---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-claude-cli-tool-emulation-event

[English](2026-09-30-claude-cli-tool-emulation-event.md) | 中文

## 概述

新增 `llm/cli-tool-emulation` 会话事件，记录一次工具声明经由提示词而非 API `tools` 字段传达的 Claude Code CLI 运行。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-claude-cli-tool-emulation-event
baseline: false
changes:
  - root: "event:llm/cli-tool-emulation"
    previous: null
    after: "17a26effacb05125a5fafa61dd5963ca9cd4008c3ee11aff2170befef1d1846f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是一个新的事件根：已有记录依然有效，已持久化的任何类型都不改变结构。该事件只由 `claude-cli` 模型路由写入，其 Base Bundle 行默认禁用，且仅在 `toolCalls` 为 `prompt` 且请求声明了工具时写入。它只进日志、从不进入派生历史，忽略它的读取方重建出的对话完全相同；它在每次 CLI 运行之前写入，因此模型读到模拟前言和纠正提示之前，它们已经在日志中。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-claude-cli：176 个测试通过，其中包含以真实 Loader 启动的组合测试，断言该事件落入真实的 SessionStore。

<a id="dev-note"></a>
## 开发备注

无。
