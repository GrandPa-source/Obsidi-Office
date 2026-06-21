# Mandatory Check-out Gate + Immutable Version History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the advisory check-out into an editing gate — a doc-container-managed document opens read-only and becomes editable only while the current author holds the lock on the current version; prior versions are immutable read-only history.

**Architecture:** A single pure decision function (`editGateDecision`) in `lib/doc-container.js` (unit-tested, then inlined into `main.js`) encodes the read-only/editable decision table. `OfficeEditorView` gains thin Obsidian-bound wrappers (`_lockStateForFile`, `_isCurrentVersion`, `_editGate`) that gather inputs and call it. `_buildEditorConfig` drives editor mode/permissions from the result, a bottom-center status-strip banner communicates state, `newDocumentVersion` gains a guard, and the existing lock listener reconciles open editors on lock transitions.

**Tech Stack:** Plain JS Obsidian plugin (no TS build), `node:test` for pure-core tests, `scripts/inline-doc-container.js` to fold `lib/doc-container.js` into `main.js`. Deploy by copying `main.js` to OB_Testing.

## Global Constraints

- **Scope guard (verbatim from spec):** the gate applies ONLY when `settings.docBrowserEnabled` is on AND the file is under `settings.docRoot + '/'` AND its extension is in `docContainer.MANAGED_EXTS` (`['docx','pptx','xlsx','pdf']`). Any other file stays freely editable with no banner. The gate must never make an ordinary office document read-only.
- **Lib edits require re-inlining:** after editing `lib/doc-container.js`, run `node scripts/inline-doc-container.js` to regenerate the `// <doc-container-core>` block in `main.js`. New `main.js`-scope helpers go OUTSIDE that block.
- **Lib symbols used at plugin/view scope must be referenced as `docContainer.X`** (e.g. `docContainer.editGateDecision`, `docContainer.MANAGED_EXTS`, `docContainer.groupDocumentFiles`).
- **Author identity:** current author is `resolveAuthorId()` (already defined at `main.js` module scope).
- **Lock carry-forward is RETAINED** — do not strip `checkedOutBy`/`checkedOutAt` when copying sidecars in `newDocumentVersion`.
- **Out of scope:** Rung B `_document.md` apply, `checkoutTimeoutHours` enforcement, P01_WhiteList identity, force-check-in policy changes.
- `node --check main.js` must pass after every `main.js` edit (catches the smart-quote / inline-IIFE-scope class of bugs that syntax-checking can catch).

---

### Task 1: Pure `editGateDecision` decision function

**Files:**
- Modify: `lib/doc-container.js` (add function + export)
- Test: `lib/doc-container.test.js` (append cases)
- Modify (generated): `main.js` (via inline script)

