---
description: "Per-agent infra/snapshot session event recording node version, platform, CPU count, memory, and sandbox mode, for maintainers and agents comparing or auditing what a run's host actually was."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-infra-snapshot

English | [中文](README.zh.md)

## Summary

This package appends one `infra/snapshot` session event when an agent is created, recording the host facts a run actually depended on: Node version, platform, architecture, logical CPU count, total memory, and the mounted shell's default sandbox mode. It exists so infrastructure is reconstructable from the session log instead of assumed — comparing two runs for a behavior difference is only valid once their snapshots match. The event is appended once per agent, at creation, with no runtime cost beyond that single append.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a run's host infrastructure must be reconstructable from its session log — comparing two runs, diagnosing environment-dependent behavior, or auditing what a deployment actually ran on.

### When to choose it

Choose it whenever infrastructure-dependent comparisons matter: benchmark runs, bug reports tied to a specific host, or any evaluation that assumes two sessions ran on comparable hardware. Skip it when the deployment already records host facts elsewhere (its own fleet inventory or telemetry) and a second per-session copy adds no value.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-infra-snapshot'
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | `[]` | Session start sources (`startup`, `resume`, `clear`, `compact`) to snapshot; empty records every source |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-infra-snapshot) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin listens on `agent/created`, which Cordis awaits before agent creation resolves, so the `infra/snapshot` event is always present by the time a caller observes a newly created agent. `sources` filters by `SessionStartSource` (`startup` | `resume` | `clear` | `compact`); an empty list (the default) records every source, and a source absent from a non-empty `sources` list appends nothing for that agent.

Host facts come from `process.version`, `process.platform`, `process.arch`, `os.cpus().length`, and `os.totalmem()` (rounded to MiB). `sandboxMode` reads the optional `ctx.shell` service's `sandboxMode` getter, falling back to `'none'` when no shell is mounted or the mounted executor does not sandbox by default — the package adds no sandboxing of its own and never calls `resolve`/`execute`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `agent/created` listener, host-fact capture |
| [`src/types.ts`](src/types.ts) | `InfraSnapshot` payload type and the `infra/snapshot` `SessionEventMap` declaration |
| — | No runtime invariant companion is published; one independent append with no cross-event relation leaves nothing for a companion to observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session event log](../../../docs/subsystems/session.md) — the append-only log `infra/snapshot` joins.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-infra-snapshot) — every accepted config field.
- [`dsh-shell`](../../shell/shell/README.md) — the optional `ctx.shell` service this package reads `sandboxMode` from.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin appends a log-only `infra/snapshot` session event that never enters a model request.

#### KV Cache effect

Independent: the event is log-only and never enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No model/effort fields** — those already live in `request/header`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

This package was scaffolded under the `290926-dsh-loop-graph` plan's Task 2, alongside `@deepseek-ai/dsh-experimental-verifier-gate` (Task 1) built in parallel. Two shared-file registrations from that plan are integration follow-ups, not part of this package's own behavior: an entry for `packages/experimental/infra-snapshot` in `SENTENCE_MODEL_EXPERIENCE` (`scripts/verify-package-readme-model-experience.ts`, so the doc-sync Model Experience gate accepts the `None, as ` sentence above), and `packages/experimental/README.md` plus `tsconfig.host.json` rows for this package (added once the plan's bundle task lands). This package's own `tsconfig.base.json` source-resolution alias was added in the same change as the package, matching every other `packages/experimental/*` package's hand-written alias.

</details>
