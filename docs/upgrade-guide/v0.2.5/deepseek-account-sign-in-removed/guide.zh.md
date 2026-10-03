---
kind: upgrade-guide
description: "发布组合禁用了 DeepSeek 账号登录；主模型现在由 Coteccons SSO 或 API Key 提供。"
---

# Coteccons SSO 取代 DeepSeek 账号登录

[English](guide.md) | 中文

## 变更

此前 Desktop 引导流程和设置页提供 DeepSeek 账号登录，`deepseek-account` 模型路由用该账号的 token 运行主模型。Web 组合还显示侧边栏账号菜单、额度和赠金通知，并挂载 `account` remote 命名空间。

现在 `@deepseek-ai/dsh-base` 对 `deepseek-account` 和 `llm-deepseek-account` 两行设置 `disabled: true`，`@deepseek-ai/dsh-web-app` 对 `ui-settings-account` 和 `account-controller` 设置同样的值。这些行保留原 id。基于这些 bundle 的所有 profile 都受影响，包括 CLI profile。主模型现在来自以下两种来源之一：

- **使用 Coteccons SSO 登录**（设置 → AI 账号，或 Desktop 欢迎窗口）通过 Microsoft Entra ID 登录，并启用 `coteccons` 模型路由。
- **添加 API Key** 保存某个提供商的 API key；DeepSeek API key 路由 `deepseek-official` 仍然挂载。

AI 账号页面还列出 Claude 和 ChatGPT 订阅。它们通过官方 Claude Code 和 Codex CLI 登录，只运行委派的 Claude Code 或 Codex 任务，从不提供主模型。

升级后，使用 `deepseek-account` 路由的会话或默认模型没有提供商，`account/*` remote 调用也没有处理方。已保存的 DeepSeek 账号凭据仍留在 `$DSH_HOME/.credentials.yaml` 中，不再使用。

## 迁移

1. 打开设置 → AI 账号，选择**使用 Coteccons SSO 登录**，或选择**添加 API Key** 并输入 DeepSeek 开放平台 API key 或其他提供商的 key。
2. 在默认模型以及每个使用过 `deepseek-account` 模型的会话中，选择 `coteccons` 路由或所添加提供商的模型。
3. 移除调用 `account` remote 命名空间的 SDK 或 HTTP 调用方；登录状态改用 `cotecconsSso`。
4. 如需在自行管理的 profile 中保留 DeepSeek 账号登录，在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中添加按 id 定位的覆盖项：`- id: deepseek-account` 和 `- id: llm-deepseek-account` 并设置 `disabled: false`，Web profile 还需对 `ui-settings-account` 和 `account-controller` 做同样设置。Desktop 欢迎窗口不再提供 DeepSeek 账号登录；请在设置页登录。
5. 确认：在新会话中发送一条消息，检查回复来自所选模型，且没有 `MISSING_CREDENTIAL` 或 `ACCOUNT_SIGN_IN_REQUIRED` 错误。
