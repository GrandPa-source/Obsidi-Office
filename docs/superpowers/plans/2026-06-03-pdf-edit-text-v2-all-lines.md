# PDF Edit Text v2 (Acrobat-like all-lines) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace Phase A's broken click-to-pick with an Acrobat-like model: Edit Text mode outlines every text line; click an outline to edit it in place (matched font, auto-fit so nothing overflows); save redacts+overlays changed lines.

**Architecture:** All in the `pdf-editor` Preact bundle. Reuse `edit-text.ts` (redact/overlay/flatten) + `TextEditBox` + the A4 confirm-save. Add line partitioning + auto-fit to `edit-text.ts`; replace the A2 click-overlay with a per-line **outlines layer** (positioned via % of the page container — zoom-independent); the active editor measures its sx from the clicked outline.

**Tech Stack:** EmbedPDF 2.14.3, PDFium WASM, Preact, esbuild, TS, Playwright harness.

**Spec:** `docs/superpowers/specs/2026-06-03-pdf-edit-text-v2-all-lines-design.md`

---

## Conventions
- Build: `cd pdf-editor && npx tsc --noEmit && node esbuild.config.mjs` (both clean).
- Harness: `node test/server.mjs 5599`; verify via Playwright. **Tests MUST dispatch real DOM clicks on real outline elements** (`elementFromPoint(...).dispatchEvent(new MouseEvent('click',{clientX,clientY}))`), not internal resolvers. Test at 100% and a non-1 zoom.
- Deploy: copy `pdf-editor/dist/pdf-editor.js`(+`.js.map`) to `C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/pdf-editor/dist/`.
- Commit prefix `PDF-EMBEDPDF PoC:` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch `pdf-editor-embedpdf`.
- The controller (not the implementer) runs the Playwright verification at each review gate.

---

## Task V1: Line model + auto-fit in `edit-text.ts`

**Files:** Modify `pdf-editor/src/edit-text.ts`.

- [ ] **Step 1: Add `Line`, `partitionLines`, `mapStandardFont`, `fitFontSize`.**

```ts
export interface Line {
  rect: any;            // engine-native {origin,size}, PDF points
  text: string;         // concatenated, trailing newline stripped
  fontSize: number;     // points (dominant run)
  pdfFont: number;      // PdfStandardFont enum for the saved overlay (Courier0/Helvetica4/Times8)
  cssFont: string;      // matching CSS font stack for on-screen + measuring
  color: string;        // hex
  runs: TextRunLike[];
}

// Map a run's font to the nearest of PDFium's standard fonts + a CSS stack.
export function mapStandardFont(font: any): { pdfFont: number; cssFont: string } {
  const name = String(font?.name || font?.family || '').toLowerCase();
  if (/times|serif|georgia|roman/.test(name)) return { pdfFont: 8, cssFont: 'Times New Roman, Times, serif' };
  if (/courier|mono|consol/.test(name)) return { pdfFont: 0, cssFont: 'Courier New, Courier, monospace' };
  return { pdfFont: 4, cssFont: 'Helvetica, Arial, sans-serif' };
}

function hexColor(c: any): string {
  if (!c) return '#000000';
  const r = c.red ?? 0, g = c.green ?? 0, b = c.blue ?? 0;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Group runs sharing a baseline into visual lines (reuses the lineRuns tolerance).
export function partitionLines(runs: TextRunLike[]): Line[] {
  const remaining = runs.slice().sort((a, b) => a.rect.origin.y - b.rect.origin.y || a.rect.origin.x - b.rect.origin.x);
  const used = new Set<TextRunLike>();
  const lines: Line[] = [];
  for (const r of remaining) {
    if (used.has(r)) continue;
    const group = lineRuns(remaining.filter((x) => !used.has(x)), r);
    group.forEach((g) => used.add(g));
    group.sort((a, b) => a.rect.origin.x - b.rect.origin.x);
    const dom = group.reduce((p, c) => (c.fontSize > p.fontSize ? c : p), group[0]);
    const fm = mapStandardFont(dom.font);
    lines.push({
      rect: unionRect(group),
      text: group.map((g) => g.text).join('').replace(/\r?\n$/, ''),
      fontSize: dom.fontSize,
      pdfFont: fm.pdfFont, cssFont: fm.cssFont,
      color: hexColor(dom.color),
      runs: group,
    });
  }
  return lines;
}

// Largest size <= start whose text fits maxWidth (and <= maxHeight). measureText
// scales linearly with px size, so a single proportional step is exact for width.
let _measCtx: CanvasRenderingContext2D | null = null;
export function fitFontSize(text: string, cssFont: string, maxWidthPt: number, maxHeightPt: number, startSizePt: number): number {
  if (!text) return Math.min(startSizePt, maxHeightPt);
  if (typeof document === 'undefined') return Math.min(startSizePt, maxHeightPt);
  if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
  const ctx = _measCtx!;
  ctx.font = `${startSizePt}px ${cssFont}`;
  const w = ctx.measureText(text).width || 1;
  let size = startSizePt;
  const budget = maxWidthPt * 0.98;
  if (w > budget) size = startSizePt * (budget / w);
  if (size > maxHeightPt) size = maxHeightPt;
  return Math.max(4, size);
}
```

