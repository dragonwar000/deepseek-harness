# Agent Note：获准登录的模型路由

Status: implemented

[English](2026-09-30-sanctioned-sign-in-model-routes.md) | 中文

## 问题

登录提供方并不会产生任何模型。`registerPiAiFlows` 为每个已安装的 pi-ai 提供方提供一个授权流程，流程会在 `llm-pi-ai/<provider id>` 提交一条凭据记录，但路由集合只来自 `providers` 设置字典，因此在用户另行手工写出一个指明刚刚登录的提供方的 profile 之前，聊天模型选择器一直是空的。AI 账号页面也没有说明哪些账号可以驱动主模型，因此一次刻意仅限委派的 Claude 或 ChatGPT 登录，看上去与一次未能生效的登录完全一样。

决定答案形态的约束是：并非每次登录都可以驱动主模型。消费者订阅 grant 签发给厂商自有的助手客户端，从另一个 HTTP 客户端发送它即冒充该客户端——这正是[官方 CLI AI 账号](2026-09-29-official-cli-ai-accounts.zh.md)移除 token 到主模型那个包的原因。因此「登录应当产生路由」不能是一条无条件规则；产品需要一份分类，而这份分类必须可见，而不是由哪些包存在来暗示。

## 决定

`packages/llm/llm-pi-ai/src/sign-in.ts` 分类的是**存储的凭据**，而不是登录方法，因为记录才是请求会发送的东西，且记录会在改变登录offer的升级之后继续存在。`classifySignIn(provider, kind)` 返回 `sanctioned`、`delegated-only` 或 `unknown-grant` 三者之一的 `SignInClass`，加上界面可以展示的原因，以及在存在时，确实能到达主模型的那个 API 密钥登录。

规则由已安装目录推导，而非逐个提供方列出，因此 pi-ai 升级新增的订阅登录在落地当刻即被保留：

| 存储的记录 | 分类 | 依据 |
|---|---|---|
| `api-key` | `sanctioned` | 账户持有者在厂商控制台签出的密钥只指明它所计费的账户 |
| `grant`，`auth.oauth.isSubscription !== true` | `sanctioned` | 厂商面向第三方客户端签发的 grant |
| `grant`，`auth.oauth.isSubscription === true` | `delegated-only` | 签发给厂商自有助手客户端的消费者订阅 grant |
| `grant`，任何已安装提供方均无 `auth.oauth` | `unknown-grant` | 已安装的一切都无法从它推导请求 auth |

`resolveSignInRoutes(request): SignInRouteSpec` 是显式的 resolve 步骤：它回答许可与目录成员资格，优先级由调用方拥有。激活的路由就是其提供方的空 profile——已安装目录的端点、协议与模型，由存储记录认证，因为不指明 `apiKeyEnv` 恰恰会让 pi-ai 转向它自己的凭据存储。插件在 `credentials/record-updated` 上重新读取凭据 seam（做了合并，因此一串写入与 OAuth 刷新只产生一次重新注册），并通过既有的 `AdapterRegistrationHandle.replace` 重新注册，因此登录与退出登录无需重启、也无需写设置即可移动选择器。监听器与激活集合位于 `ctx.inject(['credentials'], …)` 作用域内，因此稍后挂载的凭据平面仍能到达路由集合，而它离开时激活的路由随之移除。

`providers` 中的 profile 始终优先：激活只添加设置文档未提及的提供方，因此已声明路由保留其 `displayName`、收窄的 `models`、`apiKeyEnv` 及其余字段，既有 README 契约不变。`signInRoutes`（默认 `true`）是唯一新增的 `Config` 字段，因为「按用户的一次登录是否可以创建路由」对于出口白名单、计费边界或精选模型列表而言是部署事实——而分类是安全不变量，保持为固定源码。

在产品一侧，`@deepseek-ai/dsh-client-ui-settings-ai-account` 通过其在 `en` 与 `zh` 中的类型化字典，按分组说明这些账号不会添加聊天模型、grant 属于谁的客户端，以及应改为在 **模型** 中添加哪家厂商的 API 密钥。

## 分类证据

pi-ai 0.87.1，按已安装状态。`OAuthAuth.isSubscription` 是上游有文档的字段——「Whether access through this auth method is backed by a provider subscription」——位于 `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:206`，这正是它作为分类输入而非猜测的原因。

41 个已安装提供方中有 6 个标记了它，且每一个自身的流程都印证了这一读法：

