# Agent Note: A Vendor CLI as the Model Transport

Status: implemented

English | [中文](2026-09-30-vendor-cli-as-model-transport.zh.md)

## Problem

The repository owner wants a consumer subscription to drive a chat model inside the Harness. The [official-CLI AI Accounts decision](2026-09-29-official-cli-ai-accounts.md) refused that and left each subscription reachable only by launching the vendor's own CLI for a delegated task. A later proposal reversed the answer but kept the earlier note's assumption about the mechanism: that serving the main model from a subscription means reading the vendor CLI's OAuth grant out of its private storage, refreshing it, and presenting that CLI's client identity on every HTTP request. Every risk that note accepts — asserting falsely to be the vendor's first-party client, conflicting with the subscription terms, depending on undocumented storage and client identifiers, and becoming the second holder of a long-lived grant — follows from that one assumption.

## Decision

The assumption is wrong, and this note records the alternative that was built instead: **the vendor's CLI is the transport, not the credential source.**

`@deepseek-ai/dsh-llm-claude-cli` registers the `claude-cli` model route. Each request spawns `claude` through `ctx.subprocess` and speaks the CLI's own `--input-format stream-json` protocol to it. The Harness sends no HTTP request to Anthropic, holds no token, refreshes nothing, and presents no client identity anywhere. Its only credential action is the one the earlier decision already sanctioned: pointing the CLI at a registered account's configuration directory through the CLI's documented `CLAUDE_CONFIG_DIR` variable. Conflicting inherited variables are removed by the subprocess seam's existing `SENSITIVE_ENV_PATTERN` scrub rather than by a list this package maintains.

Three consequences of using the CLI as the transport are load-bearing and were verified against Claude Code 2.1.285 rather than assumed:

**Tools can be switched off, so the CLI is a completion engine.** `--tools ""` is the CLI's documented switch for removing every built-in tool; `--disallowedTools mcp__*` with `--strict-mcp-config` removes MCP tools; `--system-prompt` replaces the CLI's own system prompt rather than appending to it. A measured request carried about 440 prompt tokens against about 2,650 with the CLI's defaults.

**The model catalog comes from the CLI.** One short-lived child answers a single `list_models` control request on stdin, and the catalog is cached per account directory and per launch fingerprint. No vendor model API is contacted.

**A catalog is not a login.** `list_models` answers successfully against an unauthenticated configuration directory, returning the list-priced catalog rather than the subscription's. `claude auth status --json` is therefore asked first and separately, and a signed-out directory produces a named `CLI_NOT_AUTHENTICATED` error. `listModels()` throws rather than returning an empty list, because `buildModelCatalog` renders a throw as a visible `ModelCatalogFailure` while an empty list silently drops the provider group.

**The CLI takes no tool definitions, so the prompt carries them.** Claude Code accepts no caller-supplied tool definitions and offers no mode that reports a tool call without executing it; its only tool mechanism is MCP, where the CLI invokes the tool inside its own loop. A request that declares tools is therefore served by rendering its tool schemas into the system prompt and parsing the model's fenced reply back into a real `tool-call` block, which keeps the Harness's loop, guards, approvals, and compaction. [That emulation has its own note](2026-09-30-prompt-emulated-tool-calls-for-cli-transports.md); `toolCalls: 'refuse'` keeps the original refusal.

The row ships `disabled: true`. It is enabled from a profile patch, and it registers only while an AI Account of kind `claude` has a default; a composition that declares the same provider id keeps it.

## Alternatives considered

**Lift the OAuth grant and call the vendor API, as that proposal describes.** It makes the subscription serve any request, tools included. It lost because it requires presenting Anthropic's first-party CLI identity — the `claude-cli` user agent, `x-app: cli`, the `claude-code-20250219` beta, and a "You are Claude Code" system block — from a client that is not that CLI, and because it makes the Harness the second holder of a grant that can then be revoked in only one of two places. Its risks are exactly the ones this decision does not take.

