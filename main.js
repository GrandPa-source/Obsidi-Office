/* eslint-disable */
/*
 * OnlyObsidian Test plugin
 *
 * Localhost-free OnlyOffice integration for Obsidian. Replaces the
 * loopback HTTP server (DocxServer) in the original obsidian-docx-viewer
 * with an in-process postMessage bridge between the editor iframe and
 * the plugin.
 *
 * On load the plugin:
 *   1. Locates assets/onlyoffice/ and assets/x2t/ inside the plugin dir
 *   2. Patches OnlyOffice editor entry HTMLs (idempotent) to inject
 *      transport-shim.js as the first <script> in <head>
 *   3. Replaces web-apps/vendor/socketio/socket.io.min.js with the mock
 *      (idempotent; backups originals as *.original)
 *   4. Initialises x2t (WASM) and the TransportBridge
 *   5. Registers a FileView for .docx files
 *
 * Open a .docx file -> view reads the bytes -> x2t -> Editor.bin +
 * media -> registered with bridge -> view creates iframe pointing at
 * api.js (via file://) -> api.js loads the OnlyOffice editor -> shim
 * intercepts the editor's HTTP requests over postMessage.
 */

"use strict";

const obsidian = require("obsidian");
const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

// ===========================================================================
// Constants
// ===========================================================================

const VIEW_TYPE = "onlyobsidian-test-docx";
const SHIM_SENTINEL = "<!-- onlyobsidian-test-shim-injected -->";

// HTML entry files in the OnlyOffice tree that need the shim injected.
// Only documenteditor/main/* is required for .docx desktop editing.
const EDITOR_ENTRY_FILES = [
  "web-apps/apps/documenteditor/main/index.html",
  "web-apps/apps/documenteditor/main/index_loader.html",
];

// The mock socket replaces this exact file
const SOCKET_IO_RELATIVE = "web-apps/vendor/socketio/socket.io.min.js";

const DOCX_EXTENSIONS = ["docx"];

// Minimal blank .docx (Arial 12pt, Letter, 1" margins)
const BLANK_DOCX_BASE64 = 'UEsDBBQAAAAIACF7ilzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgAIXuKXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgAIXuKXATyCbj8AAAAmgEAABEAAAB3b3JkL2RvY3VtZW50LnhtbEVQQW7DIBC85xWIe4NjuVVkBUe55FapUtsHEExsJGARS+Omr+8SO8mFnZldZlh2+1/v2MUktBAk36wrzkzQ0NswSP79dXzZcoZZhV45CEbyq0G+71a7qe1B/3gTMiOHgO0k+ZhzbIVAPRqvcA3RBOqdIXmViaZBTJD6mEAbRArwTtRV9Sa8soF3K8bI9QT9tcAbiV05PlIpaSlHCBnZ1CrU1kp+SFY5Tnw8BHxwUUbxj+SLcpLXTVHEYiIWz1IfUWh0nhPi8Fku0j6bum6qmzfh1y1hMQ+8q0Rqhkh6M48kO4z5SU+QM/gnd+Z8784vWfLK0uK+dUH3X+3+AVBLAwQUAAAACAAhe4pc1eog13kAAACOAAAAHAAAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNNjEEOwiAQAO99Bdm7BT0YY0p76wOMPmBDV2iEhbDE6O/l6HEymZmWT4rqTVX2zBaOowFF7PK2s7fwuK+HCyhpyBvGzGThSwLLPEw3ith6I2EvovqExUJorVy1FhcooYy5EHfzzDVh61i9Luhe6EmfjDnr+v8APQ8/UEsBAhQDFAAAAAgAIXuKXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAhe4pcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAhe4pcBPIJuPwAAACaAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwECFAMUAAAACAAhe4pc1eog13kAAACOAAAAHAAAAAAAAAAAAAAAgAEoAwAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc1BLBQYAAAAABAAEAAMBAADbAwAAAAA=';

const DEFAULT_SETTINGS = {
  defaultMode: "edit",
  debugLogging: true,
  autoSaveDelayMs: 1500,
  templateDir: "_docx-templates",
};

// ===========================================================================
// Logging
// ===========================================================================

let DEBUG = false;
function dlog() {
  if (!DEBUG) return;
  try { console.log.apply(console, ["[OnlyObsidian Test]"].concat([].slice.call(arguments))); } catch (e) {}
}
function elog() {
  try { console.error.apply(console, ["[OnlyObsidian Test]"].concat([].slice.call(arguments))); } catch (e) {}
}

// ===========================================================================
// X2tConverter — WASM DOCX <-> Editor.bin
// (Adapted minimally from obsidian-docx-viewer to run in-process)
// ===========================================================================

class X2tConverter {
  constructor(x2tDir, fontsDir) {
    this.x2tDir   = x2tDir;
    this.fontsDir = fontsDir;
    this.module   = null;
    this.initP    = null;
  }

  async ensureInit() {
    if (this.module && this.module.FS) return;
    if (!this.initP) this.initP = this._init();
    await this.initP;
  }

  _init() {
    return new Promise((resolve, reject) => {
      const x2tJsPath   = path.join(this.x2tDir, "x2t.js");
      const x2tWasmPath = path.join(this.x2tDir, "x2t.wasm");
      if (!fs.existsSync(x2tJsPath) || !fs.existsSync(x2tWasmPath)) {
        reject(new Error("x2t assets missing. Expected at: " + this.x2tDir));
        return;
      }
      const wasmBinary = fs.readFileSync(x2tWasmPath);
      globalThis.Module = {
        noInitialRun:   true,
        noExitRuntime:  true,
        wasmBinary:     wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength),
        locateFile: (file) => {
          if (file.endsWith(".wasm")) return x2tWasmPath;
          return path.join(this.x2tDir, file);
        },
        onRuntimeInitialized: () => {
          this.module = globalThis.Module;
          try { this._setupVFS(); resolve(); }
          catch (err) { reject(err); }
        },
      };
      try {
        const code = fs.readFileSync(x2tJsPath, "utf-8");
        // eslint-disable-next-line no-eval
        (0, eval)(code);
      } catch (err) {
        reject(new Error("Failed to load x2t.js: " + err.message));
      }
    });
  }

  _setupVFS() {
    const FS = this.module.FS;
    if (!FS) throw new Error("x2t FS missing after init");
    this._mkdir(FS, "/working");
    this._mkdir(FS, "/working/media");
    this._mkdir(FS, "/working/fonts");
    this._mkdir(FS, "/working/themes");
    this._loadFonts(FS);
  }

  _mkdir(FS, dir) {
    try { FS.mkdir(dir); } catch (e) { /* ignore EEXIST */ }
  }

  _loadFonts(FS) {
    if (!fs.existsSync(this.fontsDir)) {
      dlog("fonts dir not present, skipping:", this.fontsDir);
      return;
    }
    let loaded = 0;
    const limit = 150; // System font dirs have ~130 .ttf/.ttc files on Windows
    const walk = (real, vfs) => {
      if (loaded >= limit) return;
      let entries;
      try { entries = fs.readdirSync(real, { withFileTypes: true }); }
      catch (e) { return; }
      for (const entry of entries) {
        if (loaded >= limit) return;
        const r = path.join(real, entry.name);
        const v = vfs + "/" + entry.name;
        if (entry.isDirectory()) {
          this._mkdir(FS, v);
          walk(r, v);
        } else if (/\.tt[fc]$/i.test(entry.name)) {
          try {
            const data = fs.readFileSync(r);
            FS.writeFile(v, new Uint8Array(data));
            loaded++;
          } catch (e) { /* skip */ }
        }
      }
    };
    walk(this.fontsDir, "/working/fonts");
    dlog("loaded", loaded, "fonts into VFS");
  }

  async docxToEditorBin(docxBytes) {
    await this.ensureInit();
    return this._convert("doc.docx", docxBytes, "Editor.bin");
  }
  async editorBinToDocx(editorBin, mediaMap) {
    await this.ensureInit();
    const r = this._convert("Editor.bin", editorBin, "output.docx", mediaMap);
    return r.editorBin;
  }

  _convert(inputName, inputBytes, outputName, media) {
    const FS    = this.module.FS;
    const ccall = this.module.ccall;
    if (!FS || !ccall) throw new Error("x2t module not initialised");
    const inputPath  = "/working/" + inputName;
    const outputPath = "/working/" + outputName;
    const paramsPath = "/working/params.xml";

    FS.writeFile(inputPath, inputBytes);
    if (media) {
      for (const [name, bytes] of media) {
        FS.writeFile("/working/media/" + name, new Uint8Array(bytes));
      }
    }
    const paramsXml = `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <m_sFileFrom>${inputPath}</m_sFileFrom>
  <m_sFileTo>${outputPath}</m_sFileTo>
  <m_sThemeDir>/working/themes</m_sThemeDir>
  <m_sFontDir>/working/fonts/</m_sFontDir>
  <m_bIsNoBase64>false</m_bIsNoBase64>
</TaskQueueDataConvert>`;
    FS.writeFile(paramsPath, paramsXml);

    const code = ccall("main1", "number", ["string"], [paramsPath]);
    let outBytes = new Uint8Array();
    const outMedia = new Map();
    if (code === 0) {
      try { outBytes = FS.readFile(outputPath); } catch (e) {}
      try {
        const files = FS.readdir("/working/media/").filter(f => f !== "." && f !== "..");
        for (const f of files) {
          try { outMedia.set(f, FS.readFile("/working/media/" + f)); } catch (e) {}
        }
      } catch (e) {}
    } else {
      throw new Error("x2t conversion failed (code " + code + ")");
    }

    [inputPath, outputPath, paramsPath].forEach(p => { try { FS.unlink(p); } catch (e) {} });
    try {
      const mFiles = FS.readdir("/working/media/").filter(f => f !== "." && f !== "..");
      for (const f of mFiles) { try { FS.unlink("/working/media/" + f); } catch (e) {} }
    } catch (e) {}

    return { editorBin: outBytes, media: outMedia };
  }
}

