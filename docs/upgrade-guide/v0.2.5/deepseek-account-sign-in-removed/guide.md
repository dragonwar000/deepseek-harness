---
kind: upgrade-guide
description: "The shipped compositions disable DeepSeek account sign-in; Coteccons SSO or an API key now supplies the main model."
---

# Coteccons SSO replaces DeepSeek account sign-in

English | [中文](guide.zh.md)

## Change

Previously, Desktop onboarding and Settings offered DeepSeek account sign-in, and the `deepseek-account` model route ran the main model with that account's token. The Web composition also showed the sidebar account menu, quota and bonus notices, and mounted the `account` remote namespace.

Now `@deepseek-ai/dsh-base` sets `disabled: true` on the `deepseek-account` and `llm-deepseek-account` rows, and `@deepseek-ai/dsh-web-app` sets it on `ui-settings-account` and `account-controller`. The rows keep their ids. This affects every profile built on these bundles, including CLI profiles. The main model now comes from one of two sources:

- **Sign in with Coteccons SSO** (Settings → AI Account, or the Desktop welcome window) signs in through Microsoft Entra ID and enables the `coteccons` model route.
- **Add API Key** stores a provider API key; the DeepSeek API-key route `deepseek-official` stays mounted.

The AI Account page also lists Claude and ChatGPT subscriptions. They sign in through the official Claude Code and Codex CLIs and only run delegated Claude Code or Codex tasks; they never supply the main model.

After upgrading, a session or default model on the `deepseek-account` route has no provider, and `account/*` remote calls have no handler. The stored DeepSeek account credential stays in `$DSH_HOME/.credentials.yaml`, unused.

## Migration

1. Open Settings → AI Account and choose **Sign in with Coteccons SSO**, or choose **Add API Key** and enter a DeepSeek Platform API key or another provider's key.
2. Select a model from the `coteccons` route or the provider you added as the default model and in any session that used a `deepseek-account` model.
3. Remove SDK or HTTP callers of the `account` remote namespace; use `cotecconsSso` for sign-in state.
4. To keep DeepSeek account sign-in in a self-managed profile instead, add id-targeted overrides to `$DSH_HOME/profiles/<name>/cordis.patch.yml`: `- id: deepseek-account` and `- id: llm-deepseek-account` with `disabled: false`, and for Web profiles also `ui-settings-account` and `account-controller`. The Desktop welcome window no longer offers DeepSeek account sign-in; sign in from Settings.
5. Confirm: send a message in a new session and check that the reply comes from the selected model without a `MISSING_CREDENTIAL` or `ACCOUNT_SIGN_IN_REQUIRED` error.
