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

import { createPluginRegistration, refreshPages } from '@embedpdf/core';
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
import {
  ThumbnailPluginPackage,
  ThumbnailsPane,
  ThumbImg,
} from '@embedpdf/plugin-thumbnail/preact';
import type { ThumbMeta } from '@embedpdf/plugin-thumbnail';
import {
  SearchPluginPackage,
  SearchLayer,
  useSearch,
} from '@embedpdf/plugin-search/preact';
import type { SearchResult } from '@embedpdf/models';

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
  // left rail (OnlyOffice's PDF-editor left-panel nav icons; all small, 20x20)
  railSearch: ['btn-menu-search', 20],
  railComments: ['btn-menu-comments', 20],
  railThumbs: ['btn-menu-thumbs', 20],
  railNav: ['btn-menu-navigation', 20],
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
  --oo-filename:#555;--oo-ctrl-bg:#fff;--oo-ctrl-border:#cfcfcf;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.${CX}.theme-dark{
  --oo-accent:#3a64b4;--oo-accent-underline:#cc4444;
  --oo-tabbar-bg:#404040;--oo-tab-text:#cfcfcf;--oo-tab-active-text:#f1f1f1;
  --oo-tab-active-bg:#404040;--oo-ribbon-bg:#404040;--oo-ribbon-border:#2b2b2b;
  --oo-icon:#cccccc;--oo-btn-hover:#4f4f4f;--oo-btn-active-bg:#5c5c5c;
  --oo-btn-active-icon:#7aa2e3;--oo-label:#dcdcdc;--oo-sep:#5a5a5a;
  --oo-filename:#bdbdbd;--oo-ctrl-bg:#4a4a4a;--oo-ctrl-border:#5a5a5a;}

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

/* Edit PDF text-formatting controls. !important resets defeat Obsidian's global
   input/select/button CSS bleed (the documented chrome-bleed lesson). */
.${CX}-glyph,.oo-glyph{display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;font-size:13px;line-height:1;color:var(--oo-icon);}
.${CX}-fmt-select,.${CX}-fmt-size{height:22px;font-size:12px;
  border:1px solid var(--oo-ctrl-border)!important;border-radius:3px;
  background:var(--oo-ctrl-bg)!important;color:var(--oo-tab-active-text);
  box-shadow:none!important;padding:0 4px;margin:0;flex:0 0 auto;}
.${CX}-fmt-select{width:118px;}
.${CX}-fmt-size{width:50px;}
.${CX}-fmt-select:disabled,.${CX}-fmt-size:disabled{opacity:.45;}
.${CX}-fmt-colorwrap{display:inline-flex;align-items:center;gap:1px;cursor:pointer;}
.${CX}-fmt-color{width:20px;height:20px;padding:0!important;margin:0;
  border:1px solid var(--oo-ctrl-border)!important;border-radius:3px;
  background:transparent!important;box-shadow:none!important;cursor:pointer;flex:0 0 auto;}
.${CX}-fmt-color:disabled{opacity:.45;cursor:default;}
.${CX}-btn-small:disabled{opacity:.4;cursor:default;}

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

/* ===================================================================== */
/* Left rail + side panel (pass 2). The whole editor view becomes:        */
/*   [tabbar] / [ribbon]  on top, then a horizontal row:                  */
/*   [rail][panel?][document Viewport].                                    */
/* ===================================================================== */

/* the horizontal body row under the chrome */
.${CX}-body{display:flex;flex:1;min-height:0;width:100%;}

/* vertical icon strip down the left of the document area */
.${CX}-rail{display:flex;flex-direction:column;align-items:center;gap:2px;
  width:40px;flex:0 0 40px;padding:4px 0;box-sizing:border-box;
  background:var(--oo-tabbar-bg);border-right:1px solid var(--oo-ribbon-border);}

/* rail icon button — flatten Obsidian's global button chrome */
.${CX}-railbtn{background-color:transparent !important;box-shadow:none !important;
  border:none !important;}
.${CX}-railbtn{display:inline-flex;align-items:center;justify-content:center;
  position:relative;width:30px;height:30px;padding:0;border-radius:4px;
  cursor:pointer;color:var(--oo-icon);flex:0 0 auto;transition:background .1s;}
.${CX}-railbtn:hover:not(.${CX}-railbtn-active){background-color:var(--oo-btn-hover) !important;}
.${CX}-railbtn.${CX}-railbtn-active{background-color:var(--oo-btn-active-bg) !important;}
.${CX}-railbtn.${CX}-railbtn-active .oo-ic{color:var(--oo-btn-active-icon);}
.${CX}-railbtn .oo-ic{width:20px;height:20px;}
/* notification dot (Comments icon when annotations exist) */
.${CX}-raildot{position:absolute;top:4px;right:4px;width:7px;height:7px;
  border-radius:50%;background:var(--oo-accent-underline);
  box-shadow:0 0 0 1.5px var(--oo-tabbar-bg);}

/* the panel that opens to the right of the rail */
.${CX}-panel{display:flex;flex-direction:column;width:220px;flex:0 0 220px;
  min-height:0;background:var(--oo-ribbon-bg);
  border-right:1px solid var(--oo-ribbon-border);overflow:hidden;}
.${CX}-panel-head{display:flex;align-items:center;justify-content:space-between;
  height:30px;flex:0 0 30px;padding:0 6px 0 10px;font-size:12px;font-weight:600;
  color:var(--oo-tab-active-text);border-bottom:1px solid var(--oo-ribbon-border);
  background:var(--oo-tabbar-bg);}