**Expose the Harness's tools to the CLI as an MCP server.** The CLI would then call real Harness tools with the Harness's own guards, and the subscription would serve full agent turns. It lost because the CLI keeps the loop: turn iteration, compaction, and the stop decision would move out of `agent-loop` into another product, which is the one thing the delegated route (`@deepseek-ai/dsh-subagent-claude-code`) already does better and more honestly.

**Emulate tool calls in the prompt.** Chosen, and [recorded separately](2026-09-30-prompt-emulated-tool-calls-for-cli-transports.md), because it is a decision about a transport that cannot take tool definitions rather than about which transport to use.

**Do nothing and keep subscriptions delegated-only.** No new package, no undocumented control request. It lost because it leaves the owner's subscription unable to answer even a tool-free request inside the Harness.

## Why Codex and DeepSeek have no equivalent route

**Codex: delegated-whole-turn only.** Codex 0.154.0 offers no way to disable its tools. There is no `--tools` equivalent on `codex` or `codex exec`, and across the 628 definitions its app-server protocol emits (`codex app-server generate-json-schema`) the only tool-configuration type is `ToolsV2`, whose entire body is `{"web_search": …}`; neither `TurnStartParams` nor `ThreadStartParams` carries a tools field. Its base instructions *are* replaceable through `thread/start`, but a measured turn under replaced instructions still carried 14,650 input tokens — Codex's tool definitions and skill descriptions, present in every request. Codex therefore always runs its own agent loop inside a turn, and the Harness cannot keep its loop, guards, or compaction for a Codex-backed model. The ChatGPT subscription stays where it already works and where the shape is honest: delegation through `@deepseek-ai/dsh-subagent-codex`.

**DeepSeek: there is nothing to spawn, because there is no subscription.** No official DeepSeek CLI exists; a catalogue of some 45 coding-agent CLIs lists none, and every community DeepSeek CLI examined authenticates with an API key. More fundamentally, DeepSeek sells no subscription to be backed by one: `GET /user/balance` returns only `is_available`, `total_balance`, `granted_balance` and `topped_up_balance` per currency, with no plan, tier, or renewal field anywhere in its billing model, and the pricing page contains no occurrence of "subscription", "monthly", or "plan". DeepSeek does document an Anthropic-format endpoint at `https://api.deepseek.com/anthropic` and a Claude Code recipe for it, which would make this very package serve DeepSeek by overriding two environment variables. That was refused twice over: it would send Anthropic's first-party client identity to a different vendor's endpoint, and it would gain nothing, because `@deepseek-ai/dsh-llm-deepseek-api-key` already serves that exact endpoint natively with streaming, pricing, file, and image-token support.

## Consequences

A Claude subscription can answer tool-free requests inside the Harness with no token in Harness code, logs, or storage, and with nothing but the CLI's own documented directory variable passed to it. Each login stays revocable in exactly one place, and revoking it in the CLI stops this route too.

The picker states, in locale-owned copy, that the entry is subscription-backed and runs through the vendor CLI. What a tool-bearing turn costs over this transport, and what it depends on, belongs to the [emulation decision](2026-09-30-prompt-emulated-tool-calls-for-cli-transports.md).

Prompt caching is lost: substituting the Harness system prompt discards the cache Claude Code keeps for its own, so every turn pays full prompt cost. Each request also spawns and tears down a process.

The `list_models` control request is undocumented and can change without notice; an unreadable answer degrades to a named catalog error, and a real-CLI test that self-skips without a signed-in CLI detects the change. The vendor documents nothing about concurrent `--print` runs against one configuration directory, so each run takes its own session id with persistence off, and concurrency is a bounded, configurable number.

Serializing a conversation into one user turn adds no model-visible input: it is an adapter projection of messages the session log already holds, like any other adapter's. The prompt text that declares tools does add one, and the [emulation decision](2026-09-30-prompt-emulated-tool-calls-for-cli-transports.md) owns its session event.
