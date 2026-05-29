# PDF Editor (EmbedPDF) — Design Spec

**Date:** 2026-05-29
**Status:** Design — awaiting user review before implementation planning.
**Supersedes (for the save-capable direction):** the OnlyOffice PDF-editor approach in `docs/superpowers/specs/2026-05-28-pdf-editor-design.md` and the feasibility wall documented in `docs/superpowers/plans/2026-05-29-pdf-editor-phase0-findings.md`.

---

## 1. Background — why this exists

Obsidi-Office edits `.docx/.pptx/.xlsx` via an embedded OnlyOffice engine. A PDF editor was attempted on the same OnlyOffice engine (load + edit were proven), but **client-side save is infeasible**: OnlyOffice's only PDF writer is the headless DocBuilder native module (not loaded in the browser editor), so the editor can only emit an internal "save-bin" needing server x2t (which cannot write PDF), or a rasterized re-render. Every native PDF-write route was ruled out (see the findings doc).

Decision (user, 2026-05-29): build a **browser-native PDF editor with a true vector save** and drop OnlyOffice for PDFs. After researching engines and reusable editor UIs, the chosen foundation is **EmbedPDF** (PDFium-WASM, MIT) — it provides ~70–80% of the editor UI plus a clean vector `saveAsCopy()`, is single-threaded (no SharedArrayBuffer → iPad-viable), and is permissively licensed.

## 2. Goals

- An **opt-in** PDF editor inside Obsidi-Office supporting: **markup/annotation, signature, AcroForm fill, page management, redaction, and "edit text" via redact+overlay**.
- **True vector save** written back to the `.pdf` in the vault.
- Runs on **desktop (Electron)** and **iPad (Capacitor WKWebView)**.
- Maximize reuse of EmbedPDF's prebuilt UI; build only the genuinely missing pieces.
- Leave the rest of Obsidi-Office (docx/pptx/xlsx/note) and Obsidian's native PDF viewer untouched.

## 3. Non-goals (explicit)

- **True in-place text reflow editing** of a PDF's existing body text — infeasible in any browser engine. "Edit text" is delivered as **redact-old + overlay-new-text** (substitute font, no reflow).
- **Incremental / signature-preserving save** — `saveAsCopy()` is a full PDFium re-serialization (vector, but not byte-preserving). Editing digitally-signed PDFs is out of scope.
- **Form-field authoring** — fill existing AcroForm fields only; not creating fields.
- **Replacing Obsidian's native PDF viewer as the default** — opt-in only. A "make Obsidi-Office the default PDF handler" setting is a possible later add, not v1.
- Collaborative/multi-user editing; OCR; encrypted-PDF authoring.

## 4. Architecture

