---
description: "Fold admitted dsh-graph/v1 plans and graph runner records from the session log into task graphs with node status, carried results, and runs, and let the model read them with graph_query."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-projection

English | [中文](README.zh.md)

## Summary

This package registers the `graph` session projection and the read-only `graph_query` tool. The projection folds the admitted `graph/plan` versions that `@deepseek-ai/dsh-experimental-graph-contract` records, and the `graph/node` and `graph/run` records that `@deepseek-ai/dsh-experimental-graph-runner` writes, into one task graph per plan id: nodes with their needs, status, basis, attempt, and recovery state, the waves of nodes that can run together, the runs of the current version, and the executed results of the replaced version. The tool lets the model list admitted plans and read one plan or one node. The package writes no session event. It is experimental and carries no stability promise.

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

Mount the plugin after `@deepseek-ai/dsh-experimental-graph-contract`, which writes the `graph/plan` events this package reads. The plugin has no configuration: it constrains nothing and only reads the log, so it has no `mode` or `assumption`. The `@deepseek-ai/dsh-experimental-loop-graph-profile` bundle mounts it.

### When to choose it

Choose it when the model should re-read an admitted plan's structure, waves, and node states after the audit or a run, instead of relying on earlier tool results in the conversation. The graph runner requires it.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-projection'
```

### What you get

The `graph` projection keeps, for every plan id with an admitted version, the task graph of the latest admitted version. A refused or unparsed version leaves the task graph unchanged. `graph_query` with scope `plans` lists each admitted plan with its version, node count, ready count, and executed count; scope `plan` with `plan_id` returns that plan's nodes, waves, and runs; scope `node` with `plan_id` and `node_id` returns one node with its output, child session, and recorded reason.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`applyGraphEvent` decodes each `graph/plan`, `graph/node`, and `graph/run` payload with the graph-contract record schemas. An admitted, parsed `graph/plan` replaces that plan id's task graph with pristine nodes, their `nodeFingerprints`, and the `planWaves` of the plan; versions that are not admitted or did not parse are ignored. A `graph/node` record replaces the named node's status, basis, attempt, revision, recovery state, output, child session, and reason; a `graph/run` record appends a run or sets its stop reason. A payload that does not decode, or a record that does not match the admitted task, sets a terminal `failure`, and `graph_query` then fails with that reason.

### Design notes

- **Readiness is derived; every other status is recorded.** After every change, a node that has not started is `ready` when `needSatisfied` from graph-contract holds for every need and `pending` otherwise. Every other status is the latest `graph/node` record of the node.
- **Carried results.** When a new version is admitted, `carry` keeps the executed nodes of the replaced version with their fingerprints and basis, so the runner can carry a node whose fingerprint did not change.
- **One task graph per plan id.** A later admitted version replaces the earlier task graph and moves it to the end of the list; its runs start empty.
- **Shadow admissions are tolerated.** A plan admitted in `shadow` mode can carry a need on an undeclared node or a cycle; such nodes join no wave.
- **Mismatched records fail terminally.** A node or run record for a version that is not the current task, a node the plan does not declare, or a stop without a start sets `failure`.
- **No `./invariant` companion.** No runtime invariant companion is published: the projection is this package's only observation of the graph events. The admission relations are checked by `@deepseek-ai/dsh-experimental-graph-contract/invariant`, and the node transition relations by `@deepseek-ai/dsh-experimental-graph-runner/invariant`, which compares each record against this projection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: projection registration and the `graph_query` tool |
| [`src/types.ts`](src/types.ts) | `graph` state types and the projection-state declaration |
| [`src/projection.ts`](src/projection.ts) | The `graph` projection fold |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Graph contract package](../graph-contract/README.md) — the plan format, the audit, and the `graph/plan` event this projection folds.
- [Graph runner package](../graph-runner/README.md) — the `graph_run` tool that writes the `graph/node` and `graph/run` records this projection folds.
- [Loop graph profile](../loop-graph-profile/README.md) — the optional bundle that mounts the graph packages.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### The graph_query tool

#### What the model sees

When the plugin is mounted, the model is offered one read-only tool named `graph_query` with a required `scope` parameter (`plans`, `plan`, or `node`), optional `plan_id` and `node_id`, and the description below. The result is compact JSON: `{"plans":[{"planId","version","nodes","ready","executed"}]}` for `plans`, `{"graph":{"planId","version","waves","nodes":[{"id","kind","needs","status","attempt","recoveryState","basis"}],"runs":[{"runId","stopReason"}]}}` for `plan`, `{"node":{…, "output", "childSession", "detail"}}` for `node`; a missing argument, an unknown plan, or an unknown node is a tool error naming the problem.

##### Verbatim text for this field

```markdown
Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, ready count, and executed count. scope "plan" with plan_id returns its nodes (needs, status, basis, attempt, recovery state), the waves of nodes that can run together, and its runs. scope "node" with plan_id and node_id returns one node with its output, child session, and recorded reason. Status is recorded by the harness from the session log; it cannot be set.
```

#### Token effect

Always-on while mounted: the tool definition is about 170 tokens in every request. Each call adds one tool result proportional to the plan size (about 25 tokens per node), plus the output of a queried node.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **No evidence graph** — claims, citations, and history lookups are not part of this package.
- **No Web card** — the pending card is the generic host presenter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
