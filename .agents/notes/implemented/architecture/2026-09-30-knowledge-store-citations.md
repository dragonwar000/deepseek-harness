# Agent Note: Knowledge store pages change only through citation-checked writes

Status: implemented

English | [中文](2026-09-30-knowledge-store-citations.zh.md)

## Problem

Knowledge that outlives a session is read by later sessions as if it were true. A page written from a tool output that carried an instruction, a guess, or a statement meant only for one session becomes a durable, trusted input: memory poisoning. The loop layer judges one turn; nothing constrained what may enter durable knowledge, what reaches the model from it, or how a stored relation stays true when the pages or code it names change.

## Decision

`@deepseek-ai/dsh-experimental-knowledge` defines the `ctx.knowledge` seam. Every write goes through `KnowledgeService.write` with a citation: the successful `tool/result` events of the session the page is based on and the workspace files they read or changed. The wiki filesystem provider checks the store rules on every write — content directories, read-only directories, frontmatter with a type, an Origin section, a citation, existing relation targets, and no new dependency on a superseded page — and returns a refusal instead of writing. `knowledge_write` cites the session's successful reads of the named sources and always asks the user. `@deepseek-ai/dsh-experimental-knowledge-rules` refuses every file tool write, edit, and shell command that would change the store directly, because such a change cannot cite session events. Every applied `knowledge/write` record is checked at append time against the session's successful tool results.

Edges, staleness, and ranking are derived from the stored files on every read and never stored: body links, declared relations, and `touches` edges to code paths that exist; a page is stale one relation deep when a page it relates to is newer or superseded. The model receives the store's index, never page content, as a capped snapshot message at the first step of a turn when the index changed, recorded as `knowledge/inject`; content arrives only through `knowledge_read`. Episode pages are distilled without a model, only after the verifier gate records verdict `ok` for the turn's final response, and cite the tool results that changed the turn's files.

## Alternatives considered

- **Check page content in the filesystem write intent.** The intent events carry the target but not the content, and a raw file write cannot name the session events it came from. Refusing direct writes and checking content in the store's own write path enforces the same rules without guessing.
- **Store derived edges and staleness.** A stored `touches` edge or stale flag stops updating the moment it is written. Deriving them on every read costs a full read of the store, bounded by `maxPages`, and cannot drift.
- **Put the index in the system prompt.** The system prompt is one rendered node; changing it with every store change rewrites the reusable prefix. An appended snapshot message costs tokens only when the index changed.
- **Extract relations with a model.** Extracted relations cannot be reproduced from the log and would make every page depend on a model call. Relations come from links, frontmatter, and existing paths.
- **Wrap the memory MCP servers as a second provider.** Their tools are registered only for the model, their schemas differ, and they stay callable without a citation. A second provider waits for a programmatic MCP call service.
- **Distill from compaction summaries.** A summary is model output, not a tool result, so an episode built from it could cite nothing.

## Consequences

People edit pages outside the harness; the agent cannot, except through `knowledge_write`. A store with many pages costs a full read per call, and a script that opens store files for writing inside a shell or code tool is not detected. Distillation depends on listener order with the verifier gate and on configured verify commands, and it logs a warning when the gate runs after it. The knowledge and loop guards bundles stay independent: the graph evidence check treats a page id an answer names like any path, supported when a knowledge tool result of the turn mentions it, and does not consult the store. In exchange, every agent-written page is traceable to the tool results it was based on, its relations and staleness are recomputed from files, and the only knowledge text that reaches the model uninvited is a logged, capped index.
