---
description: "The cotecconsSso Remote controller exposes Coteccons SSO sign-in state and commands to the browser without tokens."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-coteccons-sso-controller

English | [中文](README.zh.md)

## Summary

The `cotecconsSso` Remote namespace lets the settings UI and the Desktop welcome read the Coteccons SSO state, start or cancel a browser sign-in, and sign out. It forwards every call to `ctx.cotecconsSso` and returns the same token-free snapshots.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web App Bundle mounts the controller as row `coteccons-sso-controller`. The namespace exposes `getState`, `startSignIn`, `cancelSignIn(attemptId)`, `signOut`, and the stream `watch`. Every command returns the complete snapshot after it settles, and `watch` starts with the current snapshot. Cancellation names the attempt id, so a stale screen cannot cancel a newer sign-in. `getAccessToken` and `aiScope` are not exposed: tokens stay on the Host.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller is a Typert Remote service over `ctx.cotecconsSso` with no state of its own; no invariant companion is published. Provider failures such as a credential-store error during sign-out reach the caller as Remote errors.

<a id="further-exploration"></a>
## Further Exploration

- [coteccons-sso](../../credentials/coteccons-sso/README.md) — the Service Definition and views.
- [ui-settings-coteccons-sso](../../client/ui-settings-coteccons-sso/README.md) — the settings group that consumes this namespace.
- [api-remotes](../remotes/README.md) — the Remote assembly that mounts this namespace in the browser.

<a id="model-experience"></a>
## Model Experience

None, as the sign-in controller registers no model context or tools; tokens never cross the Remote wire.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sign-in outlives the page, not the Host** — a reconnecting page recovers the active attempt through `watch`, but a Host restart ends the attempt and its loopback listener.

<a id="dev-note"></a>
### Dev Note

None.
