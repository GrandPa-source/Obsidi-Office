# Project Memory — OnlyObsidian Test

## What this project is

A localhost-free fork of `obsidian-docx-viewer` (an Obsidian plugin that renders and edits .docx files using OnlyOffice). The original plugin spins up an HTTP server on `127.0.0.1:51430` to serve the OnlyOffice frontend tree and handle the editor's save protocol. This fork replaces that HTTP server with an in-iframe transport shim that routes all dynamic traffic over `window.postMessage` instead.

**Why:** Some endpoints (notably Baycrest Health Sciences Centre workstations) have endpoint security policies that deny loopback TCP binding. The plugin fails silently on these machines — no editor loads, no error shown.

## Architecture

### How the original plugin works

```
Obsidian (app://obsidian.md)
  └─ DocxView creates <iframe src="http://127.0.0.1:51430/web-apps/apps/api/documents/api.js">
       └─ api.js creates inner <iframe src="http://127.0.0.1:51430/web-apps/apps/documenteditor/main/index.html?...">
            └─ Editor loads socket.io, sdkjs, vendor libs — all from localhost HTTP
            └─ Mock socket completes handshake, fetches Editor.bin from localhost
            └─ On save: editor POSTs Editor.bin chunks to /downloadas/ on localhost
                 └─ DocxServer receives chunks, runs x2t (WASM), writes .docx to vault
```

### How this fork works

```
Obsidian (app://obsidian.md)
  └─ DocxView loads api.js via <script src="file:///...assets/onlyoffice/web-apps/apps/api/documents/api.js">
       └─ api.js creates inner <iframe src="file:///...assets/onlyoffice/web-apps/apps/documenteditor/main/index.html?...">
            └─ transport-shim.js (injected first in <head>) patches window.fetch + XMLHttpRequest
            └─ Static resources (JS, CSS, fonts) load natively via file:// — Electron handles this
            └─ Mock socket.io (replaced at build time) completes handshake
            └─ Mock socket fetches Editor.bin via relative URL → shim catches → postMessage to parent
            └─ On save: editor POSTs to /downloadas/ → shim catches → postMessage to parent
                 └─ TransportBridge in parent reassembles chunks, runs x2t, writes via vault.modifyBinary()
```

### Key components

| File | Role |
|---|---|
| `main.js` | Plugin entry. Contains: X2tConverter (WASM), TransportBridge (postMessage RPC handler), AssetPatcher (injects shim into OnlyOffice HTMLs), DocxView (FileView subclass), SettingsTab |
| `assets/docx-viewer/transport-shim.js` | Injected into the editor iframe as the first `<script>` in `<head>`. Patches `window.fetch` and `window.XMLHttpRequest`. Routes dynamic URLs (`/document`, `/media`, `/downloadas/`, `/upload/`, `/callback`) over postMessage to the parent. Static URLs fall through to native fetch (resolved via `file://`). |
| `assets/docx-viewer/mock-socket.js` | Drop-in replacement for `web-apps/vendor/socketio/socket.io.min.js`. Provides a fake `io()` factory that completes the OnlyOffice handshake locally. Uses RequireJS AMD `define()` wrapper (critical — OnlyOffice loads socket.io via RequireJS, not a plain `<script>` tag). |
| `setup.js` / `setup.ps1` | Cross-platform scripts that copy the ~460MB OnlyOffice + x2t asset trees from the existing `obsidian-docx-viewer` plugin into this plugin's `assets/` directory. |
| `assets/onlyoffice/` | The OnlyOffice v9.3.1 frontend tree (web-apps, sdkjs, core-fonts). ~396 MB. Pruned to documenteditor only. NOT shipped in the zip — copied by setup.js from the existing plugin. |
| `assets/x2t/` | x2t.js + x2t.wasm — the Emscripten-compiled DOCX↔Editor.bin converter. ~63 MB. NOT shipped — copied by setup.js. |

### The transport shim in detail

The shim decides whether to intercept or pass through based on URL pattern matching:

**Intercepted (routed via postMessage RPC):**
- `GET /document?docKey=...` → returns Editor.bin bytes
- `GET /media-manifest?docKey=...` → returns JSON array of media filenames
- `GET /media/<name>?docKey=...` → returns media file bytes
- `POST /downloadas/?cmd={savetype:0|1|2|3,...}` → chunked save protocol (THE critical endpoint)
- `POST /upload/...` → embedded image upload (rare)
- `POST /callback` → ack only (mock socket short-circuits)

