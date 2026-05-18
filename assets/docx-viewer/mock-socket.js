/* eslint-disable */
/*
 * Obsidi-Office — mock socket.io stand-in
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
      // Indicator (12x12) sits inside the save icon's bottom-right area:
      // -6 centers it on the corner, additional -5 each axis nudges it
      // up-and-left so it sits inset from the corner.
      saveIndicator.style.left = (rect.right  - 11) + "px";
      saveIndicator.style.top  = (rect.bottom - 11) + "px";
    }
  }

  function repositionToolbarOverlays() {
    positionSaveIndicator();
    if (typeof positionPrintBtn === "function") positionPrintBtn();
  }
  var _posTimer = setInterval(function () {
    var btn = document.getElementById("slot-btn-save");
    if (btn) {
      repositionToolbarOverlays();
      clearInterval(_posTimer);
      window.addEventListener("resize", repositionToolbarOverlays);
      var observer = new MutationObserver(function () {
        var panel = document.getElementById("file-menu-panel") || document.querySelector(".panel-menu");
        var toolbar = document.querySelector(".toolbar");
        var isMenuOpen = (panel && panel.offsetParent !== null) ||
          (toolbar && toolbar.style.display === "none") ||
          document.querySelector(".btn-tab-file.active, .ribtab.active[data-tab='file']");
        saveIndicator.style.opacity = isMenuOpen ? "0" : "1";
        if (typeof printBtn !== "undefined" && printBtn) {
          printBtn.style.opacity = isMenuOpen ? "0" : "1";
        }
        repositionToolbarOverlays();
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

  // --- PDF loading overlay (shown during PDF export) ---
  var pdfOverlay = document.createElement("div");
  pdfOverlay.id = "docx-pdf-overlay";
  pdfOverlay.style.cssText =
    "position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.5); " +
    "display: none; align-items: center; justify-content: center; " +
    "font-family: system-ui, sans-serif;";
  pdfOverlay.innerHTML =
    '<div style="background: white; padding: 22px 30px; border-radius: 8px; ' +
    'display: flex; flex-direction: column; align-items: center; gap: 14px; ' +
    'box-shadow: 0 4px 16px rgba(0,0,0,0.3); min-width: 220px;">' +
    '<svg width="32" height="32" viewBox="0 0 50 50" style="animation: docx-spin 1s linear infinite;">' +
    '<circle cx="25" cy="25" r="20" fill="none" stroke="#4a90d9" stroke-width="4" ' +
    'stroke-linecap="round" stroke-dasharray="100 60"/></svg>' +
    '<div class="docx-pdf-overlay-label" style="font-size: 14px; color: #333;">Generating PDF…</div>' +
    '</div>';
  document.body.appendChild(pdfOverlay);
  function setOverlayLabel(text) {
    var lbl = pdfOverlay.querySelector(".docx-pdf-overlay-label");
    if (lbl) lbl.textContent = text;
  }
  window.__showPdfOverlay = function (label) {
    if (label) setOverlayLabel(label);
    pdfOverlay.style.display = "flex";
  };
  window.__hidePdfOverlay = function () { pdfOverlay.style.display = "none"; };

  // --- Print button (positioned below save button) ---
  // Are we running inside an Obsidian mobile (Capacitor) WebView? Editor
  // iframe's HTML/JS lives in the plugin's assets dir, so document.baseURI
  // starts with "capacitor://" on iOS/Android and "app://" / "file://" on
  // Electron desktop. Used to route print through a transient PDF +
  // share-sheet AirPrint on iPad — window.print() is a silent no-op in
  // Capacitor WKWebView (verified 2026-05-07). User can opt-in via
  // Settings → "Enable Print on mobile".
  var IS_CAPACITOR = (function () {
    try { return !!document.baseURI && document.baseURI.indexOf("capacitor://") === 0; }
    catch (e) { return false; }
  })();

  // Floating Print button visibility gate. main.js writes
  // params.enablePrint into __oo_params at editor-config time; it's true
  // on desktop and (mobile && settings.enableMobilePrint). When false,
  // skip the printBtn appendChild entirely. positionPrintBtn stays
  // defined regardless — it's a no-op when printBtn isn't appended.
  var ENABLE_PRINT_BTN = !(window.__oo_params && window.__oo_params.enablePrint === false);

  if (ENABLE_PRINT_BTN) {
  var printSvg =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>' +
    '</svg>';
  var printBtnStyle = document.createElement("style");
  printBtnStyle.textContent =
    "#docx-print-btn { position: absolute; z-index: 99998; pointer-events: auto; " +
    "display: flex; align-items: center; justify-content: center; padding: 0; " +
    "background: transparent; border: none; cursor: pointer; " +
    "color: rgba(255,255,255,0.55); border-radius: 3px; " +
    "transition: background 0.1s, color 0.1s, opacity 0.2s; } " +
    "#docx-print-btn:hover { background: rgba(255,255,255,0.1); color: white; } " +
    "#docx-print-btn:active { background: rgba(255,255,255,0.18); } " +
    ".document-menu-opened #docx-print-btn, .toolbar-mask #docx-print-btn, " +
    "body.menu-opened #docx-print-btn { opacity: 0 !important; pointer-events: none; }";
  document.head.appendChild(printBtnStyle);

  var printBtn = document.createElement("button");
  printBtn.id = "docx-print-btn";
  printBtn.title = "Print (Ctrl+P)";
  printBtn.innerHTML = printSvg;
  // pointerdown fires on iOS WKWebView for absolutely-positioned overlay
  // buttons; click events on body-level absolute buttons can fail to
  // register in Capacitor (the save button uses the same delegation
  // pattern via document.addEventListener("pointerdown", ...)). Guard
  // against double-trigger if the pointer fires both pointerdown + click
  // on desktop with a small re-entrance flag.
  var _printBtnFiring = false;
  function _firePrint(ev) {
    if (_printBtnFiring) return;
    _printBtnFiring = true;
    setTimeout(function () { _printBtnFiring = false; }, 500);
    ev.preventDefault();
    ev.stopPropagation();
    _slog("Print button pressed (capacitor=" + IS_CAPACITOR + ")");
    if (IS_CAPACITOR) {
      // iOS Capacitor: window.print() is a no-op. Route through the export
      // pipeline with the transientPrint flag — main.js writes
      // <basename>-print-<ts>.pdf, opens it in a new tab so the user can
      // AirPrint via Obsidian's PDF-viewer share menu, then auto-deletes
      // the file + closes the tab after 60s.
      setOverlayLabel("Generating PDF for printing…");
      pdfOverlay.style.display = "flex";
      setTimeout(function () { captureAndExportPdf("export", true); }, 50);
    } else {
      // Desktop: direct iframe.contentWindow.print() works under Electron.
      setOverlayLabel("Preparing print…");
      pdfOverlay.style.display = "flex";
      setTimeout(function () { captureAndExportPdf("print"); }, 50);
    }
  }
  printBtn.addEventListener("pointerdown", _firePrint);
  printBtn.addEventListener("click", _firePrint);
  document.body.appendChild(printBtn);
  } // end if (ENABLE_PRINT_BTN)

  function positionPrintBtn() {
    var saveBtn = document.getElementById("slot-btn-save");
    if (saveBtn && printBtn) {
      var rect = saveBtn.getBoundingClientRect();
      printBtn.style.left = rect.left + "px";
      printBtn.style.top  = (rect.bottom + 6) + "px";
      printBtn.style.width  = rect.width + "px";
      printBtn.style.height = rect.height + "px";
    }
  }

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

  // --- Ctrl+P interceptor (print) ---
  // Capture phase + stopImmediatePropagation so OnlyOffice's own Ctrl+P
  // (which would open its in-editor print modal) doesn't fire.
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _slog("Ctrl+P intercepted — printing (capacitor=" + IS_CAPACITOR + ")");
      if (IS_CAPACITOR) {
        setOverlayLabel("Generating PDF for printing…");
        pdfOverlay.style.display = "flex";
        setTimeout(function () { captureAndExportPdf("export", true); }, 50);
      } else {
        setOverlayLabel("Preparing print…");
        pdfOverlay.style.display = "flex";
        setTimeout(function () { captureAndExportPdf("print"); }, 50);
      }
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
      setOverlayLabel("Preparing print…");
      pdfOverlay.style.display = "flex";
      captureAndExportPdf("print");
    }
    if (e.data.type === "docx-viewer-export-pdf") {
      setOverlayLabel("Generating PDF…");
      pdfOverlay.style.display = "flex";
      captureAndExportPdf("export");
    }
    if (e.data.type === "docx-viewer-pdf-done") {
      pdfOverlay.style.display = "none";
    }
  });

  // --- PDF export / print: capture each page via OnlyOffice's print-preview API.
  //   mode "export" (default): build a hybrid searchable PDF — canvas image
  //     plus invisible text overlay via pdf-lib in the parent. Includes
  //     full-document text extraction + per-page text-line detection.
  //   mode "print": skip the text/searchability work (~100-300ms per page
  //     saved) and post just the page images to the parent for direct
  //     iframe-print.
  async function captureAndExportPdf(mode, transientPrint) {
    mode = (mode === "print") ? "print" : "export";
    var tag = (mode === "print") ? "Print" : (transientPrint ? "Print via PDF" : "PDF export");
    if (!window.Asc || !window.Asc.editor) {
      _slog(tag + ": editor not ready");
      return;
    }
    var editor = window.Asc.editor;

    // 1. Page count — print-preview path doesn't depend on event-driven
    // pagination tracking; the polled getter is reliable in current builds.
    var pageCount = 1;
    try {
      if (editor.getCountPages) pageCount = editor.getCountPages();
      if (!pageCount || pageCount < 1) pageCount = 1;
    } catch (e) { pageCount = 1; }
    _slog(tag + ": " + pageCount + " pages");

    // 2. Page geometry — used by parent for PDF/page sizing.
    // Slide engine: get_PresentationWidth/Height return EMU, divide by 36000 for mm.
    // Docx engine: asc_getPageSize(0) -> {W, H} in mm.
    // Detect by get_PresentationWidth presence only — iPad's slide engine
    // ALSO exposes asc_getPageSize (returns docx-shaped defaults), so the
    // earlier `&& !asc_getPageSize` exclusion misclassified slide → doc on
    // iPad and produced portrait Letter PDFs. Fallback to 16:9 widescreen
    // (338.7 x 190.5 mm) if get_PresentationWidth returns 0.
    var hasSlideAPI = (typeof editor.get_PresentationWidth === "function");
    var hasDocAPI = (typeof editor.asc_getPageSize === "function");
    var isSlide = hasSlideAPI;
    var pageMm = null;
    try {
      if (isSlide) {
        var wEmu = editor.get_PresentationWidth();
        var hEmu = editor.get_PresentationHeight();
        if (wEmu > 0 && hEmu > 0) {
          pageMm = { W: wEmu / 36000, H: hEmu / 36000 };
        } else {
          pageMm = { W: 338.7, H: 190.5 };  // 16:9 fallback
        }
      } else if (hasDocAPI) {
        pageMm = editor.asc_getPageSize(0);
      }
    } catch (e) {}
    _slog(tag + ": engine=" + (isSlide ? "slide" : "doc") + " page size (mm):",
          pageMm ? (pageMm.W.toFixed(1) + "x" + pageMm.H.toFixed(1)) : "unknown",
          " hasSlideAPI=" + hasSlideAPI + " hasDocAPI=" + hasDocAPI);
    // Surface engine detection to parent debug log (iframe console doesn't propagate).
    try {
      parent.postMessage({
        __pdfEngine: true,
        isSlide: isSlide,
        hasSlideAPI: hasSlideAPI,
        hasDocAPI: hasDocAPI,
        pageMm: pageMm ? { W: Math.round(pageMm.W * 10) / 10, H: Math.round(pageMm.H * 10) / 10 } : null
      }, "*");
    } catch (e) {}

    // 3. Extract per-page text for the searchable-PDF text overlay. Skip in
    //    print mode.
    //    Docx engine: SelectAll + asc_GetSelectedText returns whole-doc text;
    //      splitTextByHeadingAnchors maps to per-page chunks.
    //    Slide engine: asc_GetSelectedText is per-active-slide. Strategy B
    //      (Phase 5 triage decision): private path editor.ra.Ea.He[i].an(true, {})
    //      gets slide-i text directly with no navigation. Falls back to
    //      whole-deck SelectAll (Strategy A — text dumped at slide 1) if the
    //      private path errors out (minified-name stability concern).
    var perPageText = [];
    if (mode === "export") {
      if (isSlide) {
        // Strategy B — per-slide via private path.
        var slideTexts = null;
        try {
          var pres = editor.ra && editor.ra.Ea;
          var slides = pres && pres.He;
          if (slides && slides.length) {
            slideTexts = [];
            for (var si = 0; si < slides.length; si++) {
              try {
                slideTexts.push(slides[si].an(true, {}) || "");
              } catch (e1) {
                slideTexts.push("");
              }
            }
          }
        } catch (e) {
          _slog(tag + ": Strategy B private path threw:", e.message);
          slideTexts = null;
        }

        if (slideTexts) {
          // Pad/truncate to pageCount so downstream indexing is safe.
          perPageText = new Array(pageCount);
          for (var pi = 0; pi < pageCount; pi++) {
            perPageText[pi] = slideTexts[pi] || "";
          }
          var totalChars = slideTexts.reduce(function (a, t) { return a + t.length; }, 0);
          _slog(tag + ": Strategy B per-slide text: " + slideTexts.length +
                " slides, " + totalChars + " chars total");
        } else {
          // Strategy A fallback — whole-deck text on slide 1.
          var allText = "";
          try {
            if (editor.asc_EditSelectAll) editor.asc_EditSelectAll();
            await new Promise(function (r) { setTimeout(r, 200); });
            if (editor.asc_GetSelectedText) {
              allText = editor.asc_GetSelectedText({ NewLineSeparator: "\n", TableLineSeparator: "\n", TableCellSeparator: "\t" }) || "";
            }
          } catch (e2) {
            _slog(tag + ": Strategy A fallback also failed:", e2.message);
          }
          perPageText = new Array(pageCount);
          perPageText[0] = allText;
          for (var pj = 1; pj < pageCount; pj++) perPageText[pj] = "";
          _slog(tag + ": Strategy A fallback: " + allText.length + " chars dumped on slide 1");
        }
      } else {
        // Docx path — unchanged.
        var allText = "";
        try {
          if (editor.asc_EditSelectAll) editor.asc_EditSelectAll();
          else if (editor.asc_SelectAll) editor.asc_SelectAll();
          await new Promise(function (r) { setTimeout(r, 200); });
          if (editor.asc_GetSelectedText) {
            allText = editor.asc_GetSelectedText({ NewLineSeparator: "\n", TableLineSeparator: "\n", TableCellSeparator: "\t" }) || "";
          }
        } catch (e) {
          _slog(tag + ": text extraction failed:", e.message);
        }
        _slog(tag + ": extracted", allText.length, "chars of text");
        try { if (editor.MoveCursorToStartPos) editor.MoveCursorToStartPos(); } catch (e) {}
        perPageText = splitTextByHeadingAnchors(editor, allText, pageCount);
      }
    }

    // 4. Use OnlyOffice's print-preview API for clean per-page renders.
    // - asc_initPrintPreview(elementId) creates a canvas inside that element
    //   sized to fit. Each call to asc_drawPrintPreview(N) renders page N to
    //   that canvas, so we just capture the canvas after each draw.
    // - The host's CSS dimensions (width/height) control render resolution.
    //   Set to ~2x device pixels for sharper output.
    //
    // The host is positioned offscreen with visibility:hidden so the user
    // doesn't see anything happen during export.
    var hostId = "obsidi-pp-export-host";
    var existing = document.getElementById(hostId);
    if (existing) existing.remove();
    var host = document.createElement("div");
    host.id = hostId;
    // Aspect-derived host sizing — longest side = 1584 px (~144 DPI on Letter).
    // Docs are portrait (aspect < 1, e.g. Letter 0.77); slides are landscape
    // (aspect > 1, e.g. 16:9 = 1.78). Without this branch, slides squish into
    // the docx Letter-portrait host.
    var aspect = pageMm ? (pageMm.W / pageMm.H) : 0.77;  // fallback = Letter
    var maxPx = 1584;
    var hostW, hostH;
    if (aspect > 1) {  // landscape — slides
      hostW = maxPx;
      hostH = Math.round(maxPx / aspect);
    } else {  // portrait — docs
      hostH = maxPx;
      hostW = Math.round(maxPx * aspect);
    }
    host.style.cssText =
      "position: fixed; top: -10000px; left: 0; " +
      "width: " + hostW + "px; height: " + hostH + "px; " +
      "visibility: hidden; pointer-events: none;";
    document.body.appendChild(host);

    var pages = [];
    // Note: we previously attempted spatial-alignment of the invisible text
    // layer by monkey-patching CanvasRenderingContext2D.prototype.fillText
    // around the print-preview loop, expecting per-glyph (text, x, y) tuples.
    // It produced 0 captured runs because OnlyOffice's sdkjs renders body
    // text as vector glyph paths (bezierCurveTo + ctx.fill()), not via
    // fillText. Path operations carry no text content. Spatial alignment
    // would need either OCR-lite line detection on the rendered canvas or
    // a sdkjs-internal y-coordinate getter on paragraph objects.
    // See: vault decisions/2026-04.md and meta/lessons.md (2026-04-29).
    try {
      if (typeof editor.asc_initPrintPreview !== "function") {
        throw new Error("asc_initPrintPreview not available");
      }
      editor.asc_initPrintPreview(hostId);
      // Allow the editor to wire up the preview canvas inside our host.
      await new Promise(function (r) { setTimeout(r, 250); });

      var previewCanvas = host.querySelector("canvas");
      if (!previewCanvas) throw new Error("print-preview canvas not created");
      _slog("PDF export: preview canvas " + previewCanvas.width + "x" + previewCanvas.height);

      // OnlyOffice's print preview draws a page-edge stroke at the canvas
      // perimeter. The stroke + AA fuzz is heavier on top/bottom than on
      // the sides (likely from header/footer band rendering). Asymmetric
      // crop — modest on sides, more on top/bottom.
      var dpr = window.devicePixelRatio || 1;
      var CROP_L = Math.max(11, Math.round(11 * dpr));
      var CROP_R = Math.max(11, Math.round(11 * dpr));
      var CROP_T = Math.max(15, Math.round(15 * dpr));
      var CROP_B = Math.max(15, Math.round(15 * dpr));

      // Slide engine's asc_drawPrintPreview requires a paperSize [w_mm, h_mm]
      // 2nd arg (presentationeditor's UI passes _paperSize from its combo).
      // Docx engine tolerates the 2nd arg, so unconditional pass is safe.
      var paperSize = pageMm ? [pageMm.W, pageMm.H] : undefined;
      for (var p = 0; p < pageCount; p++) {
        try {
          editor.asc_drawPrintPreview(p, paperSize);
          // Two animation frames + a small timeout so the canvas finishes painting.
          await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
          await new Promise(function (r) { setTimeout(r, 80); });

          // Re-query in case the canvas was replaced between calls.
          var cv = host.querySelector("canvas");
          if (!cv) { _slog("PDF export: page " + (p + 1) + " no preview canvas"); continue; }

          // Crop the page-edge perimeter to remove OnlyOffice's preview
          // border. Per-edge values — empirically tuned.
          var safeW = Math.floor(cv.width  / 20);
          var safeH = Math.floor(cv.height / 20);
          var iL = Math.min(CROP_L, safeW);
          var iR = Math.min(CROP_R, safeW);
          var iT = Math.min(CROP_T, safeH);
          var iB = Math.min(CROP_B, safeH);
          var cw = cv.width  - iL - iR;
          var ch = cv.height - iT - iB;
          var crop = document.createElement("canvas");
          crop.width = cw;
          crop.height = ch;
          var cctx = crop.getContext("2d");
          cctx.drawImage(cv, iL, iT, cw, ch, 0, 0, cw, ch);
          var dataUrl = crop.toDataURL("image/png");

          if (!dataUrl || dataUrl.length < 100) { _slog(tag + ": page " + (p + 1) + " empty"); continue; }
          // Detect text-line bands (only for searchable-PDF export). Skip
          // entirely in print mode — saves ~100-300ms per page.
          var textRuns = [];
          if (mode === "export") {
            var detectStart = performance.now();
            textRuns = detectTextLineRuns(crop, perPageText[p] || "");
            var detectMs = Math.round(performance.now() - detectStart);
            var firstY = textRuns.length ? textRuns[0].y : -1;
            var lastY  = textRuns.length ? textRuns[textRuns.length - 1].y : -1;
            var midY   = textRuns.length ? textRuns[Math.floor(textRuns.length / 2)].y : -1;
            var firstX = textRuns.length ? textRuns[0].x : -1;
            var midX   = textRuns.length ? textRuns[Math.floor(textRuns.length / 2)].x : -1;
            _slog(tag + ": page " + (p + 1) + " detect=" + detectMs + "ms runs=" + textRuns.length +
                  " ch=" + ch + " y(f/m/l)=" + firstY + "/" + midY + "/" + lastY +
                  " x(f/m)=" + firstX + "/" + midX);
          }
          pages.push({
            dataUrl: dataUrl,
            text: perPageText[p] || "",
            textRuns: textRuns,
            w: cw,
            h: ch,
            pageMmW: pageMm ? pageMm.W : null,
            pageMmH: pageMm ? pageMm.H : null
          });
          // Yield to the event loop so the loading overlay's spinner animates
          // and the iframe stays responsive. The pixel scan is ~100-300ms per
          // page; without yielding, 16 pages of work blocks for several seconds.
          await new Promise(function (r) { setTimeout(r, 0); });
        } catch (e) {
          _slog(tag + ": page " + (p + 1) + " threw:", e.message);
        }
      }
      _slog(tag + ": cropped L=" + CROP_L + " R=" + CROP_R + " T=" + CROP_T + " B=" + CROP_B + " (CSS px)");
    } finally {
      try { if (typeof editor.asc_closePrintPreview === "function") editor.asc_closePrintPreview(); } catch (e) {}
      try { host.remove(); } catch (e) {}
    }

    if (pages.length === 0) {
      _slog(tag + ": no pages captured");
      return;
    }

    // 5. Send to parent.
    var docKey = (window.__oo_params && (window.__oo_params.frameEditorId || window.__oo_params.docKey)) || "";
    var docFilePath = (window.__oo_params && window.__oo_params.docFilePath) || "";
    var basename = docFilePath ? docFilePath.split("/").pop().replace(/\.(docx|pptx)$/i, "") : "document";

    if (mode === "print") {
      // Print payload: just the per-page image dataUrls + page geometry.
      var images = pages.map(function (p) { return p.dataUrl; });
      window.parent.postMessage({
        type: "obsidi-office-print",
        docKey: docKey,
        images: images,
        pageMmW: pageMm ? pageMm.W : null,
        pageMmH: pageMm ? pageMm.H : null
      }, "*");
      _slog(tag + ": posted " + images.length + " page images to parent");
    } else {
      // Export payload: full pages array (image + text + textRuns + size).
      // transientPrint flag distinguishes a real export (user wants the PDF)
      // from a print-via-PDF (iPad path: route through export pipeline, then
      // schedule cleanup after 60s).
      window.parent.postMessage({
        type: "obsidi-office-pdf-export",
        docKey: docKey,
        docFilePath: docFilePath,
        basename: basename,
        pages: pages,
        transientPrint: !!transientPrint
      }, "*");
      _slog(tag + ": posted " + pages.length + " pages to parent (basename=" + basename + ", transient=" + !!transientPrint + ")");
    }
  }

  // (findPageRect removed 2026-04-29 — no longer needed: PDF export now uses
  // OnlyOffice's print-preview API which renders one clean page per canvas,
  // eliminating the viewport-canvas pixel-detection problem entirely.)

  // ---- Heading-anchored text-to-page mapping (replaces uniform heuristic) ----
  // The uniform chars-per-page split drifts forward through documents whose
  // ToC / cover pages have higher char density than body content. This builder
  // grounds page boundaries on real heading positions in the doc — drift
  // collapses from systemic 1-page error to <1-paragraph interpolation error.
  //
  // Strategy:
  //   1. Auto-detect the mangled paragraph page-getter method via a one-time
  //      differential 0-arg scan on heads[0] vs heads[last]. The page-getter's
  //      signature: 0-arg method returning a small int that's < pageCount and
  //      differs between first and last heading. Cached for the session.
  //   2. Build {offset, page} anchor pairs from heading paragraphs (text via
  //      asc_getText, page via the discovered method, offset via monotonic
  //      String.indexOf in the extracted text).
  //   3. For each interior page boundary, piecewise-linear-interpolate the
  //      char offset between bracketing anchors.
  //
  // If detection or anchor building fails at any point, fall back to the
  // uniform heuristic with a console warning.
  var _pageGetterName = null;
  var _pageGetterTried = false;

  // Known mangled names for the paragraph page-getter on OnlyOffice v9.3.1
  // (discovered via differential 0-arg scan, 2026-04-29). These names are
  // aliases — likely Get_StartPage / Get_AbsolutePage / etc inherited along
  // the paragraph prototype chain — all returning the absolute page number.
  // If a future OnlyOffice version remangles, this list will need updating
  // (recovery path: re-run __probePageApi probe sequence in vault notes).
  // We deliberately do NOT brute-force scan ALL 0-arg methods at runtime —
  // doing so on real paragraph objects can side-effect the editor state
  // (paragraph methods don't follow English-mutator naming conventions, so
  // a name-pattern filter doesn't reliably exclude destructive methods).
  var KNOWN_PAGE_GETTER_NAMES = ["VRa", "QSb", "Pw", "qD"];

  function _findPageGetter(editor, pageCount) {
    if (_pageGetterName) return _pageGetterName;
    if (_pageGetterTried) return null;
    _pageGetterTried = true;
    if (!editor || typeof editor.asc_GetAllHeadingParagraphs !== "function") return null;
    var heads;
    try { heads = editor.asc_GetAllHeadingParagraphs(); } catch (e) { return null; }
    if (!heads || heads.length < 2) return null;
    var h0 = heads[0];
    var hL = heads[heads.length - 1];
    for (var i = 0; i < KNOWN_PAGE_GETTER_NAMES.length; i++) {
      var k = KNOWN_PAGE_GETTER_NAMES[i];
      if (typeof h0[k] !== "function" || h0[k].length !== 0) continue;
      var r0, rL;
      try { r0 = h0[k](); } catch (e) { continue; }
      try { rL = hL[k](); } catch (e) { continue; }
      if (typeof r0 === "number" && typeof rL === "number" &&
          r0 >= 0 && rL >= 0 &&
          r0 < pageCount + 5 && rL < pageCount + 5 &&
          r0 === Math.floor(r0) && rL === Math.floor(rL) &&
          r0 < rL && rL >= Math.max(1, pageCount - 3)) {
        _pageGetterName = k;
        return k;
      }
    }
    return null;
  }

  function splitTextByHeadingAnchors(editor, text, pageCount) {
    if (!editor || !text || pageCount < 1) return splitTextHeuristically(text, pageCount);
    var pageGetter = _findPageGetter(editor, pageCount);
    if (!pageGetter) {
      _slog("PDF export: page-getter not found — falling back to heuristic split");
      return splitTextHeuristically(text, pageCount);
    }
    _slog("PDF export: page-getter resolved to method '" + pageGetter + "'");

    var heads;
    try { heads = editor.asc_GetAllHeadingParagraphs() || []; }
    catch (e) { return splitTextHeuristically(text, pageCount); }

    // Build monotonic anchor table {offset, page}
    var anchors = [];
    var lastIdx = 0;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var hText, hPage;
      try { hText = h.asc_getText && h.asc_getText(); } catch (e) {}
      try { hPage = h[pageGetter] && h[pageGetter](); } catch (e) {}
      if (typeof hText !== "string" || !hText.length) continue;
      if (typeof hPage !== "number" || hPage < 0 || hPage >= pageCount) continue;
      var idx = text.indexOf(hText, lastIdx);
      if (idx < 0) continue;
      // Reject anchors that go backward in page order (shouldn't happen given
      // doc order, but defensive).
      if (anchors.length && hPage < anchors[anchors.length - 1].page) continue;
      anchors.push({ offset: idx, page: hPage });
      lastIdx = idx + hText.length;
    }

    if (anchors.length === 0) {
      _slog("PDF export: no heading anchors matched in extracted text — falling back to heuristic");
      return splitTextHeuristically(text, pageCount);
    }
    _slog("PDF export: built " + anchors.length + " anchors from " + heads.length + " headings");

    // Compute char offset for each page boundary [0..pageCount].
    var pageStart = new Array(pageCount + 1);
    pageStart[0] = 0;
    pageStart[pageCount] = text.length;

    for (var p = 1; p < pageCount; p++) {
      var before = null, after = null;
      for (var j = 0; j < anchors.length; j++) {
        if (anchors[j].page <= p) before = anchors[j];
        if (anchors[j].page >= p && after === null) after = anchors[j];
      }
      var startOff;
      if (before && after && before.page === after.page) {
        startOff = after.offset;
      } else if (before && after) {
        var span = after.page - before.page;
        var frac = (p - before.page) / span;
        startOff = Math.round(before.offset + frac * (after.offset - before.offset));
      } else if (before) {
        // No anchor after — extrapolate to text end via remaining-pages distribution
        var pagesLeft = Math.max(1, pageCount - before.page);
        var remaining = text.length - before.offset;
        startOff = Math.round(before.offset + (p - before.page) * (remaining / pagesLeft));
      } else if (after) {
        // No anchor before — extrapolate from start
        var prefixLen = after.offset;
        var pagesBefore = Math.max(1, after.page);
        startOff = Math.round((p / pagesBefore) * prefixLen);
      } else {
        startOff = Math.floor(p * text.length / pageCount);
      }
      // Snap backward to nearest whitespace within a small window so we don't
      // split a word across pages.
      var snapEnd = Math.max(0, startOff - 80);
      var snapped = startOff;
      while (snapped > snapEnd && snapped > 0 && !/\s/.test(text[snapped])) snapped--;
      if (snapped > snapEnd) startOff = snapped;
      pageStart[p] = Math.max(0, Math.min(text.length, startOff));
    }

    // Defensive monotonic enforcement.
    for (var q = 1; q <= pageCount; q++) {
      if (pageStart[q] < pageStart[q - 1]) pageStart[q] = pageStart[q - 1];
    }

    var out = [];
    for (var p2 = 0; p2 < pageCount; p2++) {
      out.push(text.substring(pageStart[p2], pageStart[p2 + 1]));
    }
    return out;
  }

  // Split text into N segments by chars-per-page, snapping each end backward
  // to the nearest whitespace so words aren't broken across pages. Used as
  // fallback when heading-anchor detection fails.
  function splitTextHeuristically(text, n) {
    var out = [];
    if (!text || n < 1) return out;
    var charsPerPage = Math.ceil(text.length / n);
    var cursor = 0;
    for (var p = 0; p < n; p++) {
      var start = cursor;
      var end = Math.min(text.length, start + charsPerPage);
      if (end < text.length) {
        // Snap back to last whitespace within window.
        while (end > start && !/\s/.test(text[end])) end--;
        if (end === start) end = Math.min(text.length, start + charsPerPage);
      }
      out.push(text.substring(start, end));
      cursor = end;
    }
    return out;
  }

  // ---- Spatial text-layer alignment: line-band detection from canvas pixels ----
  // OnlyOffice renders text as vector glyph paths (no fillText), so per-glyph
  // interception is impossible. Instead we scan the rendered canvas for rows
  // of "ink" pixels to locate text line bands, then distribute the per-page
  // extracted text across detected lines proportionally by character count.
  //
  // Result: invisible PDF text sits on the same line as the rendered text,
  // so Ctrl+F highlights land on the correct visual line. Within-line word X
  // alignment is approximate (uses Helvetica metrics for char widths). Phase B
  // word-level X detection can be layered on later if needed.
  //
  // Returns an array of {text, x, y, fontSizePx} runs in cropped-canvas coords.
  // Caller (parent main.js) maps to PDF points using the cropped-canvas size.
  function detectTextLineRuns(canvas, pageText) {
    if (!pageText || !pageText.trim().length) return [];
    var ctx;
    try { ctx = canvas.getContext("2d"); } catch (e) { return []; }
    if (!ctx) return [];
    var imageData;
    try { imageData = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch (e) { _slog("PDF export: getImageData threw:", e.message); return []; }
    var data = imageData.data;
    var w = canvas.width, h = canvas.height;
    // INK threshold: any RGB channel below this counts the pixel as text/glyph.
    // 240 captures most rendered text and excludes light-gray UI artifacts.
    var INK = 240;
    function pixelIsInk(idx) {
      return data[idx] < INK || data[idx + 1] < INK || data[idx + 2] < INK;
    }

    // ---- Phase A: row-ink profile + line-band extraction ----
    var rowInk = new Uint16Array(h);
    for (var y = 0; y < h; y++) {
      var rowStart = y * w * 4;
      var c = 0;
      for (var x = 0; x < w; x++) {
        if (pixelIsInk(rowStart + x * 4)) c++;
      }
      rowInk[y] = c;
    }
    // Bands: contiguous rows where ink count exceeds a small threshold (>= 0.5%
    // of canvas width). Skip noise bands < 4 rows tall (usually horizontal rules
    // or top/bottom edge artifacts that survived the perimeter crop).
    var bands = [];
    var bStart = -1;
    var minRowInk = Math.max(2, Math.floor(w * 0.005));
    for (var y = 0; y < h; y++) {
      if (rowInk[y] >= minRowInk) {
        if (bStart === -1) bStart = y;
      } else if (bStart !== -1) {
        if (y - bStart >= 4) bands.push({ y0: bStart, y1: y - 1 });
        bStart = -1;
      }
    }
    if (bStart !== -1 && h - bStart >= 4) bands.push({ y0: bStart, y1: h - 1 });
    if (bands.length === 0) return [];

    // Filter out page-header and page-footer bands. asc_GetSelectedText does
    // NOT include header/footer text in the per-page extraction, so those
    // bands have no corresponding text to place on them. If we kept them,
    // extracted text would shift forward and land on wrong line bands.
    //
    // Header detection: walk bands top-down within the top 15% of canvas;
    // the first vertical gap >= 25 px between consecutive bands is the
    // header→body separator. Bands at or above the separator are header.
    // Falls back to no filter if no gap is found (cover pages, etc.).
    // Footer: bottom 4% of canvas (typical 1" bottom margin minus body line).
    var topZoneEnd = Math.floor(h * 0.15);
    var headerCutoff = 0;
    for (var hi = 1; hi < bands.length; hi++) {
      if (bands[hi].y0 > topZoneEnd) break;
      var gap = bands[hi].y0 - bands[hi - 1].y1;
      if (gap >= 25) {
        headerCutoff = bands[hi - 1].y1;
        break; // first big gap = header→body separator
      }
    }
    var footerCutoff = h - Math.floor(h * 0.04);
    var contentBands = [];
    for (var bf = 0; bf < bands.length; bf++) {
      var bnd = bands[bf];
      if (bnd.y0 <= headerCutoff) continue;
      if (bnd.y0 >= footerCutoff) continue;
      contentBands.push(bnd);
    }
    bands = contentBands;
    if (bands.length === 0) return [];

    // Merge near-bands into "logical row" bands. Multi-line table cells get
    // split by Phase A into one band per visual line; merging by a small gap
    // threshold recovers some of the row structure. The threshold is empirical:
    //   - wrap-line gaps within a paragraph or cell: ~3-7 px
    //   - row-to-row gaps in tables (cell padding only): ~8-15 px
    //   - heading-to-body / paragraph-to-paragraph: ~15-30 px
    // 5 px catches only the tightest wrap-line merges and leaves table rows,
    // section headings, and paragraph breaks intact. Better to under-merge
    // (slot count slightly inflated, drift small) than over-merge (rows
    // collapse into one giant band, search hits land on row 1 of group).
    var MERGE_GAP = 5;
    var merged = [];
    for (var mi = 0; mi < bands.length; mi++) {
      var mb = bands[mi];
      if (merged.length > 0 && mb.y0 - merged[merged.length - 1].y1 < MERGE_GAP) {
        // Extend previous merged band downward; keep `lineH` as the first
        // sub-band's height (the canonical line height for that row).
        merged[merged.length - 1].y1 = mb.y1;
      } else {
        merged.push({ y0: mb.y0, y1: mb.y1, lineH: mb.y1 - mb.y0 + 1 });
      }
    }
    bands = merged;

    // For each band: leftmost ink column (paragraph indentation), baseline,
    // font size estimate, AND per-word column ink groups for X alignment.
    // Border rows (where ink covers >50% of the canvas width — horizontal
    // table borders, blue rule lines, decorative underlines) are excluded
    // from the column-ink profile. Without this, a single continuous border
    // contributes ink to every column and defeats word-gap detection,
    // collapsing the band's word slots to one giant slot at x=0.
    var BORDER_INK_MIN = Math.floor(w * 0.5);
    for (var bi = 0; bi < bands.length; bi++) {
      var band = bands[bi];
      var bH = band.y1 - band.y0 + 1;
      var colInk = new Uint16Array(w);
      for (var by = band.y0; by <= band.y1; by++) {
        if (rowInk[by] >= BORDER_INK_MIN) continue;
        var rowBase = by * w * 4;
        for (var bx = 0; bx < w; bx++) {
          if (pixelIsInk(rowBase + bx * 4)) colInk[bx]++;
        }
      }
      // Phase B: word-group detection. Words = contiguous ink runs separated
      // by gaps of >= 25% of band height. Tunes for inter-word spaces vs
      // intra-word kerning.
      var minGap = Math.max(3, Math.floor(bH * 0.20));
      var wordSlots = [];
      var wStart = -1;
      var gapRun = 0;
      var xLeft = -1;
      for (var sx = 0; sx < w; sx++) {
        if (colInk[sx] > 0) {
          if (wStart === -1) wStart = sx;
          if (xLeft === -1) xLeft = sx; // first ink column on the band
          gapRun = 0;
        } else if (wStart !== -1) {
          gapRun++;
          if (gapRun >= minGap) {
            wordSlots.push({ x0: wStart, x1: sx - gapRun });
            wStart = -1;
          }
        }
      }
      if (wStart !== -1) wordSlots.push({ x0: wStart, x1: w - 1 });

      band.x0 = xLeft >= 0 ? xLeft : 0;
      // For merged multi-line rows, use the first sub-band's line height for
      // font size and place the baseline near the top of the band (on the
      // first visual line). Visually the search highlight would land on the
      // first wrap-line of the row, which is acceptable since the row is the
      // smallest logical unit we can map text to without per-word OCR.
      var lineH = (typeof band.lineH === "number" && band.lineH > 0) ? band.lineH : bH;
      band.baseline = band.y0 + lineH - Math.max(1, Math.floor(lineH * 0.15));
      band.fontSizePx = Math.max(6, Math.floor(lineH * 0.75));
      band.wordSlots = wordSlots;
    }

    // Build a flat slot list across all bands in document order. Each slot is
    // a (x, y, fontSizePx) anchor for one extracted word. Skip bands that
    // produced no word slots (very thin bands that are likely table borders
    // or horizontal rules).
    var slots = [];
    for (var bi3 = 0; bi3 < bands.length; bi3++) {
      var b3 = bands[bi3];
      if (!b3.wordSlots || b3.wordSlots.length === 0) continue;
      for (var ws = 0; ws < b3.wordSlots.length; ws++) {
        slots.push({
          x: b3.wordSlots[ws].x0,
          y: b3.baseline,
          fontSizePx: b3.fontSizePx
        });
      }
    }
    if (slots.length === 0) return [];

    // Tokenize the per-page extracted text on whitespace.
    var tokens = pageText.split(/\s+/);
    var nonEmpty = [];
    for (var ti = 0; ti < tokens.length; ti++) {
      if (tokens[ti].length > 0) nonEmpty.push(tokens[ti]);
    }
    tokens = nonEmpty;
    if (tokens.length === 0) return [];

    // Map tokens to slots. Three regimes for count mismatch:
    //  - exact: one token per slot
    //  - more tokens than slots: pack proportional ranges into one slot
    //  - more slots than tokens: spread tokens at proportional positions
    var runs = [];
    if (tokens.length === slots.length) {
      for (var i1 = 0; i1 < slots.length; i1++) {
        runs.push({
          text: tokens[i1],
          x: slots[i1].x,
          y: slots[i1].y,
          fontSizePx: slots[i1].fontSizePx
        });
      }
    } else if (tokens.length > slots.length) {
      var ratio = tokens.length / slots.length;
      for (var i2 = 0; i2 < slots.length; i2++) {
        var s = Math.floor(i2 * ratio);
        var e = (i2 === slots.length - 1) ? tokens.length : Math.floor((i2 + 1) * ratio);
        var combined = tokens.slice(s, e).join(" ");
        if (combined.length > 0) {
          runs.push({
            text: combined,
            x: slots[i2].x,
            y: slots[i2].y,
            fontSizePx: slots[i2].fontSizePx
          });
        }
      }
    } else {
      var stride = slots.length / tokens.length;
      for (var i3 = 0; i3 < tokens.length; i3++) {
        var slotIdx = Math.floor(i3 * stride);
        if (slotIdx >= slots.length) slotIdx = slots.length - 1;
        runs.push({
          text: tokens[i3],
          x: slots[slotIdx].x,
          y: slots[slotIdx].y,
          fontSizePx: slots[slotIdx].fontSizePx
        });
      }
    }
    return runs;
  }

  // --- Print via canvas capture (legacy, kept for compatibility) ---
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
      _slog("Ctrl+P intercepted — exporting PDF to vault");
      pdfOverlay.style.display = "flex";
      setTimeout(captureAndExportPdf, 50);
    }
  }, true);

  // (Diagnostic probes __probePageBoundaries / __diagnosePdfExport and the
  //  obsidi-pdf-probe-btn floating button removed 2026-04-29 after PDF export
  //  shipped via the print-preview API. Lessons preserved in vault:
  //  decisions/2026-04.md and meta/lessons.md under 2026-04-29.)


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

  // --- Export to PDF item in File panel left rail ---
  // Adds a menu item directly below "Info" that runs the same PDF export
  // pipeline as the floating canvas-overlay button:
  //   captureAndExportPdf() -> postMessage "obsidi-office-pdf-export"
  //   -> main.js _exportPdfToVault() -> writes <basename>.pdf next to .docx.
  // The canvas-overlay button is reserved for a future direct-print feature.
  function injectExportPdfMenuItem() {
    var info = document.getElementById("fm-btn-info");
    if (!info || !info.parentNode) return;
    if (document.getElementById("fm-btn-obsidi-export-pdf")) return;

    // Clone Info to inherit OnlyOffice's exact CSS classes / inner structure.
    // cloneNode does NOT copy addEventListener handlers, so the Info-panel
    // switch won't fire from the clone — but data-/aria- driven delegation
    // could still match, so we strip those attributes defensively.
    var item = info.cloneNode(true);
    item.id = "fm-btn-obsidi-export-pdf";
    item.classList.remove("active");
    Array.from(item.attributes).forEach(function (a) {
      if (a.name.indexOf("data-") === 0 || a.name.indexOf("aria-") === 0) {
        item.removeAttribute(a.name);
      }
    });

    // The cloned Info node has icon + label nested in wrappers that vary
    // across OnlyOffice builds; surgical text replacement leaves duplicates
    // behind. Nuke inner DOM and add a single clean caption span — outer
    // item classes still provide layout / hover / active styling.
    item.innerHTML = '<span class="caption">Export to PDF</span>';
    if (item.hasAttribute("title")) item.setAttribute("title", "Export to PDF");

    item.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _slog("File > Export to PDF clicked");
      // Reset overlay label (the print path may have set it to "Preparing print…")
      // and show the overlay.
      setOverlayLabel("Generating PDF…");
      pdfOverlay.style.display = "flex";
      // Close the File panel so the overlay is actually visible.
      var back = document.getElementById("fm-btn-back");
      if (back) { try { back.click(); } catch (err) {} }
      setTimeout(function () { captureAndExportPdf("export"); }, 50);
    }, true);  // capture phase, ahead of OnlyOffice's delegated handlers

    if (info.nextSibling) {
      info.parentNode.insertBefore(item, info.nextSibling);
    } else {
      info.parentNode.appendChild(item);
    }
    _slog("Injected File > Export to PDF menu item");
  }

  // Try immediately and watch for DOM changes (File panel populates lazily).
  new MutationObserver(function () {
    injectMetadataBtn();
    injectExportPdfMenuItem();
  }).observe(document.body, { childList: true, subtree: true });
  injectExportPdfMenuItem();

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
