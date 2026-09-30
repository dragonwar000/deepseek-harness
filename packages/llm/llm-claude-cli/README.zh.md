---
description: "claude-cli 模型路由：把厂商自己的 Claude Code CLI 作为子进程拉起来访问 Claude 模型，认证由 CLI 负责，Harness 从不调用 Anthropic 的模型 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

[English](README.md) | 中文

## 概述

本插件注册 `claude-cli` 模型路由。它的传输层是厂商自己的 Claude Code CLI：每次请求通过 `ctx.subprocess` 拉起一个子进程，于是 Claude 订阅可以在 Harness 内部驱动模型，而 Harness 自己不向 Anthropic 发出任何请求。认证由 CLI 负责：本包只通过 CLI 自己公开的 `CLAUDE_CONFIG_DIR` 变量把它指向某个已注册账号的配置目录。

该路由只服务**不声明工具**的请求：Claude Code 不接收调用方提供的工具定义，因此声明了工具的请求会以 `TOOL_CALLS_UNSUPPORTED` 失败，而不是把它们丢掉。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
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
```

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

`extraArgs` 在加载期就拒绝 `--bare`、`--betas`、`--append-system-prompt` 以及两个跳过权限的参数：前两个会改变 CLI 的认证方式，其余的会把不是 Harness 写的文本放到模型面前，或者让工具真的跑起来。

<a id="understand-the-implementation"></a>
## 理解实现

每一次 CLI 调用都由一个纯模块 `src/launch.ts` 规划，因此一次运行确切的 argv 和环境变量可以在同一个地方审阅。

**推理**执行 `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --tools "" --disallowedTools mcp__* --strict-mcp-config --setting-sources "" --disable-slash-commands --permission-prompts none --no-session-persistence --model <id> --session-id <uuid>`，请求带有系统提示词时再加上 `--system-prompt <text>`。`--tools ""` 是 CLI 自己公开的、用于关闭全部内置工具的开关；MCP 工具不受它影响，因此另行禁用。

**模型目录来自 CLI**，而不是厂商的模型 API：一个短命子进程从 stdin 收到唯一一行 `{"type":"control_request","request":{"subtype":"list_models"}}`，随后从 stdout 读取它的回答，然后子进程被终止。目录按账号目录与启动指纹（可执行文件、额外参数、上报的版本号）缓存，二者任一变化即失效。

**认证是另一个问题**，先问，且只在必须探测目录时才问。`list_models` 即便面对未登录的配置目录也会成功作答——它返回按刊例价标注的那份目录——所以它无法替代登录检查。真正的检查是 `claude auth status --json`；未登录的目录会产生具名的 `CLI_NOT_AUTHENTICATED` 错误，并指明去哪里登录。

**没有任何失败是静默的。** `listModels()` 会抛错而不是返回空列表，因为 `buildModelCatalog` 会把抛错转成选择器会连同消息一起展示的 `ModelCatalogFailure`，而空列表只会让这个 provider 分组一声不响地消失。具名的错误码是 `CLI_MISSING`、`CLI_NOT_AUTHENTICATED`、`CLI_CATALOG_UNAVAILABLE`、`TOOL_CALLS_UNSUPPORTED` 和 `UNKNOWN_MODEL`。

**凭据。** 本包设置的环境变量只有 `CLAUDE_CONFIG_DIR` 一项。继承下来的冲突变量——`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`——由 subprocess seam 自己的 `SENSITIVE_ENV_PATTERN` 清洗掉，而不是由这里维护的一份名单。

**Attribution headers。** `LlmAdapter` 要求每个 provider 的 HTTP 请求都带上 `attributionHeaders()`。本适配器不发出任何 HTTP 请求：连接由 CLI 持有。因此没有什么需要标注，而把第一方客户端标识送到厂商端点，恰恰是这个设计要避免的事。

**工作目录。** 每个子进程都在同一个固定的、空的、非仓库目录里运行。无论有没有 `--system-prompt`，CLI 都会把自己的工作目录和 git 分支告诉模型；一个恒定的空目录让这句话保持恒定，也不泄露用户项目的任何信息。

<a id="further-exploration"></a>
## 深入探索

- `@deepseek-ai/dsh-ai-account` 与 `@deepseek-ai/dsh-ai-account-platform` —— 本路由从中取得路径的、已注册的官方 CLI 配置目录。
- `@deepseek-ai/dsh-subagent-claude-code` —— Claude 账号的另一种用法：把整个任务委派给 Claude Code，而不是把它当作模型传输层。
- `@deepseek-ai/dsh-llm` —— 适配器 seam、`StreamChunk`，以及本适配器需要映射到的互不重叠的 `TokenUsage` 计数。
- [Vendor CLI as a model transport](../../../.agents/notes/implemented/feature/2026-09-30-vendor-cli-as-model-transport.zh.md) —— 为什么用 CLI 作为传输层而不是把 OAuth 令牌取出来，以及为什么 Codex 与 DeepSeek 没有对应的路由。

<a id="model-experience"></a>
## 模型体验

### 经由 CLI 传输层的文本请求

#### 模型看到什么

Harness 自己的系统提示词（通过 `--system-prompt` 顶替 Claude Code 的那份），以及作为单个用户回合送入的 Harness 消息。没有任何工具被声明给模型：`--tools ""` 移除 CLI 的内置工具，`--disallowedTools mcp__*` 配合 `--strict-mcp-config` 移除 MCP 工具，所以模型看到的是一次纯粹的补全请求。携带多条消息的请求会被渲染成那个用户回合内部的一份带角色标签的对话记录，因为 CLI 自己负责对话的 assistant 一侧，会忽略注入的 assistant 消息。CLI 还会附上它自己的工作目录与 git 分支那一行，本路由通过让所有子进程都在同一个固定空目录里运行来让它保持恒定。

#### Token 影响

顶替 CLI 默认系统提示词带来大幅下降：以 Claude Code 2.1.285 实测，使用默认提示词的一次请求在对话开始前就带有约 2,650 个 prompt token，而同一请求加上 `--system-prompt` 后约为 440 个。剩下的开销来自 CLI 的环境信息那一行。

#### KV Cache 影响

是负面的，而且是有意为之。Claude Code 会缓存它自己的默认系统提示词；顶替成 Harness 的提示词就丢弃了那份缓存，上述实测请求报告的 cache read 与 cache write 都是 0。因此这条路由上的对话每一轮都要付全额 prompt 成本——这对长的多轮会话影响最大，对一次性的文本请求影响最小。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **没有工具调用。** Claude Code 不接收调用方提供的工具定义；它唯一的工具机制是 MCP，而那时是 CLI 在自己的循环里调用工具。声明了工具的请求会以 `TOOL_CALLS_UNSUPPORTED` 失败，因此这条路由无法服务一个 agent 回合。基于提示词的工具调用模拟可以保住 Harness 自己的循环，已有设计但尚未实现。
- **`list_models` 未被文档化。** 本目录探测使用的 control request 不在 Claude Code 公开的 CLI 参考里。2.1.285 会作答，但它可能随时变化而无预告；读不懂的回答会产生 `CLI_CATALOG_UNAVAILABLE` 而不是崩溃，并且任何装有已登录 CLI 的机器上 `tests/real-cli.e2e.ts` 都会察觉这种变化。
- **不支持图片与文件输入。** 该路由只声明 `text`。附件以请求装配阶段已经替换好的句柄文本形式抵达。
- **没有 prompt 缓存。** 见上面的 KV Cache 一节。
- **每个请求一个进程。** 每次请求都要拉起并拆掉一个 CLI 子进程，因此每一轮都付出进程启动成本；`maxConcurrent` 限制同时运行的数量。
- **针对同一配置目录的并发未经厂商验证。** Claude Code 的文档没有就多个 `--print` 运行共享一个 `CLAUDE_CONFIG_DIR` 作出任何承诺。本路由给每次运行单独的 `--session-id` 并传入 `--no-session-persistence`，`maxConcurrent` 默认为 2。

<a id="dev-note"></a>
### 开发备注

`tests/real-cli.e2e.ts` 运行已安装的 `claude`，在它缺失或未登录时自动跳过，因此在 CI 中不会执行。它是唯一能察觉未文档化的 `list_models` control request 发生变化的检查；Claude Code 升级之后，请在一台装有已登录 CLI 的机器上运行它。

单元测试通过 `tests/harness.ts` 脚本化 CLI，它按 argv 所问的问题作答，而不是按 spawn 顺序作答，因此新增一个探测不需要给队列重新编号。
