---
description: "Coteccons SSO provider over MSAL Node: Microsoft Entra ID browser sign-in with PKCE and a loopback redirect, the token cache kept as one credential-store record, and silent token refresh."
kind: "package-reference"
---

# @deepseek-ai/dsh-coteccons-sso-msal

English | [中文](README.zh.md)

## Summary

Mount this provider to give `ctx.cotecconsSso` real Microsoft Entra ID sign-in through `@azure/msal-node`. The app registration is a public client, so no client secret exists: the user signs in in the system browser, MSAL receives the authorization code on a loopback listener, and the resulting refresh, access, and ID tokens live only in the Harness credential store. Access tokens for the Azure AI scope refresh silently from that cache.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web App Bundle mounts the provider as row `coteccons-sso` with the CTD-Core app registration's `tenantId` and `clientId`. It requires `ctx.credentials`. Configuration:

| Field | Default | Meaning |
|---|---|---|
| `tenantId` | unset | Directory (tenant) id or verified domain |
| `clientId` | unset | Application (client) id of the public-client app registration |
| `authority` | `https://login.microsoftonline.com/<tenantId>` | Authority URL (HTTPS) |
| `scopes` | `openid`, `profile`, `offline_access` | Scopes requested at sign-in besides `aiScope` |
| `aiScope` | `https://cognitiveservices.azure.com/.default` | Azure AI scope consented at sign-in and used for model requests |
| `allowedDomains` | empty | Lowercase email domains allowed to sign in; empty allows every account of the tenant |
| `openBrowser` | `true` | Open the sign-in page in the Host's default browser; the URL is published either way |
| `signInTimeoutMs` | `300000` | Deadline for one browser sign-in (10 s–30 min) |

While `tenantId` or `clientId` is unset the state is `not-configured` naming the missing fields; the provider still starts, so the AI Account page loads. A malformed set value (a non-GUID `clientId`, a non-HTTPS `authority`, an uppercase domain) fails the row at load. The app registration needs the redirect URI `http://localhost` on the "Mobile and desktop applications" platform with public client flows allowed, delegated permission Azure Cognitive Services `user_impersonation` with admin consent, and each user needs an Azure RBAC role such as "Cognitive Services OpenAI User" on the AI resource.

<a id="understand-the-implementation"></a>
## Understand the implementation

`startSignIn` runs MSAL `acquireTokenInteractive` with `prompt: select_account` and the sign-in scopes plus `aiScope`, so consent for the AI resource is obtained at sign-in. MSAL listens on `127.0.0.1` with a random port, and the provider publishes the authorization URL in the `signing-in` view before opening it with the `open` package. Cancellation, timeout, and disposal post an OAuth `access_denied` response to that loopback listener so MSAL settles and closes it. After sign-in the account's UPN domain is checked against `allowedDomains`; a rejected account's tokens are deleted and the state becomes `error` with `domain-not-allowed`. Only the newly signed-in account is kept.

The MSAL cache plugin reads and writes one `grant` record, `coteccons-sso/token-cache`, through `ctx.credentials`; its payload names the `clientId` and `authority`, and a record for another registration is ignored. A failed store write is logged and the in-memory cache keeps serving this process. An unreadable stored cache is deleted at start. `getAccessToken` calls `acquireTokenSilent`; when Entra ID requires interaction the record is deleted and the state becomes `error` with `session-expired`. Sign-out deletes the record and rebuilds the MSAL client so no in-memory tokens remain. Logs carry error names and codes, never token material. No invariant companion is published because the provider's state has a single owner.

<a id="further-exploration"></a>
## Further Exploration

- [coteccons-sso](../coteccons-sso/README.md) — the Service Definition and views.
- [credentials](../credentials/README.md) — the credential store holding the token cache.
- [Coteccons SSO decision](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md) — the design and the Azure prerequisites.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-coteccons-sso-msal) — every accepted field.

<a id="model-experience"></a>
## Model Experience

None, as the sign-in provider registers no model context or tools; tokens affect HTTP authentication only.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The browser must run on the Host** — the redirect reaches a loopback listener on the Host, so a browser on another machine cannot complete the sign-in.
- **No per-request refresh on 401** — a token Azure rejects is not refreshed ahead of its expiry; the request fails and a later request obtains a new token.

<a id="dev-note"></a>
### Dev Note

None.
