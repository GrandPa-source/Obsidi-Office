# Doc-Container — authorship attribution + check-out (design)

Date: 2026-06-19
Branch: `doc-container`
Status: design approved in conversation (Paul, 2026-06-19) — pending written-spec review, then plan.
Builds on: `2026-06-17-doc-container-document-md-metadata-migration-design.md` (Rung A built, Rung B pending).

## Problem

The doc-container now has a single document system-of-record (`_document.md`) and
a per-document history (`activityLog`). Two forward-looking needs surfaced:

1. **Authorship beyond one user.** The log records *what* happened but not *who*
   did it in a multi-user world. Desktop has a system username; **mobile has no
   system user** (iPad is a hard target). We want every log entry attributable,
   with the identity source pluggable later (e.g. the not-yet-built P01_WhiteList
   plugin) without a schema migration.

2. **Concurrent-edit safety on binary documents.** Obsidi-Office edits binary
   `.docx`/`.pptx`/`.xlsx`. There is no 3-way merge for binary — if two synced
   devices edit the same document, Obsidian Sync spawns a conflict copy and
   someone silently loses work. EDMS systems solve this with **check-out**.

The hard constraint behind both: **Obsidian Sync is eventually-consistent with no
central arbiter.** You cannot build a true mutex on top of a file-sync layer. So
check-out here is *coordination*, not a lock guarantee — designed honestly around
that limit, with a save-a-copy escape hatch so a lost race never loses work.

## Relationship to the deferred log-substrate change

The migration spec (§"Explicitly OUT of scope") deferred moving
`activityLog`/`noteLog` out of `_document.md` frontmatter "until Sync churn proves
it real." **This spec is that trigger.** Two reasons it now binds:

- Check-out stores its lock (`checkedOutBy`) **in `_document.md`**, and the
  check-out listener watches that file. If we also append every edit/save/open to
  an `activityLog` array in the same file, we churn the lock file constantly and
  muddy the very signal check-out depends on.
- Authorship makes the log grow faster (more entries, per-author).

