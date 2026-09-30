# Agent Note: Tool Calls Emulated in the Prompt for a CLI Transport

Status: implemented

## Problem

[Using a vendor CLI as the model transport](2026-09-30-vendor-cli-as-model-transport.md) gave a Claude subscription a model route inside the Harness without any token leaving the CLI. It could not serve a chat turn. Claude Code exposes no way to pass caller-supplied tool definitions and no mode that reports a tool call without executing it, so the route refused any request carrying `GenerateOptions.tools` — and nearly every real turn carries them, including compaction. The picker entry existed and could not answer the first message a user sent it.

Three mechanisms could close that gap, and only one keeps the loop in `agent-loop`: giving the CLI the Harness's tools over MCP moves iteration and the stop decision into Claude Code; lifting the CLI's OAuth grant and calling the vendor API takes on every risk the earlier decision refused; carrying the tool definitions as prompt text keeps the Harness's loop, guards, approvals, and compaction and asks only that the model report a call as text.

## Decision

**A CLI transport carries the request's tool definitions in the system prompt and parses the model's textual call back into a real `tool-call` block.** `@deepseek-ai/dsh-llm-claude-cli` does this under `toolCalls: 'prompt'`, which is the default; `'refuse'` keeps the earlier behavior for a deployment that wants it. The Base Bundle row stays `disabled: true`, so nothing changes for a user who does not opt in.

`src/emulate.ts` owns the mechanism. The preamble is one fixed block of text — the contract for reporting a call, the two bounds the route will enforce, and one entry per declared tool with its `description` and `parameters` schema — identified by `PREAMBLE_TEMPLATE` and pinned verbatim by a test. It is not a tunable: its wording is what makes a reply parseable. The bounds and the retry budget *are* `Config` fields, because how many calls a reply may carry, how large a call may be, and how many correction runs a deployment will pay for are deployment choices.

Four consequences were load-bearing enough to design around rather than discover.

**A reply is untrusted text, so every way it can break the contract has one named outcome.** `TOOL_CALL_TRUNCATED`, `TOOL_CALL_MALFORMED`, `TOOL_CALL_UNKNOWN_TOOL`, `TOOL_CALL_TOO_LARGE`, and `TOOL_CALL_LIMIT` each name what the reply did and what a corrected one must do. A call is never dropped in silence, never invented, and never repaired. A rejection is answered by up to `toolCallRetries` correction runs, which resend the request with a notice naming the fault; that replacement is possible only before the first text or tool-call chunk has been handed over, because after that the caller has seen output a second run would contradict, and the rejection becomes the terminal `finish`.

**The preamble is a new model-visible input, so it is logged.** Each CLI run of an emulated request appends one `llm/cli-tool-emulation` event *before* the run: route, model, template identity, preamble length, declared tool names, the run's number, and the verbatim correction notice a retry carries. The preamble text is not stored, because it is a pure function of the template and the request header's tool schemas, which the log already holds. A request naming a session the store cannot reach fails with `EMULATION_NOT_LOGGABLE` rather than emulating unlogged. The event is a new root and needed no `SESSION_FORMAT_VERSION` change.

**Schema conformance stays with the tool layer.** Structure is checked at this boundary — JSON object, a declared tool name, object `arguments`, the size and count bounds — but `arguments` that break a tool's `parameters` schema are forwarded exactly as written. The Harness's tool layer already validates them and reports a violation to the model as a tool result, which is the same correction path every other provider uses; a second validator here would be a second set of disagreements and would couple a model adapter to the tool runtime.

**Text after an accepted call is discarded, and the loop's system prompt is hoisted.** A model with no way to yield keeps writing after its call and invents the result; the preamble forbids it and the route drops it, recording the dropped length. Separately, a loop-built request leaves `GenerateOptions.system` undefined and carries its prompt as the leading system-role message, so that message is hoisted into `--system-prompt`: without the hoist the Harness prompt would arrive as a labelled paragraph inside the user turn while Claude Code's own prompt stayed in force above it.

## Alternatives considered

**Constrain the reply with the CLI's `--json-schema` structured output.** A schema for `{text, tool_calls[]}` would make the reply valid JSON by construction. Measured and rejected: against Claude Code 2.1.285 the same request went from 1,100 to 9,015 prompt tokens over five internal turns, because the CLI satisfies the schema by running its own tool loop, and the model then reported that no tools were available to it.

**Stop sequences at the closing fence.** They would end generation instead of discarding invented text. The CLI exposes no stop-sequence flag.

**Buffer the whole reply so any rejection can be retried.** It would make a correction run possible in every case, not only before the first chunk. Rejected: an emulated turn is every agent turn, so buffering would remove incremental streaming from chat permanently to protect a path the measured models rarely take.

**Terminate the child as soon as the last call closes.** It would stop paying for the invented continuation. Rejected: the CLI reports usage and the stop reason only in its terminal `result` message, so this would trade exact token accounting for a few output tokens.

**Validate `arguments` against the tool schema here and retry.** Rejected above: it duplicates the repository's one JSON-Schema validator and would make a model adapter depend on the tool runtime and its peers.

## Consequences

A Claude subscription can serve the main chat model. The Harness keeps its loop, its guards, its approvals, and its compaction, and a tool-bearing turn completes: against the installed CLI, `sonnet` reads `/etc/hosts` through a real `read_file` call and then answers from the tool result it is handed.

It costs prompt tokens and it depends on the model's obedience. Measured with `haiku`, the fixed contract text is 289 billed prompt tokens and five realistic tool declarations are about 82 each; only the contract block is overhead a provider accepting a `tools` field would not charge for. Nothing constrains the reply, so a weak model is a real failure mode: `haiku` sometimes wraps a correct block in stray `<function-calls>` tags, which parse but survive as assistant text, while `sonnet` was clean on every attempt. The route is worth enabling with a strong model and not with a weak one.

Streaming pauses at a fence: text is released as soon as it cannot open one, so a plain answer streams, but a reply that opens a fence shows nothing more until the block closes. A correction run repeats the whole request, and the abandoned run's token usage is not reported because its child is terminated the moment the reply is rejected — the session log records that the run happened.

Nothing changes for a user who does not opt in: the row still ships disabled, and enabling it is one id-targeted override.
