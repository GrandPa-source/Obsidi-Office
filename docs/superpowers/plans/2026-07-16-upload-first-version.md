# Upload First Version + Decide Later (Pending Documents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A doc container's first version can be an uploaded existing docx/pptx/xlsx, or deferred entirely ("Decide Later" → a pending document the Files & Versions tab later fills via "Create file" / "Upload").

**Architecture:** Approach A of the spec (`docs/superpowers/specs/2026-07-16-upload-first-version-design.md`): the pending marker IS the seeded sidecar `<Base>_V1.0.md`; `buildTaxonomy` learns to classify it; all three file-arrival paths converge on one choke point `attachFirstVersion` (rename sidecar first, then `createBinary`) so the container degrades back to pending on failure. `attachFirstVersion` is the future fidelity-layer ingest seam — NO conversion code in this build.

**Tech Stack:** Plain JS (no build). Pure core in `lib/doc-container.js` (node:test), inlined into `main.js` via `scripts/inline-doc-container.js`. Obsidian API only.

## Global Constraints

- Branch: `container-notes`. Working dir: `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office\`.
- `node --check main.js` before EVERY commit.
- Any `lib/doc-container.js` change ⇒ `node scripts/inline-doc-container.js` regen + `node --test lib/doc-container.test.js` before committing.
- Upload formats: docx, pptx, xlsx ONLY (pdf stays attachment-only).
- Pending sidecar regex (both name forms): `/_V\d+\.\d+(\.[a-z0-9]+)?\.md$/i`.
- Uploaded files are RENAMED to `<Base>_V<maj>.<min>.<ext>`; original filename goes to the activity log only.
- `main.js` line numbers below are pre-Task-1 approximations — anchor edits on the quoted code, not the numbers (the inline regen shifts lines).
- No emojis in UI copy. Deploy (Task 6 only) = copy `main.js` + `manifest.json` to `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`.

---

### Task 1: lib — pending-document detection in buildTaxonomy

**Files:**
- Modify: `lib/doc-container.js` (buildTaxonomy ~L131-188; exports ~L477)
- Test: `lib/doc-container.test.js` (append at end)
- Regen: `main.js` (via `node scripts/inline-doc-container.js`)

**Interfaces:**
- Consumes: existing `isSidecar`, `isManaged`, `isNoteBody`, `groupDocumentFiles`.
- Produces: taxonomy document nodes MAY carry `pending: '<sidecarName>'` with `current: null, files: []` (normal documents never have `.pending`); new export `PENDING_SIDECAR_RE`.

- [ ] **Step 1: Write the failing tests** — append to `lib/doc-container.test.js`:

```js
// 2026-07-16: pending documents (upload-first-version design)
test('buildTaxonomy: folder with only a _V sidecar is a pending document', () => {
  const tree = dc.buildTaxonomy(['Documents/Gov/Policy/Policy_V1.0.md'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.pending, 'Policy_V1.0.md');
  assert.strictEqual(doc.current, null);
  assert.deepStrictEqual(doc.files, []);
});

test('buildTaxonomy: ext-named pending sidecar (half-completed attach) still pending', () => {
  const tree = dc.buildTaxonomy(['Documents/Gov/Policy/Policy_V1.0.docx.md'], 'Documents');
  assert.strictEqual(tree[0].children[0].pending, 'Policy_V1.0.docx.md');
});

test('buildTaxonomy: office file wins over pending sidecar (normal document)', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Gov/Policy/Policy_V1.0.docx', 'Documents/Gov/Policy/Policy_V1.0.docx.md'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.current, 'Policy_V1.0.docx');
  assert.strictEqual(doc.pending, undefined);
});

test('buildTaxonomy: cnote body wins over pending sidecar (note container)', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Notes/Idea/body.cnote', 'Documents/Notes/Idea/Idea_V1.0.md'], 'Documents');
  assert.strictEqual(tree[0].children[0].kind, 'note');
});

test('buildTaxonomy: plain sidecars do NOT create a pending document', () => {
  assert.deepStrictEqual(dc.buildTaxonomy(['Documents/Gov/Policy/notes.md'], 'Documents'), []);
});

