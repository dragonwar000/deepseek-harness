---
description: "Audit dsh-graph/v1 plans deterministically before anything runs: graph_audit reports every structural rejection with a fixed remedy and records each version as a graph/plan event; shadow mode admits and only records."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-contract

English | [中文](README.zh.md)

## Summary

This package defines the `dsh-graph/v1` plan format and registers the `graph_audit` and `graph_capabilities` tools. `graph_audit` parses one plan, audits it without running anything, returns every finding with a fixed remedy, and appends a `graph/plan` event when the plan id is readable, so versions, rejection memory, admission, and capability routes are rebuilt from the log. `enforce` admits a version only without a `reject` finding; `shadow` admits every version. The package also declares the `graph/node` and `graph/run` events and the node lifecycle rules the graph runner and projection share. It is experimental.

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

Mount the plugin in a composition where the model plans multi-unit work: parallel executions, a separate verifier, and a synthesis step. Mount `@deepseek-ai/dsh-subagent` so the depth check can run, and `@deepseek-ai/dsh-experimental-graph-projection` to let the model read the admitted task graphs. The `@deepseek-ai/dsh-experimental-loop-graph-profile` bundle mounts both graph packages in `shadow` mode.

### When to choose it

Choose it when plans need a checked structure before any of them runs: no cycles, every output consumed, a fresh verifier, disjoint write scopes for parallel nodes, and a bounded worst-case budget. Start in `shadow` mode to see which findings real plans produce, then switch to `enforce`. Do not use it for straight single-step work; a chain gains nothing from a graph and the audit warns with `LINEAR_PLAN`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-contract'
  config:
    mode: shadow
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
    routes:
      - { category: coding, provider: deepseek, model: deepseek-chat }
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` admits every version and still reports findings; `enforce` admits a version only when no finding has severity `reject` |
| `assumption` | required outside `off` | The assumption about the model that this audit encodes; a blank value fails the load |
| `allowedTools` | `[]` | Global tools a graph node may declare; `run_code` fails the load |
| `runBudget.steps` | `0` | Limit on the summed worst-case steps of agent nodes (per-attempt budget × (retryBudget + 1)); `0` is unlimited |
| `runBudget.tokens` | `0` | Same for tokens |
| `runBudget.wallMs` | `0` | Limit on the critical path of worst-case wall time through the needs; `0` is unlimited |
| `routes` | `[]` | Capability routes `{category, provider, model, reliability}`; a node's `category` must be routed. `reliability` is a deployment label, `unverified` by default |

Loading fails with a `graph-contract:` error when `assumption` is blank, `allowedTools` names `run_code`, a `runBudget` field is not an integer of at least 0, a route has a blank category, provider, or model, or a category is routed twice.

### What you get

Each call with a readable plan id appends one `graph/plan` event; the `graphPlans` projection keeps every version, its codes, the acceptance frozen by the first parsed version, and the latest admitted plan. The audit reports these codes, in this order:

| Code | Check | Severity | Rejected when |
|---|---|---|---|
| `SCHEMA_INVALID` | `schema` | reject | The plan does not parse (unknown keys such as `status`, `basis`, or `version` included), or ids repeat, needs or edges name undeclared nodes, an edge is not a need, or an input binds an undeclared run input, a node outside `needs`, an undeclared output property, or a field the edge does not allow |
| `CYCLE` | `structure` | reject | The needs contain a cycle |
| `ISOLATED_NODE` | `closeness` | reject | A node in a plan of two or more nodes has no needs and no dependents |
| `NOT_CONSUMED` | `closeness` | reject | A node's output reaches no node, and it is not a `synthesis` or `stop_handoff` node (a plan without one may end in one sink) |
| `MISSING_ANCHOR` | `anchor` | reject | An anchor declares no `verify` command, or an L2 or L3 plan has no anchor with commands and an outgoing `anchors` edge |
| `VERIFIER_NOT_FRESH` | `freshness` | reject | A verification node is not `fresh-independent`, is fed by an execution node through a `feeds` edge, or an L2 or L3 plan has no verification node |
| `VERDICT_UNDECLARED` | `freshness` | reject | A verification output does not require `verdict` with enum `pass` and `fail` |
| `SYNTHESIS_BEFORE_VERIFY` | `order` | reject | A synthesis node has no verification node among its transitive needs |
| `MISSING_HUMAN_GATE` | `gates` | reject | An L3 plan has no `human_gate` node |
| `MISSING_STOP_HANDOFF` | `gates` | reject | An L3 plan has no `stop_handoff` node |
| `WRITE_SCOPE_OVERLAP` | `writes` | reject | Two nodes that can run in the same wave have overlapping write prefixes |
| `CAPABILITY_UNVERIFIED` | `capability` | reject | A tool is `run_code`, is not in `allowedTools`, or is not a registered global tool; an `anchor` or `human_gate` node declares tools or a category; an agent node's category has no configured route; or agent nodes exist and no subagent service is mounted |
| `BUDGET_EXCEEDED` | `budget` | reject | A run limit is set and an agent node declares no budget of that kind, or the worst case exceeds the limit |
| `INPUT_MAY_BE_ABSENT` | `inputs` | reject | An input binds to a node with `mayFail: true` and declares no `fallback` |
| `EDGE_WITHOUT_ARTIFACT` | `structure` | reject | A need has no declared edge, or an edge artifact is blank |
| `DEPTH_EXCEEDED` | `depth` | reject | Agent nodes would run deeper than the subagent depth limit |
| `ACCEPTANCE_CHANGED` | `freeze` | reject | Acceptance differs from the list the first parsed version froze |
| `LINEAR_PLAN` | `structure` | warn | A plan of two or more nodes without a verification node is a chain |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`graph_audit` takes one `json` parameter. `parsePlan` validates it with a strict zod schema at that parser boundary, fills node defaults, and normalizes write scopes. `auditPlan` is a pure function over the parsed plan and an explicit `AuditEnvironment` built from `Config`, `ctx.tools.get`, `ctx.subagents.resolveMaxDepth`, `delegationDepthOf`, and the `graphPlans` projection. Structure errors stop the audit; a cycle skips the checks that need an order. The tool appends `graph/plan` inside the tool pipeline and returns a structured value that renders to model-facing text.

### Design notes

- **A plan is immutable input.** Harness-owned fields (`status`, `basis`, `version`) are unknown keys and fail parsing, so the model cannot set them. The harness assigns the version: one more than the earlier records with the same plan id.
- **Rejection memory lives in the session log.** `graph_audit` reports every earlier version with its codes, and `repeatOf` names the latest earlier version with the same digest. A plan that does not parse is still recorded, with `plan: null`, when its id is readable.
- **Write scopes are path prefixes.** They are normalized like Agent Teams write scopes; two nodes may share a wave only when neither is a transitive need of the other, and then their prefixes must not overlap.
- **Budgets have no USD.** `ctx.llm` exposes no price, so the run budget covers steps, tokens (summed over attempts), and wall time (critical path, because a wave runs in parallel).
- **DAG only.** Edges carry no cycle guard in this format version; every cycle is rejected.
- **Routes are recorded, not looked up later.** A node's `category` selects the provider and model of its subagent, and a model choice reaches the model request, so `graph_audit` records the configured routes of the categories an admitted plan uses on its `graph/plan` record; the graph runner reads routes only from that record. `graph_capabilities` lists the configured routes with `available` (the model appears in `ctx.llm.listModels` at call time), the allowed tools that are registered, and the delegation depth. The routes carry no price because `ctx.llm` exposes none.
- **Runner vocabulary lives here.** `graph/node` and `graph/run` are declared in this package, with `NODE_TRANSITIONS`, `needSatisfied`, and `nodeFingerprints`, so the runner and the projection share one definition without depending on each other. A need is satisfied when it is `executed`, `failed` with `mayFail`, or `unverified` across a `verifies` edge. A node fingerprint digests the node and its needs' fingerprints, so a changed node changes every dependent.
- **Output schemas match subagents.** `output` is the object-rooted JSON Schema subset that `ctx.subagents.start` accepts.
- **Invariant companion.** `./invariant` checks that versions are contiguous, that admission agrees with the mode and the findings, that `plan: null` carries `SCHEMA_INVALID`, and that changed acceptance carries `ACCEPTANCE_CHANGED`. A composition mounts the companion together with `@deepseek-ai/dsh-invariants`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, the `graph_audit` and `graph_capabilities` tools, and result rendering |
| [`src/types.ts`](src/types.ts) | Plan, route, finding, `graph/plan`, `graph/node`, and `graph/run` event, and `graphPlans` state types |
| [`src/schema.ts`](src/schema.ts) | Zod parser of model-written plans and schemas of records and state |
| [`src/audit.ts`](src/audit.ts) | Rejection rules, waves, order, and the audit |
| [`src/digest.ts`](src/digest.ts) | Canonical JSON and plan digests |
| [`src/projection.ts`](src/projection.ts) | The `graphPlans` projection |
| [`src/run.ts`](src/run.ts) | Node transition table, need satisfaction, and node fingerprints |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for versions and admission |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Graph projection package](../graph-projection/README.md) — task graphs of admitted plans, read through `graph_query`.
- [Graph runner package](../graph-runner/README.md) — the `graph_run` tool that executes admitted plans on the recorded routes.
- [Loop graph profile](../loop-graph-profile/README.md) — the optional bundle that mounts the graph packages.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### The graph_audit tool

#### What the model sees

When the plugin is mounted (any mode except `off`), the model is offered one tool named `graph_audit` with a single required `plan` parameter (any JSON value) and this description:

##### Verbatim text for this field

```markdown
Audit one dsh-graph/v1 plan before any of it runs. The audit is deterministic and runs nothing. It checks: acyclic needs with one declared edge and artifact per dependency; every node output consumed; from L2, an anchor with verify commands and a fresh verification node; at L3, a human_gate and a stop_handoff; disjoint write scopes for nodes that can run together; allowed tools; the run budget; fallbacks for inputs from nodes that may fail; delegation depth; and acceptance unchanged since the first version.

