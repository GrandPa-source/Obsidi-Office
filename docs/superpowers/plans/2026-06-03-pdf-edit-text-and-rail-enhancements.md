# PDF Editor — Edit Text + Left-rail Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Home-ribbon "Edit Text" button edit existing PDF body text (redact-original + flatten-replacement), and bring the left rail to OnlyOffice parity (thumbnail size popover, Headings panel, comment styling/actions/filter).

**Architecture:** All code lives in the separately-bundled Preact module `pdf-editor/src/` (esbuild → `dist/pdf-editor.js`, loaded by the hand-written `main.js` — unchanged). Edit Text composes supported EmbedPDF **engine** calls proven in the feasibility gate: `getPageTextRuns` → `redactTextInRects` → `createPageAnnotation`(FreeText) → `flattenAnnotation` → `saveAsCopy`. Rail enhancements extend the existing `LeftRailAndPanel`/panel components and add a bookmark read path (`getBookmarks`).

**Tech Stack:** EmbedPDF `@embedpdf/*` 2.14.3, `@embedpdf/pdfium` WASM, Preact, esbuild, TypeScript, Obsidian API, Playwright (standalone harness verification).

**Specs:**
- `docs/superpowers/specs/2026-06-03-pdf-editor-edit-text-design.md` (Phase A)
- `docs/superpowers/specs/2026-06-03-pdf-left-rail-enhancements-design.md` (Phase B)

**Feasibility gate (Phase A):** ALREADY PASSED — `pdf-editor/POC-RESULTS.md` (2026-06-03). Redact+flatten round-trip yields an extractable, re-editable text run. No fallback needed.

---

## Conventions for this plan

- **Build:** `cd pdf-editor && npx tsc --noEmit && node esbuild.config.mjs` (typecheck must be clean before bundling).
- **Harness:** `cd pdf-editor && node test/server.mjs 5599` serves `test/standalone.html` (live editor on `test/sample.pdf`, 2 text runs). Verification = Playwright `browser_evaluate` against `window.ObsidiPdfEditor.getRegistry()` (engine/plugin access) and DOM `data-testid` queries, plus screenshots with `document.body.classList.add('theme-dark')` injected for dark-mode visual checks. ALSO inject the Obsidian button constraint when visually validating list UIs: `button{height:30px;white-space:nowrap}` (the 2026-06-02 bleed lesson).
- **`toP` helper** (Playwright eval) for EmbedPDF `PdfTask`s:
  ```js
  const toP = (t) => !t ? Promise.resolve(t)
    : typeof t.toPromise==='function' ? t.toPromise()
    : typeof t.wait==='function' ? new Promise((res,rej)=>t.wait(res,rej))
    : typeof t.then==='function' ? t : Promise.resolve(t);
  ```
- **Deploy:** copy `pdf-editor/dist/pdf-editor.js` (+ `.js.map`) to `C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/pdf-editor/dist/`. `main.js` is unchanged; no asset-zip rebuild (sprites/wasm already present).
- **Commit prefix:** `PDF-EMBEDPDF PoC: ...` + the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Branch:** `pdf-editor-embedpdf` (current).

---

## File Structure

- **Create `pdf-editor/src/edit-text.ts`** — engine glue (pure async functions over the verified engine calls): `getLineRunsAt`, `unionRect`, `redactRuns`, `addReplacementText`, `flattenReplacement`, `applyTextEdit`. No Preact; takes `engine`, `doc`, `page`. One responsibility: the redact+overlay+flatten mechanism.
- **Create `pdf-editor/src/headings.ts`** — `loadHeadings(engine, doc)` → flat list of `{title, depth, target}` from `getBookmarks`; `navigateToBookmark`. One responsibility: outline read/flatten.
- **Create `pdf-editor/src/comments-model.ts`** — comment thread assembly from annotation state (`buildThreads`, `isResolved`, `setResolved`, `sortComments`, `filterComments`, `avatarFor`). One responsibility: comment data shaping + resolved/reply semantics (decision §6.1 result wired here).
- **Modify `pdf-editor/src/index.tsx`** — add the `editText` mode + edit box + pending-edits/save hook (Phase A); add Headings rail item + thumbnails settings popover + comment restyle/actions/header (Phase B). Each consumes the focused modules above so `index.tsx` stays a composition layer, not a logic dump.
- **Modify `pdf-editor/test/standalone.html`** — add `window.__editapi` test hooks (Phase A) and a richer sample where needed.
- **Create `pdf-editor/test/make-headings-sample.mjs`** — generate a PDF WITH an outline for Headings populated-state tests.

