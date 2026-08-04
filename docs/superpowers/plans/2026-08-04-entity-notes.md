# Entity Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Organization and Site records a quick-note composer and a single Recent Notes feed that gathers activity from the record, its sites, and the work attributed to it — each row labelled with where it came from.

**Architecture:** Merging, ordering and filtering are pure functions in `lib/doc-container.js` (Node-testable, no Obsidian). Source gathering and rendering live in `main.js`. All entity frontmatter writes go through the **existing** `writeEntityRecord` seam — no new write path.

**Tech Stack:** Plain JavaScript, no build step. `node --test` for pure-core tests.

**Spec:** `docs/superpowers/specs/2026-08-04-entity-notes-design.md`

## Global Constraints

- **`writeEntityRecord(folderPath, mutator)` is the ONLY write path for entity frontmatter.** It is documented in `main.js` as a Phase D encryption seam. Do NOT add a `writeEntityNote` or call `processFrontMatter` on an entity record directly — that would break the seam the encryption work depends on. The spec's §7 mention of a new `writeEntityNote` is **superseded by this constraint**.
- `readEntityRecord(folderPath)` is the matching read seam. Use it.
- Pure functions go in `lib/doc-container.js`; Obsidian/DOM code in `main.js`. Never the reverse.
- **After ANY edit to `lib/doc-container.js`, run `node scripts/inline-doc-container.js`** to regenerate the inlined copy in `main.js` between the `// <doc-container-core>` markers (currently lines 29–783). Hand-editing that region is a bug.
- **Optimistic render.** After `processFrontMatter`, `metadataCache` is stale until the re-parse `changed` event. Any repaint following a write must pass the new entry as an override. This bug class has recurred 3+ times in this codebase.
- **Live-derive writes.** Inside the mutator, derive `noteLog` from the callback's current `fm` — never assign a render-time snapshot.
- **Guard flags self-heal.** Any flag suppressing repaint needs a guaranteed clear path.
- Reuse existing idioms and classes: `doc-detail-composer`, `doc-detail-notelist`, `doc-detail-tabb`, `docIcon`, `dlog`/`elog`. No new dependencies, no build step, no TypeScript, no frameworks.
- Verification: `node --test lib/doc-container.test.js` and `node --check main.js`.
- Baseline: **104 tests passing.**

**Working directory:** `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office`
**Branch:** `org-sites`

## Existing shapes you will consume

```
entityReferences(path) -> {
  sites: [{ path, name, rec }],
  work:  [{ path, name, kind: 'project'|'document', title, docClass, status, nextReviewDate, stamp }],
  notes: [{ path, name, title, noteType, noteDate, rowType, parentTitle }],
}
```

`noteLog` entry shape (identical in document, project and now entity):
`{ date, author, body, noteTags: [], attachments: [] }`

