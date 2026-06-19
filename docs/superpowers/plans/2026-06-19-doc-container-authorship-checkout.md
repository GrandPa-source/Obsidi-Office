# Doc-Container Authorship + Check-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-user authorship attribution (a `log.md` per document, author-stamped through one identity seam) and EDMS-style advisory check-out (single `checkedOutBy` field, Sync-arbitrated, read-only editor gating, kick→save-a-copy as a tracked outlier fork) to the Obsidi-Office doc-container.

**Architecture:** Pure logic lands in the CommonJS core (`lib/doc-container.js`, unit-tested with `node:test`) and is inlined into `main.js` via `scripts/inline-doc-container.js`. Runtime wiring (helpers, view edits, editor gating, listeners) lives in `main.js`. The document **folder** is the anchor: `log.md` and the `_forks/` folder live beside the version files; the lock field lives in `_document.md` when present, else the current-version sidecar (`lockTargetFile()` fallback).

**Tech Stack:** Obsidian plugin API (vanilla JS, no TS build for this file), `node:test` for the pure core, `processFrontMatter`/`vault.append`/`vault.createBinary` for writes.

## Global Constraints

- **iPad is a hard requirement.** No `fs`/`path`/`os` on mobile code paths — use the vault API (`vault.append`, `vault.create`, `vault.createBinary`, `vault.adapter`) and gate desktop-only code behind the existing `isMobile` global. `resolveAuthor()` already handles the mobile fallback.
- **Pure core is CommonJS** (`module.exports = {...}`). After ANY edit to `lib/doc-container.js`: run `node lib/doc-container.test.js` (must stay green) AND `node scripts/inline-doc-container.js` then `node --check main.js`.
- **All new UI is behind the existing `docBrowserEnabled` setting** (default `false`).
- **Own-keys-only writes.** Every frontmatter write uses `processFrontMatter` and touches only its own keys (the 2026-06-16 data-loss lesson). Never re-emit whole YAML.
- **Fire-and-forget logging.** `appendLog` never blocks autosave or a save round-trip; it swallows its own errors.
- **No emojis** in code/UI copy. Icons are Lucide via the existing `docIcon()` helper.
- **License: AGPL-3.0.** No new bundled deps.
- **Deploy:** OB_Testing only; `main.js` deploy must be byte-identical to source after inlining.

## Prerequisite & integration note (read first)

The base `_document.md` **apply** (migration "Rung B" from `2026-06-17-doc-container-document-md-metadata-migration-design.md`) is **not built yet** — only Rung A (dry-run + `planReconcile`) exists. This plan does **not** depend on it:

- The lock read/write goes through `lockTargetFile(node)` (Task 9), which prefers `_document.md` and falls back to the current-version sidecar. Check-out therefore works today on the sidecar model and automatically moves to `_document.md` once the apply exists.
- `log.md` lives in the document folder regardless of `_document.md`.