test('buildTaxonomy: stray files in a pending folder become attachments', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Gov/Policy/Policy_V1.0.md', 'Documents/Gov/Policy/scan.png'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.pending, 'Policy_V1.0.md');
  assert.deepStrictEqual(doc.attachments, ['scan.png']);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test lib/doc-container.test.js`
Expected: the 6 new tests FAIL (`doc.kind` undefined / `tree[0]` undefined — pending folders produce no leaf today); all pre-existing tests still PASS.

- [ ] **Step 3: Implement.** In `lib/doc-container.js`:

(a) Near `MANAGED_EXTS` (top of file), add:

```js
// Pending-document marker: an explicitly _V-versioned sidecar, with or without
// the office extension in its name ("Policy_V1.0.md" or "Policy_V1.0.docx.md" —
// the latter = a half-completed attach, still pending/retryable).
const PENDING_SIDECAR_RE = /_V\d+\.\d+(\.[a-z0-9]+)?\.md$/i;
```

(b) Replace the body of `buildTaxonomy` (from `const folderFiles = new Map();` through the final leaves loop) with:

```js
  const prefix = root.replace(/\/+$/, '') + '/';
  // folderPath → all direct child filenames (non-sidecar)
  const folderFiles = new Map();
  // folderPath → direct child sidecar names (kept ONLY to detect pending documents)
  const folderSidecars = new Map();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const slash = p.lastIndexOf('/');
    const folder = p.slice(0, slash);
    const name = p.slice(slash + 1);
    if (isSidecar(name)) {
      if (!folderSidecars.has(folder)) folderSidecars.set(folder, []);
      folderSidecars.get(folder).push(name);
      continue;
    }
    // managed office files AND stray files both collect here (strays become attachments)
    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder).push(name);
  }
  // A folder is a Document if it has ≥1 managed office file directly in it.
  // A folder is a NOTE container if it has a .cnote body and NO office file
  // (office wins: the .cnote then rides along as an attachment).
  // A folder is a PENDING document if it has neither, but holds an explicitly
  // _V-versioned sidecar (a "Decide Later" container awaiting its file).
  const documents = new Set();
  const notes = new Set();
  for (const [folder, files] of folderFiles) {
    if (files.some(isManaged)) documents.add(folder);
    else if (files.some(isNoteBody)) notes.add(folder);
  }
  const pending = new Map();   // folder → marker sidecar name
  for (const [folder, sidecars] of folderSidecars) {
    if (documents.has(folder) || notes.has(folder)) continue;
    const marker = sidecars.find(s => PENDING_SIDECAR_RE.test(s));
    if (marker) pending.set(folder, marker);
  }
  // Build nested category/collection/document tree.
  const rootNode = { children: [] };
  const ensure = (parent, name, path) => {
    let n = parent.children.find(c => c.name === name && c.path === path);
    if (!n) { n = { name, path, kind: null, children: [] }; parent.children.push(n); }
    return n;
  };
  const leaves = [];
  for (const f of documents) leaves.push({ folder: f, leafKind: 'document' });
  for (const f of notes)     leaves.push({ folder: f, leafKind: 'note' });
  for (const f of pending.keys()) leaves.push({ folder: f, leafKind: 'pending' });
  for (const { folder: docFolder, leafKind } of leaves) {
    const rel = docFolder.slice(prefix.length);          // e.g. Governance/Policy/Fan-Out…
    const segs = rel.split('/');
    let parent = rootNode, acc = root;
    segs.forEach((seg, i) => {
      acc += '/' + seg;
      const node = ensure(parent, seg, acc);
      if (i === segs.length - 1) node.kind = (leafKind === 'pending') ? 'document' : leafKind;
      else if (i === 0) node.kind = 'category';
      else if (!node.kind) node.kind = 'collection';
      parent = node;
    });
    const docNode = parent;
    if (leafKind === 'document') {
      const grouped = groupDocumentFiles(folderFiles.get(docFolder));
      docNode.current = grouped.current;
      docNode.files = grouped.versions;
      docNode.attachments = grouped.attachments;
    } else if (leafKind === 'pending') {
      docNode.pending = pending.get(docFolder);
      docNode.current = null; docNode.files = [];
      docNode.attachments = (folderFiles.get(docFolder) || []).slice();
    } else {
      docNode.noteBody = folderFiles.get(docFolder).find(isNoteBody);
      docNode.current = null; docNode.files = []; docNode.attachments = [];
    }
  }
  return rootNode.children;