---

# PHASE A — Edit Text

## Task A1: Engine-glue module `edit-text.ts` (the verified mechanism)

**Files:**
- Create: `pdf-editor/src/edit-text.ts`
- Test: Playwright assertion via `test/standalone.html` hook (Step 5)

- [ ] **Step 1: Write `edit-text.ts` with the gate-proven calls**

```ts
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
  : typeof t.wait === 'function' ? new Promise((res, rej) => t.wait(res, rej))
  : typeof t.then === 'function' ? t : Promise.resolve(t);

/** All runs on the page (reading order). */
export async function getRuns(engine: PdfEngine, doc: any, page: any): Promise<TextRunLike[]> {
  const r = await toP(engine.getPageTextRuns(doc, page));
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
  const redOk = await toP(engine.redactTextInRects(doc, page, [rect], { drawBlackBoxes: false }));
  if (!redOk) return false;
  const annot = {
    type: 3 /* FREETEXT */, pageIndex: page.index ?? 0, id: 'edit-' + page.index + '-' + rect.origin.x + '-' + rect.origin.y,
    rect, contents: newText, fontFamily: 4 /* Helvetica */, fontSize: Math.max(8, Math.round(fontSize || 12)),
    fontColor: '#000000', textAlign: 0, verticalAlign: 0, opacity: 1,
  };
  const id = await toP(engine.createPageAnnotation(doc, page, annot));
  const flatOk = await toP(engine.flattenAnnotation(doc, page, { ...annot, id: id || annot.id }));
  return !!flatOk;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd pdf-editor && npx tsc --noEmit`
Expected: no output (clean). If `PdfEngine` lacks a method on the type, cast `engine as any` for that call (the runtime methods exist per the gate).

- [ ] **Step 3: Build the bundle**

Run: `node esbuild.config.mjs`
Expected: `build complete -> dist/pdf-editor.js`.

- [ ] **Step 4: Expose a test hook in `standalone.html`**

Add inside the `<script>` after mount succeeds (near `window.__poc.mounted = true;`):

```js
// Edit-text test hook (Phase A verification).
window.__editapi = {
  async runs() {
    const reg = window.ObsidiPdfEditor.getRegistry();
    const dm = reg.getPlugin('document-manager').provides();
    const doc = dm.getActiveDocument();
    const page = doc.pages[0];
    const m = window.ObsidiPdfEditor.__editText; // exported in Step 6
    return (await m.getRuns(reg.getEngine(), doc, page)).map(r => r.text);
  },
};
```

- [ ] **Step 5: Add a Playwright assertion (verify getRuns + applyTextEdit round-trip)**

With server running (`node test/server.mjs 5599`), navigate to `http://localhost:5599/test/standalone.html`, then `browser_evaluate`:

```js
async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); await sleep(500);
  const toP=(t)=>!t?Promise.resolve(t):t.toPromise?t.toPromise():t.wait?new Promise((a,b)=>t.wait(a,b)):t;
  const reg=window.ObsidiPdfEditor.getRegistry(), eng=reg.getEngine();
  const doc=reg.getPlugin('document-manager').provides().getActiveDocument(), page=doc.pages[0];
  const m=window.ObsidiPdfEditor.__editText;
  const runs=await m.getRuns(eng,doc,page);
  const target=runs.find(r=>/sample/i.test(r.text))||runs[0];
  const ok=await m.applyTextEdit(eng,doc,page,target.rect,'A1_EDITED',target.fontSize);
  const ab=await toP(eng.saveAsCopy(doc)); const bytes=new Uint8Array(ab);
  const doc2=await toP(eng.openDocumentBuffer({id:'a1',content:ab}));
  const after=(await m.getRuns(eng,doc2,doc2.pages[0])).map(r=>r.text);
  return { ok, origGone:!after.some(t=>/sample/i.test(t)), newRun:after.some(t=>t.includes('A1_EDITED')), header:String.fromCharCode(...bytes.slice(0,5)) };
}
```
Expected: `{ ok:true, origGone:true, newRun:true, header:"%PDF-" }`.

