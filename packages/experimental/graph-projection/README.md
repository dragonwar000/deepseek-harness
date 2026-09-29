---
description: "Fold admitted dsh-graph/v1 plans, graph runner records, turn evidence, and compacted spans from the session log, and let the model read them with graph_query, graph_cite, and history_read."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-projection

English | [中文](README.zh.md)

## Summary

This package registers three session projections and three read-only tools. `graph` folds admitted `graph/plan` versions and the runner's `graph/node`, `graph/run`, and `graph/edge` records into one task graph per plan id: nodes with status, basis, attempt, recovery state, and loop iteration, waves, runs, loop decisions, and carried results; `graph_query` reads it. `graphEvidence` folds the paths and commands the current turn's tool records mention and the claims of its latest answer; `graph_cite` reads it. `graphHistory` lists compacted spans; `history_read` returns one as a transcript. The package writes no session event. It is experimental and carries no stability promise.

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

Mount the plugin after `@deepseek-ai/dsh-experimental-graph-contract`, which writes the `graph/plan` events this package reads. The plugin constrains nothing and only reads the log, so it has no `mode` or `assumption`; its only configuration is the `history_read` limits. `history_read` reads through `ctx.sessionQuery`, which `@deepseek-ai/dsh-session-query-sqlite` provides. The `@deepseek-ai/dsh-experimental-loop-graph-profile` bundle mounts it.

### When to choose it