```

(c) Add `PENDING_SIDECAR_RE,` to the `module.exports` block (~L477, alongside `MANAGED_EXTS`).

- [ ] **Step 4: Run tests to verify all pass**

Run: `node --test lib/doc-container.test.js`
Expected: ALL tests PASS (pre-existing + 6 new). If any pre-existing taxonomy test fails, the refactor broke a behavior — fix before proceeding.

- [ ] **Step 5: Regen the inlined copy + syntax check**

Run: `node scripts/inline-doc-container.js` then `node --check main.js`
Expected: regen reports success; `--check` silent (exit 0).

- [ ] **Step 6: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): buildTaxonomy classifies pending documents (_V sidecar, no file)"
```

---

### Task 2: plugin core — file picker + createPendingDocument + attachFirstVersion + createDocumentFromUpload

**Files:**
- Modify: `main.js` — insert the four methods directly AFTER `createDocumentInContainer` (search anchor: `// Create a LOOSE related office file` — insert before that comment, ~L8695).

**Interfaces:**
- Consumes: `docContainer.documentBaseName(title)`, `docContainer.firstVersionName(base, ext)` (= `<base>_V1.0.<ext>`), `this._autoCreateSidecar(tfile)`, `this._awaitSidecarCache(scPath, key)`, `this.appendLog(folderPath, action, detail)`, `this.openDocDetail(node, opts)`, `BLANK_DOCX_BASE64`/`BLANK_PPTX_BASE64`/`BLANK_XLSX_BASE64`, `VIEW_TYPE_DOC_BROWSER`, `VIEW_TYPE_DOC_CONTAINER`.
- Produces (later tasks call these EXACT signatures):
  - `_pickOfficeFile()` → `Promise<{name, ext, bytes}|null>`
  - `createPendingDocument({containerPath, title, openDetail = true})` → `Promise<string|undefined>` (docFolder)
  - `attachFirstVersion(docFolder, pendingName, {ext, bytes, templatePath, originalName, openDetail = false})` → `Promise<string|undefined>` (filePath)
  - `createDocumentFromUpload({containerPath, title, name, ext, bytes})` → `Promise<string|undefined>` (docFolder)

- [ ] **Step 1: Add the four methods**

