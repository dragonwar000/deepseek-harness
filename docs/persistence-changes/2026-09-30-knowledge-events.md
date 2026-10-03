---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-knowledge-events

English | [中文](2026-09-30-knowledge-events.zh.md)

## Summary

Adds the log-only knowledge/write and knowledge/inject session events, declared by @deepseek-ai/dsh-experimental-knowledge and written by knowledge store consumers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-knowledge-events
baseline: false
changes:
  - root: "event:knowledge/inject"
    previous: null
    after: "e472cdd6eb69e2b1f370cf990d8b4863aac452735a27b7edf945eee79017156c"
    decision: same-version
  - root: "event:knowledge/write"
    previous: null
    after: "2a3b113cb05f616fac21c4a8701fb388170f1f4ee3f85ca3c1dd802791ef3b41"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Two new ordinary event types with no predecessor; existing logs and readers are unaffected. Both are declared required-on-read in SessionEventMap like loop/verdict and graph/plan, and neither enters a model request or derived history. The index text a knowledge/inject record describes is logged separately as an ordinary user/message.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/knowledge: 2 test files, 12 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
