---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-graph-plan-event

English | [中文](2026-09-29-graph-plan-event.zh.md)

## Summary

Adds the log-only graph/plan session event recorded by @deepseek-ai/dsh-experimental-graph-contract for every graph_audit call whose input carries a readable plan id.

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
    after: "a22510249d0295211d6e1e495b6ad08be111e4f56feb38d5516127e3523a7aa5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and only the graphPlans and graph projections read it. The model-visible audit text is ordinary tool/result content.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract packages/experimental/graph-projection: 7 test files, 103 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
