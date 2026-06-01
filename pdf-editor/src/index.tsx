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
import { ZoomPluginPackage } from '@embedpdf/plugin-zoom/preact';
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
// Toolbar (markup tools) — exercises the annotation plugin via useAnnotation.
// ---------------------------------------------------------------------------

function Toolbar({ documentId }: { documentId: string }) {
  const { provides: annotationApi, state } = useAnnotation(documentId);
  // AnnotationDocumentState: activeToolId is the currently-armed tool; a
  // non-empty selectedUids means an annotation is selected (selectedUid is the
  // deprecated single-selection alias kept as a fallback).
  const activeTool = state?.activeToolId ?? null;
  const selectedUid =
    (state?.selectedUids && state.selectedUids.length > 0) || state?.selectedUid
      ? true
      : false;

  const tool = (id: string) =>
    annotationApi?.setActiveTool(activeTool === id ? null : id);

  const deleteSelected = () => {
    const sel = annotationApi?.getSelectedAnnotation();
    if (sel) annotationApi?.deleteAnnotation(sel.object.pageIndex, sel.object.id);
  };

  const btn = (id: string, label: string) => (
    <button
      type="button"
      data-tool={id}
      onClick={() => tool(id)}
      style={{
        padding: '4px 10px',
        marginRight: 4,
        border: '1px solid #c5c5c5',
        borderRadius: 4,
        background: activeTool === id ? '#204295' : '#fff',
        color: activeTool === id ? '#fff' : '#222',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      data-testid="pdf-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderBottom: '1px solid #ddd',
        background: '#fafafa',
        flexWrap: 'wrap',
      }}
    >
      {btn('freeText', 'Text')}
      {btn('highlight', 'Highlight')}
      {btn('ink', 'Pen')}
      {btn('square', 'Box')}
      <button
        type="button"
        data-testid="pdf-delete"
        onClick={deleteSelected}
        disabled={!selectedUid}
        style={{
          padding: '4px 10px',
          marginLeft: 8,
          border: '1px solid #c5c5c5',
          borderRadius: 4,
          background: '#fff',
          cursor: selectedUid ? 'pointer' : 'not-allowed',
          opacity: selectedUid ? 1 : 0.5,
        }}
      >
        Delete
      </button>
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
}: {
  engine: PdfEngine;
  fileBytes: Uint8Array;
  author: string;
  onRegistry: (r: PluginRegistry) => Promise<void>;
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
                    <Toolbar documentId={activeDocumentId} />
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

  // Mount the Preact tree.
  render(
    <PdfEditorApp
      engine={engine}
      fileBytes={fileBytes}
      author={opts.author ?? 'Obsidi-Office'}
      onRegistry={onRegistry}
    />,
    container,
  );

  const instance: ActiveInstance = {
    save: async () => {
      if (!registry) throw new Error('Editor not initialized yet.');
      await saveViaRegistry(registry, opts.onSave);
    },
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
