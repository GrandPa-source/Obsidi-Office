# OnlyOffice PDF Editor — Phase 0 Findings & Gate-1 Status (PAUSED)

**Date:** 2026-05-29 (updated same day — save investigation concluded)
**Status:** Gate 1 (desktop PoC) — **load + edit PROVEN. Native/structure-preserving SAVE is INFEASIBLE in our serverless browser runtime (conclusively ruled out, see §SAVE).** Only re-render-to-raster (Path R) is achievable with OnlyOffice; a true vector save needs a *different engine* (pdf.js / mupdf / PDFium). Phase 0b (iPad) not started. **Feature paused for a scope decision.**
**Spec:** `docs/superpowers/specs/2026-05-28-pdf-editor-design.md`
**Plan:** `docs/superpowers/plans/2026-05-28-pdf-editor-phase0.md`
**HEAD at pause:** `add7f97` + uncommitted save-investigation edits (see §Code state). PoC commit range: `6907f25..add7f97`.

This doc is the resume point. Read it first when picking this back up. The decisive section is §SAVE (root cause was corrected) and §Structure-preserving research.

---

## TL;DR — Gate 1 result

| Capability | Status | How |
|---|---|---|
| Embed OnlyOffice PDF editor (pdfeditor app) in the serverless blob-iframe + mock-socket harness | ✅ PROVEN | Same playbook as docx/pptx/xlsx — no new architecture |
| Native load + render a real PDF (NO x2t) | ✅ PROVEN | `document.isForm:false` + deliver PDF bytes under `origin.pdf` blob URL in `documentOpen` |
| Full **edit** mode ("Edit PDF", content editing) | ✅ PROVEN | `permissions.edit:true`, `mode:"edit"`; user edited text on screen |
| Open via command without hijacking Obsidian's native `.pdf` viewer | ✅ PROVEN | `_openInView` with `state.file`; `.pdf` NOT registerExtensions'd |
| No docx/pptx/xlsx regression | ✅ PROVEN | docx opened+rendered in same sessions |
| **Save edited PDF → clean vector file** | ❌ INFEASIBLE (OnlyOffice, serverless) | The engine's only PDF writer is the headless DocBuilder native module (`a["native"]`), not loaded in the browser editor. See §SAVE. |
| **Save edited PDF → re-rendered raster file (Path R)** | ✅ ACHIEVABLE (not yet wired) | Reuse the existing canvas+pdf-lib export pipeline. Pages become raster images + invisible text overlay. Lossy. |
| iPad (`drawingfile.wasm` in WKWebView) — Phase 0b | ⛔ NOT STARTED | Moot until the save-architecture decision is made. |

**Bottom line:** embedding + load + edit works on desktop. But **a structure-preserving (vector) save is not possible with OnlyOffice in our serverless/browser architecture** — every native PDF-write route is unavailable (§SAVE). The achievable OnlyOffice save is a raster re-render (Path R). A real vector save requires switching the *save engine* (or whole editor) to a browser-native PDF library — and even then, *editing existing body text* is infeasible in any browser library; only annotations/markup/form-fill survive as vector (§Structure-preserving research).

---

## What WORKS and exactly how (the load+edit pipeline)

