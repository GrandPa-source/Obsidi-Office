# OnlyOffice PDF Editor — Phase 0 / 0b PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (or disprove) that OnlyOffice's browser PDF editor can be embedded in Obsidi-Office's localhost-free harness — open a real `.pdf` natively, edit text, save via `asc_DownloadAs(513)`, on desktop (Gate 1) and on iPad (Gate 2) — before committing to the full integration.

**Architecture:** Acquire the missing `web-apps/apps/pdfeditor/` frontend from a full v9.3.1 DocumentServer, stage it into the deployed desktop assets, add a minimal throwaway `PdfView` + boot command, and wire the two x2t-bypass paths (load via `origin.pdf`, save via code 513). Desktop PoC needs no zip rebuild (assets read from disk); iPad PoC needs the asset zip rebuilt + reinstalled.

**Tech Stack:** Plain-JS Obsidian plugin (no build, no test framework — verification is `node --check main.js` + manual boot/observation). OnlyOffice DocumentServer v9.3.1 (Docker image `onlyoffice/documentserver:9.3.1` as the canary source). Blob-iframe + eval'd api.js + mock-socket + transport-shim + x2t-wasm.

**Spec:** `docs/superpowers/specs/2026-05-28-pdf-editor-design.md`

**Source root:** `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office\`
**Desktop assets (read from disk, no zip needed):** `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\assets\onlyoffice\`

---

## Scope note

This plan covers **Phase 0 (desktop PoC)** and **Phase 0b (iPad PoC)** only — the gates. **Phase 1 (full integration: production `PdfView`, the `openPdfInEditor` toggle, the "Edit in Obsidi-Office" command/ribbon, the `TransportBridge._onDownloadAs` pdf branch hardening, the `.pdf.md` sidecar 4-way touch points, 🔍 Search inclusion, `build-assets.js` finalization, desktop+iPad smoke) is intentionally deferred to its own plan written AFTER both gates pass** — because the exact load/save wiring and iPad viability are PoC outputs, and specifying that code now would be guesswork. Phase 1 outline is at the end for context.

PoC code is throwaway/minimal and clearly marked; it is allowed to be hacky. The goal is a yes/no answer per gate, not production quality.

---

## File structure (Phase 0/0b)

- **Modify:** `main.js` — a minimal `PdfView` class + `VIEW_TYPE_PDF` const, `registerView`, a temp `pdf-poc-open` command, a pdf branch in the load path, a pdf branch in `TransportBridge._onDownloadAs`. All tagged with `// PDF PoC` comments for easy removal/promotion.
- **Modify:** `assets/docx-viewer/mock-socket.js` — pdf engine-detection branch, `triggerSaveToVault` 513 branch, `conn_info`/`documentOpen` `origin.pdf` delivery.
- **Stage (not committed — large binaries, gitignored):** `assets/onlyoffice/web-apps/apps/pdfeditor/` into the deployed OB_Testing assets.
- **Modify (Phase 0b only):** `scripts/build-assets.js` — include pdfeditor; rebuild zip.
- **PoC fixtures:** a small real `.pdf` with selectable text in the vault, e.g. `C:\Obsidian\OB_Testing\_pdfpoc\sample.pdf`.

---

## Phase 0 — Desktop PoC (GATE 1)

### Task 0.1: Acquire the `pdfeditor` frontend from full v9.3.1 DocumentServer

