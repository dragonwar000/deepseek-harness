---
description: "Turn-stopping verify-command gate and a per-agent infrastructure snapshot in one experimental bundle, shipped switched off."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-loop-graph-profile` enables [`verifier-gate`](../verifier-gate/README.md) and [`infra-snapshot`](../infra-snapshot/README.md) with one bundle. `verifier-gate` runs configured verify commands before a turn may end and, in `enforce` mode, steers the model back to work on a red command; `infra-snapshot` records the host facts a run depended on. The bundle ships with dsh switched off, and `verifier-gate` starts in `shadow` mode: enabling the bundle alone records verdicts without steering. Enable it from the Plugins page or add it to an initialized profile.

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

The profile must already contain `@deepseek-ai/dsh-base`, whose `agent/turn-stopping` and `agent/created` events this layer's rows consume. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` removes both rows from the profile's ordered layer list.

Enable Loop guards on the Web or Desktop Plugins page to switch on both rows at once. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

### What you get

The layer inserts `infra-snapshot` with its shipped default (every session-start source) and `verifier-gate` in `shadow` mode with an empty `verify.commands` list, so enabling the bundle alone changes nothing observable yet: `verifier-gate` records `loop/verdict{verdict: 'skipped', reason: 'no-commands'}` at every turn boundary until a profile patch supplies commands. Configure the gate and flip it to `enforce` from your own profile patch, targeting the `verifier-gate` row id:

```yaml
- id: verifier-gate
  config:
    mode: enforce
    verify:
      commands: [pnpm test]
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, it inserts `infra-snapshot` and `verifier-gate` with stable row ids and no disables, so both rows compose over the shipped Web layers without touching an existing id.

The patch carries no `verifier-gate/invariant` row: `dsh-base` deliberately does not mount `@deepseek-ai/dsh-invariants`, and this bundle layers over `dsh-base` without adding one either. A composition that does mount the registry, such as [`packages/bundle/sdk-minimal/cordis.patch.yml`](../../bundle/sdk-minimal/cordis.patch.yml), adds `- id: verifier-gate-invariant` / `name: '@deepseek-ai/dsh-experimental-verifier-gate/invariant'` itself, next to its other core invariant companions.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch inserting `infra-snapshot` and `verifier-gate` over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch. `verifier-gate` and `infra-snapshot` each own their own invariant story. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Verifier gate](../verifier-gate/README.md) — the turn-stopping gate this bundle enables.
- [Infra snapshot](../infra-snapshot/README.md) — the per-agent host-facts event this bundle enables.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `verifier-gate`, which owns every model-visible steer this bundle can produce; `infra-snapshot` never enters a model request.

#### KV Cache effect

Independent of this bundle's own composition: `infra-snapshot` is log-only, and `verifier-gate`'s KV-cache effect is append-only, as documented in its own README.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Shadow by default** — enabling the bundle alone changes no model-visible behavior; `verify.commands` and `mode: enforce` require an explicit profile patch on the `verifier-gate` row.
- **Base profile required** — the patch depends on `dsh-base` supplying the `agent/turn-stopping`, `agent/pre-step`, and `agent/created` events both rows consume; it is not a standalone profile.
- **No invariant row** — a composition that mounts `@deepseek-ai/dsh-invariants` must add the `verifier-gate/invariant` companion itself; this bundle does not, matching `dsh-base`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
