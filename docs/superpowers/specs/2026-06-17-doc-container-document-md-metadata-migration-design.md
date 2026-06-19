# Doc-Container — `_document.md` metadata migration (design)

Date: 2026-06-17
Branch: `doc-container`
Status: approved (Paul, 2026-06-17) — proceed to plan + prototype. `docId` = generated short id (locked).

## Problem

Today, document-level metadata lives on the **per-version sidecar**
(`FanOutPolicy_V1.0.docx.md`) and is copied wholesale on "New version"
(`main.js` ≈ 6630). A "Document" is the logical thing the UI manages, but its
facts (`status`, `stakeholders`, `summary`, review cadence, `activityLog`) are
physically stored on a version file. This produces four concrete defects we have
already hit or can see in the code:

1. **Divergence** — metadata edits write only the *current* version's sidecar;
   older versions keep stale copies. Not designed snapshotting — an accident of
   the copy.
2. **Fragmented history** — `activityLog` forks per version (copy then append),
   so only the latest sidecar holds the longest log; there is no single
   authoritative document history.
3. **Inconsistent carry-forward** — `activityLog` copies forward but `noteLog`
   does not, stranding notes on old versions.
4. **Title-as-identity** — `title` is simultaneously the folder name, a
   frontmatter field, and the rollup key (`aggregateStakeholders` groups by
   title, `doc-container.js:222`). Rename → folder path and frontmatter diverge;
   rollups merge or split documents. There is no stable id.

We compared `_document.md` (folder-note) vs SQLite for the folder/project +
manifest layer. `_document.md` wins on every constraint that binds here
(iPad/mobile, Sync-safety, agent-readability, survives-uninstall, build cost);
SQLite wins only on relational query speed, which does not bind at
governance-vault scale and is matched by an in-memory index. **Decision: stick
with `_document.md`** (Paul, 2026-06-17).

## Document model (unchanged on disk)

A document remains a **folder** named with its human title, holding version
files + sidecars. This spec adds one file to that folder:

```
Documents/Governance/Policies/Fan-Out Policy/      ← document (folder)
    _document.md                                    ← NEW: document system-of-record
    FanOutPolicy_V1.0.docx … _V2.0.docx             ← versions
    FanOutPolicy_V1.0.docx.md … _V2.0.docx.md       ← per-version sidecars (shrunk)
    consultation-notes.txt                          ← attachment (stray file)
```

Mirrors the existing `_project.md` folder-note pattern for project containers.

## Decisions

**Locked (Paul):**
1. `_document.md` is the **system of record** for document-level metadata.
   SQLite is dropped; the "rebuildable cache" the DB was meant to be becomes an
   **in-memory index** built from `metadataCache`.

**Proposed in this spec (for approval):**
2. Introduce a stable **`docId`**, generated once, never changed. All
   cross-document rollups key on `docId`, never on `title` or path.
3. `_document.md` frontmatter carries an explicit **`files:` manifest** (expected
   version filenames) — the durable, synced "expected files" record that
   unblocks Phase-3 audit without a binary DB.
4. **Per-version sidecars shrink** to version-only facts. Doc-level keys move out
   of them into `_document.md`.
5. **Clear ownership:** doc-level keys live ONLY in `_document.md`; version keys
   live ONLY in the sidecar. Every write uses `processFrontMatter` own-keys-only.
6. **Read-fallback for safety:** if `_document.md` is absent, readers fall back to
   the current-version sidecar — so migration is incremental and non-breaking.

**Explicitly OUT of scope (deferred, listed so the boundary is clear):**
- `activityLog` / `noteLog` substrate change (NDJSON / markdown-body). For now
  the logs ride along in `_document.md` frontmatter. Revisit only if multi-device
  Sync churn proves the YAML-array merge cost real — do not build NDJSON infra
  speculatively.
- Conversion pipeline / LLM corpus / version diff (Phase 4/5).
- Content **hashing** for external-edit detection — the manifest holds filenames
  now; hashes are a later add.
- Audit/reconciliation **UI** (Phase 3) — this spec only lays the manifest that
  makes it possible.

## Target schema

### `_document.md` (system of record — one per document folder)

```yaml
---
docContainer: document          # marker (mirrors _project.md "type: project")
docId: 7f3a9c2e                 # stable, generated once via crypto.randomUUID() (short slice ok)
title: Fan-Out Policy
docNumber: POL-2024-001
docClass: Policy                # DOC_CLASSES enum
status: Active                  # STATUS_VALUES enum
department: Compliance
originator: Jane Smith
originatorTitle: Compliance Manager
originationDate: 2026-01-15
effectiveDate: 2026-02-01
reviewFrequencyDays: 90
nextReviewDate: 2026-05-01      # cached/derived; recomputed when blank
summary: Policy for data protection
tags: [governance, compliance] # doc-level, graph-indexed
currentVersion: FanOutPolicy_V2.0.docx
files:                          # expected-files manifest
  - FanOutPolicy_V1.0.docx
  - FanOutPolicy_V2.0.docx
stakeholders:                   # low-churn structured records stay as YAML
  - { name: Jane Smith, title: Compliance Manager, role: Originator, dept: Compliance }
relatedDocuments:               # use [[wikilinks]] so Obsidian repairs on rename
  - { kind: link, target: "[[Records Retention Policy]]", label: Records Retention }
definitions: [g-001, g-002]
activityLog:                    # rides here for now (substrate deferred)
  - { datetime: "2026-01-15 09:00", actor: jsmith, action: "Document created", type: create }
noteLog: []
---
```