```js
  // ── Upload first version + Decide Later (2026-07-16 design) ───────────────────

  // OS file picker for an office file. Resolves {name, ext, bytes} or null on
  // cancel/invalid. tap-to-pick (hidden input[type=file]) works on desktop AND
  // iPad — no drag requirement (cf. P23 drop-zone pattern).
  _pickOfficeFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.docx,.pptx,.xlsx';
      input.oncancel = () => resolve(null);
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) { resolve(null); return; }
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        if (!['docx', 'pptx', 'xlsx'].includes(ext)) {
          new obsidian.Notice('Only .docx, .pptx, or .xlsx files can be uploaded.');
          resolve(null); return;
        }
        try { resolve({ name: f.name, ext, bytes: await f.arrayBuffer() }); }
        catch (e) { new obsidian.Notice('Could not read file: ' + (e && e.message || e)); resolve(null); }
      };
      input.click();
    });
  }

  // "Decide Later" — create the container with a title only. The seeded sidecar
  // <Base>_V1.0.md IS the pending marker buildTaxonomy recognizes; when the file
  // arrives (attachFirstVersion) the sidecar is renamed, never migrated.
  async createPendingDocument({ containerPath, title, openDetail = true }) {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) { new obsidian.Notice('Enter a document title'); return; }
    if (/[\\/:*?"<>|]/.test(cleanTitle)) { new obsidian.Notice('Title cannot contain \\ / : * ? " < > |'); return; }
    const docFolder = containerPath + '/' + cleanTitle;
    if (this.app.vault.getAbstractFileByPath(docFolder)) {
      new obsidian.Notice('A document named "' + cleanTitle + '" already exists here.'); return;
    }
    const base = docContainer.documentBaseName(cleanTitle);
    const scPath = docFolder + '/' + docContainer.firstVersionName(base, 'md');   // <Base>_V1.0.md
    try {
      await this.app.vault.createFolder(docFolder);
      const nowIso = new Date().toISOString();
      const today = window.moment ? window.moment().format('YYYY-MM-DD') : new Date().toISOString().slice(0, 10);
      await this.app.vault.create(scPath, '---\ncreated: "' + nowIso + '"\nmodified: "' + nowIso + '"\n---\n');
      const sc = this.app.vault.getAbstractFileByPath(scPath);
      if (sc) {
        await this.app.fileManager.processFrontMatter(sc, (front) => {
          if (!front.title) front.title = cleanTitle;
          if (!front.status) front.status = 'Draft';
          if (!front.originationDate) front.originationDate = today;
        });
      }
      this.appendLog(docFolder, 'created (no file yet)');
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_CONTAINER).forEach(l => l.view.render && l.view.render());
      if (openDetail) {
        await this._awaitSidecarCache(scPath, 'title');
        await this.openDocDetail({ path: docFolder }, { edit: true, fresh: true });   // edit mode; Cancel discards the unsaved new doc
        const leftSplit = this.app.workspace.leftSplit;
        if (leftSplit && !leftSplit.collapsed) leftSplit.collapse();
        new obsidian.Notice('Created "' + cleanTitle + '" — no file yet');
      }
      return docFolder;
    } catch (e) {
      new obsidian.Notice('Could not create document: ' + (e && e.message ? e.message : e));
      return;
    }
  }

  // One choke point for ALL first-version arrivals (modal upload, pending
  // "Create file", pending "Upload"). Rename-first ordering: if the binary
  // write fails, the container is STILL pending (PENDING_SIDECAR_RE accepts the
  // ext-named sidecar) and the attach is retryable.
  // NOTE: designated future fidelity-layer ingest seam (plaintext conversion
  // hooks here later — see spec §4; explicitly out of scope in this build).
  async attachFirstVersion(docFolder, pendingName, { ext, bytes, templatePath, originalName, openDetail = false }) {
    const m = String(pendingName || '').match(/^(.*)_V(\d+\.\d+)(?:\.[a-z0-9]+)?\.md$/i);
    if (!m) { new obsidian.Notice('Not a pending document.'); return; }
    const fileName = m[1] + '_V' + m[2] + '.' + ext;                 // e.g. Policy_V1.0.docx
    const filePath = docFolder + '/' + fileName;
    const oldScPath = docFolder + '/' + pendingName;
    const newScPath = filePath + '.md';
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      new obsidian.Notice('File "' + fileName + '" already exists.'); return;
    }
    try {
      // 1) Rename the sidecar FIRST — on later failure the container stays pending.
      const sc = this.app.vault.getAbstractFileByPath(oldScPath);
      if (sc && oldScPath !== newScPath) await this.app.fileManager.renameFile(sc, newScPath);
      // 2) Write the office file. createBinary-before-open — the established
      //    iPad-safe ordering (Capacitor adapter registry races otherwise).
      let buffer = bytes;
      if (!buffer) {
        if (templatePath && await this.app.vault.adapter.exists(templatePath)) {
          buffer = await this.app.vault.adapter.readBinary(templatePath);
        } else {
          const blankB64 = ({ docx: BLANK_DOCX_BASE64, pptx: BLANK_PPTX_BASE64, xlsx: BLANK_XLSX_BASE64 })[ext] || BLANK_DOCX_BASE64;
          buffer = Uint8Array.from(atob(blankB64), (c) => c.charCodeAt(0)).buffer;
        }
      }
      const tfile = await this.app.vault.createBinary(filePath, buffer);
      // 3) Sidecar gains the office link now that the file exists (no-op create
      //    covers the hand-dropped-marker edge where no sidecar file existed).
      await this._autoCreateSidecar(tfile);
      const sc2 = this.app.vault.getAbstractFileByPath(newScPath);
      if (sc2) {
        await this.app.fileManager.processFrontMatter(sc2, (front) => {
          front.docx = '[[' + tfile.name + ']]';
          front.modified = new Date().toISOString();
        });
      }
      this.appendLog(docFolder, originalName
        ? 'first version uploaded — "' + originalName + '"'
        : 'first version created', fileName);
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_CONTAINER).forEach(l => l.view.render && l.view.render());
      if (openDetail) {
        await this._awaitSidecarCache(newScPath, 'title');
        await this.openDocDetail({ path: docFolder }, { edit: true, fresh: true });
        const leftSplit = this.app.workspace.leftSplit;
        if (leftSplit && !leftSplit.collapsed) leftSplit.collapse();
      }
      return filePath;
    } catch (e) {
      new obsidian.Notice('Could not add file: ' + (e && e.message ? e.message : e) + ' — the document is still awaiting its file.');
      return;
    }
  }

  // Modal upload path = pending create + attach in sequence, so exactly ONE code
  // path writes first versions from bytes. Detail page opens once, at the end.
  async createDocumentFromUpload({ containerPath, title, name, ext, bytes }) {
    const docFolder = await this.createPendingDocument({ containerPath, title, openDetail: false });
    if (!docFolder) return;
    const base = docContainer.documentBaseName((title || '').trim());
    const filePath = await this.attachFirstVersion(docFolder, docContainer.firstVersionName(base, 'md'),
      { ext, bytes, originalName: name, openDetail: true });
    if (filePath) new obsidian.Notice('Created "' + (title || '').trim() + '" from "' + name + '"');
    else await this.openDocDetail({ path: docFolder }, {});   // attach failed → show the pending page (retry from its pane)
    return docFolder;   // folder exists either way — modal may close
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: silent, exit 0.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): createPendingDocument + attachFirstVersion choke point + upload picker"
```