.${CX}-panel-close{background-color:transparent !important;box-shadow:none !important;
  border:none !important;display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border-radius:3px;cursor:pointer;
  color:var(--oo-icon);font-size:15px;line-height:1;}
.${CX}-panel-close:hover{background-color:var(--oo-btn-hover) !important;}
.${CX}-panel-body{flex:1;min-height:0;overflow:hidden;display:flex;
  flex-direction:column;}

/* thumbnails list */
.${CX}-thumblist{flex:1;min-height:0;}
.${CX}-thumbcell{position:absolute;left:0;right:0;display:flex;flex-direction:column;
  align-items:center;cursor:pointer;}
.${CX}-thumbframe{box-sizing:border-box;border:2px solid transparent;border-radius:2px;
  display:flex;align-items:center;justify-content:center;
  background:var(--oo-tabbar-bg);overflow:hidden;}
.${CX}-thumbcell:hover .${CX}-thumbframe{border-color:var(--oo-sep);}
.${CX}-thumbcell.${CX}-thumbcell-active .${CX}-thumbframe{border-color:var(--oo-accent);}
.${CX}-thumblabel{font-size:11px;color:var(--oo-label);line-height:1.4;
  text-align:center;user-select:none;}
.${CX}-thumbcell.${CX}-thumbcell-active .${CX}-thumblabel{color:var(--oo-btn-active-icon);
  font-weight:600;}

/* search panel */
.${CX}-search-bar{display:flex;gap:4px;align-items:center;padding:8px;
  border-bottom:1px solid var(--oo-ribbon-border);}
.${CX}-search-input{flex:1;min-width:0;height:24px;padding:0 7px;font-size:12px;
  border:1px solid var(--oo-sep);border-radius:3px;background:transparent;
  color:var(--oo-tab-active-text);box-shadow:none !important;}
.${CX}-search-nav{display:flex;align-items:center;justify-content:space-between;
  gap:4px;padding:5px 8px;border-bottom:1px solid var(--oo-ribbon-border);}
.${CX}-search-count{font-size:11px;color:var(--oo-label);white-space:nowrap;}
.${CX}-search-navbtns{display:flex;gap:2px;}
.${CX}-search-navbtn{background-color:transparent !important;box-shadow:none !important;
  border:none !important;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;border-radius:3px;cursor:pointer;
  color:var(--oo-icon);}
.${CX}-search-navbtn:hover:not(:disabled){background-color:var(--oo-btn-hover) !important;}
.${CX}-search-navbtn:disabled{opacity:.4;cursor:default;}
.${CX}-search-navbtn .oo-ic{width:16px;height:16px;}
.${CX}-search-results{flex:1;min-height:0;overflow-y:auto;}
.${CX}-search-item{background-color:transparent !important;box-shadow:none !important;
  border:none !important;display:block;width:100%;text-align:left;
  padding:6px 10px;font-size:12px;line-height:1.4;cursor:pointer;
  color:var(--oo-tab-active-text);border-bottom:1px solid var(--oo-sep) !important;
  /* Obsidian's global button rule (height:var(--input-height);white-space:nowrap)
     bleeds in and clamps these MULTI-LINE list items to ~30px, so each item's
     stacked spans overflow and collide with the next (the chrome's single-line
     buttons never surfaced this). Let them size to content. */
  height:auto !important;min-height:0 !important;white-space:normal !important;}
.${CX}-search-item:hover{background-color:var(--oo-btn-hover) !important;}
.${CX}-search-item.${CX}-search-item-active{background-color:var(--oo-btn-active-bg) !important;}
.${CX}-search-item .oo-hit{font-weight:700;color:var(--oo-btn-active-icon);}
.${CX}-search-item .oo-pg{font-size:10px;color:var(--oo-label);display:block;
  margin-top:2px;}

/* comments panel */
.${CX}-comments{flex:1;min-height:0;overflow-y:auto;}
.${CX}-comment-item{background-color:transparent !important;box-shadow:none !important;
  border:none !important;display:block;width:100%;text-align:left;
  padding:7px 10px;font-size:12px;line-height:1.4;cursor:pointer;
  color:var(--oo-tab-active-text);border-bottom:1px solid var(--oo-sep) !important;
  /* See .search-item: neutralize Obsidian's fixed button height so the
     type/meta/body stack sizes to content instead of overlapping the next. */
  height:auto !important;min-height:0 !important;white-space:normal !important;}