**Files:** stages into `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\assets\onlyoffice\web-apps\apps\pdfeditor\`

- [ ] **Step 1: Pull the matching DocumentServer image**

Run:
```bash
docker pull onlyoffice/documentserver:9.3.1
```
Expected: image pulled. (If `9.3.1` tag is unavailable, list tags / use the closest `9.3.x` and note the exact version used — the web-apps/sdkjs are version-locked to the editor bundle already on disk, so prefer an exact match.)

- [ ] **Step 2: Copy the pdfeditor app + full sdkjs/pdf out of the image**

Run:
```bash
cid=$(docker create onlyoffice/documentserver:9.3.1)
docker cp "$cid:/var/www/onlyoffice/documentserver/web-apps/apps/pdfeditor" "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/assets/onlyoffice/web-apps/apps/pdfeditor"
docker cp "$cid:/var/www/onlyoffice/documentserver/sdkjs/pdf" "/tmp/ds-sdkjs-pdf"
docker rm "$cid"
```
Expected: `pdfeditor/main/index.html` now exists at the destination. `/tmp/ds-sdkjs-pdf` holds the full engine for comparison.

- [ ] **Step 3: Verify the frontend landed and diff the engine**

Run:
```bash
ls "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/assets/onlyoffice/web-apps/apps/pdfeditor/main/" | head
diff -rq "/tmp/ds-sdkjs-pdf" "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/assets/onlyoffice/sdkjs/pdf" || true
```
Expected: `index.html`, `app.js`, `index_loader.html` present. The diff shows whether the on-disk `sdkjs/pdf` is missing any engine files (e.g. a built bundle) the editor needs; if files are missing on disk, copy them in from `/tmp/ds-sdkjs-pdf`.

- [ ] **Step 4: Record findings**

Write to `C:\Obsidian\OB_Testing\_pdfpoc\00-acquire.md`: exact DocumentServer version used, what `pdfeditor/main/` contains, whether `sdkjs/pdf` needed engine files added, and whether `sdkjs/word/sdk-all.js` (already on disk) is expected to carry the PDF code (note: confirmed only when the editor boots in Task 0.3).

(No git commit — these are gitignored asset binaries, not source.)

### Task 0.2: Minimal `PdfView` + boot command (no PDF loaded yet)

**Files:** Modify `main.js`

- [ ] **Step 1: Add the view-type const + minimal PdfView**

Find the existing `VIEW_TYPE_XLSX` const declaration in `main.js` and add directly after it:
```javascript
const VIEW_TYPE_PDF = "obsidi-office-pdf";  // PDF PoC
```

Locate the `XlsxView` class definition. Immediately after it, add a `PdfView` that mirrors it but with PDF getters (copy `XlsxView`'s body verbatim, changing only the getters below — keep `onLoadFile`/`onOpen`/render logic identical for now):
```javascript
// PDF PoC — minimal view, mirrors XlsxView. Throwaway until Gate 1 passes.
class PdfView extends /* same base as XlsxView */ {
  // The 7 static getters, PDF values:
  //   VIEW_TYPE -> VIEW_TYPE_PDF
  //   fileExtension -> "pdf"
  //   engineAppPath -> "web-apps/apps/pdfeditor/main/"
  //   engineSdkPath -> "sdkjs/word/"   (PDF editor shares the word SDK bundle)
  //   documentType -> "pdf"
  //   editorType -> (same numeric value XlsxView/DocxView use; PDF uses c_oEditorId.Word at the socket layer)
  //   sidecarExtension -> ".pdf.md"
  // Set editorConfig document.permissions.edit = true in the editor config builder.
}
```
NOTE to implementer: open `XlsxView` and replicate its exact structure (it may be one shared base class `OfficeEditorView` with static getters — if so, subclass that the same way `XlsxView` does and override the 7 getters). Do not invent new structure; match what `XlsxView` does line-for-line except the getter values above.

- [ ] **Step 2: Register the view + a temp command in `onload`**

Find where `XlsxView` is registered in `onload` (`this.registerView(VIEW_TYPE_XLSX, ...)`). Add directly after:
```javascript
// PDF PoC
this.registerView(VIEW_TYPE_PDF, (leaf) => new PdfView(leaf, this));
this.addCommand({
  id: "pdf-poc-open",
  name: "PDF PoC: open active/last .pdf in editor",
  callback: async () => {
    const f = this.app.workspace.getActiveFile()
      || this.app.vault.getFiles().find((x) => x.extension === "pdf");
    if (!f || f.extension !== "pdf") { new obsidian.Notice("No .pdf found"); return; }
    await this._openInView(f);  // explicit open, bypasses extension routing
  },
});
```
Find `_openInView` and add a pdf branch to its extension→viewType map: `else if (file.extension === "pdf") viewType = VIEW_TYPE_PDF;`. Also add `this.app.workspace.detachLeavesOfType(VIEW_TYPE_PDF);` to `onunload` next to the other `detachLeavesOfType` calls.

- [ ] **Step 3: Syntax check**

Run: `cd "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" && node --check main.js`
Expected: no output, exit 0.

- [ ] **Step 4: Deploy + boot (observe frame only)**

Run: `cp "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office/main.js" "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"`
Then in OB_Testing: reload, put a real text PDF at `_pdfpoc/sample.pdf`, run command "PDF PoC: open active/last .pdf in editor". **Observe:** does the pdfeditor iframe load (api.js evals, the OnlyOffice PDF UI chrome appears)? It will likely NOT render the document yet (load wiring is Task 0.3). Record console/debug output to `_pdfpoc/02-boot.md`: did api.js eval succeed, did the iframe build, any errors. This step also confirms whether `sdkjs/word/sdk-all.js` carries the PDF code (if the editor chrome appears without "unknown documentType" errors, it does).

- [ ] **Step 5: Commit the PoC scaffolding (source only)**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "PDF PoC: minimal PdfView + boot command (Gate 1 scaffolding)"
```

