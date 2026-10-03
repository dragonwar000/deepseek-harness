---
description: "Coteccons SSO Service Definition: sign one Coteccons staff account in through Microsoft Entra ID, watch the credential-free sign-in state, and mint that user's Azure AI access tokens on the Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-coteccons-sso

English | [中文](README.zh.md)

## Summary

Consumers read and watch whether a Coteccons staff member is signed in through Microsoft Entra ID, start or cancel a browser sign-in, sign out, and, on the Host only, obtain a current access token for that user. Views never carry tokens, so they can cross the Remote wire; tokens stay inside Host consumers that send them to Azure as `Authorization: Bearer`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`ctx.cotecconsSso` is a `CotecconsSso`. The client-safe views live in `@deepseek-ai/dsh-coteccons-sso/types`.

| Member | Contract |
|---|---|
| `aiScope` | Resource scope consented at sign-in for Azure AI requests; model routes request tokens for exactly this scope |
| `getState()` | Current `CotecconsSsoView` |
| `startSignIn()` | Joins the active attempt or starts a browser sign-in; returns before the user finishes. While not configured or already signed in, returns the state unchanged |
| `cancelSignIn(id)` | Cancels the named attempt; any other id changes nothing |
| `signOut()` | Forgets the signed-in account and deletes its stored token cache |
| `watch(signal)` | Complete snapshots starting with the current one; ending the subscription never cancels a sign-in |
| `getAccessToken(scope, signal?)` | Host-only bearer token for the signed-in account, refreshed silently when expired |

`CotecconsSsoView` is one of `not-configured` (with the `missing` settings `tenantId` and/or `clientId`), `signed-out`, `signing-in` (with `attemptId` and the Entra ID authorization `url`, `null` until ready), `signed-in` (with `account.name`, `account.username`, `account.tenantId`), or `error` (signed out, with `errorCode` `sign-in-failed`, `timeout`, `domain-not-allowed`, or `session-expired`). `getAccessToken` rejects with `CotecconsSsoTokenUnavailableError` whose `reason` is `not-configured`, `signed-out`, or `session-expired`; the caller reports that the user must sign in from Settings. A token must never be sent to a Client, logged, or stored outside the provider's token cache.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package defines the operations, the views, and the token-unavailable error only; the provider owns the Entra ID protocol, the browser hand-off, and token storage. No invariant companion is published because the service holds no relationship that a second observation could contradict.

<a id="further-exploration"></a>
## Further Exploration

- [coteccons-sso-msal](../coteccons-sso-msal/README.md) — the MSAL provider.
- [llm-coteccons-sso](../../llm/llm-coteccons-sso/README.md) — the `coteccons` model route that sends the user's token.
- [api-coteccons-sso-controller](../../api/coteccons-sso-controller/README.md) — the Remote controller for the settings UI.
- [Coteccons SSO decision](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md) — why each user's own Entra ID token calls Azure AI.

<a id="model-experience"></a>
## Model Experience

None, as the sign-in service registers no model context or tools; tokens affect HTTP authentication only.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One account per Host** — the service signs in one account; signing in as another user requires signing out first.

<a id="dev-note"></a>
### Dev Note

None.
