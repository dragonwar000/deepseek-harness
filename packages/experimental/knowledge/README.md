---
description: "Service Definition of the experimental knowledge seam (ctx.knowledge): page and edge vocabulary, the abstract KnowledgeService, and the knowledge/write and knowledge/inject session events, for plugin authors adding a knowledge store provider or consumer."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge

English | [中文](README.zh.md)

## Summary

This package is the Service Definition of the knowledge capability seam. It declares `ctx.knowledge` as the abstract `KnowledgeService`, which lists, searches, reads, cites, and writes the pages of one knowledge store; the vocabulary of pages, edges, and relations with a stable edge id; and two log-only session events, `knowledge/write` for every attempted store write and `knowledge/inject` for every index injection. It ships no store: a provider subclasses `KnowledgeService`. It is experimental and carries no stability promise.

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

Depend on this package to write a knowledge store provider or a consumer. It is not a plugin row: load a provider, which registers `ctx.knowledge`, and inject `knowledge` in consumers.

### When to choose it

Choose it when a plugin reads or writes durable knowledge that outlives a session and must stay attributable to the session events it came from. Session-local notes belong in the session log instead.

### Contract

Every method takes a `KnowledgeScope` with the session working directory and a cancellation signal, because the store root resolves against the session workspace. Reads derive edges, staleness, and ranking from the stored pages on every call. `write` checks every store rule and returns `refused` with the broken rule, including a write whose citation names no session event; it throws only on I/O failure. `includes` tells a guard whether a workspace path lies inside the store. An entry written with status `archived` stays readable through `read` and `cite` but is left out of `index`, `query`, and `neighbors`; `read` returns the page's `body` as a writer supplied it, so writing it back with a new status reproduces the page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`edgeId(from, to, relation)` is `e:` plus the first eight hex digits of sha1(`from|to|relation`), the same function as overstack `wiki-graph.py`, so edge ids of both tools agree on the same wiki. Relations are the six a page declares (`derives-from`, `depends-on`, `implements`, `supports`, `contradicts`, `supersedes`), body links (`wikilink`, `mdlink`), and `touches` edges to workspace code paths; an edge target is a page or a code path.

### Design notes

- **Citations are a relation, checked at append time.** The `./invariant` companion checks that every applied `knowledge/write` cites at least one event and that every cited event the process observed is an earlier successful `tool/result` of the same session. Citations older than the first event the process observed for a session are not checked, because a resumed session's earlier events were not observed.
- **Both events are required-on-read.** They are ordinary `SessionEventMap` members recorded in the persistence catalog; neither enters a model request.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `KnowledgeService` and the `ctx.knowledge` declaration |
| [`src/types.ts`](src/types.ts) | Vocabulary and the two `SessionEventMap` members |
| [`src/edge.ts`](src/edge.ts) | `edgeId`, relation list, id branding |
| [`src/tool-path.ts`](src/tool-path.ts) | `pathArgument` and `foldToolPath` for consumers that derive sources from logged tool calls |
| [`src/invariant.ts`](src/invariant.ts) | Citation invariant companion |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge subsystem page](../../../docs/subsystems/knowledge.md) — the seam, its roles, and the generated service surface.
- [Experimental group map](../README.md) — sibling experimental packages and the publication policy.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the providers and consumers of `ctx.knowledge`; this package declares types, an abstract service, and two log-only session events and registers nothing model-facing.

#### KV Cache effect

Independent: nothing from this package enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pages and code only** — edge targets are pages or code paths; section and session nodes have no deterministic source yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