**Interfaces:**
- Produces: `editGateDecision({ managed, current, heldByMe, heldByOther }) → { editable: boolean, state: string }` where `state ∈ {'unmanaged','old-version','held-by-me','held-by-other','unlocked'}`. Consumed by `_editGate` (Task 2) and the banner (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
// Task: edit-gate decision table
test('editGateDecision: non-managed file is always editable', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: false }),
    { editable: true, state: 'unmanaged' });
});
test('editGateDecision: managed old version is read-only history', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: false, heldByMe: true, heldByOther: false }),
    { editable: false, state: 'old-version' });
});
test('editGateDecision: current held by me is editable', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: true, heldByOther: false }),
    { editable: true, state: 'held-by-me' });
});
test('editGateDecision: current held by other is read-only', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: false, heldByOther: true }),
    { editable: false, state: 'held-by-other' });
});
test('editGateDecision: current unlocked is read-only (must check out)', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: false, heldByOther: false }),
    { editable: false, state: 'unlocked' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.editGateDecision is not a function`.

- [ ] **Step 3: Implement the function**

In `lib/doc-container.js`, immediately after the `lockStateFromFront` function (around line 386, before `module.exports`), add:

```js
// Pure edit-gate decision for a doc-container document. Inputs are booleans the
// caller resolves from Obsidian; output drives editor read-only state + banner copy.
// Order matters: managed → current → held-by-me → held-by-other → unlocked.
function editGateDecision(g) {
  if (!g || !g.managed) return { editable: true, state: 'unmanaged' };
  if (!g.current) return { editable: false, state: 'old-version' };
  if (g.heldByMe) return { editable: true, state: 'held-by-me' };
  if (g.heldByOther) return { editable: false, state: 'held-by-other' };
  return { editable: false, state: 'unlocked' };
}
```

- [ ] **Step 4: Export it**

In the `module.exports = { ... }` block (line 388), add `editGateDecision,` on its own line after `lockStateFromFront,`:

```js
  lockStateFromFront,
  editGateDecision,
  forkFileName,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS — all existing tests plus the 5 new ones.

- [ ] **Step 6: Re-inline into main.js**

Run: `node scripts/inline-doc-container.js`
Expected: prints `inlined lib/doc-container.js into main.js`.

Then: `node --check main.js`
Expected: no output (syntax OK).

- [ ] **Step 7: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure editGateDecision decision table + tests"
```

---

### Task 2: Editor gate predicates + apply to editor config

**Files:**
- Modify: `main.js` — `OfficeEditorView._isLockedByOther` (line ~3041), `_buildEditorConfig` (line ~3052), add 3 new methods.

**Interfaces:**
- Consumes: `docContainer.editGateDecision`, `docContainer.MANAGED_EXTS`, `docContainer.groupDocumentFiles`, `docContainer.lockStateFromFront`, `docContainer.DOCUMENT_MD_NAME` (all from Task 1's inlined core), `resolveAuthorId()`.
- Produces: `_editGate(file) → { editable, state, holder }` and `view._lastGate` / `view._gateEditable` instance fields. Consumed by the banner (Task 3) and the listener (Task 5).

- [ ] **Step 1: Add `_lockStateForFile` and refactor `_isLockedByOther`**

Replace the existing `_isLockedByOther` method (lines ~3041-3051):

```js
  _isLockedByOther(file) {
    const slash = file.path.lastIndexOf('/');
    const folder = slash >= 0 ? file.path.slice(0, slash) : '';
    const dm = this.app.vault.getAbstractFileByPath(folder + '/' + docContainer.DOCUMENT_MD_NAME);
    const sc = this.app.vault.getAbstractFileByPath(file.path + '.md');
    const lf = (dm instanceof obsidian.TFile) ? dm : (sc instanceof obsidian.TFile ? sc : null);
    if (!lf) return false;
    const fm = (this.app.metadataCache.getFileCache(lf) || {}).frontmatter || {};
    const st = docContainer.lockStateFromFront(fm, new Date().toISOString(), this.plugin.settings.checkoutTimeoutHours || 0);
    return !!st.by && st.by !== resolveAuthorId();
  }
```

with:

```js
  // Lock state for a file, read from its _document.md (if present) else its sidecar.
  _lockStateForFile(file) {
    const slash = file.path.lastIndexOf('/');
    const folder = slash >= 0 ? file.path.slice(0, slash) : '';
    const dm = this.app.vault.getAbstractFileByPath(folder + '/' + docContainer.DOCUMENT_MD_NAME);
    const sc = this.app.vault.getAbstractFileByPath(file.path + '.md');
    const lf = (dm instanceof obsidian.TFile) ? dm : (sc instanceof obsidian.TFile ? sc : null);
    const fm = lf ? (this.app.metadataCache.getFileCache(lf) || {}).frontmatter || {} : {};
    return docContainer.lockStateFromFront(fm, new Date().toISOString(), this.plugin.settings.checkoutTimeoutHours || 0);
  }
  _isLockedByOther(file) {
    const st = this._lockStateForFile(file);
    return !!st.by && st.by !== resolveAuthorId();
  }
  // True when `file` is the highest (current) version in its document folder.
  _isCurrentVersion(file) {
    const parent = file.parent;
    if (!parent || !parent.children) return true;
    const names = parent.children.filter(c => c instanceof obsidian.TFile).map(c => c.name);
    return docContainer.groupDocumentFiles(names).current === file.name;
  }
  // Resolve the full edit-gate for a file (scope guard + current + lock holder).
  _editGate(file) {
    const s = this.plugin.settings;
    const managed = !!s.docBrowserEnabled && !!file
      && file.path.startsWith(s.docRoot + '/')
      && docContainer.MANAGED_EXTS.includes((file.extension || '').toLowerCase());
    if (!managed) return { editable: true, state: 'unmanaged', holder: null };
    const current = this._isCurrentVersion(file);
    const st = this._lockStateForFile(file);
    const me = resolveAuthorId();
    const dec = docContainer.editGateDecision({
      managed: true, current,
      heldByMe: !!st.by && st.by === me,
      heldByOther: !!st.by && st.by !== me,
    });
    return { editable: dec.editable, state: dec.state, holder: st.by || null };
  }
```

- [ ] **Step 2: Drive `_buildEditorConfig` from the gate**

In `_buildEditorConfig`, replace the `lockedOut` declaration (line ~3056):

```js
    const lockedOut = this.plugin.settings.docBrowserEnabled && this._isLockedByOther(this.file);
```

with:

```js
    const gate = this._editGate(this.file);
    const editable = gate.editable;
    this._lastGate = gate;          // consumed by _syncEditGateBanner
    this._gateEditable = editable;  // consumed by _enforceCheckoutOnOpenEditors
```

- [ ] **Step 3: Use `editable` in permissions and mode**

Replace the permissions line (line ~3071):

```js
          edit: !lockedOut, copy: true, comment: !lockedOut, review: false
```

with:

```js
          edit: editable, copy: true, comment: editable, review: false
```

Replace the mode line (line ~3077):

```js
        mode: lockedOut ? "view" : this.plugin.settings.defaultMode,
```

with:

```js
        mode: editable ? this.plugin.settings.defaultMode : "view",
```

- [ ] **Step 4: Syntax check**

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): edit-gate predicates + gate editor mode/permissions"
```

**Note:** these methods call the Obsidian API and have no node unit test; behavioral verification is the smoke checklist in Task 6.

---

### Task 3: Read-only banner (bottom-center status strip)

**Files:**
- Modify: `main.js` — `DOC_CONTAINER_CSS` (line ~585), `OfficeEditorView` (add `_syncEditGateBanner`), `onLoadFile` call site (next to `_syncReturnAction`, line ~2502).

**Interfaces:**
- Consumes: `this._lastGate` (Task 2), `this._editGate` (Task 2).

- [ ] **Step 1: Add banner CSS**

In the `DOC_CONTAINER_CSS` template literal, immediately after the `.doc-return-btn` rules, add:

```css
.doc-editgate-banner { position:absolute; bottom:6px; left:50%; transform:translateX(-50%); z-index:1000; max-width:60%; padding:3px 12px; font-size:12px; border-radius:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; background-color:#e5614c !important; color:#fff !important; }
.doc-editgate-banner.mine { background-color:var(--background-modifier-border) !important; color:var(--text-muted) !important; }
```

- [ ] **Step 2: Add the `_syncEditGateBanner` method**

Immediately after the `_syncReturnAction` method's closing brace (line ~2484, before `getState()`), add:

```js
  // State-aware banner centered in the editor's bottom status strip. Read-only states
  // use the attention (red) style; "checked out by you" uses the muted .mine style.
  // No banner for non-managed files. Re-created each load like _syncReturnAction.
  _syncEditGateBanner() {
    if (this._gateBannerEl) { this._gateBannerEl.remove(); this._gateBannerEl = null; }
    const g = this._lastGate || (this.file ? this._editGate(this.file) : null);
    if (!g || g.state === 'unmanaged') return;
    let text = '';
    if (g.state === 'old-version') text = 'Read-only — prior version (history).';
    else if (g.state === 'held-by-other') text = 'Read-only — checked out by ' + (g.holder || 'another author') + '.';
    else if (g.state === 'unlocked') text = 'Read-only — check out from the Overview to edit.';
    else if (g.state === 'held-by-me') text = 'Checked out by you';
    else return;
    const cls = 'doc-editgate-banner' + (g.state === 'held-by-me' ? ' mine' : '');
    this._gateBannerEl = this.containerEl.createEl('div', { cls: cls, text: text });
  }
```

- [ ] **Step 3: Call it after the editor renders**

In `onLoadFile`, find the line that calls `this._syncReturnAction();` (line ~2502) and add the banner call right after it:

```js
      await this._onLoadFileInner(file);
      this._syncReturnAction();   // add the floating Return button AFTER the editor renders (else _renderEditor wipes it)
      this._syncEditGateBanner(); // same: banner added post-render so re-render can't wipe it
```

- [ ] **Step 4: Syntax check**

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): bottom-center read-only / checked-out banner"
```

---

### Task 4: New-version guard (block when held by another)

**Files:**
- Modify: `main.js` — `newDocumentVersion` (line ~7301).

**Interfaces:**
- Consumes: `this.readLock(node)` (existing plugin method, returns `{by, at, stale}`), `resolveAuthorId()`.

- [ ] **Step 1: Add the guard**

In `newDocumentVersion`, find the opening guard:

```js
  async newDocumentVersion(node) {
    if (!node || !node.current) { new obsidian.Notice('No current file to version'); return; }
```

and insert the lock check immediately after it:

```js
  async newDocumentVersion(node) {
    if (!node || !node.current) { new obsidian.Notice('No current file to version'); return; }
    const lk = this.readLock(node);
    if (lk.by && lk.by !== resolveAuthorId()) {
      new obsidian.Notice('Checked out by ' + lk.by + ' — cannot create a new version.');
      return;
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): block new version when checked out by another author"
```

---

### Task 5: Live editor reconcile on lock transitions

**Files:**
- Modify: `main.js` — `_enforceCheckoutOnOpenEditors` (line ~6974).

**Interfaces:**
- Consumes: `view._editGate` (Task 2), `view._gateEditable` (Task 2), `view._kicked`, `view._suppressEditLogReset`, `this._promptKick` (existing).

- [ ] **Step 1: Extend the enforcement loop**

Replace the existing `_enforceCheckoutOnOpenEditors` method:

```js
  _enforceCheckoutOnOpenEditors() {
    if (!this.settings.docBrowserEnabled) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof OfficeEditorView) || !view.file) return;
      const lockedOut = view._isLockedByOther(view.file);
      if (lockedOut && !view._kicked) { view._kicked = true; this._promptKick(view); }
      else if (!lockedOut && view._kicked) { view._kicked = false; }
    });
  }
