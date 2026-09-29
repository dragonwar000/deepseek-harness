# Agent Note: Loop edges reopen their body with a recorded iteration

Status: implemented

English | [中文](2026-09-30-graph-cycle-edges-reopen-loops.zh.md)

## Problem

Some multi-unit work repeats until a check passes, but `dsh-graph/v1` ordered nodes by acyclic needs, node status ended at `executed`, and waves, fingerprints, carry-over, and skip-cascade all assume that order.

## Decision

A cycle edge carries `cycleGuard` and is never a need: relation `feeds`, from a node back to itself or to one of its transitive needs; only its from node may feed nodes outside the loop body. When the from node becomes executed, the graph runner runs the `until` command and records one `graph/edge` decision: `until-met`, `exhausted` after `maxIterations` fires, `plateau` when the metric command's output stayed the same for `plateauAfter` decisions, or `fired`. A fire reopens every body node with a `graph/node` record at the next `iteration`, status `pending`, attempt 0, and sends the from node's allowed output fields to the loop target's next brief. Nodes that need the from node wait until the decision is recorded.

## Alternatives considered

- **Allow cycles in needs.** Every order-based invariant of the audit and the runner would need a second definition.
- **Let a model decide whether to loop.** Edge choice stays deterministic; the decision is a shell exit code.
- **Reset nodes without an iteration.** A record from `executed` back to `pending` would be indistinguishable from an illegal transition in the runner invariant.

## Consequences

Loop exits never fail a node; a downstream verification decides whether the last result is good enough. The audit multiplies the worst-case budget of each body node by `maxIterations + 1` and caps `maxIterations` by deployment configuration. A crashed run leaves at most one undecided loop per from node, which the next `graph_run` decides before dispatching dependents.