.${CX}-comment-item:hover{background-color:var(--oo-btn-hover) !important;}
.${CX}-comment-item.${CX}-comment-item-active{background-color:var(--oo-btn-active-bg) !important;}
.${CX}-comment-type{display:block;font-weight:600;color:var(--oo-btn-active-icon);}
.${CX}-comment-meta{font-size:10px;color:var(--oo-label);display:block;margin-top:2px;}
.${CX}-comment-body{display:block;margin-top:3px;color:var(--oo-tab-active-text);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.${CX}-line-outline{box-sizing:border-box;border:1px dashed rgba(120,150,220,0.55);border-radius:2px;cursor:text;background:transparent;}
.${CX}-line-outline:hover{border-color:var(--oo-accent);background:rgba(120,150,220,0.08);}
.${CX}-line-edited{border-color:var(--oo-accent-underline);}

/* PDF-EMBEDPDF PoC A3 — textarea edit box reset (fights Obsidian global textarea styles) */
.${CX}-textedit{background-color:#fff !important;box-shadow:none !important;
  border:1px solid var(--oo-accent) !important;border-radius:0;outline:none;}

/* empty / hint states */
.${CX}-panel-empty{padding:14px 12px;font-size:12px;color:var(--oo-label);
  line-height:1.5;}
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

// Text/markup-glyph formatting button (B/I/U/S, A-/A+, alignment SVGs) styled to
// match the small icon buttons. `label` may be text or an inline SVG element.
function FmtBtn({ label, title, active, disabled, onClick, testid, labelStyle }: {
  label: any; title: string; active?: boolean; disabled?: boolean;
  onClick?: () => void; testid?: string; labelStyle?: any;
}) {
  return (
    <button type="button"
      class={`${CX}-btn-small${active ? ` ${CX}-btn-active` : ''}`}
      title={title} aria-label={title} aria-pressed={active ? 'true' : undefined}
      disabled={disabled} data-testid={testid} onClick={onClick}>
      <span class="oo-glyph" style={labelStyle}>{label}</span>
    </button>
  );
}

// Small alignment glyphs (horizontal L/C/R as anchored lines; vertical T/M/B as a
// boxed bar). currentColor inherits the button's icon colour (incl. active state).
function AlignIcon({ kind }: { kind: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' }) {
  const ln = (x1: number, y: number, x2: number) =>
    <line x1={x1} y1={y} x2={x2} y2={y} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />;
  const box = <rect x="1.5" y="1.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1" />;
  let body: any;
  if (kind === 'left') body = [ln(1, 3, 13), ln(1, 7, 9), ln(1, 11, 13)];
  else if (kind === 'center') body = [ln(1, 3, 13), ln(3, 7, 11), ln(1, 11, 13)];
  else if (kind === 'right') body = [ln(1, 3, 13), ln(5, 7, 13), ln(1, 11, 13)];
  else if (kind === 'top') body = [box, ln(3.5, 4, 10.5)];
  else if (kind === 'middle') body = [box, ln(3.5, 7, 10.5)];
  else body = [box, ln(3.5, 10, 10.5)];
  return <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: 'block' }}>{body}</svg>;
}

// ---------------------------------------------------------------------------
// Left rail + side panels (pass 2). OnlyOffice's PDF editor has a vertical icon
// rail down the left of the document area; clicking an icon opens a panel beside
// it; clicking the active icon closes it. Only one panel is open at a time.
// ---------------------------------------------------------------------------

type RailId = 'thumbnails' | 'search' | 'comments';

