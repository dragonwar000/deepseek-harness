---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-loop-graph-events

English | [中文](2026-09-29-loop-graph-events.zh.md)

## Summary

Adds two log-only session events: infra/snapshot (host facts per agent) and loop/verdict (turn-stopping verify-command gate decisions).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-loop-graph-events
baseline: false
changes:
  - root: "event:infra/snapshot"
    previous: null
    after: "02c92aa7bc22aac70994b947cab626d33f76c287ecf3382a00b65d862eef14e2"
    decision: same-version
  - root: "event:loop/verdict"
    previous: null
    after: "7e000510f77bd24377d224040a040112bd0c82b86ceb1710a0e2efa03842274d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both are new ordinary event types with no predecessor; existing logs and readers are unaffected. infra/snapshot is appended once per agent creation by @deepseek-ai/dsh-experimental-infra-snapshot; loop/verdict is appended once per turn-stopping boundary by @deepseek-ai/dsh-experimental-verifier-gate. Both are declared required-on-read in SessionEventMap like todo/write; a build that does not know either type refuses the log unless the event carries ignorable: true. Neither event enters a model request or derived history, so no compaction, projection, or replay path needs to interpret them to reconstruct session state; only the verifier-gate steer message (a separate user/message event) is model-visible.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/verifier-gate packages/experimental/infra-snapshot: 3 test files, 29 tests passed. pnpm run gen-persistence-catalog and pnpm run gen-config-catalog regenerated known-event-types.ts, persistence-catalog.md/.zh.md/.i18n.yaml, persistence-schema.json, and config-catalog.md/.zh.md/.i18n.yaml from the two packages' SessionEventMap and Config declarations.

<a id="dev-note"></a>
## Dev Note

None.