**Gated on the apply (NOT in this plan, documented so it isn't lost):** seeding an empty `## Tasks` section in the `_document.md`/`_project.md` scaffolder is a one-line addition to the apply's folder-note creation when that code is written; and the Rung D task-list feature (Tasks tab + cross-doc rollup). Add the seed task to the migration apply plan.

---

## File Structure

- `lib/doc-container.js` — **modify**: add pure helpers `slugifyAuthor`, `formatLogEntry`, `parseLogBody`, `forkFileName`, `isPendingFork`, `lockStateFromFront`; export them.
- `lib/doc-container.test.js` — **modify**: add tests for each new pure helper.
- `main.js` — **modify**: identity seam, `appendLog` + log redirect, log-pane reads, CSS hides, check-out helpers + UI + editor gating + kick listener, fork-save + reconcile UI, two new settings.
- `scripts/inline-doc-container.js` — **run** (not edited) after each lib change.

---

## Phase 1 — Identity seam

### Task 1: Pure-core `slugifyAuthor`

**Files:**
- Modify: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

**Interfaces:**
- Produces: `slugifyAuthor(name: string) -> string` — filename-safe lowercase slug; empty/garbage → `'unknown'`.

- [ ] **Step 1: Write the failing test** (append to `lib/doc-container.test.js`)

```javascript
test('slugifyAuthor: lowercases and dash-joins, strips junk', () => {
  assert.strictEqual(dc.slugifyAuthor('Jane Smith'), 'jane-smith');
  assert.strictEqual(dc.slugifyAuthor('PAUL.C'), 'paul-c');
  assert.strictEqual(dc.slugifyAuthor('  --weird__name!! '), 'weird-name');
  assert.strictEqual(dc.slugifyAuthor(''), 'unknown');
  assert.strictEqual(dc.slugifyAuthor(null), 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/doc-container.test.js`
Expected: FAIL — `dc.slugifyAuthor is not a function`

- [ ] **Step 3: Implement** (add to `lib/doc-container.js` before `module.exports`)

```javascript
function slugifyAuthor(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}
```

Add `slugifyAuthor` to the `module.exports = { ... }` object.

- [ ] **Step 4: Run tests + inline + syntax check**

Run: `node lib/doc-container.test.js` → Expected: all PASS (35 tests)
Run: `node scripts/inline-doc-container.js` → Expected: writes main.js
Run: `node --check main.js` → Expected: no output (valid)

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure-core slugifyAuthor"
```

### Task 2: Runtime `resolveAuthor()` seam + mobile author-label setting

**Files:**
- Modify: `main.js` — `getUsername()` (≈1986), `DEFAULT_SETTINGS` (916–953), settings tab, plugin `onload`.

**Interfaces:**
- Consumes: `docContainer.slugifyAuthor` (Task 1).
- Produces: free fns `resolveAuthor() -> {id, display}` and `resolveAuthorId() -> string`. `getUsername()` keeps returning the **display** string (unchanged contract for existing `actor:` call sites — do NOT touch them).

- [ ] **Step 1: Add the `authorLabel` setting**

In `DEFAULT_SETTINGS` (main.js:916–953) add:
```javascript
authorLabel: '',   // mobile author display name (no system user on mobile)
checkoutTimeoutHours: 0,  // 0 = no stale-lock timeout
```

- [ ] **Step 2: Stash a settings ref + enhance `getUsername()`**

Near the top-level (module scope, before `getUsername`), add:
```javascript
let DC_SETTINGS = null;   // set in onload so getUsername can read authorLabel on mobile
```
In `onload()` after settings load, add: `DC_SETTINGS = this.settings;`

Replace the body of `getUsername()` (main.js:1986) with:
```javascript
function getUsername() {
  // P01_WhiteList seam (plugin not yet built): when present, prefer its identity here.
  if (!isMobile) {
    try { return require("os").userInfo().username; } catch (e) {}
  }
  return (DC_SETTINGS && DC_SETTINGS.authorLabel) || "Mobile User";
}
function resolveAuthor() { const display = getUsername(); return { id: docContainer.slugifyAuthor(display), display: display }; }
function resolveAuthorId() { return docContainer.slugifyAuthor(getUsername()); }
```

- [ ] **Step 3: Add the settings UI field**

In the settings tab `display()` (find the doc-container settings block near `docRoot` rendering), add a text setting bound to `authorLabel`:
```javascript
new obsidian.Setting(containerEl)
  .setName('Author label (mobile)')
  .setDesc('Display name used for authorship on mobile, where there is no system user.')
  .addText(t => t.setValue(this.plugin.settings.authorLabel || '')
    .onChange(async v => { this.plugin.settings.authorLabel = v.trim(); await this.plugin.saveSettings(); }));
```

- [ ] **Step 4: Inline + syntax check**

Run: `node scripts/inline-doc-container.js` (no lib change here, but keep main.js in sync) — actually skip; only run `node --check main.js` → Expected: valid.

- [ ] **Step 5: Manual smoke**

Deploy main.js to OB_Testing. Reload. In the console: confirm no error on load. Set an Author label in settings; on desktop `resolveAuthor()` returns `{id, display}` from the OS username (verify via a temp `console.log` if needed, then remove).

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): resolveAuthor() identity seam + mobile authorLabel setting"
```

---

## Phase 2 — `log.md` substrate

### Task 3: Pure-core log entry format + parse

**Files:**
- Modify: `lib/doc-container.js`, `lib/doc-container.test.js`

**Interfaces:**
- Produces:
  - `formatLogEntry({datetime, actor, action, detail}) -> string` (one markdown list line)
  - `parseLogBody(text: string) -> Array<{datetime, actor, action}>` (file order, oldest-first)

- [ ] **Step 1: Write the failing tests**

```javascript
test('formatLogEntry: builds a parseable markdown line, optional detail in parens', () => {
  assert.strictEqual(
    dc.formatLogEntry({ datetime: '2026-06-19 14:30', actor: 'jsmith', action: 'checked out' }),
    '- 2026-06-19 14:30 · jsmith · checked out');
  assert.strictEqual(
    dc.formatLogEntry({ datetime: '2026-06-19 15:20', actor: 'paul', action: 'fork saved', detail: 'base FanOutPolicy_V2.0.docx' }),
    '- 2026-06-19 15:20 · paul · fork saved (base FanOutPolicy_V2.0.docx)');
});

test('parseLogBody: round-trips formatted lines, ignores non-entry lines', () => {
  const body = [
    '---', 'docContainer: log', '---', '# Activity log', '',
    '- 2026-06-19 14:30 · jsmith · checked out',
    '- 2026-06-19 15:20 · paul · fork saved (base X_V2.0.docx)',
  ].join('\n');
  assert.deepStrictEqual(dc.parseLogBody(body), [
    { datetime: '2026-06-19 14:30', actor: 'jsmith', action: 'checked out' },
    { datetime: '2026-06-19 15:20', actor: 'paul', action: 'fork saved (base X_V2.0.docx)' },
  ]);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node lib/doc-container.test.js` → Expected: FAIL (functions not defined)

- [ ] **Step 3: Implement** (add to `lib/doc-container.js`)

```javascript
function formatLogEntry(e) {
  const dt = (e && e.datetime) || '';
  const actor = (e && e.actor) || '';
  const action = (e && e.action) || '';
  const detail = e && e.detail ? ' (' + e.detail + ')' : '';
  return '- ' + dt + ' · ' + actor + ' · ' + action + detail;
}
function parseLogBody(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^- (.+?) · (.+?) · (.+)$/.exec(line);
    if (m) out.push({ datetime: m[1], actor: m[2], action: m[3] });
  }
  return out;
}
```

Add both to `module.exports`.

- [ ] **Step 4: Tests + inline + check**

Run: `node lib/doc-container.test.js` → PASS (37 tests)
Run: `node scripts/inline-doc-container.js` && `node --check main.js` → valid

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure-core formatLogEntry + parseLogBody"
```

### Task 4: Runtime `appendLog` helper

**Files:**
- Modify: `main.js` — add `LOG_MD_NAME` const + `appendLog` plugin method (near `logActivity` ≈6819).

**Interfaces:**
- Consumes: `docContainer.formatLogEntry`, `getUsername` (display), `resolveAuthor`.
- Produces: `async appendLog(folderPath: string, action: string, detail?: string) -> void` — appends one entry to `<folderPath>/log.md`, creating it (with the `docContainer: log` header) if missing. Never throws.

- [ ] **Step 1: Implement**

Add a const near the other doc-container constants in main.js:
```javascript
const LOG_MD_NAME = 'log.md';
```

Add this plugin method next to `logActivity`:
```javascript
async appendLog(folderPath, action, detail) {
  try {
    const path = folderPath.replace(/\/+$/, '') + '/' + LOG_MD_NAME;
    const datetime = window.moment ? window.moment().format('YYYY-MM-DD HH:mm')
                                   : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = docContainer.formatLogEntry({ datetime, actor: getUsername(), action, detail });
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      const header = '---\ndocContainer: log\n---\n# Activity log\n\n';
      await this.app.vault.create(path, header + line + '\n');
    } else {
      await this.app.vault.append(existing, line + '\n');
    }
  } catch (e) { /* fire-and-forget */ }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js` → valid

- [ ] **Step 3: Manual smoke**

Deploy. With docBrowser on, open a doc-container document folder, run (temporarily via console) `app.plugins.getPlugin('obsidi-office').appendLog('<folder path>','checked out')`. Confirm `log.md` appears in the folder with the header + one line.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): appendLog helper writing per-document log.md"
```

### Task 5: Redirect existing log emit points to `appendLog`

**Files:**
- Modify: `main.js` — `_mutateSidecar` (3419), `logActivity` (6819), `_appendActivity` (6836), `createDocumentInContainer` (6705, the create entry), the editor edit-log path (≈2369/5177).

**Interfaces:**
- Consumes: `appendLog` (Task 4).

- [ ] **Step 1: `_mutateSidecar` (3419) — route its log to appendLog**

Currently, when `log` is provided it pushes `{datetime,actor,action,type}` onto `front.activityLog` inside the `processFrontMatter`. Change it to write metadata only, then fire `appendLog` separately. Replace the in-front log push with:
```javascript
// (inside _mutateSidecar, after the processFrontMatter that applies applyFn)
if (log && log.action) { this.plugin.appendLog(this.node.path, log.action, log.detail); }
```
Remove the `front.activityLog` push lines from the `processFrontMatter` callback.

- [ ] **Step 2: `logActivity` (6819) — replace body**

```javascript
async logActivity(node, action, type) {
  return this.appendLog(node.path, action);
}
```
(`type` arg kept for call-site compatibility; ignored — icon is derived from action text in Task 6.)

- [ ] **Step 3: `_appendActivity` (6836) — replace body**

```javascript
async _appendActivity(officePath, action, type) {
  const folder = officePath.slice(0, officePath.lastIndexOf('/'));
  return this.appendLog(folder, action);
}
```

- [ ] **Step 4: `createDocumentInContainer` (6705) — replace the create log**

Where it pushes the `'Document created'` activityLog entry into the sidecar, replace with an `appendLog` after the folder/file are created:
```javascript
this.appendLog(folder.path, 'created');
```
(`folder` = the document folder TFolder created earlier in the function. Keep the sidecar seed of `title`/`status`/`originationDate`; only the log entry moves out.)

- [ ] **Step 5: Editor edit-log path (≈2369/5177) — route to appendLog**

Where the autosave path checks `_editLoggedPaths` and logs `'Document edited'`, replace the sidecar append with:
```javascript
const folder = filePath.slice(0, filePath.lastIndexOf('/'));
this.plugin.appendLog(folder, 'edited');
```

- [ ] **Step 6: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Create a document via New Document, open + edit + save, create a new version. Confirm a single `log.md` accrues `created` / `edited` / `Version … created` lines; confirm sidecars no longer grow an `activityLog` array.

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): redirect all activity logging to log.md"
```

### Task 6: Log panes read `log.md` (with legacy fallback) + icon-by-action

**Files:**
- Modify: `main.js` — `_renderLogPane` (3735), `_projLogPane` (4187).

**Interfaces:**
- Consumes: `docContainer.parseLogBody`.

- [ ] **Step 1: Add an icon-by-action helper + rewrite `_renderLogPane`**

Replace `_renderLogPane(p, fm)` (3735) with a version that reads `log.md` from the document folder, falling back to legacy `fm.activityLog`:
```javascript
_logIcon(action) {
  const a = String(action || '').toLowerCase();
  if (a.includes('creat')) return 'plus';
  if (a.includes('version')) return 'file-plus';
  if (a.startsWith('status')) return 'refresh-cw';
  if (a.includes('fork')) return 'git-branch';
  if (a.includes('reconcil')) return 'check';
  if (a.includes('check out') || a.includes('checked out')) return 'lock';
  if (a.includes('check in') || a.includes('checked in')) return 'unlock';
  if (a.includes('open')) return 'eye';
  if (a.includes('edit')) return 'pencil';
  return 'circle';
}
async _renderLogPane(p, fm) {
  p.createDiv({ cls: 'doc-detail-noteshint', text: 'System activity — read-only. Notes are your commentary; the Log records actions on the document.' });
  const list = p.createDiv('doc-detail-loglist');
  let entries = [];
  const logPath = this.node.path + '/' + 'log.md';
  const lf = this.app.vault.getAbstractFileByPath(logPath);
  if (lf) {
    const body = await this.app.vault.cachedRead(lf);
    entries = docContainer.parseLogBody(body);   // oldest-first
    entries.reverse();                            // newest-first for display
  } else if (Array.isArray(fm.activityLog)) {
    entries = fm.activityLog.slice().sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  }
  if (!entries.length) { list.createDiv({ cls: 'doc-detail-stub', text: 'No activity recorded yet.' }); return; }
  for (const l of entries) {
    const row = list.createDiv('doc-detail-logrow');
    docIcon(row, this._logIcon(l.action), 'doc-detail-logico');
    const main = row.createDiv();
    main.createDiv({ text: l.action || '', cls: 'doc-detail-logaction' });
    main.createDiv({ text: (l.actor || '') + ' · ' + (l.datetime || ''), cls: 'doc-detail-logmeta' });
  }
}
```
NOTE: `_renderLogPane` is now `async`. Confirm its caller (the tab `fill:` callback) does not assume a sync return — the tab pane renders into `p`; async fill is fine because it appends to `p` when ready. If the `_tabGroup` builder awaits fill, leave as is; if not, the pane simply populates a tick later (acceptable).

- [ ] **Step 2: Mirror for `_projLogPane` (4187)**

Apply the same log.md-first read against the project folder (`node.path + '/log.md'`), same fallback to the passed `log` array, same `_logIcon`.

- [ ] **Step 3: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Open a document with a `log.md` → entries render newest-first with correct icons. Open a legacy doc whose sidecar still has `activityLog` and no `log.md` → legacy entries still render (fallback).

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): Log panes read log.md with legacy activityLog fallback"
```

