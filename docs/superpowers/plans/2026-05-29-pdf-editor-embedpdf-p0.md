# PDF Editor (EmbedPDF) — Phase 0 PoC Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that EmbedPDF (PDFium-WASM) + Preact can load, render, edit, and **vector-save** a PDF — first as a headless Node harness, then inside an Obsidian `ItemView` on **desktop AND iPad** — so we can commit (or abandon) the EmbedPDF foundation before building features.

**Architecture:** A throwaway Node harness validates the engine + `saveAsCopy()` vector save in isolation. Then a minimal, separately-bundled (esbuild) Preact+EmbedPDF module is loaded by the existing hand-written `main.js` into a new `PdfEditorView`, opened via a throwaway command. PDFium WASM is loaded from the plugin's asset dir. No blob-iframe. Everything is `// PDF-EMBEDPDF PoC`-tagged and behind a command — zero impact on docx/pptx/xlsx/note.

**Tech Stack:** EmbedPDF (`@embedpdf/*`, pin exact version), `@embedpdf/pdfium` (PDFium WASM), Preact, esbuild, TypeScript, Obsidian API.

**Spec:** `docs/superpowers/specs/2026-05-29-pdf-editor-embedpdf-design.md`
**Supersedes (save direction):** `docs/superpowers/plans/2026-05-29-pdf-editor-phase0-findings.md` (OnlyOffice route).

---

## Phase 0 success criteria (the gate)

P0 PASSES only if **all** hold:
1. Node harness: load a real PDF, programmatically add an annotation, `saveAsCopy()`, reopen the saved bytes, and confirm (a) valid `%PDF` header, (b) same/﻿expected page count, (c) the annotation is present. 
2. Desktop Obsidian: the `PdfEditorView` renders the PDF via EmbedPDF, a user can add one markup annotation through EmbedPDF's own UI, save writes a valid PDF to the vault, and reopening shows the annotation.
3. **AcroForm fill is confirmed shipped** in the EmbedPDF version we pin (not just exportable) — or explicitly logged as "defer forms."
4. iPad (Capacitor WKWebView): the same render + add-annotation + save round-trip works.
5. docx/pptx/xlsx/note editing is unaffected; Obsidian's native PDF viewer remains default.

