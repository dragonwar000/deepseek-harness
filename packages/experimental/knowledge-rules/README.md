---
description: "Fail-closed guard of the experimental knowledge store: refuses file tool writes, edits, and shell commands that change store pages without knowledge_write, for users who need every agent-written page to cite its session events."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge-rules

English | [中文](README.zh.md)

## Summary

This guard keeps the knowledge store's citation rule unbypassable. A write or edit by a file tool whose target lies inside the store fails in `fs/write-intent` or `fs/edit-intent`, and a shell tool call whose command names the store after a writing verb is refused by a tool guard. Pages then change only through `ctx.knowledge.write`, which checks the store rules and cites the session events a page is based on. When the store cannot answer whether a path lies inside it, the write fails. It is experimental and carries no stability promise.

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

Mount the guard after a knowledge store provider and the filesystem seam, in every composition where the model has file or shell tools and a knowledge store.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-knowledge-rules'
  config:
    shellTools: [bash, pwsh]
```

| Field | Default | Meaning |
|---|---|---|
| `shellTools` | `bash`, `pwsh` | Tools whose `command` argument is checked |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design notes

- **Ahead of the observation policy.** Both intent listeners are registered with `prepend: true`, run before `fs-observation-policy` decides the write intent, and call `next()` after the check; a refusal throws, so the tool call fails before any byte is written.
- **Session workspace.** Containment resolves the store root against the calling session's working directory, read from the tool execution the fs seam passes as the intent's actor.
- **Content rules live with the store.** The intent events carry the target but not the content, so frontmatter, Origin, and relation rules run in the store's own write path; this guard refuses every direct write, which cannot cite session events anyway.
- **Lexical shell check.** Redirections, `tee`, `touch`, `truncate`, `mkdir`, `rm`, `rmdir`, `unlink`, `mv`, in-place `sed`/`perl`, `cp`/`rsync`/`ln`/`install` into the store, git path commands, and PowerShell content and item cmdlets are refused when they name the store root; reads and copies out of the store run.
- **One refusal reason.** Every refusal carries `STORE_WRITE_REASON` verbatim: "Pages in the knowledge store change only through knowledge_write, which records the session events each page is based on; this call would change the store directly. Use knowledge_write instead."
- **No `./invariant` companion.** No invariant companion is published because the guard writes no record of its own: a refusal is the tool result the session log already holds.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, intent listeners, tool guard |
| [`src/shell.ts`](src/shell.ts) | Command patterns |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Knowledge seam](../knowledge/README.md) — `includes` and `storeRoot`, which this guard reads.
- [Wiki filesystem provider](../knowledge-wiki-filesystem/README.md) — the store rules that run on every write.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool results of refused calls: a refused write, edit, or shell call returns an error result with one fixed reason instead of running.

#### KV Cache effect

Append-only: a refusal is an ordinary tool result after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Code that writes files** — a script run by a shell or code tool (`python -c`, `node -e`, programmatic tool calling) that opens a store file for writing is not detected.
- **Lexical over-refusal** — a command that names the store after a writing verb is refused even when the write lands elsewhere.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
