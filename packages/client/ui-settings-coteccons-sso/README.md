---
description: "Coteccons SSO group on the AI Account settings page: Microsoft Entra ID sign-in for the main model, with the browser link, the signed-in account, and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-coteccons-sso

English | [中文](README.zh.md)

## Summary

Open **Settings → AI Account**: the first group, **Coteccons SSO — used for the main model**, signs a Coteccons staff member in with their Microsoft account. While signed in, the Coteccons models run with that user's own sign-in; the group shows who is signed in, the tenant, and a **Sign out** button.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The group shows one of five states. **Not configured** names the missing `tenantId` or `clientId` and where to set them. **Signed out** offers **Sign in with Coteccons SSO**. **Signing in** tells the user to finish in the browser window the Host opened, shows the Microsoft sign-in link in case no window opened, and offers **Cancel**. **Signed in** lists the name and email and the tenant id with **Sign out**. A failed or expired sign-in explains the cause (did not complete, timed out, not a Coteccons account, expired) beside the sign-in button. When a sign-in started on this page completes, the first Coteccons model becomes the Agent default.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply` that gives the package a Loader row, and declares no services: `slots` and `locale` are browser services, so naming them here would hold the Host row waiting for the whole run instead of activating it. The browser half subscribes to `ctx.remote.cotecconsSso.watch` through a reconnecting Remote stream, publishes each snapshot through the group's `sso` hook, and registers `CotecconsSsoGroup` into the `settings.ai-account.group` slot with id `coteccons` and order `0`. On a `signing-in` to `signed-in` transition it calls `ctx.remote.session.initializeDefaultModel('coteccons')`; a refusal or disconnect is logged and leaves the default unchanged. Commands publish the snapshot they return; a refused command shows a generic failure, and an ended stream keeps the last snapshot with a reload notice. The heading carries the Coteccons mark (`CtdMark`). All copy lives in the `settings.cotecconsSso` dictionary (English and Chinese). No invariant companion is published because every displayed fact derives from the Host sign-in stream.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [coteccons-sso](../../credentials/coteccons-sso/README.md) — the Service Definition and views.
- [api-coteccons-sso-controller](../../api/coteccons-sso-controller/README.md) — the Remote namespace this group calls.
- [ui-settings-ai-account](../ui-settings-ai-account/README.md) — the page that declares the group slot.

<a id="model-experience"></a>
## Model Experience

None, as the settings group registers no model context or tools; it only changes the saved default model after a sign-in.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Default follows sign-ins seen by an open page** — a sign-in completed while no settings page watched the transition (for example from the Desktop welcome) sets the default only if that surface requests it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
