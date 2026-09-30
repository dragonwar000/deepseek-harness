# Agent Note: Microsoft 365 Connectors Controlled by IT in Entra ID

Status: implemented

[English](2026-09-30-coteccons-m365-connectors.md) | 中文

## 问题

CTD Core 用户希望助手读取自己的 Outlook 邮件、Teams 聊天以及 OneDrive/SharePoint 文件。访问必须遵循每个用户本人的 Microsoft 365 权限，并且 Coteccons IT 必须能够在 Azure 中按用户或组逐类授予或撤销访问，而无需修改各安装。

## 决策

每类数据是一个 Entra ID 公共客户端企业应用：`CTD-Core M365 Connector - Mail`（`Mail.Read`）、`- Teams Chat`（`Chat.Read`）与 `- Files`（`Files.Read.All`、`Sites.Read.All`），每个都带 `User.Read`、这些委派只读 scope 的租户级管理员同意，并启用"需要分配"。每个应用分配给一个安全组：`SG-CTDCore-M365-Mail`、`-TeamsChat` 或 `-Files`。[`scripts/azure/m365-connectors.sh`](../../../../scripts/azure/m365-connectors.sh) 用 `az` 创建并收敛它们。

`ctx.cotecconsSso` 增加连接器操作：不含令牌的 `M365ConnectorView`（`not-configured`、`disconnected`、`connecting`、`connected`，以及带 `not-assigned`、`disabled-by-admin`、`consent-required`、`revoked` 或 `failed` 的 `blocked`）、连接、取消、断开、监听，以及仅限 Host 的 `getM365AccessToken`。`coteccons-sso-msal` 为每个连接器运行一个 MSAL 客户端和一条凭据记录 `coteccons-sso/m365-<id>`，并把 Entra ID 错误码映射到视图；它不保存任何"允许"标志。`@deepseek-ai/dsh-tool-m365` 以委派令牌通过 Microsoft Graph 提供只读的 `m365_search`、`m365_read_mail`、`m365_read_chat` 与 `m365_read_file`，AI 账号页面在 Coteccons SSO 下方显示 Microsoft 365 分组。

IT 把用户加入组即授予某类访问，移出该组并执行"撤销会话"即撤销；在企业应用上禁用登录则对所有人停止该类访问。

## 考虑过的替代方案

**在 CTD-Core 应用上添加 Graph scope。** 只需一次登录，但撤销邮件访问也会撤销主模型，IT 也无法区分数据类别。

**一个连接器应用加每类一个 App Role。** 所有类别只需一次登录，但逐类决定将由读取 `roles` 声明的 Harness 代码执行，而不是由 Entra ID 拒绝签发令牌。

**应用程序权限。** 它们绕过每个用户的权限，会让助手读取所有邮箱。

## 后果

Entra ID 拒绝向未分配的用户签发令牌，因此被修改的客户端也无法读取 IT 未授予的类别。移除分配在下一次令牌刷新时生效，最长为访问令牌的有效期；立即撤销还需要"撤销会话"。用户在浏览器中为每个类别连接一次。读取的内容对模型可见，并记录在本地会话日志中。针对 Coteccons 租户的真实登录与 Graph 读取仍需手动验证。
