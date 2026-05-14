#!/usr/bin/env node
// Bakes pdf-lib UMD source into main.js as a JSON-stringified constant.
// Same rationale as inline-fflate.js: Obsidian Sync on iOS does not reliably
// transfer plugin sub-folders (lib/), so vio.readText("lib/pdf-lib.min.js")
// fails on iPad. Inlining keeps the plugin self-contained — main.js +
// manifest.json are the only files Obsidian Sync needs to transfer.
//
// Run from onlyobsidian-test/. Idempotent — running twice produces the
// same output (the regex matches both fresh-insert and previously-inlined
// forms).
//
// Inserts the PDFLIB block AFTER the inlined fflate block when no prior
// pdf-lib block exists, keyed off the closing brace of loadFflate().

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.join(ROOT, "main.js");
const PDFLIB = path.join(ROOT, "lib", "pdf-lib.min.js");

const pdfLibCode = fs.readFileSync(PDFLIB, "utf-8");
const pdfLibJson = JSON.stringify(pdfLibCode);
console.log("[inline-pdflib] pdf-lib.min.js source:", pdfLibCode.length, "bytes");
console.log("[inline-pdflib] JSON literal:", pdfLibJson.length, "bytes");

const NEW_BLOCK =
"// ===========================================================================\n" +
"// pdf-lib loader (lazy)\n" +
"// ===========================================================================\n" +
"// pdf-lib UMD source — inlined here so the plugin is self-contained.\n" +
"// Obsidian Sync on iOS doesn't reliably sync plugin sub-folders (lib/),\n" +
"// so loading from disk via vio.readText was failing on iPad. Embedding\n" +
"// the source as a string sidesteps the sync limitation entirely.\n" +
"// Source: lib/pdf-lib.min.js (vendored from pdf-lib npm package).\n" +
"const PDFLIB_UMD_SOURCE = " + pdfLibJson + ";\n" +
"let _pdfLibCache = null;\n" +
"function loadPdfLib() {\n" +
"  if (_pdfLibCache) return _pdfLibCache;\n" +
"  const sandbox = { exports: {}, module: { exports: {} } };\n" +
"  // eslint-disable-next-line no-new-func\n" +
"  new Function(\"module\", \"exports\", PDFLIB_UMD_SOURCE)(sandbox.module, sandbox.module.exports);\n" +
"  const lib = sandbox.module.exports;\n" +
"  if (!lib || !lib.PDFDocument) {\n" +
"    throw new Error(\"pdf-lib failed to expose PDFDocument\");\n" +
"  }\n" +
"  _pdfLibCache = lib;\n" +
"  return lib;\n" +
"}\n";

let main = fs.readFileSync(MAIN_JS, "utf-8");

// Match a previously-inlined pdf-lib block (from the H1 comment through the
// closing brace of loadPdfLib). Anchored on PDFLIB_UMD_SOURCE so we don't
// accidentally match anything else. Uses \r?\n to handle CRLF (Windows).
const existingRe =
  /\/\/ ={10,}\r?\n\/\/ pdf-lib loader \(lazy\)[\s\S]*?\r?\nconst PDFLIB_UMD_SOURCE = [\s\S]*?\r?\nlet _pdfLibCache = null;[\s\S]*?\r?\nfunction loadPdfLib\(\) \{[\s\S]*?\r?\n\}\r?\n/;

let updated;
if (existingRe.test(main)) {
  // Replace existing block. Use function replacement to avoid $-substitution.
  updated = main.replace(existingRe, () => NEW_BLOCK);
  console.log("[inline-pdflib] replaced existing PDFLIB block");
} else {
  // Insert after the closing brace of loadFflate(). Anchor on the unique
  // last two lines of the function: `  return m.exports;\n}` so we don't
  // accidentally match an inner `}`.
  const fflateEndRe = /(function loadFflate\(\)[\s\S]*?return m\.exports;\r?\n\})\r?\n/;
  if (!fflateEndRe.test(main)) {
    console.error("[inline-pdflib] could not find loadFflate() to anchor insertion after");
    process.exit(1);
  }
  updated = main.replace(fflateEndRe, (m, body) => body + "\n\n" + NEW_BLOCK);
  console.log("[inline-pdflib] inserted PDFLIB block after loadFflate()");
}

if (updated === main) {
  console.error("[inline-pdflib] regex matched but produced no change");
  process.exit(1);
}

fs.writeFileSync(MAIN_JS, updated);
console.log("[inline-pdflib] main.js updated:", main.length, "->", updated.length, "bytes");
