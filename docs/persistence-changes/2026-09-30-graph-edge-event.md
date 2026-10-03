---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-graph-edge-event

English | [中文](2026-09-30-graph-edge-event.zh.md)

## Summary

Adds the log-only graph/edge session event, declared by @deepseek-ai/dsh-experimental-graph-contract and written by @deepseek-ai/dsh-experimental-graph-runner for every cycle-edge decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-graph-edge-event
baseline: false
changes:
  - root: "event:graph/edge"
    previous: null
    after: "a84af717c367337f8538f5208528b01805f55bbb7acb6da5ea4d7b163cb3d30d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like graph/node, never enters a model request or derived history, and only the graph projection and the runner invariant read it. The output a fired edge sends back is also logged in the child session's user message that briefs the reopened node.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract: all test files passed.

<a id="dev-note"></a>
## Dev Note

None.