- **Engine:** EmbedPDF (`@embedpdf/*`, pin exact version, currently 2.14.x) on **PDFium-WASM** (`@embedpdf/pdfium`, ~4.6 MB). Single-threaded; **no SharedArrayBuffer / COOP-COEP required**.
- **UI runtime:** **Preact**, bundled via esbuild. This is the one new dependency in the plugin's stack and is required to use EmbedPDF's prebuilt plugin UI components (its components ship for React/Vue/Svelte/Preact only — there is no vanilla-JS UI layer; Preact is the smallest, and is what EmbedPDF's own drop-in uses). Preact is scoped to the PDF editor view only.
- **Host:** a native Obsidian `ItemView` (`PdfEditorView`) that mounts the Preact + EmbedPDF app into the view's `contentEl`. **No blob-iframe** (unlike the OnlyOffice editors) — EmbedPDF renders directly to canvas/DOM in the view.
- **Save:** EmbedPDF export plugin `saveAsCopy()` → `ArrayBuffer` → `vault.adapter.writeBinary` to the source `.pdf`. Vector output with annotations/redactions/form-data baked in.
- **Assets:** PDFium WASM + EmbedPDF runtime are **lazy-downloaded from a GitHub release** using the existing `requestUrl → writeBinary` installer pattern (the same approach as the OnlyOffice asset zip), cached in the vault; never bundled into `main.js`. A canary file check triggers (re)install.

## 5. Components

**Reused from EmbedPDF (no build):** viewer/viewport, virtualized scroll, zoom/pan/rotate, page **thumbnails**, **annotation** layer + toolbar + selection/resize handles + history/undo (highlight, underline, strikeout, ink, shapes, free-text, stamp), **signature**, **redaction** (marquee + true content removal), **AcroForm fill**, **export/saveAsCopy**.

**Built by us:**
1. **`PdfEditorView`** (ItemView): lifecycle (onOpen/onLoadFile/onClose), asset-readiness gate, mounts the Preact/EmbedPDF app, wires save-to-vault, sidecar, large-file notice.
2. **PageOrganizer** (custom Preact component on top of EmbedPDF's thumbnail surface): drag-reorder, insert-from-file, delete, rotate-page, split, merge — driving PDFium ops (`deletePage`, `merge`/`mergePages`, `importPages`, `extractPages`) with reorder composed via those primitives. (No OSS UI exists for this.)
3. **TextOverlayEdit** (custom workflow): select a text region → redact it (true removal) → place a FreeText annotation with a chosen font/size as the replacement. The "edit text" UX. (No OSS UI exists for this; composed from EmbedPDF redaction + free-text.)
4. **AssetInstaller**: adapt the existing installer to fetch PDFium WASM + EmbedPDF assets from a GitHub release into the vault, with canary-based (re)install.
5. **Obsidian integration shell:** `.pdf.md` **sidecar** (tags/links, matching docx/pptx/xlsx/note); **PDF landing-page tab**; **Search-tab** inclusion; **"Edit in Obsidi-Office"** command + ribbon entry; opt-in open routing (`.pdf` is deliberately **not** `registerExtensions`'d, so the native viewer stays default).

## 6. Data flow

Open `.pdf` (via command / landing tab) → `PdfEditorView.onLoadFile` → ensure assets installed → read PDF bytes from vault → EmbedPDF loads into PDFium memory → user edits (annotations / forms / redactions / page ops are applied as PDF objects in PDFium memory) → **save**: `saveAsCopy()` → `ArrayBuffer` → `writeBinary` to the `.pdf` → sidecar `modified` timestamp updated. Destructive operations (redaction commit, page delete) are confirm-gated before they mutate the document.

## 7. Save & autosave

- **Explicit save:** Ctrl+S + a toolbar Save button → `saveAsCopy()` → write.
- **Autosave:** debounced (consistent with the other editors' ~10 s cadence), **suppressed** while a destructive-op confirmation is pending. Redaction commit and page delete always require an explicit user confirm before being applied.
- **Output:** a full PDFium re-serialization — valid vector PDF; original byte layout not preserved (acceptable per non-goals).

## 8. Platforms

- Desktop (Electron) and iPad (Capacitor WKWebView). PDFium-WASM is single-threaded with no SharedArrayBuffer requirement — the property that makes the iPad path viable where the OnlyOffice route stalled.
- EmbedPDF's engine may optionally run in a Web Worker to keep the main thread responsive; Worker viability on iPad is verified in Phase 0.

## 9. Phasing

- **P0 — PoC gate (desktop + iPad):** stand up EmbedPDF + Preact inside the plugin; load + render a real PDF; `saveAsCopy()` → write to vault → reopen and confirm validity; confirm AcroForm fill is actually shipped (not just exportable); confirm load + render + save inside iPad WKWebView. **Hard decision gate before P1.**
- **P1:** view + markup annotations + vector save + sidecar + landing PDF tab + opt-in open routing + asset installer.
- **P2:** signature + AcroForm fill.
- **P3:** page management (custom PageOrganizer).
- **P4:** redaction + redact+overlay "edit text".
- **P5:** iPad/touch polish (finger/pencil ink), autosave, hardening, and retiring the OnlyOffice `pdf-poc` code (keeping the harmless general fixes: `_openInView` `state.file`).

## 10. Risks & mitigations

- **EmbedPDF maturity** (young, fast-moving, ~138 open issues, lockstep multi-package versions) → pin exact versions; treat upgrades as deliberate; vendor the asset bundle.
- **Preact-in-Obsidian integration unknowns** → P0 validates mount/unmount, event handling, and teardown inside an ItemView.
- **Vanilla-UI depth** — EmbedPDF's ready-made toolbar "chrome" is React/Preact-first; we may rebuild a thin toolbar in our own Preact rather than use the `snippet` drop-in → acceptable (toolbar is small relative to the annotator/engine).
- **iPad WKWebView unverified for EmbedPDF specifically** → P0 gate on real hardware.
- **Form-fill maturity unconfirmed** in docs → P0 verifies; if weak, forms move to a later phase.
- **`saveAsCopy` is a full rewrite, not incremental** → acceptable per non-goals; flagged for any future signed-PDF use.
- **PDFium WASM size (~4.6 MB)** → lazy-download + vault cache (existing pattern), not bundled.

## 11. Success criteria

- On **both desktop and iPad**: open a real PDF in the editor; add markup + a signature; fill an AcroForm field; reorder + delete a page; redact a region; overlay-edit a line of text; save; reopen → **all edits present**, output is a **valid vector PDF** (text stays crisp on zoom).
- docx/pptx/xlsx/note editing is **unaffected**; Obsidian's native PDF viewer remains the default for plain viewing.
- Asset install works cold-start on a fresh device (desktop + iPad).

## 12. Open questions (resolve during planning / P0)

- Exact EmbedPDF package set, and whether to consume the `snippet` drop-in vs. headless plugins + our own thin Preact toolbar.
- Engine in a Web Worker vs. main thread (esp. iPad).
- Autosave cadence + the precise destructive-op confirmation UX.
- Asset packaging: one GitHub-release zip (PDFium WASM + EmbedPDF runtime) mirroring the OnlyOffice asset pipeline.
