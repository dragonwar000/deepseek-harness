# Agent Note: Consumer Subscription Account for the Main Model

Status: proposed

English | [中文](2026-09-30-subscription-account-main-model.zh.md)

## Problem

The repository owner wants a signed-in consumer subscription account — Claude Pro or Max, ChatGPT or Codex — to drive the main chat model, not only delegated Claude Code and Codex runs. The [official-CLI AI Accounts decision](../../implemented/feature/2026-09-29-official-cli-ai-accounts.md) refused exactly that: it removed the token-to-main-model package from every composition and left each subscription reachable only by launching the vendor's own CLI against a registered configuration directory. None of the external facts behind that refusal have changed; the owner has changed the answer.

## Proposal

On 2026-09-30 the repository owner decided to allow a signed-in consumer subscription account to serve the main chat model, reversing the main-model half of the [official-CLI AI Accounts decision](../../implemented/feature/2026-09-29-official-cli-ai-accounts.md). That note's other decisions stand unchanged — the AI Account as a registered official-CLI configuration directory, one directory per account, metadata-only storage, and delegation through the Claude Code and Codex provider Bundles — and its recorded rationale, alternatives, and consequences stay as written; it carries a reciprocal link to this note beside its status.

No implementation exists as of this note. No package, Profile row, Config field, credential-store record, or test routes a subscription OAuth token to the main model, and the packages the earlier decision removed have not been restored. What follows records the decision, what implementing it would require, and what the owner accepts.

Implementing it would require the Harness to read a long-lived OAuth grant issued to another client out of that CLI's private storage, hold it, and refresh it against the vendor's token endpoint. Two copies of that grant would then exist to revoke — the official CLI's and the Harness's — and revoking one leaves the other working.

## Unchanged external facts

A consumer subscription login is an OAuth grant issued to the vendor's official CLI, Claude Code or Codex, and not to the subscriber or to an arbitrary HTTP client. Serving the main model from that grant therefore requires every request to present that CLI's client identity.

`@earendil-works/pi-ai` records what that identity is. In `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`, the `anthropic-messages` OAuth-token path sends `user-agent: claude-cli/<version>` and `x-app: cli`, adds the `claude-code-20250219` and `oauth-2025-04-20` beta features, and prepends a system block reading "You are Claude Code, Anthropic's official CLI for Claude." ahead of the request's own system text. The API-key path sends none of them. These are pinned literals in a third-party dependency, not a documented vendor API.

## Alternatives considered

**Keep the delegated-only decision.** Subscription credentials never pass through Harness code, logs, or storage, each login stays revocable in one place, and none of the risks below arise; that is why the earlier note chose it. It lost because it leaves the main chat model on some other route, which is the one thing the owner wants the subscription to do.

**Run the main model on an Anthropic or OpenAI API key.** A key is issued to its holder, presents no other client's identity, conflicts with no subscription terms, and needs no private storage; `@deepseek-ai/dsh-llm-pi-ai` already carries the `anthropic-messages` and `openai-completions` routes that would serve it. It lost because it does not use the subscription the owner already holds, which is the point of this decision.

**Ship the capability off by default behind an explicit opt-in Config field.** An off-by-default field confines the risk to installations that turn it on, and this repository requires a validated Config field for any deployment-varying choice, so it is a condition on implementation rather than an alternative to the decision. It lost as an answer to the risks below: the field decides who turns the capability on, not whether a request presents another client's identity and not whether the subscription terms are conflicted.

## Acceptance criteria

No implementation exists, so nothing verifies this decision today. That is the coverage gap this note names: the reversal is recorded and unbuilt, and shipped behavior is still the delegated-only behavior the earlier note describes.

If the decision is implemented, done means:

- A validated `Config` field on the owning plugin, default off, gates the route; with the field off no subscription-backed main-model route is registered, and unit tests pin both states.
- With the field on and no signed-in account of that kind, a main-model request fails loud with a named missing-credential error rather than falling back to another route.
- The grant never appears in a session log, transcript, spill file, deliverable, or error message, asserted for a successful request and for a failed refresh.
- The OAuth path's leading system block is a model-visible input, so a session event carries it, a keyless recorded-session snapshot covers it, and both SDKs' expected outputs update in the same change.
- The opt-in surface states, where the user turns it on, that requests will present the vendor's official-CLI identity and that the account at risk is the user's own.
- An [upgrade guide](../../../skills/dsh-create-upgrade-guide/SKILL.md) entry records every externally perceptible change, including any settings-page or default-model change.
- A real sign-in and a real main-model request on a live subscription account remain manual checks; they are not automated, and CI does not exercise them.

## Risks

Presenting a third-party client as the vendor's first-party CLI is the core of what the owner accepts: every request asserts in its user-agent, `x-app` header, beta features, and leading system block that it is the vendor's official CLI, and that assertion is false.

The capability conflicts with the consumer subscription terms of both vendors, which cover use of the subscription through the vendor's own clients. The account exposed is the user's own, so the realistic penalty is suspension or termination of that subscription account and of whatever else is tied to it; the Harness holds no account of its own to absorb it.

The path depends on the official CLI's private token storage and on client identifiers that no vendor documents. Either can change at any time without notice, so the capability can break on any CLI or API update, including mid-session and including an update the user did not choose.

The Harness becomes a holder and refresher of a long-lived grant issued to another client. Two copies of that grant then exist to revoke, and revoking the CLI's copy does not stop the Harness's.

What the owner buys in exchange is the already-paid subscription serving the main chat model inside the Harness's own agent loop, with no separate per-token API billing and no delegation to a Claude Code or Codex child process.

This note authorizes nothing about other vendors' sanctioned third-party sign-ins. The main model's own sign-in is a separate decision — [Coteccons SSO for the main model](../../implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md) — and adding, changing, or removing a sanctioned route stays outside this note.