- **`anthropic`** —— `dist/auth/oauth/anthropic.js:301` `isSubscription: true`，`:13` 一个 base64 混淆的 `CLIENT_ID`（Claude Code 客户端），`:14` `https://claude.ai/oauth/authorize`。为它做路由需要彻底冒充该客户端：`dist/api/anthropic-messages.js:724` 发送 `"user-agent": claude-cli/${claudeCodeVersion}`，`:725` `"x-app": "cli"`，`:771` `claude-code-20250219` 与 `oauth-2025-04-20` beta 标志，`:821` 一段 `"You are Claude Code, Anthropic's official CLI for Claude."` 系统块。
- **`openai-codex`** —— `dist/auth/oauth/openai-codex.js:427` `isSubscription: true`，`:22` `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`（Codex CLI 的客户端），`:23` `https://auth.openai.com`。硬约束中点名的案例。它也是唯一完全不提供 `apiKey` 方法的已安装提供方，因此其替代是 `openai`。
- **`github-copilot`** —— `dist/auth/oauth/github-copilot.js:381` `isSubscription: true`，`:8` 一个 base64 混淆的 `CLIENT_ID`（`Iv1.b507a08c87ecfe98`），以及 `:32` 一个无文档的内部端点 `copilot_internal/v2/token`。
- **`kimi-coding`** —— `dist/auth/oauth/kimi-coding.js:237` `isSubscription: true`；一份 Kimi Code 编码订阅。
- **`meta`** —— `dist/auth/oauth/meta.js:182` `isSubscription: true`；设备 grant 在 `https://api.meta.ai/muse-code/key`（`:21`）签出密钥。
- **`xai`** —— `dist/auth/oauth/xai.js:182` `isSubscription: true`；`loginLabel` 为「Sign in with SuperGrok or X Premium」。

两个获准的 grant：

- **`openrouter`** —— `dist/auth/oauth/openrouter.js` 未设置 `isSubscription`；其 PKCE 流程在 `https://openrouter.ai/api/v1/auth/keys`（`:18`）交换，这是 OpenRouter 有文档的第三方流程，产出一个 API 密钥。
- **`radius`** —— `dist/auth/oauth/radius.js:29` `OAUTH_CLIENT_ID = "pi-gateway"`，pi-ai 为其自有网关注册的自有客户端，且无 `isSubscription`。

其余每个已安装提供方只提供 `auth.apiKey.login`——pi-ai 通过自己的提示收集密钥——41 个中有 40 个提供它，这也是六个被保留提供方中有五个能以同一记录 id 用 API 密钥作为替代的原因。

分类表由 `packages/llm/llm-pi-ai/tests/sign-in.spec.ts` 钉住，因此 pi-ai 升级改变订阅集合时会有一个点名它的测试失败，而不是无声地放宽 harness 所发送的内容。

## 考虑过的替代方案

**登录时写入 `providers` profile。** 模型页面已经会写 profile，登录也可以照做。已否决：这会让按用户的动作去编辑部署的配置文档，退出登录随后必须区分它自己写入的 profile 与用户编辑的 profile，而单个设置键无法同时承载两个事实。

**分类登录方法而非存储记录。** 更简单，因为 `loginMethods()` 已经区分了 `oauth` 与 `api-key`。已否决：早先构建存储的 grant 会比产生它的 offer 存活更久，只有记录才说明请求实际会发送什么。

**把仅限委派的提供方列成字面清单。** 固定清单比推导更直观。因漂移而否决：在两次发布之间上游新增的提供方会默认可路由，而这是错误的失败方向。该清单以钉住的测试断言形式留存，在那里过时是失败，而不是无声的许可。

**让分类可配置。** 某个部署也许仍想路由订阅 grant。已拒绝：这是安全不变量，不是可调项，任何 `Config` 字段都不得放宽 harness 可以自称的身份。

**用分类扩宽 `AuthorizationMethod`。** 这会让任何界面都能从 seam 渲染原因。已否决：授权 seam 还服务于没有这一概念的其他流程（Coteccons SSO、DeepSeek Platform），单个 Consumer 不得规定服务契约。原因以产品文案形式留在客户端包中，并以导出函数形式供想要自行计算的界面使用。

**把 AI 账号页面链接到模型页面。** 文案提到 **模型**，但无法导航过去：设置外壳仅把 `openSection` 传给 `settings.onboarding` slot。为一句提示而把它接入 `settings.section` 会改动共享的 slot 契约，因此改为记录该限制。

## 后果

获准的登录现在已经足够：提供方的目录模型在下一次读取时出现在聊天模型选择器中，退出登录会移除它们。选择器本来就在 `credentials/record-updated` 上刷新，因此列表移动不需要任何客户端改动。

消费者订阅账号保持不变，仍只能通过委派的 Claude Code 与 Codex 运行到达，页面现在会说明这一点，并在旁边给出可用的替代方案。pi-ai 升级新增订阅登录的构建会默认保留它。

激活的路由为其提供方服务整个已安装目录，模型列表比精选 profile 更长；想要更少的部署可声明一个 profile，它具有优先权。由于激活依赖记录而非文档，路由集合不再是配置的纯函数——被保留登录的诊断按记录记录一次，存储无法读取时路由集合保持原样，因此瞬时失败绝不会在回合中途结束会话。
