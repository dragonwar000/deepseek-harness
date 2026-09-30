---
description: "The claude-cli model route: Claude models reached by spawning the vendor's own Claude Code CLI as a child process, so the CLI owns authentication and the Harness never calls the Anthropic model API."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

English | [中文](README.zh.md)

## Summary

This plugin registers the `claude-cli` model route. Its transport is the vendor's own Claude Code CLI, spawned through `ctx.subprocess` per request, so a Claude subscription drives a model inside the Harness and no request goes to Anthropic. The CLI owns authentication: this package only points it at a registered account's directory through the CLI's own `CLAUDE_CONFIG_DIR` variable.

Claude Code takes no caller-supplied tool definitions, so a request declaring tools has its schemas rendered into the system prompt and the model's fenced reply parsed back into a real `tool-call` block. That keeps iteration, guards, approvals, and compaction in the Harness.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Tool calls in the prompt](#tool-calls-in-the-prompt)
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
    toolCalls: prompt
```

Patching by id replaces the row's whole `config` object, so a patch that sets one field repeats every other field it wants to keep.

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
| `toolCalls` | `prompt` | `prompt` declares the request's tools in the system prompt; `refuse` fails a tool-bearing request with `TOOL_CALLS_UNSUPPORTED`. |
| `toolCallMaxCalls` | `4` | Tool-call blocks accepted from one reply; the preamble states the number. |
| `toolCallMaxBytes` | `32768` | Bytes accepted inside one tool-call block; the preamble states the number. |
| `toolCallRetries` | `1` | Correction runs allowed after a rejected reply that produced no output yet. |
| `toolCallLenient` | `true` | Accept a call written in one of two near-miss forms instead of rejecting it; see [below](#tool-calls-in-the-prompt). `false` rejects both as `TOOL_CALL_UNFENCED`. |

`extraArgs` refuses `--bare`, `--betas`, `--append-system-prompt`, and the two permission-skipping flags at load: the first two would change how the CLI authenticates, and the rest would put text the Harness did not write in front of the model or let a tool run.

<a id="understand-the-implementation"></a>
## Understand the implementation

Every CLI invocation is planned by one pure module, `src/launch.ts`, so the exact argv and environment of a run are reviewable in one place.

**Inference** runs `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --tools "" --disallowedTools mcp__* --strict-mcp-config --setting-sources "" --disable-slash-commands --permission-prompts none --no-session-persistence --model <id> --session-id <uuid>`, plus `--system-prompt <text>` when the request carries one. `--tools ""` is the CLI's documented switch for disabling every built-in tool; MCP tools survive it, so they are denied separately.

**The model catalog comes from the CLI**, never from a vendor model API: one short-lived child receives a single `{"type":"control_request","request":{"subtype":"list_models"}}` line on stdin and its answer is read from stdout, after which the child is terminated. The catalog is cached per account directory and per launch fingerprint (executable, extra args, reported version) and is dropped when either changes.

**Authentication is a separate question**, asked first and only when the catalog must be probed. `list_models` answers successfully even against an unauthenticated configuration directory — it returns the list-priced catalog — so it cannot stand in for a login check. `claude auth status --json` is the check, and a signed-out directory produces a named `CLI_NOT_AUTHENTICATED` error naming where to sign in.

**Nothing fails quietly.** `listModels()` throws rather than returning an empty list, because `buildModelCatalog` turns a throw into a `ModelCatalogFailure` the picker shows with its message, while an empty list would drop the provider group without a word. The named codes are `CLI_MISSING`, `CLI_NOT_AUTHENTICATED`, `CLI_CATALOG_UNAVAILABLE`, `UNKNOWN_MODEL`, `TOOL_CALLS_UNSUPPORTED`, `EMULATION_NOT_LOGGABLE`, and the `TOOL_CALL_*` rejections below.

**Runtime invariants.** No runtime invariant companion is published: every relationship this package owns has exactly one observer, the catalog cache is read only through `ClaudeCliCatalog`, and an emulated reply is read only by the decoder that produced it, so no two independent observations can diverge. Behavior tests cover the probes, the parser, and the session record.

**Credentials.** The only environment entry this package sets is `CLAUDE_CONFIG_DIR`. Conflicting inherited variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` — are removed by the subprocess seam's own `SENSITIVE_ENV_PATTERN` scrub, not by a list maintained here.

