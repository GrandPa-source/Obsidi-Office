#!/usr/bin/env node
/*
 * OnlyObsidian Test — setup script
 *
 * Copies the OnlyOffice + x2t asset trees from your existing
 * obsidian-docx-viewer plugin into the onlyobsidian-test plugin.
 *
 * Run from inside the .obsidian/plugins/onlyobsidian-test/ directory:
 *
 *   node setup.js
 *
 * Or from anywhere:
 *
 *   node /path/to/onlyobsidian-test/setup.js
 *
 * Optional: pass the source plugin path as an argument:
 *
 *   node setup.js /custom/path/to/obsidian-docx-viewer
 */

const fs   = require("fs");
const path = require("path");

const SCRIPT_DIR = __dirname;
const TARGET_ASSETS = path.join(SCRIPT_DIR, "assets");
const TARGET_OO  = path.join(TARGET_ASSETS, "onlyoffice");
const TARGET_X2T = path.join(TARGET_ASSETS, "x2t");

function log(s)  { console.log("[setup] " + s); }
function err(s)  { console.error("[setup] ERROR: " + s); }
function bytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function findSource(argSrc) {
  // 1. Explicit argument
  if (argSrc) {
    const candidate = path.resolve(argSrc);
    if (validateSource(candidate)) return candidate;
    err("Path provided as argument does not contain assets/onlyoffice and assets/x2t: " + candidate);
    process.exit(1);
  }

  // 2. Sibling directory ../obsidian-docx-viewer (most common case —
  //    both plugins installed in the same .obsidian/plugins/ folder)
  const sibling = path.resolve(SCRIPT_DIR, "..", "obsidian-docx-viewer");
  if (validateSource(sibling)) return sibling;

  // 3. Walk up from current dir looking for any plugins directory
  //    that contains obsidian-docx-viewer
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".obsidian", "plugins", "obsidian-docx-viewer");
    if (validateSource(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function validateSource(srcRoot) {
  if (!dirExists(srcRoot)) return false;
  if (!dirExists(path.join(srcRoot, "assets", "onlyoffice"))) return false;
  if (!dirExists(path.join(srcRoot, "assets", "x2t"))) return false;
  if (!fileExists(path.join(srcRoot, "assets", "x2t", "x2t.js"))) return false;
  if (!fileExists(path.join(srcRoot, "assets", "x2t", "x2t.wasm"))) return false;
  return true;
}

function copyDir(src, dst) {
  if (!dirExists(dst)) fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  let count = 0, total = 0;
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDir(s, d);
      count += sub.count;
      total += sub.total;
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      count++;
      try { total += fs.statSync(d).size; } catch (e) {}
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy the target
      try {
        const target = fs.readlinkSync(s);
        fs.symlinkSync(target, d);
        count++;
      } catch (e) { /* skip broken links */ }
    }
  }
  return { count, total };
}

function main() {
  log("OnlyObsidian Test setup");
  log("script dir: " + SCRIPT_DIR);

  // Validate target plugin install
  if (!fileExists(path.join(SCRIPT_DIR, "manifest.json"))) {
    err("manifest.json not found. Run setup.js from inside the onlyobsidian-test plugin directory.");
    process.exit(1);
  }

  const srcRoot = findSource(process.argv[2]);
  if (!srcRoot) {
    err("Could not find obsidian-docx-viewer plugin with assets.");
    err("Tried:");
    err("  1. argument: " + (process.argv[2] || "(not provided)"));
    err("  2. sibling:  " + path.resolve(SCRIPT_DIR, "..", "obsidian-docx-viewer"));
    err("  3. ascending walk for .obsidian/plugins/obsidian-docx-viewer");
    err("");
    err("Please re-run with the source path as argument:");
    err("  node setup.js /full/path/to/obsidian-docx-viewer");
    process.exit(1);
  }
  log("source: " + srcRoot);

  // Make sure target/assets exists
  if (!dirExists(TARGET_ASSETS)) fs.mkdirSync(TARGET_ASSETS, { recursive: true });

  // Copy onlyoffice tree
  const srcOO = path.join(srcRoot, "assets", "onlyoffice");
  if (dirExists(TARGET_OO)) {
    log("target assets/onlyoffice/ already exists — skipping (delete it first to re-copy)");
  } else {
    log("copying assets/onlyoffice/ ... (this is the slow part, ~80-400 MB)");
    const t0 = Date.now();
    const r = copyDir(srcOO, TARGET_OO);
    log("  copied " + r.count + " files (" + bytes(r.total) + ") in " +
        ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }

  // Copy x2t tree
  const srcX2T = path.join(srcRoot, "assets", "x2t");
  if (dirExists(TARGET_X2T)) {
    log("target assets/x2t/ already exists — skipping");
  } else {
    log("copying assets/x2t/ ...");
    const t0 = Date.now();
    const r = copyDir(srcX2T, TARGET_X2T);
    log("  copied " + r.count + " files (" + bytes(r.total) + ") in " +
        ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }

  // Verify shim + mock-socket are present (shipped with the plugin)
  const shimDir = path.join(TARGET_ASSETS, "docx-viewer");
  const shimFile = path.join(shimDir, "transport-shim.js");
  const mockFile = path.join(shimDir, "mock-socket.js");
  if (!fileExists(shimFile) || !fileExists(mockFile)) {
    err("transport-shim.js or mock-socket.js missing from assets/docx-viewer/.");
    err("These should have shipped with this plugin. Re-extract the zip.");
    process.exit(1);
  }

  log("");
  log("done. Final structure:");
  log("  " + TARGET_ASSETS);
  log("  ├── docx-viewer/");
  log("  │   ├── transport-shim.js");
  log("  │   └── mock-socket.js");
  log("  ├── onlyoffice/   (copied)");
  log("  └── x2t/          (copied)");
  log("");
  log("Now reload Obsidian (Ctrl/Cmd+R) and enable 'OnlyObsidian Test' in");
  log("Settings -> Community plugins.");
}

main();
