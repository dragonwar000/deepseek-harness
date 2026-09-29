---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-loop-stationarity-event

English | [中文](2026-09-29-loop-stationarity-event.zh.md)

## Summary

Adds the log-only loop/stationarity session event recorded by @deepseek-ai/dsh-experimental-stationarity-guard, and qualifies its MessageSourceMap['stationarity-guard'] entry with @persistenceAttribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-stationarity-event
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "3d7b62c64e9b2014f237699321d7530e29d12a3e67c3681ee14aadd72a6db037"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "d3022f6ccd233db7d5e50dcdd88845e869003977530f50b8e2473799b705ce21"
    decision: same-version
  - root: "event:loop/stationarity"
    previous: null
    after: "705bbf86ac1cc0d348e09065d8bae5a5d001e24f26839c85698231a081304047"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "19469489e228fffacc2e2590361b079cc35d5de0d04c6be3d19218b66e439f08"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-verifier-gate-source-attribution"
    after: "7f81530fa8b38cb794a35f45b660b6e28eb6298161724c9f58ca3d0d93766934"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

loop/stationarity is a new ordinary event type with no predecessor; existing logs and readers are unaffected. It is declared required-on-read in SessionEventMap like loop/verdict, never enters a model request or derived history, and no projection needs it to reconstruct session state. The guard's reminder message carries an attribution-only source kind, matching the verifier-gate precedent (docs/persistence-changes/2026-09-29-verifier-gate-source-attribution.md): readers preserve its content and literal kind discriminator without needing the stationarity-guard package, and the kind imposes no validation, replay, or authority requirement beyond that preservation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/stationarity-guard: 2 test files, 20 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
