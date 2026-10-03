---
description: "AI Account Service Definition: register Claude and ChatGPT subscription accounts whose logins stay inside the official Claude Code and Codex CLIs, choose one default per kind, and watch the account list."
kind: "package-reference"
---

# @deepseek-ai/dsh-ai-account

English | [中文](README.zh.md)

## Summary

Account consumers list Claude and ChatGPT subscription accounts, add one through the official CLI login, choose the default account of each kind, and remove accounts. Each account owns one official-CLI configuration directory, and its subscription credential never leaves that directory: the service exposes the directory path only to Host consumers that launch the same official CLI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`ctx.aiAccount` is an `AiAccount`. Kind `claude` signs in through Claude Code and kind `chatgpt` through Codex.

| Operation | Contract |
|---|---|
| `getState()` | Complete `AiAccountsView`: accounts ordered by kind, then registration time, plus the latest sign-in attempt |
| `startSignIn(kind)` | Joins the active attempt, or starts the official CLI login for a new account; returns before the user authorizes |
| `cancelSignIn(id)` | Cancels the named attempt and discards its unfinished directory; a stale id changes nothing |
| `submitSignInCode(id, code)` | Hands the authorization code the vendor's browser page displayed to a login command reading one; a stale id or an attempt reading none changes nothing |
| `setDefault(id)` | Makes one account the default of its kind |
| `remove(id)` | Signs the account out through its CLI, deletes its directory, and forgets it; removing the default promotes the oldest remaining account of that kind |
| `checkStatus()` | Runs every account's official CLI status command and records each conclusive answer; a call during a running check joins it |
| `watch(signal)` | Complete snapshots starting with the current one; ending the subscription never cancels a sign-in |
| `defaultHome(kind)` | Host-only absolute directory of the default account, or `undefined` when the kind has none |

An attempt moves through `starting`, then `waiting-browser` (Claude) or `waiting-device-code` (ChatGPT), then `verifying`, and ends as `succeeded`, `cancelled`, or `failed` with an `errorCode` of `executable-missing`, `login-failed`, `timeout`, `identity-unavailable`, or `store-failed`. `login-failed` is the CLI's own refusal; `store-failed` means the CLI signed in but the account could not be recorded, so it was signed back out. `url` carries the browser or verification URL the CLI printed and `userCode` the Codex one-time code. `awaitingCode` is set while the login command reads an authorization code from its terminal, which is the channel `submitSignInCode` answers; the Claude browser page ends on such a code, while ChatGPT polls and never reads one. The first account of a kind becomes its default. Every default change, including to none, emits `ai-account/default-changed` with the kind after the change is stored.

Each account view carries `status`: `status` is `signedIn`, `signedOut`, or `unknown`; `checkedAt` is the completion time of the check that produced it (`null` while `unknown`); `message` is the first line the CLI printed with a `signedOut` answer (`null` otherwise). `unknown` means no check has answered conclusively since the provider started, and an inconclusive check leaves the recorded status unchanged. Every transition emits `ai-account/status-changed` once with an `AiAccountStatusChange`: the account `id` and `kind`, whether it was its kind's default, the `previous` status, and the `current` status view. A check that confirms the recorded status emits nothing.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package defines operations and credential-free views only; the provider owns the CLI processes, the metadata file, and the account directories. No invariant companion is published because the service holds no relationship that a second observation could contradict.

<a id="further-exploration"></a>
## Further Exploration

- [ai-account-platform](../ai-account-platform/README.md) — the official-CLI provider.
- [api-ai-account-controller](../../api/ai-account-controller/README.md) — the Remote controller that exposes the views to the browser.
- [subagent-ai-account](../../subagent/subagent-ai-account/README.md) — mounts the Claude Code and Codex subagent providers for the default accounts.
- [Official-CLI AI accounts decision](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md) — why credentials stay inside the official CLIs.

<a id="model-experience"></a>
## Model Experience

None, as AI Account management registers no model context or tools; subscription credentials stay inside the official CLIs.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One attempt at a time** — `startSignIn` joins an active attempt of either kind instead of starting a second login.
- **Identity is what the CLI reports** — Codex reports no email, so ChatGPT accounts usually show no email or plan.

<a id="dev-note"></a>
### Dev Note

None.
