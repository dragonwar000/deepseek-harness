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
| `toolCallRetries` | `1` | Correction runs allowed after a rejected reply that handed over no answer text yet. |
| `toolCallLenient` | `true` | Accept a call written in one of three near-miss forms instead of rejecting it; see [below](#tool-calls-in-the-prompt). `false` rejects them as `TOOL_CALL_UNFENCED`. |

`extraArgs` refuses `--bare`, `--betas`, `--append-system-prompt`, and the two permission-skipping flags at load: the first two would change how the CLI authenticates, and the rest would put text the Harness did not write in front of the model or let a tool run.

<a id="understand-the-implementation"></a>
## Understand the implementation

Every CLI invocation is planned by one pure module, `src/launch.ts`, so the exact argv and environment of a run are reviewable in one place.

**Inference** runs `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --tools "" --disallowedTools mcp__* --strict-mcp-config --setting-sources "" --disable-slash-commands --permission-prompts none --no-session-persistence --model <id> --session-id <uuid>`, plus `--system-prompt <text>` when the request carries one. `--tools ""` is the CLI's documented switch for disabling every built-in tool; MCP tools survive it, so they are denied separately.

**The model catalog comes from the CLI**, never from a vendor model API: one short-lived child receives a single `{"type":"control_request","request":{"subtype":"list_models"}}` line on stdin and its answer is read from stdout, after which the child is terminated. The catalog is cached per account directory and per launch fingerprint (executable, extra args, reported version) and is dropped when either changes.

**Authentication is a separate question**, asked first and only when the catalog must be probed. `list_models` answers successfully even against an unauthenticated configuration directory — it returns the list-priced catalog — so it cannot stand in for a login check. `claude auth status --json` is the check, and a signed-out directory produces a named `CLI_NOT_AUTHENTICATED` error naming where to sign in. The route also follows the AI Account provider's periodic status checks: while an `ai-account/status-changed` event reports the default Claude account `signedOut`, listing fails with that same error without spawning the CLI, and after the next event reports it `signedIn` the catalog is probed again. Each such event re-commits the route's registration, which publishes `llm/adapters-updated`, so the model picker re-lists the route without a restart. A default change clears the recorded answer, because the catalog probe asks the CLI about the new account itself.

**Nothing fails quietly.** `listModels()` throws rather than returning an empty list, because `buildModelCatalog` turns a throw into a `ModelCatalogFailure` the picker shows with its message, while an empty list would drop the provider group without a word. The named codes are `CLI_MISSING`, `CLI_NOT_AUTHENTICATED`, `CLI_CATALOG_UNAVAILABLE`, `UNKNOWN_MODEL`, `TOOL_CALLS_UNSUPPORTED`, `EMULATION_NOT_LOGGABLE`, and the `TOOL_CALL_*` rejections below.

**A failed run reports the CLI's own words.** The CLI ends a failed run with a `result` message whose `is_error` is set. When the run ended on an API error the message's `subtype` is still `success`, its `result` holds the CLI's text, its `api_error_status` holds the HTTP status when one exists, and the preceding synthetic `assistant` message carries an `error` kind. The terminal failure quotes that text as one line of at most 500 characters with terminal control sequences removed, and its code comes from the first matching row:

| The CLI reported | Code | Message |
|---|---|---|
| `error` kind `authentication_failed`, or `api_error_status` 401, or text containing `Not logged in` or `Please run /login` | `CLI_NOT_AUTHENTICATED` | The sign-in instruction `claude auth status` failures use, then `The CLI reported: <text>` |
| `error` kind `rate_limit`, or `api_error_status` 429 | `RATE_LIMIT` | `Claude Code CLI: <text>` |
| `error` kind `server_error` or `overloaded`, or `api_error_status` 500 or above | `SERVER` | `Claude Code CLI: <text>` |
| anything else, including `billing_error`, `model_not_found`, `invalid_request`, and the `error_*` subtypes | `PROVIDER` | `Claude Code CLI: <text>`, where an `error_*` subtype's text is its `errors` list |

A failed `result` with no text is named by its subtype, or as a failed run with no stated reason when the subtype is `success`. The default retry policy repeats `RATE_LIMIT` and `SERVER` and never repeats `CLI_NOT_AUTHENTICATED` or `PROVIDER`, because a signed-out account fails identically on every attempt. A run that ends with no `result` at all is `TRANSPORT`, with the CLI's stderr tail.

**Runtime invariants.** No runtime invariant companion is published: every relationship this package owns has exactly one observer, the catalog cache is read only through `ClaudeCliCatalog`, and an emulated reply is read only by the decoder that produced it, so no two independent observations can diverge. Behavior tests cover the probes, the parser, and the session record.

**Credentials.** The only environment entry this package sets is `CLAUDE_CONFIG_DIR`. Conflicting inherited variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` — are removed by the subprocess seam's own `SENSITIVE_ENV_PATTERN` scrub, not by a list maintained here.

**Attribution headers.** `LlmAdapter` requires every provider HTTP request to carry `attributionHeaders()`. This adapter sends no HTTP request: the CLI owns the connection. There is therefore nothing to attribute, and adding a first-party client identifier to a vendor endpoint is exactly what this design exists to avoid.

**System prompt.** A loop-built request leaves `GenerateOptions.system` undefined and carries its prompt as the leading system-role message instead. That message is hoisted into `--system-prompt`, so the Harness prompt replaces Claude Code's own rather than arriving as a labelled paragraph inside the user turn with the CLI's prompt still above it.

**Working directory.** Every child runs in one fixed, empty, non-repository directory. The CLI states its working directory and git branch to the model regardless of `--system-prompt`, and a constant empty directory keeps that statement constant and free of anything about the user's project.

<a id="tool-calls-in-the-prompt"></a>
## Tool calls in the prompt

A request that declares tools gets an extra section appended to its system prompt: the contract for reporting a call, and every declared tool with its `description` and the type of its `arguments`. The wording is fixed, pinned verbatim by a test, and identified by `PREAMBLE_TEMPLATE`, currently `dsh-tool-call/2`; it is not configurable, because it is what makes a reply parseable.

The type of a tool's `arguments` is rendered from its `parameters` JSON Schema by `src/arguments-type.ts` as one line per member: the name, `?` when it may be left out, its type, and its description after `//`. The notation states `type`, `properties`, `required`, `items`, `enum`, and one-line property descriptions, and nothing else. A schema that uses any other keyword, closes an object with `additionalProperties: false`, or describes something that has no member line is listed as its JSON Schema verbatim, so nothing is approximated. The preamble contains no fenced block except the `dsh-tool-call` example, so the only fence the model is shown is the one it must write.

To call a tool the model emits a fenced block whose info string is `dsh-tool-call`, holding one JSON object with `name` and `arguments`. The reply is scanned as it arrives: text is released as soon as it can be neither the start of a fence nor the start of a call in another syntax, so a plain answer still streams. A closing fence counts only when the text before it parses as a JSON object, so a fence inside a string argument — a tool writing Markdown, say — does not end the block early.

A call written in any other syntax is never released as answer text. The agent loop ends a turn on a reply with no tool call, so releasing it would end the turn and show the user a call that never ran. Two such syntaxes were recorded from `opus` and are recognized:

- **A JSON object outside the block.** The scanner holds back any JSON object that opens with `"name"` or `"arguments"`, together with a fence opener line directly above it. An object that names a declared tool and carries an `arguments` member is an attempted call; every other object is released unchanged, so an answer that quotes a JSON example still reads as written.
- **XML function-call syntax.** The scanner holds back an `<invoke name="…">` element, with or without the `antml:` namespace prefix and together with a `<function_calls>` tag directly before it, as read by `src/invoke-syntax.ts`. An element that names a declared tool is an attempted call; one that names any other tool is released unchanged, and so is any such tag inside a fenced code block, where an answer explaining the syntax writes it.

Held text is released or decided as soon as it closes, as soon as it turns out not to name a declared tool, or when it outgrows `toolCallMaxBytes`. Whitespace at the start of a reply is held until other text follows it, so a reply that is one rejected call can still be replaced by a correction run.

An attempted call is accepted in three forms while `toolCallLenient` is on, which is the default, and an accepted call counts against `toolCallMaxCalls` like any other:

- a block opened with the info string `json` or with none, holding an object with exactly the members `name` and `arguments` and object `arguments`;
- the same object bare and followed by a closing fence, which is what a block looks like when only its opener line is missing;
- a complete `<invoke>` element. A parameter body is raw text: it is kept verbatim, newlines and angle brackets included, for a parameter the tool's `parameters` schema declares as `string`, and parsed as JSON for one it declares as `number`, `integer`, `boolean`, `object`, or `array`. An element with a parameter the schema declares no such type for, a body that is not JSON of the declared type, or the same parameter twice is not accepted, because converting it would take a guess.

The JSON forms are taken exactly as written, so none of this is a repair. Every other attempted call is rejected by name, as are all three forms when `toolCallLenient` is `false`: one that closed is `TOOL_CALL_UNFENCED`, one the reply ended inside is `TOOL_CALL_TRUNCATED`, and one that outgrew `toolCallMaxBytes` without closing is `TOOL_CALL_TOO_LARGE`. The correction notice states the required block, and for XML it states that XML function-call syntax is not accepted on this route.

Model output is untrusted text, and every way a reply can break the contract has one named outcome:

| Code | The reply |
|---|---|
| `TOOL_CALL_TRUNCATED` | ended inside an unterminated block, or inside a call written in another syntax |
| `TOOL_CALL_MALFORMED` | closed a block whose contents are not one JSON object, named no tool, or gave non-object `arguments` |
| `TOOL_CALL_UNKNOWN_TOOL` | named a tool the request never declared |
| `TOOL_CALL_TOO_LARGE` | exceeded `toolCallMaxBytes` inside one block, or inside a call written in another syntax |
| `TOOL_CALL_LIMIT` | carried more blocks than `toolCallMaxCalls` |
| `TOOL_CALL_UNFENCED` | wrote a complete call to a declared tool as a JSON object outside the block or as XML, in a form lenient reading does not accept |

A rejection is answered by a correction run, up to `toolCallRetries` times: the request is sent again with a notice naming what was wrong, and the rejected reply never reaches the caller. That replacement is only possible before the first answer text is handed over; once the caller has seen text, a rejection is instead the terminal `finish` with that code. Tool calls do not count as handed over: a reply's calls are held until the reply ends, so a rejection later in the same reply replaces the whole reply and none of its calls run. Either way a call is never dropped in silence, never invented, and never repaired.

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

Everything above, plus a `## Tool calls` section appended to the system prompt: the fixed contract for reporting a call, the two stated bounds, and one entry per declared tool carrying its `description` and the type of its `arguments`, or its `parameters` JSON Schema when the type notation cannot state it. The model is told that the harness runs the tool and sends the real result back, that a rejected reply is returned with its reason, and that anything written after a block is discarded. On a correction run it also reads one `Harness:` paragraph at the end of the user turn naming what its previous reply got wrong.

#### Token effect

Measured against Claude Code 2.1.285 with `haiku`, as billed prompt tokens: the fixed contract text costs 385, and five tool declarations of two or three scalar properties cost 42 each on average. A five-tool request therefore pays about 595 prompt tokens for its declarations, of which only the 385-token contract block is overhead a provider that accepted a `tools` field would not charge for. The tool set of a real session is far larger, and most of it is the tools' own text. The 36 tools one recorded Desktop session declared cost 6,362 prompt tokens (26,275 characters), of which the tools' `description` strings alone are 13,185 characters that this route cannot shorten. `dsh-tool-call/1`, which listed each `parameters` schema as JSON inside a `json` fence, cost 7,397 tokens (30,430 characters) for the same 36 tools, 289 for the contract, and 72 for each of the same five small tools; the 27 tools the same session declared earlier went from 5,377 tokens (22,258 characters) to 4,524 (18,786). Each correction run repeats the whole request, and the abandoned run's own usage is not reported because its child is terminated as soon as the reply is rejected.

#### KV Cache effect

The small text requests above report no cache read or write, but a system prompt the size of a real tool set does: the 27-tool and 36-tool measurements report their whole prompt as `cache_creation_input_tokens`, and the recorded session reports cache reads on later turns. Because the preamble is a pure function of the declared tools, a conversation whose tool set does not change sends byte-identical prompt text every turn, so that prefix caching is not defeated by the emulation itself. A change of tool set, or of `PREAMBLE_TEMPLATE`, changes the prefix and misses the cache once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The preamble grows with the tool set, and tool descriptions dominate it.** A 36-tool session pays about 6,400 prompt tokens per request for its declarations. This route has no allowlist of tools to declare: a deployment shortens the preamble by composing fewer tools into the session.
- **Tool calls depend on the model following prose.** Nothing constrains the reply: a fenced block is an instruction, not a decoder constraint, so a model that ignores the format costs a correction run and then the turn. Measured against Claude Code 2.1.285, `sonnet` produced a clean single block on every attempt while `haiku` sometimes wrapped one in stray `<function-calls>` tags — parsed correctly, but the stray text is kept as assistant text. Prefer a strong model on this route.
- **No parallel-tool guarantee.** `toolCallMaxCalls` bounds how many blocks one reply may carry, but nothing makes the model batch independent calls the way a native `tools` field does.
- **Streaming pauses at a fence and at a possible call object.** Text is released as soon as it cannot open a fence, so a plain answer streams; a reply that opens one shows nothing further until the block closes. A JSON object that opens with `"name"` or `"arguments"` pauses the stream until its `name` is complete and undeclared, or until the object closes; an `<invoke>` tag pauses it until its tool name is complete and undeclared, or until the element closes.
- **An answer cannot quote a call to a declared tool.** A JSON object naming a declared tool with an `arguments` member, and an `<invoke>` element naming one outside a fenced code block, are always read as attempted calls. An answer that shows one as an example is rejected, or runs the tool when it is written in a form lenient reading accepts.
- **A rejected call after prose ends the turn with an error.** A correction run can only replace a reply no answer text was handed over from. When prose was already streamed, a call in another syntax that lenient reading does not accept, or that the reply ended inside, is a terminal failure: the raw JSON or XML is withheld, and no tool runs.
- **Tool calls appear when the reply ends.** A reply's calls are held until the reply ends so that a rejected reply runs none of them, which means a call card appears after the model has finished writing all of that reply's calls rather than as each one closes.
- **`list_models` is undocumented.** The control request this catalog probe uses is not in Claude Code's published CLI reference. It is answered by 2.1.285 and may change without notice; an unreadable answer produces `CLI_CATALOG_UNAVAILABLE` rather than a crash, and `tests/real-cli.e2e.ts` detects a change on any machine with a signed-in CLI.
- **Failure classification reads fields the CLI does not document.** `api_error_status` is marked internal in the CLI's own message schema, and the `error` kinds were read from Claude Code 2.1.285. A CLI that renames them leaves a failed run as `PROVIDER` with the CLI's text, except a signed-out run, which the text `Not logged in` still identifies. A subscription usage limit is reported as `rate_limit`, so the default retry policy repeats it although it cannot clear within the policy's delays.
- **No image or file input.** The route advertises `text` only. Attachments reach it as the handle text request assembly already substituted.
- **No prompt caching.** See the KV Cache note above.
- **One process per request.** Each request spawns and tears down a CLI child, which costs process startup on every turn; `maxConcurrent` bounds how many run at once.
- **Concurrency against one configuration directory is untested by the vendor.** Claude Code's documentation makes no promise about parallel `--print` runs sharing a `CLAUDE_CONFIG_DIR`. This route gives every run its own `--session-id` and passes `--no-session-persistence`, and defaults `maxConcurrent` to 2.

<a id="dev-note"></a>
### Dev Note

`tests/real-cli.e2e.ts` runs the installed `claude`. Its signed-in suite self-skips when the CLI is absent or signed out, so it is inert in CI; its signed-out suite needs only the executable and points it at an empty configuration directory it creates, so it reproduces the `CLI_NOT_AUTHENTICATED` failure without reading a real account. The signed-in suite is the only check that would notice the undocumented `list_models` control request changing, or a model stopping to follow the tool-call format; run it on a machine with a signed-in CLI after a Claude Code upgrade.

`tests/loader-composition.spec.ts` boots the package through the real Loader under the package name the Base Bundle row names, so a row that would not load in a shipped profile fails there rather than in a profile.

`tests/real-loop.e2e.ts` drives the production agent loop over the installed CLI with one real tool registered, so it is where a change to the preamble or the parser shows up as a turn that no longer completes. It self-skips the same way.

The unit tests script the CLI through `tests/harness.ts`, which answers by the question the argv asks rather than by spawn order, so adding a probe does not renumber a queue.
