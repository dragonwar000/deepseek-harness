---
description: "基于 MSAL Node 的 Coteccons SSO 提供者：通过 PKCE 与回环重定向进行 Microsoft Entra ID 浏览器登录，令牌缓存保存为一条凭据存储记录，并静默刷新令牌。"
kind: "package-reference"
---

# @deepseek-ai/dsh-coteccons-sso-msal

[English](README.md) | 中文

## 概述

挂载此提供者后，`ctx.cotecconsSso` 通过 `@azure/msal-node` 进行真实的 Microsoft Entra ID 登录。应用注册是公共客户端，因此不存在客户端密钥：用户在系统浏览器中登录，MSAL 在回环监听器上接收授权码，所得的刷新令牌、访问令牌和 ID 令牌只保存在 Harness 凭据存储中。Azure AI scope 的访问令牌从该缓存静默刷新。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Web App Bundle 以 `coteccons-sso` 行挂载此提供者，并配置 CTD-Core 应用注册的 `tenantId` 与 `clientId`。它依赖 `ctx.credentials`。配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `tenantId` | 未设置 | 目录（租户）id 或已验证域名 |
| `clientId` | 未设置 | 公共客户端应用注册的应用程序（客户端）id |
| `authority` | `https://login.microsoftonline.com/<tenantId>` | 授权机构 URL（HTTPS） |
| `scopes` | `openid`、`profile`、`offline_access` | 登录时除 `aiScope` 外请求的 scope |
| `aiScope` | `https://cognitiveservices.azure.com/.default` | 登录时授予同意并用于模型请求的 Azure AI scope |
| `allowedDomains` | 空 | 允许登录的小写邮箱域名；为空时允许租户中的所有账号 |
| `openBrowser` | `true` | 在 Host 的默认浏览器中打开登录页面；无论如何都会发布该 URL |
| `signInTimeoutMs` | `300000` | 一次浏览器登录的期限（10 秒–30 分钟） |

`tenantId` 或 `clientId` 未设置时，状态为 `not-configured` 并列出缺失字段；提供者仍会启动，因此 AI 账号页面可以加载。已设置但格式错误的值（非 GUID 的 `clientId`、非 HTTPS 的 `authority`、含大写字母的域名）会在加载时使该行失败。应用注册需要在"移动和桌面应用程序"平台上配置重定向 URI `http://localhost` 并允许公共客户端流，需要委托权限 Azure Cognitive Services `user_impersonation` 并授予管理员同意；每个用户需要在 AI 资源上拥有 Azure RBAC 角色，例如"Cognitive Services OpenAI User"。

<a id="understand-the-implementation"></a>
## 理解实现

`startSignIn` 以 `prompt: select_account` 以及登录 scope 加 `aiScope` 调用 MSAL `acquireTokenInteractive`，因此在登录时即获得 AI 资源的同意。MSAL 在 `127.0.0.1` 的随机端口上监听，提供者先在 `signing-in` 视图中发布授权 URL，再通过 `open` 包打开它。取消、超时和释放会向该回环监听器提交 OAuth `access_denied` 响应，使 MSAL 结束并关闭监听器。登录后会按 `allowedDomains` 检查账号 UPN 的域名；被拒绝账号的令牌会被删除，状态变为带 `domain-not-allowed` 的 `error`。只保留新登录的账号。

MSAL 缓存插件通过 `ctx.credentials` 读写一条 `grant` 记录 `coteccons-sso/token-cache`；其载荷写明 `clientId` 与 `authority`，属于其他注册的记录会被忽略。存储写入失败时记录日志，本进程继续使用内存缓存。无法读取的已存缓存会在启动时删除。`getAccessToken` 调用 `acquireTokenSilent`；Entra ID 要求交互时删除该记录，状态变为带 `session-expired` 的 `error`。退出登录会删除记录并重建 MSAL 客户端，不保留任何内存令牌。日志只包含错误名称和代码，从不包含令牌内容。提供者状态只有单一所有者，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [coteccons-sso](../coteccons-sso/README.zh.md) — 服务定义与视图。
- [credentials](../credentials/README.zh.md) — 保存令牌缓存的凭据存储。
- [Coteccons SSO 决策](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.zh.md) — 设计与 Azure 前置条件。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-coteccons-sso-msal) — 所有可接受的字段。

<a id="model-experience"></a>
## 模型体验

无，因为登录提供者不注册模型上下文或工具；令牌只影响 HTTP 认证。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **浏览器必须运行在 Host 上** — 重定向到达 Host 上的回环监听器，因此其他机器上的浏览器无法完成登录。
- **收到 401 时不按请求刷新** — Azure 拒绝的令牌不会在过期前刷新；该请求失败，之后的请求会获得新令牌。

<a id="dev-note"></a>
### 开发备注

无。