### Task 0.3: Native PDF load (x2t bypass via `origin.pdf`)

**Files:** Modify `main.js` (load path), `assets/docx-viewer/mock-socket.js` (conn_info/documentOpen)

- [ ] **Step 1: Inspect the current load + conn_info delivery**

Read the `OfficeEditorView` load path in `main.js` (`onLoadFile` / `_onLoadFileInner` → `converter.toEditorBin` → `bridge.registerDocument`) and the `mock-socket.js` `conn_info`/`documentOpen` code that hands the editor its document URL(s). Identify exactly where the editor receives the Editor.bin URL, and where media are delivered as `blob:` URLs (the pattern to mirror). Record the call sites in `_pdfpoc/03-load-notes.md`.

- [ ] **Step 2: Add a pdf branch to the load path (skip x2t, register raw bytes)**

In the load path, where docx/pptx/xlsx call `toEditorBin`, add: if the file extension is `pdf`, **skip** `toEditorBin` and register the raw PDF bytes with the bridge tagged `ext:"pdf"` (e.g. pass the unmodified `Uint8Array`/`ArrayBuffer` as the "document" payload). Mark with `// PDF PoC`. The bridge entry for this docKey now holds raw PDF bytes, not an Editor.bin.

- [ ] **Step 3: Deliver the PDF under `origin.pdf` in mock-socket**

In `mock-socket.js`, in the `conn_info`/`documentOpen` payload construction, add a pdf branch: when the registered doc is a PDF, set `urls['origin.pdf']` to a `blob:` URL created from the raw PDF bytes (mirror the existing media-as-blob-URL creation), and do NOT send the Editor.bin document field. (Exact field shape per the recon: the engine reads `urls['origin.pdf'] || urls['origin.xps']` when `isUseNativeViewer` and no Editor.bin documentUrl.)

- [ ] **Step 4: Syntax check + deploy + observe render**

Run: `node --check main.js` (expect clean) and `node --check assets/docx-viewer/mock-socket.js` (expect clean), then `cp` both files to OB_Testing (main.js + assets/docx-viewer/mock-socket.js). Reload, run the PoC command on `sample.pdf`. **Observe:** do the PDF's pages render in the editor? Record to `_pdfpoc/03-load-result.md` (rendered yes/no, errors, whether text is selectable).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js assets/docx-viewer/mock-socket.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "PDF PoC: native PDF load via origin.pdf (x2t bypass)"
```

### Task 0.4: Edit + save round-trip (x2t bypass via code 513)

**Files:** Modify `assets/docx-viewer/mock-socket.js` (save trigger + engine detect), `main.js` (`TransportBridge._onDownloadAs`)

- [ ] **Step 1: Add pdf engine detection + 513 save trigger in mock-socket**

In `mock-socket.js`, find the existing engine-detection block (`isSlide`/`hasCellAPI` via `get_PresentationWidth`/`asc_nativePrintPagesCount`). Add a pdf probe: `var hasPdfAPI = (typeof editor.isPdfEditor === "function" && editor.isPdfEditor());`. In `triggerSaveToVault`, add a branch BEFORE the existing default: if `hasPdfAPI` → `window.Asc.editor.asc_DownloadAs(new window.Asc.asc_CDownloadOptions(513));`.

- [ ] **Step 2: Add pdf direct-write branch in the bridge**

In `main.js` `TransportBridge._onDownloadAs` (the handler that currently calls `toSourceFormat(editorBin, ext, media)` and writes the file), add: if `ext === "pdf"`, the received bytes ARE the final PDF — **write them directly to the vault path, skipping `toSourceFormat`**. Mark `// PDF PoC`.

