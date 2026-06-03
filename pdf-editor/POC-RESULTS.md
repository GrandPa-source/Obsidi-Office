
## Edit Text feasibility gate (2026-06-03) — PASS

Probe run in the live standalone harness (browser, same runtime class as the plugin)
against the engine from `getRegistry().getEngine()`. Spec: `docs/superpowers/specs/2026-06-03-pdf-editor-edit-text-design.md` §9.

Round-trip on the 2-run sample PDF:
- `getPageTextRuns` → target run "EmbedPDF PoC sample page" @ origin(72,69) size 321x28, fontSize 24.
- `engine.redactTextInRects(doc, page, [rect], {drawBlackBoxes:false})` → true (true content removal).
- `engine.createPageAnnotation(doc, page, {type:3 FREETEXT, rect, contents, fontFamily:4 Helvetica, fontSize, fontColor:'#000000', textAlign:0, verticalAlign:0, opacity:1})` → id.
- `engine.flattenAnnotation(doc, page, annot)` → true (bakes AP into page content as real text operators).
- `engine.saveAsCopy(doc)` → valid `%PDF-`, 2084 bytes.
- `engine.openDocumentBuffer({id, content})` reopen → pageCount 1.
- `getPageTextRuns` after → `["Render + annotation toolbar validation", "ZZREPLACEDZZ"]`; `extractText` after → same.

Asserts: origGone=true, replacementIsRun=true (flatten yields an EXTRACTABLE text run -> re-editable + searchable),
replacementExtractable=true, validPdf=true. **PASS=true.**

Decision: proceed to the P1 implementation plan (spec §7 components). No annotation-layer fallback needed.

## Edit Text — Phase A complete (A1–A5, 2026-06-03)

Implemented via subagent-driven development; every task spec+quality reviewed and harness-verified in the standalone Playwright harness (engine + DOM hooks). Commits on `pdf-editor-embedpdf`: A1 `16c5816`+`c130752`, A2 `aacfd8c`+fix, A3 `cc64ea4`+`7d6605e`, A4 `54ff3c7`+`57de1eb`.

- **A1 edit-text.ts** — getRuns/runAtPoint/lineRuns/unionRect/applyTextEdit. Round-trip verified (original gone, replacement an extractable run).
- **A2 mode + button + pick** — Home "Edit Text" enabled/active; conditional click-overlay resolves the clicked line to an `activeEdit`.
- **A3 edit box** — anchored, pre-filled, font-matched textarea; Enter/blur commit (idempotent guard), Esc cancels; staged into `pendingEdits`; unchanged commits don't stage.
- **A4 save** — confirm modal ("Permanently replace N text region(s)?"); Replace applies redact+flatten per staged edit then saveAsCopy; Cancel aborts the save and keeps edits staged; concurrent-save guard (no hang); resolve-on-unmount.
- **A5 re-editability** — PROVEN: edit original line → save (flattened to a real run) → re-pick the SAME line → box pre-fills with the previously-edited text → edit again → save → prior text gone, new text in. (`prefill2 === "FIRST"` is the proof that flattened body text is re-targetable.)

**Known limitation (spec non-goal, no reflow):** the edit box uses the picked run's rect as its width. Re-editing a SHORT replacement with a longer word wraps it within that narrow box (observed "SECOND" → runs "SECO"+"ND"). Replacing original full-width lines with similar-length text does not wrap. Future enhancement: widen the box toward the page margin.

**Deployed** dist/pdf-editor.js to OB_Testing (sha256 match). main.js/sprites/wasm unchanged. **PENDING: user desktop smoke** on a real multi-page PDF in Obsidian.

## Edit Text v2 (Acrobat-like all-lines) — V1–V4 shipped (2026-06-03)

Pivoted from click-to-pick to outline-all-lines after the real-Obsidian smoke failed
(layout `scale` undefined → NaN click coords) and the substitute-font overlay grew/wrapped.
Spec: `…/specs/2026-06-03-pdf-edit-text-v2-all-lines-design.md`. Commits `b4ddaf3..` on `pdf-editor-embedpdf`.

- **V1** `edit-text.ts`: `partitionLines` (runs→visual lines), `mapStandardFont` (font→PDFium standard + CSS), `fitFontSize` (auto-fit via canvas measureText), `applyTextEdit` gains `pdfFont`. hexColor normalizes 0–1/0–255.
- **V2** outlines layer: Edit Text mode scans pages → renders a subtle outline `<div>` per line (`%`-positioned, zoom-independent), `pdf-line-<p>-<i>`; click activates that line. Replaces the broken click-overlay → **no screen→point click math** (the NaN bug is structurally gone). Rescan only after edits APPLY (scanVersion), not per stage.
- **V3** `TextEditBox`: renders in the line's matched font/colour, auto-fit size per keystroke.
- **V4** save: bakes each changed line in the mapped font at the auto-fit size.

**Harness verification (REAL dispatched clicks + zoom, per the prior lesson):**
- 2 outlines on the sample; geometry exact at 100% AND 50% zoom; real click activates the right line + opens the box.
- Box matched font; heading fits 23px in a 28px box (NOT oversized); long text shrinks 23→9px, no overflow.
- Long replacement saved as ONE run at 316pt ≤ 321pt original width (no wrap/overflow); original gone; re-editable (outlines refresh post-save, re-click pre-fills new text).

**PENDING: required real-Obsidian desktop smoke** on a genuine multi-line text PDF (the gate that the prior version failed). Deployed to OB_Testing (sha match). main.js/sprites/wasm unchanged. Dormant A2 `onPickLine`/`pick` left for post-smoke cleanup (harmless).
