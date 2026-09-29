---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-graph-node-run-events

English | [中文](2026-09-29-graph-node-run-events.zh.md)

## Summary

Adds the log-only graph/node and graph/run session events, declared by @deepseek-ai/dsh-experimental-graph-contract and written by @deepseek-ai/dsh-experimental-graph-runner.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-graph-node-run-events
baseline: false
changes:
  - root: "event:graph/node"
    previous: null
    after: "6d27af626def7a874a97e4f750bbd96d015195fd1a8472286d10095c77e16803"
    decision: same-version
  - root: "event:graph/run"
    previous: null
    after: "d3c0b323291b3fd396ec50af064f84f347b7d5df62fbec370268a744b856fc4e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Two new ordinary event types with no predecessor; existing logs and readers are unaffected. Both are declared required-on-read in SessionEventMap like graph/plan, never enter a model request or derived history, and only the graph projection and the runner invariant read them. Node output that reaches a later node's prompt is also logged in that child session's user message.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract: 6 test files, 106 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