- [ ] **Step 3: Syntax check + deploy**

Run: `node --check main.js && node --check assets/docx-viewer/mock-socket.js` (expect clean). `cp` both to OB_Testing. Reload.

- [ ] **Step 4: Round-trip test**

Open `sample.pdf` via the PoC command, edit a piece of text, trigger save (Ctrl+S). **Verify:** a notice fires, the `.pdf` mtime advances, and reopening the file (in Obsidian's native viewer or re-running the PoC command) shows the edit persisted and the file is a valid PDF. Confirm header bytes: `head -c 5 "C:/Obsidian/OB_Testing/_pdfpoc/sample.pdf"` → `%PDF-`. Record to `_pdfpoc/04-save-result.md`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js assets/docx-viewer/mock-socket.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "PDF PoC: save round-trip via asc_DownloadAs(513), direct write (x2t bypass)"
```

### Task 0.5: GATE 1 decision

- [ ] **Step 1: Evaluate** — All true? (a) pdfeditor frontend boots in the blob-iframe, (b) a real PDF renders natively (no x2t), (c) a text edit saves via 513 to a valid PDF that reopens with the edit, (d) docx/pptx/xlsx still open + save (quick regression). Record PASS/FAIL + evidence in `_pdfpoc/05-gate1.md`.
- [ ] **Step 2: Decide** — PASS → proceed to Phase 0b. FAIL → triage the failing step; do NOT proceed to Phase 0b or Phase 1. Surface blockers to the user.

---

## Phase 0b — iPad PoC (GATE 2)

### Task 0b.1: Bundle pdfeditor into the asset zip

**Files:** Modify `scripts/build-assets.js`

- [ ] **Step 1: Include pdfeditor, drop its bulk**

In `scripts/build-assets.js`: remove `"onlyoffice/sdkjs/pdf"` from `DROP_PATHS`. Add to `DROP_PATHS` the pdfeditor bulk dirs (mirror the other apps): `"onlyoffice/web-apps/apps/pdfeditor/main/resources/help"`, `"onlyoffice/web-apps/apps/pdfeditor/main/ie"`, `"onlyoffice/web-apps/apps/pdfeditor/embed"`. Add `"onlyoffice/web-apps/apps/pdfeditor/main/index.html"` and `".../index_loader.html"` to `HTML_TO_PATCH`. Add `const LOCALE_PARENT_PDF = "onlyoffice/web-apps/apps/pdfeditor/main/locale";` + an en-only filter block mirroring `LOCALE_PARENT_XLSX`.

- [ ] **Step 2: Add the pdfeditor canary to `assetsNeeded` (main.js)**

In `main.js` `assetsNeeded`, add a probe: `|| !(await vio.exists(this, vio.join(this.onlyOfficeRel, "web-apps/apps/pdfeditor/main/index.html")))` so existing installs re-extract when the new zip ships.

- [ ] **Step 3: Build the zip + syntax check**

Run: `node --check main.js && node --check scripts/build-assets.js`, then run the asset build per the script's usage (the same command used for prior zips — check the script header / package.json for the invocation, e.g. `node scripts/build-assets.js --src <deployed assets> --out <zip>`). Output: a new zip; bump the version label to **v9.3.3**. Record the byte size + entry count to `_pdfpoc/0b1-zip.md`.

- [ ] **Step 4: Publish + point data.json at it**

Upload to the GitHub release: `gh release upload v0.1.0-assets <zip> -R GrandPa-source/Obsidi-Office --clobber`. Update `assetZipSource` (data.json / settings) to the v9.3.3 URL. Commit the `build-assets.js` + `main.js` canary changes:
```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add scripts/build-assets.js main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "PDF PoC: bundle pdfeditor into asset zip (v9.3.3) + canary"
```

### Task 0b.2: iPad boot test (the `drawingfile.wasm` gate)

- [ ] **Step 1: Reinstall assets on iPad** — Obsidian Sync propagates main.js; in OB_Testing on iPad, Settings → Obsidi-Office → "Install now" (or reload) to pull the v9.3.3 zip and extract.
- [ ] **Step 2: Boot a PDF** — run the PoC command on `sample.pdf` on the iPad. **Observe** via the debug log: does `drawingfile.wasm` instantiate, or is there a `SharedArrayBuffer is not defined` / WASM-init crash? Does the PDF render? Record to `_pdfpoc/0b2-ipad.md` including `typeof SharedArrayBuffer` from the iframe context if reachable.

### Task 0b.3: GATE 2 decision

- [ ] **Step 1: Evaluate** — `drawingfile.wasm` boots in WKWebView and the PDF renders (edit/save optional at this gate; boot+render is the gate). Record PASS/FAIL in `_pdfpoc/0b3-gate2.md`.
- [ ] **Step 2: Decide** —
  - PASS → both gates green; proceed to write the **Phase 1 plan** (full integration).
  - FAIL (needs SharedArrayBuffer) → **stop**; review whether a WASM workaround can be generated (single-threaded recompile of `drawingfile.wasm`, or an alternative PDF engine) before deciding desktop-only vs. abandon-iPad. Surface to the user with the evidence.

---

## Phase 1 outline (separate plan, written only after both gates pass)

Not detailed here on purpose — the tasks below depend on Gate findings (exact `origin.pdf` field, confirmed editorType, iPad viability):

1. Promote the throwaway `PdfView` to production (remove `// PDF PoC` hacks; finalize editorConfig `permissions.edit:true`).
2. `openPdfInEditor` setting (default false) + conditional `registerExtensions(["pdf"], VIEW_TYPE_PDF)` at onload (try/catch); settings-tab toggle with "Reload to apply" notice.
3. "Edit in Obsidi-Office" command + file-menu/ribbon action (the always-on opt-in open).
4. Harden `TransportBridge._onDownloadAs` pdf branch + autosave parity; finalize mock-socket pdf engine branch.
5. `.pdf.md` sidecar 4-way: `isSidecarParent`, redirect regex + view routing, `_openInView` (already done in PoC), open-current command regex, sidecar-hide CSS, Search-filter exclusion.
6. Include `.pdf` in the 🔍 Search Recent table.
7. Finalize `build-assets.js` + ship the production zip; remove PoC fixtures.
8. Desktop + iPad smoke checklist (per the spec's Verification section).

---

## Self-Review (completed during planning)

- **Spec coverage:** Phase 0 covers acquisition (0.1), boot/`sdkjs/word` PDF-code confirmation (0.2), x2t-bypass load via `origin.pdf` (0.3), x2t-bypass save via 513 (0.4), Gate 1 (0.5). Phase 0b covers bundling (0b.1), the `drawingfile.wasm`/SAB iPad gate (0b.2/0b.3) with the spec's WASM-workaround fallback. Toggle/command/sidecar/Search are intentionally Phase 1 (gated) — listed in the outline so nothing is lost.
- **Placeholder scan:** No "TBD"/"implement later". Investigative steps have explicit observe/record outputs and success criteria; that is appropriate for a spike, not a placeholder. The one "replicate XlsxView structure" instruction is a deliberate match-existing-pattern directive (the exact base class is read from the file, not guessed).
- **Consistency:** `VIEW_TYPE_PDF`, `PdfView`, `documentType:"pdf"`, `engineSdkPath:"sdkjs/word/"`, `origin.pdf`, code `513`, `isPdfEditor()` used consistently across tasks and matching the spec.
- **No test framework** (plain JS): verification is `node --check` + manual boot/observation, consistent with the project.
