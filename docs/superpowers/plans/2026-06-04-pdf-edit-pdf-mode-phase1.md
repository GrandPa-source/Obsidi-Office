# Edit PDF Mode — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OnlyOffice-style "Edit PDF" mode: a master toggle that enables a content-editing ribbon group; an "Edit Text" sub-mode that dashes every text line; clicking a line converts it to a native EmbedPDF FreeText box the user can move/resize/rotate/edit; an "Insert Text" entry point that drops a new box.

**Architecture:** Lean on EmbedPDF's annotation editor (`AnnotationLayer`/`AnnotationContainer`) for selection, move (`startDrag`/`updateDrag`/`commitDrag`), resize, rotate, and double-click in-place edit — no app pointer code. Existing baked text isn't mutable, so a clicked line is made editable by `redactTextInRects(line.rect)` + `createAnnotation(FreeText{matched font})` + `selectAnnotation(id)`. Reuses the v2 font-matching (`mapStandardFont`, `hexColor`). Replaces the custom `TextEditBox` + flatten-on-commit path.

**Tech Stack:** Preact + esbuild → `pdf-editor/dist/pdf-editor.js` (IIFE `ObsidiPdfEditor`); `@embedpdf/*` v2.14.3 on PDFium-WASM; node-CJS micro-tests via esbuild for pure helpers; Playwright standalone harness (`test/standalone.html` + `test/server.mjs`) with **real** clicks/drags for integration; real-Obsidian desktop smoke as the final gate.

**Spec:** `docs/superpowers/specs/2026-06-04-pdf-edit-pdf-mode-phase1-design.md`

**Source of truth for EmbedPDF API shapes** (confirm exact fields/enums against these while implementing):
- `pdf-editor/node_modules/@embedpdf/models/dist/pdf.d.ts` — `PdfFreeTextAnnoObject`, `PdfAnnotationSubtype`, `PdfStandardFont`, `Rect`.
- `pdf-editor/node_modules/@embedpdf/plugin-annotation/dist/lib/types.d.ts` — `AnnotationCapability` (`createAnnotation`, `selectAnnotation`, `setActiveTool`, `updateAnnotation`, `getSelectedAnnotation`).
- `pdf-editor/node_modules/@embedpdf/plugin-annotation/dist/lib/tools/default-tools.d.ts` — `freeText` tool config / `interaction.isRotatable`.

---

## File Structure

- **Modify** `pdf-editor/src/index.tsx`:
  - Inline CSS block (~line 432): dashed outline.
  - `EditorBody` state + Home ribbon (~1052-1106): `editPdfOn` master state, rename button, gated content group.
  - Annotation plugin registration (~1546): `freeText` `isRotatable` override.
  - Outline click handler + `TextEditBox` mount (~1418-1453): replace with `convertLineToFreeText` + remove the box mount.
  - Dormant cleanup: `TextEditBox`, `activeEdit`, `applyEditNow`, `onPickLine`, `_editApplyChain`, `pendingEdits`/`_applyPendingEdits` (keep `linesByPage`, `scanVersion`).
- **Modify** `pdf-editor/src/edit-text.ts`: add `buildFreeTextFromLine(line, subtypeFreeText)` pure helper. Keep `partitionLines`, `mapStandardFont`, `hexColor`, `getRuns`, `redact` usage. `applyTextEdit` retained but unused (deferred Finalize).
- **No new files.**

---

### Task 1: Confirm EmbedPDF FreeText shapes (spike, no code)

**Files:**
- Read only: the three `.d.ts` listed above.

- [ ] **Step 1: Record the exact shapes** into a scratch note (not committed):
  - `PdfAnnotationSubtype.FREETEXT` numeric value.
  - `PdfFreeTextAnnoObject` required fields and their names (esp. `contents` vs `content`, `fontFamily` type = `PdfStandardFont` numeric enum, `fontColor` format `#rrggbb`, `rect` shape `{origin:{x,y},size:{width,height}}` vs `[l,b,r,t]`, `textAlign`, `pageIndex`, `id` — and whether `createAnnotation` auto-assigns `id`).
  - `createAnnotation(pageIndex, annotation, context?)` exact signature; whether it returns the id or void; whether a `context` (e.g. for FreeText initial appearance) is required.
  - `selectAnnotation(pageIndex, id)` and `getSelectedAnnotation()` shapes.
  - `freeText` tool config path for `interaction.isRotatable`, and the shape the plugin registration config expects for per-tool overrides.

