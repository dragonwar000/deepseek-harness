# Agent Note: English-only documentation

Status: implemented

## Problem

Every in-scope document had to merge as a triplet: the English `.md`, a Chinese `.zh.md`, and an `.i18n.yaml` consistency record. `verify-translation-pairing` rejected a missing counterpart and any edit to one side that was not carried to the other, so each documentation change cost a second edit in Chinese and a re-record. Agent Notes paid that cost most often, because a note is corrected whenever the code it describes moves.

The repository owner decided on 2026-09-30 that this fork writes documentation in English only. A first step made the counterpart optional for new Agent Notes, but it left three obligations: an existing note pair still had to be updated together, archiving a note still required a complete triplet, and every other document class still had to merge bilingual.

The Chinese documents outside the note tree are owned upstream. Deleting several hundred of them would make every upstream merge conflict.

## Decision

English is the only required documentation language. No change creates or updates a `*.zh.md` file or an `.i18n.yaml` record unless the user explicitly asks.

[scripts/translation-counterpart.ts](../../../../scripts/translation-counterpart.ts) is the one home of the rule:

- `TRANSLATION_COUNTERPART_POLICY` is `optional` for every document class: `docs/**`, `python/**`, package and app READMEs, upgrade guides, persistence-change records, the root paired documents, and `.agents/notes/README.md`. A missing, incomplete, or out-of-date counterpart is a reported finding that fails no check. The `required` policy stays implemented and tested, and `verify-translation-pairing --policy=required` applies it to the pairs a requested translation maintains.
- Agent Notes are outside the pairing contract. The Chinese counterparts and records of all active notes were deleted, a `.zh.md` or `.i18n.yaml` beside an active note fails the pairing gate under either policy, and links to a note use its `.md` path from both languages. The rule reads the path grammar in [scripts/agent-note-tree.ts](../../../../scripts/agent-note-tree.ts), so it covers exactly the note files.
- Existing Chinese documents outside the note tree stay in the tree and may go out of date.
- A finding that needs no Chinese writing to fix fails under either policy: a counterpart beside an excluded file, a record that cannot be parsed, and a counterpart whose English source is gone.

Four checks that would otherwise force a Chinese edit read the same policy. [scripts/paired-markdown-derivatives.ts](../../../../scripts/paired-markdown-derivatives.ts) leaves code fences of an out-of-date `.zh.md` unchecked in `doc-typecheck` and `verify-type-equiv`. [scripts/gen-cordis-catalog.ts](../../../../scripts/gen-cordis-catalog.ts) leaves a Chinese subsystem page that is absent or lacks its generated region as it is. [scripts/translation-links.ts](../../../../scripts/translation-links.ts) keeps the `.md` path to a target that has no counterpart. `persistence-changes --prose` accepts input without `zh` and writes the English text into the Chinese record document, which the persistence history still requires to carry the identical machine declaration.

The frozen archive keeps its sealed triplets unchanged. [scripts/archived-agent-notes.ts](../../../../scripts/archived-agent-notes.ts) accepts an archived note as either the English file alone or a complete triplet, so archiving a note moves one file. A note with a Chinese file or a record that is not the complete triplet is still rejected, and the append-only content manifest still rejects any change to or removal of a sealed file.

Client UI locale dictionaries are product behavior, not documentation. `locale-dictionary-parity` and `verify-client-ui-i18n` are unchanged.

## Alternatives considered

**Delete every Chinese document.** Rejected for the documents outside the note tree: they are upstream-owned, and deleting them turns each upstream merge into hundreds of delete/modify conflicts. The note counterparts were deleted because notes change most often and the stricter rule keeps new ones from returning.

**Add the documentation roots to the manifest's `excluded` list.** An excluded path may have no counterpart, and the gate rejects one that exists, so this would require the deletion rejected above.

**Remove the pairing checks.** Rejected because a translation the user asks for still needs them. One named switch keeps the `required` behavior implemented and tested instead of leaving dead code or a broad skip.

**Keep optional counterparts for active Agent Notes.** Rejected: a note pair that exists must be kept consistent or allowed to rot, and either outcome is Chinese work or misleading history in the decision record. Rejecting the files is one rule with one message.

**Require a triplet at archival.** Rejected: it moves the translation cost to the end of a note's life instead of removing it. Sealed triplets are not rewritten; the archive accepts both artifact sets.

## Consequences

A documentation change costs one English edit. Chinese counterparts outside the note tree become out of date as English changes, and `verify-translation-pairing --list` names each one as `out-of-sync` or `missing`. Chinese readers of those pages may read superseded text; the English document is authoritative.

An upstream merge that brings a `.zh.md` or `.i18n.yaml` beside an active Agent Note fails the pairing gate until those files are deleted in the merge.

A new persistence format version, release record, or `docs/session-format-status.md` change still needs its Chinese file to exist with the identical machine record, because [scripts/persistence-formats.ts](../../../../scripts/persistence-formats.ts), [scripts/persistence-releases.ts](../../../../scripts/persistence-releases.ts), and [scripts/persistence-finalization.ts](../../../../scripts/persistence-finalization.ts) read both files. Their Chinese prose may be the English text.

## Testing

[scripts/translation-counterpart.spec.ts](../../../../scripts/translation-counterpart.spec.ts) runs the pairing check over in-memory corpora under both policies. Under `optional` it passes an English-only docs page, package README, and upgrade guide, an out-of-date counterpart, a structurally diverged counterpart, and a counterpart with no record; under `required` each of those fails with its exact message. Under both policies it rejects a counterpart or record beside an active Agent Note, an unparseable record, a counterpart whose source is gone, and a counterpart of an excluded file.

[scripts/archived-agent-notes.spec.ts](../../../../scripts/archived-agent-notes.spec.ts) accepts an English-only archived note and a complete triplet, and rejects invalid archive metadata, a partial triplet, a triplet whose record no longer matches, and a sealed triplet stripped to its English file. [scripts/paired-markdown-derivatives.spec.ts](../../../../scripts/paired-markdown-derivatives.spec.ts), [scripts/translation-links.spec.ts](../../../../scripts/translation-links.spec.ts), and [scripts/persistence-changes.spec.ts](../../../../scripts/persistence-changes.spec.ts) cover the policy in their checks.
