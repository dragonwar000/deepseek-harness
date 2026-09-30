# Agent Note: Microsoft 365 Connectors Controlled by IT in Entra ID

Status: implemented

English | [中文](2026-09-30-coteccons-m365-connectors.zh.md)

## Problem

CTD Core users want the assistant to read their Outlook mail, Teams chats, and OneDrive/SharePoint files. Access must follow each user's own Microsoft 365 permissions, and Coteccons IT must be able to grant or revoke each data kind per user or group in Azure without changing installations.

## Decision

Each data kind is one Entra ID public-client enterprise app: `CTD-Core M365 Connector - Mail` (`Mail.Read`), `- Teams Chat` (`Chat.Read`), and `- Files` (`Files.Read.All`, `Sites.Read.All`), each with `User.Read`, tenant-wide admin consent for those delegated read-only scopes, and "Assignment required" enabled. Each app is assigned to one security group, `SG-CTDCore-M365-Mail`, `-TeamsChat`, or `-Files`. [`scripts/azure/m365-connectors.sh`](../../../../scripts/azure/m365-connectors.sh) provisions and converges them with `az`.

`ctx.cotecconsSso` gains connector operations: token-free `M365ConnectorView`s (`not-configured`, `disconnected`, `connecting`, `connected`, `blocked` with `not-assigned`, `disabled-by-admin`, `consent-required`, `revoked`, or `failed`), connect, cancel, disconnect, watch, and the Host-only `getM365AccessToken`. `coteccons-sso-msal` runs one MSAL client and one credential record `coteccons-sso/m365-<id>` per connector and maps Entra ID codes to the view; it stores no allowed flag. `@deepseek-ai/dsh-tool-m365` exposes read-only `m365_search`, `m365_read_mail`, `m365_read_chat`, and `m365_read_file` over Microsoft Graph with delegated tokens, and the AI Account page shows a Microsoft 365 group under Coteccons SSO.

IT grants a kind by adding the user to the group and revokes it by removing the user and running "Revoke sessions"; disabling sign-in on the enterprise app stops the kind for everyone.

## Alternatives considered

**Graph scopes on the CTD-Core app.** One sign-in, but revoking mail would also revoke the main model, and IT could not separate data kinds.

**One connector app with App Roles per kind.** One sign-in for all kinds, but the per-kind decision would be enforced by Harness code reading the `roles` claim instead of by Entra ID refusing the token.

**Application permissions.** They bypass each user's permissions and would let the assistant read every mailbox.

## Consequences

Entra ID refuses tokens to unassigned users, so a modified client cannot read a kind IT has not granted. Removing an assignment takes effect at the next token refresh, up to the access-token lifetime; immediate revocation also needs "Revoke sessions". Users connect each kind once in the browser. Read content becomes model-visible and is recorded in the local session log. A real sign-in and Graph reads against the Coteccons tenant remain manual checks.
