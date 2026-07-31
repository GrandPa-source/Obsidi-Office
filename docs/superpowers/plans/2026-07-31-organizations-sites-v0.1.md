# Organizations & Sites — rung v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Organization and Site as first-class container types with records, attribution on documents/projects/notes, and dashboard pages that roll up the work naming them.

**Architecture:** Two new leaf kinds in the pure taxonomy core, detected from a folder note named after its folder (`Organizations/Baycrest/Baycrest.md`) carrying `type: organization|site`. References are quoted wikilinks in frontmatter, so rollups read Obsidian's own link index rather than scanning files. One shared `renderEntityView` in `ContainerOverviewView` serves both types, differing by field schema and tab set.

**Tech Stack:** Plain JavaScript, no build step. Obsidian plugin API. `node --test` for the pure core.

**Spec:** `docs/superpowers/specs/2026-07-31-organization-site-design.md` (§ references below point there).

## Global Constraints

Every task's requirements implicitly include this section.

**Build and repo**
- Plain JS, **no build step**. `main.js` is edited directly.
- After ANY edit to `lib/doc-container.js`, run `node scripts/inline-doc-container.js` — it regenerates the inlined copy between the `// <doc-container-core>` markers in `main.js`. Forgetting this ships a `main.js` that ignores your lib change.
- Lib symbols used at plugin/view scope must be referenced as `docContainer.X`. Bare references to lib constants from view code throw a runtime `ReferenceError` that `node --check` cannot catch — this exact bug blanked the detail page once before.
- New `main.js` helpers go **outside** the `<doc-container-core>` markers, or the next inline regen wipes them.
- Tests: `node --test lib/doc-container.test.js`. All existing tests must stay green (70 at plan time).
- Bump `manifest.json` `version` on every commit that changes plugin behaviour — Paul tracks builds by version number.

**Platform**
- iPad is a hard requirement. No Node APIs, no Electron APIs, no `fs`, no `require` of anything not already bundled. Vault API only (`vault.create`, `vault.createFolder`, `vault.createBinary`, `vault.adapter.*`, `fileManager.processFrontMatter`).
- Touch targets ≥ 44px on any control that ships to mobile. Tab strips already run through `docTabsWrapGuard(bar)` — call it on every new tab bar.

**Design tokens — use these, do not invent values**
- Colors: Obsidian variables only — `--text-normal`, `--text-muted`, `--text-error`, `--text-accent`, `--interactive-accent`, `--background-primary`, `--background-secondary`, `--background-modifier-border`. No hardcoded hex.
- Reuse existing classes rather than new ones: `.doc-detail-metacard`, `.doc-detail-grp`, `.doc-detail-grid`, `.doc-detail-fld`, `.doc-detail-lab`, `.doc-detail-val`, `.doc-detail-vinput`, `.doc-detail-tabs`, `.doc-detail-tabb`, `.doc-detail-tabcnt`, `.doc-detail-tabpane`, `.doc-detail-stub`, `.doc-detail-chip`, `.doc-detail-h1actions`, `.doc-detail-editbtn`, `.doc-ov-table`, `.doc-ov-primary`, `.doc-ov-crumb`, `.doc-ov-title`, `.doc-ov-typetag`, `.doc-ov-pill`.
- New classes are prefixed `.doc-ent-` and live in the `DOC_CONTAINER_CSS` template literal (`main.js:708`). Nothing else.
- Spacing: 4px scale (4, 8, 12, 16, 24). Transitions: list properties explicitly, never `transition: all`; 150ms for feedback, 200ms for reveals; gate non-essential motion behind `prefers-reduced-motion`.
- Interactive elements are `<button>` or `<a>`, never `<div onclick>`, except where matching an existing row pattern that already uses `tr.onclick` (tables) — those rows must also carry `tabindex="0"` and an Enter handler.
- Icon-only controls need `aria-label`. Icons come from `docIcon(el, 'lucide-name', cls)` / `docIconLabel(...)` — no new icon assets.
- Placeholder sample content uses `--text-error` **plus** a literal "SAMPLE — not real data" label. Color is never the sole signal.

**Copy rules**
- Button labels are verb + object ("Create site", "Save changes"), never "Submit"/"OK".
- Empty states state what goes here and how to start.
- Confirmations state the consequence, never "Are you sure?".
- No emojis in new UI copy.

