# Agent Note: 官方 CLI AI 账号

Status: implemented

[English](2026-09-29-official-cli-ai-accounts.md) | 中文

其中一部分已被[用消费者订阅账号驱动主模型](../../proposed/feature/2026-09-30-subscription-account-main-model.zh.md)取代，该决策推翻了本决策中关于主模型的那一半；以下其余内容继续有效。

## Problem

用户希望用自己的 Claude 与 ChatGPT 订阅运行委派的 Claude Code 与 Codex 工作，每种账号保留多个账号，并选择使用哪一个。订阅登录是颁发给官方 Claude Code 或 Codex 客户端的 OAuth 授权。从 CLI 的存储中读出该授权、向厂商令牌端点刷新它，或从其他 HTTP 客户端发送它，都是在冒充官方客户端，会让 Harness 依赖未公开的存储格式与客户端标识，并使 Harness 持有长期有效的订阅令牌。更早的一个未发布草稿正是这样做的：它运行 `claude login`，读取 `~/.claude/.credentials.json`，自行刷新令牌，并把令牌用作主模型的 API key。

## Decision

AI 账号是一个登记在案的官方 CLI 配置目录。`@deepseek-ai/dsh-ai-account` 定义 `ctx.aiAccount`；`@deepseek-ai/dsh-ai-account-platform` 的实现只针对 `<Harness home>/ai-accounts` 下每个账号的一个目录运行官方 CLI：

| 种类 | 目录变量 | 添加 | 识别 | 移除 |
|---|---|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR=<root>/claude/<id>` | `claude auth login --claudeai` | `claude auth status --json` | `claude auth logout`，然后删除目录 |
| `chatgpt` | `CODEX_HOME=<root>/codex/<id>` | `codex login --device-auth` | `codex login status` | `codex logout`，然后删除目录 |

提供者只在 `accounts.json` 中存储元数据（`id`、`kind`、`email`、`plan`、`createdAt`，以及每种账号一个默认 id）。它从不打开 CLI 写入的文件，也从不访问令牌端点；只有 CLI 自己的状态命令报告已登录时才添加账号。登录输出的浏览器地址，或 Codex 的验证地址与一次性验证码，会显示出来，让用户在设置页面完成登录。

账号只通过启动同一个官方产品来使用。`@deepseek-ai/dsh-subagent-ai-account` 通过提供者文档化的 `env` 叠加，把 `@deepseek-ai/dsh-subagent-claude-code` 以提供者 `claude-code` 并带 `CLAUDE_CONFIG_DIR`、把 `@deepseek-ai/dsh-subagent-codex` 以提供者 `codex` 并带 `CODEX_HOME` 挂载，各自指向其种类的默认账号。它在 `ai-account/default-changed` 时重新挂载提供者 fiber，没有默认账号的种类不挂载任何提供者。它与独立的提供者 Bundle 一样是可选 Profile Bundle，因为生产安装排除决策使产品运行时不进入随发行版交付的 Bundle。Web App 预设中的 `tool-subagent-claude-code` 与 `tool-subagent-codex` 行已启用；每个工具只在其提供者挂载期间注册。

把令牌用于主模型的包已从所有组合中移除。设置界面为 **AI 账号**（`AI Account`），位于 `@deepseek-ai/dsh-client-ui-settings-ai-account`，通过 `@deepseek-ai/dsh-api-ai-account-controller` 的 `aiAccount` Remote 命名空间提供。

同一页面还承载主模型登录，它不是 AI 账号，也不运行 CLI。`@deepseek-ai/dsh-client-ui-settings-ai-account` 声明 `settings.ai-account.group` 插槽，并把其条目渲染在 Claude 与 ChatGPT 分组之前。在已发布的组合中，该条目是 `@deepseek-ai/dsh-client-ui-settings-coteccons-sso` 的 Coteccons SSO 分组（[Coteccons SSO 决策](2026-09-30-coteccons-sso-entra-main-model.zh.md)）；重新启用其禁用行时，`@deepseek-ai/dsh-client-ui-settings-account` 会在同一插槽注册 DeepSeek Platform 分组。因此页面依次为 Coteccons SSO（主模型）、Claude（通过 Claude Code）与 ChatGPT（通过 Codex），设置外壳会为已停用的 `account` 区块 id 打开 AI 账号。

## Alternatives considered

**提取 OAuth 令牌并直接调用厂商 API。** 这就是被移除的草稿。它能让订阅驱动主模型，但依赖私有存储与客户端标识，要求 Harness 刷新并持有令牌，并在其颁发对象之外使用该授权。

**把凭据复制到 Harness 凭据存储。** 复制可以集中管理密钥，但会复制长期授权，仍需读取私有 CLI 存储，并留下两份需要撤销的副本。

**使用默认的 `~/.claude` 和 `~/.codex` 目录。** 不需要新目录，但每种账号只能支持一个账号，并且 Harness 的登录与退出会改变用户自己的终端登录状态。

**由 platform 包挂载提供者。** 少一个包，但 platform 位于 base Bundle 中，而产品提供者带有固定版本的产品运行时，生产安装排除决策使它们不进入随发行版交付的 Bundle。

**为 DeepSeek 保留单独的账号区块。** 不需要新插槽，但账号管理会分散在两个设置页面中，并且用户登录之前无法在设置中找到 DeepSeek 登录。

**通过 Loader 重新配置独立提供者行。** 把 `env` 写入 Profile 的提供者行可以复用独立 Bundle，但每次默认账号变化都会把 Host 路径持久化到 Profile 配置中，并使账号状态与配置编辑耦合。

## Consequences

订阅凭据从不经过 Harness 代码、日志或存储，每个账号的登录都可以通过官方 CLI 撤销。每种账号的多个账号彼此独立，因为各有自己的目录，用户的终端登录不受影响。

Claude 与 ChatGPT 订阅不再驱动主模型；只能通过委派的 Claude Code 与 Codex 运行使用。只有主模型登录（已发布组合中为 Coteccons SSO）驱动主模型。设置中只有一个账号入口，贡献的分组仅在组合了 AI 账号区块时出现。身份仅限 CLI 报告的内容，因此 ChatGPT 账号不显示邮箱。登录与委派使用两个可执行文件：登录运行在 `PATH` 中找到的 Host `claude` 或 `codex`（可配置），委派运行提供者 Bundle 固定版本的运行时，两者读取同一目录。测试无法无人值守地完成登录，因此覆盖使用伪造的可执行文件以及不启动产品进程的 Loader 组合；真实的端到端登录仍需人工检查。
