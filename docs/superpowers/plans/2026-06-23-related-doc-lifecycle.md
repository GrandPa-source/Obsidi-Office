# Related-Document Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a loose related office file from a document's Related Documents tab (full New Document modal, opens in editor), and later "Break away" that loose file into a first-class sibling document under the same container — keeping metadata and a bidirectional link.

**Architecture:** A loose related file is a normal office file written into the *parent document's own folder* (so the taxonomy classifies it as an attachment) plus a sidecar carrying a `looseDoc: true` marker and a `relatedDocuments`/`links` association on the parent. Break-away renames the file into a new `<Title>/<Base>_V1.0.<ext>` folder under the parent's container, migrates the sidecar (dropping the marker), re-points the parent link, and adds a reciprocal back-link. All UI lives in `DocumentDetailView._renderRelatedPane`; the modal is the existing `NewDocumentModal` extended with an optional `onSubmit`.

**Tech Stack:** Obsidian plugin (plain JS, no build), `lib/doc-container.js` pure core (re-inlined into `main.js` via `scripts/inline-doc-container.js`), `node --test` for pure units, `node --check` for syntax.

## Global Constraints

- Plain JS, no build step; lib symbols used at plugin/view scope must be referenced as `docContainer.X`; new `main.js` helpers go OUTSIDE the inline markers.
- After any `lib/doc-container.js` edit, re-run `node scripts/inline-doc-container.js` and `node --test` (do NOT hand-edit the inlined copy inside `main.js`).
- Everything stays behind `settings.docBrowserEnabled` and under `settings.docRoot`; no change to the version model, check-out gate, or existing Related-Documents linking (Add link / drag-to-attach).
- Deploy target for smoke: `C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js` (copy `main.js` only; byte-identical check with `cmp -s`).
- Format scope for creation: `docx` / `pptx` / `xlsx` only (no blank PDF).
- The graph wikilink lives ONLY in `links[]`; never store a `[[wikilink]]` inside `relatedDocuments` objects (causes `[object Object]` backlinks). On every `relatedDocuments` write, strip any legacy inner `link` field: `rel.map(({ link, ...r }) => r)`.
- `node --check` cannot catch runtime ReferenceErrors in inlined code; the desktop smoke (Task 7) is the behavioral gate.

---

### Task 1: Pure `dedupeName` helper (collision-free folder name)

**Files:**
- Modify: `lib/doc-container.js` — add `dedupeName` near `firstVersionName` (~line 220) and to the exports object (~line 445).
- Test: `lib/doc-container.test.js` (existing `node --test` file).

**Interfaces:**
- Produces: `dedupeName(desired: string, taken: string[]) -> string` — returns `desired` if not in `taken`, else `"<desired> (2)"`, `"<desired> (3)"`, … until free. Exported as `docContainer.dedupeName`.

- [ ] **Step 1: Write the failing test**

Add to `lib/doc-container.test.js`:

```js
test('dedupeName returns desired when free', () => {
  assert.equal(dc.dedupeName('Minutes', ['A', 'B']), 'Minutes');
});
test('dedupeName suffixes on collision', () => {
  assert.equal(dc.dedupeName('Minutes', ['Minutes']), 'Minutes (2)');
});
test('dedupeName finds next free suffix', () => {
  assert.equal(dc.dedupeName('Minutes', ['Minutes', 'Minutes (2)']), 'Minutes (3)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.dedupeName is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/doc-container.js` after `firstVersionName` (line ~220):

```js
// A child name not already taken in a folder: "<desired>", else "<desired> (2)", "(3)"…
function dedupeName(desired, taken) {
  const set = new Set(taken || []);
  if (!set.has(desired)) return desired;
  let n = 2;
  while (set.has(desired + ' (' + n + ')')) n++;
  return desired + ' (' + n + ')';
}
```