- [ ] **Step 2: No commit** — this is a read spike; findings feed Tasks 3-5. If any shape differs from the spec's assumptions, note it and adjust the relevant task's code before writing it.

---

### Task 2: Dashed outline restyle

**Files:**
- Modify: `pdf-editor/src/index.tsx` (CSS block ~432-434)

- [ ] **Step 1: Change the outline border to dashed**

Replace:
```
.${CX}-line-outline{box-sizing:border-box;border:1px solid rgba(120,150,220,0.35);border-radius:2px;cursor:text;background:transparent;}
```
with:
```
.${CX}-line-outline{box-sizing:border-box;border:1px dashed rgba(120,150,220,0.55);border-radius:2px;cursor:text;background:transparent;}
```

- [ ] **Step 2: Build**

Run: `npm run build` in `pdf-editor/`
Expected: `build complete -> dist/pdf-editor.js`, no errors.

- [ ] **Step 3: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: dashed text-line outline"
```

---

### Task 3: Enable rotation for the freeText tool

**Files:**
- Modify: `pdf-editor/src/index.tsx` (~1546)

- [ ] **Step 1: Add the tool override to the annotation plugin registration**

Using the exact config shape confirmed in Task 1, change:
```ts
createPluginRegistration(AnnotationPluginPackage, { annotationAuthor: author }),
```
to pass a `freeText` override enabling rotation, e.g.:
```ts
createPluginRegistration(AnnotationPluginPackage, {
  annotationAuthor: author,
  tools: [{ id: 'freeText', interaction: { isRotatable: true } }],
}),
```
(Adjust the key/path if Task 1 showed a different override shape — e.g. `toolDefaults` or a merge function.)

- [ ] **Step 2: Build**

Run: `npm run build` in `pdf-editor/`
Expected: clean build.

- [ ] **Step 3: Verify in the harness**

Run the standalone harness (`node test/server.mjs`, open `test/standalone.html`). In the page console:
```js
ObsidiPdfEditor.getRegistry().getPlugin('annotation').provides().getTool('freeText').interaction.isRotatable
```
Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: enable rotation handle for FreeText tool"
```

---

### Task 4: `buildFreeTextFromLine` pure helper

**Files:**
- Modify: `pdf-editor/src/edit-text.ts`
- Test: node-CJS micro-test (temp, not committed), mirroring the established pattern.

- [ ] **Step 1: Write the failing test** (`C:/Users/paulc/AppData/Local/Temp/test-buildft.cjs`)

```js
// Compile first: npx esbuild src/edit-text.ts --bundle --format=cjs --platform=node \
//   --outfile="C:/Users/paulc/AppData/Local/Temp/edit-text.cjs"
const et = require('C:/Users/paulc/AppData/Local/Temp/edit-text.cjs');
let fails = 0;
const eq = (l, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); if (!ok) fails++; console.log(`${ok?'ok ':'FAIL'} ${l}: ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); };

const line = {
  rect: { origin: { x: 50, y: 100 }, size: { width: 120, height: 16 } },
  text: 'Hello World', fontSize: 12, pdfFont: 5, cssFont: 'Helvetica, Arial, sans-serif',
  weight: 'bold', color: '#1a2b3c', maxRight: Infinity, runs: [],
};
const FREETEXT = 3; // confirm value from Task 1
const a = et.buildFreeTextFromLine(line, FREETEXT, 0);
eq('subtype', a.type, FREETEXT);
eq('pageIndex', a.pageIndex, 0);
eq('contents', a.contents, 'Hello World');
eq('rect', a.rect, { origin: { x: 50, y: 100 }, size: { width: 120, height: 16 } });
eq('fontFamily=pdfFont', a.fontFamily, 5);
eq('fontSize', a.fontSize, 12);
eq('fontColor', a.fontColor, '#1a2b3c');
eq('textAlign left', a.textAlign, 0);
console.log('\n' + (fails === 0 ? 'PASS' : fails + ' FAIL'));
```

Run (after compiling): `node "C:/Users/paulc/AppData/Local/Temp/test-buildft.cjs"`
Expected: FAIL — `buildFreeTextFromLine is not a function`.

- [ ] **Step 2: Implement `buildFreeTextFromLine`** in `edit-text.ts` (append near `applyTextEdit`)

```ts
/** Build the FreeText annotation params for an editable box from a partitioned
 *  Line. Field names/enum values must match PdfFreeTextAnnoObject (see Task 1).
 *  Note: fontFamily uses the SAME PdfStandardFont enum as pdfFont, so the bold
 *  variant (e.g. Helvetica-Bold = 5) already encodes weight — no separate flag. */
