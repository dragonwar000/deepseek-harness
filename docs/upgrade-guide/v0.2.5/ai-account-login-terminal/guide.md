---
kind: upgrade-guide
description: "AI Account sign-in now runs the official CLI on a terminal and needs the authorization code, and `AiAccount` gains `submitSignInCode`."
---

# AI Account sign-in completes with an authorization code

English | [中文](guide.zh.md)

## Change

Adding a Claude or ChatGPT account previously ran the official login command with its standard input on `/dev/null`. Both commands render a terminal interface and read their confirmation from it, so the login printed its URL, never received an answer, and the attempt ended only at `loginTimeoutMs` — 15 minutes later — with nothing stored. The login command now runs on a terminal.

Everyone adding a Claude account observes the new step: **Settings → AI Account → Add Claude account** shows an **Authorization code** field, and the sign-in completes when the code the browser page ends on is pasted there. ChatGPT's device flow polls for authorization and is unchanged.

Three API surfaces change for anyone implementing or calling them:

- `AiAccount` gains the abstract method `submitSignInCode(id, code)`, so every implementation must define it.
- `AiAccountSignInView` gains the required field `awaitingCode`, so every constructed view must set it.
- `AiAccountSignInError` gains `store-failed`, reported when the CLI signed in but the account could not be recorded; that case previously reported `login-failed`.

The `aiAccount` Remote namespace gains `submitSignInCode(attemptId, code)`. The provider also accepts `loginRows`, `loginCols`, and `loginTerminalType`.

## Migration

1. No change is needed to sign in: open **Settings → AI Account**, choose **Add Claude account**, finish in the browser, then paste the code it shows into **Authorization code** and press Enter. Confirm the account appears in the Claude group with a **Default** badge, and that `<Harness home>/ai-accounts/accounts.json` exists.
2. Implementers of `AiAccount` (`@deepseek-ai/dsh-ai-account`): add `submitSignInCode(id, code)`, deliver the code to the login command, and leave state unchanged for a stale id. Set `awaitingCode` on every `AiAccountSignInView` you construct.
3. Readers of `errorCode`: handle `store-failed` alongside `login-failed`. A dictionary keyed by `AiAccountSignInError` fails to compile until the new member has an entry.
4. Confirm with `pnpm run typecheck`; an unimplemented abstract method or an unset `awaitingCode` fails there.
