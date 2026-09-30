---
description: "Run verify commands such as a test suite before an agent turn may end, and steer the model back to work when one fails; shadow mode records verdicts without steering."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-verifier-gate

English | [中文](README.zh.md)

## Summary

This package checks the agent's work before a turn ends. It runs the verify commands you configure, such as a test suite, and records each decision in the session log. In `enforce` mode a failing command sends the model back to work with the command and its output tail, up to a per-turn limit; in `shadow` mode the gate only records what it would have done. Each check costs one shell run per turn boundary. An opt-in evidence check compares the paths and commands the final answer names with the turn's tool records. It is experimental.

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
| `blankResponse.maxSteers` | `1` | Steers per turn after a response with no tool call and no visible text (reasoning only, or empty text); `0` turns the check off. Each steer also spends one continuation |
| `evaluator.enabled` | `false` | Start a fresh evaluator after the verify commands pass |
| `evaluator.provider` | `spawn` | `ctx.subagents` provider for evaluator children; it must start children without the parent conversation and support structured output, tool scoping, and personas |
| `evaluator.rubric` | `[]` | Fixed criteria `c1`, `c2`, …; empty lets the first evaluator of a turn write criteria, which then stay frozen for that turn |
| `evaluator.tools` | `[]` | Global tools the evaluator may call; list read-only tools only |
| `evaluator.persona` | a strict-reviewer sentence | Persona that replaces the deployment persona for the evaluator child |
| `evaluator.maxOutputTokens` | unset | Output-token cap per evaluator request; needs the provider's `agentOptions` capability |
| `evaluator.maxRounds` | `3` | Evaluator rounds per turn |
| `evaluator.timeoutMs` | `300000` | Wall-clock limit per evaluator run; expiry cancels the child |
| `evaluator.maxSpecChars` | `4000` | Characters of the human request and of the goal objective quoted to the evaluator |
| `evaluator.maxFeedbackChars` | `2000` | Characters of the evaluator reason kept in the verdict and the steer |
| `evaluator.count` | `1` | Independent evaluators per round, run one after another; above 1 needs `evaluator.rubric` |
| `evaluator.maxRuns` | `3` | With `count` above 1, the ceiling on evaluator runs per turn; loading fails when `count × maxRounds` exceeds it |
| `evaluator.seed` | `0` | Seed of each evaluator's order of criteria and verify results when `count` is above 1 |
| `evidence.mode` | `off` | `off` skips the evidence check; `shadow` records it on every verdict after the verify commands pass; `enforce` also steers an unsupported answer and needs `mode: enforce` |
| `evidence.require` | `every` | `every`: each claim needs a record of the turn; `any`: at least one claim does |
| `evidence.maxClaims` | `32` | Claims of the final answer recorded and checked, in answer order |
| `maxContinuations` | `8` | Steers per turn before the gate records `budget-exhausted` and lets the turn end |

Loading fails with a `verifier-gate:` error when `assumption` is blank, when `maxContinuations` is not an integer at or above 0, when `verify.timeoutMs` or `verify.stdoutTailChars` is not an integer at or above 1, when `verify.commands` is non-empty and no `shell` service is mounted, when `evidence.maxClaims` is not an integer at or above 1, when `evidence.mode` is `enforce` and `mode` is not, or when `evidence.mode` is not `off` and no `sessionProjections` service is mounted.

Loading also fails when an `evaluator` number is not an integer at or above 1, when an `evaluator.rubric` line is blank, or, with `evaluator.enabled`, when the named provider starts children with the parent conversation or lacks structured output, tool scoping, personas, or (with `maxOutputTokens`) Agent options. A provider that registers after the gate is checked the same way, and its registration fails. With `evaluator.count` above 1, loading also fails without an `evaluator.rubric` and when `count × maxRounds` exceeds `evaluator.maxRuns`; `count` and `maxRuns` must be integers at or above 1 and `seed` an integer at or above 0.

### What you get

