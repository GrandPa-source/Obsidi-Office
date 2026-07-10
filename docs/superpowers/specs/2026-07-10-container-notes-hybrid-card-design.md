# Container-Notes Hybrid: Metadata Card + Editor — Design

**Date:** 2026-07-10
**Status:** Approved by Paul (design dialogue 2026-07-10); supersedes nothing — extends the shipped container-notes feature (branch `container-notes`, v0.1.8).
**Context:** The v0.1.8 note editor opens as a bare text surface. Paul's envisioned structure is a hybrid container: notes carry metadata (parent document, attendees, date, type) maintained alongside the body — primarily for notes created from an existing document container's Related Documents tab (meeting notes, decisions, incident notes about that document).

Decisions fixed in the design dialogue: **header card + editor** layout (not detail-page tabs, not a side panel); fields = related parent(s), note date, note type, conditional people; **4 note types with people on 3** (General, Meeting, Decision, Incident; People section on Meeting/Decision/Incident); create dialog collects **title + type** only.

## 1. Data model

The note's `_document.md` (machine-created at note creation, human fields edited ONLY through plugin UI) gains four human-owned fields alongside the machine-extracted ones:

```yaml
docId: ab12cd34            # existing, machine
docClass: Note             # existing, machine
title: Kickoff Minutes     # existing, machine (from first H1)
created: "…"               # existing, machine
modified: "…"              # existing, machine
tags: [drill]              # existing, machine (from body)
links: ["[[…]]"]           # existing, machine (from body) + relation wikilinks (see below)
noteType: Meeting          # NEW human — General | Meeting | Decision | Incident; absent ⇒ General
noteDate: 2026-07-10       # NEW human — the date the note is ABOUT; defaults to creation day
relatedParents:            # NEW human — folder paths of parent document containers
  - Documents/Governance/Policies/Fan-Out Policy
people:                    # NEW human — only meaningful when noteType is people-bearing
  - { name: "J. Smith", type: Attendee, title: "Manager" }
```

- **Constants (pure core, exported):** `NOTE_TYPES = ['General','Meeting','Decision','Incident']`; `NOTE_PEOPLE_TYPES = ['Meeting','Decision','Incident']` (types whose card shows the People section); `PERSON_TYPES = ['Complainant','Subject','Victim','Witness','Stakeholder','User','Staff','Attendee']`. Pure helper `noteShowsPeople(noteType) → bool` (absent/unknown type ⇒ false).
- **Skeleton-writer safety (already true, now load-bearing):** `updateNoteSkeleton` sets only `title/tags/links/modified` — the four new fields survive every autosave. Any future change to the skeleton writer must preserve this.
- **Absent-field handling is mandatory:** existing notes (created pre-card) have none of the four fields; they render as General with empty date/parents/people and must not error.
- **Relation wiring (both directions, existing related-doc convention):**
  - Parent side: the parent document's CURRENT sidecar gets a `relatedDocuments` entry (same shape the Add-link flow writes today, incl. `added: YYYY-MM-DD`) and a `links[]` wikilink targeting the note's `_document.md` (sidecar-to-sidecar edge — link the `.md`, never the binary/body, or the graph edge is invisible).
  - Note side: the note's `links[]` gets the reciprocal wikilink to the parent's current sidecar. Because `links[]` is machine-rebuilt from the body by `updateNoteSkeleton`, relation wikilinks must ALSO be re-emitted by the skeleton writer: `updateNoteSkeleton` unions body-extracted links with wikilinks derived from `relatedParents` (derive at write time, do not store separately) so autosave cannot drop the parent edge.
  - The existing add/remove-link write path is view-bound (`DocumentDetailView._relWikilink` etc.); implement the note-relation writer as a plugin-level helper that produces the identical on-disk shape.
- **Encryption-phase flag (Phase D seam):** `people` names (Complainant/Victim/Witness…) are precisely the data the future encryption phase protects, and `_document.md` stays plaintext at rest by design. Therefore ALL reads/writes of `people` go through one plugin-level accessor pair — `readNotePeople(folderPath)` / `writeNotePeople(folderPath, people)` — so Phase D can relocate the field into encrypted storage without touching the card UI. No other code may read `fm.people` directly. `noteType: Incident` existing at all is likewise plaintext metadata; accepted for now, noted in the Phase D leak inventory.

## 2. The card

A collapsible metadata card rendered by `ContainerNoteView` between the view top and the editor host (bespoke DOM, NOT a reuse of `DocumentDetailView` — that machinery is version/sidecar/check-out-shaped).