// ===========================================================================
// TransportBridge — replaces DocxServer
// ===========================================================================

class TransportBridge {
  constructor(opts) {
    this.converter = opts.converter;
    this.onSave    = opts.onSave || (async () => {});
    this._fontsDir = opts.fontsDir || "";
    this.docs      = new Map();
    this.saveBufs  = new Map();
    this.attached  = false;
    this._handler  = (ev) => this._onMessage(ev);
  }

  attach(win) {
    if (this.attached) return;
    win.addEventListener("message", this._handler);
    this.attached = true;
  }
  detach(win) {
    if (!this.attached) return;
    win.removeEventListener("message", this._handler);
    this.attached = false;
  }

  registerDocument(docKey, filePath, editorBin, media) {
    this.docs.set(docKey, { filePath, editorBin, media: media || new Map() });
    dlog("registered docKey:", docKey, "filePath:", filePath, "bin bytes:", editorBin.byteLength);
  }
  removeDocument(docKey) {
    this.docs.delete(docKey);
    dlog("removed docKey:", docKey);
  }

  async _onMessage(ev) {
    const d = ev.data;
    if (!d || d.__shim !== "docx-viewer") return;
    if (d.type === "shim-ready") {
      dlog("shim-ready received for docKey:", d.docKey);
      return;
    }
    if (d.type !== "rpc-call") return;

    // Coexistence guard — silently ignore doc-specific RPCs whose docKey is
    // not registered with this bridge. Prevents race conditions when another
    // TransportBridge (e.g. a sibling fork during dev) is also listening on
    // window.message. Single-bridge production behavior is unchanged because
    // every iframe's docKey is registered before the iframe URL is set.
    const docMethods = ["getDocument", "getMediaManifest", "getMedia", "downloadAs", "upload"];
    if (docMethods.indexOf(d.method) !== -1 && !this.docs.has(d.docKey)) {
      return;
    }

    let payload;
    try {
      switch (d.method) {
        case "getDocument":      payload = await this._getDocument(d.docKey); break;
        case "getMediaManifest": payload = await this._getMediaManifest(d.docKey); break;
        case "getMedia":         payload = await this._getMedia(d.docKey, d.payload && d.payload.name); break;
        case "downloadAs":       payload = await this._downloadAs(d.docKey, d.payload); break;
        case "upload":           payload = await this._upload(d.docKey, d.payload); break;
        case "getFont":          payload = this._getFont(d.payload); break;
        default:
          dlog("unknown RPC method:", d.method);
          payload = { ok: false, error: "unknown method" };
      }
    } catch (err) {
      elog("RPC", d.method, "failed:", err);
      payload = { ok: false, error: String(err && err.message || err) };
    }
    const reply = { __shim: "docx-viewer", type: "rpc-reply", id: d.id, payload };
    try {
      const transfer = [];
      if (payload && payload.bytes instanceof ArrayBuffer) transfer.push(payload.bytes);
      ev.source.postMessage(reply, "*", transfer);
    } catch (e) {
      try { ev.source.postMessage(reply, "*"); } catch (e2) {}
    }
  }

  _getDocument(docKey) {
    const d = this.docs.get(docKey);
    if (!d || !d.editorBin) return { ok: false };
    const ab = d.editorBin.buffer.slice(
      d.editorBin.byteOffset,
      d.editorBin.byteOffset + d.editorBin.byteLength
    );
    return { ok: true, bytes: ab };
  }
  _getMediaManifest(docKey) {
    const d = this.docs.get(docKey);
    return { list: d ? Array.from(d.media.keys()) : [] };
  }
  _getMedia(docKey, name) {
    const d = this.docs.get(docKey);
    if (!d || !name) return { ok: false };
    const buf = d.media.get(name);
    if (!buf) return { ok: false };
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { ok: true, bytes: ab, contentType: guessContentType(name) };
  }

  _upload(docKey, payload) {
    const doc = this.docs.get(docKey);
    if (!doc || !payload || !payload.body) return { reply: {} };
    const body = new Uint8Array(payload.body);
    if (body.length === 0) return { reply: {} };

    // Detect extension from content type or magic bytes
    const ct = (payload.contentType || "").split(";")[0].trim();
    const extMap = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
      "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/webp": ".webp",
    };
    let ext = extMap[ct] || ".png";
    if (!extMap[ct] && body.length >= 4) {
      if (body[0]===0x89 && body[1]===0x50) ext = ".png";
      else if (body[0]===0xFF && body[1]===0xD8) ext = ".jpg";
      else if (body[0]===0x47 && body[1]===0x49) ext = ".gif";
    }

    const filename = "image" + Date.now() + "_" + randomHex(4) + ext;
    doc.media.set(filename, body);
    dlog("upload: stored", filename, "(" + body.length + " bytes) for", docKey);

