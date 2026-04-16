# Instructions — OnlyObsidian Test

## Context

This is a handoff from a Claude.ai conversation to Cowork. The plugin is architecturally complete but has only been tested structurally (syntax validation, path resolution, patcher idempotency). It has NOT been tested at runtime in Obsidian yet — the first attempt used `app://` URLs which Obsidian blocked. This build uses `file://` URLs instead, which is untested.

Read `MEMORY.md` for full architectural context, decisions made, and known risks.

## Immediate next step

### Test the file:// approach

1. Make sure the plugin is installed at `<vault>/.obsidian/plugins/onlyobsidian-test/`
2. Make sure `node setup.js` has been run (assets/onlyoffice/ and assets/x2t/ must be present)
3. Reload Obsidian (Ctrl+R / Cmd+R)
4. Enable "OnlyObsidian Test" in Settings → Community plugins
5. Open any `.docx` file in the vault
6. Open DevTools (Ctrl+Shift+I)
7. Check the Console and Network tabs

### What success looks like

**Console should show (in order):**
```
[OnlyObsidian Test] onload
[OnlyObsidian Test] assetBaseUrl: file:///path/to/assets/onlyoffice
[OnlyObsidian Test] registered docKey: doc-XXXX ...
[OnlyObsidian Test] read NNNN bytes from path/to/file.docx
[OnlyObsidian Test] x2t produced NNNN Editor.bin bytes, N media files
[OnlyObsidian Test] loading api.js from: file:///path/to/.../api.js
[oo-shim] loaded, docKey: doc-XXXX
[mock-socket] loaded, docKey: doc-XXXX
[mock-socket] firing connect + handshake + auth
[oo-shim] fetch intercepted: GET /document?docKey=...
[mock-socket] delivering documentOpen (NNNN bytes, N media)
[OnlyObsidian Test] onAppReady for doc-XXXX
[OnlyObsidian Test] onDocumentReady for doc-XXXX
```

**Network tab:**
- Filter `file://` → loads of OnlyOffice JS/CSS/font assets
- Filter `127.0.0.1` → empty (no localhost requests)
- No `ERR_BLOCKED_BY_CLIENT` errors

### What failure looks like and how to fix each case

#### Failure 1: `ERR_BLOCKED_BY_CLIENT` on api.js or sub-resources

**Meaning:** Obsidian's Electron build also blocks `file://` script loads from `app://` parent, or blocks sub-resources in `file://` iframes.

**Fix approach:** Fall back to serving via a custom Electron session protocol. The plugin can use `require('electron').remote.session.defaultSession.protocol.handle()` to intercept requests. This is more invasive but works post-`app.ready`. Alternatively, try `require('electron').remote.session.defaultSession.webRequest.onBeforeRequest()` to redirect requests.

**Alternative fix:** Try loading the `api.js` via inline eval instead of `<script src>`:
```javascript
const apiCode = fs.readFileSync(apiJsPath, 'utf-8');
(0, eval)(apiCode);
```
This avoids the cross-origin script load entirely. The inner iframe would still need `file://` to work though.

#### Failure 2: api.js loads but inner iframe fails

**Meaning:** `api.js` extracts its base URL from its `<script>` tag's `src` attribute. If Obsidian strips or rewrites the `src`, api.js may construct the wrong iframe URL.

**Fix approach:** Check what URL api.js constructs for the inner iframe. Look for `iframe.src = ...` in DevTools. If the path is wrong, you may need to patch api.js or override `DocsAPI.DocEditor` to inject the correct base URL.

#### Failure 3: Shim loads but postMessage doesn't arrive at bridge

**Meaning:** `postMessage` from `file://` to `app://obsidian.md` isn't working. Chromium may treat `file://` origins as opaque and block outbound postMessage.

**Fix approach:** Check if `window.parent` is accessible from the iframe. In DevTools, switch to the iframe context and run:
```javascript
console.log(window.parent === window); // should be false
window.parent.postMessage({test: true}, "*");
```
If `window.parent` is `null` or the postMessage silently fails, the iframe is sandboxed. Check if api.js adds `sandbox` attributes to the iframe. If so, ensure `allow-scripts allow-same-origin` are present.

#### Failure 4: Editor loads but hangs at "Loading..."

**Meaning:** The mock socket handshake completed but the editor can't fetch Editor.bin. The shim's `/document?docKey=...` interception may not be matching.

**Fix approach:** In DevTools Console, check for `[oo-shim] fetch intercepted: GET /document?docKey=...`. If absent, the mock socket's `fetch("/document?docKey=...")` call isn't being intercepted. Check if the patched `window.fetch` is still in place by running `window.fetch.toString()` in the iframe context — should NOT be `function fetch() { [native code] }`.

#### Failure 5: Editor renders but saving fails

**Meaning:** The `/downloadas/` POST interception or the x2t reverse conversion is failing.

