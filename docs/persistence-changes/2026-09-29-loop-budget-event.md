---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-loop-budget-event

English | [中文](2026-09-29-loop-budget-event.zh.md)

## Summary

Adds the log-only loop/budget session event recorded by @deepseek-ai/dsh-experimental-loop-budget, and qualifies its MessageSourceMap['loop-budget'] entry with @persistenceAttribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-budget-event
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-loop-stationarity-event"
    after: "4f8af840a8d3e8fdda28b6e43cecbc5f1bd6403df0d7fff8eaad686f9c63c615"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-loop-stationarity-event"
    after: "f2abe51d974abfb1a64bd4bd2d4300384045c33265d468eb67b11e61ecf31e7f"
    decision: same-version
  - root: "event:loop/budget"
    previous: null
    after: "151e7acda0708d10be7e8396b570ac0ee707c213cc54f6493f22c613e5ccf380"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-loop-stationarity-event"
    after: "46db6ba7e8d22f934a7aeb5b66a00f9d5e56c0c3357b2513c932cc878b770754"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-loop-stationarity-event"
    after: "91c9e948a6a0796fc221d01915f6a9705e9f1fca9bf37193c0b6cfa4a6798c0c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

loop/budget is a new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and no projection needs it to reconstruct session state. The work-floor steer message carries an attribution-only source kind, matching the verifier-gate precedent (docs/persistence-changes/2026-09-29-verifier-gate-source-attribution.md): readers preserve its content and literal kind discriminator without needing the loop-budget package, and the kind imposes no validation, replay, or authority requirement beyond that preservation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/loop-budget: 2 test files, 25 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
