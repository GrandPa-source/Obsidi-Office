/* eslint-disable */
/*
 * OnlyObsidian Test — mock socket.io stand-in
 *
 * Replaces web-apps/vendor/socketio/socket.io.min.js inside the OnlyOffice
 * tree. Provides a fake io() factory whose returned socket completes the
 * OnlyOffice handshake locally and feeds the editor an Editor.bin fetched
 * via a relative URL (which the transport-shim intercepts and routes via
 * postMessage to the plugin).
 *
 * IMPORTANT: OnlyOffice loads socket.io as a RequireJS AMD module
 * (require(['../vendor/socketio/socket.io.min'], ...)). The UMD wrapper
 * at the bottom of this file MUST register via define(e) when define.amd
 * is present, otherwise the editor will hang forever waiting for the
 * socket.io module to resolve.
 */
(function () {
"use strict";

var __OO_TEST_DEBUG_SOCKET = true;
var __docKey = (function () {
  try {
    var p = new URLSearchParams(window.location.search);
    var fei = p.get("frameEditorId");
    if (fei) return fei;
  } catch (e) {}
  // Fallback: injected globals (blob iframe has no query string)
  if (window.__oo_params && window.__oo_params.frameEditorId) {
    return window.__oo_params.frameEditorId;
  }
  return "";
})();

function _slog() {
  if (!__OO_TEST_DEBUG_SOCKET) return;
  try { console.log.apply(console, ["[mock-socket]"].concat([].slice.call(arguments))); } catch (e) {}
}
_slog("loaded, docKey:", __docKey);

function MockSocket(url, opts) {
  _slog("connect to", url);
  this._callbacks = {};
  this.connected = false;
  this._saveIndex = 0;
  this.id = "mock-" + Math.random().toString(36).slice(2, 10);
  var self = this;
  this.io = {
    opts: opts || {},
    _cbs: {},
    on:    function (e, cb) { if (!this._cbs[e]) this._cbs[e] = []; this._cbs[e].push(cb); return this; },
    off:   function (e, cb) { if (this._cbs[e]) this._cbs[e] = this._cbs[e].filter(function (f) { return f !== cb; }); return this; },
    once:  function (e, cb) { return this.on(e, cb); },
    emit:  function () { return this; },
    engine: { on: function () { return this; }, off: function () { return this; } },
    skipReconnect: false,
    uri: typeof url === "string" ? url : ""
  };
  this.nsp = "/";
  this.connected = true;

  setTimeout(function () {
    _slog("firing connect + handshake + auth");
    self._fire("connect");
    self._fire("message", { maxPayload: 100000000, pingInterval: 25000, pingTimeout: 20000, sid: self.id, upgrades: [] });
    self._fire("message", {
      type: "license",
      license: {
        type: 3, buildNumber: 10, buildVersion: "9.3.1", light: false, mode: 0,
        rights: 1, protectionSupport: true, isAnonymousSupport: true,
        liveViewerSupport: true, branding: false, customization: true, advancedApi: false
      }
    });
    self._fire("message", { type: "authChanges", changes: [] });
    self._fire("message", {
      type: "auth", result: 1, sessionId: self.id,
      participants: [{
        connectionId: self.id, encrypted: false, id: "local", idOriginal: "local",
        indexUser: 1, isCloseCoAuthoring: false, isLiveViewer: false,
        username: "Local User", view: false
      }],
      locks: [], indexUser: 1, buildVersion: "9.3.1", buildNumber: 10, licenseType: 3,
      editorType: 2, mode: "edit",
      permissions: {
        comment: true, chat: false, download: true, edit: true, fillForms: true,
        modifyFilter: true, protect: true, print: true, review: false, copy: true
      }
    });

    if (__docKey) {
      var dk = encodeURIComponent(__docKey);
      _slog("fetching Editor.bin + media manifest via relative URLs (shim catches)");
      Promise.all([
        fetch("/document?docKey=" + dk).then(function (r) { return r.blob(); }),
        fetch("/media-manifest?docKey=" + dk).then(function (r) { return r.json(); })
      ]).then(function (results) {
        var editorBlob = results[0];
        var mediaFiles = results[1];
        var dataMap = { "Editor.bin": URL.createObjectURL(editorBlob) };
        // Fetch each media file via shim (RPC) and create blob: URLs.
        // Native image loading (<img src>) can't use /media/ paths — those
        // only work for fetch/XHR which the shim intercepts. Blob URLs work natively.
        var mediaPromises = mediaFiles.map(function (name) {
          return fetch("/media/" + encodeURIComponent(name) + "?docKey=" + dk)
            .then(function (r) { return r.blob(); })
            .then(function (blob) {
              // Key MUST include "media/" prefix — sdkjs K1(name) looks up
              // urls["media/" + name]. Without prefix, lookup fails and the
              // editor falls through to a relative URL that 404s.
              dataMap["media/" + name] = URL.createObjectURL(blob);
            })
            .catch(function () { /* skip failed media */ });
        });
        return Promise.all(mediaPromises).then(function () {
          _slog("delivering documentOpen (" + editorBlob.size + " bytes, " + mediaFiles.length + " media as blobs)");
          self._fire("message", { type: "documentOpen", data: { type: "open", status: "ok", data: dataMap } });
        });
      }).catch(function (err) {
        console.error("[mock-socket] failed to fetch document:", err);
      });
    }
  }, 0);
}

MockSocket.prototype.on = function (event, cb) {
  if (!this._callbacks[event]) this._callbacks[event] = [];
  this._callbacks[event].push(cb);
  return this;
};
MockSocket.prototype.once = function (event, cb) { return this.on(event, cb); };
MockSocket.prototype.off = function (event, cb) {
  if (this._callbacks[event] && cb) {
    this._callbacks[event] = this._callbacks[event].filter(function (f) { return f !== cb; });
  } else if (this._callbacks[event]) {
    delete this._callbacks[event];
  }
  return this;
};
MockSocket.prototype._fire = function (event, data) {
  var cbs = this._callbacks[event] || [];
  for (var i = 0; i < cbs.length; i++) {
    try { cbs[i](data); } catch (e) { console.error("[mock-socket] error in", event, ":", e); }
  }
};
MockSocket.prototype.emit = function (event) {
  var args = Array.prototype.slice.call(arguments, 1);
  _slog("emit:", event);
  if (event === "message") {
    var data = args[0];
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
    var msgType = data && data.type ? data.type : "";
    _slog("message type:", msgType);
    if      (msgType === "auth")           { /* pre-sent */ }
    else if (msgType === "authChangesAck") { /* ack */ }
    else if (msgType === "isSaveLock")     { this._onSaveLock(); }
    else if (msgType === "saveChanges")    { this._onSaveChanges(); }
    else if (msgType === "unSaveLock")     { this._onUnSaveLock(); }
    else if (msgType === "getLock")        { this._onGetLock(data); }
    else if (msgType === "getMessages")    { this._fire("message", { type: "message", messages: [] }); }
    else if (msgType === "clientLog")      { _slog("clientLog:", JSON.stringify(data).slice(0, 200)); }
    else if (msgType === "forceSaveStart") { this._onForceSave(); }
    else if (msgType === "openDocument")   { this._onOpenDocument(data); }
    else if (msgType === "cursor" || msgType === "close") { /* ignore */ }
    else                                   { _slog("unhandled:", msgType); }
  }
  return this;
};
MockSocket.prototype._onGetLock = function (data) {
  var self = this;
  setTimeout(function () {
    self._fire("message", { type: "getLock", locks: [] });
    self._fire("message", { type: "releaseLock", locks: [] });
  }, 10);
};
MockSocket.prototype._onSaveLock = function () {
  var self = this;
  setTimeout(function () {
    self._fire("message", { type: "saveLock", saveLock: false });
  }, 10);
};
MockSocket.prototype._onSaveChanges = function () {
  var self = this;
  self._saveIndex++;
  setTimeout(function () {
    self._fire("message", {
      type: "unSaveLock", index: -1, syncChangesIndex: self._saveIndex, time: Date.now()
    });
  }, 10);
};
MockSocket.prototype._onUnSaveLock = function () {
  var self = this;
  setTimeout(function () {
    self._fire("message", {
      type: "unSaveLock", index: -1, syncChangesIndex: self._saveIndex, time: Date.now()
    });
  }, 10);
};
MockSocket.prototype._onForceSave = function () {
  var self = this;
  var saveTime = Date.now();
  setTimeout(function () {
    self._fire("message", { type: "forceSave", messages: { type: 0, time: saveTime, start: true } });
    setTimeout(function () {
      self._fire("message", { type: "forceSave", messages: { type: 0, time: saveTime, success: true } });
    }, 50);
  }, 10);
};
// Handle imgurls from clipboard paste — upload each data: URL via the
// transport shim's /upload/ endpoint (which routes via postMessage RPC to the bridge)
MockSocket.prototype._onOpenDocument = function (data) {
  var self = this;
  var msg = data.message;
  if (!msg || msg.c !== "imgurls" || !msg.data || !msg.data.length) {
    _slog("openDocument: ignoring non-imgurls command:", msg && msg.c);
    return;
  }

  _slog("imgurls: uploading", msg.data.length, "image(s)");
  var dk = encodeURIComponent(__docKey);
  var results = [];
  var completed = 0;
  var total = msg.data.length;

  function uploadOne(imgSrc, index) {
    var originalBlob = null;
    // imgSrc may be a data: URL (clipboard paste) or an HTTP URL
    fetch(imgSrc).then(function (r) { return r.blob(); }).then(function (blob) {
      originalBlob = blob;
      // POST to /upload/ endpoint (transport shim intercepts → RPC → bridge)
      return fetch("/upload/" + dk + "?docKey=" + dk, {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/png" },
        body: blob
      });
    }).then(function (resp) {
      return resp.json();
    }).then(function (json) {
      for (var key in json) {
        if (json.hasOwnProperty(key)) {
          // Create blob URL from the original image data — native image loading
          // (<img src>) can't use /media/ paths in blob iframes.
          var blobUrl = URL.createObjectURL(originalBlob);
          results[index] = { path: key, url: blobUrl };
          break;
        }
      }
    }).catch(function (err) {
      console.error("[mock-socket] imgurls upload error:", err);
      results[index] = { path: "error", url: "error" };
    }).finally(function () {
      completed++;
      if (completed === total) {
        _slog("imgurls: all uploads done, returning", results.length, "URLs");
        self._fire("message", {
          type: "documentOpen",
          data: {
            type: "imgurls",
            status: "ok",
            data: { urls: results, error: 0 }
          }
        });
      }
    });
  }

  for (var i = 0; i < total; i++) {
    uploadOne(msg.data[i], i);
  }
};

MockSocket.prototype.disconnect = function () { this.connected = false; this._fire("disconnect", "client"); return this; };
MockSocket.prototype.close = MockSocket.prototype.disconnect;

// ===========================================================================
// Save system + UI enhancements (ported from obsidian-docx-viewer)
// ===========================================================================

// Global save function — triggers editor's internal downloadAs flow
// which POSTs to /downloadas/ (intercepted by transport shim → postMessage → bridge)
function triggerSaveToVault() {
  if (typeof window !== "undefined" && window.Asc && window.Asc.editor) {
    try {
      _slog("triggerSaveToVault — asc_DownloadAs(65)");
      window.Asc.editor.asc_DownloadAs(new window.Asc.asc_CDownloadOptions(65));
    } catch (ex) { console.error("[mock-socket] save error:", ex); }
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  // --- UI cleanup CSS ---
  var hideStyle = document.createElement("style");
  hideStyle.textContent =
    "#left-btn-about, #about, #id-about, #left-btn-support, #left-btn-chat, " +
    "#btn-menu-about, .about-menu-panel, #btn-suggest-feature, #fm-btn-suggest { display: none !important; } " +
    "#slot-btn-save, #slot-btn-save .btn-slot, #slot-btn-save button { opacity: 1 !important; pointer-events: auto !important; } " +
    "#fm-btn-save { opacity: 1 !important; pointer-events: auto !important; } " +
    "#header-logo { width: 26px !important; min-width: 0 !important; max-width: 26px !important; " +
    "overflow: hidden !important; padding: 0 4px !important; opacity: 0.15 !important; " +
    "flex-shrink: 1 !important; flex-grow: 0 !important; flex-basis: 26px !important; " +
    "display: flex !important; align-items: center !important; } " +
    "#header-logo i { width: 26px !important; min-width: 0 !important; vertical-align: middle !important; } " +
    "#status-bar-wrapper, .statusbar { padding-right: 50px !important; } " +
    ".statusbar .status-group:last-child { margin-right: 50px !important; }";
  document.head.appendChild(hideStyle);

  // --- Save status indicator SVGs ---
  var refreshSvg = '<svg width="12" height="12" viewBox="-0.45 0 60.369 60.369" xmlns="http://www.w3.org/2000/svg"><g transform="translate(-446.571 -211.615)"><path d="M504.547,265.443h-9.019a30.964,30.964,0,0,0-29.042-52.733,1.5,1.5,0,1,0,.792,2.894,27.955,27.955,0,0,1,25.512,48.253l0-10.169h-.011a1.493,1.493,0,0,0-2.985,0h0v13.255a1.5,1.5,0,0,0,1.5,1.5h13.256a1.5,1.5,0,1,0,0-3Z" fill="#4a90d9"/><path d="M485.389,267.995a27.956,27.956,0,0,1-25.561-48.213l0,10.2h.015a1.491,1.491,0,0,0,2.978,0h.007V216.791a1.484,1.484,0,0,0-1.189-1.532l-.018-.005a1.533,1.533,0,0,0-.223-.022c-.024,0-.046-.007-.07-.007H448.071a1.5,1.5,0,0,0,0,3h8.995a30.963,30.963,0,0,0,29.115,52.664,1.5,1.5,0,0,0-.792-2.894Z" fill="#4a90d9"/></g></svg>';
  var checkSvg = '<svg width="12" height="12" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><g transform="translate(-100 -1139)" fill="#4caf50"><path d="M122.027,1148.07 C121.548,1147.79 120.937,1147.96 120.661,1148.43 L114.266,1159.51 L110.688,1156.21 C110.31,1155.81 109.677,1155.79 109.274,1156.17 C108.871,1156.54 108.85,1157.18 109.228,1157.58 L113.8,1161.8 C114.177,1162.2 114.81,1162.22 115.213,1161.84 C115.335,1161.73 122.393,1149.43 122.393,1149.43 C122.669,1148.96 122.505,1148.34 122.027,1148.07Z M116,1169 C108.268,1169 102,1162.73 102,1155 C102,1147.27 108.268,1141 116,1141 C123.732,1141 130,1147.27 130,1155 C130,1162.73 123.732,1169 116,1169Z M116,1139 C107.164,1139 100,1146.16 100,1155 C100,1163.84 107.164,1171 116,1171 C124.836,1171 132,1163.84 132,1155 C132,1146.16 124.836,1139 116,1139Z"/></g></svg>';

  var saveIndicatorStyle = document.createElement("style");
  saveIndicatorStyle.textContent =
    "#docx-save-indicator { position: absolute; z-index: 99999; pointer-events: none; " +
    "width: 12px; height: 12px; display: flex; align-items: center; justify-content: center; transition: opacity 0.2s; } " +
    ".document-menu-opened #docx-save-indicator, .toolbar-mask #docx-save-indicator, " +
    "body.menu-opened #docx-save-indicator { opacity: 0 !important; } " +
    "#docx-save-indicator.saving svg { animation: docx-spin 1s linear infinite; } " +
    "@keyframes docx-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  document.head.appendChild(saveIndicatorStyle);

  var saveIndicator = document.createElement("div");
  saveIndicator.id = "docx-save-indicator";
  saveIndicator.innerHTML = checkSvg;
  saveIndicator.className = "idle";
  document.body.appendChild(saveIndicator);

  var _savingMinTimer = null;

  function positionSaveIndicator() {
    var btn = document.getElementById("slot-btn-save");
    if (btn && saveIndicator) {
      var rect = btn.getBoundingClientRect();
      saveIndicator.style.left = (rect.left + rect.width / 2 - 6) + "px";
      saveIndicator.style.top = (rect.bottom + 4) + "px";
    }
  }

  var _posTimer = setInterval(function () {
    var btn = document.getElementById("slot-btn-save");
    if (btn) {
      positionSaveIndicator();
      clearInterval(_posTimer);
      var observer = new MutationObserver(function () {
        var panel = document.getElementById("file-menu-panel") || document.querySelector(".panel-menu");
        var toolbar = document.querySelector(".toolbar");
        var isMenuOpen = (panel && panel.offsetParent !== null) ||
          (toolbar && toolbar.style.display === "none") ||
          document.querySelector(".btn-tab-file.active, .ribtab.active[data-tab='file']");
        saveIndicator.style.opacity = isMenuOpen ? "0" : "1";
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    }
  }, 500);

  function showSaving() {
    saveIndicator.innerHTML = refreshSvg;
    saveIndicator.className = "saving";
    positionSaveIndicator();
    if (_savingMinTimer) clearTimeout(_savingMinTimer);
    _savingMinTimer = setTimeout(function () { _savingMinTimer = null; }, 1000);
  }

  function showSaved() {
    var doShow = function () {
      saveIndicator.innerHTML = checkSvg;
      saveIndicator.className = "idle";
      positionSaveIndicator();
    };
    if (_savingMinTimer) {
      var waitInterval = setInterval(function () {
        if (!_savingMinTimer) { clearInterval(waitInterval); doShow(); }
      }, 100);
    } else {
      doShow();
    }
  }

  window.__showSaving = showSaving;
  window.__showSaved = showSaved;

  // --- Ctrl+S interceptor ---
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _slog("Ctrl+S intercepted");
      showSaving();
      setTimeout(triggerSaveToVault, 50);
    }
  }, true);

  // --- Save button interceptor (pointerdown delegation) ---
  document.addEventListener("pointerdown", function (e) {
    var target = e.target;
    while (target && target !== document.body) {
      if (target.id === "slot-btn-save" || target.id === "slot-btn-dt-save" || target.id === "fm-btn-save") {
        _slog("Save button pressed:", target.id);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showSaving();
        setTimeout(triggerSaveToVault, 50);
        return;
      }
      target = target.parentElement;
    }
  }, true);

  // --- Listen for save commands from parent (auto-save, etc.) ---
  window.addEventListener("message", function (e) {
    if (!e.data || !e.data.type) return;
    if (e.data.type === "docx-viewer-show-saving") {
      showSaving();
    }
    if (e.data.type === "docx-viewer-save") {
      _slog("Save via postMessage from parent");
      triggerSaveToVault();
    }
    if (e.data.type === "docx-viewer-print") {
      captureAndPrint();
    }
  });

  // --- Print via canvas capture ---
  function captureAndPrint() {
    if (!window.Asc || !window.Asc.editor) return;
    var editor = window.Asc.editor;
    var pageCount = 1;
    try {
      pageCount = editor.asc_getCountPages ? editor.asc_getCountPages() :
        editor.getCountPages ? editor.getCountPages() : 1;
      if (!pageCount || pageCount < 1) pageCount = 1;
    } catch(e) { pageCount = 1; }
    _slog("print: capturing", pageCount, "pages");

    // Find all canvases and log them for debugging
    var allCanvases = document.querySelectorAll("canvas");
    _slog("print: found", allCanvases.length, "canvases");
    for (var ci = 0; ci < allCanvases.length; ci++) {
      _slog("print: canvas[" + ci + "] id=" + allCanvases[ci].id + " size=" + allCanvases[ci].width + "x" + allCanvases[ci].height);
    }

    // The main editor canvas — try multiple selectors
    var canvas = document.getElementById("id_viewer") ||
      document.getElementById("id_target_cursor") ||
      document.querySelector("canvas");
    if (!canvas) { _slog("print: no canvas found"); return; }
    _slog("print: using canvas", canvas.id, canvas.width + "x" + canvas.height);

    var images = [];
    var currentPage = 0;

    function capturePage() {
      if (currentPage >= pageCount) {
        openPrintWindow(images);
        return;
      }
      if (editor.goToPage) editor.goToPage(currentPage);
      else if (editor.asc_GotoPage) editor.asc_GotoPage(currentPage);

      setTimeout(function () {
        try {
          // Try the main viewer canvas first, fall back to largest canvas
          var targetCanvas = document.getElementById("id_viewer") || canvas;
          var dataUrl = targetCanvas.toDataURL("image/png");
          _slog("print: page", currentPage, "captured, dataUrl length:", dataUrl.length);
          if (dataUrl.length > 100) { // not just "data:image/png;base64,"
            images.push(dataUrl);
          } else {
            _slog("print: page", currentPage, "produced empty image");
          }
        } catch (e) {
          _slog("print: canvas capture FAILED for page", currentPage, ":", e.message);
          // If SecurityError (tainted canvas), try cloning the canvas content
          try {
            var clone = document.createElement("canvas");
            var targetCanvas = document.getElementById("id_viewer") || canvas;
            clone.width = targetCanvas.width;
            clone.height = targetCanvas.height;
            var ctx = clone.getContext("2d");
            ctx.drawImage(targetCanvas, 0, 0);
            images.push(clone.toDataURL("image/png"));
            _slog("print: page", currentPage, "captured via clone");
          } catch (e2) {
            _slog("print: clone also failed:", e2.message);
          }
        }
        currentPage++;
        capturePage();
      }, 300);
    }

    function openPrintWindow(imgs) {
      _slog("print: captured", imgs.length, "pages, sending to parent for print tab");
      // Send captured images to parent — parent opens an Obsidian tab for printing
      window.parent.postMessage({
        type: "obsidi-office-print",
        images: imgs
      }, "*");
    }

    capturePage();
  }

  // --- Ctrl+P interceptor ---
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "p") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _slog("Ctrl+P intercepted — canvas capture print");
      captureAndPrint();
    }
  }, true);

  // --- Fit-to-width on document load ---
  var _fitTimer = setInterval(function () {
    if (window.Asc && window.Asc.editor && window.Asc.editor.zoomFitToWidth) {
      clearInterval(_fitTimer);
      setTimeout(function () {
        try {
          window.Asc.editor.zoomFitToWidth();
          _slog("Fit-to-width applied");
          setTimeout(function () {
            var savedZoom = parseInt(localStorage.getItem("de-settings-zoom") || "0");
            if (savedZoom > 0) {
              window.Asc.editor.zoom(savedZoom);
              _slog("Zoom set to saved preference:", savedZoom + "%");
            }
          }, 300);
        } catch (ex) { console.error("[mock-socket] Zoom error:", ex.message); }
      }, 1500);
    }
  }, 500);

  // --- Obsidian Metadata button in File > Info panel ---
  // The info panel is at #panel-info. DocumentInfo view renders into it
  // when the user clicks File > Info. We watch for content changes and
  // inject our button at the bottom.
  function injectMetadataBtn() {
    var panel = document.getElementById("panel-info");
    if (!panel || panel.querySelector("#obsidi-metadata-btn")) return;
    var btn = document.createElement("button");
    btn.id = "obsidi-metadata-btn";
    btn.textContent = "Obsidian Metadata";
    btn.style.cssText = "margin: 12px 0 -21px -10px; padding: 6px 14px; border-radius: 4px; cursor: pointer; " +
      "background: #7b6cd9; color: white; border: none; font-size: 12px; display: block;";
    btn.addEventListener("click", function () {
      window.parent.postMessage({
        type: "obsidi-office-metadata",
        filePath: (window.__oo_params && window.__oo_params.docFilePath) || ""
      }, "*");
    });
    // Insert as first child so it appears at the top of the info panel
    if (panel.firstChild) {
      panel.insertBefore(btn, panel.firstChild);
    } else {
      panel.appendChild(btn);
    }
  }
  // Try immediately and also watch for DOM changes (panel is populated lazily)
  new MutationObserver(function () { injectMetadataBtn(); })
    .observe(document.body, { childList: true, subtree: true });

  // Auto-save is handled in the parent (main.js) via onDocumentStateChange event.
  // Parent sends "docx-viewer-save" postMessage to this iframe after 10s debounce.
}

// The io() factory the way the real socket.io client exposes it
function io(url, opts) {
  var sock = new MockSocket(url, opts);
  window.__mockSocket = sock;
  return sock;
}
io.connect = io;
io.Manager = MockSocket;
io.Socket = MockSocket;
io.protocol = 5;

// ===========================================================================
// UMD wrapper — MUST match the real socket.io v4.5.3 pattern
// OnlyOffice uses RequireJS to load this module. Without define(e) the
// editor will hang waiting for the socket.io module to resolve.
// ===========================================================================
(function (root, factory) {
  if (typeof exports === "object" && typeof module !== "undefined") {
    _slog("registering via CommonJS module.exports");
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    _slog("registering via AMD define()");
    define(factory);
  } else {
    _slog("registering on global");
    (typeof globalThis !== "undefined" ? globalThis : root || self).io = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  _slog("factory function called by module loader");
  return io;
});

})();
