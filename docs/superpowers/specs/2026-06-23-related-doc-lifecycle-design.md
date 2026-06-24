# Related-Document Lifecycle — New Related Document + Break Away

**Date:** 2026-06-23
**Branch:** `doc-container`
**Status:** Design approved, ready for implementation plan

## Problem

The Related Documents tab can link to existing files (folder-navigator Add link) and
attach dropped references, but there is no way to **create a net-new related document**
(e.g. meeting minutes) from within a document's context. Forcing the choice between a
heavyweight full doc-container document and a throwaway loose file up front is the wrong
trade-off.

This design adds a two-stage lifecycle:

1. **New Related Document** — create a *loose* office file with metadata, linked to the
   parent, in one step. Light by default.
2. **Break Away** — promote that loose file into a first-class sibling document (its own
   folder + versioning + check-out) when it earns it, carrying its metadata forward and
   keeping the relationship bidirectional.

Progressive disclosure: start light, graduate on demand.

## Taxonomy constraint (the governing fact)

`buildTaxonomy` (in `lib/doc-container.js`) treats **any folder containing ≥1 managed
office file as a document**. Consequences that shape this design:

- A loose office file placed in the **parent document's own folder** is classified by
  `groupDocumentFiles` as an **attachment** (not a version). It therefore appears in the
  parent's Files & Versions tab as an attachment — the same mechanism the existing
  drag-to-attach reference already uses. This is acceptable and consistent.
- A loose office file placed **directly in a container folder** would turn the container
  itself into a "document" — **not viable**.
- A document folder nested **inside another document folder** produces an irregular
  "document containing a document" tree the UI was not built for — **rejected**.

Therefore: loose files live in the **parent document's folder** (as attachments), and
break-away promotes them to a **sibling document under the same container**.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Break-away destination | **Sibling** in the same container (`parentOf(parentDocPath)`) |
| Parent link after break-away | **Re-point + reciprocal back-link** (bidirectional) |
| Break-away button location | **On the Related Documents entry, edit mode only** |
| Break-away gating | **Only plugin-created loose files** (sidecar `looseDoc: true`) |
| New-doc create UI | **Full `NewDocumentModal`** (title + format + template cards) |
| After create | **Open in editor**, with **Return to document** button → parent detail page |
| Format scope | docx / pptx / xlsx (no blank PDF) |

## Feature 1 — New Related Document

### Trigger
A **＋ New document** button in the Related Documents tab, **edit mode only**, beside the
*Add link* field.

### Flow
1. Open the existing **`NewDocumentModal`** (single screen: title field, format selector
   docx/pptx/xlsx, template-card grid reading `_obsidi-office-templates/<ext>/`, Blank
   first).
2. On **Create** → new helper `createLooseRelatedDoc({ parentDocPath, title, ext, templatePath })`:
   - Write `<parentDocPath>/<Title>.<ext>` — a **loose file in the parent document's own
     folder** (→ classified as an attachment) — from the chosen template bytes, or the
     embedded blank base64 (`BLANK_DOCX_BASE64` / `BLANK_PPTX_BASE64` / `BLANK_XLSX_BASE64`).
   - Seed sidecar `<…>.<ext>.md` via `processFrontMatter`: `title`, `status: Draft`,
     `originationDate`, `created`/`modified`, **and the marker `looseDoc: true`**.
   - Add the parent association in one `_mutateSidecar` transaction on the **parent's**
     current-version sidecar: push `relatedDocuments` entry
     `{ kind: 'link', target: <looseFilePath>, label: <Title> }` and add the graph
     `[[wikilink]]` to `links[]` (reusing the existing unify path; never store the
     wikilink inside the relatedDocuments object — that caused the `[object Object]`
     backlink defect).
3. Open the new file in the editor via `openDocInEditor(looseFilePath, parentDocPath, newPane=false, leaf)`
   with the **Return to document** context set to the parent's detail page.

### Validation / collisions
- Empty title disables Create.
- Illegal path chars (`\ / : * ? " < > |`) rejected with a Notice.
- Duplicate filename in the parent folder rejected with a Notice.

## Feature 2 — Break Away

### Trigger
A **Break away** button on a Related-Documents entry row, **edit mode only**, rendered
**only when** the entry's target file has `looseDoc: true` in its sidecar (read via
`metadataCache`). Non-loose entries (plain links, drag refs, normal documents) never show
the button.

