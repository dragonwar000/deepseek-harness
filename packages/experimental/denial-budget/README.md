---
description: "Count policy-denied tool calls, append fixed safer-approach advice, and ask for approval before an agent continues past a denial budget; shadow mode only records."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-denial-budget

English | [中文](README.zh.md)

## Summary

This package counts tool calls that a policy denied: a guard, a `tools/pre-execute` deny, or an approval that was not granted. In `enforce` mode it adds one fixed sentence to each denied result that tells the model to take a safer approach, and when the denials reach a configured budget it asks for human approval before the agent may continue; without a grant the turn ends `blocked` and an active goal is blocked. In `shadow` mode it only records what it would have done. Each count and decision is a session event. It is experimental and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a composition that has tool policies: guards, `tools/pre-execute` listeners, or approval-gated tools. Mount `@deepseek-ai/dsh-user-approval` with an answerer when a human should decide whether the agent continues past the budget.

### When to choose it

Choose it when the model keeps retrying actions that a policy denies instead of changing its approach. Start in `shadow` mode to measure how often the budget would trip, then switch to `enforce`. Avoid `enforce` in a headless deployment where denials are expected and harmless, because without an approval answerer every trip ends the turn.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-denial-budget'
  config:
    mode: shadow
    assumption: the model retries denied actions instead of changing approach
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records only; `enforce` appends advice, asks for approval, and stops |
| `assumption` | required outside `off` | The assumption about the model that this budget encodes; a blank value fails the load |
| `maxConsecutive` | `3` | Denied calls in a row that trip the budget |
| `maxTotal` | `20` | Denied calls since the last human message that trip the budget |

Loading fails with a `denial-budget:` error when `assumption` is blank or a count is not an integer of at least 1.

### What you get

Each denied call appends one `loop/denial` session event with decision `counted`, the turn, the mode, the denied tool name and call id, the consecutive count, and the total count. An allowed call resets the consecutive count; a new human message resets both counts. When either count reaches its limit, the next step boundary records one more `loop/denial`. In `enforce` mode the plugin first calls `ctx.approval.request()`: `allowed-once` records `approved`, resets the counts, and lets the step run; any other outcome records `stopped` with that outcome, rejects the step so the turn ends `blocked`, and blocks an active goal with code `denial-budget`. In `shadow` mode the plugin records `stopped` with `applied: false`, resets the counts, and lets the step run.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The registry turns every policy denial into a failed result that reaches `tools/post-execute` and `tools/result` without entering `tools/execute`. The plugin marks each execution that enters its `tools/execute` listener in a `WeakSet`, and treats a failed result as a denial when its execution was never marked and its error code is not `ABORTED_BEFORE_DISPATCH`. Counts live in a `WeakMap<Session, DenialCount>`; a `session/event` listener records the current turn from `turn/start`. The budget decision runs in `agent/pre-step`, the only point where a plugin can end a turn without cancelling it.

### Design notes

- **What counts as a denial.** A `tools/pre-execute` deny, an `ask` that approval did not grant (`rejected`, `cancelled` by the answerer, `unavailable`, or no approval service), and a `ToolGuard` reason all count. A failed tool body, an unknown tool reached through dispatch, a post-execute block of a dispatched call, and a pre-dispatch cancellation do not count. Calls without an agent are ignored.
- **Counted at `tools/result`.** `tools/result` is an emit event that every listener receives. A `tools/pre-execute` listener could not see guard denials, approval outcomes, or denials from listeners ahead of it that do not call `next()`.
- **Advice keeps the original reason.** In `enforce` mode the post-execute listener appends the fixed sentence after the registry's `Error: <reason>` text, so the model still learns what was denied. The sentence never names a way to disable the policy or the budget. A downstream post-execute `block` of a denial is left unchanged.
- **Always ask at a trip.** There is no headless flag; approval fails closed. No mounted approval service, or a service with no answerer, yields `unavailable`, which stops the turn.
- **Records are log-only.** `loop/denial` is declared in `SessionEventMap`, required on read, and never enters derived history; only the appended advice is model-visible, as part of the ordinary tool result.
- **Invariant companion.** `./invariant` checks that every `loop/denial` with decision `approved` follows an `approval/decided` event with outcome `allowed-once` recorded after the session's latest `counted` denial. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, tool pipeline and pre-step listeners, `DENIAL_ADVICE` |
| [`src/types.ts`](src/types.ts) | `loop/denial` session-event declaration and its payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for approved decisions and their approval audit |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem reference](../../../docs/subsystems/core.md) — the `tools/*` pipeline and `agent/pre-step` events this budget consumes.
- [User approval package](../../interaction/user-approval/README.md) — the approval seam that decides whether the agent continues past the budget.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Advice on a denied tool call

#### What the model sees

In `enforce` mode only, every tool result that a policy stage denied keeps its original `Error: <reason>` text and gains one more text block:

##### Verbatim text for this field

```markdown
Take a safer approach; do not retry this exact action or work around the denial.
```

#### Token effect

About 20 tokens per denied call in `enforce` mode; zero in `shadow` mode. A trip adds nothing model-visible: the approval question goes to the human answerer, and a stop rejects the step.

#### KV Cache effect

Append-only: the advice is part of a new tool result after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Counts are in memory** — a resumed session starts counting from zero.
- **Approval question is tool-scoped** — `@deepseek-ai/dsh-user-approval` asks about one tool, so the escalation question names the most recent denied tool and call in `approval/asked`, not the continuation of the turn. A continuation-scoped approval request needs a change to the release approval package.
- **Sub-dispatch denials inside `run_code` count** — nested calls carry the parent's agent, so their denials count toward the same budget.
- **Failures before the policy pipeline count without advice** — a call that fails before `tools/pre-execute` runs, such as a direct call to a tool that the `ptc` presentation mode reserves for `run_code`, counts as a denial but skips `tools/post-execute`, so its result carries no advice.
- **An around-dispatch wrapper can hide a dispatch** — a `tools/execute` listener ahead of this plugin that returns a failed result without calling `next()` makes that call count as a denial.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
