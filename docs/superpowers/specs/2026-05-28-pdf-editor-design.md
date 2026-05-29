# OnlyOffice PDF editor in Obsidi-Office — Design

**Date:** 2026-05-28
**Plugin:** Obsidi-Office (`obsidi-office`)
**Source:** `GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office/`

## Goal

Add a 5th capability to Obsidi-Office: open, **fully edit PDF text/content**, and save `.pdf` files, using OnlyOffice's browser PDF editor — embedded with the same localhost-free blob-iframe + mock-socket harness already used for the docx/pptx/xlsx editors. Cross-platform (Electron desktop **and** iPad Capacitor WKWebView).

**Out of scope:** PDF form fill/create (the engine's form code stays, but we build no form-specific UI/features). No "New blank PDF" template/landing card. No change to the existing docx/pptx/xlsx editors.

## Background (recon findings — treat as established)

- The plugin embeds OnlyOffice **DocumentServer v9.3.1** (`VERSION.json`: originally `pruned: true, editors_included: ["documenteditor"]`). pptx/xlsx were added later by re-pulling `presentationeditor`/`spreadsheeteditor` + `sdkjs/slide`/`sdkjs/cell` from the full v9.3.1 DocumentServer via a "canary install." The PDF editor is obtainable the same way.
- **The asset gap is narrow.** The PDF engine binaries are already on disk: `sdkjs/pdf/src/engine/{drawingfile.wasm,drawingfile.js,viewer.js,cmap.bin}`, `annotations/`. The PDF editor loads `sdkjs/word/sdk-all.js` (the docx editor already uses it — PDF editing code is compiled into the word bundle). **The only missing asset is the `web-apps/apps/pdfeditor/` frontend.** (Currently `sdkjs/pdf` is in `build-assets.js` `DROP_PATHS` line ~123; the trimmed zip excludes it.)
- **Capability:** full PDF text/content editing landed in OnlyOffice Docs 8.1; v9.3 is mature. Selected via api.js config `documentType: "pdf"` + `document.permissions.edit: true`.
- **Load bypasses x2t.** The PDF editor reads PDF bytes **natively** via the `drawingfile.wasm` engine, taking the file from the `origin.pdf` URL key (not an `Editor.bin`). No `toEditorBin` step.
- **Save bypasses x2t.** `c_oAscFileType.PDF = 0x0201 = 513`. `asc_DownloadAs(new Asc.asc_CDownloadOptions(513))` makes the engine emit **native PDF bytes directly** — no `toSourceFormat`/x2t reverse.
- **Handshake is docx-like.** The PDF editor passes `c_oEditorId.Word` at the socket layer, so the existing `editorType` value works. Runtime detection: `window.Asc.editor.isPdfEditor()` returns `true`.
- **The one real iPad risk:** if `drawingfile.wasm` was compiled with WASM threads it needs `SharedArrayBuffer`, which the blob/`capacitor://` origin cannot provide (no COOP/COEP) → boot crash. x2t-wasm and spell.wasm are single-threaded and work in this harness, so `drawingfile.wasm` is *plausibly* fine, but **unverified** — this is the make-or-break for iPad.

## Architecture: phased with hard PoC gates

The effort gates on two cheap PoCs before any production integration is built.

### Phase 0 — Desktop PoC (GATE 1)
1. Acquire `web-apps/apps/pdfeditor/` from the full v9.3.1 DocumentServer (canary path used for pptx/xlsx).
2. Boot the PDF editor in the existing blob-iframe + mock-socket harness with `documentType:"pdf"`, `permissions.edit:true`. Confirms `sdkjs/word/sdk-all.js` in this build contains the compiled PDF editing code.
3. Open a real `.pdf` **natively** (PDF delivered under `origin.pdf`, no x2t).
4. Make a text edit; save via `asc_DownloadAs(513)`; write the returned bytes to a temp path; confirm a valid `%PDF` that reopens.

**Gate:** all four steps green → proceed. Any failure → triage before building anything else.

### Phase 0b — iPad PoC (GATE 2)
Reinstall the PoC asset zip on iPad; confirm `drawingfile.wasm` **boots in WKWebView** and a PDF opens. **Gate:** boots → proceed. Needs `SharedArrayBuffer` → iPad blocked → **stop and review whether a WASM workaround can be generated** (e.g., a single-threaded recompile of `drawingfile.wasm`, or an alternative PDF engine) *before* deciding between a desktop-only fallback or abandoning iPad. Detection: try/catch around PDF open + check `typeof SharedArrayBuffer`.

### Phase 1+ — Full integration (only if both gates pass)
`PdfView`, the toggle + command/ribbon, the x2t-bypass bridge branches, sidecar 4-way + Search inclusion, then desktop + iPad smoke.

## Components

### 1. Asset bundle (`scripts/build-assets.js` + canary)
- Remove `"onlyoffice/sdkjs/pdf"` from `DROP_PATHS`.
- Add `web-apps/apps/pdfeditor/main/index.html` and `index_loader.html` to `HTML_TO_PATCH` (same `frameOrigin`/mock-socket/SVG/font patches the other apps get).
- Add `LOCALE_PARENT_PDF = "onlyoffice/web-apps/apps/pdfeditor/main/locale"` + an en-only filter block (mirror pptx/xlsx).
- Drop `pdfeditor` `main/resources/help`, `main/ie`, `embed` for size (mirror the other apps). Keep the standard editor otherwise (do not surgically excise forms code — it is intertwined; we simply ship no form features).
- `assetsNeeded` canary in `main.js`: add a probe for `web-apps/apps/pdfeditor/main/index.html` (and/or a pdf engine file) so existing installs re-extract when the new zip ships.
- Rebuild zip → version bump to **v9.3.3** → upload to GitHub release `v0.1.0-assets` → `data.json` `assetZipSource` updated → iPad reinstall via Settings. (Asset-zip-dating lesson: source-tree fixes to bundled assets are invisible on iPad until zip rebuild + `gh release upload --clobber` + user reinstall.)

### 2. `PdfView` (new view class in `main.js`)
Follows the `PptxView`/`XlsxView` pattern. Static getters: `VIEW_TYPE_PDF = "obsidi-office-pdf"`, file extension `"pdf"`, `engineAppPath` `web-apps/apps/pdfeditor/main/`, `engineSdkPath` `sdkjs/word/` (PDF editor shares the word SDK bundle), `documentType` `"pdf"`, `editorType` = the existing docx value (`c_oEditorId.Word`), sidecar suffix `.pdf.md`. Editor config sets `document.permissions.edit: true`. No `_ensureThemesStubs` equivalent.

### 3. Open behavior (toggle, default opt-in)
- **Always available:** an "Edit in Obsidi-Office" **command** + file-menu/ribbon action that opens the current/selected `.pdf` in a `PdfView` via explicit `_openInView(file)` (`setViewState` + `onLoadFile`; no global extension registration). Works regardless of the toggle.
- **Setting `openPdfInEditor` (boolean, default `false`):** when `true`, `onload` calls `registerExtensions(["pdf"], VIEW_TYPE_PDF)` so `.pdf` routes to `PdfView` by default; when `false`, Obsidian's native PDF viewer keeps `.pdf`. Settings tab toggle "Open PDFs in Obsidi-Office editor"; changing it shows a "Reload Obsidian to apply" notice (Obsidian exposes no clean runtime extension *un*-register, so registration is decided at `onload` — robust and simple). Wrap `registerExtensions` in try/catch (Obsidian may already own `.pdf`).

### 4. Load pipeline (x2t bypass)
`PdfView._onLoadFile` reads the raw `.pdf` bytes and registers them with the bridge tagged `ext:"pdf"`. **No `toEditorBin`/x2t.** The mock-socket `documentOpen`/`conn_info` provides the document under `urls['origin.pdf']` as a `blob:` URL (mirroring the existing media-as-blob-URL pattern) instead of the Editor.bin fetch path. (Exact wiring confirmed in Phase 0.)

### 5. Save pipeline (x2t bypass)
- `mock-socket.js` `triggerSaveToVault`: add a PDF branch — if `window.Asc.editor.isPdfEditor()` (or `editorType`/engine probe) → `asc_DownloadAs(new Asc.asc_CDownloadOptions(513))`.
- `TransportBridge._onDownloadAs` (`main.js`): when `ext === "pdf"`, the returned bytes are already a valid PDF → **write directly to the vault, skipping `toSourceFormat`/x2t**. This is the only format that bypasses the reverse converter.
- Autosave reuses the existing `onDocumentStateChange` + 10s debounce; manual Ctrl+S path unchanged otherwise.
- `mock-socket.js` engine detection: add a `pdf` branch alongside the existing `isSlide`/`hasCellAPI` probes (e.g. `editor.isPdfEditor()`), so format-specific paths (save, and any print/preview bail) route correctly.

### 6. Sidecar + Search integration (4-way, no templates)
Extend the existing 3-way (`docx|pptx|xlsx`) touch points to include `pdf`/`.pdf.md`:
- `isSidecarParent` predicate (add `f.extension === "pdf"`).
- Sidecar-redirect regex `/^(.+\.(docx|pptx|xlsx|pdf))\.md$/i` + view-type routing (`pdf → VIEW_TYPE_PDF`).
- `_openInView` extension→view map (`pdf → VIEW_TYPE_PDF`).
- "open current" command regex (`pdf`).
- `_injectSidecarCSS` / file-explorer hide selectors (add `[data-path$=".pdf.md"]`).
- Search-filter exclusion list (add `.pdf.md`).
- Include `.pdf` in the 🔍 **Search Recent** table (cross-format list).
- Sidecar redirect + Search-row clicks use `_openInView` → always open in `PdfView` (explicit open, independent of the toggle).
- **No** template seeding, **no** "New PDF" card, **no** dedicated landing "New" tab for PDF. Auto-create-sidecar on new file: not applicable (PDFs aren't created blank here); existing `_autoCreateSidecar` is unchanged.

## Data flow

```
Open (explicit command or toggle-on .pdf click)
  → PdfView._onLoadFile → read raw PDF bytes → bridge.registerDocument(docKey, path, pdfBytes, media, ext:"pdf")
  → blob-iframe (pdfeditor/main, eval api.js, documentType:"pdf", permissions.edit:true)
  → mock-socket conn_info delivers urls['origin.pdf'] = blob:(pdfBytes)   [NO x2t]
  → drawingfile.wasm renders + edits

Save (Ctrl+S / toolbar / 10s autosave)
  → triggerSaveToVault: isPdfEditor() → asc_DownloadAs(513)
  → engine emits native PDF bytes → downloadas RPC → bridge._onDownloadAs
  → ext==="pdf" → write bytes directly to vault   [NO x2t reverse]
```

## Risks & mitigations

1. **`drawingfile.wasm` needs SharedArrayBuffer/threads → iPad blocked.** Mitigation: Phase 0b gate (~1 day) before any production build. If hit, first review whether a WASM workaround can be generated (single-threaded recompile of `drawingfile.wasm`, or an alternative PDF engine); only then decide between desktop-only fallback or abandoning iPad.
2. **x2t-bypass load + save branches** are new code paths and the #2 risk. Mitigation: validated end-to-end in Phase 0 desktop PoC before the view class is built.
3. **`sdkjs/word/sdk-all.js` might lack compiled PDF code** in the pruned build. Mitigation: confirmed by the Phase 0 boot (it's the standard v9.3.1 word bundle, so expected to contain it).
4. **Native-viewer override scope.** Mitigation: confined to toggle-ON; reload-to-apply; try/catch on `registerExtensions`.
5. **Asset-zip dating.** Mitigation: treat zip rebuild + `gh release upload --clobber` + iPad reinstall as part of the flow, not an afterthought.

## Affected files

- `scripts/build-assets.js` — DROP_PATHS, HTML_TO_PATCH, LOCALE_PARENT_PDF, pdfeditor sub-dir drops.
- `main.js` — `VIEW_TYPE_PDF` const + `PdfView`; `onload` registerView / conditional registerExtensions / detachLeavesOfType / assetsNeeded canary / command + ribbon; `_openInView` + sidecar 4-way touch points; `TransportBridge._onDownloadAs` pdf-direct-write branch; load path origin.pdf delivery; settings tab toggle; `DEFAULT_SETTINGS.openPdfInEditor`.
- `assets/docx-viewer/mock-socket.js` — engine `pdf` detection branch; `triggerSaveToVault` 513 branch; conn_info `origin.pdf` delivery.
- Landing page Search Recent — include `.pdf`.

## Verification

- **Phase 0 (desktop):** boot pdfeditor, open real PDF, edit, save(513), valid PDF round-trip; docx/pptx/xlsx unaffected.
- **Phase 0b (iPad):** drawingfile.wasm boots in WKWebView, PDF opens.
- **Phase 1+ smoke (desktop + iPad):** command opens PDF in editor; toggle ON makes `.pdf` default-open in editor (after reload), OFF restores native viewer; edit + Ctrl+S + autosave persist; `.pdf.md` sidecar created/renamed/deleted in lockstep, hidden from explorer, tags in Metadata modal; `.pdf` appears + clickable in 🔍 Search; office tabs/sidecars regression-free; iPad edit + save round-trip.
