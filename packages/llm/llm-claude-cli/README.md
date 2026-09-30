---
description: "The claude-cli model route: Claude models reached by spawning the vendor's own Claude Code CLI as a child process, so the CLI owns authentication and the Harness never calls the Anthropic model API."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

English | [中文](README.zh.md)

## Summary

This plugin registers the `claude-cli` model route. Its transport is the vendor's own Claude Code CLI, spawned through `ctx.subprocess` for each request, so a Claude subscription drives a model inside the Harness and the Harness sends no request to Anthropic. The CLI owns authentication: this package only points it at a registered account's configuration directory through the CLI's documented `CLAUDE_CONFIG_DIR` variable.

The route serves requests that declare **no tools**: Claude Code accepts no caller-supplied tool definitions, so a request declaring tools fails with `TOOL_CALLS_UNSUPPORTED` rather than losing them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Base Bundle carries the row `llm-claude-cli` with `disabled: true`. Enable it from a profile patch:

```yaml
- id: llm-claude-cli
  disabled: false
  config:
    cliPath: claude
    maxConcurrent: 2
```

The route registers itself only while an AI Account of kind `claude` has a default, which `@deepseek-ai/dsh-ai-account-platform` records after the CLI's own `claude auth login --claudeai` reports success. Sign in from Settings, AI Account. A composition that declares the same provider id for itself keeps it; activation only ever adds a route the composition is silent about.

| Config field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-cli` | Provider route registered on `ctx.llm`. |
| `displayName` | `Claude (Claude Code CLI)` | Route name wherever the picker does not localize it. |
| `cliPath` | `claude` | Executable name on `PATH`, or an absolute path. |
| `extraArgs` | `[]` | Arguments appended after the fixed ones. |
| `workingDirectory` | `<Harness home>/claude-cli` | Working directory for every child; see below. |
| `autoActivate` | `true` | Register the route when a Claude account has a default. |
| `authTimeoutMs` | `15000` | Deadline for `claude auth status --json` and `claude --version`. |
| `catalogTimeoutMs` | `30000` | Deadline for the one-shot model listing. |
| `requestTimeoutMs` | `600000` | Deadline for one inference run. |
| `maxConcurrent` | `2` | Concurrent CLI children this route may hold. |
| `graceMs` | `2000` | Grace before a terminated child is killed. |

`extraArgs` refuses `--bare`, `--betas`, `--append-system-prompt`, and the two permission-skipping flags at load: the first two would change how the CLI authenticates, and the rest would put text the Harness did not write in front of the model or let a tool run.

<a id="understand-the-implementation"></a>
## Understand the implementation

Every CLI invocation is planned by one pure module, `src/launch.ts`, so the exact argv and environment of a run are reviewable in one place.

**Inference** runs `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --tools "" --disallowedTools mcp__* --strict-mcp-config --setting-sources "" --disable-slash-commands --permission-prompts none --no-session-persistence --model <id> --session-id <uuid>`, plus `--system-prompt <text>` when the request carries one. `--tools ""` is the CLI's documented switch for disabling every built-in tool; MCP tools survive it, so they are denied separately.

**The model catalog comes from the CLI**, never from a vendor model API: one short-lived child receives a single `{"type":"control_request","request":{"subtype":"list_models"}}` line on stdin and its answer is read from stdout, after which the child is terminated. The catalog is cached per account directory and per launch fingerprint (executable, extra args, reported version) and is dropped when either changes.

**Authentication is a separate question**, asked first and only when the catalog must be probed. `list_models` answers successfully even against an unauthenticated configuration directory — it returns the list-priced catalog — so it cannot stand in for a login check. `claude auth status --json` is the check, and a signed-out directory produces a named `CLI_NOT_AUTHENTICATED` error naming where to sign in.

**Nothing fails quietly.** `listModels()` throws rather than returning an empty list, because `buildModelCatalog` turns a throw into a `ModelCatalogFailure` the picker shows with its message, while an empty list would drop the provider group without a word. The named codes are `CLI_MISSING`, `CLI_NOT_AUTHENTICATED`, `CLI_CATALOG_UNAVAILABLE`, `TOOL_CALLS_UNSUPPORTED`, and `UNKNOWN_MODEL`.

**Credentials.** The only environment entry this package sets is `CLAUDE_CONFIG_DIR`. Conflicting inherited variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` — are removed by the subprocess seam's own `SENSITIVE_ENV_PATTERN` scrub, not by a list maintained here.

