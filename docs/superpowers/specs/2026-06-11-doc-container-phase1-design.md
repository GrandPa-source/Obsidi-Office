# Document Container — Phase 1 Design (Container View + Navigation)

**Date:** 2026-06-11
**Project:** Obsidi-Office (P21) · `obsidi-office` plugin
**Branch:** `doc-container` (off `main`) — not yet created
**Phase:** 1 of a 5-phase roadmap (this spec covers Phase 1 only)
**Status:** Approved design — pending spec review

---

## 1. Purpose

Add a presentation-and-management layer over the Office documents that already live as real files in the vault. The native Obsidian file explorer is weak for a structured document taxonomy: clicking a folder only expands it (no contextual view), document versions sit as equal siblings with nothing marking which is current, `.docx`/`.xlsx` entries are inert, and reaching one file takes four levels of expand/collapse.

Phase 1 delivers a custom main-area view that owns navigation end-to-end and renders a document-status detail panel. **No database, audit, conversion, or diff** — those are Phases 2–5. A second, explicit Phase 1 goal is to **define the metadata schema** so Phase 2 (SQLite) has a fixed target.

## 2. Scope

**In scope (Phase 1):**
- A `ItemView` "Document Browser" in the main workspace area, inside the existing `obsidi-office` plugin, behind a settings toggle, lazy-loaded.
- Managed-root + Category folder scaffolding (ensure-exists, idempotent).
- A smart tree (Category → Collection → Document; no version nodes) with single-click → detail.
- A document-status detail form rendering + editing document-level metadata from the current version's sidecar.
- Filename-convention version parsing; current version pinned, history shown in the detail panel.
- Detail actions: Open in editor, Open in system app, Edit metadata, Reveal in file explorer.
- Settings: enable toggle, managed-root path, editable Category list.

**Explicitly OUT of Phase 1:**
- SQLite (org graph, folder-level metadata persistence, expected-files manifest).
- Audit / startup reconciliation / drift detection.
- Content-conversion pipeline (mammoth/turndown/SheetJS) and the LLM corpus.
- Version diff rendering.
- All approval **workflow** (reviewers/approver routing, Pending Review / Pending Approval queues, status-transition enforcement). Workflow *fields* are reserved in the schema but not acted on.

## 3. Roadmap context

The reference UI (a QMS document-control record) sets the long-term direction: a document-control system with an approval workflow. **Decision: plan toward QMS workflow later.** Phase 1 builds only navigation + metadata, but the metadata schema is designed forward-compatibly so later workflow phases need no data-model rework. The 5-phase roadmap (view → SQLite → audit → conversion → diff) may be extended with workflow phases after Phase 5.

## 4. Conceptual model

Four roles, mapped onto real on-disk folders under a single managed root:

- **Category** — depth-1 folder under the managed root (Governance, Projects, SOPs).
- **Collection** — zero or more folder levels between Category and Document.
- **Document** — a folder that **directly contains office files**. The key invented abstraction; the thing a person names. Not a native Obsidian concept.
- **Files/versions** — office files inside a Document folder, including versions and attachments.

**Flexible depth (decision):** the tree renders the real folder hierarchy, so arbitrary nesting works (the live `governance/` vault folder nests deeper than the clean handover example). Roles are assigned by position for labelling and metadata, not by a fixed 4-level rule.

## 5. Architecture

### 5.1 Components

- **`DocumentBrowserView` (`ItemView`)** — registered via `registerView` under a new view type (e.g. `obsidi-office-doc-browser`). Main-area leaf. Owns the tree + detail render and all click behaviour. Lazy-loaded: code path only runs when the feature toggle is on.
- **`TaxonomyScanner`** — reads `vault.getFiles()` / folder structure filtered to the managed root; builds an in-memory tree of Category/Collection/Document nodes; groups files within a Document into version sets via the version parser. Pure read; no persistence.
- **`VersionParser`** — parses `<base>_V<major>.<minor>.<ext>` and bare `<base>.<ext>`; returns the version set for a Document and identifies the current (highest) version. Unparseable names → ordered by mtime, no current flag.
- **`DocumentMetadata` (sidecar adapter)** — reads/writes document-level frontmatter on the current version's `.md` sidecar, reusing the existing P21 sidecar mechanism (`processFrontMatter`, the MetadataModal, rename/delete watchers). Extends the existing schema; does not create a parallel system.
- **`RootScaffolder`** — on `onLayoutReady`, ensures `<managedRoot>/<Category>/` exists for each configured Category; creates missing folders; never deletes.
- **Settings additions** — new section in the existing settings tab: enable toggle, managed-root path, editable Category list.

### 5.2 Data flow

1. Plugin load → if feature toggle on, `RootScaffolder` ensures folders (inside `onLayoutReady`).
2. User opens Document Browser (ribbon/command) → `DocumentBrowserView` mounts.
3. `TaxonomyScanner` builds the tree from disk; `VersionParser` resolves versions per Document.
4. Render tree (down to Document level). User single-clicks a node.
5. Node selected → detail panel renders. For a Document: `DocumentMetadata` reads the current version's sidecar frontmatter; the file/version list and attachments render from the scanned version set.
6. User edits metadata → written back to the current version's sidecar. User clicks Open in editor → hands the file to the existing Obsidi-Office editor leaf.

