---
kind: upgrade-guide
description: "`AiAccount` gains `checkStatus`, every `AiAccountView` carries a required sign-in `status`, and the platform provider now runs periodic status checks."
---

# AI Account views carry a sign-in status

## Change

The AI Account provider previously ran an account's official CLI status command only while adding the account, so an account whose CLI later signed out still looked usable. The `ai-account-platform` provider now runs every account's status command at start and every `statusCheckIntervalMs` (5 minutes by default), and records the answer.

Three API surfaces change for anyone implementing or reading them:

- `AiAccount` (`@deepseek-ai/dsh-ai-account`) gains the abstract method `checkStatus()`, so every implementation must define it.
- `AiAccountView` gains the required field `status: AiAccountStatusView` (`status` of `signedIn`, `signedOut`, or `unknown`; `checkedAt`; `message`), so every constructed view must set it.
- The event `ai-account/status-changed` carries an `AiAccountStatusChange` once per status transition.

The `aiAccount` Remote namespace gains `checkStatus()` and the stream `watchStatusChanges`. The provider accepts `statusCheckIntervalMs`, `statusCheckTimeoutMs`, and `statusCheckConcurrency`.

## Migration

1. Implementers of `AiAccount`: add `checkStatus()`, returning the snapshot after the check settles, and set `status` on every `AiAccountView` you construct; `{ status: 'unknown', checkedAt: null, message: null }` states that no check has answered.
2. Deployments that must not run the official CLIs periodically: set `statusCheckIntervalMs: 0` on the `ai-account` row in `cordis.yml`. Any other value must be at least `30000`.
3. Confirm with `pnpm run typecheck`; an unimplemented `checkStatus` or an unset `status` fails there. At runtime, `aiAccount.getState()` returns `signedIn` or `signedOut` for each account shortly after start unless periodic checks are disabled.