Where each source's frontmatter lives:
- entity (self, sites) → `<folder>/<Name>.md`, read via `readEntityRecord(folder)`
- project → `<folder>/_project.md`
- document → `<folder>/` + `docContainer.DOCUMENT_MD_NAME`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/doc-container.js` | Pure core: merge, filter | Modify — 2 functions + exports |
| `lib/doc-container.test.js` | Pure-core tests | Modify — append ~14 tests |
| `main.js` | Source gathering, 3 panes, tab wiring, CSS | Modify |
| `main.js` lines 29–783 | Inlined pure core | **Generated** — never hand-edited |

---

### Task 1: Pure core — `mergeNoteFeed` and `filterNoteFeed`

**Files:** `lib/doc-container.js`, `lib/doc-container.test.js`

**Interfaces produced:**
- `mergeNoteFeed(sources)` → flat array, newest first. Input `[{origin, originKind, originPath, entries}]`.
  Each output row: `{origin, originKind, originPath, date, author, body, noteTags, attachments}`.
- `filterNoteFeed(rows, {text, from, to})` → filtered array.

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
// 2026-08-04: entity notes — merged feed
const FEED_SRC = [
  { origin: 'This organization', originKind: 'self', originPath: 'Documents/Organizations/Acme',
    entries: [{ date: '2026-08-01', author: 'paul', body: 'kickoff', noteTags: ['meeting'], attachments: [] }] },
  { origin: 'Terraces', originKind: 'site', originPath: 'Documents/Sites/Terraces',
    entries: [{ date: '2026-08-03', author: 'paul', body: 'site walk', noteTags: [], attachments: ['x.pdf'] }] },
  { origin: 'Fan-Out Policy', originKind: 'work', originPath: 'Documents/Governance/Fan-Out Policy',
    entries: [{ date: '2026-07-20', author: 'sam', body: 'reviewed', noteTags: [], attachments: [] }] },
];

test('mergeNoteFeed: newest first across sources', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.deepStrictEqual(r.map(x => x.date), ['2026-08-03', '2026-08-01', '2026-07-20']);
});

test('mergeNoteFeed: stamps origin on every row', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(r[0].origin, 'Terraces');
  assert.strictEqual(r[0].originKind, 'site');
  assert.strictEqual(r[0].originPath, 'Documents/Sites/Terraces');
  assert.ok(r.every(x => x.origin && x.originKind));
});

test('mergeNoteFeed: preserves entry fields', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(r[1].body, 'kickoff');
  assert.deepStrictEqual(r[1].noteTags, ['meeting']);
  assert.deepStrictEqual(r[0].attachments, ['x.pdf']);
});

test('mergeNoteFeed: ties break by origin name, so order is stable', () => {
  const same = [
    { origin: 'Zulu',  originKind: 'site', originPath: 'z', entries: [{ date: '2026-08-01', body: 'z' }] },
    { origin: 'Alpha', originKind: 'site', originPath: 'a', entries: [{ date: '2026-08-01', body: 'a' }] },
  ];
  assert.deepStrictEqual(dc.mergeNoteFeed(same).map(x => x.origin), ['Alpha', 'Zulu']);
  assert.deepStrictEqual(dc.mergeNoteFeed(same.slice().reverse()).map(x => x.origin), ['Alpha', 'Zulu']);
});

test('mergeNoteFeed: sources with no entries are skipped, never throw', () => {
  assert.deepStrictEqual(dc.mergeNoteFeed([]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed(null), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x', entries: null }]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x' }]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x', entries: 'nope' }]), []);
});

test('mergeNoteFeed: malformed entries do not throw and keep safe defaults', () => {
  const r = dc.mergeNoteFeed([{ origin: 'x', originKind: 'self', originPath: 'p',
    entries: [null, 'string', { body: 'no date' }] }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].body, 'no date');
  assert.strictEqual(r[0].date, '');
  assert.deepStrictEqual(r[0].noteTags, []);
});

test('filterNoteFeed: text matches body, author and tags, case-insensitively', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'SITE' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'sam' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'meeting' }).length, 1);
});

test('filterNoteFeed: all terms must match (AND), and # is ignored', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: '#meeting' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'kickoff meeting' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'kickoff nomatch' }).length, 0);
});

test('filterNoteFeed: date range is inclusive at both ends', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { from: '2026-08-01', to: '2026-08-03' }).length, 2);
  assert.strictEqual(dc.filterNoteFeed(rows, { from: '2026-08-03' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { to: '2026-07-20' }).length, 1);
});

test('filterNoteFeed: text and dates intersect', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'walk', from: '2026-08-02' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'walk', to: '2026-07-01' }).length, 0);
});

test('filterNoteFeed: empty criteria returns everything; bad input returns []', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, {}).length, 3);
  assert.strictEqual(dc.filterNoteFeed(rows).length, 3);
  assert.deepStrictEqual(dc.filterNoteFeed(null, { text: 'x' }), []);
});

test('filterNoteFeed: searching also matches the origin label', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'terraces' }).length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

`node --test lib/doc-container.test.js` → FAIL, `dc.mergeNoteFeed is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/doc-container.js` just above the `module.exports` block:

```js
// ── Entity notes: merged activity feed (spec 2026-08-04) ────────────────────
// A record's own notes, its sites' notes and notes on work attributed to it are
// one chronological story. These two functions are the whole of that logic, kept
// pure so the ordering rules are testable without a vault.