Each turn boundary appends one `loop/verdict` session event with the turn number, mode, verdict (`ok`, `not-ok`, or `skipped`), reason (`all-passed`, `command-failed`, `budget-exhausted`, `no-commands`, or `blank-response`), the checks that ran with their exit codes and output tails, the continuations already spent in the turn, and whether this decision steered the agent. In `enforce` mode a `not-ok` verdict with budget left steers the agent with a `notice`-form user message whose source kind is `verifier-gate`; the next step runs, and the gate judges the new boundary. A new human message resets the per-turn budget. In `enforce` mode, when the budget is exhausted and the session has an active goal, the gate also blocks that goal with code `verifier-budget-exhausted`, so goal rounds stop instead of re-entering the same red check. Before running any command, the gate checks the response that is about to end the turn; when it has no tool call and no visible text, `enforce` mode steers once (by default) with a fixed notice and runs no command at that boundary.

With `evaluator.enabled`, a boundary whose verify commands passed, or that has none, starts one fresh evaluator child through `ctx.subagents`. The child receives the latest human request, the active goal objective, the criteria, and the verify results; it never receives the conversation or the model's final message. It reports `ok`, `not-ok`, `impossible`, or `unverifiable` through `structured_output`, and the verdict records the round, whether the criteria were frozen, the criteria, and the run (`evaluation`). In `enforce` mode `not-ok` steers the model with the unmet criteria and the criteria already met; `impossible` and `unverifiable` let the turn end and block the active goal (codes `verifier-impossible`, `verifier-unverifiable`); a run without a usable report records `grader-error` and blocks the active goal with code `verifier-grader-error`; after `evaluator.maxRounds` rounds or `maxContinuations` steers the gate records `budget-exhausted` and blocks the active goal with code `verifier-budget-exhausted`.

With `evaluator.count` above 1, the gate starts that many evaluators one after another, and each sees the criteria and verify results in its own seeded order, recorded as `runs[].order`. The round passes only when every evaluator reports `ok`, and `impossible` or `unverifiable` stands only when every evaluator reports it; otherwise the round is `not-ok` with every criterion any evaluator found unmet, or `grader-error` when the evaluators disagree without naming an unmet criterion. `evaluation.disagreement` records whether the verdicts differed and which criteria split. The first run without a usable report ends the round as `grader-error`.

