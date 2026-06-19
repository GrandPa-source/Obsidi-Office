# Doc-Container — `_document.md` metadata migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move document-level metadata from per-version sidecars to a
`_document.md` folder-note (system of record) per document, introduce a stable
generated `docId`, add a `files:` manifest, and serve all reads/rollups from an
in-memory index built from `metadataCache`. Do it reversibly: a dry-run reconcile
report runs against the real corpus before any write path changes.

**Architecture:** All testable logic (key partitioning, manifest building, the
reconcile *plan*) lands in the existing pure module `lib/doc-container.js` and is
unit-tested with `node --test`. `main.js` gets: the in-memory `DocIndex`, a
`readDocMeta()` read-fallback accessor, the reconcile command (dry-run + apply),
docId generation, and the switched write paths. No new dependency, no bundler,
plain CommonJS.

**Tech Stack:** Plain CommonJS JS, Obsidian API, `node --test` (zero deps).

**Spec:** `docs/superpowers/specs/2026-06-17-doc-container-document-md-metadata-migration-design.md` (approved 2026-06-17; `docId` = generated short id, locked).

**Branch:** `doc-container`.

**Conventions:**
- Pure logic → `lib/doc-container.js` (+ tests); Obsidian-bound code → `main.js`,
  matching existing patterns. After editing `lib/doc-container.js`, run
  `node scripts/inline-doc-container.js` to re-inline into `main.js` (iPad can't
  `require('./lib/...')`). `node --test` runs against `lib/` directly.
- All frontmatter writes use `app.fileManager.processFrontMatter` **own-keys-only**
  — never re-emit a whole YAML doc (the clobber-bug discipline).
- Deploy target: `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\` — copy
  `main.js` + `manifest.json` + styles, **not** `lib/`.
- Behind the existing `docBrowserEnabled` toggle. iPad smoke gate per rung.

---

## Release ladder — READ BEFORE BUILDING

### Rung A — reversible foundation + dry-run (THE PROTOTYPE — ship/stop here first)
Pure core + in-memory index + read-fallback + a **dry-run reconcile report**.
Adds the new read path and shows exactly what migration *would* do to the real
`Documents/` corpus. **Mutates no data, changes no write path, fully reversible.**
This is the prototype to exercise before committing. — **Tasks 1–7**

**🚦 Gate:** deploy, run the dry-run command on a copy of the real `Documents/`
folder, read the report. Do not start Rung B until the report looks correct.

### Rung B — commit the migration
Reconcile *apply* + switch write paths to `_document.md` + docId-keyed rollups +
hide `_document.md` + smoke. — **Tasks 8–13**

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/doc-container.js` | Modify | Add `DOCUMENT_MD_NAME`, `DOC_MARKER`, `DOC_LEVEL_KEYS`, `VERSION_KEYS`; `partitionFrontmatter()`, `buildFilesManifest()`, `planReconcile()`. No Obsidian import. |
| `lib/doc-container.test.js` | Modify | `node --test` cases for every new pure function, incl. idempotency + divergent-version handling. |
| `main.js` | Modify | `DocIndex` (in-memory), `generateDocId()`, `readDocMeta()` read-fallback, reconcile command (dry-run + apply), switched write paths, docId-keyed rollups, `_document.md` CSS-hide. |
| `scripts/inline-doc-container.js` | Run | Re-inline core after `lib/` edits. |

---

## Rung A — reversible foundation + dry-run

- [x] **Task 1 — Pure schema constants.** In `lib/doc-container.js` add:
  `DOCUMENT_MD_NAME = '_document.md'`, `DOC_MARKER = 'document'`,
  `DOC_LEVEL_KEYS` (title, docNumber, docClass, status, department, originator,
  originatorTitle, originationDate, effectiveDate, reviewFrequencyDays,
  nextReviewDate, summary, tags, currentVersion, files, stakeholders,
  relatedDocuments, definitions, activityLog, noteLog), `VERSION_KEYS`
  (docx, docId, created, modified, versionNote, tags, links). Export all.
  *Test:* constants present; key sets are disjoint except the intentional
  overlaps (`tags`, `docId`) are documented.

- [x] **Task 2 — `partitionFrontmatter(front)`** (pure). Given a frontmatter
  object, return `{ docLevel, versionLevel }` by key ownership. Unknown keys →
  preserved on the version side (least-destructive). Used by reconcile + (later)
  write paths. *Test:* a fat legacy sidecar splits correctly; unknown keys ride
  along; empty input → empty partitions.

- [x] **Task 3 — `buildFilesManifest(fileNames)` + `planReconcile(input)`** (pure).
  `buildFilesManifest` reuses `groupDocumentFiles`/`compareVersions` to produce
  the ordered `files:` list + `currentVersion`. `planReconcile({ folderFiles,
  sidecarFronts, hasDocumentMd })` returns a pure plan:
  `{ skip, createDocumentMd:{docLevelKeys, files, currentVersion}, sidecarRewrites:[{name, dropKeys}], notes:[] }`.
  Picks the **current version's** sidecar as the metadata source; logs divergent
  doc-level values across versions into `notes`. No disk, no id generation (the
  plan carries a `needsDocId` flag the runtime fills). *Test:* idempotency
  (`hasDocumentMd:true` → `skip`); single-version; multi-version with divergence;
  no-sidecar folder → minimal plan.

