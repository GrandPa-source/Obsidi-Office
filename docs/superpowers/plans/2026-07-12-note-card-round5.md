# Note-Card Round 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the R5.1 Related-Documents staleness/clobber class, make every note↔parent removal confirm first, restructure the Related Documents tab (create/browse always visible; Edit gates destructive actions), and apply the R5.2–R5.5 card styling/UX batch.

**Architecture:** All changes in `main.js` (plain JS, no build). No `lib/doc-container.js` changes → no inline regen, tests stay 70/70. The Related pane's write handlers stop trusting render-time closures (re-derive from `front` inside `processFrontMatter`); the detail view gains a suppressed-refresh catch-up flag + render instrumentation. Card changes are confined to `ContainerNoteView._renderCard`/`_renderPeopleSection` + `_injectNoteCSS`.

**Tech Stack:** Obsidian plugin API, CM6 (via `requireCm()`), plain CSS transitions.

## Global Constraints

- Plain JavaScript, NO build step; `main.js` is the artifact. `node --check main.js` must pass after every task.
- NEVER hand-edit the `// <doc-container-core>` inlined region of main.js.
- All note body I/O through `readNoteBody`/`writeNoteBody`; skeleton before body. (No task here touches body I/O.)
- `cnote` must never enter `MANAGED_EXTS`.
- Optimistic render overrides after `processFrontMatter` writes (metadataCache is stale until the re-parse 'changed' event) — every new field write follows this pattern.
- Animations: CSS transitions only, must respect `prefers-reduced-motion: reduce`.
- Logging via `dlog`/`elog`.
- Tests: `node --test lib/doc-container.test.js` → 70/70 (lib untouched).
- Manifest version bump to `0.1.19` happens ONCE, in Task 8 (deploy) — individual tasks do not touch manifest.json.
- Spec: `docs/superpowers/specs/2026-07-10-note-card-refinements.md` § Round 5. Baseline `fa020a1`, branch `container-notes`.

---

### Task 1: R5.1 — Related pane de-clobber + suppressed-refresh catch-up + render instrumentation

**Files:**
- Modify: `main.js` — `DocumentDetailView.onOpen` (~4124), `render()` (~4178), `_renderRelatedPane` handlers (~4507 newBtn, ~4566 chooseFile, ~4669 remove ✕), `_dropRelatedRefs` (~4705).

**Context (investigation result, 2026-07-12, adversarially verified):** The relation write path is PROVEN correct — the parent's current sidecar (`Test3_V1.1.docx.md`) holds the re-added entry on disk. The failure is display-side. Root cause (verified by independent review): **`_composerDirty` deadlock** — the Recent Notes composer input (`_renderRecentNotesPane`, oninput ~4887) sets `this._composerDirty = true` when a draft exists; the flag is cleared ONLY by `render()` (~4184) or the composer's own `add()` (~4923). Both refresh listeners (`metadataCache 'changed'` ~4129, `active-leaf-change` ~4138) bail while the flag is set — so an abandoned draft (typed, never submitted) freezes ALL tabs of the view (the guard is view-wide, tabs are only CSS-toggled) until a `setState()` navigation. The guard exists because a re-render wipes the composer's local draft (`input.value`, `stagedTags`, `stagedFiles` are closure-local). Secondary proven defect: **lost-update clobber** — every Related-pane write handler does `front.relatedDocuments = rel.map(...)` from a render-time snapshot; a stale pane doing any write silently deletes entries written elsewhere (e.g. note-card `_writeNoteRelation`). The safe pattern already exists in `_writeNoteRelation`/`_removeNoteRelation` (~8728/8756): read the live array inside the `processFrontMatter` callback, dedup/filter by `target`.

**Interfaces:**
- Produces: `this._composerDraft` ({text, tags, files} | null) and `this._staleWhileGuarded` (boolean) on DocumentDetailView; render-time dlog line. No public signature changes.

- [ ] **Step 0: Composer draft preservation (root fix).** In `_renderRecentNotesPane` (~4863):
  - Seed locals from the instance draft instead of empty: `let stagedTags = (this._composerDraft && this._composerDraft.tags.slice()) || [], stagedFiles = (this._composerDraft && this._composerDraft.files) || [];` and after creating `input`: `input.value = (this._composerDraft && this._composerDraft.text) || '';`.
  - Add a `syncDraft` helper and call it from `input.oninput`, `drop.ondrop`, and both staged-chip ✕ handlers inside `renderStaged`:
