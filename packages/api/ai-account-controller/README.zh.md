---
description: "aiAccount Remote 控制器向浏览器公开 AI 账号快照与命令，不包含凭据或 Host 目录路径。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-ai-account-controller

[English](README.md) | 中文

## 概述

`aiAccount` Remote 命名空间让设置界面列出 AI 账号、启动或取消官方 CLI 登录、选择默认账号并移除账号。它把每次调用转发给 `ctx.aiAccount`，并返回同样不含凭据的快照。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Web App Bundle 以 `ai-account-controller` 行挂载此控制器。命名空间公开 `getState`、`startSignIn(kind)`、`cancelSignIn(attemptId)`、`submitSignInCode(attemptId, code)`、`setDefault(accountId)`、`removeAccount(accountId)` 以及流式方法 `watch`。每个命令在完成后返回完整快照，`watch` 从当前快照开始。取消与提交授权码都指定尝试 id，因此过期的页面既无法取消更新的登录，也无法把授权码发给它。提交的授权码送达官方 CLI 的终端，从不在此存储或记录。`defaultHome` 不公开：账号目录保留在 Host 上。

<a id="understand-the-implementation"></a>
## 理解实现

控制器是基于 `ctx.aiAccount` 的 Typert Remote 服务，自身不持有状态；不发布不变量配套模块。未知账号 id 等提供者失败会作为 Remote 错误返回给调用方。

<a id="further-exploration"></a>
## 深入探索

- [ai-account](../../credentials/ai-account/README.zh.md) — 服务定义与视图。
- [ui-settings-ai-account](../../client/ui-settings-ai-account/README.zh.md) — 使用此命名空间的设置页面。
- [api-remotes](../remotes/README.zh.md) — 在浏览器中挂载此命名空间的 Remote 组装。

<a id="model-experience"></a>
## 模型体验

无，因为 AI 账号管理不注册模型上下文或工具；订阅凭据保留在官方 CLI 中。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **登录的生命周期跟随 Host 而非页面** — 重新连接的页面可以通过 `watch` 恢复进行中的尝试，但 Host 重启会结束该尝试及其 CLI 进程。

<a id="dev-note"></a>
### 开发备注

无。
