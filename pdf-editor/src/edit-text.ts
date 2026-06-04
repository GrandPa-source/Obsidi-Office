// pdf-editor/src/edit-text.ts
// PDF-EMBEDPDF PoC — Edit Text engine glue. Pure async fns over the EmbedPDF
// engine; all calls verified in the 2026-06-03 feasibility gate (POC-RESULTS.md).
import type { PdfEngine } from '@embedpdf/engines';

export interface TextRunLike {
  text: string;
  rect: any;            // Rect {origin:{x,y},size:{width,height}} (engine-native)
  fontSize: number;
  font?: any;
  color?: any;
  charIndex: number;
  charCount: number;
}

const toP = (t: any): Promise<any> =>
  !t ? Promise.resolve(t)
  : typeof t.toPromise === 'function' ? t.toPromise()
  // t.wait(onFulfilled, onRejected) — EmbedPDF Tasks use the two-callback pattern, not Node error-first.
  : typeof t.wait === 'function' ? new Promise((res, rej) => t.wait(res, rej))
  : typeof t.then === 'function' ? t : Promise.resolve(t);

let _editSeq = 0;

/** All runs on the page (reading order). */
export async function getRuns(engine: PdfEngine, doc: any, page: any): Promise<TextRunLike[]> {
  const r = await toP((engine as any).getPageTextRuns(doc, page));
  return (r && r.runs) || [];
}

/** The run whose rect contains the page-space point (x,y), else null. */
export function runAtPoint(runs: TextRunLike[], x: number, y: number): TextRunLike | null {
  for (const r of runs) {
    const o = r.rect.origin, s = r.rect.size;
    if (x >= o.x && x <= o.x + s.width && y >= o.y && y <= o.y + s.height) return r;
  }
  return null;
}

/** Runs sharing the clicked run's baseline (same line). Groups multi-style spans. */
export function lineRuns(runs: TextRunLike[], clicked: TextRunLike): TextRunLike[] {
  const cy = clicked.rect.origin.y, ch = clicked.rect.size.height;
  return runs.filter((r) => {
    const oy = r.rect.origin.y;
    return Math.abs(oy - cy) <= Math.max(2, ch * 0.4);
  });
}

/** Bounding rect over a set of runs (engine-native Rect shape). */
export function unionRect(runs: TextRunLike[]): any {
  if (runs.length === 0) throw new Error('unionRect: requires at least one run');
  const xs = runs.map((r) => r.rect.origin.x);
  const ys = runs.map((r) => r.rect.origin.y);
  const xe = runs.map((r) => r.rect.origin.x + r.rect.size.width);
  const ye = runs.map((r) => r.rect.origin.y + r.rect.size.height);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { origin: { x, y }, size: { width: Math.max(...xe) - x, height: Math.max(...ye) - y } };
}

export interface Line {
  rect: any;            // engine-native {origin,size}, PDF points
  text: string;         // concatenated, trailing newline stripped
  fontSize: number;     // points (dominant run)
  pdfFont: number;      // PdfStandardFont enum for the saved overlay (Courier 0 / Helvetica 4 / Times 8)
  cssFont: string;      // matching CSS font stack for on-screen + measuring
  weight: string;       // 'bold' | 'normal' — matched from the original font name
  color: string;        // hex
  runs: TextRunLike[];
}

// Map a run's font to the nearest of PDFium's standard fonts + a CSS stack + weight.
// PDFium only ships regular/bold of Helvetica/Times/Courier; match the weight when
// the original is bold/semibold so the edit isn't visibly lighter than the line.
export function mapStandardFont(font: any): { pdfFont: number; cssFont: string; weight: string } {
  const name = String(font?.name || font?.family || '').toLowerCase();
  const bold = /bold|semibold|black|heavy|[-_ ](bd|sb|blk)\b/.test(name);
  const weight = bold ? 'bold' : 'normal';
  if (/times|serif|georgia|roman/.test(name)) return { pdfFont: bold ? 9 : 8, cssFont: 'Times New Roman, Times, serif', weight };
  if (/courier|mono|consol/.test(name)) return { pdfFont: bold ? 1 : 0, cssFont: 'Courier New, Courier, monospace', weight };
  return { pdfFont: bold ? 5 : 4, cssFont: 'Helvetica, Arial, sans-serif', weight };
}

