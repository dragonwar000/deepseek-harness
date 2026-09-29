---
description: "实验组地图：可公开安装的预稳定原型。"
kind: "package-group"
---

# packages/experimental

[English](README.md) | 中文

## 概述

实验组包含约定可能变更且不提供支持承诺的原型能力。所有当前包都以 `@deepseek-ai/dsh-experimental-*` 名称发布，包括显式启用的 Agent Teams 组合、Auto review、Cua Driver 提供方、浏览器操作后端、跨 realm Inspector、CPython PTC 后端与浏览器 worker 预览库。组外已发布产品不得依赖实验性包。dsh 安装将 Agent Teams、语音输入、Auto review、定时与循环护栏包作为可选 bundle 一起发布，可从 Web 侧边栏“插件”页启用（[决策](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)）；其余包是库或显式组合。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`speech-to-text`](speech-to-text/README.zh.md) | 具名语音识别 Provider | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.zh.md) | 托管本地 SenseVoice 推理 | — |
| [`api-speech-to-text`](api-speech-to-text/README.zh.md) | 带认证的临时转写 Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.zh.md) | 麦克风录音与版本检查后的草稿插入 | — |
| [`voice-input-bundle`](voice-input-bundle/README.zh.md) | 默认禁用的可选语音输入组合 | — |
| [`agent-team-profile`](agent-team-profile/README.zh.md) | Agent Teams 协作、工具与 Web UI 组合包 | — |
| [`agent-team`](agent-team/README.zh.md) | 具名 teammate，成员之间持久消息与共享任务板 | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.zh.md) | Web Team roster、任务板与 teammate 导航 | — |
| [`auto-review`](auto-review/README.zh.md) | 显式 Web 层，在每个原生或 PTC inner 工具调用前使用同一模型审查 | — |
| [`schedule-bundle`](schedule-bundle/README.zh.md) | 为出厂 Web 组合按需加入定时服务、任务页面与时间上下文 | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.zh.md) | PTC 执行 seam 的 CPython 子进程后端 | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 使用已安装的 Cua Driver | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.zh.md) | 嵌入 Cua Driver 原生 npm 运行时 | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.zh.md) | 通过 MCP 提供 Playwright 浏览器工具 | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 提供 Chrome DevTools 检查与浏览器控制 | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.zh.md) | Stagehand 浏览器操作与显式配置的原生模型 | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.zh.md) | 实验性提供方共享的 Session 浏览器资源 | — |
| [`inspector`](inspector/README.zh.md) | 用于 Host 调试、Client Runtime 检查、网络采集与 Cordis 树的跨 realm CDP hub | `ctx.inspector` |
| [`tool-agent-team`](tool-agent-team/README.zh.md) | 让模型创建、发消息与协调 teammate 的九个工具 | 按作用域注册工具到 `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.zh.md) | 构建浏览器 worker 预览所消费的 gzip 压缩虚拟文件系统（VFS）镜像 | 库与 CLI（命令行界面），不使用 ctx key |
| [`webworker-runtime`](webworker-runtime/README.zh.md) | 在专用浏览器 worker 中运行 harness 插件树 | 库与 worker 入口，不使用 ctx key |
| [`verifier-gate`](verifier-gate/README.zh.md) | 回合结束前的校验命令门与可选的最终回答证据检查，shadow 或 enforce | 在 `agent/turn-stopping` 上注册监听器 |
| [`infra-snapshot`](infra-snapshot/README.zh.md) | 每个 agent 一条 `infra/snapshot` 事件 | — |
| [`loop-graph-profile`](loop-graph-profile/README.zh.md) | 从插件页开启的循环护栏组合包 | — |
| [`stationarity-guard`](stationarity-guard/README.zh.md) | 按步骤签名提醒或停止重复工具步骤的护栏，shadow 或 enforce | 在 `agent/pre-step` 与 `session/event` 上注册监听器 |
| [`denial-budget`](denial-budget/README.zh.md) | 统计策略拒绝、提示更安全的做法，并在超出预算时请求批准，shadow 或 enforce | 在 `tools/*` 与 `agent/pre-step` 上注册监听器 |
| [`loop-budget`](loop-budget/README.zh.md) | 按回合与目标限制步数、token、美元与墙钟时间，并带工作量下限，shadow 或 enforce | 在 `agent/pre-step`、`agent/turn-stopping` 与 `session/event` 上注册监听器 |
| [`graph-contract`](graph-contract/README.zh.md) | 确定性的 `dsh-graph/v1` 计划审计、拒绝记忆、循环边规则与 shell 写入警告，shadow 或 enforce | 注册 `graph_audit` 工具与 `graphPlans` 投影 |
| [`graph-projection`](graph-projection/README.zh.md) | 从会话日志折叠的任务图、轮次证据与被压缩的历史，提供只读的 `graph_query`、`graph_cite` 与 `history_read` 工具 | 注册 `graph_query`、`graph_cite` 与 `history_read` 工具，以及 `graph`、`graphEvidence` 与 `graphHistory` 投影 |
| [`graph-runner`](graph-runner/README.zh.md) | 前台运行已准入计划的 `graph_run`：每个节点一个新子代理、基于证据的完成、重试、恢复、写入范围与循环边 | 注册 `graph_run` 工具与 `fs/write-intent`/`fs/edit-intent` 监听器 |
| [`knowledge`](knowledge/README.zh.md) | 知识库接缝：页面与边的词汇、抽象服务，以及写入与注入事件 | `ctx.knowledge` |
| [`knowledge-wiki-filesystem`](knowledge-wiki-filesystem/README.zh.md) | 会话工作区内的 Markdown wiki 知识库：推导的边与过期状态、经规则校验的写入 | `ctx.knowledge` |
| [`knowledge-rules`](knowledge-rules/README.zh.md) | 失败即拒绝的守卫：拒绝绕过 `knowledge_write` 的文件与 shell 写入 | 注册 `fs/write-intent`/`fs/edit-intent` 监听器与工具守卫 |
| [`tool-knowledge`](tool-knowledge/README.zh.md) | `knowledge_query`、`knowledge_read`、`knowledge_cite` 与需审批、带出处的 `knowledge_write` | 在 `ctx.tools` 上注册四个工具 |

-----

<a id="related-documentation"></a>
## 相关文档

- [实验包发布决策](../../.agents/notes/implemented/process/2026-09-12-experimental-publication-denylist.zh.md)——默认公开与私有例外。
- [计算机操作](../../docs/subsystems/computer-use.zh.md)——桌面提供方选择。
- [浏览器操作](../../docs/subsystems/browser-use.zh.md)——浏览器提供方选择与 Session 所有权。
- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [实验子树规则](AGENTS.md)——实验状态放宽了什么、不放宽什么。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
