---
description: "Wiki filesystem provider of the experimental knowledge seam: Markdown pages with YAML frontmatter in the session workspace, derived links, relations, touches edges and staleness, and rule-checked writes that cite session events, for users choosing where durable project knowledge lives."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem

English | [中文](README.zh.md)

## Summary

This package registers `ctx.knowledge` as a directory of Markdown pages with YAML frontmatter inside the session workspace, compatible with the overstack llmwiki layout. Every read loads the pages through `ctx.fs` and derives body links, declared relations, and `touches` edges to existing code paths, each with the overstack edge id; staleness is derived one relation deep and never stored. Every write checks the store rules, cites its session events in frontmatter and an Origin section, and replaces a page only at the version it read. It is experimental and carries no stability promise.

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

Mount the provider in a composition with a `ctx.fs` provider, then mount consumers such as `@deepseek-ai/dsh-experimental-tool-knowledge`. Mount `@deepseek-ai/dsh-experimental-knowledge-rules` with it so tools cannot change pages without cited session events.

### When to choose it

Choose it when project knowledge should live in the repository as reviewable Markdown that people and agents both read, with every agent-written page traceable to the tool results it was based on.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
  config:
    root: knowledge
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `knowledge` | Store directory relative to the session working directory |
| `contentDirs` | `concepts`, `entities`, `sources`, `architecture`, `tours`, `episodes` | Top-level directories that hold pages |
| `readOnlyDirs` | `raw` | Top-level directories only people change |
| `codeExtensions` | `py`, `js`, `ts`, `sh`, `yaml`, `yml`, `json`, `html` | Extensions of backticked code paths that become `touches` edges |
| `maxPages` | `2000` | Most pages one read loads before it fails |

The generated [configuration catalog](../../../docs/config-catalog.md) lists every accepted field.

### Page format

A page is `<contentDir>/…/<name>.md` with frontmatter holding a non-empty `type`, and optionally `title`, `updated`, `status`, `relations` (`- {rel: depends-on, to: concepts/backoff.md}`), and `citation`. `status: archived` leaves the page out of the index, query results, and neighbor levels, and neighbor walks do not pass through it; `read` and `cite` still return it. Other `status` values are ignored. Pages whose frontmatter does not parse or has no `type` are quarantined: left out of every result and counted in the index. `README.md` and `_template.md` are not pages; files at the store root and outside `contentDirs` are ignored.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design notes

- **Derive, never store.** Every call lists the content directories, parses each page, stats each backticked candidate path, and builds the graph. A page is stale when a page it declares a relation to has a later `updated`, or when it depends on a page another page supersedes; staleness is one relation deep by construction.
- **Rules run in the write path.** `write` checks, in order, read-only directories and content directories (overstack R1, R14, R5), a one-word `type` and a non-blank title (R9), a citation with at least one event and one file, and relations: every target exists, no self relation, no new dependency on a superseded page (R-rel-1, R-rel-3). The rendered page is checked again for parseable frontmatter, a citation, and an Origin section (R9, R2). A broken rule returns `refused` and writes nothing.
- **Version-guarded writes.** A write replaces an existing page only at the version it stat-ed and creates a new page only if it is still absent.
- **Ranking.** A hit's score is the share of query words (letters and digits, lowercased) found in the page id, type, title, and body; ties sort by id. Overstack `mem-rank.py` uses Jaccard over short memories, which penalizes long pages.
- **Markdown links with anchors.** `[x](y.md#part)` links `y.md`; overstack `wiki-graph.py` skips such links.
- **No `./invariant` companion.** No invariant companion is published because the provider writes no session event; the citation relation of `knowledge/write` records is checked by `@deepseek-ai/dsh-experimental-knowledge/invariant`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WikiFilesystemKnowledge`: config, loading through `ctx.fs`, the service methods |
| [`src/page.ts`](src/page.ts) | Frontmatter parsing, link extraction, page rendering |
| [`src/graph.ts`](src/graph.ts) | Graph building, resolution, staleness, neighbors, citations |
| [`src/rank.ts`](src/rank.ts) | Query ranking |
| [`src/rules.ts`](src/rules.ts) | Store rules |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge seam](../knowledge/README.md) — the Service Definition this package implements.
- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — roles and events.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — the `ctx.fs` seam the store reads and writes through.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.knowledge`; the provider registers no tool, message, or prompt text of its own, and refusal reasons reach the model only in the results of those consumers.

#### KV Cache effect

Independent: the provider adds nothing to a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Full read per call** — every call reads every page; `maxPages` bounds the cost.
- **Staleness needs `updated`** — pages people edit without updating `updated` never become stale by time.
- **No section or session nodes** — edge targets are pages and code paths.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
