---
description: "Model-facing tools of the experimental knowledge seam: knowledge_query, knowledge_read, knowledge_cite, and approval-gated knowledge_write whose pages cite the session's successful reads, for users letting the model read and record durable project knowledge."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-knowledge

English | [中文](README.zh.md)

## Summary

This package registers the model-facing tools of `ctx.knowledge`. In the default `read-only` mode it registers `knowledge_query`, `knowledge_read`, and `knowledge_cite`; `read-write` adds `knowledge_write`. Every `knowledge_write` asks the user, accepts only sources that an evidence tool read successfully in the same session, cites those reads as the page's source events, and appends a `knowledge/write` record for every attempt that reaches the store, including one the store refuses. It is experimental and carries no stability promise.

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

Mount the plugin after a knowledge store provider such as `@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem`, a `ctx.fs` provider, and the session projection service. Mount `@deepseek-ai/dsh-experimental-knowledge-rules` with it in `read-write` mode so file and shell tools cannot change pages directly, and mount an approval provider, without which every `knowledge_write` is denied.

### When to choose it

Choose it when the model should consult project knowledge recorded by earlier sessions and people, and, in `read-write` mode, record durable facts it verified by reading workspace files.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-tool-knowledge'
  config:
    mode: read-write
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `read-only` | `read-only` registers the three read tools; `read-write` adds `knowledge_write` |
| `evidenceTools` | `read` | Tools whose successful calls count as reads of their `file_path` or `path` argument |
| `maxResults` | `10` | Most hits one `knowledge_query` returns |
| `maxPageChars` | `20000` | Characters of page text one `knowledge_read` returns |
| `maxDepth` | `2` | Largest `depth` of `knowledge_cite` |

Loading fails with a `tool-knowledge:` error when `evidenceTools` is empty or has a blank entry, or when a count field is not a positive integer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`knowledge_write` looks up, for each source, the seq of the latest successful `tool/result` of an evidence tool whose path argument resolves to the same `ctx.fs` target, builds the entry, and calls `ctx.knowledge.write` with those seqs. A written page returns its id, operation, and the pages that became stale; a refused page returns a tool error naming the broken rule.

### Design notes

- **Citations from the log.** The `knowledgeEvidence` projection folds `tool/call` and `tool/result`: a call of an evidence tool with a `file_path` or `path` argument waits for its result, and a successful result records its seq under that path. Sources match reads by the `targetKey` of `ctx.fs.resolve`, so `src/a.ts` and `./src/a.ts` are the same file. A source that was never read successfully is refused before the store is called, and no `knowledge/write` is recorded.
- **Always asked.** A `tools/pre-execute` listener registered with `prepend: true` calls `next()` first and turns an `allow` for `knowledge_write` into `ask`, so no earlier listener's `allow` skips the question. Without an approval provider the registry denies the call. Child sessions reject every approval, so `knowledge_write` in a subagent or a graph node is always denied.
- **Every attempt is logged.** A write that reaches the store appends one `knowledge/write` record with the cited seqs and files, whether the store wrote or refused the page; the `@deepseek-ai/dsh-experimental-knowledge` invariant checks the citations of every applied record.
- **Not a session search.** `knowledge_query` ranks store pages only; earlier sessions are searched with the session query tools.
- **No `./invariant` companion.** No invariant companion is published because every record it writes is a knowledge/write whose citations the @deepseek-ai/dsh-experimental-knowledge invariant checks.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the four tools, and the approval listener |
| [`src/evidence.ts`](src/evidence.ts) | The `knowledgeEvidence` projection fold |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge seam](../knowledge/README.md) — `ctx.knowledge` and the `knowledge/write` event.
- [Wiki filesystem provider](../knowledge-wiki-filesystem/README.md) — the store rules and page format behind these tools.
- [Knowledge rules guard](../knowledge-rules/README.md) — refuses direct file and shell writes into the store.
- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — roles and events.

-----

<a id="model-experience"></a>
## Model Experience

### The knowledge_query tool

