---
description: "Run verify commands such as a test suite before an agent turn may end, and steer the model back to work when one fails; shadow mode records verdicts without steering."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-verifier-gate

English | [中文](README.zh.md)

## Summary

This package checks the agent's work before a turn ends. It runs the verify commands you configure, such as a test suite, and records each decision in the session log. In `enforce` mode a failing command sends the model back to work with the command and its output tail, up to a per-turn limit; in `shadow` mode the gate only records what it would have done. Every check costs one shell run per turn boundary. It is experimental and carries no stability promise.

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

Mount the plugin after a `shell` provider in a composition and list the commands that must pass before a turn may end.

### When to choose it

Choose it when a deterministic command can tell whether the agent's work is done and the model tends to declare completion early. Start in `shadow` mode to measure how often the gate would object, then switch to `enforce`. Avoid it when no fast, deterministic check exists, because every turn boundary runs every command until one fails.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-verifier-gate'
  config:
    mode: shadow
    assumption: the model declares a task done before its tests pass
    verify:
      commands: [pnpm test]
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records verdicts only; `enforce` also steers after a failed command |
| `assumption` | required outside `off` | The assumption about the model that this gate encodes; a blank value fails the load |
| `verify.commands` | `[]` | Commands run in order at every turn boundary; the first failing command stops the run |
| `verify.timeoutMs` | `300000` | Per-command timeout handed to the shell provider |
| `verify.stdoutTailChars` | `2000` | Characters of the stdout and stderr tail kept in the verdict and the steer |
| `maxContinuations` | `8` | Steers per turn before the gate records `budget-exhausted` and lets the turn end |

Loading fails with a `verifier-gate:` error when `assumption` is blank, when `maxContinuations` is not an integer at or above 0, when `verify.timeoutMs` or `verify.stdoutTailChars` is not an integer at or above 1, or when `verify.commands` is non-empty and no `shell` service is mounted.

### What you get

Each turn boundary appends one `loop/verdict` session event with the turn number, mode, verdict (`ok`, `not-ok`, or `skipped`), reason (`all-passed`, `command-failed`, `budget-exhausted`, or `no-commands`), the checks that ran with their exit codes and output tails, the continuations already spent in the turn, and whether this decision steered the agent. In `enforce` mode a `not-ok` verdict with budget left steers the agent with a `notice`-form user message whose source kind is `verifier-gate`; the next step runs, and the gate judges the new boundary. A new human message resets the per-turn budget.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The gate listens on `agent/turn-stopping`, which agent-loop awaits only after a completed step when no steering is pending. It runs the configured commands through `ShellExecutor.resolve()` and `execute()` with the turn's abort signal, appends `loop/verdict`, and calls `agent.steer()` when it objects. The loop then re-reads its inbox and runs another step. The per-turn continuation counter lives in a `WeakMap<Agent, Budget>` keyed by turn number; an `agent/pre-step` listener drops it when the step admits a message whose source kind is `user`.

### Design notes

- **No failed-step guard.** A step that throws closes the turn with `turn/end` reason `error` before `agent/turn-stopping` runs, so the gate never judges a failed step.
- **No fail-open.** A failing, timed-out, or signal-killed command is `not-ok`. A shell infrastructure failure or a `shell` service that disappeared after load rejects the listener and ends the turn with reason `error`.
- **The steer never names a way to disable the gate.** It names the failing command, its exit status, and the output tail.
- **Verdicts are log-only.** `loop/verdict` is declared in `SessionEventMap`, required on read, and never enters derived history; only the steer message is model-visible.
- **Invariant companion.** `./invariant` checks that every `loop/verdict` with `continued: true` is followed by a `verifier-gate` user message before its turn ends `completed` or `max-tokens`; aborted, errored, and blocked turns may discard pending steering. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, turn-stopping and pre-step listeners |
| [`src/types.ts`](src/types.ts) | `loop/verdict` session-event declaration and its payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for continued verdicts and their steers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem reference](../../../docs/subsystems/core.md) — the `agent/turn-stopping` and `agent/pre-step` events this gate consumes.
- [Shell package](../../shell/shell/README.md) — the executor contract that runs verify commands.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### Steer after a red verify command

#### What the model sees

In `enforce` mode only, after a failed verify command and at most `maxContinuations` times per turn, the model receives a `notice`-form user message with the text below. `<exit>` is the exit code or `signal`; `, timed out` appears only when the executor's deadline cut the command short.

##### Verbatim text for this field

```markdown
verify command failed (exit <exit>[, timed out]): <command>
Output tail:
<last stdoutTailChars characters of stdout, a newline, and stderr>
Fix the cause, rerun the failing check yourself, and only then finish.
```

#### Token effect

Zero tokens when every check passes, in `shadow` mode, and after the budget is exhausted. Each steer adds one retained message bounded by `stdoutTailChars` plus the command and about 120 characters of fixed text.

#### KV Cache effect

Append-only: the steer is a new trailing user message after the reusable request prefix, and the gate changes no earlier request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **No evidence check** — claims in the final assistant message are not compared against tool results; only the configured commands decide.
- **Budget exhaustion ends the turn normally** — after `budget-exhausted` the turn ends `completed`; the gate does not block a session goal.
- **No sandbox of its own** — verify commands run under whatever policy the mounted `shell` provider applies.
- **Budget is in memory** — a resumed session starts with a fresh continuation counter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
