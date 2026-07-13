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

---

# Round 4 (2026-07-12 drill findings)

## R4.1 Caret (real fix)
The `.cm-cursor` border rule did not work because the editor uses the NATIVE browser caret (no `drawSelection` extension). Fix: `caret-color: var(--text-normal);` on `.obsidi-note-editor .cm-content` (keep the existing rules; do not add drawSelection).

## R4.2 Card layout pass 2
- Consistent field alignment: ALL left-column entries use the same label-above-control pattern — Type and Date stay side by side; Parent and Tags become label-above blocks beneath them, aligned to the same grid.
- People column: order = "People" heading, then the ADD-PERSON input row (Name / Title / type select / ＋), then roster checkboxes (when a parent has stakeholders), then the people TABLE below.
- Vertical divider between the two card columns (border-left on the right column, `var(--background-modifier-border)`).

## R4.3 Tag quick-add (architecture-safe)
The Tags row gains a small input + ＋: submitting inserts ` #<tag>` at the END of the note body via the OPEN EDITOR BUFFER (`this._cm.dispatch` append; the updateListener then marks dirty and the normal autosave/extraction pipeline owns it — the card NEVER writes `fm.tags`). Optimistic pill render via `_renderCard({ tags: [...current, tag] })`. Sanitize input to `[A-Za-z][\w/-]*` (strip a leading #). If `_cm` is null (locked/failed load), Notice and no-op. Pills stay display-only (tags are removed by editing the body).

## R4.4 Auto-title numbering position
Collision numbering moves BEFORE the type: "Meeting - Parent", then "(2) Meeting - Parent", "(3) …" (custom collision loop, not dedupeName's trailing suffix). The rename-prompt auto-name matcher accepts BOTH the new prefixed form `^(\(\d+\) )?<Type> - <Parent>$` AND the legacy trailing form `<Type> - <Parent>( \(\d+\))?` (notes created before this change exist with the old form).

## R4.5 Rename flow inversion (prompt BEFORE removal)
The rename gate runs BEFORE any relation removal at both trigger sites (card ✕ and parent-tab remove): when the note is auto-named, open the rename modal FIRST; X/Esc/close = ABORT the entire removal (parent association retained, nothing written anywhere); submit = perform the removal (both sides) then rewrite the H1 (skip the rewrite when the submitted name equals the current one). When not auto-named, removal proceeds directly as today. The parent-tab remove handler defers its splice/_mutateSidecar until the gate resolves true.

## R4.6 Log-ref naming after rename — no code change
Verified by design: log details store immutable paths; the renderer resolves the CURRENT title at render time, so renamed notes update retroactively in all log entries. Drill item only.

---

# Round 5 (2026-07-12 round-4 drill findings) — TO BUILD (handover for fresh-context session)

Round-4 drill: caret PASS, numbering PASS, layout applied. Items below are Paul's round-5 asks + one open BUG. Baseline `30a69e3`, manifest 0.1.18.

## R5.1 BUG (blocking, investigate FIRST): re-associated note missing from parent's Related Documents tab
Repro (Paul, console captured 2026-07-12): on "Test Note Beta" (manually named — the rename gate correctly does NOT prompt for it; expectation gap only, see R5.7), card ✕ removed the parent (logs `note parent removed` + `note relation removed`), then re-added via the card picker — logs show `note relation written … <-> … Test Note Beta` + `note field set: relatedParents` — but the note does NOT appear in the parent's (`Documents/Projects/Accreditation 2026/test 3`) Related Documents tab. Repeated remove/re-add cycles logged identically. Investigate with DISK inspection: read the parent's CURRENT sidecar frontmatter (`relatedDocuments` + `links`) after a re-add — did the entry land (then it's a RENDER bug in the tab: check how `rel` is built and whether a stale `fm` snapshot/re-render guard eats it) or not land (then `_writeNoteRelation`'s dedup `rel.some(r => r.target === dmPath)` may be matching a stale/ghost entry, or processFrontMatter is writing a different sidecar than the tab reads — check whether "test 3" has multiple versions and both sides resolve the same current sidecar). Also check the note-side: `relatedParents` on the note's `_document.md` after re-add. Fix + regression-check the whole add/remove cycle from BOTH surfaces.

## R5.2 People column styling/alignment
- "People" heading label CSS = same class/look as the "Type"/"Date" field labels.
- Add-person inputs (Name, Title) and the person-type dropdown get the SAME control height as the date-picker input so the row aligns.
- The add-person "＋" button styled like the parent doc-container's "New Version" button (find its class on the detail page and reuse).

## R5.3 Progressive-disclosure animations (People + Tags)
- People: the add-person input row is HIDDEN by default; pressing "＋" reveals it with a horizontal right-to-left swipe animation (CSS transition, no JS animation lib; respect `prefers-reduced-motion`).
- Tags: a "＋" button sits to the RIGHT of the Tags label; pressing it TRANSFORMS (right-to-left transition) into the tag input field. The tag input no longer sits permanently in the left column.

## R5.4 Executive Summary field
Where the tag input currently sits: a small multi-line text box labelled "Executive Summary". Human-owned card field → store as `summary` in the note's `_document.md` (already in DOC_LEVEL_KEYS; skeleton writer never touches it — verify). Write via `_setNoteField('summary', …)` on blur/change; optimistic render like the other fields.

## R5.5 Tag pills show the #
Pills render `#yourtag` (leading hash) instead of `yourtag`.

## R5.6 Related Documents tab restructure
Move "＋ New document", "＋ New note", the drag-drop zone, and the Browse/add-link navigator OUT of edit mode → always visible in the tab's normal view. The Edit button becomes the gate for DESTRUCTIVE/lifecycle actions only: per-row remove ✕, and BREAK AWAY — which must now also exist for NOTE rows (initiates the parent-removal/rename gate from the parent side; office looseDoc break-away already exists). Keep read-mode rows clickable as today.

## R5.7 Confirm on EVERY removal (DECIDED 2026-07-12 — build it)
Paul chose: every note↔parent removal (card ✕ AND parent-tab remove/break-away) shows a confirmation dialog first. For auto-named notes the same dialog additionally carries the rename field (existing R4.5 gate behavior folds in). Abort (Esc/close/X/Cancel) = nothing removed, nothing written — same abort contract as R4.5. This supersedes "manually named notes remove silently".

## Status
Paul holding at drill step 6 (log-rename verification) pending R5.1 fix; full regression sweep deferred until round 5 lands.

---

# Round 6 (2026-07-12 round-5 drill: steps 1-5 PASS) — TO BUILD

Round-5 drill passed 1-5 on 0.1.19. Paul's refinements, all in the note card (`_renderCard`/`_renderPeopleSection`/`_injectNoteCSS`):

## R6.1 People reveal direction: top → downward
The add-person row's reveal transition becomes a vertical slide (top-down: `max-height` 0→open + `translateY(-8px)`→0 + opacity), replacing the right-to-left swipe. Keep `prefers-reduced-motion: reduce` opt-out.

## R6.2 People reveal button toggles ＋ → ✕
The header-row reveal button shows ＋/"Add" when closed; once pressed (row visible) it becomes ✕ (close/hide the row). Toggling closed hides the row (draft text in the inputs may persist until re-render; no write). Update `aria-label` per state ('Add person' / 'Close add person').

## R6.3 Tags ＋ styled like the People ＋, same toggle
The tag button uses the same `docIconLabel`/`doc-detail-hbtn` idiom as the People ＋ and toggles ＋ → ✕ while the input is visible. When open, the tag input fills the REMAINING WIDTH of the Tags label row (layout: label | input flex:1 | ✕ button). No more morph-replace.

## R6.4 Multi-tag comma input
The tag input accepts multiple tags separated by commas ("a, b, c"). On Enter: each token trimmed, leading '#' stripped, validated against `[A-Za-z][\w/-]*` (invalid tokens → one Notice naming them, valid ones still added), inserted into the OPEN EDITOR BUFFER as ` #a #b #c` (single dispatch; extraction pipeline stays the sole fm.tags writer). Optimistic pill render includes all added tags.

## R6.5 Tag pills strip with Edit
Confirmed pills sit between two horizontal rules (container with top+bottom `1px solid var(--background-modifier-border)`), with an **Edit** button aligned far right inside the strip. Edit toggles per-pill remove ✕ (button label becomes Done). Removing a pill deletes ALL occurrences of that `#tag` token from the note body via the CM buffer (boundary-aware: preceded by start/whitespace/'(' — same boundary as `extractNoteSkeleton`'s tag regex — and not followed by `[\w/-]`; also consume ONE preceding space when present so no double-spaces accumulate), single dispatch per removal; the extraction/autosave pipeline updates fm.tags; optimistic render drops the pill. If `_cm` is null → Notice, no-op (same as quick-add).

## Out of scope
Doc-level tag pills on the detail page; encryption; iPad.
