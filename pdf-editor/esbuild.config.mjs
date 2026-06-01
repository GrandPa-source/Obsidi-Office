// Bundles the Preact + EmbedPDF PDF editor into a single IIFE that the
// hand-written Obsidi-Office main.js loads at runtime. The 4.6 MB pdfium.wasm
// is NOT inlined — it is fetched at runtime from a URL passed into
// mountPdfEditor(...). EmbedPDF ships native `/preact` subpaths for every
// package, so no react -> preact/compat aliasing is needed.
import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/index.tsx'],
  outfile: 'dist/pdf-editor.js',
  bundle: true,
  format: 'iife',
  globalName: 'ObsidiPdfEditor',
  platform: 'browser',
  target: 'es2018',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: true,
  // Single self-contained file: prevent code-splitting chunks. We import the
  // direct PDFium engine statically (not the worker engine) so there is no
  // dynamic import() to split out.
  splitting: false,
  minify: false,
  logLevel: 'info',
  // pdfium.wasm is loaded at runtime via a URL, never bundled.
  loader: { '.wasm': 'file' },
  // The Emscripten glue computes `new URL("pdfium.wasm", import.meta.url)` even
  // though createPdfiumEngine supplies the wasm bytes directly. In an IIFE that
  // expression is `import.meta.url === undefined`, which throws at module init.
  // We never use the computed path (the fetched bytes win), but it must not
  // throw — so point import.meta.url at a guaranteed-valid base URL. In the
  // browser/Electron renderer/WKWebView, document.baseURI is always a valid
  // absolute URL.
  define: { 'import.meta.url': 'document.baseURI' },
  // The host (main.js) loads this bundle via `(0, eval)(code)`. Because the
  // bundle is strict-mode ("use strict" above), a strict eval gives its `var`
  // declarations their OWN scope — so `var ObsidiPdfEditor = ...` does NOT leak
  // to globalThis. Self-register explicitly: this footer runs in the bundle's
  // own top-level scope (where the var IS visible) and pins it on globalThis,
  // which works regardless of how the bundle is loaded (eval / <script> / etc.).
  footer: { js: '\nif (typeof ObsidiPdfEditor !== "undefined") { globalThis.ObsidiPdfEditor = ObsidiPdfEditor; }' },
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[pdf-editor] watching...');
} else {
  await esbuild.build(options);
  console.log('[pdf-editor] build complete -> dist/pdf-editor.js');
}
