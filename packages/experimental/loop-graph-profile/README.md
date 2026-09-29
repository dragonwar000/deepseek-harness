---
description: "Verifier gate, stationarity guard, denial budget, loop budget, a per-agent infrastructure snapshot, and the graph plan audit and runner in one experimental bundle, shipped switched off."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loop-graph-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-loop-graph-profile` enables [`verifier-gate`](../verifier-gate/README.md), [`stationarity-guard`](../stationarity-guard/README.md), [`denial-budget`](../denial-budget/README.md), [`loop-budget`](../loop-budget/README.md), [`infra-snapshot`](../infra-snapshot/README.md), [`graph-contract`](../graph-contract/README.md), [`graph-projection`](../graph-projection/README.md), and [`graph-runner`](../graph-runner/README.md) with one bundle, and leaves `repeat-tool-reminder` running until you switch `stationarity-guard` to `enforce`. Every guard, the graph contract, and the graph runner start in `shadow` mode: enabling the bundle records what each guard would do and changes no step or goal; the only change to model requests is the `graph_audit`, `graph_capabilities`, `graph_query`, `graph_cite`, `history_read`, and `graph_run` tool definitions. The bundle ships with dsh switched off; enable it from the Plugins page or add it to an initialized profile.

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

The profile must already contain `@deepseek-ai/dsh-base`, whose `agent/turn-stopping` and `agent/created` events this layer's rows consume. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-loop-graph-profile` removes all eight rows from the profile's ordered layer list.

Enable Loop guards on the Web or Desktop Plugins page to switch on all eight rows at once. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

### What you get

The layer inserts eight rows and changes no `dsh-base` row. `infra-snapshot` records host facts. `graph-contract` offers the `graph_audit` and `graph_capabilities` tools in `shadow` mode: each audited plan version appends a `graph/plan` record and every version is admitted; `allowedTools` starts empty, so every tool a plan node declares is reported as `CAPABILITY_UNVERIFIED` until your profile patch names the tools graph nodes may use. `graph-contract` also warns with `SHELL_WRITES_UNCHECKED` when a node declares `bash` or `pwsh`, whose writes bypass the write-scope check, and accepts loop edges of at most 8 iterations. `graph-projection` offers the read-only `graph_query` tool over the admitted plans, `graph_cite`, which lists the tool records of the current turn that mention a path or command, and `history_read`, which reads compacted spans back as a new tool result at the end of the context (limits `history.maxChars` 8000, `maxListed` 20, `readWindow` 50). `verifier-gate` records the evidence check of every final answer (`loop/verdict` `evidence`) in `shadow` mode. `graph-runner` offers the `graph_run` tool in `shadow` mode: it runs an admitted plan with a fresh subagent per agent node on the `spawn` provider and records node writes outside a node's write scopes without refusing them; no capability route is configured, so every node runs on the calling agent's model. The four guards start in `shadow` mode and append `loop/verdict`, `loop/stationarity`, `loop/denial`, or `loop/budget` records; `loop-budget` ships with every limit at `0` (off) and `verifier-gate` with no verify commands, so `loop-budget` records nothing and `verifier-gate` records only `no-commands` or `blank-response` verdicts until configured. Flip a guard to `enforce` from your own profile patch, targeting its row id:

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
- id: graph-contract   # a config patch replaces the whole row config
  config:
    mode: enforce
    assumption: the model writes multi-unit plans with cycles, unconsumed nodes, or self-verification unless a deterministic audit rejects them
    allowedTools: [read, grep, edit]
    runBudget: { steps: 0, tokens: 0, wallMs: 0 }
    shellTools: [bash, pwsh]
    maxCycleIterations: 8
- id: verifier-gate   # a config patch replaces the whole row config
  config:
    mode: enforce
    assumption: the model declares a task done before its verify commands pass
    verify: { commands: ["pnpm test"], timeoutMs: 300000, stdoutTailChars: 2000 }
    blankResponse: { maxSteers: 1 }
    evidence: { mode: enforce, require: every, maxClaims: 32 }
    maxContinuations: 8