```

with:

```js
  _enforceCheckoutOnOpenEditors() {
    if (!this.settings.docBrowserEnabled) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof OfficeEditorView) || !view.file) return;
      const gate = view._editGate(view.file);
      const lockedOut = gate.state === 'held-by-other';
      // Kick modal (+ fork offer) only when another author grabbed a doc you could edit.
      if (lockedOut && !view._kicked) { view._kicked = true; this._promptKick(view); return; }
      if (!lockedOut && view._kicked) view._kicked = false;
      // Reconcile read-only/editable + banner when YOUR gate flips (check out / check in
      // from the Overview while the editor is open). _promptKick already reloads its case.
      if (view._gateEditable !== gate.editable) {
        view._gateEditable = gate.editable;
        view._suppressEditLogReset = true;
        view.onLoadFile(view.file);
      }
    });
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): reconcile open editors on lock transitions"
```

---

### Task 6: Files & Versions affordance + deploy + smoke

**Files:**
- Modify: `main.js` — `_renderFilesPane` (line ~3598).

**Interfaces:**
- Consumes: existing `rowFor` closure in `_renderFilesPane`.

- [ ] **Step 1: Add read-only hint to prior-version rows**

In `_renderFilesPane`, find the open-button line inside `rowFor`:

```js
      const openBtn = r.createSpan({ text: isCurrent ? 'Open in editor' : 'Open', cls: 'doc-detail-fbtn' });
      openBtn.onclick = (e) => this.plugin.openDocInEditor(this.node.path + '/' + name, this.node.path, !!(e && (e.metaKey || e.ctrlKey)), this.leaf);
