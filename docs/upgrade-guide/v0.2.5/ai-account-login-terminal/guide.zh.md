---
kind: upgrade-guide
description: "AI 账号登录现在在终端上运行官方 CLI 并需要授权码，`AiAccount` 新增 `submitSignInCode`。"
---

# AI 账号登录通过授权码完成

[English](guide.md) | 中文

## 变更

此前添加 Claude 或 ChatGPT 账号时，官方登录命令的标准输入为 `/dev/null`。两个登录命令都会渲染终端界面并从中读取确认，因此登录输出地址后再也收不到应答，尝试只能在 `loginTimeoutMs` 时（15 分钟后）结束，且什么都没有存储。登录命令现在运行在终端上。

所有添加 Claude 账号的用户都会看到新增的一步：**设置 → AI 账号 → 添加 Claude 账号** 会显示 **授权码** 输入框，将浏览器页面最后给出的授权码粘贴到该处即可完成登录。ChatGPT 的设备流程通过轮询获取授权，保持不变。

对实现方或调用方而言，三处 API 发生变化：

- `AiAccount` 新增抽象方法 `submitSignInCode(id, code)`，因此每个实现都必须定义它。
- `AiAccountSignInView` 新增必填字段 `awaitingCode`，因此每个构造出的视图都必须设置它。
- `AiAccountSignInError` 新增 `store-failed`，用于 CLI 已登录但账号未能记录的情形；该情形此前报告为 `login-failed`。

`aiAccount` Remote 命名空间新增 `submitSignInCode(attemptId, code)`。提供者还接受 `loginRows`、`loginCols` 和 `loginTerminalType`。

## 迁移

1. 登录本身无需改动：打开 **设置 → AI 账号**，选择 **添加 Claude 账号**，在浏览器中完成后，把显示的授权码粘贴进 **授权码** 并按回车。确认该账号出现在 Claude 分组中并带有 **默认** 标记，且 `<Harness home>/ai-accounts/accounts.json` 已存在。
2. `AiAccount`（`@deepseek-ai/dsh-ai-account`）的实现方：新增 `submitSignInCode(id, code)`，把授权码送达登录命令，并对过期的 id 保持状态不变。为你构造的每个 `AiAccountSignInView` 设置 `awaitingCode`。
3. `errorCode` 的读取方：在 `login-failed` 之外处理 `store-failed`。以 `AiAccountSignInError` 为键的字典在新成员补齐条目前无法通过编译。
4. 用 `pnpm run typecheck` 确认；未实现的抽象方法或未设置的 `awaitingCode` 都会在此失败。
