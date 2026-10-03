# Documentation languages

English | [中文](README.zh.md)

English is the only required documentation language. Write English only: do not create or update `*.zh.md` files or `.i18n.yaml` pairing records unless the user explicitly asks. Existing Simplified Chinese counterparts stay in the tree and may go out of date; no check fails because one is missing or out of date. Agent Notes are stricter: a note has no counterpart at all. Client UI locale dictionaries are product behavior, not documentation, and keep their own parity checks. This page defines the counterpart policy, the pairing contract a maintained counterpart follows, the checks, scope, and exclusions; [translation-rules.md](translation-rules.md) defines how to translate; [terminology.md](terminology.md) is the terminology source of truth. The [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow runs only when the user explicitly invokes it. The [English-only documentation decision](../../.agents/notes/implemented/process/2026-09-30-english-only-agent-notes.md) owns the rationale.

## The counterpart policy

[scripts/translation-counterpart.ts](../../scripts/translation-counterpart.ts) is the one home of the policy, and every documentation check reads it. `TRANSLATION_COUNTERPART_POLICY` is `optional`: a missing, incomplete, or out-of-date counterpart is reported and never fails a check. The `required` policy, under which each of those findings fails, remains implemented and tested; `pnpm run verify-translation-pairing --policy=required <pair...>` applies it to the pairs a translation change maintains.

Three findings fail under either policy, because none of them asks for Chinese writing: a `.zh.md` or `.i18n.yaml` beside an active Agent Note or an excluded file, a pairing record that cannot be parsed, and a counterpart or record whose English source is gone.

## The pairing contract

The contract describes a counterpart that someone maintains. It obliges no change to create or update one.

- **English is authoritative.** A counterpart is a translation of the English document. Where the two differ, the English document states the current contract and the counterpart is out of date.
- **A pair is three sibling files.** The English `foo.md`, the Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`, all in the same directory. No locale directories, no separate translation repo, no interleaved bilingual files. A change that maintains a counterpart updates all three; an English source with no counterpart has no pair.
- **The consistency record.** `foo.i18n.yaml` holds one entry per heading section that still contains language-specific content. The key is the section's English heading-slug path (`/` for text before the first heading; a repeated path gets `~2`, `~3`, …), and the entry holds a hash of the English and of the Chinese blocks in that section that differ between the two sides:

  ```yaml
  /foo:
    en: 41d772192075e133
    zh: dda91c6c670cfd9d
  /foo/usage:
    en: 86940bea4a3c7ed6
    zh: de78429597783c7f
  ```

  Section `i` of one side corresponds to section `i` of the other. Each side's hash covers every top-level block of the section except fenced code blocks and generated regions, the two kinds of content the gate already requires to be identical on both sides; content that merely happens to be identical is still hashed. A section with no remaining blocks has no entry. Regenerating a region or editing a code block on both sides leaves the record unchanged, and edits to different sections change separate record lines, so Git's default text merge, including GitHub's, composes them. A record conflicts only when both branches changed hashed content in the same section; resolve the Markdown and re-record the pair. An out-of-sync pair is updated, when the user asks for it, by patching the counterpart minimally against the edited side's diff, never by re-translating whole files; the gate names each changed section under `--policy=required`. In the extended workflow, `pnpm run gen-translation-brief <pair>` recovers the last-confirmed text from the newest commit whose contents produce the recorded entries, assembles the update at the narrowest safely aligned granularity, and `--apply` can splice a code-fence-only change after structural validation. After bringing the pair back in line, `pnpm run verify-translation-pairing --write <pair>` re-records the entries; that yaml diff is the reviewable act of confirming consistency, which is why `--write` requires naming the pairs you confirmed (`--write --all` is the explicit corpus-wide form).

  A maintained Chinese file retains its English backlink; an authored English source that has a counterpart retains its Chinese link, while a listed generated English source is exempt. The [section-keyed pairing records Agent Note](../../.agents/notes/implemented/process/2026-09-23-section-keyed-translation-pairing-records.md) owns the record format and its alternatives.
- **Language switcher.** The Chinese file always links back immediately after its H1 heading with `[English](foo.md) | 中文`. An authored English file reciprocates there with `English | [中文](foo.zh.md)`; a listed generated English source omits that line so it remains byte-identical to generator output. A README published outside GitHub, such as PyPI project metadata, may use the canonical `https://github.com/deepseek-ai/deepseek-harness/blob/master/<repository-path>` URL to the same counterpart so the switcher still resolves there.
- **Structure mirrors the counterpart.** Heading depths and order, list kinds, ordered-list starts, list item counts, table row and column counts, semantic link targets with exact query/fragment suffixes, and verbatim code blocks match one to one across the pair. When a relative document link targets a document that has a counterpart, the English side uses its `.md` path and the Chinese side uses its `.zh.md` path. A target with no counterpart, a target outside the corpus, and every Agent Note keep the authored `.md` path on both sides. Under `required`, a missing counterpart is a pair-completeness finding rather than a fallback. See [translation-rules.md](translation-rules.md) for the full preservation rules. Existing Markdown gates apply to `.zh.md` files unchanged (`verify-md-wrap`, `verify-md-links`).

## The gate: verify-translation-pairing

`pnpm run verify-translation-pairing` (part of `doc-sync`, which contributors run locally for documentation changes and CI runs exhaustively) checks the contract mechanically. It reports findings 1 and 2 and exits 0 under the `optional` policy; it fails on them only under `--policy=required`. It fails on finding 3 under either policy:

1. A document in scope has no counterpart. An active Agent Note is never reported, because it has none by rule. README discovery is case-insensitive on the basename, so `missions/readme.md` is in scope alongside the other documentation roots.
2. A pair that exists is incomplete or inconsistent: one of the three files is absent, the record is not canonical or its entries differ from the entries computed from the current contents, the Chinese side or an authored English source lacks its language switcher (listed generated English sources are exempt), an ordinary relative document link uses the wrong locale for its source side, or the structural signatures differ in order — heading depths, verbatim code blocks (info string and content), table row and column counts, list kinds, ordered-list starts, item counts, and semantic link targets with exact query/fragment suffixes apart from the switcher.
3. A file that must not exist or cannot be read as what it is: a `.zh.md` or `.i18n.yaml` beside an active Agent Note or a file listed as `excluded`, a record that cannot be parsed, and a counterpart or record whose English source is gone. Frozen Agent Notes under `.agents/notes/archived/` are outside this gate; their dedicated verifier seals each archived note's files instead.

Source-oriented code gates consume an exact `.zh.md` fence sequence as a derivative of its unsuffixed sibling instead of compiling or manifesting the same code twice. The sequence must match in length, order, fence kind, and byte-exact body. A sequence that differs belongs to an out-of-date counterpart: `doc-typecheck` and `verify-type-equiv` leave it unchecked under `optional` and check it independently under `required`, and the pairing gate reports the structural mismatch.

`pnpm run verify-translation-pairing --list` prints the current pairing state of every document in scope — missing, out-of-sync, english-only, or ok. It never fails; `missing` and `out-of-sync` rows name the findings that `--policy=required` rejects, while `english-only` names an Agent Note.

`pnpm run verify-translation-pairing <pair...>` checks just the named pairs — any of a pair's three files (or its bare stem) names it — so a translation change verifies its own pair in seconds instead of re-scanning the corpus; add `--policy=required` to enforce consistency for those pairs. The no-argument corpus-wide form is what `doc-sync` and CI run.

The practical rule: **a PR that edits an English document leaves its Chinese counterpart and pairing record untouched.** The counterpart becomes `out-of-sync` in `--list`, which is an accepted state. Only a change the user explicitly asked to translate updates the counterpart, re-records the pair with `--write <pair>`, and checks it under `--policy=required`. Deleting or renaming an English document deletes or renames its counterpart and record with it.

The gate's limit, stated plainly: **a pair that passes under `required` was confirmed consistent at these exact contents, not confirmed sound.** It checks hashes and Markdown structure; it cannot judge whether the two sides say the same thing, or whether the wording is accurate, well-termed, and natural — that is the reviewer's half of the contract, per [translation-rules.md](translation-rules.md). A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review.

## Scope and exclusions

**Scope** (the documents whose counterparts the gate reports on): the root `CONTRIBUTING.md`, `BRAND_GUIDELINES.md`, and `SAFETY.md` documents, every non-vendor README, and every active document under `.agents/notes/**`, `docs/**`, and `python/**`. README matching is case-insensitive on the basename and covers future directories without another manifest edit. Dependency and ignored build-output trees and the frozen `.agents/notes/archived/` tree are discovery exclusions, not evolving translation source.

**English-only by rule** (in scope; a counterpart is rejected): every active Agent Note — the dated files at `.agents/notes/{proposed,implemented,rejected}/{class}/yyyy-mm-dd-topic-title.md`. A `.zh.md` or `.i18n.yaml` beside one fails the gate under either policy, and links to a note keep its `.md` path on both sides of any pair. The rule reads the closed path grammar in [scripts/agent-note-tree.ts](../../scripts/agent-note-tree.ts), so it covers exactly the notes and not `.agents/notes/README.md` or the tree's instruction pages.

Generated English references and graphs participate in pairing when a Chinese counterpart exists. A generator puts its generated data in generated regions and writes each region into both pages, so regeneration never requires a manual Chinese update or a new record. Under `optional`, `gen-cordis-catalog` leaves a Chinese subsystem page that is absent or lacks the region as it is, and `persistence-changes --prose` accepts input without `zh` and writes the English text into the Chinese record document. Freshness and pairing gates enforce their respective invariants independently.

Shared generated regions, such as the Cordis subsystem regions and the per-package regions of the [config catalog](../config-catalog.md), keep every generated byte identical across languages except localized paired-document paths; labels inside a region are code identifiers rather than translated words. A full-page generator can also render source-owned paired prose, such as [persistence-catalog-text.ts](../../scripts/persistence-catalog-text.ts), from the same structural data with matching Markdown structure and identical code blocks. It regenerates both pages and their consistency record together; review still verifies the paired prose's meaning and terminology.

Generated English sources omit the language switcher that ordinary authored sources carry, because adding it would make the generator stale; their Chinese counterparts still link back to the English source. A manually maintained Chinese counterpart may rewrite only self-referential generation and maintenance statements that would otherwise be false for the reviewed translation; all technical content remains subject to the ordinary faithfulness rules.

**Excluded** (never paired, and the gate rejects a `.zh.md` or `.i18n.yaml` for them):

- [cordis-api/inherited.md](../cordis-api/inherited.md) — generated without a reviewed Chinese counterpart, so both website locales project the English source.
- `docs/AGENTS.md`, `.agents/notes/**/AGENTS.md`, and their `CLAUDE.md` instruction symlinks — agent instructions, maintained in English only like the root `AGENTS.md`.
- `docs/i18n/terminology.md` and [style-samples.md](style-samples.md) — both are bilingual by construction.
- [translation-prompt.md](translation-prompt.md) — the automated pipeline's prompt template; its body is machine-consumed verbatim, so a paired translation would change pipeline behavior.
- [review-ownership/README.md](../../.github/review-ownership/README.md) — repository-internal approval policy maintained in English only.
- `.agents/notes/archived/` — frozen historical notes, each either an English file alone or a complete triplet sealed before notes became English-only. [`verify-archived-agent-notes`](../../scripts/verify-archived-agent-notes.ts) validates their content seals; translation maintenance must never rewrite them.

**One policy for every class**: `docs/**`, `python/**`, package and app READMEs, upgrade guides, persistence-change records, and the root paired documents all follow the same `optional` policy, and excluded files and Agent Notes accept no counterpart. [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) contains only explicit exclusions; there is no per-file rollout list, date cutoff, or README-specific policy class.

## Division of labor

Routine work writes English and leaves counterparts alone. When the user explicitly asks for a translation, the working agent updates the counterpart after loading [terminology.md](terminology.md), or runs the extended [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow when the user invokes it by name. Under `--policy=required` the gate checks pair completeness, recorded hashes, the Chinese backlink and authored-source switcher (with the documented generated-source exception), and its documented structural signature. Review still owns translation quality, terminology, and structural requirements that the signature does not encode. The prompt contract is executable: [scripts/translation-prompt.ts](../../scripts/translation-prompt.ts) renders the committed template (terminology injected; the template carries its own calibrated rules) into either direction and parses the three-section response, while `verify-translation-prompt` exercises both render directions and the checked-in example in `doc-sync`.
