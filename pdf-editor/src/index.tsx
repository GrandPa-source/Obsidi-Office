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

// ---------------------------------------------------------------------------
// Toolbar — OnlyOffice-style compact single-row strip.
//
// Visual spec: light grey chrome (#f7f7f8), ~36px tall, 28px square monochrome
// Lucide-style inline-SVG icon buttons, brand-accent (#204295) active state,
// thin vertical separators between groups. Hover/active states require a CSS
// class (can't be inline), injected once via injectToolbarStyles().
// ---------------------------------------------------------------------------

const TB = 'oo-pdftb-'; // scoped class prefix

let _stylesInjected = false;
function injectToolbarStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  const css = `
.${TB}bar{display:flex;align-items:center;flex-wrap:wrap;gap:2px;
  height:auto;min-height:38px;padding:3px 6px;box-sizing:border-box;
  background:#f7f7f8;border-bottom:1px solid #e0e0e0;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.${TB}btn{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;margin:0;border:none;border-radius:4px;
  background:transparent;color:#444;cursor:pointer;flex:0 0 auto;
  transition:background .12s,color .12s;}
.${TB}btn:hover:not(:disabled):not(.${TB}active){background:#ececec;}
.${TB}btn.${TB}active{background:#204295;color:#fff;}
.${TB}btn:disabled{opacity:.4;cursor:default;}
.${TB}btn svg{width:18px;height:18px;display:block;}
.${TB}sep{width:1px;align-self:stretch;margin:4px 5px;background:#dcdcdc;
  flex:0 0 auto;}
.${TB}zoom{display:inline-flex;align-items:center;gap:1px;flex:0 0 auto;}
.${TB}pct{min-width:46px;text-align:center;font-size:12px;color:#444;
  user-select:none;padding:0 2px;}
`;
  const el = document.createElement('style');
  el.setAttribute('data-oo-pdftb', '');
  el.textContent = css;
  document.head.appendChild(el);
}

// --- Lucide-style line icons (stroke=currentColor, 18px viewBox 24). ---------
type IconProps = { d?: string };
const Svg = (children: any) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {children}
  </svg>
);

const ICONS = {
  // mouse-pointer (Select)
  select: Svg(<><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /><path d="m13 13 6 6" /></>),
  // type (Text / freeText)
  text: Svg(<><path d="M4 7V5h16v2" /><path d="M9 19h6" /><path d="M12 5v14" /></>),
  // highlighter (Highlight)
  highlight: Svg(<><path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></>),
  // pen-tool (Pen / ink)
  pen: Svg(<><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></>),
  // square (Shapes — rectangle for now)
  shapes: Svg(<rect x="4" y="4" width="16" height="16" rx="1" />),
  // signature / pen-line (Sign)
  sign: Svg(<><path d="M3 17c3 0 4-7 6-7s2 5 4 5 2-3 4-3" /><path d="M3 21h18" /></>),
  // eraser-ish redaction (Redact) — strikethrough block
  redact: Svg(<><rect x="3" y="9" width="18" height="6" rx="1" /><path d="M3 3l18 18" /></>),
  // trash-2 (Delete)
  trash: Svg(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>),
  // minus / plus (Zoom)
  minus: Svg(<path d="M5 12h14" />),
  plus: Svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  // save (floppy disk)
  save: Svg(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></>),
};

const Sep = () => <span class={`${TB}sep`} aria-hidden="true" />;

