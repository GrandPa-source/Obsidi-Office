# Doc-Container B1 — New Document flow (design)

Date: 2026-06-16
Branch: `doc-container`
Status: approved (Paul, 2026-06-16) — proceed to plan + implementation

## Problem

The Doc-Container "＋ New Document" buttons are stubs. Clicking either one shows
`new Notice('New Document flow — deferred to a follow-up (needs UX mock)')`:

- Collection page — `main.js` `renderDocs()` (≈ line 4013)
- Project view Documents tab — `main.js` `_projDocsPane()` (≈ line 3834)

You cannot create a new managed document from inside the plugin; you must drop
files into the vault by hand. This is the **B1** half of the create-side gap the
3rd opus review flagged. (B2 — making empty/scaffolded folders visible in the
tree — is explicitly out of scope and deferred.)

## Document model (confirmed from the real `Documents/` corpus)

A **document is a folder** named with its human title; the folder holds one or
more version files plus a sidecar:

```
Documents/Governance/Policies/Fan-Out Policy/      ← document (folder, title-named)
    FanOutPolicy_V1.0.docx … FanOutPolicy_V2.0.docx ← versions (PascalCase base + _V<maj>.<min>)
    FanOutPolicy_V2.0.docx.md                        ← sidecar (metadata)
    consultation-notes.txt                           ← attachment (stray file)
```

`buildTaxonomy()` treats a folder as a Document when it directly contains ≥1
managed office file. Therefore a *new* document must be its **own sub-folder**
inside the container — dropping a file directly into the Collection folder would
collapse the Collection itself into a Document node.

## Decisions (locked with Paul)

1. **Scope:** B1 only — New-Document flow. No empty-folder visibility, no
   sidebar-tree create entry, no New-Version changes. (B2 reassessed later.)
2. **Modal shape:** single self-contained modal — Title + format selector +
   per-format template grid + Create. (Not the tabbed-landing reuse, not the
   two-step variant.)
3. **Template selection:** reuse the existing template system — cards come from
   `_obsidi-office-templates/<ext>/`, with a "Blank" card always first (falls
   back to the embedded blank base64 when no template file exists).
4. **After create:** open the new document's **detail page**
   (`DocumentDetailView`) in view mode — NOT the editor. Container refreshes
   underneath. (Paul wants to add metadata before editing content.)

## Architecture

### Entry points (no new surface)

Both existing buttons get a real handler that passes the container node:

```js
btn.onclick = () => this.plugin.openNewDocumentModal(node);   // node.path = container folder
```

`node` is the Collection / Project container the button lives on.

### Modal — `NewDocumentModal extends obsidian.Modal`

Constructed with `(app, plugin, containerPath, containerLabel)`.

Layout (single screen):

```
┌─ New Document in “<containerLabel>” ─────────┐
│ Title:  [ Visitor Code of Conduct ]          │
│ Format: (●Document)( Presentation )( Sheet ) │
│ Template:                                     │
│   [📄 Blank] [📝 SOP] [📝 TOR] …             │
│                          [Cancel] [Create]    │
└───────────────────────────────────────────────┘
```

- Format = segmented control over `docx` / `pptx` / `xlsx` (default `docx`).
- Changing format re-renders the template grid for that extension.
- Template grid lists files under `_obsidi-office-templates/<ext>/` (basename →
  card), Blank first (path `""`). Selecting a card marks it active; Blank is
  selected by default.
- **Create** is enabled only when Title is non-empty and a template is selected.
- On Create: call `plugin.createDocumentInContainer(...)`, close the modal.

The modal is pure DOM (no `fs`), so it works on iPad. Styling reuses the
existing `.template-grid` / `.template-card` classes.

### Create logic — `plugin.createDocumentInContainer({ containerPath, title, ext, templatePath })`

Returns the created document-folder path (or `undefined` on failure).

1. `base = documentBaseName(title)` (pure-core; PascalCase, strip non-alnum;
   fallback `Document`).
2. Validate title: reject illegal path chars `\ / : * ? " < > |` → Notice, abort.
3. `docFolder = containerPath + '/' + title`. If it already exists → Notice
   `A document named "<title>" already exists here.`, abort.
