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

/** Apply one text edit: redact original rect, add replacement free-text, flatten it.
 *  Mirrors the feasibility-gate sequence exactly. Returns true on success. */
export async function applyTextEdit(
  engine: PdfEngine, doc: any, page: any,
  rect: any, newText: string, fontSize: number,
): Promise<boolean> {
  const e = engine as any;
  const redOk = await toP(e.redactTextInRects(doc, page, [rect], { drawBlackBoxes: false }));
  if (!redOk) return false;
  const annot = {
    type: 3 /* FREETEXT */, pageIndex: page.index ?? 0,
    id: 'edit-' + (page.index ?? 0) + '-' + rect.origin.x + '-' + rect.origin.y + '-' + (++_editSeq),
    rect, contents: newText, fontFamily: 4 /* Helvetica */,
    fontSize: Math.max(8, Math.round(fontSize || 12)),
    fontColor: '#000000', textAlign: 0, verticalAlign: 0, opacity: 1,
  };
  const id = await toP(e.createPageAnnotation(doc, page, annot));
  const flatOk = await toP(e.flattenAnnotation(doc, page, { ...annot, id: id || annot.id }));
  return !!flatOk;
}
