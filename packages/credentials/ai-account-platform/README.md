---
description: "AI Account provider that signs Claude and ChatGPT subscription accounts in, identifies them, and signs them out only by running the official Claude Code and Codex CLIs against one configuration directory per account."
kind: "package-reference"
---

# @deepseek-ai/dsh-ai-account-platform

English | [中文](README.zh.md)

## Summary

Mount this provider to give `ctx.aiAccount` real accounts. Adding an account runs the official login in a new configuration directory, reading the identity runs the official status command there, and removing an account runs the official logout there before deleting the directory. The provider stores only account metadata; it never reads, copies, refreshes, or stores the credentials the CLIs keep.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The base Bundle mounts the provider as row `ai-account`. Its configuration:

| Field | Default | Meaning |
|---|---|---|
| `root` | `<Harness home>/ai-accounts` | Directory holding `accounts.json` and the per-account CLI directories |
| `claudeCliPath` | `claude` | Claude Code executable: absolute path or bare name resolved from `PATH` |
| `codexCliPath` | `codex` | Codex executable: absolute path or bare name resolved from `PATH` |
| `loginTimeoutMs` | `900000` | Deadline for one login including user authorization (1 s–30 min) |
| `commandTimeoutMs` | `15000` | Deadline for one status or logout command (1–120 s) |
| `graceMs` | `2000` | Grace between termination tiers when a CLI command is cancelled |
| `loginRows` | `40` | Rows of the terminal allocated for the login command (1–1000) |
| `loginCols` | `200` | Columns of that terminal (40–1000); a narrow terminal can wrap the URL the CLI prints |
| `loginTerminalType` | `xterm-256color` | `TERM` advertised to the login command; the Host must have its terminfo entry |
| `statusCheckIntervalMs` | `300000` | Interval between periodic sign-in status checks; `0` disables them, otherwise at least 30 s |
| `statusCheckTimeoutMs` | `15000` | Deadline for one account's status command during a status check (1–120 s) |
| `statusCheckConcurrency` | `2` | Status commands one status check runs at the same time (1–8) |

| Kind | Account directory | Login | Identity | Sign-out |
|---|---|---|---|---|
| `claude` | `<root>/claude/<id>` as `CLAUDE_CONFIG_DIR` | `claude auth login --claudeai` | `claude auth status --json` | `claude auth logout` |
| `chatgpt` | `<root>/codex/<id>` as `CODEX_HOME` | `codex login --device-auth` | `codex login status` | `codex logout` |

The login command runs on a terminal, not on pipes. Both official login commands render a terminal interface and read their confirmation from it, so with standard input on `/dev/null` they print their URL and then wait for an answer that can never arrive — the attempt could only end at `loginTimeoutMs`. Only the login command gets a terminal; the status and logout commands are non-interactive and keep their pipes.

The login command's output is scanned for the first `https://` URL, and for ChatGPT the one-time device code printed after it; both appear in the attempt view. The Claude browser page ends on an authorization code, so a Claude attempt reports `awaitingCode` and completes when `submitSignInCode` writes that code to the login command's terminal; the code is passed straight through and is never stored, logged, or matched against the CLI's output. ChatGPT's device flow polls for authorization and reads nothing, so it never reports `awaitingCode`.

A zero exit alone does not add an account: the status command must report a signed-in account, otherwise the provider runs the logout command, deletes the directory, and fails the attempt with `identity-unavailable`. A failure to record the account is reported as `store-failed` rather than `login-failed`, because the vendor did sign in and only this Harness's own write failed; the provider then runs the logout command so the discarded directory cannot keep a credential no account record points at. Every attempt that does not succeed deletes its directory, and also the `<root>/<kind>/` directory that held it when no other account of that kind remains, so an empty kind directory never looks like a registered account.

A sign-in status check runs every registered account's status command against its directory and records the answer in the account's `status` view: `signedIn`, or `signedOut` with the first line the CLI printed. The provider runs one check when it starts and one every `statusCheckIntervalMs`, and `checkStatus()` runs one on demand; a check requested while another runs joins it, so checks never overlap. Output that states neither answer, a missing executable, a failed command, and a command stopped by `statusCheckTimeoutMs` or unload leave the recorded status unchanged. Each transition, including the first answer after `unknown`, emits `ai-account/status-changed` once. Status lives in memory only, so every account is `unknown` until the first check after start; a newly added account starts `signedIn` because its identity read is a status answer. The check only runs the status command: it never reads, copies, or refreshes the stored credentials, and it never signs an account back in.

<a id="understand-the-implementation"></a>
## Understand the implementation

`accounts.json` holds `version`, the account records (`id`, `kind`, `email`, `plan`, `createdAt`), and one optional default id per kind. It is replaced through a temporary file and rename, and it is validated when the provider starts: an unreadable file, a non-UUID id, a duplicate id, or a default that names no account of its kind fails the provider instead of being repaired. Account ids are Host-minted UUIDs because they name directories. Mutations run one at a time, and each change is published and announced only after the file is written. The CLI child environment is the subprocess seam's credential-scrubbed parent environment plus the one directory variable. No invariant companion is published because the provider's state has a single owner.

<a id="further-exploration"></a>
## Further Exploration

- [ai-account](../ai-account/README.md) — the Service Definition and views.
- [subagent-ai-account](../../subagent/subagent-ai-account/README.md) — runs the product subagent providers as the default accounts.
- [Official-CLI AI accounts decision](../../../.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md) — why the provider never touches tokens.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-ai-account-platform) — every accepted field.

<a id="model-experience"></a>
## Model Experience

None, as AI Account management registers no model context or tools; subscription credentials stay inside the official CLIs.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Login runs on the Host** — the Claude CLI opens the browser on the Host machine; a remote browser user opens the surfaced URL instead and pastes the resulting code back through the attempt view.
- **One login attempt at a time, and no view of its terminal** — the provider surfaces only the URL, the device code, and `awaitingCode`; a login command that asks anything else on its terminal cannot be answered, and the attempt ends at `loginTimeoutMs`.
- **CLI output formats are not versioned** — URL and device-code extraction and the Codex status text match current official CLI output; a changed format can leave `url` or `userCode` empty, fail identity, or leave status checks inconclusive.
- **Status checks report what the CLI reports** — a status command may answer from the credential the CLI stores without contacting the vendor, so a subscription revoked on the vendor's side can read `signedIn` until the CLI itself notices.
- **Interrupted logins can leave directories** — a Host crash during login leaves its directory under `root` without an account record; such directories are not cleaned up.
- **A rejected authorization code ends the attempt** — the CLI exits non-zero on a code it refuses, which the provider reports as `login-failed`; the user starts a new attempt rather than retyping into the same one.

<a id="dev-note"></a>
### Dev Note

None.
