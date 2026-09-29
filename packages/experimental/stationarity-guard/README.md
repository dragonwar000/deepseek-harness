---
description: "Remind or stop an agent whose tool steps keep returning identical results; shadow mode records the decisions without acting."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-stationarity-guard

English | [中文](README.zh.md)

## Summary

This package watches for an agent that keeps running the same tool calls and getting the same results. After each tool step it computes a signature of the step's calls and results, counts how often that signature has appeared since the last human message, and counts consecutive read-only steps that produced nothing new. In `enforce` mode it adds one reminder when a signature reaches its reminder threshold and ends the turn when a counter reaches its stop threshold; in `shadow` mode it only records what it would have done. It is experimental and carries no stability promise.

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

Mount the plugin in a composition that has the `tools` registry and an agent loop.

### When to choose it

Choose it when agents spend steps and tokens repeating tool calls whose results no longer change, including alternating patterns such as A, B, A, B that a consecutive-repeat detector misses. Start in `shadow` mode to measure how often the guard would act, then switch to `enforce`. Avoid it when a workflow legitimately polls a tool until its result changes, because unchanged polls count as repeats.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-stationarity-guard'
  config:
    mode: shadow
    assumption: the model repeats tool calls that return identical results
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records decisions only; `enforce` reminds and stops |
| `assumption` | required outside `off` | The assumption about the model that this guard encodes; a blank value fails the load |
| `remindAt.sideEffect` / `remindAt.readOnly` | `4` / `8` | Occurrences of one step signature that add one reminder |
| `stopAt.sideEffect` / `stopAt.readOnly` | `8` / `12` | Occurrences of one step signature that stop the turn |
| `noopStopAt` | `4` | Consecutive read-only steps without a new call/result pair that stop the turn |

Loading fails with a `stationarity-guard:` error when `assumption` is blank, when a threshold is not an integer of at least 2, or when a tier's `remindAt` is not below its `stopAt`.

### What you get

At the step boundary after a tool step that reaches a threshold, the guard appends one `loop/stationarity` session event with the judged turn and step, the mode, the step signature, the tier (`sideEffect` or `readOnly`), the signature's occurrence count, the read-only no-progress run, the action (`remind` or `stop`), the reason (`repeat` or `noop`), and whether the guard acted. In `enforce` mode a `remind` adds a `notice`-form user message whose source kind is `stationarity-guard` to the next step's input, and a `stop` rejects the next step, so the turn ends with `turn/end` reason `blocked` and an active session goal is blocked with code `stationary`. A new human message resets every count.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A `session/event` listener folds `step/start`, `tool/call`, `tool/result`, and `step/end` from the session log into one batch per completed step that made tool calls; it keeps the fold in a `WeakMap<Session, SessionFold>` and never appends. An `agent/pre-step` listener judges the pending batch at the next step boundary: it classifies the tier, updates the signature counts and the evidence ledger, appends `loop/stationarity` when a threshold is reached, and then either calls `next()`, appends the reminder to the downstream `enter` decision, or returns `{ kind: 'reject' }`.

### Design notes

- **One signature covers calls and evidence.** The signature is the sha256 of the step's sorted (tool name, key-sorted arguments, result hash) triples, so reordering parallel calls is not progress, and an edit-then-test cycle whose test output changes is not counted as a repeat.
- **Repeats are not required to be adjacent.** Counts accumulate per signature since the last human message, so an A, B, A, B pattern reaches the thresholds.
- **The tier comes from the tool registry.** A step is `readOnly` only when `ctx.tools.executionMode()` returns `parallel` for every call; any exclusive call makes it `sideEffect`.
- **The fold reads the log, not the tool pipeline.** `tools/result` carries no turn or step, so the guard reads `tool/call`, `tool/result`, and `step/end` session events instead.
- **A stop is a rejected step.** Rejecting `agent/pre-step` makes agent-loop end the turn `blocked`; the guard also blocks an active goal with code `stationary` and adds no new turn-end reason.
- **Only human input resets.** A step whose input contains a message with source kind `user` clears every count; goal rounds, steers, and the guard's own reminder do not.
- **The reminder never names a way to disable the guard.**
- **Successor to `repeat-tool-reminder` in `enforce` mode.** A composition keeps `@deepseek-ai/dsh-repeat-tool-reminder` running while this guard is in `shadow` mode, and disables it in the same profile patch that switches this guard to `enforce`.
- **Invariant companion.** `./invariant` checks that after an applied `stop` the session's next `step/start` or `turn/end` is a `turn/end` with reason `blocked`, `aborted`, or `error`. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, session-event fold, pre-step listener |
| [`src/types.ts`](src/types.ts) | `loop/stationarity` session-event declaration and its payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for applied stops and the turn end that follows |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem reference](../../../docs/subsystems/core.md) — the `agent/pre-step` and `session/event` events this guard consumes.
- [Tools package](../../core/tools/README.md) — `executionMode()` and the concurrency-safety classification behind the tier.
- [Goal package](../../goal/goal/README.md) — the goal lifecycle the guard blocks on a stop.
- [Repeat-tool-reminder package](../../guard/repeat-tool-reminder/README.md) — the consecutive-repeat reminder this guard replaces in `enforce` mode.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Reminder after a repeated step

#### What the model sees

In `enforce` mode only, at the step boundary after a step whose signature reached `remindAt` for its tier, the model receives a `notice`-form user message appended to that step's input:

##### Verbatim text for this field

```markdown
Stationarity check: this exact set of tool calls has now returned identical results <repeats> times since the last user message.
Repeating it will not produce new information. Inspect the latest results, then take a different action or finish with the evidence you already have.
```

#### Token effect

Zero tokens in `shadow` mode and for steps below `remindAt`. Each reminder adds one retained message of about 60 tokens. A stop sends nothing: the step is rejected and the turn ends.

#### KV Cache effect

Append-only: the reminder joins the new step's trailing user input after the reusable request prefix; nothing earlier changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Counts are in memory** — a resumed session starts counting again from zero.
- **Sub-dispatches inside `run_code` are not folded** — only root `tool/call` events enter the signature; PTC sub-dispatches are logged as `tool/ptc-dispatch` and are not counted.
- **Two repeat detectors while in `shadow`** — `repeat-tool-reminder` still reminds and `stationarity-guard` only records `loop/stationarity`; switching this guard to `enforce` without disabling the reminder can give the model two reminders for the same loop.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
