---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-loop-denial-event

English | [中文](2026-09-29-loop-denial-event.zh.md)

## Summary

Adds the log-only loop/denial session event recorded by @deepseek-ai/dsh-experimental-denial-budget.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-denial-event
baseline: false
changes:
  - root: "event:loop/denial"
    previous: null
    after: "52ff900df9dcdaa61a565eefb84b5f635d65b2c2193577d35d473182a9246cab"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

A new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and no projection needs it to reconstruct session state. The model-visible advice is part of the ordinary tool/result content.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/denial-budget: 2 test files, 21 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
