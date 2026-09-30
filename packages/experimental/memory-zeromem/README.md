---
description: "Conversation memory backed by the zeromem zm CLI: each completed turn's user messages and final assistant text are stored per workspace with no model call, and memory_recall and memory_stats search earlier sessions, for users who want the agent to recall what was said in past conversations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-zeromem

English | [中文](README.zh.md)

## Summary

This package gives the agent recall of earlier conversations through [zeromem](https://github.com/ptaranat/zeromem), an MIT-licensed Rust implementation of Zero-Mem whose memory operations make no model calls. When a turn ends, the plugin stores its user messages and final assistant text; tool calls and tool output are never stored. The model searches earlier sessions with `memory_recall` and counts the store with `memory_stats`; with `allowForget`, the approval-gated `memory_forget_session` deletes one session. Every store operation runs the `zm` executable through `ctx.subprocess`. The [knowledge bundle](../knowledge-profile/README.md) carries the row switched off. It is experimental and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Get a zm executable

The plugin needs zeromem's `zm` CLI. Build it from a zeromem checkout:

```sh
git clone https://github.com/ptaranat/zeromem && cd zeromem
cargo install --path crates/zeromem                                   # zm on PATH, semantic embedder
cargo build --release --no-default-features -p zeromem                # or: target/release/zm, hash embedder, offline
```

The default build embeds text with bge-small-en-v1.5 through fastembed and downloads the model (about 130 MB) on first use into the `models` directory of the store root. The `--no-default-features` build has only zeromem's lexical hash embedder and makes no network access; pair it with `embedder: hash`.

### Enable the row

The knowledge bundle inserts the row `memory-zeromem` with `disabled: true`. Enable it from a profile patch; a config patch replaces the whole row config, so restate every field you keep:

```yaml
- id: memory-zeromem
  disabled: false
  config:
    zmPath: zm
    embedder: default
    scope: workspace
    excludeCurrentSession: true
    ingestSubagentSessions: false
    allowForget: false
    defaultResults: 5
    maxResults: 10
    maxTurnChars: 2000
    maxIngestChars: 16000
    timeoutMs: 120000
    graceMs: 2000
    maxConcurrent: 1
```

Outside the bundle, mount `@deepseek-ai/dsh-experimental-memory-zeromem` after the tool registry, the subprocess provider, and the session projection service.

| Field | Default | Meaning |
|---|---|---|
| `zmPath` | `zm` | `zm` executable: a name on `PATH` or an absolute path |
| `zmArgs` | none | Arguments placed before zeromem's own, for a `zm` run through an interpreter |
| `embedder` | `default` | `default` lets `zm` choose its embedder; `hash` passes `--no-model`, zeromem's lexical hash embedder |
| `scope` | `workspace` | `workspace` keeps one store per session working directory; `global` shares one store across workspaces |
| `storeRoot` | empty | Absolute directory, or one starting with `~`, that holds the stores; empty selects `<harness home>/zeromem` |
| `excludeCurrentSession` | `true` | Leave the calling session's turns out of `memory_recall` results |
| `ingestSubagentSessions` | `false` | Store turns of subagent child sessions too |
| `allowForget` | `false` | Register the approval-gated `memory_forget_session` tool |
| `defaultResults` | `5` | Turns `memory_recall` returns without a `limit` |
| `maxResults` | `10` | Largest `limit` of `memory_recall` |
| `maxTurnChars` | `2000` | Characters of text per recalled turn |
| `maxIngestChars` | `16000` | Characters stored per message |
| `timeoutMs` | `120000` | Deadline of one `zm` operation, including the ingestion of pending turns |
| `graceMs` | `2000` | Grace before a terminated `zm` is killed |
| `maxConcurrent` | `1` | Concurrent `zm` processes |

Loading fails with a named error when `zm` cannot be found (`ZeromemExecutableError`, which says how to install zeromem), when `storeRoot` is not absolute, or when `defaultResults` exceeds `maxResults`. A `zm` that fails, times out, or answers as another program makes the tool call fail with a `ZeromemProcessError` carrying the `zm` stderr tail; recall never falls back to an empty result. When `zm` reports its lexical fallback embedder while `embedder` is `default`, the plugin logs one warning.

### What is stored, and where

The plugin stores, verbatim and unencrypted, the text of each human user message and of the last assistant message of each completed turn, each cut to `maxIngestChars` characters. It never stores tool calls, tool results, reasoning, injected context, or subagent sessions (unless `ingestSubagentSessions`). With the `workspace` scope, a session's store is `<storeRoot>/workspaces/<first 16 hex digits of the SHA-256 of its working directory>`; with the `global` scope it is `<storeRoot>/global`. Each store holds `zeromem.db` (SQLite, written by `zm`), `spool/` (turn files waiting for ingestion), `dsh-forgotten/` (sessions deleted by `memory_forget_session`), and a `models` link to the shared model cache. The plugin creates directories owner-only and spool files with mode `0600`. A user message can contain secrets the user typed; delete a store directory to delete its memory. Sessions without a working directory are not stored under the `workspace` scope, with one warning per session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Ingestion

The `zeromemTurn` projection folds the open turn's human `user/message` texts and its last uninterrupted assistant text, and keeps the last completed turn. On `turn/end` the plugin writes that turn as one spool file in zeromem's spool format: one JSON line `{session_id, speaker, text, ts, uuid}` per text, with `ts` in epoch seconds and `uuid` `dsh:<session id>:<event seq>`. The file is written under a temporary name and renamed into `spool/`, so `zm` never reads a partial file. Writes run one at a time, off the model request path, and never start `zm`. `zm` ingests every pending spool file before each operation and skips a line whose `uuid` it already stored, so ingestion is idempotent.

Each plugin instance keeps the number of the last turn it spooled per session. On `turn/start` it also spools the last completed turn when that number is lower, which stores a turn whose ingestion a previous process did not finish once the resumed session starts its next turn; when the previous process had spooled it, zeromem drops the duplicate by `uuid`. A failed spool write is logged and retried at the next turn boundary of the session. Events inherited from a fork parent are not stored under the child's id. A session marked in `dsh-forgotten/` is not spooled again.

### Store operations

Each tool call starts one `zm [--no-model] mcp --home <store>` process through `ctx.subprocess` in the store directory, sends MCP `initialize`, `notifications/initialized`, and one `tools/call` (`zeromem_recall`, `zeromem_stats`, or `zeromem_forget_session`), closes stdin, and reads the answers. The plugin verifies that the server names itself `zeromem`, waits for spool writes queued before the call, and bounds the process by `timeoutMs`, the call's cancellation, and plugin disposal; at most `maxConcurrent` processes run at once. `memory_recall` passes the calling session's id as `exclude_session` when `excludeCurrentSession` is on. `memory_forget_session` refuses the calling session, asks the user through `tools/pre-execute` as the outermost listener, and marks the deleted session forgotten after `zm` reports the deletion.

### Design notes

- **Separate capability, not a knowledge provider.** `ctx.knowledge` serves wiki pages with ids, relations, and citations of workspace reads; zeromem stores conversation turns. The package is a function plugin with its own tools and no Service Definition, because it has a single consumer.
- **One process per operation.** A long-lived `zm mcp` would keep the index and embedder resident; a process per call keeps no idle process and no cross-call state, at the cost of an index rebuild from `zeromem.db` on every call.
- **Spool instead of `zm ingest`.** `zm ingest` opens the store and rebuilds its index for every file and does not deduplicate; the spool protocol lets turn end write a file without starting `zm` and gives `uuid` deduplication.
- **No prefetch.** Recalled text enters a request only as a tool result, which the session log already records; no new session event exists.
- **No `./invariant` companion.** No invariant companion is published because the plugin owns no relationship between two independent observations: the store is external, and the session log holds every model-visible value as ordinary tool results.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, load-time `zm` lookup, the ingestion listener, the tools, and the forget approval |
| [`src/fold.ts`](src/fold.ts) | The `zeromemTurn` projection fold |
| [`src/store.ts`](src/store.ts) | Store resolution, directory preparation, spool files, and forgotten markers |
| [`src/zm.ts`](src/zm.ts) | One `zm mcp` operation through the subprocess seam |
| [`src/results.ts`](src/results.ts) | Validation and conversion of zeromem results |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge bundle](../knowledge-profile/README.md) — the bundle that carries this row switched off.
- [Episode distillation](../memory-distill/README.md) — the other memory row, which writes verified turns as knowledge pages.
- [zeromem](https://github.com/ptaranat/zeromem) — the `zm` CLI, its MCP tools, and its spool protocol.
- [Placement decision](../../../.agents/notes/implemented/architecture/2026-09-30-zeromem-conversation-memory.md) — why this is a separate tool plugin with a per-workspace store.

-----

<a id="model-experience"></a>
## Model Experience

### The memory_recall tool

#### What the model sees

While the plugin is mounted, the model is offered [`memory_recall`](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-memory-zeromem) with a required `query` string and an optional integer `limit` from 1 to `maxResults`. The description names the store scope (`in this workspace` or `in any workspace`) and whether the current session is left out or included. The result is compact JSON `{"turns":[{"session","time","speaker","text","kind","truncated"?}]}`, where `time` is ISO 8601 UTC, `kind` is `match` or `context`, and `truncated` marks text cut to `maxTurnChars`. A blank query, a `limit` outside the range, a store the session cannot use, and a `zm` failure are tool errors.

##### Verbatim text for this field

```markdown
Search what the user and you said in earlier sessions in this workspace. Returns the most relevant stored turns, each with its session id, time, speaker (user or assistant), text, and kind: match answers the query, context is linked to a match. Only user messages and final assistant replies are stored, never tool calls or tool output; the current session is left out. Recalled text records what was said then: verify it against the current files before relying on it.
```

#### Token effect

Always-on while mounted: the tool definition is about 180 tokens in every request (its serialized definition is 788 characters, estimated at the 4.4 characters per token that the knowledge tool figures use). Each call adds about 25 tokens per turn plus the turn text, at most `maxTurnChars` characters per turn and `maxResults` turns.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The memory_stats tool

#### What the model sees

While the plugin is mounted, the model is offered [`memory_stats`](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-memory-zeromem) with no parameters and the description below. The result is `{"turns","sessions"}` for the store the calling session uses.

##### Verbatim text for this field

```markdown
Count the stored turns and sessions that memory_recall searches.
```

#### Token effect

Always-on while mounted: the tool definition is about 40 tokens in every request. Each call adds a result of about 10 tokens.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The memory_forget_session tool

#### What the model sees

With `allowForget: true`, the model is offered [`memory_forget_session`](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-memory-zeromem) with a required `session` string and the description below. The user is asked before every call. The result is `{"session","deletedTurns"}`; the current session, a blank id, a rejected approval, and a `zm` failure are tool errors.

##### Verbatim text for this field

```markdown
Permanently delete every stored turn of one earlier session, named by the session id memory_recall returned. Use only when the user asks to forget that session; the user approves every deletion. The current session cannot be deleted, and later turns of a deleted session are not stored.
```

#### Token effect

Present only with `allowForget: true`: the tool definition is about 120 tokens in every request. Each call adds a result of about 15 tokens.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External executable** — the user installs `zm`; the harness neither ships nor downloads it, and a missing `zm` fails the row at load.
- **Spool format coupling** — ingestion writes zeromem's internal spool files, which zeromem does not document as a stable interface; the real-binary test (`tests/real-zm.e2e.ts`, run with `DSH_ZEROMEM_ZM` set to a `zm` path) checks compatibility with a given zeromem build.
- **Plain-text store** — stored turns are raw, unencrypted text on disk; the only deletions are `memory_forget_session` and removing the store directory.
- **Index rebuilt per call** — each operation starts `zm`, which rebuilds its index from `zeromem.db`, and with the default embedder loads the model; calls on a large store take longer than a resident server would.
- **Pending turns count on the next call** — turns spooled since the last operation are ingested by the next `zm` process, so the first call after many turns also pays their ingestion within `timeoutMs`.
- **Resumed turns stored at the next turn** — a turn whose spool write did not finish before the process stopped is stored when the resumed session starts its next turn; a session never resumed keeps that turn out of memory.
- **Forget races an open session** — a session open in another process while it is deleted may store one more turn before that process sees the forgotten marker.
- **No prefetch and no zeromem tuning** — evidence enters the context only through `memory_recall`; zeromem's `gamma` and `rho` stay at the paper defaults because `zm` exposes no option for them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `zm` protocol and spool format were read from zeromem commit `eda2126`.

</details>
