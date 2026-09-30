---
description: "基于 zeromem zm 命令行的对话记忆：每个已完成轮次的用户消息与最终助手文本按工作区存储，不调用模型；memory_recall 与 memory_stats 检索更早的会话，适合希望智能体回忆过去对话内容的用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-zeromem

[English](README.md) | 中文

## 概述

本包通过 [zeromem](https://github.com/ptaranat/zeromem) 让智能体回忆更早的对话。zeromem 是 Zero-Mem 的 MIT 许可 Rust 实现，其记忆操作不调用模型。一个轮次结束时，插件存储该轮次的用户消息和最终助手文本；工具调用和工具输出从不存储。模型用 `memory_recall` 检索更早的会话，用 `memory_stats` 统计存储；开启 `allowForget` 后，需要审批的 `memory_forget_session` 可删除一个会话。每次存储操作都通过 `ctx.subprocess` 运行 `zm` 可执行文件。[知识 bundle](../knowledge-profile/README.zh.md) 以关闭状态携带这一行。本包为实验性，不承诺稳定。

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

### 获取 zm 可执行文件

插件需要 zeromem 的 `zm` 命令行。[CTD Core Desktop](../../../apps/desktop/README.zh.md#bundled-zeromem-executable) 在 macOS 与 Windows 上自带一个以 zeromem 默认 fastembed 特性构建的 `zm` 及其嵌入模型，并通过 `DSH_ZEROMEM_ZM` 与 `DSH_ZEROMEM_MODELS` 指明其路径，因此 Desktop 无需安装。其他环境下，在 zeromem 检出目录中构建：

```sh
git clone https://github.com/ptaranat/zeromem && cd zeromem
cargo install --locked --path crates/zeromem                          # zm on PATH, fastembed embedder
cargo build --release --locked --no-default-features -p zeromem       # or: target/release/zm, hash embedder only
```

默认构建静态链接 onnxruntime，由 `ort-sys` 构建脚本下载，并按其 crate 内记录的 SHA-256 校验；`--no-default-features` 构建只含 zeromem 的词法哈希嵌入器，请搭配 `embedder: hash` 使用。在仓库检出目录中，`pnpm run prepare:desktop:zeromem` 会改为按 [Desktop zeromem 锁文件](../../../apps/desktop/scripts/zeromem-lock.json) 固定的输入构建 Desktop 的 `zm` 及其模型，放在 `apps/desktop/.desktop-build/targets/<target>/runtime/zeromem/` 下。

### 提供嵌入模型

使用 `embedder: default` 时，`zm` 用 Hugging Face 仓库 `Xenova/bge-small-en-v1.5` 中的 bge-small-en-v1.5 嵌入文本：共五个文件、134 MB，从 Hugging Face 缓存布局的模型目录读取。显式的 `resolveModelDir` 步骤选择该目录：非空的 `modelDir`；否则为非空的 `DSH_ZEROMEM_MODELS`，它必须是绝对路径；否则为 `<storeRoot>/models`。每个存储的 `models` 条目链接到该目录。插件在加载时以及每次操作之前检查：`models--Xenova--bge-small-en-v1.5/refs/main` 含有不带行结束符的提交 id，且 `snapshots/<提交 id>/` 中有 `onnx/model.onnx`、`tokenizer.json`、`config.json`、`special_tokens_map.json` 和 `tokenizer_config.json`。缺少任一文件时，在运行 `zm` 之前以 `ZeromemModelError` 失败，因为 `zm` 会从 huggingface.co 按仓库的最新修订下载它。手动准备该目录时，从 `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/<修订>/<文件>` 下载 Desktop zeromem 锁文件固定的修订下的这些文件，逐一与其中记录的 SHA-256 比较，再把该修订写入 `refs/main`。

### 启用该行

知识 bundle 插入 `disabled: true` 的 `memory-zeromem` 行。在 profile patch 中启用它；config patch 会替换整行 config，因此请重写所有要保留的字段：

```yaml
- id: memory-zeromem
  disabled: false
  config:
    zmPath: ''
    embedder: default
    modelDir: ''
    scope: workspace
    excludeCurrentSession: true
    ingestSubagentSessions: false
    allowForget: false
    defaultResults: 5
    maxResults: 10
    maxTurnChars: 2000
    maxIngestChars: 16000
    timeoutMs: 120000
    graceMs: 2000
    maxConcurrent: 1
```

在 bundle 之外使用时，在工具注册表、子进程 provider 和会话投影服务之后挂载 `@deepseek-ai/dsh-experimental-memory-zeromem`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `zmPath` | 空 | `zm` 可执行文件：`PATH` 上的名称或绝对路径；为空时选择 `DSH_ZEROMEM_ZM`，其次选择 `PATH` 上的 `zm` |
| `zmArgs` | 无 | 放在 zeromem 自身参数之前的参数，用于通过解释器运行的 `zm` |
| `embedder` | `default` | `default` 从模型目录运行 bge-small-en-v1.5，需要以 zeromem 的 fastembed 特性构建的 `zm`；`hash` 传入 `--no-model`，即 zeromem 的词法哈希嵌入器 |
| `modelDir` | 空 | 存放嵌入模型的绝对目录，或以 `~` 开头的目录；为空时选择 `DSH_ZEROMEM_MODELS`，其次选择 `<storeRoot>/models` |
| `scope` | `workspace` | `workspace` 为每个会话工作目录保留一个存储；`global` 在所有工作区间共享一个存储 |
| `storeRoot` | 空 | 存放各存储的绝对目录，或以 `~` 开头的目录；为空时选择 `<harness home>/zeromem` |
| `excludeCurrentSession` | `true` | `memory_recall` 结果中排除调用方会话的轮次 |
| `ingestSubagentSessions` | `false` | 同时存储子智能体子会话的轮次 |
| `allowForget` | `false` | 注册需要审批的 `memory_forget_session` 工具 |
| `defaultResults` | `5` | 未给出 `limit` 时 `memory_recall` 返回的轮次数 |
| `maxResults` | `10` | `memory_recall` 的最大 `limit` |
| `maxTurnChars` | `2000` | 每个召回轮次的文本字符数 |
| `maxIngestChars` | `16000` | 每条消息存储的字符数 |
| `timeoutMs` | `120000` | 一次 `zm` 操作的截止时间，包括摄取待处理轮次 |
| `graceMs` | `2000` | 终止 `zm` 后到强制结束前的宽限时间 |
| `maxConcurrent` | `1` | 并发 `zm` 进程数 |

显式的 `resolveZm` 步骤按以下顺序选择可执行文件：非空的 `zmPath`；否则为非空的 `DSH_ZEROMEM_ZM`，它必须是绝对路径；否则为 `PATH` 上的 `zm`。bundle 行保持 `zmPath` 与 `modelDir` 为空并设置 `embedder: default`，因此 Desktop 运行其自带的 `zm` 与模型；对不含 fastembed 的 `zm` 构建，或要在没有模型的情况下运行时，设置 `embedder: hash`。

找不到所选的 `zm` 时（`ZeromemExecutableError`，其中指明 `zmPath`、`DSH_ZEROMEM_ZM` 或 `PATH`，并说明如何安装 zeromem）、`embedder` 为 `default` 而模型目录不完整时（`ZeromemModelError`，其中指明该目录与第一个缺失的文件）、`storeRoot` 或 `modelDir` 不是绝对路径时，或 `defaultResults` 超过 `maxResults` 时，加载以具名错误失败。`zm` 失败、超时或以其他程序身份应答时，工具调用以携带 `zm` stderr 末尾的 `ZeromemProcessError` 失败；召回从不退化为空结果。`embedder` 为 `default` 而 `zm` 报告其哈希嵌入器时（因为它构建时不含 fastembed，或无法加载 onnxruntime 或模型），`memory_recall` 与 `memory_stats` 以携带 `zm` stderr 的 `ZeromemEmbedderError` 失败，而不返回词法结果。

### 存储什么、存在哪里

插件逐字、不加密地存储每条人类用户消息的文本，以及每个已完成轮次最后一条助手消息的文本，每条截断到 `maxIngestChars` 个字符。它从不存储工具调用、工具结果、推理、注入的上下文或子智能体会话（除非开启 `ingestSubagentSessions`）。在 `workspace` 范围下，会话的存储为 `<storeRoot>/workspaces/<其工作目录 SHA-256 的前 16 个十六进制数字>`；在 `global` 范围下为 `<storeRoot>/global`。每个存储包含 `zeromem.db`（SQLite，由 `zm` 写入）、`spool/`（等待摄取的轮次文件）、`dsh-forgotten/`（被 `memory_forget_session` 删除的会话）以及指向模型目录的 `models` 链接。插件以仅所有者可访问的权限创建目录，spool 文件的模式为 `0600`。用户消息可能包含用户输入的机密；删除存储目录即可删除其记忆。在 `workspace` 范围下，没有工作目录的会话不会被存储，每个会话记录一次警告。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

### 摄取

`zeromemTurn` 投影折叠当前轮次的人类 `user/message` 文本及其最后一条未中断的助手文本，并保留最后一个已完成轮次。在 `turn/end` 时，插件把该轮次以 zeromem 的 spool 格式写成一个 spool 文件：每段文本一行 JSON `{session_id, speaker, text, ts, uuid}`，`ts` 为 epoch 秒，`uuid` 为 `dsh:<session id>:<event seq>`。文件先以临时名写入，再重命名进 `spool/`，因此 `zm` 从不读取不完整的文件。写入逐个执行，不在模型请求路径上，也从不启动 `zm`。`zm` 在每次操作前摄取所有待处理的 spool 文件，并跳过已存储过的 `uuid` 行，因此摄取是幂等的。

每个插件实例为每个会话记录它最后 spool 的轮次号。在 `turn/start` 时，若该轮次号更小，它还会 spool 最后一个已完成轮次；这样，上一个进程未完成摄取的轮次会在恢复的会话开始下一轮次时被存储；若上一个进程已 spool 过，zeromem 按 `uuid` 丢弃重复项。spool 写入失败会被记录，并在该会话的下一个轮次边界重试。从 fork 父会话继承的事件不会以子会话的 id 存储。在 `dsh-forgotten/` 中标记的会话不再被 spool。

### 存储操作

每次工具调用都通过 `ctx.subprocess` 在存储目录中启动一个 `zm [--no-model] mcp --home <store>` 进程，发送 MCP `initialize`、`notifications/initialized` 和一个 `tools/call`（`zeromem_recall`、`zeromem_stats` 或 `zeromem_forget_session`），关闭 stdin 并读取应答。使用 `embedder: default` 时，它先检查模型目录，并拒绝以哈希嵌入器算出的结果。插件校验服务器自称 `zeromem`，等待调用前排队的 spool 写入完成，并以 `timeoutMs`、调用的取消和插件卸载约束该进程；同时最多运行 `maxConcurrent` 个进程。开启 `excludeCurrentSession` 时，`memory_recall` 把调用方会话的 id 作为 `exclude_session` 传入。`memory_forget_session` 拒绝删除调用方会话，作为最外层监听器通过 `tools/pre-execute` 询问用户，并在 `zm` 报告删除后把该会话标记为已遗忘。

### 设计说明

- **独立能力，而非知识 provider。** `ctx.knowledge` 提供带 id、关系和工作区读取引用的 wiki 页面；zeromem 存储的是对话轮次。本包是一个带自有工具的函数插件，没有 Service Definition，因为它只有一个消费者。
- **每次操作一个进程。** 常驻的 `zm mcp` 会让索引和嵌入器常驻内存；每次调用一个进程则没有空闲进程、也没有跨调用状态，代价是每次调用都从 `zeromem.db` 重建索引。
- **用 spool 而非 `zm ingest`。** `zm ingest` 每个文件都会打开存储并重建索引，且不去重；spool 协议让轮次结束时只写文件而不启动 `zm`，并提供 `uuid` 去重。
- **不预取。** 召回的文本只以工具结果进入请求，而会话日志已记录工具结果；没有新增会话事件。
- **没有 `./invariant` 配套模块。** 不发布不变量配套模块，因为插件不拥有两个独立观测之间的关系：存储位于外部，而会话日志以普通工具结果记录了所有模型可见的值。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、加载时查找 `zm` 与模型、摄取监听器、工具以及遗忘审批 |
| [`src/fold.ts`](src/fold.ts) | `zeromemTurn` 投影折叠 |
| [`src/store.ts`](src/store.ts) | 存储解析、目录准备、spool 文件与遗忘标记 |
| [`src/zm.ts`](src/zm.ts) | 通过子进程 seam 执行的一次 `zm mcp` 操作 |
| [`src/results.ts`](src/results.ts) | zeromem 结果的校验与转换 |
| [`src/model.ts`](src/model.ts) | 模型目录解析、模型检查，以及模型与嵌入器错误 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识 bundle](../knowledge-profile/README.zh.md) — 以关闭状态携带这一行的 bundle。
- [片段提炼](../memory-distill/README.zh.md) — 另一个记忆行，把经过验证的轮次写成知识页面。
- [zeromem](https://github.com/ptaranat/zeromem) — `zm` 命令行、其 MCP 工具及其 spool 协议。
- [定位决策](../../../.agents/notes/implemented/architecture/2026-09-30-zeromem-conversation-memory.md) — 为什么这是一个带按工作区存储的独立工具插件。

-----

<a id="model-experience"></a>
## 模型体验

### memory_recall 工具

#### 模型看到什么

插件挂载期间，模型会获得 [`memory_recall`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-memory-zeromem)，含必填字符串 `query` 与可选整数 `limit`（1 到 `maxResults`）。描述会写明存储范围（`in this workspace` 或 `in any workspace`），以及当前会话被排除还是被包含。结果为紧凑 JSON `{"turns":[{"session","time","speaker","text","kind","truncated"?}]}`，其中 `time` 为 ISO 8601 UTC，`kind` 为 `match` 或 `context`，`truncated` 标记被截断到 `maxTurnChars` 的文本。空查询、超出范围的 `limit`、会话无法使用的存储以及 `zm` 失败都是工具错误。

##### 该字段的原文

```markdown
Search what the user and you said in earlier sessions in this workspace. Returns the most relevant stored turns, each with its session id, time, speaker (user or assistant), text, and kind: match answers the query, context is linked to a match. Only user messages and final assistant replies are stored, never tool calls or tool output; the current session is left out. Recalled text records what was said then: verify it against the current files before relying on it.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约 180 个 token（其序列化定义为 788 个字符，按知识工具数据所用的每 token 4.4 个字符估算）。每次调用为每个轮次增加约 25 个 token 加上轮次文本，每个轮次最多 `maxTurnChars` 个字符，最多 `maxResults` 个轮次。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是可复用前缀之后仅追加的工具结果。

### memory_stats 工具

#### 模型看到什么

插件挂载期间，模型会获得不带参数的 [`memory_stats`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-memory-zeromem) 及下方描述。结果为调用方会话所用存储的 `{"turns","sessions"}`。

##### 该字段的原文

```markdown
Count the stored turns and sessions that memory_recall searches.
```

#### Token 影响

挂载期间始终生效：工具定义在每个请求中约 40 个 token。每次调用增加约 10 个 token 的结果。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是可复用前缀之后仅追加的工具结果。

### memory_forget_session 工具

#### 模型看到什么

开启 `allowForget: true` 时，模型会获得含必填字符串 `session` 的 [`memory_forget_session`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-memory-zeromem) 及下方描述。每次调用前都会询问用户。结果为 `{"session","deletedTurns"}`；当前会话、空 id、被拒绝的审批以及 `zm` 失败都是工具错误。

##### 该字段的原文

```markdown
Permanently delete every stored turn of one earlier session, named by the session id memory_recall returned. Use only when the user asks to forget that session; the user approves every deletion. The current session cannot be deleted, and later turns of a deleted session are not stored.
```

#### Token 影响

仅在 `allowForget: true` 时存在：工具定义在每个请求中约 120 个 token。每次调用增加约 15 个 token 的结果。

#### KV Cache 影响

工具定义在插件加载时一次性加入稳定的工具前缀；结果是可复用前缀之后仅追加的工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Desktop 之外的外部可执行文件** — 在 CTD Core Desktop 之外，由用户安装 `zm`，并在使用 `embedder: default` 时安装模型；插件不下载任何内容，缺少 `zm` 或模型时该行在加载时失败。
- **与 spool 格式耦合** — 摄取写入的是 zeromem 内部的 spool 文件，zeromem 并未将其作为稳定接口记录；真实二进制测试（`tests/real-zm.e2e.ts`，设置 `DSH_ZEROMEM_ZM` 为 `zm` 路径后运行）检查与特定 zeromem 构建的兼容性。
- **嵌入开销与语言** — `embedder: default` 在每个 `zm` 进程中加载 onnxruntime 与 134 MB 的模型：在 Apple M 系列主机上，对小型存储的一次操作在文件缓存为冷时约需 1.3 秒、为热时约需 0.1 秒，哈希嵌入器约需 10 毫秒；且 bge-small-en-v1.5 以英文训练，跨其他语言的召回较弱。`embedder: hash` 不需要模型，但按共有词语为已存储的轮次排序：已存储轮次的改写或同义表述可能错过它，`tests/real-zm.e2e.ts` 展示了这一点。
- **明文存储** — 存储的轮次是磁盘上未加密的原始文本；只能通过 `memory_forget_session` 或删除存储目录来删除。
- **每次调用重建索引** — 每次操作都启动 `zm`，它从 `zeromem.db` 重建索引，使用默认嵌入器时还要加载模型；在大型存储上，调用比常驻服务器更慢。
- **待处理轮次计入下一次调用** — 自上次操作以来 spool 的轮次由下一个 `zm` 进程摄取，因此多轮之后的第一次调用还要在 `timeoutMs` 内承担它们的摄取。
- **恢复的轮次在下一轮次存储** — 进程停止前 spool 写入未完成的轮次，会在恢复的会话开始下一轮次时被存储；从未恢复的会话会让该轮次留在记忆之外。
- **遗忘与打开的会话竞争** — 删除时仍在另一个进程中打开的会话，在该进程看到遗忘标记前可能再存储一个轮次。
- **不预取，也不调节 zeromem** — 证据只通过 `memory_recall` 进入上下文；zeromem 的 `gamma` 和 `rho` 保持论文默认值，因为 `zm` 没有暴露相应选项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

`zm` 协议与 spool 格式依据 zeromem 提交 `eda2126` 阅读得出。

</details>
