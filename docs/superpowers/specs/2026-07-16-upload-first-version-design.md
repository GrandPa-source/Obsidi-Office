# Upload First Version + Decide Later (Pending Documents) — Design

**Date:** 2026-07-16
**Branch:** `container-notes` (rides the container-notes → doc-container → master merge queue; the feature is doc-container domain, but recent doc-container fixes already land on this branch and OB_Testing runs it)
**Status:** Approved by Paul 2026-07-16 (Approach A of three presented)

## Problem

A doc container's first version can only be created from a template (`NewDocumentModal` → `createDocumentInContainer`). There is no way to bring an **existing** docx/pptx/xlsx in as the first working file, and no way to create a container whose file decision is deferred. Today `buildTaxonomy` only classifies a folder as a document if it directly contains a managed office file (`lib/doc-container.js:145-151`, sidecars discarded at :140), so a file-less container would be invisible in the Document Browser.

## Feature summary (Paul's spec)

1. **New Document modal** gains an **Upload** option alongside title + template selection — first version = an existing docx/pptx/xlsx the user brings in.
2. The modal gains a **Decide Later** button — create the container with a title only; no file, no format commitment.
3. In **Files & Versions**, when a container has no active working file, "+ New version" relabels to **Create file** with an **Upload** button beside it.

## Design

### 1. New state — "pending document"

A doc container folder whose only managed content is an explicitly versioned sidecar: `<Base>_V1.0.md` or `<Base>_V1.0.<ext>.md` (regex accepts both so a half-completed attach stays visible and retryable).

`buildTaxonomy` (lib/doc-container.js) changes:
- Collect sidecar names per folder (today discarded at the `isSidecar` skip).
- A folder with **no** managed office file and **no** `.cnote` body but **≥1** sidecar matching `/_V\d+\.\d+(\.[a-z0-9]+)?\.md$/i` classifies as `kind:'document'` with `pending: <sidecarName>`, `current: null`, `files: []`; stray non-office files remain `attachments`.
- Precedence: office file beats pending (normal document); `.cnote` beats pending (note container); pending only when neither is present.

Lib change protocol: `node scripts/inline-doc-container.js` regen + `node --test lib/doc-container.test.js`. New test cases: pending detected (both sidecar name forms); office file wins over pending sidecar; cnote folders unaffected; strays in a pending folder stay attachments; plain non-`_V` sidecars do NOT create a pending document.

Tree row shows the standard document icon plus a muted "(no file)" suffix so pending documents are spottable in the browser.

### 2. New Document modal — Upload option + Decide Later

