# Upload First Version — Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply Paul's five drill follow-ups: Upload as a modal format tab with a drag-and-drop zone, centered/enlarged pending-pane actions with an upload modal, no pre-selected template, accent-coloured delete-confirm title, and a title-mismatch prompt (full-rename adopt) on pending uploads.

**Architecture:** Spec Round 2 section of `docs/superpowers/specs/2026-07-16-upload-first-version-design.md` (R2.1–R2.5). One shared `buildUploadDropZone` widget feeds both surfaces; all pending-upload arrivals now route through a new `uploadIntoPending` plugin method, which Task 3 upgrades with the title-mismatch gate.

**Tech Stack:** Plain JS, single `main.js`, no lib changes this round (`node --test lib/doc-container.test.js` must stay 76/76 untouched).

## Global Constraints

- Branch: `container-notes`. Working dir: `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office\`.
- `node --check main.js` before EVERY commit; lib tests stay 76/76 (no lib edits).
- Upload formats: docx, pptx, xlsx ONLY. No emojis in UI copy.
- Existing signatures must not change: `attachFirstVersion(docFolder, pendingName, {ext, bytes, templatePath, originalName, openDetail})`, `createDocumentFromUpload({containerPath, title, name, ext, bytes})`, `_pickOfficeFile()`, `openCreateFileModal(node, leaf)`.
- The modal's `onSubmit`-override variants (loose related doc; pending Create file) must keep working; the Upload tab appears only when `!this.onSubmit` (same gate as round 1's upload row).
- Anchor edits on quoted code, not line numbers. Do NOT stage pre-existing untracked files (`pdf-editor/`, `docs/superpowers/plans/2026-07-12-note-card-round5.md`).

---

### Task 1: Modal rework — Upload tab + no pre-selected template (R2.1 + R2.3)

**Files:**
- Modify: `main.js` — `class NewDocumentModal` (anchor: `class NewDocumentModal extends obsidian.Modal`), a new module-level `buildUploadDropZone` function directly ABOVE that class, and the injected CSS block (anchor: `.doc-detail-hbtn {` near main.js:835).

**Interfaces:**
- Consumes: `plugin._pickOfficeFile()`, `plugin.createDocumentFromUpload(...)`, `plugin.createPendingDocument(...)` (all existing).
- Produces: module-level `buildUploadDropZone(plugin, parent, onPicked)` — Task 2's `UploadDropModal` calls it; `onPicked` receives `{name, ext, bytes}`. Modal state fields `this.uploadTab` (bool) and `this.templatePath === null` meaning nothing-selected (`''` still means the Blank card).

- [ ] **Step 1: Shared drop zone.** Insert directly above `class NewDocumentModal`:

```js
// Shared drag-and-drop / click-to-upload zone for office files (R2.1/R2.2).
// Click opens the OS picker; a single dropped file is read the same way.
// onPicked receives {name, ext, bytes}; invalid types Notice and are ignored.
function buildUploadDropZone(plugin, parent, onPicked) {
  const zone = parent.createDiv('doc-upload-zone');
  const ico = zone.createDiv('doc-upload-zone-ico');
  obsidian.setIcon(ico, 'upload');
  zone.createDiv({ cls: 'doc-upload-zone-txt', text: 'Drop a file here, or click to choose' });
  zone.createDiv({ cls: 'doc-upload-zone-sub', text: '.docx · .pptx · .xlsx' });
  const readFile = async (f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!['docx', 'pptx', 'xlsx'].includes(ext)) { new obsidian.Notice('Only .docx, .pptx, or .xlsx files can be uploaded.'); return; }
    try { onPicked({ name: f.name, ext, bytes: await f.arrayBuffer() }); }
    catch (e) { new obsidian.Notice('Could not read file: ' + (e && e.message || e)); }
  };
  zone.onclick = async () => { const picked = await plugin._pickOfficeFile(); if (picked) onPicked(picked); };
  zone.ondragover = (e) => { e.preventDefault(); zone.addClass('drag'); };
  zone.ondragleave = () => zone.removeClass('drag');
  zone.ondrop = (e) => { e.preventDefault(); zone.removeClass('drag'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); };
  return zone;
}
```

- [ ] **Step 2: CSS.** In the injected CSS template block (same block as `.doc-detail-hbtn {`), add:

```css
.doc-upload-zone { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; border:2px dashed var(--background-modifier-border); border-radius:8px; padding:28px 16px; cursor:pointer; text-align:center; }
.doc-upload-zone:hover, .doc-upload-zone.drag { border-color: var(--interactive-accent); background: var(--background-modifier-hover); }
.doc-upload-zone-ico svg { width:28px; height:28px; color: var(--text-muted); }
.doc-upload-zone-txt { font-size:13px; color: var(--text-normal); }
.doc-upload-zone-sub { font-size:11px; color: var(--text-faint); }
.doc-newdoc-upchiprow { display:flex; align-items:center; gap:8px; padding:12px; border:1px solid var(--background-modifier-border); border-radius:8px; }
.doc-pending-actions { display:flex; gap:16px; justify-content:center; margin:24px 0 12px; }
.doc-pending-actions .doc-detail-hbtn.big { font-size:13px; padding:10px 22px; }
```

(`.doc-pending-actions` rules are consumed by Task 2 — adding them here keeps the CSS in one commit.)

- [ ] **Step 3: Constructor.** In `NewDocumentModal`'s constructor: change `this.templatePath = '';   // '' = Blank (embedded fallback)` to:

```js
    this.templatePath = null;  // null = NOTHING selected (R2.3); '' = the Blank card
    this.uploadTab = false;    // R2.1: 4th format tab
```

(`this.staged` stays from round 1.)

- [ ] **Step 4: Format segment gains the Upload tab.** Replace the format-buttons loop (anchor: `[['docx', 'Document'], ['pptx', 'Presentation'], ['xlsx', 'Spreadsheet']].forEach(([ext, label]) => {`) with:

```js
    const tabs = [['docx', 'Document'], ['pptx', 'Presentation'], ['xlsx', 'Spreadsheet']];
    if (!this.onSubmit) tabs.push(['upload', 'Upload']);   // R2.1: only the plain container-create modal uploads
    tabs.forEach(([key, label]) => {
      const b = seg.createEl('button', { text: label });
      b.style.cssText = 'flex:1;padding:6px;';
      b.addEventListener('click', () => {
        if (key === 'upload') { this.uploadTab = true; }
        else { this.uploadTab = false; this.ext = key; this.staged = null; }   // leaving Upload clears the staged file
        this.templatePath = null;                                              // R2.3: no selection survives a tab switch
        this._renderFormats(); this._renderTemplates(); this._syncCreateState();
      });
      this._fmtBtns[key] = b;
    });
```

- [ ] **Step 5: Remove the round-1 upload row.** Delete the whole `if (!this.onSubmit) { ... }` block that renders the "Or upload an existing file" label + "Upload file…" button (anchor: `text: 'Or upload an existing file'`), including the `upBtn` handler. Also delete the `_renderStaged()` method and the `this._renderStaged();` call at the end of `onOpen` — its staged-chip and grey-out duties move into `_renderTemplates` (next step). The `Template` label element must be captured: where `tmplWrap.createEl('label', { text: 'Template', cls: 'doc-newdoc-label' });` is created, change to `this._tmplLabel = tmplWrap.createEl('label', { text: 'Template', cls: 'doc-newdoc-label' });`

- [ ] **Step 6: `_renderFormats`** — replace the method body with:

```js
  _renderFormats() {
    Object.entries(this._fmtBtns).forEach(([key, b]) =>
      b.toggleClass('mod-cta', this.uploadTab ? key === 'upload' : key === this.ext));
  }
```

- [ ] **Step 7: `_renderTemplates`** — replace the method with:

```js
  _renderTemplates() {
    const grid = this._tmplGrid;
    grid.empty();
    if (this._tmplLabel) this._tmplLabel.setText(this.uploadTab ? 'Upload' : 'Template');
    if (this.uploadTab) {                                   // R2.1: tab body = drop zone / staged chip
      if (this.staged) {
        const chip = grid.createDiv('doc-newdoc-upchiprow');
        chip.createSpan({ text: this.staged.name });
        const x = chip.createSpan({ text: ' ✕' });
        x.style.cursor = 'pointer';
        x.setAttr('title', 'Clear staged file');
        x.onclick = () => { this.staged = null; this._renderTemplates(); this._syncCreateState(); };
      } else {
        buildUploadDropZone(this.plugin, grid, (picked) => {
          this.staged = picked;
          if (!this.titleInput.value.trim()) this.titleInput.value = picked.name.replace(/\.[^.]+$/, '');
          this._renderTemplates(); this._syncCreateState();
        });
      }
      return;
    }
    const root = this.plugin.settings.templatesRoot || '_obsidi-office-templates';
    const dir = root + '/' + this.ext;
    const blankName = ({ docx: 'Blank Document', pptx: 'Blank Presentation', xlsx: 'Blank Spreadsheet' })[this.ext] || 'Blank Document';
    const blankIcon = ({ docx: '\u{1F4C4}', pptx: '\u{1F4FD}', xlsx: '\u{1F4CA}' })[this.ext] || '\u{1F4C4}';
    const tmplIcon  = ({ docx: '\u{1F4DD}', pptx: '\u{1F39E}', xlsx: '\u{1F9EE}' })[this.ext] || '\u{1F4DD}';
    const extras = [];
    for (const f of this.app.vault.getFiles()) {
      if (f.path.startsWith(dir + '/') && f.extension === this.ext) extras.push({ name: f.basename, path: f.path, icon: tmplIcon });
    }
    extras.sort((a, b) => a.name.localeCompare(b.name));
    const cards = [{ name: blankName, path: '', icon: blankIcon }, ...extras];   // Blank first — selectable, NOT pre-selected (R2.3)
    for (const c of cards) {
      const card = grid.createEl('div', { cls: 'template-card' });
      card.createEl('div', { cls: 'icon', text: c.icon });
      card.createEl('div', { cls: 'label', text: c.name });
      card.toggleClass('is-selected', this.templatePath !== null && c.path === this.templatePath);
      card.addEventListener('click', () => { this.templatePath = c.path; this._renderTemplates(); this._syncCreateState(); });
    }
  }
```

(The emoji-valued icon constants are pre-existing template-card icons carried over verbatim, not new UI copy.)

- [ ] **Step 8: `_syncCreateState`** — replace with:

```js
  _syncCreateState() {
    const okTitle = !!this.titleInput.value.trim();
    const okSource = this.uploadTab ? !!this.staged : this.templatePath !== null;   // R2.3
    const ok = okTitle && okSource;
    this._createBtn.disabled = !ok;
    this._createBtn.style.opacity = ok ? '' : '0.5';
    if (this._laterBtn) { this._laterBtn.disabled = !okTitle; this._laterBtn.style.opacity = okTitle ? '' : '0.5'; }   // Decide Later needs a title only
  }
```

- [ ] **Step 9: `_submit`** — in the staged/unstaged branch (round 1's), change the conditions/values: the upload branch triggers on `this.uploadTab && this.staged`; the template branch passes `templatePath: this.templatePath || ''` (downstream treats `''` as the embedded blank — `null` must never reach it, and `_syncCreateState` guarantees it can't):

```js
    let result;
    if (this.uploadTab && this.staged) {
      result = await this.plugin.createDocumentFromUpload({
        containerPath: this.containerPath, title,
        name: this.staged.name, ext: this.staged.ext, bytes: this.staged.bytes });
    } else {
      result = this.onSubmit
        ? await this.onSubmit({ title, ext: this.ext, templatePath: this.templatePath || '' })
        : await this.plugin.createDocumentInContainer({ containerPath: this.containerPath, title, ext: this.ext, templatePath: this.templatePath || '' });
    }
```

- [ ] **Step 10: Verify + commit**

Run: `node --check main.js` (clean) and `node --test lib/doc-container.test.js` (76/76).

```bash
git add main.js
git commit -m "feat(doc-container): modal Upload tab + drop zone; no pre-selected template (R2.1, R2.3)"
```

---

### Task 2: Pending pane redesign + UploadDropModal + delete-confirm accent (R2.2 + R2.4)

**Files:**
- Modify: `main.js` — `_renderFilesPane` pending branch (anchor: `if (this.node.pending && !this.node.current) {` inside `_renderFilesPane`), new `class UploadDropModal` (insert directly above `class DeleteConfirmModal`), new plugin method `uploadIntoPending` (insert directly after `openCreateFileModal`), `DeleteConfirmModal.onOpen` first paragraph.

**Interfaces:**
- Consumes: `buildUploadDropZone(plugin, parent, onPicked)` (Task 1), `attachFirstVersion(...)`, `openCreateFileModal(node, leaf)`, `_refreshNode()` (all existing).
- Produces: `plugin.uploadIntoPending(node, picked, leaf)` → `Promise<string|undefined>` — Task 3 replaces this method's body with the title-mismatch gate; its signature must not change. `class UploadDropModal` constructed as `new UploadDropModal(this.app, this.plugin, this.node, this.leaf)`.

- [ ] **Step 1: Pane pending branch.** Replace the entire pending branch body inside `_renderFilesPane` (from `if (this.node.pending && !this.node.current) {` through its `return;` inclusive — the branch round 1 added, since amended with `_refreshNode`) with:

```js
    if (this.node.pending && !this.node.current) {
      // Pending document (R2.2): hint + two centered, enlarged actions.
      p.createDiv({ cls: 'doc-detail-stub', text: 'No working file yet — create one or upload an existing document.' });
      const actions = p.createDiv('doc-pending-actions');
      const cf = docIconLabel(actions, 'file-plus', 'Create file', { cls: 'doc-detail-hbtn big' });
      cf.onclick = () => this.plugin.openCreateFileModal(this.node, this.leaf);
      const up = docIconLabel(actions, 'upload', 'Upload', { cls: 'doc-detail-hbtn big' });
      up.onclick = () => new UploadDropModal(this.app, this.plugin, this.node, this.leaf).open();
      return;
    }
```

(The header `acts` div stays created but gains no buttons on pending — matching the mock, which shows the actions in the body.)

- [ ] **Step 2: UploadDropModal.** Insert directly above `class DeleteConfirmModal`:

```js
// ===========================================================================
// UploadDropModal — R2.2: pending container's Upload action; just a drop zone.
// ===========================================================================
class UploadDropModal extends obsidian.Modal {
  constructor(app, plugin, node, leaf) { super(app); this.plugin = plugin; this.node = node; this.leaf = leaf; }
  onOpen() {
    this.contentEl.createEl('h3', { text: 'Upload file for “' + this.node.name + '”' });
    buildUploadDropZone(this.plugin, this.contentEl, async (picked) => {
      this.close();
      await this.plugin.uploadIntoPending(this.node, picked, this.leaf);
    });
  }
  onClose() { this.contentEl.empty(); }
}
```

- [ ] **Step 3: `uploadIntoPending`.** Insert directly after the `openCreateFileModal` method:

```js
  // Pending-container upload arrival (R2.2). Task-3 upgrade adds the
  // title-mismatch gate here; the signature is load-bearing.
  async uploadIntoPending(node, picked, leaf) {
    const r = await this.attachFirstVersion(node.path, node.pending, { ext: picked.ext, bytes: picked.bytes, originalName: picked.name });
    if (r) new obsidian.Notice('Uploaded "' + picked.name + '"');
    const dv = leaf && leaf.view;
    if (dv && dv._refreshNode) { dv._refreshNode(); dv.render(); }
    return r;
  }
```

- [ ] **Step 4: Delete-confirm accent (R2.4).** In `DeleteConfirmModal.onOpen`, replace

```js
    contentEl.createEl('p', { text: 'This moves "' + this.name + '" and everything inside it (all versions, sidecars, log, forks) to your system trash. Recoverable from there.' });
```

with:

```js
    const p1 = contentEl.createEl('p');
    p1.appendText('This moves ');
    const nm = p1.createSpan({ text: '"' + this.name + '"' });
    nm.style.color = 'var(--text-accent)';
    nm.style.fontWeight = '600';
    p1.appendText(' and everything inside it (all versions, sidecars, log, forks) to your system trash. Recoverable from there.');
```

- [ ] **Step 5: Verify + commit**

Run: `node --check main.js` (clean) and `node --test lib/doc-container.test.js` (76/76).

```bash
git add main.js
git commit -m "feat(doc-container): pending pane centered actions + UploadDropModal; delete-confirm accent title (R2.2, R2.4)"
```

---

### Task 3: Title-mismatch prompt + full-rename adopt (R2.5)

**Files:**
- Modify: `main.js` — new `class TitleKeepModal` (insert directly above `class UploadDropModal`), replace the body of `uploadIntoPending` (Task 2's).

**Interfaces:**
- Consumes: `attachFirstVersion(...)`, `openDocDetail({path}, opts)`, `docContainer.documentBaseName(title)`, `app.fileManager.renameFile`, `app.fileManager.processFrontMatter`.
- Produces: nothing new consumed later.

- [ ] **Step 1: TitleKeepModal.** Insert directly above `class UploadDropModal`:

```js
// ===========================================================================
// TitleKeepModal — R2.5: container title vs uploaded file name; pick one.
// Resolves 'container' | 'file' | null (Esc/close = abort the upload).
// ===========================================================================
class TitleKeepModal extends obsidian.Modal {
  constructor(app, containerTitle, fileStem, resolve) {
    super(app); this.a = containerTitle; this.b = fileStem; this._resolve = resolve; this._done = false;
  }
  onOpen() {
    this.contentEl.createEl('h3', { text: 'Which title should this document keep?' });
    this.contentEl.createEl('p', { text: 'The container is titled "' + this.a + '" but the uploaded file is named "' + this.b + '".' });
    const row = this.contentEl.createDiv({ attr: { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:12px; flex-wrap:wrap;' } });
    const mk = (label, val, cta) => {
      const b = row.createEl('button', { text: label, cls: cta ? 'mod-cta' : '' });
      b.onclick = () => { this._done = true; this._resolve(val); this.close(); };
    };
    mk('Keep "' + this.a + '"', 'container', true);
    mk('Use "' + this.b + '"', 'file', false);
  }
  onClose() { this.contentEl.empty(); if (!this._done) this._resolve(null); }
}
```

- [ ] **Step 2: Gate + adopt.** Replace the body of `uploadIntoPending` with:

```js
  async uploadIntoPending(node, picked, leaf) {
    const stem = picked.name.replace(/\.[^.]+$/, '');
    let docFolder = node.path, pendingName = node.pending, adopted = false;
    // R2.5: mismatched titles → the user picks which one the document keeps.
    if (stem.trim().toLowerCase() !== String(node.name).trim().toLowerCase()) {
      const choice = await new Promise((resolve) => new TitleKeepModal(this.app, node.name, stem, resolve).open());
      if (!choice) return;                                   // Esc/close → abort; container stays pending
      if (choice === 'file') {
        const clean = stem.trim();
        if (/[\\/:*?"<>|]/.test(clean)) {
          new obsidian.Notice('File name contains \\ / : * ? " < > | — keeping "' + node.name + '".');
        } else {
          const parentPath = node.path.slice(0, node.path.lastIndexOf('/'));
          const target = parentPath + '/' + clean;
          if (this.app.vault.getAbstractFileByPath(target)) {
            new obsidian.Notice('A document named "' + clean + '" already exists here — keeping "' + node.name + '".');
          } else {
            // FULL rename (Paul's ruling): folder, marker base, and title all adopt the file's name.
            const folder = this.app.vault.getAbstractFileByPath(node.path);
            await this.app.fileManager.renameFile(folder, target);
            docFolder = target; adopted = true;
            const vm = pendingName.match(/_V(\d+\.\d+)/);
            const newMarkerName = docContainer.documentBaseName(clean) + '_V' + (vm ? vm[1] : '1.0') + '.md';
            if (pendingName !== newMarkerName) {
              const sc = this.app.vault.getAbstractFileByPath(docFolder + '/' + pendingName);
              if (sc) { await this.app.fileManager.renameFile(sc, docFolder + '/' + newMarkerName); pendingName = newMarkerName; }
            }
            const sc2 = this.app.vault.getAbstractFileByPath(docFolder + '/' + pendingName);
            if (sc2) await this.app.fileManager.processFrontMatter(sc2, (front) => { front.title = clean; });
          }
        }
      }
    }
    const r = await this.attachFirstVersion(docFolder, pendingName, { ext: picked.ext, bytes: picked.bytes, originalName: picked.name });
    if (r) new obsidian.Notice('Uploaded "' + picked.name + '"');
    if (adopted) {
      await this.openDocDetail({ path: docFolder }, {});     // path changed — _refreshNode would look up the old path
    } else {
      const dv = leaf && leaf.view;
      if (dv && dv._refreshNode) { dv._refreshNode(); dv.render(); }
    }
    return r;
  }
```

- [ ] **Step 3: Verify + commit**

Run: `node --check main.js` (clean) and `node --test lib/doc-container.test.js` (76/76).

```bash
git add main.js
git commit -m "feat(doc-container): title-mismatch prompt on pending upload — full-rename adopt (R2.5)"
```

---

### Task 4: bump 0.1.27 + deploy + drill

- [ ] **Step 1:** `manifest.json` version → `0.1.27`.
- [ ] **Step 2:** `node --check main.js` + `node --test lib/doc-container.test.js` — both clean.
- [ ] **Step 3:** Commit manifest; copy `main.js` + `manifest.json` → `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`.
- [ ] **Step 4: Drill (Paul):**
  1. Modal opens: no template selected, Create disabled; title alone doesn't enable it; clicking Blank enables. Tab switch clears selection.
  2. Upload tab: drop zone (drag a docx onto it AND click-to-pick), staged chip + ✕, title defaults, Create → document lands.
  3. Decide Later → pending pane shows hint + two centered large buttons; Create file opens the modal (no preselected template, title locked); Upload opens the drop-zone modal.
  4. Upload a file whose name ≠ container title → prompt; test all three exits: Keep (file renamed to container base), Use (folder + title + file all adopt file name; tree and detail follow), Esc (nothing written, still pending).
  5. Adopt-name collision: create sibling with the file's name first → Notice, keeps container title, upload succeeds.
  6. Delete a container → confirm modal shows the name in accent colour.
  7. Regressions: loose related-doc modal untouched (no Upload tab, template behavior per R2.3 with its own onSubmit), normal-container Files & Versions unchanged.
