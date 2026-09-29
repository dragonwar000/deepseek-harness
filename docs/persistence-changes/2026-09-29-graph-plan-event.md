---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-graph-plan-event

English | [中文](2026-09-29-graph-plan-event.zh.md)

## Summary

Adds the log-only graph/plan session event recorded by @deepseek-ai/dsh-experimental-graph-contract for every graph_audit call whose input carries a readable plan id, with the optional routes of the categories the plan uses and the optional category of each plan node.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-graph-plan-event
baseline: false
changes:
  - root: "event:graph/plan"
    previous: null
    after: "831e16f193f276537679f5281a25c025ba04e387a5ef15e25e526e6c403da73f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and only the graphPlans and graph projections, the graph runner, and the invariant companions read it. The model-visible audit text is ordinary tool/result content. The graph runner reads node routes only from this record, so the model route of every node subagent is reconstructable from the log.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract packages/experimental/graph-projection packages/experimental/graph-runner: 13 test files, 177 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
