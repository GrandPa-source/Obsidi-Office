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

// Mobile (Capacitor / iOS) gating. On mobile, Node-only modules are unavailable
// or unsafe — fs/path/crypto would throw at module load. Detect once at top
// and gate all subsequent require() calls. Mobile-specific code paths use the
// vault adapter (vio shim, added in Phase 2) for I/O and Web Crypto API for
// random bytes (see randomHex). Inline requires for `os`, `https`,
// `child_process`, `electron` live inside methods that are gated on
// !isMobile by their callers (added throughout Phase 1+).
const isMobile = obsidian.Platform && obsidian.Platform.isMobile;
const fs       = isMobile ? null : require("fs");
const path     = isMobile ? null : require("path");
const crypto   = isMobile ? null : require("crypto");

// ===========================================================================
// Phase B — Platform-IO shim
// ===========================================================================
// All vault-relative I/O routes through Obsidian's vault adapter, which works
// identically on desktop and mobile. Absolute-path I/O (system fonts, tmp
// files, etc.) is desktop-only and stays sync via fs.
//
// vio.* helpers all take an Obsidian `Plugin` instance (for adapter access)
// and forward-slash vault-relative paths. The desktop adapter will translate
// these to absolute paths internally; mobile uses them as-is.
//
// vioAbs.* helpers take absolute filesystem paths and are sync (existing
// fs API surface). Throw on mobile to surface incorrect routing during dev.
// ===========================================================================

const vio = {
  exists(plugin, relPath) {
    return plugin.app.vault.adapter.exists(relPath);
  },
  readBinary(plugin, relPath) {
    return plugin.app.vault.adapter.readBinary(relPath);
  },
  readText(plugin, relPath) {
    return plugin.app.vault.adapter.read(relPath);
  },
  writeBinary(plugin, relPath, data) {
    return plugin.app.vault.adapter.writeBinary(relPath, data);
  },
  writeText(plugin, relPath, data) {
    return plugin.app.vault.adapter.write(relPath, data);
  },
  list(plugin, relPath) {
    // Returns { files: string[], folders: string[] } — paths are vault-relative.
    return plugin.app.vault.adapter.list(relPath);
  },
  mkdir(plugin, relPath) {
    return plugin.app.vault.adapter.mkdir(relPath);
  },
  // Forward-slash join, collapse repeats. Vault-relative paths are
  // platform-agnostic; never use OS-native separators.
  join(...parts) {
    return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  },
  // Posix-style dirname — last segment stripped, no trailing slash.
  dirname(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  },
  // Resolve `rel` against `base` (both forward-slash). Handles `..`/`.`.
  // Stays vault-relative; doesn't go above the vault root.
  resolve(base, rel) {
    if (!rel) return base;
    if (rel.startsWith("/")) return rel.replace(/^\/+/, "");
    const segs = base.split("/").filter(Boolean);
    for (const s of rel.split("/")) {
      if (s === "" || s === ".") continue;
      if (s === "..") segs.pop();
      else segs.push(s);
    }
    return segs.join("/");
  },
  // Relative path from `from` directory to `to` (file or dir). Both vault-relative.
  relative(from, to) {
    const f = from.split("/").filter(Boolean);
    const t = to.split("/").filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    const ups = new Array(f.length - i).fill("..");
    return [...ups, ...t.slice(i)].join("/");
  },
};

const vioAbs = {
  exists(absPath) {
    if (isMobile) throw new Error("vioAbs.exists called on mobile: " + absPath);
    return fs.existsSync(absPath);
  },
  readBinary(absPath) {
    if (isMobile) throw new Error("vioAbs.readBinary called on mobile: " + absPath);
    return fs.readFileSync(absPath);
  },
  readText(absPath) {
    if (isMobile) throw new Error("vioAbs.readText called on mobile: " + absPath);
    return fs.readFileSync(absPath, "utf-8");
  },
  writeBinary(absPath, data) {
    if (isMobile) throw new Error("vioAbs.writeBinary called on mobile: " + absPath);
    return fs.writeFileSync(absPath, data);
  },
  writeText(absPath, data) {
    if (isMobile) throw new Error("vioAbs.writeText called on mobile: " + absPath);
    return fs.writeFileSync(absPath, data, "utf-8");
  },
  readdir(absPath) {
    if (isMobile) throw new Error("vioAbs.readdir called on mobile: " + absPath);
    return fs.readdirSync(absPath, { withFileTypes: true });
  },
};

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

// Spell-check Worker prologue. Mirrored from onlyobsidian-mobile (commit
// 14dd7bd). Injected as the FIRST code in the spawned Worker (Blob URL,
// same-origin null with the blob iframe). Overrides self.fetch +
// XMLHttpRequest so the Worker's spell.wasm fetch and dictionary load_file
// XHR calls route via postMessage RPC to the blob iframe, which forwards
// to the plugin parent for vio-equivalent reads.
//
// Three non-obvious fixes baked in (see mobile fork docs/spellcheck-architecture.md):
//   1. Regex escape double-back-slash so template literal interpolation
//      doesn't collapse \. and \? to . and ?.
//   2. RPC replies tagged type:"init" so spell.js's onmessage handler hits
//      its dup-init guard and doesn't queue replies as spell-check requests.
//   3. error + unhandledrejection listeners surface Worker-side failures
//      that the editor's i2() pR.onerror handler would otherwise swallow
//      via preventDefault().
const SPELL_WORKER_PROLOGUE = `(function(){
  self.addEventListener("error", function(e) {
    console.error("[spell-worker] uncaught error:", e.message, "at", e.filename + ":" + e.lineno);
  });
  self.addEventListener("unhandledrejection", function(e) {
    console.error("[spell-worker] unhandled rejection:", e.reason);
  });
  var _id = 0;
  var _pending = new Map();
  var _RPC_TAG = "__onlyoSpellRPC";

  self.addEventListener("message", function(e) {
    var d = e.data;
    if (d && d[_RPC_TAG] === true) {
      var cb = _pending.get(d.id);
      if (cb) { _pending.delete(d.id); cb(d); }
    }
  });

  function rpcFetch(url) {
    return new Promise(function(resolve, reject) {
      var id = ++_id;
      _pending.set(id, function(msg) {
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.bytes);
      });
      self.postMessage({ __onlyoSpellRPC: true, type: "fetch", id: id, url: url });
    });
  }

  var _origFetch = self.fetch;
  self.fetch = function(input, opts) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (typeof url === "string" &&
        url.indexOf("blob:") !== 0 && url.indexOf("data:") !== 0) {
      return rpcFetch(url).then(function(bytes) {
        var ct = "application/octet-stream";
        if (/\\.wasm(\\?|$)/i.test(url)) ct = "application/wasm";
        else if (/\\.js(\\?|$)/i.test(url)) ct = "application/javascript";
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": ct }
        });
      });
    }
    return _origFetch ? _origFetch.call(self, input, opts) : Promise.reject(new Error("fetch unavailable"));
  };

  var _OrigXHR = self.XMLHttpRequest;
  function ShimXHR() {
    this._url = null;
    this._responseType = "";
    this._response = null;
    this._status = 0;
    this._readyState = 0;
    this.onload = null;
    this.onerror = null;
  }
  ShimXHR.prototype.open = function(method, url) { this._url = url; this._readyState = 1; };
  ShimXHR.prototype.setRequestHeader = function() {};
  ShimXHR.prototype.overrideMimeType = function() {};
  Object.defineProperty(ShimXHR.prototype, "responseType", {
    get: function() { return this._responseType; },
    set: function(v) { this._responseType = v; }
  });
  Object.defineProperty(ShimXHR.prototype, "response", {
    get: function() { return this._response; }
  });
  Object.defineProperty(ShimXHR.prototype, "status", {
    get: function() { return this._status; }
  });
  Object.defineProperty(ShimXHR.prototype, "readyState", {
    get: function() { return this._readyState; }
  });
  ShimXHR.prototype.send = function() {
    var self_ = this;
    rpcFetch(this._url).then(function(bytes) {
      self_._response = bytes;
      self_._status = 200;
      self_._readyState = 4;
      if (typeof self_.onload === "function") self_.onload({ target: self_ });
    }).catch(function(err) {
      self_._status = 0;
      self_._readyState = 4;
      if (typeof self_.onerror === "function") self_.onerror(err);
    });
  };
  self.XMLHttpRequest = ShimXHR;
})();`;

