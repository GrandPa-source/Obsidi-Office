# PDF Editor — Edit Text v2 (Acrobat-like all-lines editing)

**Date:** 2026-06-03
**Status:** Design — approved by user 2026-06-03.
**Supersedes the interaction model of:** `2026-06-03-pdf-editor-edit-text-design.md` (Phase A click-to-pick). Keeps that spec's engine mechanism (redact + overlay + flatten) and save model.
**Reason for revision:** Phase A's click-to-pick failed in real Obsidian (the Scroller layout `scale` is `undefined` → coordinate conversion produced NaN; only ever "passed" because harness tests fed page coords past the boundary), and the substitute-font overlay rendered larger than the original and wrapped/overflowed. User wants an Adobe-Acrobat-like experience: enter Edit Text → editable boxes appear over the text → click to edit in place.

---

## 1. What we're building

When the user toggles **Edit Text**, every text **line** on each visible page is decorated with a subtle **outline**. Clicking an outline turns that line into a live editable `<textarea>` (one at a time), pre-filled with the line text in the matched font/size/colour. Edits stage; on save, each changed line is redacted and replaced with auto-fit overlay text, flattened into the page. This is Acrobat-*like* in-place editing, within the engine's limits.

## 2. Approved decisions

- **Fidelity bar:** Acrobat-like UX with **approximate font** (substitute font, **auto-fit** so text never overflows/wraps). NOT pixel-perfect to the original typeface, NOT raw PDFium text-object editing.
- **Edit unit:** **one text line per box** (no reflow → per-line maps cleanly to redact-and-replace).
- **Box behaviour:** **outline all lines, click to activate** (one live editor at a time). Not N simultaneous live fields.

## 3. Why this also fixes the click bug

The Phase A overlay resolved a raw page click to a run via `(clientX-left)/scale` — fragile, and `scale` was undefined at runtime. v2 renders a **real positioned `<div>` per line**; clicking it activates *that* line directly. There is no screen→point resolution on the click path, so the entire NaN-coordinate failure mode is gone. Geometry is only used to *place* outlines/boxes, via the proven measured factor `sx = overlayRect.width / page.size.width` (zoom-independent; verified at 100% and 50%).

## 4. Components

**Reused (from Phase A):**
- `edit-text.ts` — `getRuns`, `lineRuns`, `unionRect`, `applyTextEdit` (redact+overlay+flatten). Extended (§6) with line partitioning + auto-fit.
- `TextEditBox` — the live editor (textarea). Extended to take the matched font family + auto-fit size and to render in the matched font.
- Pending-edits state + the confirm-modal save path (A4): on save, "Replace N line(s)?" → apply each changed line → `saveAsCopy`. Unchanged. Concurrent-save guard + resolve-on-unmount kept.

**New:**
1. **Line model** (`edit-text.ts`): `partitionLines(runs) → Line[]`, where `Line = { rect, text, fontSize, fontFamily, color, runs }`. Groups runs sharing a baseline (reuses the `lineRuns` tolerance), unions their rect, concatenates text, takes the dominant run's font/size/colour.
2. **Auto-fit** (`edit-text.ts`): `fitFontSize(text, fontFamily, maxWidthPt, maxHeightPt, startSizePt) → number` — the largest size ≤ start that fits both the line width and height, measured via an offscreen canvas `measureText` (CSS font ≈ PDF font). Used for the on-screen editor AND the saved overlay so they agree (WYSIWYG).
3. **Outlines layer** (`index.tsx`): inside the per-page render closure, when `editTextOn`, render one outline `<div>` per `partitionLines` line at `rect * sx/sy`, `data-testid="pdf-line-<page>-<i>"`. Subtle border; hover emphasis; **accent border if that line is in `pendingEdits`**. Click → activate that line (set `activeEdit` from the line model, including `fontFamily` + auto-fit size).
4. **Replaces** the A2 single click-overlay div (removed).

## 5. Data flow

Toggle Edit Text on → per visible page: `getRuns` → `partitionLines` → render outlines. Click outline *i* → `activeEdit = { pageIndex, rect, text, fontSize: fit(...), fontFamily, color, sx, sy }` → `TextEditBox` mounts over the line, matched font, pre-filled. Edit → Enter/blur → if changed, push to `pendingEdits` (outline turns accent); Esc → discard. Save → confirm → per changed line: `applyTextEdit` (redact original rect → add free-text in matched font at auto-fit size → flatten) → `saveAsCopy` → vault. Reopen/re-enter Edit Text → flattened text is a real run → re-outlined → re-editable.

## 6. Auto-fit detail (the fidelity fix)

The "font grows / wraps / disappears" bug is a substitute-font metric mismatch (Helvetica at the same nominal size is wider/taller than the original face). Fix:
- Measure the replacement string's width at the candidate size in the matched CSS font via canvas `measureText`.
- Pick the largest size ≤ the original `fontSize` whose measured width ≤ line width AND whose size ≤ line height. (Binary/iterative search, few steps.)
- Apply that size to (a) the on-screen `TextEditBox` (re-fit on input so typing never overflows) and (b) the saved free-text annotation. Identical function → on-screen matches saved.
- Colour preserved from the run; family mapped to an available font (fallback Helvetica).

## 7. Non-goals (unchanged + clarified)

- No reflow; no paragraph/block editing (per-line only).
- No original-typeface preservation (substitute font).
- No raw PDFium text-object mutation.
- No multi-line-per-box editing.
- Image/scanned PDFs (no text runs) show no outlines — nothing to edit (communicated, not an error).

## 8. Platform

Desktop + iPad. Outlines/boxes are plain positioned DOM (touch-friendly). All engine calls are the supported set already validated. iPad re-checked after desktop passes.

## 9. Testing (hard requirement — the Phase A lesson)

- Harness tests MUST dispatch **real DOM click events** on real outline elements (`elementFromPoint(...).dispatchEvent(new MouseEvent('click', {clientX, clientY}))`) and assert the downstream effect (correct line activated, box geometry == line geometry, auto-fit size sane) — NOT call an internal resolver with pre-computed coords.
- Verify outline placement + click activation at 100% AND a non-1 zoom.
- **A real-Obsidian desktop smoke on a genuine multi-line text PDF is a REQUIRED gate before "done."** No hook-only sign-off.

## 10. Risks

- **Auto-fit approximation** — canvas `measureText` with a CSS font approximates PDFium's render; minor width error possible → leave a small safety margin (fit to ~98% of line width).
- **Dense pages** — many outlines; mitigated by per-visible-page rendering + cheap divs + single active textarea. If a page has >N lines, still fine (divs are light); measure if needed.
- **Line partitioning** — runs that share a baseline but belong to different columns would merge into one wide line. Acceptable for v1; note as a known limitation (column-aware splitting deferred).
- **Real-environment drift** — the very reason for this revision. Mitigated by the §9 real-Obsidian gate.
