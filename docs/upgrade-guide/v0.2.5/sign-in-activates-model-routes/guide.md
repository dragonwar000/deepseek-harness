---
kind: upgrade-guide
description: "A sanctioned llm-pi-ai sign-in now registers a provider route on its own, which the new signInRoutes key turns off."
---

# A sanctioned sign-in registers its own model route

English | [中文](guide.zh.md)

## Change

Previously the `@deepseek-ai/dsh-llm-pi-ai` route set came only from its `providers` settings dict: signing in to a provider stored a credential at `llm-pi-ai/<provider id>` and registered nothing, so the model picker stayed empty until a profile named that provider.

Now a **sanctioned** stored credential also activates a route serving that provider's installed pi-ai catalog, authenticated by the stored record. Sanctioned means an API key, or an OAuth grant pi-ai does not mark `isSubscription`. A consumer subscription grant (`anthropic`, `github-copilot`, `kimi-coding`, `meta`, `openai-codex`, `xai`) is never routed; it stays available to delegated Claude Code and Codex runs. Signing out removes the route with the record.

Anyone whose deployment holds `llm-pi-ai` credentials observes this: providers signed into but never declared now appear in the model picker, and `llm.listProviders()` returns them. A profile in `providers` is unaffected — it still wins over activation, with its `displayName`, `models`, and `apiKeyEnv` exactly as before.

## Migration

1. No change is required to keep declared routes working. Verify nothing moved by comparing the picker, or `llm.listProviders()`, against your `providers` keys.
2. To keep `providers` the only source of routes, set the new key in `cordis.yml` or the settings patch for the `llm-pi-ai` entry:

   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       signInRoutes: false
   ```

3. To drop a route a sign-in activated, delete its credential record rather than editing configuration: the Models page's sign-out, or `credentials.deleteRecord('llm-pi-ai/<provider id>')`.
4. Confirm the result with `llm.listProviders()`: with `signInRoutes: false` it lists exactly your `providers` keys; with the default it also lists every provider holding a sanctioned credential.
