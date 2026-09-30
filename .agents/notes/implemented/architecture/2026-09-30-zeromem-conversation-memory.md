# Agent Note: Conversation memory through zeromem is a separate tool plugin with a per-workspace store

Status: implemented

## Problem

A new session forgets what the user and agent said in earlier sessions of the same project. zeromem (MIT, Rust, Zero-Mem) indexes raw conversation turns and retrieves them with no model call, but its store holds raw conversation text on disk.

## Decision

`@deepseek-ai/dsh-experimental-memory-zeromem` is a standalone function plugin, carried by the knowledge bundle as a sixth row with `disabled: true`; it is not a `ctx.knowledge` provider, because that seam serves curated pages whose writes must cite workspace reads, while turns cite nothing. It drives the real `zm` binary through `ctx.subprocess` (one `zm mcp` process per operation) and never reimplements zeromem. At `turn/end` it spools only human messages and the final assistant text, keyed `dsh:<session>:<seq>` so zeromem drops duplicates; tool calls and output are never stored. The default store is one per workspace under the harness home, outside the repository, and `memory_recall` excludes the calling session. Recalled text reaches the model only as a tool result, so no new session event is needed.

## Alternatives considered

A second `KnowledgeService` provider would present conversation as curated pages; porting zeromem to TypeScript would duplicate maintained code; `zm ingest` does not deduplicate; a global default store would mix unrelated projects and their secrets; storing tool output would copy file contents and credentials; prefetch at turn start is deferred until it has its own session event.

## Consequences

Recall costs about 220 tool-definition tokens per request and no model call. The user installs `zm`, and zeromem's spool format is not a documented stable interface, so a real-binary test (`DSH_ZEROMEM_ZM`) guards compatibility. Stored turns are plain text; deleting the store directory or `memory_forget_session` are the only deletions.
