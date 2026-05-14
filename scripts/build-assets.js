#!/usr/bin/env node
/* eslint-disable no-console */
//
// build-assets.js — produce a trimmed copy of the OnlyOffice
// assets bundle for the Obsidi-Office plugin.
//
// Inputs (full 455 MB bundle, expected to contain onlyoffice/ + x2t/):
//   --src <path>     source assets dir (default: deployed onlyobsidian-test)
//   --shim <path>    path to transport-shim.js to inline (default: this plugin's)
//   --mock <path>    path to mock-socket.js to substitute for socket.io (default: this plugin's)
//   --out <path>     output dir (default: ./dist/assets)
//   --top-fonts N    drop top-N largest numbered fonts (default: 20)
//   --keep-locales L,L  comma-separated locales to keep (default: en)
//   --no-clean       don't wipe output dir before building
//   --dry            list what would happen without doing it
//   --zip <path>     after building, package the output as a .zip at <path>
//                    (uses PowerShell Compress-Archive on win32, `zip` elsewhere;
//                     fflate-compatible standard zip format for runtime extraction)
//
// What it does:
//   1. Walks the source tree, copying everything that's NOT in DROP_PATHS
//      to the output dir. Drops are reported with byte counts.
//   2. Drops the top-N largest numbered fonts in onlyoffice/fonts/ (CJK
//      heuristic — the largest files are CJK by size signature).
//   3. Drops locale subdirs under documenteditor/main/locale/ except those
//      in --keep-locales.
//   4. Pre-patches editor HTML files (documenteditor/main/index.html and
//      index_loader.html) to inject the transport-shim <script> tag.
//      Uses *.original sibling files when present (clean source).
//   5. Replaces web-apps/vendor/socketio/socket.io.min.js with the contents
//      of --mock (this plugin's mock-socket.js).
//
// Output is a directory. Zip packaging is a separate step (B2.4).
//

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    src: null,
    shim: null,
    mock: null,
    x2tFonts: null,
    dictionaries: null,
    out: null,
    topFonts: 20,
    keepLocales: ["en"],
    clean: true,
    dry: false,
    zip: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--src":          args.src = next(); break;
      case "--shim":         args.shim = next(); break;
      case "--mock":         args.mock = next(); break;
      case "--x2t-fonts":    args.x2tFonts = next(); break;
      case "--dictionaries": args.dictionaries = next(); break;
      case "--out":          args.out = next(); break;
      case "--top-fonts":    args.topFonts = parseInt(next(), 10); break;
      case "--keep-locales": args.keepLocales = next().split(",").map(s => s.trim()).filter(Boolean); break;
      case "--no-clean":     args.clean = false; break;
      case "--dry":          args.dry = true; break;
      case "--zip":          args.zip = next(); break;
      case "--help": case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error("unknown arg:", a);
        process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  const usage = `Usage: node build-assets.js [options]

  --src <path>          source assets dir
  --shim <path>         transport-shim.js path
  --mock <path>         mock-socket.js path
  --x2t-fonts <path>    metric-only font subset dir for x2t (bundled as x2t-fonts/)
  --dictionaries <path> Hunspell dictionaries dir (bundled as dictionaries/)
  --out <path>          output dir (default ./dist/assets)
  --top-fonts N         drop top-N largest numbered fonts (default 20)
  --keep-locales a,b    locales to keep under documenteditor/main/locale/ (default en)
  --no-clean            don't wipe output dir first
  --dry                 print what would happen, do nothing
  -h, --help            this message`;
  console.log(usage);
}

// ---------------------------------------------------------------------------
// Drop list — paths relative to the source dir root.
// Forward slashes; we'll normalize.
// ---------------------------------------------------------------------------

const DROP_PATHS = [
  "onlyoffice/web-apps/apps/documenteditor/main/resources/help",
  "onlyoffice/web-apps/apps/documenteditor/main/ie",
  "onlyoffice/web-apps/apps/documenteditor/forms",
  "onlyoffice/web-apps/apps/documenteditor/embed",
  "onlyoffice/web-apps/apps/visioeditor",
  "onlyoffice/web-apps/vendor/monaco",
  "onlyoffice/sdkjs/visio",
  "onlyoffice/sdkjs/pdf",
];

