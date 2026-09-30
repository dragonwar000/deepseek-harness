# Agent Note: A Vendor CLI as the Model Transport

Status: implemented

[English](2026-09-30-vendor-cli-as-model-transport.md) | 中文

## Problem

仓库所有者希望消费级订阅能在 Harness 内部驱动一个聊天模型。[official-CLI AI Accounts 决策](2026-09-29-official-cli-ai-accounts.zh.md)拒绝了这件事，只让每份订阅通过拉起厂商自己的 CLI 去完成被委派的任务。后来的一份提案反转了结论，却保留了前一份备忘对**机制**的假设：要让订阅服务主模型，就得把厂商 CLI 的 OAuth 授权从它的私有存储里读出来、自己刷新、并在每个 HTTP 请求上出示那个 CLI 的客户端身份。那份备忘接受的全部风险——虚假地声称自己是厂商的第一方客户端、与订阅条款冲突、依赖未文档化的存储与客户端标识、以及成为一份长期授权的第二个持有者——都来自这一个假设。

## Decision

这个假设是错的。本备忘记录实际建成的替代方案：**厂商的 CLI 是传输层，不是凭据来源。**

`@deepseek-ai/dsh-llm-claude-cli` 注册 `claude-cli` 模型路由。每次请求通过 `ctx.subprocess` 拉起 `claude`，并使用 CLI 自己的 `--input-format stream-json` 协议与它对话。Harness 不向 Anthropic 发送任何 HTTP 请求，不持有令牌，不刷新任何东西，也不在任何地方出示客户端身份。它唯一的凭据动作正是前一份决策已经认可的那个：通过 CLI 自己公开的 `CLAUDE_CONFIG_DIR` 变量，把 CLI 指向某个已注册账号的配置目录。继承下来的冲突变量由 subprocess seam 既有的 `SENSITIVE_ENV_PATTERN` 清洗掉，而不是由本包维护一份名单。

把 CLI 用作传输层带来三个承重的结论，它们是针对 Claude Code 2.1.285 验证过的，不是假定的：

**工具可以关掉，于是 CLI 成为一个补全引擎。** `--tools ""` 是 CLI 自己公开的、用于移除全部内置工具的开关；`--disallowedTools mcp__*` 配合 `--strict-mcp-config` 移除 MCP 工具；`--system-prompt` 顶替 CLI 自己的系统提示词而不是追加。实测一次请求携带约 440 个 prompt token，而用 CLI 默认值时约为 2,650 个。

**模型目录来自 CLI。** 一个短命子进程从 stdin 收到唯一一个 `list_models` control request 并作答，目录按账号目录与启动指纹缓存。不接触厂商的模型 API。

**目录不等于登录。** 即便面对未登录的配置目录，`list_models` 也会成功作答，返回的是按刊例价标注的那份目录而非订阅的那份。因此先单独询问 `claude auth status --json`；未登录的目录会产生具名的 `CLI_NOT_AUTHENTICATED` 错误。`listModels()` 抛错而不是返回空列表，因为 `buildModelCatalog` 会把抛错呈现为可见的 `ModelCatalogFailure`，而空列表只会让这个 provider 分组悄悄消失。

**这条路由做不到、也不假装做得到的事。** Claude Code 不接收调用方提供的工具定义，也没有任何模式能报告一次工具调用却不执行它；它唯一的工具机制是 MCP，而那时是 CLI 在自己的循环里调用工具。因此声明了工具的请求会以 `TOOL_CALLS_UNSUPPORTED` 失败，而不是把声明悄悄丢掉。该路由服务纯文本请求，它还不是主 agent 循环的聊天模型。

正因如此，这一行以 `disabled: true` 发布。它由 profile patch 打开，并且只在某个 `claude` 类型的 AI 账号存在默认项时注册；如果 composition 自己声明了同一个 provider id，则该声明保留。

## Alternatives considered

**按那份提案所述，取出 OAuth 授权并直接调用厂商 API。** 它能让订阅服务任何请求，包括带工具的请求。它落选，是因为这要求从一个并非该 CLI 的客户端出示 Anthropic 第一方 CLI 的身份——`claude-cli` user agent、`x-app: cli`、`claude-code-20250219` beta，以及一段「You are Claude Code」系统块——并且会让 Harness 成为一份授权的第二个持有者，而这份授权此后只能在两处中的一处被吊销。它的风险恰恰是本决策不去承担的那些。

**把 Harness 的工具作为 MCP server 暴露给 CLI。** 那样 CLI 会带着 Harness 自己的 guard 调用真正的 Harness 工具，订阅也就能服务完整的 agent 回合。它落选，是因为循环归 CLI 所有：回合迭代、compaction 与停止判定都会从 `agent-loop` 移到另一个产品里，而这恰恰是既有的委派路线（`@deepseek-ai/dsh-subagent-claude-code`）做得更好也更诚实的那件事。

