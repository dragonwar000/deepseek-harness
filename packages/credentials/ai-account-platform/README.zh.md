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
| `loginRows` | `40` | 为登录命令分配的终端行数（1–1000） |
| `loginCols` | `200` | 该终端的列数（40–1000）；终端过窄会折行 CLI 输出的地址 |
| `loginTerminalType` | `xterm-256color` | 向登录命令声明的 `TERM`；主机必须具备其 terminfo 条目 |

| 种类 | 账号目录 | 登录 | 身份 | 退出 |
|---|---|---|---|---|
| `claude` | `<root>/claude/<id>`，作为 `CLAUDE_CONFIG_DIR` | `claude auth login --claudeai` | `claude auth status --json` | `claude auth logout` |
| `chatgpt` | `<root>/codex/<id>`，作为 `CODEX_HOME` | `codex login --device-auth` | `codex login status` | `codex logout` |

登录命令运行在终端上，而不是管道上。两个官方登录命令都会渲染终端界面并从中读取确认，因此当标准输入为 `/dev/null` 时，它们输出地址后便等待一个永远无法到达的应答——尝试只能在 `loginTimeoutMs` 时结束。只有登录命令获得终端；状态和退出命令不交互，仍使用管道。

提供者从登录命令的输出中提取第一个 `https://` 地址，ChatGPT 还会提取其后输出的一次性设备验证码；两者都出现在尝试视图中。Claude 浏览器页面最后会给出授权码，因此 Claude 尝试会报告 `awaitingCode`，并在 `submitSignInCode` 将该授权码写入登录命令的终端后完成；授权码被直接透传，从不存储、记录或与 CLI 的输出匹配。ChatGPT 的设备流程通过轮询获取授权且不读取任何输入，因此从不报告 `awaitingCode`。

仅退出码为零不会添加账号：状态命令必须报告已登录账号，否则提供者运行退出命令、删除目录，并以 `identity-unavailable` 使尝试失败。记录账号失败会报告为 `store-failed` 而非 `login-failed`，因为厂商确实已登录，失败的只是本 Harness 自身的写入；随后提供者运行退出命令，使被丢弃的目录不会保留没有任何账号记录指向的凭据。每次未成功的尝试都会删除其目录；当该种类不再有其他账号时，也会删除曾容纳它的 `<root>/<kind>/` 目录，使空的种类目录不会看起来像已登记的账号。

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

- **登录在 Host 上运行** — Claude CLI 在 Host 机器上打开浏览器；远程浏览器用户改为打开界面显示的地址，并通过尝试视图把得到的授权码粘贴回来。
- **一次只有一个登录尝试，且看不到其终端** — 提供者只呈现地址、设备验证码和 `awaitingCode`；登录命令在终端上询问其他内容时无法应答，尝试将在 `loginTimeoutMs` 时结束。
- **CLI 输出格式没有版本约定** — 地址和设备验证码的提取以及 Codex 状态文本匹配当前官方 CLI 输出；格式变化可能使 `url` 或 `userCode` 为空，或导致身份读取失败。
- **中断的登录可能留下目录** — 登录期间 Host 崩溃会在 `root` 下留下没有账号记录的目录；这些目录不会被清理。
- **被拒绝的授权码会结束该次尝试** — CLI 对其拒绝的授权码以非零码退出，提供者将其报告为 `login-failed`；用户应开始新的尝试，而不是在同一次尝试中重新输入。

<a id="dev-note"></a>
### 开发备注

无。