Every call with a valid plan id records a new version of that plan. Fix every rejection it reports, then call again. Warnings do not block admission.

Plan: format "dsh-graph/v1"; id (lower-case, stable across versions); level L1|L2|L3; goal; runInputs (names); nodes; edges; deliverable; acceptance (non-empty list, frozen after the first version).

Node: id; kind execution|verification|anchor|human_gate|reducer|synthesis|stop_handoff; instruction; needs (node ids); inputs [{name, from: "run" or a needed node id, field, fallback?}]; output (object JSON Schema; verification nodes require verdict with enum ["pass","fail"]); tools; writes (workspace-relative path prefixes); verify (shell commands, required for anchors); budget {steps?, tokens?, wallMs?} per attempt; retryBudget; contextScope execution-only|fresh-independent; mayFail; category (optional; one of the categories graph_capabilities lists).

Edge: from; to; relation feeds|verifies|constrains|vetoes|anchors|hands_off; artifact (what crosses the edge); allowedFields (optional).

Status, basis, and version belong to the harness and are rejected inside a plan.
```

#### Token effect

Always-on while mounted: the tool definition is about 450 tokens in every request.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads.

### The graph_audit result

#### What the model sees

Each call returns text in this form; bracketed parts are filled per call and lines without data are omitted. Input without a valid plan id yields `plan: not recorded, because the input has no valid id` in the second line.

##### Verbatim text for this field

```markdown
graph_audit: <admitted | rejected | admitted in shadow mode; the rejections below are recorded, not enforced>
plan: <plan id> version <n> sha <first 12 hex digits>
identical to version <k>
previous versions: v<n> <admitted|rejected> (<CODE>, <CODE>); …
waves: [<node>, <node>] [<node>] …
rejections (<count>):
- [<CODE>] <subject>: <detail>. Remedy: <remedy>
warnings (<count>):
- [<CODE>] <subject>: <detail>. Remedy: <remedy>
```

#### Token effect

Each call adds one tool result that grows with the number of findings (about 40 tokens per finding) and with the plan history.

#### KV Cache effect

Append-only: each result is a new tool result after the reusable request prefix.

### The graph_capabilities tool

#### What the model sees

When the plugin is mounted (any mode except `off`), the model is offered a read-only tool named `graph_capabilities` with no parameters and this description. The result is compact JSON: `{"categories":[{"category","provider","model","reliability","available"}],"tools":[…],"depth":{"current","max"}}`; `depth` is absent when no subagent service is mounted.

##### Verbatim text for this field

```markdown
List what graph nodes can use in this deployment: each node category with its provider, model, reliability label, and whether the model is available now; the tools a node may declare; and the current and maximum delegation depth. Use only these categories and tools in a dsh-graph/v1 plan.
```

#### Token effect

Always-on while mounted: the tool definition is about 70 tokens in every request. Each call returns about 20 tokens per route.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Rejection memory is per session** — a new session starts with no history; storage-backed memory is deferred.
- **No cost in USD** — `runBudget` has steps, tokens, and wall time.
- **DAG only** — cycles with a guard are not part of this format version.
- **Tool registration is read at audit time** — a tool registered later (for example by MCP) is judged by the registry at the moment of the call.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
