// Tiny static file server for the standalone Playwright validation. Serves the
// repo's pdf-editor/ dir so /test/standalone.html can load ../dist/pdf-editor.js,
// ./sample.pdf, ./pdfium.wasm and ./icons*.svg. Used only for local testing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..')); // pdf-editor/
const PORT = Number(process.argv[2] || 5599);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/test/standalone.html';
    const full = normalize(join(ROOT, p));
    if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      // SharedArrayBuffer not needed (direct PDFium engine), but harmless.
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end('not found: ' + (e && e.message));
  }
}).listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}`));
