# Agent Note: Official-CLI AI Accounts

Status: implemented

Superseded in part by [Consumer Subscription Account for the Main Model](../../proposed/feature/2026-09-30-subscription-account-main-model.md), which reverses the main-model half of this decision; everything else below remains in force.

## Problem

Users want to run delegated Claude Code and Codex work on their own Claude and ChatGPT subscriptions, keep several accounts of each kind, and pick which one is used. A subscription login is an OAuth grant issued to the official Claude Code or Codex client. Reading that grant out of the CLI's storage, refreshing it against the vendor's token endpoint, or sending it from another HTTP client impersonates the official client, couples the Harness to undocumented storage formats and client identifiers, and turns the Harness into a holder of long-lived subscription tokens. An earlier unreleased draft did exactly that: it ran `claude login`, read `~/.claude/.credentials.json`, refreshed the token itself, and used it as the API key of the main model.

## Decision

An AI Account is a registered official-CLI configuration directory. `@deepseek-ai/dsh-ai-account` defines `ctx.aiAccount`; `@deepseek-ai/dsh-ai-account-platform` implements it by running only the official CLI against one directory per account under `<Harness home>/ai-accounts`:

| Kind | Directory variable | Add | Identify | Remove |
|---|---|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR=<root>/claude/<id>` | `claude auth login --claudeai` | `claude auth status --json` | `claude auth logout`, then delete the directory |
| `chatgpt` | `CODEX_HOME=<root>/codex/<id>` | `codex login --device-auth` | `codex login status` | `codex logout`, then delete the directory |

The provider stores only metadata (`id`, `kind`, `email`, `plan`, `createdAt`, and one default id per kind) in `accounts.json`. It never opens a file the CLI writes and never contacts a token endpoint; an account is added only when the CLI's own status command reports it signed in. The login's printed browser URL, or the Codex verification URL and one-time code, are surfaced so the user can finish sign-in from the settings page.

Accounts are used only by launching the same official product. `@deepseek-ai/dsh-subagent-ai-account` mounts `@deepseek-ai/dsh-subagent-claude-code` as provider `claude-code` with `CLAUDE_CONFIG_DIR` and `@deepseek-ai/dsh-subagent-codex` as provider `codex` with `CODEX_HOME`, each pointing at the default account of its kind, through the providers' documented `env` overlay. It remounts the provider fiber on `ai-account/default-changed` and mounts nothing for a kind without a default. It is an optional Profile Bundle, like the standalone provider Bundles, because the production-install exclusion keeps the product payloads out of shipped Bundles. The Web App presets' `tool-subagent-claude-code` and `tool-subagent-codex` rows are enabled; each tool registers only while its provider is mounted.

The token-to-main-model package was removed from every composition. The settings surface is **AI Account** (`AI 账号`) in `@deepseek-ai/dsh-client-ui-settings-ai-account`, served through the `aiAccount` Remote namespace of `@deepseek-ai/dsh-api-ai-account-controller`.

The same page hosts the main-model sign-in, which is not an AI Account and runs no CLI. `@deepseek-ai/dsh-client-ui-settings-ai-account` declares the `settings.ai-account.group` slot and renders its entries before the Claude and ChatGPT groups. In the shipped composition that entry is the Coteccons SSO group of `@deepseek-ai/dsh-client-ui-settings-coteccons-sso` ([Coteccons SSO decision](2026-09-30-coteccons-sso-entra-main-model.md)); `@deepseek-ai/dsh-client-ui-settings-account` registers a DeepSeek Platform group in the same slot when its disabled row is re-enabled. The page therefore reads Coteccons SSO (main model), Claude (through Claude Code), and ChatGPT (through Codex), and the settings shell opens AI Account for the retired `account` section id.

## Alternatives considered

**Extract the OAuth token and call the vendor API directly.** This is the removed draft. It lets a subscription drive the main model, but it depends on private storage and client identifiers, requires the Harness to refresh and hold tokens, and uses a grant outside the client it was issued to.

**Copy credentials into the Harness credential store.** Copying gives one place to manage secrets, but it duplicates long-lived grants, still requires reading private CLI storage, and leaves two copies to revoke.

**Use the default `~/.claude` and `~/.codex` directories.** No new directory is needed, but that supports only one account per kind and lets Harness sign-in and sign-out change the user's own terminal login.

**Mount the providers from the platform package.** One fewer package, but the platform sits in the base Bundle, and the product providers bring pinned product runtimes that the production-install exclusion keeps out of shipped Bundles.

**Keep a separate Account section for DeepSeek.** It needs no new slot, but it splits account management across two Settings pages and hides DeepSeek sign-in from Settings until the user is already signed in.

**Reconfigure the standalone provider rows through the Loader.** Writing `env` into the Profile's provider rows would reuse the standalone Bundles, but it persists Host paths into Profile configuration on every default change and couples account state to configuration edits.

## Consequences

Subscription credentials never pass through Harness code, logs, or storage, and each account's login stays revocable through the official CLI. Several accounts per kind are independent because each has its own directory, and the user's terminal login is untouched.

Claude and ChatGPT subscriptions no longer drive the main model; they are reachable only through delegated Claude Code and Codex runs. Only the main-model sign-in (Coteccons SSO in the shipped composition) drives the main model. Settings has one home for accounts, and contributed groups appear there only while the AI Account section is composed. Identity is limited to what the CLIs report, so ChatGPT accounts show no email. Login and delegation use two binaries: login runs the host `claude` or `codex` found on `PATH` (configurable), while delegation runs the provider Bundles' pinned runtimes, which read the same directory. Sign-in cannot be driven headlessly in tests, so coverage uses fake executables and a Loader composition without product processes; a real end-to-end sign-in remains a manual check.
