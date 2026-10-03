---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-graph-node-ratchet

English | [中文](2026-10-03-graph-node-ratchet.zh.md)

## Summary

Adds an optional ratchet record to graph/node events, written when graph-runner's ratchetMetric is set and a node retries.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-graph-node-ratchet
baseline: false
changes:
  - root: "event:graph/node"
    previous: "2026-09-29-graph-node-run-events"
    after: "377c08a1d4e6c94db348ae6a6806f4e1da6a64bef3a80ac1471f541c829918d4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: the field is optional and absent from every record written without a ratchet. The graph projection does not read it. The strict node schema rejects the field, so a reader that predates it cannot decode a record that carries one; such records appear only after an operator sets ratchetMetric.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/graph-runner: 94 tests passed, including the ratchet unit and run specs; graph-runner src coverage 100% per file.

<a id="dev-note"></a>
## Dev Note

None.
