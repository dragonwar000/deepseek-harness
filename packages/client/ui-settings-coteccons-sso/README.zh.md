---
description: "AI 账号设置页中的 Coteccons SSO 分组：用于主模型的 Microsoft Entra ID 登录，显示浏览器链接、已登录账号并支持退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-coteccons-sso

[English](README.md) | 中文

## 概述

打开 **设置 → AI 账号**：第一个分组 **Coteccons SSO — 用于主模型** 让 Coteccons 员工使用其 Microsoft 账号登录。登录期间，Coteccons 模型以该用户本人的登录身份运行；分组显示登录者、租户以及 **退出登录** 按钮。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

分组显示五种状态之一。**未配置** 列出缺失的 `tenantId` 或 `clientId` 以及设置位置。**未登录** 提供 **使用 Coteccons SSO 登录**。**登录中** 提示用户在 Host 打开的浏览器窗口中完成登录，在没有打开窗口时显示 Microsoft 登录链接，并提供 **取消**。**已登录** 列出姓名、邮箱与租户 id，并提供 **退出登录**。登录失败或过期时，在登录按钮旁说明原因（未完成、超时、不是 Coteccons 账号、已过期）。在本页面发起的登录完成后，第一个 Coteccons 模型成为 Agent 默认模型。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 半边是一个空的 `apply`，为包提供 Loader 行。浏览器半边通过可重连的 Remote 流订阅 `ctx.remote.cotecconsSso.watch`，经由分组的 `sso` hook 发布每个快照，并以 id `coteccons`、顺序 `0` 将 `CotecconsSsoGroup` 注册到 `settings.ai-account.group` 插槽。从 `signing-in` 转为 `signed-in` 时，它调用 `ctx.remote.session.initializeDefaultModel('coteccons')`；被拒绝或连接断开时记录日志，默认模型保持不变。命令会发布其返回的快照；被拒绝的命令显示通用失败信息，流结束时保留最后的快照并提示刷新页面。标题带有 Coteccons 标志（`CtdMark`）。所有文案位于 `settings.cotecconsSso` 词典（英文与中文）。显示的每项事实都来自 Host 登录流，因此不发布不变量配套模块。

</details>

<a id="further-exploration"></a>
## 深入探索

- [coteccons-sso](../../credentials/coteccons-sso/README.zh.md) — 服务定义与视图。
- [api-coteccons-sso-controller](../../api/coteccons-sso-controller/README.zh.md) — 此分组调用的 Remote 命名空间。
- [ui-settings-ai-account](../ui-settings-ai-account/README.zh.md) — 声明分组插槽的页面。

<a id="model-experience"></a>
## 模型体验

无，因为设置分组不注册模型上下文或工具；它只在登录后更改已保存的默认模型。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **默认模型跟随打开页面看到的登录** — 在没有设置页面观察到该转变时完成的登录（例如来自 Desktop 欢迎页）只有在该界面自行请求时才会设置默认模型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
