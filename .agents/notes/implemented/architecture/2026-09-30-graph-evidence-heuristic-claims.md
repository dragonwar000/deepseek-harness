# Agent Note: Final-answer evidence is a heuristic fold of the turn's tool records

Status: implemented

## Problem

A turn can end with an answer that names files and commands nothing in the turn looked at. The session log already holds every tool call and tool result, but nothing related the answer to them, and compacted spans could not be read back at all.

## Decision

A claim is a file path or a shell command the final answer names: inline code, or a rooted or file-like path in prose. The `graphEvidence` projection of `@deepseek-ai/dsh-experimental-graph-projection` folds, per turn, the paths and commands that tool call arguments and tool results mention, and the claims of the turn's latest assistant message with their leaves: `tool-record`, `observed`, or `absence`; a claim without a leaf is parametric. The fold is deterministic and calls no model. `graph_cite` reads the same records for one claim. `verifier-gate` records the check on `loop/verdict.evidence` and, only with `evidence.mode: enforce`, steers an unsupported answer. `history_read` lists spans that compaction replaced or shortened and returns one as a new tool result, read through the session query service.

## Alternatives considered

- **Cite source events on the answer.** `assistant/message` cannot carry `sourceEventSeqs`, so the answer never cites its sources.
- **Ask a model to link claims to evidence.** It costs a request per turn and makes the gate depend on a nondeterministic call; it is deferred until shadow data shows the heuristic is not enough.
- **Record a `graph/claim` event.** Claims and leaves are a pure function of logged events, and the gate's use of them is already recorded on `loop/verdict`.
- **Read shadowed events synchronously.** New synchronous reads of Session history are prohibited; paged reads through the session query service replace them.

## Consequences

The check proves that a named path or command appears in the turn's tool records, not that the surrounding statement is true. File-system observations are Cordis events, not session events, so they are not leaves. A replacement tool result, such as a pruned one, is not new evidence. A history_read result lands after the cached prompt prefix and never rewrites earlier context. The evidence step starts in shadow mode in `loop-graph-profile`. A mounted knowledge store is the one source outside the log: `graph_cite` and the gate add a `graph-edge` leaf for a page or edge the store resolves, read through the optional `ctx.get('knowledge')` at judgment time and recorded only in the tool result or `loop/verdict` that used it.
