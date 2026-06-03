# PDF Editor — "Edit Text" (edit existing PDF body text)

**Date:** 2026-06-03
**Status:** Design — approved by user 2026-06-03; feasibility gate pending.
**Builds on:** `docs/superpowers/specs/2026-05-29-pdf-editor-embedpdf-design.md` (EmbedPDF foundation, P0 PASSED desktop; left rail shipped 2026-06-02, commit `fdbaae4`).
**Component:** the spec's P4 `TextOverlayEdit` workflow, brought forward and refined.

---

## 1. Background — why this is not "true" text editing

OnlyOffice's PDF "Edit Text" converts the whole PDF into its internal word-processor model and edits with full reflow — the same engine that makes OnlyOffice's client-side PDF *save* infeasible (the reason Obsidi-Office moved to EmbedPDF). EmbedPDF/PDFium cannot match that.

Engine probe (EmbedPDF 2.14.3, `PdfEngine` interface):
- **Reads** text: `getPageTextRuns` (text + font + position), `getPageTextRects`, `extractText`, `getTextSlices`. ✓
- **Adds** content: free-text annotations, images, stamps, shapes, text-markup. ✓
- **Redacts**: `@embedpdf/plugin-redaction@2.14.3` exists; engine supports run-slice redaction ("removes content, flattens RO overlay, deletes annotation") + `flatten` (bake an annotation's AP/N into page content). ✓
- **Modifies an existing text object's string**: NOT exposed. `FPDFText_SetText` is compiled into the PDFium WASM but EmbedPDF does not wrap it, and even raw it gives no reflow.

So "Edit Text" is delivered as **redact-the-original + overlay-the-replacement**, with the replacement **flattened into real page content** so it reads as native body text.

## 2. Goal

Enable the Home-ribbon **Edit Text** button so a user can click a line of existing PDF text, retype it in place, and save — with the original removed and the replacement baked in as ordinary, searchable body text that the same tool can edit again later.

## 3. Approved decisions

- **Approach:** A — redact + overlay (not raw PDFium mutation; not OnlyOffice-style reflow).
- **Selection unit:** text **line / run** (click a line → that line's run(s) become one editable box).
- **Removal method:** **true redaction** (run-slice content removal) — original glyphs gone, unrecoverable, can't peek out behind a shorter replacement. Destructive → committed at **save** behind a single confirm.
- **Replacement persistence:** **flattened into page content** on save → indistinguishable from native body text, searchable. **Re-editability is a property of the tool, not the object:** because the replacement is a real text run, the Edit Text tool re-targets it via `getPageTextRuns` exactly like original text. No persistent annotation layer.

## 4. Workflow

1. **Activation** — enable the existing (disabled) Home-ribbon Edit Text button; it sets an `editText` interaction mode mutually exclusive with the annotation tools / Select / Hand.
2. **Select** — on page click, `getPageTextRuns(page)` finds the run(s) on the clicked line; compute their union rect; read font family / size / color.
3. **Edit surface** — an inline editable box (FreeText annotation in edit mode, reusing the annotation plugin) anchored to that rect, pre-filled with the original text, matched font/size/color.
4. **Stage** — committing the box (click-away / Enter) stages a redaction over the original run's rect and keeps the new text. Nothing destructive yet; the new box visually covers the original.
5. **Save / commit (confirm-gated)** — on save with pending edits, one confirm: *"Permanently replace N text region(s)? The original text will be removed."* On confirm → apply run-slice redaction (removes original) → flatten each replacement into page content → `saveAsCopy` → `writeBinary` to vault. Autosave suppressed while a box is open or a confirm is pending.
6. **Re-edit** — reopened, the replacement is ordinary body text; the same Edit Text tool can select and edit it again.

## 5. Fonts

Best-effort: exact size; map the run's font family to an available editor font; fall back to Helvetica/Arial; preserve color. Typing fresh text in a mapped, available font sidesteps the original embedded-subset glyph gaps.

## 6. Non-goals (v1)

- Reflow of surrounding text.
- Multi-line / paragraph / region edit (one line/run per edit).
- Rich-formatting toggles beyond inherited font/size/color (no bold/italic UI).
- Table/column-aware editing.
- Editing text inside form fields or existing annotations (body text only).

## 7. Components

- **Engine glue:** wrappers over `getPageTextRuns` (locate line), redaction-plugin apply (run-slice removal), free-text create/edit (the editable box), `flatten` (bake replacement), `saveAsCopy`.
- **`editText` interaction mode:** registered alongside the existing tools; click → resolve run → open box.
- **Edit box UI (Preact):** anchored, pre-filled, font-matched; commit on Enter/click-away, cancel on Esc.
- **Pending-edits store + save hook:** stage redaction rects + replacement text; on save, confirm → apply → flatten → save; suppress autosave while pending.
- **Home-ribbon wiring:** enable the Edit Text `BigBtn`; reflect active state.

## 8. Platform

Desktop (Electron) + iPad (Capacitor WKWebView). All APIs are the supported EmbedPDF/PDFium set already validated for render/annotate/save in P0. The redaction + flatten round-trip is part of the feasibility gate below; iPad re-verification is a later task once desktop passes.

## 9. Feasibility gate (MUST pass before building UI)

A throwaway Node/browser harness probe proves the round-trip on a real text PDF:

1. Open a PDF; `getPageTextRuns` returns a target run with text + rect + font.
2. Apply run-slice redaction over that run (true content removal).
3. Add a replacement free-text at the run rect with new text; `flatten` it into page content.
4. `saveAsCopy` → reopen the saved bytes.
5. **Assert:** (a) the original string is gone from `getPageTextRuns`/`extractText`; (b) the replacement string is present **as an extractable text run** `getPageTextRuns` sees (proves indistinguishable + searchable + re-editable); (c) valid `%PDF`, same page count.

**Decision:**
- **PASS** → write the P1 implementation plan (the components in §7).
- **FAIL on (b)** (flatten yields raster/vector, not a text run) → STOP and return to the user with the fallback: keep the replacement as a **re-editable FreeText annotation** (still editable; reads as an annotation layer, not native body text) — a deliberate downgrade of decision §3's "indistinguishable," requiring sign-off.
- **FAIL on (a)** (redaction doesn't remove the run) → investigate redaction-plugin apply semantics (quads vs run-slices) before proceeding.

## 10. Risks

- **Flatten fidelity** (the gate's core unknown) — see §9.
- **Run granularity** — `getPageTextRuns` run boundaries may split a visual line into multiple runs (style spans). The "line" selection unions runs sharing a baseline; mis-grouping yields a too-small or too-large box. Tunable; verified during the gate with a real multi-run line.
- **Redaction confirm fatigue** — mitigated by deferring the single confirm to save, not per-edit.
- **Font match approximation** — accepted per §5; visible only when the original used an unusual face.
- **iPad redaction/flatten** — unverified until the desktop gate passes; then re-checked on device.