So `_document.md` must stay **quiet** — slow metadata + the lock field only. The
log moves to a sibling **`log.md`** (the OKF `log.md` precedent noted in
`OB_Claude/references/open-knowledge-format.md`, takeaway #3).

## Decisions (locked by Paul, 2026-06-19)

1. **Log → a single `log.md` per document**, markdown body, OKF-aligned,
   author-stamped per entry. *Not* per-author files — check-out serializes
   editing, so the concurrent-writer pressure that would justify per-author files
   does not exist. Single `log.md` is sufficient and simpler.
2. **Per-entry format = markdown body** (human-readable in plain Obsidian; the
   detail-view Log tab already renders entries). Append newest-last (cheap
   append), reverse at read for display.
3. **Identity via one seam, `resolveAuthor()`** — desktop = system username
   (reuse the source the editor already injects); mobile = a settings-configured
   author label; later = `app.plugins.getPlugin('white-list')` if present. The
   lock and log never care where the id came from.
4. **Check-out lock = a single `checkedOutBy`/`checkedOutAt` field in
   `_document.md`; Sync arbitrates the winner** (last-write-wins by sync-receipt
   order). We do *not* control which racer wins — accepted, because the kicked
   user keeps their work via save-a-copy.
5. **Kicked-user escape hatch = save-a-copy, tracked as an outlier fork** tied to
   the common-ancestor version for later manual reconciliation.
6. **"Consolidate later" = surface + manual reconcile.** No automatic binary
   merge, no compare/diff view (that would need its own PoC; deferred).

## Explicitly OUT of scope (boundary)

- Per-author claim files / deterministic earliest-wins arbitration (considered,
  rejected in favour of the simpler Sync-arbitrated single field + save-a-copy).
- Any P2P / WebRTC / relay-server authorship. Not building real-time multi-user.
- A true mutex / distributed consensus over Sync (impossible by construction).
- P01_WhiteList integration — **seam only**; WhiteList is not yet built.
- Document compare/diff view for reconciliation (manual reconcile only for now).
- `noteLog` substrate — moves to `log.md` alongside `activityLog` for consistency,
  but no new note features here.
- **Document/project task-list feature** (Tasks tab + cross-doc open-task rollup +
  optional assignee) — deferred to **Rung D**. This spec only seeds the convention
  (below); it does not build the feature.

## Target schema

### `_document.md` — adds lock fields, drops the log arrays

```yaml
---
docContainer: document
docId: 7f3a9c2e
title: Fan-Out Policy
status: Active
# … all existing slow metadata unchanged …
currentVersion: FanOutPolicy_V2.0.docx
files: [FanOutPolicy_V1.0.docx, FanOutPolicy_V2.0.docx]
stakeholders: [ … ]
checkedOutBy: jsmith            # NEW. absent/empty = available
checkedOutAt: 2026-06-19T14:30:00.000Z   # NEW. ISO; absent when available
# activityLog / noteLog REMOVED from frontmatter → now in log.md
---
```

`checkedOutBy` holds the resolved author id (the `resolveAuthor()` slug). Absence
of `checkedOutBy` is the single source of truth for "available".

### `log.md` — per document, markdown body (NEW file)

Lives beside `_document.md` in the document folder; CSS-hidden like the other
container files. Append newest-last; reverse on read.

```markdown
---
docContainer: log
docId: 7f3a9c2e          # backref to the parent document
---
# Activity log

- 2026-01-15 09:00 · jsmith · created
- 2026-06-19 14:30 · jsmith · checked out
- 2026-06-19 15:10 · jsmith · edited
- 2026-06-19 15:12 · jsmith · checked in
- 2026-06-19 15:20 · pnicholson · fork saved (base FanOutPolicy_V2.0.docx)
```

Entry grammar (stable, parseable): `- <ISO-or-display datetime> · <actor> · <action>[ (<detail>)]`.
`actor` continues the existing `activityLog` field name. Actions:
`created`, `edited`, `opened`, `checked out`, `checked in`, `force check-in`,
`status → <x>`, `fork saved`, `reconciled`.

### Outlier fork copy + sidecar (NEW, only on a lost check-out race)

Written inside the document folder under a hidden `_forks/`:

```
Documents/.../Fan-Out Policy/
    _document.md
    log.md
    FanOutPolicy_V2.0.docx              ← current (winner lineage)
    _forks/
        FanOutPolicy_fork_pnicholson_20260619.docx
        FanOutPolicy_fork_pnicholson_20260619.docx.md   ← outlier sidecar
```

```yaml
---
docx: "[[FanOutPolicy_fork_pnicholson_20260619.docx]]"
forkOf: 7f3a9c2e                         # docId of the parent document
forkBaseVersion: FanOutPolicy_V2.0.docx  # common ancestor — the tie to the winner lineage
forkAuthor: pnicholson
forkAt: 2026-06-19T15:20:00.000Z
forkReason: checkout-conflict
reconciled: false                        # flips true on Mark reconciled
---
```

The fork is **not** added to the document's `files:` manifest — it is not a clean
version. Pending-reconciliation state is **derived** (scan the index for sidecars
with `forkOf` + `reconciled: false`), so there is no frontmatter list to keep in
sync.

## Architecture

### `resolveAuthor()` — the one identity seam

```
resolveAuthor(): { id, display }
  desktop: system username (reuse editor's existing username source / os.userInfo)
  mobile:  settings.authorLabel (configured once per device) || "unknown"
  later:   if white-list plugin present → its identity, else fall through
```

Returns a filename-safe `id` (slug) for `checkedOutBy`/`actor`/fork names and a
`display` for UI. Single function; every feature consumes it. P01 integration is
a one-function change behind this seam.

### Logging

- New helper `appendLog(docFolder, actor, action, detail?)` → `vault.append` to
  `log.md` (creates it on first use, seeded with the `docContainer: log` +
  `docId` header). Fire-and-forget; never blocks autosave.
- Existing log emit points (create / new-version / edit / open / status change,
  per the migration + B1 work) redirect from the frontmatter array to
  `appendLog`. The detail-view Log tab reads `log.md` (reverse for newest-first
  display) instead of `activityLog`.

### Check-out (Sync-arbitrated, advisory)

- **Check out / Check in** buttons on the document detail page. Check out writes
  `checkedOutBy`/`checkedOutAt` (via `processFrontMatter`) + `appendLog`. Check in
  clears them + `appendLog`.
- **Editor gating:** on open, if `checkedOutBy` is set and `!= resolveAuthor().id`,
  the editor opens **read-only with a banner** ("Checked out by <display>"). If
  unset or held by self, normal edit.
- **Race → kick:** a listener on `_document.md` (`metadataCache.on('changed')`,
  scoped to docRoot). After Sync delivers the arbitrated file, a device that has
  the editor open and finds `checkedOutBy != self` is the loser: drop the editor
  to read-only, show "Released — <display> holds this. Save your changes as a
  copy?" → on yes, run the fork-save flow.
- **Stale-lock breaker** (forgotten check-ins are the #1 EDMS-lite failure):
  a visible **Force check-in** action available to anyone (clears the lock +
  `appendLog` `force check-in`), plus an optional configurable
  `checkoutTimeoutHours` after which the detail page treats the lock as stale and
  offers Force check-in prominently.

### Fork-save + reconciliation (manual)

- **Fork save:** `vault.createBinary` the in-editor bytes to
  `_forks/<base>_fork_<author>_<date>.docx`, write the outlier sidecar, `appendLog`
  `fork saved (base <currentVersion>)`. iPad-safe (no `fs`).
- **Pending reconciliation** section on the detail page (derived from the index):
  each fork row shows author + `forkBaseVersion` + the document's current version,
  with actions **Open fork**, **Open current**, **Mark reconciled**.
- **Mark reconciled:** set `reconciled: true` on the fork sidecar + `appendLog`
  `reconciled`. (Whether to also move the fork out of `_forks/` or leave it as an
  archived record is a plan-time detail; default = leave it, flagged reconciled.)

## Task lists (forward-compat seed only)

Document- and project-level task lists will use **native Obsidian checkbox tasks
in the folder-note body** (`- [ ]` / `- [x]` under a `## Tasks` heading in
`_document.md` / `_project.md`) — **not** a frontmatter array. Rationale: zero
schema change (no migration), keeps the lock-bearing `_document.md` frontmatter
quiet, and interoperates for free with core search, Dataview, the Tasks plugin,
and P11_TaskBoard, since the substrate is standard markdown. Task toggles are
low-frequency (status-edit tier, not the per-save log firehose), so body churn is
acceptable and never produces a false check-out kick (the listener re-reads
frontmatter; `checkedOutBy` is unchanged).

**Seed now (Rung B):** the scaffolder that creates `_document.md` / `_project.md`
seeds an empty `## Tasks` section in the body, so the future Tasks tab + rollup
have a predictable home. **Build later (Rung D):** the Tasks tab (reads/toggles
the body checkboxes), the project-view **cross-doc open-task rollup** (scan each
member doc's `## Tasks`, keyed by `docId`, mirroring the stakeholder rollup), and
optional assignee via `resolveAuthor()` / Tasks-plugin syntax.

## Build sequencing

- **Rung B (current, imminent — fold in, no extra migration cost):**
  Because Rung B *creates* `_document.md` and the log paths for the first time:
  bake in the final schema — drop the log arrays, write the log to `log.md`,
  add the (empty) lock fields to the schema, and introduce `resolveAuthor()` +
  `appendLog`. Author-stamp the log from day one. Also seed an empty `## Tasks`
  section in the scaffolded `_document.md` / `_project.md` bodies (forward-compat,
  zero schema cost). The migration's read-fallback and dry-run discipline (already
  specced) cover this.
- **Rung C (next):** check-out UI + editor gating + race/kick listener +
  fork-save + Pending-reconciliation. All behind the existing `docBrowserEnabled`
  toggle.
- **Rung D (later, independent):** the document/project task-list feature — Tasks
  tab over the seeded `## Tasks` body section + project cross-doc open-task
  rollup. Body-only; no schema or migration dependency on B/C.

Doing the schema + log + seam in Rung B is the whole point: author attribution
and check-out become *light feature-adds*, never a second schema migration —
which was the original "minimize a heavier edit later" goal.

## Risks / mitigations

| Risk | Mitigation |
|---|---|
| Sync picks the "wrong" check-out winner | Accepted by decision; save-a-copy means the loser never loses work |
| Loser's in-window edits unmergeable | Fork copy tied to `forkBaseVersion`; surfaced for manual reconcile |
| Forgotten check-in blocks everyone | Force check-in (anyone) + optional timeout |
| `log.md` conflict during a race window | Small markdown file; conflict copy is recoverable; low-stakes vs binary content |
| Mobile has no system user | `settings.authorLabel` fallback; seam keeps it pluggable |
| Lock churns `_document.md` | Log moved out to `log.md`; `_document.md` changes only on metadata + checkout events |
| Scope creep into real multi-user sync | Explicitly out of scope; advisory-only stated up front |

## Next step

On written-spec approval: write the implementation plan
(`docs/superpowers/plans/2026-06-19-doc-container-authorship-checkout.md`),
splitting Rung B foldins (seam + `log.md` + schema) from Rung C (check-out +
fork/reconcile), with a smoke gate per rung on the real `Documents/` corpus.
