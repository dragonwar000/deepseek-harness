# Agent Note: English-only Agent Notes

Status: implemented

## Problem

Every Agent Note had to merge as a triplet: the English `.md`, a Chinese `.zh.md`, and an `.i18n.yaml` consistency record pairing them. The corpus-wide check in `verify-translation-pairing` enforced it, so a note could not land without a counterpart.

Agent Notes are the repository's internal decision record, written by agents and read by the people and agents working in this tree. Unlike `docs/`, they are not a published surface for readers outside the company. The counterpart was translated in the same change that wrote the note, and every later correction to a note — a moved file, a renamed package, a changed default — cost a second edit and a re-record. The repository owner decided on 2026-09-30 that the translation overhead on this one tree buys less than it costs, and that notes are written in English from now on.

The rule had to shrink without loosening anything adjacent. `docs/` pages, package READMEs, upgrade guides, and the root paired documents are read outside the company and stay bilingual. The frozen archive under `.agents/notes/archived/` is sealed content that no longer changes, so its completeness rules stay exactly as strict. The several hundred existing note pairs are consistent today, and nothing about this decision makes them worth deleting.

## Decision

An active Agent Note — a dated file at `.agents/notes/{proposed,implemented,rejected}/{class}/yyyy-mm-dd-topic-title.md` — merges with its English `.md` alone. This note is the first one written under that rule, and it is English-only.

[scripts/translation-counterpart.ts](../../../../scripts/translation-counterpart.ts) is the one home of the rule. It exports the predicate over source paths and the verdict the gate prints when a counterpart is required and absent, and it reads the Agent Note path grammar from [scripts/agent-note-tree.ts](../../../../scripts/agent-note-tree.ts) rather than matching a prefix, so the exemption is exactly the note files and never the tree's `README`, `AGENTS.md`, or anything under `archived/`.

Two consumers read that rule, and both had to, because they must agree about what a pair is:

- [scripts/verify-translation-pairing.ts](../../../../scripts/verify-translation-pairing.ts) applies it where a discovered source has no counterpart. `--list` reports such a source as `english-only` instead of `missing`, so the exemption is visible rather than silent.
- [scripts/translation-links.ts](../../../../scripts/translation-links.ts) stops treating an Agent Note with no counterpart on disk as a locale-switchable target. Both sides of any pair that links to an English-only note therefore keep its `.md` path, and the two sides' structural signatures still match.

A counterpart that exists is unaffected. It is a pair like any other: complete with its `.i18n.yaml`, hash-checked per section, structurally mirrored, and rejected when either side drifts. Adding a counterpart to an English-only note makes links to it locale-switched again, and the gate names every Chinese-side link still on the `.md` path. Deleting a note deletes whatever of the three files exist.

Everything outside the active note files is unchanged: `docs/**`, `python/**`, package READMEs, the root paired documents, `.agents/notes/README.md` itself, and the locale dictionaries. Archiving still requires the complete triplet, so a note that reaches the archive English-only gains its counterpart and sidecar in the archival change — the archive is sealed, append-only history, and relaxing it would mean rewriting sealed content.

## Alternatives considered

**Add `.agents/notes/` to the manifest's `excluded` list.** This is the cheapest edit and the wrong one. An excluded path may have *no* counterpart and *no* sidecar, and the gate actively rejects one that exists — so the several hundred existing note pairs would all have to be deleted, and the exclusion would also cover `.agents/notes/README.md`, which is a published contract page that stays bilingual. The decision needs "optional", which the manifest cannot express.

**Add an `optional` field to the pairing manifest.** More honest than abusing `excluded`, and rejected because it puts a policy decision in a data file where it reads as a list of paths with no statement of why. A rule with one named exemption belongs in code with its reasoning attached, next to the predicate the gate calls. A manifest field would also invite a second, third, and fourth path to be added with no review of whether the exemption fits.

**Match on the `.agents/notes/` prefix instead of the note path grammar.** A one-line predicate, and too broad: it exempts `.agents/notes/README.md`, which the decision explicitly keeps bilingual, and it would silently exempt any future page added to that tree. Reading the closed lifecycle and class sets from the tree walker costs a few lines and makes the exemption exactly the notes.

**Delete the existing Chinese counterparts.** Considered because a half-translated corpus is an odd state to maintain. Rejected: the existing counterparts are consistent, already paid for, and still useful to Chinese-reading maintainers. Deleting them destroys reviewed work to buy tidiness, and the pairing gate keeps them honest at no ongoing cost to notes that do not have one.

**Relax the frozen archive too, for consistency.** Rejected on the archive's own terms. Archived triplets are sealed by a content manifest and never change; loosening the completeness rule there would either require rewriting sealed artifacts or leave a rule that can never fire. The asymmetry is deliberate and stated in [.agents/notes/README.md](../../README.md).

## Consequences

Writing a note costs one file. A later correction to a note costs one edit and no re-record. The cost moves to archival, where an English-only note must be translated before it can be sealed; that is one translation at the end of a note's active life instead of one at the start plus one per correction.

The note corpus is now mixed: older notes are pairs, newer ones are not. `verify-translation-pairing --list` distinguishes the two states, and the `english-only` count makes the mix measurable rather than inferred from absent rows.

The gate's error surface is narrower by exactly one case and no more. A missing counterpart is still rejected for every `docs/` page, every package README, every `python/` page, the root paired documents, and `.agents/notes/README.md`; a counterpart that exists is still checked in full; and the archive still rejects an incomplete triplet.

## Testing

[scripts/translation-counterpart.spec.ts](../../../../scripts/translation-counterpart.spec.ts) pins the rule's acceptance and rejection paths: an active Agent Note in each lifecycle merges English-only; a docs page, a nested docs page, a package README, the root README, a root paired document, a `python/` page, `.agents/notes/README.md`, an archived note, and four paths that only resemble a note are each still rejected with the gate's exact message. It also pins that a link to an English-only note resolves to the same target from both sides of a pair, that adding a counterpart makes the Chinese side's `.md` link a violation again, and that an Agent Note pair which does exist still reports record drift and structural divergence.

[scripts/archived-agent-notes.spec.ts](../../../../scripts/archived-agent-notes.spec.ts) pins that an archived note missing its Chinese counterpart, its English side, or its record is still rejected as an incomplete triplet.