function hexColor(c: any): string {
  if (!c) return '#000000';
  let r = c.red ?? 0, g = c.green ?? 0, b = c.blue ?? 0;
  // EmbedPDF may return channels normalized 0–1 (PDF PDFReal) or as 0–255. If
  // every channel is ≤ 1, treat them as 0–1 floats and scale up. (A genuine
  // 0–255 colour with all channels ≤ 1 is indistinguishable from black anyway.)
  if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Group runs sharing a baseline into visual lines (reuses the lineRuns tolerance).
export function partitionLines(runs: TextRunLike[]): Line[] {
  const sorted = runs.slice().sort((a, b) => a.rect.origin.y - b.rect.origin.y || a.rect.origin.x - b.rect.origin.x);
  const used = new Set<TextRunLike>();
  const lines: Line[] = [];
  for (const r of sorted) {
    if (used.has(r)) continue;
    const group = lineRuns(sorted.filter((x) => !used.has(x)), r);
    group.forEach((g) => used.add(g));
    group.sort((a, b) => a.rect.origin.x - b.rect.origin.x);
    const dom = group.reduce((p, c) => (c.fontSize > p.fontSize ? c : p), group[0]);
    const fm = mapStandardFont(dom.font);
    lines.push({
      rect: unionRect(group),
      text: group.map((g) => g.text).join('').replace(/\r?\n$/, ''),
      fontSize: dom.fontSize,
      pdfFont: fm.pdfFont, cssFont: fm.cssFont, weight: fm.weight,
      color: hexColor(dom.color),
      runs: group,
    });
  }
  return lines;
}

// Largest size <= start whose text fits maxWidth (and <= maxHeight). measureText
// scales linearly with px size, so one proportional step is exact for width.
let _measCtx: CanvasRenderingContext2D | null = null;
export function fitFontSize(text: string, cssFont: string, maxWidthPt: number, maxHeightPt: number, startSizePt: number): number {
  if (!text || typeof document === 'undefined') return Math.min(startSizePt, maxHeightPt);
  if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
  const ctx = _measCtx;
  if (!ctx) return Math.min(startSizePt, maxHeightPt);
  ctx.font = `${startSizePt}px ${cssFont}`;
  const w = ctx.measureText(text).width || 1;
  let size = startSizePt;
  const budget = maxWidthPt * 0.98;
  if (w > budget) size = startSizePt * (budget / w);
  if (size > maxHeightPt) size = maxHeightPt;
  return Math.max(4, size);
}

/** Canvas text width (px≈pt) for the given CSS font at sizePt (+ optional weight). */
export function measureTextWidthPt(text: string, cssFont: string, sizePt: number, weight = ''): number {
  if (!text || typeof document === 'undefined') return 0;
  if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
  if (!_measCtx) return text.length * sizePt * 0.5;
  _measCtx.font = `${weight ? weight + ' ' : ''}${sizePt}px ${cssFont}`;
  return _measCtx.measureText(text).width;
}

/**
 * Decide the overlay box width + font size for a replacement, PRESERVING the
 * original size when possible. The box is widened (toward the page right edge)
 * so the text fits on one line at the original size; only if it can't fit even
 * at full page width do we shrink. A generous safety factor keeps PDFium's
 * FreeText from wrapping (canvas measureText slightly under-reports PDFium's
 * standard-font widths, and any overflow makes FreeText wrap to a 2nd line that
 * overflows the one-line box → the cut-off bug).
 */
export function fitBox(
  text: string, cssFont: string, origSizePt: number, rect: any, pageWidthPt: number, origText?: string, weight = '',
): { fontSize: number; width: number } {
  const SAFETY = 1.1;                        // pad measured width so PDFium never wraps
  const x = rect.origin.x, w0 = rect.size.width, h = rect.size.height;
  // Calibrate the substitute-font size to the ORIGINAL font's rendered footprint.
  // PDFium only has the 14 standard fonts (Helvetica/Times/Courier), which render
  // larger than e.g. Segoe UI at the same point size — so a "preserved" 15pt looks
  // bigger. The original text occupied w0 at origSize in ITS font; if our substitute
  // renders that same text wider, scale the size down by the ratio so the edit
  // visually matches the original. Clamped to avoid extremes.
  let baseSize = origSizePt;
  if (origText && w0 > 0) {
    const subW = measureTextWidthPt(origText, cssFont, origSizePt, weight);
    if (subW > 0) baseSize = origSizePt * Math.max(0.6, Math.min(1.15, w0 / subW));
  }
  let fontSize = Math.min(baseSize, h > 0 ? h : baseSize);   // never taller than the line
  const need = measureTextWidthPt(text, cssFont, fontSize, weight) * SAFETY || w0;
  const maxW = Math.max(w0, (pageWidthPt || x + w0) - x - 6);     // can extend to ~6pt from page edge
  let width = w0;
  if (need <= w0) {
    width = w0;                              // fits in the original box at original size
  } else if (need <= maxW) {
    width = need;                            // widen the box, keep the size
  } else {
    width = maxW;                            // shrink to fit the widest allowed box
    fontSize = Math.max(4, fontSize * (maxW / need));
  }
  return { fontSize, width };
}

/** Apply one text edit: redact original rect, add replacement free-text, flatten it.
 *  Mirrors the feasibility-gate sequence exactly. Returns true on success. */
export async function applyTextEdit(
  engine: PdfEngine, doc: any, page: any,
  rect: any, newText: string, fontSize: number, pdfFont = 4, overlayRect?: any,
): Promise<boolean> {
  const e = engine as any;
  // Redact the ORIGINAL line rect; place the new text in the (possibly wider)
  // overlay rect so it fits on one line at the preserved size.
  const oRect = overlayRect || rect;
  const redOk = await toP(e.redactTextInRects(doc, page, [rect], { drawBlackBoxes: false }));
  if (!redOk) return false;
  const annot = {
    type: 3 /* FREETEXT */, pageIndex: page.index ?? 0,
    id: 'edit-' + (page.index ?? 0) + '-' + oRect.origin.x + '-' + oRect.origin.y + '-' + (++_editSeq),
    rect: oRect, contents: newText, fontFamily: pdfFont,
    fontSize: Math.max(4, Math.round(fontSize || 12)),
    fontColor: '#000000', textAlign: 0, verticalAlign: 0, opacity: 1,
  };
  const id = await toP(e.createPageAnnotation(doc, page, annot));
  const flatOk = await toP(e.flattenAnnotation(doc, page, { ...annot, id: id || annot.id }));
  return !!flatOk;
}