- **Collapsed (one line):** `▸ {noteType} · {first parent title, if any} · {noteDate}`. Click anywhere on the line to expand.
- **Expanded:** type select (`NOTE_TYPES`), date field, parent row(s) — each row: parent title (clickable → opens the parent's detail page via `openDocDetail`), remove ✕, plus an "Add parent" affordance reusing the office-doc path-navigator idiom scoped to document containers; and, ONLY when `noteShowsPeople(noteType)`, the **People section**:
  - A checkbox list sourced LIVE from each parent's stakeholder roster (parent current sidecar `stakeholders[]`; re-read on every card expand — no sync machinery). Checked = present in `people` (match key = `name + '|' + (title || '')`, the same composite key `aggregateStakeholders` uses). Checking adds `{ name, title, type: 'Attendee' }`; unchecking removes that row.
  - Ad-hoc rows: name (text), person-type dropdown (`PERSON_TYPES`), optional title (text), remove ✕. Roster-picked rows keep the same per-row type dropdown (default Attendee, editable).
- **Write behavior:** every card edit writes immediately through `processFrontMatter` on `_document.md` (people via the accessor pair) — no separate save button. The card never touches machine fields (title comes from the H1, not the card).
- **Type switching:** changing type away from a people-bearing one hides the People section but PRESERVES the `people` data on disk.
- **State:** collapse state persists per view via `getState`/`setState` (survives restart, same pattern as `returnDocPath`). Default expanded on a freshly created note (once), collapsed on subsequent opens.
- **Lock interaction:** `setLocked(true)` already empties `contentEl`, which removes the card; unlock rebuilds it via `onLoadFile`. No new lock code.
- **Rendering guard:** the card re-renders on its own `_document.md` metadataCache change (external Sync edits), guarded so an in-progress card edit isn't clobbered (same `_composerDirty`-style guard idiom used by the detail page).

## 3. Creation flows

- **From a document container:** the Related Documents tab (edit mode) gets a **"＋ New note"** button beside "＋ New document". It opens a two-field modal — title (text) + type (select, default Meeting when launched from a parent; General when standalone) — then `createNoteContainer` runs with `{ title, noteType, parentDocPath }`: creates `<docRoot>/Notes/<Title>/` exactly as today, additionally stamps `noteType`, `noteDate` (today), `relatedParents:[parent]`, writes the both-direction relation (parent sidecar entry + wikilinks), then opens the editor with the card expanded.
- **Standalone:** the existing "Create container note" command uses the same modal (title + type, default General); no parent, no relation writes. Behavior otherwise unchanged.
- Title validation, duplicate rejection, docId stamping, `log.md` seeding: unchanged.

## 4. Parent-side integration

- The note appears in the parent's Related Documents tab like any related document, labelled by the note's title (read from its `_document.md`).
- Clicking it routes to the NOTE EDITOR: add a note branch to the related-doc click routing — if the target `_document.md`'s folder holds a `body.cnote`, call `openNoteInEditor` (mirrors how broken-away documents route to their overview). Remove-link on the parent strips both the entry and the wikilink (existing behavior) and additionally removes the parent from the note's `relatedParents` (self-healing reciprocal).
- People added on a note NEVER write back to the parent's stakeholder roster (one-way sourcing).

## 5. Invariants that do not change

Body I/O only via `readNoteBody`/`writeNoteBody`; skeleton-before-body autosave order; 5 s debounce; `cnote` never in `MANAGED_EXTS`; check-out gate bypass; inert lock seams; `[[` completion; tag-pane routing; iPad-safety (no Node/Electron in the view path; card is plain DOM).

## Out of scope (this round)

Encryption of any field; people rollups into project Team views; parent-roster writeback; migrating/back-filling existing notes (graceful absence suffices); note people in graph/search surfaces; multi-select bulk people entry.

## Testing

- Pure core (`node --test lib/doc-container.test.js`): `NOTE_TYPES`/`PERSON_TYPES` exports, `noteShowsPeople` truth table, and the `updateNoteSkeleton` link-union rule if implemented as a pure helper (body links ∪ parent-derived links, deduped).
- Runtime: Paul drill — create from Related Documents tab (relation on both sides, graph edge, card expanded), roster checkbox round-trip, ad-hoc person row, type-switch preserves people, parent remove-link self-heal, existing pre-card notes open clean, restart preserves collapse state, office regression pass.
