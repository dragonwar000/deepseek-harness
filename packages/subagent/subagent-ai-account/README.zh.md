---
description: "Profile Bundle：以每种账号的默认 AI 账号运行 Claude Code 与 Codex 子代理提供者，并在默认账号变化时重新挂载。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-ai-account

[English](README.md) | 中文

## 概述

当委派的 Claude Code 和 Codex 任务需要使用 **设置 → AI 账号** 中添加的账号运行时，安装此 Profile Bundle。对于每种有默认账号的种类，它都会用该账号的 CLI 配置目录挂载官方产品提供者——Claude 使用 `claude-code`，ChatGPT 使用 `codex`——使产品 CLI 使用该账号自己保存的登录状态。更改或移除默认账号会重新挂载或撤下提供者；委派工具随之出现或消失。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

将 Bundle 安装到同时挂载了 `ctx.aiAccount` 提供者的 Profile 中（base Bundle 挂载 `ai-account-platform`），然后重启该 Profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-ai-account
```

此 Bundle 自带两个产品提供者包及其固定版本的运行时；不要再安装 `@deepseek-ai/dsh-subagent-claude-code` 或 `@deepseek-ai/dsh-subagent-codex`，它们自己的行会注册相同的提供者名称并因重复提供者而失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `claudeCode` | `{ providerName: claude-code }` | 默认 Claude 账号使用的 [Claude Code 提供者配置](../subagent-claude-code/README.zh.md) |
| `codex` | `{ providerName: codex }` | 默认 ChatGPT 账号使用的 [Codex 提供者配置](../subagent-codex/README.zh.md) |

账号目录叠加在各配置的 `env` 之上：Claude Code 使用 `CLAUDE_CONFIG_DIR`，Codex 使用 `CODEX_HOME`。模型只能通过委派工具行访问提供者。Web App 的 standard、PTC 与 Cordis 预设带有 `tool-subagent-claude-code`（`subagent_claude_code`）和 `tool-subagent-codex`（`subagent_codex`）行；每个工具只在其提供者挂载期间注册。

<a id="understand-the-implementation"></a>
## 理解实现

对于每个种类，插件在启动时以及该种类每次发出 `ai-account/default-changed` 时读取 `ctx.aiAccount.defaultHome(kind)`。目录变化时，它释放当前提供者 fiber，并用 `ctx.plugin` 挂载新的 fiber；没有默认账号时该种类没有提供者。提供者 fiber 是此插件的子 fiber，因此释放此插件会撤下两个提供者。释放提供者 fiber 会结束该提供者的注册；其上进行中的委派随提供者停止。子代理服务已经负责提供者注册，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [ai-account](../../credentials/ai-account/README.zh.md) — 其默认账号决定目录的账号服务。
- [subagent-claude-code](../subagent-claude-code/README.zh.md) 与 [subagent-codex](../subagent-codex/README.zh.md) — 被挂载的产品提供者。
- [tool-subagent](../tool-subagent/README.zh.md) — 向模型公开提供者的委派工具。
- [官方 CLI AI 账号决策](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md) — 为何只通过官方 CLI 使用账号。

<a id="model-experience"></a>
## 模型体验

间接地，通过被挂载的 Claude Code 与 Codex 提供者及其 `dsh-tool-subagent` 行：当某种类有默认账号时，模型可以调用该种类的委派工具，子产品以该账号运行；没有默认账号时该工具不存在。

#### KV Cache effect

默认账号出现或消失会增加或移除一个委派工具 schema，从而改变之后请求的工具列表；在同一种类的两个账号之间切换不会改变任何模型请求内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **与独立提供者 Bundle 互斥** — 提供者名称 `claude-code` 和 `codex` 由预设工具行固定，因此除非同时修改 `providerName` 和工具行，此 Bundle 不能与独立提供者 Bundle 共存于同一 Profile。
- **重新挂载会中断委派** — 在委派运行期间更改或移除默认账号会停止该运行。

<a id="dev-note"></a>
### 开发备注

无。
