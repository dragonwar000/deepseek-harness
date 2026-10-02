---
kind: upgrade-guide
description: AI Account now reads and refreshes registered CLI OAuth credentials by default instead of leaving credential maintenance entirely to the product CLIs.
---

# AI Account OAuth maintenance

## Change

`@deepseek-ai/dsh-ai-account-platform` maintains Claude and ChatGPT subscription OAuth grants in registered account directories or their macOS Keychain items. Status checks and product launches refresh expiring access tokens before starting the official CLI. Credentials remain absent from account views, session logs, and model context. A rejected refresh grant reports the account as signed out; transient failures preserve stored credentials and the last conclusive status.

The provider sends refresh requests to the product token endpoints and replaces rotated tokens in their existing CLI storage. Account metadata and Session formats do not change. Existing registered accounts require no import or migration. Unregistered terminal configuration directories remain untouched.

## Migration

1. To retain exclusively CLI-managed credentials, set `refreshEnabled: false` on the `ai-account` row in the profile's `cordis.patch.yml`. Otherwise refresh is enabled automatically.
2. Adjust `refreshAheadMs`, `refreshTimeoutMs`, and `refreshLockWaitMs` on that row when deployment timing requires it; defaults are five minutes, fifteen seconds, and thirty seconds.
3. Restart the profile, then use **Settings → AI Account → Check sign-in status**. A revoked grant requires a new sign-in; a network failure preserves the previous status and can be retried.

See the [provider reference](../../../../packages/credentials/ai-account-platform/README.md) for credential storage, cancellation, and concurrent CLI limitations.
