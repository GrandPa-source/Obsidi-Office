# PDF Editor — "Edit PDF" Mode, Phase 1 (OnlyOffice-style object editing)

**Date:** 2026-06-04
**Status:** Design — pending user review.
**Supersedes the interaction model of:** `2026-06-03-pdf-edit-text-v2-all-lines-design.md` (outline-click → custom `TextEditBox` + redact/overlay/**flatten**). Keeps that spec's font-matching (`mapStandardFont`, weight, colour, size calibration) and line/segment partitioning for the outline pass.
**Reason for revision:** User wants an OnlyOffice-like two-tier model: an **Edit PDF** master toggle that enables a content-editing toolset; an **Edit Text** sub-mode that dashes every text block; clicking a block turns it into a selectable text box the user can **move, resize, rotate, and edit in place**. EmbedPDF's annotation plugin already implements all of those primitives, so the custom `TextEditBox` overlay is replaced by native FreeText-annotation editing.

---

## 1. What we're building (Phase 1 only)

1. The Home-ribbon **"Edit Text"** button becomes **"Edit PDF"** — a master toggle. When ON, a content-editing ribbon group is enabled (Phase 1 surfaces **Edit Text** + **Insert Text**; the full font/paragraph toolset is Phase 2/3). When OFF, the editor is in view/annotate mode as today.
2. Within Edit PDF mode, **Edit Text** (sub-button) dashes every text line on each visible page (the existing outline pass, restyled to a dashed border).
3. **Clicking a dashed line converts that line into an editable FreeText box:** the original glyphs are redacted and a FreeText annotation with the same text/font/size/weight/colour is created in their place and selected. EmbedPDF then renders resize + rotation handles; the user can **drag to move, drag handles to resize, drag the rotation handle to rotate, and double-click to edit the text**.
4. **Insert Text** drops a brand-new empty FreeText box (the existing `freeText` tool), click-to-place, immediately editable.
5. Edits persist across save/reload as FreeText annotations (natively re-editable). Baking edits into indistinguishable page content ("Finalize/Flatten") is **deferred** (see §7).

Out of scope for Phase 1: the font/paragraph formatting ribbon (Phase 2), lists/indent/spacing, insert image/shape, arrange/z-order, multi-select group transforms (Phase 3).

## 2. Why this is mostly integration

The current `index.tsx` already:
- Mounts `<AnnotationLayer>` per page (`index.tsx:1411`) — this renders the selection box + handles automatically when an annotation is selected.
- Has `useAnnotation(documentId)` → `annotationApi` with `setActiveTool`, `createAnnotation`, `selectAnnotation`, `updateAnnotation`, `getSelectedAnnotation`, `deleteAnnotation` (`index.tsx:903`).
- Has a working **`freeText` "Text" tool** in the Comment ribbon (`index.tsx:1111-1113`) that already creates movable/resizable/editable FreeText boxes.
- Has Select mode (`setActiveTool(null)`), Hand mode, undo/redo, delete-selected.

So move/resize/edit already work today for any FreeText box. Phase 1 adds: the Edit PDF master toggle + gated group, the dashed-outline restyle, the **click-line → redact + createAnnotation(FreeText) + select** conversion, the Insert Text entry point, and `isRotatable` for FreeText.

## 3. Architecture

- **Engine-native editing.** Editable text lives as EmbedPDF **FreeText annotations**. Selection, move (`startDrag`/`updateDrag`/`commitDrag`), resize, rotate, and double-click in-place edit are all handled inside `AnnotationContainer`/`AnnotationLayer` — no app pointer code.
- **Existing text is not directly mutable** (PDFium bakes glyphs into the content stream). To make a line editable we **redact the original rect + create a FreeText with the same text/style at that rect** (our existing `redactTextInRects` + the run's mapped font/weight/colour). We do **not** flatten — it stays a live, re-editable object.
- **Font matching reused.** The conversion's FreeText params come straight from the Phase-v2 work: `mapStandardFont(run.font)` → `fontFamily` (PDF standard font) + `weight`; `hexColor` → `fontColor`; line `fontSize`. The size-calibration insight (`fitBox`) informs the initial FreeText `fontSize`/`rect`.
- **Mode discipline.** Conversion and movement require **select mode** (`activeTool == null`). Insert Text uses `setActiveTool('freeText')` (create mode). Toggling Edit PDF off disarms tools and clears outlines.

## 4. Components / changes (files)

- `pdf-editor/src/index.tsx`
  - **Ribbon restructure:** add a **new `editPdfOn` master state**; rename the Home `BigBtn` "Edit Text" → **"Edit PDF"** to toggle it. Add a content-editing `Group` gated on `editPdfOn` containing **Edit Text** (a sub-toggle bound to the **existing `editTextOn` state**, which drives the dashed outline pass) and **Insert Text** (`setActiveTool('freeText')`). Turning Edit PDF off forces `editTextOn=false` and disarms tools. Phase 2 controls slot into this same group. (Net: two states — `editPdfOn` master gates the group; `editTextOn` sub drives outlines.)
  - **Outline click handler:** replace the current `setActiveEdit(...)` / `TextEditBox` path (`index.tsx:1427-1453`) with a `convertLineToFreeText(pageIndex, line)` call: redact `line.rect`, `createAnnotation(pageIndex, freeTextAnnot)` built from the line's text + mapped font/weight/colour/size, then `selectAnnotation(pageIndex, id)`. Remove the `<TextEditBox>` mount.
  - **Dashed outline style:** restyle `${CX}-line-outline` to a dashed border; keep `data-testid="pdf-line-<page>-<i>"`.
  - **FreeText rotation:** enable `isRotatable: true` for the `freeText` tool in the `AnnotationPluginPackage` registration (`index.tsx:1546`).
- `pdf-editor/src/edit-text.ts`
  - Add `buildFreeTextFromLine(line) → PdfFreeTextAnnoObject-shaped params` (text, rect, fontFamily=pdfFont, fontSize, fontColor, weight→via fontFamily bold variant, textAlign=left). Reuse `mapStandardFont`/`hexColor`. Keep `partitionLines` for the outline pass.
  - Keep `applyTextEdit` (redact+overlay+flatten) only if still used by the deferred Finalize path; otherwise mark dormant. The redact step is reused by `convertLineToFreeText`.
- **CSS** (`styles`/`CX` classes): dashed outline; ensure the FreeText/annotation handles aren't occluded by the outline layer `zIndex`.

## 5. Data flow

Edit PDF ON → Edit Text ON → per visible page: `getRuns` → `partitionLines` → render dashed outlines. Click outline *i* (select mode) → `convertLineToFreeText`: `redactTextInRects(line.rect)` → `createAnnotation(FreeText{contents, rect, fontFamily, fontSize, fontColor})` → `selectAnnotation(id)`. EmbedPDF shows handles → user drags body (move) / handles (resize) / rotation handle (rotate) / double-clicks (edit text). Insert Text → `setActiveTool('freeText')` → click page → new box, auto-selected + editing. Save → `saveAsCopy` (annotations auto-committed) → vault. Reload → FreeText annotations persist and are natively selectable/editable.

## 6. Granularity decision (per-line vs per-segment)

Phase 1 converts **one FreeText box per visual line** (matches the user's image 4, where each line is its own dashed box). A FreeText annotation has a **single font**, so a mixed-weight line (e.g. bold "To:" + regular value) is rendered at the line's **majority weight** (the rule shipped in commit `caee282`). This is a known fidelity limitation of the object model: true mixed weight in one box is not expressible in a FreeText. **Alternative (deferred):** convert per *style segment* (the v2 per-segment boxes) so each weight is its own FreeText — higher fidelity, more boxes. Flagged for user input; default is per-line.

## 7. Save / persistence model

- **Phase 1:** edits persist as **FreeText annotations** (autoCommit → included in `saveAsCopy`). On reload they are real annotations — natively selectable, movable, editable. This is the OnlyOffice behaviour (text blocks remain objects).
- **Deferred — "Finalize / Flatten":** a later action flattens the edit FreeTexts into page content so the saved PDF is indistinguishable baked text (the earlier v2 goal). Requires tagging which FreeTexts are text-edits vs comments. Not in Phase 1.

## 8. Platform

Desktop + iPad. All interaction is EmbedPDF-native (already touch-capable). iPad re-checked after desktop passes.

## 9. Testing (hard requirement)

- Playwright harness with **real** clicks/drags (the focus/blur + pointer lesson): toggle Edit PDF → Edit Text → outlines dashed; click a line → assert a FreeText annotation now exists at that rect with the matched font/size and is selected; drag the body and assert the annotation's rect origin changed (move); drag a resize handle and assert size changed; drag rotation handle and assert non-zero `rotation`; double-click and assert text edit applies; Insert Text → click → new FreeText created + editable.
- **A real-Obsidian desktop smoke is a REQUIRED gate before "done"** (the Phase-A lesson): no hook-only sign-off.

## 10. Risks

- **Convert-on-click is destructive:** clicking a line redacts the original glyphs even if the user only wanted to look. Acceptable for Phase 1 (the FreeText shows identical text and is re-editable); a future optimisation can convert lazily on first real interaction.
- **Mixed-weight fidelity** (per §6) — single-font FreeText; majority weight only unless we adopt per-segment boxes.
- **Standard-font substitution** — FreeText uses PDFium's 14 standard fonts; the typeface won't match an embedded original (same limitation as v2, communicated not solved).
- **Redaction tightness** — `redactTextInRects` must remove only the line's glyphs, not neighbours (union rect is tight; verified in v2).
- **Save baking** — confirm `saveAsCopy` includes the FreeText edits (autoCommit) during implementation; if not, call `annotationApi.commit()`/engine commit before save.
