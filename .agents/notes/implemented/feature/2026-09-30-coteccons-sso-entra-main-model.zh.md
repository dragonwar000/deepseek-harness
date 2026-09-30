# Agent Note: 用于主模型的 Coteccons SSO

Status: implemented

[English](2026-09-30-coteccons-sso-entra-main-model.md) | 中文

## Problem

CTD Core 是 Coteccons 内部产品。其主模型运行在 Coteccons 的 Azure AI 资源（`ctd-opus-resource`，OpenAI 兼容的 v1 端点）上，访问权限必须跟随公司目录：员工离职或变更角色时，通过 Microsoft Entra ID 失去访问权限，而无需任何人轮换共享密钥。沿用的 DeepSeek Platform 登录针对的是 DeepSeek 自己的账号与计费，Coteccons 无法管理；共享的 Azure API key 又会让每个安装使用同一个无法审计的身份。

## Decision

每个用户使用自己的 Coteccons Microsoft 账号登录，并由该用户的 Entra ID 访问令牌以 `Authorization: Bearer` 直接调用 Azure AI。资源上的 Azure RBAC 负责授权；不存在 API key 或客户端密钥。

`@deepseek-ai/dsh-coteccons-sso` 定义 `ctx.cotecconsSso`：不含令牌的视图（`not-configured`、`signed-out`、带授权 URL 的 `signing-in`、`signed-in`、`error`）、登录、取消、退出、监听，以及仅限 Host 的 `getAccessToken(scope, signal)`。`@deepseek-ai/dsh-coteccons-sso-msal` 以 `@azure/msal-node` 的 `PublicClientApplication` 实现它：在系统浏览器中执行带 PKCE 的授权码流程，授权码经 `form_post` 送达 MSAL 在 `127.0.0.1` 上的回环监听器，登录请求 `openid profile offline_access` 以及 Azure AI scope（`https://cognitiveservices.azure.com/.default`），从而一次取得同意。MSAL 令牌缓存通过 `ICachePlugin` 以一条 grant 记录 `coteccons-sso/token-cache` 保存在 Harness 凭据存储中，从不写入普通文件或日志。`acquireTokenSilent` 刷新访问令牌；需要交互的刷新会删除该记录并报告 `session-expired`。退出登录会删除该记录。`allowedDomains` 可选地限制已登录 UPN 的域名。`tenantId` 或 `clientId` 未设置时，提供者报告 `not-configured`，而不是使启动失败。

`@deepseek-ai/dsh-llm-coteccons-sso` 将 `coteccons` 路由注册为一个 `llm-pi-ai` 的 `openai-completions` 配置档（默认模型 `DeepSeek-V4-Pro` 与 `gpt-5.6-terra`），其每个请求的 `apiKey` 就是 SSO 令牌；OpenAI SDK 以 Bearer 凭据发送它，Azure v1 端点接受这种方式，而 Entra 令牌也必须如此发送。未登录时模型仍然列出，此时请求以 `MISSING_CREDENTIAL` 失败并指向 **设置 → AI 账号**。`@deepseek-ai/dsh-api-coteccons-sso-controller` 以 `cotecconsSso` Remote 命名空间公开视图与命令，不含任何令牌方法；`@deepseek-ai/dsh-client-ui-settings-coteccons-sso` 在 AI 账号页面的首位渲染 **Coteccons SSO — 用于主模型** 分组。在该分组完成的登录会调用 `session.initializeDefaultModel('coteccons')`，把该路由的第一个模型保存为 Agent 默认模型。

Web App Bundle 挂载这四个 Host 与浏览器行，并在 `coteccons-sso` 行上配置 CTD-Core 应用注册的公开 `tenantId` 与 `clientId`。DeepSeek Platform 登录从已发布组合中移除：base Bundle 禁用 `deepseek-account` 与 `llm-deepseek-account` 行，Web App Bundle 禁用 `ui-settings-account` 与 `account-controller` 行；这些包仍然保留，profile patch 可以重新启用它们。`llm-deepseek-api-key` 与 `llm-pi-ai` 路由保持挂载。

Azure 侧是前置条件而非 Harness 代码：应用注册是公共客户端，在"移动和桌面应用程序"平台上配置重定向 URI `http://localhost` 并允许公共客户端流，拥有委托权限 Azure Cognitive Services `user_impersonation` 并已授予管理员同意；员工在 AI 资源上获得"Cognitive Services OpenAI User"角色。

## Alternatives considered

**共享的 Azure API key。** 接入最简单，但所有用户共享一个身份，撤销意味着在所有地方轮换密钥，并且密钥会保存在每个安装的凭据存储中。

**机密客户端或后端令牌代理。** 可以让刷新令牌不留在用户机器上，但需要客户端密钥或托管服务，而安装在员工机器上的桌面产品无法保密客户端密钥。

**设备码流程。** 不需要回环监听器，但要求用户在第二个页面输入代码，且更易受钓鱼攻击；回环流程在一个浏览器标签页内完成。

**自行实现 OAuth。** 可以避免依赖，但 PKCE、回环监听器、令牌缓存与刷新正是 MSAL 所维护的内容。

**在 SSO 旁保留 DeepSeek Platform 登录。** 会留下两个主模型登录，其中一个不受 Coteccons 管理，并保留不适用的 DeepSeek 额度与赠送通知。

## Consequences

主模型的访问权限跟随 Entra ID 账号与 Azure 角色分配，每个 Azure 请求都携带具体用户的身份以便审计。刷新令牌与访问令牌保存在本地凭据存储中，同一操作系统用户可读。浏览器必须运行在 Host 上，因为重定向到达回环监听器。没有 RBAC 角色的用户可以登录，但请求会收到 Azure 的授权错误。已发布产品中不再有 DeepSeek 账号余额、额度与赠送通知以及 Desktop 账号引导。测试使用伪造的 MSAL 客户端与本地 HTTP 端点；针对 Coteccons 租户的真实登录以及对 `ctd-opus-resource` 的真实请求仍需人工检查。
