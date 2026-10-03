---
description: "Episode distillation of the experimental knowledge seam: after the verifier gate records verdict ok for a turn's final response, one episode page with the request, the filtered final response, and the changed files, citing the tool results that changed them, with optional archiving of older episodes, for users who want verified turns remembered across sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-memory-distill

English | [中文](README.zh.md)

## Summary

This package writes one `episode` page to the `ctx.knowledge` store for a turn that the verifier gate judged `ok` and that changed files. The page holds the human request, the final response without sentences marked temporary, the changed files, and the verdict, and cites the successful tool results that changed those files. With a positive `maxEpisodes`, older episode pages are archived, never deleted. The default `shadow` mode only records the `knowledge/write` records it would make. No model is called. Mount it after the verifier gate. It is experimental and carries no stability promise.

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

Mount the plugin after a knowledge store provider, the session projection service, and `@deepseek-ai/dsh-experimental-verifier-gate` with `verify.commands`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-memory-distill'
  config:
    mode: enforce
    assumption: a turn whose verify commands passed holds project facts worth recalling in later sessions
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` registers nothing; `shadow` records the write it would make; `enforce` writes |
| `assumption` | none | The assumption this mechanism encodes about the model; blank outside `off` is a load error |
| `requireVerdict` | `true` | Distill only after a `loop/verdict` of `ok` for the turn's final response |
| `dir` | `episodes` | Store directory for episode pages; must be a content directory of the store |
| `maxEpisodes` | `0` | Active episode pages kept: `0` archives none; a positive value archives the oldest other episode pages after each written episode, so at most that many stay in the store index |
| `changeTools` | `write`, `edit` | Tools whose successful calls change their `file_path` or `path` |
| `maxRequestChars` | `1000` | Characters of the request kept |
| `maxOutcomeChars` | `2000` | Characters of the final response kept |
| `transientMarkers` | `this session`, `for now`, `today only`, `temporarily`, `for this turn` | Markers of temporary statements, dropped sentence by sentence |

Loading fails with a `memory-distill:` error when `assumption` is blank outside `off`, `dir` is not one path segment, `changeTools` is empty or has a blank entry, a character cap is not a positive integer, `maxEpisodes` is not an integer of at least 0, or a marker is blank.

### Order with the verifier gate

`agent/turn-stopping` runs listeners in registration order; list `@deepseek-ai/dsh-experimental-loop-graph-profile` before `@deepseek-ai/dsh-experimental-knowledge-profile` in the profile's layer list. When the gate judges a boundary after this plugin checked it, the turn is not distilled and the plugin logs the warning below once per session.

```text
memory-distill: the verifier gate recorded a verdict after memory-distill checked the same turn boundary, so the turn was not distilled; list the loop guards bundle before the knowledge bundle so the gate runs first.
```

### Verify commands decide

The loop guards bundle ships verifier-gate without verify commands, which records `skipped`, never `ok`; configure `verify.commands` for episodes to be written.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `memoryDistill` projection folds the open turn: the first `user/message` with source kind `user`, the latest successful change per path by a `changeTools` call, the latest `assistant/message` and its text, a `loop/verdict` of the same turn tied to that message, and whether a `knowledge/write` by this writer was already recorded. An `agent/turn-stopping` listener registered without `prepend` writes the episode when the verdict tied to the final response is `ok`, or when `requireVerdict` is off and no verdict is tied to it, and when the turn changed at least one file.

### Design notes

- **Page content.** `episodes/<YYYY-MM-DD>-<session>-t<turn>.md`, type `episode`, with Request, Outcome, Files changed, and Verification sections; the provider adds frontmatter, the title heading, and the Origin section.
- **Retention by archiving.** `resolveRetention` turns `maxEpisodes` into no archiving (`0`) or the count of active episode pages kept. With a count, the plugin reads the store index before writing; after the episode is written, it archives every other `episode` page under `dir` beyond the newest `maxEpisodes - 1` (newer means a later `updated`, then a later id). Archiving reads the page and writes its title, body, and relations back with status `archived` through `ctx.knowledge.write`, citing the same tool results as the new episode, so the store rules check it and it is logged as a `knowledge/write` with operation `update`. An archived page leaves the index, query results, and neighbor levels but stays readable through `knowledge_read` and `knowledge_cite`; the plugin never deletes a page. A frontmatter status was chosen over a `supersedes` relation because a newer episode does not replace the facts of an older one, and a superseded page would stay in the index. In `shadow` mode the plugin records one `knowledge/write` per page it would archive.
- **Citations from changes.** The page cites the successful `tool/result` of each changed file's latest change; a turn that changed no file is not distilled, because its page could cite nothing.
- **Temporary statements dropped.** Sentences containing a configured marker, case-insensitively, are removed from the request and the outcome.
- **Shared content.** `episodeContent` applies the marker filter and the length bounds to a turn's request and outcome. It is a pure export: `memory-zeromem` uses it for the text of its verified episodes, so both stores drop the same statements without copying the rule.
- **Once per turn.** The fold marks a turn distilled at its first `knowledge/write` by this writer, so a steered continuation of the same turn is not distilled again.
- **No compaction summaries.** A summary is model output, not a tool result, so it cannot be cited.
- **Gate independence.** The gate's `loop/verdict` is read by event name and validated with zod; this package does not depend on the gate at runtime.
- **No `./invariant` companion.** No invariant companion is published because every record it writes is a knowledge/write whose citations the @deepseek-ai/dsh-experimental-knowledge invariant checks.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the projection registration, the turn-stopping listener, and the order warning |
| [`src/fold.ts`](src/fold.ts) | The `memoryDistill` projection fold and the verdict parser |
| [`src/retention.ts`](src/retention.ts) | `maxEpisodes` resolution and the choice of episode pages to archive |
| [`src/episode.ts`](src/episode.ts) | Episode page id, marker filter, the shared `episodeContent`, and page entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge seam](../knowledge/README.md) — `ctx.knowledge` and the `knowledge/write` event.
- [Verifier gate](../verifier-gate/README.md) — the `loop/verdict` this plugin waits for.
- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — roles and events.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the knowledge store: episode pages reach the model only through the index message and the knowledge tools; the plugin adds no message, tool, or prompt text.

#### KV Cache effect

Independent: nothing from this plugin enters a request directly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Layer order** — the gate must register its `agent/turn-stopping` listener first; the plugin warns instead of reordering.
- **No summaries** — compaction summaries are not distilled.
- **Episode files are never deleted** — archiving bounds the index, not the store: archived pages stay files, and the provider's `maxPages` caps what one read loads, archived pages included. An archival replaces the page's citation and Origin section with the tool results that triggered it; the page id keeps the original session and turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
