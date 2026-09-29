---
description: "Fold admitted dsh-graph/v1 plans from the session log into task graphs with derived node status and waves, and let the model read them with graph_query."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-projection

English | [中文](README.zh.md)

## Summary

This package registers the `graph` session projection and the read-only `graph_query` tool. The projection folds the admitted `graph/plan` versions that `@deepseek-ai/dsh-experimental-graph-contract` records into one task graph per plan id: nodes with their needs and a derived status, and the waves of nodes that can run together. The tool lets the model list admitted plans and read one of them. The package writes no session event. It is experimental and carries no stability promise.

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

Choose it when the model should re-read an admitted plan's structure and waves after the audit, instead of relying on the audit text earlier in the conversation.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-projection'
```

### What you get

The `graph` projection keeps, for every plan id with an admitted version, the task graph of the latest admitted version. A refused or unparsed version leaves the task graph unchanged. `graph_query` with scope `plans` lists each admitted plan with its version, node count, and ready count; scope `plan` with `plan_id` returns that plan's nodes and waves.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`applyGraphEvent` decodes each `graph/plan` payload with the graph-contract record schema, ignores versions that are not admitted or did not parse, and replaces that plan id's task graph with the nodes and `planWaves` of the admitted plan. A payload that does not decode sets a terminal `failure`, and `graph_query` then fails with that reason.

### Design notes

- **Status is derived, never set.** A node is `ready` when every needed node is done and `pending` otherwise. No node is done before a runner records it, so a node without needs is `ready` and every other node is `pending`.
- **One task graph per plan id.** A later admitted version replaces the earlier task graph and moves it to the end of the list.
- **Shadow admissions are tolerated.** A plan admitted in `shadow` mode can carry a need on an undeclared node or a cycle; such nodes join no wave.
- **No `./invariant` companion.** No runtime invariant companion is published: the projection is the only observation of `graph/plan` in this package, and the admission relations are already checked by `@deepseek-ai/dsh-experimental-graph-contract/invariant`. A second observation, such as node events written by a runner, is needed before a transition invariant can be stated.

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
- [Loop graph profile](../loop-graph-profile/README.md) — the optional bundle that mounts both graph packages.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### The graph_query tool

#### What the model sees

When the plugin is mounted, the model is offered one read-only tool named `graph_query` with a required `scope` parameter (`plans` or `plan`), an optional `plan_id`, and the description below. The result is compact JSON: `{"plans":[{"planId","version","nodes","ready"}]}` for `plans`, `{"graph":{"planId","version","waves","nodes":[{"id","kind","needs","status"}]}}` for `plan`; a missing `plan_id` or an unknown plan is a tool error naming the problem.

##### Verbatim text for this field

```markdown
Read the admitted task graphs of this session. scope "plans" lists each admitted plan with its version, node count, and ready count. scope "plan" with plan_id returns that plan's nodes with their needs and derived status, and the waves of nodes that can run together. Status is derived from the session log; it cannot be set.
```

#### Token effect

Always-on while mounted: the tool definition is about 110 tokens in every request. Each call adds one tool result proportional to the plan size (about 15 tokens per node).

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **No execution status yet** — nodes are only `pending` or `ready` until a graph runner records node events.
- **No evidence graph** — claims, citations, and history lookups are not part of this package.
- **No Web card** — the pending card is the generic host presenter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
