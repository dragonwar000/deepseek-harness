---
description: "实验性知识库的失败即拒绝守卫：拒绝不经 knowledge_write 修改知识库页面的文件工具写入、编辑与 shell 命令，面向需要每个由智能体写入的页面都带出处的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-rules

[English](README.md) | 中文

## 概述

本守卫让知识库的出处规则无法被绕过。目标位于知识库内的文件工具写入或编辑会在 `fs/write-intent` 或 `fs/edit-intent` 中失败，命令在写入类动词之后提到知识库的 shell 工具调用会被工具守卫拒绝。这样页面只能通过 `ctx.knowledge.write` 修改，它会检查知识库规则并引用页面所依据的会话事件。当知识库无法回答某个路径是否位于其中时，写入失败。本包是实验性的，不承诺稳定性。

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

在知识库提供方与文件系统 seam 之后挂载本守卫；在模型拥有文件或 shell 工具且存在知识库的每个组合中都要挂载。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-rules'
  config:
    shellTools: [bash, pwsh]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `shellTools` | `bash`、`pwsh` | 其 `command` 参数会被检查的工具 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

### 设计说明

- **先于观察策略。** 两个 intent 监听器都以 `prepend: true` 注册，在 `fs-observation-policy` 决定写入 intent 之前运行，并在检查之后调用 `next()`；拒绝时抛出异常，因此工具调用会在写入任何字节之前失败。
- **会话工作区。** 包含判断相对调用会话的工作目录解析知识库根目录，该目录读自文件系统 seam 作为 intent 的 actor 传入的工具执行。
- **内容规则由知识库负责。** intent 事件只携带目标而不携带内容，因此 frontmatter、Origin 与关系规则在知识库自身的写入路径中运行；本守卫拒绝所有直接写入，这类写入本来也无法携带出处。
- **基于词法的 shell 检查。** 重定向、`tee`、`touch`、`truncate`、`mkdir`、`rm`、`rmdir`、`unlink`、`mv`、就地修改的 `sed`/`perl`、写入知识库的 `cp`/`rsync`/`ln`/`install`、git 路径命令，以及 PowerShell 的内容与条目 cmdlet，在提到知识库根目录时会被拒绝；读取与从知识库中复制出去的命令照常运行。
- **唯一的拒绝原因。** 每次拒绝都原样携带 `STORE_WRITE_REASON`："Pages in the knowledge store change only through knowledge_write, which records the session events each page is based on; this call would change the store directly. Use knowledge_write instead."
- **没有 `./invariant` 伴随插件。** 本包不发布不变量伴随插件，因为守卫不写入自己的任何记录：拒绝就是会话日志中已有的工具结果。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、intent 监听器、工具守卫 |
| [`src/shell.ts`](src/shell.ts) | 命令模式 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 seam](../knowledge/README.zh.md) — 本守卫读取的 `includes` 与 `storeRoot`。
- [wiki 文件系统提供方](../knowledge-wiki-filesystem/README.zh.md) — 每次写入都会运行的知识库规则。

-----

<a id="model-experience"></a>
## 模型体验

间接体现，通过被拒绝调用的工具结果：被拒绝的写入、编辑或 shell 调用不会运行，而是返回带一条固定原因的错误结果。

#### KV Cache 影响

仅追加：拒绝是位于可复用前缀之后的普通工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **写文件的代码** — 由 shell 或代码工具运行、以写方式打开知识库文件的脚本（`python -c`、`node -e`、程序化工具调用）不会被检测到。
- **词法层面的过度拒绝** — 在写入类动词之后提到知识库的命令，即使写入落在别处也会被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