- [ ] **Step 6: Export the module on the global for the hook**

In `index.tsx`, add `import * as editText from './edit-text';` and extend the export block: `(globalThis as any).ObsidiPdfEditor.__editText = editText;` (alongside the existing assignment). Rebuild. Re-run Step 5 → PASS.

- [ ] **Step 7: Commit**

```bash
git add pdf-editor/src/edit-text.ts pdf-editor/src/index.tsx pdf-editor/test/standalone.html
git commit -m "PDF-EMBEDPDF PoC: edit-text engine glue (getRuns/lineRuns/applyTextEdit) + harness assertion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task A2: `editText` interaction mode + enable the Home-ribbon button + click-to-select-line

**Files:**
- Modify: `pdf-editor/src/index.tsx` (Chrome `homeRibbon` Edit Text button; new `editText` state on `EditorBody`)

- [ ] **Step 1: Lift an `editText` active flag into `EditorBody` and pass to Chrome**

In `EditorBody`, add `const [editTextOn, setEditTextOn] = useState(false);` and pass `editTextOn`/`setEditTextOn` to `<Chrome>`. Add `editTextOn`/`setEditTextOn` to `Chrome`'s props type.

- [ ] **Step 2: Enable the Edit Text `BigBtn` (currently `disabled`)**

Replace the disabled Edit Text button in `homeRibbon`:

```tsx
<BigBtn icon={IC.editText} caption="Edit Text" title="Edit existing text"
  active={editTextOn}
  onClick={() => {
    const next = !editTextOn;
    setEditTextOn(next);
    // Editing text is exclusive with annotation tools / select.
    annotationApi?.setActiveTool(null);
    if (next) { try { imApi?.activateDefaultMode?.(); } catch (_) {} }
  }}
  testid="pdf-edit-text" />