Below the template grid: an "Or upload an existing file" row with an **Upload file…** button → hidden `<input type="file" accept=".docx,.pptx,.xlsx">` (iPad-safe tap-to-pick pattern, cf. P23). On pick:
- Filename chip with ✕ to clear.
- Format segment + Template grid grey out while a file is staged (format derives from the staged file's extension).
- Empty Title defaults from the filename stem (user-editable).

Button row becomes **Cancel | Decide Later | Create**:
- **Create**, file staged → `createDocumentFromUpload` (§4). No file staged → existing `createDocumentInContainer`, unchanged.
- **Decide Later** → Title required (button disabled while empty) → `createPendingDocument`: create title folder, write seeded `<Base>_V1.0.md` sidecar (title / status Draft / originationDate — same seeding as `createDocumentInContainer`), `appendLog('created (no file yet)')`, await sidecar cache, open detail page in edit mode (same flow/UX as today's create, including fresh-doc Cancel semantics and sidebar collapse).

### 3. Files & Versions pane on a pending container

`_renderFilesPane` (main.js ~4484) branches on `node.pending && !node.current`:
- Header actions: **Create file** (file-plus icon → NewDocumentModal variant: Title locked to folder name, format + template only) and **Upload** (upload icon → file picker directly, same accept filter).
- Body: empty-state line — "No working file yet — create one or upload an existing document."
- Normal containers: unchanged ("New version" as today).

`newDocumentVersion` is unreachable on pending nodes (its button is replaced), so no guard changes needed there.

### 4. Attach convergence — one choke point

All three file-arrival paths (modal upload; pending Create file; pending Upload) end in **one helper**:

`attachFirstVersion(docFolder, { ext, bytes | templatePath, originalName })`
1. **Rename sidecar first**: `<Base>_V1.0.md` → `<Base>_V1.0.<ext>.md`. If step 2 then fails, the container is still pending (regex accepts the ext-named form) and the attach is retryable. Metadata never migrates — it is already in its permanent home.
2. `vault.createBinary(<Base>_V1.0.<ext>, bytes)` — bytes from `file.arrayBuffer()` (upload) or template/embedded blank (create). createBinary-before-open: the established iPad-safe ordering (registry races on Capacitor adapter otherwise).
3. `appendLog` — uploads record the original filename (e.g. `first version uploaded — "FanoutPolicy_draft.docx"`); refresh Document Browser + container overview leaves; open/refresh detail.

`createDocumentFromUpload` = `createPendingDocument` + `attachFirstVersion` in sequence, so exactly one code path writes first versions from bytes. When composed this way, `createPendingDocument`'s detail-open step is suppressed (an option flag) — the detail page opens once, at the end of `attachFirstVersion`.

**Fidelity-layer seam (LATER, not in this build):** `attachFirstVersion` is the designated ingest point for the plaintext/markdown fidelity conversion proven in the 2026-07-15 PoC. No conversion code now; the product build starts as its own branch off master after the merge queue.

Uploaded files are **renamed** to `<Title>_V1.0.<ext>` — version-name discipline is load-bearing for `groupDocumentFiles` primary/current selection. The original name is preserved in the activity log only.

### 5. Detail page on pending nodes

One consistent rule — "the working sidecar is `node.current + '.md'`, or `node.pending` when `current` is null" — applied at all three choke points: `frontmatter()` (main.js:4285), `_mutateSidecar` (main.js:~4522), and `sidecarFor`. Metadata edits, notes, tags, and activity log then all work before a file exists. Existing `node.current` guards (e.g. the `revision` field) stay as-is.

### 6. Errors and edge cases

- Duplicate title → same Notice/abort as `createDocumentInContainer` today.
- Non-office file picked → Notice, stay in modal (belt-and-suspenders behind the `accept` filter).
- Upload write failure → Notice; container remains pending (rename-first ordering); retry via the pane buttons.
- Decide Later with empty title → button disabled.
- Hand-dropped pending folder (someone drops only a `_V1.0.md`) → gets the same Create file / Upload buttons; consistent with C9 hand-dropped-container handling.
- **Plan-phase verification item:** Rung-B `planReconcile` must not treat a pending folder as a stray needing repair (it skips `_document.md` folders today; pending folders need the same courtesy). Also confirm `buildDocIndex`/`readDocMeta` tolerate `current: null`.

### 7. Scope

**In:** everything above, on `container-notes`; manifest bump; deploy `main.js` + `manifest.json` to OB_Testing only; `node --check main.js` before every commit.

**Out (later working items):**
- Plaintext/fidelity conversion on upload (seam noted in §4).
- PDF uploads (pdf stays attachment-only; upload accepts docx/pptx/xlsx, matching the modal's formats).
- Upload-as-new-version on containers that already have files (the New version flow covers subsequent versions).

### 8. Testing

- Lib tests per §1 (pure-core, `node --test`).
- Manual desktop drill: modal upload × 3 formats; Decide Later → tree visibility → metadata edit while pending → Create file; Decide Later → Upload; duplicate-title abort; upload-failure retry (simulated); regression: template create unchanged, New version unchanged on normal containers.
- Then rides the pending iPad smoke session.

## Alternatives considered

- **B — dedicated marker file** (`_pending.md`): no rename on attach, but a new file convention beside `body.cnote`/`_document.md`, metadata migration on attach (second moving part), conceptual collision with note containers. Rejected.
- **C — phase it** (modal upload now, pending state later): ships less; Decide Later is half the spec and the relabeled buttons also cover hand-dropped folders. Rejected in favor of one coherent round.
