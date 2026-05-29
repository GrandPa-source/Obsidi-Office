# OnlyOffice PDF Editor — Phase 0 Findings & Gate-1 Status (PAUSED)

**Date:** 2026-05-29
**Status:** Gate 1 (desktop PoC) — **load + edit PROVEN; save BLOCKED (one lever identified).** Phase 0b (iPad) not started.
**Spec:** `docs/superpowers/specs/2026-05-28-pdf-editor-design.md`
**Plan:** `docs/superpowers/plans/2026-05-28-pdf-editor-phase0.md`
**HEAD at pause:** `add7f97`. PoC commit range: `6907f25..add7f97` (spec/plan + 10 PoC commits).

This doc is the resume point. Read it first when picking this back up.

---

## TL;DR — Gate 1 result

| Capability | Status | How |
|---|---|---|
| Embed OnlyOffice PDF editor (pdfeditor app) in the serverless blob-iframe + mock-socket harness | ✅ PROVEN | Same playbook as docx/pptx/xlsx — no new architecture |
| Native load + render a real PDF (NO x2t) | ✅ PROVEN | `document.isForm:false` + deliver PDF bytes under `origin.pdf` blob URL in `documentOpen` |
| Full **edit** mode ("Edit PDF", content editing) | ✅ PROVEN | `permissions.edit:true`, `mode:"edit"`; user edited text on screen |
| Open via command without hijacking Obsidian's native `.pdf` viewer | ✅ PROVEN | `_openInView` with `state.file`; `.pdf` NOT registerExtensions'd |
| No docx/pptx/xlsx regression | ✅ PROVEN | docx opened+rendered in same sessions |
| **Save edited PDF → clean file** | ❌ BLOCKED | Needs **load-time `canSaveDocumentToBinary` injection** (see below) |
| iPad (`drawingfile.wasm` in WKWebView) — Phase 0b | ⛔ NOT STARTED | Still the open feasibility risk for cross-platform |

**Bottom line:** the core feasibility question ("can the PDF editor be embedded + load + edit in our localhost-free architecture?") is **YES, on desktop**. Save is the lone holdout and is solvable but needs a deeper, load-time config change.

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

## The SAVE blocker — root cause + the exact next lever

**Symptom:** `asc_Save()` (and `asc_DownloadAs(513)`) do not produce a clean PDF. `asc_DownloadAs(513)` via `/downloadas/` POST yields a non-standard file (`%PDF` + binary `d0 1b 02 00`, "Unknown error") — OnlyOffice's internal save-bin, because x2t-wasm **cannot** produce PDF (confirmed in prior P21 research). `asc_Save()` falls back to the collaborative **socket** route (`isSaveLock → saveChanges → onDocumentStateChange:false`) and never emits a binary.

**Root cause (confirmed):** The PDF editor only enters **client-side binary-save mode** when `editorConfig.canSaveDocumentToBinary` is true at **document-load** time. pdfeditor `app.js`:
```
this.appOptions.canSaveDocumentToBinary = this.editorConfig.canSaveDocumentToBinary;
i.put_SupportsOnSaveDocument(this.editorConfig.canSaveDocumentToBinary);   // i = asc_CDocInfo, set via asc_setDocInfo at LOAD
t.appOptions.canSaveDocumentToBinary && t.api.asc_registerCallback("asc_onSaveDocument", ...)
```
Two hard facts that block the obvious fixes:
- **`api.js` does NOT forward `canSaveDocumentToBinary`** (grep: zero references). So setting it in our `_buildEditorConfig().editorConfig` never reaches the app.
- **`put_SupportsOnSaveDocument` is NOT on `window.Asc.editor`** (runtime: "is not a function"). It lives on the `asc_CDocInfo` consumed at load. So it **cannot be set post-load** from the iframe. Registering `asc_onSaveDocument` in-iframe succeeds but never fires, because binary-save mode was never enabled.