- [x] **Task 4 — `generateDocId()`** (main.js, runtime). 8-char slice of
  `crypto.randomUUID()`; regenerate on collision against the live `DocIndex`.
  Fallback if `crypto` absent (timestamp+counter). *Test:* manual — generated
  ids are 8-char, unique across a batch.

- [x] **Task 5 — `DocIndex` in-memory cache** (main.js). Built at
  `app.workspace.onLayoutReady`: scan `metadataCache` for `_document.md` (and
  `_project.md`) under `docRoot` → `Map<docId, record>` + derived getters
  (byPath, byStatus, overdueReviews, stakeholdersAcross, projectRollup). Keep warm
  via `metadataCache.on('changed')` + vault `create`/`delete`/`rename` (listeners
  registered inside `onLayoutReady`, per the startup-burst lesson). Fully
  rebuildable; never persisted. *Test:* deploy; verify index populates and
  updates when a `_document.md` is edited.

- [x] **Task 6 — `readDocMeta(node)` read-fallback** (main.js). Returns
  `_document.md` frontmatter if present, else the current-version sidecar
  frontmatter. **Scope refinement (2026-06-17):** added as an *additive*
  accessor in Rung A; existing readers (DetailView, ContainerOverviewView,
  rollups) are **switched to it at the START of Rung B**, immediately before the
  apply step — wiring readers only matters once `_document.md` exists, and
  keeping Rung A additive-only makes the prototype trivially reversible (no
  existing code path changes). *Test:* deploy; a hand-made `_document.md` is
  returned by `readDocMeta`; absent → current sidecar.

- [x] **Task 7 — Reconcile DRY-RUN command** (main.js). Command
  "Doc-Container: migrate metadata to `_document.md` (dry run)". For each document
  folder under `docRoot`, call `planReconcile` and render a **report** (modal or
  written `_migration-report.md`): documents found, `_document.md` to create,
  keys to move per doc, sidecars to slim, and all `notes` (divergences,
  no-sidecar folders). **Writes nothing to document data.** *Test:* run on a copy
  of the real `Documents/` corpus; report is accurate and complete.

**🚦 Rung A gate:** deploy (desktop + iPad), run the dry-run on real data, read
the report. Confirm with Paul before Rung B.

---

## Rung B — commit the migration

- [ ] **Task 8 — Reconcile APPLY command.** Same `planReconcile` output, executed:
  create `_document.md` (stamp `docContainer: document` + `generateDocId()` +
  doc-level keys + `files:` + `currentVersion`) via `processFrontMatter`; slim
  each version sidecar by removing `dropKeys` (own-keys-only) and stamping the
  `docId` backref. Idempotent (skips folders with `_document.md`), non-destructive
  (no file deletes). *Test:* run on the corpus copy; re-run → no changes (idempotent);
  spot-check a migrated doc renders identically via `readDocMeta`.

- [ ] **Task 9 — Switch write paths.** `createDocumentInContainer` seeds
  `_document.md` (doc-level + docId + initial `files:`/`currentVersion`) and a
  version-only sidecar. `newDocumentVersion` appends to `files:` + updates
  `currentVersion` + appends the version event to `_document.md` `activityLog`
  (no more wholesale sidecar copy). `_saveMetaEdits` writes `_document.md`.
  `MetadataModal` writes doc-level `tags`/`links` to `_document.md`, per-file to
  the sidecar — all own-keys-only. *Test:* create a new doc → `_document.md`
  appears, sidecar is slim; cut a new version → manifest grows, no metadata
  duplication; inline edit persists to `_document.md`.

- [ ] **Task 10 — docId-keyed rollups.** Re-key `aggregateStakeholders` and the
  project cross-doc rollup from title to `docId` (via `DocIndex`). *Test:* two
  docs sharing a title no longer merge; renaming a title leaves rollups intact.

- [ ] **Task 11 — Hide `_document.md`.** Extend the existing sidecar-hiding CSS
  block to also hide `_document.md` from the file explorer; keep it indexed for
  graph/tags. *Test:* not visible in explorer; still in `metadataCache`.

- [ ] **Task 12 — Inline + deploy.** `node scripts/inline-doc-container.js`;
  `node --test`; deploy `main.js`/`manifest.json`/styles to OB_Testing.

- [ ] **Task 13 — Smoke gate (desktop + iPad).** On migrated real-corpus copy:
  browse tree, open a doc detail, edit metadata, cut a version, check a project
  rollup. Confirm no data loss vs the pre-migration report. iPad parity check.

---

## Out of scope (per spec — do NOT build here)
- `activityLog`/`noteLog` substrate change (NDJSON / body) — they remain in
  `_document.md` frontmatter for now.
- Conversion pipeline / corpus / diff (Phase 4/5); content **hashing**; audit
  reconciliation **UI** (Phase 3). The `files:` manifest only *enables* these.

## Risk register
| Risk | Mitigation |
|---|---|
| Migration data loss | Dry-run report first (Rung A); idempotent + non-destructive apply; read-fallback keeps partial state working |
| Reintroduced multi-writer clobber | Strict key ownership (`DOC_LEVEL_KEYS`/`VERSION_KEYS`) + own-keys-only writes |
| `metadataCache` not ready | Build `DocIndex` in `onLayoutReady`, not `onload` |
| `_document.md` deleted | CSS-hidden + in-folder; reconcile rebuilds from any sidecar still holding legacy keys |