### Task 7: CSS-hide `log.md`, `_document.md`, `_forks/`

**Files:**
- Modify: `main.js` — `_injectSidecarCSS` (6393–6407).

- [ ] **Step 1: Extend the selector string**

In `_injectSidecarCSS`, extend `style.textContent` to also hide the new artifacts:
```javascript
style.textContent =
  '.nav-file-title[data-path$=".docx.md"], ' +
  '.nav-file-title[data-path$=".pptx.md"], ' +
  '.nav-file-title[data-path$=".xlsx.md"], ' +
  '.nav-file-title[data-path$=".pdf.md"], ' +
  '.nav-file-title[data-path$="/log.md"], ' +
  '.nav-file-title[data-path$="/_document.md"], ' +
  '.nav-folder-title[data-path$="/_forks"] { display: none !important; }';
```

- [ ] **Step 2: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Confirm `log.md`, `_document.md`, and any `_forks` folder are hidden in the file explorer.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): hide log.md, _document.md, _forks from explorer"
```

---

## Phase 3 — Check-out

### Task 8: Pure-core `lockStateFromFront`

**Files:**
- Modify: `lib/doc-container.js`, `lib/doc-container.test.js`

**Interfaces:**
- Produces: `lockStateFromFront(front, nowISO, timeoutHours) -> {by: string|null, at: string|null, stale: boolean}`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('lockStateFromFront: reads lock fields, computes staleness against timeout', () => {
  assert.deepStrictEqual(dc.lockStateFromFront({}, '2026-06-19T15:00:00.000Z', 0),
    { by: null, at: null, stale: false });
  assert.deepStrictEqual(
    dc.lockStateFromFront({ checkedOutBy: 'jsmith', checkedOutAt: '2026-06-19T14:00:00.000Z' }, '2026-06-19T15:00:00.000Z', 0),
    { by: 'jsmith', at: '2026-06-19T14:00:00.000Z', stale: false });   // timeout 0 = never stale
  assert.strictEqual(
    dc.lockStateFromFront({ checkedOutBy: 'jsmith', checkedOutAt: '2026-06-19T10:00:00.000Z' }, '2026-06-19T15:00:00.000Z', 2).stale,
    true);   // 5h old, 2h timeout
});
```