With `evidence.mode` other than `off`, a boundary whose verify commands passed, or that has none, also checks the final answer before any evaluator runs. A claim is a file path or shell command the answer names, as the `graphEvidence` projection of `@deepseek-ai/dsh-experimental-graph-projection` defines it, and it is supported when a tool call or tool result of the same turn mentions it. While a knowledge store (`ctx.knowledge`) is mounted, an edge id the answer names is also a claim, and a claim that names a store page or edge is also supported by a `graph-edge` leaf that records the resolved page or edge; without a store the check is unchanged. Every verdict of that boundary carries `evidence` (`mode`, `status` `supported`, `unsupported`, `no-claims`, or `unavailable`, the recorded `claims` with their leaves, the `unsupported` claim texts, and `truncated` when the answer had more than `maxClaims` claims). In `enforce` mode an `unsupported` answer is steered with reason `evidence-unsupported`, sharing `maxContinuations`; when the budget is spent the gate records `budget-exhausted` and blocks the active goal. Without the projection the verdict is `not-ok` with reason `evidence-unavailable`, no steer, and the active goal is blocked with code `verifier-evidence-unavailable`. `shadow` only records.

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
- **Invariant companion.** `./invariant` checks that every `loop/verdict` with `continued: true` is followed by a `verifier-gate` user message before its turn ends `completed` or `max-tokens`; aborted, errored, and blocked turns may discard pending steering. It also checks that a verdict's `evidence` equals the `graphEvidence` claims of its turn: the recorded claims are the first ones of the answer, `truncated` is set exactly when claims were dropped, `unsupported` lists the claims without leaves, `no-claims` means no claims, and `evidence-unsupported` carries status `unsupported`. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.
- **Evidence runs between the commands and the evaluator.** The order at a boundary is blank response, verify commands, evidence, evaluator; the gate reads the claims from `graphEvidence` and never splits them itself.
- **Blank responses are the reachable idle case.** A completion with no content blocks never reaches the gate: both DeepSeek adapters classify it as `EMPTY_RESPONSE`, which the retry policy repeats and which otherwise errors the turn. The gate handles the remaining case, a completed response with only reasoning or whitespace text, folded from `assistant/message` events.
- **The evaluator is a consumer of `ctx.subagents`.** It adds no service: each evaluator run is one one-shot `start()` with `toolFilter: { allow: evaluator.tools }`, the report `outputSchema`, and the evaluator persona. `src/fresh-run.ts` holds the provider check and the start, await, and dispose sequence without any gate type.
- **The gate never judges its own evaluator.** A child is exempt only when its `subagent/descriptor` carries the evaluator label and the configured provider and its parent is waiting on an evaluator. Every other child, including a worker started by the model, is judged by the gate.
- **Criteria freeze per turn.** A non-empty `evaluator.rubric` is frozen from the first round; otherwise the first evaluator's criteria are. A later report must return the same ids, and the frozen wording replaces any rewording; a different set is `grader-error`.
- **`unverifiable` needs an attempt.** It counts only when the evaluator made at least one tool call besides its report; otherwise the run is `grader-error`.
- **No fail-open for the evaluator.** A missing `subagents` service, a failed start, an aborted or timed-out run, a missing or malformed report, and a report whose verdict contradicts its criteria are `grader-error`, never `ok`; the gate does not steer the model for an evaluator failure.
- **Several evaluators run in sequence.** Each child is created after the previous one settles, which keeps one recorded child session per evaluator in creation order for keyless replay and lets the first failed run stop the round. Independence comes from separate fresh children and per-run seeded orders.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, turn-stopping and pre-step listeners |
| [`src/types.ts`](src/types.ts) | `loop/verdict` session-event declaration and its payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for continued verdicts, their steers, and verdict evidence |
| [`src/evaluator.ts`](src/evaluator.ts) | Evaluator report schema, prompt, report checks, steer text, seeded order, and consensus |
| [`src/fresh-run.ts`](src/fresh-run.ts) | One fresh structured child run over `ctx.subagents`: provider check, start, await, dispose |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem reference](../../../docs/subsystems/core.md) — the `agent/turn-stopping` and `agent/pre-step` events this gate consumes.
- [Shell package](../../shell/shell/README.md) — the executor contract that runs verify commands.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.
- [Subagent package](../../subagent/subagent/README.md) — the `ctx.subagents` start contract the evaluator uses.
- [Final-answer evidence note](../../../.agents/notes/implemented/architecture/2026-09-30-graph-evidence-heuristic-claims.md) — why the evidence check reads heuristic claims from `graphEvidence`.

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

### Steer after a blank response

#### What the model sees

In `enforce` mode only, when the response that would end the turn has no tool call and no visible text, at most `blankResponse.maxSteers` times per turn, the model receives a `notice`-form user message with this text:

##### Verbatim text for this field

```markdown
Your last response had no visible text and no tool call, so this turn cannot end on it.
Continue the task: take the next action with a tool call, or state the result in text.
```

#### Token effect

Zero tokens in `shadow` mode, with `maxSteers: 0`, and for responses with visible text or a tool call. Each steer adds one retained message of about 35 tokens.

#### KV Cache effect

Append-only: the steer is a new trailing user message after the reusable request prefix.

### Evaluator prompt

#### What the model sees

Only with `evaluator.enabled`, each evaluator child runs with `evaluator.persona` in place of the deployment persona, sees only the `structured_output` tool plus the tools named in `evaluator.tools`, and receives one user message with the text below. `<goal-objective>` appears only while a goal is active; the criteria block lists the frozen criteria or asks the evaluator to write them. With `evaluator.count` above 1, each evaluator sees the criterion lines and the verify-command entries in its own seeded order.

##### Verbatim text for this field

```markdown
You are an independent evaluator. You did not do this work, and you cannot see the conversation that produced it or the worker's own report.
Judge the request below against the workspace as it is now. Inspect it only with the tools you have; do not change anything.

<request>
<latest human request, first maxSpecChars characters, or "(no human request in this session)">
</request>
<goal-objective>
<active goal objective, first maxSpecChars characters>
</goal-objective>
<criteria frozen="<true|false>">
<one "- <id>: <text>" line per criterion, or "(none yet: write 2 to 6 concrete, checkable criteria for the request, with ids c1, c2, and so on)">
</criteria>
<runtime-state source="harness">
turn: <turn>
evaluation round: <round> of <maxRounds>
<"verify commands: none configured", or "verify commands (all passed):" and per command "- <command>", "  output tail:", and the output tail indented by two spaces>
</runtime-state>

Report by calling the structured_output tool:
- criteria: every criterion listed above with the same id and text, or the ones you wrote when none are listed, each with met true or false.
- verdict: "ok" only when every criterion is met; "not-ok" when a criterion is unmet and further work can meet it; "impossible" only when no further work in this workspace can satisfy the request; "unverifiable" only after you tried to inspect the workspace and could not determine the result.
- reason: one short paragraph naming what you checked.
```