**在提示词里模拟工具调用。** 把请求的 `ToolSchema[]` 序列化进系统提示词、再从围栏块里解析出调用，可以保住 Harness 的循环、工具、guard 与 compaction，也会让这条路由能当主聊天模型用。它是被推迟而非被拒绝：模拟用的前导块是一个新的 model-visible 输入，因此需要一个 session event、一条 persistence 记录、一个 keyless snapshot，以及一条针对格式错误调用的具名失败路径。半途而废地交付，等于交付一个悄悄无法调用工具的模型。

**什么也不做，订阅继续只能被委派。** 没有新包，没有未文档化的 control request。它落选，是因为那样所有者的订阅连一次不带工具的请求都无法在 Harness 里作答。

## Why Codex and DeepSeek have no equivalent route

**Codex：只能整回合委派。** Codex 0.154.0 没有任何关闭工具的办法。`codex` 与 `codex exec` 上都没有 `--tools` 的对应物；在它的 app-server 协议输出的 628 个定义中（`codex app-server generate-json-schema`），唯一与工具配置有关的类型是 `ToolsV2`，而它的全部内容是 `{"web_search": …}`；`TurnStartParams` 与 `ThreadStartParams` 都没有 tools 字段。它的 base instructions **可以**通过 `thread/start` 顶替，但实测一次顶替后的回合仍携带 14,650 个 input token——那是 Codex 的工具定义与 skill 描述，出现在每一个请求里。因此 Codex 永远在一个回合内部跑它自己的 agent 循环，Harness 无法为一个由 Codex 驱动的模型保住自己的循环、guard 或 compaction。ChatGPT 订阅留在它本来就能用、形态也更诚实的地方：通过 `@deepseek-ai/dsh-subagent-codex` 委派。

**DeepSeek：没有东西可拉起，因为根本没有订阅。** 不存在官方的 DeepSeek CLI；一份约 45 个编码 agent CLI 的目录中一个也没有，而检查过的每一个社区 DeepSeek CLI 都用 API key 认证。更根本的是，DeepSeek 并不出售可供支撑的订阅：`GET /user/balance` 只返回每种货币的 `is_available`、`total_balance`、`granted_balance` 与 `topped_up_balance`，其计费模型中任何地方都没有 plan、tier 或 renewal 字段，定价页上也没有出现过 "subscription"、"monthly" 或 "plan"。DeepSeek 确实在 `https://api.deepseek.com/anthropic` 提供了一个 Anthropic 格式的端点，并给出了对应的 Claude Code 配方，那意味着只要覆盖两个环境变量，本包就能服务 DeepSeek。这被两重理由否决：它会把 Anthropic 的第一方客户端身份送到另一家厂商的端点；而且它一无所获，因为 `@deepseek-ai/dsh-llm-deepseek-api-key` 已经原生服务同一个端点，并带有流式、定价、文件与图像 token 支持。

## Consequences

一份 Claude 订阅可以在 Harness 内部作答不带工具的请求，Harness 的代码、日志与存储中没有任何令牌，传给 CLI 的只有它自己公开的目录变量。每次登录仍然只在一个地方可吊销，在 CLI 里吊销它也就停掉了这条路由。

这条路由不是主聊天模型。几乎每个真实回合都声明工具，compaction 也不例外，因此启用后，选它来聊天的用户会在第一个带工具的回合遇到 `TOOL_CALLS_UNSUPPORTED`。这就是这一行默认关闭的原因，也是选择器要用本地化文案说明该条目由订阅支撑、并经厂商 CLI 运行的原因。

Prompt 缓存被放弃了：顶替 Harness 的系统提示词会丢掉 Claude Code 为自己那份保留的缓存，所以每一轮都付全额 prompt 成本。每个请求还会拉起并拆掉一个进程。

`list_models` control request 未被文档化，可能随时变化而无预告；读不懂的回答会降级为具名的目录错误，而一个在没有已登录 CLI 时自动跳过的真实 CLI 测试会察觉这种变化。厂商对同一配置目录上的并发 `--print` 运行没有任何说明，因此每次运行取用自己的 session id 并关闭持久化，并发数是一个有上限、可配置的数字。

不需要 session event、persistence 记录或 `SESSION_FORMAT_VERSION` 变更：该路由没有引入任何 Harness 本来没有撰写的 model-visible 输入。把一段对话序列化进单个用户回合，是对 session log 已经持有的消息所做的适配器投影，与任何其他适配器所做的一样。