**Attribution headers.** `LlmAdapter` requires every provider HTTP request to carry `attributionHeaders()`. This adapter sends no HTTP request: the CLI owns the connection. There is therefore nothing to attribute, and adding a first-party client identifier to a vendor endpoint is exactly what this design exists to avoid.

**Working directory.** Every child runs in one fixed, empty, non-repository directory. The CLI states its working directory and git branch to the model regardless of `--system-prompt`, and a constant empty directory keeps that statement constant and free of anything about the user's project.

<a id="further-exploration"></a>
## Further Exploration

- `@deepseek-ai/dsh-ai-account` and `@deepseek-ai/dsh-ai-account-platform` — the registered official-CLI configuration directories this route reads a path from.
- `@deepseek-ai/dsh-subagent-claude-code` — the other use of a Claude account, which delegates a whole task to Claude Code rather than using it as a model transport.
- `@deepseek-ai/dsh-llm` — the adapter seam, `StreamChunk`, and the disjoint `TokenUsage` accounting this adapter maps onto.
- [Vendor CLI as a model transport](../../../.agents/notes/implemented/feature/2026-09-30-vendor-cli-as-model-transport.md) — why the CLI is the transport instead of a lifted OAuth token, and why Codex and DeepSeek have no equivalent route.

<a id="model-experience"></a>
## Model Experience

### Text requests over the CLI transport

#### What the model sees

The Harness's own system prompt, substituted for Claude Code's through `--system-prompt`, and the Harness's messages as one user turn. No tool is declared to the model: `--tools ""` removes the CLI's built-ins and `--disallowedTools mcp__*` with `--strict-mcp-config` removes MCP tools, so the model sees a plain completion request. Requests carrying more than one message are rendered as a labelled transcript inside that single user turn, because the CLI supplies the assistant side of a conversation itself and ignores an injected assistant message. The CLI adds its own working-directory and git-branch line, which this route holds constant by running every child in one fixed empty directory.

#### Token effect

Replacing the CLI's default system prompt is a large reduction: measured against Claude Code 2.1.285, a request with the default prompt carried about 2,650 prompt tokens before any conversation, and the same request with `--system-prompt` carried about 440. The remaining overhead is the CLI's environment line.

#### KV Cache effect

Negative, and deliberately so. Claude Code caches its own default system prompt; substituting the Harness prompt discards that cache, and the measured requests above report no cache read or write at all. A conversation over this route therefore pays full prompt cost on every turn, which matters most for long multi-turn sessions and least for one-shot text requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No tool calls.** Claude Code accepts no caller-supplied tool definitions; its only tool mechanism is MCP, where the CLI invokes the tool inside its own loop. A request that declares tools fails with `TOOL_CALLS_UNSUPPORTED`, so this route cannot serve an agent turn. Prompt-level tool-call emulation would keep the Harness's loop and is specified but not built.
- **`list_models` is undocumented.** The control request this catalog probe uses is not in Claude Code's published CLI reference. It is answered by 2.1.285 and may change without notice; an unreadable answer produces `CLI_CATALOG_UNAVAILABLE` rather than a crash, and `tests/real-cli.e2e.ts` detects a change on any machine with a signed-in CLI.
- **No image or file input.** The route advertises `text` only. Attachments reach it as the handle text request assembly already substituted.
- **No prompt caching.** See the KV Cache note above.
- **One process per request.** Each request spawns and tears down a CLI child, which costs process startup on every turn; `maxConcurrent` bounds how many run at once.
- **Concurrency against one configuration directory is untested by the vendor.** Claude Code's documentation makes no promise about parallel `--print` runs sharing a `CLAUDE_CONFIG_DIR`. This route gives every run its own `--session-id` and passes `--no-session-persistence`, and defaults `maxConcurrent` to 2.

<a id="dev-note"></a>
### Dev Note

`tests/real-cli.e2e.ts` runs the installed `claude` and self-skips when it is absent or signed out, so it is inert in CI. It is the only check that would notice the undocumented `list_models` control request changing; run it on a machine with a signed-in CLI after a Claude Code upgrade.

The unit tests script the CLI through `tests/harness.ts`, which answers by the question the argv asks rather than by spawn order, so adding a probe does not renumber a queue.
