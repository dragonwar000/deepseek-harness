---
description: "The coteccons model route: Azure OpenAI or Foundry models called over the OpenAI-compatible v1 endpoint with the signed-in Coteccons user's own Entra ID token, authorized by Azure RBAC instead of an API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-coteccons-sso

English | [中文](README.zh.md)

## Summary

This plugin registers the `coteccons` model route. Each request goes to the Coteccons Azure AI resource with `Authorization: Bearer <token>`, where the token is the signed-in user's own Entra ID access token from `ctx.cotecconsSso`. Azure RBAC on the resource decides who may call it; no API key is configured or stored.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web App Bundle mounts the route as row `llm-coteccons-sso`. Configuration:

| Field | Default | Meaning |
|---|---|---|
| `displayName` | `Coteccons` | Name shown in model selectors |
| `baseURL` | `https://ctd-opus-resource.openai.azure.com/openai/v1` | OpenAI-compatible v1 endpoint; HTTPS, or plain HTTP only to a loopback address |
| `models` | `DeepSeek-V4-Pro` (context 131,072, no reasoning control), `gpt-5.6-terra` | Deployments on the endpoint, in the `llm-pi-ai` model-entry format; each `id` is sent as the request's `model` |

The models are listed whether or not anyone is signed in. A request while nobody is signed in fails with `LlmError` code `MISSING_CREDENTIAL` and a message naming **Settings → AI Account**; the same code covers an expired sign-in and a Host without Coteccons SSO. After a sign-in in the settings page, the first model becomes the Agent default.

<a id="understand-the-implementation"></a>
## Understand the implementation

The route is one `llm-pi-ai` profile with protocol `openai-completions`, resolved once at load with `resolveProfiles`, so an invalid model entry fails the row. At each model request the adapter calls `ctx.cotecconsSso.getAccessToken(aiScope)` and passes the token as pi-ai's `apiKey` override, which the OpenAI SDK sends as a Bearer credential. pi-ai's own stored logins and environment discovery answer nothing for this route. The route is registered in the configurable-provider directory with an empty settings path, so the Models page lists it without a credential field. No invariant companion is published because the plugin holds no state.

<a id="further-exploration"></a>
## Further Exploration

- [coteccons-sso](../../credentials/coteccons-sso/README.md) — the token source.
- [llm-pi-ai](../llm-pi-ai/README.md) — the adapter, profile resolution, and model-entry fields.
- [Coteccons SSO decision](../../../.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md) — why per-user tokens replace an API key.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-coteccons-sso) — every accepted field.

<a id="model-experience"></a>
## Model Experience

### Authenticated model requests

#### What the model sees

Requests on `coteccons` add no model-visible text from this plugin; the shared `openai-completions` transport serializes requests.

#### Token effect

Authentication adds no input tokens; the selected model and request content determine actual usage.

#### KV Cache effect

Tokens and sign-in state do not enter model input; the protocol transport owns request-prefix serialization.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Access failures surface as provider errors** — a user without an RBAC role on the resource receives Azure's 401 or 403 as an ordinary request failure, not a sign-in prompt.
- **Static catalog** — models are configured, not discovered from the resource.

<a id="dev-note"></a>
### Dev Note

None.