```js
const syncDraft = () => {
  this._composerDraft = { text: input.value, tags: stagedTags.slice(), files: stagedFiles };
  this._composerDirty = input.value.trim().length > 0 || stagedTags.length > 0 || stagedFiles.length > 0;
};
```
  (in `input.oninput`, call `syncDraft()` AFTER the inline-tag extraction mutates `input.value`/`stagedTags`; remove the now-redundant direct `this._composerDirty = ...` assignments there and in `ondrop`.)
  - In `add()` right before `_saveSidecar`: `this._composerDraft = null;` (keep the existing `this._composerDirty = false;`).
  - In `render()` (~4184), replace `this._composerDirty = false;` with a recompute so a preserved draft keeps its protection after re-render:
```js
const d = this._composerDraft;
this._composerDirty = !!(d && ((d.text || '').trim() || d.tags.length || d.files.length));
this._staleWhileGuarded = false;   // any full render clears the refresh debt
```
  - A re-render now restores the draft, so re-rendering on leaf switch/blur is safe; the `'changed'` guard remains only to avoid yanking focus mid-typing.

- [ ] **Step 1: De-clobber the four write handlers.** In each handler that writes relatedDocuments, re-derive the array from `front` inside the `_mutateSidecar` callback instead of assigning the snapshot:

For the **add** paths (newBtn onSubmit ~4517, `chooseFile` ~4568, and the add loop inside `_dropRelatedRefs`), replace the pattern:
```js
rel.push({ kind: 'link', target: filePath, label: title.trim(), added: docToday() });
await this._mutateSidecar((front) => {
  front.relatedDocuments = rel.map(({ link, ...r }) => r);
  ...
```
with:
```js
const entry = { kind: 'link', target: filePath, label: title.trim(), added: docToday() };
await this._mutateSidecar((front) => {
  // Re-derive from front (NOT the render-time `rel` snapshot): a stale pane
  // must never clobber entries written elsewhere (e.g. note-card relation writes).
  const cur = Array.isArray(front.relatedDocuments) ? front.relatedDocuments.slice() : [];
  if (!cur.some((r) => r && r.target === entry.target)) cur.push(entry);
  front.relatedDocuments = cur.map(({ link, ...r }) => r);
  ...
```
(keep each handler's existing `links` wikilink block unchanged; `chooseFile`'s entry uses `f.path`/`f.basename`). Keep the local `rel.push(...)` ONLY if later code in the same handler reads `rel`; otherwise delete it.

`_dropRelatedRefs` (~4705) currently ends with `await this._saveSidecar('relatedDocuments', rel, ...)` — convert it to the same `_mutateSidecar` live-merge shape: build the array of new entries locally, then inside the callback push each onto `front.relatedDocuments` (deduped by `target`) and merge the wikilinks into `front.links`; keep its log action string.