Choose it when the model should re-read an admitted plan's structure, waves, and node states after the audit or a run, instead of relying on earlier tool results in the conversation, check which of this turn's tool records mention a path or command before naming it, or read back what compaction removed from its context. The graph runner requires it, and the evidence check of `@deepseek-ai/dsh-experimental-verifier-gate` reads `graphEvidence`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-projection'
```

| Field | Default | Meaning |
|---|---|---|
| `history.maxChars` | `8000` | Characters of transcript per `history_read` page; a longer event line is cut to it |
| `history.maxListed` | `20` | Spans a `history_read` listing returns, newest first |
| `history.readWindow` | `50` | Events after the target per session query read; keep it at most the session query `readWindowMax` (default 50) |

Loading fails with a `graph-projection:` error when a `history` field is not an integer of at least 1.

### What you get

The `graph` projection keeps, for every plan id with an admitted version, the task graph of the latest admitted version. A refused or unparsed version leaves the task graph unchanged. `graph_query` with scope `plans` lists each admitted plan with its version, node count, ready count, and executed count; scope `plan` with `plan_id` returns that plan's nodes, waves, runs, and loop edges with their fire counts; scope `node` with `plan_id` and `node_id` returns one node with its output, child session, and recorded reason.

The `graphEvidence` projection resets at every `turn/start`. A claim is a file path or a shell command the latest assistant message names: inline code with whitespace is a command, inline code that reads as a path is a path, and a prose token is a path only when it is rooted (`/`, `~/`, `../`) or contains `/` and ends in a file name; fenced code is ignored. Each claim carries leaves from the same turn: `tool-record` (a tool call argument names it), `observed` (a successful tool result names it), or `absence` (a failed tool result names it); a claim without a leaf is parametric. Replacement tool results and the `graph_cite` tool's own calls are not leaves. `graph_cite` classifies one claim and returns its leaves.

The `graphHistory` projection records every `compaction/summary` and `compaction/prune` span with its shadowed seqs. `history_read` without `seq` lists spans newest first; with `seq` it reads the span's original events through `ctx.sessionQuery.readEvent` in bounded windows and returns one transcript page as a new tool result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`applyGraphEvent` decodes each `graph/plan`, `graph/node`, `graph/run`, and `graph/edge` payload with the graph-contract record schemas. An admitted, parsed `graph/plan` replaces that plan id's task graph with pristine nodes, their `nodeFingerprints`, and the `planWaves` of the plan; versions that are not admitted or did not parse are ignored. A `graph/node` record replaces the named node's status, basis, attempt, revision, recovery state, output, child session, and reason; a `graph/run` record appends a run or sets its stop reason; a `graph/edge` record updates the view of its cycle edge (fire count, decided iteration, outcome, metrics, and the output a fire sent back). A payload that does not decode, or a record that does not match the admitted task, sets a terminal `failure`, and `graph_query` then fails with that reason.

### Design notes

- **Readiness is derived; every other status is recorded.** After every change, a node that has not started is `ready` when `needSatisfied` from graph-contract holds for every need and `pending` otherwise. Every other status is the latest `graph/node` record of the node.
- **Carried results.** When a new version is admitted, `carry` keeps the executed nodes of the replaced version with their fingerprints and basis, so the runner can carry a node whose fingerprint did not change.
- **One task graph per plan id.** A later admitted version replaces the earlier task graph and moves it to the end of the list; its runs start empty.
- **Shadow admissions are tolerated.** A plan admitted in `shadow` mode can carry a need on an undeclared node or a cycle; such nodes join no wave.
- **Loop iterations are recorded.** A `graph/node` record with a higher `iteration` reopens the node; readiness is derived again from needs.
- **Evidence is heuristic.** `graphEvidence` is a pure fold of `turn/start`, `tool/call`, `tool/result`, and `assistant/message`; it calls no model. `assistant/message` cannot cite source events, file-system observations are Cordis events rather than session events, and no service links claims to code, so leaves come only from the turn's tool records and no `graph/claim` event exists: claims and leaves are rebuilt from the log.
- **Folds read no config.** Projection caches are keyed by `stateVersion` only, so every configurable limit applies when a tool or gate reads the state.
- **History is read, not restored.** `history_read` never rewrites the surface; it reads old events asynchronously through the session query service and returns them at the tail.
- **Mismatched records fail terminally.** A node or run record for a version that is not the current task, a node the plan does not declare, or a stop without a start sets `failure`.
- **No `./invariant` companion.** No runtime invariant companion is published: the projections are this package's only observation of the graph events and the evidence. The evidence relation is checked by `@deepseek-ai/dsh-experimental-verifier-gate/invariant`, which compares each recorded `loop/verdict` evidence with `graphEvidence`. The admission relations are checked by `@deepseek-ai/dsh-experimental-graph-contract/invariant`, and the node transition relations by `@deepseek-ai/dsh-experimental-graph-runner/invariant`, which compares each record against this projection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, projection registration, and the `graph_query`, `graph_cite`, and `history_read` tools |
| [`src/types.ts`](src/types.ts) | `graph`, `graphEvidence`, and `graphHistory` state types and the projection-state declarations |
| [`src/projection.ts`](src/projection.ts) | The `graph` projection fold |
| [`src/evidence.ts`](src/evidence.ts) | Pure claim, path, command, and leaf functions |
| [`src/evidence-projection.ts`](src/evidence-projection.ts) | The `graphEvidence` projection fold |
| [`src/history.ts`](src/history.ts) | The `graphHistory` projection and the paged transcript reader |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Graph contract package](../graph-contract/README.md) — the plan format, the audit, and the `graph/plan` event this projection folds.
- [Graph runner package](../graph-runner/README.md) — the `graph_run` tool that writes the `graph/node` and `graph/run` records this projection folds.
- [Loop graph profile](../loop-graph-profile/README.md) — the optional bundle that mounts the graph packages.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.
- [Final-answer evidence note](../../../.agents/notes/implemented/architecture/2026-09-30-graph-evidence-heuristic-claims.md) — why claims and leaves are a heuristic fold of the turn's tool records.

-----

<a id="model-experience"></a>
## Model Experience

### The graph_query tool

#### What the model sees

When the plugin is mounted, the model is offered one read-only tool named `graph_query` with a required `scope` parameter (`plans`, `plan`, or `node`), optional `plan_id` and `node_id`, and the description below. The result is compact JSON: `{"plans":[{"planId","version","nodes","ready","executed"}]}` for `plans`, `{"graph":{"planId","version","waves","nodes":[{"id","kind","needs","status","attempt","recoveryState","iteration","basis"}],"runs":[{"runId","stopReason"}],"edges":[{"from","to","fireCount","outcome"}]}}` for `plan` (`iteration` only above 0, `edges` only for a plan with loop edges), `{"node":{…, "output", "childSession", "detail"}}` for `node`; a missing argument, an unknown plan, or an unknown node is a tool error naming the problem.

##### Verbatim text for this field

```markdown
Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state, loop iteration), the waves of nodes that can run together, its runs, and the fire count of each loop edge. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.
```

#### Token effect

Always-on while mounted: the tool definition is about 190 tokens in every request. Each call adds one tool result proportional to the plan size (about 25 tokens per node), plus the output of a queried node.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The graph_cite tool

#### What the model sees

When the plugin is mounted, the model is offered a read-only tool named `graph_cite` with one required `claim` string and the description below. The result is one of three texts: `graph_cite: <path|command> <claim> is supported in turn <n> by:` followed by one `- <tool-record|observed|absence>: <tool> (#<seq>)` line per leaf; `graph_cite: <path|command> <claim> is parametric: no tool call or tool result in turn <n> mentions it.`; or `graph_cite: "<claim>" is neither a file path nor a shell command; cite one path or one command.`

##### Verbatim text for this field

```markdown
Check which tool calls and tool results of the current turn mention a file path or a shell command you are about to name in your answer. Each supporting record is tool-record (a tool call argument names it), observed (a successful tool result names it), or absence (a failed tool result names it). A claim with no record is parametric: nothing in this turn shows it.
```

#### Token effect

Always-on while mounted: the tool definition is about 95 tokens in every request. Each call adds a result of one to four lines.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results.

### The history_read tool

#### What the model sees

When the plugin is mounted, the model is offered a read-only tool named `history_read` with optional integer `seq` and `offset` and the description below. Without `seq` the result lists compacted spans, newest first (`- seq <n>: summary|prune, events #<start>-#<end>, <k> items`); with `seq` it is a transcript page (`#<seq> User|Assistant|Tool result: <text>`, other event types by type name), cut to `history.maxChars` characters, followed by `More: call history_read with seq <n> and offset <m>.` when the page stopped early. An unknown `seq`, an offset outside the span, or a deployment without the session query service is a tool error.

##### Verbatim text for this field

```markdown
Read back conversation that compaction replaced or shortened in your context. Without seq, list the compacted spans of this session, newest first: each has a seq, a kind (summary: a span replaced by a checkpoint; prune: a tool result shortened in place), its first and last event number, and its item count. With seq from that list, return the span as a transcript starting at offset; a page that stops early names the next offset. The transcript arrives as this tool result; nothing earlier in your context changes.
```

#### Token effect

Always-on while mounted: the tool definition is about 150 tokens in every request. Each read adds one tool result of at most `history.maxChars` characters of transcript (about `maxChars / 4` tokens) plus one heading line.

#### KV Cache effect

A history_read result is a new tool result appended after everything the model has already seen; no earlier message, checkpoint, or tool result changes, so the cached prompt prefix stays reusable. Re-reading a span re-sends its content at the tail; it does not restore it in place.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Claims are paths and commands only** — prose facts, fenced code, and file names without a slash in prose are not claims; a command claim is supported by a call that names it, whatever the call's exit status.
- **Transcript text is search text** — lines come from `extractSessionEventText` of `@deepseek-ai/dsh-session-query`: reasoning blocks are dropped, a tool call renders as its name and raw arguments, and images render as nothing.
- **Reads clone the live log** — the session query service snapshots the live session for each window read, so a long span costs several full-log copies.
- **No Web card** — the pending card is the generic host presenter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
