---
description: "Knowledge index context of the experimental knowledge seam: at the first step of a turn whose store index changed, one capped snapshot message lists page ids, titles, types, update dates, and stale marks, never page content, for users letting the model know which project knowledge exists."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-knowledge

English | [中文](README.zh.md)

## Summary

This package adds the index of the `ctx.knowledge` store to the model request. At the first step of a turn, when the index differs from the last one the session received, it appends a `knowledge/inject` record and adds one snapshot-form user message listing page ids, titles, types, update dates, and stale marks, never page content. The message stays within `maxLines` lines and `maxBytes` bytes. It is experimental and carries no stability promise.

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

Mount the plugin after a knowledge store provider such as `@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem` and the session projection service. Mount `@deepseek-ai/dsh-experimental-tool-knowledge` with it so the model can read the pages the index lists.

### When to choose it

Choose it when the model should know, without searching first, which durable project knowledge the workspace store holds.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-context-knowledge'
  config:
    maxLines: 200
    maxBytes: 25600
```

| Field | Default | Meaning |
|---|---|---|
| `maxLines` | `200` | Most lines of the index message, header and footers included; at least 3 |
| `maxBytes` | `25600` | Most UTF-8 bytes of the index message; at least 1024 |

Loading fails with a `context-knowledge:` error when a cap is not an integer or is below its minimum.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

An `agent/pre-step` listener registered with `prepend: true` calls `next()` first and returns the downstream decision unchanged for a rejected step, a step after the first, an empty store, or an unchanged index. Otherwise it reads `ctx.knowledge.index` with the session working directory, renders the index, appends `knowledge/inject` with the listed ids, the exact byte and line counts, the omitted and quarantined counts, and the sha256 digest of the text, and adds the text as a `knowledge-context` user message after the step's other messages.

### Design notes

- **Index, not content.** Each line names one page; page text reaches the model only through `knowledge_read` of `@deepseek-ai/dsh-experimental-tool-knowledge`, which the knowledge bundle mounts with this plugin.
- **Only when it changed.** The `knowledgeContext` projection folds the digest of the session's last `knowledge/inject`; a turn whose store did not change adds no tokens.
- **Dates, not ages.** Each line carries the date of the page's last write, not an age, so an unchanged store renders the same text on every day and the model computes the age itself.
- **Newest first under the caps.** Pages are listed newest first; when a cap is reached the oldest pages are left out and a footer counts them. Pages with unreadable frontmatter are counted in a second footer.
- **`./invariant` companion.** The companion checks that every `knowledge-context` message follows a `knowledge/inject` of the same turn whose `bytes` equals the message's UTF-8 text length, and that a turn records at most one undelivered inject at a time.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the `knowledgeContext` projection, and the pre-step listener |
| [`src/render.ts`](src/render.ts) | Index rendering within the line and byte caps |
| [`src/invariant.ts`](src/invariant.ts) | Inject record and index message agreement |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge seam](../knowledge/README.md) — `ctx.knowledge` and the `knowledge/inject` event.
- [Knowledge tools](../tool-knowledge/README.md) — the tools that read the pages the index lists.
- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — roles and events.

-----

<a id="model-experience"></a>
## Model Experience

### The knowledge index message

#### What the model sees

At the first step of a turn whose store index changed, the model receives one snapshot-form user message after the step's other messages. Its first line is the header below, where `N` is the number of readable pages. Each following line has the form `- <page id> — <title> [<type>] updated <YYYY-MM-DD>, stale`, where the date is present when the page records one, `, stale` is present for a stale page, and titles are cut to 120 characters. Up to two footers follow.

##### Verbatim text for this field

```markdown
Knowledge index of the workspace knowledge store, newest first (readable pages: N). It lists pages, not their content: read a page with knowledge_read before relying on it, and verify statements about code against the current files before asserting them. A page marked stale depends on a page that changed after it or was superseded.
Pages not listed here: N; search them with knowledge_query.
Pages left out for unreadable frontmatter: N.
```

#### Token effect

About 70 tokens for the header plus about 15 to 25 tokens per listed page, at most `maxBytes` bytes (about 6,000 to 7,000 tokens at the default 25,600). Zero when the store has no pages or the index did not change since the session's last index message.

#### KV Cache effect

Append-only: the message joins the request after the reusable prefix and stays in history; the system prompt does not change. A new message is added only when the index changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Store changes inside a turn** — a page written during a turn appears in the index at the next turn.
- **Read every turn** — the first step of every turn reads the whole store to compute the digest, bounded by the provider's `maxPages`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