---

### Task 3: NewDocumentModal — upload row + Decide Later + locked-title variant

**Files:**
- Modify: `main.js` — `class NewDocumentModal` (search anchor: `class NewDocumentModal extends obsidian.Modal`, ~L9811): constructor, `onOpen`, `_syncCreateState`, `_submit`; add `_renderStaged`, `_decideLater`.

**Interfaces:**
- Consumes: `plugin._pickOfficeFile()`, `plugin.createDocumentFromUpload(...)`, `plugin.createPendingDocument(...)` (Task 2 signatures).
- Produces: constructor opts gain `lockedTitle` (string — prefill + disable Title) — Task 4's `openCreateFileModal` passes `{heading, lockedTitle, onSubmit}`. Behavior contract: upload row and Decide Later appear ONLY on the plain container-create modal (`!this.onSubmit`), so the loose-related-doc flow and Task 4's Create-file variant are untouched.

- [ ] **Step 1: Constructor** — after `this.heading = (opts && opts.heading) || null;` add:

```js
    this.lockedTitle = (opts && opts.lockedTitle) || null;   // pending "Create file": title fixed to the folder name
    this.staged = null;                                      // {name, ext, bytes} from "Upload file…"
```

- [ ] **Step 2: `onOpen` — locked title.** After `this.titleInput.placeholder = 'Document title';` add:

```js
    if (this.lockedTitle) { this.titleInput.value = this.lockedTitle; this.titleInput.disabled = true; }
```

- [ ] **Step 3: `onOpen` — upload row.** Between the Template grid block and the Buttons block insert:

```js
    // Upload an existing file — alternative first version (2026-07-16 design).
    // Only on the plain container-create modal: the loose-related-doc flow and
    // the pending "Create file" variant both pass onSubmit and must not show it.
    if (!this.onSubmit) {
      const upWrap = contentEl.createDiv();
      upWrap.createEl('label', { text: 'Or upload an existing file', cls: 'doc-newdoc-label' });
      const upRow = upWrap.createDiv();
      upRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 12px;';
      const upBtn = upRow.createEl('button', { text: 'Upload file…' });
      upBtn.style.cssText = 'padding:6px 10px;';
      this._upChip = upRow.createSpan();
      upBtn.addEventListener('click', async () => {
        const picked = await this.plugin._pickOfficeFile();
        if (!picked) return;
        this.staged = picked;
        if (!this.titleInput.value.trim()) this.titleInput.value = picked.name.replace(/\.[^.]+$/, '');
        this._renderStaged(); this._syncCreateState();
      });
    }
```

- [ ] **Step 4: `onOpen` — Decide Later button.** In the Buttons row, between Cancel and Create insert:

```js
    if (!this.onSubmit) {
      this._laterBtn = btnRow.createEl('button', { text: 'Decide Later' });
      this._laterBtn.addEventListener('click', () => this._decideLater());
    }
```

And at the end of `onOpen` (after `this._syncCreateState();`) add `this._renderStaged();`.