    // sdkjs URL registry uses "media/" prefix — key must include it.
    // The URL points to /media/filename which the shim intercepts and serves via RPC.
    const response = {};
    response["media/" + filename] = "/media/" + encodeURIComponent(filename) + "?docKey=" + encodeURIComponent(docKey);
    return { reply: response };
  }

  _getFont(payload) {
    const fontFile = (payload && payload.fontFile) || "";
    if (!fontFile) return { ok: false };
    const fontsDir = path.join(this._fontsDir || "", "");
    const fontPath = path.join(fontsDir, fontFile);

    if (fs.existsSync(fontPath)) {
      const data = fs.readFileSync(fontPath);
      return { ok: true, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }

    // Fallback: serve Arial Regular (font 029) for missing fonts
    const arialPath = path.join(fontsDir, "029");
    if (fs.existsSync(arialPath)) {
      dlog("font fallback:", fontFile, "-> 029 (Arial)");
      const data = fs.readFileSync(arialPath);
      return { ok: true, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }

    return { ok: false };
  }

  async _downloadAs(docKey, payload) {
    const cmd = (payload && payload.cmd) || {};
    if (cmd.c !== "save" && cmd.c !== "savefromorigin") {
      return { reply: { error: 0 } };
    }
    const doc = this.docs.get(docKey);
    if (!doc) return { reply: { error: 1 } };

    const saveType = cmd.savetype;
    let saveKey = cmd.savekey || "";
    const body = (payload && payload.body) ? new Uint8Array(payload.body) : new Uint8Array(0);

    const now = Date.now();
    for (const [k, b] of this.saveBufs) {
      if (now - b.created > 60000) this.saveBufs.delete(k);
    }

    let editorBin = null;
    if (saveType === 3) {
      editorBin = body;
    } else if (saveType === 0) {
      saveKey = randomHex(8);
      this.saveBufs.set(saveKey, { parts: [body], created: now });
      return { reply: { status: "ok", type: "save", data: saveKey } };
    } else if (saveType === 1) {
      const e = this.saveBufs.get(saveKey);
      if (e) e.parts.push(body);
      return { reply: { status: "ok", type: "save", data: saveKey } };
    } else if (saveType === 2) {
      const e = this.saveBufs.get(saveKey);
      if (e) {
        e.parts.push(body);
        editorBin = concatChunks(e.parts);
        this.saveBufs.delete(saveKey);
      } else {
        editorBin = body;
      }
    } else {
      editorBin = body;
    }

    if (!editorBin || editorBin.length === 0) {
      return { reply: { status: "ok", type: "save", data: saveKey || "empty" } };
    }
    if (!this.converter || !doc.filePath) {
      return { reply: { error: 1 } };
    }

    try {
      const docxBytes = await this.converter.editorBinToDocx(editorBin, doc.media);
      if (!docxBytes || docxBytes.length === 0) return { reply: { error: 1 } };
      await this.onSave(doc.filePath, docxBytes);
      doc.editorBin = editorBin;
      dlog("saved", docxBytes.length, "bytes to", doc.filePath);
      return { reply: { status: "ok", type: "save", data: saveKey || randomHex(8) } };
    } catch (err) {
      elog("save conversion failed:", err);
      return { reply: { error: 1 } };
    }
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function pathToFileUrl(absPath) {
  // Convert an absolute filesystem path to a file:// URL.
  // Windows: C:\foo\bar -> file:///C:/foo/bar
  // Unix:    /foo/bar   -> file:///foo/bar
  let p = absPath.split(path.sep).join("/");
  if (!p.startsWith("/")) p = "/" + p;
  // Percent-encode spaces and special chars that break URL parsing
  p = p.replace(/ /g, "%20").replace(/#/g, "%23");
  return "file://" + p;
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
function guessContentType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
    bmp: "image/bmp", emf: "image/x-emf", wmf: "image/x-wmf"
  }[ext] || "application/octet-stream";
}

// ===========================================================================
// AssetPatcher — runs once per load, idempotent
// ===========================================================================

class AssetPatcher {
  constructor(onlyOfficeRoot, shimSourcePath, mockSocketSourcePath) {
    this.root = onlyOfficeRoot;
    this.shimSrc = shimSourcePath;
    this.mockSrc = mockSocketSourcePath;
  }

  run() {
    const result = { patchedHtml: 0, replacedSocket: 0, errors: [], details: [] };

    // 1. Inject the shim <script> tag into editor entry HTMLs
    for (const rel of EDITOR_ENTRY_FILES) {
      const abs = path.join(this.root, rel);
      if (!fs.existsSync(abs)) {
        result.details.push("[skip - not present] " + rel);
        continue;
      }
      try {
        const shimRelUrl = this._shimRelativeTo(rel);
        const r = this._patchHtml(abs, shimRelUrl);
        if (r === "patched") {
          result.patchedHtml++;
          result.details.push("[patched] " + rel + " -> " + shimRelUrl);
        } else {
          result.details.push("[already patched] " + rel);
        }
      } catch (err) {
        result.errors.push("patch " + rel + ": " + err.message);
      }
    }

    // 2. Replace socket.io with our mock at the canonical location
    const socketAbs = path.join(this.root, SOCKET_IO_RELATIVE);
    if (fs.existsSync(socketAbs)) {
      try {
        if (this._replaceSocket(socketAbs)) {
          result.replacedSocket++;
          result.details.push("[replaced] " + SOCKET_IO_RELATIVE);
        } else {
          result.details.push("[already replaced] " + SOCKET_IO_RELATIVE);
        }
      } catch (err) {
        result.errors.push("socket replace: " + err.message);
      }
    } else {
      result.errors.push("socket.io not found at expected path: " + SOCKET_IO_RELATIVE);
    }

    return result;
  }

  /**
   * Compute relative path from an editor HTML back to the shim file.
   *
   * OnlyOffice tree at:  <plugin>/assets/onlyoffice/
   * Shim at:             <plugin>/assets/docx-viewer/transport-shim.js
   *
   * From web-apps/apps/documenteditor/main/index.html:
   *   ../../../.. = onlyoffice root
   *   ../../../../../docx-viewer/transport-shim.js
   */
  _shimRelativeTo(htmlRelPath) {
    const htmlDir = path.dirname(htmlRelPath);
    const fromDir = path.join(this.root, htmlDir);
    const rel = path.relative(fromDir, this.shimSrc);
    return rel.split(path.sep).join("/");
  }

  _patchHtml(absPath, shimRelUrl) {
    let html = fs.readFileSync(absPath, "utf-8");
    if (html.indexOf(SHIM_SENTINEL) !== -1) {
      // Already patched — but verify the shim path still matches in case we moved files
      const expected = '<script src="' + shimRelUrl + '"></script>';
      if (html.indexOf(expected) === -1) {
        // Path drifted; remove old injection and re-patch
        const re = new RegExp("\\n?" + escapeRe(SHIM_SENTINEL) + "[\\s\\S]*?<script src=\"[^\"]*transport-shim\\.js\"><\\/script>\\n?", "g");
        html = html.replace(re, "");
      } else {
        return "already-patched";
      }
    }
    const headMatch = html.match(/<head[^>]*>/i);
    if (!headMatch) {
      throw new Error("no <head> element in " + absPath);
    }
    // Backup once
    const backup = absPath + ".original";
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, fs.readFileSync(absPath, "utf-8"), "utf-8");
    }
    const inject =
      "\n" + SHIM_SENTINEL +
      "\n<script>window.__OO_TEST_DEBUG = true;</script>" +
      '\n<script src="' + shimRelUrl + '"></script>\n';
    const idx = headMatch.index + headMatch[0].length;
    html = html.slice(0, idx) + inject + html.slice(idx);
    fs.writeFileSync(absPath, html, "utf-8");
    return "patched";
  }

  _replaceSocket(absPath) {
    const mockContent = fs.readFileSync(this.mockSrc, "utf-8");
    let cur;
    try { cur = fs.readFileSync(absPath, "utf-8"); } catch (e) { cur = ""; }
    if (cur === mockContent) return false; // already replaced
    const backup = absPath + ".original";
    if (!fs.existsSync(backup) && cur) {
      fs.writeFileSync(backup, cur, "utf-8");
    }
    fs.writeFileSync(absPath, mockContent, "utf-8");
    return true;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ===========================================================================
// DocxView — opens .docx files
// ===========================================================================

class DocxView extends obsidian.FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.docKey = "doc-" + randomHex(6);
    this.placeholderId = this.docKey;
    this._autoSaveTimer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : "DOCX"; }
  getIcon() { return "file-text"; }

  async onOpen() {
    this.containerEl.empty();
    this.containerEl.style.padding = "0";
    if (!this.file) {
      this._renderLandingPage();
    }
  }

  async onClose() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    if (this.plugin.bridge) this.plugin.bridge.removeDocument(this.docKey);
  }

  _renderLandingPage() {
    const container = this.containerEl;
    container.empty();
    const wrapper = container.createEl("div", { cls: "docx-landing" });

    const style = wrapper.createEl("style");
    style.textContent =
      ".docx-landing { padding: 24px 32px; font-family: var(--font-interface); color: var(--text-normal); max-width: 900px; margin: 0 auto; }" +
      ".docx-landing h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }" +
      ".docx-landing .template-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 32px; }" +
      ".docx-landing .template-card { width: 120px; padding: 16px 12px; border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer; text-align: center; transition: border-color 0.15s, background 0.15s; }" +
      ".docx-landing .template-card:hover { border-color: var(--interactive-accent); background: var(--background-modifier-hover); }" +
      ".docx-landing .template-card .icon { font-size: 32px; margin-bottom: 8px; }" +
      ".docx-landing .template-card .label { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
      ".docx-landing .recent-table { width: 100%; border-collapse: collapse; }" +
      ".docx-landing .recent-table th { text-align: left; padding: 6px 12px; border-bottom: 2px solid var(--background-modifier-border); font-size: 12px; color: var(--text-muted); font-weight: 600; }" +
      ".docx-landing .recent-table td { padding: 8px 12px; border-bottom: 1px solid var(--background-modifier-border); font-size: 13px; cursor: pointer; }" +
      ".docx-landing .recent-table tr:hover td { background: var(--background-modifier-hover); }" +
      ".docx-landing .recent-table .date { color: var(--text-muted); white-space: nowrap; width: 140px; }";

    // --- NEW section ---
    wrapper.createEl("h2", { text: "New" });
    const grid = wrapper.createEl("div", { cls: "template-grid" });

    const templateDir = this.plugin.settings.templateDir || "_docx-templates";
    const templates = [];
    const files = this.app.vault.getFiles();
    for (const f of files) {
      if (f.path.startsWith(templateDir + "/") && f.extension === "docx") {
        templates.push({ name: f.basename, path: f.path });
      }
    }
    templates.sort((a, b) => {
      if (a.name === "Blank Document") return -1;
      if (b.name === "Blank Document") return 1;
      return a.name.localeCompare(b.name);
    });
    if (templates.length === 0) {
      templates.push({ name: "Blank Document", path: "" });
    }

    for (const tmpl of templates) {
      const card = grid.createEl("div", { cls: "template-card" });
      card.createEl("div", { cls: "icon", text: tmpl.name === "Blank Document" ? "\u{1F4C4}" : "\u{1F4DD}" });
      card.createEl("div", { cls: "label", text: tmpl.name });
      card.addEventListener("click", () => this._createFromTemplate(tmpl.path, tmpl.name));
    }

    // --- RECENT section ---
    wrapper.createEl("h2", { text: "Recent" });
    const recentFiles = this.app.vault.getFiles()
      .filter((f) => DOCX_EXTENSIONS.includes(f.extension) && !f.path.startsWith(templateDir + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 20);

    if (recentFiles.length === 0) {
      wrapper.createEl("p", { text: "No recent .docx files found." });
    } else {
      const table = wrapper.createEl("table", { cls: "recent-table" });
      const thead = table.createEl("thead");
      const headerRow = thead.createEl("tr");
      headerRow.createEl("th", { text: "Document" });
      headerRow.createEl("th", { text: "Modified", cls: "date" });
      const tbody = table.createEl("tbody");
      for (const f of recentFiles) {
        const row = tbody.createEl("tr");
        row.createEl("td", { text: f.basename });
        const date = new Date(f.stat.mtime);
        row.createEl("td", {
          text: date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
          cls: "date",
        });
        row.addEventListener("click", () => this._openDocxFile(f));
      }
    }
  }

  async _createFromTemplate(templatePath, templateName) {
    const modal = new FileNameModal(this.app, templateName, async (filename) => {
      if (!filename) return;
      if (!filename.endsWith(".docx")) filename += ".docx";
      if (await this.app.vault.adapter.exists(filename)) {
        new obsidian.Notice('File "' + filename + '" already exists.');
        return;
      }
      if (templatePath && await this.app.vault.adapter.exists(templatePath)) {
        await this.app.vault.adapter.copy(templatePath, filename);
      } else {
        const bytes = Uint8Array.from(atob(BLANK_DOCX_BASE64), (c) => c.charCodeAt(0));
        await this.app.vault.adapter.writeBinary(filename, bytes);
      }
      new obsidian.Notice("Created: " + filename);
      const f = this.app.vault.getAbstractFileByPath(filename);
      if (f && f instanceof obsidian.TFile) this._openDocxFile(f);
    });
    modal.open();
  }

  _openDocxFile(file) {
    this.file = file;
    this.onLoadFile(file);
  }

  _findExistingLeaf(file) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.getViewType() === VIEW_TYPE &&
          leaf.view !== this && leaf.view.file &&
          leaf.view.file.path === file.path) {
        found = leaf;
      }
    });
    return found;
  }

  async onLoadFile(file) {
    // Check if another leaf already has this file open
    const existingLeaf = this._findExistingLeaf(file);
    if (existingLeaf && existingLeaf !== this.leaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      this.leaf.detach();
      return;
    }

    this.file = file;

    // Collapse left sidebar to maximize editor space (delayed to run after
    // Obsidian's file explorer finishes its reveal-active-file action)
    setTimeout(() => {
      const leftSplit = this.app.workspace.leftSplit;
      if (leftSplit && !leftSplit.collapsed) leftSplit.collapse();
    }, 300);

    this.containerEl.empty();
    this.containerEl.createEl("div", {
      text: "Loading " + file.basename + " ...",
      attr: { style: "padding: 16px; font-family: var(--font-monospace);" }
    });

    try {
      const docxBytes = await this.app.vault.adapter.readBinary(file.path);
      dlog("read", docxBytes.byteLength, "bytes from", file.path);

      const result = await this.plugin.converter.docxToEditorBin(new Uint8Array(docxBytes));
      dlog("x2t produced", result.editorBin.byteLength, "Editor.bin bytes,",
           result.media.size, "media files");

      this.plugin.bridge.registerDocument(
        this.docKey, file.path, result.editorBin, result.media
      );

      this._renderEditor();
    } catch (err) {
      elog("onLoadFile error:", err);
      this.containerEl.empty();
      this.containerEl.createEl("pre", {
        text: "Failed to open " + file.path + "\n\n" + (err && err.stack || err),
        attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
      });
    }
  }

  _renderEditor() {
    this.containerEl.empty();
    this.containerEl.createEl("div", {
      attr: {
        id: this.placeholderId,
        style: "width: 100%; height: 100%; min-height: 600px;"
      }
    });

    const baseUrl = this.plugin.assetBaseUrl;
    const apiSrc = baseUrl + "/web-apps/apps/api/documents/api.js";
    dlog("loading api.js from:", apiSrc);

    // --- Blob iframe interceptor ---
    // Obsidian's app:// protocol serves iframe HTML but blocks JS/CSS
    // sub-resources inside app:// iframes (ERR_BLOCKED_BY_CLIENT).
    // Workaround: intercept the iframe api.js creates, read the HTML from
    // disk, inject a <base> tag for relative URL resolution, and load via
    // blob: URL. Blob URLs inherit the parent's origin (app://obsidian.md),
    // making sub-resource loads same-origin.
    const onlyOfficeDir = this.plugin.onlyOfficeDir;
    const docKey = this.docKey;
    const shimAbsPath = this.plugin.shimAbs;

    const iframeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.tagName !== "IFRAME") continue;
          const src = node.getAttribute("src") || "";
          if (!src.includes("documenteditor/main/index")) continue;

          iframeObserver.disconnect();
          dlog("intercepted editor iframe, original src:", src.substring(0, 120));

          // Parse query params from the original src
          const params = {};
          try {
            const u = new URL(src, "http://dummy");
            u.searchParams.forEach((v, k) => { params[k] = v; });
          } catch (e) {}

          // Read the actual HTML from disk
          const htmlPath = path.join(onlyOfficeDir,
            "web-apps", "apps", "documenteditor", "main", "index.html");
          let html = fs.readFileSync(htmlPath, "utf-8");

          // Inject <base> for relative URL resolution via app://
          const baseHref = baseUrl + "/web-apps/apps/documenteditor/main/";

          // Inject params as globals (blob URL has no query string)
          // Also inject diagnostics for CSP, errors, and script loading
          // In blob iframes, window.location.search is empty and read-only.
          // OnlyOffice's index.html reads params via getUrlParams() which parses
          // window.location.search.substring(1). Patch the HTML to replace that
          // expression with a hardcoded query string built from captured params.
          // Add docFilePath so the metadata button knows which file is being edited
          params.docFilePath = this.file ? this.file.path : "";

          const qs = Object.entries(params)
            .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
            .join("&");
          html = html.replace(
            "window.location.search.substring(1)",
            JSON.stringify(qs)
          );

          const paramsScript = "<script>" +
            "window.__oo_params=" + JSON.stringify(params) + ";" +
            "console.log('[blob] iframe loaded, docKey:'," + JSON.stringify(params.frameEditorId || "") + ");" +
            // Worker shim: the blob iframe (origin app://obsidian.md) can't create
            // Workers from app://hash/... (cross-origin). Override Worker to catch
            // the error and return a no-op stub so SDK initialization continues.
            "var _OrigWorker=window.Worker;" +
            "window.Worker=function(url,opts){" +
            "try{return new _OrigWorker(url,opts);}catch(e){" +
            "console.warn('[blob] Worker blocked (cross-origin), stubbing:',String(url).split('/').pop());" +
            "var s={postMessage:function(){},terminate:function(){}," +
            "addEventListener:function(){},removeEventListener:function(){}};" +
            "Object.defineProperty(s,'onmessage',{set:function(){},get:function(){return null}});" +
            "Object.defineProperty(s,'onerror',{set:function(){},get:function(){return null}});" +
            "return s;}};" +
            "</script>";

          // Inline the transport shim (avoid sub-resource <script src> for it)
          let shimScript = "";
          try {
            const shimCode = fs.readFileSync(shimAbsPath, "utf-8");
            shimScript = "<script>" + shimCode + "</script>";
          } catch (e) {
            elog("failed to read transport shim:", e.message);
          }

          // Inject after <head>: base tag, params, inlined shim
          html = html.replace(/<head([^>]*)>/i,
            "<head$1>\n" +
            '<base href="' + baseHref + '">\n' +
            paramsScript + "\n" +
            shimScript + "\n"
          );

          // Remove the patcher's <script src="...transport-shim.js"> since we inlined it
          html = html.replace(/<script\s+src="[^"]*transport-shim\.js"><\/script>\s*/g, "");

          // Inline CSS: Obsidian's CSP blocks <link rel="stylesheet"> from app://hash/...
          // because 'self' = app://obsidian.md (blob origin) != app://hash (resource host).
          // 'unsafe-inline' IS allowed, so <style> tags work.
          const htmlDir = path.join(onlyOfficeDir, "web-apps", "apps", "documenteditor", "main");
          html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
            const hrefMatch = tag.match(/href=["']([^"']+)["']/);
            if (!hrefMatch) return tag;
            const href = hrefMatch[1];
            // Resolve relative href against the HTML directory
            const cssAbsPath = path.resolve(htmlDir, href);
            if (!fs.existsSync(cssAbsPath)) {
              dlog("CSS not found, keeping link tag:", href);
              return tag;
            }
            try {
              let css = fs.readFileSync(cssAbsPath, "utf-8");
              // Rewrite url() paths: CSS was at resources/css/app.css, but
              // when inlined, url() resolves against <base> (the main/ dir).
              // Convert url(../../resources/img/x) -> url(resources/img/x)
              const cssDir = path.dirname(cssAbsPath);
              css = css.replace(/url\(["']?([^"')]+)["']?\)/g, (match, relUrl) => {
                if (relUrl.startsWith("data:") || relUrl.startsWith("http") || relUrl.startsWith("//")) return match;
                const absUrl = path.resolve(cssDir, relUrl);
                const fromBase = path.relative(htmlDir, absUrl).split(path.sep).join("/");
                return "url(" + fromBase + ")";
              });
              // Also rewrite --sprite-button-icons-base-url which is a plain path
              // (not inside url()), used by JS to construct icon sprite URLs at runtime.
              css = css.replace(
                /--sprite-button-icons-base-url:\s*([^;}\s]+)/g,
                (match, relPath) => {
                  if (relPath.startsWith("url(")) return match; // already a url()
                  const absPath2 = path.resolve(cssDir, relPath);
                  const fromBase = path.relative(htmlDir, absPath2).split(path.sep).join("/");
                  return "--sprite-button-icons-base-url:" + fromBase;
                }
              );
              dlog("inlined CSS:", href, "(" + css.length + " chars)");
              return "<style>" + css + "</style>";
            } catch (e) {
              elog("failed to inline CSS:", href, e.message);
              return tag;
            }
          });

          // Pre-inject SVG icons into <div class="inlined-svg">.
          // OnlyOffice v9.3 uses SVG sprites (not PNG) for toolbar icons.
          // injectSvgIcons() fetches SVG files via fetch(), but those requests
          // fail in the blob iframe (cross-origin to app://hash/...).
          // Fix: read SVGs from disk and inject them directly into the HTML.
          // Also set svgiconsrunonce=true to prevent runtime re-fetch.
          const svgFiles = [
            path.join(htmlDir, "resources", "img", "iconssmall@2.5x.svg"),
            path.join(htmlDir, "resources", "img", "iconsbig@2.5x.svg"),
            path.join(htmlDir, "resources", "img", "iconshuge@2.5x.svg"),
            path.join(onlyOfficeDir, "web-apps", "apps", "common", "main", "resources", "img", "doc-formats", "formats@2.5x.svg"),
          ];
          let svgContent = "";
          for (const svgPath of svgFiles) {
            if (fs.existsSync(svgPath)) {
              svgContent += fs.readFileSync(svgPath, "utf-8");
            }
          }
          if (svgContent) {
            html = html.replace(
              '<div class="inlined-svg"></div>',
              '<div class="inlined-svg">' + svgContent + '</div>'
            );
            // Prevent runtime re-fetch
            html = html.replace(
              /<\/head>/i,
              '<script>window.svgiconsrunonce=true;</script>\n</head>'
            );
            dlog("pre-injected", svgFiles.length, "SVG icon sprites (" + svgContent.length + " chars)");
          }

          // Create blob URL (inherits parent origin app://obsidian.md)
          const blob = new Blob([html], { type: "text/html" });
          const blobUrl = URL.createObjectURL(blob);

          node.src = blobUrl;
          dlog("iframe replaced with blob URL, base:", baseHref);
        }
      }
    });
    iframeObserver.observe(this.containerEl, { childList: true, subtree: true });

    const create = () => {
      const DocsAPI = window.DocsAPI;
      if (!DocsAPI) {
        elog("DocsAPI not available after api.js load");
        return;
      }
      try {
        const config = this._buildEditorConfig();
        new DocsAPI.DocEditor(this.placeholderId, config);
      } catch (err) {
        elog("DocEditor init failed:", err);
      }
    };

    if (window.DocsAPI) {
      create();
    } else {
      // Chromium blocks <script src="file://..."> from app:// origin.
      // Workaround: place a non-executing marker <script> tag with the correct
      // file:// src so api.js's getBasePath() can scan it from the DOM,
      // then load the actual code via eval().
      const apiAbsPath = path.join(this.plugin.onlyOfficeDir,
        "web-apps", "apps", "api", "documents", "api.js");

      if (!fs.existsSync(apiAbsPath)) {
        elog("api.js not found at:", apiAbsPath);
        this.containerEl.createEl("pre", {
          text: "api.js not found.\n\nExpected at: " + apiAbsPath +
                "\n\nRun setup.js to copy OnlyOffice assets.",
          attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
        });
        return;
      }

      // Marker tag: api.js scans document.getElementsByTagName('script') for
      // a src matching "api/documents/api.js" to derive its base URL.
      // type='text/plain' prevents the browser from fetching the file:// URL.
      const marker = document.createElement("script");
      marker.type = "text/plain";
      marker.setAttribute("src", apiSrc);
      document.head.appendChild(marker);

      // Temporary: log all postMessages to debug the handshake
      const _pmDebug = (ev) => {
        if (!ev.data) return;
        const d = typeof ev.data === 'string' ? ev.data.substring(0, 120) : JSON.stringify(ev.data).substring(0, 120);
        dlog("postMessage from origin:", ev.origin, "data:", d);
      };
      window.addEventListener("message", _pmDebug);

      try {
        dlog("loading api.js via eval from:", apiAbsPath);
        let apiCode = fs.readFileSync(apiAbsPath, "utf-8");

        // CRITICAL FIX: api.js derives frameOrigin from iframe.src via string split:
        //   this.frameOrigin = pathArray[0] + '//' + pathArray[2];
        // This yields "app://hash" from the original src. But our blob iframe's
        // origin is "app://obsidian.md" (inherited from parent). The mismatch
        // causes _onMessage to silently drop ALL messages from the iframe.
        // Fix: replace the origin derivation to use window.location.origin,
        // which matches the blob iframe's origin.
        const beforeLen = apiCode.length;
        apiCode = apiCode.replace(
          /this\.frameOrigin\s*=\s*pathArray\[0\]\s*\+\s*['"]\/\/['"]\s*\+\s*pathArray\[2\]/,
          "this.frameOrigin = window.location.origin"
        );
        if (apiCode.length !== beforeLen) {
          dlog("patched api.js frameOrigin (string length changed:", beforeLen, "->", apiCode.length, ")");
        } else {
          elog("WARNING: frameOrigin patch regex did NOT match — postMessage will fail");
        }

        (0, eval)(apiCode);
        create();
      } catch (err) {
        elog("Failed to eval api.js:", err);
        this.containerEl.createEl("pre", {
          text: "Failed to load OnlyOffice api.js via eval()\n\n" +
                (err && err.stack || err),
          attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
        });
      }
    }
  }

  _buildEditorConfig() {
    const filename = this.file.basename + "." + this.file.extension;
    const editorKey = crypto.createHash("sha256")
      .update(this.file.path + Date.now().toString())
      .digest("hex").slice(0, 20);

    return {
      document: {
        fileType: "docx",
        key: editorKey,
        title: filename,
        url: "/document?docKey=" + encodeURIComponent(this.docKey),
        permissions: {
          print: false, download: false,
          edit: true, copy: true, comment: true, review: false
        }
      },
      documentType: "word",
      frameEditorId: this.docKey,
      editorConfig: {
        mode: this.plugin.settings.defaultMode,
        lang: "en",
        user: { id: require("os").userInfo().username, name: require("os").userInfo().username },
        customization: {
          forcesave: false, autosave: true, chat: false, comments: true,
          about: false, help: false, feedback: false, plugins: false, macros: false,
          goback: false, close: false, compactHeader: true, hideRightMenu: true,
          features: { spellcheck: { change: false } }
        }
      },
      events: {
        onAppReady:        () => dlog("onAppReady for", this.docKey),
        onDocumentReady:   () => dlog("onDocumentReady for", this.docKey),
        onDocumentStateChange: (e) => {
          // e.data === true means document is modified (unsaved changes)
          if (e && e.data === true) {
            dlog("document modified, scheduling auto-save for", this.docKey);
            if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
            this._autoSaveTimer = setTimeout(() => {
              dlog("auto-save firing for", this.docKey);
              // Send save command to the iframe via postMessage
              const iframe = this.containerEl.querySelector("iframe");
              if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: "docx-viewer-show-saving" }, "*");
                setTimeout(() => {
                  iframe.contentWindow.postMessage({ type: "docx-viewer-save" }, "*");
                }, 50);
              }
            }, 10000);
          }
        },
        onError:           (e) => elog("Editor error:", e)
      },
      type: "desktop",
      width: "100%",
      height: "100%"
    };
  }
}