- [ ] **Step 2: Run to verify fail** — `node lib/doc-container.test.js` → FAIL

- [ ] **Step 3: Implement**

```javascript
function lockStateFromFront(front, nowISO, timeoutHours) {
  const by = front && front.checkedOutBy ? String(front.checkedOutBy) : null;
  const at = front && front.checkedOutAt ? String(front.checkedOutAt) : null;
  let stale = false;
  if (by && at && timeoutHours > 0) {
    const age = Date.parse(nowISO) - Date.parse(at);
    stale = isFinite(age) && age > timeoutHours * 3600 * 1000;
  }
  return { by: by, at: at, stale: stale };
}
```
Add to `module.exports`.

- [ ] **Step 4: Tests + inline + check** — `node lib/doc-container.test.js` (38 tests PASS); `node scripts/inline-doc-container.js && node --check main.js`

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure-core lockStateFromFront"
```

### Task 9: Runtime lock helpers + `lockTargetFile` fallback

**Files:**
- Modify: `main.js` — add plugin methods near `readProjectNote` (6632).

**Interfaces:**
- Consumes: `docContainer.lockStateFromFront`, `resolveAuthorId`.
- Produces:
  - `lockTargetFile(node) -> TFile|null` — `<folder>/_document.md` if it exists, else `<folder>/<node.current>.md` (current-version sidecar).
  - `readLock(node) -> {by, at, stale}` (sync, via metadataCache).
  - `async setCheckout(node)` / `async clearCheckout(node, action)` — write/clear `checkedOutBy`/`checkedOutAt` via processFrontMatter + appendLog.

- [ ] **Step 1: Implement**

```javascript
lockTargetFile(node) {
  const dm = this.app.vault.getAbstractFileByPath(node.path + '/_document.md');
  if (dm) return dm;
  return this.app.vault.getAbstractFileByPath(node.path + '/' + node.current + '.md');
}
readLock(node) {
  const f = this.lockTargetFile(node);
  const fm = f ? (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {} : {};
  return docContainer.lockStateFromFront(fm, new Date().toISOString(), this.settings.checkoutTimeoutHours || 0);
}
async setCheckout(node) {
  const f = this.lockTargetFile(node);
  if (!f) return;
  const at = new Date().toISOString();
  await this.app.fileManager.processFrontMatter(f, (fm) => { fm.checkedOutBy = resolveAuthorId(); fm.checkedOutAt = at; });
  this.appendLog(node.path, 'checked out');
}
async clearCheckout(node, action) {
  const f = this.lockTargetFile(node);
  if (!f) return;
  await this.app.fileManager.processFrontMatter(f, (fm) => { delete fm.checkedOutBy; delete fm.checkedOutAt; });
  this.appendLog(node.path, action || 'checked in');
}
```

- [ ] **Step 2: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Via console on a document node: `setCheckout` writes `checkedOutBy`/`checkedOutAt` into the sidecar (or `_document.md` if present) and logs `checked out`; `readLock` reflects it; `clearCheckout` removes them.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): check-out lock helpers with _document.md/sidecar fallback"
```

### Task 10: Check out / Check in / Force check-in buttons + lock banner (detail page)

**Files:**
- Modify: `main.js` — `_renderH1Row` (3264–3276) and/or the metadata header region of `DocumentDetailView.render` (3249+).

**Interfaces:**
- Consumes: `readLock`, `setCheckout`, `clearCheckout`, `resolveAuthorId`.

- [ ] **Step 1: Render the lock control + banner**

In the detail header (after the existing Edit/Save/Cancel block in `_renderH1Row`), add:
```javascript
const lock = this.plugin.readLock(this.node);
const me = resolveAuthorId();
const lockBar = wrap.createDiv('doc-detail-lockbar');
if (!lock.by) {
  const b = lockBar.createEl('button', { text: 'Check out' });
  b.onclick = async () => { await this.plugin.setCheckout(this.node); this.render(); };
} else if (lock.by === me) {
  lockBar.createSpan({ cls: 'doc-detail-lockmine', text: 'You have this checked out.' });
  const b = lockBar.createEl('button', { text: 'Check in' });
  b.onclick = async () => { await this.plugin.clearCheckout(this.node, 'checked in'); this.render(); };
} else {
  lockBar.createSpan({ cls: 'doc-detail-lockother', text: 'Checked out by ' + lock.by + (lock.stale ? ' (stale)' : '') });
  const b = lockBar.createEl('button', { text: 'Force check-in' });
  b.onclick = async () => {
    if (!confirm('Force check-in will release ' + lock.by + "'s lock. Continue?")) return;
    await this.plugin.clearCheckout(this.node, 'force check-in'); this.render();
  };
}
```

- [ ] **Step 2: Add minimal CSS** (in the plugin's stylesheet / injected styles block — match how existing `.doc-detail-*` classes are styled): `.doc-detail-lockother { color: var(--text-error); } .doc-detail-lockmine { color: var(--text-success); }`. (If styles live in `styles.css`, add there; if injected, add to that block.)

- [ ] **Step 3: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. On a document: Check out → banner shows "You have this checked out" + Check in; reload → state persists (read from frontmatter). Simulate another user by setting `authorLabel` to a different value (mobile) or editing `checkedOutBy` by hand → banner shows "Checked out by …" + Force check-in.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): check-out/in + force-check-in controls + lock banner"
```

### Task 11: Editor read-only gating

**Files:**
- Modify: `main.js` — `_buildEditorConfig` (2894–3000), specifically `mode` (2918) and `permissions` (2910–2913); add helper `_isLockedByOther(file)`.

**Interfaces:**
- Consumes: `docContainer.lockStateFromFront`, `resolveAuthorId`, `lockTargetFile`-equivalent for an open file.

- [ ] **Step 1: Add a sync lock check for an open office file**

Add to `OfficeEditorView` (or as a plugin method called with `this.plugin`):
```javascript
_isLockedByOther(file) {
  // file = the open office TFile; its document folder is file.parent
  const folder = file.path.slice(0, file.path.lastIndexOf('/'));
  const dm = this.app.vault.getAbstractFileByPath(folder + '/_document.md');
  const sc = this.app.vault.getAbstractFileByPath(file.path + '.md');
  const lf = dm || sc;
  if (!lf) return false;
  const fm = (this.app.metadataCache.getFileCache(lf) || {}).frontmatter || {};
  const st = docContainer.lockStateFromFront(fm, new Date().toISOString(), this.plugin.settings.checkoutTimeoutHours || 0);
  return !!st.by && st.by !== resolveAuthorId();
}
```

- [ ] **Step 2: Gate mode + permissions in `_buildEditorConfig`**

Compute once near the top of `_buildEditorConfig`:
```javascript
const lockedOut = this.plugin.settings.docBrowserEnabled && this._isLockedByOther(this.file);
```
Change line 2918 to: `mode: lockedOut ? "view" : this.plugin.settings.defaultMode,`
Change the permissions object (2910–2913) `edit` to: `edit: !lockedOut,` and `comment: !lockedOut,`.

- [ ] **Step 3: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Check out a doc as "other" (hand-edit `checkedOutBy` to a different slug). Open it in the editor → it opens read-only (no edit). Clear the lock → reopen → editable.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): editor opens read-only when checked out by another author"
```

### Task 12: Race/kick listener (enforce on open editors)

**Files:**
- Modify: `main.js` — the `onLayoutReady` `metadataCache.on('changed')` handler (5494) + add `_enforceCheckoutOnOpenEditors()`.

**Interfaces:**
- Consumes: `_isLockedByOther` (Task 11), the fork-save flow (Task 14 — wire the prompt here; until Task 14 lands, the modal's "Save a copy" calls a stub that Task 14 fills).

- [ ] **Step 1: Add the enforcement sweep**

```javascript
_enforceCheckoutOnOpenEditors() {
  if (!this.settings.docBrowserEnabled) return;
  this.app.workspace.getLeavesOfType('obsidi-office-docx').concat(
    this.app.workspace.getLeavesOfType('obsidi-office-pptx'),
    this.app.workspace.getLeavesOfType('obsidi-office-xlsx'),
    this.app.workspace.getLeavesOfType('obsidi-office-pdf')
  ).forEach((leaf) => {
    const view = leaf.view;
    if (!view || !view.file || typeof view._isLockedByOther !== 'function') return;
    if (view._kicked) return;
    if (view._isLockedByOther(view.file)) {
      view._kicked = true;
      this._promptKick(view);
    }
  });
}
```
(Use the actual registered view-type strings from `registerView` — confirm them; the report cites `obsidi-office-docx`. Verify the other three at their `VIEW_TYPE_*` consts and substitute exactly.)

- [ ] **Step 2: Add `_promptKick(view)`**

```javascript
_promptKick(view) {
  const file = view.file;
  const modal = new obsidian.Modal(this.app);
  modal.titleEl.setText('Released from edit');
  modal.contentEl.createEl('p', { text: 'This document was checked out by another author. Your session is now read-only. Save your in-progress changes as a copy to reconcile later?' });
  const row = modal.contentEl.createDiv();
  const save = row.createEl('button', { text: 'Save a copy', cls: 'mod-cta' });
  save.onclick = async () => { modal.close(); await this.saveForkCopy(view); };
  const cancel = row.createEl('button', { text: 'Discard / keep read-only' });
  cancel.onclick = () => { modal.close(); };
  modal.open();
  // drop the live editor to read-only by reloading it (config now computes view mode)
  view._suppressEditLogReset = true;
  view.onLoadFile(file);
}
```

- [ ] **Step 3: Call the sweep from the metadataCache listener**

In the `onLayoutReady` `metadataCache.on('changed', ...)` handler (5494), after the existing `refreshIfManaged(...)` call, add:
```javascript
this._enforceCheckoutOnOpenEditors();
```

- [ ] **Step 4: Add a temporary `saveForkCopy` stub** (replaced in Task 14) so this compiles:
```javascript
async saveForkCopy(view) { new obsidian.Notice('Fork save not yet implemented'); }
```

- [ ] **Step 5: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Open a doc as editable; on a second device (or by hand-editing the lock file to another slug, which fires `metadataCache changed`), confirm the open editor surfaces the kick modal and drops to read-only.

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): kick open editors to read-only when lock changes to another author"
```

---

## Phase 4 — Fork on kick + reconciliation

### Task 13: Pure-core `forkFileName` + `isPendingFork`

**Files:**
- Modify: `lib/doc-container.js`, `lib/doc-container.test.js`

**Interfaces:**
- Produces:
  - `forkFileName(currentVersionName, authorSlug, dateStr) -> string` (e.g. `FanOutPolicy_fork_paul_20260619.docx`)
  - `isPendingFork(front) -> boolean` (`front.forkOf` set and not reconciled)

- [ ] **Step 1: Write the failing tests**

```javascript
test('forkFileName: base_fork_<slug>_<date>.<ext>, strips version', () => {
  assert.strictEqual(dc.forkFileName('FanOutPolicy_V2.0.docx', 'paul', '20260619'),
    'FanOutPolicy_fork_paul_20260619.docx');
  assert.strictEqual(dc.forkFileName('Plan.pptx', 'jsmith', '20260101'),
    'Plan_fork_jsmith_20260101.pptx');
});

test('isPendingFork: true only when forkOf set and not reconciled', () => {
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a', reconciled: false }), true);
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a' }), true);          // missing = pending
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a', reconciled: true }), false);
  assert.strictEqual(dc.isPendingFork({}), false);
});
```

- [ ] **Step 2: Run to verify fail** — `node lib/doc-container.test.js` → FAIL

- [ ] **Step 3: Implement**

```javascript
function forkFileName(currentVersionName, authorSlug, dateStr) {
  const v = parseVersion(currentVersionName);
  return v.base + '_fork_' + authorSlug + '_' + dateStr + '.' + v.ext;
}
function isPendingFork(front) {
  return !!(front && front.forkOf) && front.reconciled !== true;
}
```
Add both to `module.exports`.

- [ ] **Step 4: Tests + inline + check** — `node lib/doc-container.test.js` (40 tests PASS); `node scripts/inline-doc-container.js && node --check main.js`

- [ ] **Step 5: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(doc-container): pure-core forkFileName + isPendingFork"
```

### Task 14: Fork-save flow (replaces the Task-12 stub)

**Files:**
- Modify: `main.js` — replace the `saveForkCopy` stub.

**Interfaces:**
- Consumes: `docContainer.forkFileName`, `resolveAuthor`, the open view's in-editor bytes.

- [ ] **Step 1: Implement `saveForkCopy(view)`**

```javascript
async saveForkCopy(view) {
  try {
    const file = view.file;
    const folder = file.path.slice(0, file.path.lastIndexOf('/'));
    const currentName = file.path.slice(file.path.lastIndexOf('/') + 1);
    const author = resolveAuthor();
    const dateStr = (window.moment ? window.moment().format('YYYYMMDD') : new Date().toISOString().slice(0,10).replace(/-/g,''));
    const forkName = docContainer.forkFileName(currentName, author.id, dateStr);
    const forksDir = folder + '/_forks';
    if (!this.app.vault.getAbstractFileByPath(forksDir)) await this.app.vault.createFolder(forksDir);
    const forkPath = forksDir + '/' + forkName;
    // capture current in-editor bytes via the existing save-capture path; fallback to on-disk bytes
    const bytes = (typeof view.captureCurrentBytes === 'function')
      ? await view.captureCurrentBytes()
      : await this.app.vault.readBinary(file);
    await this.app.vault.createBinary(forkPath, bytes);
    const scPath = forkPath + '.md';
    await this.app.vault.create(scPath, '---\n---\n');
    const sc = this.app.vault.getAbstractFileByPath(scPath);
    await this.app.fileManager.processFrontMatter(sc, (fm) => {
      fm.docx = '[[' + forkName + ']]';
      fm.forkOf = this._docIdForFolder(folder) || '';
      fm.forkBaseVersion = currentName;
      fm.forkAuthor = author.id;
      fm.forkAt = new Date().toISOString();
      fm.forkReason = 'checkout-conflict';
      fm.reconciled = false;
    });
    this.appendLog(folder, 'fork saved', 'base ' + currentName);
    new obsidian.Notice('Saved your changes as a fork copy for later reconciliation.');
  } catch (e) { new obsidian.Notice('Could not save fork copy: ' + e.message); }
}
_docIdForFolder(folder) {
  const dm = this.app.vault.getAbstractFileByPath(folder + '/_document.md');
  if (!dm) return null;
  return ((this.app.metadataCache.getFileCache(dm) || {}).frontmatter || {}).docId || null;
}
```
NOTE on `captureCurrentBytes`: if no such method exists on the editor view, the fallback reads the on-disk bytes (which, post-kick read-only, are the last-saved state — acceptable for a first cut; capturing unsaved in-editor bytes is a refinement to wire to the existing save/`asc_DownloadAs` capture path if/when needed). Document this in the commit.

- [ ] **Step 2: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. Trigger a kick (Task 12) with the editor open, click "Save a copy" → confirm `_forks/<base>_fork_<slug>_<date>.<ext>` + its sidecar appear with the fork fields and `reconciled: false`, and `log.md` gains a `fork saved (base …)` line.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): save kicked edits as a tracked outlier fork in _forks/"
```

### Task 15: Pending-reconciliation section + Mark reconciled

**Files:**
- Modify: `main.js` — `DocumentDetailView` left-column tab specs (3287–3292) and a new `_renderPendingPane`.

**Interfaces:**
- Consumes: `docContainer.isPendingFork`.

- [ ] **Step 1: Add a "Reconcile" tab when pending forks exist**

In the left-column tab specs, conditionally add a tab. First compute the pending list (scan the document folder's `_forks` sidecars via metadataCache):
```javascript
_pendingForks() {
  const out = [];
  const dir = this.node.path + '/_forks';
  const folder = this.app.vault.getAbstractFileByPath(dir);
  if (!folder || !folder.children) return out;
  for (const child of folder.children) {
    if (!child.path.endsWith('.md')) continue;
    const fm = (this.app.metadataCache.getFileCache(child) || {}).frontmatter || {};
    if (docContainer.isPendingFork(fm)) out.push({ scPath: child.path, fork: child.path.replace(/\.md$/, ''), fm });
  }
  return out;
}
```
Add to the left specs array (3287–3292):
```javascript
const pending = this._pendingForks();
// ...existing specs..., then:
...(pending.length ? [{ id: 'reconcile', label: 'Reconcile', count: pending.length,
  fill: (p) => this._renderPendingPane(p, pending) }] : []),