**Fix approach:** Edit some text and watch the console for:
```
[oo-shim] xhr open: POST /downloadas/...
[oo-shim] downloadas cmd: {c: "save", savetype: ...}
[OnlyObsidian Test] saved NNNN bytes to path/to/file.docx
```
If the shim catches the POST but the bridge fails, the error will be in `[OnlyObsidian Test]` logs. If the shim doesn't catch it, OnlyOffice might be using a different URL pattern for saves — check the Network tab for any POST request you don't see in the shim logs.

#### Failure 6: `require is not a function` (same as before)

**Meaning:** RequireJS (`require.js`) failed to load. This is the same error as the `app://` attempt. Check Network tab for `require.js` — if it shows `ERR_BLOCKED_BY_CLIENT` or 404, the `file://` base URL is wrong.

**Fix approach:** Verify the `file://` URL resolves to the correct path by manually navigating to it in a browser or checking `fs.existsSync()` on the corresponding filesystem path.

## Iteration plan (if first attempt works)

If the `file://` approach loads the editor successfully:

1. **Test editing** — type some text, wait for autosave, verify the .docx file updates on disk
2. **Test media** — open a .docx with embedded images, verify they render
3. **Test fonts** — open a .docx with non-standard fonts, verify substitution works (Arial fallback expected)
4. **Add feature parity:**
   - Font substitution dialog (from original plugin)
   - Manual save button/command (Ctrl+S integration)
   - x2t integrity check (SHA-256 hash validation)
5. **Test on restricted endpoint** — deploy to a Baycrest workstation with the loopback binding restriction and verify it works where the original fails
6. **Dual-mode support** — add runtime detection: try `net.createServer().listen(0, '127.0.0.1')` on startup; if it works, use the original localhost approach; if it fails, fall back to the shim approach. Single binary that works everywhere.

## File modification guide

### To change how static assets are served

Edit `main.js`, the `pathToFileUrl()` function and the `assetBaseUrl` construction in `OnlyObsidianTestPlugin.onload()`.

### To change which URLs the shim intercepts

Edit `assets/docx-viewer/transport-shim.js`, the `DYNAMIC` array and the `dispatch()` function.

### To change the mock socket handshake

Edit `assets/docx-viewer/mock-socket.js`, the `MockSocket` constructor's `setTimeout` block. The license, auth, and documentOpen messages are all in there. **Do NOT remove the UMD wrapper at the bottom** — OnlyOffice loads this via RequireJS AMD and will hang without `define()`.

### To change the save protocol

Edit `main.js`, the `TransportBridge._downloadAs()` method. The savetype 0/1/2/3 chunking protocol is implemented there.

### To re-patch the OnlyOffice tree after modifying shim or mock socket

Either restart the plugin (it re-patches on load) or click Settings → OnlyObsidian Test → Re-run patcher.

### To undo all patches to the OnlyOffice tree

```bash
cd assets/onlyoffice
mv web-apps/vendor/socketio/socket.io.min.js.original web-apps/vendor/socketio/socket.io.min.js
mv web-apps/apps/documenteditor/main/index.html.original web-apps/apps/documenteditor/main/index.html
mv web-apps/apps/documenteditor/main/index_loader.html.original web-apps/apps/documenteditor/main/index_loader.html
```

## Key gotchas for anyone working on this

1. **The mock socket MUST have the AMD UMD wrapper.** OnlyOffice loads socket.io via RequireJS `require(['../vendor/socketio/socket.io.min'], ...)`. If the mock doesn't call `define(factory)`, the editor hangs forever. This was a critical bug in the first iteration.

2. **The shim MUST load before ANY other script in the iframe.** If RequireJS or app.js loads first and makes a `fetch()` before the shim patches it, the request goes to `file:///document?docKey=...` which doesn't exist. The AssetPatcher injects it as the first `<script>` after `<head>`.

3. **postMessage targetOrigin must be `"*"` on both sides.** The iframe is at `file://` (opaque origin), the parent is at `app://obsidian.md`. Neither side can reliably specify the other's origin. Security is via the `__shim: "docx-viewer"` magic field.

4. **The transport shim patches XMLHttpRequest as well as fetch.** OnlyOffice uses XHR for the chunked `/downloadas/` save protocol (not fetch). The `ShimXHR` class in transport-shim.js implements `open/send/abort/addEventListener/readyState/status/response` — if you're debugging saves, look there.

5. **The x2t converter runs in-process (eval'd into the renderer).** It sets `globalThis.Module` which is the Emscripten pattern. If another plugin also uses Emscripten WASM, there will be a collision. The original plugin had a `x2t-worker.js` for running x2t in a Node Worker thread but it was unused in the bundle — consider moving to it if stability is an issue.

6. **The patcher backs up originals but NEVER auto-restores them.** If you update the OnlyOffice tree (re-run setup.js after deleting assets/onlyoffice/), the backups will be from the previous version. The patcher checks for the sentinel comment, not file content, so it will skip re-patching if the sentinel is present even if the file is from a different OnlyOffice version.