1. **Assets**: pdfeditor frontend (`web-apps/apps/pdfeditor/`) acquired from the full v9.3.1 DocumentServer via Docker (`onlyoffice/documentserver:9.3.1` → `docker cp …/web-apps/apps/pdfeditor` into OB_Testing assets). The PDF **engine** binaries (`sdkjs/pdf/src/engine/drawingfile.wasm` etc.) were already on disk and are **identical** to the container's. The PDF editor loads `sdkjs/word/sdk-all.js` (the docx bundle — it has `AscPDF` ×436 compiled in). **Only the frontend was missing.**
2. **View**: `PdfView` (7 static getters) — `documentType:"pdf"`, `engineAppPath:"web-apps/apps/pdfeditor/main/"`, `engineSdkPath:"sdkjs/word/"`, `editorType:2`, ext `pdf`, sidecar `.pdf.md`.
3. **Open routing**: `_openInView(file)` calls `setViewState({type, active:true, state:{file: file.path}})`. The `state.file` is **mandatory** — without it the new view collapses to "empty" before the file loads (same bug as the sidecar-redirect saga). `.pdf` is deliberately NOT `registerExtensions`'d, so Obsidian's native PDF viewer stays the default; the throwaway `pdf-poc-open` command opens in the editor on demand.
4. **Load (x2t bypass)**: in `_onLoadFileInner`, `if (ext==="pdf")` skips `toEditorBin` and registers the **raw PDF bytes**. `params.docExt = this.fileExtension` is threaded into `window.__oo_params` so the iframe knows the format.
5. **`documentOpen` delivery**: mock-socket sets the dataMap key to **`origin.pdf`** (not `Editor.bin`) when `__oo_params.docExt==="pdf"`, as a `blob:` URL. The PDF native viewer reads `urls['origin.pdf']`.
6. **The `downloadfile/<hash>` request** the editor fires is the `checkExtendedPDF` **form-probe** (a 300-byte range read), NOT the document download. **`document.isForm:false` skips it entirely** — this was the fix that made the PDF render. (We also added a `/downloadfile/` intercept to the transport-shim as a fallback; with `isForm:false` it's moot but harmless.)
7. Benign noise (present for all editors): ServiceWorker registration failure on `app://`, `fonts_thumbnail@1.5x.png.bin` 404, "Refused to set unsafe header Accept-Charset", Canvas2D `willReadFrequently` hints.

---

## SAVE — corrected root cause + the conclusive feasibility map

### The earlier root cause was WRONG
The previous version of this doc said *"api.js does NOT forward `canSaveDocumentToBinary` (grep: zero references)"* and proposed injecting it at load. That was incorrect. **api.js line ~408 actually RECOMPUTES the flag** from the events object:
```js
_config.editorConfig.canSaveDocumentToBinary = _config.events && !!_config.events.onSaveDocument;
```
So api.js *overwrites* whatever we set on `editorConfig` — the flag is driven purely by whether we register an `events.onSaveDocument` handler. We never did, so it was always `false`.

### Enabling the flag the right way — and what it revealed
**FIX APPLIED:** added `onSaveDocument` (pdf-scoped) to the `events` object in `_buildEditorConfig()`. Verified this makes the flag `true` and the engine enters binary-save mode. **But this only exposed the real wall:** with binary-save on, `asc_Save()` for a PDF takes the engine's *Branch B* (XHR/server route, because `asc_isSupportFeature("ooxml")` is false for PDF — only docx/pptx/xlsx take the clean in-memory Branch A). The result:
- The engine POSTs an internal **save-bin** to `/downloadas/` → our `_downloadAs` captured **138218 bytes** whose signature is `25 50 44 46 d0 1b 02 00` = `%PDF` + OnlyOffice binary marker. **A real PDF starts `25 50 44 46 2d 31 2e` (`%PDF-1.`). This is the internal save-bin, not a PDF.** It needs server-side x2t conversion — and **x2t-wasm cannot write PDF** (long-established in P21; it's exactly why the docx→PDF export uses canvas+pdf-lib instead).
- The `asc_onSaveDocument`/`Common.Gateway.saveDocument` callback fires with a **0-byte buffer** (the engine's follow-up XHR-GET to re-fetch the converted file returns empty from our shim). Empty.

### Every native PDF-write route — ruled out
| Route | Verdict | Why |
|---|---|---|
| `asc_Save()` / `asc_DownloadAs(513)` → `/downloadas/` | ❌ | Produces the save-bin (`%PDF d0 1b 02 00`); needs server x2t; x2t-wasm can't write PDF. |
| `asc_onSaveDocument` / Gateway callback | ❌ | Fires with 0 bytes (no server to return the converted file). |
| **`asc_nativeGetPDF()`** (engine's own PDF writer) | ❌ | **TESTED — threw `Cannot read properties of undefined (reading 'Save_End')`.** It calls `a["native"].Save_End(...)`; `a["native"]` is the headless **DocBuilder/conversion** runtime (`IS_NATIVE_EDITOR`), NOT loaded in the interactive browser editor. The function is unguarded and assumes that runtime. Also it just loops `asc_nativePrint` over pages — a render path. |
| `drawingfile.wasm` incremental save | ❌ | The 217-line `drawingfile.js` wrapper exposes read/render/page-ops (`_openFile`,`_getPixmap`,`_getStructure`,`_SplitPages`,`_RedactPage`,`_getAnnotationsInfo/AP`,`_getInteractiveFormsInfo/AP`…) but **NO PDF serializer/writer**. |
| Force engine offline mode (`asc_isOffline`→true, gated on `file://`) | ❌ | Wouldn't help — the offline branch invokes the same `a["native"]` writer that isn't loaded. |
| x2t-wasm reverse for PDF | ❌ | Cannot produce PDF (established). |

**Conclusion:** OnlyOffice has no client-side PDF writer in our serverless/browser runtime. The only OnlyOffice-based save is **Path R** — reuse the existing canvas+pdf-lib export pipeline (`captureAndExportPdf("export")`) to re-render the edited pages → real, openable, *searchable* PDF, but **rasterized** (page images + invisible text overlay; original vector/structure not preserved). Not yet wired into the pdf save path.

---

## Current code state (all `// PDF PoC` tagged; behind the `pdf-poc-open` command; deployed to OB_Testing, UNCOMMITTED)

⚠️ The save path currently calls `asc_nativeGetPDF()`, which **throws** (native writer absent), so **Ctrl+S on a PDF logs an error and saves nothing**. This is the spike's end-state, intentionally left for documentation. Nothing here touches docx/pptx/xlsx.

**`main.js`:**
- `VIEW_TYPE_PDF` const; `PdfView` class (after `XlsxView`).
- `onload`: `registerView(VIEW_TYPE_PDF…)` + `addCommand("pdf-poc-open")`; `detachLeavesOfType(VIEW_TYPE_PDF)` in `onunload`.
- `_openInView`: `pdf → VIEW_TYPE_PDF` branch + `state.file` fix (GENERAL improvement — benefits docx/pptx/xlsx "open current" too).
- `_onLoadFileInner`: `if (ext==="pdf")` native-load branch (skip x2t).
- `params.docExt` threaded into `__oo_params`.
- `_buildEditorConfig`: `document.isForm:false` (pdf). The inert `canSaveDocumentToBinary` line was REMOVED (api.js recomputes it); replaced with a comment pointing to `events.onSaveDocument`. **NEW:** `events.onSaveDocument: fileExtension==="pdf" ? ()=>{} : undefined` — this is the real load-time switch that flips api.js's flag true (pdf-scoped).
- `TransportBridge._onMessage`: `type:"pdf-save"` branch → writes to `*.pocsave.pdf`. **NEW:** guarded `d.bytes.byteLength > 0` (never write empty).
- `TransportBridge._downloadAs`: `ext==="pdf"` → write bytes directly to `*.pocsave.pdf`. **NEW:** diagnostic logs the PDF signature (head/tail). NOTE: with the current `asc_nativeGetPDF` save path this branch is no longer hit (we don't call `asc_Save`); it only fired during the earlier flag test.
- `onDocumentStateChange`: `if (fileExtension==="pdf") return;` (autosave disabled for pdf). `customization.autosave:false` for pdf.

**`assets/docx-viewer/transport-shim.js`:** `/downloadfile/` intercept (moot with `isForm:false`; harmless). Still has a diagnostic `console.log` — remove on cleanup.

**`assets/docx-viewer/mock-socket.js`:**
- `documentOpen`: `origin.pdf` key for pdf.
- `triggerSaveToVault`: pdf branch now calls **`asc_nativeGetPDF()`** directly (bypasses `asc_Save()`), logs len/head/tail, posts bytes via `_postPdfBytes`. Falls back to `asc_Save()` only if the method is absent. ⚠️ `asc_nativeGetPDF()` throws in our runtime — see §SAVE.
- `ensurePdfSaveHook()`: collapsed to a single `Common.Gateway.saveDocument` wrapper (dead `put_SupportsOnSaveDocument` + duplicate `asc_onSaveDocument` registration removed). Guards empty buffer. Only reached via the asc_Save fallback now.
- `_postPdfBytes()`: posts `{type:"pdf-save", bytes}` to the bridge.

---

## Assets / deploy state

- **pdfeditor frontend (~39 MB) is in OB_Testing assets only** (`…/assets/onlyoffice/web-apps/apps/pdfeditor/`), acquired via Docker. **NOT committed** (gitignored binaries) and **NOT yet added to `scripts/build-assets.js`** — so it's desktop-only and not in the v9.3.x asset zip. Adding it to the zip (un-drop `sdkjs/pdf`, add pdfeditor to HTML_TO_PATCH + locale trim, rebuild + GitHub release) is part of Phase 0b/Phase 1, NOT done.
- Docker image `onlyoffice/documentserver:9.3.1` was pulled (still local; can be removed to reclaim ~2.5 GB).
- Staging copy at `OB_Testing/_pdfpoc/ds-sdkjs-pdf` + `_pdfpoc/00-acquire.md` — disposable.

---

## Cleanup checklist (do on resume, NOT now — keep PoC intact)

- Corrupted test PDFs in OB_Testing: `CHROME_Sent Items - Paul Nicholson - Outlook.pdf` (138218-byte bin from the 513 attempt) and earlier `Outlook.pdf` (1606-byte stub) — replace with fresh copies.
- `*.pocsave.pdf` files; `_pdfpoc/` folder; staged `ds-sdkjs-pdf`.
- Remove the transport-shim `downloadfile` diagnostic `console.log`.
- Decide: keep `/downloadfile/` shim intercept (harmless fallback) or remove.
- Once save works: flip `*.pocsave.pdf` → real `doc.filePath`; re-enable pdf autosave; reconcile the two save paths (`_downloadAs` ext==="pdf" branch vs the `pdf-save` message path).

---

## Structure-preserving save — feasibility research (2026-05-29, 3 parallel agents)

User's question on pause: *"surely because we can still interact & edit the PDF there is enough information to still save non-flattened/rasterized pages."* Researched three angles: (A) what edit data OnlyOffice exposes client-side; (B) the browser PDF-write library ecosystem; (C) how existing browser PDF editors do non-raster save. Convergent answer below.

### A — What OnlyOffice exposes client-side (codebase RE)
- **Edit model:** With `isForm:false`, edits flow through the **same document-history/transaction system as Word** (`asc_EditPage`→`Kei`, `AddFreeTextAnnot`→`VWd`, all via the history wrapper). Existing page text, once edited, is **reflowed into the engine's private CDocument model** — not stored as recoverable PDF objects.
- **Extractable as structured JS:** **annotations** (`getAnnotationsInfo` → per-annot type/page/rect/color/contents + rich-text runs + `InkList`/`QuadPoints`/`Vertices`) and **form values** (`asc_GetAllFormsData`/`asc_GetFormValue`/`getInteractiveFormsInfo().Fields[]`). ✅
- **NOT extractable:** edits to **existing body text** — no structured op log; only an opaque glyph-draw buffer or re-render. ❌
- **Appearance streams are NOT vector:** `_getAnnotationsAP`/`_getInteractiveFormsAP` take **pixel w/h + background** and return **raster pixmaps**, not PDF `/AP` content streams. So the hoped-for "splice the AP into the original PDF" shortcut **does not exist.**
- **Guardrails:** page add/remove/rotate/merge and **redaction** break any original-bytes mapping; redaction-as-overlay would leak data (security defect). Must detect and bail/full-rebuild.

### B + C — Browser PDF-write ecosystem & the real architecture
The dominant browser pattern for non-raster save: **keep original PDF bytes immutable + represent edits as an annotation/object layer + write them as real PDF objects (incremental update) on save.** Vector preservation = editing the PDF *object graph*, not pixels. **Crucially, NO browser library edits/reflows existing body text** — that's native/server-only (Acrobat, Qoppa, Foxit). pdf.js, mupdf, PDFium all scope to annotations/forms/page-ops.

| Engine | License | In-browser edit+save | Notes |
|---|---|---|---|
| **pdf.js** annotation editor + `saveDocument()` | Apache-2.0 | FreeText/Ink/Stamp/Highlight + form fill → incremental save | Ships in Firefox; save is **viewer-coupled / internal-dependent** (not a clean headless API). Pure JS, **no SharedArrayBuffer** (solves the iPad gate). `/AP` + CJK font-embed gotchas. |
| **mupdf.js** (WASM) | **AGPL-3.0** / commercial | Annotations + **redaction** + forms + page ops + true `saveToBuffer("incremental")` | Most capable single engine. ~8–15 MB wasm. Single-threaded (no SAB). AGPL — but OnlyOffice is already AGPL, so may be license-consistent. |
| **EmbedPDF `@embedpdf/pdfium`** (WASM) | **MIT wrapper + BSD/Apache PDFium** | annotations, forms, page ops, `saveAsCopy()` | **Permissive** (AGPL escape hatch). ~3–6 MB wasm, single-threaded. Newer/less proven — needs its own Gate-1 PoC. |
| **pdf-lib** (`@cantoo/pdf-lib` fork) | MIT | form-fill + add new content/annotations (hand-built dicts); **full-rewrite** save | No existing-text edit; weak incremental (fork-only). Good for the *reconstruct* half if paired with an extractor. |

### Synthesis / strategic conclusion
1. **OnlyOffice is the wrong engine for a vector PDF save.** It uniquely attempts *full text editing* — the one thing no browser engine can save client-side. Its save needs the server/headless native writer we don't have.
2. **The edits we CAN extract from OnlyOffice (annotations + form-fill) are exactly the subset a purpose-built browser annotator handles natively and saves losslessly — without OnlyOffice at all.** Trying to extract-then-rebuild via pdf-lib is possible for those types but redundant and fiddly (pdf-lib has no high-level annotation API; OnlyOffice AP is raster).
3. **Full existing-text editing + vector save is infeasible client-side in any library.** Treat it as out of scope (or "redact region + overlay text", which is brittle).

### Decision options for resume (pick one)
- **(R) Ship raster save with OnlyOffice.** Wire `captureAndExportPdf("export")` → pocsave/real path. Keeps full-edit UX; output is flattened+searchable. Lowest effort. Honest framing: "edit, then flatten-to-PDF on save."
- **(S) Re-scope to an annotation/markup/form PDF editor on a browser-native engine.** Drop OnlyOffice for PDFs; adopt **pdf.js editor + saveDocument()** (permissive, no SAB, pure JS — also clears the iPad Phase-0b gate) or **mupdf.js** (more capable, AGPL) or **EmbedPDF/PDFium** (permissive WASM). True vector save; no existing-text edit. This is the architecturally-correct path if the goal is "markup/fill/sign a PDF and save a real PDF."
- **(X) Shelve the PDF editor.** docx/pptx/xlsx editing + the existing docx→PDF *export* already cover the high-value cases.

Recommendation: **(S) with pdf.js** if a real (non-raster) PDF editor is wanted and annotation/markup/form scope is acceptable; **(X)** if not worth the build; **(R)** only if full-content-edit UX matters more than output fidelity.

## How to reproduce the current state (≈30s)

1. OB_Testing already has the deployed plugin + pdfeditor assets. Full-restart Obsidian.
2. Put a text PDF in the vault; run command **"PDF PoC: open active/last .pdf in editor"**.
3. PDF renders in the OnlyOffice editor; "Edit PDF" → edit works. Ctrl+S → logs `triggerSaveToVault — asc_nativeGetPDF() [pdf]` then `asc_nativeGetPDF failed: TypeError … 'Save_End'` — **nothing saved** (native writer absent; this is the documented end-state, not a regression to fix in place).

## Reminder of the larger plan (now contingent on the §SAVE decision)
- **The save architecture must be decided first** (options R/S/X above). Phase 0b and Phase 1 are moot until then:
  - If **(S) pdf.js / EmbedPDF-PDFium**: those are single-threaded (no SharedArrayBuffer) — the iPad Phase-0b SAB gate largely evaporates. mupdf.js is also single-threaded per its docs.
  - If **(R) raster via OnlyOffice**: Phase 0b reverts to the original `drawingfile.wasm`-in-WKWebView SAB question.
- Phase 1 (toggle, ribbon, sidecar 4-way, Search, build-assets + zip ship) stays gated on the save decision + iPad pass.
- **Cleanup if abandoning the OnlyOffice PDF route:** the PoC `// PDF PoC` code is isolated behind `pdf-poc-open` and doesn't touch docx/pptx/xlsx; the `events.onSaveDocument` pdf-scoped addition and the `state.file` fix in `_openInView` are harmless general improvements worth keeping regardless.