Add `dedupeName,` to the `module.exports = { … }` object (near `firstVersionName,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/doc-container.test.js`
Expected: PASS (all three new tests).

- [ ] **Step 5: Re-inline lib into main.js**

Run: `node scripts/inline-doc-container.js`
Expected: completes without error; `main.js` updated.

- [ ] **Step 6: Syntax check + commit**

```bash
node --check main.js
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure dedupeName helper for collision-free folder names"
```

---

### Task 2: `NewDocumentModal` optional `onSubmit` + heading

**Files:**
- Modify: `main.js` — `NewDocumentModal` constructor (~line 7928), `onOpen` heading line (~line 7940), `_submit` (~line 8021).

**Interfaces:**
- Consumes: existing `NewDocumentModal(app, plugin, containerPath, containerLabel)`.
- Produces: `new NewDocumentModal(app, plugin, containerPath, containerLabel, { onSubmit?, heading? })`. When `onSubmit` is set, `_submit` calls `await onSubmit({ title, ext, templatePath })` instead of `createDocumentInContainer`; a truthy return closes the modal. `heading` overrides the modal title text.

- [ ] **Step 1: Add opts to the constructor**

Replace the constructor body's end (after `this.templatePath = '';`):

```js
  constructor(app, plugin, containerPath, containerLabel, opts) {
    super(app);
    this.plugin = plugin;
    this.containerPath = containerPath;
    this.containerLabel = containerLabel || containerPath;
    this.ext = 'docx';
    this.templatePath = '';   // '' = Blank (embedded fallback)
    this.onSubmit = (opts && opts.onSubmit) || null;     // optional override (loose related doc)
    this.heading = (opts && opts.heading) || null;
  }
```

- [ ] **Step 2: Use the heading override in onOpen**

Replace the `contentEl.createEl('h3', …)` line (~7940):

```js
    contentEl.createEl('h3', { text: this.heading || ('New Document in “' + this.containerLabel + '”') });
```

- [ ] **Step 3: Route `_submit` through onSubmit when present**

Replace `_submit` (~8021):

```js
  async _submit() {
    const title = this.titleInput.value.trim();
    if (!title) { this.titleInput.focus(); return; }
    this._createBtn.disabled = true;
    const result = this.onSubmit
      ? await this.onSubmit({ title, ext: this.ext, templatePath: this.templatePath })
      : await this.plugin.createDocumentInContainer({ containerPath: this.containerPath, title, ext: this.ext, templatePath: this.templatePath });
    if (result) this.close();        // created → close; on failure keep modal open
    else this._syncCreateState();
  }
```

- [ ] **Step 4: Syntax check + commit**

```bash
node --check main.js
git add main.js
git commit -m "feat(doc-container): NewDocumentModal optional onSubmit + heading override"
```

---

### Task 3: `createLooseRelatedDoc` plugin method

**Files:**
- Modify: `main.js` — add method directly after `createDocumentInContainer` (ends ~line 7371).

**Interfaces:**
- Consumes: `BLANK_DOCX_BASE64`/`BLANK_PPTX_BASE64`/`BLANK_XLSX_BASE64`, `this._autoCreateSidecar(tfile)`, `docContainer` not needed here.
- Produces: `async createLooseRelatedDoc({ parentDocPath, title, ext, templatePath }) -> string|undefined` — returns the created file path on success, `undefined` on validation failure/error. Writes `<parentDocPath>/<Title>.<ext>` + sidecar with `title`/`status`/`originationDate`/`looseDoc: true`.

- [ ] **Step 1: Implement the method**

Insert after the closing brace of `createDocumentInContainer`:

```js
  // Create a LOOSE related office file inside an existing document's folder (so the
  // taxonomy treats it as an attachment, not a version). Seeds a sidecar with the
  // looseDoc marker that gates "Break away". Returns the file path on success.
  async createLooseRelatedDoc({ parentDocPath, title, ext, templatePath }) {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) { new obsidian.Notice('Enter a document title'); return; }
    if (/[\\/:*?"<>|]/.test(cleanTitle)) { new obsidian.Notice('Title cannot contain \\ / : * ? " < > |'); return; }
    const filePath = parentDocPath + '/' + cleanTitle + '.' + ext;
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      new obsidian.Notice('A file named "' + cleanTitle + '.' + ext + '" already exists here.'); return;
    }
    try {
      let buffer;
      if (templatePath && await this.app.vault.adapter.exists(templatePath)) {
        buffer = await this.app.vault.adapter.readBinary(templatePath);
      } else {
        const blankB64 = ({ docx: BLANK_DOCX_BASE64, pptx: BLANK_PPTX_BASE64, xlsx: BLANK_XLSX_BASE64 })[ext] || BLANK_DOCX_BASE64;
        buffer = Uint8Array.from(atob(blankB64), (c) => c.charCodeAt(0)).buffer;
      }
      const tfile = await this.app.vault.createBinary(filePath, buffer);
      await this._autoCreateSidecar(tfile);
      const scPath = filePath + '.md';
      const sc = this.app.vault.getAbstractFileByPath(scPath);
      if (sc) {
        const today = window.moment ? window.moment().format('YYYY-MM-DD') : new Date().toISOString().slice(0, 10);
        await this.app.fileManager.processFrontMatter(sc, (front) => {
          if (!front.title) front.title = cleanTitle;
          if (!front.status) front.status = 'Draft';
          if (!front.originationDate) front.originationDate = today;
          front.looseDoc = true;   // marker — gates Break away
        });
      } else {
        elog('createLooseRelatedDoc: sidecar missing after _autoCreateSidecar for', filePath);
      }
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
      return filePath;
    } catch (e) {
      new obsidian.Notice('Could not create related document: ' + (e && e.message ? e.message : e));
      return;
    }
  }
```

- [ ] **Step 2: Syntax check + commit**

```bash
node --check main.js
git add main.js
git commit -m "feat(doc-container): createLooseRelatedDoc — loose related file + looseDoc marker"
```

---

### Task 4: "＋ New document" button in Related Documents (edit mode)

**Files:**
- Modify: `main.js` — `DocumentDetailView._renderRelatedPane`, the `if (editing) { … }` block (the drop zone / Add link section, ~line 3790).

**Interfaces:**
- Consumes: `createLooseRelatedDoc` (Task 3), `NewDocumentModal` onSubmit (Task 2), existing `this._relWikilink`, `this._mutateSidecar`, `this.plugin.openDocInEditor(filePath, returnDocPath, newPane, leaf)`, the in-scope `rel` array.
- Produces: a button that creates a loose related doc, links it (relatedDocuments + `links[]` wikilink), and opens it in the editor with Return → parent detail.

- [ ] **Step 1: Add the New document button at the top of the editing block**

Immediately inside `if (editing) {` (before `const dz = p.createDiv('doc-detail-dropzone');`):

```js
      const newBtn = p.createEl('button', { cls: 'doc-detail-hbtn', text: '＋ New document' });
      newBtn.style.cssText = 'margin-bottom:8px;';
      newBtn.onclick = () => {
        const parentDocPath = this.node.path;
        new NewDocumentModal(this.app, this.plugin, parentDocPath, this.node.name, {
          heading: 'New related document',
          onSubmit: async ({ title, ext, templatePath }) => {
            const filePath = await this.plugin.createLooseRelatedDoc({ parentDocPath, title, ext, templatePath });
            if (!filePath) return null;
            const wl = this._relWikilink(filePath);
            rel.push({ kind: 'link', target: filePath, label: title.trim() });
            await this._mutateSidecar((front) => {
              front.relatedDocuments = rel.map(({ link, ...r }) => r);
              if (wl) {
                const links = Array.isArray(front.links) ? front.links.slice() : [];
                if (!links.includes(wl)) links.push(wl);
                front.links = links;
              }
            }, { action: 'Related document created: ' + title.trim(), type: 'link' });
            this.plugin.openDocInEditor(filePath, parentDocPath, false, this.leaf);   // editor; Return → parent detail
            return filePath;   // truthy → modal closes
          },
        }).open();
      };
```

- [ ] **Step 2: Syntax check + deploy + manual check**

```bash
node --check main.js
cp main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
```
Manual: open a document detail → Related Documents → Edit → ＋ New document → create from Blank. Expected: file created in the parent folder, opens in editor, Return button visible; the loose file appears as an attachment in Files & Versions and as a linked row in Related Documents.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): + New document button creates loose related doc, opens editor"
```

---

### Task 5: Break-away detection + button on the related row

**Files:**
- Modify: `main.js` — `DocumentDetailView`: add `_isLooseDoc` method (near `_relWikilink`, ~line 3840) and the Break-away button in the row's `if (editing) { … }` block inside `_renderRelatedPane` (~line 3827).

**Interfaces:**
- Consumes: `this.app.metadataCache.getFileCache`, the in-scope `r` (related entry) and `rel` array, `this._breakAway` (Task 6).
- Produces: `_isLooseDoc(targetPath: string) -> boolean` (true when `<targetPath>.md` frontmatter has `looseDoc === true`); a two-click "Break away" button rendered only for loose-doc link entries in edit mode.

- [ ] **Step 1: Add the `_isLooseDoc` detector**

Near `_relWikilink` (add a new method):

```js
  // True when a related target is a plugin-created loose document (eligible for Break away).
  _isLooseDoc(targetPath) {
    const sc = this.app.vault.getAbstractFileByPath(targetPath + '.md');
    if (!sc) return false;
    const cache = this.app.metadataCache.getFileCache(sc);
    return !!(cache && cache.frontmatter && cache.frontmatter.looseDoc === true);
  }