// ===========================================================================
// Settings tab
// ===========================================================================

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OnlyObsidian Test" });
    containerEl.createEl("p", {
      text: "Test build of OnlyOffice in Obsidian without a localhost HTTP server. " +
            "All editor traffic is routed via in-process postMessage.",
      attr: { style: "color: var(--text-muted); font-size: 13px;" }
    });

    new obsidian.Setting(containerEl)
      .setName("Default mode")
      .setDesc("Open documents in 'edit' or 'view' mode by default.")
      .addDropdown(d => d
        .addOption("edit", "Edit")
        .addOption("view", "View")
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async v => { this.plugin.settings.defaultMode = v; await this.plugin.saveSettings(); }));

    new obsidian.Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose console output (plugin + shim + mock socket).")
      .addToggle(t => t
        .setValue(this.plugin.settings.debugLogging)
        .onChange(async v => {
          this.plugin.settings.debugLogging = v;
          DEBUG = v;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName("Template directory")
      .setDesc("Folder for .docx templates (hidden from file explorer).")
      .addText(t => t
        .setValue(this.plugin.settings.templateDir || "_docx-templates")
        .onChange(async v => {
          this.plugin.settings.templateDir = v;
          await this.plugin.saveSettings();
          this.plugin._injectTemplateDirCSS();
        }));

    containerEl.createEl("h3", { text: "Asset paths" });
    const code = (label, value) => {
      const wrap = containerEl.createEl("div", { attr: { style: "margin: 6px 0; font-size: 12px;" } });
      wrap.createEl("strong", { text: label + ": " });
      wrap.createEl("code", { text: value, attr: { style: "background: var(--background-secondary); padding: 2px 6px; word-break: break-all;" } });
    };
    code("OnlyOffice tree", this.plugin.onlyOfficeDir || "(not resolved)");
    code("x2t",             this.plugin.x2tDir         || "(not resolved)");
    code("Asset base URL",  this.plugin.assetBaseUrl   || "(not resolved)");

    containerEl.createEl("h3", { text: "Patcher" });
    containerEl.createEl("p", {
      text: "Re-injects the transport shim and replaces socket.io.min.js. Idempotent.",
      attr: { style: "color: var(--text-muted); font-size: 13px;" }
    });
    new obsidian.Setting(containerEl)
      .setName("Re-run patcher")
      .addButton(b => b.setButtonText("Run").onClick(() => {
        const r = this.plugin.runPatcher();
        new obsidian.Notice(
          "Patcher: " + r.patchedHtml + " HTMLs patched, " +
          r.replacedSocket + " sockets replaced" +
          (r.errors.length ? ", " + r.errors.length + " errors (see console)" : "")
        );
        if (r.errors.length) elog("patch errors:", r.errors);
        if (r.details.length) dlog("patch details:", r.details);
      }));
  }
}

// ===========================================================================
// Plugin
// ===========================================================================

// ===========================================================================
// Standalone landing page — rendered without a FileView
// ===========================================================================

function renderStandaloneLandingPage(containerEl, plugin) {
  containerEl.empty();
  const wrapper = containerEl.createEl("div", { cls: "docx-landing" });

  const style = wrapper.createEl("style");
  style.textContent =
    ".docx-landing { padding: 24px 32px; font-family: var(--font-interface); color: var(--text-normal); max-width: 900px; margin: 0 auto; }" +
    ".docx-landing h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }" +
    ".docx-landing .template-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 32px; }" +
    ".docx-landing .template-card { width: 120px; padding: 16px 12px; border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer; text-align: center; transition: border-color 0.15s, background 0.15s; }" +
    ".docx-landing .template-card:hover { border-color: var(--interactive-accent); background: var(--background-modifier-hover); }" +
    ".docx-landing .template-card .icon { font-size: 32px; margin-bottom: 8px; }" +
    ".docx-landing .template-card .label { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
    ".docx-landing .recent-table { width: 100%; border-collapse: collapse; }" +
    ".docx-landing .recent-table th { text-align: left; padding: 6px 12px; border-bottom: 2px solid var(--background-modifier-border); font-size: 12px; color: var(--text-muted); font-weight: 600; }" +
    ".docx-landing .recent-table td { padding: 8px 12px; border-bottom: 1px solid var(--background-modifier-border); font-size: 13px; cursor: pointer; }" +
    ".docx-landing .recent-table tr:hover td { background: var(--background-modifier-hover); }" +
    ".docx-landing .recent-table .date { color: var(--text-muted); white-space: nowrap; width: 140px; }";

  const app = plugin.app;
  const templateDir = plugin.settings.templateDir || "_docx-templates";

  // --- NEW section ---
  wrapper.createEl("h2", { text: "New" });
  const grid = wrapper.createEl("div", { cls: "template-grid" });
  const templates = [];
  for (const f of app.vault.getFiles()) {
    if (f.path.startsWith(templateDir + "/") && f.extension === "docx") {
      templates.push({ name: f.basename, path: f.path });
    }
  }
  templates.sort((a, b) => {
    if (a.name === "Blank Document") return -1;
    if (b.name === "Blank Document") return 1;
    return a.name.localeCompare(b.name);
  });
  if (templates.length === 0) templates.push({ name: "Blank Document", path: "" });

  for (const tmpl of templates) {
    const card = grid.createEl("div", { cls: "template-card" });
    card.createEl("div", { cls: "icon", text: tmpl.name === "Blank Document" ? "\u{1F4C4}" : "\u{1F4DD}" });
    card.createEl("div", { cls: "label", text: tmpl.name });
    card.addEventListener("click", () => {
      const modal = new FileNameModal(app, tmpl.name, async (filename) => {
        if (!filename) return;
        if (!filename.endsWith(".docx")) filename += ".docx";
        if (await app.vault.adapter.exists(filename)) {
          new obsidian.Notice('File "' + filename + '" already exists.');
          return;
        }
        if (tmpl.path && await app.vault.adapter.exists(tmpl.path)) {
          await app.vault.adapter.copy(tmpl.path, filename);
        } else {
          const bytes = Uint8Array.from(atob(BLANK_DOCX_BASE64), (c) => c.charCodeAt(0));
          await app.vault.adapter.writeBinary(filename, bytes);
        }
        new obsidian.Notice("Created: " + filename);
        const f = app.vault.getAbstractFileByPath(filename);
        if (f && f instanceof obsidian.TFile) {
          const leaf = app.workspace.getLeaf(true);
          await leaf.openFile(f);
        }
      });
      modal.open();
    });
  }

  // --- RECENT section ---
  wrapper.createEl("h2", { text: "Recent" });
  const recentFiles = app.vault.getFiles()
    .filter((f) => DOCX_EXTENSIONS.includes(f.extension) && !f.path.startsWith(templateDir + "/"))
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, 20);

  if (recentFiles.length === 0) {
    wrapper.createEl("p", { text: "No recent .docx files found." });
  } else {
    const table = wrapper.createEl("table", { cls: "recent-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Document" });
    headerRow.createEl("th", { text: "Modified", cls: "date" });
    const tbody = table.createEl("tbody");
    for (const f of recentFiles) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: f.basename });
      const date = new Date(f.stat.mtime);
      row.createEl("td", {
        text: date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        cls: "date",
      });
      row.addEventListener("click", async () => {
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(f);
      });
    }
  }
}

