---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-verifier-gate-source-attribution

English | [中文](2026-09-29-verifier-gate-source-attribution.zh.md)

## Summary

Qualifies verifier-gate's MessageSourceMap['verifier-gate'] entry with @persistenceAttribution, adding an attribution-only source kind to user/message, developer/message, agent/inbox/spliced, and session/title-llm-request.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-verifier-gate-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "419df7252cc345db0e34240faaf27868a31d8b66daae88676766ac5645f98fe2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "524cb28ed4e9d26477c480323aa9b05a08ac61cfa29f34f64317eb6d1c17f8bf"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "e59cfecc052e9bf6b81f611213df68a05c84117291dbe505feda5a9624308f2a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "64197be913978cb19ee69e1a5680698a1e568cc9280f81c0b46dac7a4f9e11a1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The verifier-gate steer message's source kind carries only attribution metadata: readers preserve its content and literal kind discriminator without needing the verifier-gate package, and the kind imposes no validation, replay, or authority requirement beyond that preservation. Existing logs and existing source kinds are unaffected; older readers that do not know the verifier-gate kind still read the enclosing event structurally and preserve the field. Only the verifier-gate package itself additionally inspects its own kind, in its invariant companion, to correlate a continued loop/verdict with the steer it produced.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/verifier-gate: 25 tests passed, including the invariant-companion tests that depend on the source kind. pnpm run gen-persistence-catalog regenerated known-event-types.ts, persistence-catalog.md/.zh.md/.i18n.yaml, and persistence-schema.json; pnpm --silent run verify-persistence-changes --json reclassified the four affected roots as attribution-kind-added, same-version.

<a id="dev-note"></a>
## Dev Note

None.