If 1–4 pass → proceed to write the P1 plan. If any fail → document the failure and revisit engine choice (the spec's risk section).

---

## File structure (P0)

- `_embedpdf-poc/` — **throwaway** Node harness dir (sibling of the existing `_pdfdemo/`). Engine/API validation only; not shipped, gitignored.
  - `_embedpdf-poc/probe.mjs` — discover + log the EmbedPDF/PDFium API surface for the pinned version.
  - `_embedpdf-poc/harness.mjs` — load→annotate→saveAsCopy→reopen→assert.
- `pdf-editor/` — **new** source dir for the bundled Preact+EmbedPDF module (kept separate from the hand-written `main.js`).
  - `pdf-editor/src/index.tsx` — exports `mountPdfEditor(container, fileBytes, opts)` / `unmountPdfEditor(container)`; sets up EmbedPDF + Preact app.
  - `pdf-editor/esbuild.config.mjs` — bundles `src/index.tsx` → `dist/pdf-editor.js` (IIFE/global), Preact + EmbedPDF inlined.
  - `pdf-editor/package.json` — dev deps: `esbuild`, `preact`, pinned `@embedpdf/*`, `@embedpdf/pdfium`, `typescript`.
  - `pdf-editor/tsconfig.json` — JSX = preact.
- `assets/pdfium/` — PDFium WASM asset(s) staged for the plugin to load (path mirrors the OnlyOffice asset convention).
- `main.js` (MODIFY) — add: `VIEW_TYPE_PDF_EMBED` const; `PdfEmbedView extends ItemView`; `registerView` + `addCommand("embedpdf-poc-open")` in `onload`; `detachLeavesOfType` in `onunload`. All `// PDF-EMBEDPDF PoC`-tagged.

---

## Task 1: Throwaway Node harness — probe the EmbedPDF/PDFium API

**Files:**
- Create: `_embedpdf-poc/probe.mjs`
- Create: `_embedpdf-poc/package.json` (via `npm init -y`)

- [ ] **Step 1: Scaffold the throwaway dir and install pinned deps**

```bash
cd "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office"
rm -rf _embedpdf-poc && mkdir _embedpdf-poc && cd _embedpdf-poc
npm init -y >/dev/null
# Pin the version we evaluate; capture the resolved version in the output.
npm install @embedpdf/engines @embedpdf/pdfium @embedpdf/models
```

Expected: install succeeds, `node_modules/@embedpdf/*` present.

- [ ] **Step 2: Write the API probe**

```js
// _embedpdf-poc/probe.mjs  — discover the real API for the pinned version
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("node_modules/@embedpdf/pdfium/package.json","utf8"));
console.log("@embedpdf/pdfium version:", pkg.version);
const engines = await import("@embedpdf/engines");
console.log("engines exports:", Object.keys(engines).sort().join(", "));
const pdfium = await import("@embedpdf/pdfium");
console.log("pdfium exports:", Object.keys(pdfium).sort().join(", "));
// Many EmbedPDF builds expose an init like `init()` / `createPdfiumModule()`.
// Log whatever factory exists so harness.mjs can call the right one.
for (const k of Object.keys(pdfium)) console.log("pdfium." + k, typeof pdfium[k]);
```

- [ ] **Step 3: Run the probe and record the API**

Run: `node _embedpdf-poc/probe.mjs`
Expected: prints the pinned version and the export names. **Record the engine-init function name + the save/`saveAsCopy` entry point**; these names feed Task 2. (If `@embedpdf/engines` assumes a DOM and throws in Node, fall back to driving `@embedpdf/pdfium` directly — it is the WASM binding and is Node-capable, as PDFium-WASM is single-threaded with no DOM dependency.)

- [ ] **Step 4: Commit the probe (throwaway dir is gitignored; commit only the plan progress note)**

Skip committing `_embedpdf-poc/` (add it to `.gitignore`). No commit this step.

---

## Task 2: Node harness — load → annotate → saveAsCopy → reopen → assert

**Files:**
- Create: `_embedpdf-poc/harness.mjs`

- [ ] **Step 1: Write the harness using the API names recorded in Task 1**

```js
// _embedpdf-poc/harness.mjs
// NOTE: replace INIT_FN / openDocument / saveAsCopy calls with the exact
// names printed by probe.mjs for the pinned version.
import fs from "node:fs";
import * as pdfium from "@embedpdf/pdfium";

const SRC = "../CHROME_Sent Items - Paul Nicholson - Outlook.pdf"; // real test PDF
const srcBytes = new Uint8Array(fs.readFileSync(SRC));

const engine = await pdfium.init();              // <-- exact init from probe.mjs
const doc = await engine.openDocument(srcBytes); // <-- exact open from probe.mjs
const pages0 = await engine.getPageCount(doc);
console.log("opened, pages:", pages0);

// add one annotation on page 0 (use the engine's createPageAnnotation;
// exact signature from probe.mjs — a highlight or freetext rect)
await engine.createPageAnnotation(doc, 0, {
  type: "freetext", rect: { x: 54, y: 700, width: 200, height: 16 },
  contents: "PoC annotation",
});

const out = await engine.saveAsCopy(doc);        // <-- ArrayBuffer / Uint8Array
const outBytes = out instanceof Uint8Array ? out : new Uint8Array(out);
fs.writeFileSync("DEMO_embedpdf_saved.pdf", Buffer.from(outBytes));

// reopen and assert
const head = String.fromCharCode(...outBytes.slice(0,5));
const doc2 = await engine.openDocument(outBytes);
const pages2 = await engine.getPageCount(doc2);
const annots = await engine.getPageAnnotations(doc2, 0); // exact name from probe
const ok = head === "%PDF-" && pages2 === pages0 && annots && annots.length >= 1;
console.log("header:", JSON.stringify(head), "pages:", pages2, "annots p0:", annots && annots.length);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run the harness**

Run: `cd _embedpdf-poc && node harness.mjs`
Expected: prints `header: "%PDF-" pages: 2 annots p0: 1` then `PASS`, exit 0, and writes `DEMO_embedpdf_saved.pdf`.

- [ ] **Step 3: Visually verify the saved PDF (render back via the same engine, view the PNG)**

Add to harness or a small `verify.mjs`: render page 0 of `DEMO_embedpdf_saved.pdf` to PNG (engine `renderPage`/pixmap → PNG) and open it / Read it. Expected: original content crisp (vector) + the "PoC annotation" visible. Confirms `saveAsCopy` is real vector output, not raster.

- [ ] **Step 4: GATE CHECK (success criterion 1)**

If `PASS` and the render shows vector content + annotation → engine+save proven. If `FAIL` → STOP; the EmbedPDF engine doesn't round-trip in our setup; document and revisit engine choice. No further P0 tasks until this passes.

---

## Task 3: Stand up the bundled Preact + EmbedPDF module (build pipeline)

**Files:**
- Create: `pdf-editor/package.json`, `pdf-editor/tsconfig.json`, `pdf-editor/esbuild.config.mjs`
- Create: `pdf-editor/src/index.tsx`

- [ ] **Step 1: Scaffold the build for a separate bundle (the plugin's main.js stays hand-written)**

```bash
cd "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office"
mkdir -p pdf-editor/src pdf-editor/dist assets/pdfium
cd pdf-editor && npm init -y >/dev/null
npm install --save-dev esbuild typescript preact @embedpdf/engines @embedpdf/pdfium @embedpdf/models \
  @embedpdf/core @embedpdf/plugin-loader @embedpdf/plugin-render @embedpdf/plugin-annotation @embedpdf/plugin-export
```

(Exact `@embedpdf/plugin-*` set is confirmed from Task 1 + the docs; annotation + render + export are the P0 minimum. Pin versions to match Task 1.)

- [ ] **Step 2: tsconfig.json (Preact JSX)**

```json
{
  "compilerOptions": {
    "target": "ES2018", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "jsxImportSource": "preact",
    "strict": true, "skipLibCheck": true, "lib": ["DOM","ES2020"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: esbuild.config.mjs → single IIFE global the plugin can load**

```js
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/pdf-editor.js",
  bundle: true, format: "iife", globalName: "ObsidiPdfEditor",
  platform: "browser", target: "es2018",
  jsx: "automatic", jsxImportSource: "preact",
  loader: { ".wasm": "binary" }, // PDFium wasm loaded separately at runtime via URL, not inlined
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
console.log("built dist/pdf-editor.js");
```

- [ ] **Step 4: src/index.tsx — minimal mount/unmount exposing a global**

```tsx
// Minimal PoC: render EmbedPDF into a container, load given bytes, expose save().
// Exact EmbedPDF component/plugin wiring per Task 1 + docs; this is the shape.
import { render, h } from "preact";

export interface MountOpts {
  pdfiumWasmUrl: string;             // app:// URL the plugin resolves to assets/pdfium
  onSave: (bytes: Uint8Array) => Promise<void>;
}
let _save: (() => Promise<void>) | null = null;

export async function mountPdfEditor(container: HTMLElement, fileBytes: Uint8Array, opts: MountOpts) {
  // 1) init engine with opts.pdfiumWasmUrl (fetch override so it loads our bundled wasm)
  // 2) render EmbedPDF viewer + annotation plugin UI into `container`
  // 3) wire a save() that calls engine.saveAsCopy() then opts.onSave(bytes)
  // (concrete plugin registration filled from Task 1 probe output)
  _save = async () => { /* const b = await engine.saveAsCopy(doc); await opts.onSave(b); */ };
  // render(<App .../>, container)
}
export async function savePdfEditor() { if (_save) await _save(); }
export function unmountPdfEditor(container: HTMLElement) { render(null as any, container); _save = null; }
(globalThis as any).ObsidiPdfEditor = { mountPdfEditor, savePdfEditor, unmountPdfEditor };
```

- [ ] **Step 5: Build and confirm output exists**

Run: `cd pdf-editor && node esbuild.config.mjs`
Expected: `built dist/pdf-editor.js`, file present, no errors. (Confirms Preact + EmbedPDF bundle under esbuild — success criterion toward the Preact-in-plugin risk.)

- [ ] **Step 6: Commit the build scaffold**

```bash
cd "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office"
echo "_embedpdf-poc/" >> .gitignore
echo "pdf-editor/node_modules/" >> .gitignore
git add .gitignore pdf-editor/package.json pdf-editor/tsconfig.json pdf-editor/esbuild.config.mjs pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: Preact+EmbedPDF bundle scaffold (esbuild)"
```

---

## Task 4: Stage PDFium WASM as a plugin asset + resolve its URL

**Files:**
- Create: `assets/pdfium/pdfium.wasm` (copied from `pdf-editor/node_modules/@embedpdf/pdfium/...`)
- Modify: `main.js` (a helper that returns the `app://` URL for `assets/pdfium/pdfium.wasm`)

- [ ] **Step 1: Copy the wasm into the plugin asset dir**

```bash
cd "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office"
cp pdf-editor/node_modules/@embedpdf/pdfium/dist/pdfium.wasm assets/pdfium/pdfium.wasm  # exact path from Task 1
ls -la assets/pdfium/
```

Expected: `pdfium.wasm` (~4.6 MB) present. (P0 stages it locally; the GitHub-release lazy-download installer is a P1 task — not needed to prove feasibility.)

- [ ] **Step 2: Add a wasm-URL resolver in main.js (mirror existing `assetBaseUrl` pattern)**

```js
// // PDF-EMBEDPDF PoC: resolve the app:// URL for the bundled PDFium wasm.
pdfiumWasmUrl() {
  return this.app.vault.adapter.getResourcePath(
    this.manifest.dir + "/assets/pdfium/pdfium.wasm"
  ).replace(/\?.*$/, "");
}
```

- [ ] **Step 3: Commit**

```bash
git add main.js   # (wasm is large + may be gitignored like other binaries; mirror existing asset .gitignore policy)
git commit -m "PDF-EMBEDPDF PoC: PDFium wasm asset + URL resolver"
```

---

## Task 5: PdfEmbedView (ItemView) + throwaway open command — desktop wiring

**Files:**
- Modify: `main.js` — add `VIEW_TYPE_PDF_EMBED`, `PdfEmbedView`, registration, command.

- [ ] **Step 1: Add the view class (loads dist/pdf-editor.js, mounts the editor)**

```js
// // PDF-EMBEDPDF PoC
const VIEW_TYPE_PDF_EMBED = "obsidi-office-pdf-embed";
class PdfEmbedView extends obsidian.ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE_PDF_EMBED; }
  getDisplayText() { return this.file ? this.file.basename : "PDF editor"; }
  async onLoadFile(file) {
    this.file = file;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    // load the bundled editor module once
    if (!globalThis.ObsidiPdfEditor) {
      const code = await this.plugin.app.vault.adapter.read(this.plugin.manifest.dir + "/pdf-editor/dist/pdf-editor.js");
      (0, eval)(code); // IIFE assigns globalThis.ObsidiPdfEditor
    }
    const container = this.contentEl.createDiv({ cls: "obsidi-pdf-embed-root" });
    await globalThis.ObsidiPdfEditor.mountPdfEditor(container, bytes, {
      pdfiumWasmUrl: this.plugin.pdfiumWasmUrl(),
      onSave: async (out) => { await this.app.vault.modifyBinary(file, out); new obsidian.Notice("PDF saved (" + out.byteLength + " bytes)"); },
    });
    this.scope?.register?.([ "Mod" ], "s", () => { globalThis.ObsidiPdfEditor.savePdfEditor(); return false; });
  }
  async onClose() { try { globalThis.ObsidiPdfEditor?.unmountPdfEditor(this.contentEl); } catch (e) {} }
}
```

- [ ] **Step 2: Register the view + command in onload; detach in onunload**

```js
// in onload():
this.registerView(VIEW_TYPE_PDF_EMBED, (leaf) => new PdfEmbedView(leaf, this));
this.addCommand({ id: "embedpdf-poc-open", name: "EmbedPDF PoC: open active/last .pdf in editor",
  callback: async () => {
    const f = this.app.workspace.getActiveFile() || this._lastPdf;
    if (!f || f.extension !== "pdf") { new obsidian.Notice("Open/select a .pdf first"); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PDF_EMBED, active: true, state: { file: f.path } });
  }});
// in onunload():
this.app.workspace.detachLeavesOfType(VIEW_TYPE_PDF_EMBED);
```

- [ ] **Step 3: Build, deploy to OB_Testing, syntax-check**

```bash
cd pdf-editor && node esbuild.config.mjs && cd ..
node --check main.js && echo "main.js OK"
DST="/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office"
cp main.js "$DST/main.js"
mkdir -p "$DST/pdf-editor/dist" "$DST/assets/pdfium"
cp pdf-editor/dist/pdf-editor.js "$DST/pdf-editor/dist/pdf-editor.js"
cp assets/pdfium/pdfium.wasm "$DST/assets/pdfium/pdfium.wasm"
echo deployed
```

Expected: `main.js OK`, files copied.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "PDF-EMBEDPDF PoC: PdfEmbedView + open command (desktop wiring)"
```

---

## Task 6: Desktop smoke test (manual — success criteria 2, 3, 5)

**Files:** none (manual verification).

- [ ] **Step 1: Full-restart Obsidian (desktop), open the dev console.**

- [ ] **Step 2: Put a real PDF in the vault, select it, run command "EmbedPDF PoC: open active/last .pdf in editor".**

Expected: a new tab opens; EmbedPDF renders the PDF pages. Console shows no fatal errors (PDFium wasm loaded from the `app://` URL).

- [ ] **Step 3: Add one markup annotation via EmbedPDF's toolbar (e.g., highlight or a free-text box).**

Expected: annotation appears and is interactive (select/move).

- [ ] **Step 4: Save (Ctrl+S). Then close + reopen the PDF in the editor.**

Expected: `Notice "PDF saved (N bytes)"`; on reopen the annotation is still present; opening the saved file in Obsidian's native viewer also shows it. **Confirms vector save round-trip in-app (criterion 2).**

- [ ] **Step 5: Confirm form-fill availability (criterion 3).** In the EmbedPDF build, verify the form plugin renders + fills an AcroForm field on a fillable test PDF (or log "forms deferred" if the pinned version's form-fill is not shipped).

- [ ] **Step 6: Regression (criterion 5):** open a `.docx`, a `.pptx`, an `.xlsx`, and a `.md` note in Obsidi-Office — all still work; clicking a `.pdf` normally still opens Obsidian's native viewer (we did NOT registerExtensions `.pdf`).

- [ ] **Step 7: Record results** in `pdf-editor/POC-RESULTS.md` (desktop section: pass/fail per criterion, console notes). Commit.

```bash
git add pdf-editor/POC-RESULTS.md && git commit -m "PDF-EMBEDPDF PoC: desktop smoke results"
```

---

## Task 7: iPad smoke test (manual — success criterion 4, the cross-platform gate)

**Files:** none (manual verification on device).

- [ ] **Step 1: Ensure the deployed plugin files reach iPad.** Obsidian Sync propagates `main.js` + `manifest.json` + `styles.css` + `data.json` only. The bundled `pdf-editor/dist/pdf-editor.js` and `assets/pdfium/pdfium.wasm` are **extra files that do NOT sync** (known constraint from P23/P21). For the PoC, either (a) inline `pdf-editor.js` into `main.js` at build time, or (b) lazy-download both from a GitHub release (the P1 installer). For P0, use (a) inline-and-base64 the wasm OR temporarily host on a release and fetch via `requestUrl`. **Record which delivery path was used.**

- [ ] **Step 2: On iPad, full-restart Obsidian, open a PDF, run the open command.**

Expected: EmbedPDF renders in WKWebView. (PDFium is single-threaded / no SharedArrayBuffer — the property this step validates on real hardware.)

- [ ] **Step 3: Add an annotation (touch/Pencil), save, reopen.**

Expected: save round-trip works; annotation persists. Capture any WKWebView-specific errors.

- [ ] **Step 4: Record iPad results in `pdf-editor/POC-RESULTS.md`. Commit.**

```bash
git add pdf-editor/POC-RESULTS.md && git commit -m "PDF-EMBEDPDF PoC: iPad smoke results"
```

- [ ] **Step 5: GATE DECISION.** If criteria 1–4 all pass → P0 PASSES; write the P1 plan (view + markup + vector save + sidecar + landing tab + opt-in open + GitHub-release asset installer). If iPad fails on wasm/Worker → evaluate main-thread-only engine config; if unrecoverable, document and reconsider (spec risk section).

---

## Phases after P0 (planned only after the gate passes)

These are intentionally **not** detailed here — their exact EmbedPDF API calls and file structures depend on what Task 1's probe + the desktop smoke establish. After P0 PASSES, write `2026-..-..-pdf-editor-embedpdf-p1.md` etc.:

- **P1:** view + markup + vector save + `.pdf.md` sidecar + landing PDF tab + Search-tab inclusion + "Edit in Obsidi-Office" command/ribbon + GitHub-release asset installer (replace the local-staged wasm).
- **P2:** signature + AcroForm fill.
- **P3:** page management (custom PageOrganizer on EmbedPDF thumbnails driving PDFium page ops).
- **P4:** redaction + redact+overlay "edit text" workflow.
- **P5:** iPad/touch (Pencil ink) polish, autosave + destructive-op confirm UX, hardening, retire the OnlyOffice `pdf-poc` code (keep the harmless `_openInView` `state.file` fix).

---

## Self-review notes

- **Spec coverage (P0 portion):** engine+vector-save (Tasks 1–2), Preact+EmbedPDF build (Task 3), PDFium asset/URL (Task 4), ItemView + opt-in open (Task 5), desktop validation incl. forms-check + regression (Task 6), iPad gate (Task 7). Feature phases P1–P5 deferred by design (gated on P0) — explicitly listed so nothing is dropped.
- **Placeholders:** the only deliberately-deferred specifics are exact EmbedPDF API names, which **Task 1 discovers and records before they're used** — this is the legitimate purpose of a PoC probe, not a hidden TODO. Every such call is flagged "exact name from probe.mjs."
- **Type/name consistency:** `mountPdfEditor`/`savePdfEditor`/`unmountPdfEditor` (Task 3) are the exact names called in Task 5; `VIEW_TYPE_PDF_EMBED`, `PdfEmbedView`, `pdfiumWasmUrl()` consistent across Tasks 4–5; `onSave(bytes)` signature matches between `MountOpts` (Task 3) and the view's `modifyBinary` call (Task 5).
- **Codebase fit:** mirrors the existing `pdf-poc` command + `assetBaseUrl`/`getResourcePath` patterns; manual smoke testing matches the plugin's established verification style (no unit-test harness exists); the iPad asset-sync caveat is the documented P21/P23 constraint.