```

- [ ] **Step 2: Implement `_renderPendingPane`**

```javascript
_renderPendingPane(p, pending) {
  p.createDiv({ cls: 'doc-detail-noteshint', text: 'Outlier copies saved from a check-out conflict. Reconcile by hand, then mark resolved.' });
  for (const item of pending) {
    const row = p.createDiv('doc-detail-pendrow');
    row.createDiv({ cls: 'doc-detail-pendtitle', text: (item.fm.forkAuthor || '?') + ' · diverged from ' + (item.fm.forkBaseVersion || '?') });
    const actions = row.createDiv('doc-detail-pendactions');
    const openFork = actions.createEl('button', { text: 'Open fork' });
    openFork.onclick = () => { const f = this.app.vault.getAbstractFileByPath(item.fork); if (f) this.app.workspace.getLeaf('tab').openFile(f); };
    const openCur = actions.createEl('button', { text: 'Open current' });
    openCur.onclick = () => { const f = this.app.vault.getAbstractFileByPath(this.node.path + '/' + this.node.current); if (f) this.app.workspace.getLeaf('tab').openFile(f); };
    const done = actions.createEl('button', { text: 'Mark reconciled', cls: 'mod-cta' });
    done.onclick = async () => {
      const sc = this.app.vault.getAbstractFileByPath(item.scPath);
      if (sc) await this.app.fileManager.processFrontMatter(sc, (fm) => { fm.reconciled = true; });
      this.plugin.appendLog(this.node.path, 'reconciled', item.fm.forkBaseVersion ? 'base ' + item.fm.forkBaseVersion : undefined);
      this.render();
    };
  }
}
```

- [ ] **Step 3: Syntax check + smoke**

Run: `node --check main.js` → valid. Deploy. With a pending fork present (from Task 14), the detail page shows a "Reconcile" tab with a count; rows offer Open fork / Open current / Mark reconciled; Mark reconciled flips `reconciled: true`, logs `reconciled`, and the tab disappears when none remain.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(doc-container): pending-reconciliation tab + mark reconciled"
```

