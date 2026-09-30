---
description: "AI 账号提供者：只通过针对每个账号的配置目录运行官方 Claude Code 与 Codex CLI 来登录、识别和退出 Claude 与 ChatGPT 订阅账号。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ai-account-platform

[English](README.md) | 中文

## 概述

挂载此提供者可为 `ctx.aiAccount` 提供真实账号。添加账号会在新的配置目录中运行官方登录命令，读取身份会在该目录中运行官方状态命令，移除账号会先在该目录中运行官方退出命令再删除目录。提供者只存储账号元数据；从不读取、复制、刷新或存储 CLI 保存的凭据。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

base Bundle 以 `ai-account` 行挂载此提供者。其配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `<Harness home>/ai-accounts` | 存放 `accounts.json` 和各账号 CLI 目录的目录 |
| `claudeCliPath` | `claude` | Claude Code 可执行文件：绝对路径或从 `PATH` 解析的名称 |
| `codexCliPath` | `codex` | Codex 可执行文件：绝对路径或从 `PATH` 解析的名称 |
| `loginTimeoutMs` | `900000` | 一次登录（含用户授权）的时限（1 秒–30 分钟） |
| `commandTimeoutMs` | `15000` | 一次状态或退出命令的时限（1–120 秒） |
| `graceMs` | `2000` | 取消 CLI 命令时各终止阶段之间的宽限时间 |

| 种类 | 账号目录 | 登录 | 身份 | 退出 |
|---|---|---|---|---|
| `claude` | `<root>/claude/<id>`，作为 `CLAUDE_CONFIG_DIR` | `claude auth login --claudeai` | `claude auth status --json` | `claude auth logout` |
| `chatgpt` | `<root>/codex/<id>`，作为 `CODEX_HOME` | `codex login --device-auth` | `codex login status` | `codex logout` |

提供者从登录命令的输出中提取第一个 `https://` 地址，ChatGPT 还会提取其后输出的一次性设备验证码；两者都出现在尝试视图中。仅退出码为零不会添加账号：状态命令必须报告已登录账号，否则提供者运行退出命令、删除目录，并以 `identity-unavailable` 使尝试失败。已取消、失败和超时的尝试会删除其目录。

<a id="understand-the-implementation"></a>
## 理解实现

`accounts.json` 保存 `version`、账号记录（`id`、`kind`、`email`、`plan`、`createdAt`）以及每种账号一个可选的默认 id。文件通过临时文件加重命名整体替换，并在提供者启动时校验：无法读取的文件、非 UUID 的 id、重复的 id，或默认值未指向该种类账号时，提供者启动失败而不做修复。账号 id 由 Host 生成的 UUID 充当，因为它们用作目录名。修改逐一执行，每次变化都在文件写入后才发布和通知。CLI 子进程环境是 subprocess 接缝已清除凭据的父环境加上唯一的目录变量。提供者状态只有一个所有者，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [ai-account](../ai-account/README.zh.md) — 服务定义与视图。
- [subagent-ai-account](../../subagent/subagent-ai-account/README.zh.md) — 以默认账号运行产品子代理提供者。
- [官方 CLI AI 账号决策](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.zh.md) — 提供者为何从不接触令牌。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-ai-account-platform) — 所有可接受的字段。

<a id="model-experience"></a>
## 模型体验

无，因为 AI 账号管理不注册模型上下文或工具；订阅凭据保留在官方 CLI 中。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **登录在 Host 上运行** — Claude CLI 在 Host 机器上打开浏览器；远程浏览器用户改为打开界面显示的地址，而需要把代码粘贴回 CLI 的 Claude 流程无法完成，因为 CLI 的标准输入已关闭。
- **CLI 输出格式没有版本约定** — 地址和设备验证码的提取以及 Codex 状态文本匹配当前官方 CLI 输出；格式变化可能使 `url` 或 `userCode` 为空，或导致身份读取失败。
- **中断的登录可能留下目录** — 登录期间 Host 崩溃会在 `root` 下留下没有账号记录的目录；这些目录不会被清理。

<a id="dev-note"></a>
### 开发备注

无。