`docContainer: document` distinguishes it from `_project.md` and from ordinary
notes; CSS-hides it like the existing sidecars/`_project.md`.

### Per-version sidecar (`<file>.docx.md` — shrunk)

```yaml
---
docx: "[[FanOutPolicy_V1.0.docx]]"   # keeps the binary visible in the graph
docId: 7f3a9c2e                       # backref to parent _document.md (move-resilient pairing)
created: 2026-01-15T09:00:00.000Z
modified: 2026-01-15T09:00:00.000Z
versionNote: "Initial release"        # optional, per-version
tags: []                              # optional, for this file's own discoverability
links: []                             # optional
---
```

Doc-level keys (`status`, `stakeholders`, `summary`, dates, logs, …) are
**removed** from sidecars and owned by `_document.md`.

## Architecture

### In-memory index (the rebuildable cache)

- Built at `app.workspace.onLayoutReady` by scanning `metadataCache` for files
  named `_document.md` (and `_project.md`) under `docRoot`. No disk reads beyond
  the cache; no persisted file.
- Shape: `Map<docId, DocRecord>` plus derived views computed on demand from the
  map (by-status, overdue-reviews, stakeholder-across-docs, project rollup).
- Kept warm incrementally via `metadataCache.on('changed')` + the existing
  vault `create`/`delete`/`rename` listeners (registered inside
  `onLayoutReady`, per the known startup-burst lesson).
- **Fully rebuildable from disk** → losing it costs nothing. `_document.md` files
  are the durable truth; the index is the optimization. (This is the inverse of
  the SQLite framing: the folder-notes are source of truth, the cache is in RAM.)

### Rollups key on `docId`

`aggregateStakeholders` and the project cross-doc rollup change from
title-keyed to `docId`-keyed. Renaming a title or moving a folder no longer
merges/splits records.

### Durability of `_document.md`

Unlike the in-memory index, `_document.md` is NOT rebuildable — `status`,
`stakeholders`, `summary` are not derivable from disk. So it is protected, not
disposable: CSS-hidden (users don't see it to "tidy" it — the handover's
folder-note worry), lives *inside* the document folder (not a loose top-level
file), and is recreated by the reconcile if a sidecar still carries legacy
doc-level keys.

## One-time migration (reconcile + backfill)

A command **"Doc-Container: migrate metadata to `_document.md`"**, dry-run first.
Per document folder under `docRoot`:

1. If `_document.md` exists → skip (idempotent).
2. Read the **current version's** sidecar (richest copy) frontmatter.
3. Create `_document.md`: `docContainer: document`, fresh `docId`, all doc-level
   keys lifted from the sidecar; build `files:` from the folder's managed files;
   set `currentVersion`.
4. Rewrite each version sidecar down to the version-only schema (keep
   `docx`/`created`/`modified`/`tags`/`links`; stamp `docId`; drop doc-level
   keys).
5. Report: documents migrated, keys moved, anything ambiguous (e.g. divergent
   metadata across versions → current wins, others logged).

Safety: dry-run report before writing; idempotent; read-fallback means a
half-migrated vault still renders; no destructive delete of sidecars (only key
removal via `processFrontMatter`).

## Write paths to update

- `createDocumentInContainer` — seed `_document.md` (not the sidecar) with
  doc-level keys + `docId` + initial `files:` + `currentVersion`; sidecar gets
  version-only seed.
- `newDocumentVersion` — append filename to `files:`, update `currentVersion` in
  `_document.md`; append the version event to `_document.md` `activityLog`; new
  sidecar gets version-only seed (no more wholesale copy).
- `_saveMetaEdits` (DetailView inline edit) — write to `_document.md`.
- `MetadataModal` — continues to own `tags`/`links` but on the appropriate file
  (doc-level tags → `_document.md`; per-file tags → sidecar). Keep own-keys-only.
- All readers (DetailView, ContainerOverviewView, taxonomy rollups) — prefer
  `_document.md`, fall back to current-version sidecar.

## Risks / mitigations

| Risk | Mitigation |
|---|---|
| Migration data loss | Dry-run + idempotent + non-destructive key removal + read-fallback |
| Two writers reintroduce clobber | Strict ownership split + `processFrontMatter` own-keys-only |
| `metadataCache` not ready at startup | Build index in `onLayoutReady`, not `onload` |
| `_document.md` accidentally deleted | CSS-hidden, in-folder (not loose), reconcile can rebuild from any sidecar still carrying legacy keys |
| Vault file count grows (+1/doc) | Negligible at governance scale |

## Resolved decisions

- `docId` format (**locked, Paul 2026-06-17**): **generated short id** — 8-char
  slice of `crypto.randomUUID()` (collision-checked against the in-memory index
  at generation). `docNumber` stays a separate human field, never used as
  identity.

## Next step

On approval: write the implementation plan
(`docs/superpowers/plans/2026-06-17-doc-container-document-md-metadata.md`) with
task breakdown + smoke gate, then build behind the existing `docBrowserEnabled`
toggle. Recommend building the reconcile command + read-fallback **first** so the
schema change is reversible and dogfoggable on the real `Documents/` corpus
before any write path is switched over.
