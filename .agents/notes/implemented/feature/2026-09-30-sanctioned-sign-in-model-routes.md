# Agent Note: Sanctioned Sign-In Model Routes

Status: implemented

## Problem

Signing in to a provider produced no model. `registerPiAiFlows` offers one authorization flow per installed pi-ai provider and the flow commits a credential record at `llm-pi-ai/<provider id>`, but the route set came only from the `providers` settings dict, so the chat model picker stayed empty until the user also hand-wrote a profile naming the provider they had just signed into. Nothing on the AI Account page explained which accounts could drive the main model at all, so a Claude or ChatGPT sign-in that is deliberately delegated-only looked identical to a sign-in that had simply failed to take effect.

The constraint that shapes the answer is that not every sign-in may drive the main model. A consumer subscription grant is issued to the vendor's own assistant client, and sending it from another HTTP client impersonates that client — the reason [official-CLI AI accounts](2026-09-29-official-cli-ai-accounts.md) removed the token-to-main-model package. So "a sign-in should produce a route" cannot be a blanket rule; the product needs a classification, and the classification has to be visible rather than implied by which packages exist.

## Decision

`packages/llm/llm-pi-ai/src/sign-in.ts` classifies each **stored credential**, not each login method, because the record is what a request would send and a record survives an upgrade that changes the offer. `classifySignIn(provider, kind)` returns a `SignInClass` of `sanctioned`, `delegated-only`, or `unknown-grant` plus the reason a surface may show and, when one exists, the API-key sign-in that reaches the main model instead.

The rule is derived from the installed catalog rather than listed per provider, so a pi-ai upgrade that adds a subscription login is withheld the moment it lands:

| Stored record | Class | Basis |
|---|---|---|
| `api-key` | `sanctioned` | A key the account holder minted in the vendor's console names only the account it bills |
| `grant`, `auth.oauth.isSubscription !== true` | `sanctioned` | A grant the vendor issues to third-party clients |
| `grant`, `auth.oauth.isSubscription === true` | `delegated-only` | A consumer subscription grant issued to the vendor's own assistant client |
| `grant`, no `auth.oauth` on any installed provider | `unknown-grant` | Nothing installed can derive request auth from it |

`resolveSignInRoutes(request): SignInRouteSpec` is the explicit resolve step: it answers permission and catalog membership, and the caller owns precedence. An activated route is the empty profile for its provider — the installed catalog's endpoint, protocol, and models, authenticated by the stored record, because naming no `apiKeyEnv` is exactly what sends pi-ai to its own credential store. The plugin re-reads the credential seam on `credentials/record-updated` (coalesced, so a burst of writes and OAuth refreshes costs one re-registration) and re-registers through the existing `AdapterRegistrationHandle.replace`, so signing in and out moves the picker without a restart and without a settings write. The listener and the activated set live in a `ctx.inject(['credentials'], …)` scope, so a credential plane mounted later still reaches the route set and the activated routes drop when it leaves.

A profile in `providers` always wins: activation only adds a provider the settings document is silent about, so a declared route keeps its `displayName`, narrowed `models`, `apiKeyEnv`, and every other field, and the existing README contract is unchanged. `signInRoutes` (default `true`) is the one new `Config` field, because whether a per-user sign-in may create a route is a deployment fact for an egress allowlist, a billing boundary, or a curated model list — while the classification is a security invariant and stays fixed source.

On the product side, `@deepseek-ai/dsh-client-ui-settings-ai-account` states per group, through its typed dictionary in `en` and `zh`, that these accounts add no chat model, whose client the grant belongs to, and which vendor's API key to add under **Models** instead.

## Classification evidence

pi-ai 0.87.1, as installed. `OAuthAuth.isSubscription` is a documented upstream field — "Whether access through this auth method is backed by a provider subscription" — at `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:206`, which is what makes it a classification input rather than a guess.

Six of the 41 installed providers mark it, and each one's own flow confirms the reading:

- **`anthropic`** — `dist/auth/oauth/anthropic.js:301` `isSubscription: true`, `:13` a base64-obfuscated `CLIENT_ID` (the Claude Code client), `:14` `https://claude.ai/oauth/authorize`. Routing it requires impersonating that client outright: `dist/api/anthropic-messages.js:724` sends `"user-agent": claude-cli/${claudeCodeVersion}`, `:725` `"x-app": "cli"`, `:771` the `claude-code-20250219` and `oauth-2025-04-20` beta flags, and `:821` a `"You are Claude Code, Anthropic's official CLI for Claude."` system block.
- **`openai-codex`** — `dist/auth/oauth/openai-codex.js:427` `isSubscription: true`, `:22` `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (the Codex CLI's client), `:23` `https://auth.openai.com`. The named case in the hard constraint. It is also the one installed provider shipping no `apiKey` method at all, so its substitute is `openai`.
- **`github-copilot`** — `dist/auth/oauth/github-copilot.js:381` `isSubscription: true`, `:8` a base64-obfuscated `CLIENT_ID` (`Iv1.b507a08c87ecfe98`), and `:32` an undocumented internal endpoint, `copilot_internal/v2/token`.
- **`kimi-coding`** — `dist/auth/oauth/kimi-coding.js:237` `isSubscription: true`; a Kimi Code coding subscription.
- **`meta`** — `dist/auth/oauth/meta.js:182` `isSubscription: true`; the device grant mints a key at `https://api.meta.ai/muse-code/key` (`:21`).
- **`xai`** — `dist/auth/oauth/xai.js:182` `isSubscription: true`; `loginLabel` is "Sign in with SuperGrok or X Premium".

The two sanctioned grants:

- **`openrouter`** — `dist/auth/oauth/openrouter.js` sets no `isSubscription`; its PKCE flow exchanges at `https://openrouter.ai/api/v1/auth/keys` (`:18`), an OpenRouter-documented third-party flow that yields an API key.
- **`radius`** — `dist/auth/oauth/radius.js:29` `OAUTH_CLIENT_ID = "pi-gateway"`, pi-ai's own registered client for its own gateway, and no `isSubscription`.

Every other installed provider offers only `auth.apiKey.login` — pi-ai collects the key through its own prompt — and 40 of the 41 ship one, which is why an API key is the alternative for five of the six withheld providers under the same record id.

The classification table is pinned by `packages/llm/llm-pi-ai/tests/sign-in.spec.ts`, so a pi-ai upgrade that changes the subscription set fails a test naming it instead of silently widening what the harness sends.

## Alternatives considered

**Write a `providers` profile on sign-in.** The Models page already writes profiles, so a sign-in could write one too. Rejected: it makes a per-user action edit the deployment's configuration document, sign-out then has to distinguish the profile it wrote from one the user edited, and a single settings key cannot hold both facts.

**Classify the login method instead of the stored record.** Simpler, since `loginMethods()` already separates `oauth` from `api-key`. Rejected: a grant stored by an earlier build outlives the offer that produced it, and only the record says what a request would actually send.

**Enumerate the delegated-only providers as a literal list.** A fixed list reads more directly than a derivation. Rejected on drift: an upstream provider added between releases would default to routable, which is the wrong direction to fail in. The list survives as a pinned test assertion, where being out of date is a failure rather than a silent permission.

**Make the classification configurable.** A deployment might want to route a subscription grant anyway. Refused: it is a security invariant, not a tunable, and no `Config` field may widen what the harness may claim to be.

**Widen `AuthorizationMethod` with the classification.** It would let any surface render the reason from the seam. Rejected: the authorization seam serves other flows (Coteccons SSO, DeepSeek Platform) that have no such notion, and one consumer must not dictate the service contract. The reason travels as product copy in the client package and as exported functions for a surface that wants to compute it.

**Link the AI Account page to the Models page.** The copy names **Models** but cannot navigate there: the settings shell passes `openSection` only to the `settings.onboarding` slot. Plumbing it into `settings.section` would change a shared slot contract for one hint, so the limitation is recorded instead.

## Consequences

A sanctioned sign-in is now enough: the provider's catalog models appear in the chat model picker on the next read, and signing out removes them. The picker already refreshes on `credentials/record-updated`, so no client change was needed for the list to move.

Consumer subscription accounts are unchanged and stay reachable only through delegated Claude Code and Codex runs, and the page now says so with the working alternative beside it. A build whose pi-ai upgrade adds a subscription login withholds it by default.

An activated route serves the whole installed catalog for its provider, which is a longer model list than a curated profile would give; a deployment that wants fewer declares a profile, which takes precedence. Because activation depends on a record rather than a document, the route set is no longer a pure function of configuration — the diagnostic for a withheld sign-in is logged once per record, and the route set is left untouched when the store cannot be read, so a transient failure never ends a session mid-turn.
