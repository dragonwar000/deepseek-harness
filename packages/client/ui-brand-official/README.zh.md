---
description: "面向侧栏的官方 CTD Core 品牌填充，仅在官方构建中生效；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包让以 `official` profile 构建的客户端在侧栏显示 CTD Core 名称字标。所有构建 profile 本就在侧栏显示同一个 Coteccons 标志——本包的标志填充渲染的正是外壳回退所用的同一个 `CtdMark` 图形——因此两者的差异只在名称呈现：官方字标 SVG，而非外壳的纯文本本地构建标签。会话首屏无论 profile 如何都使用 Coteccons 标志回退。品牌为 CTD Core 的部署应选择本包；使用其他品牌的部署应提供替代品牌包。本包不保留运行时状态，也不影响模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在采用 CTD Core 自有品牌的部署中，将本插件挂载到浏览器插件名单；一旦挂载，其填充无条件注册。

### 选择 profile

本包内部没有构建 profile 判断：一旦插件挂载，`apply()` 始终注册 `OfficialBrandMark` 与 `OfficialBrandName`。部署的组合方式——而非某个运行时环境值——才决定本包是否出现在插件名单中；`DSH_CLIENT_BUILD_PROFILE` 只选择其他地方读取的内嵌 `official`/默认客户端构建记录（参见 [`scripts/client-build-environment.ts`](../../../scripts/client-build-environment.ts)），与本包自身的注册无关。未将本包纳入名单的部署会保留外壳回退——Coteccons 标志与本地构建标签。会话首屏无论 profile 如何都显示来自 `dsh-client-ui-conversation` 的 Coteccons 标志回退，因为这个回退本身就是官方标志。

### 替换品牌

自有身份的部署不组合本包，而是组合另一个占据侧栏 slot——以及本包留给回退的首屏 slot——的包。占据 slot 是唯一的组合路径；这里不存在任何品牌配置面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个填充作为一组声明感知的注册安装：嵌套的 `ctx.slots.inject()` 调用等待侧栏声明，因此无论本行在声明者之前还是之后激活，这组注册都能工作；声明消失时两个填充一并撤回，HMR 期间也不会留下残缺的品牌混合。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是一个空 Loader 座位。浏览器标题是构建环境的事（`DSH_CLIENT_TITLE`），不在 slot 系统之内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了品牌呈现的供给方式。它们是当前包约束，不是品牌设计对比或任务积压。

- **只有一组填充**——替代呈现属于占据相同 slot 的另一个 Cordis 包。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包不保留可变状态，三个 slot occupant 通过同一个事务性 effect 安装和释放。