For the **remove ✕** handler (~4681 `performRemoval`), replace:
```js
rel.splice(i, 1);
const wl = removed && (removed.link || (removed.kind === 'link' ? this._relWikilink(removed.target) : null));
await this._mutateSidecar((front) => {
  front.relatedDocuments = rel.map(({ link, ...r }) => r);
```
with:
```js
const wl = removed && (removed.link || (removed.kind === 'link' ? this._relWikilink(removed.target) : null));
await this._mutateSidecar((front) => {
  const cur = Array.isArray(front.relatedDocuments) ? front.relatedDocuments.slice() : [];
  front.relatedDocuments = cur.filter((r) => !(r && r.target === removed.target)).map(({ link, ...r }) => r);
```
(`removed = rel[i]` stays — the row's identity comes from the render; only the WRITE re-derives. Removal by `target` match, mirroring `_removeNoteRelation`.)

- [ ] **Step 2: Catch-up + unfreeze the leaf-switch path.** In `onOpen`:
```js
this.registerEvent(this.app.metadataCache.on('changed', (f) => {
  const relevant = this.node && this.node.current && f && f.path === this.node.path + '/' + this.node.current + '.md';
  if (this._composerDirty || this._editMode || this._stakeEdit) {
    if (relevant) this._staleWhileGuarded = true;   // catch-up: consumed by blur/leaf-switch below
    return;
  }
  if (relevant) this.render();
}));
this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
  if (leaf !== this.leaf) return;
  // _composerDirty no longer freezes this path — Step 0 preserves the draft
  // across renders, so repainting on leaf return is lossless. _editMode and
  // _stakeEdit still guard (their in-DOM row edits are not draft-preserved).
  if (this._editMode || this._stakeEdit) {
    if (this._staleWhileGuarded) dlog('doc detail: refresh suppressed by edit guard (stale view):', this.node && this.node.path);
    return;
  }
  if (this.node) this.render();
}));
```
Also in `_renderRecentNotesPane`, add a composer-blur catch-up so a stale view heals as soon as the user leaves the input (draft survives via Step 0):
```js
input.addEventListener('blur', () => {
  if (this._staleWhileGuarded && !this._editMode && !this._stakeEdit) setTimeout(() => this.render(), 100);
});
```
(the 100ms defer lets a click on "Add note" land before the rebuild; `add()` clears the draft itself.)

- [ ] **Step 3: Render instrumentation.** In `render()`, immediately after `const fm = this.frontmatter();` (~4186), add:
```js
dlog('doc detail render:', this.node.path, 'current:', this.node.current,
  'reldocs:', Array.isArray(fm.relatedDocuments) ? fm.relatedDocuments.length : 0,
  'guards:', !!this._composerDirty, !!this._editMode, !!this._stakeEdit, 'relEdit:', !!this._relEdit);
```
(place it after the `if (!this.node)` early-return AND after Step 0's recompute block so the logged guard values are the post-recompute ones). This makes the next drill self-evidencing: if the pane ever shows a list that contradicts the logged count, the bug is DOM-side; if the count is stale, the log shows which guard held it.

**Deferred minors to record in the ledger (final review triages):** (a) `openDocDetail` reuses `getLeavesOfType(...)[0]` — with 2+ detail leaves the non-[0] leaf loses the fresh-`setState` escape hatch (extends the existing R2 multi-leaf minor); (b) the 'changed' listener's path compare uses `this.node.current` frozen at `setState` — after a version bump with the view open it would silently stop matching until re-navigation.

- [ ] **Step 4: Verify** — `node --check main.js` passes; `node --test lib/doc-container.test.js` → 70/70.

- [ ] **Step 5: Commit** — `git add main.js && git commit -m "fix(note-card): R5.1 — related-pane de-clobber (write from front, not render snapshot) + guarded-refresh catch-up + render instrumentation"`

### Task 2: R5.7 — Confirm on EVERY note↔parent removal

**Files:**
- Modify: `main.js` — `confirmNoteParentRemoval` (~8795); module-scope modals near `NoteRenameModal`.

**Interfaces:**
- Consumes: existing call sites (card ✕ ~3712, parent-tab remove ~4690) — unchanged, both already route through the gate.
- Produces: `confirmNoteParentRemoval` now ALWAYS gates. Auto-named → existing `NoteRenameModal` (rename doubles as confirm, unchanged contract). Non-auto-named → new plain confirm modal. Abort never calls `performRemoval`.

- [ ] **Step 1:** Add a minimal confirm modal at module scope next to `NoteRenameModal` (match its style/idiom — read it first):
```js
class NoteRemoveConfirmModal extends obsidian.Modal {
  constructor(app, noteTitle, parentTitle, onConfirm) {
    super(app);
    this._onConfirm = onConfirm; this._noteTitle = noteTitle; this._parentTitle = parentTitle; this._done = false;
  }
  onOpen() {
    this.titleEl.setText('Remove association?');
    this.contentEl.createEl('p', { text: 'Remove the link between “' + this._noteTitle + '” and “' + this._parentTitle + '”? The note itself is kept.' });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = row.createEl('button', { text: 'Remove', cls: 'mod-warning' });
    ok.onclick = () => { this._done = true; this.close(); this._onConfirm(); };
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
  }
  onClose() { if (!this._done && this._onCancel) this._onCancel(); }
}
```
(If `NoteRenameModal` uses a different done/cancel idiom, mirror THAT exactly — the `_done` flag distinguishing submit from Esc/close/X is the established pattern.)

- [ ] **Step 2:** In `confirmNoteParentRemoval`, replace the two direct-proceed branches:
  - Line ~8799 (`no skeleton`) and ~8816 (`!isAutoName || !bodyFile`): instead of `await performRemoval(); return;`, open `NoteRemoveConfirmModal` wrapped in the same `await new Promise((resolve) => {...})` shape as the rename path, with `modal._onCancel = () => resolve();` and the confirm callback doing `try { await performRemoval(); } catch (e) { elog(...); Notice(...) } resolve();`. Use `currentTitle || noteFolderPath.split('/').pop()` for the note title and `this._parentDisplayTitle(removedParentDocPath)` for the parent title (compute the parent title inside the existing try/catch fail-safe — a throw still means NO removal).
  - The auto-named branch (NoteRenameModal) is unchanged — rename modal already serves as the confirmation.
- [ ] **Step 3:** Update the function's header comment: the gate now fires for EVERY removal (decision 2026-07-12); auto-named adds rename, non-auto-named plain confirm.
- [ ] **Step 4: Verify** — `node --check main.js`; tests 70/70.
- [ ] **Step 5: Commit** — `git commit -am "feat(note-card): R5.7 — confirm every note-parent removal (plain confirm; auto-named keeps rename-as-confirm)"`

### Task 3: R5.6 — Related Documents tab restructure

**Files:**
- Modify: `main.js` — `_renderRelatedPane` (~4498).

**Interfaces:**
- Consumes: Task 1's de-clobbered handlers (this task MOVES them; keep the de-clobbered bodies verbatim). Task 2's always-confirm gate for note rows.

- [ ] **Step 1:** Move the create/attach affordances OUT of `if (editing)` so they render always: `＋ New document` button, `＋ New note` button, the drag-drop zone (`doc-detail-dropzone` + `_dropRelatedRefs`), and the Browse/add-link navigator (`doc-detail-addlink` block through `input.onkeydown`). Order in the pane: action buttons row, dropzone, browse input, then the list (existing `rHead` + `listEl`). The Edit/Done toggle stays where it is (pane header area).
- [ ] **Step 2:** Edit mode now gates ONLY destructive/lifecycle controls: the per-row remove ✕ (existing `if (editing)` block ~4667) and Break away. Read-mode rows stay clickable exactly as today.
- [ ] **Step 3:** Break away for NOTE rows: inside the `if (editing)` per-row block, where the office loose-doc break-away lives (~4693), add the note-row branch:
```js
} else if (noteBody) {
  const ba = right.createSpan({ text: 'Break away', cls: 'doc-detail-fbtn' });
  ba.onclick = async () => {
    // Same gated removal as the ✕ — for notes, breaking away IS removing the
    // parent association (the note container stays, standalone). The gate
    // (Task 2) confirms, and prompts rename when the note is auto-named.
    await this.plugin.confirmNoteParentRemoval(noteFolder, this.node.path, performRemovalForRow);
  };
}
```
where `performRemovalForRow` is the SAME removal callback the row's ✕ uses — refactor the ✕ handler so its `performRemoval` closure is declared once per row and shared by both controls (declare it before the ✕ handler; both the ✕ `onclick` and `ba.onclick` route through `confirmNoteParentRemoval(nf, this.node.path, performRemoval)` for note targets). NOTE: `noteFolder`/`noteBody` are already computed per-row at ~4635 in the label block — hoist them so the edit block can use them (compute once at the top of the `rel.forEach` callback).
- [ ] **Step 4:** No two-click arming for the note break-away (the gate modal IS the confirmation); the office break-away keeps its existing two-click arming.
- [ ] **Step 5: Verify** — `node --check main.js`; tests 70/70.
- [ ] **Step 6: Commit** — `git commit -am "feat(doc-detail): R5.6 — create/drag/browse always visible in Related Documents; Edit gates remove + break-away; note-row break-away via removal gate"`

### Task 4: R5.2 — People column styling/alignment

**Files:**
- Modify: `main.js` — `_renderPeopleSection` (~3806), `_injectNoteCSS` (~7866).

- [ ] **Step 1:** People heading label = same look as Type/Date labels: in `_injectNoteCSS` change `.obsidi-note-card-peoplehead` to drop the `font-weight: 600` (rule becomes `{ flex: none; margin-bottom: 4px; }`) — it already shares `.obsidi-note-card-lbl`.
- [ ] **Step 2:** Control heights — align the add-person inputs and type select to the date-picker height. Add to `_injectNoteCSS`:
```css
.obsidi-note-card-addperson input, .obsidi-note-card-addperson select { height: var(--input-height); }
```
(Obsidian's `--input-height` is what the date input uses; verify by inspecting — if date inputs don't use it in this theme, match with `.obsidi-note-card-field input[type="date"]`'s computed pattern by giving ALL of them the same explicit `height: var(--input-height);` rule, i.e. also add `.obsidi-note-card-field select, .obsidi-note-card-field input[type="date"] { height: var(--input-height); }`.)
- [ ] **Step 3:** Style the add-person ＋ like the parent detail page's "New version" button: replace `const btn = add.createEl('button', { text: '＋', ... })` with the `docIconLabel` idiom used at ~4359: `const btn = docIconLabel(add, 'plus', 'Add', { cls: 'doc-detail-hbtn' });` — read `docIconLabel`'s signature first and match it; keep `attr: {'aria-label': 'Add person'}` semantics by setting `btn.setAttr('aria-label', 'Add person')`. (Same for the submit behavior — `btn.onclick` unchanged.)
- [ ] **Step 4: Verify** — `node --check main.js`; tests 70/70.
- [ ] **Step 5: Commit** — `git commit -am "style(note-card): R5.2 — people label matches field labels, control heights aligned, add-person button in New-version idiom"`

### Task 5: R5.3 — Progressive-disclosure animations (People + Tags)

**Files:**
- Modify: `main.js` — `_renderPeopleSection` (~3806), `_renderCard` tags block (~3730), `_injectNoteCSS`.

- [ ] **Step 1 (People):** The add-person row starts hidden; the ＋ button (from Task 4) sits on the People heading row and toggles it. Structure:
```js
const headRow = sec.createDiv('obsidi-note-card-peoplehr');
headRow.createDiv({ text: 'People', cls: 'obsidi-note-card-lbl obsidi-note-card-peoplehead' });
const revealBtn = docIconLabel(headRow, 'plus', 'Add', { cls: 'doc-detail-hbtn' });
revealBtn.setAttr('aria-label', 'Add person');
const add = sec.createDiv('obsidi-note-card-addperson obsidi-note-card-reveal');
revealBtn.onclick = () => { add.toggleClass('is-open', !add.hasClass('is-open')); if (add.hasClass('is-open')) nm.focus(); };
```
(the Name/Title/select/submit-＋ children of `add` are unchanged from Task 4; `nm.focus()` referenced after `nm` is declared — declare the handler after the inputs, or capture lazily.)
- [ ] **Step 2 (Tags):** The permanent tag input row goes away (Task 6 puts Executive Summary in its place). A ＋ button sits to the RIGHT of the Tags label and transforms into the input:
```js
const tagsLblRow = tagsRow.createDiv('obsidi-note-card-tagslblrow');
tagsLblRow.createSpan({ text: 'Tags', cls: 'obsidi-note-card-lbl' });
const tagMorph = tagsLblRow.createDiv('obsidi-note-card-tagmorph');
const tagPlus = tagMorph.createEl('button', { text: '＋', cls: 'obsidi-note-card-tagplus', attr: { 'aria-label': 'Add tag' } });
const tagInput = tagMorph.createEl('input', { attr: { placeholder: 'Add tag…' } });
tagPlus.onclick = () => { tagMorph.addClass('is-open'); tagInput.focus(); };
tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTag(); if (e.key === 'Escape') { tagInput.value = ''; tagMorph.removeClass('is-open'); } });
tagInput.addEventListener('blur', () => { if (!tagInput.value.trim()) tagMorph.removeClass('is-open'); });
```
`submitTag` body unchanged (still dispatches ` #tag` into the CM buffer; optimistic pill via `_renderCard` — note a re-render rebuilds the morph closed, acceptable). The old `tagAdd` div (input+button under the pills) is REMOVED. The `Tags` label line keeps the pills wrap (`obsidi-note-card-tags`) below it as today.
- [ ] **Step 3 (CSS):** Add to `_injectNoteCSS`:
```css
.obsidi-note-card-peoplehr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.obsidi-note-card-reveal { overflow: hidden; max-width: 0; opacity: 0; transform: translateX(24px); transition: max-width 0.25s ease, opacity 0.2s ease, transform 0.25s ease; }
.obsidi-note-card-reveal.is-open { max-width: 100%; opacity: 1; transform: translateX(0); }
.obsidi-note-card-tagslblrow { display: flex; align-items: center; gap: 8px; }
.obsidi-note-card-tagmorph { position: relative; display: flex; }
.obsidi-note-card-tagmorph input { width: 0; opacity: 0; padding: 0; border-width: 0; transform: translateX(16px); transition: width 0.25s ease, opacity 0.2s ease, transform 0.25s ease; }
.obsidi-note-card-tagmorph.is-open input { width: 140px; opacity: 1; padding: 0 8px; border-width: 1px; transform: translateX(0); }
.obsidi-note-card-tagmorph.is-open .obsidi-note-card-tagplus { display: none; }
@media (prefers-reduced-motion: reduce) { .obsidi-note-card-reveal, .obsidi-note-card-tagmorph input { transition: none; } }
```
(the People reveal keeps `display:flex` from `.obsidi-note-card-addperson`; hidden state is width/opacity-based so the transition can run — if flex-gap spacing leaks when closed, also zero the margin in the closed state.)
- [ ] **Step 4: Verify** — `node --check main.js`; tests 70/70.
- [ ] **Step 5: Commit** — `git commit -am "feat(note-card): R5.3 — swipe-reveal add-person row and morphing tag input (reduced-motion safe)"`

### Task 6: R5.4 — Executive Summary field

**Files:**
- Modify: `main.js` — `_renderCard` left column (~3730, where the old tag input sat), `_injectNoteCSS`.

**Interfaces:**
- Consumes: `_setNoteField(key, value)` (~3646); `summary` ∈ DOC_LEVEL_KEYS (verified); `updateNoteSkeleton` never touches `summary` (verified — writes only title/tags/links/modified).

- [ ] **Step 1:** After the Tags block in the left column, add:
```js
const sumRow = left.createDiv('obsidi-note-card-field obsidi-note-card-sumrow');
sumRow.createSpan({ text: 'Executive Summary', cls: 'obsidi-note-card-lbl' });
const sum = sumRow.createEl('textarea', { cls: 'obsidi-note-card-summary', attr: { rows: '3', placeholder: 'Short summary…' } });
sum.value = fm.summary || '';
sum.onchange = async () => {   // fires on blur-after-edit — same cadence as the date field
  const v = sum.value.trim();
  await this._setNoteField('summary', v || undefined);   // empty clears the key (verify _setNoteField deletes on undefined; if not, write '' )
  this._renderCard({ summary: v });
};
```
Read `_setNoteField` first: if it does NOT delete the key when value is `undefined`, pass `v` (empty string) instead and note it.
- [ ] **Step 2 (CSS):** `.obsidi-note-card-sumrow { margin-top: 10px; } .obsidi-note-card-summary { width: 100%; resize: vertical; font-family: var(--font-text); }`
- [ ] **Step 3: Verify** — `node --check main.js`; tests 70/70.
- [ ] **Step 4: Commit** — `git commit -am "feat(note-card): R5.4 — Executive Summary card field (summary fm key, human-owned)"`

### Task 7: R5.5 — Tag pills show the #

**Files:**
- Modify: `main.js` — `_renderCard` tags render (~3734).

- [ ] **Step 1:** `tagsWrap.createSpan({ text: t, ... })` → `text: '#' + t` (the optimistic path at ~3748 flows through the same render — verify no second render site prints pills; search `doc-detail-tagpill` uses inside ContainerNoteView).
- [ ] **Step 2: Verify + Commit** — `node --check main.js`; `git commit -am "style(note-card): R5.5 — tag pills display leading #"`

### Task 8: Deploy + drill handoff

- [ ] **Step 1:** `manifest.json` version → `0.1.19`.
- [ ] **Step 2:** Full check: `node --check main.js`; `node --test lib/doc-container.test.js` (70/70).
- [ ] **Step 3:** Copy `main.js`, `manifest.json`, `styles.css` (if present) to `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`.
- [ ] **Step 4: Commit** — `git commit -am "chore: bump 0.1.19 — round 5 (R5.1 fix + confirm-always gate + tab restructure + card styling batch)"`

## Verification (whole round)
`node --check main.js`; tests 70/70; deploy OB_Testing; consolidated Paul drill: R5.1 repro attempt (remove/re-add from card, check parent tab — the new `doc detail render:` dlog line evidences the pane state), removal-confirm on manually named note, tab restructure, card styling/animations, Executive Summary persistence (check `_document.md` frontmatter), pills with `#`, held step 6 (log-rename follow-through), then full regression sweep.

## Out of scope
Encryption, iPad smoke, merge, migrating existing notes.
