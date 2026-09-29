---
description: "Run admitted dsh-graph/v1 plans in the foreground with a fresh subagent per node, proof-based completion, retries, resume from the session log, human gates, and write-scope enforcement."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-graph-runner

English | [中文](README.zh.md)

## Summary

This package registers the `graph_run` tool, which executes the latest admitted version of one `dsh-graph/v1` plan inside the calling tool call. Each agent node runs as a fresh subagent with its declared tools and output schema; anchors and verify commands run through the shell seam; human gates ask the user. A node counts as `executed` only with proof. Every status change is a `graph/node` event on the calling session, so a later call resumes from the log. Writes by a node's subagent outside its write scopes are refused in `enforce` mode and recorded in `shadow` mode. It is experimental.

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

Mount the plugin after `@deepseek-ai/dsh-experimental-graph-contract`, which admits plans and records them as `graph/plan` events, and `@deepseek-ai/dsh-experimental-graph-projection`, which folds the runner's records. The composition also needs `ctx.subagents` with a provider that supports tool filters and output schemas (the in-process `spawn` provider does), the shell seam for anchors and verify commands, and `@deepseek-ai/dsh-user-approval` with an answerer when plans use human gates. The `@deepseek-ai/dsh-experimental-loop-graph-profile` bundle mounts it in `shadow` mode.

### When to choose it

Choose it when the model should execute a multi-unit plan whose units must not certify their own work: each unit runs with only its brief and tools, and completion needs a passing command, an independent verification node, or a human. Start in `shadow` mode to measure write-scope violations before refusing them.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-graph-contract'
  config:
    mode: enforce
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
- name: '@deepseek-ai/dsh-experimental-graph-projection'
- name: '@deepseek-ai/dsh-experimental-graph-runner'
  config:
    mode: shadow
    assumption: node agents report completion without proof unless a verifier or a command confirms it
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records writes outside a node's scopes; `enforce` refuses them |
| `assumption` | required outside `off` | The assumption about the model that this runner encodes; a blank value fails the load |
| `provider` | `spawn` | Subagent provider for agent nodes; it must support tool filters and output schemas |
| `maxConcurrent` | `2` | Nodes running at once |
| `maxDispatches` | `0` | Agent-node dispatches per run; `0` is unlimited |
| `maxWallMs` | `0` | Wall time per run; `0` is unlimited |
| `maxPlanVersions` | `8` | Highest plan version that may run |
| `verifyTimeoutMs` | `300000` | Timeout per verify command |
| `outputTailChars` | `2000` | Command output kept per check |
| `humanTimeoutMs` | `0` | Human gate timeout; `0` waits until the run stops |

Loading fails with a `graph-runner:` error when `assumption` or `provider` is blank, or a count is not an integer in range (`maxConcurrent`, `maxPlanVersions`, `verifyTimeoutMs`, and `outputTailChars` at least 1; the others at least 0).

### What you get

Each call returns the stop reason, its fixed guidance, and every node's status, basis, attempt, and reason, plus the output of `synthesis` and `stop_handoff` nodes. The stop reasons are:

| Stop reason | Meaning |
|---|---|
| `GOAL_MET` | Every node finished with proof, or is a final report |
| `NO_FURTHER_WORK` | No node can run: an unverified result needs a verification node or verify commands, or a node waits on one that did not finish |
| `NO_PROGRESS` | A node failed after its retries and its dependents were skipped; audit a fixed version with `graph_audit` |
| `BUDGET` | `maxDispatches` or `maxWallMs` stopped dispatching; call `graph_run` again to continue from the recorded state |
| `HUMAN_STOPPED` | A human gate was not granted, or the run was cancelled |
| `ADMISSION_REFUSED` | The plan has no admitted version, or the admitted version cannot be ordered |
| `MAX_ROUNDS` | The admitted version exceeds `maxPlanVersions` |

A node status carries a basis:

| Basis | Given when |
|---|---|
| `predicate` | The node's verify commands exited 0 (an anchor, or an agent node with `verify`) |
| `verifier` | A verification node returned verdict `pass` for it across a `verifies` edge, or the verification node itself passed without verify commands |
| `human` | Its `human_gate` was granted with `allowed-once` |
| `agentReported` | The subagent completed with a schema-valid output and nothing proved it; the node stays `unverified` |
| `sessionExited` | A previous run ended while the node was `running`; the node becomes `failed_retryable` |