**Deploy (after each task's commit)**
```powershell
Copy-Item main.js, manifest.json "C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\" -Force
```
OB_Testing only. Never a production vault without explicit instruction from Paul.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/doc-container.js` | Pure core: constants, schemas, taxonomy, pure helpers | Modify — entity constants, field schemas, entity leaf detection, link + classification helpers, stamp-input parsing, entity-scope predicate |
| `lib/doc-container.test.js` | Pure-core tests | Modify — new tests per task |
| `main.js` | Everything runtime: views, plugin methods, modals, CSS | Modify — settings, type registry, entity accessors, entity view, rollups, stamp fields, guards, CSS |
| `manifest.json` | Version | Modify — bump per task |
| `docs/superpowers/plans/2026-07-31-organizations-sites-v0.1.md` | This plan | Created |

`main.js` is 10,537 lines and the codebase's established shape — this plan does not restructure it. New code follows the existing section ordering: pure-core-adjacent helpers near their peers, view code inside the relevant view class, plugin methods on `OnlyObsidianTestPlugin`, modals at the bottom with the other modal classes.

---

### Task 1: Pure core — entity constants, field schemas, taxonomy detection

**Files:**
- Modify: `lib/doc-container.js` (constants block near line 26; `buildTaxonomy` at 136; exports at 500)
- Test: `lib/doc-container.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `ENTITY_TYPES = ['organization', 'site']`
  - `ORG_TYPES`, `SITE_TYPES`, `ORG_STATUS`, `SITE_STATUS` — string arrays
  - `ORG_FIELDS`, `SITE_FIELDS` — arrays of `{ key, label, type, options? }`, same shape as `DOC_FIELDS.phase1`
  - `entityNoteName(folderName) → string` — the folder note's filename
  - `buildTaxonomy(paths, root, entityFolders?) → nodes[]` — third argument is a `Map<folderPath, entityType>` or plain object; entity folders become leaves with `kind === entityType` and `node.entityType` set

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
// ── Organizations & Sites (2026-07-31 spec) ─────────────────────────────────

test('entityNoteName: folder note is named after its folder', () => {
  assert.strictEqual(dc.entityNoteName('Baycrest'), 'Baycrest.md');
});

test('ORG_FIELDS/SITE_FIELDS expose the documented keys', () => {
  const orgKeys = dc.ORG_FIELDS.map(f => f.key);
  assert.deepStrictEqual(orgKeys,
    ['name','orgType','status','relationship','website','address','summary','tags']);
  const siteKeys = dc.SITE_FIELDS.map(f => f.key);
  assert.deepStrictEqual(siteKeys,
    ['name','organization','siteType','siteCode','address','city','province','postalCode','status','summary','tags']);
  assert.ok(!orgKeys.includes('phone'), 'phone belongs to Contacts, not the org record');
});

test('buildTaxonomy: an entity folder becomes a leaf of its own kind', () => {
  const paths = ['Documents/Organizations/Baycrest/Baycrest.md'];
  const ents = new Map([['Documents/Organizations/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const cat = tree.find(n => n.name === 'Organizations');
  assert.strictEqual(cat.kind, 'category');
  const org = cat.children.find(n => n.name === 'Baycrest');
  assert.strictEqual(org.kind, 'organization');
  assert.strictEqual(org.entityType, 'organization');
  assert.strictEqual(org.current, null);
});

test('buildTaxonomy: a site folder becomes a site leaf', () => {
  const paths = ['Documents/Sites/Apotex Centre/Apotex Centre.md'];
  const ents = { 'Documents/Sites/Apotex Centre': 'site' };
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const site = tree.find(n => n.name === 'Sites').children[0];
  assert.strictEqual(site.kind, 'site');
});

test('buildTaxonomy: an entity that owns notes keeps its kind (override beats collection)', () => {
  const paths = [
    'Documents/Organizations/Baycrest/Baycrest.md',
    'Documents/Organizations/Baycrest/Vendor review/body.cnote',
    'Documents/Organizations/Baycrest/Vendor review/_document.md',
  ];
  const ents = new Map([['Documents/Organizations/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const org = tree.find(n => n.name === 'Organizations').children.find(n => n.name === 'Baycrest');
  assert.strictEqual(org.kind, 'organization', 'note child must not demote the org to a collection');
  const note = org.children.find(n => n.name === 'Vendor review');
  assert.strictEqual(note.kind, 'note');
});

test('buildTaxonomy: entityFolders outside the root are ignored', () => {
  const paths = ['Documents/Governance/Policy/Fan-Out/FanOut_V1.0.docx'];
  const ents = new Map([['Elsewhere/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  assert.strictEqual(tree.length, 1);
  assert.strictEqual(tree[0].name, 'Governance');
});

test('buildTaxonomy: two-argument calls behave exactly as before', () => {
  const paths = ['Documents/Governance/Policy/Fan-Out/FanOut_V1.0.docx'];
  const tree = dc.buildTaxonomy(paths, 'Documents');
  const doc = tree[0].children[0].children[0];
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.current, 'FanOut_V1.0.docx');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.entityNoteName is not a function`, and the taxonomy tests fail because the third argument is ignored.

- [ ] **Step 3: Add the constants and schemas**

In `lib/doc-container.js`, immediately after the `DOC_CLASSES` line (currently line 26):

```js
// ── Organizations & Sites (2026-07-31 spec) ──────────────────────────────────
// An entity is a folder holding a folder note named after the folder, carrying
// `type: organization|site`. Entities are NOT document containers: they hold
// their record and (organizations only) their own notes. See spec §4, §5.

const ENTITY_TYPES = ['organization', 'site'];

const ORG_TYPES = ['Internal', 'Health System Partner', 'Vendor', 'Contractor',
                   'Agency', 'Regulator', 'Union', 'Community Partner', 'Other'];
const ORG_STATUS = ['Active', 'Prospective', 'Inactive', 'Archived'];

const SITE_TYPES = ['Hospital', 'Long-Term Care', 'Residential', 'Clinic',
                    'Office', 'Campus Building', 'Parking', 'External'];
const SITE_STATUS = ['Active', 'Planned', 'Closed', 'Archived'];

// No `phone` on the organization record — phone numbers belong to Contacts,
// which is a later piece of work (spec §2).
const ORG_FIELDS = [
  { key: 'name',         label: 'Name',         type: 'text' },
  { key: 'orgType',      label: 'Type',         type: 'select', options: ORG_TYPES },
  { key: 'status',       label: 'Status',       type: 'select', options: ORG_STATUS },
  { key: 'relationship', label: 'Relationship', type: 'text' },
  { key: 'website',      label: 'Website',      type: 'text' },
  { key: 'address',      label: 'Address',      type: 'text' },
  { key: 'summary',      label: 'Summary',      type: 'textarea' },
  { key: 'tags',         label: 'Tags',         type: 'tags' },
];

const SITE_FIELDS = [
  { key: 'name',         label: 'Name',         type: 'text' },
  { key: 'organization', label: 'Organization', type: 'entity' },
  { key: 'siteType',     label: 'Site Type',    type: 'select', options: SITE_TYPES },
  { key: 'siteCode',     label: 'Site Code',    type: 'text' },
  { key: 'address',      label: 'Address',      type: 'text' },
  { key: 'city',         label: 'City',         type: 'text' },
  { key: 'province',     label: 'Province',     type: 'text' },
  { key: 'postalCode',   label: 'Postal Code',  type: 'text' },
  { key: 'status',       label: 'Status',       type: 'select', options: SITE_STATUS },
  { key: 'summary',      label: 'Summary',      type: 'textarea' },
  { key: 'tags',         label: 'Tags',         type: 'tags' },
];

// The folder note is named after its folder so references read `[[Baycrest]]`
// and the graph labels the node with the entity name (spec D4).
function entityNoteName(folderName) {
  return String(folderName || '') + '.md';
}
```

- [ ] **Step 4: Teach `buildTaxonomy` about entities**

In `lib/doc-container.js`, change the signature (line 136) and add entity handling.

Signature:
```js
function buildTaxonomy(paths, root, entityFolders) {
```

After the `pending` Map is built (immediately before the `// Build nested category/collection/document tree.` comment), insert:

```js
  // Entity folders are supplied by the caller (frontmatter is not readable from
  // the pure core). Only those under the managed root participate.
  const entities = new Map();
  if (entityFolders) {
    const pairs = (typeof entityFolders.entries === 'function')
      ? entityFolders.entries() : Object.entries(entityFolders);
    for (const [folder, kind] of pairs) {
      if (String(folder).startsWith(prefix) && ENTITY_TYPES.includes(kind)) entities.set(folder, kind);
    }
  }
```

In the leaves assembly, add entities **first** so their nodes exist before any nested note claims the same path:

```js
  const leaves = [];
  for (const [f, k] of entities) leaves.push({ folder: f, leafKind: k });
  for (const f of documents) leaves.push({ folder: f, leafKind: 'document' });
  for (const f of notes)     leaves.push({ folder: f, leafKind: 'note' });
  for (const f of pending.keys()) leaves.push({ folder: f, leafKind: 'pending' });
```

In the per-leaf branch chain, add an entity branch before the final `else`:

```js
    if (leafKind === 'document') {
      const grouped = groupDocumentFiles(folderFiles.get(docFolder));
      docNode.current = grouped.current;
      docNode.files = grouped.versions;
      docNode.attachments = grouped.attachments;
    } else if (leafKind === 'pending') {
      docNode.pending = pending.get(docFolder);
      docNode.current = null; docNode.files = [];
      docNode.attachments = (folderFiles.get(docFolder) || []).slice();
    } else if (ENTITY_TYPES.includes(leafKind)) {
      docNode.entityType = leafKind;
      docNode.current = null; docNode.files = []; docNode.attachments = [];
    } else {
      docNode.noteBody = folderFiles.get(docFolder).find(isNoteBody);
      docNode.current = null; docNode.files = []; docNode.attachments = [];
    }
```

Before `return rootNode.children;`, add the override pass:

```js
  // An entity folder can also be the parent of note folders; the "intermediate
  // segment becomes a collection" rule must not demote it. Stamping last makes
  // the result independent of leaf ordering.
  if (entities.size) _stampEntityKinds(rootNode.children, entities);
```

And define the helper immediately after `buildTaxonomy`:

```js
function _stampEntityKinds(nodes, entities) {
  for (const n of nodes) {
    const k = entities.get(n.path);
    if (k) { n.kind = k; n.entityType = k; }
    if (n.children && n.children.length) _stampEntityKinds(n.children, entities);
  }
}
```

- [ ] **Step 5: Export the new symbols**

In the `module.exports` block, add after `DOC_CLASSES,`:

```js
  ENTITY_TYPES,
  ORG_TYPES,
  ORG_STATUS,
  SITE_TYPES,
  SITE_STATUS,
  ORG_FIELDS,
  SITE_FIELDS,
  entityNoteName,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS — all pre-existing tests plus the 7 new ones.

- [ ] **Step 7: Re-inline and commit**

```bash
node scripts/inline-doc-container.js
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(entities): pure-core entity types, field schemas, taxonomy detection"
```

---

### Task 2: Pure core — link helpers and backlink source classification

**Files:**
- Modify: `lib/doc-container.js`
- Test: `lib/doc-container.test.js`

**Interfaces:**
- Consumes: `ENTITY_TYPES` (Task 1)
- Produces:
  - `entityLink(name) → '[[Name]]'`
  - `entityLinkName(link) → 'Name' | null` — strips `[[ ]]`, alias `|`, subpath `#`
  - `entityStampKind(front, name) → 'organization' | 'sites' | null` — which stamp field of a frontmatter object names this entity
  - `stampSourceFolder(sourcePath) → { folder, role }` where role is `'document-md' | 'project-md' | 'entity-note' | 'sidecar' | 'other'`
  - `parseEntityListInput(text) → string[]` — comma-separated names to link strings

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
test('entityLink / entityLinkName round-trip', () => {
  assert.strictEqual(dc.entityLink('Baycrest'), '[[Baycrest]]');
  assert.strictEqual(dc.entityLinkName('[[Baycrest]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('[[Baycrest|BC]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('[[Baycrest#Sites]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('Baycrest'), 'Baycrest', 'bare name is tolerated');
  assert.strictEqual(dc.entityLinkName(''), null);
  assert.strictEqual(dc.entityLinkName(null), null);
});

test('entityStampKind: distinguishes the organization stamp from the sites stamp', () => {
  const front = { organization: '[[Baycrest]]', sites: ['[[Apotex Centre]]', '[[Terraces]]'] };
  assert.strictEqual(dc.entityStampKind(front, 'Baycrest'), 'organization');
  assert.strictEqual(dc.entityStampKind(front, 'Terraces'), 'sites');
  assert.strictEqual(dc.entityStampKind(front, 'Nowhere'), null);
  assert.strictEqual(dc.entityStampKind(null, 'Baycrest'), null);
});

test('entityStampKind: a single-string sites value still matches', () => {
  assert.strictEqual(dc.entityStampKind({ sites: '[[Terraces]]' }, 'Terraces'), 'sites');
});

test('stampSourceFolder: identifies which record a link came from', () => {
  assert.deepStrictEqual(dc.stampSourceFolder('Documents/Gov/Fan-Out/_document.md'),
    { folder: 'Documents/Gov/Fan-Out', role: 'document-md' });
  assert.deepStrictEqual(dc.stampSourceFolder('Documents/Projects/Acc 2026/_project.md'),
    { folder: 'Documents/Projects/Acc 2026', role: 'project-md' });
  assert.deepStrictEqual(dc.stampSourceFolder('Documents/Sites/Terraces/Terraces.md'),
    { folder: 'Documents/Sites/Terraces', role: 'entity-note' });
  assert.deepStrictEqual(dc.stampSourceFolder('Documents/Gov/Fan-Out/FanOut_V1.0.docx.md'),
    { folder: 'Documents/Gov/Fan-Out', role: 'sidecar' });
  assert.deepStrictEqual(dc.stampSourceFolder('Documents/Gov/Fan-Out/log.md'),
    { folder: 'Documents/Gov/Fan-Out', role: 'other' });
});

test('parseEntityListInput: names to link strings, deduped, empties dropped', () => {
  assert.deepStrictEqual(dc.parseEntityListInput('Apotex Centre, Terraces'),
    ['[[Apotex Centre]]', '[[Terraces]]']);
  assert.deepStrictEqual(dc.parseEntityListInput('[[Apotex Centre]], Apotex Centre'),
    ['[[Apotex Centre]]']);
  assert.deepStrictEqual(dc.parseEntityListInput('  '), []);
  assert.deepStrictEqual(dc.parseEntityListInput(null), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.entityLink is not a function`.

- [ ] **Step 3: Implement the helpers**

In `lib/doc-container.js`, after `entityNoteName`:

```js
// References are quoted wikilinks in frontmatter — the form the native indexer
// parses at boot, which is what makes backlinks and graph edges work (spec D3).
function entityLink(name) {
  return '[[' + String(name || '').trim() + ']]';
}

// Accepts '[[Name]]', '[[Name|alias]]', '[[Name#sub]]' or a bare name.
function entityLinkName(link) {
  const s = String(link == null ? '' : link).trim();
  if (!s) return null;
  const m = s.match(/^\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]$/);
  const name = (m ? m[1] : s).trim();
  return name || null;
}

// Which stamp field of `front` names `entityName` — 'organization', 'sites',
// or null. Only the stamp counts as a reference; body mentions are handled by
// the caller (spec D8).
function entityStampKind(front, entityName) {
  if (!front || !entityName) return null;
  const want = String(entityName).trim();
  if (entityLinkName(front.organization) === want) return 'organization';
  const raw = front.sites;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const s of list) if (entityLinkName(s) === want) return 'sites';
  return null;
}

// Which record a linking file represents, and the folder that owns it.
function stampSourceFolder(sourcePath) {
  const p = String(sourcePath || '');
  const slash = p.lastIndexOf('/');
  const folder = slash >= 0 ? p.slice(0, slash) : '';
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const folderName = folder.slice(folder.lastIndexOf('/') + 1);
  let role = 'other';
  if (name === DOCUMENT_MD_NAME) role = 'document-md';
  else if (name === '_project.md') role = 'project-md';
  else if (folderName && name === entityNoteName(folderName)) role = 'entity-note';
  else if (/\.[a-z0-9]+\.md$/i.test(name)) role = 'sidecar';
  return { folder, role };
}

// Comma-separated user input to link strings, order preserved, deduped.
function parseEntityListInput(text) {
  const out = [];
  for (const part of String(text == null ? '' : text).split(',')) {
    const name = entityLinkName(part.trim());
    if (!name) continue;
    const link = entityLink(name);
    if (!out.includes(link)) out.push(link);
  }
  return out;
}
```

Note: `stampSourceFolder` references `DOCUMENT_MD_NAME`, which is declared later in the file at line 53. Function declarations hoist and this is only called at runtime, so ordering is safe — but place these functions **after** the `DOCUMENT_MD_NAME` declaration anyway to keep reading order sane. If you placed `entityNoteName` in Task 1 before line 53, move this block below `LOG_MD_NAME` instead.

- [ ] **Step 4: Export the new symbols**

Add to `module.exports`:

```js
  entityLink,
  entityLinkName,
  entityStampKind,
  stampSourceFolder,
  parseEntityListInput,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS.

- [ ] **Step 6: Re-inline and commit**

```bash
node scripts/inline-doc-container.js
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(entities): link helpers and backlink source classification"
```

---

### Task 3: Runtime — settings, type registry, single taxonomy entry point

**Files:**
- Modify: `main.js` — settings defaults (~1169), `resolveContainerType` (8322), five `buildTaxonomy` call sites (3886, 4302, 4332, 4994, 5397), `SettingsTab` (5895+)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `docContainer.ENTITY_TYPES`, `docContainer.entityNoteName`, `docContainer.buildTaxonomy` (Task 1)
- Produces:
  - `plugin.entityFolders() → Map<folderPath, entityType>`
  - `plugin.taxonomy() → nodes[]` — the ONE way to build a taxonomy from here on
  - `plugin.entityCategoryPath(type) → string` — e.g. `Documents/Organizations`
  - settings keys `docOrgCategory`, `docSiteCategory`

- [ ] **Step 1: Add the settings defaults**

In `main.js`, in the defaults object, replace the `docCategoryTypeMap` line with:

```js
  docCategoryTypeMap: { Projects: 'project', Organizations: 'organization', Sites: 'site' },
  docOrgCategory: 'Organizations',    // category under docRoot holding organization records
  docSiteCategory: 'Sites',           // category under docRoot holding site records
```

- [ ] **Step 2: Add the entity resolver and the taxonomy entry point**

On `OnlyObsidianTestPlugin`, immediately after `resolveContainerType` (ends line 8335):

```js
  // ── Organizations & Sites: entity folder resolution ──────────────────────────
  // An entity folder holds a markdown file named after the folder whose
  // frontmatter `type` is an entity type. Frontmatter is unreadable from the
  // pure core, so the runtime resolves this and hands the map to buildTaxonomy.
  entityFolders() {
    const map = new Map();
    const root = (this.settings.docRoot || 'Documents').replace(/\/+$/, '');
    const prefix = root + '/';
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const folder = f.path.slice(0, f.path.length - f.name.length - 1).replace(/\/+$/, '');
      const folderName = folder.slice(folder.lastIndexOf('/') + 1);
      if (f.name !== docContainer.entityNoteName(folderName)) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      if (docContainer.ENTITY_TYPES.includes(fm.type)) map.set(folder, fm.type);
    }
    return map;
  }

  // THE taxonomy entry point. Every caller uses this so entity detection can
  // never be accidentally omitted at one call site.
  taxonomy() {
    return docContainer.buildTaxonomy(
      this.app.vault.getFiles().map((f) => f.path),
      this.settings.docRoot,
      this.entityFolders());
  }

  // Absolute path of the category holding records of a given entity type.
  entityCategoryPath(type) {
    const root = (this.settings.docRoot || 'Documents').replace(/\/+$/, '');
    const cat = type === 'site' ? (this.settings.docSiteCategory || 'Sites')
                                : (this.settings.docOrgCategory || 'Organizations');
    return root + '/' + cat;
  }
```

- [ ] **Step 3: Teach `resolveContainerType` about the entity folder note**

In `resolveContainerType` (8322), insert after the `_project.md` block and before the `const root = ...` line:

```js
    // Entity folder note: `<Folder>/<Folder>.md` with `type: organization|site`
    const folderName = node.path.slice(node.path.lastIndexOf('/') + 1);
    const enote = this.app.vault.getAbstractFileByPath(node.path + '/' + docContainer.entityNoteName(folderName));
    if (enote) {
      const efm = (this.app.metadataCache.getFileCache(enote) || {}).frontmatter || {};
      if (docContainer.ENTITY_TYPES.includes(efm.type)) return efm.type;
    }
```

- [ ] **Step 4: Route every taxonomy build through the new entry point**

Replace each of these five call sites with `this.plugin.taxonomy()` (or `this.taxonomy()` inside the plugin class):

| Line | Current | Replacement |
|---|---|---|
| 3886 | `docContainer.buildTaxonomy(this.app.vault.getFiles().map((f) => f.path), this.plugin.settings.docRoot)` | `this.plugin.taxonomy()` |
| 4302 | `docContainer.buildTaxonomy(paths, this.plugin.settings.docRoot)` | `this.plugin.taxonomy()` |
| 4332 | `docContainer.buildTaxonomy(paths, this.plugin.settings.docRoot)` | `this.plugin.taxonomy()` |
| 4994 | `docContainer.buildTaxonomy(paths, this.plugin.settings.docRoot)` | `this.plugin.taxonomy()` |
| 5397 | `docContainer.buildTaxonomy(this.app.vault.getFiles().map(f => f.path), root)` | `this.plugin.taxonomy()` |

Where a now-unused `const paths = ...` line remains directly above, delete it. Do not delete `const root = ...` at 5396 — line 5398 still uses it.

- [ ] **Step 5: Add the settings UI**

In `SettingsTab.display()`, directly after the existing `docCategoryTypeMap` setting (the one described as "Comma-separated categories whose containers are Projects…"):

```js
    new obsidian.Setting(containerEl)
      .setName('Organizations category')
      .setDesc('Category folder under the document root holding organization records. Each organization is a folder with a note named after it.')
      .addText((t) => t.setValue(this.plugin.settings.docOrgCategory || 'Organizations')
        .onChange(async (v) => { this.plugin.settings.docOrgCategory = v.trim() || 'Organizations'; await this.plugin.saveSettings(); }));

    new obsidian.Setting(containerEl)
      .setName('Sites category')
      .setDesc('Category folder under the document root holding site records. Sites are created from an organization page and stored here.')
      .addText((t) => t.setValue(this.plugin.settings.docSiteCategory || 'Sites')
        .onChange(async (v) => { this.plugin.settings.docSiteCategory = v.trim() || 'Sites'; await this.plugin.saveSettings(); }));
```

- [ ] **Step 6: Verify nothing regressed**

Run: `node --check main.js`
Expected: no output (syntax OK).

Run: `node --test lib/doc-container.test.js`
Expected: PASS.

Then in Obsidian (OB_Testing), reload the plugin and open the Document Browser.
Expected: the tree renders exactly as before — no entities exist yet, so behaviour is unchanged. Any blank tree means a call-site edit was wrong.

- [ ] **Step 7: Bump version, deploy, commit**

```bash
# manifest.json: version 0.1.28 -> 0.1.29
git add main.js manifest.json
git commit -m "feat(entities): settings, entity type registry, single taxonomy entry point"
```

---

### Task 4: Runtime — entity record accessors and creation

**Files:**
- Modify: `main.js` — plugin methods after `entityCategoryPath` (Task 3); command registration in `onload`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `plugin.entityCategoryPath`, `plugin.taxonomy` (Task 3); `docContainer.ORG_FIELDS`, `SITE_FIELDS`, `entityNoteName`, `entityLink` (Tasks 1–2)
- Produces:
  - `plugin.entityNotePath(folderPath) → string`
  - `plugin.readEntityRecord(folderPath) → object` — frontmatter, `{}` when absent
  - `plugin.writeEntityRecord(folderPath, mutator) → Promise<void>`
  - `plugin.createEntity({ type, name, seed }) → Promise<string|null>` — returns the folder path
  - Command: `Create organization`

**Phase D note:** `readEntityRecord` / `writeEntityRecord` are the ONLY paths that touch an entity record's frontmatter. Every consumer in later tasks goes through them, so a future encryption phase relocates the payload by changing two methods (spec §12). Do not read entity frontmatter directly anywhere else.

- [ ] **Step 1: Add the accessors and the creator**

After `entityCategoryPath` in `main.js`:

```js
  entityNotePath(folderPath) {
    const name = folderPath.slice(folderPath.lastIndexOf('/') + 1);
    return folderPath + '/' + docContainer.entityNoteName(name);
  }

  // Phase D seam — the only read of an entity record's frontmatter.
  readEntityRecord(folderPath) {
    const f = this.app.vault.getAbstractFileByPath(this.entityNotePath(folderPath));
    if (!(f instanceof obsidian.TFile)) return {};
    return (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
  }

  // Phase D seam — the only write of an entity record's frontmatter.
  async writeEntityRecord(folderPath, mutator) {
    const f = this.app.vault.getAbstractFileByPath(this.entityNotePath(folderPath));
    if (!(f instanceof obsidian.TFile)) { elog('writeEntityRecord: no record at', folderPath); return; }
    await this.app.fileManager.processFrontMatter(f, (fm) => mutator(fm));
    this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach((l) => l.view.render && l.view.render());
  }

  // Create an organization or site record. `seed` supplies extra frontmatter
  // (e.g. a site's organization link). Returns the folder path, or null.
  async createEntity({ type, name, seed }) {
    const clean = (name || '').trim();
    if (!clean) { new obsidian.Notice('Enter a name'); return null; }
    if (/[\\/:*?"<>|]/.test(clean)) { new obsidian.Notice('Name cannot contain \\ / : * ? " < > |'); return null; }
    const category = this.entityCategoryPath(type);
    if (!this.app.vault.getAbstractFileByPath(category)) {
      try { await this.app.vault.createFolder(category); } catch (e) { /* exists or race */ }
    }
    const folder = category + '/' + clean;
    if (this.app.vault.getAbstractFileByPath(folder)) {
      new obsidian.Notice('“' + clean + '” already exists here.'); return null;
    }
    const defaults = type === 'site'
      ? { siteType: '', status: 'Active' }
      : { orgType: '', status: 'Active' };
    const front = Object.assign({ type, name: clean }, defaults, seed || {});
    const lines = ['---'];
    for (const [k, v] of Object.entries(front)) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) { lines.push(k + ':'); v.forEach((x) => lines.push('  - ' + JSON.stringify(String(x)))); }
      else lines.push(k + ': ' + JSON.stringify(String(v)));
    }
    lines.push('tags: []', '---', '');
    try {
      await this.app.vault.createFolder(folder);
      await this.app.vault.create(this.entityNotePath(folder), lines.join('\n'));
      dlog('entity created:', type, folder);
      this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_BROWSER).forEach((l) => l.view.render && l.view.render());
      new obsidian.Notice('Created ' + type + ' “' + clean + '”');
      return folder;
    } catch (e) {
      elog('createEntity failed:', e && e.stack || e);
      new obsidian.Notice('Could not create ' + type + ': ' + ((e && e.message) || e));
      return null;
    }
  }
```

- [ ] **Step 2: Register the command**

In `onload`, beside the existing `Create container note` command registration:

```js
    this.addCommand({
      id: 'create-organization',
      name: 'Create organization',
      callback: () => new EntityCreateModal(this.app, {
        type: 'organization',
        onSubmit: async ({ name }) => {
          const folder = await this.createEntity({ type: 'organization', name });
          if (folder) await this.openContainerOverview({ path: folder });
        },
      }).open(),
    });
```

- [ ] **Step 3: Add the creation modal**

At the bottom of `main.js`, beside the other modal classes (after `NoteCreateModal`):

```js
// Create an organization, or a site from an organization page. `orgName` (site
// mode) is displayed read-only — the site's owner is the page you started from.
class EntityCreateModal extends obsidian.Modal {
  constructor(app, opts) { super(app); this.opts = opts || {}; }
  onOpen() {
    const isSite = this.opts.type === 'site';
    this.titleEl.setText(isSite ? 'New site' : 'New organization');
    const c = this.contentEl;

    const nameLab = c.createEl('label', { text: 'Name', cls: 'doc-ent-flab' });
    nameLab.htmlFor = 'doc-ent-name';
    const name = c.createEl('input', { cls: 'doc-ov-newinput', attr: { id: 'doc-ent-name', spellcheck: 'false' } });
    name.placeholder = isSite ? 'Apotex Centre' : 'Baycrest';

    let typeSel = null, addr = null;
    if (isSite) {
      const owner = c.createDiv('doc-ent-owner');
      owner.createSpan({ text: 'Organization', cls: 'doc-detail-lab' });
      owner.createSpan({ text: this.opts.orgName || '—', cls: 'doc-detail-val' });

      const tLab = c.createEl('label', { text: 'Site type', cls: 'doc-ent-flab' });
      tLab.htmlFor = 'doc-ent-type';
      typeSel = c.createEl('select', { cls: 'doc-detail-vinput', attr: { id: 'doc-ent-type' } });
      typeSel.createEl('option', { text: '—', value: '' });
      docContainer.SITE_TYPES.forEach((o) => typeSel.createEl('option', { text: o, value: o }));

      const aLab = c.createEl('label', { text: 'Address (optional)', cls: 'doc-ent-flab' });
      aLab.htmlFor = 'doc-ent-addr';
      addr = c.createEl('input', { cls: 'doc-ov-newinput', attr: { id: 'doc-ent-addr' } });
    }

    const bar = c.createDiv('doc-detail-sh-bar');
    const create = bar.createEl('button', { text: isSite ? 'Create site' : 'Create organization', cls: 'mod-cta' });
    create.disabled = true;
    name.oninput = () => { create.disabled = !name.value.trim(); };
    const submit = async () => {
      if (!name.value.trim()) return;
      create.disabled = true;
      await this.opts.onSubmit({
        name: name.value.trim(),
        siteType: typeSel ? typeSel.value : '',
        address: addr ? addr.value.trim() : '',
      });
      this.close();
    };
    create.onclick = submit;
    name.onkeydown = (e) => { if (e.key === 'Enter' && name.value.trim()) { e.preventDefault(); submit(); } };
    name.focus();
  }
  onClose() { this.contentEl.empty(); }
}
```

- [ ] **Step 4: Verify by drill**

Run: `node --check main.js` — expect no output.

Deploy, reload Obsidian, run the command palette entry **Create organization**, name it `Baycrest`.
Expected: `Documents/Organizations/Baycrest/Baycrest.md` exists on disk with `type: organization`, `name: Baycrest`, `status: Active`; the Document Browser shows Organizations › Baycrest.

Verify on disk rather than trusting the Notice:
```powershell
Get-Content "C:\Obsidian\OB_Testing\Documents\Organizations\Baycrest\Baycrest.md"
```

- [ ] **Step 5: Bump version, deploy, commit**

```bash
# manifest.json: version -> 0.1.30
git add main.js manifest.json
git commit -m "feat(entities): record accessors, createEntity, create-organization command"
```

---

### Task 5: Runtime — entity view shell (header, metadata card, inline edit)

**Files:**
- Modify: `main.js` — `ContainerOverviewView.render` (5417), new methods after `renderProjectView` (ends 5568)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `plugin.readEntityRecord`, `plugin.writeEntityRecord` (Task 4); `docContainer.ORG_FIELDS`, `SITE_FIELDS` (Task 1)
- Produces:
  - `ContainerOverviewView.renderEntityView(c, node, type)`
  - `ContainerOverviewView._entInputs` — `{ key: { inp, orig, field } }` during edit
  - `ContainerOverviewView._saveEntityEdits(node, type)`
  - `this._entEditMode`, `this._entActiveTab` view state

- [ ] **Step 1: Branch `render()` to the entity view**

In `ContainerOverviewView.render()`, replace the project-type check with a chain that handles entities first:

```js
    const ctype = this.plugin.resolveContainerType(node);
    if (docContainer.ENTITY_TYPES.includes(ctype)) {
      this.renderEntityView(c, node, ctype);
    } else if (node.kind === 'collection' && ctype === 'project') {
      this.renderProjectView(c, node);
    } else {
```

(the existing `else` body is unchanged).

Also extend the state reset in `setState` (5390) so entity state clears on navigation:

```js
    if (s && s.path) { if (s.path !== this.path) { this._projActiveTab = null; this._projEditMode = false; this._ovEditMode = false; this._entEditMode = false; this._entActiveTab = null; this._wantScrollTop = true; } this.path = s.path; this.render(); }
```

- [ ] **Step 2: Implement the entity view**

After `renderProjectView` ends (line 5568), add:

```js
  // ── Organizations & Sites: shared entity view (spec §7) ─────────────────────
  _entFields(type) {
    return type === 'site' ? docContainer.SITE_FIELDS : docContainer.ORG_FIELDS;
  }
  _entChipCls(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active') return 'c-active';
    if (s === 'prospective' || s === 'planned') return 'c-review';
    if (s === 'inactive' || s === 'closed') return 'c-draft';
    if (s === 'archived') return 'c-arch';
    return '';
  }
  renderEntityView(c, node, type) {
    const rec = this.plugin.readEntityRecord(node.path);
    const editing = this._entEditMode;
    if (editing) this._entInputs = {};
    const isOrg = type === 'organization';

    c.createDiv({ text: node.path.split('/').slice(0, -1).join(' › '), cls: 'doc-ov-crumb' });
    const h1 = c.createDiv('doc-pv-h1row');
    h1.createSpan({ text: rec.name || node.name, cls: 'doc-ov-title' });
    const kindVal = isOrg ? rec.orgType : rec.siteType;
    if (kindVal) h1.createSpan({ text: kindVal, cls: 'doc-detail-chip' });
    if (rec.status) h1.createSpan({ text: rec.status, cls: 'doc-detail-chip ' + this._entChipCls(rec.status) });
    h1.createSpan({ text: isOrg ? 'Organization' : 'Site', cls: 'doc-ov-typetag' });

    const acts = h1.createDiv('doc-detail-h1actions');
    if (editing) {
      acts.createEl('button', { text: 'Save changes', cls: 'doc-detail-editbtn' })
        .onclick = () => this._saveEntityEdits(node, type);
      acts.createEl('button', { text: 'Cancel', cls: 'doc-detail-editbtn ghost' })
        .onclick = () => { this._entEditMode = false; this.render(); };
    } else {
      acts.createEl('button', { text: 'Edit', cls: 'doc-detail-editbtn' })
        .onclick = () => { this._entEditMode = true; this.render(); };
    }
    c.createDiv({ text: editing ? 'Editing — Save or Cancel' : 'Stored in ' + docContainer.entityNoteName(node.name),
                  cls: 'doc-pv-sub' });

    const card = c.createDiv('doc-detail-metacard');
    const groups = isOrg
      ? [['Identification', ['name', 'orgType', 'status', 'relationship']],
         ['Contact', ['website', 'address']],
         ['Description', ['summary', 'tags']]]
      : [['Identification', ['name', 'organization', 'siteType', 'siteCode', 'status']],
         ['Location', ['address', 'city', 'province', 'postalCode']],
         ['Description', ['summary', 'tags']]];
    const byKey = {}; for (const f of this._entFields(type)) byKey[f.key] = f;
    for (const [label, keys] of groups) {
      card.createDiv({ text: label, cls: 'doc-detail-grp' });
      const grid = card.createDiv('doc-detail-grid');
      for (const k of keys) { const f = byKey[k]; if (f) this._entCell(grid, f, rec, editing); }
    }

    this._entTabs(c.createDiv('doc-pv-tabwrap'), node, type, rec);
  }

  _entCell(grid, f, rec, editing) {
    const cell = grid.createDiv('doc-detail-fld');
    if (f.type === 'textarea' || f.key === 'name' || f.key === 'tags' || f.key === 'address') cell.addClass('span2');
    const labId = 'ent-' + f.key;
    const lab = cell.createEl('label', { text: f.label.toUpperCase(), cls: 'doc-detail-lab' });
    lab.htmlFor = labId;

    const seed = f.key === 'tags'
      ? (Array.isArray(rec.tags) ? rec.tags.join(', ') : (rec.tags || ''))
      : (f.type === 'entity' ? (docContainer.entityLinkName(rec[f.key]) || '')
                             : (rec[f.key] != null ? String(rec[f.key]) : ''));

    if (editing) {
      let inp;
      if (f.type === 'select') {
        inp = cell.createEl('select', { cls: 'doc-detail-vinput', attr: { id: labId } });
        inp.createEl('option', { text: '—', value: '' });
        (f.options || []).forEach((o) => inp.createEl('option', { text: o, value: o }));
        inp.value = seed;
      } else if (f.type === 'textarea') {
        inp = cell.createEl('textarea', { cls: 'doc-detail-vinput', attr: { id: labId } });
        inp.rows = 2; inp.value = seed;
      } else {
        inp = cell.createEl('input', { cls: 'doc-detail-vinput', attr: { id: labId } });
        inp.value = seed;
        if (f.key === 'tags') inp.placeholder = 'comma-separated';
        if (f.key === 'website') { inp.type = 'url'; inp.spellcheck = false; inp.placeholder = 'https://…'; }
        if (f.type === 'entity') inp.placeholder = 'Organization name';
      }
      this._entInputs[f.key] = { inp, orig: seed, field: f };
      return;
    }

    if (f.key === 'tags') {
      const arr = Array.isArray(rec.tags) ? rec.tags : (rec.tags ? String(rec.tags).split(/[,\s]+/) : []);
      const tags = arr.map((t) => String(t).replace(/^#/, '')).filter(Boolean);
      if (!tags.length) { cell.createDiv({ text: '—', cls: 'doc-detail-val' }); return; }
      const box = cell.createDiv('doc-detail-val');
      tags.forEach((t) => box.createSpan({ text: t, cls: 'doc-detail-tagpill' }));
      return;
    }
    if (f.type === 'entity' && seed) {
      const box = cell.createDiv('doc-detail-val');
      const a = box.createEl('button', { text: seed, cls: 'doc-ent-link' });
      a.onclick = () => this.plugin.openEntityByName(seed);
      return;
    }
    if (f.key === 'website' && seed) {
      const box = cell.createDiv('doc-detail-val');
      const a = box.createEl('a', { text: seed, href: seed });
      a.setAttr('rel', 'noopener'); a.setAttr('target', '_blank');
      return;
    }
    cell.createDiv({ text: seed || '—', cls: 'doc-detail-val' + (seed ? '' : ' doc-detail-muted') });
  }

  async _saveEntityEdits(node, type) {
    const inputs = this._entInputs || {};
    let changed = false;
    for (const k in inputs) if (inputs[k].inp.value !== inputs[k].orig) { changed = true; break; }
    this._entEditMode = false;
    if (!changed) { this.render(); return; }
    try {
      await this.plugin.writeEntityRecord(node.path, (fm) => {
        for (const k in inputs) {
          const { inp, orig, field } = inputs[k];
          const v = inp.value;
          if (v === orig) continue;
          if (k === 'tags') fm.tags = v.split(/[,\s]+/).map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
          else if (field.type === 'entity') { if (v.trim()) fm[k] = docContainer.entityLink(v.trim()); else delete fm[k]; }
          else fm[k] = v === '' ? null : v;
        }
      });
    } catch (e) {
      elog('[entities] save failed:', e && e.stack || e);
      new obsidian.Notice('Save failed: ' + ((e && e.message) || e));
      this._entEditMode = true;
      return;
    }
    this.render();
  }
```

- [ ] **Step 3: Add the name-based open helper**

On the plugin class, after `entityNotePath` (Task 4):

```js
  // Open an entity page by its display name (what a wikilink carries).
  async openEntityByName(name) {
    const want = String(name || '').trim();
    for (const [folder] of this.entityFolders()) {
      if (folder.slice(folder.lastIndexOf('/') + 1) === want) { await this.openContainerOverview({ path: folder }); return; }
    }
    new obsidian.Notice('No record found for “' + want + '”');
  }
```

- [ ] **Step 4: Verify by drill**

Run: `node --check main.js` — expect no output.

Deploy, reload, open Organizations › Baycrest.
Expected: header with name + Organization tag, metadata card in three groups, Edit toggles inputs, Save persists. Confirm on disk that `relationship` and `website` landed in `Baycrest.md`.

Tab through the page with the keyboard only.
Expected: Edit, every input, and Save/Cancel are all reachable with a visible focus ring.

- [ ] **Step 5: Bump version, deploy, commit**

```bash
# manifest.json: version -> 0.1.31
git add main.js manifest.json
git commit -m "feat(entities): shared entity view — header, metadata card, inline edit"
```

---

### Task 6: Runtime — backlink index and the Sites / Work / Notes panes

**Files:**
- Modify: `main.js` — plugin methods after `openEntityByName` (Task 5); `_entTabs` and pane methods in `ContainerOverviewView`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `docContainer.stampSourceFolder`, `entityStampKind`, `entityLinkName` (Task 2); `plugin.taxonomy` (Task 3); `plugin.readEntityRecord` (Task 4)
- Produces:
  - `plugin.entityReferences(entityFolderPath) → { sites, work, notes }` where
    - `sites`: `[{ path, name, rec }]`
    - `work`: `[{ path, name, kind, title, docClass, status, nextReviewDate, stamp }]` (`kind` is `'document' | 'project'`, `stamp` is `'organization' | 'sites'`)
    - `notes`: `[{ path, name, title, noteType, noteDate, rowType, parentTitle }]` (`rowType` is `'organizational' | 'stamped' | 'mention'`)
  - `ContainerOverviewView._entTabs(parent, node, type, rec)`

- [ ] **Step 1: Add the reference resolver**

On the plugin class:

```js
  // ── Organizations & Sites: rollups (spec §9) ────────────────────────────────
  // Backlinks come from Obsidian's own link index (resolvedLinks), so this is a
  // map read, not a vault scan. Only the metadata stamp counts as a reference;
  // a [[link]] typed into a note body is surfaced as a 'mention' (spec D8).
  _backlinkSources(targetPath) {
    const out = [];
    const rl = this.app.metadataCache.resolvedLinks || {};
    for (const src of Object.keys(rl)) { if (rl[src] && rl[src][targetPath]) out.push(src); }
    return out;
  }

  entityReferences(entityFolderPath) {
    const notePath = this.entityNotePath(entityFolderPath);
    const entityName = entityFolderPath.slice(entityFolderPath.lastIndexOf('/') + 1);
    const tree = this.taxonomy();
    const byFolder = new Map();
    const walk = (n) => { byFolder.set(n.path, n); (n.children || []).forEach(walk); };
    tree.forEach(walk);

    const sites = [], work = [], notes = [];
    const seen = new Set();

    for (const src of this._backlinkSources(notePath)) {
      const { folder, role } = docContainer.stampSourceFolder(src);
      if (seen.has(folder + '|' + role)) continue;
      seen.add(folder + '|' + role);
      const f = this.app.vault.getAbstractFileByPath(src);
      const fm = (f && (this.app.metadataCache.getFileCache(f) || {}).frontmatter) || {};
      const stamp = docContainer.entityStampKind(fm, entityName);
      const node = byFolder.get(folder);
      const name = folder.slice(folder.lastIndexOf('/') + 1);

      if (role === 'entity-note') {
        if (node && node.kind === 'site' && stamp === 'organization') {
          sites.push({ path: folder, name, rec: this.readEntityRecord(folder) });
        }
        continue;
      }
      if (node && node.kind === 'note') {
        notes.push({
          path: folder, name,
          title: fm.title || name,
          noteType: fm.noteType || 'General',
          noteDate: fm.noteDate || '',
          rowType: folder.startsWith(entityFolderPath + '/') ? 'organizational' : (stamp ? 'stamped' : 'mention'),
          parentTitle: this._parentDisplayTitle((Array.isArray(fm.relatedParents) ? fm.relatedParents[0] : '') || ''),
        });
        continue;
      }
      if (!stamp) continue;   // documents and projects join Work only on a stamp
      if (role === 'project-md') {
        work.push({ path: folder, name, kind: 'project', title: fm.projectName || name,
                    docClass: 'Project', status: fm.status || '', nextReviewDate: '', stamp });
      } else if (role === 'document-md' || role === 'sidecar') {
        work.push({ path: folder, name, kind: 'document', title: fm.title || name,
                    docClass: fm.docClass || '', status: fm.status || '',
                    nextReviewDate: fm.nextReviewDate
                      || docContainer.computeNextReview(fm.effectiveDate, fm.reviewFrequencyDays) || '',
                    stamp });
      }
    }

    // Organizational notes live inside the folder and may carry no link at all.
    const own = byFolder.get(entityFolderPath);
    for (const child of ((own && own.children) || [])) {
      if (child.kind !== 'note') continue;
      if (notes.some((n) => n.path === child.path)) continue;
      const dm = this.app.vault.getAbstractFileByPath(child.path + '/' + docContainer.DOCUMENT_MD_NAME);
      const fm = (dm && (this.app.metadataCache.getFileCache(dm) || {}).frontmatter) || {};
      notes.push({ path: child.path, name: child.name, title: fm.title || child.name,
                   noteType: fm.noteType || 'General', noteDate: fm.noteDate || '',
                   rowType: 'organizational', parentTitle: '' });
    }

    const byDate = (a, b) => String(b.noteDate).localeCompare(String(a.noteDate));
    notes.sort(byDate);
    sites.sort((a, b) => a.name.localeCompare(b.name));
    work.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return { sites, work, notes };
  }
```

- [ ] **Step 2: Add the tab strip and panes**

In `ContainerOverviewView`, after `_saveEntityEdits`:

```js
  _entTabs(parent, node, type, rec) {
    const bar = parent.createDiv('doc-detail-tabs');
    const panes = parent.createDiv('doc-detail-panes');
    const refs = this.plugin.entityReferences(node.path);
    const isOrg = type === 'organization';
    const today = window.moment ? window.moment().format('YYYY-MM-DD') : new Date().toISOString().slice(0, 10);

    const specs = [];
    if (isOrg) specs.push({ id: 'esites', label: 'Sites', count: refs.sites.length, fill: (p) => this._entSitesPane(p, node, refs.sites) });
    specs.push({ id: 'ework', label: 'Work', count: refs.work.length, fill: (p) => this._entWorkPane(p, refs.work, today) });
    specs.push({ id: 'enotes', label: 'Notes', count: refs.notes.length, fill: (p) => this._entNotesPane(p, node, isOrg, refs.notes) });
    if (isOrg) specs.push({ id: 'eagree', label: 'Agreements & Procurements', fill: (p) => this._entAgreementsPane(p) });
    specs.push({ id: 'econtacts', label: 'Contacts', fill: (p) => this._entContactsPane(p) });

    const hasActive = specs.some((s) => s.id === this._entActiveTab);
    specs.forEach((spec, i) => {
      const tab = bar.createDiv('doc-detail-tabb');
      tab.setAttr('role', 'tab'); tab.setAttr('tabindex', '0');
      tab.createSpan({ text: spec.label });
      if (spec.count != null) tab.createSpan({ text: String(spec.count), cls: 'doc-detail-tabcnt' });
      const pane = panes.createDiv('doc-detail-tabpane');
      pane.setAttr('role', 'tabpanel');
      spec.fill(pane);
      const activate = () => {
        this._entActiveTab = spec.id;
        bar.querySelectorAll('.doc-detail-tabb').forEach((t) => { t.removeClass('is-active'); t.setAttr('aria-selected', 'false'); });
        panes.querySelectorAll('.doc-detail-tabpane').forEach((p) => p.removeClass('is-active'));
        tab.addClass('is-active'); tab.setAttr('aria-selected', 'true'); pane.addClass('is-active');
      };
      tab.onclick = activate;
      tab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
      if (hasActive ? spec.id === this._entActiveTab : i === 0) activate();
    });
    docTabsWrapGuard(bar);
  }

  _entRow(table, cells, onOpen, label) {
    const tr = table.createEl('tr', { cls: 'row' });
    cells.forEach((c) => tr.createEl('td', { text: c == null || c === '' ? '—' : String(c) }));
    tr.setAttr('tabindex', '0');
    tr.setAttr('aria-label', label);
    tr.onclick = onOpen;
    tr.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } };
    return tr;
  }

  _entSitesPane(p, node, sites) {
    const acts = p.createDiv('doc-detail-paneacts');
    const add = docIconLabel(acts, 'plus', 'New site', { tag: 'button', cls: 'doc-ov-primary' });
    add.style.marginBottom = '0';
    add.onclick = () => this.plugin.openNewSiteModal(node);
    if (!sites.length) {
      p.createDiv({ text: 'No sites yet. Use New site to add this organization’s first location.', cls: 'doc-detail-stub' });
      return;
    }
    const table = p.createEl('table', { cls: 'doc-ov-table' });
    const head = table.createEl('tr'); ['Site', 'Code', 'Type', 'City', 'Status'].forEach((h) => head.createEl('th', { text: h }));
    for (const s of sites) {
      this._entRow(table, [s.rec.name || s.name, s.rec.siteCode, s.rec.siteType, s.rec.city, s.rec.status],
        () => this.plugin.openContainerOverview({ path: s.path }), 'Open site ' + (s.rec.name || s.name));
    }
  }

  _entWorkPane(p, work, today) {
    if (!work.length) {
      p.createDiv({ text: 'No work attributed yet. Set Organization or Sites on a document or project to see it here.', cls: 'doc-detail-stub' });
      return;
    }
    const overdue = work.filter((w) => docContainer.isOverdue(w.nextReviewDate, today)).length;
    const roll = p.createDiv('doc-ov-rollup');
    roll.createSpan({ text: work.length + ' items', cls: 'doc-ov-pill' });
    if (overdue) roll.createSpan({ text: overdue + ' review overdue', cls: 'doc-ov-pill over' });
    const table = p.createEl('table', { cls: 'doc-ov-table' });
    const head = table.createEl('tr'); ['Title', 'Kind', 'Class', 'Status', 'Next review', 'Via'].forEach((h) => head.createEl('th', { text: h }));
    for (const w of work) {
      const via = w.stamp === 'organization' ? 'Organization' : 'Site';
      const tr = this._entRow(table, [w.title, w.kind === 'project' ? 'Project' : 'Document', w.docClass, w.status, w.nextReviewDate || '—', via],
        () => (w.kind === 'project' ? this.plugin.openContainerOverview({ path: w.path }) : this.plugin.openDocDetail({ path: w.path })),
        'Open ' + w.title);
      if (docContainer.isOverdue(w.nextReviewDate, today)) tr.addClass('doc-ent-overdue');
    }
  }

  _entNotesPane(p, node, isOrg, notes) {
    if (isOrg) {
      const acts = p.createDiv('doc-detail-paneacts');
      const add = docIconLabel(acts, 'plus', 'New organizational note', { tag: 'button', cls: 'doc-ov-primary' });
      add.style.marginBottom = '0';
      add.onclick = () => this.plugin.createOrganizationalNote(node);
    }
    if (!notes.length) {
      p.createDiv({ text: 'No notes yet. Notes written on documents and projects appear here when they name this record.', cls: 'doc-detail-stub' });
      return;
    }
    const table = p.createEl('table', { cls: 'doc-ov-table' });
    const head = table.createEl('tr'); ['Note', 'Type', 'Date', 'Source', 'Kind'].forEach((h) => head.createEl('th', { text: h }));
    const kindWord = { organizational: 'This record', stamped: 'Attributed', mention: 'Mention' };
    for (const n of notes) {
      const tr = this._entRow(table, [n.title, n.noteType, n.noteDate, n.parentTitle || '—', kindWord[n.rowType]],
        () => this.plugin.openNoteInEditor({ path: n.path }), 'Open note ' + n.title);
      tr.addClass('doc-ent-note-' + n.rowType);
    }
  }
```

- [ ] **Step 3: Rebuild rollups when the link index settles**

In `ContainerOverviewView.onOpen` (beside the existing `metadataCache.on('changed')` registration at 5383), add:

```js
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (docContainer.ENTITY_TYPES.includes(this.plugin.resolveContainerType({ path: this.path }))) this.render();
    }));
```

- [ ] **Step 4: Verify the load-bearing assumption before trusting the pane**

The rollup depends on a quoted wikilink in **frontmatter** appearing in `resolvedLinks` (spec §9). Observe it, don't assume it.

Hand-edit `Documents/Governance/.../<a document>/_document.md` (or its current sidecar) to add:
```yaml
organization: "[[Baycrest]]"
```

Then in the Obsidian console (Ctrl+Shift+I):
```js
Object.entries(app.metadataCache.resolvedLinks)
  .filter(([, links]) => Object.keys(links).some(t => t.endsWith('Baycrest.md')))
```
Expected: the edited file appears in the result. If it does NOT, stop and report — the rollup design needs `getBacklinksForFile` or a frontmatter scan instead, and every later task in this rung depends on the answer.

- [ ] **Step 5: Drill the panes**

Open Organizations › Baycrest.
Expected: Work tab lists the stamped document with Via = Organization; Sites tab shows the empty state with a New site button; Notes tab shows its empty state. Tab strip is keyboard-operable and each tab reports `aria-selected`.

- [ ] **Step 6: Bump version, deploy, commit**

```bash
# manifest.json: version -> 0.1.32
git add main.js manifest.json
git commit -m "feat(entities): backlink rollups — Sites, Work and consolidated Notes panes"
```

---

### Task 7: Runtime — Agreements & Procurements and Contacts placeholders

**Files:**
- Modify: `main.js` — pane methods in `ContainerOverviewView` after `_entNotesPane`; `DOC_CONTAINER_CSS` (708)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `_entTabs` (Task 6)
- Produces: `_entAgreementsPane(p)`, `_entContactsPane(p)`

- [ ] **Step 1: Implement the placeholder panes**

```js
  // Placeholder panes. Sample rows are rendered in the error colour AND labelled
  // "SAMPLE" — colour is never the only signal that this is not real data.
  _entPlaceholderTable(p, intro, headers, rows) {
    const banner = p.createDiv('doc-ent-sample-banner');
    banner.setAttr('role', 'note');
    banner.createSpan({ text: 'SAMPLE — not real data', cls: 'doc-ent-sample-tag' });
    banner.createSpan({ text: intro });
    const table = p.createEl('table', { cls: 'doc-ov-table doc-ent-sample' });
    const head = table.createEl('tr'); headers.forEach((h) => head.createEl('th', { text: h }));
    for (const r of rows) {
      const tr = table.createEl('tr');
      r.forEach((cell) => tr.createEl('td', { text: cell }));
    }
  }

  _entAgreementsPane(p) {
    this._entPlaceholderTable(p,
      'Contracts, quotes and invoices will be uploaded and tracked here once the Agreements work lands.',
      ['Document', 'Kind', 'Value', 'Starts', 'Expires', 'Owner'],
      [['Managed Services Agreement', 'Contract', '$120,000/yr', '2026-01-01', '2028-12-31', 'Procurement'],
       ['Camera refresh — Phase 2', 'Quote', '$48,500', '2026-05-14', '2026-08-14', 'Security'],
       ['INV-20260430', 'Invoice', '$10,000', '2026-04-30', '—', 'Finance']]);
  }

  _entContactsPane(p) {
    this._entPlaceholderTable(p,
      'People and their contact details will live here once Contacts becomes a real folder.',
      ['Name', 'Title', 'Role', 'Phone', 'Email'],
      [['A. Sample', 'Account Manager', 'Primary contact', '000-000-0000', 'sample@example.com'],
       ['B. Sample', 'Service Lead', 'Escalation', '000-000-0000', 'sample@example.com']]);
  }
```

- [ ] **Step 2: Add the placeholder CSS**

In the `DOC_CONTAINER_CSS` template literal:

```css
.doc-ent-sample-banner { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  padding: 8px 12px; border: 1px dashed var(--text-error); border-radius: 6px;
  color: var(--text-muted); font-size: 0.9em; }
.doc-ent-sample-tag { color: var(--text-error); font-weight: 600; letter-spacing: 0.02em;
  white-space: nowrap; }
.doc-ent-sample td { color: var(--text-error); font-style: italic; }
.doc-ent-sample th { color: var(--text-muted); }
```

- [ ] **Step 3: Verify contrast and drill**

Deploy, reload, open the Agreements & Procurements and Contacts tabs in **both** Obsidian light and dark themes.
Expected: sample rows legible in both, the "SAMPLE — not real data" tag visible before the table, no interactive affordances on the sample rows.

Check contrast of `--text-error` on `--background-primary` in DevTools for both themes.
Expected: ≥ 4.5:1. If a theme fails, add `font-weight: 500` and re-check at the large-text 3:1 threshold, or fall back to `--text-muted` text with the error-coloured tag carrying the signal.

- [ ] **Step 4: Bump version, deploy, commit**

```bash
# manifest.json: version -> 0.1.33
git add main.js manifest.json
git commit -m "feat(entities): Agreements and Contacts placeholder panes"
```

---

### Task 8: Stamp schema and the document detail fields

**Files:**
- Modify: `lib/doc-container.js` — `DOC_FIELDS.phase1`, `DOC_LEVEL_KEYS`
- Test: `lib/doc-container.test.js`
- Modify: `main.js` — `DocumentDetailView._renderMeta` (4475), `_valCell` (4496), `_saveMetaEdits` (4610)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `entityLink`, `entityLinkName`, `parseEntityListInput` (Task 2); `plugin.entityFolders`, `openEntityByName` (Tasks 3, 5)
- Produces:
  - `DOC_FIELDS.phase1` gains `{ key:'organization', type:'entity' }` and `{ key:'sites', type:'entities' }`
  - `DOC_LEVEL_KEYS` gains `'organization'`, `'sites'`
  - `plugin.entityNamesByType(type) → string[]` — for the picker datalist

- [ ] **Step 1: Write the failing tests**

```js
test('DOC_FIELDS carries the organization and sites stamp fields', () => {
  const byKey = {}; for (const f of dc.DOC_FIELDS.phase1) byKey[f.key] = f;
  assert.strictEqual(byKey.organization.type, 'entity');
  assert.strictEqual(byKey.sites.type, 'entities');
});

test('organization and sites are document-level keys, not version keys', () => {
  assert.ok(dc.DOC_LEVEL_KEYS.includes('organization'));
  assert.ok(dc.DOC_LEVEL_KEYS.includes('sites'));
  const part = dc.partitionFrontmatter({ organization: '[[Baycrest]]', sites: ['[[Terraces]]'], created: 'x' });
  assert.deepStrictEqual(Object.keys(part.docLevel).sort(), ['organization', 'sites']);
  assert.deepStrictEqual(Object.keys(part.versionLevel), ['created']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'type')`.

- [ ] **Step 3: Extend the schema**

In `lib/doc-container.js`, in `DOC_FIELDS.phase1`, insert after the `department` entry:

```js
    { key:'organization',    label:'Organization',     type:'entity' },
    { key:'sites',           label:'Sites',            type:'entities' },
```

In `DOC_LEVEL_KEYS`, add to the line holding `'department'`:

```js
  'originator', 'originatorTitle', 'originationDate', 'effectiveDate',
  'organization', 'sites',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS.

- [ ] **Step 5: Render the fields on the document detail page**

In `main.js`, `_renderMeta` (4475), change the Classification group:

```js
      ['Classification & Status', ['revision', 'status', 'department', 'originator']],
      ['Attribution', ['organization', 'sites']],
```

(insert the Attribution row directly after Classification & Status, before Lifecycle).

In `_valCell` (4496), add entity handling. In the `span2` line:

```js
    if (f.type === 'textarea' || f.key === 'title' || f.key === 'tags' || f.type === 'entities') cell.addClass('span2');
```

In the edit branch, before `let inp;`, add a dedicated path:

```js
      if (f.type === 'entity' || f.type === 'entities') {
        const isMulti = f.type === 'entities';
        const raw = fm[f.key];
        const seedE = isMulti
          ? (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map((x) => docContainer.entityLinkName(x)).filter(Boolean).join(', ')
          : (docContainer.entityLinkName(raw) || '');
        const inpE = cell.createEl('input', { cls: 'doc-detail-vinput' });
        inpE.value = seedE;
        inpE.spellcheck = false;
        inpE.placeholder = isMulti ? 'comma-separated site names' : 'organization name';
        const listId = 'doc-ent-list-' + f.key;
        inpE.setAttr('list', listId);
        const dl = cell.createEl('datalist'); dl.id = listId;
        for (const nm of this.plugin.entityNamesByType(isMulti ? 'site' : 'organization')) dl.createEl('option', { value: nm });
        this._mdInputs[f.key] = { inp: inpE, orig: seedE, field: f };
        return;
      }
```

In the view branch, before the `if (f.key === 'tags')` block, add:

```js
    if (f.type === 'entity' || f.type === 'entities') {
      const raw = fm[f.key];
      const names = (f.type === 'entities' ? (Array.isArray(raw) ? raw : (raw ? [raw] : [])) : [raw])
        .map((x) => docContainer.entityLinkName(x)).filter(Boolean);
      if (!names.length) { cell.createDiv({ text: '—', cls: 'doc-detail-val doc-detail-muted' }); return; }
      const box = cell.createDiv('doc-detail-val');
      names.forEach((nm) => {
        const b = box.createEl('button', { text: nm, cls: 'doc-ent-link' });
        b.onclick = () => this.plugin.openEntityByName(nm);
      });
      return;
    }
```

In `_saveMetaEdits` (4620 mutator), add the conversion before the `else if (field.type === 'number')` branch:

```js
          if (k === 'tags') front.tags = v.split(/[,\s]+/).map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
          else if (field.type === 'entities') {
            const list = docContainer.parseEntityListInput(v);
            if (list.length) front.sites = list; else delete front.sites;
          }
          else if (field.type === 'entity') {
            const nm = docContainer.entityLinkName(v);
            if (nm) front[k] = docContainer.entityLink(nm); else delete front[k];
          }
          else if (field.type === 'number') front[k] = v === '' ? null : Number(v);
          else front[k] = v === '' ? null : v;
```

- [ ] **Step 6: Add the picker source**

On the plugin class, after `openEntityByName`:

```js
  // Display names of every entity of a type — the datalist source for pickers.
  entityNamesByType(type) {
    const out = [];
    for (const [folder, t] of this.entityFolders()) {
      if (t !== type) continue;
      out.push(folder.slice(folder.lastIndexOf('/') + 1));
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
```

- [ ] **Step 7: Verify by drill**

Run: `node --check main.js` and `node --test lib/doc-container.test.js` — expect clean.

Deploy, reload, open a document's detail page, click Edit.
Expected: an Attribution group with Organization and Sites inputs; typing in Organization offers `Baycrest` from the datalist; Save writes `organization: "[[Baycrest]]"` to the record. Verify on disk. Then open the organization page: the document appears in Work.

- [ ] **Step 8: Bump version, deploy, commit**

```bash
node scripts/inline-doc-container.js
git add lib/doc-container.js lib/doc-container.test.js main.js manifest.json
git commit -m "feat(entities): organization/sites stamp on the document schema and detail page"
```

---

### Task 9: Stamp fields on the project view and the note card

**Files:**
- Modify: `main.js` — `renderProjectView` (5472) Identification group, `_saveProjEdits` (5575); `ContainerNoteView._renderCard` (3701+), `_setNoteField` (3682)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `entityNamesByType`, `openEntityByName` (Task 8); `entityLink`, `entityLinkName`, `parseEntityListInput` (Task 2)
- Produces: no new exports — the stamp keys now exist on `_project.md` and on note skeletons

- [ ] **Step 1: Add the project fields**

In `renderProjectView`, the editing branch of the Identification grid, after the `fld(grid, 'Department', 'department', 'text');` line:

```js
      fld(grid, 'Organization', 'organization', 'entity');
      fld(grid, 'Sites', 'sites', 'entities', null, true);
```

In the same function's `fld` helper, add entity handling before the final `else`:

```js
      else if (type === 'entity' || type === 'entities') {
        inp = cell.createEl('input', { cls: 'doc-detail-vinput' });
        inp.spellcheck = false;
        inp.placeholder = type === 'entities' ? 'comma-separated site names' : 'organization name';
        const listId = 'doc-pj-list-' + key;
        inp.setAttr('list', listId);
        const dl = cell.createEl('datalist'); dl.id = listId;
        for (const nm of this.plugin.entityNamesByType(type === 'entities' ? 'site' : 'organization')) dl.createEl('option', { value: nm });
        inp.value = seed;
      }
```

In `_pjSeed`, add the entity cases before the final return:

```js
    if (key === 'organization') return docContainer.entityLinkName(pn.organization) || '';
    if (key === 'sites') {
      const raw = pn.sites;
      return (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map((x) => docContainer.entityLinkName(x)).filter(Boolean).join(', ');
    }
```

In the view branch of Identification, after `kv('Dept', pn.department);`:

```js
      kv('Organization', docContainer.entityLinkName(pn.organization) || '');
      kv('Sites', (Array.isArray(pn.sites) ? pn.sites : (pn.sites ? [pn.sites] : []))
        .map((x) => docContainer.entityLinkName(x)).filter(Boolean).join(', '));
```

In `_saveProjEdits`, inside the write mutator where each changed key is applied, add the entity conversions before the generic assignment:

```js
        if (k === 'organization') {
          const nm = docContainer.entityLinkName(v);
          if (nm) fm.organization = docContainer.entityLink(nm); else delete fm.organization;
          continue;
        }
        if (k === 'sites') {
          const list = docContainer.parseEntityListInput(v);
          if (list.length) fm.sites = list; else delete fm.sites;
          continue;
        }
```

- [ ] **Step 2: Add the note card rows**

In `ContainerNoteView._renderCard`, after the single-parent slot block, add an attribution row:

```js
    // Attribution (spec §4.3) — human-owned, preserved by the skeleton writer.
    const attrRow = grid.createDiv('doc-note-cardrow');
    const orgCell = attrRow.createDiv('doc-note-cardfld');
    const orgLab = orgCell.createEl('label', { text: 'ORGANIZATION', cls: 'doc-detail-lab' });
    orgLab.htmlFor = 'note-org';
    const orgInp = orgCell.createEl('input', { cls: 'doc-detail-vinput', attr: { id: 'note-org', list: 'note-org-list' } });
    orgInp.spellcheck = false;
    orgInp.value = docContainer.entityLinkName(fm.organization) || '';
    const orgDl = orgCell.createEl('datalist'); orgDl.id = 'note-org-list';
    for (const nm of this.plugin.entityNamesByType('organization')) orgDl.createEl('option', { value: nm });
    orgInp.onchange = async () => {
      const nm = docContainer.entityLinkName(orgInp.value);
      await this._setNoteField('organization', nm ? docContainer.entityLink(nm) : null);
      this._renderCard({ organization: nm ? docContainer.entityLink(nm) : null });
    };

    const siteCell = attrRow.createDiv('doc-note-cardfld');
    const siteLab = siteCell.createEl('label', { text: 'SITES', cls: 'doc-detail-lab' });
    siteLab.htmlFor = 'note-sites';
    const siteInp = siteCell.createEl('input', { cls: 'doc-detail-vinput', attr: { id: 'note-sites', list: 'note-sites-list' } });
    siteInp.spellcheck = false;
    siteInp.placeholder = 'comma-separated';
    siteInp.value = (Array.isArray(fm.sites) ? fm.sites : (fm.sites ? [fm.sites] : []))
      .map((x) => docContainer.entityLinkName(x)).filter(Boolean).join(', ');
    const siteDl = siteCell.createEl('datalist'); siteDl.id = 'note-sites-list';
    for (const nm of this.plugin.entityNamesByType('site')) siteDl.createEl('option', { value: nm });
    siteInp.onchange = async () => {
      const list = docContainer.parseEntityListInput(siteInp.value);
      await this._setNoteField('sites', list.length ? list : null);
      this._renderCard({ sites: list });
    };
```

If `_setNoteField` deletes keys on null, no change is needed; if it writes `null`, add a delete branch there so an emptied field leaves no dangling key.

- [ ] **Step 3: Protect the stamp from the skeleton writer**

Open `updateNoteSkeleton` (around line 9072). Confirm it writes only `title`, `tags` and `links` through `processFrontMatter` and never rebuilds the whole frontmatter object. Add a comment naming the invariant:

```js
      // Human-owned keys (summary, noteType, noteDate, people, organization,
      // sites, relatedParents) are NEVER touched here — this writer owns
      // title/tags/links only.
```

If it does rebuild wholesale, stop and report before continuing — that would silently drop the stamp on every autosave.

- [ ] **Step 4: Verify by drill**

Deploy, reload.
Expected: a project's Edit form has Organization and Sites with working datalists and persists both; a container note's card has the two fields, persists them, and typing in the body then waiting 6 seconds for autosave leaves both intact.

Confirm the autosave case explicitly on disk — this is the one that would fail silently:
```powershell
Get-Content "C:\Obsidian\OB_Testing\Documents\...\<note folder>\_document.md"
```

- [ ] **Step 5: Bump version, deploy, commit**

```bash
git add main.js manifest.json
git commit -m "feat(entities): stamp fields on the project view and the note card"
```

---

### Task 10: Pre-fill attribution at the creation choke points

**Files:**
- Modify: `main.js` — new plugin helper; `createDocumentInContainer` (8800), `createPendingDocument` (8886), `createNoteContainer` (9082)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `plugin.readEntityRecord` (Task 4), `plugin.readProjectNote` (existing)
- Produces: `plugin.containerStamp(containerPath) → { organization?, sites? }`

Spec D7: items are stamped at creation from their container, not resolved at read time.

- [ ] **Step 1: Add the resolver**

```js
  // Attribution a new item inherits from where it is being created. Walks up to
  // the nearest ancestor carrying a stamp (project note or entity record).
  // Stamped, not inherited — the value is copied onto the new item (spec D7).
  containerStamp(containerPath) {
    const root = (this.settings.docRoot || 'Documents').replace(/\/+$/, '');
    let p = containerPath;
    while (p && p.startsWith(root)) {
      const pn = this.app.vault.getAbstractFileByPath(p + '/_project.md');
      if (pn) {
        const fm = (this.app.metadataCache.getFileCache(pn) || {}).frontmatter || {};
        if (fm.organization || fm.sites) {
          const out = {};
          if (fm.organization) out.organization = fm.organization;
          if (fm.sites) out.sites = Array.isArray(fm.sites) ? fm.sites.slice() : [fm.sites];
          return out;
        }
      }
      const rec = this.readEntityRecord(p);
      if (rec && rec.type === 'organization' && rec.name) return { organization: docContainer.entityLink(rec.name) };
      if (rec && rec.type === 'site' && rec.name) {
        const out = { sites: [docContainer.entityLink(rec.name)] };
        if (rec.organization) out.organization = rec.organization;
        return out;
      }
      if (p === root) break;
      p = p.slice(0, p.lastIndexOf('/'));
    }
    return {};
  }
```

- [ ] **Step 2: Apply it in `createDocumentInContainer`**

In the sidecar seeding block (after `if (!front.title) front.title = cleanTitle;`):

```js
          const stamp = this.containerStamp(containerPath);
          if (stamp.organization && !front.organization) front.organization = stamp.organization;
          if (stamp.sites && !front.sites) front.sites = stamp.sites;
```

- [ ] **Step 3: Apply it in `createPendingDocument`**

Find the `processFrontMatter` call that seeds the pending marker sidecar and add the same three lines inside it, using the same `containerPath` variable in scope.

- [ ] **Step 4: Apply it in `createNoteContainer`**

In the YAML string built at line 9123, after the `noteDate` line:

```js
        + (stamp.organization ? 'organization: ' + JSON.stringify(stamp.organization) + '\n' : '')
        + (stamp.sites && stamp.sites.length
            ? 'sites:\n' + stamp.sites.map((s) => '  - ' + JSON.stringify(s)).join('\n') + '\n' : '')
```

and above the `const yaml = ` line:

```js
      const stamp = this.containerStamp(parent);
```

- [ ] **Step 5: Verify by drill**

Deploy, reload. Stamp a project with Organization = Baycrest. Create a document inside that project, and a note on that document.
Expected: both new items already carry `organization: "[[Baycrest]]"` with no manual entry, and both appear in Baycrest's rollups.

- [ ] **Step 6: Bump version, deploy, commit**

```bash
git add main.js manifest.json
git commit -m "feat(entities): pre-fill attribution from the container at creation"
```

---

### Task 11: New site from the organization page

**Files:**
- Modify: `main.js` — plugin method; `EntityCreateModal` reuse (Task 4)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `createEntity` (Task 4), `EntityCreateModal` (Task 4)
- Produces: `plugin.openNewSiteModal(orgNode)` — referenced by `_entSitesPane` (Task 6)

- [ ] **Step 1: Implement the flow**

```js
  // A site is created FROM an organization page but STORED in the Sites
  // category (spec §8). The owning organization is stamped at creation.
  openNewSiteModal(orgNode) {
    const rec = this.readEntityRecord(orgNode.path);
    const orgName = rec.name || orgNode.path.slice(orgNode.path.lastIndexOf('/') + 1);
    new EntityCreateModal(this.app, {
      type: 'site',
      orgName,
      onSubmit: async ({ name, siteType, address }) => {
        const seed = { organization: docContainer.entityLink(orgName) };
        if (siteType) seed.siteType = siteType;
        if (address) seed.address = address;
        const folder = await this.createEntity({ type: 'site', name, seed });
        if (folder) {
          this.app.workspace.getLeavesOfType(VIEW_TYPE_DOC_CONTAINER)
            .forEach((l) => l.view && l.view.render && l.view.render());
        }
      },
    }).open();
  }
```

The organization page stays open and its Sites tab repaints — creating a site is not a navigation.

- [ ] **Step 2: Verify by drill**

Deploy, reload, open Organizations › Baycrest → Sites → New site. Create `Apotex Centre`, type Long-Term Care.
Expected: `Documents/Sites/Apotex Centre/Apotex Centre.md` on disk with `organization: "[[Baycrest]]"`; the row appears in Baycrest's Sites tab without a reload; the Document Browser shows it under Sites, not under Organizations.

Verify on disk:
```powershell
Get-Content "C:\Obsidian\OB_Testing\Documents\Sites\Apotex Centre\Apotex Centre.md"
```

Then open the site page.
Expected: no Sites tab, no Agreements tab, no create buttons anywhere; Organization field shows Baycrest and clicking it opens the organization.

- [ ] **Step 3: Bump version, deploy, commit**

```bash
git add main.js manifest.json
git commit -m "feat(entities): create a site from its organization page"
```

---

### Task 12: New organizational note

**Files:**
- Modify: `main.js` — plugin method beside `createNoteContainer` (9082)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: `createNoteContainer` (existing), `readEntityRecord` (Task 4), `containerStamp` (Task 10)
- Produces: `plugin.createOrganizationalNote(orgNode)` — referenced by `_entNotesPane` (Task 6)

- [ ] **Step 1: Implement**

```js
  // An organizational note belongs to the organization rather than to any one
  // document: it lives INSIDE the organization folder and carries no
  // relatedParents (spec §7.3). containerStamp supplies the organization link.
  async createOrganizationalNote(orgNode) {
    const rec = this.readEntityRecord(orgNode.path);
    const orgName = rec.name || orgNode.path.slice(orgNode.path.lastIndexOf('/') + 1);
    new NoteCreateModal(this.app, { defaultType: 'General', types: docContainer.NOTE_TYPES, askTitle: true },
      async (title, noteType) => {
        const folder = await this.createNoteContainer({ containerPath: orgNode.path, title, noteType });
        if (folder) dlog('organizational note created for', orgName, folder);
      }).open();
  }
```

No extra stamping call is needed: `createNoteContainer` already runs `containerStamp(parent)` from Task 10, and the parent here is the organization folder, whose record supplies the organization link.

- [ ] **Step 2: Verify by drill**

Deploy, reload, open Baycrest → Notes → New organizational note. Title it `Vendor performance 2026`.
Expected: the note editor opens; the folder is `Documents/Organizations/Baycrest/Vendor performance 2026/`; its `_document.md` carries `organization: "[[Baycrest]]"` and no `relatedParents`; the Notes tab lists it with Kind = "This record".

Confirm the org page still renders as an organization (not demoted to a collection by its new note child) — this is the Task 1 kind-override working end to end.

- [ ] **Step 3: Bump version, deploy, commit**

```bash
git add main.js manifest.json
git commit -m "feat(entities): create an organizational note on an organization"
```

---

### Task 13: Creation guards — refuse documents inside entity folders

**Files:**
- Modify: `lib/doc-container.js` — pure predicate
- Test: `lib/doc-container.test.js`
- Modify: `main.js` — `createDocumentInContainer` (8800), `createPendingDocument` (8886), `openNewDocumentModal` (8717), `renderDocs` (5850), `_projDocsPane` (5668)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: nothing new
- Produces: `underEntityCategory(path, root, categories) → boolean`

Spec §8: creation is refused at the choke point, not merely hidden.

- [ ] **Step 1: Write the failing tests**

```js
test('underEntityCategory: true inside the entity categories, false elsewhere', () => {
  const cats = ['Organizations', 'Sites'];
  assert.strictEqual(dc.underEntityCategory('Documents/Organizations/Baycrest', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Sites/Terraces/Sub', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Organizations', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Governance/Policy', 'Documents', cats), false);
  assert.strictEqual(dc.underEntityCategory('Documents/OrganizationsExtra/X', 'Documents', cats), false);
  assert.strictEqual(dc.underEntityCategory('', 'Documents', cats), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.underEntityCategory is not a function`.

- [ ] **Step 3: Implement the predicate**

In `lib/doc-container.js`, after `entityNoteName`:

```js
// True when `path` is the entity category itself or anything beneath it.
// Guards document creation: entity folders are records, not filing cabinets.
function underEntityCategory(path, root, categories) {
  const p = String(path || '');
  if (!p) return false;
  const base = String(root || '').replace(/\/+$/, '');
  for (const cat of (categories || [])) {
    const c = base + '/' + cat;
    if (p === c || p.startsWith(c + '/')) return true;
  }
  return false;
}
```

Export it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS.

- [ ] **Step 5: Enforce at the choke points**

On the plugin class:

```js
  // One place answers "may a document be created here?" — every creation path
  // asks it, so hiding a button is never the only thing standing in the way.
  _refuseIfEntityScope(containerPath) {
    const cats = [this.settings.docOrgCategory || 'Organizations', this.settings.docSiteCategory || 'Sites'];
    if (!docContainer.underEntityCategory(containerPath, this.settings.docRoot, cats)) return false;
    new obsidian.Notice('Organizations and Sites hold records, not documents. Create this in a Governance, Projects or SOP container instead.');
    return true;
  }
```

Add as the first line of `createDocumentInContainer`:
```js
    if (this._refuseIfEntityScope(containerPath)) return;
```

Add as the first line of `createPendingDocument`:
```js
    if (this._refuseIfEntityScope(containerPath)) return;
```

Add to `openNewDocumentModal`, after the existing null check:
```js
    if (this._refuseIfEntityScope(node.path)) return;
```

- [ ] **Step 6: Hide the affordances too**

In `ContainerOverviewView.renderDocs` (5850), before creating the New Document button:

```js
    const cats = [this.plugin.settings.docOrgCategory || 'Organizations', this.plugin.settings.docSiteCategory || 'Sites'];
    const entityScope = docContainer.underEntityCategory(node.path, this.plugin.settings.docRoot, cats);
    if (!entityScope) {
      const btn = docIconLabel(c, 'plus', 'New Document', { tag: 'button', cls: 'doc-ov-primary' });
      btn.onclick = () => this.plugin.openNewDocumentModal(node);
    }
```

In `renderContainers` (5833), suppress "New Collection" the same way when `node.path` is an entity category, so the Organizations page offers no folder-creation path that bypasses `createEntity`. Instead render a "New organization" button there:

```js
    const cats = [this.plugin.settings.docOrgCategory || 'Organizations', this.plugin.settings.docSiteCategory || 'Sites'];
    if (docContainer.underEntityCategory(node.path, this.plugin.settings.docRoot, cats)) {
      const isOrgCat = node.path.endsWith('/' + (this.plugin.settings.docOrgCategory || 'Organizations'));
      if (isOrgCat) {
        const nb = docIconLabel(c, 'plus', 'New organization', { tag: 'button', cls: 'doc-ov-primary' });
        nb.onclick = () => new EntityCreateModal(this.app, {
          type: 'organization',
          onSubmit: async ({ name }) => {
            const folder = await this.plugin.createEntity({ type: 'organization', name });
            if (folder) await this.plugin.openContainerOverview({ path: folder });
          },
        }).open();
      } else {
        c.createDiv({ text: 'Sites are created from an organization’s Sites tab.', cls: 'doc-detail-stub' });
      }
    } else {
      const btn = docIconLabel(c, 'plus', `New ${kindLabel}`, { tag: 'button', cls: 'doc-ov-primary' });
      btn.onclick = () => this.promptNew(node.path, kindLabel);
    }
```

In `_projDocsPane` (5668) no change is needed — projects never live under an entity category.

- [ ] **Step 7: Verify by drill**

Deploy, reload.
Expected: the Organizations category page offers New organization and no New Collection; the Sites category page explains where sites come from; an organization page and a site page offer no document creation; running the command palette's document-creation path against an entity container produces the refusal Notice and writes nothing.

- [ ] **Step 8: Bump version, deploy, commit**

```bash
node scripts/inline-doc-container.js
git add lib/doc-container.js lib/doc-container.test.js main.js manifest.json
git commit -m "feat(entities): refuse document creation inside entity categories"
```

---

### Task 14: CSS, design unification pass, and the rung ship gate

**Files:**
- Modify: `main.js` — `DOC_CONTAINER_CSS` (708)
- Modify: `manifest.json`

**Interfaces:**
- Consumes: everything above
- Produces: `.doc-ent-*` styles; a drilled, deployable v0.1

This task is not optional polish. Per-task CSS accretion caused a quality regression on P24 that Paul flagged; every UI rung ends with one unification pass.

- [ ] **Step 1: Add the entity styles**

In `DOC_CONTAINER_CSS`:

```css
/* ── Organizations & Sites ─────────────────────────────────────────────── */
.doc-ent-link { background: none; border: none; padding: 0 8px 0 0; margin: 0;
  color: var(--text-accent); cursor: pointer; font: inherit; text-align: left; }
.doc-ent-link:hover { text-decoration: underline; }
.doc-ent-link:focus-visible { outline: 2px solid var(--interactive-accent); outline-offset: 2px; border-radius: 3px; }

.doc-ent-flab { display: block; margin: 12px 0 4px; color: var(--text-muted);
  font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.02em; }
.doc-ent-owner { display: flex; align-items: baseline; gap: 8px; margin: 12px 0 4px; }

.doc-ov-table tr.row[tabindex]:focus-visible { outline: 2px solid var(--interactive-accent);
  outline-offset: -2px; }

.doc-ent-overdue td { color: var(--text-error); }
.doc-ent-note-mention td { color: var(--text-muted); font-style: italic; }

/* Touch: every row and control clears 44px on mobile */
@media (pointer: coarse) {
  .doc-ov-table td, .doc-ov-table th { padding-top: 12px; padding-bottom: 12px; }
  .doc-detail-tabb { min-height: 44px; display: flex; align-items: center; }
  .doc-ent-link { min-height: 44px; display: inline-flex; align-items: center; }
}
```

- [ ] **Step 2: Run the pre-delivery checklist**

Walk the ui-standards pre-delivery checklist against the organization page, the site page, and both modals. Fix what fails. Specifically confirm:

- contrast ≥ 4.5:1 for all new text in light AND dark themes;
- every interactive element reachable by keyboard with a visible focus ring;
- tab strip operable by Enter/Space and reporting `aria-selected`;
- table rows reachable by Tab and openable by Enter;
- every input has an associated `<label>`;
- empty states say what goes here and how to start;
- no `transition: all`, no `outline: none`, no `<div onclick>` outside the table-row pattern;
- the page holds up at a 250px sidebar width and at 200% zoom;
- one dominant element per view (the entity name), and no card nested inside a card.

- [ ] **Step 3: Full desktop drill**

Run every acceptance criterion for the rung (spec §14, items 1–6 and the parts of 10 that apply to v0.1):

1. Create an organization; create a site from it; confirm the site is stored under Sites.
2. Stamp a document, a project and a note; confirm each appears in the right tab within one refresh.
3. Confirm the organization page lists its sites and the site page has no Sites tab.
4. Attempt document creation inside an entity folder; confirm the refusal Notice and that nothing is written.
5. Type `[[Baycrest]]` into a note body with no stamp; confirm it appears in Notes as a Mention and NOT in Work.
6. Create an organizational note; confirm it lands inside the org folder and shows as "This record".

Record each result. Any failure stops the gate.

- [ ] **Step 4: Full test run**

Run: `node --test lib/doc-container.test.js`
Expected: PASS, with the new entity tests included in the count.

Run: `node --check main.js`
Expected: no output.

- [ ] **Step 5: Bump version, deploy, commit**

```bash
# manifest.json: version -> 0.1.40
git add main.js manifest.json
git commit -m "feat(entities): entity CSS, design unification pass, v0.1 ship gate"
```

- [ ] **Step 6: Hand back for the iPad pass**

Report to Paul: what drilled clean, what did not, and the outstanding iPad items — CM6 note card with the two new fields, the datalist pickers on touch, the tab strip at mobile width, and the entity modals. The iPad pass rides the existing container-notes session; it is not part of this rung's desktop gate.

---

## Self-Review

**Spec coverage (v0.1 rung only):**

| Spec section | Covered by |
|---|---|
| §4.1 Organization record | Task 1 (schema), Task 4 (creation), Task 5 (render/edit) |
| §4.2 Site record | Task 1, Task 4, Task 5, Task 11 |
| §4.3 The stamp | Task 8 (documents), Task 9 (projects, notes), Task 10 (pre-fill) |
| §5 Storage layout | Task 4 (`createEntity`), Task 11 (sites stored under Sites) |
| §6.1 Pure-core changes | Task 1 (entity detection, kind override), Task 2 (classification), Task 13 (scope predicate) |
| §6.2 Runtime type registry | Task 3 |
| §7.1 Organization page | Tasks 5, 6, 7 |
| §7.2 Site page | Task 5 (shared view), Task 6 (tab set excludes Sites/Agreements) |
| §7.3 Notes tab, three row types | Task 6 (`rowType`), Task 12 (organizational) |
| §7.4 Placeholder treatment | Task 7 |
| §8 Creation rules and guards | Tasks 11, 12, 13 |
| §9 Rollup resolution + verification probe | Task 6 (Step 4 is the probe) |
| §12 Phase D accessors | Task 4 (`readEntityRecord`/`writeEntityRecord`, named as the seam) |
| §13 Testing | Tasks 1, 2, 8, 13 (pure core); Task 14 (drill) |

Deferred to later rungs by design: §4.4 `organizationHistory`, §10 lifecycle, §11 backfill. Not gaps.

**Placeholder scan:** none — every step carries the code or the exact command and expected output.

**Type consistency check:**
- `buildTaxonomy(paths, root, entityFolders)` — third argument accepts `Map` or plain object; Task 1 tests both forms; Task 3 passes a `Map`.
- `entityFolders()` returns `Map<folderPath, type>`; consumed by `taxonomy()` (Task 3), `openEntityByName` (Task 5), `entityNamesByType` (Task 8) — all iterate `for (const [folder, t] of ...)` consistently.
- `stampSourceFolder` returns `{ folder, role }` in Task 2 and is destructured as `{ folder, role }` in Task 6.
- `entityStampKind` returns `'organization' | 'sites' | null`; Task 6 stores it as `stamp` and Task 6's Work pane maps it to the "Via" column — the field name is `sites` (plural) in both.
- `entityReferences` returns `{ sites, work, notes }`; `_entTabs` destructures the same three keys.
- `EntityCreateModal` `onSubmit` receives `{ name, siteType, address }` in Task 4 and is called with exactly those in Task 11.
- `openNewSiteModal` (Task 11) and `createOrganizationalNote` (Task 12) are referenced by `_entSitesPane` / `_entNotesPane` in Task 6 — forward references, resolved by the time the rung is drilled, but note that Task 6's panes will throw if drilled before Tasks 11–12 land. Drill Task 6 with the Sites/Notes create buttons untouched, or execute Tasks 11–12 before drilling Task 6's buttons.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-31-organizations-sites-v0.1.md`.
