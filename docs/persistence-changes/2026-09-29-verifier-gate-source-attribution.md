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
    previous: "2026-09-16-session-format-v4"
    after: "92cf526183edb4cab80fcbf8677933aab152e65a5466134af3c5df1bee0b2472"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "c3932d2e2c41698de74ed3cca9c7dd8a889292b49a9368058726e600c5ae3b73"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "e4f22257eebf78472ab503fa476b8da877e541531c2b0a866b98f080ab89f8a2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "48d6b40a7a5be4fb4510fe6daecb2d41fe5400f704e6cb10b5bdbbf66a911d04"
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
