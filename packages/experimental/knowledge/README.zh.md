---
description: "实验性知识 seam 的 Service Definition（ctx.knowledge）：页面与边的词汇、抽象的 KnowledgeService，以及 knowledge/write 与 knowledge/inject 会话事件，面向要添加知识库提供方或消费方的插件作者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge

[English](README.md) | 中文

## 概述

本包是知识能力 seam 的 Service Definition。它把 `ctx.knowledge` 声明为抽象的 `KnowledgeService`，用于列出、搜索、读取、引用和写入一个知识库的页面；声明页面、边与关系的词汇以及稳定的边 id；并声明两个仅记录日志的会话事件：每次尝试写入知识库都记录 `knowledge/write`，每次注入索引都记录 `knowledge/inject`。本包不提供知识库：提供方继承 `KnowledgeService`。本包是实验性的，不承诺稳定性。

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

编写知识库提供方或消费方时依赖本包。它不是插件行：挂载一个提供方来注册 `ctx.knowledge`，并在消费方中注入 `knowledge`。

### 何时选择

当插件读取或写入比会话存活更久、且必须能追溯到其来源会话事件的持久知识时，选择它。仅属于单个会话的笔记应放在会话日志中。

### 契约

每个方法都接收一个带会话工作目录与取消信号的 `KnowledgeScope`，因为知识库根目录相对会话工作区解析。读取操作每次调用都从已存储的页面推导边、过期状态与排序。`write` 检查每条知识库规则，并以 `refused` 返回被违反的规则，包括出处未引用任何会话事件的写入；它只在 I/O 失败时抛出异常。`includes` 告诉守卫某个工作区路径是否位于知识库内。以状态 `archived` 写入的条目仍可通过 `read` 与 `cite` 读取，但不出现在 `index`、`query` 与 `neighbors` 中；`read` 返回写入方提供的页面 `body`，因此以新状态写回它即可重现该页面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`edgeId(from, to, relation)` 是 `e:` 加 sha1(`from|to|relation`) 的前八位十六进制数字，与 overstack `wiki-graph.py` 的函数相同，因此两个工具在同一 wiki 上的边 id 一致。关系包括页面声明的六种（`derives-from`、`depends-on`、`implements`、`supports`、`contradicts`、`supersedes`）、正文链接（`wikilink`、`mdlink`），以及指向工作区代码路径的 `touches` 边；边的目标是页面或代码路径。

### 设计说明

- **出处是一种关系，在追加时检查。** `./invariant` 伴随插件检查每条已应用的 `knowledge/write` 至少引用一个事件，并且进程观察到的每个被引用事件都是同一会话中更早的成功 `tool/result`。早于进程为某个会话观察到的第一个事件的引用不做检查，因为恢复的会话之前的事件未被观察到。
- **两个事件都是读取时必需的。** 它们是记录在持久化目录中的普通 `SessionEventMap` 成员；都不会进入模型请求。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `KnowledgeService` 与 `ctx.knowledge` 声明 |
| [`src/types.ts`](src/types.ts) | 词汇与两个 `SessionEventMap` 成员 |
| [`src/edge.ts`](src/edge.ts) | `edgeId`、关系列表、id 品牌化 |
| [`src/tool-path.ts`](src/tool-path.ts) | 供从已记录工具调用推导来源的消费方使用的 `pathArgument` 与 `foldToolPath` |
| [`src/invariant.ts`](src/invariant.ts) | 出处不变量伴随插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识子系统页面](../../../docs/subsystems/knowledge.zh.md) — seam、其角色与生成的服务接口。
- [实验性分组地图](../README.zh.md) — 同组的实验性包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过 `ctx.knowledge` 的提供方与消费方：本包只声明类型、一个抽象服务与两个仅记录日志的会话事件，不注册任何面向模型的内容。

#### KV Cache 影响

无关：本包不会向请求中加入任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有页面与代码** — 边的目标是页面或代码路径；章节与会话节点尚无确定性的来源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
