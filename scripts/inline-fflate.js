#!/usr/bin/env node
// Replaces the disk-loading loadFflate() in main.js with an inline-string
// version. fflate.umd.js (32 KB) gets baked into main.js so the plugin is
// self-contained — no separate file needed for Obsidian Sync to transfer
// (sync of plugin sub-folders/lib/ is unreliable on iOS).
//
// Run from obsidi-office/. Idempotent — running twice produces the
// same output (the regex matches both the disk-loading and inlined forms).

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.join(ROOT, "main.js");
const FFLATE = path.join(ROOT, "lib", "fflate.umd.js");

const fflateCode = fs.readFileSync(FFLATE, "utf-8");
const fflateJson = JSON.stringify(fflateCode);
console.log("[inline-fflate] fflate.umd.js source:", fflateCode.length, "bytes");
console.log("[inline-fflate] JSON literal:", fflateJson.length, "bytes");

// Replacement loadFflate body: uses the inlined string instead of vio.readText.
// We keep the same name and signature so callers don't need to change.
const NEW_BLOCK =
"// fflate UMD source — inlined here so the plugin is self-contained.\n" +
"// Obsidian Sync on iOS doesn't reliably sync plugin sub-folders (lib/),\n" +
"// so loading from disk via vio.readText was failing on iPad. Embedding\n" +
"// the source as a string sidesteps the sync limitation entirely.\n" +
"// Source: https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js\n" +
"const FFLATE_UMD_SOURCE = " + fflateJson + ";\n" +
"let _fflateCache = null;\n" +
"function loadFflate() {\n" +
"  if (_fflateCache) return _fflateCache;\n" +
"  const m = { exports: {} };\n" +
"  // eslint-disable-next-line no-new-func\n" +
"  new Function(\"module\", \"exports\", FFLATE_UMD_SOURCE)(m, m.exports);\n" +
"  if (!m.exports || typeof m.exports.unzipSync !== \"function\") {\n" +
"    throw new Error(\"fflate failed to expose unzipSync\");\n" +
"  }\n" +
"  _fflateCache = m.exports;\n" +
"  return m.exports;\n" +
"}";

let main = fs.readFileSync(MAIN_JS, "utf-8");

// Match either the disk-loading version OR a previous inlined version,
// from `// fflate is vendored as lib/fflate.umd.js.` (or an inline marker
// comment) all the way through the closing `}` of loadFflate.
const re =
  /\/\/ fflate (?:is vendored as lib\/fflate\.umd\.js\.|UMD source — inlined here)[\s\S]*?\nlet _fflateCache = null;[\s\S]*?\nasync function loadFflate\(plugin\) \{[\s\S]*?\n\}|\/\/ fflate UMD source — inlined here[\s\S]*?\nfunction loadFflate\(\) \{[\s\S]*?\n\}/;

if (!re.test(main)) {
  console.error("[inline-fflate] could not find loadFflate block to replace");
  console.error("[inline-fflate] (check that main.js still has the original async loadFflate(plugin) or the inlined sync version)");
  process.exit(1);
}

// Use a function replacement (not string) — string replacements have
// special meaning for $&, $1, etc, and fflate's minified code is full of $.
const updated = main.replace(re, () => NEW_BLOCK);

if (updated === main) {
  console.error("[inline-fflate] regex matched but produced no change");
  process.exit(1);
}

fs.writeFileSync(MAIN_JS, updated);
console.log("[inline-fflate] main.js updated:", main.length, "->", updated.length, "bytes");