- [ ] **Step 5: Add `_renderStaged` and `_decideLater` methods** (after `_syncCreateState`):

```js
  _renderStaged() {
    if (!this._upChip) return;
    this._upChip.empty();
    if (this.staged) {
      this._upChip.createSpan({ text: this.staged.name });
      const x = this._upChip.createSpan({ text: ' ✕' });
      x.style.cursor = 'pointer';
      x.setAttr('title', 'Clear staged file');
      x.onclick = () => { this.staged = null; this._renderStaged(); this._syncCreateState(); };
    }
    // Format + template choose the new file's content — irrelevant while a real
    // file is staged (format then derives from the staged extension).
    const dis = !!this.staged;
    Object.values(this._fmtBtns || {}).forEach(b => { b.disabled = dis; b.style.opacity = dis ? '0.4' : ''; });
    if (this._tmplGrid) { this._tmplGrid.style.opacity = dis ? '0.4' : ''; this._tmplGrid.style.pointerEvents = dis ? 'none' : ''; }
  }

  async _decideLater() {
    const title = this.titleInput.value.trim();
    if (!title) { this.titleInput.focus(); return; }
    this._laterBtn.disabled = true;
    const result = await this.plugin.createPendingDocument({ containerPath: this.containerPath, title });
    if (result) this.close(); else this._syncCreateState();
  }
```

- [ ] **Step 6: `_syncCreateState`** — replace the method with:

```js
  _syncCreateState() {
    const ok = !!this.titleInput.value.trim();
    this._createBtn.disabled = !ok;
    this._createBtn.style.opacity = ok ? '' : '0.5';
    if (this._laterBtn) { this._laterBtn.disabled = !ok; this._laterBtn.style.opacity = ok ? '' : '0.5'; }
  }
```

- [ ] **Step 7: `_submit`** — replace the `const result = ...` assignment with:

```js
    let result;
    if (this.staged) {
      result = await this.plugin.createDocumentFromUpload({
        containerPath: this.containerPath, title,
        name: this.staged.name, ext: this.staged.ext, bytes: this.staged.bytes });
    } else {
      result = this.onSubmit
        ? await this.onSubmit({ title, ext: this.ext, templatePath: this.templatePath })
        : await this.plugin.createDocumentInContainer({ containerPath: this.containerPath, title, ext: this.ext, templatePath: this.templatePath });
    }
```

- [ ] **Step 8: Syntax check + commit**

Run: `node --check main.js` → silent.

```bash
git add main.js
git commit -m "feat(doc-container): New Document modal gains Upload file + Decide Later"
```

---

### Task 4: pending surfaces — detail choke points + Files & Versions branch

**Files:**
- Modify: `main.js` — `DocumentDetailView`: `sidecarFor`/`frontmatter` (anchor: `sidecarFor(file) {`, ~L4284), `_mutateSidecar` (anchor: `async _mutateSidecar(applyFn, log)`, ~L4522), `_renderFilesPane` (anchor: `_renderFilesPane(p) {`, ~L4484); plugin: `readDocMeta` (anchor: `readDocMeta(node) {`, ~L8290) and new `openCreateFileModal` (insert after `openNewDocumentModal`, anchor: `openNewDocumentModal(node) {`, ~L8624).

**Interfaces:**
- Consumes: `node.pending` (Task 1), `plugin._pickOfficeFile()`/`plugin.attachFirstVersion(...)` (Task 2), `NewDocumentModal` opts `{heading, lockedTitle, onSubmit}` (Task 3), existing `docIconLabel(parent, icon, label, opts)`.
- Produces: `plugin.openCreateFileModal(node, leaf)`; `DocumentDetailView._workingSidecarPath()` → `string|null`.

- [ ] **Step 1: One working-sidecar rule.** Directly above `sidecarFor(file)` add:

```js
  // One rule (design §5): the working sidecar is <current>.md, or the pending
  // marker when no file exists yet. All reads/writes of "the document's
  // metadata" route through this.
  _workingSidecarPath() {
    if (!this.node) return null;
    if (this.node.current) return this.node.path + '/' + this.node.current + '.md';
    if (this.node.pending) return this.node.path + '/' + this.node.pending;
    return null;
  }
```

Replace `frontmatter()` with:

```js
  frontmatter() {
    const scPath = this._workingSidecarPath();
    if (!scPath) return {};
    const sc = this.app.vault.getAbstractFileByPath(scPath);
    if (!sc) return {};
    const cache = this.app.metadataCache.getFileCache(sc);
    return (cache && cache.frontmatter) || {};
  }
```

- [ ] **Step 2: `_mutateSidecar`.** Replace its first two lines

```js
    if (!this.node || !this.node.current) return;
    const scPath = this.node.path + '/' + this.node.current + '.md';
```

with:

```js
    const scPath = this._workingSidecarPath();
    if (!scPath) return;
```

- [ ] **Step 3: `_renderFilesPane` pending branch.** Immediately after `const acts = p.createDiv('doc-detail-paneacts');` insert:

```js
    if (this.node.pending && !this.node.current) {
      // Pending document (design §3): no working file yet — offer both arrivals.
      const cf = docIconLabel(acts, 'file-plus', 'Create file', { cls: 'doc-detail-hbtn' });
      cf.onclick = () => this.plugin.openCreateFileModal(this.node, this.leaf);
      const up = docIconLabel(acts, 'upload', 'Upload', { cls: 'doc-detail-hbtn' });
      up.onclick = async () => {
        const picked = await this.plugin._pickOfficeFile();
        if (!picked) return;
        const r = await this.plugin.attachFirstVersion(this.node.path, this.node.pending,
          { ext: picked.ext, bytes: picked.bytes, originalName: picked.name });
        if (r) new obsidian.Notice('Uploaded "' + picked.name + '"');
        this.render();   // render() recomputes the node — pending → normal document
      };
      p.createDiv({ cls: 'doc-detail-stub', text: 'No working file yet — create one or upload an existing document.' });
      return;
    }
```

- [ ] **Step 4: plugin `openCreateFileModal`.** After `openNewDocumentModal(node)` add:

```js
  // Pending "Create file": format + template only — the title is the folder's
  // name already. onSubmit routes to attachFirstVersion instead of a new folder.
  openCreateFileModal(node, leaf) {
    if (!node || !node.pending) { new obsidian.Notice('No pending document selected'); return; }
    new NewDocumentModal(this.app, this, node.path, node.name, {
      heading: 'Create file for “' + node.name + '”',
      lockedTitle: node.name,
      onSubmit: async ({ ext, templatePath }) => {
        const r = await this.attachFirstVersion(node.path, node.pending, { ext, templatePath });
        const dv = leaf && leaf.view;
        if (r && dv && dv.render) dv.render();
        return r;
      },
    }).open();
  }
```

- [ ] **Step 5: `readDocMeta` pending fallback.** After the `if (node.current) {...}` block, before `return {};`, add:

```js
    if (node.pending) {
      const sc = this.app.vault.getAbstractFileByPath(node.path + '/' + node.pending);
      if (sc) return (this.app.metadataCache.getFileCache(sc) || {}).frontmatter || {};
    }
```

- [ ] **Step 6: Footer guard.** In `_renderFooter` (anchor: `_renderFooter(c) {`, ~L5230), directly after the `const mk = (label, cls, fn) => ...` line, add:

```js
    // Pending document (no file yet): every file-bound action (check-out, open,
    // new version, system app, reveal) is meaningless — the Files & Versions
    // pane carries Create file / Upload. Keep only the spacer + Delete.
    const filePending = !!(this.node && this.node.pending && !this.node.current);
```

Then wrap the file-bound span — from `const lock = this.plugin.readLock(this.node);` through the `mk('Open in system app', ...)` line inclusive — in `if (!filePending) { ... }`, and change the Reveal line to:

```js
    if (!filePending) mk('Reveal in file explorer', '', () => this.node.current && this.plugin.revealInExplorer(this.node.path + '/' + this.node.current));
```

(The `heldByMe` const moves inside the wrapped block — it is only used there. The spacer span and the edit-mode Delete block stay outside, unconditional: Delete works folder-level and MUST remain available on pending docs.)

- [ ] **Step 7: Syntax check + commit**

Run: `node --check main.js` → silent.

```bash
git add main.js
git commit -m "feat(doc-container): pending detail surfaces — working-sidecar rule + Create file/Upload pane"
```

---

### Task 5: periphery — tree "(no file)" hint, migration dry-run guard, explorer CSS

