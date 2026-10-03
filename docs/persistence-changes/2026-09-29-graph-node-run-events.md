---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-graph-node-run-events

English | [中文](2026-09-29-graph-node-run-events.zh.md)

## Summary

Adds the log-only graph/node and graph/run session events, declared by @deepseek-ai/dsh-experimental-graph-contract and written by @deepseek-ai/dsh-experimental-graph-runner. A graph/node record may carry the loop iteration of the node.

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
    after: "f8c0f9a529e2ea6e1943e450e8c5e5dc2494353e527fad2a57617da51d89a2fa"
    decision: same-version
  - root: "event:graph/run"
    previous: null
    after: "d3c0b323291b3fd396ec50af064f84f347b7d5df62fbec370268a744b856fc4e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Two new ordinary event types with no predecessor; existing logs and readers are unaffected. Both are declared required-on-read in SessionEventMap like graph/plan, never enter a model request or derived history, and only the graph projection and the runner invariant read them. Node output that reaches a later node's prompt is also logged in that child session's user message. The optional iteration field is absent on records written before it, which read as iteration 0.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-contract: all test files passed.

<a id="dev-note"></a>
## Dev Note

None.
