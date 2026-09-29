# Agent Note: Graph plans run in the foreground with proof-based node completion

Status: implemented

English | [中文](2026-09-29-graph-runner-foreground-scheduling.zh.md)

## Problem

An admitted `dsh-graph/v1` plan must run as a set of independent units without trusting what each unit says about itself, must survive a crash, and must keep parallel units from overwriting each other. The loop layer gates one session; nothing scheduled several sessions, decided when a unit's result counts, or recovered a partially finished plan.

## Decision

`@deepseek-ai/dsh-experimental-graph-runner` registers `graph_run`. A call runs the latest admitted version of one plan inside the calling tool call: list scheduling within `maxConcurrent`, each agent node a fresh one-shot subagent started with the node's tool allowlist and output schema, anchors and verify commands through the shell seam, and human gates through approval on the calling agent. Every status change is a `graph/node` event on the calling session, bracketed by `graph/run` start and stop; the node vocabulary, the transition table, need satisfaction, and node fingerprints live in `@deepseek-ai/dsh-experimental-graph-contract` so the runner, the graph projection, and the runner invariant share one definition.

A node is `executed` only with proof: its verify commands exit 0 (`predicate`), a verification node returns verdict `pass` for it (`verifier`), or a human grants its gate (`human`). A completed subagent without proof leaves the node `unverified`; a node needing it proceeds only across a `verifies` edge. Retryable failures rerun within `retryBudget` with a fresh brief that never includes the earlier failure. A new admitted version carries executed nodes whose fingerprint (the node and its needs' fingerprints) is unchanged and marks changed ones `patched`. A run that finds a node still `running` in the log marks it `failed_retryable` with basis `sessionExited` and briefs the next attempt to inspect partial changes. Writes and edits by a node's subagent outside the node's write prefixes are refused in `enforce` mode and recorded in both modes through `fs/write-intent` and `fs/edit-intent` listeners registered ahead of the observation policy.

## Alternatives considered

**Run the graph as a background job.** Jobs are in-memory and not resumable, need a job controller for the owner, and report back through a notice message; approval cannot be asked after the tool call returned. The foreground call keeps the turn open for human gates and makes the log the only recovery state.

**Give each writing node its own git worktree.** Child sessions inherit the parent's working directory and one-shot subagent requests have no working-directory field, so a worktree would not change where the node's tools write. Disjoint write prefixes are checked at audit time and enforced at write time instead.

**Count a completed subagent as done.** That lets a unit certify its own work, the failure the loop-layer verifier gate exists to prevent. Completion requires a predicate, an independent verification, or a human.

**Cap replanning with the goal round limit.** Goal rounds count goal-driven turns, not plan versions; `maxPlanVersions` bounds the versions a run accepts.

## Consequences

The calling turn waits for the whole run, and a node's shell commands can write outside its prefixes because only the fs seam is checked. Token and cost budgets per run are not enforced because subagent results carry no usage; wall time and dispatch count are. Loop-layer listeners such as the verifier gate also act inside node sessions. In exchange, every node outcome, retry, carried result, and stop reason is reconstructable from the calling session's log, and the runner invariant rejects an illegal transition, a revision gap, or an `executed` status without proof at append time.
