---
description: "A Markdown wiki knowledge store with a fail-closed write guard, read-only knowledge tools, a capped index in context, and episode distillation after verified turns in shadow mode, in one experimental bundle shipped switched off."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-knowledge-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-knowledge-profile` enables [`knowledge-wiki-filesystem`](../knowledge-wiki-filesystem/README.md), [`knowledge-rules`](../knowledge-rules/README.md), [`tool-knowledge`](../tool-knowledge/README.md), [`context-knowledge`](../context-knowledge/README.md), and [`memory-distill`](../memory-distill/README.md) with one bundle. The only changes to model requests are the three read tool definitions and, when the store has pages, the index message. `memory-distill` starts in `shadow` mode. The bundle ships switched off; enable it from the Plugins page or add it to an initialized profile.

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
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-knowledge-profile
```

The profile must already contain `@deepseek-ai/dsh-base`, which supplies the filesystem, tool, and session projection services and the `agent/pre-step` and `agent/turn-stopping` events these rows use. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-knowledge-profile` removes all five rows from the profile's ordered layer list.

Enable Knowledge on the Web or Desktop Plugins page to switch on all five rows at once. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

### What you get

The layer inserts five rows and changes no `dsh-base` row. `knowledge-wiki-filesystem` keeps pages under `<session cwd>/knowledge`. `knowledge-rules` refuses file tool writes and shell commands that would change the store directly, so pages change only through `knowledge_write` or `memory-distill`. `tool-knowledge` starts `read-only` with `knowledge_query`, `knowledge_read`, and `knowledge_cite`. `context-knowledge` adds the store index, never page content, at the first step of a turn when it changed, capped at 200 lines and 25600 bytes. `memory-distill` starts in `shadow` mode: after the verifier gate records verdict `ok` it records the episode page it would write as a `knowledge/write` with `applied: false`.

### Order with the loop guards bundle

`memory-distill` must register its `agent/turn-stopping` listener after `verifier-gate`: add the loop guards bundle before this bundle in the profile's layer list. In the wrong order no turn is distilled and `memory-distill` logs this warning once per session:

```text
memory-distill: the verifier gate recorded a verdict after memory-distill checked the same turn boundary, so the turn was not distilled; list the loop guards bundle before the knowledge bundle so the gate runs first.
```

A verdict of `ok` exists only when `verifier-gate` has `verify.commands`; without the loop guards bundle, or with a gate that has none, `memory-distill` records nothing.

### Turn on writes

Patch the rows by id from your own profile patch. A config patch replaces the whole row config, so restate every field:

```yaml
- id: tool-knowledge
  config:
    mode: read-write
    evidenceTools: [read]
    maxResults: 10
    maxPageChars: 20000
    maxDepth: 2
- id: memory-distill
  config:
    mode: enforce
    assumption: a turn whose verify commands passed holds project facts worth recalling in later sessions
    requireVerdict: true
    dir: episodes
    changeTools: [write, edit]
    maxRequestChars: 1000
    maxOutcomeChars: 2000
    transientMarkers: [this session, for now, today only, temporarily, for this turn]
```

Every `knowledge_write` then asks the user and cites the session's reads of its sources. Disable one row with `disabled: true` on its id.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Applied after `dsh-base`, the patch inserts five rows with stable ids and changes no `dsh-base` row. Row order is listener order: the store is loaded before its guard and consumers, and `memory-distill` comes last.

The patch carries no invariant rows: `dsh-base` deliberately does not mount `@deepseek-ai/dsh-invariants`. A composition that mounts the registry adds each companion itself — `knowledge/invariant` and `context-knowledge/invariant` — next to its other core companions.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch inserting five rows over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | Parses the patch, validates every row against its package `Config`, and checks independence from the loop guards bundle |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | Boots the patch through the Loader and checks the request tools, the index message, and the store guard |
| — | No runtime invariant companion is published; the package carries only a static profile patch. Each row package owns its own invariant story. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — the seam, its roles, and its events.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.
- [Loop guards bundle](../loop-graph-profile/README.md) — the verifier gate `memory-distill` waits for.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through tool-knowledge and context-knowledge, which own every tool definition and index message this bundle can produce; knowledge-wiki-filesystem, knowledge-rules, and memory-distill add no request content of their own.

#### KV Cache effect

The three read tool definitions join the stable tool prefix once, when the bundle loads. The index message is append-only and is added only when the index changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Read-only and shadow by default** — `tool-knowledge` needs `mode: read-write` and `memory-distill` needs `mode: enforce` before the agent can change the store.
- **Tools cost tokens in every request** — the three read tool definitions add about 430 tokens to each request while the bundle is enabled; `read-write` adds about 340 more for `knowledge_write`.
- **Base profile required** — the patch depends on `dsh-base`; it is not a standalone profile.
- **Layer order** — `memory-distill` distills only when the loop guards bundle comes first in the layer list.
- **No invariant row** — a composition that mounts `@deepseek-ai/dsh-invariants` must add the `knowledge/invariant` and `context-knowledge/invariant` companions itself; this bundle does not, matching `dsh-base`.
- **Graph nodes cannot write knowledge** — a graph node has only the tools the graph contract's `allowedTools` names, and child sessions reject every approval, so `knowledge_write` in a node is always denied.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
