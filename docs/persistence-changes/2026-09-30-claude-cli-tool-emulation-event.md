---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-claude-cli-tool-emulation-event

English | [中文](2026-09-30-claude-cli-tool-emulation-event.zh.md)

## Summary

Adds the `llm/cli-tool-emulation` session event, which records one Claude Code CLI run whose tool declarations travelled in the prompt instead of an API `tools` field, and the `llm/cli-tool-emulation-reply` event, which records how that run's reply was read.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-claude-cli-tool-emulation-event
baseline: false
changes:
  - root: "event:llm/cli-tool-emulation"
    previous: null
    after: "17a26effacb05125a5fafa61dd5963ca9cd4008c3ee11aff2170befef1d1846f"
    decision: same-version
  - root: "event:llm/cli-tool-emulation-reply"
    previous: null
    after: "36c5f0056bdb4ff6b82ef7bbc2ea21069f8f66e8473b42d0b8c903dde5cdbbac"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Two new event roots: existing records remain valid and nothing already persisted changes shape. Both events are written only by the `claude-cli` model route, whose Base Bundle row ships disabled, and only for a request that declares tools while `toolCalls` is `prompt`. Both are log-only and never enter derived history, so a reader that ignores them reconstructs the same conversation. `llm/cli-tool-emulation` is recorded before each CLI run so the emulation preamble and any correction notice are in the log before the model reads them. `llm/cli-tool-emulation-reply` is recorded after the run and carries nothing the model reads: the calls accepted, how many of them were accepted from a near-miss JSON form or an XML `<invoke>` element, the characters dropped after an accepted call, and the rejection code if the reply was rejected.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-claude-cli: 308 tests passed, including the Loader-booted composition and the plugin test asserting both events land in a real SessionStore in run-then-reply order.

<a id="dev-note"></a>
## Dev Note

None.