// sources: [{ origin, originKind, originPath, entries }] -> flat rows, newest first.
// Ties break by origin name so repaints are stable rather than depending on the
// order entityReferences happened to discover sources in.
function mergeNoteFeed(sources) {
  if (!Array.isArray(sources)) return [];
  const rows = [];
  for (const s of sources) {
    if (!s || !Array.isArray(s.entries)) continue;
    for (const e of s.entries) {
      if (!e || typeof e !== 'object') continue;
      rows.push({
        origin: s.origin || '',
        originKind: s.originKind || '',
        originPath: s.originPath || '',
        date: e.date || '',
        author: e.author || '',
        body: e.body || '',
        noteTags: Array.isArray(e.noteTags) ? e.noteTags : [],
        attachments: Array.isArray(e.attachments) ? e.attachments : [],
      });
    }
  }
  rows.sort((a, b) => {
    const d = String(b.date).localeCompare(String(a.date));
    return d !== 0 ? d : String(a.origin).localeCompare(String(b.origin));
  });
  return rows;
}

// Text terms are ANDed; `#` is stripped so "#meeting" and "meeting" behave the
// same, matching the document pane's search. Dates are inclusive at both ends.
function filterNoteFeed(rows, criteria) {
  if (!Array.isArray(rows)) return [];
  const c = criteria || {};
  const terms = String(c.text || '').toLowerCase().replace(/#/g, '').split(/\s+/).filter(Boolean);
  return rows.filter((n) => {
    const hay = ((n.date || '') + ' ' + (n.author || '') + ' ' + (n.body || '') + ' '
      + (n.origin || '') + ' ' + (n.noteTags || []).join(' ')).toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
    if (c.from && String(n.date) < c.from) return false;
    if (c.to && String(n.date) > c.to) return false;
    return true;
  });
}
```

Add `mergeNoteFeed,` and `filterNoteFeed,` to `module.exports`.

- [ ] **Step 4: Tests pass** — `node --test lib/doc-container.test.js` → 118 passing (104 + 14).
- [ ] **Step 5: Regenerate + check** — `node scripts/inline-doc-container.js` then `node --check main.js`. Confirm `function mergeNoteFeed` appears inside the generated block.
- [ ] **Step 6: Commit** — `feat(entities): pure merged note feed — ordering and filtering`

---

### Task 2: Gather the feed's sources

**Files:** `main.js` (`ContainerOverviewView`, next to `_entTabs`)

**Interfaces:** `_entNoteSources(node, type, refs)` → the `sources` array `mergeNoteFeed` consumes.

- [ ] **Step 1: Implement**

Add to `ContainerOverviewView`, directly above `_entTabs`:

```js
  // Assemble the Recent Notes feed's sources (spec §5.1). Adds no traversal —
  // sites and work are already discovered by entityReferences; this only reads
  // each one's noteLog. Note pages contribute one row each, since a page has a
  // date and a title but no note body in frontmatter.
  _entNoteSources(node, type, refs) {
    const out = [];
    const selfLabel = type === 'organization' ? 'This organization' : 'This site';
    const rec = this.plugin.readEntityRecord(node.path);
    out.push({ origin: selfLabel, originKind: 'self', originPath: node.path,
               entries: Array.isArray(rec.noteLog) ? rec.noteLog : [] });

    for (const s of (refs.sites || [])) {
      const r = this.plugin.readEntityRecord(s.path);
      if (Array.isArray(r.noteLog) && r.noteLog.length) {
        out.push({ origin: s.name, originKind: 'site', originPath: s.path, entries: r.noteLog });
      }
    }

    for (const w of (refs.work || [])) {
      const file = w.path + '/' + (w.kind === 'project' ? '_project.md' : docContainer.DOCUMENT_MD_NAME);
      const f = this.app.vault.getAbstractFileByPath(file);
      const fm = (f && (this.app.metadataCache.getFileCache(f) || {}).frontmatter) || {};
      if (Array.isArray(fm.noteLog) && fm.noteLog.length) {
        out.push({ origin: w.title || w.name, originKind: 'work', originPath: w.path, entries: fm.noteLog });
      }
    }

    // A note page has no noteLog — it IS the note. One synthetic entry each so it
    // takes its place in the same chronology.
    for (const n of (refs.notes || [])) {
      out.push({ origin: n.title || n.name, originKind: 'page', originPath: n.path,
                 entries: [{ date: n.noteDate || '', author: '', body: n.noteType || 'Note page',
                             noteTags: [], attachments: [] }] });
    }
    return out;
  }
```

- [ ] **Step 2: Verify** — `node --check main.js`; `node -e "const s=require('fs').readFileSync('main.js','utf8'); console.log('defined:',(s.match(/^  _entNoteSources\(/gm)||[]).length)"` → 1.
- [ ] **Step 3: Commit** — `feat(entities): gather note-feed sources across record, sites and work`

---

### Task 3: The Recent Notes pane

**Files:** `main.js`

**Interfaces:** `_entRecentNotesPane(p, node, type, refs)`.

**Key seam:** writes go through `this.plugin.writeEntityRecord(node.path, mutator)` — the documented Phase D encryption seam. Do NOT introduce another write path.

- [ ] **Step 1: Implement**

Model the composer on `_projNotesPane` (same classes, same tag extraction, same drop-zone states). Differences to honour:

1. The write is `await this.plugin.writeEntityRecord(node.path, (fm) => { if (!Array.isArray(fm.noteLog)) fm.noteLog = []; fm.noteLog.push(entry); })` — **derive from `fm`, never assign a snapshot.**
2. Attachments go to `node.path + '/_notes'`, created if absent, timestamp-prefixed on collision.
3. **Optimistic repaint:** after the write, clear the composer and repaint the list passing the new entry as an override — do not wait for `metadataCache`. Build the override rows with
   `docContainer.mergeNoteFeed(sources)` where the `self` source's entries are `rec.noteLog.concat([entry])`.
4. `this._entComposerDirty` guards against a listener repaint wiping a half-typed note. It **must** be cleared on commit before the write, and on discard — a flag with no clear path once froze a view for a day.

Render the feed with a new `_renderFeedInto(listEl, rows, emptyText)` placed next to `_renderNoteListInto`. It reuses `doc-detail-note` markup and adds one element: an origin chip.

```js
  // Same note markup as _renderNoteListInto, plus the origin chip that makes the
  // feed legible — a note reading "confirmed Monday" is useless without its source.
  _renderFeedInto(listEl, rows, emptyText) {
    listEl.empty();
    if (!rows.length) { listEl.createDiv({ cls: 'doc-detail-stub', text: emptyText || 'No notes yet.' }); return; }
    const CAP = 50;
    for (const n of rows.slice(0, CAP)) {
      const note = listEl.createDiv('doc-detail-note');
      const meta = note.createDiv('doc-detail-nmeta');
      const chip = meta.createSpan({ cls: 'doc-ent-origin ok-' + (n.originKind || 'self'), text: n.origin || '—' });
      if (n.originKind !== 'self' && n.originPath) {
        chip.addClass('is-link');
        chip.setAttr('role', 'button'); chip.setAttr('tabindex', '0');
        chip.setAttr('aria-label', 'Open ' + n.origin);
        const go = () => this.plugin.openContainerOverviewByPath(n.originPath);
        chip.onclick = go;
        chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      }
      meta.createSpan({ text: n.author || '' });
      meta.createSpan({ text: n.date || '' });
      note.createDiv({ text: n.body || '', cls: 'doc-detail-nbody' });
      const tags = n.noteTags || [], files = n.attachments || [];
      if (tags.length || files.length) {
        const foot = note.createDiv('doc-detail-nfoot');
        tags.forEach((t) => foot.createSpan({ text: '#' + t, cls: 'doc-detail-ntag' }));
        files.forEach((f) => { const ch = foot.createSpan({ cls: 'doc-detail-nfile' }); docIcon(ch, 'paperclip', 'doc-chip-ico'); ch.createSpan({ text: f }); });
      }
    }
    if (rows.length > CAP) {
      listEl.createDiv({ cls: 'doc-detail-noteshint', text: 'Showing ' + CAP + ' of ' + rows.length + ' — use Search Notes to narrow.' });
    }
  }
```

If `openContainerOverviewByPath` does not exist, resolve the node from `this.plugin.taxonomy()` by path and call the existing `openContainerOverview(node)`. **Check first; do not assume.** If neither is available, report BLOCKED rather than inventing a navigation path.

Hint line beneath the composer: `Notes from this record, its sites and its attributed work. Note tags (green) & attachments are scoped to the note. Newest first.`

- [ ] **Step 2: Verify** — `node --check main.js`, 118 tests still passing.
- [ ] **Step 3: Commit** — `feat(entities): Recent Notes pane — composer and merged feed`

---

### Task 4: The Search Notes pane

**Files:** `main.js`

**Interfaces:** `_entSearchNotesPane(p, node, type, refs)`.

- [ ] **Step 1: Implement**

Mirror `_renderSearchNotesPane` (main.js ~5684) exactly — same search bar, same `▤ Dates` toggle, same From/To/Clear row, same classes. Two differences:

1. The corpus is `docContainer.mergeNoteFeed(this._entNoteSources(node, type, refs))`, not a single `fm.noteLog`.
2. Filtering calls `docContainer.filterNoteFeed(rows, { text, from, to })` — do NOT reimplement the predicate inline; that duplication is exactly what Task 1 exists to prevent.

Render results with `_renderFeedInto(results, hits, 'No matching notes.')`.

- [ ] **Step 2: Verify** — `node --check main.js`, 118 passing.
- [ ] **Step 3: Commit** — `feat(entities): Search Notes pane over the merged feed`

---

### Task 5: The Log pane

**Files:** `main.js`

**Interfaces:** `async _entLogPane(p, node)`.

- [ ] **Step 1: Implement**

Mirror `_projLogPane` (main.js ~6610): read `node.path + '/' + docContainer.LOG_MD_NAME`, parse with `docContainer.parseLogBody`, render newest-first with `docLogIcon(action)` per row. Empty state when the file is absent — a record with no log is normal, not an error.

Hint line: `System activity — read-only. Notes are your commentary; the Log records actions on the record.`

- [ ] **Step 2: Verify** — `node --check main.js`, 118 passing.
- [ ] **Step 3: Commit** — `feat(entities): Log pane reading the record's log.md`

---

### Task 6: Wire the tabs and style the origin chip

**Files:** `main.js` (`_entTabs` ~6086, CSS block)

- [ ] **Step 1: Replace the `enotes` spec**

In `_entTabs`, **remove** the existing line:

```js
    specs.push({ id: 'enotes', label: 'Notes', count: refs.notes.length, fill: (p) => this._entNotesPane(p, node, isOrg, refs.notes) });
```

and add, in its place:

```js
    const feed = docContainer.mergeNoteFeed(this._entNoteSources(node, type, refs));
    specs.push({ id: 'erecent', label: 'Recent Notes', count: feed.length, fill: (p) => this._entRecentNotesPane(p, node, type, refs) });
    specs.push({ id: 'esearch', label: 'Search Notes', fill: (p) => this._entSearchNotesPane(p, node, type, refs) });
```

and append **after** the Contacts spec:

```js
    specs.push({ id: 'elog', label: 'Log', right: true, fill: (p) => this._entLogPane(p, node) });
```

Add `bar.addClass('has-right');` after the `bar` is created, matching `_projTabs` — the Log tab is pinned top-right and the class is what positions it.

The tab-render loop already honours `spec.right` in `_projTabs` but `_entTabs` builds its tab with `bar.createDiv('doc-detail-tabb')` with no right handling. Add `+ (spec.right ? ' right' : '')` to that call.

- [ ] **Step 2: Delete `_entNotesPane`**

It has exactly one call site, the one removed above. Remove the method. Verify no other caller:
`node -e "const s=require('fs').readFileSync('main.js','utf8'); console.log('calls:',(s.match(/_entNotesPane\(/g)||[]).length)"` → **0**.

If the count is not 0, stop and report — a dangling call would ship a `TypeError`.

- [ ] **Step 3: Style the origin chip**

Add next to the other `.doc-ent-*` rules in the CSS template string:

```css
.doc-ent-origin { font-weight:600; color: var(--text-normal); margin-right:6px; }
.doc-ent-origin.is-link { cursor:pointer; text-decoration:underline dotted; }
.doc-ent-origin.is-link:hover { color: var(--text-accent); }
.doc-ent-origin.ok-self { font-weight:500; color: var(--text-muted); }
```

These target a `<span>`, not a `<button>`, so Obsidian's `button:not(.clickable-icon)` rule does not apply and single-class specificity is correct here. **Do not** add doubled selectors reflexively — that pattern exists for controls that lose the cascade, and a span does not.

- [ ] **Step 4: Verify**

```bash
node --check main.js
node --test lib/doc-container.test.js
node -e "const s=require('fs').readFileSync('main.js','utf8'); for (const m of ['_entRecentNotesPane','_entSearchNotesPane','_entLogPane','_entNoteSources','_renderFeedInto']) { const d=(s.match(new RegExp('^  (async )?'+m+'\\\\(','gm'))||[]).length; const c=(s.match(new RegExp('this\\\\.'+m+'\\\\(','g'))||[]).length; console.log(m,'defined',d,'called',c); }"
```

Every method must be defined exactly once and called at least once.

- [ ] **Step 5: Manual check** — do NOT deploy. Report to the controller that the branch is ready for deployment when Paul's smoke test finishes.

- [ ] **Step 6: Commit** — `feat(entities): Recent Notes, Search Notes and Log tabs on entity records`

---

## Acceptance verification

| # | Criterion | How to verify |
|---|---|---|
| 1 | Three tabs present, old Notes tab gone | Task 6 step 2 count is 0; open a record |
| 2 | Composer writes to `noteLog` via the seam | Add a note, inspect the record's `.md` frontmatter |
| 3 | Every row states its origin; rows open their source | Click a site-origin chip |
| 4 | Org feed includes sites + attributed work | Add notes in three places, open the org |
| 5 | Note pages appear as rows | A record with a note page under it |
| 6 | Newest-first and stable | `node --test` (Task 1) |
| 7 | New note visible without reload | Add a note, do not reload |
| 8 | Search filters text, tag, dates | Search Notes pane |
| 9 | Log reads `log.md` | Log tab on a record with history |
| 10 | Pure core has no Obsidian/network | Read the diff |

## Self-review notes

- **Spec deviation, deliberate:** spec §7 proposed a new `writeEntityNote`. Superseded — `writeEntityRecord` already exists and is documented as the only entity-frontmatter write seam for the Phase D encryption work. Adding a parallel path would have broken that invariant.
- **Ordering:** Task 1 is pure and independently testable. Task 2 is a read-only gatherer. Tasks 3–5 are panes, each unreachable until Task 6. Task 6 is the only task that changes what a user sees.
- **Not built:** editing/deleting entries, notes on Agreements/Contacts, cross-vault search, reassignment (spec §2).