### 5.3 Reuse (do not rebuild)

- **Sidecar feature** (`.docx.md`/`.pptx.md`/`.xlsx.md`, auto-create, CSS-hidden, rename/delete watchers, MetadataModal) — already shipped in P21. Extend its schema.
- **ItemView registration + lifecycle** — pattern proven in P21 (`DocxView`/`XlsxView`) and P11/P13 master-detail views.
- **Open-in-editor handoff** — the existing `obsidi-office` view-open routing.

## 6. Metadata schema

One schema, defined now. Phase 1 implements the descriptive subset; workflow fields are reserved (defined, nullable, unused until later phases).

### 6.1 Document-level (current version's sidecar frontmatter)

**Phase 1 — display + edit:**

| Field | Type | Notes |
|---|---|---|
| `title` | string | Human title (distinct from filename) |
| `docNumber` | string | e.g. `POL-014`, `SQ-3` |
| `docClass` | enum | Policy / SOP / Work Instruction / Form / Flowchart / Other (configurable later) |
| `revision` | string | Current revision label, e.g. `2.0` (derived default from filename, editable) |
| `status` | enum | Draft / In Review / Pending Approval / Approved / Active / Archived / Obsolete (free-set in Phase 1; no transition enforcement) |
| `department` | string | |
| `originator` | string | |
| `originationDate` | date | ISO |
| `summary` | string | |
| `tags` | string[] | Existing sidecar field |
| `created` / `modified` | date | Existing sidecar fields |

**Reserved — defined, not acted on in Phase 1:**

| Field | Type | Activated in |
|---|---|---|
| `reviewers` | string[] | Workflow phase |
| `finalApprover` | string | Workflow phase |
| `reviewFrequencyDays` | number | Workflow phase |
| `nextReviewDate` | date | Workflow phase |
| `statusHistory` | array of {status, by, date} | Workflow phase |
| `relatedDocuments` | string[] (doc refs) | Phase 5 / workflow |

### 6.2 Folder-level (Category / Collection)

Schema defined now, **persisted in Phase 2 SQLite** (folders have no safe frontmatter home). Phase 1 renders these as stub/empty fields.

| Field | Type | Applies to |
|---|---|---|
| `name` | string | Category, Collection |
| `description` | string | Category, Collection |
| `owner` | string | Category, Collection |
| `parent` | ref | Collection → Category |
| `expectedFiles` (manifest) | per Document | Phase 2/3 audit |

## 7. Version convention

- **Current/version pattern:** `<base>_V<major>.<minor>.<ext>` is a version of `<base>.<ext>`.
- Bare `<base>.<ext>` = revision 1.0.
- Highest parsed `(major, minor)` = **current** (pinned + badged).
- Files in a Document that don't match the convention and aren't an office-doc sibling render as **attachments**.
- Unparseable office files → ordered by mtime, no current badge (degraded but functional).

## 8. Files within a Document

Simple model (no primary/editable roles): **current version** (pinned) + **older versions** (history) + **attachments** (everything else). All openable; office files route to the Obsidi-Office editor, others to the system app.

## 9. UI surface

- **Tree (left):** Category (folder icon) → Collection → Document (doc icon, status badge). No version nodes. Single-click selects; selection drives the detail panel. Greyed "unmanaged" items not shown as Documents.
- **Detail (right):** document-status form — Title, Doc Number, Class, Revision, Status, Department, Originator, Origination Date, Summary, Tags; Files & Versions list (current pinned + history + attachments); Related Documents (stub table in Phase 1); actions row (Open in editor / System app / Edit metadata / Reveal).
- **Selecting a Category/Collection node:** detail shows folder-level fields (stub in Phase 1) + child count.

## 10. Settings

- **Enable Document Browser** (toggle; default off until smoke-tested).
- **Managed root** (path, default `Documents/`).
- **Categories** (editable list, default `Governance`, `Projects`, `SOPs`).

## 11. Testing / verification

- Desktop smoke: scaffold creates missing Category folders; tree renders a sample taxonomy; single-click shows detail; current-version pin correct across convention/edge cases; metadata edit round-trips to sidecar; Open-in-editor hands off correctly.
- iPad smoke (after desktop): view mounts, tree renders, detail renders, open-in-editor works (no DB/native deps in Phase 1, so mobile parity expected).
- Edge cases: empty managed root, Document with one file, unparseable filenames, deep Collection nesting, stray non-office files.

## 12. Open decisions deferred (not Phase 1)

1. Managed-file definition strictness (audit signal) — Phase 3.
2. Diff granularity (full normalized markdown vs hash) — Phase 4/5.
3. SQLite location/sync/platform — Phase 2 (precedent: M01-ARCH `sql.js`).
4. xlsx diff representation (structural) — Phase 5.
5. Workflow data model details — post-Phase 5 workflow phases (schema reserved here).

## 13. Out-of-scope risks to watch

- **Scope creep toward QMS workflow** — keep Phase 1 to navigation + metadata; resist building queues/routing.
- **Sidecar schema drift** — extend the existing schema additively; don't fork the sidecar format.
- **Plugin size** — lazy-load the view so it costs nothing when the toggle is off.