export function buildFreeTextFromLine(line: Line, freeTextSubtype: number, pageIndex: number): any {
  return {
    type: freeTextSubtype,
    pageIndex,
    contents: line.text,
    rect: line.rect,
    fontFamily: line.pdfFont,
    fontSize: Math.max(4, Math.round(line.fontSize || 12)),
    fontColor: line.color || '#000000',
    textAlign: 0,        // left
    verticalAlign: 0,    // top
    opacity: 1,
  };
}
```

- [ ] **Step 3: Recompile + run test**

```bash
cd pdf-editor && npx esbuild src/edit-text.ts --bundle --format=cjs --platform=node --outfile="C:/Users/paulc/AppData/Local/Temp/edit-text.cjs"
node "C:/Users/paulc/AppData/Local/Temp/test-buildft.cjs"
```
Expected: `PASS`. (If Task 1 showed `contents`→`content` or a different `rect` shape, update both the impl and test to the real shape; the test must mirror `PdfFreeTextAnnoObject`.)

- [ ] **Step 4: Clean temp + build the bundle**

```bash
rm -f "C:/Users/paulc/AppData/Local/Temp/edit-text.cjs" "C:/Users/paulc/AppData/Local/Temp/test-buildft.cjs"
cd pdf-editor && npm run build
```
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add pdf-editor/src/edit-text.ts
git commit -m "Edit PDF P1: buildFreeTextFromLine helper (+unit test)"
```

---

### Task 5: `editPdfOn` master state + ribbon restructure

**Files:**
- Modify: `pdf-editor/src/index.tsx` (state near `editTextOn`; Home ribbon ~1076-1095)

- [ ] **Step 1: Add the master state** near the existing `editTextOn` declaration

```ts
const [editPdfOn, setEditPdfOn] = useState(false);
```

- [ ] **Step 2: Rename the Home "Edit Text" button to "Edit PDF" + gate a content group**

Replace the Group at `index.tsx:1076-1087` with:
```tsx
{/* 2. Edit PDF — master toggle; gates the content-editing group */}
<Group testid="pdf-group-editpdf">
  <BigBtn icon={IC.editText} caption="Edit PDF" title="Edit PDF content"
    active={editPdfOn}
    onClick={() => {
      const next = !editPdfOn;
      setEditPdfOn(next);
      if (!next) { setEditTextOn(false); annotationApi?.setActiveTool(null); }
    }}
    testid="pdf-edit-pdf" />
</Group>
{editPdfOn ? (
  <Group testid="pdf-group-content">
    <BigBtn icon={IC.editText} caption="Edit Text" title="Outline & edit text lines"
      active={editTextOn}
      onClick={() => {
        const next = !editTextOn;
        setEditTextOn(next);
        annotationApi?.setActiveTool(null);
        if (next) { try { imApi?.activateDefaultMode?.(); } catch (_) {} }
      }}
      testid="pdf-edit-text" />
    <BigBtn icon={IC.text} caption="Insert Text" title="Insert a new text box"
      active={activeTool === 'freeText'}
      onClick={() => tool('freeText')}
      testid="pdf-insert-text" />
  </Group>
) : null}
```
(Keep `IC.editText`/`IC.text` icons already imported. `tool('freeText')` already toggles the freeText create tool.)

- [ ] **Step 3: Build**

Run: `npm run build` in `pdf-editor/`
Expected: clean build.

- [ ] **Step 4: Harness verification (real clicks)**

In the harness: click `[data-testid="pdf-edit-pdf"]` → assert `[data-testid="pdf-group-content"]` appears; click `[data-testid="pdf-edit-text"]` → assert `[data-testid^="pdf-line-"]` dashed outlines render; click `pdf-edit-pdf` again → assert content group hidden and outlines gone.

