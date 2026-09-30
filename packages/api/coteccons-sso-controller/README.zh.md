---
description: "cotecconsSso Remote 控制器向浏览器公开 Coteccons SSO 登录状态与命令，不包含令牌。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-coteccons-sso-controller

[English](README.md) | 中文

## 概述

`cotecconsSso` Remote 命名空间让设置界面和 Desktop 欢迎页读取 Coteccons SSO 状态、启动或取消浏览器登录并退出登录。它把每次调用转发给 `ctx.cotecconsSso`，并返回同样不含令牌的快照。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Web App Bundle 以 `coteccons-sso-controller` 行挂载此控制器。命名空间公开 `getState`、`startSignIn`、`cancelSignIn(attemptId)`、`signOut` 以及流式方法 `watch`。每个命令在完成后返回完整快照，`watch` 从当前快照开始。取消操作指定尝试 id，因此过期的页面无法取消更新的登录。`getAccessToken` 与 `aiScope` 不公开：令牌保留在 Host 上。

<a id="understand-the-implementation"></a>
## 理解实现

控制器是基于 `ctx.cotecconsSso` 的 Typert Remote 服务，本身不持有状态；不发布不变量配套模块。提供者失败（例如退出登录时的凭据存储错误）以 Remote 错误返回给调用方。

<a id="further-exploration"></a>
## 深入探索

- [coteccons-sso](../../credentials/coteccons-sso/README.zh.md) — 服务定义与视图。
- [ui-settings-coteccons-sso](../../client/ui-settings-coteccons-sso/README.zh.md) — 使用此命名空间的设置分组。
- [api-remotes](../remotes/README.zh.md) — 在浏览器中挂载此命名空间的 Remote 组装。

<a id="model-experience"></a>
## 模型体验

无，因为登录控制器不注册模型上下文或工具；令牌从不经过 Remote 传输。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **登录不随页面结束，但随 Host 结束** — 重新连接的页面通过 `watch` 恢复进行中的尝试，但 Host 重启会结束该尝试及其回环监听器。

<a id="dev-note"></a>
### 开发备注

无。