const LOCALE_PARENT = "onlyoffice/web-apps/apps/documenteditor/main/locale";

const FONTS_DIR = "onlyoffice/fonts";

const HTML_TO_PATCH = [
  "onlyoffice/web-apps/apps/documenteditor/main/index.html",
  "onlyoffice/web-apps/apps/documenteditor/main/index_loader.html",
];

const SOCKET_IO_REL = "onlyoffice/web-apps/vendor/socketio/socket.io.min.js";

// Sentinel injected into pre-patched HTML so we can detect tampering at
// runtime if needed. Distinct from the runtime AssetPatcher sentinels.
const PREPATCH_SENTINEL = "<!-- obsidi-office-prepatched -->";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function rel(root, abs) {
  return toPosix(path.relative(root, abs));
}

function isUnder(child, parent) {
  // both forward-slash normalized, no trailing slash
  return child === parent || child.startsWith(parent + "/");
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function listFontsBySize(fontsDirAbs) {
  if (!fs.existsSync(fontsDirAbs)) return [];
  return fs.readdirSync(fontsDirAbs, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => ({ name: e.name, size: fs.statSync(path.join(fontsDirAbs, e.name)).size }))
    .sort((a, b) => b.size - a.size);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function rmrf(d) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pre-patcher
// ---------------------------------------------------------------------------

// HTML lives at:    onlyoffice/web-apps/apps/documenteditor/main/index.html
// Shim will live at: docx-viewer/transport-shim.js (one level above onlyoffice/)
// From main/, that's ../../../../../docx-viewer/transport-shim.js (5 ups).
function shimHrefFromHtml(htmlRel) {
  const htmlDir = path.posix.dirname(htmlRel);
  // shim lives at docx-viewer/transport-shim.js (sibling of onlyoffice/ in
  // the assets root)
  const shimAtRoot = "docx-viewer/transport-shim.js";
  return path.posix.relative(htmlDir, shimAtRoot);
}

function prepatchHtml(srcContent, htmlRel) {
  if (srcContent.indexOf(PREPATCH_SENTINEL) !== -1) {
    return { content: srcContent, alreadyPatched: true };
  }
  const headRe = /<head[^>]*>/i;
  const m = srcContent.match(headRe);
  if (!m) throw new Error("no <head> in " + htmlRel);
  const shimHref = shimHrefFromHtml(htmlRel);
  const inject =
    "\n" + PREPATCH_SENTINEL +
    '\n<script src="' + shimHref + '"></script>\n';
  const idx = m.index + m[0].length;
  return {
    content: srcContent.slice(0, idx) + inject + srcContent.slice(idx),
    alreadyPatched: false,
    shimHref: shimHref,
  };
}

// Strip any prior runtime-patcher injections (sentinels + their script tags)
// so the build is deterministic regardless of source dev state.
function stripRuntimePatches(html) {
  const sentinels = [
    "<!-- onlyobsidian-test-shim-injected -->",
    "<!-- onlyobsidian-mobile-shim-injected -->",
  ];
  for (const sent of sentinels) {
    const re = new RegExp(
      "\\n?" + sent.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") +
      "[\\s\\S]*?<script src=\"[^\"]*transport-shim\\.js\"><\\/script>\\n?",
      "g"
    );
    html = html.replace(re, "");
  }
  // Also strip the runtime debug stub if it leaked in
  html = html.replace(/<script>window\.__OO_TEST_DEBUG = true;<\/script>\n?/g, "");
  return html;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

class Stats {
  constructor() {
    this.copiedBytes = 0;
    this.copiedFiles = 0;
    this.dropped = []; // [{path, bytes, reason}]
  }
  addCopy(bytes) { this.copiedBytes += bytes; this.copiedFiles += 1; }
  addDrop(p, bytes, reason) { this.dropped.push({ path: p, bytes, reason }); }
  totalDropped() { return this.dropped.reduce((s, d) => s + d.bytes, 0); }
  reportByReason() {
    const byReason = {};
    for (const d of this.dropped) {
      byReason[d.reason] = (byReason[d.reason] || 0) + d.bytes;
    }
    return byReason;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function build(args) {
  const stats = new Stats();
  const dropPathsSet = new Set(DROP_PATHS);

  // Pre-compute font drop list
  const fontsAbs = path.join(args.src, FONTS_DIR);
  const fontsBySize = listFontsBySize(fontsAbs);
  const fontDropSet = new Set(fontsBySize.slice(0, args.topFonts).map(f => FONTS_DIR + "/" + f.name));
  console.log(`[fonts] dropping top ${args.topFonts} of ${fontsBySize.length} numbered fonts (saves ${fmtBytes(fontsBySize.slice(0, args.topFonts).reduce((s, f) => s + f.size, 0))})`);

  // Read the mock-socket content once
  let mockContent = null;
  if (fs.existsSync(args.mock)) {
    mockContent = fs.readFileSync(args.mock);
    console.log(`[mock] using ${args.mock} (${fmtBytes(mockContent.length)})`);
  } else {
    console.warn(`[mock] not found at ${args.mock} — socket.io will be copied verbatim (BAD for runtime)`);
  }

  // Walk + copy
  function walk(srcDir, outDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const outPath = path.join(outDir, entry.name);
      const relPath = rel(args.src, srcPath);

      // 1. Drop list
      let dropReason = null;
      for (const dp of dropPathsSet) {
        if (isUnder(relPath, dp)) { dropReason = "drop-list:" + dp; break; }
      }

      // 2. Locale filter — locale/ contains <locale>.json files (en.json,
      //    pt-pt.json, zh-tw.json, ...). Strip the .json suffix to compare
      //    against keepLocales.
      if (!dropReason && isUnder(relPath, LOCALE_PARENT) && relPath !== LOCALE_PARENT) {
        const after = relPath.slice(LOCALE_PARENT.length + 1);
        const firstSeg = after.split("/")[0];
        const localeName = firstSeg.replace(/\.json$/i, "");
        if (!args.keepLocales.includes(localeName)) {
          dropReason = "locale:" + localeName;
        }
      }

      // 3. Font filter
      if (!dropReason && fontDropSet.has(relPath)) {
        dropReason = "font-top-N";
      }

      if (dropReason) {
        const sz = entry.isDirectory() ? dirSize(srcPath) : fs.statSync(srcPath).size;
        stats.addDrop(relPath, sz, dropReason);
        if (!args.dry) {
          // Don't copy this entry. If a directory, the entire tree is skipped.
        }
        continue;
      }

      // Copy/recurse
      if (entry.isDirectory()) {
        if (!args.dry) ensureDir(outPath);
        walk(srcPath, outPath);
      } else if (entry.isFile()) {
        if (args.dry) {
          stats.addCopy(fs.statSync(srcPath).size);
          continue;
        }
        // Special handling for files we transform during copy
        if (HTML_TO_PATCH.includes(relPath)) {
          // Prefer .original if it exists (clean source)
          const srcReadPath = fs.existsSync(srcPath + ".original") ? srcPath + ".original" : srcPath;
          let html = fs.readFileSync(srcReadPath, "utf-8");
          html = stripRuntimePatches(html);
          const r = prepatchHtml(html, relPath);
          fs.writeFileSync(outPath, r.content, "utf-8");
          stats.addCopy(Buffer.byteLength(r.content, "utf-8"));
          console.log(`[patch] ${relPath} -> shim ${r.shimHref}`);
          continue;
        }
        if (relPath === SOCKET_IO_REL && mockContent) {
          fs.writeFileSync(outPath, mockContent);
          stats.addCopy(mockContent.length);
          console.log(`[mock] ${relPath} replaced with mock-socket.js`);
          continue;
        }
        // Skip .original sidecar files (they were used during pre-patch above)
        if (entry.name.endsWith(".original")) {
          stats.addDrop(relPath, fs.statSync(srcPath).size, "original-backup");
          continue;
        }
        // Plain copy
        fs.copyFileSync(srcPath, outPath);
        stats.addCopy(fs.statSync(srcPath).size);
      }
    }
  }

  if (args.clean && !args.dry) rmrf(args.out);
  if (!args.dry) ensureDir(args.out);

  // Walk children of src so we don't recreate the parent
  for (const entry of fs.readdirSync(args.src, { withFileTypes: true })) {
    const srcPath = path.join(args.src, entry.name);
    const outPath = path.join(args.out, entry.name);
    if (entry.isDirectory()) {
      if (!args.dry) ensureDir(outPath);
      walk(srcPath, outPath);
    } else if (entry.isFile()) {
      if (args.dry) {
        stats.addCopy(fs.statSync(srcPath).size);
      } else {
        fs.copyFileSync(srcPath, outPath);
        stats.addCopy(fs.statSync(srcPath).size);
      }
    }
  }

  // Also copy the docx-viewer dir (transport-shim + mock-socket) into the
  // bundle so the pre-patched HTML's <script src="../../../../../docx-viewer/transport-shim.js">
  // resolves at runtime. The shim and mock are dependency-free and tiny.
  if (!args.dry) {
    const dvOut = path.join(args.out, "docx-viewer");
    ensureDir(dvOut);
    if (args.shim && fs.existsSync(args.shim)) {
      const dst = path.join(dvOut, "transport-shim.js");
      fs.copyFileSync(args.shim, dst);
      stats.addCopy(fs.statSync(dst).size);
      console.log(`[bundle] docx-viewer/transport-shim.js (from ${args.shim})`);
    }
    if (args.mock && fs.existsSync(args.mock)) {
      const dst = path.join(dvOut, "mock-socket.js");
      fs.copyFileSync(args.mock, dst);
      stats.addCopy(fs.statSync(dst).size);
      console.log(`[bundle] docx-viewer/mock-socket.js (from ${args.mock})`);
    }

    // Copy x2t-fonts/ — metric-only TTF subsets that x2t reads at conversion
    // time. Written to bundle root so the runtime path matches
    //   pluginDir/assets/x2t-fonts/
    // (set by the plugin's X2tConverter constructor as fontsRel).
    if (args.x2tFonts && fs.existsSync(args.x2tFonts)) {
      const xfOut = path.join(args.out, "x2t-fonts");
      ensureDir(xfOut);
      let xfCount = 0;
      let xfBytes = 0;
      for (const entry of fs.readdirSync(args.x2tFonts, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.tt[fc]$/i.test(entry.name)) continue;
        const src = path.join(args.x2tFonts, entry.name);
        const dst = path.join(xfOut, entry.name);
        fs.copyFileSync(src, dst);
        const sz = fs.statSync(dst).size;
        stats.addCopy(sz);
        xfCount++;
        xfBytes += sz;
      }
      console.log(`[bundle] x2t-fonts/ ${xfCount} files, ${fmtBytes(xfBytes)} (from ${args.x2tFonts})`);
    } else if (args.x2tFonts) {
      console.warn(`[x2t-fonts] not found at ${args.x2tFonts} — skipping (x2t will fall back to system fonts on desktop / internal defaults on mobile)`);
    }

    // Copy dictionaries/ — Hunspell .aff/.dic files for OnlyOffice spellcheck.
    // Subfolders by language code (en_US, en_CA, ...). Bundle root path
    // is dictionaries/<lang>/<lang>.{aff,dic} — matches the runtime layout
    // the plugin expects under <plugin>/assets/dictionaries/.
    if (args.dictionaries && fs.existsSync(args.dictionaries)) {
      const dictOut = path.join(args.out, "dictionaries");
      ensureDir(dictOut);
      let dCount = 0;
      let dBytes = 0;
      const walkDicts = (srcDir, relPrefix) => {
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
          const src = path.join(srcDir, entry.name);
          const dstRel = relPrefix ? relPrefix + "/" + entry.name : entry.name;
          const dst = path.join(dictOut, dstRel);
          if (entry.isDirectory()) {
            ensureDir(dst);
            walkDicts(src, dstRel);
          } else if (entry.isFile() && /\.(aff|dic)$/i.test(entry.name)) {
            fs.copyFileSync(src, dst);
            const sz = fs.statSync(dst).size;
            stats.addCopy(sz);
            dCount++;
            dBytes += sz;
          }
        }
      };
      walkDicts(args.dictionaries, "");
      console.log(`[bundle] dictionaries/ ${dCount} files, ${fmtBytes(dBytes)} (from ${args.dictionaries})`);
    } else if (args.dictionaries) {
      console.warn(`[dictionaries] not found at ${args.dictionaries} — skipping (spellcheck will fall back to disabled)`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Defaults pinned to this dev environment
  const here = path.resolve(__dirname);
  const pluginRoot = path.dirname(here); // onlyobsidian-test/
  const projectRoot = path.dirname(pluginRoot); // P21_OnlyOffice/
  if (!args.src) {
    args.src = "C:\\Obsidian\\OB_Testing\\.obsidian\\plugins\\onlyobsidian-test\\assets";
  }
  if (!args.shim) {
    args.shim = path.join(pluginRoot, "assets", "docx-viewer", "transport-shim.js");
  }
  if (!args.mock) {
    args.mock = path.join(pluginRoot, "assets", "docx-viewer", "mock-socket.js");
  }
  if (!args.x2tFonts) {
    args.x2tFonts = path.join(pluginRoot, "assets", "x2t-fonts");
  }
  if (!args.dictionaries) {
    args.dictionaries = path.join(pluginRoot, "assets", "dictionaries");
  }
  if (!args.out) {
    args.out = path.join(pluginRoot, "dist", "assets");
  }

  console.log("== build-assets ==");
  console.log("src:        ", args.src);
  console.log("shim:       ", args.shim);
  console.log("mock:       ", args.mock);
  console.log("x2tFonts:   ", args.x2tFonts);
  console.log("dicts:      ", args.dictionaries);
  console.log("out:        ", args.out);
  console.log("topFonts:   ", args.topFonts);
  console.log("keepLocales:", args.keepLocales.join(","));
  console.log("dry:        ", args.dry);
  console.log("");

  if (!fs.existsSync(args.src)) {
    console.error("source dir not found:", args.src);
    process.exit(1);
  }

  const t0 = Date.now();
  const stats = build(args);
  const ms = Date.now() - t0;

  console.log("");
  console.log("== summary ==");
  console.log("copied:    ", stats.copiedFiles, "files,", fmtBytes(stats.copiedBytes));
  console.log("dropped:   ", stats.dropped.length, "entries,", fmtBytes(stats.totalDropped()));
  const byReason = stats.reportByReason();
  for (const r of Object.keys(byReason).sort()) {
    console.log("  by", r + ":", fmtBytes(byReason[r]));
  }
  console.log("elapsed:   ", ms + "ms");
  if (!args.dry) console.log("output:    ", args.out);

  if (args.zip && !args.dry) {
    zipDir(args.out, args.zip);
  }
}

// Zip via fflate — produces standard forward-slash paths regardless of
// host OS, so the resulting archive extracts cleanly on iPad/Mac/Linux.
// (PowerShell's Compress-Archive on Windows uses backslashes, which breaks
// runtime extraction on every other platform.)
function zipDir(srcDir, zipPath) {
  const fflate = require(path.join(__dirname, "..", "lib", "fflate.umd.js"));
  try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
  ensureDir(path.dirname(zipPath));

  const t0 = Date.now();
  // Walk srcDir, collect {posixPath: Uint8Array}. Skip directory entries —
  // fflate creates them implicitly and runtime extractors handle missing
  // directory entries fine.
  const entries = {};
  const walk = (real, prefix) => {
    for (const e of fs.readdirSync(real, { withFileTypes: true })) {
      const full = path.join(real, e.name);
      const key = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) walk(full, key);
      else if (e.isFile()) entries[key] = new Uint8Array(fs.readFileSync(full));
    }
  };
  walk(srcDir, "");

  const zipped = fflate.zipSync(entries, { level: 6 });
  fs.writeFileSync(zipPath, Buffer.from(zipped));

  const ms = Date.now() - t0;
  const size = fs.statSync(zipPath).size;
  console.log("");
  console.log("== zip ==");
  console.log("file:    ", zipPath);
  console.log("size:    ", fmtBytes(size));
  console.log("entries: ", Object.keys(entries).length);
  console.log("elapsed: ", ms + "ms");
}

main();