**Files:**
- Modify: `main.js` — Document Browser `renderNode` (anchor: `renderNode(parent, node, depth, terms)`, ~L4141); `dryRunMetadataMigration` walker (anchor: `async dryRunMetadataMigration()`, ~L8306); `_injectSidecarCSS` (anchor: `_injectSidecarCSS()`, ~L8041).

**Interfaces:**
- Consumes: `node.pending` (Task 1).
- Produces: nothing consumed later — cosmetic + safety guards.

- [ ] **Step 1: Tree hint.** In `renderNode`'s `kind === 'document'` branch, after `row.createSpan({ text: node.name });` add:

```js
      if (node.pending && !node.current) {
        const hint = row.createSpan({ text: 'no file', cls: 'doc-container-badge' });
        hint.style.opacity = '0.7';
      }
```

- [ ] **Step 2: Migration dry-run guard.** In `dryRunMetadataMigration`, change the walker line

```js
    const walk = (nodes) => { for (const n of (nodes || [])) { if (n.kind === 'document') docs.push(n); else walk(n.children); } };
```

to:

```js
    // Pending documents (no file yet) are not migration candidates — their only
    // sidecar IS the marker; creating _document.md here would be pure noise.
    const walk = (nodes) => { for (const n of (nodes || [])) { if (n.kind === 'document') { if (!n.pending) docs.push(n); } else walk(n.children); } };
```

(Only the dry-run walker exists today — verified 2026-07-16, there is no apply-side function yet. Do NOT touch the visually identical walker inside the related-parents suggester (~L3851): pending docs SHOULD be relatable there.)

- [ ] **Step 3: Explorer CSS.** In `_injectSidecarCSS`, extend the rule. Replace

```js
      '.nav-file-title[data-path$=".pdf.md"], ' +
```

with:

```js
      '.nav-file-title[data-path$=".pdf.md"], ' +
      // Pending markers (<Base>_V1.0.md) are machine files too. Scoped to the
      // managed root; a user note with "_V" in its name inside the doc root is
      // the accepted (unlikely) collateral.
      '.nav-file-title[data-path^="' + (this.settings.docRoot || 'Documents') + '/"][data-path*="_V"][data-path$=".md"], ' +
```

- [ ] **Step 4: Syntax check + commit**

Run: `node --check main.js` → silent.

```bash
git add main.js
git commit -m "feat(doc-container): pending periphery — tree no-file hint, dry-run skip, explorer hide"
```

---

### Task 6: bump + deploy + desktop drill

**Files:**
- Modify: `manifest.json` (version `0.1.25` → `0.1.26`)
- Deploy: copy `main.js` + `manifest.json` → `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`

- [ ] **Step 1: Bump manifest** — `"version": "0.1.26"`.

- [ ] **Step 2: Final checks**

Run: `node --check main.js` AND `node --test lib/doc-container.test.js`
Expected: both clean.

- [ ] **Step 3: Commit + deploy**

```bash
git add manifest.json
git commit -m "chore: bump 0.1.26 — upload first version + Decide Later"
cp main.js manifest.json "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/"
```

- [ ] **Step 4: Desktop drill (Paul gate — walk together, spec §8)**

1. New Document → Upload file… → pick a real .docx → title defaults from filename → Create → detail opens, file listed current, log shows `first version uploaded — "<orig>"`. Repeat once each for .pptx / .xlsx.
2. New Document → title only → Decide Later → container appears in tree with "no file" badge → detail opens in edit mode → edit metadata + add a note (writes land in `<Base>_V1.0.md`) → Files & Versions shows Create file / Upload + empty-state → footer shows NO check-out/open/new-version/system-app/reveal buttons (Delete still present in edit mode).
3. Pending → Create file → format+template modal (title locked) → file created, badge gone, sidecar renamed, metadata intact.
4. Second pending → Upload → picker → file lands, container normalizes, metadata intact.
5. Duplicate title in same container → Notice, aborted.
6. Fresh-cancel: New Document → Decide Later → immediately Cancel on the detail page → folder discarded.
7. Regressions: template create unchanged; New version unchanged on a normal container; loose related-doc modal shows NO upload row / NO Decide Later; check-out gate untouched.
8. iPad: rides the pending container-notes iPad smoke session (picker + upload on Capacitor is the platform unknown).
