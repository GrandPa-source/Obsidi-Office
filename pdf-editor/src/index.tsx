/**
 * Obsidi-Office PDF editor bundle (Task 3 PoC).
 *
 * Exposes a small global API (`ObsidiPdfEditor`) that the hand-written plugin
 * main.js can call to mount EmbedPDF's prebuilt Preact viewer + annotation UI
 * into an arbitrary container, edit a PDF in-browser, and save the modified
 * bytes back via a host-supplied callback.
 *
 * Engine: createPdfiumEngine(wasmUrl) runs PDFium directly in the main thread
 * (no Web Worker -> no SharedArrayBuffer requirement -> works in Obsidian's
 * Electron renderer AND Capacitor WKWebView on iPad). The browser image
 * converter is wired internally by createPdfiumEngine.
 *
 * Save: we hold the EmbedPDF PluginRegistry (captured via onInitialized),
 * pull the live active document from the document-manager plugin, and call
 * engine.saveAsCopy(doc) -> ArrayBuffer -> opts.onSave(Uint8Array).
 */
import { render } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';

import { createPluginRegistration } from '@embedpdf/core';
import type { PluginRegistry } from '@embedpdf/core';
import { EmbedPDF } from '@embedpdf/core/preact';
import { createPdfiumEngine } from '@embedpdf/engines/pdfium-direct-engine';
import type { PdfEngine } from '@embedpdf/engines';

import {
  ViewportPluginPackage,
  Viewport,
} from '@embedpdf/plugin-viewport/preact';
import {
  ScrollPluginPackage,
  Scroller,
} from '@embedpdf/plugin-scroll/preact';
import type { RenderPageProps } from '@embedpdf/plugin-scroll/preact';
import {
  DocumentManagerPluginPackage,
  DocumentContent,
} from '@embedpdf/plugin-document-manager/preact';
import {
  RenderLayer,
  RenderPluginPackage,
} from '@embedpdf/plugin-render/preact';
import { ZoomPluginPackage, useZoom } from '@embedpdf/plugin-zoom/preact';
import { ZoomMode } from '@embedpdf/plugin-zoom';
import { useScroll } from '@embedpdf/plugin-scroll/preact';
import { useHistoryCapability } from '@embedpdf/plugin-history/preact';
import { useInteractionManager } from '@embedpdf/plugin-interaction-manager/preact';
import { InteractionManagerPluginPackage, PagePointerProvider } from '@embedpdf/plugin-interaction-manager/preact';
import { SelectionPluginPackage, SelectionLayer } from '@embedpdf/plugin-selection/preact';
import { HistoryPluginPackage } from '@embedpdf/plugin-history/preact';
import {
  AnnotationPluginPackage,
  AnnotationLayer,
  useAnnotation,
} from '@embedpdf/plugin-annotation/preact';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MountOpts {
  pdfiumWasmUrl: string;
  onSave: (bytes: Uint8Array) => Promise<void>;
  /** Author name stamped on created annotations. */
  author?: string;
  /**
   * PDF-EMBEDPDF PoC — URLs of OnlyOffice's symbol-based icon sprite SVGs
   * (small/big/huge). The bundle fetches each sprite's text and injects it once
   * into a hidden div so the chrome's `<use href="#btn-...">` references resolve
   * in the SAME document as the toolbar (the ItemView DOM, not the iframe).
   */
  spriteUrls?: string[];
  /**
   * Optional close handler for the File menu's "Close" item. The host can wire
   * this to detach the leaf; when absent the Close item is hidden.
   */
  onClose?: () => void;
}

interface ActiveInstance {
  /** Save the current document via the host onSave callback. */
  save: () => Promise<void>;
  /** Tear down Preact + the engine. */
  destroy: () => void;
  /** The captured EmbedPDF registry (null until onInitialized fires). Exposed
   *  for diagnostics/automation (e.g. driving the annotation plugin in tests). */
  getRegistry: () => PluginRegistry | null;
}

// container -> live instance, so savePdfEditor()/unmount can find it.
const INSTANCES = new WeakMap<HTMLElement, ActiveInstance>();
// Most-recently mounted container, so savePdfEditor() can be argument-free.
let lastContainer: HTMLElement | null = null;

// ===========================================================================
// OnlyOffice chrome — faithful replica of the PDF-editor top tab bar + ribbon.
//
// PDF-EMBEDPDF PoC (pass 1). Reuses OnlyOffice's ACTUAL symbol-based icon
// sprites (small/big SVGs) rendered via `<svg class="oo-ic"><use href="#btn-…">`.
// Theme-aware: an OnlyOffice DARK palette when Obsidian is in dark mode, LIGHT
// otherwise. All CSS is scoped under the unique root class `oo-pdfchrome` and a
// single `<style>` is injected once.
//
// Layout: a tab bar [File | Home | Comment | View] with the filename centered,
// and a ribbon below it that changes per selected tab.
// ===========================================================================

const CX = 'oo-pdfchrome'; // scoped root class / prefix