```

- [ ] **Step 3: Add a page-level click handler that selects the clicked line (mode on)**

In `EditorBody`, render an invisible capture layer per page is unnecessary — reuse the existing `PagePointerProvider`. Add to the `renderPage` closure (in the `Scroller`) a click handler that, when `editTextOn`, converts the click to page coords and resolves the line. Pass `editTextOn` + an `onPickLine(pageIndex, pageX, pageY)` down to a new small wrapper around the page content. Implement `onPickLine` in `EditorBody`:

```tsx
const onPickLine = useCallback(async (pageIndex: number, px: number, py: number) => {
  const reg = (globalThis as any).ObsidiPdfEditor.getRegistry?.();
  const dm = reg?.getPlugin('document-manager')?.provides();
  const doc = dm?.getActiveDocument(); const page = doc?.pages?.[pageIndex];
  if (!doc || !page) return;
  const runs = await editText.getRuns(reg.getEngine(), doc, page);
  const hit = editText.runAtPoint(runs, px, py);
  if (!hit) return;
  const line = editText.lineRuns(runs, hit);
  setActiveEdit({ pageIndex, rect: editText.unionRect(line),
    text: line.map(r => r.text).join('').replace(/\r?\n$/, ''),
    fontSize: hit.fontSize });
}, []);
```
(`setActiveEdit` is the Task A3 state; for A2, log the pick and assert via the hook.)

- [ ] **Step 4: Coordinate conversion**

The pointer event gives client coords; convert to page space using the page element's bounding rect + scale, and flip Y (PDF origin is bottom-left; EmbedPDF run rects use top-left origin per the gate output — origin.y=69 for the top line — so NO flip needed; use `(clientY - pageTop)/scale`). Verify against the gate's known rect in Step 6.

- [ ] **Step 5: Build + typecheck**

Run: `cd pdf-editor && npx tsc --noEmit && node esbuild.config.mjs` → clean.

- [ ] **Step 6: Playwright assertion — tool toggles + line pick resolves the right run**

Navigate; `browser_evaluate`: click `[data-testid="pdf-edit-text"]`, assert it gets `oo-btn-active`; then simulate a pick by calling the exposed `onPickLine` path via a temporary `window.__editapi.pick(px,py)` hook returning the resolved `{text}`. Click at the page-space point of the "sample" line (origin ~72,70) → expect resolved text contains "sample".
Expected: `{ active:true, picked:"EmbedPDF PoC sample page" }`.

- [ ] **Step 7: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: editText mode + enable Edit Text button + click-to-pick-line

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task A3: Anchored, pre-filled, font-matched edit box

**Files:**
- Modify: `pdf-editor/src/index.tsx` (new `<TextEditBox>` component + `activeEdit` state)

- [ ] **Step 1: Add `activeEdit` state + box component**

```tsx
type ActiveEdit = { pageIndex: number; rect: any; text: string; fontSize: number };
// in EditorBody:
const [activeEdit, setActiveEdit] = useState<ActiveEdit | null>(null);
const [pendingEdits, setPendingEdits] = useState<Array<ActiveEdit & { newText: string }>>([]);
```

```tsx
function TextEditBox({ edit, scale, pageTop, pageLeft, onCommit, onCancel }: {
  edit: ActiveEdit; scale: number; pageTop: number; pageLeft: number;
  onCommit: (newText: string) => void; onCancel: () => void;
}) {
  const [val, setVal] = useState(edit.text);
  const o = edit.rect.origin, s = edit.rect.size;
  return (
    <textarea
      class={`${CX}-textedit`} data-testid="pdf-textedit" autoFocus
      value={val}
      style={{ position:'absolute', left: pageLeft + o.x*scale, top: pageTop + o.y*scale,
        width: s.width*scale, height: s.height*scale, fontSize: edit.fontSize*scale,
        lineHeight: 1.0, fontFamily: 'Helvetica, Arial, sans-serif', color:'#000',
        background:'#fff', border:'1px solid var(--oo-accent)', padding:0, margin:0, resize:'none', zIndex:40 }}
      onInput={(e)=>setVal((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e)=>{ const k=(e as KeyboardEvent); if(k.key==='Escape'){onCancel();}
        else if(k.key==='Enter'&&!k.shiftKey){k.preventDefault();onCommit(val);} }}
      onBlur={()=>onCommit(val)}
    />
  );
}
```

- [ ] **Step 2: Render the box over the active page when `activeEdit` set**

In the `renderPage` closure, when `activeEdit?.pageIndex === pageIndex`, render `<TextEditBox .../>` with `onCommit` = push to `pendingEdits` (replace original text only if changed) then clear `activeEdit`; `onCancel` = clear `activeEdit`. Add CSS for `${CX}-textedit` (flatten Obsidian textarea bleed: `box-shadow:none !important`).

- [ ] **Step 3: Build + typecheck** → clean.

- [ ] **Step 4: Playwright assertion — box appears pre-filled, edits stage**

Navigate; enable Edit Text; pick the "sample" line (via the A2 hook or a real click at its coords); assert `[data-testid="pdf-textedit"]` exists with `value` === "EmbedPDF PoC sample page"; set its value to "Edited line", dispatch Enter; assert `window.__editapi.pendingCount()===1` (add a hook returning `pendingEdits.length`).
Expected: `{ boxText:"EmbedPDF PoC sample page", pending:1 }`.

- [ ] **Step 5: Visual smoke (screenshot)**

Screenshot with the box open; confirm it sits over the original line (anchored), white bg, accent border. Save `pdf-editor/pdf-edittext-box.png`, Read it, confirm placement.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: anchored pre-filled edit box + pending-edits staging

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task A4: Save = confirm + apply (redact+flatten) + autosave suppression

**Files:**
- Modify: `pdf-editor/src/index.tsx` (`saveViaRegistry` / the save closure)

- [ ] **Step 1: Route pending text edits through the save path**

Extend the save flow: before `saveAsCopy`, if `pendingEdits.length`, show a confirm (a small in-bundle modal or `window.confirm` fallback): *"Permanently replace N text region(s)? The original text will be removed."* On confirm, for each pending edit call `editText.applyTextEdit(engine, doc, page, edit.rect, edit.newText, edit.fontSize)` (page = `doc.pages[edit.pageIndex]`), then proceed to the existing annotation-commit + `saveAsCopy`. On cancel, abort the save (leave edits pending).

- [ ] **Step 2: Suppress autosave while editing**

Where autosave is scheduled, guard: skip if `activeEdit !== null || pendingEdits.length > 0 || confirmPending`. (If the bundle has no autosave timer yet, this is a no-op guard for future-proofing — note it and move on.)

- [ ] **Step 3: Clear pending on successful save**

After `onSave(bytes)` resolves, `setPendingEdits([])`.

- [ ] **Step 4: Build + typecheck** → clean.

- [ ] **Step 5: Playwright assertion — full edit→save→reopen round-trip in-app**

Navigate; enable Edit Text; pick "sample" line; set box value "SAVED_EDIT"; Enter; auto-accept the confirm (`window.confirm` returns true under Playwright, or click the modal's confirm `data-testid`); trigger save (`window.ObsidiPdfEditor.savePdfEditor()`); read `window.__poc.savedSize`; then reopen the saved bytes via the engine hook and assert runs contain "SAVED_EDIT" and NOT "sample".
Expected: original gone, "SAVED_EDIT" present as a run, valid `%PDF-`.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: Edit Text save (confirm + apply redact/flatten + autosave suppress)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task A5: Re-editability + desktop smoke + deploy

**Files:** none new (manual + harness).

- [ ] **Step 1: Harness assertion — re-edit a previously-edited line**

After Task A4's save+reopen (replacement is a real run "SAVED_EDIT"), repeat the pick→edit→apply on THAT run, save, reopen → assert "SAVED_EDIT" gone and the new text present. Proves tool-based re-editability (spec §3).
Expected: PASS.

- [ ] **Step 2: Deploy to OB_Testing**

```bash
cp pdf-editor/dist/pdf-editor.js "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/pdf-editor/dist/pdf-editor.js"
cp pdf-editor/dist/pdf-editor.js.map "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/pdf-editor/dist/pdf-editor.js.map"
```

- [ ] **Step 3: Manual desktop smoke (real multi-page PDF)**

Reload Obsidi-Office; open a real PDF via the `embedpdf-poc-open` command; click Edit Text; click a line; edit; Ctrl+S; confirm; reopen → edited text present + searchable (Search panel finds it) + re-editable. Record pass/fail in `pdf-editor/POC-RESULTS.md`.

- [ ] **Step 4: Commit results**

```bash
git add pdf-editor/POC-RESULTS.md
git commit -m "PDF-EMBEDPDF PoC: Edit Text re-edit + desktop smoke results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# PHASE B — Left-rail enhancements

> Build only after Phase A is committed. B0a/B0b resolve spec §6 decisions BEFORE the dependent UI.

## Task B0a: PROBE — "resolved" persistence (spec §6.1)

**Files:** none (throwaway Playwright probe).

- [ ] **Step 1: Probe both routes on the live engine**

`browser_evaluate`: create a Text annotation (type 1) via the annotation plugin; then test route (a) create a child state-reply (annot with `inReplyToId`=parent.id, `stateModel` + state "Completed"/"Marked") and route (b) set `custom.resolved=true` + `updateAnnotation`. For each: `saveAsCopy` → reopen → read annotations → check whether the resolved signal survives.

- [ ] **Step 2: Decide + record**

Record in `pdf-editor/POC-RESULTS.md` which route round-trips. Wire the winner into `comments-model.ts` `isResolved`/`setResolved` (Task B4). If neither round-trips, use `custom.resolved` for the session + document the non-persistent caveat. No code commit this task (probe only); the decision feeds B4.

## Task B0b: PROBE — thumbnail runtime resize (spec §6.2)

**Files:** none (throwaway Playwright probe).

- [ ] **Step 1: Probe**

`browser_evaluate`: open thumbnails; test (a) whether the thumbnail plugin exposes a runtime config setter (`reg.getPlugin('thumbnail').provides()` method list) vs (b) re-rendering `<ThumbnailsPane>` with a different effective width. Measure whether thumb `<img>` width changes without a full remount/flicker.

- [ ] **Step 2: Decide + record**

Record the mechanism in `POC-RESULTS.md`; it feeds Task B1. (Default if (a) absent: our-side display scaling — store `thumbW` state, pass to a wrapper that scales the rendered cell.)

## Task B1: Thumbnails settings popover (size slider + highlight-visible)

**Files:**
- Modify: `pdf-editor/src/index.tsx` (`ThumbnailsPanel`, panel header)

- [ ] **Step 1: Add a settings-icon + popover to the thumbnails panel header**

Add an `IC.railSettings` (sprite `btn-menu-settings` — verify id present in `iconssmall@2.5x.svg`; if absent, reuse an existing sliders glyph) button in the panel header (right side, before close). Toggle a popover with: a range `<input type="range">` "Thumbnails size" (stops 90/120/160/220) and a "Highlight visible part of page" checkbox (default checked). Persist both in component state (and to plugin `data.json` later if desired; v1 = session state).

- [ ] **Step 2: Wire size → thumbnail width** using the B0b-decided mechanism.

- [ ] **Step 3: "Highlight visible part of page"** — on the ACTIVE thumb, overlay a translucent rect = visible viewport fraction. Compute from `useScroll` state (scroll offset + viewport height) ÷ page height × thumb height. Render an absolutely-positioned div inside the active `${CX}-thumbframe`.

- [ ] **Step 4: Build + typecheck** → clean.

- [ ] **Step 5: Playwright assertion + screenshot**

Open thumbnails; click settings icon → popover visible (`data-testid="pdf-thumb-settings"`); move slider → assert thumb `<img>` width changed; toggle highlight off → overlay removed. Screenshot popover (light + dark). Save + Read.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: thumbnails settings popover (size + highlight-visible)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task B2: Headings panel (new rail item)

**Files:**
- Create: `pdf-editor/src/headings.ts`
- Create: `pdf-editor/test/make-headings-sample.mjs`
- Modify: `pdf-editor/src/index.tsx` (`RailId`, rail order, panel)

- [ ] **Step 1: `headings.ts`**

```ts
// PDF-EMBEDPDF PoC — document outline (Headings).
const toP = (t:any):Promise<any> => !t?Promise.resolve(t):t.toPromise?t.toPromise():t.wait?new Promise((a,b)=>t.wait(a,b)):t;
export interface HeadingItem { title: string; depth: number; node: any; }
export async function loadHeadings(engine:any, doc:any): Promise<HeadingItem[]> {
  const res = await toP(engine.getBookmarks(doc));
  const out: HeadingItem[] = [];
  const walk = (nodes:any[], depth:number) => {
    for (const n of (nodes||[])) { out.push({ title: n.title ?? '(untitled)', depth, node: n });
      if (n.children?.length) walk(n.children, depth+1); }
  };
  walk(res?.bookmarks ?? [], 0);
  return out;
}
```

- [ ] **Step 2: `make-headings-sample.mjs`** — emit `test/headings-sample.pdf` with an `/Outlines` tree (2-3 bookmarks to page 1). (Hand-build the outline dict like `make-sample.mjs` builds objects.)

- [ ] **Step 3: Add `'headings'` to `RailId`, a rail icon (`IC.railNav`/headings glyph), and a `HeadingsPanel`**

Rail order per reference: Search, Comments, Headings, Thumbnails. `HeadingsPanel` calls `loadHeadings`; renders rows indented by `depth`; click → `scrollApi.scrollToPage` of the bookmark's target page (resolve target from `node` — log the node shape during B2 to map the dest field). Empty state EXACT copy: **"There are no headings in the document."**

- [ ] **Step 4: Build + typecheck** → clean.

- [ ] **Step 5: Playwright assertions**

(a) On `sample.pdf` (no outline): open Headings → `data-testid="pdf-headings-empty"` shows "There are no headings in the document." (b) Swap harness to `headings-sample.pdf`: open Headings → rows render with titles; click a row → current page changes.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/headings.ts pdf-editor/src/index.tsx pdf-editor/test/make-headings-sample.mjs
git commit -m "PDF-EMBEDPDF PoC: Headings panel (getBookmarks tree + navigate + empty state)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task B3: Comments restyle (author avatar)

**Files:**
- Create: `pdf-editor/src/comments-model.ts`
- Modify: `pdf-editor/src/index.tsx` (`CommentsPanel`)

- [ ] **Step 1: `comments-model.ts` — `avatarFor` + thread/sort/filter scaffolding**

```ts
// PDF-EMBEDPDF PoC — comment data shaping.
export function avatarFor(author?: string){ const a=(author||'?').trim();
  const initial=(a[0]||'?').toUpperCase();
  let h=0; for(let i=0;i<a.length;i++) h=(h*31+a.charCodeAt(i))>>>0;
  const hue=h%360; return { initial, bg:`hsl(${hue} 65% 45%)` }; }
export type CommentSort='newest'|'oldest'|'az'|'za';
export type CommentFilter='all'|'resolved'|'open';
export function sortComments(items:any[], s:CommentSort){ const c=[...items];
  if(s==='newest') return c.sort((a,b)=>(+new Date(b.created||0))-(+new Date(a.created||0)));
  if(s==='oldest') return c.sort((a,b)=>(+new Date(a.created||0))-(+new Date(b.created||0)));
  if(s==='az') return c.sort((a,b)=>String(a.author||'').localeCompare(String(b.author||'')));
  return c.sort((a,b)=>String(b.author||'').localeCompare(String(a.author||''))); }
```
(`isResolved`/`setResolved` added in B4 from the B0a decision; `buildThreads` groups by `inReplyToId`.)

- [ ] **Step 2: Restyle `CommentsPanel` rows** — avatar circle (`avatarFor`), bold author, meta (page · relative time), body. Add CSS (`${CX}-comment-avatar`, etc.) — apply the multi-line button reset (`height:auto !important;white-space:normal !important`) per the 2026-06-02 lesson.

- [ ] **Step 3: Build + typecheck** → clean.

- [ ] **Step 4: Playwright + screenshot** — create an annotation (via plugin), open Comments; assert avatar initial + author render; screenshot light+dark WITH the injected Obsidian `button{height:30px}` constraint; confirm no overlap, avatar visible.

- [ ] **Step 5: Commit**

```bash
git add pdf-editor/src/comments-model.ts pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: comments restyle (author avatar + meta)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task B4: Comment actions — edit / delete / resolve / reply

**Files:**
- Modify: `pdf-editor/src/comments-model.ts` (`isResolved`/`setResolved`/`buildThreads`), `pdf-editor/src/index.tsx` (`CommentsPanel`)

- [ ] **Step 1: `isResolved`/`setResolved`** per B0a decision (state-reply OR `custom.resolved`).

- [ ] **Step 2: Row actions** — edit (pencil → inline `<textarea>` → `annotationApi.updateAnnotation(pageIndex,id,{contents})`), delete (trash → confirm → `annotationApi.deleteAnnotation(pageIndex,id)`), resolve (check → `setResolved`), each with `data-testid` (`pdf-comment-edit/delete/resolve-<id>`). Resolved rows get a muted style.

- [ ] **Step 3: Reply** — "Add reply" → inline input → `annotationApi.createAnnotation(pageIndex, {type:1 Text, inReplyToId:parentId, replyType: <R value>, contents, ...})`; `buildThreads` renders replies indented under parents.

- [ ] **Step 4: Build + typecheck** → clean.

- [ ] **Step 5: Playwright assertions** — create a comment; edit its text (assert updated); reply (assert child appears indented); resolve (assert muted + filterable); delete (assert removed). Each via `data-testid`.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/comments-model.ts pdf-editor/src/index.tsx
git commit -m "PDF-EMBEDPDF PoC: comment actions (edit/delete/resolve/reply threads)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task B5: Comment panel header — Add Comment + sort/filter popover

**Files:**
- Modify: `pdf-editor/src/index.tsx` (`LeftRailAndPanel` comments header), `comments-model.ts` (`filterComments`)

- [ ] **Step 1: "Add Comment" button** (chat-plus glyph) in the comments panel header → creates a Text annotation at the current page top-left (spec §6.3 option a), immediately selected + in edit mode.

- [ ] **Step 2: Sort/filter (`…`) popover** — items: Newest (default) / Oldest / Author A→Z / Author Z→A (drive `sortComments`); "Show comments" submenu: All / Resolved / Open (drive `filterComments(items, isResolved, filter)`). State in `CommentsPanel`.

- [ ] **Step 3: `filterComments`** in `comments-model.ts`.

- [ ] **Step 4: Build + typecheck** → clean.

- [ ] **Step 5: Playwright + screenshot** — Add Comment → new comment row appears; open `…` → choose Oldest → assert order flips; Show comments → Resolved → assert only resolved shown. Screenshot popover light+dark.

- [ ] **Step 6: Commit**

```bash
git add pdf-editor/src/index.tsx pdf-editor/src/comments-model.ts
git commit -m "PDF-EMBEDPDF PoC: comments header (Add Comment + sort/filter popover)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task B6: Deploy + iPad smoke + results

**Files:** `pdf-editor/POC-RESULTS.md`.

- [ ] **Step 1: Deploy** `dist/pdf-editor.js`(+map) to OB_Testing.
- [ ] **Step 2: Desktop smoke** — all four rail features in real Obsidian (thumbnails resize+highlight, headings on a Word-export PDF, comment actions, header filter). Record.
- [ ] **Step 3: iPad smoke** — touch reachability of rail icons, popovers, and per-comment actions (NOT hover-only, spec §8). Record.
- [ ] **Step 4: Commit results.**

---

## Self-Review

**Spec coverage — Edit Text spec:** activation/enable button (A2), line/run selection (A1 `lineRuns`/`runAtPoint` + A2 pick), true run-slice redaction (A1 `applyTextEdit` → `redactTextInRects`), flatten-to-page (A1 `flattenAnnotation`), edit surface pre-filled+font-matched (A3), save+confirm+autosave-suppress (A4), re-editability (A5), fonts best-effort Helvetica (A1), non-goals respected (one line/run, no reflow). ✓

**Spec coverage — rail-enhancements spec:** thumbnails settings popover size+highlight (B1), Headings panel+navigate+empty-state (B2), comments avatar restyle (B3), edit/delete/resolve/reply (B4), Add Comment + sort/filter (B5), the 3 open decisions resolved as probes (B0a resolved-persistence, B0b thumbnail-resize, B5 Add-Comment-anchor uses §6.3 option a), touch affordances (B6 Step 3). ✓

**Placeholder scan:** No "TBD"/"add error handling" — concrete code or concrete probe steps throughout. The two genuine unknowns (resolved-persistence, thumbnail-resize) are explicit PROBE tasks (B0a/B0b) that produce a recorded decision before dependent code, not hidden TODOs (same pattern as the passed Edit Text gate).

**Type consistency:** `getRuns`/`runAtPoint`/`lineRuns`/`unionRect`/`applyTextEdit` (A1) used verbatim in A2/A3/A4. `ActiveEdit` shape consistent A2→A4. `avatarFor`/`sortComments`/`filterComments`/`isResolved`/`setResolved`/`buildThreads` (comments-model) referenced consistently B3→B5. `loadHeadings`/`HeadingItem` (headings.ts) consistent in B2. EmbedPDF calls use the gate-verified signatures (`redactTextInRects(doc,page,rects,opts)`, `createPageAnnotation(doc,page,annot)`, `flattenAnnotation(doc,page,annot)`, `getBookmarks(doc)`, `getPageTextRuns(doc,page)`, `openDocumentBuffer({id,content})`).

**Known caveat (recorded, not a gap):** exact EmbedPDF annotation-plugin method names for `updateAnnotation`/`deleteAnnotation`/`createAnnotation` were observed in the live API in the 2026-06-02 left-rail session (the `apiKeys` dump) — B4 uses those; the bookmark `node` target/dest field shape is logged in B2 Step 3 before being used for navigation (one live-shape lookup, not a placeholder).