- [ ] **Step 5: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: master Edit PDF toggle gating content group (Edit Text + Insert Text)"
```

---

### Task 6: `convertLineToFreeText` + rewire the outline click

**Files:**
- Modify: `pdf-editor/src/index.tsx` (outline click handler ~1427-1433; `TextEditBox` mount ~1438-1453; add `convertLineToFreeText` callback near `applyEditNow`)

- [ ] **Step 1: Add the conversion callback** (near the existing `applyEditNow`, reusing its registry/engine lookups and the `_editApplyChain` serialization)

```ts
// Convert a clicked text line into an editable FreeText annotation: redact the
// original glyphs, create a matched-font FreeText in their place, and select it
// so EmbedPDF shows move/resize/rotate handles + double-click edit.
const FREETEXT_SUBTYPE = 3; // confirm against PdfAnnotationSubtype.FREETEXT (Task 1)
const convertLineToFreeText = useCallback((pageIndex: number, line: any) => {
  _editApplyChain = _editApplyChain.then(async () => {
    const reg = (globalThis as any).ObsidiPdfEditor.getRegistry?.();
    const engine = reg?.getEngine();
    const doc = reg?.getPlugin('document-manager')?.provides()?.getActiveDocument();
    const page = doc?.pages?.[pageIndex];
    if (!engine || !doc || !page || !annotationApi) return;
    // 1) Redact the original line glyphs (no black box).
    await (engine as any).redactTextInRects(doc, page, [line.rect], { drawBlackBoxes: false })
      ?.toPromise?.();
    // 2) Create the FreeText with the line's matched font/size/colour.
    const annot = editText.buildFreeTextFromLine(line, FREETEXT_SUBTYPE, pageIndex);
    const id = annotationApi.createAnnotation(pageIndex, annot); // returns id or void (Task 1)
    // 3) Refresh the page render + select the new box for immediate editing.
    try { reg.getStore?.()?.dispatch(refreshPages(doc.id, [pageIndex])); } catch (_) {}
    const selId = (id as any) || (annot as any).id;
    if (selId) { try { annotationApi.selectAnnotation(pageIndex, selId); } catch (_) {} }
    setScanVersion((v) => v + 1);
  }).catch((e) => console.warn('[pdf-editor] convertLineToFreeText failed', e));
}, [annotationApi]);
```
(If Task 1 shows `createAnnotation` needs a `context` arg or returns void with a pre-set `annot.id`, adjust the id handling accordingly.)

- [ ] **Step 2: Rewire the outline click** — replace the `onClick` body at `index.tsx:1427-1433` with:

```tsx
onClick={(e) => {
  e.stopPropagation();
  annotationApi?.setActiveTool(null);          // ensure select mode for move/resize
  convertLineToFreeText(pageIndex, ln);
}}
```

- [ ] **Step 3: Remove the `TextEditBox` mount** at `index.tsx:1438-1453` (the `{activeEdit && ... <TextEditBox .../>}` block). Leave the outline `.map(...)` intact.

- [ ] **Step 4: Build** (expect unused-symbol errors for `activeEdit`/`TextEditBox`/`applyEditNow` — fixed in Task 7)

Run: `npm run build` in `pdf-editor/`
If the build fails only on now-unused symbols, proceed to Task 7 before the harness check; otherwise fix real errors here.

- [ ] **Step 5: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: click line -> redact + create FreeText + select (replaces TextEditBox)"
```

---

### Task 7: Remove dormant TextEditBox/activeEdit machinery

**Files:**
- Modify: `pdf-editor/src/index.tsx`

- [ ] **Step 1: Delete now-unused code** (keep `linesByPage`, `scanVersion`, `_editApplyChain`, `convertLineToFreeText`):
  - `TextEditBox` component (~571-610).
  - `activeEdit` state + `ActiveEdit` type (~1196-1198, 1213).
  - `applyEditNow` (~1297-1310) and `onPickLine` (~1261-1292) if no longer referenced.
  - `pendingEdits`/`pendingRef`/`_applyPendingEdits`/`confirm*` dormant machinery if unreferenced (verify with grep before deleting).
  - Any `__editapi` test hooks that reference removed symbols — update or drop.

- [ ] **Step 2: Build clean**

Run: `npm run build` in `pdf-editor/`
Expected: clean build, no unused-symbol errors.

- [ ] **Step 3: Grep for dangling references**

Run: `grep -n "activeEdit\|TextEditBox\|applyEditNow\|onPickLine\|_applyPendingEdits" pdf-editor/src/index.tsx`
Expected: no matches (or only intended ones).

