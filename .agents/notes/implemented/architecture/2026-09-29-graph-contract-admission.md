# Agent Note: Graph plans are audited contracts recorded in the session log

Status: implemented

## Problem

Multi-unit work (parallel executions, a separate verifier, a synthesis step) needs a declared structure that can be checked before any of it runs. A plan written as prose cannot be checked, and a plan held in a store outside the session log cannot be replayed, resumed, or trusted after a crash. Community plugins either audit a file on disk without recording versions (`whale4rain/dsh-graph-engineering`) or keep a separate project store (`octie-dsh-plugin`).

## Decision

`@deepseek-ai/dsh-experimental-graph-contract` defines the `dsh-graph/v1` plan the model writes and a deterministic audit over it. The model passes a plan to `graph_audit` as JSON; a zod schema parses it at that parser boundary and rejects unknown keys, so harness-owned fields (`status`, `basis`, `version`) cannot appear in a plan. `auditPlan` checks structure, closeness, anchors and fresh verification from L2, human and handoff gates at L3, disjoint write prefixes for nodes that can share a wave, allowed and registered tools, subagent depth, the worst-case run budget, input fallbacks, and frozen acceptance. Each finding carries a fixed remedy; only findings with severity `reject` block admission in `enforce` mode, and `shadow` mode admits every version that parses while reporting the same findings; a version that does not parse is recorded as not admitted in both modes, so `graph_run` never receives it.

Every call whose input carries a readable plan id appends one `graph/plan` event with the harness-assigned version, the digest, the admission, the parsed plan or `null`, and the findings. The `graphPlans` projection folds these events into versions, rejection memory, the acceptance frozen by the first parsed version, and the latest admitted plan; the graph runner reads that projection and nothing else. The `./invariant` companion checks that versions are contiguous and that each record's admission agrees with its mode and findings.

## Alternatives considered

**Reuse the Agent Teams task board.** Its events and projection are fixed to Team membership, every mutation needs a Lead or owner, and readiness is computed one task at a time with no ordering or admission. The graph contract reuses its patterns (zod projection state, prefix invariant, write-prefix overlap) without depending on the package.

**Store rejected plans in a storage domain.** A second store could drift from the log and has no defined scope or retention across sessions. Rejection memory is the per-session projection of `graph/plan`; cross-session memory waits for the evolution gate.

**Typed tool parameters for the plan.** The tool parameter language has no typed maps, and a plan nests maps and schemas several levels deep; the plan parameter is `json` and the zod schema is the single validator.

**Glob write scopes.** Overlap of two globs is not cheap to decide; path prefixes match the Agent Teams normalization and the runner's write enforcement.

## Consequences

The audit is model-independent and costs no model call, but a model must learn the plan format from the tool description, which adds about 450 tokens to every request of a session that mounts the plugin. The opt-in `@deepseek-ai/dsh-experimental-loop-graph-profile` bundle mounts it in `shadow` mode with `@deepseek-ai/dsh-experimental-graph-projection`, so enabling that bundle pays this cost in every request; `dsh-base` does not mount it. Plans are directed acyclic graphs in this format version; guarded cycles need a later, compatible extension. Findings reference the deployment at audit time, so a tool registered later is judged by the registry of the call.