// One flat icon button in the left rail.
function RailBtn({
  icon, title, active, dot, onClick, testid,
}: {
  icon: IconSpec; title: string;
  active?: boolean; dot?: boolean; onClick?: () => void; testid?: string;
}) {
  return (
    <button
      type="button"
      class={`${CX}-railbtn${active ? ` ${CX}-railbtn-active` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? 'true' : 'false'}
      data-testid={testid}
      onClick={onClick}
    >
      <Ic spec={icon} />
      {dot ? <span class={`${CX}-raildot`} data-testid={`${testid}-dot`} aria-hidden="true" /> : null}
    </button>
  );
}

// --- Thumbnails panel -------------------------------------------------------
// Uses @embedpdf/plugin-thumbnail's <ThumbnailsPane> (windowed render-prop list)
// + <ThumbImg> (renders one page bitmap to a blob URL). Clicking a thumbnail
// navigates the main document via the scroll plugin; the current page is
// highlighted.
function ThumbnailsPanel({ documentId }: { documentId: string }) {
  const { provides: scrollApi, state: scrollState } = useScroll(documentId);
  const curPage = scrollState?.currentPage ?? 1; // 1-based
  return (
    <div class={`${CX}-panel-body`} data-testid="pdf-panel-thumbnails">
      <ThumbnailsPane documentId={documentId} className={`${CX}-thumblist`}>
        {(m: ThumbMeta) => {
          const isActive = m.pageIndex + 1 === curPage;
          return (
            <div
              key={m.pageIndex}
              class={`${CX}-thumbcell${isActive ? ` ${CX}-thumbcell-active` : ''}`}
              style={{ top: m.top, height: m.wrapperHeight }}
              data-testid={`pdf-thumb-${m.pageIndex}`}
              role="button"
              tabIndex={0}
              onClick={() => scrollApi?.scrollToPage({ pageNumber: m.pageIndex + 1 })}
            >
              <div
                class={`${CX}-thumbframe`}
                style={{ width: m.width, height: m.height }}
              >
                <ThumbImg
                  documentId={documentId}
                  meta={m}
                  style={{ width: m.width, height: m.height, display: 'block' }}
                />
              </div>
              <div class={`${CX}-thumblabel`} style={{ height: m.labelHeight }}>
                {m.pageIndex + 1}
              </div>
            </div>
          );
        }}
      </ThumbnailsPane>
    </div>
  );
}

// --- Search panel -----------------------------------------------------------
// Uses @embedpdf/plugin-search's useSearch(): startSearch() opens a session,
// searchAllPages(q) finds matches, goToResult/nextResult/previousResult jump +
// activate a hit; the per-page <SearchLayer> (added in the Scroller) paints the
// highlight. Results show context (before/<hit>/after) + page number.
function SearchPanel({ documentId }: { documentId: string }) {
  const { provides: searchApi, state: searchState } = useSearch(documentId);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState(false);

  // Start a search session when the panel mounts; stop it on unmount so the
  // highlight layer clears when the panel closes.
  useEffect(() => {
    if (!searchApi) return;
    searchApi.startSearch();
    return () => { try { searchApi.stopSearch(); } catch (_) { /* noop */ } };
  }, [searchApi]);

  const results = searchState?.results ?? [];
  const activeIdx = searchState?.activeResultIndex ?? -1;
  const loading = !!searchState?.loading;

  const runSearch = useCallback(() => {
    if (!searchApi) return;
    const q = query.trim();
    setSubmitted(true);
    if (!q) return;
    const task = searchApi.searchAllPages(q);
    // PdfTask resolves when the full-document search completes; state updates
    // reactively via useSearch, so we don't need the resolved value here.
    task?.wait?.(() => { /* state-driven */ }, () => { /* ignore */ });
  }, [searchApi, query]);

  return (
    <div class={`${CX}-panel-body`} data-testid="pdf-panel-search">
      <div class={`${CX}-search-bar`}>
        <input
          class={`${CX}-search-input`}
          data-testid="pdf-search-input"
          type="text"
          placeholder="Find in document"
          value={query}
          aria-label="Find in document"
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') runSearch(); }}
        />
      </div>
      <div class={`${CX}-search-nav`}>
        <span class={`${CX}-search-count`} data-testid="pdf-search-count">
          {loading ? 'Searching…'
            : results.length === 0
              ? (submitted ? 'No matches' : ' ')
              : `${activeIdx >= 0 ? activeIdx + 1 : 1} / ${results.length}`}
        </span>
        <div class={`${CX}-search-navbtns`}>
          <button type="button" class={`${CX}-search-navbtn`}
            data-testid="pdf-search-prev" title="Previous match"
            disabled={results.length === 0}
            onClick={() => searchApi?.previousResult()}>
            <Ic spec={IC.prevPage} />
          </button>
          <button type="button" class={`${CX}-search-navbtn`}
            data-testid="pdf-search-next" title="Next match"
            disabled={results.length === 0}
            onClick={() => searchApi?.nextResult()}>
            <Ic spec={IC.nextPage} />
          </button>
        </div>
      </div>
      <div class={`${CX}-search-results`} data-testid="pdf-search-results">
        {results.map((r: SearchResult, i: number) => (
          <button
            type="button"
            key={i}
            class={`${CX}-search-item${i === activeIdx ? ` ${CX}-search-item-active` : ''}`}
            data-testid={`pdf-search-result-${i}`}
            onClick={() => searchApi?.goToResult(i)}
          >
            <span>
              {r.context?.before}
              <span class="oo-hit">{r.context?.match}</span>
              {r.context?.after}
            </span>
            <span class="oo-pg">Page {r.pageIndex + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Comments panel ---------------------------------------------------------
// Lists existing annotations from the already-registered annotation plugin
// (via useAnnotation state.byUid). Clicking one selects it + scrolls to its
// page. A notification dot on the rail's Comments icon shows when any exist.
const ANNOT_TYPE_LABEL: Record<number, string> = {
  1: 'Text', 3: 'Free text', 4: 'Line', 5: 'Rectangle', 6: 'Ellipse',
  8: 'Polyline', 9: 'Highlight', 10: 'Underline', 11: 'Squiggly',
  12: 'Strikeout', 13: 'Stamp', 15: 'Ink',
};

function CommentsPanel({ documentId }: { documentId: string }) {
  const { provides: annotationApi, state } = useAnnotation(documentId);
  const { provides: scrollApi } = useScroll(documentId);

  // Flatten byUid -> array; keep deterministic order by page then id.
  const items = Object.values(state?.byUid ?? {})
    .map((t: any) => t?.object)
    .filter((o: any) => o && o.type !== 16 /* skip POPUP */)
    .sort((a: any, b: any) =>
      a.pageIndex - b.pageIndex || String(a.id).localeCompare(String(b.id)));

  const selectedUids = state?.selectedUids ?? [];
  const isSel = (o: any) => selectedUids.includes(o.id);

  const onSelect = (o: any) => {
    try { annotationApi?.selectAnnotation(o.pageIndex, o.id); } catch (_) { /* noop */ }
    scrollApi?.scrollToPage({ pageNumber: o.pageIndex + 1 });
  };

  return (
    <div class={`${CX}-panel-body`} data-testid="pdf-panel-comments">
      {items.length === 0 ? (
        <div class={`${CX}-panel-empty`} data-testid="pdf-comments-empty">
          No comments yet. Use the Comment tab to add highlights, notes, shapes
          and ink, and they'll appear here.
        </div>
      ) : (
        <div class={`${CX}-comments`}>
          {items.map((o: any) => (
            <button
              type="button"
              key={o.id}
              class={`${CX}-comment-item${isSel(o) ? ` ${CX}-comment-item-active` : ''}`}
              data-testid={`pdf-comment-${o.id}`}
              onClick={() => onSelect(o)}
            >
              <span class={`${CX}-comment-type`}>
                {ANNOT_TYPE_LABEL[o.type] ?? `Type ${o.type}`}
              </span>
              <span class={`${CX}-comment-meta`}>
                Page {o.pageIndex + 1}{o.author ? ` · ${o.author}` : ''}
              </span>
              {o.contents
                ? <span class={`${CX}-comment-body`}>{o.contents}</span>
                : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The rail + (optional) open panel. Renders to the left of the document area.
function LeftRailAndPanel({
  documentId, openPanel, setOpenPanel,
}: {
  documentId: string;
  openPanel: RailId | null;
  setOpenPanel: (p: RailId | null) => void;
}) {
  const { state: annotState } = useAnnotation(documentId);
  const hasComments = Object.values(annotState?.byUid ?? {})
    .some((t: any) => t?.object && t.object.type !== 16);

  const toggle = (id: RailId) => setOpenPanel(openPanel === id ? null : id);

  const PANEL_TITLE: Record<RailId, string> = {
    thumbnails: 'Page Thumbnails',
    search: 'Search',
    comments: 'Comments',
  };

  return (
    <>
      <div class={`${CX}-rail`} data-testid="pdf-rail" role="toolbar" aria-label="Side panels">
        <RailBtn icon={IC.railThumbs} title="Page Thumbnails"
          active={openPanel === 'thumbnails'} onClick={() => toggle('thumbnails')}
          testid="pdf-rail-thumbnails" />
        <RailBtn icon={IC.railSearch} title="Search"
          active={openPanel === 'search'} onClick={() => toggle('search')}
          testid="pdf-rail-search" />
        <RailBtn icon={IC.railComments} title="Comments" dot={hasComments}
          active={openPanel === 'comments'} onClick={() => toggle('comments')}
          testid="pdf-rail-comments" />
      </div>
      {openPanel ? (
        <div class={`${CX}-panel`} data-testid={`pdf-panel-${openPanel}`} key={openPanel}>
          <div class={`${CX}-panel-head`}>
            <span data-testid="pdf-panel-title">{PANEL_TITLE[openPanel]}</span>
            <button type="button" class={`${CX}-panel-close`}
              title="Close panel" aria-label="Close panel"
              data-testid="pdf-panel-close"
              onClick={() => setOpenPanel(null)}>×</button>
          </div>
          {openPanel === 'thumbnails' ? <ThumbnailsPanel documentId={documentId} />
            : openPanel === 'search' ? <SearchPanel documentId={documentId} />
              : <CommentsPanel documentId={documentId} />}
        </div>
      ) : null}
    </>
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
  editPdfOn,
  setEditPdfOn,
  editTextOn,
  setEditTextOn,
}: {
  documentId: string;
  save: () => Promise<void>;
  onClose?: () => void;
  editPdfOn: boolean;
  setEditPdfOn: (v: boolean) => void;
  editTextOn: boolean;
  setEditTextOn: (v: boolean) => void;
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

  // --- Edit PDF: live formatting of the SELECTED FreeText box ---
  // Reads the selected box's current props (to drive control values + active
  // states) and patches them via updateAnnotation (autoCommit re-renders the AP).
  const selTracked = annotationApi?.getSelectedAnnotation?.() as any;
  const selObj = selTracked?.object || null;
  const ftSelected = !!selObj && selObj.type === 3; // PdfAnnotationSubtype.FREETEXT
  const ftVar = ftSelected ? editText.fontVariant(selObj.fontFamily ?? 4) : null;
  const ftSize = ftSelected ? Math.round(selObj.fontSize ?? 12) : null;
  const ftAlign = ftSelected ? (selObj.textAlign ?? 0) : -1;
  const ftVAlign = ftSelected ? (selObj.verticalAlign ?? 0) : -1;
  const ftColor = ftSelected ? (selObj.fontColor || '#000000') : '#000000';
  const ftBg = ftSelected ? (selObj.color || '#ffffff') : '#ffffff';
  const ftStyles = !!ftVar && editText.familyHasStyles(ftVar.family);
  const patchFt = (patch: any) => {
    if (!ftSelected) return;
    try { annotationApi?.updateAnnotation(selObj.pageIndex, selObj.id, patch); } catch (_) { /* noop */ }
  };
  const setFamily = (family: any) =>
    patchFt({ fontFamily: editText.composeFont(family, !!ftVar?.bold, !!ftVar?.italic) });
  const toggleBold = () => ftVar && patchFt({ fontFamily: editText.composeFont(ftVar.family, !ftVar.bold, ftVar.italic) });
  const toggleItalic = () => ftVar && patchFt({ fontFamily: editText.composeFont(ftVar.family, ftVar.bold, !ftVar.italic) });
  const setSize = (n: number) => patchFt({ fontSize: Math.max(4, Math.min(144, Math.round(n))) });

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

      {/* 2. Edit PDF — master toggle; gates the content-editing group (OnlyOffice-style) */}
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

      {/* 2b. Content-editing group — only when Edit PDF is on */}
      {editPdfOn ? (
        <Group testid="pdf-group-content">
          <BigBtn icon={IC.editText} caption="Edit Text" title="Outline & edit text lines"
            active={editTextOn}
            onClick={() => {
              const next = !editTextOn;
              setEditTextOn(next);
              annotationApi?.setActiveTool(null); // exclusive with annotation tools
              if (next) { try { imApi?.activateDefaultMode?.(); } catch (_) {} }
            }}
            testid="pdf-edit-text" />
          <BigBtn icon={IC.text} caption="Insert Text" title="Insert a new text box"
            active={activeTool === 'freeText'}
            onClick={() => tool('freeText')}
            testid="pdf-insert-text" />
        </Group>
      ) : null}

      {/* 2c. Text formatting of the selected box (Edit PDF). Controls are enabled
           only when a FreeText box is selected; underline/strikethrough are shown
           disabled (not expressible on a FreeText annotation). */}
      {editPdfOn ? (
        <Group testid="pdf-group-format">
          <div class={`${CX}-group-rows`}>
            <div class={`${CX}-row`}>
              <select class={`${CX}-fmt-select`} title="Font" data-testid="pdf-fmt-font"
                disabled={!ftSelected} value={ftVar?.family ?? 'helvetica'}
                onChange={(e) => setFamily((e.target as HTMLSelectElement).value)}>
                <option value="helvetica">Helvetica</option>
                <option value="times">Times New Roman</option>
                <option value="courier">Courier New</option>
                <option value="symbol">Symbol</option>
                <option value="zapf">ZapfDingbats</option>
              </select>
              <select class={`${CX}-fmt-size`} title="Font size" data-testid="pdf-fmt-size"
                disabled={!ftSelected} value={String(ftSize ?? '')}
                onChange={(e) => setSize(Number((e.target as HTMLSelectElement).value))}>
                {ftSize != null && ![8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].includes(ftSize)
                  ? <option value={String(ftSize)}>{ftSize}</option> : null}
                {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map((s) =>
                  <option value={String(s)}>{s}</option>)}
              </select>
              <FmtBtn label="A−" title="Decrease font size" disabled={!ftSelected}
                testid="pdf-fmt-size-dn" onClick={() => ftSize != null && setSize(ftSize - 1)} />
              <FmtBtn label="A+" title="Increase font size" disabled={!ftSelected}
                testid="pdf-fmt-size-up" onClick={() => ftSize != null && setSize(ftSize + 1)} />
            </div>
            <div class={`${CX}-row`}>
              <FmtBtn label="B" title="Bold" labelStyle={{ fontWeight: 700 }}
                active={!!ftVar?.bold} disabled={!ftSelected || !ftStyles}
                testid="pdf-fmt-bold" onClick={toggleBold} />
              <FmtBtn label="I" title="Italic" labelStyle={{ fontStyle: 'italic' }}
                active={!!ftVar?.italic} disabled={!ftSelected || !ftStyles}
                testid="pdf-fmt-italic" onClick={toggleItalic} />
              <FmtBtn label="U" title="Underline — not available on PDF text boxes"
                labelStyle={{ textDecoration: 'underline' }} disabled testid="pdf-fmt-underline" />
              <FmtBtn label="S" title="Strikethrough — not available on PDF text boxes"
                labelStyle={{ textDecoration: 'line-through' }} disabled testid="pdf-fmt-strike" />
              <label class={`${CX}-fmt-colorwrap`} title="Font colour">
                <span class="oo-glyph">A</span>
                <input type="color" class={`${CX}-fmt-color`} disabled={!ftSelected} value={ftColor}
                  data-testid="pdf-fmt-color" onInput={(e) => patchFt({ fontColor: (e.target as HTMLInputElement).value })} />
              </label>
              <label class={`${CX}-fmt-colorwrap`} title="Highlight (box fill) colour">
                <span class="oo-glyph">▮</span>
                <input type="color" class={`${CX}-fmt-color`} disabled={!ftSelected} value={ftBg}
                  data-testid="pdf-fmt-bg" onInput={(e) => patchFt({ color: (e.target as HTMLInputElement).value })} />
              </label>
              <FmtBtn label={<AlignIcon kind="left" />} title="Align left" active={ftAlign === 0}
                disabled={!ftSelected} testid="pdf-fmt-align-left" onClick={() => patchFt({ textAlign: 0 })} />
              <FmtBtn label={<AlignIcon kind="center" />} title="Align centre" active={ftAlign === 1}
                disabled={!ftSelected} testid="pdf-fmt-align-center" onClick={() => patchFt({ textAlign: 1 })} />
              <FmtBtn label={<AlignIcon kind="right" />} title="Align right" active={ftAlign === 2}
                disabled={!ftSelected} testid="pdf-fmt-align-right" onClick={() => patchFt({ textAlign: 2 })} />
              <FmtBtn label={<AlignIcon kind="top" />} title="Align top" active={ftVAlign === 0}
                disabled={!ftSelected} testid="pdf-fmt-valign-top" onClick={() => patchFt({ verticalAlign: 0 })} />
              <FmtBtn label={<AlignIcon kind="middle" />} title="Align middle" active={ftVAlign === 1}
                disabled={!ftSelected} testid="pdf-fmt-valign-middle" onClick={() => patchFt({ verticalAlign: 1 })} />
              <FmtBtn label={<AlignIcon kind="bottom" />} title="Align bottom" active={ftVAlign === 2}
                disabled={!ftSelected} testid="pdf-fmt-valign-bottom" onClick={() => patchFt({ verticalAlign: 2 })} />
            </div>
          </div>
        </Group>
      ) : null}

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
// Editor body: chrome on top, then a horizontal row [rail][panel?][viewport].
// Owns the open-panel state so the rail + panel stay in sync. Rendered only once
// the document is loaded (so all the plugin hooks have a live document).
// ---------------------------------------------------------------------------

function EditorBody({
  documentId,
  save,
  onClose,
}: {
  documentId: string;
  save: () => Promise<void>;
  onClose?: () => void;
}) {
  const [openPanel, setOpenPanel] = useState<RailId | null>(null);

  // PDF-EMBEDPDF PoC A2 — edit-text mode state.
  const [editTextOn, setEditTextOn] = useState(false);
  // Edit PDF master toggle (OnlyOffice-style): gates the content-editing ribbon
  // group. editTextOn is the sub-mode that dashes text lines for click-to-edit.
  const [editPdfOn, setEditPdfOn] = useState(false);
  // Precomputed line rects per page (populated when editTextOn → dashed outlines).
  const [linesByPage, setLinesByPage] = useState<Record<number, { ptW: number; ptH: number; lines: any[] }>>({});
  // Bumped after a line is converted to a FreeText (in convertLineToFreeText) so the
  // outline scan refreshes (the converted line is now an object, no longer a run).
  const [scanVersion, setScanVersion] = useState(0);
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
  }, [editTextOn, scanVersion]);


  // Edit PDF mode: convert a clicked text line into an editable FreeText annotation.
  // Redacts the original glyphs, creates a matched-font FreeText in their place
  // (NOT flattened → stays a live object), and selects it so EmbedPDF renders the
  // move/resize/rotate handles + double-click edit. Serialized on _editApplyChain.
  const FREETEXT_SUBTYPE = 3; // PdfAnnotationSubtype.FREETEXT (confirmed in @embedpdf/models)
  const convertLineToFreeText = useCallback((pageIndex: number, line: any) => {
    _editApplyChain = _editApplyChain.then(async () => {
      const reg = (globalThis as any).ObsidiPdfEditor.getRegistry?.();
      const engine = reg?.getEngine();
      const doc = reg?.getPlugin('document-manager')?.provides()?.getActiveDocument();
      const annoApi = reg?.getPlugin('annotation')?.provides();
      const page = doc?.pages?.[pageIndex];
      if (!engine || !doc || !page || !annoApi) return;
      // Ensure select mode so the new box gets handles + drag-to-move (not a tool).
      try { annoApi.setActiveTool(null); } catch (_) { /* noop */ }
      // 1) Redact the original line glyphs (no black box) so they don't show under the box.
      const t = (engine as any).redactTextInRects(doc, page, [line.rect], { drawBlackBoxes: false });
      await (t?.toPromise ? t.toPromise()
        : new Promise((res, rej) => (t?.wait ? t.wait(res, rej) : res(t))));
      // 2) Create the live FreeText (matched font/size/colour; we own the id).
      //    Seed the box width via fitBox so the wider substitute font (Helvetica)
      //    doesn't clip the text at the original line rect; widen toward the page
      //    edge (or the next segment), shrinking the size only as a last resort.
      const fit = editText.fitBox(line.text, line.cssFont, line.fontSize, line.rect,
        page.size?.width ?? 0, line.text, line.weight, line.maxRight);
      const seededLine = {
        ...line,
        rect: { origin: line.rect.origin, size: { width: fit.width, height: line.rect.size.height } },
        fontSize: fit.fontSize,
      };
      const annot = editText.buildFreeTextFromLine(seededLine, pageIndex, FREETEXT_SUBTYPE);
      annoApi.createAnnotation(pageIndex, annot);
      // 3) Refresh the page render + select the box (handles + double-click edit).
      try { reg.getStore?.()?.dispatch(refreshPages(doc.id, [pageIndex])); } catch (_) { /* noop */ }
      try { annoApi.selectAnnotation(pageIndex, annot.id); } catch (_) { /* noop */ }
      setScanVersion((v) => v + 1); // re-scan outlines (the converted line is now an object)
    }).catch((e) => console.warn('[pdf-editor] convertLineToFreeText failed', e));
  }, []);

  // Click outside the selected FreeText box → deselect it. EmbedPDF keeps the
  // selection on an empty-page click, so we drive it geometrically: on pointerdown,
  // map the selected box's PDF rect to screen px (via the pdf-page-N reference) and
  // deselect when the click falls outside it (+ a margin for the resize/rotate
  // handles). Clicks on a line outline are left alone (they convert that line).
  useEffect(() => {
    if (!editTextOn) return;
    const onDown = (e: PointerEvent) => {
      const reg = (globalThis as any).ObsidiPdfEditor?.getRegistry?.();
      const annoApi = reg?.getPlugin('annotation')?.provides();
      const sel = annoApi?.getSelectedAnnotation?.();
      if (!sel?.object) return;
      const target = e.target as HTMLElement | null;
      // Only deselect for clicks INSIDE the page area — never the ribbon/toolbar
      // (clicking a formatting control must keep the box selected).
      if (!target?.closest?.('[data-testid="pdf-body"]')) return;
      if (target?.closest?.('[data-testid^="pdf-line-"]')) return; // outline → convert, not deselect
      const pageIndex = sel.object.pageIndex ?? 0;
      const pageEl = document.querySelector(`[data-testid="pdf-page-${pageIndex}"]`);
      const doc = reg?.getPlugin('document-manager')?.provides()?.getActiveDocument();
      const ptSize = doc?.pages?.[pageIndex]?.size;
      const r = sel.object.rect;
      if (!pageEl || !ptSize || !r) return;
      const pr = (pageEl as HTMLElement).getBoundingClientRect();
      const sxv = pr.width / ptSize.width, syv = pr.height / ptSize.height;
      const left = pr.left + r.origin.x * sxv, top = pr.top + r.origin.y * syv;
      const right = left + r.size.width * sxv, bottom = top + r.size.height * syv;
      const M = 26; // margin so clicking the handles (incl. rotation, ~20px above) keeps selection
      const inside = e.clientX >= left - M && e.clientX <= right + M &&
                     e.clientY >= top - M && e.clientY <= bottom + M;
      if (!inside) { try { annoApi.deselectAnnotation(); } catch (_) { /* noop */ } }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [editTextOn]);

  // Test hooks (standalone.html harness). Edit PDF mode + outline line counts.
  useEffect(() => {
    (globalThis as any).__editapi = Object.assign((globalThis as any).__editapi || {}, {
      editState: () => ({ editPdfOn, editTextOn }),
      setEditPdf: (v: boolean) => setEditPdfOn(v),
      setMode: (v: boolean) => setEditTextOn(v),
      lineCount: (p: number) => (linesByPage[p]?.lines.length ?? 0),
    });
  }, [editPdfOn, editTextOn, linesByPage]);

  return (
    <>
      <Chrome documentId={documentId} save={save} onClose={onClose}
        editPdfOn={editPdfOn} setEditPdfOn={setEditPdfOn}
        editTextOn={editTextOn} setEditTextOn={setEditTextOn} />
      <div class={`${CX}-body`} data-testid="pdf-body">
        <LeftRailAndPanel
          documentId={documentId}
          openPanel={openPanel}
          setOpenPanel={setOpenPanel}
        />
        <Viewport
          documentId={documentId}
          style={{ flex: 1, minWidth: 0, backgroundColor: '#f1f3f5', overflow: 'auto' }}
        >
          <Scroller
            documentId={documentId}
            renderPage={(page) => {
              // Scroller's declared param is PageLayout, but at runtime it
              // also spreads scale/rotation/document (RenderPageProps).
              const { width, height, pageIndex, scale, rotation } =
                page as RenderPageProps;
              return (
                <PagePointerProvider
                  documentId={documentId}
                  pageIndex={pageIndex}
                  style={{ width, height, position: 'relative' }}
                >
                  <RenderLayer documentId={documentId} pageIndex={pageIndex} scale={scale} />
                  <SelectionLayer documentId={documentId} pageIndex={pageIndex} scale={scale} />
                  {/* Search highlights (only paints when a search session is active). */}
                  <SearchLayer documentId={documentId} pageIndex={pageIndex} scale={scale} />
                  <AnnotationLayer
                    documentId={documentId}
                    pageIndex={pageIndex}
                    scale={scale}
                    rotation={rotation}
                  />
                  {/* Page-geometry reference (Edit PDF). pointer-events:none so it
                      never intercepts; its bounding rect == the page in screen px,
                      used by the click-outside-to-deselect handler to map the
                      selected box's PDF rect to screen coordinates. */}
                  {editTextOn ? (
                    <div data-testid={`pdf-page-${pageIndex}`}
                      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }} />
                  ) : null}
                  {/* Edit PDF mode — dash every text line; click converts it to an
                      editable FreeText box (move/resize/rotate/edit via EmbedPDF). */}
                  {editTextOn && linesByPage[pageIndex] ? linesByPage[pageIndex].lines.map((ln: any, i: number) => {
                    const { ptW, ptH } = linesByPage[pageIndex];
                    const o = ln.rect.origin, s = ln.rect.size;
                    return (
                      <div key={i} data-testid={`pdf-line-${pageIndex}-${i}`}
                        class={`${CX}-line-outline`}
                        style={{ position: 'absolute', left: `${o.x / ptW * 100}%`, top: `${o.y / ptH * 100}%`,
                          width: `${s.width / ptW * 100}%`, height: `${s.height / ptH * 100}%`, zIndex: 10 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          convertLineToFreeText(pageIndex, ln); // redacts + creates FreeText + selects (select mode)
                        }}
                      />
                    );
                  }) : null}
                </PagePointerProvider>
              );
            }}
          />
        </Viewport>
      </div>
    </>
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
      createPluginRegistration(AnnotationPluginPackage, {
        annotationAuthor: author,
        // Edit PDF mode: text boxes (FreeText) are rotatable like OnlyOffice. The
        // default freeText tool is drag+resize only; this partial override is
        // deep-merged with the default tool (AnnotationToolOverride).
        tools: [{ id: 'freeText', interaction: { isRotatable: true } as any }],
      }),
      // Left-rail feature plugins (pass 2).
      // Thumbnail requires `render` (above) + optionally uses `scroll` (above).
      createPluginRegistration(ThumbnailPluginPackage, {
        width: 140,
        gap: 10,
        labelHeight: 18,
      }),
      createPluginRegistration(SearchPluginPackage),
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
                  <EditorBody
                    documentId={activeDocumentId}
                    save={save}
                    onClose={onClose}
                  />
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

// Edit PDF mode — line→FreeText conversions chain here (serialized) so the save
// path can await any in-flight conversion (redact + createAnnotation) before
// saveAsCopy serializes the document.
let _editApplyChain: Promise<void> = Promise.resolve();

async function saveViaRegistry(
  registry: PluginRegistry,
  onSave: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const engine = registry.getEngine();
  const docManager = registry.getPlugin<any>('document-manager')?.provides();
  const doc = docManager?.getActiveDocument?.();
  if (!engine || !doc) throw new Error('No active document to save.');

  // Wait for any in-flight line→FreeText conversion to finish so the serialized
  // doc includes it.
  await _editApplyChain;

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
import * as editText from './edit-text';
// PDF-EMBEDPDF PoC — re-export edit-text glue so window.ObsidiPdfEditor.__editText resolves.
const __editText = editText;
export { mountPdfEditor, savePdfEditor, unmountPdfEditor, getRegistry, __editText };
