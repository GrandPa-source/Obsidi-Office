# Document Container — Phase 1 Design (Container View + Navigation)

**Date:** 2026-06-11
**Project:** Obsidi-Office (P21) · `obsidi-office` plugin
**Branch:** `doc-container` (off `main`) — created; spec + plan committed
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
- Detail actions (floating footer): Open in editor, New version, Open in system app, Edit metadata, Reveal in file explorer.
- **Detail left tabs:** Files & Versions, Stakeholders (Name·Title·Role·Dept), Related Documents (vault links + drag-drop reference material), Definitions (read-only checkbox table over the vault glossary of **Definitions & Acronyms** — right-aligned include checkbox, overflow + "more", no type pills, no add/delete).
- **Detail right tabs:** Recent Notes (structured note log; inline-`#tag` composer + note-text-gated drag-drop attachments; note-tags a separate namespace), Search Notes (text + note-tag + icon date-range filter), Log (read-only activity feed of plugin-originated actions).
- Responsive single-column collapse, empty states, file-type icons.
- Settings: enable toggle, managed-root path, editable Category list.

**Explicitly OUT of Phase 1:**
- SQLite (org graph, folder-level metadata persistence, expected-files manifest).
- Audit / startup reconciliation / drift detection.
- Content-conversion pipeline (mammoth/turndown/SheetJS) and the LLM corpus.
- Version diff rendering.
- All approval **workflow** (reviewers/approver routing, Pending Review / Pending Approval queues, status-transition enforcement). Workflow *fields* are reserved in the schema but not acted on.
- **Definitions insert-into-document** — writing the included glossary text into the `.docx` body (an editor content op). Phase 1 records inclusion (the checkbox) only.
- **Activity-log external-change detection** — Phase 3 audit. Phase 1 logs plugin-originated actions only.

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
- **`DocumentDetailView` (`ItemView`, main area)** — view type `obsidi-office-doc-detail`; a **reused main-area leaf** opened when a Document is selected (may share one main-area leaf with the overview, re-typed on navigation). Layout = a **scrollable body** + a **sticky floating footer** (action bar pinned to the bottom of the view, so the tab panels can grow/shrink without moving it). Body = the **metadata form** (grouped: Identification / Classification & Status / Lifecycle / Description) over **two independently-scoped tabbed columns**:
  - **Left tabs** — *Files & Versions* (working version set only: current pinned + history; **⎘ New version**), *Stakeholders* (Name · **Title** · Role · Dept), *Related Documents* (vault links + drag-drop reference material), *Definitions* (a filterable, read-only **table of the vault glossary's Definitions & Acronyms**: Term · Definition [overflow + **"more"**] · small **right-aligned include checkbox**; no type pills, no add/delete).
  - **Right tabs** — *Recent Notes* (structured note log + composer), *Search Notes* (text + note-tag + icon date-range filter), *Log* (read-only activity feed).
  - Switching a tab in one column does not affect the other. Takes the document's folder path as view state.
- **`NoteLog` (sidecar adapter)** — reads/writes the structured note log; each note `{date, author, body, noteTags[], attachments[], version?}`. **Note-tags are a separate namespace** from the document's `tags` (not shared with the metadata cache / Obsidi-Office tag fields). The composer parses inline `#tag` tokens out of the note text into pills; the drag-drop attach zone is disabled until note text is entered; attachments (minutes, PDFs) are copied into a per-Document `_notes/` subfolder and referenced.
- **`ActivityLog` (sidecar adapter)** — appends read-only entries `{datetime, actor, action, type}` for plugin-originated actions (version created, status changed, metadata edited, note added/edited/deleted, reference attached, definition (un)checked, document created). External-change entries arrive via the Phase 3 audit.
- **`Glossary` + `Definitions` adapters** — `Glossary` scans a curated **vault glossary** folder (toggled on + path-set in settings) holding **Definitions and Acronyms only** (each entry = term + its text + type ∈ {definition, acronym}). `Definitions` stores the document's **included** term ids in the sidecar (checkbox = include/exclude). Inserting the included set into the .docx is a **later** document-level action (see §14); the checkbox alone is the Phase-1 include/traceability record.
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

**Structured sub-objects** (in the sidecar; full shapes in §6.3): `noteLog[]`, `stakeholders[]`, `relatedDocuments[]`, `definitions[]`, `activityLog[]`. **Reserved scalars** still deferred: `statusHistory[]` (workflow phase) — the per-status-change audit, distinct from the general `activityLog`.

### 6.2 Folder-level (Category / Collection)

Schema defined now, **persisted in Phase 2 SQLite** (folders have no safe frontmatter home). **Phase 1 creates the folder only** (New Category / New Collection); `description`/`owner` are not stored yet — adding a folder-note now is the fragility the handover warned against. The container overviews show **derived** rollups (counts, overdue), not stored container metadata, so nothing is lost by deferring.

| Field | Type | Applies to |
|---|---|---|
| `name` | string | Category, Collection |
| `description` | string | Category, Collection |
| `owner` | string | Category, Collection |
| `parent` | ref | Collection → Category |
| `expectedFiles` (manifest) | per Document | Phase 2/3 audit |

### 6.3 Document sidecar sub-structures (the evolved detail view)

All live in the **current version's sidecar** frontmatter (the note log may also mirror to the sidecar body for readability — decide at build). Note-tags, the activity log, and definitions are **document-scoped** and distinct from the document's `tags`.

| Field | Shape | Phase | Notes |
|---|---|---|---|
| `noteLog` | `[{date, author, body, noteTags[], attachments[], version?}]` | 1 | Development/status log shown in *Recent Notes*. Inline `#tag` → note-tag pill; **note-tags are a separate namespace** from `tags`. Attachments copied into `_notes/` and referenced. `version` parks to the current version (see §14). |
| `stakeholders` | `[{name, title, role, dept}]` | 1 (Title + Originator) · workflow (Reviewer / Approver rows) | **Title is role-based** so the record isn't person-centred over time. Replaces the old scalar `reviewers`/`finalApprover`. |
| `relatedDocuments` | `[{kind:'link'\|'ref', target, label}]` | 1 | `link` = a vault-file link; `ref` = reference material (dropped file copied into the Document folder, or a path link). Shown in *Related Documents*. |
| `definitions` | `[termId]` (ids of included glossary entries) | 1 (include) · later (insert) | *Definitions* tab = filterable read-only table of the glossary (**Definitions + Acronyms only**). Columns: Term · Definition (overflow-clamped with a **"more"** expander) · a small **right-aligned include checkbox** (last column); type shown as muted text, **no pills**; no add/delete. Insert into the .docx is a **later** action (§14). |
| `activityLog` | `[{datetime, actor, action, type}]` | 1 (plugin-originated) · 3 (external) | Read-only feed in the *Log* tab. Plugin records its own actions now; external add/delete/edit arrive with the Phase 3 audit. |

### 6.4 Glossary source

A **curated glossary in the vault** (decision): a folder the user maintains holding **Definitions and Acronyms only** (each entry = term + its text + type ∈ {definition, acronym}; no criteria). **Toggled on + path-set in settings** (default `Definitions/`). The Definitions tab filters it (term + text, comma-AND). Not plugin-managed; version-controlled with the vault.

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
- **Document detail (main area, "Document Status"):** a scrollable body + a **sticky floating footer**.
  - **Metadata top** in grouped sections: *Identification* (Title, Doc Number, Document Class) · *Classification & Status* (Revision, Status, Department, Originator) · *Lifecycle* (Origination, Effective, Review Frequency, Next Review + overdue) · *Description* (Summary, Tags — Tags left-aligned/wrapping; only chevron/select fields use right-justified content).
  - **Left tabbed column** — *Files & Versions* (working version set only: current pinned + history; **⎘ New version** in the tab header) · *Stakeholders* (table: Name · **Title** · Role · Dept; Title role-based) · *Related Documents* (drag-drop zone + ＋ Add link at top, then list of 🔗 links / 📎 reference material with remove) · *Definitions* (filter box + read-only table of glossary terms/criteria, each row a **checkbox** to include in this document — term/criterion colour-tagged; no add/delete).
  - **Right tabbed column** — *Recent Notes* (composer: note input with inline `#tag`→pill, **Add note** button to its right, a **drag-drop attach** zone disabled until note text is entered; below, the note log newest-first with green note-tags + 📎 attachments) · *Search Notes* (search box + funnel **icon** toggling a From/To date range; filters by text + note-tag + range) · *Log* (read-only activity feed: icon · action · actor · timestamp, newest-first).
  - **Floating footer** (pinned): Open in editor · New version · Open in system app · Edit metadata · Reveal in file explorer.
- **Responsiveness / states:** the two columns collapse to one on narrow/iPad panes; explicit empty states (no node selected, Document with one file, empty Category/Collection, empty notes/log/definitions); file-type icons differ by extension (docx/pptx/xlsx/pdf).
- **Reuse:** the overview leaf and detail leaf may be the same reused main-area leaf, re-typed on navigation (no tab stacking).

## 10. Settings

- **Enable Document Browser** (toggle; default off until smoke-tested).
- **Managed root** (path, default `Documents/`).
- **Categories** (editable list, default `Governance`, `Projects`, `SOPs`).
- **Definitions glossary** (toggle + folder path, default `Definitions/`; holds Definitions & Acronyms for the Definitions tab).

## 11. Testing / verification

- Unit (node --test, pure core): version parse/compare/group, taxonomy build, `nextVersionName`, `computeNextReview`/`isOverdue`, `rollupByStatus`/`countOverdue`, schema constants.
- Desktop smoke: scaffold creates missing Category folders; sidebar leaf mounts + ribbon/command reveals it; tree renders + the filter box matches title+tags (comma=AND); twistie expands, label-click opens overview/detail. Container overview by kind: Root→Categories+New Category, Category→Collections cards+rollup+New Collection (modal creates folder w/ live path), Collection→Documents table+search+New Document. Document detail: metadata groups incl. Lifecycle; next-review computes + overdue flag shows; Files & Versions with current pinned; **New version** creates the next `_Vx.y` and carries metadata. Left tabs (Files & Versions / Stakeholders w/ Title / Related Documents links + drag-drop refs / Definitions checkbox-table over the glossary) and right tabs (Recent Notes composer w/ inline-`#tag` pills + note-text-gated drag-drop attach / Search Notes text+note-tag+date-range / Log feed) all render and operate; the floating footer stays pinned while a tab's content grows; all footer actions work; edits round-trip and refresh tree/overview.
- iPad smoke (after desktop): sidebar leaf, filter, overview, detail all mount; two columns collapse to one; open-in-editor works; New version works; "Open in system app" degrades gracefully (Electron `shell` absent). No DB/native deps, so parity expected.
- Edge cases: empty managed root, empty Category/Collection, Document with one file, unparseable filenames, deep Collection nesting, stray non-office files, missing/empty lifecycle dates (no overdue when no next-review).

## 12. Open decisions deferred (not Phase 1)

1. Managed-file definition strictness (audit signal) — Phase 3.
2. Diff granularity (full normalized markdown vs hash) — Phase 4/5.
3. SQLite location/sync/platform — Phase 2 (precedent: M01-ARCH `sql.js`).
4. xlsx diff representation (structural) — Phase 5.
5. Workflow data model details — post-Phase 5 workflow phases (schema reserved here).

## 14. Parking lot — future enhancements

- **New note auto-associates with the current/most-active version.** When a note is added, default its `version` to the Document's current pinned `_Vx.y`, so the development log ties to the revision it was written against. User-overridable.
- **Definitions → insert into the .docx.** Recommended first form: a manual document-level **"Insert/refresh Definitions & Acronyms section"** action (idempotent, managed region). Heavier future option (user-requested): **live auto-insert/-remove as each checkbox toggles** — requires the doc open + two-way sync of a managed section. The checkbox-include half ships in Phase 1; both insert forms are later.

> The detail-view UI evolution (twin tabbed columns, structured note log + composer, note-scoped tags, Stakeholders Title, Related Documents links/refs, floating footer, Log, Definitions checkbox table) is now folded into §2/§5/§6/§9. Prototype: `.superpowers/brainstorm/sustained-1/content/document-detail-v4.html`.

## 15. Out-of-scope risks to watch

- **Scope creep toward QMS workflow** — keep Phase 1 to navigation + metadata; resist building queues/routing.
- **Sidecar schema drift** — extend the existing schema additively; don't fork the sidecar format.
- **Plugin size** — lazy-load the view so it costs nothing when the toggle is off.