- [ ] **Step 2: Extend `applyTextEdit` to take the mapped font + fitted size** (default keeps current behaviour):

```ts
export async function applyTextEdit(
  engine: PdfEngine, doc: any, page: any,
  rect: any, newText: string, fontSize: number, pdfFont = 4,
): Promise<boolean> {
  // ...unchanged redact...
  const annot = {
    type: 3, pageIndex: page.index ?? 0, id: 'edit-' + (page.index ?? 0) + '-' + rect.origin.x + '-' + rect.origin.y + '-' + (++_editSeq),
    rect, contents: newText, fontFamily: pdfFont, fontSize: Math.max(4, Math.round(fontSize || 12)),
    fontColor: '#000000', textAlign: 0, verticalAlign: 0, opacity: 1,
  };
  // ...unchanged create + flatten...
}
```
(Change the two literals: `fontFamily: 4` → `fontFamily: pdfFont`; `Math.max(8,...)` → `Math.max(4,...)`. Keep everything else.)

- [ ] **Step 3:** Typecheck + build clean.

- [ ] **Step 4: Controller harness assertion** — `partitionLines(getRuns(...))` on the sample returns 2 lines with correct text/rects; `fitFontSize('EmbedPDF PoC sample page','Helvetica,Arial,sans-serif',321,28,24)` returns ≤24 and >0; a long string returns a smaller size.

- [ ] **Step 5: Commit** `edit-text.ts`.

## Task V2: Outlines layer (replace the A2 click-overlay) + precompute lines

**Files:** Modify `pdf-editor/src/index.tsx`.

- [ ] **Step 1: Precompute lines when edit mode is on.** In `EditorBody`, add `const [linesByPage, setLinesByPage] = useState<Record<number, { ptW:number; ptH:number; lines: any[] }>>({});` and:

```tsx
useEffect(() => {
  if (!editTextOn) { setLinesByPage({}); return; }
  let cancelled = false;
  (async () => {
    const reg = (globalThis as any).ObsidiPdfEditor.getRegistry?.();
    const eng = reg?.getEngine();
    const doc = reg?.getPlugin('document-manager')?.provides()?.getActiveDocument();
    if (!doc) return;
    const map: Record<number, any> = {};
    for (const page of doc.pages) {
      const runs = await editText.getRuns(eng, doc, page);
      map[page.index] = { ptW: page.size.width, ptH: page.size.height, lines: editText.partitionLines(runs) };
    }
    if (!cancelled) setLinesByPage(map);
  })().catch((e) => console.warn('[pdf-editor] line scan failed', e));
  return () => { cancelled = true; };
}, [editTextOn, pendingEdits.length]);
```

- [ ] **Step 2: Replace the A2 click-overlay** in the `renderPage` closure (the `{editTextOn ? (<div ...overlay...>) : null}` block) with an outlines layer:

```tsx
{editTextOn && linesByPage[pageIndex] ? linesByPage[pageIndex].lines.map((ln: any, i: number) => {
  const { ptW, ptH } = linesByPage[pageIndex];
  const o = ln.rect.origin, s = ln.rect.size;
  const edited = pendingEdits.some((p) => p.pageIndex === pageIndex && p.lineIndex === i);
  return (
    <div key={i} data-testid={`pdf-line-${pageIndex}-${i}`}
      class={`${CX}-line-outline${edited ? ` ${CX}-line-edited` : ''}`}
      style={{ position:'absolute', left:`${o.x/ptW*100}%`, top:`${o.y/ptH*100}%`,
        width:`${s.width/ptW*100}%`, height:`${s.height/ptH*100}%`, zIndex:10 }}
      onClick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const sx = r.width / s.width, sy = r.height / s.height;
        setActiveEdit({ pageIndex, lineIndex: i, rect: ln.rect, text: ln.text,
          fontSize: ln.fontSize, cssFont: ln.cssFont, pdfFont: ln.pdfFont, color: ln.color, sx, sy });
      }}
    />
  );
}) : null}
```

- [ ] **Step 3: CSS** for `.${CX}-line-outline` (subtle border, hover emphasis) + `.${CX}-line-edited` (accent border) in `injectChromeStyles()`:
```css
.${CX}-line-outline{box-sizing:border-box;border:1px solid rgba(120,150,220,0.35);border-radius:2px;cursor:text;background:transparent;}
.${CX}-line-outline:hover{border-color:var(--oo-accent);background:rgba(120,150,220,0.08);}
.${CX}-line-edited{border-color:var(--oo-accent-underline);}
```

- [ ] **Step 4: Update `ActiveEdit` type** to add `lineIndex:number; cssFont:string; pdfFont:number; color:string` (keep `pageIndex,rect,text,fontSize,sx,sy`).

- [ ] **Step 5:** Remove the now-unused A2 overlay's `onPickLine`/`runAtPoint` click path IF nothing else uses it. Keep `onPickLine` only if the `__editapi.pick` hook still references it; otherwise delete it and the hook. (The outlines replace pick.)