// ===========================================================================
// Plugin
// ===========================================================================

class OnlyObsidianTestPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    DEBUG = !!this.settings.debugLogging;
    dlog("onload");

    const adapter = this.app.vault.adapter;
    const pluginDirRel = this.manifest.dir;
    const basePath = adapter.getBasePath ? adapter.getBasePath() : null;
    if (!basePath) {
      new obsidian.Notice("OnlyObsidian Test: cannot resolve vault base path (desktop only).");
      return;
    }

    const pluginAbs = path.join(basePath, pluginDirRel);
    this.onlyOfficeDir = path.join(pluginAbs, "assets", "onlyoffice");
    this.x2tDir        = path.join(pluginAbs, "assets", "x2t");
    this.shimAbs       = path.join(pluginAbs, "assets", "docx-viewer", "transport-shim.js");
    this.mockSocketAbs = path.join(pluginAbs, "assets", "docx-viewer", "mock-socket.js");

    // x2t converter uses system fonts for accurate text metrics during conversion.
    // The numbered files in assets/onlyoffice/fonts/ are for editor canvas rendering
    // (proprietary binary format, not .ttf) — x2t can't use those.
    if (process.platform === "win32") {
      this.fontsDir = "C:\\Windows\\Fonts";
    } else if (process.platform === "darwin") {
      this.fontsDir = "/Library/Fonts";
    } else {
      this.fontsDir = "/usr/share/fonts";
    }
    dlog("x2t fontsDir (system fonts):", this.fontsDir);

    // Use Obsidian's app:// protocol for assets. Obsidian serves vault files
    // via app://hash/path URLs. file:// is blocked by Chromium from app:// origin.
    // api.js is loaded via eval() (bypasses <script src> restrictions), and
    // the inner editor iframe loads at app:// where Obsidian serves the HTML+assets.
    const ooRelToVault = path.relative(basePath, this.onlyOfficeDir).split(path.sep).join("/");
    this.assetBaseUrl = adapter.getResourcePath(ooRelToVault).replace(/\?.*$/, "");
    dlog("assetBaseUrl:", this.assetBaseUrl);

    // Check assets — download if missing
    const assetsNeeded = !fs.existsSync(this.onlyOfficeDir) || !fs.existsSync(this.x2tDir) ||
      !fs.existsSync(path.join(this.x2tDir, "x2t.js")) || !fs.existsSync(path.join(this.x2tDir, "x2t.wasm"));

    if (assetsNeeded) {
      dlog("assets missing — starting download");
      const ok = await this._downloadAssets(pluginAbs);
      if (!ok) {
        new obsidian.Notice("Obsidi-Office: asset download failed. See console for details.", 15000);
        return;
      }
    }

    // Patch the tree (idempotent)
    if (fs.existsSync(this.onlyOfficeDir) && fs.existsSync(this.shimAbs) && fs.existsSync(this.mockSocketAbs)) {
      const r = this.runPatcher();
      if (r.errors.length) elog("patcher errors:", r.errors);
    }

    // x2t + bridge
    this.converter = new X2tConverter(this.x2tDir, this.fontsDir);
    this.bridge = new TransportBridge({
      converter: this.converter,
      fontsDir: path.join(this.onlyOfficeDir, "fonts"),
      onSave: async (filePath, docxBytes) => {
        const f = this.app.vault.getAbstractFileByPath(filePath);
        if (f && f instanceof obsidian.TFile) {
          await this.app.vault.modifyBinary(f, docxBytes);
        } else {
          await adapter.writeBinary(filePath, docxBytes);
        }
      }
    });
    this.bridge.attach(window);

    this.registerView(VIEW_TYPE, (leaf) => new DocxView(leaf, this));
    try { this.registerExtensions(["docx"], VIEW_TYPE); } catch (e) {
      elog("registerExtensions failed (probably already registered by another plugin):", e.message);
    }

    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({
      id: "onlyobsidian-open-current",
      name: "Open current .docx in OnlyObsidian",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !/\.docx$/i.test(f.path)) return false;
        if (!checking) this._openInView(f);
        return true;
      }
    });

    // Ribbon icon — opens landing page.
    // Can't use setViewState because FileView requires a file.
    // Instead, render the landing page directly using a standalone function.
    const plugin = this;
    this.addRibbonIcon("file-text", "Obsidi-Office", () => {
      const leaf = this.app.workspace.getLeaf(true);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      renderStandaloneLandingPage(leaf.view.containerEl, plugin);
    });

    // Template directory setup
    await this._initTemplateDir();
    this._injectTemplateDirCSS();

    // Sidecar metadata: hide *.docx.md from file explorer
    this._injectSidecarCSS();

    // Sidecar metadata: auto-rename/delete sidecars when .docx files change
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof obsidian.TFile && file.extension === "docx") {
        const oldSidecar = oldPath + ".md";
        const newSidecar = file.path + ".md";
        const sf = this.app.vault.getAbstractFileByPath(oldSidecar);
        if (sf && sf instanceof obsidian.TFile) {
          this.app.vault.rename(sf, newSidecar);
          dlog("sidecar renamed:", oldSidecar, "->", newSidecar);
        }
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof obsidian.TFile && file.extension === "docx") {
        const sidecarPath = file.path + ".md";
        const sf = this.app.vault.getAbstractFileByPath(sidecarPath);
        if (sf && sf instanceof obsidian.TFile) {
          this.app.vault.delete(sf);
          dlog("sidecar deleted:", sidecarPath);
        }
      }
    }));

    // Listen for metadata button postMessage from editor iframe
    this._metadataHandler = (ev) => {
      if (!ev.data || !ev.data.type) return;
      if (ev.data.type === "obsidi-office-metadata") {
        const filePath = ev.data.filePath;
        if (filePath) {
          const modal = new MetadataModal(this.app, filePath);
          modal.open();
        }
      }
      if (ev.data.type === "obsidi-office-print" && ev.data.images) {
        this._openPrintTab(ev.data.images);
      }
    };
    window.addEventListener("message", this._metadataHandler);

    new obsidian.Notice("Obsidi-Office loaded.");
  }

  async onunload() {
    if (this._metadataHandler) window.removeEventListener("message", this._metadataHandler);
    dlog("onunload");
    if (this.bridge) this.bridge.detach(window);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    DEBUG = !!this.settings.debugLogging;
  }

  runPatcher() {
    const patcher = new AssetPatcher(this.onlyOfficeDir, this.shimAbs, this.mockSocketAbs);
    const r = patcher.run();
    dlog("patcher result:", r);
    return r;
  }

  async _downloadAssets(pluginAbs) {
    const ASSET_URL = "https://github.com/GrandPa-source/Obsidi-Office/releases/download/v0.1.0-assets/onlyobsidian-assets-v9.3.1-full-fonts.tar.gz";
    const assetsDir = path.join(pluginAbs, "assets");
    const notice = new obsidian.Notice("Obsidi-Office: Downloading OnlyOffice assets (207 MB)...", 0);

    try {
      // Download the archive via Node.js https (streams to disk, shows progress).
      // Obsidian's requestUrl() loads the entire file into RAM which is too slow for 207 MB.
      dlog("downloading assets from:", ASSET_URL);
      const tarGzPath = path.join(pluginAbs, "_assets-download.tar.gz");

      await new Promise((resolve, reject) => {
        const https = require("https");
        const follow = (url, redirects) => {
          if (redirects > 5) { reject(new Error("Too many redirects")); return; }
          https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              follow(res.headers.location, redirects + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error("HTTP " + res.statusCode));
              return;
            }
            const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
            let downloaded = 0;
            const file = fs.createWriteStream(tarGzPath);
            res.on("data", (chunk) => {
              downloaded += chunk.length;
              file.write(chunk);
              if (totalBytes > 0) {
                const pct = Math.round((downloaded / totalBytes) * 100);
                const mb = (downloaded / 1048576).toFixed(0);
                notice.setMessage("Obsidi-Office: Downloading assets... " + mb + " MB / " +
                  (totalBytes / 1048576).toFixed(0) + " MB (" + pct + "%)");
              }
            });
            res.on("end", () => { file.end(); file.on("finish", resolve); });
            res.on("error", reject);
          }).on("error", reject);
        };
        follow(ASSET_URL, 0);
      });
      dlog("downloaded to:", tarGzPath, "size:", fs.statSync(tarGzPath).size);
      notice.setMessage("Obsidi-Office: Download complete. Extracting...");

      // Extract using tar (available in Git Bash on Windows, native on Mac/Linux)
      const { execSync } = require("child_process");
      execSync('tar -xzf "' + tarGzPath + '" -C "' + assetsDir + '"', {
        timeout: 120000,
        windowsHide: true,
      });
      dlog("extraction complete");

      // Clean up temp file
      try { fs.unlinkSync(tarGzPath); } catch (e) {}

      // Verify extraction
      const x2tOk = fs.existsSync(path.join(assetsDir, "x2t", "x2t.js"));
      const ooOk = fs.existsSync(path.join(assetsDir, "onlyoffice", "web-apps"));
      if (!x2tOk || !ooOk) {
        elog("extraction verification failed — x2t:", x2tOk, "onlyoffice:", ooOk);
        notice.setMessage("Obsidi-Office: Extraction failed. Check console.");
        setTimeout(() => notice.hide(), 8000);
        return false;
      }

      notice.setMessage("Obsidi-Office: Assets installed. Reload to activate.");
      setTimeout(() => notice.hide(), 5000);
      dlog("assets installed successfully");
      return true;
    } catch (err) {
      elog("asset download/extract failed:", err);
      notice.setMessage("Obsidi-Office: Download failed — " + (err.message || err));
      setTimeout(() => notice.hide(), 10000);
      return false;
    }
  }

  async _initTemplateDir() {
    const dir = this.settings.templateDir || "_docx-templates";
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(dir))) {
      await adapter.mkdir(dir);
    }
    const blankPath = dir + "/Blank Document.docx";
    if (!(await adapter.exists(blankPath))) {
      const bytes = Uint8Array.from(atob(BLANK_DOCX_BASE64), (c) => c.charCodeAt(0));
      await adapter.writeBinary(blankPath, bytes);
    }
  }

  _injectTemplateDirCSS() {
    const styleId = "obsidi-office-hide-templates";
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const dir = this.settings.templateDir || "_docx-templates";
    style.textContent = '.nav-folder-title[data-path="' + dir + '"], .nav-folder-title[data-path="' + dir + '"] + .nav-folder-children { display: none !important; }';
  }

  _openPrintTab(images) {
    // Write captured pages to a temp HTML file and open in system browser.
    // Electron's window.print() always prints the full BrowserWindow —
    // the system browser's print dialog works correctly for just the content.
    const os = require("os");
    const tempPath = path.join(os.tmpdir(), "obsidi-office-print.html");
    let html = '<!DOCTYPE html><html><head><title>Print — Obsidi-Office</title><style>' +
      '@media print { @page { margin: 0; } } ' +
      'body { margin: 0; background: white; } ' +
      'img { display: block; width: 100%; height: auto; page-break-after: always; } ' +
      'img:last-child { page-break-after: avoid; }' +
      '</style></head><body>';
    for (const src of images) {
      html += '<img src="' + src + '">';
    }
    html += '<script>window.onload=function(){setTimeout(function(){window.print();},500);};<\/script>';
    html += '</body></html>';

    fs.writeFileSync(tempPath, html, "utf-8");
    dlog("print: wrote", images.length, "pages to", tempPath);
    require("electron").shell.openPath(tempPath);
    new obsidian.Notice("Opening print preview in browser...");
  }

  _injectSidecarCSS() {
    const styleId = "obsidi-office-hide-sidecars";
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    // Hide *.docx.md files from file explorer (they're indexed for graph/tags but shouldn't clutter the tree)
    style.textContent = '.nav-file-title[data-path$=".docx.md"] { display: none !important; }';
  }

  async _openInView(file) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    const view = leaf.view;
    if (view && view.onLoadFile) await view.onLoadFile(file);
  }
}

