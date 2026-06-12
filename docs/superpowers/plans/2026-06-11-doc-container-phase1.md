# Document Container — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated "Documents" sidebar tree (Category → Collection → Document) plus a reused main-area document-status detail view to the `obsidi-office` plugin, behind a settings toggle — navigation + metadata only, no DB/audit/conversion/diff.

**Architecture:** A single new pure-JS module `lib/doc-container.js` (no Obsidian dependency) holds all testable logic — version parsing, file classification, taxonomy building, schema constants. `main.js` (monolithic, plain JS, no build) requires that module and adds two `ItemView`s: `DocumentBrowserView` (left sidebar) and `DocumentDetailView` (main area), plus a folder scaffolder, ribbon/command, settings, and sidecar metadata glue that reuses the existing P21 sidecar helpers.

**Tech Stack:** Plain CommonJS JS, Obsidian API, Node built-in test runner (`node --test`, zero deps). No bundler, no TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-11-doc-container-phase1-design.md`

**Branch:** `doc-container` (already created off `main`, spec committed).

**Conventions:**
- New pure logic goes in `lib/doc-container.js` and is unit-tested. Obsidian-bound code goes in `main.js`, following its existing patterns (`class XView extends ...`, `this.registerView(...)`, `addRibbonIcon`, settings on the existing settings tab).
- Match the existing CSS-injection approach in `main.js` (search for the existing sidecar-hiding `<style>` / `document.head.appendChild` block) when adding styles.
- After each view task, **deploy + manual smoke** is the test (Obsidian views can't be unit-tested headlessly). Deploy target: `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\` (copy `main.js`, `manifest.json`, and `lib/doc-container.js`).
- **UI rendering is the fine-tuning surface** — keep all markup/CSS inside `renderTree()` / `renderDetail()` so visual tweaks stay contained. The browser mockups in `.superpowers/brainstorm/` are the visual reference.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/doc-container.js` | Create | Pure logic: `parseVersion`, `compareVersions`, `groupDocumentFiles`, `classifyFile`, `buildTaxonomy`, `DOC_FIELDS`/`STATUS_VALUES`/`MANAGED_EXTS` constants. No Obsidian import. |
| `lib/doc-container.test.js` | Create | `node --test` unit tests for every exported function. |
| `main.js` | Modify | View types, `DocumentBrowserView`, `DocumentDetailView`, `DocContainerScaffolder`, ribbon + command, `registerView` wiring, settings section, sidecar metadata read/write glue. |
| `styles.css` *(or main.js style block)* | Modify | `.doc-container-*` styles for tree + detail. Use whichever the plugin already uses for sidecar CSS. |

---

## Task 1: Pure core — version parsing

**Files:**
- Create: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
// lib/doc-container.test.js
const test = require('node:test');
const assert = require('node:assert');
const dc = require('./doc-container.js');

test('parseVersion: bare name is revision 1.0', () => {
  assert.deepStrictEqual(dc.parseVersion('FanOutPolicy.docx'),
    { base: 'FanOutPolicy', ext: 'docx', major: 1, minor: 0, label: 'rev 1.0', parsed: true });
});

test('parseVersion: _V2.0 suffix', () => {
  assert.deepStrictEqual(dc.parseVersion('FanOutPolicy_V2.0.docx'),
    { base: 'FanOutPolicy', ext: 'docx', major: 2, minor: 0, label: 'rev 2.0', parsed: true });
});

test('parseVersion: _V3.10 two-digit minor', () => {
  const r = dc.parseVersion('Plan_V3.10.xlsx');
  assert.strictEqual(r.major, 3); assert.strictEqual(r.minor, 10);
});

