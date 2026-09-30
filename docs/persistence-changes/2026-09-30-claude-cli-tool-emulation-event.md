---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-claude-cli-tool-emulation-event

English | [中文](2026-09-30-claude-cli-tool-emulation-event.zh.md)

## Summary

Adds the `llm/cli-tool-emulation` session event, which records one Claude Code CLI run whose tool declarations travelled in the prompt instead of an API `tools` field.

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
```

<a id="compatibility"></a>
## Compatibility

A new event root: existing records remain valid and nothing already persisted changes shape. The event is written only by the `claude-cli` model route, whose Base Bundle row ships disabled, and only for a request that declares tools while `toolCalls` is `prompt`. It is log-only and never enters derived history, so a reader that ignores it reconstructs the same conversation; it is recorded before each CLI run so the emulation preamble and any correction notice are in the log before the model reads them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-claude-cli: 176 tests passed, including the Loader-booted composition asserting the event lands in a real SessionStore.

<a id="dev-note"></a>
## Dev Note

None.