- [ ] **Step 6:** Typecheck + build clean.

- [ ] **Step 7: Controller real-click verification** — enable Edit Text; assert N outline divs render (`[data-testid^="pdf-line-0-"]`) matching `partitionLines` count; their on-screen rects match the line geometry (% of page); **dispatch a real click** on `pdf-line-0-0` → `activeEdit.lineIndex===0`, text == line 0 text. Repeat at 50% zoom (outlines still align via %). Commit.

## Task V3: TextEditBox — matched font + auto-fit on input

**Files:** Modify `pdf-editor/src/index.tsx` (`TextEditBox`).

- [ ] **Step 1:** `TextEditBox` reads `edit.cssFont`, `edit.color`, and computes a fitted display size that updates as the user types:
```tsx
const fitted = editText.fitFontSize(val, edit.cssFont, edit.rect.size.width, edit.rect.size.height, edit.fontSize);
// style: fontFamily: edit.cssFont, color: edit.color, fontSize: fitted * edit.sy (px), whiteSpace:'pre', overflow:'hidden'
```
Position/size via % of the page container (`left:`${o.x/?}`) is NOT available here (box is in the page container; use sx/sy px like before): `left:o.x*edit.sx, top:o.y*edit.sy, width:s.width*edit.sx, height:s.height*edit.sy, fontSize:fitted*edit.sy`. Keep the idempotent commit guard.

- [ ] **Step 2:** Typecheck + build clean.

- [ ] **Step 3: Controller verification** — real-click a line → box mounts in the matched font, fontSize ≈ line size (NOT larger); type a long string → displayed font shrinks (no overflow/wrap, text stays visible). Geometry matches the outline. Commit.

## Task V4: Save — apply with mapped font + fitted size

**Files:** Modify `pdf-editor/src/index.tsx` (the `_applyPendingEdits` loop).

- [ ] **Step 1:** In the apply loop, compute the fitted size + pass the mapped font:
```tsx
const fitted = editText.fitFontSize(ed.newText, ed.cssFont, ed.rect.size.width, ed.rect.size.height, ed.fontSize);
await editText.applyTextEdit(engine, doc, page, ed.rect, ed.newText, fitted, ed.pdfFont);
```
(`pendingEdits` entries already carry `cssFont,pdfFont,fontSize,rect` from the outline-click `setActiveEdit` → `onCommit` spread. Ensure `onCommit` pushes those fields: `{ ...activeEdit, newText }` already does.)

- [ ] **Step 2:** Typecheck + build clean.

- [ ] **Step 3: Controller real round-trip** — real-click a line → edit → Enter → Save → Replace → reopen: replacement present as a run, original gone, AND the saved overlay did not overflow (the new run's rect width ≤ original line width). Re-enter Edit Text → the edited line re-outlines (re-editable). Commit.

## Task V5: Deploy + cleanup + real-Obsidian gate

**Files:** `pdf-editor/POC-RESULTS.md`; remove A2 dead code if any remains.

- [ ] **Step 1:** Remove any leftover A2-only code (the single overlay, unused `onPickLine`/`runAtPoint` import if now unused — but keep `runAtPoint` in edit-text.ts exports; just remove unused wiring). Typecheck/build clean.
- [ ] **Step 2:** Deploy `dist/pdf-editor.js`(+map) to OB_Testing (sha match).
- [ ] **Step 3:** Record v2 results in `POC-RESULTS.md`. Commit.
- [ ] **Step 4 (REQUIRED GATE):** Hand to the user for a **real-Obsidian desktop smoke** on a genuine multi-line text PDF: toggle Edit Text → outlines on every line → click one → edit in matched font (no growth/overflow) → Ctrl+S → Replace → reopen shows the edit. Do NOT mark done until the user confirms in real Obsidian.

---

## Self-Review
- **Spec coverage:** outline-all-lines (V2), click-to-activate one-at-a-time (V2/V3), per-line unit (V1 partitionLines), matched font + auto-fit fixing the grow/wrap bug (V1 fitFontSize + V3 + V4), redact+overlay+flatten reuse (V1 applyTextEdit), confirm-save reuse (V4), % positioning so outlines are zoom-independent (V2), real-DOM-click + real-Obsidian testing gate (V2/V3/V4 verifications + V5 Step 4). ✓
- **Placeholders:** none — concrete code for the new edit-text.ts functions + the outline layer; UI wiring references exact existing structures (renderPage closure, EditorBody state, injectChromeStyles, _applyPendingEdits).
- **Type consistency:** `Line`/`partitionLines`/`fitFontSize`/`mapStandardFont` (V1) used verbatim in V2-V4; `ActiveEdit` gains `lineIndex,cssFont,pdfFont,color` (V2) consumed in V3 (box) + V4 (save); `applyTextEdit(...,pdfFont)` signature (V1) matches the V4 call. `pendingEdits` entries carry the font fields via the `{...activeEdit,newText}` spread.
- **Known limit:** column-sharing baselines merge into one line (deferred); measureText approximates PDFium metrics (2% safety margin in fitFontSize).
