---
description: "Official CTD Core brand occupants for the sidebar, active only in official builds; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package gives an `official` client build the CTD Core name wordmark in the sidebar. Every build profile already shows the same Coteccons mark there — this package's mark occupant renders the identical `CtdMark` artwork as the shell's own fallback — so only the name presentation differs: the official wordmark SVG instead of the shell's plain-text local-build label. The conversation hero always uses the Coteccons mark fallback regardless of profile. Choose this package for deployments branded as CTD Core; deployments with another identity should provide a replacement brand package. It has no runtime state and does not affect model requests.

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

Mount this plugin in the browser roster of a deployment whose identity is CTD Core's own; its occupants register unconditionally once mounted.

### Choosing the profile

This package has no internal build-profile check: `apply()` always registers `OfficialBrandMark` and `OfficialBrandName` once the plugin is mounted. A deployment's composition — not a runtime env value — decides whether this package is in the roster at all; `DSH_CLIENT_BUILD_PROFILE` only selects the embedded `official`/default client build record read elsewhere (see [`scripts/client-build-environment.ts`](../../../scripts/client-build-environment.ts)), not this package's own registration. A deployment that leaves this package out of its roster keeps the shell fallbacks — the Coteccons mark and the local-build label — in place. The conversation hero shows the Coteccons mark fallback from `dsh-client-ui-conversation` regardless of profile, because that fallback is already the official mark.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies the sidebar slots — and the hero slot, which this package leaves on its fallback. Occupying a slot is the only composition route; there is no brand configuration surface here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state, and its three slot occupants install and leave through one transactional effect.