```

- [ ] **Step 2: Render the Break-away button on eligible rows**

In `_renderRelatedPane`, inside `if (editing) {` of the row loop (right after the existing remove-button block, before the closing `}` of `if (editing)`):

```js
        if (r.kind === 'link' && this._isLooseDoc(r.target)) {
          const ba = right.createSpan({ text: 'Break away', cls: 'doc-detail-fbtn' });
          let armedBA = false;   // two-click confirm (iPad-safe; no window.confirm)
          ba.onclick = async () => {
            if (!armedBA) { armedBA = true; ba.setText('Confirm break away'); return; }
            await this._breakAway(r.target, rel);
          };
        }
```

- [ ] **Step 3: Syntax check + commit**

```bash
node --check main.js
git add main.js
git commit -m "feat(doc-container): Break-away button on loose related-doc rows (edit mode)"
```

(The button calls `_breakAway`, implemented next; committing here is fine — the handler is only reachable after Task 6 deploys.)

---

### Task 6: `_breakAway` — promote loose file to sibling document

**Files:**
- Modify: `main.js` — `DocumentDetailView`: add `_breakAway` method (near `_isLooseDoc`).

**Interfaces:**
- Consumes: `docContainer.dedupeName`, `docContainer.documentBaseName`, `docContainer.firstVersionName`, `this.node`, `this.frontmatter()`, `this._relWikilink`, `this._mutateSidecar`, `this.app.fileManager.renameFile`, `this.app.fileManager.processFrontMatter`.
- Produces: `async _breakAway(looseFilePath: string, rel: object[]) -> void` — moves the loose file to `<container>/<Title>/<Base>_V1.0.<ext>`, migrates+cleans the sidecar, re-points the parent link, adds a reciprocal back-link, refreshes views.

**Note on link updates:** `fileManager.renameFile` auto-updates `[[wikilinks]]` (including frontmatter `links[]`) that reference the moved file, so the parent's `links[]` entry is fixed by Obsidian. We manually update only the stored `relatedDocuments` target string (Obsidian does not rewrite JSON paths) and add the reciprocal back-link.

- [ ] **Step 1: Implement `_breakAway`**

```js
  // Promote a loose related file into a first-class sibling document under the same
  // container. Keeps metadata, re-points the parent link, adds a reciprocal back-link.
  async _breakAway(looseFilePath, rel) {
    const looseFile = this.app.vault.getAbstractFileByPath(looseFilePath);
    if (!looseFile) { new obsidian.Notice('That file no longer exists.'); return; }
    const ext = looseFile.extension;
    const title = looseFile.basename;
    const container = this.node.path.slice(0, this.node.path.lastIndexOf('/'));
    const containerFolder = this.app.vault.getAbstractFileByPath(container);
    const taken = (containerFolder && containerFolder.children || []).map(c => c.name);
    const folderName = docContainer.dedupeName(title, taken);
    const newFolder = container + '/' + folderName;
    const newFilePath = newFolder + '/' + docContainer.firstVersionName(docContainer.documentBaseName(title), ext);
    const parentCur = this.node.path + '/' + this.node.current;
    const parentTitle = this.frontmatter().title || this.node.name;
    try {
      const looseScPath = looseFilePath + '.md';
      const looseSc = this.app.vault.getAbstractFileByPath(looseScPath);
      await this.app.vault.createFolder(newFolder);
      // Move the file (Obsidian rewrites [[wikilinks]] to it, incl. the parent's links[]).
      await this.app.fileManager.renameFile(looseFile, newFilePath);
      if (looseSc) {
        await this.app.fileManager.renameFile(looseSc, newFilePath + '.md');
        const newSc = this.app.vault.getAbstractFileByPath(newFilePath + '.md');
        if (newSc) await this.app.fileManager.processFrontMatter(newSc, (front) => { delete front.looseDoc; });
      }
      // Re-point the parent's relatedDocuments entry target (JSON path is NOT auto-updated).
      const idx = rel.findIndex(r => r.target === looseFilePath);
      if (idx >= 0) rel[idx] = { kind: 'link', target: newFilePath, label: title };
      await this._mutateSidecar((front) => {
        front.relatedDocuments = rel.map(({ link, ...r }) => r);
      }, { action: 'Broke away related document: ' + title, type: 'link' });
      // Reciprocal back-link on the new document → parent current version.
      const parentWl = this._relWikilink(parentCur);
      const newSc2 = this.app.vault.getAbstractFileByPath(newFilePath + '.md');
      if (newSc2) await this.app.fileManager.processFrontMatter(newSc2, (front) => {
        const r2 = Array.isArray(front.relatedDocuments) ? front.relatedDocuments.slice() : [];
        r2.push({ kind: 'link', target: parentCur, label: parentTitle });
        front.relatedDocuments = r2.map(({ link, ...x }) => x);
        const links = Array.isArray(front.links) ? front.links.slice() : [];
        if (parentWl && !links.includes(parentWl)) links.push(parentWl);
        front.links = links;
      });
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
      this.render();
      new obsidian.Notice('Broke away "' + title + '" into its own document.');
    } catch (e) {
      new obsidian.Notice('Break away failed: ' + (e && e.message ? e.message : e));
    }
  }