#### What the model sees

When the plugin is mounted, the model is offered a read-only tool named `knowledge_query` with a required `query` string, an optional integer `limit` from 1 to `maxResults`, and the description below. The result is compact JSON `{"hits":[{"id","title","type","updated","stale","score"}]}`; a `limit` outside the range is a tool error naming the range.

##### Verbatim text for this field

```markdown
Search the knowledge store of this workspace: durable pages about the project that earlier sessions and people recorded. Returns pages ranked by the share of query words they contain, with id, title, type, last update, and stale (a page it depends on changed after it or was superseded). Read a page with knowledge_read before relying on it.
```

#### Token effect

Always-on while mounted: the tool definition is about 140 tokens in every request. Each call adds a result of about 25 tokens per hit, at most `maxResults` hits.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The knowledge_read tool

#### What the model sees

When the plugin is mounted, the model is offered a read-only tool named `knowledge_read` with a required `ref` string and the description below. The result is compact JSON `{"page":{"id","title","type","updated","stale","relations","content","truncated"}}` with the file text cut to `maxPageChars` characters; a reference that names no readable page is a tool error suggesting `knowledge_query`.

##### Verbatim text for this field

```markdown
Read one knowledge page by id (for example concepts/retry.md), by id without .md, or by a file name that is unique in the store. Returns its title, type, last update, stale flag, declared relations, and Markdown text. Pages can be outdated: verify statements about code against the current files before asserting them.
```

#### Token effect

Always-on while mounted: the tool definition is about 120 tokens in every request. Each call adds the page text, at most `maxPageChars` characters (about `maxPageChars / 4` tokens), plus about 40 tokens of fields.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The knowledge_cite tool

#### What the model sees

When the plugin is mounted, the model is offered a read-only tool named `knowledge_cite` with a required `ref` string, an optional integer `depth` from 0 to `maxDepth`, and the description below. The result is compact JSON `{"edges":[{"eid","from","to","toKind","relation"}],"neighbors":[[…]]}`; `neighbors` lists page ids by link distance and is present only for a `depth` above 0 and a page reference. A `depth` outside the range is a tool error naming the range.

##### Verbatim text for this field

```markdown
List the edges that start or end at one knowledge page, each with a stable edge id (e: and 8 hex digits) you can cite: body links (wikilink, mdlink), declared relations (derives-from, depends-on, implements, supports, contradicts, supersedes), and touches edges to workspace code paths the page names. Pass an edge id as ref to look up that one edge. depth from 1 also returns the pages within that many links.
```

#### Token effect

Always-on while mounted: the tool definition is about 170 tokens in every request. Each call adds about 30 tokens per edge plus the listed neighbor ids.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

### The knowledge_write tool

#### What the model sees

In `read-write` mode the model is offered a tool named `knowledge_write` with required `id`, `type`, `title`, `body`, and `sources`, optional `relations` (`{relation, to}` with the six declared relations), and the description below, which names the configured evidence tools (shown here for the default `read`). The user is asked before every call. A written page returns `{"id","operation","stale"}`. An empty `sources` list, a source not read successfully in this session, a rejected or unavailable approval, and a store refusal (`knowledge_write refused (<rule>): <reason>`) are tool errors.

##### Verbatim text for this field

```markdown
Create or replace one knowledge page. id is a path such as concepts/retry.md inside one of the store's content directories. sources must list workspace files you read in this session with read; the harness cites those reads in the page and refuses a page without them. relations may point only at existing pages. The user approves every write. Record durable facts about the project, not plans, progress, or temporary state of this session.
```

#### Token effect

Present only in `read-write` mode: the tool definition is about 340 tokens in every request. Each call adds a result of about 20 tokens plus the stale page ids, or one error sentence.

#### KV Cache effect

The tool definition joins the stable tool prefix once, when the plugin loads; results are append-only tool results after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Reads only through evidence tools** — a file read by a shell command or a script cannot be a source; read it with an evidence tool first.
- **No Web card** — the pending card is the generic host presenter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
