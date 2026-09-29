---
description: "Verifier gate, stationarity guard, denial budget, loop budget, and a per-agent infrastructure snapshot in one experimental bundle, shipped switched off."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-loop-graph-profile` enables [`verifier-gate`](../verifier-gate/README.md), [`stationarity-guard`](../stationarity-guard/README.md), [`denial-budget`](../denial-budget/README.md), [`loop-budget`](../loop-budget/README.md), and [`infra-snapshot`](../infra-snapshot/README.md) with one bundle, and leaves `repeat-tool-reminder` running until you switch `stationarity-guard` to `enforce`. Every guard starts in `shadow` mode: enabling the bundle alone records what each guard would do and changes no model request, step, or goal. The bundle ships with dsh switched off; enable it from the Plugins page or add it to an initialized profile.

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

### Install into a profile

Add the package to an initialized profile:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-loop-graph-profile
```

The profile must already contain `@deepseek-ai/dsh-base`, whose `agent/turn-stopping` and `agent/created` events this layer's rows consume. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` removes all five rows from the profile's ordered layer list.

Enable Loop guards on the Web or Desktop Plugins page to switch on all five rows at once. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

### What you get

The layer inserts five rows and changes no `dsh-base` row. `infra-snapshot` records host facts. The four guards start in `shadow` mode and append `loop/verdict`, `loop/stationarity`, `loop/denial`, or `loop/budget` records; `loop-budget` ships with every limit at `0` (off) and `verifier-gate` with no verify commands, so those two record nothing until configured. Flip a guard to `enforce` from your own profile patch, targeting its row id:

```yaml
- id: stationarity-guard
  config:
    mode: enforce
- id: repeat-tool-reminder   # stationarity-guard now owns repeat reminders
  disabled: true
- id: loop-budget
  config:
    mode: enforce
    turn: { maxSteps: 64 }
```

While `stationarity-guard` stays in `shadow` mode, `repeat-tool-reminder` still sends its advisory reminders; disable it when you enforce `stationarity-guard`, as above.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Applied after `dsh-base`, the patch inserts five rows with stable ids and changes no `dsh-base` row. Row order is listener order: `verifier-gate` registers its `agent/turn-stopping` listener before `loop-budget`, so the work floor yields when the gate has already steered.

The patch carries no invariant rows: `dsh-base` deliberately does not mount `@deepseek-ai/dsh-invariants`. A composition that mounts the registry adds each companion itself — `verifier-gate/invariant`, `stationarity-guard/invariant`, `denial-budget/invariant`, `loop-budget/invariant` — next to its other core companions.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch inserting five rows over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | Parses the patch and validates every guard row against its package `Config` |
| — | No runtime invariant companion is published; the package carries only a static profile patch. Each row package owns its own invariant story. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Verifier gate](../verifier-gate/README.md) — the turn-stopping gate this bundle enables.
- [Infra snapshot](../infra-snapshot/README.md) — the per-agent host-facts event this bundle enables.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.
- [Stationarity guard](../stationarity-guard/README.md) — the step-repetition guard this bundle enables.
- [Denial budget](../denial-budget/README.md) — the policy-denial guard this bundle enables.
- [Loop budget](../loop-budget/README.md) — the turn/goal spend guard this bundle enables.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `verifier-gate`, `stationarity-guard`, `denial-budget`, and `loop-budget`, which own every model-visible message this bundle can produce; `infra-snapshot` never enters a model request.

#### KV Cache effect

Independent of this bundle's own composition: every guard message is append-only, as documented in each guard's README, and `infra-snapshot` is log-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Shadow by default** — every guard needs an explicit `mode: enforce` patch on its row; `verifier-gate` also needs `verify.commands` and `loop-budget` needs limits.
- **Base profile required** — the patch depends on `dsh-base` supplying the `agent/turn-stopping`, `agent/pre-step`, and `agent/created` events both rows consume; it is not a standalone profile.
- **No invariant row** — a composition that mounts `@deepseek-ai/dsh-invariants` must add the `verifier-gate/invariant`, `stationarity-guard/invariant`, `denial-budget/invariant`, and `loop-budget/invariant` companions itself; this bundle does not, matching `dsh-base`.
- **No repeat reminders in shadow** — while `stationarity-guard` stays in `shadow` mode, `repeat-tool-reminder` keeps sending its advisory reminders; disable it in your own profile patch when you enforce `stationarity-guard`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