- [ ] **Step 4: Commit**

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: remove dormant TextEditBox/activeEdit/pendingEdits machinery"
```

---

### Task 8: Integration — convert, move, resize, rotate, edit (harness, real input)

**Files:**
- Test: drive the standalone harness (`test/standalone.html` + `test/server.mjs`) via Playwright MCP with REAL clicks/drags.

- [ ] **Step 1: Load** the harness on the demo PDF; toggle `pdf-edit-pdf` then `pdf-edit-text`; assert dashed outlines (`[data-testid^="pdf-line-"]`).

- [ ] **Step 2: Convert** — real-click the first outline. Assert via engine:
```js
const reg = ObsidiPdfEditor.getRegistry();
const doc = reg.getPlugin('document-manager').provides().getActiveDocument();
// a FreeText annotation now exists on page 0 near the clicked rect, and is selected:
reg.getPlugin('annotation').provides().getSelectedAnnotation();
```
Expected: a selected FreeText whose `contents` == the line text and `fontFamily`/`fontSize` match the mapping.

- [ ] **Step 3: Move** — capture the selected annotation's `rect.origin`, real-drag the box body by (+40,+20) px, release. Assert `rect.origin` changed by the page-space equivalent.

- [ ] **Step 4: Resize** — real-drag a corner handle; assert `rect.size` changed.

- [ ] **Step 5: Rotate** — real-drag the rotation handle; assert `rotation` != 0.

- [ ] **Step 6: Edit text** — double-click the box, select-all, type replacement, blur; assert `contents` updated.

- [ ] **Step 7: Insert Text** — click `pdf-insert-text`, click empty page space, type; assert a new FreeText was created and is editable.

- [ ] **Step 8:** No code change expected; if any step fails, fix the responsible Task (5/6) and re-run. Commit any fixes with a descriptive message.

---

### Task 9: Save / persistence verification

**Files:**
- Possibly modify: `pdf-editor/src/index.tsx` save path (`saveViaRegistry`/`onSaveClick`) only if edits aren't baked.

- [ ] **Step 1:** In the harness, after Task 8's edits, trigger Save (Ctrl+S / `pdf-save`). Capture the saved `ArrayBuffer`.

- [ ] **Step 2:** Reopen the saved buffer (`openDocumentBuffer`). Assert the FreeText edits persist (annotation present with the edited `contents`, position, rotation).

- [ ] **Step 3:** If edits are missing, add an `annotationApi.commit()` (or engine commit) before `saveAsCopy` in the save path. Re-test until persistence holds.

- [ ] **Step 4: Commit** (only if the save path changed)

```bash
git add pdf-editor/src/index.tsx
git commit -m "Edit PDF P1: ensure FreeText edits are committed before saveAsCopy"
```

---

### Task 10: Deploy + real-Obsidian desktop smoke (REQUIRED gate)

**Files:**
- Deploy artifact only.

- [ ] **Step 1: Build + deploy**

```bash
cd pdf-editor && npm run build
# copy dist/pdf-editor.js -> C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\pdf-editor\dist\pdf-editor.js
```
Verify byte-match.

- [ ] **Step 2: Real-Obsidian smoke** (no hook-only sign-off — the Phase-A lesson). In Obsidian on the demo PDF: Edit PDF → Edit Text → dashed lines; click a line → box appears with handles, matched font; drag to move; resize; rotate; double-click + edit; Insert Text → new box; Save; reload note → edits persist. Record pass/fail per step.

- [ ] **Step 3:** If all pass, update the spec/project file status to "Phase 1 shipped to OB_Testing"; note any deltas. If any fail, file the issue and return to the responsible Task.

---

## Self-Review

- **Spec coverage:** master toggle (T5), dashed outlines (T2), click→FreeText conversion w/ matched font (T4,T6), move/resize/rotate/edit (T3,T8 — engine-native), Insert Text (T5,T8), persistence (T9), real-Obsidian gate (T10). Granularity = per-line via `partitionLines` Line (T4/T6). Deferred Finalize/Flatten explicitly out of scope. ✓
- **Placeholders:** none — every code step shows concrete code; Task 1 is an explicit shape-confirmation spike that the code steps depend on (not a vague "add fields"). ✓
- **Type consistency:** `buildFreeTextFromLine(line, freeTextSubtype, pageIndex)` signature is identical in T4 impl, T4 test, and T6 call. `Line` fields (`rect/text/fontSize/pdfFont/color`) match `edit-text.ts`. `convertLineToFreeText(pageIndex, line)` consistent T6 def/call. ✓
- **Known runtime risk:** exact `PdfFreeTextAnnoObject` field names / `createAnnotation` return are confirmed in Task 1 before the dependent code is written — adjust T4/T6 to the real shapes if they differ.