### Flow — `breakAwayLooseDoc(parentDocPath, looseFilePath)`
1. **Destination:** `container = parentOf(parentDocPath)`; new folder `container/<Title>/`.
   On collision auto-suffix `<Title> (2)`, `(3)`, … — never overwrite.
2. **Promote the file:** `vault.rename` the loose file →
   `<container>/<Title>/<Base>_V1.0.<ext>` where `Base = documentBaseName(Title)` and the
   version name comes from `firstVersionName` (both existing pure-core helpers). Obsidian
   auto-fixes any body `[[wikilinks]]` to the moved file.
3. **Migrate metadata:** rename the loose sidecar to match the new `_V1.0` file
   (`<…>_V1.0.<ext>.md`); carry all frontmatter forward **except** `looseDoc`, which is
   dropped (it is now a real document, no longer break-away eligible).
4. **Re-point parent link:** in the parent's sidecar, update the matching
   `relatedDocuments` entry `target` and the corresponding `links[]` wikilink to the new
   document's current-version path.
5. **Reciprocal back-link:** on the new document's `_V1.0` sidecar, add a
   `relatedDocuments` entry + `links[]` wikilink pointing back to the parent's
   current-version path.
6. **Refresh** the document tree + the parent detail view. The new document now appears as
   a peer document in the container overview, with its own version lineage and check-out.

### Net result
The file graduates attachment → first-class document; parent and new doc reference each
other (bidirectional, with graph edges on both); no nesting; every document stays a clean
leaf.

## Detection marker

The sidecar field `looseDoc: true`:
- Stamped at creation (Feature 1).
- Dropped on break-away (Feature 2).
- Checked by the Related Documents row renderer to decide whether to show the Break-away
  button.

Explicit and unambiguous: manually-dragged references and normal documents never carry it.

## Edge cases

- **Loose file open in an editor during break-away:** detect an open `OfficeEditorView`
  on that path (via `iterateAllLeaves` + `instanceof`); after the rename, redirect/reload
  it to the new `_V1.0` path (reuse the open-editor reconcile pattern) so it does not
  dangle on a moved file.
- **Name collision** in destination container → auto-suffix; never overwrite.
- **Missing or non-`looseDoc` sidecar** → Break-away button does not render (no-op safety).
- **`relatedDocuments` target paths** are stored strings → every file move updates them
  explicitly (Obsidian only auto-fixes `[[wikilinks]]`, not our JSON paths).
- **PDF** excluded from creation (no blank PDF base); break-away still works on any
  existing office extension.

## Testing

- **Pure-core unit tests** in `lib/doc-container.js` (+ `node --test`, then re-run
  `scripts/inline-doc-container.js`) for any new pure path logic — e.g. a
  collision-suffix / loose-related-filename helper.
- **Desktop smoke checklist:**
  1. Related Documents (edit) → ＋ New document → pick a template → file is created in the
     parent folder, opens in the editor, Return button lands on the parent detail page.
  2. Loose file shows as an **attachment** in Files & Versions **and** as a linked entry in
     Related Documents; target note/graph shows the edge; backlink is clean (no
     `[object Object]`).
  3. Related Documents (edit) → **Break away** on the loose entry → a sibling document
     folder appears under the same container with `_V1.0`; parent link re-points to it;
     reciprocal back-link present on the new doc; graph edges intact both directions;
     `looseDoc` marker gone; Break-away button no longer shows for that entry.

## Scope guards (unchanged)

- Everything behind `docBrowserEnabled` and under `docRoot`.
- No change to the version model, the check-out gate, or existing Related-Documents
  linking (Add link / drag-to-attach).
- Lib edits require re-running `scripts/inline-doc-container.js`.

## Reused building blocks

- `NewDocumentModal`, `BLANK_{DOCX,PPTX,XLSX}_BASE64`, template root resolution.
- Pure-core `documentBaseName`, `firstVersionName`, `parentOf` (path helper),
  `groupDocumentFiles`, `buildTaxonomy`.
- `_mutateSidecar` (single `processFrontMatter` transaction), `_relWikilink`,
  the relatedDocuments↔`links[]` unify, `openDocInEditor` + Return-to-document context,
  the open-editor reconcile pattern.