**Passed through to native fetch (resolved via file://):**
- Everything else: `web-apps/...`, `sdkjs/...`, `vendor/...`, fonts, CSS, images

### The chunked save protocol

OnlyOffice saves documents by POSTing Editor.bin data to `/downloadas/` in chunks:

1. `savetype: 0` — first chunk (PartStart). Bridge generates a saveKey, stores the chunk.
2. `savetype: 1` — middle chunk (Part). Bridge appends to the saveKey's buffer.
3. `savetype: 2` — final chunk (Complete). Bridge appends, concatenates all chunks, runs x2t to convert Editor.bin → .docx, writes to vault.
4. `savetype: 3` — single-shot (entire Editor.bin in one POST). Bridge converts directly.

Each response must be `{ status: "ok", type: "save", data: "<savekey>" }` for the editor to consider the save successful.

### The AssetPatcher

Runs once on plugin load (idempotent via sentinel comment `<!-- onlyobsidian-test-shim-injected -->`):

1. Opens `web-apps/apps/documenteditor/main/index.html` and `index_loader.html`
2. Injects `<script src="../../../../../docx-viewer/transport-shim.js"></script>` as the first element after `<head>`
3. Backs up originals as `*.original`
4. Replaces `web-apps/vendor/socketio/socket.io.min.js` with `assets/docx-viewer/mock-socket.js`
5. Backs up original socket.io as `socket.io.min.js.original`

## Decisions made and why

### Why not app:// protocol?

**Tested and failed.** Obsidian's `app://` protocol handler serves the iframe HTML but blocks JavaScript and CSS sub-resource loads inside iframes with `ERR_BLOCKED_BY_CLIENT`. This is Obsidian's security policy, not a CSP header — the error code indicates the Electron embedder (Obsidian) is actively rejecting the requests. Confirmed in live testing April 15, 2026.

### Why not Service Worker?

Electron requires schemes to be registered with `allowServiceWorkers: true` via `protocol.registerSchemesAsPrivileged()` before `app.ready` fires. Plugins load after `app.ready`. The `app://` scheme is registered by Obsidian core without `allowServiceWorkers`. Confirmed by the console error: `Failed to register a ServiceWorker: The URL protocol of the current origin ('app://f0f9acb662c223d9114fe0defcdb471d1f22') is not supported.`

### Why not custom Electron protocol?

`protocol.registerSchemesAsPrivileged()` can only be called once, before `app.ready`, by the main process. Plugins run in the renderer, after `app.ready`. Only Obsidian core could expose a custom scheme.

### Why not srcdoc / blob: URLs?

OnlyOffice spawns Web Workers, uses `importScripts()` with relative paths, and lazy-loads chunks. All of these require a resolvable base URL. `blob:` and `data:` URLs cannot serve as a base for relative URL resolution.

### Why file:// works

- Electron natively serves `<script src>`, `<link href>`, `<img src>`, and RequireJS `define()` loads from `file://` pages — this is fundamental to how Electron apps work
- The original plugin already operated cross-origin (parent at `app://obsidian.md`, iframe at `http://127.0.0.1`). `file://` is the same cross-origin model
- `postMessage` works across `file://` ↔ `app://` origins (using `targetOrigin: "*"`, validated by `__shim` field)
- The transport shim patches `fetch()` and `XHR` for dynamic URLs, so Chromium's restriction on `fetch()` from `file://` pages doesn't matter for the endpoints we care about

### Why targetOrigin is "*" everywhere

The iframe is at `file:///...` (opaque origin in Chromium — every file:// page gets its own origin). The parent is at `app://obsidian.md`. Specifying a targetOrigin of `"app://obsidian.md"` might not work because Chromium may not recognize `app://` as a valid origin for postMessage targeting from a `file://` context. Using `"*"` is safe because:
- Both sides are controlled by us (not user-controllable content)
- Security is enforced by the `__shim: "docx-viewer"` magic field on every message
- The bridge ignores any message without this field

## OnlyOffice version and tree structure

**Version:** 9.3.1 (build 10)
**Source:** github.com/ONLYOFFICE/DocumentServer releases
**License:** AGPL-3.0

```
assets/onlyoffice/
├── CHECKSUMS.sha256
├── VERSION.json
├── core-fonts/          (abyssinica, arphic-ukai, asana, caladea, crosextra, ...)
├── fonts/               (optional — font fallback for missing system fonts)
├── sdkjs/
│   ├── common/          (AllFonts.js, serviceworker/, ...)
│   └── word/            (document editor JS modules)
└── web-apps/
    ├── apps/
    │   ├── api/documents/api.js        ← THE entry point loaded by <script> tag
    │   ├── common/                     ← shared UI components
    │   └── documenteditor/
    │       ├── main/
    │       │   ├── index.html          ← inner iframe HTML (patched by AssetPatcher)
    │       │   ├── index_loader.html   ← alternative loader (also patched)
    │       │   ├── app.js              ← main editor application (minified, ~65KB)
    │       │   └── code.js             ← editor core
    │       ├── embed/                  ← not used by desktop viewer
    │       ├── forms/                  ← not used
    │       └── mobile/                 ← not used
    └── vendor/
        ├── requirejs/require.js        ← AMD module loader
        └── socketio/socket.io.min.js   ← REPLACED with mock-socket.js by patcher
```

**Key detail:** OnlyOffice loads socket.io via RequireJS AMD: `require(['../vendor/socketio/socket.io.min'], ...)`. The mock socket MUST include a UMD wrapper with `define(factory)` when `define.amd` is present, otherwise the editor hangs forever waiting for the module to resolve.

## Current status (as of April 15, 2026)

### What's been tested and confirmed

- ✅ Setup script copies 4571 files (392.5 MB) correctly from existing plugin
- ✅ AssetPatcher injects shim into both editor HTMLs at correct position
- ✅ Relative path from editor HTML to shim resolves correctly: `../../../../../docx-viewer/transport-shim.js`
- ✅ socket.io.min.js replaced with AMD-compatible mock (44 KB → 8.9 KB)
- ✅ Patcher is idempotent (second run is a no-op)
- ✅ Backups created for all modified files
- ✅ All JS files syntax-validate
- ✅ pathToFileUrl handles Windows paths, spaces, and # characters
- ✅ `app://` approach tested and confirmed broken (ERR_BLOCKED_BY_CLIENT)
- ✅ Service Worker approach confirmed broken (app:// scheme doesn't support SW)

### What has NOT been tested yet

- ❓ Whether `file://` iframe loads sub-resources correctly in Obsidian's Electron build
- ❓ Whether `<script src="file:///...api.js">` loads successfully from the parent `app://obsidian.md` window
- ❓ Whether postMessage works from `file://` iframe to `app://obsidian.md` parent
- ❓ Whether RequireJS module loading works from `file://` origin
- ❓ Whether x2t WASM conversion produces valid output when invoked from TransportBridge
- ❓ Whether the chunked save protocol round-trips correctly through postMessage
- ❓ Whether OnlyOffice's Web Workers make any HTTP requests that bypass the main-thread shim
- ❓ Whether OnlyOffice's `document_editor_service_worker.js` registration failure (expected) causes any functional issues beyond a console warning

### Known potential issues

1. **Chromium blocks `fetch()` from `file://` pages** — mitigated by the transport shim patching `fetch()` for dynamic URLs, but OnlyOffice might also use `fetch()` for some static resources (JSON configs, theme files). If so, the shim would need to be expanded to serve those from the bridge.

2. **Web Worker requests** — the shim only patches the main thread's `fetch/XHR`. If OnlyOffice spawns a Worker that makes HTTP requests to dynamic endpoints, those won't be intercepted. Fix: patch `window.Worker` to inject the shim into worker bootstrap.

3. **OnlyOffice parentOrigin check** — the editor reads `parentOrigin` from its URL params and may validate incoming postMessage origins against it. Since the parent is `app://obsidian.md` and the iframe is `file://`, origin matching might fail. The original plugin handled this at line 7134 of its bundle: `var expectedParent = 'app://obsidian.md'`. If the editor strictly checks the reverse (iframe checking parent origin), we may need to patch that check.

4. **CSP on the parent window** — if Obsidian's `app://obsidian.md` has a Content-Security-Policy that restricts `script-src` to same-origin, loading `api.js` from `file://` would be blocked. However, the original plugin loaded api.js from `http://127.0.0.1:*` (also cross-origin) and it worked, so this is unlikely.

## Files in this package

```
onlyobsidian-test/
├── manifest.json                     ← plugin metadata (id: onlyobsidian-test)
├── data.json                         ← default settings
├── main.js                           (860 LoC) ← all plugin logic
├── README.md                         ← quickstart + troubleshooting
├── setup.js                          ← Node.js setup script (copies assets)
├── setup.ps1                         ← PowerShell setup script (Windows)
├── MEMORY.md                         ← this file
├── INSTRUCTIONS.md                   ← what to do next
└── assets/
    └── docx-viewer/
        ├── transport-shim.js         (337 LoC) ← injected into editor iframe
        └── mock-socket.js            (219 LoC) ← replaces socket.io.min.js
```

After running `setup.js`:

```
assets/
├── docx-viewer/                      ← shipped
├── onlyoffice/                       ← copied from obsidian-docx-viewer (~396 MB)
│   ├── web-apps/...
│   ├── sdkjs/...
│   └── core-fonts/...
└── x2t/                              ← copied from obsidian-docx-viewer (~63 MB)
    ├── x2t.js
    └── x2t.wasm
```

## Related context

- The original `obsidian-docx-viewer` plugin is by GrandpaProjects, v0.1.0, AGPL-3.0
- Architecture decision memo `DOCX-VIEWER/02` (HTML document) was produced earlier in this conversation with full reasoning
- Paul works in Security Operations at Baycrest Health Sciences Centre, Toronto
- The target environment is locked-down Windows workstations with endpoint security that blocks loopback TCP binding
- Paul has a Proxmox homelab and extensive Obsidian plugin development experience
- The x2t integrity check (SHA-256) from the original plugin was NOT ported to this fork — may want to re-add