4. `await vault.createFolder(docFolder)`.
5. `fileName = firstVersionName(base, ext)` (pure-core → `<base>_V1.0.<ext>`).
   `filePath = docFolder + '/' + fileName`.
6. Read template bytes when `templatePath` exists and is present on disk; else
   decode the embedded blank base64 for `ext`
   (`BLANK_DOCX_BASE64` / `BLANK_PPTX_BASE64` / `BLANK_XLSX_BASE64`).
7. `tfile = await vault.createBinary(filePath, buffer)` (iPad-safe registration,
   mirrors `_createFromTemplate`).
8. Seed sidecar:
   - `await this._autoCreateSidecar(tfile)` (writes `docx` link + `created` +
     `modified`).
   - `await fileManager.processFrontMatter(sidecar, front => { … })` to add, only
     when absent: `title` = human title, `status` = `'Draft'`,
     `originationDate` = today (`YYYY-MM-DD`).
9. After-create:
   - `await this.openDocDetail({ path: docFolder })` — detail view rebuilds the
     taxonomy (folder now holds a managed file → it resolves) and opens in view
     mode.
   - Refresh sidebar tree + open container overview:
     `getLeavesOfType(VIEW_TYPE_DOC_BROWSER)` and `VIEW_TYPE_DOC_CONTAINER`
     → `view.render()`.
   - `new Notice('Created "' + title + '"')`.

### Pure-core additions — `lib/doc-container.js`

```js
// Title → PascalCase file base. Strips non-alphanumeric; each space-delimited
// word gets its first char upper-cased, the rest preserved (so "SOP" stays
// "SOP"). Empty/punctuation-only input falls back to "Document".
function documentBaseName(title) { … }

// First-version filename for a fresh document.
function firstVersionName(base, ext) { return `${base}_V1.0.${ext}`; }
```

Both exported and unit-tested with `node --test`. **After editing the lib, run
`scripts/inline-doc-container.js`** to inline the pure-core into `main.js`
(the lib is not relative-required at runtime — iPad constraint).

Worked examples for `documentBaseName`:

| Title | Base |
|---|---|
| `Fan-Out Policy` | `FanOutPolicy` |
| `Code of Conduct` | `CodeOfConduct` |
| `Incident Reporting SOP` | `IncidentReportingSOP` |
| `  ` / `!!!` | `Document` |

## Error handling

- Empty title → Create disabled (no error path needed).
- Illegal path chars → Notice, abort before any vault write.
- Duplicate document folder → Notice, abort.
- `createFolder` / `createBinary` throw → caught, Notice
  `Could not create document: <message>`, abort. (Folder may be left behind on a
  mid-step failure; acceptable for B1 — user can delete it. No partial-rollback
  complexity.)

## Out of scope (non-goals)

- B2 empty/scaffolded folder visibility (taxonomy contract unchanged).
- Sidebar-tree right-click / `＋` create affordance.
- New-Version flow changes.
- Editing the modal's metadata inline before create (metadata is set on the
  detail page afterward — the chosen after-create behavior).
- Note (`.md`) documents — managed types are docx/pptx/xlsx only.

## Testing

**Pure-core (`node --test`):**
- `documentBaseName`: the four worked examples above + a hyphen/punctuation mix.
- `firstVersionName`: `('FanOutPolicy','docx')` → `FanOutPolicy_V1.0.docx`.

**Manual smoke (desktop + iPad):**
1. Collection page → New Document → Blank docx → lands on detail page, editor NOT
   launched; folder/file/sidecar layout correct; tree shows the new doc.
2. Project Documents tab → New Document → real template (pptx/xlsx) → same checks.
3. Duplicate title → rejected with Notice.
4. Title with illegal char → rejected with Notice.
5. Detail page → "Open in editor" still works for the new file.

## Files touched

- `lib/doc-container.js` — add `documentBaseName`, `firstVersionName` + exports.
- `lib/doc-container.test.*` (or existing test file) — unit tests.
- `main.js` — `NewDocumentModal` class; `openNewDocumentModal`,
  `createDocumentInContainer` plugin methods; wire the two button handlers; run
  inline script to refresh the embedded pure-core.
- Deploy `main.js` (+ manifest/styles if changed) to `OB_Testing`.
