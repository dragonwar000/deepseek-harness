---
description: "claude-cli 模型路由：把厂商自己的 Claude Code CLI 作为子进程拉起来访问 Claude 模型，认证由 CLI 负责，Harness 从不调用 Anthropic 的模型 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

[English](README.md) | 中文

## 概述

本插件注册 `claude-cli` 模型路由。它的传输层是厂商自己的 Claude Code CLI：每次请求通过 `ctx.subprocess` 拉起一个子进程，于是 Claude 订阅可以在 Harness 内部驱动模型，而没有任何请求发往 Anthropic。认证由 CLI 负责：本包只通过 CLI 自己的 `CLAUDE_CONFIG_DIR` 变量把它指向某个已注册账号的目录。

Claude Code 不接收调用方提供的工具定义，因此声明了工具的请求会把它的 schema 渲染进系统提示词，再把模型回复里的围栏代码块解析回真正的 `tool-call` 块。这让迭代、守卫、审批与压缩都留在 Harness 里。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Tool calls in the prompt](#tool-calls-in-the-prompt)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

Base Bundle 带有 `llm-claude-cli` 行，且 `disabled: true`。用 profile patch 打开它：

```yaml
- id: llm-claude-cli
  disabled: false
  config:
    cliPath: claude
    maxConcurrent: 2
    toolCalls: prompt
```

按 id 打补丁会**整体替换**该行的 `config` 对象，所以只设置一个字段的补丁必须把想保留的其他字段全部重写一遍。

只有当某个 `claude` 类型的 AI 账号存在默认项时，路由才会注册自己；这个默认项由 `@deepseek-ai/dsh-ai-account-platform` 在 CLI 自己的 `claude auth login --claudeai` 报告成功之后记录。请在「设置 → AI 账号」中登录。如果 composition 自己声明了同一个 provider id，则该声明保留；激活只会补上 composition 未提及的路由。

| Config 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-cli` | 注册到 `ctx.llm` 的 provider 路由。 |
| `displayName` | `Claude (Claude Code CLI)` | 选择器未做本地化时显示的路由名。 |
| `cliPath` | `claude` | `PATH` 上的可执行文件名，或绝对路径。 |
| `extraArgs` | `[]` | 追加在固定参数之后的参数。 |
| `workingDirectory` | `<Harness home>/claude-cli` | 每个子进程的工作目录，见下文。 |
| `autoActivate` | `true` | 当 Claude 账号有默认项时注册该路由。 |
| `authTimeoutMs` | `15000` | `claude auth status --json` 与 `claude --version` 的截止时间。 |
| `catalogTimeoutMs` | `30000` | 一次性模型列举的截止时间。 |
| `requestTimeoutMs` | `600000` | 一次推理运行的截止时间。 |
| `maxConcurrent` | `2` | 该路由同时持有的 CLI 子进程数上限。 |
| `graceMs` | `2000` | 终止子进程后强杀前的宽限时间。 |
| `toolCalls` | `prompt` | `prompt` 把请求声明的工具写进系统提示词；`refuse` 让带工具的请求以 `TOOL_CALLS_UNSUPPORTED` 失败。 |
| `toolCallMaxCalls` | `4` | 一次回复中接受的工具调用块数量上限；前言会把这个数字告诉模型。 |
| `toolCallMaxBytes` | `32768` | 单个工具调用块内接受的字节数上限；前言会把这个数字告诉模型。 |
| `toolCallRetries` | `1` | 回复被拒且尚未输出任何内容时，允许的纠正性重跑次数。 |

`extraArgs` 在加载期就拒绝 `--bare`、`--betas`、`--append-system-prompt` 以及两个跳过权限的参数：前两个会改变 CLI 的认证方式，其余的会把不是 Harness 写的文本放到模型面前，或者让工具真的跑起来。

<a id="understand-the-implementation"></a>
## 理解实现

每一次 CLI 调用都由一个纯模块 `src/launch.ts` 规划，因此一次运行确切的 argv 和环境变量可以在同一个地方审阅。

**推理**执行 `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --tools "" --disallowedTools mcp__* --strict-mcp-config --setting-sources "" --disable-slash-commands --permission-prompts none --no-session-persistence --model <id> --session-id <uuid>`，请求带有系统提示词时再加上 `--system-prompt <text>`。`--tools ""` 是 CLI 自己公开的、用于关闭全部内置工具的开关；MCP 工具不受它影响，因此另行禁用。

**模型目录来自 CLI**，而不是厂商的模型 API：一个短命子进程从 stdin 收到唯一一行 `{"type":"control_request","request":{"subtype":"list_models"}}`，随后从 stdout 读取它的回答，然后子进程被终止。目录按账号目录与启动指纹（可执行文件、额外参数、上报的版本号）缓存，二者任一变化即失效。

**认证是另一个问题**，先问，且只在必须探测目录时才问。`list_models` 即便面对未登录的配置目录也会成功作答——它返回按刊例价标注的那份目录——所以它无法替代登录检查。真正的检查是 `claude auth status --json`；未登录的目录会产生具名的 `CLI_NOT_AUTHENTICATED` 错误，并指明去哪里登录。

**没有任何失败是静默的。** `listModels()` 会抛错而不是返回空列表，因为 `buildModelCatalog` 会把抛错转成选择器会连同消息一起展示的 `ModelCatalogFailure`，而空列表只会让这个 provider 分组一声不响地消失。具名的错误码是 `CLI_MISSING`、`CLI_NOT_AUTHENTICATED`、`CLI_CATALOG_UNAVAILABLE`、`UNKNOWN_MODEL`、`TOOL_CALLS_UNSUPPORTED`、`EMULATION_NOT_LOGGABLE`，以及下文列出的 `TOOL_CALL_*` 拒绝码。

**运行时 invariant。** 本包不发布运行时 invariant 伴生模块：它拥有的每一组关系都只有一个观察者——目录缓存只经 `ClaudeCliCatalog` 读取，被模拟的回复只由产生它的解码器读取，因此不存在两处独立观察可能分歧。探测、解析器与会话记录都由行为测试覆盖。

**凭据。** 本包设置的环境变量只有 `CLAUDE_CONFIG_DIR` 一项。继承下来的冲突变量——`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`——由 subprocess seam 自己的 `SENSITIVE_ENV_PATTERN` 清洗掉，而不是由这里维护的一份名单。

**Attribution headers。** `LlmAdapter` 要求每个 provider 的 HTTP 请求都带上 `attributionHeaders()`。本适配器不发出任何 HTTP 请求：连接由 CLI 持有。因此没有什么需要标注，而把第一方客户端标识送到厂商端点，恰恰是这个设计要避免的事。

**系统提示词。** 由循环构造的请求不会设置 `GenerateOptions.system`，而是把提示词放在打头的 system 角色消息里。该消息会被提升进 `--system-prompt`，于是 Harness 的提示词是**替换**掉 Claude Code 自己的那份，而不是以一个带标签的段落出现在用户轮次内部、上面还压着 CLI 的提示词。

**工作目录。** 每个子进程都在同一个固定的、空的、非仓库目录里运行。无论有没有 `--system-prompt`，CLI 都会把自己的工作目录和 git 分支告诉模型；一个恒定的空目录让这句话保持恒定，也不泄露用户项目的任何信息。

<a id="tool-calls-in-the-prompt"></a>
## 用提示词承载工具调用

声明了工具的请求会在系统提示词后面追加一段内容：上报一次调用的约定，以及每个已声明工具连同它的 `description` 与 `parameters` schema。这段措辞是固定的，由一个测试逐字钉住，并由 `PREAMBLE_TEMPLATE` 标识；它不是可配置项，因为正是它让回复可被解析。

要调用工具，模型发出一个 info string 为 `dsh-tool-call` 的围栏代码块，里面是含 `name` 与 `arguments` 的一个 JSON 对象。回复是边到达边扫描的：一段文本只要不可能成为围栏的开头就立刻放行，所以普通回答依然是流式的，只有那几个可能开启围栏的字符会被暂留。只有当闭合围栏之前的文本能解析成一个 JSON 对象时，它才算真正的闭合围栏，因此出现在字符串参数里的围栏——比如某个工具要写 Markdown——不会提前结束这个块。

模型输出是不可信文本，回复违反约定的每一种方式都有唯一一个具名结果：

| 错误码 | 这次回复 |
|---|---|
| `TOOL_CALL_TRUNCATED` | 在未闭合的块内部结束 |
| `TOOL_CALL_MALFORMED` | 闭合的块内不是一个 JSON 对象、没有给出工具名，或 `arguments` 不是对象 |
| `TOOL_CALL_UNKNOWN_TOOL` | 调用了请求从未声明的工具 |
| `TOOL_CALL_TOO_LARGE` | 单个块超过 `toolCallMaxBytes` |
| `TOOL_CALL_LIMIT` | 携带的块数超过 `toolCallMaxCalls` |

被拒之后会发起纠正性重跑，最多 `toolCallRetries` 次：请求连同一段指明错在哪里的提示重新发出，被拒的那次回复绝不会到达调用方。这种替换只在第一个文本块或工具调用块交出去之前才可能；一旦调用方已经看到输出，被拒就改为终止性的 `finish` 并带上该错误码。无论哪条路径，调用都不会被悄悄丢掉、不会被凭空编造、也不会被擅自修补。

有两件事**故意不在这里检查**。即便 `arguments` 违反工具的 `parameters` schema，也按模型写的原样转发：schema 一致性由 Harness 的工具层负责，它已经会把违规作为工具结果报告给模型，在这里再查一遍等于引入第二个会与它产生分歧的校验器。被接受的调用**之后**写的文本会被丢弃而不是保留：前言明令禁止它，而模型手上并没有真实结果可描述，所以那只能是编造。被丢弃的长度会计入会话记录。

**日志。** 前言是模型可见的输入，因此模拟请求的每一次 CLI 运行都会在运行**之前**追加一条 `llm/cli-tool-emulation` 事件：路由、模型、前言模板与长度、已声明的工具名、这是第几次运行，以及——在纠正性重跑上——它携带的那段提示原文。前言文本本身不入库，因为它是模板与请求头中工具 schema 的纯函数，而这两样日志已经持有。请求指向一个存储无法访问的会话时，它以 `EMULATION_NOT_LOGGABLE` 失败，而不是在无日志的情况下去做模拟。

<a id="further-exploration"></a>
## 深入探索

- `@deepseek-ai/dsh-ai-account` 与 `@deepseek-ai/dsh-ai-account-platform` —— 本路由从中取得路径的、已注册的官方 CLI 配置目录。
- `@deepseek-ai/dsh-subagent-claude-code` —— Claude 账号的另一种用法：把整个任务委派给 Claude Code，而不是把它当作模型传输层。
- `@deepseek-ai/dsh-llm` —— 适配器 seam、`StreamChunk`，以及本适配器需要映射到的互不重叠的 `TokenUsage` 计数。
- [用提示词模拟工具调用](../../../.agents/notes/implemented/feature/2026-09-30-prompt-emulated-tool-calls-for-cli-transports.zh.md) —— 为什么 CLI 传输层把工具定义当作提示词文本携带，以及代价是什么。
- [Vendor CLI as a model transport](../../../.agents/notes/implemented/feature/2026-09-30-vendor-cli-as-model-transport.zh.md) —— 为什么用 CLI 作为传输层而不是把 OAuth 令牌取出来，以及为什么 Codex 与 DeepSeek 没有对应的路由。

<a id="model-experience"></a>
## 模型体验

### 经由 CLI 传输层的文本请求

#### 模型看到什么

Harness 自己的系统提示词（通过 `--system-prompt` 顶替 Claude Code 的那份），以及作为单个用户回合送入的 Harness 消息。CLI 自己的工具全部关闭：`--tools ""` 移除内置工具，`--disallowedTools mcp__*` 配合 `--strict-mcp-config` 移除 MCP 工具。携带多条消息的请求会被渲染成那个用户回合内部的一份带角色标签的对话记录，因为 CLI 自己负责对话的 assistant 一侧，会忽略注入的 assistant 消息。CLI 还会附上它自己的工作目录与 git 分支那一行，本路由通过让所有子进程都在同一个固定空目录里运行来让它保持恒定。

#### Token 影响

顶替 CLI 默认系统提示词带来大幅下降：以 Claude Code 2.1.285 实测，使用默认提示词的一次请求在对话开始前就带有约 2,650 个 prompt token，而同一请求在空目录中加上 `--system-prompt` 后约为 440 个。

#### KV Cache 影响

是负面的，而且是有意为之。Claude Code 会缓存它自己的默认系统提示词；顶替成 Harness 的提示词就丢弃了那份缓存，上述实测请求报告的 cache read 与 cache write 都是 0。因此这条路由上的对话每一轮都要付全额 prompt 成本——这对长的多轮会话影响最大，对一次性的文本请求影响最小。

### 经由 CLI 传输层的带工具请求

#### 模型看到什么

上面的一切，再加上追加到系统提示词后面的一段 `## Tool calls`：上报一次调用的固定约定、两个明示的上限，以及每个已声明工具一条记录，携带它的 `description` 和以 JSON 呈现的 `parameters` schema。模型被告知：工具由 harness 执行并把真实结果送回来；被拒的回复会连同原因退回给它；在块之后写的任何内容都会被丢弃。在纠正性重跑上，它还会在用户回合末尾读到一段 `Harness:` 段落，指明上一次回复错在哪里。

#### Token 影响

以 Claude Code 2.1.285 配 `haiku` 实测，按计费 prompt token 计：固定的约定文本占 289 个，五个现实工具声明平均各占 82 个（一个带说明的三属性工具约 100 个；一个不带说明的两属性工具约 67 个）。因此一次五工具请求为它的工具声明付出约 700 个 prompt token，其中只有 289 个约定文本是接受 `tools` 字段的 provider 不会收费的额外开销。每一次纠正性重跑都会把整个请求重发一遍；被放弃的那次运行自身的用量不会上报，因为回复一旦被拒，它的子进程就立刻被终止。

#### KV Cache 影响

相比纯文本情形既没有新增收益也没有新增损失：前言属于被顶替的系统提示词，而 CLI 并不缓存它。由于前言是已声明工具的纯函数，工具集不变的对话每一轮发送的提示词文本逐字节相同，所以确实生效的 provider 侧前缀缓存不会被这套模拟本身破坏。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **工具调用依赖模型遵守散文约定。** 没有任何东西约束回复：围栏代码块是一条指令，不是解码约束，所以无视格式的模型会先花掉一次纠正性重跑、然后毁掉这一回合。以 Claude Code 2.1.285 实测，`sonnet` 每次都给出干净的单个块，而 `haiku` 有时会把块包在多余的 `<function-calls>` 标签里——解析仍然正确，但那些多余文本会被当作 assistant 文本保留。这条路由请优先选择强模型。
- **不保证并行工具调用。** `toolCallMaxCalls` 限制一次回复能携带多少个块，但没有任何东西像原生 `tools` 字段那样促使模型把互不依赖的调用打成一批。
- **围栏处流式会停顿。** 一段文本只要不可能开启围栏就立刻放行，所以普通回答是流式的；一旦回复开启了围栏，在该块闭合之前就不再有新内容显示。
- **`list_models` 未被文档化。** 本目录探测使用的 control request 不在 Claude Code 公开的 CLI 参考里。2.1.285 会作答，但它可能随时变化而无预告；读不懂的回答会产生 `CLI_CATALOG_UNAVAILABLE` 而不是崩溃，并且任何装有已登录 CLI 的机器上 `tests/real-cli.e2e.ts` 都会察觉这种变化。
- **不支持图片与文件输入。** 该路由只声明 `text`。附件以请求装配阶段已经替换好的句柄文本形式抵达。
- **没有 prompt 缓存。** 见上面的 KV Cache 一节。
- **每个请求一个进程。** 每次请求都要拉起并拆掉一个 CLI 子进程，因此每一轮都付出进程启动成本；`maxConcurrent` 限制同时运行的数量。
- **针对同一配置目录的并发未经厂商验证。** Claude Code 的文档没有就多个 `--print` 运行共享一个 `CLAUDE_CONFIG_DIR` 作出任何承诺。本路由给每次运行单独的 `--session-id` 并传入 `--no-session-persistence`，`maxConcurrent` 默认为 2。

<a id="dev-note"></a>
### 开发备注

`tests/real-cli.e2e.ts` 运行已安装的 `claude`，在它缺失或未登录时自动跳过，因此在 CI 中不会执行。它是唯一能察觉未文档化的 `list_models` control request 发生变化、或某个模型不再遵守工具调用格式的检查；Claude Code 升级之后，请在一台装有已登录 CLI 的机器上运行它。

`tests/loader-composition.spec.ts` 用 Base Bundle 行所写的包名、通过真实 Loader 启动本包，因此一个在实际 profile 里装不起来的行会在那里失败，而不是在 profile 里失败。

`tests/real-loop.e2e.ts` 在注册了一个真实工具的前提下，用已安装的 CLI 驱动生产 agent 循环，因此前言或解析器的改动如果让一个回合走不通，会在这里暴露。它同样会自动跳过。

单元测试通过 `tests/harness.ts` 脚本化 CLI，它按 argv 所问的问题作答，而不是按 spawn 顺序作答，因此新增一个探测不需要给队列重新编号。