// --- Icon sprite ids actually present in OnlyOffice's pdfeditor sprites. -----
// small (viewBox 20x20) unless noted; pen is the only one we pull from the big
// (28x28) sprite — mixed viewBoxes render fine because each <symbol> carries
// its own viewBox.
// Each entry is [symbolId, viewBoxSize]. Most small-sprite glyphs are 20x20;
// the big-sprite glyphs we use (editText/handBig/selectBig/pen) are 28x28,
// EXCEPT btn-big-hand-tool which (despite living in the big sprite) ships a
// 20x20 viewBox — so we carry the size per-icon rather than per-sprite.
const IC = {
  // clipboard / file cluster (small, 20)
  save: ['btn-save', 20],
  copy: ['btn-copy', 20],
  paste: ['btn-paste', 20],
  cut: ['btn-cut', 20],
  print: ['btn-print', 20],
  undo: ['btn-undo', 20],
  redo: ['btn-redo', 20],
  selectObjects: ['btn-select-tool', 20], // dashed-cursor select-objects glyph
  // large labelled buttons
  editText: ['btn-edit-text', 28], // big sprite
  hand: ['btn-big-hand-tool', 20], // big sprite, but 20x20 viewBox
  select: ['btn-select', 28], // big sprite arrow-cursor
  // page nav (small, 20)
  firstPage: ['btn-firstitem', 20],
  prevPage: ['btn-previtem', 20],
  nextPage: ['btn-nextitem', 20],
  lastPage: ['btn-lastitem', 20],
  // zoom / fit
  zoomOut: ['btn-zoomdown', 20],
  zoomIn: ['btn-zoomup', 20],
  fitPage: ['btn-ic-zoomtopage', 20],
  fitWidth: ['btn-ic-zoomtowidth', 20],
  // comment tools
  text: ['btn-text-comment', 20],
  highlight: ['btn-highlight', 20],
  pen: ['btn-pen-tool', 28], // big sprite (28x28)
  rect: ['btn-annotation-rectangle', 20],
  del: ['btn-cc-remove', 20],
} as const;

type IconSpec = readonly [string, number];

