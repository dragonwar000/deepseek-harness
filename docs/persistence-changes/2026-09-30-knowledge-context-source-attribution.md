---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-knowledge-context-source-attribution

English | [中文](2026-09-30-knowledge-context-source-attribution.zh.md)

## Summary

Qualifies context-knowledge's MessageSourceMap['knowledge-context'] entry with @persistenceAttribution, adding an attribution-only source kind to user/message, developer/message, agent/inbox/spliced, and session/title-llm-request.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-knowledge-context-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-loop-budget-event"
    after: "72ac21ffd551d21aee204c531274ed1dd1dc05d0819a9d75668d4c78e204b171"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-loop-budget-event"
    after: "e1ab2a2b52ffd259a07204382de664c190cf5ac6fe44589784faa04f325b23a2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-loop-budget-event"
    after: "caf552c5a831de0e7a781287798ae3444ca88abfabc7f92ddbc9ee092d9717c3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-loop-budget-event"
    after: "2e8e49e6243b3ce232b9a317d2dad40a0aea26730f38a4f000cab6678523df41"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The knowledge index message's source kind carries only attribution metadata: readers preserve its content and literal kind discriminator without needing the context-knowledge package, and the kind imposes no validation, replay, or authority requirement beyond that preservation. Existing logs and existing source kinds are unaffected; older readers that do not know the knowledge-context kind still read the enclosing event structurally and preserve the field. Only the context-knowledge package itself additionally inspects its own kind, in its invariant companion, to match each index message with the knowledge/inject record before it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/context-knowledge: 3 test files passed, including the invariant-companion tests that depend on the source kind. pnpm run gen-persistence-catalog regenerated the persistence catalog and schema.

<a id="dev-note"></a>
## Dev Note

None.
