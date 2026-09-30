---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-graph-plan-event

English | [中文](2026-09-29-graph-plan-event.zh.md)

## Summary

Adds the log-only graph/plan session event recorded by @deepseek-ai/dsh-experimental-graph-contract for every graph_audit call whose input carries a readable plan id, with the optional routes of the categories the plan uses, the optional category of each plan node, the SHELL_WRITES_UNCHECKED warning code, and optional cycleGuard edges in the recorded plan.

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
    after: "6021c0913fd7ca9a06eb9621db858f3746456d9d2a4d62cd1af8a8480333d666"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and only the graphPlans and graph projections, the graph runner, and the invariant companions read it. The model-visible audit text is ordinary tool/result content. The graph runner reads node routes only from this record, so the model route of every node subagent is reconstructable from the log. The added warning code widens the rejection code enum and cycleGuard is an optional edge field; records written before them still decode. A version whose input did not parse (plan: null) is recorded with admitted: false in both modes; in shadow mode mode: shadow records that no finding blocked it. Earlier records of an unparsed shadow-mode plan carry admitted: true and still decode, and every reader ignores them because an admitted plan needs a parsed plan.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract packages/experimental/graph-projection packages/experimental/graph-runner: all test files passed, including the shadow-mode unparsed plan case and its invariant.

<a id="dev-note"></a>
## Dev Note

None.
