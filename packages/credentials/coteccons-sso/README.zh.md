---
description: "Coteccons SSO 服务定义：通过 Microsoft Entra ID 登录一个 Coteccons 员工账号，监听不含凭据的登录状态，并在 Host 上为该用户签发 Azure AI 访问令牌。"
kind: "package-reference"
---

# @deepseek-ai/dsh-coteccons-sso

[English](README.md) | 中文

## 概述

使用方可以读取并监听是否有 Coteccons 员工通过 Microsoft Entra ID 登录，启动或取消浏览器登录，退出登录，并且仅在 Host 上为该用户获取当前访问令牌。视图从不携带令牌，因此可以跨越 Remote 传输；令牌只保留在以 `Authorization: Bearer` 发送给 Azure 的 Host 使用方中。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`ctx.cotecconsSso` 是一个 `CotecconsSso`。客户端安全的视图位于 `@deepseek-ai/dsh-coteccons-sso/types`。

| 成员 | 约定 |
|---|---|
| `aiScope` | 登录时为 Azure AI 请求授予同意的资源 scope；模型路由恰好为此 scope 请求令牌 |
| `getState()` | 当前 `CotecconsSsoView` |
| `startSignIn()` | 加入进行中的尝试或启动浏览器登录；在用户完成之前返回。未配置或已登录时原样返回状态 |
| `cancelSignIn(id)` | 取消指定的尝试；其他 id 不改变任何状态 |
| `signOut()` | 忘记已登录账号并删除其保存的令牌缓存 |
| `watch(signal)` | 从当前快照开始的完整快照流；结束订阅不会取消登录 |
| `getAccessToken(scope, signal?)` | 仅限 Host 的已登录账号 bearer 令牌，过期时静默刷新 |

`CotecconsSsoView` 为以下之一：`not-configured`（附带缺失的设置 `missing`：`tenantId` 和/或 `clientId`）、`signed-out`、`signing-in`（附带 `attemptId` 与 Entra ID 授权 `url`，就绪前为 `null`）、`signed-in`（附带 `account.name`、`account.username`、`account.tenantId`），或 `error`（已退出，附带 `errorCode`：`sign-in-failed`、`timeout`、`domain-not-allowed` 或 `session-expired`）。`getAccessToken` 以 `CotecconsSsoTokenUnavailableError` 拒绝，其 `reason` 为 `not-configured`、`signed-out` 或 `session-expired`；调用方提示用户需要在设置中登录。令牌绝不能发送给 Client、写入日志，或保存在提供者令牌缓存之外。

<a id="understand-the-implementation"></a>
## 理解实现

本包只定义操作、视图和令牌不可用错误；提供者负责 Entra ID 协议、浏览器交接和令牌存储。服务不持有可被第二次观测否定的关系，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [coteccons-sso-msal](../coteccons-sso-msal/README.zh.md) — MSAL 提供者。
- [llm-coteccons-sso](../../llm/llm-coteccons-sso/README.zh.md) — 发送用户令牌的 `coteccons` 模型路由。
- [api-coteccons-sso-controller](../../api/coteccons-sso-controller/README.zh.md) — 供设置界面使用的 Remote 控制器。
- [Coteccons SSO 决策](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md) — 为何由每个用户自己的 Entra ID 令牌调用 Azure AI。

<a id="model-experience"></a>
## 模型体验

无，因为登录服务不注册模型上下文或工具；令牌只影响 HTTP 认证。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **每个 Host 一个账号** — 服务只登录一个账号；以其他用户登录需要先退出。

<a id="dev-note"></a>
### 开发备注

无。