---

## Phase 5 — Smoke gate (Paul, desktop + iPad)

Not a code task — the ship-gate. With `docBrowserEnabled` on, on the real `Documents/` corpus:

- [ ] Desktop: create a document → `log.md` gets `created`; edit+save → `edited`; new version → `Version … created`. Sidecars no longer grow `activityLog`.
- [ ] Desktop: Check out → banner + Check in; reload persists; editor read-only when checked out by another (hand-set slug); Force check-in works.
- [ ] Desktop: simulate a race (hand-edit lock to another slug while editor open) → kick modal → Save a copy → `_forks/` copy + sidecar + `fork saved` log; Reconcile tab → Mark reconciled.
- [ ] iPad: set Author label; create/edit a doc → `log.md` author shows the label; check out / check in; fork-save uses `createBinary` (no `fs`) and succeeds.
- [ ] Verify `log.md` / `_document.md` / `_forks` are hidden in the explorer on both.

---

## Deferred (documented, gated on the `_document.md` apply)

- **`## Tasks` body seed** in the `_document.md`/`_project.md` scaffolder — one line in the migration apply's folder-note creation. Add to the migration Rung B plan.
- **Rung D task-list feature** — Tasks tab over the seeded `## Tasks` section + project cross-doc open-task rollup + optional assignee via `resolveAuthor()`.

