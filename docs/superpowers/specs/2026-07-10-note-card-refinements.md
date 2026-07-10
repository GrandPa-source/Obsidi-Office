# Note-Card Refinements (post-drill round 3) — Requirements

**Date:** 2026-07-10. **Status:** Paul-specified after the hybrid-card drill passed (v0.1.14). Decisions from follow-up: **single parent only**; **break-away rename prompts on parent removal**.
**Baseline:** branch `container-notes` at `c40c6a2`. These are behavioural requirements with code anchors; implementers read the live code for exact shapes.

## R1 — Card layout rework + caret + tags (ContainerNoteView + `_injectNoteCSS`)

1. **Caret colour:** the CM6 caret in the note editor must follow the theme text colour. CSS: `.obsidi-note-editor .cm-cursor, .obsidi-note-editor .cm-dropCursor { border-left-color: var(--text-normal); }` appended in `_injectNoteCSS`.
2. **Keep the collapsible head line** exactly as is (chevron · type · parent · date).
3. **Expanded body becomes two columns** (CSS grid, `1fr 1fr`, gap ~16px; stack to one column under ~500px container width via `flex-wrap`/`minmax` — plain CSS, no JS measurement):
   - **Left column:** (a) Type select and Date input side by side on one row (two half-width fields with small labels above or beside, match existing `.obsidi-note-card-lbl` idiom); (b) **Parent document** beneath — SINGLE slot: when set, the parent title as an accent link (opens `openDocDetail`) with a remove ✕; when empty, the existing add-parent picker input. Multi-parent UI is REMOVED: render only `relatedParents[0]`; the picker only shows when there is no parent. (Data model keeps the array on disk — no migration; the card just never adds a second entry.)
   - **(c) Tags** stacked under the parent: read-only pills from the skeleton's `fm.tags` (machine-extracted from the body — display only, never editable here; reuse the existing tag-pill look from the detail page if a class exists, else a small `.obsidi-note-card-tagpill` style).
   - **Right column:** the **People section** (only when `docContainer.noteShowsPeople(type)`), restyled to match the parent container's **Stakeholders table** idiom (same header-row + flat-row classes the detail page uses — read `DocumentDetailView`'s stakeholders pane for the exact classes, e.g. `.doc-detail-lhead` header + row separators). The add-person button label becomes **"＋"** (not "Add"). Roster checkboxes and per-row person-type dropdown behavior unchanged.
4. All existing behaviours survive: optimistic `_renderCard(fmOverride, peopleOverride)`, focus-guarded cache watcher, collapse persistence, people accessor seam, one-way roster sourcing.

## R2 — Create-from-parent flow + break-away rename

1. **From the Related Documents tab ("＋ New note"):** the modal asks **type only** — options Meeting / Decision / Incident (General removed in this context; default Meeting). No title field. The note's title/folder auto-generates as **`<Type> - <ParentName>`** (ParentName = the parent document folder's display title, i.e. its current sidecar `fm.title` falling back to the folder basename). Collisions use the existing `dedupeName` convention (" (2)" suffix). The body seed H1 = the same auto title.
2. **Standalone command** ("Create container note"): unchanged — title + all four types.
3. **Break-away rename on parent removal:** when the parent relation is removed from EITHER side (card ✕ or the parent's Related Documents tab remove), and the note's current title still matches the auto form `<its noteType> - <the removed parent's name>` (exact match), open a small modal pre-filled with the current title prompting for a new one. On submit: rewrite the note body's first H1 line to the new title through the choke point (`readNoteBody` → replace first `# …` line → `updateNoteSkeleton` then `writeNoteBody`, same order as autosave) — the skeleton/tab/tree titles follow automatically. Do NOT rename the note folder (identity = docId; paths stay stable). On cancel: keep the auto name, no error.

## R3 — Log tab file references

1. Parent `log.md` entries that reference a file (today: `related note added (label)` / `Opened in editor (Minutes.docx)` style details) render in the **Log tab** as: action text, then the file reference **between the action and the actor/timestamp**, styled in the accent colour (`var(--text-accent)`), showing the file name **with extension**, and **clickable** — click opens the target (office file → editor route; note `_document.md` → the note editor via the existing file-open redirect or `openNoteInEditor` directly).
2. To make references clickable, relation/activity log DETAILS for file references should carry the vault path (the renderer shows only the basename+ext, accent-styled; the raw `log.md` line carries the path — acceptable, log.md is a machine surface). Backward compatibility: old entries whose detail is a bare label render as plain text exactly as today (no link).
3. Read the Log pane renderer (search `parseLogBody` call sites in `DocumentDetailView`) and `formatLogEntry`/`appendLog` before changing anything; `parseLogBody`'s regex must keep parsing old lines (50/70 tests include log helpers — keep pure-core tests green; if `formatLogEntry`/`parseLogBody` change, update lib + inline regen + tests).

## Out of scope
Encryption; iPad smoke; merge; migrating existing notes' titles/log entries.

## Verification
`node --check main.js`; `node --test lib/doc-container.test.js` (70/70 or updated count if lib log helpers change); deploy OB_Testing; consolidated Paul drill at the end.
