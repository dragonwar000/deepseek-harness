# Agent Note: Conversation memory through zeromem is a separate tool plugin with a per-workspace store

Status: implemented

## Problem

A new session starts without the decisions, preferences, and facts stated in earlier sessions of the same project. The knowledge store keeps curated pages that cite workspace reads, and `memory-distill` turns verified, file-changing turns into episode pages; neither keeps what the user and the agent said in ordinary turns. zeromem (MIT, a Rust implementation of Zero-Mem, arXiv:2607.29377) indexes raw conversation turns and retrieves them with no model call, but its store holds raw conversation text, so the integration decides what reaches the store, where the store lives, and how the model reads it.

## Decision

`@deepseek-ai/dsh-experimental-memory-zeromem` is a function plugin that owns its capability end to end. It is not a second `ctx.knowledge` provider and defines no Service Definition. The knowledge bundle carries it as a sixth row with `disabled: true`, so enabling Knowledge on the Plugins page does not enable it; a profile patch does.

- **Placement.** `KnowledgeService` serves pages addressed by id, with titles, types, relations, staleness, and citations of workspace reads; its write path refuses a page without a citation. zeromem stores turns addressed by session and time, has no pages or relations, and its evidence cites nothing in the workspace. Mapping turns onto pages would make every `knowledge_*` tool and the index message treat unverified conversation as curated knowledge. The package name puts it beside `memory-distill` as the second memory mechanism and names its vendor.
- **zeromem is driven, not reimplemented.** Every store operation runs one `zm [--no-model] mcp --home <store>` process through `ctx.subprocess` (the same route `llm-claude-cli` uses for an external CLI) and calls one of zeromem's MCP tools. `zmPath` resolves at load; a missing `zm` fails the row with `ZeromemExecutableError`, and a failing `zm` fails the tool call with `ZeromemProcessError` and its stderr tail.
- **Ingestion without `zm`.** At `turn/end` the plugin writes the turn's human `user/message` texts and its last uninterrupted assistant text as one file in zeromem's spool format, with `uuid` `dsh:<session id>:<event seq>`. `zm` ingests pending spool files before every operation and skips a `uuid` it already stored, so re-spooling is harmless. The plugin keeps the last spooled turn per session in memory and re-spools the last completed turn at the next `turn/start` when it has no record of it, which covers a turn whose write a previous process did not finish.
- **Privacy default.** Only human messages and final assistant text are stored; tool calls and tool output, which carry file contents and command output, are never stored, and subagent sessions are skipped by default. The default scope is one store per session working directory under `<harness home>/zeromem/workspaces/<hash>`, outside the workspace, so the text cannot be committed with the project and a session recalls only its own workspace's conversations. `scope: global` shares one store. `memory_recall` leaves the calling session out, which the Claude Code integration of zeromem cannot do because its MCP server receives no session identity.
- **Model surface.** `memory_recall` and `memory_stats` are always registered; `memory_forget_session` exists only with `allowForget` and always asks the user. Recalled text reaches the model only as a tool result, so the session log already records it and no session event, persistence record, or format change is needed. Prefetch into context is not implemented.

## Alternatives considered

- **Second `KnowledgeService` provider.** Rejected for the placement reasons above: the seam's write path requires workspace citations a turn cannot supply, and its consumers would present conversation as curated pages.
- **Port zeromem to TypeScript.** Rejected: NER, personalized PageRank, BM25, fusion, and embeddings would be owned code and tests that the maintained Rust implementation already provides.
- **`zm ingest` at turn end.** Rejected: it opens the store and rebuilds the index per call, may load the embedding model at every turn, and does not deduplicate, so a retried or resumed turn would be stored twice.
- **A long-lived `zm mcp` server.** Deferred: it would keep the index and model resident and answer faster, but adds a lifecycle to supervise and restart; one process per operation keeps no idle process and no cross-call state.
- **Global store as the default.** Rejected as the default: it mixes conversations from unrelated projects, including their secrets, into every workspace's recall. It remains a configuration choice.
- **Store tool output.** Rejected: tool results carry file contents, command output, and credentials that the user never chose to repeat, and they dominate the text volume.
- **Prefetch evidence at turn start.** Deferred: a model-visible input needs its own session event and persistence record, and the tool already gives the model recall on demand.

## Consequences

The agent can recall what was said in earlier sessions of a workspace at a cost of about 220 tool-definition tokens per request and no model call for storage or retrieval. The user must install `zm`, and with its default build the first operation downloads an embedding model into the shared `models` directory of the store root. Ingestion depends on zeromem's spool files, which zeromem does not document as a stable interface; a test against a real `zm` build (`DSH_ZEROMEM_ZM`) checks compatibility. Each operation rebuilds zeromem's index from its database. Stored turns are plain text on disk: deleting a store directory or calling `memory_forget_session` are the only deletions, and a forgotten session is marked so later turns of it are not stored again. The related [recallable compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md) concerns history of the current session and is unaffected.
