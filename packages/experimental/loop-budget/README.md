---
description: "Per-turn and per-goal step, token, USD, and wall-time budgets that stop the turn and pause the goal, plus an optional work floor; shadow mode only records."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loop-budget

English | [中文](README.zh.md)

## Summary

This package bounds one turn and one active goal: started steps, provider-reported tokens, their USD cost through a configured price table, and wall time, recording the first exhausted limit as a `loop/budget` event. In `enforce` mode a turn limit rejects the next step (turn ends `blocked`); a goal limit pauses the goal, or completes it when the latest `loop/verdict` was `ok` with no step since. An optional work floor steers the model once per turn short of a configured minimum. `shadow` mode only records what it would have done. Experimental; no stability promise.

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

Mount the plugin in a composition and set `turn`, `goal`, or `floor` limits; set `prices` when any `maxUsd` limit is above 0.

### When to choose it

Choose it when a turn or goal can run away in steps, tokens, spend, or wall time without a deterministic stopping signal, or when a turn tends to end with too little work done. Start in `shadow` mode to measure trips before switching to `enforce`. A goal limit needs `@deepseek-ai/dsh-goal` mounted; goal completion additionally needs `@deepseek-ai/dsh-experimental-verifier-gate` mounted and reporting `loop/verdict`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-loop-budget'
  config:
    mode: shadow
    assumption: the model does not stop spending on a turn or goal by itself
    turn: { maxSteps: 64 }
    goal: { maxUsd: 5 }
    prices:
      - { provider: deepseek, model: deepseek-chat, inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 }
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records only; `enforce` rejects the step, pauses or completes the goal, and steers for the floor |
| `assumption` | required outside `off` | The assumption about the model that this budget encodes; a blank value fails the load |
| `turn.maxSteps` / `maxTokens` / `maxUsd` | `0` (off) | Limits reset at every turn start |
| `turn.maxWallMs` | `900000` (15 min) | Wall-clock limit of one turn, reset at every turn start; set `0` to turn it off |
| `goal.maxSteps` / `maxTokens` / `maxUsd` | `0` (off) | Limits that accumulate while one goal stays active; a resumed goal starts a fresh accumulator |
| `goal.maxWallMs` | `3600000` (1 h) | Wall-clock limit that accumulates while one goal stays active; set `0` to turn it off |
| `floor.minSteps` / `floor.minTokens` | `0` (off) | Work a turn must reach before it ends; one steer per turn |
| `prices[]` | `[]` | USD per million tokens per exact `provider`/`model`; required when any `maxUsd` is above 0 |

Loading fails with a `loop-budget:` error when `assumption` is blank, a count is not a non-negative integer, an amount is negative or not finite, two price rows name the same route, or a `maxUsd` is set with no `prices`. A turn fails with the same prefix when a priced limit meets a route that has no price row.

### What you get

At every step boundary the plugin checks the turn's accumulators, then the active goal's accumulators when one is tracked, and records the first exhausted limit once per `(scope, turn or goal, kind)` as a `loop/budget` session event carrying the turn, the proposed step, the mode, the scope (`turn` or `goal`), the kind (`steps`, `tokens`, `usd`, or `wallMs`), the amount used, the configured limit, the action (`stopped`, `paused`, `completed`, or `floor-steer`), whether the plugin acted, the session's `root`/`subagent` attribution, and the tracked goal id when there is one. In `enforce` mode a trip rejects the proposed step, which ends the turn `blocked`; a goal-scoped trip pauses the active goal instead, unless the latest `loop/verdict` was `ok` with no step started since, in which case it completes the goal — and a goal-scoped trip never rejects a step that admits a human message. When `floor.minSteps` or `floor.minTokens` is set and no other listener already steered at that turn's stop boundary, a turn about to end below the floor gets one work-floor steer instead of ending.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin folds `turn/start`, `step/start`, `assistant/message`, `assistant/attempt`, and `loop/verdict` session events into a per-session accumulator in a `WeakMap<Session, SessionBudget>`. Steps come from the loop's own step numbering (`step - 1` at `agent/pre-step`, the last started step at `agent/turn-stopping`); tokens and USD come from the `usage` chunk of every settled model stream, including a failed `assistant/attempt`, priced through the exact `provider`/`model` route in `request/header`; wall time comes from the turn's start time or from when the active goal was first tracked. `agent/pre-step` checks the accumulators before every step and, on a trip, rejects the step in `enforce` mode; `agent/turn-stopping` checks the work floor and steers when short.

### Design notes

- **Verdict precedes budget.** A goal-scoped trip completes the goal instead of pausing it exactly when the latest `loop/verdict` was `ok` and no step has started since — the gate's judgement is more current than the budget's.
- **A goal limit never blocks a human.** A trip whose scope is `goal` still admits a step that carries a message whose source kind is `user`; only a `turn` limit rejects unconditionally.
- **No token-meter reuse.** `ctx.tokenMeter` measures request-shaping pressure for the next call, not spend; this plugin reads the `usage` chunk of every settled stream instead, because a failed attempt still spends tokens.
- **No built-in price table.** dsh has no USD pricing of its own; `prices[]` is deployment-declared configuration, validated at load, and a priced limit with an unmatched route fails the turn loud at the earliest point (the next `agent/pre-step`).
- **The floor yields to other steering.** It checks `agent.inbox.nextStep` before steering so it never fights another listener (such as `verifier-gate`) that already objected at the same boundary; a composition orders `verifier-gate` before `loop-budget`.
- **Accumulators are per-process state, not derived history.** `loop/budget` is log-only and declared required-on-read in `SessionEventMap`; only a floor steer (a separate `user/message` event) is model-visible.
- **Invariant companion.** `./invariant` checks that every turn-scoped `loop/budget` of kind `steps` reports exactly the number of `step/start` events its turn has logged so far. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, accumulator fold, pre-step and turn-stopping listeners |
| [`src/types.ts`](src/types.ts) | `loop/budget` session-event declaration and its payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for turn-scoped step counts |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem reference](../../../docs/subsystems/core.md) — the `agent/pre-step` and `agent/turn-stopping` events this budget consumes.
- [Goal package](../../goal/goal/README.md) — the `pause`/`complete` operations a goal limit drives.
- [Verifier gate](../verifier-gate/README.md) — the `loop/verdict` event that decides `paused` versus `completed`.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Work-floor steer

#### What the model sees

In `enforce` mode only, at most once per turn, when the turn is about to end below `floor.minSteps` or `floor.minTokens` and no other listener steered at that boundary, the model receives a `notice`-form user message:

##### Verbatim text for this field

```markdown
Work floor not reached for this turn: <used> of <limit> <steps|tokens>.
Before finishing, do adjacent useful work on the same request, such as verifying the change or covering a case you have not checked, then finish.
```

#### Token effect

Zero tokens when no floor is configured, in `shadow` mode, and for every limit trip (a trip rejects the step and sends nothing). Each floor steer adds one retained message of about 45 tokens.

#### KV Cache effect

Append-only: the steer is a new trailing user message after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Accumulators are in memory** — a resumed session starts every accumulator over, and a goal's wall-time limit measures from when this process first saw the goal active, not from the goal's original creation.
- **USD needs a price table** — dsh has no built-in provider pricing; every priced route must appear in `prices[]`.
- **Goal completion relies on `verifier-gate`** — without a mounted verifier reporting `loop/verdict`, a goal limit never completes the goal, only pauses it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