// ===========================================================================
// MetadataModal — Obsidian tags + wikilinks for .docx sidecar
// ===========================================================================

class MetadataModal extends obsidian.Modal {
  constructor(app, docxPath) {
    super(app);
    this.docxPath = docxPath;
    this.sidecarPath = docxPath + ".md";
    this.tags = [];
    this.links = [];
  }

  async onOpen() {
    // Read existing sidecar
    await this._loadSidecar();

    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.padding = "12px 16px";
    const titleRow = contentEl.createEl("div", { attr: { style: "display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;" } });
    titleRow.createEl("h3", { text: "Obsidian Metadata", attr: { style: "margin: 0;" } });
    titleRow.createEl("span", {
      text: this.docxPath.split("/").pop(),
      attr: { style: "color: var(--text-muted); font-size: 12px;" }
    });

    // --- Tags section ---
    contentEl.createEl("label", { text: "Tags", attr: { style: "font-weight: 600; font-size: 12px; display: block; margin: 4px 0 2px;" } });
    this._tagContainer = contentEl.createEl("div", { attr: { style: "display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 2px;" } });
    this._renderChips(this._tagContainer, this.tags, "tag");

    const tagInput = contentEl.createEl("input", { type: "text" });
    tagInput.style.cssText = "width: 100%; padding: 4px 8px; margin-bottom: 2px; font-size: 12px;";
    tagInput.placeholder = "Type to search tags...";

    const tagSuggest = contentEl.createEl("div", { attr: { style: "max-height: 100px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; display: none; font-size: 12px;" } });

    tagInput.addEventListener("input", () => {
      const q = tagInput.value.replace(/^#/, "").toLowerCase();
      tagSuggest.empty();
      if (!q) { tagSuggest.style.display = "none"; return; }
      const allTags = Object.keys(this.app.metadataCache.getTags() || {})
        .map(t => t.replace(/^#/, ""))
        .filter(t => t.toLowerCase().includes(q) && !this.tags.includes(t))
        .slice(0, 10);
      if (allTags.length === 0) { tagSuggest.style.display = "none"; return; }
      tagSuggest.style.display = "block";
      for (const t of allTags) {
        const item = tagSuggest.createEl("div", { text: "#" + t, attr: { style: "padding: 4px 8px; cursor: pointer;" } });
        item.addEventListener("mouseenter", () => { item.style.background = "var(--background-modifier-hover)"; });
        item.addEventListener("mouseleave", () => { item.style.background = ""; });
        item.addEventListener("click", () => {
          this.tags.push(t);
          this._renderChips(this._tagContainer, this.tags, "tag");
          tagInput.value = "";
          tagSuggest.style.display = "none";
        });
      }
    });
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && tagInput.value.trim()) {
        const t = tagInput.value.replace(/^#/, "").trim();
        if (t && !this.tags.includes(t)) {
          this.tags.push(t);
          this._renderChips(this._tagContainer, this.tags, "tag");
        }
        tagInput.value = "";
        tagSuggest.style.display = "none";
        e.preventDefault();
      }
    });

    // --- Links section ---
    contentEl.createEl("label", { text: "Links", attr: { style: "font-weight: 600; font-size: 12px; display: block; margin: 6px 0 2px;" } });
    this._linkContainer = contentEl.createEl("div", { attr: { style: "display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 2px;" } });
    this._renderChips(this._linkContainer, this.links, "link");

    const linkInput = contentEl.createEl("input", { type: "text" });
    linkInput.style.cssText = "width: 100%; padding: 4px 8px; margin-bottom: 2px; font-size: 12px;";
    linkInput.placeholder = "Type to search notes...";

    const linkSuggest = contentEl.createEl("div", { attr: { style: "max-height: 100px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; display: none; font-size: 12px;" } });

    linkInput.addEventListener("input", () => {
      const q = linkInput.value.toLowerCase();
      linkSuggest.empty();
      if (!q) { linkSuggest.style.display = "none"; return; }
      const allNotes = this.app.vault.getMarkdownFiles()
        .filter(f => f.basename.toLowerCase().includes(q) && !f.path.endsWith(".docx.md"))
        .map(f => f.basename)
        .filter(n => !this.links.includes("[[" + n + "]]"))
        .slice(0, 10);
      if (allNotes.length === 0) { linkSuggest.style.display = "none"; return; }
      linkSuggest.style.display = "block";
      for (const n of allNotes) {
        const item = linkSuggest.createEl("div", { text: "[[" + n + "]]", attr: { style: "padding: 4px 8px; cursor: pointer;" } });
        item.addEventListener("mouseenter", () => { item.style.background = "var(--background-modifier-hover)"; });
        item.addEventListener("mouseleave", () => { item.style.background = ""; });
        item.addEventListener("click", () => {
          this.links.push("[[" + n + "]]");
          this._renderChips(this._linkContainer, this.links, "link");
          linkInput.value = "";
          linkSuggest.style.display = "none";
        });
      }
    });
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && linkInput.value.trim()) {
        let n = linkInput.value.trim();
        if (!n.startsWith("[[")) n = "[[" + n + "]]";
        if (!this.links.includes(n)) {
          this.links.push(n);
          this._renderChips(this._linkContainer, this.links, "link");
        }
        linkInput.value = "";
        linkSuggest.style.display = "none";
        e.preventDefault();
      }
    });

    // --- Buttons ---
    const btnRow = contentEl.createEl("div", { attr: { style: "display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px;" } });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => { this._saveSidecar(); this.close(); });
  }

  _renderChips(container, items, type) {
    container.empty();
    for (let i = 0; i < items.length; i++) {
      const chip = container.createEl("span", {
        text: type === "tag" ? "#" + items[i] : items[i],
        attr: { style: "display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: var(--background-modifier-hover); border: 1px solid var(--background-modifier-border);" }
      });
      const x = chip.createEl("span", { text: "\u00D7", attr: { style: "cursor: pointer; font-size: 12px; line-height: 1; color: var(--text-muted);" } });
      const idx = i;
      x.addEventListener("click", () => {
        items.splice(idx, 1);
        this._renderChips(container, items, type);
      });
    }
  }

  async _loadSidecar() {
    const f = this.app.vault.getAbstractFileByPath(this.sidecarPath);
    if (!f || !(f instanceof obsidian.TFile)) return;
    const content = await this.app.vault.read(f);
    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return;
    const fm = fmMatch[1];
    // Extract tags
    const tagsMatch = fm.match(/tags:\n((?:\s+-\s+.+\n)*)/);
    if (tagsMatch) {
      this.tags = tagsMatch[1].match(/^\s+-\s+(.+)$/gm)
        ?.map(l => l.replace(/^\s+-\s+/, "").trim()) || [];
    }
    // Extract links
    const linksMatch = fm.match(/links:\n((?:\s+-\s+.+\n)*)/);
    if (linksMatch) {
      this.links = linksMatch[1].match(/^\s+-\s+(.+)$/gm)
        ?.map(l => l.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim()) || [];
    }
  }

  async _saveSidecar() {
    const hasTags = this.tags.length > 0;
    const hasLinks = this.links.length > 0;

    if (!hasTags && !hasLinks) {
      // Delete sidecar if empty
      const f = this.app.vault.getAbstractFileByPath(this.sidecarPath);
      if (f && f instanceof obsidian.TFile) {
        await this.app.vault.delete(f);
        dlog("sidecar deleted (empty):", this.sidecarPath);
      }
      return;
    }

    const docxName = this.docxPath.split("/").pop();
    let yaml = "---\n";
    yaml += 'docx: "[[' + docxName + ']]"\n';
    if (hasTags) {
      yaml += "tags:\n";
      for (const t of this.tags) yaml += "  - " + t + "\n";
    }
    if (hasLinks) {
      yaml += "links:\n";
      for (const l of this.links) yaml += '  - "' + l + '"\n';
    }
    yaml += "---\n";

    const existing = this.app.vault.getAbstractFileByPath(this.sidecarPath);
    if (existing && existing instanceof obsidian.TFile) {
      await this.app.vault.modify(existing, yaml);
    } else {
      await this.app.vault.create(this.sidecarPath, yaml);
    }
    dlog("sidecar saved:", this.sidecarPath, "tags:", this.tags.length, "links:", this.links.length);
    new obsidian.Notice("Metadata saved for " + docxName);
  }

  onClose() { this.contentEl.empty(); }
}

// ===========================================================================
// FileNameModal — prompt for new document name
// ===========================================================================

class FileNameModal extends obsidian.Modal {
  constructor(app, defaultName, onSubmit) {
    super(app);
    this.defaultName = defaultName === "Blank Document" ? "" : defaultName;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "New Document" });
    contentEl.createEl("p", { text: "Enter a name for the new document:" });
    const input = contentEl.createEl("input", { type: "text" });
    input.style.width = "100%";
    input.style.padding = "8px";
    input.style.marginBottom = "12px";
    input.placeholder = "Document name";
    input.value = this.defaultName;
    input.focus();
    const btnRow = contentEl.createEl("div", { attr: { style: "display:flex;gap:8px;justify-content:flex-end;" } });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const okBtn = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });
    okBtn.addEventListener("click", () => {
      const name = input.value.trim();
      if (name) { this.onSubmit(name); this.close(); }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const name = input.value.trim(); if (name) { this.onSubmit(name); this.close(); } }
      if (e.key === "Escape") this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = OnlyObsidianTestPlugin;