**Attribution headers.** `LlmAdapter` requires every provider HTTP request to carry `attributionHeaders()`. This adapter sends no HTTP request: the CLI owns the connection. There is therefore nothing to attribute, and adding a first-party client identifier to a vendor endpoint is exactly what this design exists to avoid.

**System prompt.** A loop-built request leaves `GenerateOptions.system` undefined and carries its prompt as the leading system-role message instead. That message is hoisted into `--system-prompt`, so the Harness prompt replaces Claude Code's own rather than arriving as a labelled paragraph inside the user turn with the CLI's prompt still above it.

**Working directory.** Every child runs in one fixed, empty, non-repository directory. The CLI states its working directory and git branch to the model regardless of `--system-prompt`, and a constant empty directory keeps that statement constant and free of anything about the user's project.

<a id="tool-calls-in-the-prompt"></a>
## Tool calls in the prompt

A request that declares tools gets an extra section appended to its system prompt: the contract for reporting a call, and every declared tool with its `description` and its `parameters` schema. The wording is fixed, pinned verbatim by a test, and identified by `PREAMBLE_TEMPLATE`; it is not configurable, because it is what makes a reply parseable.

To call a tool the model emits a fenced block whose info string is `dsh-tool-call`, holding one JSON object with `name` and `arguments`. The reply is scanned as it arrives: text is released as soon as it can be neither the start of a fence nor the start of a tool-call object, so a plain answer still streams. A closing fence counts only when the text before it parses as a JSON object, so a fence inside a string argument — a tool writing Markdown, say — does not end the block early.

A call written outside a `dsh-tool-call` block is never released as answer text. The agent loop ends a turn on a reply with no tool call, so releasing that JSON would end the turn and show the user a call that never ran. The scanner therefore holds back any JSON object that opens with `"name"` or `"arguments"`, together with a fence opener line directly above it, until the object closes, until its `name` turns out not to be a declared tool, or until it outgrows `toolCallMaxBytes`. An object that names a declared tool and carries an `arguments` member is read as an attempted call; every other object is released unchanged, so an answer that quotes a JSON example still reads as written. Whitespace at the start of a reply is held until other text follows it, so a reply that is one rejected call can still be replaced by a correction run.

An attempted call outside the fence is accepted in two forms while `toolCallLenient` is on, which is the default: a block opened with the info string `json` or with none, and a bare object followed by a closing fence, which is what a block looks like when only its opener line is missing. Either form is accepted only when the object has exactly the members `name` and `arguments`, names a declared tool, and carries object `arguments`, and an accepted call counts against `toolCallMaxCalls` like any other. The JSON is taken exactly as written, so this is not a repair. Every other attempted call — a bare object with no fence after it, a block under any other info string, an object with a further member — is rejected as `TOOL_CALL_UNFENCED`, as are both lenient forms when `toolCallLenient` is `false`. One written after an accepted call is discarded with the rest of the text there.

Model output is untrusted text, and every way a reply can break the contract has one named outcome:

| Code | The reply |
|---|---|
| `TOOL_CALL_TRUNCATED` | ended inside an unterminated block |
| `TOOL_CALL_MALFORMED` | closed a block whose contents are not one JSON object, named no tool, or gave non-object `arguments` |
| `TOOL_CALL_UNKNOWN_TOOL` | named a tool the request never declared |
| `TOOL_CALL_TOO_LARGE` | exceeded `toolCallMaxBytes` inside one block |
| `TOOL_CALL_LIMIT` | carried more blocks than `toolCallMaxCalls` |
| `TOOL_CALL_UNFENCED` | wrote a call to a declared tool outside a `dsh-tool-call` block, in a form lenient reading does not accept |