const DEFAULT_SETTINGS = {
  defaultMode: "edit",
  debugLogging: true,
  autoSaveDelayMs: 1500,
  templateDir: "_docx-templates",
  // Phase B3 — runtime asset delivery.
  // Either an http(s) URL (production / iPad — fetched via obsidian.requestUrl)
  // or a vault-relative path to a zip already in the vault (dev — read via
  // adapter.readBinary, no network). Empty string falls back to the legacy
  // streaming-https tar.gz GitHub flow on desktop. Mobile requires this set.
  assetZipSource: "",
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
// pdf-lib loader (lazy)
// ===========================================================================
// Loaded on first use of the PDF export feature. Source at lib/pdf-lib.min.js.
// 525 KB on disk; we don't want to evaluate it at plugin load.
let _pdfLibCache = null;
function loadPdfLib(pluginAbs) {
  if (_pdfLibCache) return _pdfLibCache;
  const pdfLibPath = path.join(pluginAbs, "lib", "pdf-lib.min.js");
  if (!fs.existsSync(pdfLibPath)) {
    throw new Error("pdf-lib not found at " + pdfLibPath);
  }
  const src = fs.readFileSync(pdfLibPath, "utf-8");
  // pdf-lib UMD: detects exports/module then sets PDFLib globally on window.
  // Run in an isolated scope so we don't pollute global; capture via factory.
  const sandbox = { exports: {}, module: { exports: {} } };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", src)(sandbox.module, sandbox.module.exports);
  const lib = sandbox.module.exports;
  if (!lib || !lib.PDFDocument) {
    throw new Error("pdf-lib failed to expose PDFDocument");
  }
  _pdfLibCache = lib;
  return lib;
}

// ===========================================================================
// fflate loader (lazy)
// ===========================================================================
// fflate UMD source — inlined here so the plugin is self-contained.
// Obsidian Sync on iOS doesn't reliably sync plugin sub-folders (lib/),
// so loading from disk via vio.readText was failing on iPad. Embedding
// the source as a string sidesteps the sync limitation entirely.
// Source: https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
const FFLATE_UMD_SOURCE = "!function(f){typeof module!='undefined'&&typeof exports=='object'?module.exports=f():typeof define!='undefined'&&define.amd?define(f):(typeof self!='undefined'?self:this).fflate=f()}(function(){var _e={};\"use strict\";var t=(typeof module!='undefined'&&typeof exports=='object'?function(_f){\"use strict\";var e,t=\";var __w=require('worker_threads');__w.parentPort.on('message',function(m){onmessage({data:m})}),postMessage=function(m,t){__w.parentPort.postMessage(m,t)},close=process.exit;self=global\";try{e=require(\"worker_threads\").Worker}catch(e){}exports.default=e?function(r,n,o,a,s){var u=!1,i=new e(r+t,{eval:!0}).on(\"error\",(function(e){return s(e,null)})).on(\"message\",(function(e){return s(null,e)})).on(\"exit\",(function(e){e&&!u&&s(Error(\"exited with code \"+e),null)}));return i.postMessage(o,a),i.terminate=function(){return u=!0,e.prototype.terminate.call(i)},i}:function(e,t,r,n,o){setImmediate((function(){return o(Error(\"async operations unsupported - update to Node 12+ (or Node 10-11 with the --experimental-worker CLI flag)\"),null)}));var a=function(){};return{terminate:a,postMessage:a}};return _f}:function(_f){\"use strict\";var e={};_f.default=function(r,t,s,a,n){var o=new Worker(e[t]||(e[t]=URL.createObjectURL(new Blob([r+';addEventListener(\"error\",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'],{type:\"text/javascript\"}))));return o.onmessage=function(e){var r=e.data,t=r.$e$;if(t){var s=Error(t[0]);s.code=t[1],s.stack=t[2],n(s,null)}else n(null,r)},o.postMessage(s,a),o};return _f})({}),n=Uint8Array,r=Uint16Array,e=Int32Array,i=new n([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),o=new n([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),s=new n([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),a=function(t,n){for(var i=new r(31),o=0;o<31;++o)i[o]=n+=1<<t[o-1];var s=new e(i[30]);for(o=1;o<30;++o)for(var a=i[o];a<i[o+1];++a)s[a]=a-i[o]<<5|o;return{b:i,r:s}},u=a(i,2),h=u.b,f=u.r;h[28]=258,f[258]=28;for(var l=a(o,0),c=l.b,p=l.r,v=new r(32768),d=0;d<32768;++d){var g=(43690&d)>>1|(21845&d)<<1;v[d]=((65280&(g=(61680&(g=(52428&g)>>2|(13107&g)<<2))>>4|(3855&g)<<4))>>8|(255&g)<<8)>>1}var y=function(t,n,e){for(var i=t.length,o=0,s=new r(n);o<i;++o)t[o]&&++s[t[o]-1];var a,u=new r(n);for(o=1;o<n;++o)u[o]=u[o-1]+s[o-1]<<1;if(e){a=new r(1<<n);var h=15-n;for(o=0;o<i;++o)if(t[o])for(var f=o<<4|t[o],l=n-t[o],c=u[t[o]-1]++<<l,p=c|(1<<l)-1;c<=p;++c)a[v[c]>>h]=f}else for(a=new r(i),o=0;o<i;++o)t[o]&&(a[o]=v[u[t[o]-1]++]>>15-t[o]);return a},m=new n(288);for(d=0;d<144;++d)m[d]=8;for(d=144;d<256;++d)m[d]=9;for(d=256;d<280;++d)m[d]=7;for(d=280;d<288;++d)m[d]=8;var b=new n(32);for(d=0;d<32;++d)b[d]=5;var w=y(m,9,0),x=y(m,9,1),z=y(b,5,0),k=y(b,5,1),M=function(t){for(var n=t[0],r=1;r<t.length;++r)t[r]>n&&(n=t[r]);return n},S=function(t,n,r){var e=n/8|0;return(t[e]|t[e+1]<<8)>>(7&n)&r},A=function(t,n){var r=n/8|0;return(t[r]|t[r+1]<<8|t[r+2]<<16)>>(7&n)},T=function(t){return(t+7)/8|0},D=function(t,r,e){return(null==r||r<0)&&(r=0),(null==e||e>t.length)&&(e=t.length),new n(t.subarray(r,e))};_e.FlateErrorCode={UnexpectedEOF:0,InvalidBlockType:1,InvalidLengthLiteral:2,InvalidDistance:3,StreamFinished:4,NoStreamHandler:5,InvalidHeader:6,NoCallback:7,InvalidUTF8:8,ExtraFieldTooLong:9,InvalidDate:10,FilenameTooLong:11,StreamFinishing:12,InvalidZipData:13,UnknownCompressionMethod:14};var C=[\"unexpected EOF\",\"invalid block type\",\"invalid length/literal\",\"invalid distance\",\"stream finished\",\"no stream handler\",,\"no callback\",\"invalid UTF-8 data\",\"extra field too long\",\"date not in range 1980-2099\",\"filename too long\",\"stream finishing\",\"invalid zip data\"],I=function(t,n,r){var e=Error(n||C[t]);if(e.code=t,Error.captureStackTrace&&Error.captureStackTrace(e,I),!r)throw e;return e},U=function(t,r,e,a){var u=t.length,f=a?a.length:0;if(!u||r.f&&!r.l)return e||new n(0);var l=!e,p=l||2!=r.i,v=r.i;l&&(e=new n(3*u));var d=function(t){var r=e.length;if(t>r){var i=new n(Math.max(2*r,t));i.set(e),e=i}},g=r.f||0,m=r.p||0,b=r.b||0,w=r.l,z=r.d,C=r.m,U=r.n,F=8*u;do{if(!w){g=S(t,m,1);var E=S(t,m+1,3);if(m+=3,!E){var Z=t[(J=T(m)+4)-4]|t[J-3]<<8,q=J+Z;if(q>u){v&&I(0);break}p&&d(b+Z),e.set(t.subarray(J,q),b),r.b=b+=Z,r.p=m=8*q,r.f=g;continue}if(1==E)w=x,z=k,C=9,U=5;else if(2==E){var O=S(t,m,31)+257,G=S(t,m+10,15)+4,L=O+S(t,m+5,31)+1;m+=14;for(var H=new n(L),j=new n(19),N=0;N<G;++N)j[s[N]]=S(t,m+3*N,7);m+=3*G;var P=M(j),B=(1<<P)-1,Y=y(j,P,1);for(N=0;N<L;){var J,K=Y[S(t,m,B)];if(m+=15&K,(J=K>>4)<16)H[N++]=J;else{var Q=0,R=0;for(16==J?(R=3+S(t,m,3),m+=2,Q=H[N-1]):17==J?(R=3+S(t,m,7),m+=3):18==J&&(R=11+S(t,m,127),m+=7);R--;)H[N++]=Q}}var V=H.subarray(0,O),W=H.subarray(O);C=M(V),U=M(W),w=y(V,C,1),z=y(W,U,1)}else I(1);if(m>F){v&&I(0);break}}p&&d(b+131072);for(var X=(1<<C)-1,$=(1<<U)-1,_=m;;_=m){var tt=(Q=w[A(t,m)&X])>>4;if((m+=15&Q)>F){v&&I(0);break}if(Q||I(2),tt<256)e[b++]=tt;else{if(256==tt){_=m,w=null;break}var nt=tt-254;tt>264&&(nt=S(t,m,(1<<(it=i[N=tt-257]))-1)+h[N],m+=it);var rt=z[A(t,m)&$],et=rt>>4;if(rt||I(3),m+=15&rt,W=c[et],et>3){var it=o[et];W+=A(t,m)&(1<<it)-1,m+=it}if(m>F){v&&I(0);break}p&&d(b+131072);var ot=b+nt;if(b<W){var st=f-W,at=Math.min(W,ot);for(st+b<0&&I(3);b<at;++b)e[b]=a[st+b]}for(;b<ot;++b)e[b]=e[b-W]}}r.l=w,r.p=_,r.b=b,r.f=g,w&&(g=1,r.m=C,r.d=z,r.n=U)}while(!g);return b!=e.length&&l?D(e,0,b):e.subarray(0,b)},F=function(t,n,r){var e=n/8|0;t[e]|=r<<=7&n,t[e+1]|=r>>8},E=function(t,n,r){var e=n/8|0;t[e]|=r<<=7&n,t[e+1]|=r>>8,t[e+2]|=r>>16},Z=function(t,e){for(var i=[],o=0;o<t.length;++o)t[o]&&i.push({s:o,f:t[o]});var s=i.length,a=i.slice();if(!s)return{t:N,l:0};if(1==s){var u=new n(i[0].s+1);return u[i[0].s]=1,{t:u,l:1}}i.sort((function(t,n){return t.f-n.f})),i.push({s:-1,f:25001});var h=i[0],f=i[1],l=0,c=1,p=2;for(i[0]={s:-1,f:h.f+f.f,l:h,r:f};c!=s-1;)h=i[i[l].f<i[p].f?l++:p++],f=i[l!=c&&i[l].f<i[p].f?l++:p++],i[c++]={s:-1,f:h.f+f.f,l:h,r:f};var v=a[0].s;for(o=1;o<s;++o)a[o].s>v&&(v=a[o].s);var d=new r(v+1),g=q(i[c-1],d,0);if(g>e){o=0;var y=0,m=g-e,b=1<<m;for(a.sort((function(t,n){return d[n.s]-d[t.s]||t.f-n.f}));o<s;++o){var w=a[o].s;if(!(d[w]>e))break;y+=b-(1<<g-d[w]),d[w]=e}for(y>>=m;y>0;){var x=a[o].s;d[x]<e?y-=1<<e-d[x]++-1:++o}for(;o>=0&&y;--o){var z=a[o].s;d[z]==e&&(--d[z],++y)}g=e}return{t:new n(d),l:g}},q=function(t,n,r){return-1==t.s?Math.max(q(t.l,n,r+1),q(t.r,n,r+1)):n[t.s]=r},O=function(t){for(var n=t.length;n&&!t[--n];);for(var e=new r(++n),i=0,o=t[0],s=1,a=function(t){e[i++]=t},u=1;u<=n;++u)if(t[u]==o&&u!=n)++s;else{if(!o&&s>2){for(;s>138;s-=138)a(32754);s>2&&(a(s>10?s-11<<5|28690:s-3<<5|12305),s=0)}else if(s>3){for(a(o),--s;s>6;s-=6)a(8304);s>2&&(a(s-3<<5|8208),s=0)}for(;s--;)a(o);s=1,o=t[u]}return{c:e.subarray(0,i),n:n}},G=function(t,n){for(var r=0,e=0;e<n.length;++e)r+=t[e]*n[e];return r},L=function(t,n,r){var e=r.length,i=T(n+2);t[i]=255&e,t[i+1]=e>>8,t[i+2]=255^t[i],t[i+3]=255^t[i+1];for(var o=0;o<e;++o)t[i+o+4]=r[o];return 8*(i+4+e)},H=function(t,n,e,a,u,h,f,l,c,p,v){F(n,v++,e),++u[256];for(var d=Z(u,15),g=d.t,x=d.l,k=Z(h,15),M=k.t,S=k.l,A=O(g),T=A.c,D=A.n,C=O(M),I=C.c,U=C.n,q=new r(19),H=0;H<T.length;++H)++q[31&T[H]];for(H=0;H<I.length;++H)++q[31&I[H]];for(var j=Z(q,7),N=j.t,P=j.l,B=19;B>4&&!N[s[B-1]];--B);var Y,J,K,Q,R=p+5<<3,V=G(u,m)+G(h,b)+f,W=G(u,g)+G(h,M)+f+14+3*B+G(q,N)+2*q[16]+3*q[17]+7*q[18];if(c>=0&&R<=V&&R<=W)return L(n,v,t.subarray(c,c+p));if(F(n,v,1+(W<V)),v+=2,W<V){Y=y(g,x,0),J=g,K=y(M,S,0),Q=M;var X=y(N,P,0);for(F(n,v,D-257),F(n,v+5,U-1),F(n,v+10,B-4),v+=14,H=0;H<B;++H)F(n,v+3*H,N[s[H]]);v+=3*B;for(var $=[T,I],_=0;_<2;++_){var tt=$[_];for(H=0;H<tt.length;++H)F(n,v,X[rt=31&tt[H]]),v+=N[rt],rt>15&&(F(n,v,tt[H]>>5&127),v+=tt[H]>>12)}}else Y=w,J=m,K=z,Q=b;for(H=0;H<l;++H){var nt=a[H];if(nt>255){var rt;E(n,v,Y[257+(rt=nt>>18&31)]),v+=J[rt+257],rt>7&&(F(n,v,nt>>23&31),v+=i[rt]);var et=31&nt;E(n,v,K[et]),v+=Q[et],et>3&&(E(n,v,nt>>5&8191),v+=o[et])}else E(n,v,Y[nt]),v+=J[nt]}return E(n,v,Y[256]),v+J[256]},j=new e([65540,131080,131088,131104,262176,1048704,1048832,2114560,2117632]),N=new n(0),P=function(t,s,a,u,h,l){var c=l.z||t.length,v=new n(u+c+5*(1+Math.ceil(c/7e3))+h),d=v.subarray(u,v.length-h),g=l.l,y=7&(l.r||0);if(s){y&&(d[0]=l.r>>3);for(var m=j[s-1],b=m>>13,w=8191&m,x=(1<<a)-1,z=l.p||new r(32768),k=l.h||new r(x+1),M=Math.ceil(a/3),S=2*M,A=function(n){return(t[n]^t[n+1]<<M^t[n+2]<<S)&x},C=new e(25e3),I=new r(288),U=new r(32),F=0,E=0,Z=l.i||0,q=0,O=l.w||0,G=0;Z+2<c;++Z){var N=A(Z),P=32767&Z,B=k[N];if(z[P]=B,k[N]=P,O<=Z){var Y=c-Z;if((F>7e3||q>24576)&&(Y>423||!g)){y=H(t,d,0,C,I,U,E,q,G,Z-G,y),q=F=E=0,G=Z;for(var J=0;J<286;++J)I[J]=0;for(J=0;J<30;++J)U[J]=0}var K=2,Q=0,R=w,V=P-B&32767;if(Y>2&&N==A(Z-V))for(var W=Math.min(b,Y)-1,X=Math.min(32767,Z),$=Math.min(258,Y);V<=X&&--R&&P!=B;){if(t[Z+K]==t[Z+K-V]){for(var _=0;_<$&&t[Z+_]==t[Z+_-V];++_);if(_>K){if(K=_,Q=V,_>W)break;var tt=Math.min(V,_-2),nt=0;for(J=0;J<tt;++J){var rt=Z-V+J&32767,et=rt-z[rt]&32767;et>nt&&(nt=et,B=rt)}}}V+=(P=B)-(B=z[P])&32767}if(Q){C[q++]=268435456|f[K]<<18|p[Q];var it=31&f[K],ot=31&p[Q];E+=i[it]+o[ot],++I[257+it],++U[ot],O=Z+K,++F}else C[q++]=t[Z],++I[t[Z]]}}for(Z=Math.max(Z,O);Z<c;++Z)C[q++]=t[Z],++I[t[Z]];y=H(t,d,g,C,I,U,E,q,G,Z-G,y),g||(l.r=7&y|d[y/8|0]<<3,y-=7,l.h=k,l.p=z,l.i=Z,l.w=O)}else{for(Z=l.w||0;Z<c+g;Z+=65535){var st=Z+65535;st>=c&&(d[y/8|0]=g,st=c),y=L(d,y+1,t.subarray(Z,st))}l.i=c}return D(v,0,u+T(y)+h)},B=function(){for(var t=new Int32Array(256),n=0;n<256;++n){for(var r=n,e=9;--e;)r=(1&r&&-306674912)^r>>>1;t[n]=r}return t}(),Y=function(){var t=-1;return{p:function(n){for(var r=t,e=0;e<n.length;++e)r=B[255&r^n[e]]^r>>>8;t=r},d:function(){return~t}}},J=function(){var t=1,n=0;return{p:function(r){for(var e=t,i=n,o=0|r.length,s=0;s!=o;){for(var a=Math.min(s+2655,o);s<a;++s)i+=e+=r[s];e=(65535&e)+15*(e>>16),i=(65535&i)+15*(i>>16)}t=e,n=i},d:function(){return(255&(t%=65521))<<24|(65280&t)<<8|(255&(n%=65521))<<8|n>>8}}},K=function(t,r,e,i,o){if(!o&&(o={l:1},r.dictionary)){var s=r.dictionary.subarray(-32768),a=new n(s.length+t.length);a.set(s),a.set(t,s.length),t=a,o.w=s.length}return P(t,null==r.level?6:r.level,null==r.mem?o.l?Math.ceil(1.5*Math.max(8,Math.min(13,Math.log(t.length)))):20:12+r.mem,e,i,o)},Q=function(t,n){var r={};for(var e in t)r[e]=t[e];for(var e in n)r[e]=n[e];return r},R=function(t,n,r){for(var e=t(),i=\"\"+t,o=i.slice(i.indexOf(\"[\")+1,i.lastIndexOf(\"]\")).replace(/\\s+/g,\"\").split(\",\"),s=0;s<e.length;++s){var a=e[s],u=o[s];if(\"function\"==typeof a){n+=\";\"+u+\"=\";var h=\"\"+a;if(a.prototype)if(-1!=h.indexOf(\"[native code]\")){var f=h.indexOf(\" \",8)+1;n+=h.slice(f,h.indexOf(\"(\",f))}else for(var l in n+=h,a.prototype)n+=\";\"+u+\".prototype.\"+l+\"=\"+a.prototype[l];else n+=h}else r[u]=a}return n},V=[],W=function(t){var n=[];for(var r in t)t[r].buffer&&n.push((t[r]=new t[r].constructor(t[r])).buffer);return n},X=function(n,r,e,i){if(!V[e]){for(var o=\"\",s={},a=n.length-1,u=0;u<a;++u)o=R(n[u],o,s);V[e]={c:R(n[a],o,s),e:s}}var h=Q({},V[e].e);return(0,t.default)(V[e].c+\";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=\"+r+\"}\",e,h,W(h),i)},$=function(){return[n,r,e,i,o,s,h,c,x,k,v,C,y,M,S,A,T,D,I,U,Tt,it,ot]},_=function(){return[n,r,e,i,o,s,f,p,w,m,z,b,v,j,N,y,F,E,Z,q,O,G,L,H,T,D,P,K,kt,it]},tt=function(){return[pt,gt,ct,Y,B]},nt=function(){return[vt,dt]},rt=function(){return[yt,ct,J]},et=function(){return[mt]},it=function(t){return postMessage(t,[t.buffer])},ot=function(t){return t&&{out:t.size&&new n(t.size),dictionary:t.dictionary}},st=function(t,n,r,e,i,o){var s=X(r,e,i,(function(t,n){s.terminate(),o(t,n)}));return s.postMessage([t,n],n.consume?[t.buffer]:[]),function(){s.terminate()}},at=function(t){return t.ondata=function(t,n){return postMessage([t,n],[t.buffer])},function(n){n.data.length?(t.push(n.data[0],n.data[1]),postMessage([n.data[0].length])):t.flush()}},ut=function(t,n,r,e,i,o,s){var a,u=X(t,e,i,(function(t,r){t?(u.terminate(),n.ondata.call(n,t)):Array.isArray(r)?1==r.length?(n.queuedSize-=r[0],n.ondrain&&n.ondrain(r[0])):(r[1]&&u.terminate(),n.ondata.call(n,t,r[0],r[1])):s(r)}));u.postMessage(r),n.queuedSize=0,n.push=function(t,r){n.ondata||I(5),a&&n.ondata(I(4,0,1),null,!!r),n.queuedSize+=t.length,u.postMessage([t,a=r],[t.buffer])},n.terminate=function(){u.terminate()},o&&(n.flush=function(){u.postMessage([])})},ht=function(t,n){return t[n]|t[n+1]<<8},ft=function(t,n){return(t[n]|t[n+1]<<8|t[n+2]<<16|t[n+3]<<24)>>>0},lt=function(t,n){return ft(t,n)+4294967296*ft(t,n+4)},ct=function(t,n,r){for(;r;++n)t[n]=r,r>>>=8},pt=function(t,n){var r=n.filename;if(t[0]=31,t[1]=139,t[2]=8,t[8]=n.level<2?4:9==n.level?2:0,t[9]=3,0!=n.mtime&&ct(t,4,Math.floor(new Date(n.mtime||Date.now())/1e3)),r){t[3]=8;for(var e=0;e<=r.length;++e)t[e+10]=r.charCodeAt(e)}},vt=function(t){31==t[0]&&139==t[1]&&8==t[2]||I(6,\"invalid gzip data\");var n=t[3],r=10;4&n&&(r+=2+(t[10]|t[11]<<8));for(var e=(n>>3&1)+(n>>4&1);e>0;e-=!t[r++]);return r+(2&n)},dt=function(t){var n=t.length;return(t[n-4]|t[n-3]<<8|t[n-2]<<16|t[n-1]<<24)>>>0},gt=function(t){return 10+(t.filename?t.filename.length+1:0)},yt=function(t,n){var r=n.level,e=0==r?0:r<6?1:9==r?3:2;if(t[0]=120,t[1]=e<<6|(n.dictionary&&32),t[1]|=31-(t[0]<<8|t[1])%31,n.dictionary){var i=J();i.p(n.dictionary),ct(t,2,i.d())}},mt=function(t,n){return(8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31)&&I(6,\"invalid zlib data\"),(t[1]>>5&1)==+!n&&I(6,\"invalid zlib data: \"+(32&t[1]?\"need\":\"unexpected\")+\" dictionary\"),2+(t[1]>>3&4)};function bt(t,n){return\"function\"==typeof t&&(n=t,t={}),this.ondata=n,t}var wt=function(){function t(t,r){if(\"function\"==typeof t&&(r=t,t={}),this.ondata=r,this.o=t||{},this.s={l:0,i:32768,w:32768,z:32768},this.b=new n(98304),this.o.dictionary){var e=this.o.dictionary.subarray(-32768);this.b.set(e,32768-e.length),this.s.i=32768-e.length}}return t.prototype.p=function(t,n){this.ondata(K(t,this.o,0,0,this.s),n)},t.prototype.push=function(t,r){this.ondata||I(5),this.s.l&&I(4);var e=t.length+this.s.z;if(e>this.b.length){if(e>2*this.b.length-32768){var i=new n(-32768&e);i.set(this.b.subarray(0,this.s.z)),this.b=i}var o=this.b.length-this.s.z;this.b.set(t.subarray(0,o),this.s.z),this.s.z=this.b.length,this.p(this.b,!1),this.b.set(this.b.subarray(-32768)),this.b.set(t.subarray(o),32768),this.s.z=t.length-o+32768,this.s.i=32766,this.s.w=32768}else this.b.set(t,this.s.z),this.s.z+=t.length;this.s.l=1&r,(this.s.z>this.s.w+8191||r)&&(this.p(this.b,r||!1),this.s.w=this.s.i,this.s.i-=2)},t.prototype.flush=function(){this.ondata||I(5),this.s.l&&I(4),this.p(this.b,!1),this.s.w=this.s.i,this.s.i-=2},t}();_e.Deflate=wt;var xt=function(){return function(t,n){ut([_,function(){return[at,wt]}],this,bt.call(this,t,n),(function(t){var n=new wt(t.data);onmessage=at(n)}),6,1)}}();function zt(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[_],(function(t){return it(kt(t.data[0],t.data[1]))}),0,r)}function kt(t,n){return K(t,n||{},0,0)}_e.AsyncDeflate=xt,_e.deflate=zt,_e.deflateSync=kt;var Mt=function(){function t(t,r){\"function\"==typeof t&&(r=t,t={}),this.ondata=r;var e=t&&t.dictionary&&t.dictionary.subarray(-32768);this.s={i:0,b:e?e.length:0},this.o=new n(32768),this.p=new n(0),e&&this.o.set(e)}return t.prototype.e=function(t){if(this.ondata||I(5),this.d&&I(4),this.p.length){if(t.length){var r=new n(this.p.length+t.length);r.set(this.p),r.set(t,this.p.length),this.p=r}}else this.p=t},t.prototype.c=function(t){this.s.i=+(this.d=t||!1);var n=this.s.b,r=U(this.p,this.s,this.o);this.ondata(D(r,n,this.s.b),this.d),this.o=D(r,this.s.b-32768),this.s.b=this.o.length,this.p=D(this.p,this.s.p/8|0),this.s.p&=7},t.prototype.push=function(t,n){this.e(t),this.c(n)},t}();_e.Inflate=Mt;var St=function(){return function(t,n){ut([$,function(){return[at,Mt]}],this,bt.call(this,t,n),(function(t){var n=new Mt(t.data);onmessage=at(n)}),7,0)}}();function At(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[$],(function(t){return it(Tt(t.data[0],ot(t.data[1])))}),1,r)}function Tt(t,n){return U(t,{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncInflate=St,_e.inflate=At,_e.inflateSync=Tt;var Dt=function(){function t(t,n){this.c=Y(),this.l=0,this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),this.l+=t.length,wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=K(t,this.o,this.v&&gt(this.o),n&&8,this.s);this.v&&(pt(r,this.o),this.v=0),n&&(ct(r,r.length-8,this.c.d()),ct(r,r.length-4,this.l)),this.ondata(r,n)},t.prototype.flush=function(){wt.prototype.flush.call(this)},t}();_e.Gzip=Dt,_e.Compress=Dt;var Ct=function(){return function(t,n){ut([_,tt,function(){return[at,wt,Dt]}],this,bt.call(this,t,n),(function(t){var n=new Dt(t.data);onmessage=at(n)}),8,1)}}();function It(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[_,tt,function(){return[Ut]}],(function(t){return it(Ut(t.data[0],t.data[1]))}),2,r)}function Ut(t,n){n||(n={});var r=Y(),e=t.length;r.p(t);var i=K(t,n,gt(n),8),o=i.length;return pt(i,n),ct(i,o-8,r.d()),ct(i,o-4,e),i}_e.AsyncGzip=Ct,_e.AsyncCompress=Ct,_e.gzip=It,_e.compress=It,_e.gzipSync=Ut,_e.compressSync=Ut;var Ft=function(){function t(t,n){this.v=1,this.r=0,Mt.call(this,t,n)}return t.prototype.push=function(t,r){if(Mt.prototype.e.call(this,t),this.r+=t.length,this.v){var e=this.p.subarray(this.v-1),i=e.length>3?vt(e):4;if(i>e.length){if(!r)return}else this.v>1&&this.onmember&&this.onmember(this.r-e.length);this.p=e.subarray(i),this.v=0}Mt.prototype.c.call(this,r),!this.s.f||this.s.l||r||(this.v=T(this.s.p)+9,this.s={i:0},this.o=new n(0),this.push(new n(0),r))},t}();_e.Gunzip=Ft;var Et=function(){return function(t,n){var r=this;ut([$,nt,function(){return[at,Mt,Ft]}],this,bt.call(this,t,n),(function(t){var n=new Ft(t.data);n.onmember=function(t){return postMessage(t)},onmessage=at(n)}),9,0,(function(t){return r.onmember&&r.onmember(t)}))}}();function Zt(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[$,nt,function(){return[qt]}],(function(t){return it(qt(t.data[0],t.data[1]))}),3,r)}function qt(t,r){var e=vt(t);return e+8>t.length&&I(6,\"invalid gzip data\"),U(t.subarray(e,-8),{i:2},r&&r.out||new n(dt(t)),r&&r.dictionary)}_e.AsyncGunzip=Et,_e.gunzip=Zt,_e.gunzipSync=qt;var Ot=function(){function t(t,n){this.c=J(),this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=K(t,this.o,this.v&&(this.o.dictionary?6:2),n&&4,this.s);this.v&&(yt(r,this.o),this.v=0),n&&ct(r,r.length-4,this.c.d()),this.ondata(r,n)},t.prototype.flush=function(){wt.prototype.flush.call(this)},t}();_e.Zlib=Ot;var Gt=function(){return function(t,n){ut([_,rt,function(){return[at,wt,Ot]}],this,bt.call(this,t,n),(function(t){var n=new Ot(t.data);onmessage=at(n)}),10,1)}}();function Lt(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[_,rt,function(){return[Ht]}],(function(t){return it(Ht(t.data[0],t.data[1]))}),4,r)}function Ht(t,n){n||(n={});var r=J();r.p(t);var e=K(t,n,n.dictionary?6:2,4);return yt(e,n),ct(e,e.length-4,r.d()),e}_e.AsyncZlib=Gt,_e.zlib=Lt,_e.zlibSync=Ht;var jt=function(){function t(t,n){Mt.call(this,t,n),this.v=t&&t.dictionary?2:1}return t.prototype.push=function(t,n){if(Mt.prototype.e.call(this,t),this.v){if(this.p.length<6&&!n)return;this.p=this.p.subarray(mt(this.p,this.v-1)),this.v=0}n&&(this.p.length<4&&I(6,\"invalid zlib data\"),this.p=this.p.subarray(0,-4)),Mt.prototype.c.call(this,n)},t}();_e.Unzlib=jt;var Nt=function(){return function(t,n){ut([$,et,function(){return[at,Mt,jt]}],this,bt.call(this,t,n),(function(t){var n=new jt(t.data);onmessage=at(n)}),11,0)}}();function Pt(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),st(t,n,[$,et,function(){return[Bt]}],(function(t){return it(Bt(t.data[0],ot(t.data[1])))}),5,r)}function Bt(t,n){return U(t.subarray(mt(t,n&&n.dictionary),-4),{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncUnzlib=Nt,_e.unzlib=Pt,_e.unzlibSync=Bt;var Yt=function(){function t(t,n){this.o=bt.call(this,t,n)||{},this.G=Ft,this.I=Mt,this.Z=jt}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r){t.ondata(n,r)}},t.prototype.push=function(t,r){if(this.ondata||I(5),this.s)this.s.push(t,r);else{if(this.p&&this.p.length){var e=new n(this.p.length+t.length);e.set(this.p),e.set(t,this.p.length)}else this.p=t;this.p.length>2&&(this.s=31==this.p[0]&&139==this.p[1]&&8==this.p[2]?new this.G(this.o):8!=(15&this.p[0])||this.p[0]>>4>7||(this.p[0]<<8|this.p[1])%31?new this.I(this.o):new this.Z(this.o),this.i(),this.s.push(this.p,r),this.p=null)}},t}();_e.Decompress=Yt;var Jt=function(){function t(t,n){Yt.call(this,t,n),this.queuedSize=0,this.G=Et,this.I=St,this.Z=Nt}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r,e){t.ondata(n,r,e)},this.s.ondrain=function(n){t.queuedSize-=n,t.ondrain&&t.ondrain(n)}},t.prototype.push=function(t,n){this.queuedSize+=t.length,Yt.prototype.push.call(this,t,n)},t}();function Kt(t,n,r){return r||(r=n,n={}),\"function\"!=typeof r&&I(7),31==t[0]&&139==t[1]&&8==t[2]?Zt(t,n,r):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?At(t,n,r):Pt(t,n,r)}function Qt(t,n){return 31==t[0]&&139==t[1]&&8==t[2]?qt(t,n):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?Tt(t,n):Bt(t,n)}_e.AsyncDecompress=Jt,_e.decompress=Kt,_e.decompressSync=Qt;var Rt=function(t,r,e,i){for(var o in t){var s=t[o],a=r+o,u=i;Array.isArray(s)&&(u=Q(i,s[1]),s=s[0]),s instanceof n?e[a]=[s,u]:(e[a+=\"/\"]=[new n(0),u],Rt(s,a,e,i))}},Vt=\"undefined\"!=typeof TextEncoder&&new TextEncoder,Wt=\"undefined\"!=typeof TextDecoder&&new TextDecoder,Xt=0;try{Wt.decode(N,{stream:!0}),Xt=1}catch(t){}var $t=function(t){for(var n=\"\",r=0;;){var e=t[r++],i=(e>127)+(e>223)+(e>239);if(r+i>t.length)return{s:n,r:D(t,r-1)};i?3==i?(e=((15&e)<<18|(63&t[r++])<<12|(63&t[r++])<<6|63&t[r++])-65536,n+=String.fromCharCode(55296|e>>10,56320|1023&e)):n+=String.fromCharCode(1&i?(31&e)<<6|63&t[r++]:(15&e)<<12|(63&t[r++])<<6|63&t[r++]):n+=String.fromCharCode(e)}},_t=function(){function t(t){this.ondata=t,Xt?this.t=new TextDecoder:this.p=N}return t.prototype.push=function(t,r){if(this.ondata||I(5),r=!!r,this.t)return this.ondata(this.t.decode(t,{stream:!0}),r),void(r&&(this.t.decode().length&&I(8),this.t=null));this.p||I(4);var e=new n(this.p.length+t.length);e.set(this.p),e.set(t,this.p.length);var i=$t(e),o=i.s,s=i.r;r?(s.length&&I(8),this.p=null):this.p=s,this.ondata(o,r)},t}();_e.DecodeUTF8=_t;var tn=function(){function t(t){this.ondata=t}return t.prototype.push=function(t,n){this.ondata||I(5),this.d&&I(4),this.ondata(nn(t),this.d=n||!1)},t}();function nn(t,r){if(r){for(var e=new n(t.length),i=0;i<t.length;++i)e[i]=t.charCodeAt(i);return e}if(Vt)return Vt.encode(t);var o=t.length,s=new n(t.length+(t.length>>1)),a=0,u=function(t){s[a++]=t};for(i=0;i<o;++i){if(a+5>s.length){var h=new n(a+8+(o-i<<1));h.set(s),s=h}var f=t.charCodeAt(i);f<128||r?u(f):f<2048?(u(192|f>>6),u(128|63&f)):f>55295&&f<57344?(u(240|(f=65536+(1047552&f)|1023&t.charCodeAt(++i))>>18),u(128|f>>12&63),u(128|f>>6&63),u(128|63&f)):(u(224|f>>12),u(128|f>>6&63),u(128|63&f))}return D(s,0,a)}function rn(t,n){if(n){for(var r=\"\",e=0;e<t.length;e+=16384)r+=String.fromCharCode.apply(null,t.subarray(e,e+16384));return r}if(Wt)return Wt.decode(t);var i=$t(t),o=i.s;return(r=i.r).length&&I(8),o}_e.EncodeUTF8=tn,_e.strToU8=nn,_e.strFromU8=rn;var en=function(t){return 1==t?3:t<6?2:9==t?1:0},on=function(t,n){return n+30+ht(t,n+26)+ht(t,n+28)},sn=function(t,n,r){var e=ht(t,n+28),i=rn(t.subarray(n+46,n+46+e),!(2048&ht(t,n+8))),o=n+46+e,s=ft(t,n+20),a=r&&4294967295==s?an(t,o):[s,ft(t,n+24),ft(t,n+42)],u=a[0],h=a[1],f=a[2];return[ht(t,n+10),u,h,i,o+ht(t,n+30)+ht(t,n+32),f]},an=function(t,n){for(;1!=ht(t,n);n+=4+ht(t,n+2));return[lt(t,n+12),lt(t,n+4),lt(t,n+20)]},un=function(t){var n=0;if(t)for(var r in t){var e=t[r].length;e>65535&&I(9),n+=e+4}return n},hn=function(t,n,r,e,i,o,s,a){var u=e.length,h=r.extra,f=a&&a.length,l=un(h);ct(t,n,null!=s?33639248:67324752),n+=4,null!=s&&(t[n++]=20,t[n++]=r.os),t[n]=20,n+=2,t[n++]=r.flag<<1|(o<0&&8),t[n++]=i&&8,t[n++]=255&r.compression,t[n++]=r.compression>>8;var c=new Date(null==r.mtime?Date.now():r.mtime),p=c.getFullYear()-1980;if((p<0||p>119)&&I(10),ct(t,n,p<<25|c.getMonth()+1<<21|c.getDate()<<16|c.getHours()<<11|c.getMinutes()<<5|c.getSeconds()>>1),n+=4,-1!=o&&(ct(t,n,r.crc),ct(t,n+4,o<0?-o-2:o),ct(t,n+8,r.size)),ct(t,n+12,u),ct(t,n+14,l),n+=16,null!=s&&(ct(t,n,f),ct(t,n+6,r.attrs),ct(t,n+10,s),n+=14),t.set(e,n),n+=u,l)for(var v in h){var d=h[v],g=d.length;ct(t,n,+v),ct(t,n+2,g),t.set(d,n+4),n+=4+g}return f&&(t.set(a,n),n+=f),n},fn=function(t,n,r,e,i){ct(t,n,101010256),ct(t,n+8,r),ct(t,n+10,r),ct(t,n+12,e),ct(t,n+16,i)},ln=function(){function t(t){this.filename=t,this.c=Y(),this.size=0,this.compression=0}return t.prototype.process=function(t,n){this.ondata(null,t,n)},t.prototype.push=function(t,n){this.ondata||I(5),this.c.p(t),this.size+=t.length,n&&(this.crc=this.c.d()),this.process(t,n||!1)},t}();_e.ZipPassThrough=ln;var cn=function(){function t(t,n){var r=this;n||(n={}),ln.call(this,t),this.d=new wt(n,(function(t,n){r.ondata(null,t,n)})),this.compression=8,this.flag=en(n.level)}return t.prototype.process=function(t,n){try{this.d.push(t,n)}catch(t){this.ondata(t,null,n)}},t.prototype.push=function(t,n){ln.prototype.push.call(this,t,n)},t}();_e.ZipDeflate=cn;var pn=function(){function t(t,n){var r=this;n||(n={}),ln.call(this,t),this.d=new xt(n,(function(t,n,e){r.ondata(t,n,e)})),this.compression=8,this.flag=en(n.level),this.terminate=this.d.terminate}return t.prototype.process=function(t,n){this.d.push(t,n)},t.prototype.push=function(t,n){ln.prototype.push.call(this,t,n)},t}();_e.AsyncZipDeflate=pn;var vn=function(){function t(t){this.ondata=t,this.u=[],this.d=1}return t.prototype.add=function(t){var r=this;if(this.ondata||I(5),2&this.d)this.ondata(I(4+8*(1&this.d),0,1),null,!1);else{var e=nn(t.filename),i=e.length,o=t.comment,s=o&&nn(o),a=i!=t.filename.length||s&&o.length!=s.length,u=i+un(t.extra)+30;i>65535&&this.ondata(I(11,0,1),null,!1);var h=new n(u);hn(h,0,t,e,a,-1);var f=[h],l=function(){for(var t=0,n=f;t<n.length;t++)r.ondata(null,n[t],!1);f=[]},c=this.d;this.d=0;var p=this.u.length,v=Q(t,{f:e,u:a,o:s,t:function(){t.terminate&&t.terminate()},r:function(){if(l(),c){var t=r.u[p+1];t?t.r():r.d=1}c=1}}),d=0;t.ondata=function(e,i,o){if(e)r.ondata(e,i,o),r.terminate();else if(d+=i.length,f.push(i),o){var s=new n(16);ct(s,0,134695760),ct(s,4,t.crc),ct(s,8,d),ct(s,12,t.size),f.push(s),v.c=d,v.b=u+d+16,v.crc=t.crc,v.size=t.size,c&&v.r(),c=1}else c&&l()},this.u.push(v)}},t.prototype.end=function(){var t=this;2&this.d?this.ondata(I(4+8*(1&this.d),0,1),null,!0):(this.d?this.e():this.u.push({r:function(){1&t.d&&(t.u.splice(-1,1),t.e())},t:function(){}}),this.d=3)},t.prototype.e=function(){for(var t=0,r=0,e=0,i=0,o=this.u;i<o.length;i++)e+=46+(h=o[i]).f.length+un(h.extra)+(h.o?h.o.length:0);for(var s=new n(e+22),a=0,u=this.u;a<u.length;a++){var h;hn(s,t,h=u[a],h.f,h.u,-h.c-2,r,h.o),t+=46+h.f.length+un(h.extra)+(h.o?h.o.length:0),r+=h.b}fn(s,t,this.u.length,e,r),this.ondata(null,s,!0),this.d=2},t.prototype.terminate=function(){for(var t=0,n=this.u;t<n.length;t++)n[t].t();this.d=2},t}();function dn(t,r,e){e||(e=r,r={}),\"function\"!=typeof e&&I(7);var i={};Rt(t,\"\",i,r);var o=Object.keys(i),s=o.length,a=0,u=0,h=s,f=Array(s),l=[],c=function(){for(var t=0;t<l.length;++t)l[t]()},p=function(t,n){xn((function(){e(t,n)}))};xn((function(){p=e}));var v=function(){var t=new n(u+22),r=a,e=u-a;u=0;for(var i=0;i<h;++i){var o=f[i];try{var s=o.c.length;hn(t,u,o,o.f,o.u,s);var l=30+o.f.length+un(o.extra),c=u+l;t.set(o.c,c),hn(t,a,o,o.f,o.u,s,u,o.m),a+=16+l+(o.m?o.m.length:0),u=c+s}catch(t){return p(t,null)}}fn(t,a,f.length,e,r),p(null,t)};s||v();for(var d=function(t){var n=o[t],r=i[n],e=r[0],h=r[1],d=Y(),g=e.length;d.p(e);var y=nn(n),m=y.length,b=h.comment,w=b&&nn(b),x=w&&w.length,z=un(h.extra),k=0==h.level?0:8,M=function(r,e){if(r)c(),p(r,null);else{var i=e.length;f[t]=Q(h,{size:g,crc:d.d(),c:e,f:y,m:w,u:m!=n.length||w&&b.length!=x,compression:k}),a+=30+m+z+i,u+=76+2*(m+z)+(x||0)+i,--s||v()}};if(m>65535&&M(I(11,0,1),null),k)if(g<16e4)try{M(null,kt(e,h))}catch(t){M(t,null)}else l.push(zt(e,h,M));else M(null,e)},g=0;g<h;++g)d(g);return c}function gn(t,r){r||(r={});var e={},i=[];Rt(t,\"\",e,r);var o=0,s=0;for(var a in e){var u=e[a],h=u[0],f=u[1],l=0==f.level?0:8,c=(M=nn(a)).length,p=f.comment,v=p&&nn(p),d=v&&v.length,g=un(f.extra);c>65535&&I(11);var y=l?kt(h,f):h,m=y.length,b=Y();b.p(h),i.push(Q(f,{size:h.length,crc:b.d(),c:y,f:M,m:v,u:c!=a.length||v&&p.length!=d,o:o,compression:l})),o+=30+c+g+m,s+=76+2*(c+g)+(d||0)+m}for(var w=new n(s+22),x=o,z=s-o,k=0;k<i.length;++k){var M;hn(w,(M=i[k]).o,M,M.f,M.u,M.c.length);var S=30+M.f.length+un(M.extra);w.set(M.c,M.o+S),hn(w,o,M,M.f,M.u,M.c.length,M.o,M.m),o+=16+S+(M.m?M.m.length:0)}return fn(w,o,i.length,z,x),w}_e.Zip=vn,_e.zip=dn,_e.zipSync=gn;var yn=function(){function t(){}return t.prototype.push=function(t,n){this.ondata(null,t,n)},t.compression=0,t}();_e.UnzipPassThrough=yn;var mn=function(){function t(){var t=this;this.i=new Mt((function(n,r){t.ondata(null,n,r)}))}return t.prototype.push=function(t,n){try{this.i.push(t,n)}catch(t){this.ondata(t,null,n)}},t.compression=8,t}();_e.UnzipInflate=mn;var bn=function(){function t(t,n){var r=this;n<32e4?this.i=new Mt((function(t,n){r.ondata(null,t,n)})):(this.i=new St((function(t,n,e){r.ondata(t,n,e)})),this.terminate=this.i.terminate)}return t.prototype.push=function(t,n){this.i.terminate&&(t=D(t,0)),this.i.push(t,n)},t.compression=8,t}();_e.AsyncUnzipInflate=bn;var wn=function(){function t(t){this.onfile=t,this.k=[],this.o={0:yn},this.p=N}return t.prototype.push=function(t,r){var e=this;if(this.onfile||I(5),this.p||I(4),this.c>0){var i=Math.min(this.c,t.length),o=t.subarray(0,i);if(this.c-=i,this.d?this.d.push(o,!this.c):this.k[0].push(o),(t=t.subarray(i)).length)return this.push(t,r)}else{var s=0,a=0,u=void 0,h=void 0;this.p.length?t.length?((h=new n(this.p.length+t.length)).set(this.p),h.set(t,this.p.length)):h=this.p:h=t;for(var f=h.length,l=this.c,c=l&&this.d,p=function(){var t,n=ft(h,a);if(67324752==n){s=1,u=a,v.d=null,v.c=0;var r=ht(h,a+6),i=ht(h,a+8),o=2048&r,c=8&r,p=ht(h,a+26),d=ht(h,a+28);if(f>a+30+p+d){var g=[];v.k.unshift(g),s=2;var y,m=ft(h,a+18),b=ft(h,a+22),w=rn(h.subarray(a+30,a+=30+p),!o);4294967295==m?(t=c?[-2]:an(h,a),m=t[0],b=t[1]):c&&(m=-1),a+=d,v.c=m;var x={name:w,compression:i,start:function(){if(x.ondata||I(5),m){var t=e.o[i];t||x.ondata(I(14,\"unknown compression type \"+i,1),null,!1),(y=m<0?new t(w):new t(w,m,b)).ondata=function(t,n,r){x.ondata(t,n,r)};for(var n=0,r=g;n<r.length;n++)y.push(r[n],!1);e.k[0]==g&&e.c?e.d=y:y.push(N,!0)}else x.ondata(null,N,!0)},terminate:function(){y&&y.terminate&&y.terminate()}};m>=0&&(x.size=m,x.originalSize=b),v.onfile(x)}return\"break\"}if(l){if(134695760==n)return u=a+=12+(-2==l&&8),s=3,v.c=0,\"break\";if(33639248==n)return u=a-=4,s=3,v.c=0,\"break\"}},v=this;a<f-4&&\"break\"!==p();++a);if(this.p=N,l<0){var d=h.subarray(0,s?u-12-(-2==l&&8)-(134695760==ft(h,u-16)&&4):a);c?c.push(d,!!s):this.k[+(2==s)].push(d)}if(2&s)return this.push(h.subarray(a),r);this.p=h.subarray(a)}r&&(this.c&&I(13),this.p=null)},t.prototype.register=function(t){this.o[t.compression]=t},t}();_e.Unzip=wn;var xn=\"function\"==typeof queueMicrotask?queueMicrotask:\"function\"==typeof setTimeout?setTimeout:function(t){t()};function zn(t,r,e){e||(e=r,r={}),\"function\"!=typeof e&&I(7);var i=[],o=function(){for(var t=0;t<i.length;++t)i[t]()},s={},a=function(t,n){xn((function(){e(t,n)}))};xn((function(){a=e}));for(var u=t.length-22;101010256!=ft(t,u);--u)if(!u||t.length-u>65558)return a(I(13,0,1),null),o;var h=ht(t,u+8);if(h){var f=h,l=ft(t,u+16),c=4294967295==l||65535==f;if(c){var p=ft(t,u-12);(c=101075792==ft(t,p))&&(f=h=ft(t,p+32),l=ft(t,p+48))}for(var v=r&&r.filter,d=function(r){var e=sn(t,l,c),u=e[0],f=e[1],p=e[2],d=e[3],g=e[4],y=on(t,e[5]);l=g;var m=function(t,n){t?(o(),a(t,null)):(n&&(s[d]=n),--h||a(null,s))};if(!v||v({name:d,size:f,originalSize:p,compression:u}))if(u)if(8==u){var b=t.subarray(y,y+f);if(p<524288||f>.8*p)try{m(null,Tt(b,{out:new n(p)}))}catch(t){m(t,null)}else i.push(At(b,{size:p},m))}else m(I(14,\"unknown compression type \"+u,1),null);else m(null,D(t,y,y+f));else m(null,null)},g=0;g<f;++g)d()}else a(null,{});return o}function kn(t,r){for(var e={},i=t.length-22;101010256!=ft(t,i);--i)(!i||t.length-i>65558)&&I(13);var o=ht(t,i+8);if(!o)return{};var s=ft(t,i+16),a=4294967295==s||65535==o;if(a){var u=ft(t,i-12);(a=101075792==ft(t,u))&&(o=ft(t,u+32),s=ft(t,u+48))}for(var h=r&&r.filter,f=0;f<o;++f){var l=sn(t,s,a),c=l[0],p=l[1],v=l[2],d=l[3],g=l[4],y=on(t,l[5]);s=g,h&&!h({name:d,size:p,originalSize:v,compression:c})||(c?8==c?e[d]=Tt(t.subarray(y,y+p),{out:new n(v)}):I(14,\"unknown compression type \"+c):e[d]=D(t,y,y+p))}return e}_e.unzip=zn,_e.unzipSync=kn;return _e});";
let _fflateCache = null;
function loadFflate() {
  if (_fflateCache) return _fflateCache;
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", FFLATE_UMD_SOURCE)(m, m.exports);
  if (!m.exports || typeof m.exports.unzipSync !== "function") {
    throw new Error("fflate failed to expose unzipSync");
  }
  _fflateCache = m.exports;
  return m.exports;
}

// ===========================================================================
// X2tConverter — WASM DOCX <-> Editor.bin
// (Adapted minimally from obsidian-docx-viewer to run in-process)
// ===========================================================================

class X2tConverter {
  // x2tRel  — vault-relative path to the x2t/ assets dir (x2t.js + x2t.wasm)
  // fontsRel — vault-relative path to a shipped font subset (mobile + future)
  // fontsAbs — absolute system fonts dir (desktop only; null on mobile)
  // x2tAbs  — absolute path to x2t dir (desktop only; needed for Emscripten locateFile)
  constructor(plugin, opts) {
    this.plugin   = plugin;
    this.x2tRel   = opts.x2tRel;
    this.x2tAbs   = opts.x2tAbs || null;
    this.fontsRel = opts.fontsRel || null;
    this.fontsAbs = opts.fontsAbs || null;
    this.module   = null;
    this.initP    = null;
  }

  async ensureInit() {
    if (this.module && this.module.FS) return;
    if (!this.initP) this.initP = this._init();
    await this.initP;
  }

  async _init() {
    const x2tJsRel   = vio.join(this.x2tRel, "x2t.js");
    const x2tWasmRel = vio.join(this.x2tRel, "x2t.wasm");

    const [jsOk, wasmOk] = await Promise.all([
      vio.exists(this.plugin, x2tJsRel),
      vio.exists(this.plugin, x2tWasmRel),
    ]);
    if (!jsOk || !wasmOk) {
      throw new Error("x2t assets missing. Expected at: " + this.x2tRel);
    }

    const [wasmBinary, x2tCode] = await Promise.all([
      vio.readBinary(this.plugin, x2tWasmRel),
      vio.readText(this.plugin, x2tJsRel),
    ]);

    return new Promise((resolve, reject) => {
      const x2tAbs = this.x2tAbs;
      globalThis.Module = {
        noInitialRun:   true,
        noExitRuntime:  true,
        wasmBinary:     wasmBinary, // already an ArrayBuffer from adapter.readBinary
        // locateFile returns absolute paths on desktop (where Emscripten uses
        // fs to load auxiliary files). On mobile this currently echoes the
        // input — auxiliary loads aren't expected since wasmBinary is set
        // directly and our VFS is preloaded before main1() runs.
        locateFile: (file) => {
          if (x2tAbs) {
            return file.endsWith(".wasm") ? path.join(x2tAbs, "x2t.wasm") : path.join(x2tAbs, file);
          }
          return file;
        },
        onRuntimeInitialized: () => {
          this.module = globalThis.Module;
          this._setupVFS()
            .then(resolve)
            .catch(reject);
        },
      };
      try {
        // eslint-disable-next-line no-eval
        (0, eval)(x2tCode);
      } catch (err) {
        reject(new Error("Failed to load x2t.js: " + err.message));
      }
    });
  }

  async _setupVFS() {
    const FS = this.module.FS;
    if (!FS) throw new Error("x2t FS missing after init");
    this._mkdir(FS, "/working");
    this._mkdir(FS, "/working/media");
    this._mkdir(FS, "/working/fonts");
    this._mkdir(FS, "/working/themes");
    await this._loadFonts(FS);
  }

  _mkdir(FS, dir) {
    try { FS.mkdir(dir); } catch (e) { /* ignore EEXIST */ }
  }

  async _loadFonts(FS) {
    // Two sources, in order:
    //   1. Shipped font subset (vault-relative, both platforms) — primary on mobile
    //   2. System fonts dir (absolute, desktop only) — primary on desktop
    // Skip silently if not present.
    let loaded = 0;
    const limit = 150;

    if (this.fontsRel && (await vio.exists(this.plugin, this.fontsRel))) {
      loaded += await this._walkRel(FS, this.fontsRel, "/working/fonts", limit - loaded);
      dlog("loaded", loaded, "fonts from shipped subset:", this.fontsRel);
    }

    if (this.fontsAbs && !isMobile && vioAbs.exists(this.fontsAbs)) {
      const before = loaded;
      loaded += this._walkAbs(FS, this.fontsAbs, "/working/fonts", limit - loaded);
      dlog("loaded", loaded - before, "fonts from system dir:", this.fontsAbs);
    }

    if (loaded === 0) {
      dlog("no fonts loaded — fontsRel:", this.fontsRel, "fontsAbs:", this.fontsAbs);
    }
  }

  async _walkRel(FS, rel, vfs, budget) {
    if (budget <= 0) return 0;
    let loaded = 0;
    let entries;
    try { entries = await vio.list(this.plugin, rel); }
    catch (e) { return 0; }
    for (const folder of entries.folders || []) {
      if (loaded >= budget) break;
      const name = folder.split("/").pop();
      const v = vfs + "/" + name;
      this._mkdir(FS, v);
      loaded += await this._walkRel(FS, folder, v, budget - loaded);
    }
    for (const file of entries.files || []) {
      if (loaded >= budget) break;
      const name = file.split("/").pop();
      if (!/\.tt[fc]$/i.test(name)) continue;
      try {
        const data = await vio.readBinary(this.plugin, file);
        FS.writeFile(vfs + "/" + name, new Uint8Array(data));
        loaded++;
      } catch (e) { /* skip */ }
    }
    return loaded;
  }

  _walkAbs(FS, real, vfs, budget) {
    if (budget <= 0) return 0;
    let loaded = 0;
    let entries;
    try { entries = vioAbs.readdir(real); }
    catch (e) { return 0; }
    for (const entry of entries) {
      if (loaded >= budget) break;
      const r = path.join(real, entry.name);
      const v = vfs + "/" + entry.name;
      if (entry.isDirectory()) {
        this._mkdir(FS, v);
        loaded += this._walkAbs(FS, r, v, budget - loaded);
      } else if (/\.tt[fc]$/i.test(entry.name)) {
        try {
          const data = vioAbs.readBinary(r);
          FS.writeFile(v, new Uint8Array(data));
          loaded++;
        } catch (e) { /* skip */ }
      }
    }
    return loaded;
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
  // opts.plugin    — owning plugin (for vio adapter access)
  // opts.fontsRel  — vault-relative path to numbered fonts dir (preferred)
  // opts.fontsDir  — absolute path to numbered fonts dir (desktop fallback)
  constructor(opts) {
    this.plugin    = opts.plugin || null;
    this.converter = opts.converter;
    this.onSave    = opts.onSave || (async () => {});
    this._fontsDir = opts.fontsDir || "";
    this._fontsRel = opts.fontsRel || "";
    // Spellcheck asset roots — vault-relative paths used by getSpellAsset
    // to constrain reads. Anything outside these prefixes is rejected.
    this._spellAssetRoots = (opts.spellAssetRoots || []).filter(Boolean);
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

    // Multi-instance guard — if multiple TransportBridges are attached to
    // the same window (e.g. two .docx tabs open simultaneously), a
    // doc-specific RPC could be answered by the bridge that does NOT own
    // the docKey, returning an error reply that races with the real
    // bridge's success reply and breaks the editor. Silently ignore such
    // calls so only the owning bridge responds. doc-independent methods
    // (getFont) are still answered by everyone.
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
        case "getFont":          payload = await this._getFont(d.payload); break;
        case "getSpellAsset":    payload = await this._getSpellAsset(d.payload); break;
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

  async _getFont(payload) {
    const fontFile = (payload && payload.fontFile) || "";
    if (!fontFile) return { ok: false };

    const tryRead = async (rel) => {
      try {
        if (this.plugin && (await vio.exists(this.plugin, rel))) {
          const buf = await vio.readBinary(this.plugin, rel);
          // adapter.readBinary returns ArrayBuffer; ensure we return a clean copy
          return { ok: true, bytes: buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + buf.byteLength) };
        }
      } catch (e) { /* fall through */ }
      return null;
    };
    const tryReadAbs = (abs) => {
      if (isMobile) return null;
      try {
        if (vioAbs.exists(abs)) {
          const data = vioAbs.readBinary(abs);
          return { ok: true, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
        }
      } catch (e) { /* fall through */ }
      return null;
    };

    // Primary: vault-relative (works on both platforms; preferred on mobile)
    if (this._fontsRel) {
      const r = await tryRead(vio.join(this._fontsRel, fontFile));
      if (r) return r;
    }
    // Fallback: absolute (desktop only)
    if (this._fontsDir) {
      const r = tryReadAbs(path.join(this._fontsDir, fontFile));
      if (r) return r;
    }

    // Arial 029 fallback for missing fonts
    if (this._fontsRel) {
      const r = await tryRead(vio.join(this._fontsRel, "029"));
      if (r) { dlog("font fallback:", fontFile, "-> 029 (Arial)"); return r; }
    }
    if (this._fontsDir) {
      const r = tryReadAbs(path.join(this._fontsDir, "029"));
      if (r) { dlog("font fallback:", fontFile, "-> 029 (Arial)"); return r; }
    }

    return { ok: false };
  }

  // Read a spell-check asset (spell.wasm, spell.js.mem, dictionaries .aff/.dic)
  // from disk via vio. Path is constrained to allowlisted roots — any
  // request outside those is rejected. Roots are configured by the plugin
  // at bridge construction (sdkjs/common/spell/spell/, dictionaries/).
  async _getSpellAsset(payload) {
    const rel = (payload && payload.path) || "";
    if (!rel || typeof rel !== "string") return { ok: false, error: "missing path" };

    // Reject path traversal and absolute paths
    if (rel.indexOf("..") !== -1 || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
      return { ok: false, error: "invalid path" };
    }

    // Normalize and allowlist-check
    const norm = rel.replace(/\\/g, "/");
    const allowed = this._spellAssetRoots.some((root) => {
      const r = root.replace(/\\/g, "/").replace(/\/$/, "");
      return norm === r || norm.startsWith(r + "/");
    });
    if (!allowed) {
      dlog("getSpellAsset rejected (outside allowlist):", norm);
      return { ok: false, error: "path not allowed" };
    }

    if (!this.plugin) return { ok: false, error: "no plugin" };
    try {
      if (!(await vio.exists(this.plugin, norm))) return { ok: false, error: "not found" };
      const buf = await vio.readBinary(this.plugin, norm);
      const ab = buf instanceof ArrayBuffer
        ? buf
        : buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + buf.byteLength);
      return { ok: true, bytes: ab };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
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
  // Use Web Crypto API — present in both Electron renderer and Capacitor
  // WKWebView. The module-top `crypto` is the Node module and is null on
  // mobile; `globalThis.crypto` is the Web Crypto API which is separate
  // and always available in browser-like environments.
  const wc = (typeof globalThis !== "undefined" && globalThis.crypto) ||
             (typeof window !== "undefined" && window.crypto);
  if (wc && typeof wc.getRandomValues === "function") {
    const arr = new Uint8Array(bytes);
    wc.getRandomValues(arr);
    let hex = "";
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      hex += (b < 16 ? "0" : "") + b.toString(16);
    }
    return hex;
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return crypto.randomBytes(bytes).toString("hex");
  }
  // Last-resort Math.random — keys are opaque session IDs, not security-bearing.
  let hex = "";
  for (let i = 0; i < bytes; i++) {
    const b = Math.floor(Math.random() * 256);
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

function makeEditorKey(seed) {
  if (crypto && typeof crypto.createHash === "function") {
    return crypto.createHash("sha256")
      .update(String(seed) + Date.now().toString())
      .digest("hex").slice(0, 20);
  }
  return Math.random().toString(16).slice(2, 14) +
         Date.now().toString(16).slice(-8);
}

// Username for the OnlyOffice editor's user.id/name. Desktop reads OS user;
// mobile gets a generic label. Either way OnlyOffice just shows it in the
// presence indicator and uses it for the local editing session.
function getUsername() {
  if (!isMobile) {
    try { return require("os").userInfo().username; } catch (e) {}
  }
  return "Mobile User";
}

// pdf-lib's StandardFonts.Helvetica uses WinAnsi (cp1252) encoding which only
// supports printable ASCII (0x20-0x7E) + most Latin-1 supplement (0xA0-0xFF) +
// a few extras. Drawing chars outside this set throws. For invisible-text PDF
// search/copy purposes, we strip non-encodable chars rather than abort.
function sanitizeForWinAnsi(s) {
  if (!s) return "";
  // Keep printable ASCII, common whitespace (CR, LF, tab), and Latin-1 supplement.
  // Replace tabs with spaces (some PDF readers don't index tabbed text well anyway).
  return String(s)
    .replace(/\t/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, " ");
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
    dlog("DocxView constructed, docKey:", this.docKey);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : "DOCX"; }
  getIcon() { return "file-text"; }

  async onOpen() {
    dlog("DocxView onOpen, hasFile:", !!this.file, "filePath:", this.file ? this.file.path : "(none)");
    try {
      this.containerEl.empty();
      this.containerEl.style.padding = "0";
      if (!this.file) {
        this._renderLandingPage();
      }
    } catch (err) {
      elog("DocxView onOpen threw:", err && err.stack || err);
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
    dlog("DocxView onLoadFile entry, file:", file && file.path, "isMobile:", isMobile);
    try {
      await this._onLoadFileInner(file);
    } catch (err) {
      elog("DocxView onLoadFile top-level threw:", err && err.stack || err);
      try {
        this.containerEl.empty();
        this.containerEl.createEl("pre", {
          text: "Failed to open " + (file && file.path) + "\n\n" + (err && err.stack || err),
          attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
        });
      } catch (e2) {}
    }
  }

  async _onLoadFileInner(file) {
    // Auto-migrate leaves to onlyobsidian-test on DESKTOP only. The test
    // plugin is isDesktopOnly:true so it can never load on mobile — but
    // its id can still appear in enabledPlugins (community-plugins.json
    // sync from desktop). Without the !isMobile guard, mobile would
    // migrate the leaf to a view-type with no registered handler, leaving
    // the landing page stuck on screen until the leaf is destroyed.

    // Check if another leaf already has this file open
    const existingLeaf = this._findExistingLeaf(file);
    if (existingLeaf && existingLeaf !== this.leaf) {
      dlog("duplicate leaf detected — revealing existing, detaching this one");
      this.app.workspace.revealLeaf(existingLeaf);
      this.leaf.detach();
      return;
    }
    dlog("onLoadFile proceeding with file:", file && file.path);

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

      await this._renderEditor();
    } catch (err) {
      elog("onLoadFile error:", err);
      this.containerEl.empty();
      this.containerEl.createEl("pre", {
        text: "Failed to open " + file.path + "\n\n" + (err && err.stack || err),
        attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
      });
    }
  }

  // Phase B4 — async, vio-based render.
  // All disk reads are pre-loaded at the top via vio (vault adapter, mobile-
  // safe). The MutationObserver callback then transforms HTML using cached
  // values and stays synchronous — no fs/path inside the observer.
  async _renderEditor() {
    this.containerEl.empty();
    this.containerEl.createEl("div", {
      attr: {
        id: this.placeholderId,
        style: "width: 100%; height: 100%; min-height: 600px;"
      }
    });

    const plugin = this.plugin;
    const baseUrl = plugin.assetBaseUrl;
    const apiSrc = baseUrl + "/web-apps/apps/api/documents/api.js";
    dlog("loading api.js from:", apiSrc);

    // --- Pre-load all asset files via vio ---
    const onlyRel = plugin.onlyOfficeRel;
    const htmlRel = vio.join(onlyRel, "web-apps/apps/documenteditor/main/index.html");
    const apiRel  = vio.join(onlyRel, "web-apps/apps/api/documents/api.js");
    const shimRel = plugin.shimRel;
    const spellJsRel = vio.join(onlyRel, "sdkjs/common/spell/spell/spell.js");
    const htmlDirRel = vio.join(onlyRel, "web-apps/apps/documenteditor/main");
    const svgPathsRel = [
      vio.join(htmlDirRel, "resources/img/iconssmall@2.5x.svg"),
      vio.join(htmlDirRel, "resources/img/iconsbig@2.5x.svg"),
      vio.join(htmlDirRel, "resources/img/iconshuge@2.5x.svg"),
      vio.join(onlyRel,    "web-apps/apps/common/main/resources/img/doc-formats/formats@2.5x.svg"),
    ];

    let htmlTemplate, apiCode;
    try {
      [htmlTemplate, apiCode] = await Promise.all([
        vio.readText(plugin, htmlRel),
        vio.readText(plugin, apiRel),
      ]);
    } catch (err) {
      elog("failed to load editor HTML or api.js:", err);
      this.containerEl.createEl("pre", {
        text: "Failed to load editor assets.\n\n" + (err && err.stack || err),
        attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
      });
      return;
    }

    let shimCode = "";
    try { shimCode = await vio.readText(plugin, shimRel); }
    catch (e) { elog("failed to read transport shim:", e.message); }

    // Spell-check Worker source — pre-cached for the Blob-URL Worker spawn
    // path. Empty string disables the spellcheck Worker shim path; the
    // existing no-op stub is used instead. See docs/spellcheck-architecture.md.
    let spellSrc = "";
    try {
      if (await vio.exists(plugin, spellJsRel)) {
        spellSrc = await vio.readText(plugin, spellJsRel);
        dlog("pre-cached spell.js source (" + spellSrc.length + " chars)");
      }
    } catch (e) { elog("failed to read spell.js (spellcheck will fall back to no-op):", e.message); }

    // Absolute URL of the dictionaries dir, used to override the relative
    // default dictionaries_path that the editor passes to the Worker.
    // adapter.getResourcePath returns an app://hash/... or capacitor://...
    // URL that our Worker shim's RPC bridge can resolve back to a vault path.
    const dictionariesRel = vio.join(plugin.pluginDirRel, "assets/dictionaries");
    let dictionariesUrl = "";
    try {
      if (await vio.exists(plugin, dictionariesRel)) {
        dictionariesUrl = plugin.app.vault.adapter
          .getResourcePath(dictionariesRel)
          .replace(/\?.*$/, "");
      }
    } catch (e) { dictionariesUrl = ""; }
    dlog("dictionariesUrl:", dictionariesUrl || "(missing)");

    // SVG sprites — read in parallel, missing files become empty string
    const svgContents = await Promise.all(svgPathsRel.map(async (p) => {
      try {
        return (await vio.exists(plugin, p)) ? await vio.readText(plugin, p) : "";
      } catch (e) { return ""; }
    }));
    const svgContent = svgContents.join("");

    // CSS files — parse <link> tags from the HTML, read each CSS in parallel
    const linkTags = htmlTemplate.match(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi) || [];
    const cssCache = new Map(); // href (as in HTML) -> { css, cssDirRel }
    await Promise.all(linkTags.map(async (tag) => {
      const m = tag.match(/href=["']([^"']+)["']/);
      if (!m) return;
      const href = m[1];
      const cssRel = vio.resolve(htmlDirRel, href);
      try {
        if (!(await vio.exists(plugin, cssRel))) return;
        const css = await vio.readText(plugin, cssRel);
        cssCache.set(href, { css, cssDirRel: vio.dirname(cssRel) });
      } catch (e) { /* skip missing */ }
    }));

    // api.js frameOrigin patch (in-memory transform — no I/O)
    // api.js derives frameOrigin from iframe.src via:
    //   this.frameOrigin = pathArray[0] + '//' + pathArray[2];
    // That yields "app://hash" from the original src, but our blob iframe's
    // origin is "app://obsidian.md" (inherited from parent). The mismatch
    // causes _onMessage to silently drop ALL messages from the iframe.
    // Fix: replace the derivation with window.location.origin.
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

    // --- MutationObserver: transform iframe HTML using cached values ---
    const filePath = this.file ? this.file.path : "";
    const placeholderId = this.placeholderId;

    const iframeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.tagName !== "IFRAME") continue;
          const src = node.getAttribute("src") || "";
          if (!src.includes("documenteditor/main/index")) continue;

          // Race fix: kill original src load synchronously before any work.
          node.src = "about:blank";
          iframeObserver.disconnect();
          dlog("intercepted editor iframe, original src:", src.substring(0, 120));

          // Parse query params from the original src
          const params = {};
          try {
            const u = new URL(src, "http://dummy");
            u.searchParams.forEach((v, k) => { params[k] = v; });
          } catch (e) {}
          params.docFilePath = filePath;
          // Print-button enable signal for the iframe. Always true on
          // desktop; on mobile, governed by the user setting (defaults to
          // false because Capacitor WKWebView doesn't implement
          // window.print() — see DEFAULT_SETTINGS comment).
          params.enablePrint = !isMobile;

          let html = htmlTemplate;
          const baseHref = baseUrl + "/web-apps/apps/documenteditor/main/";

          // Replace getUrlParams() since blob iframes have no query string
          const qs = Object.entries(params)
            .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
            .join("&");
          html = html.replace(
            "window.location.search.substring(1)",
            JSON.stringify(qs)
          );

          // Spell-check Worker shim — see docs/spellcheck-architecture.md.
          // For non-spell Workers, fall through to no-op stub (existing behavior).
          // For spell.js: spawn a Blob-URL Worker (same-origin with blob iframe)
          // with a fetch+XHR shim prologue that routes asset reads through the
          // existing transport-shim RPC. dictionaries_path is rewritten to an
          // absolute URL so Worker-side relative resolution works.
          const SPELL_DIR_URL = baseUrl + "/sdkjs/common/spell/spell";
          const spellShimEnabled = !!spellSrc && !!dictionariesUrl;
          const workerShim =
            "var _OrigWorker=window.Worker;" +
            "var _SPELL_SRC=" + (spellShimEnabled ? JSON.stringify(spellSrc) : '""') + ";" +
            "var _SPELL_DIR_URL=" + JSON.stringify(SPELL_DIR_URL) + ";" +
            "var _DICT_URL=" + JSON.stringify(dictionariesUrl) + ";" +
            "var _ONLY_REL=" + JSON.stringify(plugin.onlyOfficeRel) + ";" +
            "var _SPELL_REL=" + JSON.stringify(vio.join(plugin.onlyOfficeRel, "sdkjs/common/spell/spell")) + ";" +
            "var _DICT_REL=" + JSON.stringify(vio.join(plugin.pluginDirRel, "assets/dictionaries")) + ";" +
            // Worker-side prologue: overrides self.fetch + XHR, talks to the
            // blob iframe via postMessage RPC. This becomes the FIRST code
            // executed inside the spawned Worker, before spell.js runs.
            "var _SPELL_PROLOGUE=" + JSON.stringify(SPELL_WORKER_PROLOGUE) + ";" +
            "function _resolveSpellPath(url){" +
              "var s=String(url);" +
              "if(s.indexOf(_SPELL_DIR_URL+'/')===0)return _SPELL_REL+'/'+s.substring(_SPELL_DIR_URL.length+1).split('?')[0];" +
              "if(s.indexOf(_DICT_URL+'/')===0)return _DICT_REL+'/'+s.substring(_DICT_URL.length+1).split('?')[0];" +
              "return null;" +
            "}" +
            "function _wireSpellWorker(w){" +
              // RPC bridge: Worker posts {__onlyoSpellRPC:true,type:'fetch',...},
              // we resolve via vio.readBinary in the plugin parent, reply with
              // type:'init' so spell.js's onmessage hits its dup-init guard
              // (self.spellchecker already exists by the time replies arrive).
              "w.addEventListener('message',function(e){" +
                "var d=e.data;" +
                "if(!d||d.__onlyoSpellRPC!==true||d.type!=='fetch')return;" +
                "var path=_resolveSpellPath(d.url);" +
                "if(!path){w.postMessage({__onlyoSpellRPC:true,type:'init',id:d.id,error:'unresolved url: '+d.url});return;}" +
                "if(typeof window.__docxViewerRpc!=='function'){w.postMessage({__onlyoSpellRPC:true,type:'init',id:d.id,error:'rpc not ready'});return;}" +
                "window.__docxViewerRpc('getSpellAsset',{path:path}).then(function(r){" +
                  "if(r&&r.ok){w.postMessage({__onlyoSpellRPC:true,type:'init',id:d.id,bytes:r.bytes},[r.bytes]);}" +
                  "else{w.postMessage({__onlyoSpellRPC:true,type:'init',id:d.id,error:(r&&r.error)||'asset read failed'});}" +
                "}).catch(function(err){w.postMessage({__onlyoSpellRPC:true,type:'init',id:d.id,error:String(err&&err.message||err)});});" +
              "});" +
              // Wrap Worker.postMessage to rewrite the editor's init message
              // dictionaries_path (default is relative — won't resolve from
              // a Blob URL Worker; need absolute URL).
              "var _origPost=w.postMessage.bind(w);" +
              "w.postMessage=function(msg,transfer){" +
                "if(msg&&msg.type==='init'&&typeof msg.dictionaries_path==='string'){msg.dictionaries_path=_DICT_URL;}" +
                "if(transfer)return _origPost(msg,transfer);" +
                "return _origPost(msg);" +
              "};" +
            "}" +
            "window.Worker=function(url,opts){" +
              "var fname=String(url).split('/').pop().split('?')[0];" +
              "if(fname==='spell.js'&&_SPELL_SRC){" +
                "try{" +
                  // Provide an absolute base for spell.wasm via Module.locateFile
                  // so the Worker emits the right URL for our fetch shim to catch.
                  "var modulePrelude='self.Module=self.Module||{};self.Module.locateFile=function(p){return '+JSON.stringify(_SPELL_DIR_URL)+'+\"/\"+p;};';" +
                  "var blob=new Blob([_SPELL_PROLOGUE,modulePrelude,_SPELL_SRC],{type:'text/javascript'});" +
                  "var blobUrl=URL.createObjectURL(blob);" +
                  "var w=new _OrigWorker(blobUrl,opts);" +
                  "w.addEventListener('error',function(ev){console.error('[blob] spell Worker error:',ev.message,'at',ev.filename+\":\"+ev.lineno);});" +
                  "_wireSpellWorker(w);" +
                  "console.log('[blob] spell Worker spawned (Blob URL '+blob.size+' bytes)');" +
                  "return w;" +
                "}catch(e){console.warn('[blob] spell Worker spawn failed:',e&&e.message);}" +
              "}" +
              // Non-spell Workers (or spell-disabled fallback) — try original,
              // otherwise return no-op stub (preserves existing behavior).
              "try{return new _OrigWorker(url,opts);}catch(e){" +
                "console.warn('[blob] Worker blocked (cross-origin), stubbing:',fname);" +
                "var s={postMessage:function(){},terminate:function(){}," +
                "addEventListener:function(){},removeEventListener:function(){}};" +
                "Object.defineProperty(s,'onmessage',{set:function(){},get:function(){return null}});" +
                "Object.defineProperty(s,'onerror',{set:function(){},get:function(){return null}});" +
                "return s;}" +
            "};";

          const paramsScript = "<script>" +
            "window.__oo_params=" + JSON.stringify(params) + ";" +
            "console.log('[blob] iframe loaded, docKey:'," + JSON.stringify(params.frameEditorId || "") + ");" +
            workerShim +
            "</script>";

          const shimScript = shimCode ? "<script>" + shimCode + "</script>" : "";

          html = html.replace(/<head([^>]*)>/i,
            "<head$1>\n" +
            '<base href="' + baseHref + '">\n' +
            paramsScript + "\n" +
            shimScript + "\n"
          );

          // Strip the (pre-patched or runtime-patched) <script src="...transport-shim.js">
          html = html.replace(/<script\s+src="[^"]*transport-shim\.js"><\/script>\s*/g, "");

          // Inline CSS using cache (Obsidian CSP blocks <link> sub-resources from app://hash)
          html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
            const m = tag.match(/href=["']([^"']+)["']/);
            if (!m) return tag;
            const href = m[1];
            const entry = cssCache.get(href);
            if (!entry) {
              dlog("CSS not in cache, keeping link tag:", href);
              return tag;
            }
            let css = entry.css;
            const cssDirRel = entry.cssDirRel;
            // Rewrite url() paths so they resolve relative to <base> (htmlDirRel)
            css = css.replace(/url\(["']?([^"')]+)["']?\)/g, (match, relUrl) => {
              if (relUrl.startsWith("data:") || relUrl.startsWith("http") || relUrl.startsWith("//")) return match;
              const absRel = vio.resolve(cssDirRel, relUrl);
              const fromBase = vio.relative(htmlDirRel, absRel);
              return "url(" + fromBase + ")";
            });
            // Rewrite --sprite-button-icons-base-url (used by JS at runtime)
            css = css.replace(
              /--sprite-button-icons-base-url:\s*([^;}\s]+)/g,
              (match, relPathStr) => {
                if (relPathStr.startsWith("url(")) return match;
                const absRel = vio.resolve(cssDirRel, relPathStr);
                const fromBase = vio.relative(htmlDirRel, absRel);
                return "--sprite-button-icons-base-url:" + fromBase;
              }
            );
            dlog("inlined CSS:", href, "(" + css.length + " chars)");
            return "<style>" + css + "</style>";
          });

          // Pre-inject SVG sprite content (injectSvgIcons() can't fetch from blob iframe)
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
            dlog("pre-injected", svgPathsRel.length, "SVG icon sprites (" + svgContent.length + " chars)");
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

    // --- DocsAPI bootstrap ---
    const create = () => {
      const DocsAPI = window.DocsAPI;
      if (!DocsAPI) {
        elog("DocsAPI not available after api.js load");
        return;
      }
      try {
        const config = this._buildEditorConfig();
        new DocsAPI.DocEditor(placeholderId, config);
      } catch (err) {
        elog("DocEditor init failed:", err);
      }
    };

    if (window.DocsAPI) {
      create();
      return;
    }

    // Marker <script> tag — api.js scans document.scripts for a src ending in
    // api/documents/api.js to derive its base URL. type='text/plain' so the
    // browser doesn't try to fetch it.
    const marker = document.createElement("script");
    marker.type = "text/plain";
    marker.setAttribute("src", apiSrc);
    document.head.appendChild(marker);

    // PostMessage debug logger (one per render — keeps the existing pattern)
    const _pmDebug = (ev) => {
      if (!ev.data) return;
      const d = typeof ev.data === 'string' ? ev.data.substring(0, 120) : JSON.stringify(ev.data).substring(0, 120);
      dlog("postMessage from origin:", ev.origin, "data:", d);
    };
    window.addEventListener("message", _pmDebug);

    try {
      dlog("loading api.js via eval (cached", apiCode.length, "bytes)");
      // eslint-disable-next-line no-eval
      (0, eval)(apiCode);
      create();
    } catch (err) {
      elog("Failed to eval api.js:", err);
      this.containerEl.createEl("pre", {
        text: "Failed to load OnlyOffice api.js via eval()\n\n" + (err && err.stack || err),
        attr: { style: "padding: 16px; color: var(--text-error); white-space: pre-wrap;" }
      });
    }
  }

  _buildEditorConfig() {
    const filename = this.file.basename + "." + this.file.extension;
    const editorKey = makeEditorKey(this.file.path);
    const username = getUsername();

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
        user: { id: username, name: username },
        customization: {
          forcesave: false, autosave: true, chat: false, comments: true,
          about: false, help: false, feedback: false, plugins: false, macros: false,
          goback: false, close: false, compactHeader: true, hideRightMenu: true,
          // Spellcheck re-enabled 2026-04-27 via Blob-URL Worker + Worker-side
          // fetch/XHR shim + en_US/en_CA Hunspell dictionaries (MPL-2.0).
          // See docs/spellcheck-architecture.md for the layered design.
          features: { spellcheck: { mode: true, change: true } }
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

    new obsidian.Setting(containerEl)
      .setName("Asset zip source")
      .setDesc(
        "Where to fetch the trimmed asset zip from when assets are missing. " +
        "Accepts an http(s) URL (production / iPad) or a vault-relative path " +
        "to a zip already in your vault (dev). Leave empty to use the legacy " +
        "streaming-https tar.gz GitHub flow on desktop (mobile requires this set)."
      )
      .addText(t => t
        .setPlaceholder("https://github.com/.../obsidi-office-assets-v9.3.1.zip OR obsidi-office-assets-v9.3.1.zip")
        .setValue(this.plugin.settings.assetZipSource || "")
        .onChange(async v => {
          this.plugin.settings.assetZipSource = v.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName("Re-install assets from zip")
      .setDesc(
        "Triggers the zip-based install flow now (instead of waiting for the " +
        "next plugin reload). Useful when iterating on a new asset bundle."
      )
      .addButton(b => b.setButtonText("Install now").onClick(async () => {
        const src = (this.plugin.settings.assetZipSource || "").trim();
        if (!src) {
          new obsidian.Notice("Set 'Asset zip source' first.");
          return;
        }
        await this.plugin._downloadAssetsViaZip(src);
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
    this.pluginDirRel = pluginDirRel;  // for vio access from method scope (zip install, etc.)
    const basePath = adapter.getBasePath ? adapter.getBasePath() : null;
    if (!basePath) {
      new obsidian.Notice("OnlyObsidian Test: cannot resolve vault base path (desktop only).");
      return;
    }

    const pluginAbs = path.join(basePath, pluginDirRel);
    this.pluginAbs     = pluginAbs;  // for lazy loaders (pdf-lib, etc.)
    this.onlyOfficeDir = path.join(pluginAbs, "assets", "onlyoffice");
    this.x2tDir        = path.join(pluginAbs, "assets", "x2t");
    this.shimAbs       = path.join(pluginAbs, "assets", "docx-viewer", "transport-shim.js");
    this.mockSocketAbs = path.join(pluginAbs, "assets", "docx-viewer", "mock-socket.js");
    this.x2tRel        = vio.join(pluginDirRel, "assets/x2t");
    this.x2tFontsRel   = vio.join(pluginDirRel, "assets/x2t-fonts");
    this.onlyOfficeRel = vio.join(pluginDirRel, "assets/onlyoffice");
    this.shimRel       = vio.join(pluginDirRel, "assets/docx-viewer/transport-shim.js");

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
      dlog("assets missing — starting install");
      // Phase B3 — prefer the zip-based flow when assetZipSource is set.
      // Falls back to the legacy streaming-https/tar.gz flow on desktop when
      // the setting is empty, so existing dev workflows keep working until
      // zip-flow proves universal.
      const zipSrc = (this.settings.assetZipSource || "").trim();
      if (zipSrc) {
        // Phase B4.3 — background install. Don't await — extracting ~1000
        // files takes long enough that Obsidian fires its "plugin taking
        // too long" warning if onload blocks. Detach the install, show a
        // clear notice, and bail. User reloads when "Assets installed"
        // appears. Subsequent loads find assets present and skip this.
        new obsidian.Notice(
          "Obsidi-Office: Installing assets in background. " +
          "Reload Obsidian when the 'Assets installed' notice appears.",
          0
        );
        this._downloadAssetsViaZip(zipSrc).then((ok) => {
          if (!ok) {
            new obsidian.Notice("Obsidi-Office: asset install failed. See console.", 15000);
          }
        });
        return;
      }
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

    // x2t + bridge. The converter accepts both relative + absolute paths
    // so it can route via vio (vault adapter, mobile-safe) for the assets
    // shipped inside the plugin and via vioAbs (fs sync) for system fonts.
    this.converter = new X2tConverter(this, {
      x2tRel:   this.x2tRel,
      x2tAbs:   this.x2tDir,
      // Shipped metric-only font subset (~5.6 MB, 44 .ttf files produced by
      // scripts/subset-fonts.py). Byte-identical x2t output vs full system
      // fonts. On desktop this loads additively with fontsAbs (system dir);
      // on mobile this is the only source x2t sees (OS sandboxes system fonts).
      // If the directory doesn't exist (e.g. older installs that only ran the
      // legacy streaming-https tar.gz), X2tConverter._loadFonts silently
      // skips it and falls through to fontsAbs.
      fontsRel: this.x2tFontsRel,
      fontsAbs: this.fontsDir,   // C:\Windows\Fonts on desktop
    });
    this.bridge = new TransportBridge({
      plugin:    this,
      converter: this.converter,
      fontsRel:  vio.join(this.onlyOfficeRel, "fonts"),
      fontsDir:  this.onlyOfficeDir ? path.join(this.onlyOfficeDir, "fonts") : null,
      // Spellcheck asset roots (vault-relative). getSpellAsset reads are
      // strictly constrained to these prefixes — anything outside is rejected.
      spellAssetRoots: [
        vio.join(this.onlyOfficeRel, "sdkjs/common/spell/spell"),
        vio.join(pluginDirRel, "assets/dictionaries"),
      ],
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
    // After fork consolidation there is only one docx plugin.
    try { this.registerExtensions(["docx"], VIEW_TYPE); } catch (e) {
      elog("registerExtensions failed:", e.message);
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
        this._printDocument(ev.data.images, ev.data.pageMmW, ev.data.pageMmH);
        // Iframe overlay can hide as soon as the print iframe takes over.
        this._notifyPdfDone(null);
      }
      if (ev.data.type === "obsidi-office-pdf-export" && ev.data.pages) {
        this._exportPdfToVault(ev.data).catch((err) => {
          elog("PDF export failed:", err);
          new obsidian.Notice("PDF export failed: " + (err.message || err));
          this._notifyPdfDone(null);
        });
      }
      // (obsidi-office-pdf-diagnostic handler removed 2026-04-29 — diagnostic
      //  probes were development-only; PDF export now ships via the print-
      //  preview API. Lessons preserved in vault decisions/2026-04.md and
      //  meta/lessons.md under 2026-04-29.)
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

  // Phase B3 — runtime asset delivery via pre-packaged zip. `source` is
  // either an http(s) URL (production / iPad) or a vault-relative path to
  // a local zip (dev). Returns true on success.
  async _downloadAssetsViaZip(source) {
    const notice = new obsidian.Notice("Obsidi-Office: Preparing assets...", 0);
    try {
      // 1. Fetch zip bytes
      let zipBytes;
      if (/^https?:\/\//i.test(source)) {
        notice.setMessage("Obsidi-Office: Downloading assets...");
        const r = await obsidian.requestUrl({ url: source });
        zipBytes = new Uint8Array(r.arrayBuffer);
      } else {
        notice.setMessage("Obsidi-Office: Reading local asset zip...");
        const buf = await vio.readBinary(this, source);
        zipBytes = new Uint8Array(buf);
      }
      dlog("zip bytes:", zipBytes.length);

      // 2. Extract via fflate (vendored at lib/fflate.umd.js; see loadFflate)
      notice.setMessage("Obsidi-Office: Extracting " +
        (zipBytes.length / 1048576).toFixed(0) + " MB...");
      const fflate = await loadFflate(this);
      const entries = fflate.unzipSync(zipBytes);
      const fileNames = Object.keys(entries).filter(n => !n.endsWith("/") && entries[n].length > 0);
      dlog("zip entries:", fileNames.length, "files");

      // 3. Write each entry to the plugin assets dir via vault adapter.
      // Pre-create directories — adapter.mkdir is non-recursive on mobile.
      const dirsCreated = new Set();
      const ensureDir = async (relDir) => {
        if (!relDir || relDir === "." || dirsCreated.has(relDir)) return;
        if (await vio.exists(this, relDir)) { dirsCreated.add(relDir); return; }
        const parent = relDir.split("/").slice(0, -1).join("/");
        if (parent) await ensureDir(parent);
        await vio.mkdir(this, relDir);
        dirsCreated.add(relDir);
      };

      let written = 0;
      const total = fileNames.length;
      const progressEvery = Math.max(1, Math.floor(total / 20));
      for (const name of fileNames) {
        const targetRel = vio.join(this.pluginDirRel, "assets", name);
        const targetDir = targetRel.split("/").slice(0, -1).join("/");
        await ensureDir(targetDir);
        await vio.writeBinary(this, targetRel, entries[name].buffer.slice(
          entries[name].byteOffset,
          entries[name].byteOffset + entries[name].byteLength
        ));
        written++;
        if (written % progressEvery === 0) {
          notice.setMessage("Obsidi-Office: Installing " + written + " / " + total + " files...");
        }
      }

      notice.setMessage("Obsidi-Office: Assets installed (" + total + " files). Reload to activate.");
      setTimeout(() => notice.hide(), 6000);
      dlog("zip install complete:", total, "files");
      return true;
    } catch (err) {
      elog("zip install failed:", err);
      notice.setMessage("Obsidi-Office: Asset install failed: " + (err && err.message || err));
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

  _printDocument(images, pageMmW, pageMmH) {
    // Direct print via hidden iframe in the parent (Obsidian) window.
    // Electron treats iframes as separate documents for print purposes:
    // iframe.contentWindow.print() prints ONLY the iframe content, not
    // the full BrowserWindow. Same pattern as P11_TaskBoard and
    // P13_HomeInventory.
    //
    // Pagination + exact layout: each image is OnlyOffice's authoritative
    // per-page render (asc_drawPrintPreview output). @page sized to the
    // document's actual page dimensions (mm) so 1 image = 1 print page,
    // and page-break-after: always enforces the page boundary.
    const pageSize = (pageMmW && pageMmH && pageMmW > 0 && pageMmH > 0)
      ? `${pageMmW}mm ${pageMmH}mm`
      : "letter";

    let body = "";
    for (const src of images) {
      body += '<img src="' + src + '">';
    }

    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print</title><style>' +
      '@page { size: ' + pageSize + '; margin: 0; } ' +
      'html, body { margin: 0; padding: 0; background: white; } ' +
      'img { display: block; width: 100%; height: 100%; page-break-after: always; } ' +
      'img:last-child { page-break-after: avoid; } ' +
      '@media print { html, body { width: 100%; height: 100%; } }' +
      '</style></head><body>' + body + '</body></html>';

    const iframe = document.createElement("iframe");
    iframe.style.cssText =
      "position: fixed; left: -9999px; top: -9999px; width: 0; height: 0; " +
      "border: 0; visibility: hidden;";
    iframe.srcdoc = html;

    iframe.addEventListener("load", () => {
      // Small delay so the iframe's image elements have actually rendered
      // their bitmaps before the print dialog samples them.
      setTimeout(() => {
        try {
          const win = iframe.contentWindow;
          if (!win) return;
          win.focus();
          win.print();
        } catch (e) {
          elog("Print failed:", e);
          new obsidian.Notice("Print failed: " + (e.message || e));
        }
        // Detach the iframe shortly after — the print dialog has its own
        // captured render and stays open even if the iframe is removed.
        setTimeout(() => { try { iframe.remove(); } catch (e) {} }, 2000);
      }, 100);
    }, { once: true });

    document.body.appendChild(iframe);
    dlog("print: opened print dialog (" + images.length + " pages, " + pageSize + ")");
  }

  // Hybrid PDF export: each page = canvas image (visible) + invisible text
  // overlay (searchable). Text rendering mode 3 in PDF spec = "invisible";
  // viewers index it for Ctrl+F and copy-paste but don't paint it.
  //
  // payload: { docKey, pages: [{dataUrl, text, w, h}], basename }
  async _exportPdfToVault(payload) {
    if (!this.pluginAbs) {
      new obsidian.Notice("PDF export: plugin not initialised");
      return;
    }
    const lib = loadPdfLib(this.pluginAbs);
    const { PDFDocument, StandardFonts, rgb } = lib;

    const pages = payload.pages || [];
    if (pages.length === 0) {
      new obsidian.Notice("PDF export: no pages");
      return;
    }

    dlog("Exporting PDF (" + pages.length + " pages)...");
    const t0 = Date.now();

    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // mm → PDF points: 1 inch = 25.4 mm = 72 points.
    const MM_TO_PT = 72 / 25.4;

    for (const p of pages) {
      const dataUrl = p.dataUrl || "";
      const b64 = dataUrl.indexOf(",") >= 0 ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      const pngBytes = Uint8Array.from(Buffer.from(b64, "base64"));
      const png = await pdfDoc.embedPng(pngBytes);

      // PDF page size: prefer the document's actual page dimensions in mm
      // (so the PDF is Letter/A4 sized, not viewport-canvas sized). Fall back
      // to the captured PNG dimensions if mm sizing isn't available.
      let pdfW, pdfH;
      if (p.pageMmW && p.pageMmH && p.pageMmW > 0 && p.pageMmH > 0) {
        pdfW = p.pageMmW * MM_TO_PT;
        pdfH = p.pageMmH * MM_TO_PT;
      } else {
        pdfW = png.width;
        pdfH = png.height;
      }

      const pdfPage = pdfDoc.addPage([pdfW, pdfH]);
      pdfPage.drawImage(png, { x: 0, y: 0, width: pdfW, height: pdfH });

      // Invisible text layer. opacity:0 + color rgb(1,1,1) keeps the bytes in
      // the page content stream (indexed by PDF readers for Ctrl+F and copy)
      // without painting. Helvetica is WinAnsi-only — we strip chars outside.
      //
      // Preferred path: spatially-aligned per-line placement using line-band
      // positions detected by pixel scan of the rendered canvas. Each text
      // chunk drawn at the detected baseline of its line, so search highlights
      // land on the correct visual line. Fallback: top-of-page text dump if
      // pixel-scan detection failed (e.g. tainted canvas).
      const runs = Array.isArray(p.textRuns) ? p.textRuns : [];
      const cw = p.w || png.width;
      const ch = p.h || png.height;
      const sx = pdfW / cw;
      const sy = pdfH / ch;

      if (runs.length > 0) {
        let placed = 0, skipped = 0;
        for (const r of runs) {
          const text = sanitizeForWinAnsi(r.text == null ? "" : String(r.text));
          if (!text.length) { skipped++; continue; }
          const fontSizePx = (typeof r.fontSizePx === "number" && r.fontSizePx > 0) ? r.fontSizePx : 12;
          const pdfFontSize = Math.max(1, fontSizePx * sy);
          const pdfX = r.x * sx;
          // Canvas y is from top, baseline; PDF y is from bottom, baseline.
          const pdfY = pdfH - r.y * sy;
          try {
            pdfPage.drawText(text, {
              x: pdfX,
              y: pdfY,
              font: helvetica,
              size: pdfFontSize,
              color: rgb(1, 1, 1),
              opacity: 0,
            });
            placed++;
          } catch (e) {
            skipped++;
          }
        }
        dlog("page " + (pages.indexOf(p) + 1) + ": placed " + placed + " runs, skipped " + skipped);
      } else {
        const text = sanitizeForWinAnsi(p.text || "");
        if (text.length > 0) {
          try {
            pdfPage.drawText(text, {
              x: 4,
              y: pdfH - 12,
              font: helvetica,
              size: 8,
              color: rgb(1, 1, 1),
              opacity: 0,
              maxWidth: pdfW - 8,
              lineHeight: 9,
            });
          } catch (e) {
            dlog("invisible text layer failed for one page (skipping):", e.message);
          }
        }
      }
      // Yield to the event loop between pages so the host-side notice/UI stays
      // responsive across the (~50-100ms per page) drawText operations.
      await new Promise((r) => setTimeout(r, 0));
    }

    const pdfBytes = await pdfDoc.save();

    // Resolve target path: <docDir>/<basename>.pdf next to the .docx.
    // Prefer docFilePath sent from the iframe; fall back to docKey lookup via bridge.
    const basename = (payload.basename || "document").replace(/\.docx$/i, "");
    const docPath = payload.docFilePath || this._lookupDocFilePath(payload.docKey) || "";
    const docDir = docPath ? docPath.split("/").slice(0, -1).join("/") : "";
    const targetPath = (docDir ? docDir + "/" : "") + basename + ".pdf";

    await this.app.vault.adapter.writeBinary(targetPath, pdfBytes);
    const ms = Date.now() - t0;
    dlog("PDF exported:", targetPath, "(" + (pdfBytes.byteLength / 1024).toFixed(1) + " KB) in", ms, "ms");

    // Open the produced PDF in a new Obsidian tab. Wait one tick for the
    // vault to register the new file before resolving its TFile.
    try {
      await new Promise((r) => setTimeout(r, 100));
      const file = this.app.vault.getAbstractFileByPath(targetPath);
      if (file instanceof obsidian.TFile) {
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(file);
      } else {
        dlog("PDF written but TFile not yet resolvable for", targetPath);
      }
    } catch (err) {
      elog("Failed to open exported PDF:", err);
    }

    // Notify all editor iframes to hide their PDF loading overlay.
    this._notifyPdfDone(targetPath);

    new obsidian.Notice("PDF exported");
  }

  _notifyPdfDone(targetPath) {
    try {
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((f) => {
        try { f.contentWindow.postMessage({ type: "docx-viewer-pdf-done", path: targetPath || null }, "*"); }
        catch (e) {}
      });
    } catch (e) {}
  }

  _lookupDocFilePath(docKey) {
    if (!this.bridge || !docKey) return null;
    const d = this.bridge.docs.get(docKey);
    return d ? d.filePath : null;
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
