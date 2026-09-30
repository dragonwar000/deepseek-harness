---
description: "coteccons 模型路由：通过 OpenAI 兼容的 v1 端点，以已登录 Coteccons 用户自己的 Entra ID 令牌调用 Azure OpenAI 或 Foundry 模型，由 Azure RBAC 而非 API key 授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-coteccons-sso

[English](README.md) | 中文

## 概述

此插件注册 `coteccons` 模型路由。每个请求都以 `Authorization: Bearer <token>` 发送到 Coteccons Azure AI 资源，其中令牌是来自 `ctx.cotecconsSso` 的已登录用户自己的 Entra ID 访问令牌。资源上的 Azure RBAC 决定谁可以调用；不配置也不保存任何 API key。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Web App Bundle 以 `llm-coteccons-sso` 行挂载此路由。配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `displayName` | `Coteccons` | 模型选择器中显示的名称 |
| `baseURL` | `https://ctd-opus-resource.openai.azure.com/openai/v1` | OpenAI 兼容的 v1 端点；必须为 HTTPS，或仅对回环地址使用普通 HTTP |
| `models` | `DeepSeek-V4-Pro`（上下文 131,072，无推理控制）、`gpt-5.6-terra` | 端点上的部署，采用 `llm-pi-ai` 模型条目格式；每个 `id` 作为请求的 `model` 发送 |

无论是否有人登录，模型都会列出。无人登录时的请求以 `LlmError` 代码 `MISSING_CREDENTIAL` 失败，消息指向 **设置 → AI 账号**；登录过期或 Host 未配置 Coteccons SSO 时也使用同一代码。在设置页面登录后，第一个模型成为 Agent 默认模型。

<a id="understand-the-implementation"></a>
## 理解实现

该路由是一个协议为 `openai-completions` 的 `llm-pi-ai` 配置档，加载时通过 `resolveProfiles` 解析一次，因此无效的模型条目会使该行失败。每次模型请求时，适配器调用 `ctx.cotecconsSso.getAccessToken(aiScope)`，并把令牌作为 pi-ai 的 `apiKey` 覆盖值传入，OpenAI SDK 将其作为 Bearer 凭据发送。pi-ai 自身保存的登录和环境发现对此路由不返回任何内容。该路由以空设置路径登记在可配置提供方目录中，因此 Models 页面列出它但不显示凭据字段。插件不持有状态，因此不发布不变量配套模块。

<a id="further-exploration"></a>
## 深入探索

- [coteccons-sso](../../credentials/coteccons-sso/README.zh.md) — 令牌来源。
- [llm-pi-ai](../llm-pi-ai/README.zh.md) — 适配器、配置档解析与模型条目字段。
- [Coteccons SSO 决策](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.zh.md) — 为何以按用户令牌取代 API key。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-coteccons-sso) — 所有可接受的字段。

<a id="model-experience"></a>
## 模型体验

### 已鉴权的模型请求

#### What the model sees

`coteccons` 请求不包含本插件添加的模型可见文本；请求由共享的 `openai-completions` 传输序列化。

#### Token effect

鉴权不增加输入 token；实际调用的 token 由所选模型与请求内容决定。

#### KV Cache effect

令牌与登录状态不进入模型输入；协议传输拥有请求前缀的序列化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **访问失败表现为提供方错误** — 在资源上没有 RBAC 角色的用户会收到 Azure 的 401 或 403，作为普通请求失败，而不是登录提示。
- **静态目录** — 模型通过配置给出，不从资源发现。

<a id="dev-note"></a>
### 开发备注

无。
