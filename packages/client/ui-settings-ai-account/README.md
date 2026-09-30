---
description: "AI Account settings page in the dsh web client: the Coteccons SSO group for the main model, then Claude and ChatGPT subscription accounts added through the official CLIs, with a default of each kind and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-ai-account

English | [中文](README.zh.md)

## Summary

Open **Settings → AI Account** to manage every account the app uses. The **Coteccons SSO — used for the main model** group signs a Coteccons staff member in with Microsoft Entra ID; that user's own sign-in runs the main model. The Claude and ChatGPT groups add subscription accounts, show which account of each kind is the default, switch the default, and sign an account out; adding one runs the official Claude Code or Codex login on the Host, and the page shows the link to open, the field for Claude's authorization code, and ChatGPT's one-time code.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The page shows three groups in order. **Coteccons SSO — used for the main model** comes from [ui-settings-coteccons-sso](../ui-settings-coteccons-sso/README.md), which owns its sign-in and sign-out; the page only reserves its place. **Claude — used through Claude Code** and **ChatGPT — used through Codex** list official-CLI accounts. Each row shows the email the CLI reported (or **Signed-in account** when it reported none), the plan when known, and a **Default** badge on the default account. **Set as default** switches the default of that kind; **Sign out and remove** signs the account out through its CLI and forgets it.

Each subscription group also states why it adds nothing to the chat model picker and which key does instead: a Claude subscription is issued to Anthropic's own Claude Code client and a ChatGPT subscription to OpenAI's own Codex client, so only those clients may send them, and running the main model on that vendor means adding an Anthropic or OpenAI API key under **Models**. [llm-pi-ai](../../llm/llm-pi-ai/README.md#use-this-package) owns that rule and the classification behind it.

**Add Claude account** starts `claude auth login`: the Claude CLI opens a browser window on the Host, and the page shows the authorization link in case no window opened. That browser page ends on an authorization code, so the page also shows **Authorization code**; pasting it there and pressing Enter or **Complete sign-in** hands it to the waiting login command, which is what completes the sign-in. The field stays available until the command exits, so a code the CLI refuses can be entered again. **Add ChatGPT account** starts `codex login --device-auth`: the page shows the verification link and the one-time code to enter there. **Cancel** stops the login. Failures explain whether the CLI is missing, the login did not complete, it timed out before the code was entered, the CLI reported no signed-in account, or the account could not be saved on the Host. Adding is disabled while a sign-in is active.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply` that gives the package a Loader row, and declares no services: `slots` and `locale` are browser services, so naming them here would hold the Host row waiting for the whole run instead of activating it. The browser half subscribes to `ctx.remote.aiAccount.watch` through a reconnecting Remote stream, publishes each snapshot through the section's `accounts` hook, and registers `AiAccountSection` into the `settings.section` slot with id `ai-account`. The section declares the `settings.ai-account.group` list slot and renders its entries after the introduction and before the Claude and ChatGPT groups, in every account-list state, so a group with its own Host stream (Coteccons SSO) stays usable while the official-CLI list loads or after it is lost. Commands publish the snapshot they return; a refused command shows a generic failure, and an ended account stream keeps the last snapshot with a reload notice. All copy lives in the `settings.aiAccount` dictionary. No invariant companion is published because every displayed fact derives from the Host account stream.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [ai-account](../../credentials/ai-account/README.md) — the Service Definition and views.
- [api-ai-account-controller](../../api/ai-account-controller/README.md) — the Remote namespace this page calls.
- [ui-settings](../ui-settings/README.md) — the settings page that hosts the section slot.

<a id="model-experience"></a>
## Model Experience

None, as AI Account management registers no model context or tools; subscription credentials stay inside the official CLIs.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No removal confirmation** — **Sign out and remove** acts immediately; signing in again is the recovery path.
- **The Models pointer is prose, not a link** — the per-group explanation names the **Models** page, but the settings shell exposes `openSection` only to the onboarding slot, so a section cannot navigate there; the reader switches pages themselves.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
