# Document Container — Phase 1 Design (Container View + Navigation)

**Date:** 2026-06-11
**Project:** Obsidi-Office (P21) · `obsidi-office` plugin
**Branch:** `doc-container` (off `main`) — not yet created
**Phase:** 1 of a 5-phase roadmap (this spec covers Phase 1 only)
**Status:** Approved design — pending spec review

---

## 1. Purpose

Add a presentation-and-management layer over the Office documents that already live as real files in the vault. The native Obsidian file explorer is weak for a structured document taxonomy: clicking a folder only expands it (no contextual view), document versions sit as equal siblings with nothing marking which is current, `.docx`/`.xlsx` entries are inert, and reaching one file takes four levels of expand/collapse.

Phase 1 delivers a curated **left-sidebar tree** (a "Documents" pane that folds into Obsidian's navigation alongside Files/Search) plus a **main-area document-status detail view** opened when a Document is selected. **No database, audit, conversion, or diff** — those are Phases 2–5. A second, explicit Phase 1 goal is to **define the metadata schema** so Phase 2 (SQLite) has a fixed target.

## 2. Scope

**In scope (Phase 1):**
- A **left-sidebar leaf** "Document Browser" (own ribbon icon, peer to Files/Search), inside the existing `obsidi-office` plugin, behind a settings toggle, lazy-loaded — renders the taxonomy tree with a **title+tag filter box**.
- A **main-area container overview** that, by node kind, manages Categories (Root), Collections (Category), or Documents (Collection) — with **＋ New Category / New Collection / New Document** (folder/file creation), per-level **status rollups** (counts + overdue), and the title+tag search at the Collection level.
- A **main-area document-status detail** that renders + edits document metadata, lists files & versions, and offers **⎘ New version** (next `_Vx.y`).
- Managed-root + Category folder scaffolding (ensure-exists, idempotent); shared `createFolder` used by the New-X actions.
- Smart tree (Root → Category → Collection → Document; no version nodes): twistie expands/collapses; clicking a node **label** opens its overview (containers) or detail (Documents).
- Filename-convention version parsing; current version pinned, history in the detail.
- **Lifecycle:** effective date, review frequency, computed next-review with an **overdue** flag surfaced in tree/overviews/detail.
- Detail actions: Open in editor, New version, Open in system app, Edit metadata, Reveal in file explorer.
- Responsive single-column collapse, empty states, file-type icons.
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

**Architecture decision (UI placement):** the tree lives in the **left sidebar** as its own curated pane (peer to Files/Search), not as a main-area split and not by augmenting Obsidian's native Files explorer (augmenting was rejected as brittle — it hooks explorer internals and mixes the taxonomy with all other vault files). Clicking a **container** (Root / Category / Collection) opens a **container overview** in the main area; clicking a **Document** opens its **status detail** in the main area. The disclosure twistie still expands/collapses; clicking the node **label** opens the overview/detail. Three `ItemView`s collaborate:

- **`DocumentBrowserView` (`ItemView`, left sidebar)** — registered via `registerView` under view type `obsidi-office-doc-browser`; mounted in the **left sidebar** (`workspace.getLeftLeaf`), revealed by a ribbon icon + command. Renders the taxonomy tree (with a **filter box** matching document title + sidecar tags, same comma-AND engine as Obsidi-Office's existing search). Owns tree click behaviour. Lazy-loaded.
- **`ContainerOverviewView` (`ItemView`, main area)** — view type `obsidi-office-doc-container`; a **reused main-area leaf** opened when a container node's label is clicked. Renders **by node kind**:
  - **Root** → a Categories grid + **＋ New Category** (creates `<root>/<name>` folder; also appended to the settings Category list).
  - **Category** → a Collections grid (cards with doc count + status mini-rollup + overdue flag) + **＋ New Collection** (creates `<category>/<name>` folder).
  - **Collection** → a Documents table (Title · Doc # · Class · Status · Next review/overdue · Modified · Tags), filtered by the same title+tag search, + **＋ New Document**.
  - All levels show an aggregate **status rollup** (counts by status + overdue) computed from the live scan + sidecars. Clicking a card/row drills down (re-targets this same overview leaf, or opens the detail leaf for a Document).
- **`DocumentDetailView` (`ItemView`, main area)** — view type `obsidi-office-doc-detail`; a **reused main-area leaf** opened when a Document is selected. Renders the document-status form (metadata top, then two columns: Files & Versions left, a tabbed **Related Stakeholders / Related Documents** panel right) and metadata editing. Takes the document's folder path as view state. (The overview and detail may share one main-area leaf, re-typed on navigation.)
- **`TaxonomyScanner`** — reads `vault.getFiles()` / folder structure filtered to the managed root; builds an in-memory tree of Category/Collection/Document nodes; groups files within a Document into version sets. Pure read; no persistence.
- **Pure-core helpers (`lib/doc-container.js`, no Obsidian dep, unit-tested):** `parseVersion` / `compareVersions` / `groupDocumentFiles` (versioning); `buildTaxonomy`; `nextVersionName(current, bump)` (compute the next `_Vx.y` filename); `computeNextReview(effectiveDate, freqDays)` + `isOverdue(nextReview, today)` (lifecycle); `rollupByStatus(documents)` + `countOverdue(documents, today)` (overview rollups); `DOC_FIELDS`/`STATUS_VALUES`/`DOC_CLASSES` constants.
- **`DocumentMetadata` (sidecar adapter)** — reads/writes document-level frontmatter on the current version's `.md` sidecar, reusing the existing P21 sidecar mechanism (`processFrontMatter`, the MetadataModal, rename/delete watchers). Extends the existing schema; does not create a parallel system.
- **`NewVersionAction`** — copies the current file to the `nextVersionName` (minor bump default, major on a prompt), copies/clears its sidecar carrying metadata forward, and refreshes the views.
- **`Scaffolder`** — on `onLayoutReady`, ensures `<managedRoot>/<Category>/` exists for each configured Category (idempotent, never deletes); also exposes `createFolder(path)` used by the New Category/Collection/Document actions.
- **Settings additions** — new section in the existing settings tab: enable toggle, managed-root path, editable Category list.

### 5.2 Data flow

1. Plugin load → if feature toggle on, `RootScaffolder` ensures folders (inside `onLayoutReady`).
2. User reveals Document Browser (ribbon/command) → `DocumentBrowserView` mounts in the left sidebar.
3. `TaxonomyScanner` builds the tree from disk; `VersionParser` resolves versions per Document.
4. Render tree down to Document level. Clicking a Category/Collection expands/collapses it.
5. Clicking a **Document** → open or re-target the single `DocumentDetailView` in the main area with the document's folder path as state. The detail view: `DocumentMetadata` reads the current version's sidecar frontmatter; the file/version list and attachments render from the scanned version set.
6. User edits metadata → written back to the current version's sidecar (the sidebar tree refreshes the affected node's badge). User clicks Open in editor → hands the file to the existing Obsidi-Office editor leaf.

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
| `effectiveDate` | date | When the current revision takes effect |
| `reviewFrequencyDays` | number | Review cadence; `0`/empty = no scheduled review |
| `nextReviewDate` | date | Default computed = `effectiveDate + reviewFrequencyDays`; manual override allowed. Drives the **overdue** flag (`nextReviewDate < today`) used in the tree, overviews, and detail |
| `summary` | string | |
| `tags` | string[] | Existing sidecar field |
| `created` / `modified` | date | Existing sidecar fields |

**Reserved — defined, not acted on in Phase 1** (surfaced read-only in the detail's Related tabs where relevant):

| Field | Type | Activated in |
|---|---|---|
| `reviewers` | string[] | Workflow phase (shown in Related Stakeholders) |
| `finalApprover` | string | Workflow phase (shown in Related Stakeholders) |
| `statusHistory` | array of {status, by, date} | Workflow phase |
| `relatedDocuments` | string[] (doc refs) | Phase 5 / workflow (shown in Related Documents) |

### 6.2 Folder-level (Category / Collection)

Schema defined now, **persisted in Phase 2 SQLite** (folders have no safe frontmatter home). **Phase 1 creates the folder only** (New Category / New Collection); `description`/`owner` are not stored yet — adding a folder-note now is the fragility the handover warned against. The container overviews show **derived** rollups (counts, overdue), not stored container metadata, so nothing is lost by deferring.

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

- **Sidebar tree (left pane, own "Documents" leaf):** Root → Category → Collection → Document (doc icon, status badge). No version nodes. Toolbar: New Document, Refresh, Collapse-all. A **filter box** at the top matches document title + sidecar tags (comma = AND), reusing Obsidi-Office's existing search engine. Disclosure twistie expands/collapses; clicking the **label** opens that node's overview/detail in the main area. Greyed "unmanaged" items are not shown as Documents.
- **Container overview (main area, by node kind):**
  - **Root:** Categories grid + **＋ New Category**.
  - **Category:** Collections grid (cards: name, doc count, status mini-rollup, overdue flag) + **＋ New Collection** (modal → name → live path preview → create folder). Card click drills into the Collection.
  - **Collection:** Documents table (Title · Doc # · Class · Status · Next review/overdue · Modified · Tags) + **＋ New Document**; the search box filters by title + tags. Row click opens the Document detail.
  - Every level shows an aggregate **status rollup** (counts by status + overdue), derived from the live scan + sidecars.
- **Document detail (main area, "Document Status"):** metadata top in grouped sections (Identification / Classification & Status / **Lifecycle** [Origination, Effective, Review Frequency, Next Review + overdue] / Description); then two columns — **left** Files & Versions (current pinned + history + attachments, with **⎘ New version** + **＋ Add file**), **right** a tabbed **Related Stakeholders / Related Documents** panel (reserved fields, mostly stub in Phase 1); actions row (Open in editor / New version / System app / Edit metadata / Reveal).
- **Responsiveness / states:** the two detail columns collapse to one on narrow/iPad panes; explicit empty states (no node selected, Document with one file, empty Category/Collection); file-type icons differ by extension (docx/pptx/xlsx/pdf).
- **Reuse:** the overview leaf and detail leaf may be the same reused main-area leaf, re-typed on navigation (no tab stacking).

## 10. Settings

- **Enable Document Browser** (toggle; default off until smoke-tested).
- **Managed root** (path, default `Documents/`).
- **Categories** (editable list, default `Governance`, `Projects`, `SOPs`).

## 11. Testing / verification

- Unit (node --test, pure core): version parse/compare/group, taxonomy build, `nextVersionName`, `computeNextReview`/`isOverdue`, `rollupByStatus`/`countOverdue`, schema constants.
- Desktop smoke: scaffold creates missing Category folders; sidebar leaf mounts + ribbon/command reveals it; tree renders + the filter box matches title+tags (comma=AND); twistie expands, label-click opens overview/detail. Container overview by kind: Root→Categories+New Category, Category→Collections cards+rollup+New Collection (modal creates folder w/ live path), Collection→Documents table+search+New Document. Document detail: metadata groups incl. Lifecycle; next-review computes + overdue flag shows; Files & Versions with current pinned; **New version** creates the next `_Vx.y` and carries metadata; Related tabs render (reserved fields mostly `—`); all actions work; edits round-trip and refresh tree/overview.
- iPad smoke (after desktop): sidebar leaf, filter, overview, detail all mount; two columns collapse to one; open-in-editor works; New version works; "Open in system app" degrades gracefully (Electron `shell` absent). No DB/native deps, so parity expected.
- Edge cases: empty managed root, empty Category/Collection, Document with one file, unparseable filenames, deep Collection nesting, stray non-office files, missing/empty lifecycle dates (no overdue when no next-review).

## 12. Open decisions deferred (not Phase 1)

1. Managed-file definition strictness (audit signal) — Phase 3.
2. Diff granularity (full normalized markdown vs hash) — Phase 4/5.
3. SQLite location/sync/platform — Phase 2 (precedent: M01-ARCH `sql.js`).
4. xlsx diff representation (structural) — Phase 5.
5. Workflow data model details — post-Phase 5 workflow phases (schema reserved here).

## 13. Parking lot — future enhancements (captured during UI fine-tuning)

- **New note auto-associates with the current/most-active version.** When a note is added, default its association to the Document's current version (the pinned `_Vx.y`), so the development log ties to the revision it was written against. User-overridable later; useful once the Notes log is structured (`{date, author, body, tags[], files[], version?}`).
- **(Tracking) Detail-view UI evolution awaiting fold-in to this spec:** twin tabbed columns (Files & Versions / Stakeholders / Related Documents — and Recent Notes / Search Notes); Notes log with inline `#tag`→pill composer + note-text-gated drag-drop attachments + note-scoped tags (separate namespace from document tags); Stakeholders **Title** column (role-based, not person-centered); Related Documents = vault links + drag-drop reference material; floating (sticky-bottom) action footer; icon-only date-range filter on Search Notes. These were prototyped in the visual companion (`.superpowers/brainstorm/sustained-1/content/document-detail-v4.html`) and are not yet reflected in §5/§6/§9.

## 13. Out-of-scope risks to watch

- **Scope creep toward QMS workflow** — keep Phase 1 to navigation + metadata; resist building queues/routing.
- **Sidecar schema drift** — extend the existing schema additively; don't fork the sidecar format.
- **Plugin size** — lazy-load the view so it costs nothing when the toggle is off.