```

- [ ] **Step 2: Syntax check + deploy**

```bash
node --check main.js
cp main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
cmp -s main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js" && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): _breakAway promotes loose file to sibling document + reciprocal link"
```

---

### Task 7: Desktop smoke + fixes

**Files:**
- Modify: `main.js` (only if smoke surfaces a fix).

- [ ] **Step 1: Reload Obsidi-Office in OB_Testing, then run the checklist**

On a document under `docRoot`, in Related Documents → Edit:
1. **＋ New document** → pick a template (Blank + a real template) → file created in the parent folder; **opens in the editor**; **Return to document** button returns to the parent detail page.
2. The new file shows as an **attachment** in Files & Versions **and** a linked row in Related Documents; open the target's Backlinks — the parent appears, **no `[object Object]`**; graph shows the edge.
3. **Break away** (two-click) on the loose row → a **sibling document folder** `<Title>/<Base>_V1.0.<ext>` appears under the same container; the parent's link **re-points** to it (row still present, opens the new doc); the new doc's sidecar has a **reciprocal** related entry + wikilink back to the parent; graph edges intact **both** directions; the **`looseDoc` marker is gone** and the Break-away button no longer shows for that row.
4. **Regression:** a normal document and a drag-attached reference show **no** Break-away button; Add link (folder navigator) and drag-to-attach still work.

- [ ] **Step 2: Fix any issues, re-deploy, and commit**

For each fix:
```bash
node --check main.js
cp main.js "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
git add main.js && git commit -m "fix(doc-container): <smoke finding>"
```

- [ ] **Step 3: Mark the spec's smoke checklist complete in the project knowledge file**

Update `OB_Claude/projects/Obsidian-Plugin/P21_OnlyOffice/P21_OnlyOffice.md` with the result (pass/fail per row) under the doc-container entry.

---

## Self-Review

- **Spec coverage:** Feature 1 (create loose + link + open editor) → Tasks 2–4. Feature 2 (break away: sibling destination, metadata migrate, re-point, reciprocal, marker drop) → Tasks 5–6. Detection marker → Tasks 3 (stamp) + 5 (`_isLooseDoc`) + 6 (drop). Collision-suffix → Task 1. Edge cases (collision, missing sidecar, JSON-path re-point, rename link auto-update) → Tasks 1/5/6 + the note in Task 6. Testing → Task 1 (pure) + Task 7 (smoke). Scope guards → Global Constraints.
- **Placeholder scan:** none — every code step shows full code.
- **Type consistency:** `createLooseRelatedDoc` returns a path string (Task 3) consumed as truthy by the modal `onSubmit` (Task 4) and `_submit` (Task 2). `dedupeName(desired, taken[])` (Task 1) used in Task 6. `_isLooseDoc(targetPath)` (Task 5) and `_breakAway(looseFilePath, rel)` (Task 6) names match their call sites. `relatedDocuments` writes always `.map(({ link, ...r }) => r)`.
- **Open-editor edge case:** the spec calls for reconciling an editor open on the loose file during break-away. `fileManager.renameFile` updates an open `FileView`'s file reference in place, so a basic redirect is automatic; if smoke (Task 7) shows a dangling editor, add an explicit reconcile then (kept out of the happy path to avoid speculative complexity — YAGNI).
