---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-claude-cli-tool-emulation-event

[English](2026-09-30-claude-cli-tool-emulation-event.md) | 中文

## 概述

新增 `llm/cli-tool-emulation` 会话事件，记录一次工具声明经由提示词而非 API `tools` 字段传达的 Claude Code CLI 运行；并新增 `llm/cli-tool-emulation-reply` 事件，记录那次运行的回复是如何被读取的。

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
  - root: "event:llm/cli-tool-emulation-reply"
    previous: null
    after: "36c5f0056bdb4ff6b82ef7bbc2ea21069f8f66e8473b42d0b8c903dde5cdbbac"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是两个新的事件根：已有记录依然有效，已持久化的任何类型都不改变结构。两个事件都只由 `claude-cli` 模型路由写入，其 Base Bundle 行默认禁用，且仅在 `toolCalls` 为 `prompt` 且请求声明了工具时写入。它们都只进日志、从不进入派生历史，忽略它们的读取方重建出的对话完全相同。`llm/cli-tool-emulation` 在每次 CLI 运行之前写入，因此模型读到模拟前言和纠正提示之前，它们已经在日志中。`llm/cli-tool-emulation-reply` 在运行之后写入，不携带任何模型会读到的内容：被接受的调用数、其中以近似 JSON 形式或 XML `<invoke>` 元素被接受的调用数、被接受的调用之后丢弃的字符数，以及回复被拒时的错误码。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-claude-cli：308 个测试通过，其中包含以真实 Loader 启动的组合测试，以及断言两个事件按先运行后回复的顺序落入真实 SessionStore 的插件测试。

<a id="dev-note"></a>
## 开发备注

无。