test('parseVersion: non-office or weird name still returns parsed=true with base', () => {
  const r = dc.parseVersion('contact-list.xlsx');
  assert.strictEqual(r.base, 'contact-list'); assert.strictEqual(r.major, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `Cannot find module './doc-container.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/doc-container.js
'use strict';

const MANAGED_EXTS = ['docx', 'pptx', 'xlsx', 'pdf'];

// "<base>_V<major>.<minor>.<ext>" → version; bare "<base>.<ext>" → rev 1.0
function parseVersion(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const m = stem.match(/^(.*)_V(\d+)\.(\d+)$/);
  if (m) {
    return { base: m[1], ext, major: Number(m[2]), minor: Number(m[3]),
             label: `rev ${Number(m[2])}.${Number(m[3])}`, parsed: true };
  }
  return { base: stem, ext, major: 1, minor: 0, label: 'rev 1.0', parsed: true };
}

module.exports = { MANAGED_EXTS, parseVersion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/doc-container.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js
git commit -m "feat(doc-container): version filename parser + tests"
```

---

## Task 2: Pure core — compare versions & group a Document's files

**Files:**
- Modify: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('compareVersions orders ascending', () => {
  assert.ok(dc.compareVersions({major:2,minor:0},{major:2,minor:1}) < 0);
  assert.ok(dc.compareVersions({major:3,minor:0},{major:2,minor:9}) > 0);
  assert.strictEqual(dc.compareVersions({major:1,minor:0},{major:1,minor:0}), 0);
});

test('groupDocumentFiles: pins highest version of the primary base, lists attachments', () => {
  const files = ['FanOutPolicy_V2.0.docx','FanOutPolicy.docx','contact-list.xlsx','notes.txt'];
  const g = dc.groupDocumentFiles(files);
  assert.strictEqual(g.current, 'FanOutPolicy_V2.0.docx');
  assert.deepStrictEqual(g.versions, ['FanOutPolicy_V2.0.docx','FanOutPolicy.docx']); // current first, then history
  assert.deepStrictEqual(g.attachments, ['contact-list.xlsx','notes.txt']);
});

test('groupDocumentFiles: largest version-set base wins as primary', () => {
  // base "Plan" has 2 versions, "Annex" has 1 → Plan is primary, Annex is attachment
  const g = dc.groupDocumentFiles(['Plan.docx','Plan_V2.0.docx','Annex.docx']);
  assert.strictEqual(g.current, 'Plan_V2.0.docx');
  assert.deepStrictEqual(g.attachments, ['Annex.docx']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.compareVersions is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
function compareVersions(a, b) {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

// Group a Document folder's filenames: choose the base with the most versions as
// primary; its highest version = current; the rest of that base = history;
// everything else = attachments.
function groupDocumentFiles(filenames) {
  const byBase = new Map();
  for (const f of filenames) {
    const v = parseVersion(f);
    if (!byBase.has(v.base)) byBase.set(v.base, []);
    byBase.get(v.base).push({ name: f, ...v });
  }
  let primaryBase = null, primaryCount = -1;
  for (const [base, arr] of byBase) {
    const officeCount = arr.filter(x => MANAGED_EXTS.includes(x.ext)).length;
    if (officeCount > primaryCount) { primaryCount = officeCount; primaryBase = base; }
  }
  const primary = (byBase.get(primaryBase) || []).slice()
    .sort((a, b) => compareVersions(b, a)); // descending → current first
  const versions = primary.map(x => x.name);
  const current = versions[0] || null;
  const attachments = filenames.filter(f => !versions.includes(f));
  return { current, versions, attachments };
}

module.exports = { MANAGED_EXTS, parseVersion, compareVersions, groupDocumentFiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/doc-container.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js
git commit -m "feat(doc-container): compareVersions + groupDocumentFiles + tests"
```

---

## Task 3: Pure core — build taxonomy tree from a path list

**Files:**
- Modify: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

A **Document** = the deepest folder that directly contains ≥1 managed office file. depth-1 folder under the root = **Category**; folders between = **Collection**.

- [ ] **Step 1: Write the failing test**

```js
test('buildTaxonomy: classifies category/collection/document from paths', () => {
  const paths = [
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy_V2.0.docx',
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy.docx',
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy_V2.0.docx.md',
    'Documents/Projects/Accreditation 2026/HIRA Methodology/BaycrestHIRA_Methodology_V1.0.xlsx',
  ];
  const tree = dc.buildTaxonomy(paths, 'Documents');
  const gov = tree.find(c => c.name === 'Governance');
  assert.strictEqual(gov.kind, 'category');
  const policy = gov.children.find(c => c.name === 'Policy');
  assert.strictEqual(policy.kind, 'collection');
  const doc = policy.children.find(d => d.name === 'Fan-Out Notification Policy');
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.current, 'FanOutPolicy_V2.0.docx');     // sidecar (.md) excluded from versions
  assert.deepStrictEqual(doc.files.sort(), ['FanOutPolicy.docx','FanOutPolicy_V2.0.docx']);
});

test('buildTaxonomy: ignores paths outside the managed root', () => {
  const tree = dc.buildTaxonomy(['Home.md','Meetings/note.md'], 'Documents');
  assert.deepStrictEqual(tree, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.buildTaxonomy is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
function isManaged(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MANAGED_EXTS.includes(ext);
}
function isSidecar(name) { return name.toLowerCase().endsWith('.md'); }

// paths: vault-relative file paths (forward slashes). root: managed-root folder name.
function buildTaxonomy(paths, root) {
  const prefix = root.replace(/\/+$/, '') + '/';
  // folderPath -> Set of direct child filenames (office files only)
  const folderFiles = new Map();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const slash = p.lastIndexOf('/');
    const folder = p.slice(0, slash);
    const name = p.slice(slash + 1);
    if (isSidecar(name)) continue;
    if (!isManaged(name)) { // remember stray files too, as attachments
      if (!folderFiles.has(folder)) folderFiles.set(folder, []);
      folderFiles.get(folder).push(name);
      continue;
    }
    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder).push(name);
  }
  // A folder is a Document if it has ≥1 managed office file directly in it.
  const documents = new Set();
  for (const [folder, files] of folderFiles) {
    if (files.some(isManaged)) documents.add(folder);
  }
  // Build nested category/collection/document tree.
  const rootNode = { children: [] };
  const ensure = (parent, name, path) => {
    let n = parent.children.find(c => c.name === name && c.path === path);
    if (!n) { n = { name, path, kind: null, children: [] }; parent.children.push(n); }
    return n;
  };
  for (const docFolder of documents) {
    const rel = docFolder.slice(prefix.length);          // e.g. Governance/Policy/Fan-Out…
    const segs = rel.split('/');
    let parent = rootNode, acc = root;
    segs.forEach((seg, i) => {
      acc += '/' + seg;
      const node = ensure(parent, seg, acc);
      if (i === 0) node.kind = 'category';
      else if (i === segs.length - 1) node.kind = 'document';
      else if (!node.kind) node.kind = 'collection';
      parent = node;
    });
    // attach grouped files to the document node
    const docNode = parent;
    const grouped = groupDocumentFiles(folderFiles.get(docFolder));
    docNode.current = grouped.current;
    docNode.files = grouped.versions;
    docNode.attachments = grouped.attachments;
  }
  return rootNode.children;
}

module.exports = { MANAGED_EXTS, parseVersion, compareVersions, groupDocumentFiles, buildTaxonomy, isManaged, isSidecar };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/doc-container.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js
git commit -m "feat(doc-container): buildTaxonomy from path list + tests"
```

---

## Task 4: Pure core — metadata schema constants

**Files:**
- Modify: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('schema exposes Phase-1 fields, reserved fields, and status values', () => {
  assert.deepStrictEqual(dc.DOC_FIELDS.phase1.map(f => f.key),
    ['title','docNumber','docClass','revision','status','department','originator','originationDate','summary','tags']);
  assert.ok(dc.DOC_FIELDS.reserved.includes('reviewers'));
  assert.ok(dc.DOC_FIELDS.reserved.includes('finalApprover'));
  assert.ok(dc.STATUS_VALUES.includes('Draft') && dc.STATUS_VALUES.includes('Approved'));
  assert.deepStrictEqual(dc.DOC_CLASSES.slice(0,2), ['Policy','SOP']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'phase1')`.

- [ ] **Step 3: Write minimal implementation**

```js
const STATUS_VALUES = ['Draft','In Review','Pending Approval','Approved','Active','Archived','Obsolete'];
const DOC_CLASSES   = ['Policy','SOP','Work Instruction','Form','Flowchart','Other'];

const DOC_FIELDS = {
  phase1: [
    { key:'title',           label:'Title',            type:'text' },
    { key:'docNumber',       label:'Document Number',  type:'text' },
    { key:'docClass',        label:'Document Class',   type:'select', options: DOC_CLASSES },
    { key:'revision',        label:'Revision',         type:'text' },
    { key:'status',          label:'Status',           type:'select', options: STATUS_VALUES },
    { key:'department',      label:'Department',       type:'text' },
    { key:'originator',      label:'Originator',       type:'text' },
    { key:'originationDate', label:'Origination Date', type:'date' },
    { key:'summary',         label:'Summary',          type:'textarea' },
    { key:'tags',            label:'Tags',             type:'tags' },
  ],
  // reserved — defined now, not edited in Phase 1 (workflow phases activate these)
  reserved: ['reviewers','finalApprover','reviewFrequencyDays','nextReviewDate','statusHistory','relatedDocuments'],
};

module.exports = { MANAGED_EXTS, parseVersion, compareVersions, groupDocumentFiles,
  buildTaxonomy, isManaged, isSidecar, STATUS_VALUES, DOC_CLASSES, DOC_FIELDS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/doc-container.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js
git commit -m "feat(doc-container): metadata schema constants + tests"
```

---

## Task 5: Wire the core module + settings into main.js

**Files:**
- Modify: `main.js` (top require area; the plugin `DEFAULT_SETTINGS` object; the settings tab `display()`)

- [ ] **Step 1: Require the core module near the top of main.js**

Add after the existing `const obsidian = require('obsidian');` line:

```js
const docContainer = require('./lib/doc-container.js');
```

- [ ] **Step 2: Add settings defaults**

Find the existing `DEFAULT_SETTINGS` object in `main.js` and add:

```js
  docBrowserEnabled: false,
  docRoot: 'Documents',
  docCategories: ['Governance', 'Projects', 'SOPs'],
```

- [ ] **Step 3: Add a settings section**

In the plugin's settings-tab `display()` method, append a section:

```js
new obsidian.Setting(containerEl).setName('Document Browser').setHeading();
new obsidian.Setting(containerEl)
  .setName('Enable Document Browser')
  .setDesc('Adds a Documents pane to the left sidebar (reload to apply).')
  .addToggle(t => t.setValue(this.plugin.settings.docBrowserEnabled)
    .onChange(async v => { this.plugin.settings.docBrowserEnabled = v; await this.plugin.saveSettings(); }));
new obsidian.Setting(containerEl)
  .setName('Managed root folder')
  .setDesc('Vault-relative folder that holds the document taxonomy.')
  .addText(t => t.setValue(this.plugin.settings.docRoot)
    .onChange(async v => { this.plugin.settings.docRoot = v.trim() || 'Documents'; await this.plugin.saveSettings(); }));
new obsidian.Setting(containerEl)
  .setName('Categories')
  .setDesc('Comma-separated top-level categories ensured under the root.')
  .addText(t => t.setValue(this.plugin.settings.docCategories.join(', '))
    .onChange(async v => { this.plugin.settings.docCategories = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
```

- [ ] **Step 4: Verify syntax**

Run: `node --check main.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): require core module + settings (toggle/root/categories)"
```

---

## Task 6: Folder scaffolder

**Files:**
- Modify: `main.js` (add a method on the plugin class; call it from `onLayoutReady`)

- [ ] **Step 1: Add the scaffolder method to the plugin class**

```js
async ensureDocTaxonomy() {
  if (!this.settings.docBrowserEnabled) return;
  const root = this.settings.docRoot;
  const mk = async (path) => {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try { await this.app.vault.createFolder(path); } catch (e) { /* exists race — ignore */ }
    }
  };
  await mk(root);
  for (const cat of this.settings.docCategories) await mk(`${root}/${cat}`);
}
```

- [ ] **Step 2: Call it from onLayoutReady**

Find the existing `this.app.workspace.onLayoutReady(...)` call in `onload()` (the plugin already uses it for the note-frontmatter listener). Inside that callback, add:

```js
this.ensureDocTaxonomy();
```

If no `onLayoutReady` block exists in `onload`, add:

```js
this.app.workspace.onLayoutReady(() => { this.ensureDocTaxonomy(); });
```

- [ ] **Step 3: Verify syntax**

Run: `node --check main.js`
Expected: exit 0.

- [ ] **Step 4: Deploy + smoke**

Copy `main.js` + `lib/doc-container.js` to `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`. In Obsidian: Settings → ObsidiOffice → enable Document Browser, reload. Confirm `Documents/`, `Documents/Governance/`, `Documents/Projects/`, `Documents/SOPs/` now exist in the vault. Re-reload → no errors, no duplicate folders (idempotent).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): scaffold managed root + category folders on layout-ready"
```

---

## Task 7: DocumentBrowserView (sidebar tree)

**Files:**
- Modify: `main.js` (add `VIEW_TYPE_DOC_BROWSER` const; `DocumentBrowserView` class; `registerView`; ribbon icon + command + activation helper)

- [ ] **Step 1: Add the view-type constant**

Near the other `const VIEW_TYPE...` declarations:

```js
const VIEW_TYPE_DOC_BROWSER = 'obsidi-office-doc-browser';
const VIEW_TYPE_DOC_DETAIL  = 'obsidi-office-doc-detail';
```

- [ ] **Step 2: Add the DocumentBrowserView class**

```js
class DocumentBrowserView extends obsidian.ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.collapsed = new Set(); }
  getViewType() { return VIEW_TYPE_DOC_BROWSER; }
  getDisplayText() { return 'Document Browser'; }
  getIcon() { return 'folder-tree'; }

  async onOpen() { this.render(); }
  async onClose() {}

  scan() {
    const root = this.plugin.settings.docRoot;
    const paths = this.app.vault.getFiles().map(f => f.path);
    return docContainer.buildTaxonomy(paths, root);
  }

  render() {
    const c = this.containerEl.children[1];
    c.empty();
    c.addClass('doc-container-pane');
    const toolbar = c.createDiv('doc-container-toolbar');
    toolbar.createSpan({ text: 'DOCUMENT BROWSER', cls: 'doc-container-title' });
    const refresh = toolbar.createSpan({ text: '↻', cls: 'doc-container-act' });
    refresh.onclick = () => this.render();
    const tree = c.createDiv('doc-container-tree');
    const nodes = this.scan();
    if (!nodes.length) { tree.createDiv({ text: 'No documents found under ' + this.plugin.settings.docRoot, cls: 'doc-container-empty' }); return; }
    for (const n of nodes) this.renderNode(tree, n, 0);
  }

  renderNode(parent, node, depth) {
    const row = parent.createDiv('doc-container-node');
    row.style.paddingLeft = (8 + depth * 16) + 'px';
    if (node.kind === 'document') {
      row.addClass('is-doc');
      row.createSpan({ text: '📄 ', cls: 'doc-container-ico' });
      row.createSpan({ text: node.name });
      const status = this.readStatus(node);
      if (status) row.createSpan({ text: status, cls: 'doc-container-badge st-' + status.toLowerCase().replace(/\s+/g, '-') });
      row.onclick = () => { this.plugin.openDocDetail(node); this.markSelected(row); };
    } else {
      const isCollapsed = this.collapsed.has(node.path);
      row.createSpan({ text: isCollapsed ? '▸ ' : '▾ ', cls: 'doc-container-tw' });
      row.createSpan({ text: (node.kind === 'category' ? '📁 ' : '📂 ') });
      row.createSpan({ text: node.name });
      row.onclick = () => { if (isCollapsed) this.collapsed.delete(node.path); else this.collapsed.add(node.path); this.render(); };
      if (!isCollapsed) for (const ch of node.children) this.renderNode(parent, ch, depth + 1);
    }
  }

  readStatus(node) {
    if (!node.current) return null;
    const sidecar = this.app.vault.getAbstractFileByPath(node.path + '/' + node.current + '.md');
    if (!sidecar) return null;
    const cache = this.app.metadataCache.getFileCache(sidecar);
    return (cache && cache.frontmatter && cache.frontmatter.status) || null;
  }

  markSelected(row) {
    this.containerEl.querySelectorAll('.doc-container-node.is-selected').forEach(e => e.removeClass('is-selected'));
    row.addClass('is-selected');
  }
}
```

- [ ] **Step 3: Register the view + ribbon + command + activation helper**

In `onload()`, alongside the existing `registerView` calls:

```js
this.registerView(VIEW_TYPE_DOC_BROWSER, (leaf) => new DocumentBrowserView(leaf, this));

if (this.settings.docBrowserEnabled) {
  this.addRibbonIcon('folder-tree', 'Document Browser', () => this.activateDocBrowser());
  this.addCommand({ id: 'open-document-browser', name: 'Open Document Browser',
    callback: () => this.activateDocBrowser() });
}
```

Add the activation helper as a plugin method:

```js
async activateDocBrowser() {
  let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER)[0];
  if (!leaf) { leaf = this.app.workspace.getLeftLeaf(false); await leaf.setViewState({ type: VIEW_TYPE_DOC_BROWSER, active: true }); }
  this.app.workspace.revealLeaf(leaf);
}
```

- [ ] **Step 4: Add a temporary stub so it loads**

Add a stub method (replaced in Task 8): `openDocDetail(node) { new obsidian.Notice('Document: ' + node.name); }`

- [ ] **Step 5: Verify syntax + deploy + smoke**

Run: `node --check main.js` → exit 0.
Deploy `main.js` + `lib/doc-container.js`. Reload Obsidian. Click the new ribbon icon (or run the command) → a "Document Browser" pane appears in the left sidebar showing the scaffolded taxonomy. Expand/collapse Category/Collection works. Clicking a Document shows the stub Notice. (Seed a couple of `.docx` files under `Documents/Governance/Policy/<DocName>/` first to see Documents.)

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): DocumentBrowserView sidebar tree + ribbon/command"
```

---

## Task 8: DocumentDetailView (main-area status form) + open handler

**Files:**
- Modify: `main.js` (add `DocumentDetailView` class; `registerView`; replace the `openDocDetail` stub)

- [ ] **Step 1: Add the DocumentDetailView class**

```js
class DocumentDetailView extends obsidian.ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.node = null; }
  getViewType() { return VIEW_TYPE_DOC_DETAIL; }
  getDisplayText() { return this.node ? this.node.name : 'Document Status'; }
  getIcon() { return 'file-text'; }

  async setState(state, result) {
    if (state && state.docPath) {
      const paths = this.app.vault.getFiles().map(f => f.path);
      const tree = docContainer.buildTaxonomy(paths, this.plugin.settings.docRoot);
      this.node = this.findDoc(tree, state.docPath);
      this.render();
    }
    return super.setState(state, result);
  }
  getState() { return { docPath: this.node ? this.node.path : null }; }

  findDoc(nodes, path) {
    for (const n of nodes) {
      if (n.kind === 'document' && n.path === path) return n;
      if (n.children) { const f = this.findDoc(n.children, path); if (f) return f; }
    }
    return null;
  }

  sidecarFor(file) { return this.app.vault.getAbstractFileByPath(this.node.path + '/' + file + '.md'); }
  frontmatter() {
    if (!this.node || !this.node.current) return {};
    const sc = this.sidecarFor(this.node.current);
    if (!sc) return {};
    const cache = this.app.metadataCache.getFileCache(sc);
    return (cache && cache.frontmatter) || {};
  }

  render() {
    const c = this.containerEl.children[1];
    c.empty(); c.addClass('doc-detail');
    if (!this.node) { c.createDiv({ text: 'Select a document.', cls: 'doc-detail-empty' }); return; }
    const fm = this.frontmatter();
    const wrap = c.createDiv('doc-detail-wrap');
    wrap.createDiv({ text: this.node.path.split('/').slice(0, -1).join(' › '), cls: 'doc-detail-crumb' });
    wrap.createDiv({ text: fm.title || this.node.name, cls: 'doc-detail-title' });
    wrap.createDiv({ text: 'Document Status', cls: 'doc-detail-sub' });

    const grid = wrap.createDiv('doc-detail-grid');
    for (const f of docContainer.DOC_FIELDS.phase1) {
      const cell = grid.createDiv('doc-detail-fld');
      if (f.type === 'textarea' || f.key === 'title') cell.addClass('span2');
      cell.createDiv({ text: f.label.toUpperCase(), cls: 'doc-detail-lab' });
      let val = fm[f.key];
      if (f.key === 'tags' && Array.isArray(val)) val = val.map(t => '#' + String(t).replace(/^#/, '')).join(' ');
      if (f.key === 'revision' && !val && this.node.current) val = docContainer.parseVersion(this.node.current).label.replace('rev ', '');
      cell.createDiv({ text: val != null && val !== '' ? String(val) : '—', cls: 'doc-detail-val' });
    }

    // Files & Versions
    const fv = wrap.createDiv('doc-detail-sec');
    fv.createEl('h4', { text: 'Files & Versions' });
    const rowFor = (name, badge, badgeCls, isCurrent) => {
      const r = fv.createDiv('doc-detail-frow' + (isCurrent ? ' cur' : ''));
      const left = r.createDiv('doc-detail-fl');
      left.createSpan({ text: (badgeCls === 'v-att' ? '📎 ' : '📄 ') + name });
      left.createSpan({ text: badge, cls: 'doc-detail-vbadge ' + badgeCls });
      const openBtn = r.createSpan({ text: 'Open', cls: 'doc-detail-fbtn' });
      openBtn.onclick = () => this.plugin.openFileInEditor(this.node.path + '/' + name);
    };
    (this.node.files || []).forEach((f, i) => {
      const isCur = f === this.node.current;
      rowFor(f, isCur ? 'current' : docContainer.parseVersion(f).label, isCur ? 'v-cur' : 'v-old', isCur);
    });
    (this.node.attachments || []).forEach(a => rowFor(a, 'attachment', 'v-att', false));

    // Actions
    const act = wrap.createDiv('doc-detail-sec');
    act.createEl('h4', { text: 'Actions' });
    const mkBtn = (label, cls, fn) => { const b = act.createSpan({ text: label, cls: 'doc-detail-btn ' + (cls||'') }); b.onclick = fn; };
    mkBtn('Open in editor', 'accent', () => this.node.current && this.plugin.openFileInEditor(this.node.path + '/' + this.node.current));
    mkBtn('Open in system app', '', () => this.node.current && this.plugin.openInSystemApp(this.node.path + '/' + this.node.current));
    mkBtn('Edit metadata', '', () => this.node.current && this.plugin.openMetadataModal(this.node.path + '/' + this.node.current));
    mkBtn('Reveal in file explorer', '', () => this.node.current && this.plugin.revealInExplorer(this.node.path + '/' + this.node.current));
  }
}
```

- [ ] **Step 2: Register the detail view**

In `onload()`:

```js
this.registerView(VIEW_TYPE_DOC_DETAIL, (leaf) => new DocumentDetailView(leaf, this));
```

- [ ] **Step 3: Replace the openDocDetail stub with the real reused-leaf opener**

```js
async openDocDetail(node) {
  let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_DETAIL)[0];
  if (!leaf) leaf = this.app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: VIEW_TYPE_DOC_DETAIL, active: true, state: { docPath: node.path } });
  this.app.workspace.revealLeaf(leaf);
}
```

- [ ] **Step 4: Verify syntax**

Run: `node --check main.js` → exit 0.

- [ ] **Step 5: Deploy + smoke**

Deploy. Reload. Click a Document in the sidebar → the status form opens in the main area showing metadata (or `—` where the sidecar has none) + Files & Versions (current pinned, attachments) + Actions. Click a second Document → the SAME main-area leaf re-targets (no new tab stacking).

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): DocumentDetailView status form + reused-leaf open"
```

---

## Task 9: Detail action handlers (open / system app / metadata / reveal)

**Files:**
- Modify: `main.js` (add four plugin methods, reusing existing P21 helpers)

- [ ] **Step 1: Implement the four helpers**

Reuse existing routing — search `main.js` for the existing open-in-view routing (`_openInView` / `setViewState({ type: VIEW_TYPE, state:{ file }})`) and the existing MetadataModal opener; call them here.

```js
async openFileInEditor(path) {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file) { new obsidian.Notice('File not found: ' + path); return; }
  // reuse existing extension→view routing used by the landing page
  await this._openInView(file);   // if the existing method has a different name, call that instead
}
openInSystemApp(path) {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file) return;
  const full = this.app.vault.adapter.getFullPath ? this.app.vault.adapter.getFullPath(path) : path;
  // desktop only
  try { const { shell } = require('electron'); shell.openPath(full); } catch (e) { new obsidian.Notice('System app unavailable on this platform'); }
}
openMetadataModal(path) {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (file) this.openSidecarMetadata(file);   // reuse existing MetadataModal entry point (rename to the actual method)
}
revealInExplorer(path) {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (file) this.app.workspace.getLeftLeaf(false); // then:
  this.app.commands.executeCommandById('file-explorer:reveal-active-file');
}
```

- [ ] **Step 2: Reconcile method names**

Confirm the actual existing method names by searching `main.js` (`grep -nE "_openInView|openMetadata|MetadataModal|reveal" main.js`) and update the three reused calls (`_openInView`, `openSidecarMetadata`) to match. If `_openInView` does not exist, route directly:

```js
async openFileInEditor(path) {
  const file = this.app.vault.getAbstractFileByPath(path);
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const typeMap = { docx: VIEW_TYPE, pptx: VIEW_TYPE_PPTX, xlsx: VIEW_TYPE_XLSX, pdf: VIEW_TYPE_PDF };
  const vt = typeMap[ext];
  const leaf = this.app.workspace.getLeaf('tab');
  if (vt) await leaf.setViewState({ type: vt, active: true, state: { file: path } });
  else await leaf.openFile(file);
}
```

- [ ] **Step 3: Verify syntax + deploy + smoke**

Run: `node --check main.js` → exit 0. Deploy. Reload. From the detail view: Open in editor opens the current `.docx`/`.xlsx` in the Obsidi-Office editor; Open in system app launches Word/Excel (desktop); Edit metadata opens the existing sidecar modal; Reveal highlights the file in the native explorer.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): detail action handlers (open/system/metadata/reveal)"
```

---

## Task 10: Live refresh — keep tree + detail current

**Files:**
- Modify: `main.js` (register vault + metadata listeners scoped to the managed root)

- [ ] **Step 1: Register listeners inside onLayoutReady**

In the same `onLayoutReady` callback as the scaffolder (critical — avoids the startup index burst), add:

```js
const refreshIfManaged = (file) => {
  if (!this.settings.docBrowserEnabled) return;
  if (!file || !file.path || !file.path.startsWith(this.settings.docRoot + '/')) return;
  this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
};
this.registerEvent(this.app.vault.on('create', refreshIfManaged));
this.registerEvent(this.app.vault.on('delete', refreshIfManaged));
this.registerEvent(this.app.vault.on('rename', (f) => refreshIfManaged(f)));
this.registerEvent(this.app.metadataCache.on('changed', refreshIfManaged)); // status badge refresh
```

- [ ] **Step 2: Verify syntax + deploy + smoke**

Run: `node --check main.js` → exit 0. Deploy. Reload. Add a `.docx` under a Document folder via the OS → the sidebar tree updates without manual refresh. Edit a sidecar `status` via the metadata modal → the tree badge updates.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): live tree/badge refresh via vault + metadata listeners"
```

---

## Task 11: Styles

**Files:**
- Modify: `styles.css` if present, else the existing in-`main.js` style-injection block (match the sidecar-hiding CSS approach).

- [ ] **Step 1: Add the styles**

```css
/* Document Browser sidebar */
.doc-container-pane { font-size: var(--font-ui-small); }
.doc-container-toolbar { display:flex; align-items:center; justify-content:space-between; padding:4px 10px; color: var(--text-faint); }
.doc-container-title { font-size:10px; letter-spacing:.07em; text-transform:uppercase; }
.doc-container-act { cursor:pointer; }
.doc-container-node { display:flex; align-items:center; gap:5px; padding:4px 6px; border-radius:5px; white-space:nowrap; cursor:pointer; }
.doc-container-node:hover { background: var(--background-modifier-hover); }
.doc-container-node.is-selected { background: var(--background-modifier-active-hover); box-shadow: inset 2px 0 0 var(--interactive-accent); }
.doc-container-tw { width:11px; color: var(--text-faint); font-size:10px; }
.doc-container-badge { margin-left:auto; font-size:9px; padding:1px 7px; border-radius:9px; background: var(--background-modifier-border); }
.doc-container-badge.st-draft { color:#d6a24a; } .doc-container-badge.st-active { color:#48b884; } .doc-container-badge.st-in-review { color:#5b8def; }
.doc-container-empty, .doc-detail-empty { color: var(--text-faint); padding:14px; }
/* Document Status detail */
.doc-detail-wrap { max-width: 980px; padding: 8px 6px; }
.doc-detail-crumb { font-size:12px; color: var(--text-faint); }
.doc-detail-title { font-size:22px; font-weight:600; }
.doc-detail-sub { font-size:12px; color: var(--text-muted); margin-bottom:18px; }
.doc-detail-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px 22px; }
.doc-detail-fld.span2 { grid-column: span 2; }
.doc-detail-lab { font-size:10px; letter-spacing:.05em; color: var(--text-faint); margin-bottom:4px; }
.doc-detail-val { background: var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:6px; padding:8px 11px; min-height:34px; }
.doc-detail-sec { margin-top:20px; }
.doc-detail-sec h4 { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color: var(--text-faint); border-bottom:1px solid var(--background-modifier-border); padding-bottom:6px; }
.doc-detail-frow { display:flex; align-items:center; justify-content:space-between; padding:8px 11px; border-radius:7px; background: var(--background-secondary); margin:5px 0; }
.doc-detail-frow.cur { box-shadow: inset 0 0 0 1px rgba(72,184,132,.4); }
.doc-detail-vbadge { font-size:9px; padding:2px 8px; border-radius:9px; margin-left:8px; }
.doc-detail-vbadge.v-cur { color:#48b884; } .doc-detail-vbadge.v-att { color:#5b8def; } .doc-detail-vbadge.v-old { color: var(--text-muted); }
.doc-detail-fbtn, .doc-detail-btn { font-size:11px; padding:4px 11px; border-radius:6px; border:1px solid var(--background-modifier-border); cursor:pointer; margin-left:6px; }
.doc-detail-btn.accent { background: var(--interactive-accent); color: var(--text-on-accent); }
```

- [ ] **Step 2: Deploy + smoke**

Deploy (`main.js` + `lib/doc-container.js` + `styles.css` if used). Reload. Confirm the tree and detail view match the approved mockup (Obsidian theme colours, status badges, current-version pin, 3-column grid).

- [ ] **Step 3: Commit**

```bash
git add styles.css main.js
git commit -m "feat(doc-container): styles for sidebar tree + detail view"
```

---

## Task 12: Desktop smoke gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full desktop checklist**

Seed a sample taxonomy with a Document folder holding `X.docx` + `X_V2.0.docx` + a sidecar with `status`, a Document with an `.xlsx`, and a stray `.txt`. Verify:
- Scaffold created missing Category folders; re-reload is idempotent.
- Sidebar leaf mounts via ribbon + command; tree shows Categories/Collections/Documents only (no version files).
- Expand/collapse works; current-version pin correct; stray `.txt` shows as attachment, not a Document.
- Click Document → detail opens in main area; second Document re-targets the same leaf.
- Metadata fields render from sidecar; `—` where absent; revision defaults from filename.
- All four actions work; metadata edit round-trips and refreshes the tree badge.
- Disable the toggle + reload → no Documents pane, no ribbon icon, no errors.

- [ ] **Step 2: Run unit tests once more**

Run: `node --test lib/doc-container.test.js`
Expected: all PASS.

- [ ] **Step 3: Commit any fixes, then tag the phase**

```bash
git add -A && git commit -m "test(doc-container): Phase 1 desktop smoke fixes" || echo "no fixes needed"
```

---

## Task 13: iPad smoke gate

**Files:** none (verification only)

- [ ] **Step 1: Verify on iPad after Obsidian Sync propagates main.js + lib/doc-container.js**

- Sidebar Documents pane mounts; tree renders.
- Click Document → detail opens in main area.
- Open in editor routes to the Obsidi-Office editor (docx/xlsx).
- "Open in system app" shows the graceful "unavailable on this platform" Notice (Electron `shell` absent on mobile) — not a crash.

- [ ] **Step 2: Record results + commit notes**

Append results to this plan file under a "Smoke results" heading; commit.

```bash
git add docs/superpowers/plans/2026-06-11-doc-container-phase1.md
git commit -m "docs(doc-container): Phase 1 iPad smoke results"
```

---

---

# Phase 1 additions — container overviews, lifecycle, new-version, filter

> These extend the core plan above (decided during UI fine-tuning). Do the pure-core additions (Tasks 14–16) right after Task 4; do the view additions (17–19) after Task 8. Amendments to earlier tasks are listed first.

## Amendments to earlier tasks

- **Task 4 schema** — add three lifecycle fields to `DOC_FIELDS.phase1` (after `originationDate`), and remove `reviewFrequencyDays`/`nextReviewDate` from `reserved`:

```js
    { key:'effectiveDate',       label:'Effective Date',         type:'date' },
    { key:'reviewFrequencyDays', label:'Review Frequency (days)',type:'number' },
    { key:'nextReviewDate',      label:'Next Review',            type:'date' },
```
```js
  reserved: ['reviewers','finalApprover','statusHistory','relatedDocuments'],
```

- **Task 7 tree click** — clicking a container node's **label** now opens its overview (not just expand). Keep the twistie for expand/collapse. In `renderNode`, for non-document nodes split the row: a `tw` twistie span toggles `this.collapsed`; the label span calls `this.plugin.openContainerOverview(node)`. Document rows still call `openDocDetail`.

- **Task 8 detail** — add a **Lifecycle** field group (Origination, Effective, Review Frequency, Next Review) and a tabbed **Related Stakeholders / Related Documents** right column (reserved fields, mostly `—`). Compute the Next Review display when `nextReviewDate` is empty via `docContainer.computeNextReview(fm.effectiveDate, fm.reviewFrequencyDays)`, and show an `overdue` pill when `docContainer.isOverdue(nextReview, todayISO())`.

- **Task 11 styles** — add `.doc-container-filter`, `.doc-ov-*` (overview rollup/cards/table), `.doc-ov-modal` (New X modal) classes alongside the tree/detail styles.

---

## Task 14: Pure core — lifecycle (next review + overdue)

**Files:** Modify `lib/doc-container.js`; Test `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('computeNextReview adds freq days to effective date', () => {
  assert.strictEqual(dc.computeNextReview('2026-04-20', 180), '2026-10-17');
  assert.strictEqual(dc.computeNextReview('2026-04-20', 0), null);   // no cadence
  assert.strictEqual(dc.computeNextReview('', 180), null);           // no effective date
});
test('isOverdue compares against today', () => {
  assert.strictEqual(dc.isOverdue('2026-01-01', '2026-06-11'), true);
  assert.strictEqual(dc.isOverdue('2026-12-01', '2026-06-11'), false);
  assert.strictEqual(dc.isOverdue(null, '2026-06-11'), false);
});
```

- [ ] **Step 2: Run → FAIL** (`dc.computeNextReview is not a function`).

Run: `node --test lib/doc-container.test.js`

- [ ] **Step 3: Implement**

```js
function computeNextReview(effectiveDate, freqDays) {
  const f = Number(freqDays);
  if (!effectiveDate || !f) return null;
  const d = new Date(effectiveDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + f);
  return d.toISOString().slice(0, 10);
}
function isOverdue(nextReviewISO, todayISO) {
  if (!nextReviewISO) return false;
  return nextReviewISO < todayISO;   // ISO date strings compare lexicographically
}
```
Add both to `module.exports`.

- [ ] **Step 4: Run → PASS.** `node --test lib/doc-container.test.js`
- [ ] **Step 5: Commit** — `git commit -am "feat(doc-container): lifecycle next-review + overdue + tests"`

---

## Task 15: Pure core — status rollup + overdue count

**Files:** Modify `lib/doc-container.js`; Test `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('rollupByStatus counts documents per status', () => {
  const docs = [{status:'Draft'},{status:'Draft'},{status:'Active'},{status:null}];
  assert.deepStrictEqual(dc.rollupByStatus(docs), { Draft:2, Active:1, Unset:1 });
});
test('countOverdue counts docs whose nextReview is past', () => {
  const docs = [{nextReviewDate:'2026-01-01'},{nextReviewDate:'2027-01-01'},{nextReviewDate:null}];
  assert.strictEqual(dc.countOverdue(docs, '2026-06-11'), 1);
});
```

- [ ] **Step 2: Run → FAIL.** `node --test lib/doc-container.test.js`

- [ ] **Step 3: Implement**

```js
function rollupByStatus(docs) {
  const out = {};
  for (const d of docs) { const k = d.status || 'Unset'; out[k] = (out[k]||0)+1; }
  return out;
}
function countOverdue(docs, todayISO) {
  return docs.filter(d => isOverdue(d.nextReviewDate, todayISO)).length;
}
```
Add to `module.exports`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(doc-container): status rollup + overdue count + tests"`

---

## Task 16: Pure core — next version filename

**Files:** Modify `lib/doc-container.js`; Test `lib/doc-container.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('nextVersionName bumps minor by default, major on request', () => {
  assert.strictEqual(dc.nextVersionName('FanOutPolicy_V2.0.docx', 'minor'), 'FanOutPolicy_V2.1.docx');
  assert.strictEqual(dc.nextVersionName('FanOutPolicy_V2.0.docx', 'major'), 'FanOutPolicy_V3.0.docx');
  assert.strictEqual(dc.nextVersionName('FanOutPolicy.docx', 'minor'), 'FanOutPolicy_V1.1.docx'); // bare = rev 1.0
});
```

- [ ] **Step 2: Run → FAIL.** `node --test lib/doc-container.test.js`

- [ ] **Step 3: Implement**

```js
function nextVersionName(current, bump) {
  const v = parseVersion(current);
  const major = bump === 'major' ? v.major + 1 : v.major;
  const minor = bump === 'major' ? 0 : v.minor + 1;
  return `${v.base}_V${major}.${minor}.${v.ext}`;
}
```
Add to `module.exports`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(doc-container): nextVersionName + tests"`

---

## Task 17: ContainerOverviewView (render by node kind)

**Files:** Modify `main.js` (add `VIEW_TYPE_DOC_CONTAINER` const; `ContainerOverviewView` class; `registerView`; `openContainerOverview` opener; `createTaxonomyFolder` helper)

- [ ] **Step 1: Add the view-type const + the opener + folder helper**

```js
const VIEW_TYPE_DOC_CONTAINER = 'obsidi-office-doc-container';

// plugin methods:
async openContainerOverview(node) {
  let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_CONTAINER)[0]
          || this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_DETAIL)[0]
          || this.app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: VIEW_TYPE_DOC_CONTAINER, active: true, state: { path: node ? node.path : this.settings.docRoot } });
  this.app.workspace.revealLeaf(leaf);
}
async createTaxonomyFolder(parentPath, name) {
  const clean = (name||'').trim(); if (!clean) return;
  const path = `${parentPath}/${clean}`;
  if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
  this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
  return path;
}
```

- [ ] **Step 2: Add the ContainerOverviewView class**

```js
class ContainerOverviewView extends obsidian.ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.path = null; }
  getViewType() { return VIEW_TYPE_DOC_CONTAINER; }
  getDisplayText() { return this.path ? this.path.split('/').pop() : 'Documents'; }
  getIcon() { return 'folder-open'; }
  async setState(s, r) { if (s && s.path) { this.path = s.path; this.render(); } return super.setState(s, r); }
  getState() { return { path: this.path }; }

  node() {
    const root = this.plugin.settings.docRoot;
    const tree = docContainer.buildTaxonomy(this.app.vault.getFiles().map(f => f.path), root);
    if (this.path === root) return { kind: 'root', path: root, name: root, children: tree };
    const find = (nodes) => { for (const n of nodes) { if (n.path === this.path) return n; if (n.children) { const f = find(n.children); if (f) return f; } } return null; };
    return find(tree);
  }
  // flatten all descendant document nodes (for rollups)
  docsUnder(node) {
    const out = [];
    const walk = (n) => { if (n.kind === 'document') out.push(this.docMeta(n)); (n.children||[]).forEach(walk); };
    (node.children||[]).forEach(walk);
    if (node.kind === 'document') out.push(this.docMeta(node));
    return out;
  }
  docMeta(n) {
    const sc = n.current && this.app.vault.getAbstractFileByPath(n.path + '/' + n.current + '.md');
    const fm = (sc && this.app.metadataCache.getFileCache(sc) || {}).frontmatter || {};
    const nextReview = fm.nextReviewDate || docContainer.computeNextReview(fm.effectiveDate, fm.reviewFrequencyDays);
    return { node: n, title: fm.title || n.name, docNumber: fm.docNumber || '', docClass: fm.docClass || '',
             status: fm.status || null, nextReviewDate: nextReview, tags: fm.tags || [],
             modified: fm.modified || '' };
  }

  render() {
    const c = this.containerEl.children[1]; c.empty(); c.addClass('doc-ov');
    const node = this.node();
    if (!node) { c.createDiv({ text: 'Container not found.', cls: 'doc-ov-empty' }); return; }
    const today = window.moment ? window.moment().format('YYYY-MM-DD') : new Date().toISOString().slice(0,10);
    const docs = this.docsUnder(node);

    // header + rollup
    c.createDiv({ text: node.path.split('/').slice(0,-1).join(' › ') || '', cls: 'doc-ov-crumb' });
    const head = c.createDiv('doc-ov-head');
    head.createSpan({ text: node.name, cls: 'doc-ov-title' });
    const roll = c.createDiv('doc-ov-rollup');
    roll.createSpan({ text: `${docs.length} documents`, cls: 'doc-ov-pill' });
    const by = docContainer.rollupByStatus(docs);
    Object.keys(by).forEach(k => roll.createSpan({ text: `${by[k]} ${k}`, cls: 'doc-ov-pill st-' + k.toLowerCase().replace(/\s+/g,'-') }));
    const over = docContainer.countOverdue(docs, today);
    if (over) roll.createSpan({ text: `${over} review overdue`, cls: 'doc-ov-pill over' });

    if (node.kind === 'collection' || node.kind === 'document') return this.renderDocs(c, node, docs, today);
    return this.renderContainers(c, node);   // root or category
  }

  renderContainers(c, node) {
    const kindLabel = node.kind === 'root' ? 'Category' : 'Collection';
    const btn = c.createEl('button', { text: `＋ New ${kindLabel}`, cls: 'doc-ov-primary' });
    btn.onclick = () => this.promptNew(node.path, kindLabel);
    const grid = c.createDiv('doc-ov-cards');
    for (const child of (node.children||[])) {
      if (child.kind === 'document') continue;     // documents handled at collection level
      const card = grid.createDiv('doc-ov-card');
      card.createDiv({ text: '📂 ' + child.name, cls: 'doc-ov-cardname' });
      const sub = this.docsUnder(child);
      card.createDiv({ text: `${sub.length} docs`, cls: 'doc-ov-cardnum' });
      card.onclick = () => this.plugin.openContainerOverview(child);
    }
  }

  renderDocs(c, node, docs, today) {
    const btn = c.createEl('button', { text: '＋ New Document', cls: 'doc-ov-primary' });
    btn.onclick = () => new obsidian.Notice('New Document flow — see Task 19 follow-up'); // wired with create-doc modal
    const filter = c.createEl('input', { cls: 'doc-ov-filter', attr: { placeholder: 'Search by title or #tag…' } });
    const table = c.createEl('table', { cls: 'doc-ov-table' });
    const head = table.createEl('tr');
    ['Title','Doc #','Class','Status','Next review','Modified','Tags'].forEach(h => head.createEl('th', { text: h }));
    const draw = (term) => {
      table.querySelectorAll('tr.row').forEach(r => r.remove());
      const terms = (term||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      docs.filter(d => { const hay = (d.title + ' ' + (d.tags||[]).map(t=>'#'+t).join(' ')).toLowerCase(); return terms.every(t => hay.includes(t)); })
        .forEach(d => {
          const tr = table.createEl('tr', { cls: 'row' });
          tr.createEl('td', { text: d.title });
          tr.createEl('td', { text: d.docNumber });
          tr.createEl('td', { text: d.docClass });
          tr.createEl('td').createSpan({ text: d.status || '—', cls: d.status ? 'doc-ov-sb st-'+d.status.toLowerCase().replace(/\s+/g,'-') : '' });
          const nr = tr.createEl('td');
          if (docContainer.isOverdue(d.nextReviewDate, today)) nr.createSpan({ text: 'overdue', cls: 'doc-ov-overtxt' });
          else nr.setText(d.nextReviewDate || '—');
          tr.createEl('td', { text: d.modified || '—' });
          tr.createEl('td', { text: (d.tags||[]).map(t=>'#'+t).join(' ') });
          tr.onclick = () => this.plugin.openDocDetail(d.node);
        });
    };
    filter.oninput = () => draw(filter.value);
    draw('');
  }

  promptNew(parentPath, kindLabel) {
    const modal = new obsidian.Modal(this.app);
    modal.titleEl.setText('New ' + kindLabel);
    const input = modal.contentEl.createEl('input', { attr: { placeholder: kindLabel + ' name' }, cls: 'doc-ov-newinput' });
    const path = modal.contentEl.createDiv({ cls: 'doc-ov-newpath', text: parentPath + '/…' });
    input.oninput = () => path.setText(parentPath + '/' + (input.value || '…'));
    const create = modal.contentEl.createEl('button', { text: 'Create folder', cls: 'mod-cta' });
    create.onclick = async () => { await this.plugin.createTaxonomyFolder(parentPath, input.value); modal.close(); this.render(); };
    modal.open(); input.focus();
  }
}
```

- [ ] **Step 3: Register + wire**

In `onload()`:
```js
this.registerView(VIEW_TYPE_DOC_CONTAINER, (leaf) => new ContainerOverviewView(leaf, this));
```

- [ ] **Step 4: Verify + deploy + smoke**

Run: `node --check main.js` → exit 0. Deploy. Reload. Click a Category label → Collections grid + rollup + New Collection (modal creates a folder, live path preview). Click a Collection label → Documents table + working search filter + rollup + overdue flag. Click a document row → detail opens.

- [ ] **Step 5: Commit** — `git commit -am "feat(doc-container): ContainerOverviewView (root/category/collection) + New folder"`

---

## Task 18: Sidebar tree filter box

**Files:** Modify `main.js` (`DocumentBrowserView.render` — add a filter input; filter Documents by title + tags)

- [ ] **Step 1: Add a filter input above the tree and store the query**

In `DocumentBrowserView.render()`, after the toolbar:

```js
const filter = c.createEl('input', { cls: 'doc-container-filter', attr: { placeholder: 'Filter title or #tag…' } });
filter.value = this._q || '';
filter.oninput = () => { this._q = filter.value; this.renderTreeBody(tree); };
```

Refactor the node-drawing into `renderTreeBody(treeEl)`; when `this._q` is set, only show Documents whose `title + #tags` match all comma-split terms, and the containers on their path. (Compute matches from `this.docMetaFor(node)` mirroring the overview's `docMeta`.)

- [ ] **Step 2: Verify + deploy + smoke**

Run: `node --check main.js` → exit 0. Deploy. Reload. Type in the sidebar filter → tree narrows to matching Documents and their parent containers; clearing restores the full tree.

- [ ] **Step 3: Commit** — `git commit -am "feat(doc-container): sidebar tree filter (title+tag)"`

---

## Task 19: New version action

**Files:** Modify `main.js` (add `newDocumentVersion(node)` plugin method; wire the detail's New-version button + Files header button)

- [ ] **Step 1: Implement the action**

```js
async newDocumentVersion(node) {
  if (!node || !node.current) { new obsidian.Notice('No current file to version'); return; }
  const bump = await new Promise(res => {
    const m = new obsidian.Modal(this.app); m.titleEl.setText('New version');
    m.contentEl.createEl('p', { text: 'Bump which part of the revision?' });
    const mk = (label, val) => { const b = m.contentEl.createEl('button', { text: label, cls: 'mod-cta' }); b.style.marginRight = '8px'; b.onclick = () => { res(val); m.close(); }; };
    mk('Minor (x.Y)', 'minor'); mk('Major (X.0)', 'major');
    m.onClose = () => res(null); m.open();
  });
  if (!bump) return;
  const nextName = docContainer.nextVersionName(node.current, bump);
  const srcPath = node.path + '/' + node.current;
  const src = this.app.vault.getAbstractFileByPath(srcPath);
  const data = await this.app.vault.readBinary(src);
  await this.app.vault.createBinary(node.path + '/' + nextName, data);
  // carry metadata forward: copy the sidecar (the existing sidecar auto-create + MetadataModal own the schema)
  const sc = this.app.vault.getAbstractFileByPath(srcPath + '.md');
  if (sc) { const fm = await this.app.vault.read(sc); await this.app.vault.create(node.path + '/' + nextName + '.md', fm); }
  new obsidian.Notice('Created ' + nextName);
  this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach(l => l.view.render && l.view.render());
  this.openDocDetail(node);   // refresh detail (re-scan picks the new current)
}
```

- [ ] **Step 2: Wire the button(s)** — in `DocumentDetailView.render`, the `⎘ New version` header button and the Actions-row button call `this.plugin.newDocumentVersion(this.node)`.

- [ ] **Step 3: Verify + deploy + smoke**

Run: `node --check main.js` → exit 0. Deploy. Reload. Open a Document, click **New version** → choose Minor → a `_Vx.(y+1)` file + sidecar appear; the detail re-renders with the new file pinned as current; the old one drops to history.

- [ ] **Step 4: Commit** — `git commit -am "feat(doc-container): New version action (copy + increment + carry metadata)"`

---

## Task 20: Re-run smoke gates (fold into Tasks 12–13)

- [ ] Re-run the desktop checklist including: filter box, container overviews (all three kinds), New Collection/Category folder creation, lifecycle next-review + overdue, New version. Re-run `node --test lib/doc-container.test.js` (all pure-core incl. lifecycle/rollup/version-name green). Then repeat the iPad gate.

---

---

# Phase 1B — evolved detail view (tabs, notes log, definitions, activity log)

> Folded in from the visual-companion fine-tuning. **Canonical render reference:** `.superpowers/brainstorm/sustained-1/content/document-detail-v4.html` — port markup/handlers from there; production CSS uses Obsidian tokens (Task 11 style block) and scopes `justify-content:space-between` to chevron/select fields only (the Tags-pill alignment fix). Schema sub-structures: spec §6.3. All new state lives in the **current version's sidecar**.

## Task 21: Pure core — inline note-tag extraction

**Files:** Modify `lib/doc-container.js`; Test `lib/doc-container.test.js`

- [ ] **Step 1: Failing test**

```js
test('extractInlineTags pulls completed #tags, leaves trailing partial', () => {
  assert.deepStrictEqual(dc.extractInlineTags('Looks good #review next #urgent '),
    { body: 'Looks good next', tags: ['review','urgent'] });
  assert.deepStrictEqual(dc.extractInlineTags('no tags here'),
    { body: 'no tags here', tags: [] });
  // trailing partial (no space) is captured on flush=true
  assert.deepStrictEqual(dc.extractInlineTags('done #final', true),
    { body: 'done', tags: ['final'] });
});
```

- [ ] **Step 2: Run → FAIL.** `node --test lib/doc-container.test.js`

- [ ] **Step 3: Implement**

```js
function extractInlineTags(text, flush) {
  const tags = []; let body = text;
  const re = /(^|\s)#([\w-]+)\s/;            // a completed "#tag " token
  let m; while ((m = body.match(re))) { tags.push(m[2]); body = body.replace(re, '$1'); }
  if (flush) {                                // on Add: also take a trailing "#tag" with no space
    const t = body.match(/(^|\s)#([\w-]+)\s*$/);
    if (t) { tags.push(t[2]); body = body.replace(/(^|\s)#([\w-]+)\s*$/, '$1'); }
  }
  return { body: body.trim().replace(/\s+/g, ' '), tags };
}
```
Add to `module.exports`.

- [ ] **Step 4: Run → PASS.**  **Step 5: Commit** — `git commit -am "feat(doc-container): inline note-tag extraction + tests"`

---

## Task 22: DocumentDetailView restructure — scroll body + sticky footer + two tab columns

**Files:** Modify `main.js` (`DocumentDetailView.render`)

Replace the Task 8 single-pane render with: a `.doc-detail-scroll` body (metadata groups + a `.doc-detail-cols` grid of two `.doc-detail-col`s) and a `.doc-detail-footer` (sticky, the action buttons). Each column hosts a scoped tab group (`showTab` scopes to `closest('.doc-detail-col')` — port from the prototype). Metadata renders in the four groups (Identification / Classification & Status / Lifecycle / Description); Tags box uses the left-align modifier.

- [ ] Implement render skeleton with empty tab panes (filled by Tasks 23–29); footer with the 5 actions wired to Task 9 handlers.
- [ ] `node --check main.js` → exit 0. Deploy + smoke: detail opens, footer pinned, tabs switch independently per column.
- [ ] Commit — `feat(doc-container): detail view shell (scroll body + sticky footer + two tab columns)`

---

## Task 23: Left tab — Files & Versions + Stakeholders

**Files:** Modify `main.js`

- [ ] **Files & Versions** pane: working version set only (current pinned + history; no attachments here). `⎘ New version` button → Task 19 `newDocumentVersion`.
- [ ] **Stakeholders** pane: table Name · **Title** · Role · Dept from sidecar `stakeholders[] {name,title,role,dept}`. Originator row editable in Phase 1; Reviewer/Final Approver rows shown but workflow-reserved. Title is the load-bearing field (role-based).
- [ ] Deploy + smoke; commit — `feat(doc-container): Files&Versions + Stakeholders (Title) tabs`

---

## Task 24: Left tab — Related Documents (links + drag-drop references)

**Files:** Modify `main.js`

- [ ] Pane: a drag-drop zone + **＋ Add link** at the **top**, then the list of entries from sidecar `relatedDocuments[] {kind:'link'|'ref', target, label}` (🔗 link / 📎 ref) with remove.
- [ ] **Add link** → vault file suggester (reuse Obsidi-Office's existing link-suggest); store `{kind:'link', target:path, label}`.
- [ ] **Drop** files → copy into the Document folder (or store a path link — default: link if the file is already in the vault, else copy in); store `{kind:'ref', ...}`.
- [ ] Deploy + smoke; commit — `feat(doc-container): Related Documents (vault links + drag-drop refs)`

---

## Task 25: Right tab — Recent Notes (structured log + composer)

**Files:** Modify `main.js`; sidecar `noteLog[]`

- [ ] Composer: note input with **inline `#tag`→pill** (use `docContainer.extractInlineTags` on input + on Add); **Add note** button to the right of the input; a **drag-drop attach** zone **disabled until note text present** (port `updateDropState`); dropped files copy into `<Document>/_notes/` and stage as 📎 pills.
- [ ] On Add: append `{date, author, body, noteTags[], attachments[], version: <current>}` to sidecar `noteLog`; **note-tags are written to `noteLog`, NOT to the document `tags`** (separate namespace).
- [ ] Render list newest-first with green note-tags + 📎 attachments. Author = system username (existing helper).
- [ ] Deploy + smoke; commit — `feat(doc-container): Recent Notes structured log + inline-tag composer + gated attach`

---

## Task 26: Right tab — Search Notes (text + tag + date range)

**Files:** Modify `main.js`

- [ ] Search box + funnel **icon** button toggling a From/To date row (port `toggleDateFilter`/`searchNotes`). Filter `noteLog` by text + note-tags + `[from,to]` (ISO string compare), newest-first.
- [ ] Deploy + smoke; commit — `feat(doc-container): Search Notes (text + note-tag + date-range)`

---

## Task 27: Right tab — Log (activity feed) + ActivityLog writer

**Files:** Modify `main.js`; sidecar `activityLog[]`

- [ ] Read-only render: icon · action · actor · timestamp, newest-first (port `logHtml` + `LOG_ICON`).
- [ ] **ActivityLog writer**: a `logActivity(docPath, action, type)` helper that appends `{datetime, actor, action, type}` to the sidecar. Call it from: New version, status change (on metadata save), metadata edit, note add/edit/delete, definition (un)check, document create. **Phase 1 = plugin-originated only**; external-change entries are Phase 3 (audit).
- [ ] Deploy + smoke; commit — `feat(doc-container): activity Log tab + writer (plugin-originated)`

---

## Task 28: Left tab — Definitions (glossary checkbox table)

**Files:** Modify `main.js`; new settings `glossaryRoot` (default `Definitions/`); sidecar `definitions[]` (included term ids)

- [ ] **Glossary scan**: read entries from the `glossaryRoot` folder (each note/entry = term/criterion + text + type). Build `{id, term, type, text}` list.
- [ ] **Definitions pane**: a filter box + a **read-only table** (Incl. checkbox · Term/Criterion + type pill · Definition). Checkbox reflects membership in sidecar `definitions`; `toggleDef` adds/removes the term id. **No add/delete rows.** Filter matches term + text + type (comma-AND).
- [ ] Settings: add `glossaryRoot` path field.
- [ ] (Deferred / parking lot) document-level "Insert/refresh Definitions section into the .docx" — NOT in this task.
- [ ] Deploy + smoke; commit — `feat(doc-container): Definitions checkbox table over vault glossary`

---

## Task 29: Re-smoke (fold into Tasks 12–13)

- [ ] Desktop + iPad: all left tabs (Files&Versions / Stakeholders+Title / Related Documents links+refs / Definitions checkbox-table) and right tabs (Recent Notes composer + gated attach / Search Notes filters / Log feed) render and operate; footer stays pinned; note-tags stay out of the document `tags`; `node --test` green incl. `extractInlineTags`.

---

## Self-Review notes (author)

- **Spec coverage:** scaffolding (T6), sidebar leaf + tree (T7), main detail + reused leaf (T8), filename-convention versioning (T1–T3), metadata schema incl. reserved fields (T4, T8), actions (T9), settings (T5), live refresh + onLayoutReady ordering (T10), styles (T11), desktop+iPad smoke (T12–T13). Flexible-depth Document detection = T3. Folder-level metadata deliberately stubbed (Phase 2) per spec §9.
- **Deploy reminder:** every view-task smoke step must copy `lib/doc-container.js` alongside `main.js` (first time the plugin ships a local `require`). Confirm `lib/` is included by the deploy copy.
- **Method-name reconciliation (T9):** `_openInView` / `openSidecarMetadata` are placeholders for the actual existing P21 method names — the executor must grep and match, with a direct-routing fallback provided.
- **UI is the fine-tuning surface:** markup/CSS live in `render()`/`renderNode()`/`renderDetail()` + Task 11; visual changes won't alter the task structure.
- **Additions coverage (Tasks 14–20):** lifecycle next-review/overdue (T14), status rollup (T15), next-version name (T16) — all unit-tested; ContainerOverviewView by kind + New Category/Collection folder creation + collection search (T17); sidebar tree filter (T18); New version action (T19); re-smoke (T20). Amendments wire lifecycle fields into the schema (T4) + detail (T8), and switch container label-click to open the overview (T7).
- **Shared main-area leaf:** the container overview and document detail reuse one main-area leaf (re-typed via `setViewState`); openers prefer an existing `VIEW_TYPE_DOC_CONTAINER`/`VIEW_TYPE_DOC_DETAIL` leaf before opening a new tab — avoids tab stacking across drill-down.
- **Phase 1B (Tasks 21–29):** evolved detail view — extractInlineTags (unit-tested); detail shell (scroll body + sticky footer + two scoped tab columns); Files&Versions + Stakeholders(Title); Related Documents (links + drag-drop refs); Recent Notes (structured `noteLog`, inline-tag composer, gated `_notes/` attach, **note-tags separate from doc `tags`**); Search Notes (text+tag+date-range); Log (`activityLog` + writer, plugin-originated); Definitions (glossary scan + checkbox table, sidecar `definitions`). Canonical render reference = the `document-detail-v4.html` prototype. Deferred: Definitions insert-into-.docx, activity-log external detection (Phase 3). Schema sub-structures: spec §6.3.
