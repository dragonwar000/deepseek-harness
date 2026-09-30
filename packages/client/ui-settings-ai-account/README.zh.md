---
description: "dsh Web 客户端中的 AI 账号设置页：先显示用于主模型的 Coteccons SSO 分组，再显示通过官方 CLI 添加的 Claude 与 ChatGPT 订阅账号，可为每种账号选择默认账号并退出账号。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-ai-account

[English](README.md) | 中文

## 概述

打开 **设置 → AI 账号** 即可管理应用使用的所有账号。**Coteccons SSO — 用于主模型** 分组让 Coteccons 员工通过 Microsoft Entra ID 登录；主模型以该用户本人的登录身份运行。Claude 与 ChatGPT 分组添加订阅账号、显示每种账号的默认账号、切换默认账号并退出账号；添加账号会在 Host 上运行官方 Claude Code 或 Codex 登录，页面显示需要打开的链接，ChatGPT 还会显示需要输入的一次性验证码。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

页面按顺序显示三个分组。**Coteccons SSO — 用于主模型** 来自 [ui-settings-coteccons-sso](../ui-settings-coteccons-sso/README.zh.md)，由它负责登录与退出登录；本页面只保留其位置。**Claude — 通过 Claude Code 使用** 与 **ChatGPT — 通过 Codex 使用** 列出官方 CLI 账号。每一行显示 CLI 报告的邮箱（未报告时显示 **已登录账号**）、已知的套餐，默认账号带有 **默认** 标记。**设为默认** 切换该种类的默认账号；**退出并移除** 通过其 CLI 退出账号并忘记该账号。

每个订阅分组还会说明它为何不向聊天模型选择器添加任何模型，以及替代它的是哪个密钥：Claude 订阅签发给 Anthropic 自有的 Claude Code 客户端，ChatGPT 订阅签发给 OpenAI 自有的 Codex 客户端，因此只有这些客户端可以发送它们；若要让主模型运行在该厂商上，需在 **模型** 中添加 Anthropic 或 OpenAI API 密钥。该规则及其背后的分类由 [llm-pi-ai](../../llm/llm-pi-ai/README.zh.md#use-this-package) 负责。

**添加 Claude 账号** 会启动 `claude auth login`：Claude CLI 在 Host 上打开浏览器窗口，页面同时显示授权链接以防窗口未打开。**添加 ChatGPT 账号** 会启动 `codex login --device-auth`：页面显示验证链接以及需要在该处输入的一次性验证码。**取消** 会停止登录。失败信息会说明 CLI 缺失、登录未完成、登录超时，或 CLI 未报告已登录账号。登录进行中时无法添加账号。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 半边是一个空的 `apply`，为包提供 Loader 行。浏览器半边通过可重连的 Remote 流订阅 `ctx.remote.aiAccount.watch`，经由区块的 `accounts` hook 发布每个快照，并以 id `ai-account` 将 `AiAccountSection` 注册到 `settings.section` 插槽。该区块声明 `settings.ai-account.group` 列表插槽，并在任何账号列表状态下都把其条目渲染在简介之后、Claude 与 ChatGPT 分组之前，因此拥有独立 Host 流的分组（Coteccons SSO）在官方 CLI 列表加载中或丢失后仍可使用。命令会发布其返回的快照；被拒绝的命令显示通用失败信息，账号流结束时保留最后的快照并提示刷新页面。所有文案位于 `settings.aiAccount` 词典。显示的每项事实都来自 Host 账号流，因此不发布不变量配套模块。

</details>

<a id="further-exploration"></a>
## 深入探索

- [ai-account](../../credentials/ai-account/README.zh.md) — 服务定义与视图。
- [api-ai-account-controller](../../api/ai-account-controller/README.zh.md) — 此页面调用的 Remote 命名空间。
- [ui-settings](../ui-settings/README.zh.md) — 承载区块插槽的设置页面。

<a id="model-experience"></a>
## 模型体验

无，因为 AI 账号管理不注册模型上下文或工具；订阅凭据保留在官方 CLI 中。

#### KV Cache effect

无；此包既不组装也不发送提供者请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **移除不需要确认** — **退出并移除** 会立即执行；重新登录是恢复方式。
- **指向「模型」只是文字，不是链接** — 分组说明提到 **模型** 页面，但设置外壳仅向 onboarding slot 暴露 `openSection`，section 无法导航过去；读者需自行切换页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