A rejection is answered by a correction run, up to `toolCallRetries` times: the request is sent again with a notice naming what was wrong, and the rejected reply never reaches the caller. That replacement is only possible before the first text or tool-call chunk is handed over; once the caller has seen output, a rejection is instead the terminal `finish` with that code. Either way a call is never dropped in silence, never invented, and never repaired.

Two things are deliberately *not* checked here. `arguments` are forwarded exactly as the model wrote them even when they break the tool's `parameters` schema: the Harness's tool layer owns schema conformance and already reports a violation to the model as a tool result, and duplicating that check would mean a second validator with its own disagreements. Text written *after* an accepted call is discarded rather than kept: the preamble forbids it and the model has no real result to describe, so it can only be invention. The discarded length is counted in the session record.

**Logging.** The preamble is model-visible input, so each CLI run of an emulated request appends one `llm/cli-tool-emulation` event *before* the run: the route, the model, the preamble template and its length, the declared tool names, the run's number, and — on a correction run — the verbatim notice it carries. The preamble text itself is not stored, because it is a pure function of the template and the request header's tool schemas, which the log already holds. A request that names a session the store cannot reach fails with `EMULATION_NOT_LOGGABLE` rather than emulating unlogged.

Each run whose reply was read appends one `llm/cli-tool-emulation-reply` event *after* the run, because none of its content is known earlier: the calls accepted, how many of those were accepted leniently, the characters discarded after an accepted call, and the rejection code when the reply was rejected. A run whose stream the caller abandoned, or whose child failed before a reply was read, has no such event.

<a id="further-exploration"></a>
## Further Exploration

- `@deepseek-ai/dsh-ai-account` and `@deepseek-ai/dsh-ai-account-platform` — the registered official-CLI configuration directories this route reads a path from.
- `@deepseek-ai/dsh-subagent-claude-code` — the other use of a Claude account, which delegates a whole task to Claude Code rather than using it as a model transport.
- `@deepseek-ai/dsh-llm` — the adapter seam, `StreamChunk`, and the disjoint `TokenUsage` accounting this adapter maps onto.
- [Tool calls emulated in the prompt](../../../.agents/notes/implemented/feature/2026-09-30-prompt-emulated-tool-calls-for-cli-transports.md) — why a CLI transport carries tool definitions as prompt text, and what that costs.
- [Vendor CLI as a model transport](../../../.agents/notes/implemented/feature/2026-09-30-vendor-cli-as-model-transport.md) — why the CLI is the transport instead of a lifted OAuth token, and why Codex and DeepSeek have no equivalent route.

<a id="model-experience"></a>
## Model Experience

### Text requests over the CLI transport

#### What the model sees

The Harness's own system prompt, substituted for Claude Code's through `--system-prompt`, and the Harness's messages as one user turn. The CLI's own tools are all switched off: `--tools ""` removes the built-ins and `--disallowedTools mcp__*` with `--strict-mcp-config` removes MCP tools. Requests carrying more than one message are rendered as a labelled transcript inside that single user turn, because the CLI supplies the assistant side of a conversation itself and ignores an injected assistant message. The CLI adds its own working-directory and git-branch line, which this route holds constant by running every child in one fixed empty directory.

#### Token effect

Replacing the CLI's default system prompt is a large reduction: measured against Claude Code 2.1.285, a request with the default prompt carried about 2,650 prompt tokens before any conversation, and the same request with `--system-prompt` carried about 440 from an empty directory.

#### KV Cache effect

Negative, and deliberately so. Claude Code caches its own default system prompt; substituting the Harness prompt discards that cache, and the measured requests above report no cache read or write at all. A conversation over this route therefore pays full prompt cost on every turn, which matters most for long multi-turn sessions and least for one-shot text requests.

### Tool-bearing requests over the CLI transport

#### What the model sees

Everything above, plus a `## Tool calls` section appended to the system prompt: the fixed contract for reporting a call, the two stated bounds, and one entry per declared tool carrying its `description` and its `parameters` schema as JSON. The model is told that the harness runs the tool and sends the real result back, that a rejected reply is returned with its reason, and that anything written after a block is discarded. On a correction run it also reads one `Harness:` paragraph at the end of the user turn naming what its previous reply got wrong.