let _stylesInjected = false;
function injectChromeStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  // Palette as CSS custom properties switched by `.theme-dark` on the root.
  // LIGHT ≈ OnlyOffice light chrome; DARK ≈ OnlyOffice dark chrome. Brand accent
  // #204295; active Home-tab red underline ≈ #cc3333.
  const css = `
.${CX}{display:flex;flex-direction:column;width:100%;
  --oo-accent:#204295;--oo-accent-underline:#cc3333;
  --oo-tabbar-bg:#f7f7f7;--oo-tab-text:#444;--oo-tab-active-text:#111;
  --oo-tab-active-bg:#fff;--oo-ribbon-bg:#fff;--oo-ribbon-border:#e0e0e0;
  --oo-icon:#444;--oo-btn-hover:#ececec;--oo-btn-active-bg:#dae3f3;
  --oo-btn-active-icon:#204295;--oo-label:#444;--oo-sep:#dcdcdc;
  --oo-filename:#555;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.${CX}.theme-dark{
  --oo-accent:#3a64b4;--oo-accent-underline:#cc4444;
  --oo-tabbar-bg:#404040;--oo-tab-text:#cfcfcf;--oo-tab-active-text:#f1f1f1;
  --oo-tab-active-bg:#404040;--oo-ribbon-bg:#404040;--oo-ribbon-border:#2b2b2b;
  --oo-icon:#cccccc;--oo-btn-hover:#4f4f4f;--oo-btn-active-bg:#5c5c5c;
  --oo-btn-active-icon:#7aa2e3;--oo-label:#dcdcdc;--oo-sep:#5a5a5a;
  --oo-filename:#bdbdbd;}

/* hidden sprite host */
.${CX}-sprites{position:absolute;width:0;height:0;overflow:hidden;}

/* Obsidian's global <button>/<input> CSS bleeds into our chrome (it gives
   buttons an --interactive-normal background + box-shadow that read as dark,
   bordered boxes). The standalone test harness has no Obsidian CSS, so this
   only appears inside Obsidian. Force-flatten our controls; keep a real border
   only on the zoom dropdown + page-number field (like OnlyOffice). */
.${CX}-btn-small,.${CX}-btn-big,.${CX}-btn-wide,.${CX}-tab,
.${CX}-zoomitem,.${CX}-fileitem,.${CX}-zoombtn{
  background-color:transparent !important;box-shadow:none !important;}
.${CX}-btn-small,.${CX}-btn-big,.${CX}-btn-wide,.${CX}-tab,
.${CX}-zoomitem,.${CX}-fileitem{border:none !important;}
.${CX}-zoombtn{border:1px solid var(--oo-sep) !important;}
.${CX}-pageinp{box-shadow:none !important;}

/* tab bar */
.${CX}-tabbar{display:flex;align-items:stretch;height:32px;
  background:var(--oo-tabbar-bg);position:relative;
  border-bottom:1px solid var(--oo-ribbon-border);}
.${CX}-tab{appearance:none;border:none;background:transparent;cursor:pointer;
  padding:0 14px;font-size:12px;line-height:32px;color:var(--oo-tab-text);
  position:relative;white-space:nowrap;}
.${CX}-tab:hover{color:var(--oo-tab-active-text);}
.${CX}-tab.${CX}-tab-active{color:var(--oo-tab-active-text);font-weight:600;}
.${CX}-tab.${CX}-tab-active::after{content:"";position:absolute;left:0;right:0;
  bottom:0;height:2px;background:var(--oo-accent-underline);}
.${CX}-tab.${CX}-tab-file{color:var(--oo-tab-text);font-weight:600;}
.${CX}-tab.${CX}-tab-file:hover{color:var(--oo-tab-active-text);}
.${CX}-filename{flex:1;text-align:center;align-self:center;font-size:12px;
  color:var(--oo-filename);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;padding:0 12px;pointer-events:none;}

/* ribbon — OnlyOffice proportions: ~68px tall, groups laid out horizontally */
.${CX}-ribbon{display:flex;align-items:stretch;flex-wrap:nowrap;gap:0;
  height:68px;padding:4px 4px;box-sizing:border-box;overflow-x:auto;
  background:var(--oo-ribbon-bg);border-bottom:1px solid var(--oo-ribbon-border);}

/* group — a labelled cluster of controls with a right-hand separator */
.${CX}-group{display:flex;align-items:center;gap:2px;padding:2px 7px;
  position:relative;flex:0 0 auto;}
.${CX}-group::after{content:"";position:absolute;right:0;top:8px;bottom:8px;
  width:1px;background:var(--oo-sep);}
.${CX}-group:last-child::after{display:none;}
/* a 2-row vertical stack inside a group (clipboard cluster, page nav, zoom) */
.${CX}-group-rows{display:flex;flex-direction:column;justify-content:center;
  gap:2px;}
.${CX}-row{display:flex;align-items:center;gap:1px;}

/* small icon-only button (~22px) — clipboard cluster, page nav steppers */
.${CX}-btn-small{display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;border:none;border-radius:3px;
  background:transparent;cursor:pointer;color:var(--oo-icon);flex:0 0 auto;
  transition:background .1s;}
.${CX}-btn-small:hover:not(:disabled):not(.${CX}-btn-active){background:var(--oo-btn-hover) !important;}
.${CX}-btn-small.${CX}-btn-active{background:var(--oo-btn-active-bg) !important;}
.${CX}-btn-small.${CX}-btn-active .oo-ic{color:var(--oo-btn-active-icon);}
.${CX}-btn-small:disabled{opacity:.4;cursor:default;}
.${CX}-btn-small .oo-ic{width:18px;height:18px;}

/* big button (~52px) — icon on top, label below */
.${CX}-btn-big{display:inline-flex;flex-direction:column;align-items:center;
  justify-content:center;gap:1px;min-width:52px;height:54px;padding:3px 6px;
  border:none;border-radius:3px;background:transparent;cursor:pointer;
  color:var(--oo-icon);flex:0 0 auto;transition:background .1s;}
.${CX}-btn-big:hover:not(:disabled):not(.${CX}-btn-active){background:var(--oo-btn-hover) !important;}
.${CX}-btn-big.${CX}-btn-active{background:var(--oo-btn-active-bg) !important;}
.${CX}-btn-big.${CX}-btn-active .oo-ic{color:var(--oo-btn-active-icon);}
.${CX}-btn-big:disabled{opacity:.4;cursor:default;}
.${CX}-btn-big .oo-ic{width:28px;height:28px;}
.${CX}-btn-big .oo-cap{font-size:9px;line-height:1.2;color:var(--oo-label);
  text-align:center;max-width:64px;}

/* wide button (~) — icon + inline label, stacked vertically in a group */
.${CX}-btn-wide{display:inline-flex;align-items:center;justify-content:flex-start;
  gap:6px;min-width:96px;height:24px;padding:2px 8px 2px 6px;
  border:none;border-radius:3px;background:transparent;cursor:pointer;
  color:var(--oo-icon);flex:0 0 auto;transition:background .1s;}
.${CX}-btn-wide:hover:not(:disabled):not(.${CX}-btn-active){background:var(--oo-btn-hover) !important;}
.${CX}-btn-wide.${CX}-btn-active{background:var(--oo-btn-active-bg) !important;}
.${CX}-btn-wide:disabled{opacity:.4;cursor:default;}
.${CX}-btn-wide .oo-ic{width:18px;height:18px;flex:0 0 auto;}
.${CX}-btn-wide .oo-cap{font-size:12px;line-height:1;color:var(--oo-label);
  white-space:nowrap;}

.oo-ic{width:20px;height:20px;display:block;color:inherit;fill:currentColor;}

/* group caption (under a 2-row control, e.g. "Zoom") */
.${CX}-grpcap{font-size:11px;line-height:1;color:var(--oo-label);
  text-align:center;user-select:none;padding-top:1px;}

.${CX}-sep{width:1px;align-self:stretch;margin:4px 6px;
  background:var(--oo-sep);flex:0 0 auto;}
.${CX}-pageinp{width:30px;height:22px;text-align:center;font-size:12px;
  border:1px solid var(--oo-sep);border-radius:3px;background:transparent;
  color:var(--oo-tab-active-text);}
.${CX}-pagebox{display:flex;align-items:center;gap:3px;justify-content:center;}
.${CX}-pagetotal{font-size:12px;color:var(--oo-label);padding:0 2px;
  user-select:none;white-space:nowrap;}

/* zoom dropdown */
.${CX}-zoomdd{position:relative;display:inline-flex;}
.${CX}-zoombtn{display:inline-flex;align-items:center;gap:4px;height:22px;
  padding:0 6px;min-width:62px;justify-content:space-between;
  border:1px solid var(--oo-sep);border-radius:3px;background:transparent;
  cursor:pointer;color:var(--oo-tab-active-text);font-size:12px;}
.${CX}-zoombtn:hover{background:var(--oo-btn-hover) !important;}
.${CX}-zoombtn .oo-caret{font-size:9px;line-height:1;opacity:.7;}
.${CX}-zoommenu{position:absolute;top:24px;left:0;z-index:30;min-width:78px;
  background:var(--oo-ribbon-bg);border:1px solid var(--oo-ribbon-border);
  box-shadow:0 4px 16px rgba(0,0,0,.25);border-radius:3px;
  display:flex;flex-direction:column;padding:3px 0;max-height:220px;
  overflow-y:auto;}
.${CX}-zoomitem{appearance:none;border:none;background:transparent;
  text-align:left;padding:5px 14px;font-size:12px;cursor:pointer;
  color:var(--oo-tab-active-text);}
.${CX}-zoomitem:hover{background:var(--oo-btn-hover) !important;}
.${CX}-zoomitem.${CX}-zoomitem-active{color:var(--oo-btn-active-icon);
  font-weight:600;}

/* File popover */
.${CX}-filemenu{position:absolute;top:32px;left:0;z-index:20;min-width:160px;
  background:var(--oo-ribbon-bg);border:1px solid var(--oo-ribbon-border);
  box-shadow:0 4px 16px rgba(0,0,0,.25);border-radius:0 0 4px 4px;
  display:flex;flex-direction:column;padding:4px 0;}
.${CX}-fileitem{appearance:none;border:none;background:transparent;
  text-align:left;padding:7px 16px;font-size:13px;cursor:pointer;
  color:var(--oo-tab-active-text);display:flex;align-items:center;gap:8px;}
.${CX}-fileitem:hover{background:var(--oo-btn-hover) !important;}
.${CX}-fileitem:disabled{opacity:.4;cursor:default;}
`;
  const el = document.createElement('style');
  el.setAttribute('data-oo-pdfchrome', '');
  el.textContent = css;
  document.head.appendChild(el);
}