function Toolbar({
  documentId,
  save,
}: {
  documentId: string;
  save: () => Promise<void>;
}) {
  injectToolbarStyles();

  const { provides: annotationApi, state } = useAnnotation(documentId);
  const { provides: zoomApi, state: zoomState } = useZoom(documentId);

  // AnnotationDocumentState: activeToolId is the currently-armed tool; a
  // non-empty selectedUids means an annotation is selected (selectedUid is the
  // deprecated single-selection alias kept as a fallback).
  const activeTool = state?.activeToolId ?? null;
  const hasSelection =
    (state?.selectedUids && state.selectedUids.length > 0) || state?.selectedUid
      ? true
      : false;

  // Select == "no active tool" (pointer/idle) state.
  const isSelect = activeTool == null;

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  // Toggle a tool: clicking the active tool again disarms it (back to Select).
  const tool = (id: string) =>
    annotationApi?.setActiveTool(activeTool === id ? null : id);

  const selectMode = () => annotationApi?.setActiveTool(null);

  const deleteSelected = () => {
    const sel = annotationApi?.getSelectedAnnotation();
    if (sel) annotationApi?.deleteAnnotation(sel.object.pageIndex, sel.object.id);
  };

  const onSaveClick = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await save();
      setSavedAt(Date.now());
    } catch (e) {
      console.error('[pdf-editor] toolbar save failed', e);
    } finally {
      setSaving(false);
    }
  }, [save, saving]);

  // Brief "Saved" affordance after a successful save.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Current zoom as a percentage (currentZoomLevel is the actual scale factor).
  const zoomPct = Math.round((zoomState?.currentZoomLevel ?? 1) * 100);

  const iconBtn = (
    key: keyof typeof ICONS,
    title: string,
    opts: {
      active?: boolean;
      disabled?: boolean;
      onClick?: () => void;
      testid?: string;
    } = {},
  ) => (
    <button
      type="button"
      class={`${TB}btn${opts.active ? ` ${TB}active` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={opts.active ? 'true' : undefined}
      data-testid={opts.testid}
      disabled={opts.disabled}
      onClick={opts.onClick}
    >
      {ICONS[key]}
    </button>
  );

  return (
    <div class={`${TB}bar`} data-testid="pdf-toolbar" role="toolbar" aria-label="PDF tools">
      {/* Select / pointer */}
      {iconBtn('select', 'Select', {
        active: isSelect,
        onClick: selectMode,
        testid: 'pdf-tool-select',
      })}

      <Sep />

      {/* Markup tools */}
      {iconBtn('text', 'Text', {
        active: activeTool === 'freeText',
        onClick: () => tool('freeText'),
        testid: 'pdf-tool-freeText',
      })}
      {iconBtn('highlight', 'Highlight', {
        active: activeTool === 'highlight',
        onClick: () => tool('highlight'),
        testid: 'pdf-tool-highlight',
      })}
      {iconBtn('pen', 'Pen', {
        active: activeTool === 'ink',
        onClick: () => tool('ink'),
        testid: 'pdf-tool-ink',
      })}
      {iconBtn('shapes', 'Shapes', {
        active: activeTool === 'square',
        onClick: () => tool('square'),
        testid: 'pdf-tool-square',
      })}
      {iconBtn('trash', 'Delete selection', {
        disabled: !hasSelection,
        onClick: deleteSelected,
        testid: 'pdf-delete',
      })}

      <Sep />

      {/* Sign — deferred (signature plugin not registered). TODO P2 */}
      {iconBtn('sign', 'Sign (coming soon)', { disabled: true, testid: 'pdf-tool-sign' })}

      <Sep />

      {/* Redact — deferred (redaction plugin not registered, destructive). TODO P4 */}
      {iconBtn('redact', 'Redact (coming soon)', { disabled: true, testid: 'pdf-tool-redact' })}

      <Sep />

      {/* Zoom */}
      <span class={`${TB}zoom`}>
        {iconBtn('minus', 'Zoom out', {
          disabled: !zoomApi,
          onClick: () => zoomApi?.zoomOut(),
          testid: 'pdf-zoom-out',
        })}
        <span class={`${TB}pct`} data-testid="pdf-zoom-pct">
          {zoomPct}%
        </span>
        {iconBtn('plus', 'Zoom in', {
          disabled: !zoomApi,
          onClick: () => zoomApi?.zoomIn(),
          testid: 'pdf-zoom-in',
        })}
      </span>

      <Sep />

      {/* Save */}
      {iconBtn('save', saving ? 'Saving…' : savedAt ? 'Saved' : 'Save (Ctrl+S)', {
        active: !!savedAt,
        disabled: saving,
        onClick: onSaveClick,
        testid: 'pdf-save',
      })}
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
}: {
  engine: PdfEngine;
  fileBytes: Uint8Array;
  author: string;
  onRegistry: (r: PluginRegistry) => Promise<void>;
  /** Save the current document via the host onSave callback (toolbar Save / Ctrl+S). */
  save: () => Promise<void>;
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
                    <Toolbar documentId={activeDocumentId} save={save} />
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
// Public API
// ---------------------------------------------------------------------------

async function mountPdfEditor(
  container: HTMLElement,
  fileBytes: Uint8Array,
  opts: MountOpts,
): Promise<void> {
  if (INSTANCES.has(container)) unmountPdfEditor(container);

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