---

## Self-Review

**Spec coverage:**
- Log → single `log.md`, markdown body, author-stamped → Tasks 3–7. ✓
- `resolveAuthor()` seam (desktop/mobile/P01-later) → Tasks 1–2. ✓
- Check-out single `checkedOutBy` field, Sync-arbitrated, read-only gating, force-check-in + optional timeout → Tasks 8–12 (+ `checkoutTimeoutHours` setting in Task 2). ✓
- Kick → save-a-copy as outlier fork tied to `forkBaseVersion`; consolidate = surface + manual reconcile → Tasks 13–15. ✓
- `_document.md` lock fields → written via `lockTargetFile` (Task 9) with sidecar fallback (apply not yet built) — noted in Prerequisite. ✓
- CSS-hide log.md/_document.md/_forks → Task 7. ✓
- Task-list seed → deferred section (gated on apply), per spec which puts only the seed in Rung B and the feature in Rung D. ✓

**Placeholder scan:** No "TBD"/"handle edge cases". The one explicit deferral (capturing unsaved in-editor bytes in Task 14) states the concrete fallback (on-disk bytes) and is flagged in its commit — it is a stated design choice, not a placeholder.

**Type consistency:** `slugifyAuthor`, `formatLogEntry`, `parseLogBody`, `lockStateFromFront`, `forkFileName`, `isPendingFork` names match between lib definitions, exports, and main.js call sites. Lock fields `checkedOutBy`/`checkedOutAt` consistent across Tasks 8–12. Fork fields `forkOf`/`forkBaseVersion`/`forkAuthor`/`forkAt`/`forkReason`/`reconciled` consistent across Tasks 13–15. `appendLog(folderPath, action, detail?)` signature consistent across all callers.

**Open verification for the implementer:** confirm the exact registered editor view-type strings in `registerView` (Task 12 cites `obsidi-office-docx`; substitute the real `VIEW_TYPE_*` values for pptx/xlsx/pdf) and whether the editor view exposes a `captureCurrentBytes`-style method (Task 14 fallback covers its absence).