#### Token effect

Measured against Claude Code 2.1.285 with `haiku`, as billed prompt tokens: the fixed contract text costs 289, and five realistic tool declarations cost 82 each on average (a three-property tool with descriptions is about 100; a two-property tool without them is about 67). A five-tool request therefore pays about 700 prompt tokens for its declarations, of which only the 289-token contract block is overhead a provider that accepted a `tools` field would not charge for. Each correction run repeats the whole request, and the abandoned run's own usage is not reported because its child is terminated as soon as the reply is rejected.

#### KV Cache effect

None gained and none lost beyond the text case: the preamble is part of the substituted system prompt, which the CLI does not cache. Because the preamble is a pure function of the declared tools, a conversation whose tool set does not change sends byte-identical prompt text every turn, so any provider-side prefix caching that does apply is not defeated by the emulation itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Tool calls depend on the model following prose.** Nothing constrains the reply: a fenced block is an instruction, not a decoder constraint, so a model that ignores the format costs a correction run and then the turn. Measured against Claude Code 2.1.285, `sonnet` produced a clean single block on every attempt while `haiku` sometimes wrapped one in stray `<function-calls>` tags — parsed correctly, but the stray text is kept as assistant text. Prefer a strong model on this route.
- **No parallel-tool guarantee.** `toolCallMaxCalls` bounds how many blocks one reply may carry, but nothing makes the model batch independent calls the way a native `tools` field does.
- **Streaming pauses at a fence and at a possible call object.** Text is released as soon as it cannot open a fence, so a plain answer streams; a reply that opens one shows nothing further until the block closes. A JSON object that opens with `"name"` or `"arguments"` pauses the stream until its `name` is complete and undeclared, or until the object closes.
- **An answer cannot quote a call to a declared tool.** A JSON object naming a declared tool with an `arguments` member is always read as an attempted call, so an answer that shows one as an example is rejected as `TOOL_CALL_UNFENCED`, or runs the tool when it is written in a form lenient reading accepts.
- **A rejected unfenced call after prose ends the turn with an error.** A correction run can only replace a reply nothing was handed over from. When prose was already streamed, an unfenced call that lenient reading does not accept is the terminal `TOOL_CALL_UNFENCED` failure: the raw JSON is withheld, and no tool runs.
- **`list_models` is undocumented.** The control request this catalog probe uses is not in Claude Code's published CLI reference. It is answered by 2.1.285 and may change without notice; an unreadable answer produces `CLI_CATALOG_UNAVAILABLE` rather than a crash, and `tests/real-cli.e2e.ts` detects a change on any machine with a signed-in CLI.
- **No image or file input.** The route advertises `text` only. Attachments reach it as the handle text request assembly already substituted.
- **No prompt caching.** See the KV Cache note above.
- **One process per request.** Each request spawns and tears down a CLI child, which costs process startup on every turn; `maxConcurrent` bounds how many run at once.
- **Concurrency against one configuration directory is untested by the vendor.** Claude Code's documentation makes no promise about parallel `--print` runs sharing a `CLAUDE_CONFIG_DIR`. This route gives every run its own `--session-id` and passes `--no-session-persistence`, and defaults `maxConcurrent` to 2.

<a id="dev-note"></a>
### Dev Note

`tests/real-cli.e2e.ts` runs the installed `claude` and self-skips when it is absent or signed out, so it is inert in CI. It is the only check that would notice the undocumented `list_models` control request changing, or a model stopping to follow the tool-call format; run it on a machine with a signed-in CLI after a Claude Code upgrade.

`tests/loader-composition.spec.ts` boots the package through the real Loader under the package name the Base Bundle row names, so a row that would not load in a shipped profile fails there rather than in a profile.

`tests/real-loop.e2e.ts` drives the production agent loop over the installed CLI with one real tool registered, so it is where a change to the preamble or the parser shows up as a turn that no longer completes. It self-skips the same way.

The unit tests script the CLI through `tests/harness.ts`, which answers by the question the argv asks rather than by spawn order, so adding a probe does not renumber a queue.
