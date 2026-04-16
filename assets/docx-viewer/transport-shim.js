/* eslint-disable */
/*
 * obsidian-docx-viewer transport shim
 *
 * This script is injected as the FIRST script in the OnlyOffice
 * editor iframe (documenteditor/main/index.html and *_loader.html),
 * BEFORE any OnlyOffice code executes.
 *
 * Goal: make the editor think it's talking to a real document server
 * over HTTP, when in fact every dynamic request is routed back to
 * the Obsidian plugin via window.parent postMessage.
 *
 * It does three things:
 *   1. Patches XMLHttpRequest and fetch so that requests to known
 *      dynamic endpoints are intercepted and answered by the parent.
 *   2. Establishes a postMessage RPC channel to the parent.
 *   3. Reads docKey + parentOrigin from URL params (api.js sets them).
 */
(function () {
  "use strict";

  // ---------- config (read from query params api.js stamps onto the iframe) ----------
  var PARAMS = (function () {
    try {
      return new URLSearchParams(window.location.search);
    } catch (e) {
      return { get: function () { return null; } };
    }
  })();
  var DOC_KEY = PARAMS.get("frameEditorId")
    || (window.__oo_params && window.__oo_params.frameEditorId)
    || "";
  var PARENT_ORIGIN = "*";  // Always "*": blob/file iframe → app:// parent; security via __shim field

  // Paths that look "dynamic" - these will be routed via postMessage rather
  // than served from app://. Everything else falls through to the native
  // fetch/XHR (which the browser will resolve against the page's app:// base).
  var DYNAMIC = [
    /\/document(\/)?(\?|$)/,      // GET Editor.bin
    /\/media\//,                  // GET embedded media
    /\/media-manifest(\?|$)/,     // GET media manifest JSON
    /\/downloadas\//,             // POST save (the critical one)
    /\/upload\//,                 // POST embedded image upload
    /\/callback(\?|$)/,           // POST callback (mostly unused)
    /\/fonts\/\d+/                // GET numbered font files (need fallback for missing)
  ];

  function isDynamic(url) {
    if (typeof url !== "string") url = String(url);
    for (var i = 0; i < DYNAMIC.length; i++) {
      if (DYNAMIC[i].test(url)) return true;
    }
    return false;
  }

  // ---------- RPC ----------
  var _rpcSeq = 0;
  var _pending = Object.create(null);

  window.addEventListener("message", function (ev) {
    // ignore messages that don't carry the right shape
    var d = ev && ev.data;
    if (!d || d.__shim !== "docx-viewer") return;
    if (d.type === "rpc-reply") {
      var slot = _pending[d.id];
      if (!slot) return;
      delete _pending[d.id];
      slot.resolve(d.payload);
    }
  });

  function rpc(method, payload, transfer) {
    return new Promise(function (resolve, reject) {
      var id = ++_rpcSeq;
      _pending[id] = { resolve: resolve, reject: reject };
      var msg = {
        __shim: "docx-viewer",
        type: "rpc-call",
        id: id,
        method: method,
        docKey: DOC_KEY,
        payload: payload
      };
      try {
        if (transfer && transfer.length) {
          window.parent.postMessage(msg, PARENT_ORIGIN, transfer);
        } else {
          window.parent.postMessage(msg, PARENT_ORIGIN);
        }
      } catch (e) {
        delete _pending[id];
        reject(e);
      }
    });
  }

  // ---------- helpers ----------
  function makeResponse(body, init) {
    init = init || {};
    var status = init.status || 200;
    var headers = init.headers || { "Content-Type": "application/json" };
    return new Response(body, { status: status, headers: headers });
  }

  function jsonReply(obj) {
    return makeResponse(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  function urlPathOf(input) {
    try {
      var u = new URL(input, window.location.href);
      return u.pathname + u.search;
    } catch (e) {
      return String(input);
    }
  }

  // ---------- handlers ----------
  // Every dynamic request becomes one of these. They all return Promises.

  function handleGetDocument() {
    return rpc("getDocument", { docKey: DOC_KEY }).then(function (r) {
      // r = { ok, bytes (ArrayBuffer) }
      if (!r || !r.ok) return makeResponse("", { status: 404 });
      return makeResponse(r.bytes, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" }
      });
    });
  }

  function handleGetMedia(path) {
    var name = decodeURIComponent(path.replace(/^.*\/media\//, "").split("?")[0]);
    return rpc("getMedia", { docKey: DOC_KEY, name: name }).then(function (r) {
      if (!r || !r.ok) return makeResponse("", { status: 404 });
      return makeResponse(r.bytes, {
        status: 200,
        headers: { "Content-Type": r.contentType || "application/octet-stream" }
      });
    });
  }

  function handleGetMediaManifest() {
    return rpc("getMediaManifest", { docKey: DOC_KEY }).then(function (r) {
      return jsonReply((r && r.list) || []);
    });
  }

  function handleDownloadAs(url, body) {
    // body is a Uint8Array / ArrayBuffer / string of Editor.bin chunk(s)
    // Parse cmd from URL string directly (URL constructor fails with blob: base URLs)
    var cmdRaw = null;
    try {
      var cmdMatch = url.match(/[?&]cmd=([^&]+)/);
      if (cmdMatch) cmdRaw = decodeURIComponent(cmdMatch[1]);
    } catch (e) { /* ignore */ }
    var cmd = null;
    try { cmd = cmdRaw ? JSON.parse(cmdRaw) : null; } catch (e) { /* ignore */ }
    return rpc("downloadAs", {
      docKey: DOC_KEY,
      cmd: cmd,
      body: body  // Transferable when ArrayBuffer
    }).then(function (r) {
      var reply = (r && r.reply) || { error: 0 };
      // On successful save, show saved indicator and send documentOpen notification
      // to clear the editor's loading spinner (same pattern as original plugin)
      if (reply.status === "ok" && cmd && (cmd.c === "save" || cmd.c === "savefromorigin")) {
        if (window.__showSaved) window.__showSaved();
        if (window.__mockSocket) {
          setTimeout(function () {
            window.__mockSocket._fire("message", {
              type: "documentOpen",
              data: { type: "save", status: "ok", data: "data:," }
            });
          }, 100);
        }
      }
      return jsonReply(reply);
    });
  }

  function handleUpload(url, body, contentType) {
    // Keep the original body as a blob for creating a blob URL later
    var uploadBlob = body ? new Blob([body], { type: contentType || "image/png" }) : null;
    return rpc("upload", { docKey: DOC_KEY, url: url, body: body, contentType: contentType || "" })
      .then(function (r) {
        var reply = (r && r.reply) || { error: 0 };
        // Convert /media/ URLs to blob: URLs for native image loading.
        // The editor creates <img src="..."> with the returned URL — fetch/XHR
        // interception doesn't cover native image loads in blob iframes.
        if (uploadBlob) {
          for (var key in reply) {
            if (reply.hasOwnProperty(key) && typeof reply[key] === "string" &&
                reply[key].indexOf("/media/") !== -1) {
              reply[key] = URL.createObjectURL(uploadBlob);
              break;
            }
          }
        }
        return jsonReply(reply);
      });
  }

  function handleGetFont(path) {
    var fontFile = path.replace(/^.*\/fonts\//, "").split("?")[0];
    return rpc("getFont", { docKey: DOC_KEY, fontFile: fontFile }).then(function (r) {
      if (!r || !r.ok) return makeResponse("", { status: 404 });
      return makeResponse(r.bytes, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" }
      });
    });
  }

  function handleCallback() {
    // mock socket already short-circuits this path; just ack
    return jsonReply({ error: 0 });
  }

  function dispatch(method, url, body, contentType) {
    var path = urlPathOf(url);
    if (/\/document(\/)?(\?|$)/.test(path) && method === "GET")    return handleGetDocument();
    if (/\/media-manifest(\?|$)/.test(path) && method === "GET")   return handleGetMediaManifest();
    if (/\/media\//.test(path) && method === "GET")                return handleGetMedia(path);
    if (/\/downloadas\//.test(path))                               return handleDownloadAs(url, body);
    if (/\/upload\//.test(path))                                   return handleUpload(url, body, contentType);
    if (/\/fonts\/\d+/.test(path) && method === "GET")             return handleGetFont(path);
    if (/\/callback(\?|$)/.test(path))                             return handleCallback();
    return Promise.resolve(makeResponse("", { status: 404 }));
  }

  // ---------- fetch patch ----------
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (!isDynamic(url)) return nativeFetch(input, init);
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var ct = (init && init.headers && (init.headers["Content-Type"] || init.headers["content-type"])) || "";
    var bodyP = (init && init.body) ? Promise.resolve(init.body).then(toArrayBuffer) : Promise.resolve(null);
    return bodyP.then(function (b) { return dispatch(method, url, b, ct); });
  };

  function toArrayBuffer(b) {
    if (!b) return null;
    if (b instanceof ArrayBuffer) return b;
    if (ArrayBuffer.isView(b))    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    if (typeof b === "string")    return new TextEncoder().encode(b).buffer;
    if (b instanceof Blob)        return b.arrayBuffer();
    if (b instanceof FormData) {
      // OnlyOffice doesn't generally use FormData for the dynamic endpoints
      // we care about, but flatten just in case.
      var out = [];
      b.forEach(function (v, k) { out.push(k + "=" + v); });
      return new TextEncoder().encode(out.join("&")).buffer;
    }
    return null;
  }

  // ---------- XMLHttpRequest patch ----------
  // OnlyOffice's older paths use XHR (especially /downloadas/). We override the
  // minimum surface of XHR to route dynamic URLs through our handler while
  // letting static URLs hit the native implementation untouched.
  var NativeXHR = window.XMLHttpRequest;
  function ShimXHR() {
    this._native = new NativeXHR();
    this._intercepted = false;
    this._method = "GET";
    this._url = "";
    this._listeners = { load: [], error: [], readystatechange: [], progress: [], abort: [], timeout: [] };
    this._respHeaders = "";
    var self = this;
    // Mirror native readyState / status / response to this object via getters
    Object.defineProperty(this, "readyState",   { get: function () { return self._intercepted ? self._readyState : self._native.readyState; }});
    Object.defineProperty(this, "status",       { get: function () { return self._intercepted ? (self._status || 0) : self._native.status; }});
    Object.defineProperty(this, "statusText",   { get: function () { return self._intercepted ? (self._statusText || "") : self._native.statusText; }});
    Object.defineProperty(this, "responseText", { get: function () { return self._intercepted ? (self._responseText || "") : self._native.responseText; }});
    Object.defineProperty(this, "response",     { get: function () { return self._intercepted ? (self._response  != null ? self._response : self._responseText) : self._native.response; }});
    Object.defineProperty(this, "responseType", {
      get: function () { return self._responseTypeUser || self._native.responseType; },
      set: function (v) { self._responseTypeUser = v; try { self._native.responseType = v; } catch (e) {} }
    });
    // Forward unhandled native events for non-intercepted requests
    ["load","error","abort","timeout","progress","readystatechange"].forEach(function (ev) {
      self._native.addEventListener(ev, function (e) {
        if (self._intercepted) return;
        self._fire(ev, e);
      });
    });
  }
  ShimXHR.prototype = {
    open: function (method, url, async, user, pass) {
      this._method = (method || "GET").toUpperCase();
      this._url = url;
      this._intercepted = isDynamic(url);
      if (!this._intercepted) {
        return this._native.open(method, url, async !== false, user, pass);
      }
      this._readyState = 1; // OPENED
      this._fire("readystatechange");
    },
    setRequestHeader: function (k, v) {
      if (!this._intercepted) return this._native.setRequestHeader(k, v);
    },
    send: function (body) {
      if (!this._intercepted) return this._native.send(body);
      var self = this;
      this._readyState = 2; this._fire("readystatechange");
      Promise.resolve(toArrayBuffer(body))
        .then(function (b) { return dispatch(self._method, self._url, b); })
        .then(function (resp) {
          self._status = resp.status;
          self._statusText = resp.statusText || "";
          // We only ever produce JSON or octet-stream bodies, normalise both
          var ct = resp.headers.get("Content-Type") || "";
          var p;
          if (/octet-stream/.test(ct)) {
            p = resp.arrayBuffer().then(function (ab) {
              if (self._responseTypeUser === "arraybuffer") {
                self._response = ab;
                self._responseText = "";
              } else if (self._responseTypeUser === "blob") {
                self._response = new Blob([ab]);
                self._responseText = "";
              } else {
                // last resort: dump as binary string (some legacy paths expect this)
                self._response = ab;
                self._responseText = "";
              }
            });
          } else {
            p = resp.text().then(function (t) {
              self._responseText = t;
              if (self._responseTypeUser === "json") { try { self._response = JSON.parse(t); } catch (e) { self._response = null; } }
              else if (self._responseTypeUser === "" || self._responseTypeUser === "text") self._response = t;
              else self._response = t;
            });
          }
          return p;
        })
        .then(function () {
          self._readyState = 4; self._fire("readystatechange"); self._fire("load");
        })
        .catch(function (err) {
          self._status = 0; self._statusText = "error";
          self._readyState = 4; self._fire("readystatechange"); self._fire("error", err);
        });
    },
    abort: function () {
      if (this._intercepted) {
        this._status = 0; this._readyState = 4; this._fire("readystatechange"); this._fire("abort");
      } else { this._native.abort(); }
    },
    getAllResponseHeaders: function () { return this._intercepted ? this._respHeaders : this._native.getAllResponseHeaders(); },
    getResponseHeader: function (n) { return this._intercepted ? null : this._native.getResponseHeader(n); },
    addEventListener: function (ev, cb) {
      if (this._listeners[ev]) this._listeners[ev].push(cb);
      else this._native.addEventListener(ev, cb);
    },
    removeEventListener: function (ev, cb) {
      if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(function (f) { return f !== cb; });
      else this._native.removeEventListener(ev, cb);
    },
    _fire: function (ev, data) {
      var prop = "on" + ev;
      if (typeof this[prop] === "function") { try { this[prop](data || { type: ev }); } catch (e) {} }
      var arr = this._listeners[ev] || [];
      for (var i = 0; i < arr.length; i++) { try { arr[i](data || { type: ev }); } catch (e) {} }
    }
  };
  // Constants
  ShimXHR.UNSENT = 0; ShimXHR.OPENED = 1; ShimXHR.HEADERS_RECEIVED = 2; ShimXHR.LOADING = 3; ShimXHR.DONE = 4;
  window.XMLHttpRequest = ShimXHR;

  // ---------- announce ready (the parent waits for this before resolving rpc calls) ----------
  try {
    window.parent.postMessage(
      { __shim: "docx-viewer", type: "shim-ready", docKey: DOC_KEY },
      PARENT_ORIGIN
    );
  } catch (e) { /* ignore */ }
})();
