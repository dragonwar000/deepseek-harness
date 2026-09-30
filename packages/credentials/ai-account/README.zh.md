---
description: "AI 账号服务定义：登记登录状态保存在官方 Claude Code 与 Codex CLI 中的 Claude 和 ChatGPT 订阅账号，为每种账号选择一个默认账号，并监听账号列表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ai-account

[English](README.md) | 中文

## 概述

账号使用方可以列出 Claude 和 ChatGPT 订阅账号，通过官方 CLI 登录添加账号，为每种账号选择默认账号，并移除账号。每个账号拥有一个官方 CLI 配置目录，其订阅凭据不会离开该目录：服务只向启动同一官方 CLI 的 Host 使用方提供该目录路径。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`ctx.aiAccount` 是一个 `AiAccount`。`claude` 类账号通过 Claude Code 登录，`chatgpt` 类账号通过 Codex 登录。

| 操作 | 约定 |
|---|---|
| `getState()` | 完整的 `AiAccountsView`：账号先按种类、再按登记时间排序，并附带最近一次登录尝试 |
| `startSignIn(kind)` | 加入进行中的尝试，或为新账号启动官方 CLI 登录；在用户授权之前返回 |
| `cancelSignIn(id)` | 取消指定的尝试并丢弃其未完成的目录；过期的 id 不改变任何状态 |
| `submitSignInCode(id, code)` | 将厂商浏览器页面显示的授权码交给正在读取授权码的登录命令；过期的 id 或不读取授权码的尝试不改变任何状态 |
| `setDefault(id)` | 将一个账号设为该种类的默认账号 |
| `remove(id)` | 通过其 CLI 退出账号、删除其目录并忘记该账号；移除默认账号时，该种类中最早登记的剩余账号成为默认账号 |
| `watch(signal)` | 从当前快照开始的完整快照流；结束订阅不会取消登录 |
| `defaultHome(kind)` | 仅限 Host 的默认账号绝对目录；该种类没有默认账号时为 `undefined` |

一次尝试依次经过 `starting`、`waiting-browser`（Claude）或 `waiting-device-code`（ChatGPT）、`verifying`，最终为 `succeeded`、`cancelled`，或带有 `executable-missing`、`login-failed`、`timeout`、`identity-unavailable`、`store-failed` 之一 `errorCode` 的 `failed`。`login-failed` 是 CLI 自身的拒绝；`store-failed` 表示 CLI 已登录但账号未能记录，因此已将其退出登录。`url` 携带 CLI 输出的浏览器或验证地址，`userCode` 携带 Codex 一次性验证码。登录命令从其终端读取授权码期间会设置 `awaitingCode`，该通道由 `submitSignInCode` 应答；Claude 浏览器页面最后会给出这样的授权码，而 ChatGPT 采用轮询，从不读取授权码。某种类的第一个账号成为其默认账号。每次默认账号变化（包括变为无默认账号）都会在变化存储后发出带有种类的 `ai-account/default-changed`。

<a id="understand-the-implementation"></a>
## 理解实现

本包只定义操作和不含凭据的视图；提供者负责 CLI 进程、元数据文件和账号目录。服务不持有可被第二次观测否定的关系，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [ai-account-platform](../ai-account-platform/README.zh.md) — 官方 CLI 提供者。
- [api-ai-account-controller](../../api/ai-account-controller/README.zh.md) — 向浏览器公开视图的 Remote 控制器。
- [subagent-ai-account](../../subagent/subagent-ai-account/README.zh.md) — 为默认账号挂载 Claude Code 和 Codex 子代理提供者。
- [官方 CLI AI 账号决策](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md) — 凭据为何保留在官方 CLI 中。

<a id="model-experience"></a>
## 模型体验

无，因为 AI 账号管理不注册模型上下文或工具；订阅凭据保留在官方 CLI 中。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **一次只有一个尝试** — `startSignIn` 会加入任一种类的进行中尝试，而不是启动第二个登录。
- **身份以 CLI 报告为准** — Codex 不报告邮箱，因此 ChatGPT 账号通常不显示邮箱或套餐。

<a id="dev-note"></a>
### 开发备注

无。
