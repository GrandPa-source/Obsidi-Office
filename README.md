# OnlyObsidian Test

Localhost-free OnlyOffice integration for Obsidian.

This plugin replaces the `127.0.0.1:51430` HTTP server in the original
`obsidian-docx-viewer` with an in-iframe transport shim that routes all
dynamic OnlyOffice traffic over `window.postMessage` instead. Static
assets are served by Obsidian's existing `app://` resource protocol.

For locked-down endpoints where loopback TCP binding is denied.

---

## Quick start (3 steps)

### 1. Extract this zip

Place the `onlyobsidian-test/` folder into your vault's plugins dir:

```
<your-vault>/.obsidian/plugins/onlyobsidian-test/
```

### 2. Copy the OnlyOffice + x2t assets

This plugin doesn't ship the ~459 MB AGPL OnlyOffice tree. Use the
included setup script to copy them from your existing
`obsidian-docx-viewer` install:

**Linux / macOS / Windows (Node.js):**

```bash
cd <your-vault>/.obsidian/plugins/onlyobsidian-test
node setup.js
```

**Windows (PowerShell, no Node required):**

```powershell
cd <your-vault>\.obsidian\plugins\onlyobsidian-test
.\setup.ps1
```

The script auto-detects the source plugin if it's a sibling in the same
`plugins/` directory. If yours is somewhere else, pass the path:

```bash
node setup.js /custom/path/to/obsidian-docx-viewer
# or
.\setup.ps1 -SourcePath "C:\custom\path\to\obsidian-docx-viewer"
```

Expected output:

```
[setup] OnlyObsidian Test setup
[setup] script dir: ...
[setup] source: ...
[setup] copying assets/onlyoffice/ ... (this is the slow part, ~80-400 MB)
[setup]   copied 5023 files (396.4 MB) in 12.3s
[setup] copying assets/x2t/ ...
[setup]   copied 2 files (62.8 MB) in 0.4s
[setup] done. ...
```

### 3. Enable the plugin

In Obsidian: **Settings → Community plugins → Installed plugins → OnlyObsidian Test → toggle on.**

If it loads cleanly you'll see `OnlyObsidian Test loaded.` as a Notice.

The plugin will auto-patch the OnlyOffice tree on first load (idempotent
— sentinel comments and content-equality checks prevent re-patching;
originals backed up as `*.original` if you want to roll back).

---

## What you should see when it works

Open any `.docx` in your vault:

1. The OnlyOffice editor renders inside the Obsidian pane
2. **No** firewall popup, **no** TCP socket on 127.0.0.1:51430
3. Open DevTools (Ctrl/Cmd+Shift+I) → Network panel:
   - Filter `127.0.0.1` → empty
   - Filter `app://` → loads of OnlyOffice assets
4. Console has streams of `[oo-shim]`, `[mock-socket]`, `[OnlyObsidian Test]` log lines
5. Edit some text, wait a couple seconds, check the file's mtime on disk — should update

---

## Troubleshooting

### Editor pane shows "Failed to load OnlyOffice api.js"

`getResourcePath` couldn't resolve a usable `app://` URL for the plugin
directory. Check **Settings → OnlyObsidian Test → Asset paths** — the
"Asset base URL" should look like `app://<32-hex-chars>/...`. If it's
empty or malformed, this is open question #1 from the architecture memo
— Obsidian's `app://` may not serve plugin-internal paths on your build.
Send me the Asset base URL string and the platform/Obsidian version.

### Editor hangs at the loading splash forever

Most likely the mock socket isn't being loaded. Check:
- DevTools console for any line starting with `[mock-socket]` — if absent, the patcher didn't replace `socket.io.min.js`
- `assets/onlyoffice/web-apps/vendor/socketio/socket.io.min.js` should be the mock (~8 KB), with `socket.io.min.js.original` next to it (~44 KB)
- Click **Settings → OnlyObsidian Test → Re-run patcher** to re-patch

### Save doesn't persist to disk

Check console for `[OnlyObsidian Test]` lines around save events. The
flow is: editor XHR `/downloadas/` → shim catches → `[oo-shim] xhr open: POST` → bridge processes → `[OnlyObsidian Test] saved N bytes to ...`. Whichever step is missing tells you where the break is.

### Worker-originated requests not intercepted

The shim only patches the iframe's main thread. If you see XHR requests
to `/document` or `/downloadas/` in the Network panel that aren't in the
shim's console logs, OnlyOffice spawned a Worker that we're not
patching. Send me the failing URL — fix is to also patch `window.Worker`.

---

## To roll back the OnlyOffice tree patches

The patcher backs up originals as `<file>.original`. To revert:

```bash
cd assets/onlyoffice
mv web-apps/vendor/socketio/socket.io.min.js.original web-apps/vendor/socketio/socket.io.min.js
mv web-apps/apps/documenteditor/main/index.html.original web-apps/apps/documenteditor/main/index.html
mv web-apps/apps/documenteditor/main/index_loader.html.original web-apps/apps/documenteditor/main/index_loader.html
```

Or just disable the plugin and delete `assets/onlyoffice/` and
`assets/x2t/` and re-run `setup.js`.

---

## Architecture (summary)

| Layer | File | Role |
|---|---|---|
| Iframe shim | `assets/docx-viewer/transport-shim.js` | Patches `fetch` + `XMLHttpRequest` inside editor iframe; routes dynamic URLs over `postMessage` |
| Mock socket | `assets/docx-viewer/mock-socket.js` | RequireJS-AMD-compatible drop-in for `socket.io.min.js`; completes handshake locally |
| Bridge | `main.js` (`TransportBridge`) | Receives RPC in parent window; runs x2t; writes back to vault |
| View | `main.js` (`DocxView`) | Creates editor iframe with `app://` src |
| Patcher | `main.js` (`AssetPatcher`) | Idempotently patches HTMLs and replaces socket.io |

See architecture memo `DOCX-VIEWER/02` for full reasoning.

---

## License

OnlyOffice components remain under AGPL-3.0.
