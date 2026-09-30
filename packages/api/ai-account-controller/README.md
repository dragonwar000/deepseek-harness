---
description: "The aiAccount Remote controller exposes AI Account snapshots and commands to the browser without credentials or Host directory paths."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-ai-account-controller

English | [中文](README.zh.md)

## Summary

The `aiAccount` Remote namespace lets the settings UI list AI Accounts, start or cancel an official-CLI sign-in, choose defaults, and remove accounts. It forwards every call to `ctx.aiAccount` and returns the same credential-free snapshots.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web App Bundle mounts the controller as row `ai-account-controller`. The namespace exposes `getState`, `startSignIn(kind)`, `cancelSignIn(attemptId)`, `submitSignInCode(attemptId, code)`, `setDefault(accountId)`, `removeAccount(accountId)`, `checkStatus()`, and the streams `watch` and `watchStatusChanges`. Every command returns the complete snapshot after it settles, and `watch` starts with the current snapshot, whose accounts carry their sign-in `status`. `checkStatus()` runs the provider's sign-in status check now, joining one already running. `watchStatusChanges` yields each `ai-account/status-changed` payload emitted while the stream is open and replays none from before it opened. Cancellation and code submission both name the attempt id, so a stale screen cannot cancel a newer sign-in or send its code to one. A submitted code reaches the official CLI's terminal and is never stored or logged here. `defaultHome` is not exposed: account directories stay on the Host.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller is a Typert Remote service over `ctx.aiAccount` with no state of its own; no invariant companion is published. Provider failures such as an unknown account id reach the caller as Remote errors.

<a id="further-exploration"></a>
## Further Exploration

- [ai-account](../../credentials/ai-account/README.md) — the Service Definition and views.
- [ui-settings-ai-account](../../client/ui-settings-ai-account/README.md) — the settings page that consumes this namespace.
- [api-remotes](../remotes/README.md) — the Remote assembly that mounts this namespace in the browser.

<a id="model-experience"></a>
## Model Experience

None, as AI Account management registers no model context or tools; subscription credentials stay inside the official CLIs.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sign-in outlives the page, not the Host** — a reconnecting page recovers the active attempt through `watch`, but a Host restart ends the attempt and its CLI process.

<a id="dev-note"></a>
### Dev Note

None.
