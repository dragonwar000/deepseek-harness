---
kind: upgrade-guide
description: "获准的 llm-pi-ai 登录现在会自行注册提供方路由，新增的 signInRoutes 键可将其关闭。"
---

# 获准的登录会注册自己的模型路由

[English](guide.md) | 中文

## 变更

此前 `@deepseek-ai/dsh-llm-pi-ai` 的路由集合只来自其 `providers` 设置字典：登录提供方会在 `llm-pi-ai/<provider id>` 存储凭据，但不注册任何路由，因此在某个 profile 指明该提供方之前，模型选择器一直是空的。

现在**获准**的存储凭据还会激活一条路由，服务该提供方已安装的 pi-ai 目录，并由存储记录认证。获准指 API 密钥，或 pi-ai 未标记 `isSubscription` 的 OAuth grant。消费者订阅 grant（`anthropic`、`github-copilot`、`kimi-coding`、`meta`、`openai-codex`、`xai`）永不被路由；它仍可供委派的 Claude Code 与 Codex 运行使用。退出登录会随记录一并移除该路由。

任何部署中持有 `llm-pi-ai` 凭据的人都会观察到这一点：已登录但从未声明的提供方现在出现在模型选择器中，`llm.listProviders()` 也会返回它们。`providers` 中的 profile 不受影响——它仍优先于激活，其 `displayName`、`models` 与 `apiKeyEnv` 一律保持原样。

## 迁移

1. 保持已声明路由正常工作无需任何改动。对照选择器或 `llm.listProviders()` 与你的 `providers` 键，即可确认没有变化。
2. 若要让 `providers` 成为路由的唯一来源，请在 `cordis.yml` 或 `llm-pi-ai` 条目的设置补丁中设置新键：

   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       signInRoutes: false
   ```

3. 若要移除某次登录激活的路由，请删除其凭据记录而非编辑配置：使用模型页面的退出登录，或 `credentials.deleteRecord('llm-pi-ai/<provider id>')`。
4. 用 `llm.listProviders()` 确认结果：设为 `signInRoutes: false` 时，它恰好列出你的 `providers` 键；使用默认值时，它还会列出每个持有获准凭据的提供方。