// Render an OnlyOffice sprite icon from an [id, viewBoxSize] spec. The host svg
// gets the symbol's own viewBox so 20x20 and 28x28 glyphs both map correctly.
const Ic = ({ spec }: { spec: IconSpec }) => (
  <svg class="oo-ic" viewBox={`0 0 ${spec[1]} ${spec[1]}`} aria-hidden="true">
    <use href={`#${spec[0]}`} />
  </svg>
);

const Sep = () => <span class={`${CX}-sep`} aria-hidden="true" />;

// Small icon-only button (~22px) — clipboard cluster + page-nav steppers.
function SmallBtn({
  icon, title, active, disabled, onClick, testid,
}: {
  icon: IconSpec; title: string;
  active?: boolean; disabled?: boolean; onClick?: () => void; testid?: string;
}) {
  return (
    <button
      type="button"
      class={`${CX}-btn-small${active ? ` ${CX}-btn-active` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? 'true' : undefined}
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
    >
      <Ic spec={icon} />
    </button>
  );
}

// Big button (~52px) — icon on top, label below.
function BigBtn({
  icon, caption, title, active, disabled, onClick, testid,
}: {
  icon: IconSpec; caption: string; title: string;
  active?: boolean; disabled?: boolean; onClick?: () => void; testid?: string;
}) {
  return (
    <button
      type="button"
      class={`${CX}-btn-big${active ? ` ${CX}-btn-active` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? 'true' : undefined}
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
    >
      <Ic spec={icon} />
      <span class="oo-cap">{caption}</span>
    </button>
  );
}

// Wide button — icon + inline label (Fit To Page / Fit To Width stacks).
function WideBtn({
  icon, caption, title, active, disabled, onClick, testid,
}: {
  icon: IconSpec; caption: string; title: string;
  active?: boolean; disabled?: boolean; onClick?: () => void; testid?: string;
}) {
  return (
    <button
      type="button"
      class={`${CX}-btn-wide${active ? ` ${CX}-btn-active` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? 'true' : undefined}
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
    >
      <Ic spec={icon} />
      <span class="oo-cap">{caption}</span>
    </button>
  );
}

// A group: cluster of controls with a right-hand separator.
function Group({ children, testid }: { children: any; testid?: string }) {
  return (
    <div class={`${CX}-group`} data-testid={testid}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Chrome — tab bar + per-tab ribbon, fully wired to EmbedPDF plugin hooks.
// ---------------------------------------------------------------------------

type TabId = 'home' | 'comment' | 'view';

function Chrome({
  documentId,
  save,
  onClose,
}: {
  documentId: string;
  save: () => Promise<void>;
  onClose?: () => void;
}) {
  injectChromeStyles();

  const [tab, setTab] = useState<TabId>('home');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, forceTick] = useState(0); // re-render on history changes

  // Theme: OnlyOffice dark palette when Obsidian is in dark mode. Track the
  // body's `theme-dark` class reactively so toggling the Obsidian theme (or the
  // test harness toggling the class) re-skins the chrome live.
  const readDark = () =>
    typeof document !== 'undefined' &&
    document.body.classList.contains('theme-dark');
  const [isDark, setIsDark] = useState<boolean>(readDark);
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined')
      return;
    const obs = new MutationObserver(() => setIsDark(readDark()));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const { provides: annotationApi, state } = useAnnotation(documentId);
  const { provides: zoomApi, state: zoomState } = useZoom(documentId);
  const { provides: scrollApi, state: scrollState } = useScroll(documentId);
  const { provides: historyApi } = useHistoryCapability();
  const { provides: imApi } = useInteractionManager(documentId);

  const activeTool = state?.activeToolId ?? null;
  const isSelect = activeTool == null;
  const hasSelection =
    (state?.selectedUids && state.selectedUids.length > 0) || state?.selectedUid
      ? true
      : false;

  // History scope for this document (undo/redo + reactivity).
  const histScope = historyApi?.forDocument(documentId) ?? null;
  useEffect(() => {
    if (!histScope?.onHistoryChange) return;
    const off = histScope.onHistoryChange(() => forceTick((n) => n + 1));
    return () => { try { off?.(); } catch (_) { /* noop */ } };
  }, [histScope]);
  const canUndo = !!histScope?.canUndo();
  const canRedo = !!histScope?.canRedo();

  // Tools.
  const tool = (id: string) =>
    annotationApi?.setActiveTool(activeTool === id ? null : id);
  const selectMode = () => annotationApi?.setActiveTool(null);
  const handMode = () => {
    // No dedicated pan plugin is registered; Select/Hand share the default
    // (non-annotation) interaction mode. We disarm any annotation tool and ask
    // the interaction manager for its default mode + a grab cursor so Hand is a
    // meaningful, distinct affordance (drag-to-pan already works via the
    // scroller). If the interaction manager is unavailable this degrades to the
    // same behaviour as Select.
    annotationApi?.setActiveTool(null);
    try {
      imApi?.activateDefaultMode?.();
    } catch (_) { /* noop */ }
  };
  const deleteSelected = () => {
    const sel = annotationApi?.getSelectedAnnotation();
    if (sel) annotationApi?.deleteAnnotation(sel.object.pageIndex, sel.object.id);
  };

  const onSaveClick = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try { await save(); }
    catch (e) { console.error('[pdf-editor] chrome save failed', e); }
    finally { setSaving(false); }
  }, [save, saving]);

  // Zoom %.
  const zoomPct = Math.round((zoomState?.currentZoomLevel ?? 1) * 100);
  const fitPage = () => zoomApi?.requestZoom(ZoomMode.FitPage);
  const fitWidth = () => zoomApi?.requestZoom(ZoomMode.FitWidth);
  // Preset zoom levels for the dropdown (OnlyOffice's standard set).
  const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200];
  const setZoomPct = (pct: number) => {
    zoomApi?.requestZoom(pct / 100);
    setZoomMenuOpen(false);
  };

  // Page nav. scrollState.currentPage / totalPages are 1-based counts.
  const curPage = scrollState?.currentPage ?? 1;
  const totalPages = scrollState?.totalPages ?? 1;
  const goPage = (n: number) => {
    const p = Math.max(1, Math.min(totalPages, n));
    scrollApi?.scrollToPage({ pageNumber: p });
  };

  // --- Reusable group fragments ---

  // Page-nav group: 2-row stack (N / total box on top, first/prev/next/last
  // arrows below).
  const pageNavGroup = (
    <Group testid="pdf-group-pagenav">
      <div class={`${CX}-group-rows`}>
        <div class={`${CX}-row ${CX}-pagebox`}>
          <input class={`${CX}-pageinp`} data-testid="pdf-page-input" type="text"
            value={String(curPage)} aria-label="Current page"
            onChange={(e) => {
              const v = parseInt((e.target as HTMLInputElement).value, 10);
              if (!Number.isNaN(v)) goPage(v);
            }} />
          <span class={`${CX}-pagetotal`} data-testid="pdf-page-total">/ {totalPages}</span>
        </div>
        <div class={`${CX}-row`}>
          <SmallBtn icon={IC.firstPage} title="First page" disabled={curPage <= 1}
            onClick={() => goPage(1)} testid="pdf-first" />
          <SmallBtn icon={IC.prevPage} title="Previous page" disabled={curPage <= 1}
            onClick={() => goPage(curPage - 1)} testid="pdf-prev" />
          <SmallBtn icon={IC.nextPage} title="Next page" disabled={curPage >= totalPages}
            onClick={() => goPage(curPage + 1)} testid="pdf-next" />
          <SmallBtn icon={IC.lastPage} title="Last page" disabled={curPage >= totalPages}
            onClick={() => goPage(totalPages)} testid="pdf-last" />
        </div>
      </div>
    </Group>
  );

  // Zoom group: 2-row stack (100% ▾ dropdown on top, "Zoom" caption below).
  const zoomGroup = (
    <Group testid="pdf-group-zoom">
      <div class={`${CX}-group-rows`}>
        <div class={`${CX}-row`} style={{ justifyContent: 'center' }}>
          <div class={`${CX}-zoomdd`}>
            <button type="button" class={`${CX}-zoombtn`} data-testid="pdf-zoom-dd"
              disabled={!zoomApi}
              aria-haspopup="true" aria-expanded={zoomMenuOpen ? 'true' : 'false'}
              onClick={() => setZoomMenuOpen((o) => !o)}>
              <span data-testid="pdf-zoom-pct">{zoomPct}%</span>
              <span class="oo-caret" aria-hidden="true">▾</span>
            </button>
            {zoomMenuOpen ? (
              <div class={`${CX}-zoommenu`} data-testid="pdf-zoom-menu" role="menu">
                {(ZOOM_PRESETS.includes(zoomPct) ? ZOOM_PRESETS
                  : [...ZOOM_PRESETS, zoomPct].sort((a, b) => a - b)
                ).map((p) => (
                  <button type="button" role="menuitem"
                    class={`${CX}-zoomitem${p === zoomPct ? ` ${CX}-zoomitem-active` : ''}`}
                    data-testid={`pdf-zoom-${p}`}
                    onClick={() => setZoomPct(p)}>
                    {p}%
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div class={`${CX}-grpcap`}>Zoom</div>
      </div>
    </Group>
  );

  // Fit group: 2 stacked wide buttons (icon + inline label).
  const fitGroup = (prefix: string) => (
    <Group testid="pdf-group-fit">
      <div class={`${CX}-group-rows`}>
        <WideBtn icon={IC.fitPage} caption="Fit To Page" title="Fit to page"
          disabled={!zoomApi} onClick={fitPage} testid={`${prefix}fit-page`} />
        <WideBtn icon={IC.fitWidth} caption="Fit To Width" title="Fit to width"
          disabled={!zoomApi} onClick={fitWidth} testid={`${prefix}fit-width`} />
      </div>
    </Group>
  );

  // --- Ribbons ---

  const homeRibbon = (
    <div class={`${CX}-ribbon`} data-testid="pdf-ribbon-home" role="toolbar" aria-label="Home">
      {/* 1. Clipboard / file cluster — 2 rows of small icon buttons */}
      <Group testid="pdf-group-clipboard">
        <div class={`${CX}-group-rows`}>
          <div class={`${CX}-row`}>
            <SmallBtn icon={IC.save} title={saving ? 'Saving…' : 'Save (Ctrl+S)'}
              disabled={saving} onClick={onSaveClick} testid="pdf-save" />
            <SmallBtn icon={IC.copy} title="Copy (coming soon)" disabled testid="pdf-copy" />
            <SmallBtn icon={IC.paste} title="Paste (coming soon)" disabled testid="pdf-paste" />
            <SmallBtn icon={IC.cut} title="Cut (coming soon)" disabled testid="pdf-cut" />
          </div>
          <div class={`${CX}-row`}>
            <SmallBtn icon={IC.print} title="Print (coming soon)" disabled testid="pdf-print" />
            <SmallBtn icon={IC.undo} title="Undo" disabled={!canUndo}
              onClick={() => histScope?.undo()} testid="pdf-undo" />
            <SmallBtn icon={IC.redo} title="Redo" disabled={!canRedo}
              onClick={() => histScope?.redo()} testid="pdf-redo" />
            <SmallBtn icon={IC.selectObjects} title="Select objects (coming soon)"
              disabled testid="pdf-select-objects" />
          </div>
        </div>
      </Group>

      {/* 2. Edit Text — large labelled (disabled) */}
      <Group testid="pdf-group-edittext">
        <BigBtn icon={IC.editText} caption="Edit Text" title="Edit Text (coming soon)"
          disabled testid="pdf-edit-text" />
      </Group>

      {/* 3. Hand + Select — large labelled buttons */}
      <Group testid="pdf-group-tools">
        <BigBtn icon={IC.hand} caption="Hand" title="Hand (pan)"
          onClick={handMode} testid="pdf-hand" />
        <BigBtn icon={IC.select} caption="Select" title="Select"
          active={isSelect} onClick={selectMode} testid="pdf-select" />
      </Group>

      {/* 4. Page nav */}
      {pageNavGroup}

      {/* 5. Zoom dropdown */}
      {zoomGroup}

      {/* 6. Fit */}
      {fitGroup('pdf-')}
    </div>
  );

  const commentRibbon = (
    <div class={`${CX}-ribbon`} data-testid="pdf-ribbon-comment" role="toolbar" aria-label="Comment">
      <Group testid="pdf-group-annotate">
        <BigBtn icon={IC.text} caption="Text" title="Text comment"
          active={activeTool === 'freeText'} onClick={() => tool('freeText')}
          testid="pdf-tool-freeText" />
        <BigBtn icon={IC.highlight} caption="Highlight" title="Highlight"
          active={activeTool === 'highlight'} onClick={() => tool('highlight')}
          testid="pdf-tool-highlight" />
        <BigBtn icon={IC.pen} caption="Pen" title="Pen"
          active={activeTool === 'ink'} onClick={() => tool('ink')}
          testid="pdf-tool-ink" />
        <BigBtn icon={IC.rect} caption="Shape" title="Rectangle"
          active={activeTool === 'square'} onClick={() => tool('square')}
          testid="pdf-tool-square" />
      </Group>
      <Group testid="pdf-group-delete">
        <BigBtn icon={IC.del} caption="Delete" title="Delete selection"
          disabled={!hasSelection} onClick={deleteSelected} testid="pdf-delete" />
      </Group>
    </div>
  );

  const viewRibbon = (
    <div class={`${CX}-ribbon`} data-testid="pdf-ribbon-view" role="toolbar" aria-label="View">
      {zoomGroup}
      {fitGroup('pdf-view-')}
    </div>
  );

  const Tab = ({ id, label }: { id: TabId; label: string }) => (
    <button
      type="button"
      class={`${CX}-tab${tab === id ? ` ${CX}-tab-active` : ''}`}
      data-testid={`pdf-tab-${id}`}
      aria-selected={tab === id ? 'true' : 'false'}
      onClick={() => { setTab(id); setFileMenuOpen(false); setZoomMenuOpen(false); }}
    >
      {label}
    </button>
  );

  return (
    <div class={`${CX}${isDark ? ' theme-dark' : ''}`} data-testid="pdf-chrome">
      <div class={`${CX}-tabbar`} role="tablist">
        <button type="button"
          class={`${CX}-tab ${CX}-tab-file`} data-testid="pdf-tab-file"
          aria-haspopup="true" aria-expanded={fileMenuOpen ? 'true' : 'false'}
          onClick={() => setFileMenuOpen((o) => !o)}>
          File
        </button>
        <Tab id="home" label="Home" />
        <Tab id="comment" label="Comment" />
        <Tab id="view" label="View" />
        <span class={`${CX}-filename`} data-testid="pdf-filename">document.pdf</span>

        {fileMenuOpen ? (
          <div class={`${CX}-filemenu`} data-testid="pdf-file-menu" role="menu">
            <button type="button" class={`${CX}-fileitem`} role="menuitem"
              data-testid="pdf-file-save"
              onClick={() => { setFileMenuOpen(false); onSaveClick(); }}>
              <Ic spec={IC.save} /> Save
            </button>
            <button type="button" class={`${CX}-fileitem`} role="menuitem"
              data-testid="pdf-file-close" disabled={!onClose}
              onClick={() => { setFileMenuOpen(false); onClose?.(); }}>
              <Ic spec={IC.del} /> Close
            </button>
          </div>
        ) : null}
      </div>

      {tab === 'home' ? homeRibbon : tab === 'comment' ? commentRibbon : viewRibbon}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor root component
// ---------------------------------------------------------------------------

function PdfEditorApp({
  engine,
  fileBytes,
  author,
  onRegistry,
  save,
  onClose,
}: {
  engine: PdfEngine;
  fileBytes: Uint8Array;
  author: string;
  onRegistry: (r: PluginRegistry) => Promise<void>;
  /** Save the current document via the host onSave callback (toolbar Save / Ctrl+S). */
  save: () => Promise<void>;
  /** Optional close handler for the File menu. */
  onClose?: () => void;
}) {
  // Build a stable ArrayBuffer copy of the incoming bytes for the document
  // manager (it expects an ArrayBuffer it can own).
  const [plugins] = useState(() => {
    // Copy into a fresh, non-shared ArrayBuffer the document manager can own.
    const ab = new ArrayBuffer(fileBytes.byteLength);
    new Uint8Array(ab).set(fileBytes);
    return [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [
          { buffer: ab, name: 'document.pdf', documentId: 'main', autoActivate: true },
        ],
      }),
      createPluginRegistration(ViewportPluginPackage),
      createPluginRegistration(ScrollPluginPackage),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(ZoomPluginPackage),
      // Annotation stack + its dependencies (order: deps before annotation).
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage),
      createPluginRegistration(HistoryPluginPackage),
      createPluginRegistration(AnnotationPluginPackage, { annotationAuthor: author }),
    ];
  });

  return (
    <div
      data-testid="pdf-editor-root"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}
    >
      <EmbedPDF engine={engine} plugins={plugins} onInitialized={onRegistry}>
        {({ activeDocumentId }) =>
          activeDocumentId ? (
            <DocumentContent documentId={activeDocumentId}>
              {({ isLoaded }) =>
                isLoaded ? (
                  <>
                    <Chrome documentId={activeDocumentId} save={save} onClose={onClose} />
                    <Viewport
                      documentId={activeDocumentId}
                      style={{ flex: 1, backgroundColor: '#f1f3f5', overflow: 'auto' }}
                    >
                      <Scroller
                        documentId={activeDocumentId}
                        renderPage={(page) => {
                          // Scroller's declared param is PageLayout, but at runtime it
                          // also spreads scale/rotation/document (RenderPageProps).
                          const { width, height, pageIndex, scale, rotation } =
                            page as RenderPageProps;
                          return (
                          <PagePointerProvider
                            documentId={activeDocumentId}
                            pageIndex={pageIndex}
                            style={{ width, height, position: 'relative' }}
                          >
                            <RenderLayer documentId={activeDocumentId} pageIndex={pageIndex} scale={scale} />
                            <SelectionLayer documentId={activeDocumentId} pageIndex={pageIndex} scale={scale} />
                            <AnnotationLayer
                              documentId={activeDocumentId}
                              pageIndex={pageIndex}
                              scale={scale}
                              rotation={rotation}
                            />
                          </PagePointerProvider>
                          );
                        }}
                      />
                    </Viewport>
                  </>
                ) : (
                  <div style={{ padding: 16 }}>Loading document…</div>
                )
              }
            </DocumentContent>
          ) : (
            <div style={{ padding: 16 }}>Opening…</div>
          )
        }
      </EmbedPDF>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save helper: pull live doc from registry + saveAsCopy.
// ---------------------------------------------------------------------------

async function saveViaRegistry(
  registry: PluginRegistry,
  onSave: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const engine = registry.getEngine();
  const docManager = registry.getPlugin<any>('document-manager')?.provides();
  const doc = docManager?.getActiveDocument?.();
  if (!engine || !doc) throw new Error('No active document to save.');

  // CRITICAL: flush the annotation plugin's pending changes into the in-memory
  // PDFium document BEFORE saveAsCopy serializes it.
  //
  // The annotation plugin STAGES user-drawn annotations (and edits/deletes) in
  // its own Redux-style state, then writes them into the PDFium doc on a
  // "commit". With autoCommit (the default) that commit fires automatically
  // after the history event — but it returns an un-awaited Task that runs
  // asynchronously. For annotations whose commit involves async appearance-
  // stream generation (ink / freeText / anything that re-renders), a fast
  // Ctrl+S immediately after drawing can call saveAsCopy() before that commit
  // Task has finished, serializing the document WITHOUT the new annotation.
  //
  // Calling commit() here and awaiting it guarantees all staged changes are in
  // the PDFium doc. commit() is idempotent: it early-returns when there are no
  // pending changes (the common case for synchronously-committed shapes), so
  // this is harmless for already-flushed annotations. We deselect first so any
  // in-progress edit (e.g. a FreeText box still in edit mode) is finalized into
  // a pending change before the commit runs.
  const annotationApi = registry.getPlugin<any>('annotation')?.provides();
  if (annotationApi) {
    try {
      annotationApi.deselectAnnotation?.();
      const commitTask = annotationApi.commit?.();
      if (commitTask?.toPromise) await commitTask.toPromise();
    } catch (_) {
      // A commit failure must not silently corrupt the save — but neither
      // should it block saving annotations that DID commit. Surface via console
      // and proceed; saveAsCopy still serializes whatever is in the doc.
      console.warn('[pdf-editor] annotation commit before save failed', _);
    }
  }

  const ab: ArrayBuffer = await engine.saveAsCopy(doc).toPromise();
  const bytes = new Uint8Array(ab);
  await onSave(bytes);
}

// ---------------------------------------------------------------------------
// Sprite injection (PDF-EMBEDPDF PoC).
//
// OnlyOffice's icon sprites are symbol-based SVGs. For `<use href="#btn-…">` in
// our toolbar to resolve, the <symbol> definitions must live in the SAME
// document as the toolbar (the ItemView DOM). We fetch each sprite's text and
// inject it ONCE into a hidden div appended to <body> via innerHTML, so the
// inline same-document symbols resolve by id from anywhere in the document.
//
// We inject into <body> (not the editor container) because Preact's
// render(vnode, container) owns/clears the container's children — a sibling
// inside the container would be clobbered on the first diff. A single
// document-level host is also naturally deduped across re-mounts.
// ---------------------------------------------------------------------------

let _spritesInjected = false;
async function injectSprites(spriteUrls: string[] | undefined): Promise<void> {
  if (_spritesInjected || typeof document === 'undefined') return;
  if (!spriteUrls || spriteUrls.length === 0) return;
  if (document.querySelector(`.${CX}-sprites`)) { _spritesInjected = true; return; }
  let combined = '';
  for (const url of spriteUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn('[pdf-editor] sprite fetch failed', url, res.status);
        continue;
      }
      combined += await res.text();
    } catch (e) {
      console.warn('[pdf-editor] sprite fetch error', url, e);
    }
  }
  if (!combined) return;
  const host = document.createElement('div');
  host.className = `${CX}-sprites`;
  host.setAttribute('aria-hidden', 'true');
  // innerHTML keeps the <symbol> nodes as same-document inline SVG so
  // href="#id" resolves (avoids cross-document <use> href restrictions). The
  // content is OnlyOffice's own static, bundled sprite SVGs fetched from the
  // plugin's app:// resource path — trusted plugin assets, not user input.
  host.innerHTML = combined;
  document.body.appendChild(host);
  _spritesInjected = true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function mountPdfEditor(
  container: HTMLElement,
  fileBytes: Uint8Array,
  opts: MountOpts,
): Promise<void> {
  if (INSTANCES.has(container)) unmountPdfEditor(container);

  // Inject OnlyOffice icon sprites into the document BEFORE rendering so the
  // chrome's <use href="#btn-..."> references resolve.
  await injectSprites(opts.spriteUrls);

  // Create the engine directly (main-thread PDFium, browser image converter).
  const engine = (await createPdfiumEngine(opts.pdfiumWasmUrl)) as unknown as PdfEngine;

  let registry: PluginRegistry | null = null;
  // EmbedPDF's onInitialized is awaited internally, so it must return a Promise.
  const onRegistry = async (r: PluginRegistry): Promise<void> => {
    registry = r;
  };

  // Single save closure shared by the in-toolbar Save button, Ctrl+S, and the
  // public savePdfEditor() API — they must all run the exact same save path
  // (deselect + await commit, then saveAsCopy) via saveViaRegistry.
  const save = async (): Promise<void> => {
    if (!registry) throw new Error('Editor not initialized yet.');
    await saveViaRegistry(registry, opts.onSave);
  };

  // Mount the Preact tree.
  render(
    <PdfEditorApp
      engine={engine}
      fileBytes={fileBytes}
      author={opts.author ?? 'Obsidi-Office'}
      onRegistry={onRegistry}
      save={save}
      onClose={opts.onClose}
    />,
    container,
  );

  const instance: ActiveInstance = {
    save,
    destroy: () => {
      try {
        render(null, container); // unmount Preact tree (triggers EmbedPDF cleanup -> registry.destroy())
      } finally {
        try {
          (engine as any).destroy?.();
        } catch (_) {
          /* noop */
        }
      }
    },
    getRegistry: () => registry,
  };

  INSTANCES.set(container, instance);
  lastContainer = container;
}

async function savePdfEditor(container?: HTMLElement): Promise<void> {
  const target = container ?? lastContainer;
  if (!target) throw new Error('No mounted PDF editor.');
  const inst = INSTANCES.get(target);
  if (!inst) throw new Error('No mounted PDF editor for container.');
  await inst.save();
}

function unmountPdfEditor(container: HTMLElement): void {
  const inst = INSTANCES.get(container);
  if (!inst) return;
  inst.destroy();
  INSTANCES.delete(container);
  if (lastContainer === container) lastContainer = null;
}

/**
 * Diagnostic accessor — returns the live EmbedPDF PluginRegistry for a mounted
 * container (or the most-recently mounted one). Useful for automation/tests and
 * for advanced host integrations that need direct engine/plugin access.
 */
function getRegistry(container?: HTMLElement): PluginRegistry | null {
  const target = container ?? lastContainer;
  if (!target) return null;
  return INSTANCES.get(target)?.getRegistry() ?? null;
}

// Exported as the IIFE globalName `ObsidiPdfEditor`.
export { mountPdfEditor, savePdfEditor, unmountPdfEditor, getRegistry };
