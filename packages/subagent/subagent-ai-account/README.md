---
description: "Profile Bundle that runs the Claude Code and Codex subagent providers as the default AI Account of each kind, remounting them when the default changes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-ai-account

English | [中文](README.zh.md)

## Summary

Install this Profile Bundle when delegated Claude Code and Codex tasks should run as the accounts added in **Settings → AI Account**. For each kind with a default account, it mounts the official product provider — `claude-code` for Claude, `codex` for ChatGPT — with that account's CLI configuration directory, so the product CLI uses the account's own stored login. Changing or removing the default remounts or withdraws the provider; the delegation tools appear and disappear with it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Install the Bundle into a Profile that also mounts an `ctx.aiAccount` provider (the base Bundle mounts `ai-account-platform`), then restart the Profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-ai-account
```

The Bundle brings both product provider packages and their pinned runtimes; do not also install `@deepseek-ai/dsh-subagent-claude-code` or `@deepseek-ai/dsh-subagent-codex`, whose own rows would register the same provider names and fail with a duplicate-provider error.

| Field | Default | Meaning |
|---|---|---|
| `claudeCode` | `{ providerName: claude-code }` | [Claude Code provider configuration](../subagent-claude-code/README.md) for the default Claude account |
| `codex` | `{ providerName: codex }` | [Codex provider configuration](../subagent-codex/README.md) for the default ChatGPT account |

The account directory is layered over each configuration's `env`: `CLAUDE_CONFIG_DIR` for Claude Code and `CODEX_HOME` for Codex. The model reaches a provider only through a delegation tool row. The Web App's standard, PTC, and Cordis presets carry `tool-subagent-claude-code` (`subagent_claude_code`) and `tool-subagent-codex` (`subagent_codex`) rows; each tool registers only while its provider is mounted.

<a id="understand-the-implementation"></a>
## Understand the implementation

For each kind, the plugin reads `ctx.aiAccount.defaultHome(kind)` at start and on every `ai-account/default-changed` for that kind. A new directory disposes the current provider fiber and mounts a fresh one with `ctx.plugin`; no default leaves the kind without a provider. Provider fibers are children of this plugin, so disposing it withdraws both providers. Disposing a provider fiber ends that provider's registration; a delegation in flight on it stops with the provider. No invariant companion is published because the subagent service already owns provider registration.

<a id="further-exploration"></a>
## Further Exploration

- [ai-account](../../credentials/ai-account/README.md) — the account service whose defaults select the directories.
- [subagent-claude-code](../subagent-claude-code/README.md) and [subagent-codex](../subagent-codex/README.md) — the mounted product providers.
- [tool-subagent](../tool-subagent/README.md) — the delegation tool that exposes a provider to the model.
- [Official-CLI AI accounts decision](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md) — why accounts are used only through the official CLIs.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the mounted Claude Code and Codex providers and their `dsh-tool-subagent` rows: while a kind has a default account, the model can call that kind's delegation tool, and the child product runs as that account; without a default, the tool is absent.

#### KV Cache effect

A default appearing or disappearing adds or removes a delegation tool schema, which changes the tool list of later requests; switching between two accounts of the same kind changes no model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Exclusive with the standalone provider Bundles** — the provider names `claude-code` and `codex` are fixed by the preset tool rows, so this Bundle and the standalone provider Bundles cannot share a Profile unless `providerName` and the tool rows are changed together.
- **Remounting interrupts delegations** — changing or removing a default while a delegated run is active stops that run.

<a id="dev-note"></a>
### Dev Note

None.