**The next lever (the focused resume task):** inject `canSaveDocumentToBinary: true` into the config **at the point the pdfeditor app reads `this.editorConfig`** — i.e. load-time. Candidate approaches, in rough order of likelihood:
1. **Patch the app's config intake / the init message.** Find where the app sets `this.editorConfig` (it comes from the `{command:"init", data:{config}}` postMessage that api.js sends, or the app's own config processing). Patch our eval'd `api.js` (we already string-patch `frameOrigin`) to inject `canSaveDocumentToBinary:true` into the config it forwards for pdf, OR intercept the init postMessage in the iframe and add the flag before the app consumes it.
2. **Set it on the `asc_CDocInfo` before `asc_LoadDocument`.** If we can reach the docInfo construction in-iframe (the app builds it during `loadDocument`), call `put_SupportsOnSaveDocument(true)` on **it** (not the editor) before load completes.
3. If neither is reachable cleanly, fall back to the **Gateway `onSaveDocument`** flow end-to-end (we already hook `Common.Gateway.saveDocument`; it just never gets bytes because the app never calls `onSaveDocumentBinary` without the flag).

Once binary-save mode is on, the rest is already built: `asc_Save()` → `asc_onSaveDocument`/`Common.Gateway.saveDocument` → our hook posts `{type:"pdf-save", bytes}` to the bridge → bridge writes the file. The capture + write path is wired and waiting.

**Ruled out:** `asc_DownloadAs(513)` + `/downloadas/` (produces non-PDF bin); x2t reverse for PDF (x2t-wasm can't make PDF); post-load `put_SupportsOnSaveDocument` on the editor (method absent).

---

## Current code state (all `// PDF PoC` tagged; behind the `pdf-poc-open` command)

**`main.js`:**
- `VIEW_TYPE_PDF` const; `PdfView` class (after `XlsxView`).
- `onload`: `registerView(VIEW_TYPE_PDF…)` + `addCommand("pdf-poc-open")`; `detachLeavesOfType(VIEW_TYPE_PDF)` in `onunload`.
- `_openInView`: `pdf → VIEW_TYPE_PDF` branch + `state.file` fix (the `state.file` fix is a GENERAL improvement — benefits docx/pptx/xlsx "open current" too).
- `_onLoadFileInner`: `if (ext==="pdf")` native-load branch (skip x2t).
- `params.docExt` threaded into `__oo_params`.
- `_buildEditorConfig`: `document.isForm:false` (pdf) + `editorConfig.canSaveDocumentToBinary:true` (pdf) [latter is INERT — api.js drops it; left as documentation of intent].
- `TransportBridge._onMessage`: `type:"pdf-save"` branch → writes to `*.pocsave.pdf` (PoC-safety path).
- `TransportBridge._downloadAs`: `ext==="pdf"` → write bytes directly (skip toSourceFormat) to `*.pocsave.pdf` [from the asc_DownloadAs(513) attempt — now superseded by the pdf-save message path; revisit on cleanup].
- `onDocumentStateChange`: `if (fileExtension==="pdf") return;` (autosave disabled for pdf — PoC safety).
- `customization.autosave`: `false` for pdf.

**`assets/docx-viewer/transport-shim.js`:**
- `/downloadfile/` added to DYNAMIC + dispatch → `handleGetDownloadFile()` (serves bytes as application/pdf). Moot with `isForm:false`; harmless. **Has a diagnostic `console.log` in `isDynamic` for `downloadfile` URLs — remove on cleanup.**

**`assets/docx-viewer/mock-socket.js`:**
- `documentOpen`: `origin.pdf` key for pdf.
- `triggerSaveToVault`: `if (docExt==="pdf")` → `ensurePdfSaveHook()` + `asc_Save()`.
- `ensurePdfSaveHook()` + `_postPdfBytes()`: enables binary save in-iframe (currently INERT — `put_SupportsOnSaveDocument` not on editor) + registers `asc_onSaveDocument` + Gateway fallback hook.
- Fit-to-width ready block calls `ensurePdfSaveHook()` early for pdf.

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

## How to reproduce the current state (≈30s)

1. OB_Testing already has the deployed plugin + pdfeditor assets. Full-restart Obsidian.
2. Put a text PDF in the vault; run command **"PDF PoC: open active/last .pdf in editor"**.
3. PDF renders in the OnlyOffice editor; "Edit PDF" → edit works. Ctrl+S → `asc_Save()` fires but no binary (the blocker).

## Reminder of the larger plan
- Phase 0b (iPad): the `drawingfile.wasm`-in-WKWebView SharedArrayBuffer risk is **still unverified** and is the gate for cross-platform. Per spec, if it needs SAB, first review a single-threaded `drawingfile.wasm` recompile before any desktop-only fallback.
- Phase 1 (full integration: toggle, ribbon, sidecar 4-way, Search, build-assets + zip ship) is gated on Phase 0 (save) + Phase 0b (iPad) passing.