```

While `stationarity-guard` stays in `shadow` mode, `repeat-tool-reminder` still sends its advisory reminders; disable it when you enforce `stationarity-guard`, as above.

The bundle does not change compaction. To keep unanswered tool results out of pressure trimming and stop re-summarizing history whose summary did not shrink it, patch the `dsh-base` rows in your own headless profile; a config patch replaces the whole row config, so restate the pruner budgets:

```yaml
- id: tool-result-pruner
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
    protectUnseen: true
- id: compaction-basic
  config:
    convergence: refuse
```

Web presets carry their own `compaction-basic` and `tool-result-pruner` rows inside each preset group, so this patch does not reach them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Applied after `dsh-base`, the patch inserts eight rows with stable ids and changes no `dsh-base` row. Row order is listener order: `verifier-gate` registers its `agent/turn-stopping` listener before `loop-budget`, so the work floor yields when the gate has already steered.

The patch carries no invariant rows: `dsh-base` deliberately does not mount `@deepseek-ai/dsh-invariants`. A composition that mounts the registry adds each companion itself — `verifier-gate/invariant`, `stationarity-guard/invariant`, `denial-budget/invariant`, `loop-budget/invariant`, `graph-contract/invariant`, `graph-runner/invariant` — next to its other core companions.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch inserting eight rows over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | Parses the patch and validates every guard, graph-contract, and graph-runner row against its package `Config` |
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
- [Graph contract](../graph-contract/README.md) — the plan audit tool this bundle enables.
- [Graph projection](../graph-projection/README.md) — the task-graph query tool this bundle enables.
- [Graph runner](../graph-runner/README.md) — the plan execution tool this bundle enables.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `verifier-gate`, `stationarity-guard`, `denial-budget`, `loop-budget`, `graph-contract`, `graph-projection`, and `graph-runner`, which own every model-visible message and tool definition this bundle can produce; `infra-snapshot` never enters a model request.

#### KV Cache effect

Independent of this bundle's own composition: every guard message is append-only, as documented in each guard's README, `infra-snapshot` is log-only, and the `graph_audit`, `graph_capabilities`, `graph_query`, `graph_cite`, `history_read`, and `graph_run` definitions join the stable tool prefix once, when the bundle loads; `history_read` results are appended at the tail and never rewrite earlier context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Shadow by default** — every guard, `graph-contract`, and `graph-runner` need an explicit `mode: enforce` patch on their rows; `verifier-gate` also needs `verify.commands`, `loop-budget` needs limits, and `graph-contract` needs `allowedTools`.
- **Graph tools cost tokens in every request** — the `graph_audit`, `graph_capabilities`, `graph_query`, `graph_cite`, `history_read`, and `graph_run` definitions add about 1,400 tokens to each request while the bundle is enabled, whether or not the model plans with a graph.
- **Base profile required** — the patch depends on `dsh-base` supplying the `agent/turn-stopping`, `agent/pre-step`, and `agent/created` events both rows consume; it is not a standalone profile.
- **No invariant row** — a composition that mounts `@deepseek-ai/dsh-invariants` must add the `verifier-gate/invariant`, `stationarity-guard/invariant`, `denial-budget/invariant`, `loop-budget/invariant`, `graph-contract/invariant`, and `graph-runner/invariant` companions itself; this bundle does not, matching `dsh-base`.
- **No repeat reminders in shadow** — while `stationarity-guard` stays in `shadow` mode, `repeat-tool-reminder` keeps sending its advisory reminders; disable it in your own profile patch when you enforce `stationarity-guard`.
- **Compaction settings are not bundled** — `protectUnseen`, `convergence`, and `authoritativeRequest` stay opt-in per profile because a bundle patch would replace the whole `dsh-base` row config and cannot reach the per-preset compaction rows of the Web profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