A need is satisfied when it is `executed`, `failed` with `mayFail` (bindings then receive their `fallback`), or `unverified` across a `verifies` edge. A new admitted version carries executed nodes of the replaced version whose fingerprint (the node and its needs' fingerprints) is unchanged; a node that existed before with a changed fingerprint runs again with recovery state `patched`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`graph_run` reads the latest admitted version and its recorded routes from the `graphPlans` projection and the node states from the `graph` projection, then `runGraph` loops: it fails nodes past their `retryBudget`, dispatches every dispatchable node in plan order up to `maxConcurrent`, and waits for one in-flight node to settle. An agent node is started with `ctx.subagents.start(provider, { prompt, parent, signal, toolFilter, outputSchema, agentOptions? })` and always disposed in `finally`. A completed child's structured output is validated against the node schema, then the node's verify commands run in order and stop at the first failure. A verification node resolves itself and every `unverified` node it verifies: `pass` with passing commands makes them `executed`; anything else makes them `failed_retryable`. When nothing is in flight, a `NO_PROGRESS` stop first skips every open node whose need failed without `mayFail` or was skipped.

### Design notes

- **Foreground, not a background job.** The job registry is in memory and not resumable, `ctx.approval.request()` needs an open turn, and job completions return as notice messages. The run holds the calling tool call, so human gates ask on the calling agent, `exec.signal` cancels the run, and the session log is the only recovery state.
- **Write scopes instead of worktrees.** Child sessions inherit the parent's working directory and one-shot requests have no working-directory field, so a worktree would not change where a node's tools write. The audit keeps write prefixes of nodes that can run together disjoint, and `fs/write-intent` and `fs/edit-intent` listeners registered with `{ prepend: true }` check each write of a tracked child and always call `next()`, leaving the observation policy's decision slot untouched.
- **`maxPlanVersions` bounds replanning.** Goal rounds count goal-driven turns, not plan versions.
- **`maxConcurrent` is the only concurrency cap.** `maxActiveSubagents` applies only to continuable children.
- **No persona per kind.** The node brief states the node's role; a verification node's brief adds the artifacts to check, the acceptance criteria, and the verdict rule. Earlier failure traces are never included.
- **Gates ask on the calling agent.** Child subagents reject approval requests. The request names `graph_run` and the call id; `humanTimeoutMs` bounds the wait; only `allowed-once` grants.
- **Routes come from the log.** A node with a category runs on the route recorded with the admitted version; the provider must support agent options.
- **Invariant companion.** `./invariant` checks every `graph/node` and `graph/run` against the `graph` projection before it: the record folds onto the prefix, the transition is in `NODE_TRANSITIONS`, the revision follows the previous one, a node that never ran becomes `executed` only with `carriedFrom`, `executed` carries a `predicate`, `verifier`, or `human` basis, and the output matches the node's output schema. A composition mounts the companion together with `@deepseek-ai/dsh-invariants` and the graph projection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, the fs write-scope listeners, and the `graph_run` tool |
| [`src/runner.ts`](src/runner.ts) | `runGraph`: scheduling, dispatch, resolution, retries, resume, carry-over, and stop reasons |
| [`src/prompt.ts`](src/prompt.ts) | The node brief |
| [`src/write-scope.ts`](src/write-scope.ts) | Write-scope checks for tracked child sessions |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for node lifecycle records |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Graph contract package](../graph-contract/README.md) — the plan format, the audit, routes, and the `graph/node` and `graph/run` vocabulary.
- [Graph projection package](../graph-projection/README.md) — the task graphs this runner reads and `graph_query`.
- [Subagent package](../../subagent/subagent/README.md) — the `ctx.subagents` seam that starts each node.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### The graph_run tool

#### What the model sees

When the plugin is mounted (any mode except `off`), the model is offered `graph_run` with a required `plan_id` and an optional `inputs` object, and this description:

##### Verbatim text for this field

```markdown
Run the latest admitted version of one dsh-graph/v1 plan and wait for it to stop. Each agent node runs as a fresh subagent that sees only its instruction, its inputs, and its declared tools, and returns its declared output. Anchors and verify commands run as shell commands; a human_gate asks the user.

A node counts as executed only with proof: its verify commands passed, a verification node returned verdict "pass" for it, or the user granted its gate. A result without proof stays unverified. Failed nodes are retried up to their retryBudget.

The result names the stop reason and every node's status. After NO_PROGRESS, fix the plan and audit a new version with graph_audit; unchanged finished nodes are carried over. After BUDGET, call graph_run again to continue.
```

#### Token effect

Always-on while mounted: the tool definition is about 230 tokens in every request of the calling session.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads.

### The graph_run result

#### What the model sees

Each call returns text in this form; bracketed parts are filled per call and lines without data are omitted. A missing plan, a missing run input, or an unusable provider is a tool error naming the problem.

##### Verbatim text for this field

```markdown
graph_run: <STOP_REASON> — plan <id> — version <n> — run <run id>
<fixed guidance for the stop reason>
- <node>: <status> (<basis>), attempt <n> — <reason>
result of <synthesis or stop_handoff node>: <JSON output>
```

#### Token effect

Each run adds one tool result of about 20 tokens per node plus the final outputs.

#### KV Cache effect

Append-only: each result is a new tool result after the reusable request prefix.

### The node brief

#### What the model sees

Each agent node's subagent receives one user message built by `nodePrompt`: its role and plan, the plan goal, its instruction, its resolved inputs (`not provided` when absent), its tool and write limits, and, for a verification node, the artifacts to check, the acceptance criteria, and the verdict rule. After an interrupted attempt it also receives:

##### Verbatim text for this field

```markdown
A previous attempt of this node stopped before it finished; inspect the workspace for partial changes before acting.
```

#### Token effect

Each node brief is its child's first message, about 80 tokens plus inputs and acceptance.

#### KV Cache effect

Node briefs start fresh child sessions and do not touch the calling session's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **Shell writes are not scoped** — only writes through the fs seam (`write`, `edit`) pass the write-intent check; a node with a shell tool can write anywhere its sandbox allows.
- **Loop guards run in every node** — listeners such as `verifier-gate` apply to child sessions too, so root verify commands also run at the end of each node turn.
- **Foreground only** — the calling turn waits for the run; background runs are deferred.
- **No token or USD budget per run** — subagent results carry no usage; `maxDispatches` and `maxWallMs` bound a run.
- **No `any_of` join** — a node waits for all of its needs; `mayFail` with `fallback` expresses a branch that may fail.
- **No Web card** — the pending card is the generic host presenter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