```

and add a tooltip on non-current rows by inserting after the `openBtn` declaration:

```js
      const openBtn = r.createSpan({ text: isCurrent ? 'Open in editor' : 'Open', cls: 'doc-detail-fbtn' });
      if (!isCurrent) openBtn.setAttr('title', 'Opens read-only — prior version (history)');
      openBtn.onclick = (e) => this.plugin.openDocInEditor(this.node.path + '/' + name, this.node.path, !!(e && (e.metaKey || e.ctrlKey)), this.leaf);
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 3: Deploy to OB_Testing**

Run:
```bash
cp main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
md5sum main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
```
Expected: identical md5 on both lines.

- [ ] **Step 4: Smoke test (desktop + iPad), on a real `docRoot` document**

Reload Obsidi-Office, then verify:
1. Open current version WITHOUT checking out → editor read-only; banner "Read-only — check out from the Overview to edit." (centered, red).
2. Overview → Check out → Open in editor → editable; banner "Checked out by you" (muted).
3. With editor open, Overview → Check in → editor flips to read-only automatically (no manual reload); banner returns to "check out" message.
4. Open a prior version from Files & Versions → always read-only; banner "Read-only — prior version (history)."; hover its Open button shows the tooltip.
5. Simulate a second author (different `authorLabel`/username) holding the lock → your editor read-only, banner names the holder; their force check-in mid-edit → kick modal + "Save a copy" fork offer.
6. New-version guard: attempt New version while another holds the lock → blocked Notice; while you hold it → succeeds and the new current stays editable by you.
7. Regression: open a plain `.docx` OUTSIDE `docRoot` → editable, no banner.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): read-only hint on prior-version rows; deploy + smoke"
```

---

## Self-Review

**Spec coverage:**
- Editing gate (§1) → Tasks 1, 2. Banner (§2) → Task 3. Control surface Overview-only (§3) → no code change needed (lock bar unchanged; editor offers no check-out). Version model (§4): only-current-editable → Task 2 (`_isCurrentVersion` + decision); new-version guard → Task 4; Files&Versions affordance → Task 6; carry-forward retained → Global Constraints (no change). Live propagation (§5) → Task 5. Scope guard → Task 2 + Global Constraints.
- Resolved O1 (muted "Checked out by you") → Task 3 `.mine`. Resolved O2 (centered) → Task 3 CSS `left:50%; translateX(-50%)`.

**Placeholder scan:** none — every code step shows full code; every run step shows command + expected output.

**Type consistency:** `editGateDecision` signature `{managed,current,heldByMe,heldByOther} → {editable,state}` is identical in Task 1 (def + tests) and Task 2 (call). `_editGate → {editable,state,holder}` consumed consistently by Task 3 (`state`,`holder`) and Task 5 (`state`,`editable`). `_gateEditable`/`_lastGate` set in Task 2, read in Tasks 3/5. `state` enum values are identical across Tasks 1/3/5.