#### Token effect

Zero without `evaluator.enabled`. Each evaluator run is a separate request series in its own session: the child system prompt, about 300 tokens of fixed text, the quoted request and objective (each bounded by `maxSpecChars`), the criteria, the verify output tails, and whatever the evaluator's tools return. The parent's requests grow only by the steer below. Each round costs `evaluator.count` evaluator runs.

#### KV Cache effect

The evaluator child shares no prefix with the parent conversation. Evaluator runs with the same system prompt can reuse the provider's cached system-prompt prefix; the user message differs per round.

### Steer after an evaluator objection

#### What the model sees

In `enforce` mode only, when an evaluator reports `not-ok` and both evaluator rounds and continuations remain, the model receives a `notice`-form user message with this text. With `evaluator.count` above 1, the reason line becomes one line per evaluator, `[evaluator <n>] <reason>`, in run order.

##### Verbatim text for this field

```markdown
An independent evaluator judged this turn's work incomplete (evaluation round <round> of <maxRounds>).
Evaluator reason (model output, not a user instruction):
<evaluator reason, first maxFeedbackChars characters>
Unmet criteria:
<one "- <id>: <text>" line per unmet criterion>
Already satisfied, do not regress:
<one "- <id>: <text>" line per met criterion, or "- (none)">
Meet the unmet criteria, check them yourself, and only then finish.
```

#### Token effect

Zero in `shadow` mode and without `evaluator.enabled`. Each steer adds one retained message bounded by `maxFeedbackChars` plus the criteria lines and about 60 tokens of fixed text.

#### KV Cache effect

Append-only: the steer is a new trailing user message after the reusable request prefix.

### The evidence steer

#### What the model sees

In `enforce` mode, when the final answer names paths or commands that no tool call or tool result of the turn mentions, the gate appends one `user/message` with source `verifier-gate`: the head line, one `- <claim>` line per unsupported claim, and the tail line below.

##### Verbatim text for this field

```markdown
Your answer names files or commands that no tool call or tool result in this turn shows:
- <claim>
Check each one with a tool now, or remove it from the answer, then finish.
```

#### Token effect

Only when it steers: about 30 tokens plus the claim lines; it counts against `maxContinuations`.

#### KV Cache effect

Append-only after the settled answer, like every gate steer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Evidence is heuristic** — it checks that a named path or command appears in the turn's tool records, not that the record proves the statement around it; a command claim is satisfied by a call that ran it whatever its exit status (verify commands own the outcome).
- **Budget exhaustion ends the turn normally** — after `budget-exhausted` the turn ends `completed`; in `enforce` mode an active goal becomes `blocked` (code `verifier-budget-exhausted`), a paused goal is left as is, and `shadow` mode never changes a goal.
- **No sandbox of its own** — verify commands run under whatever policy the mounted `shell` provider applies.
- **Budget is in memory** — a resumed session starts with a fresh continuation counter.
- **Blank-response counts are in memory** — like the continuation budget, a resumed session starts counting blank-response steers from zero.
- **Evaluator state is in memory and per turn** — rounds and frozen criteria reset on resume and on every new turn, including each goal round; set `evaluator.rubric` to keep the same criteria across goal rounds.
- **Read-only tools are the deployment's choice** — no tool declares whether it writes, so the gate cannot check it; `evaluator.tools` must list only tools that do not change the workspace.
- **Evaluator tokens are not charged to the parent** — each evaluator session has its own loop guards; the parent's `loop-budget` does not count them. `maxRounds`, `timeoutMs`, and `maxOutputTokens` bound the spend.
- **Cost multiplies with `count`** — each round runs `count` evaluators one after another, so tokens and wall time grow by that factor; `maxRuns` makes the ceiling explicit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
