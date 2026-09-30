# Agent Note: Coteccons SSO for the Main Model

Status: implemented

English | [中文](2026-09-30-coteccons-sso-entra-main-model.zh.md)

## Problem

CTD Core is a Coteccons-internal product. Its main model runs on a Coteccons Azure AI resource (`ctd-opus-resource`, OpenAI-compatible v1 endpoint), and access must follow the company directory: a staff member who leaves or changes role loses access through Microsoft Entra ID, without anyone rotating a shared key. The inherited DeepSeek Platform sign-in authenticated against DeepSeek's own accounts and billing, which Coteccons does not manage, and a shared Azure API key would give every installation the same unaudited identity.

## Decision

Each user signs in with their own Coteccons Microsoft account, and that user's Entra ID access token calls Azure AI directly as `Authorization: Bearer`. Azure RBAC on the resource authorizes the call; no API key or client secret exists.

`@deepseek-ai/dsh-coteccons-sso` defines `ctx.cotecconsSso`: token-free views (`not-configured`, `signed-out`, `signing-in` with the authorization URL, `signed-in`, `error`), sign-in, cancel, sign-out, watch, and the Host-only `getAccessToken(scope, signal)`. `@deepseek-ai/dsh-coteccons-sso-msal` implements it with `@azure/msal-node` `PublicClientApplication`: the authorization-code flow with PKCE in the system browser, the code delivered by `form_post` to MSAL's loopback listener on `127.0.0.1`, and the sign-in requesting `openid profile offline_access` plus the Azure AI scope (`https://cognitiveservices.azure.com/.default`) so consent is obtained once. The MSAL token cache is persisted through an `ICachePlugin` as one grant record, `coteccons-sso/token-cache`, in the Harness credential store, never in a plain file or a log. `acquireTokenSilent` refreshes access tokens; an interaction-required refresh deletes the record and reports `session-expired`. Sign-out deletes the record. `allowedDomains` optionally restricts the signed-in UPN domain. With `tenantId` or `clientId` unset the provider reports `not-configured` instead of failing boot.

`@deepseek-ai/dsh-llm-coteccons-sso` registers the `coteccons` route as one `llm-pi-ai` `openai-completions` profile (default models `DeepSeek-V4-Pro` and `gpt-5.6-terra`) whose per-request `apiKey` is the SSO token; the OpenAI SDK sends it as a Bearer credential, which the Azure v1 endpoint accepts and Entra tokens require. Models stay listed while signed out, and a request then fails with `MISSING_CREDENTIAL` naming **Settings → AI Account**. `@deepseek-ai/dsh-api-coteccons-sso-controller` exposes the views and commands as the `cotecconsSso` Remote namespace without any token method, and `@deepseek-ai/dsh-client-ui-settings-coteccons-sso` renders the **Coteccons SSO — used for the main model** group first on the AI Account page. A sign-in completed there calls `session.initializeDefaultModel('coteccons')`, which saves the route's first model as the Agent default.

The Web App Bundle mounts the four Host and browser rows, with the public `tenantId` and `clientId` of the CTD-Core app registration on row `coteccons-sso`. DeepSeek Platform sign-in is removed from the shipped composition by disabling rows `deepseek-account` and `llm-deepseek-account` in the base Bundle and `ui-settings-account` and `account-controller` in the Web App Bundle; the packages remain, and a profile patch can re-enable them. `llm-deepseek-api-key` and `llm-pi-ai` routes stay mounted.

The Azure side is a prerequisite, not Harness code: the app registration is a public client with redirect URI `http://localhost` on the "Mobile and desktop applications" platform and public client flows allowed, holds delegated Azure Cognitive Services `user_impersonation` with admin consent, and staff receive "Cognitive Services OpenAI User" on the AI resource.

## Alternatives considered

**A shared Azure API key.** Simplest to wire, but every user shares one identity, revocation means rotating the key everywhere, and the key would sit in every installation's credential store.

**A confidential client or a backend token broker.** It would keep refresh tokens off user machines, but it needs a client secret or a hosted service, which a desktop product installed on staff machines cannot keep private.

**Device-code flow.** It works without a loopback listener, but it asks users to type a code on a second page and is weaker against phishing; the loopback flow completes in one browser tab.

**Hand-rolled OAuth.** It avoids a dependency, but PKCE, the loopback listener, token caching, and refresh are exactly what MSAL maintains.

**Keeping DeepSeek Platform sign-in beside SSO.** It would leave two main-model sign-ins, one outside Coteccons governance, and keep DeepSeek quota and bonus notices that do not apply.

## Consequences

Access to the main model follows the Entra ID account and Azure role assignment, and each Azure request carries the individual user's identity for auditing. Refresh and access tokens live in the local credential store, readable by the same OS user. The browser must run on the Host because the redirect reaches a loopback listener. Users without the RBAC role can sign in but receive Azure's authorization error on requests. DeepSeek account balance, quota, and bonus notices and the Desktop account onboarding are absent from the shipped product. Tests use a fake MSAL client and a local HTTP endpoint; a real sign-in against the Coteccons tenant and a real request to `ctd-opus-resource` remain manual checks.
