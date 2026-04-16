# Obsidi-Office

**Work in progress** — An [Obsidian](https://obsidian.md) plugin that embeds the [OnlyOffice](https://www.onlyoffice.com/) document editor for viewing and editing `.docx` files directly inside your vault.

## What makes this different

Most OnlyOffice integrations — including the official [Document Server](https://helpcenter.onlyoffice.com/installation/docs-community-install-docker.aspx) — require either a Docker container or a localhost HTTP server to serve the editor frontend and handle the save protocol. This creates problems on locked-down endpoints where Docker isn't available, loopback TCP binding is blocked by endpoint security policies, or firewall rules prevent local server creation.

**Obsidi-Office uses none of that.** The entire OnlyOffice editor runs inside a sandboxed iframe using Obsidian's native `app://` protocol for static assets and `window.postMessage` for all dynamic communication (document loading, saving, image uploads, font serving). There is no HTTP server, no Docker container, no TCP socket, and no network dependency. Everything runs in-process within Obsidian's Electron environment.

## Status

This plugin is under active development. Only `.docx` files are supported in the current phase. Other OnlyOffice-supported formats (spreadsheets, presentations, Visio) may be reviewed for future development.

Current working features:

- Document viewing and editing (Word-accurate rendering via OnlyOffice v9.3.1)
- Save — Ctrl+S, toolbar button, 10-second auto-save
- Insert images from file and clipboard paste (Ctrl+V)
- Embedded images persist across save and reload
- SVG toolbar icons
- Font fallback (Arial substitution for missing fonts)
- Save status indicator (blue spinner → green checkmark)
- Fit-to-width zoom

Known limitations:

- Print/PDF export is not yet functional (Electron prints the full window, not the document content)

## Installation

1. Copy the plugin files to your vault's plugins directory:
   ```
   <vault>/.obsidian/plugins/onlyobsidian-test/
   ```

2. Enable the plugin in **Settings → Community plugins**.

3. On first activation, the plugin automatically downloads the OnlyOffice asset package (~213 MB) from this repository's GitHub Releases. A progress notice is displayed during download and extraction.

4. Open any `.docx` file in your vault.

## Architecture

The plugin replaces the conventional localhost HTTP server with a postMessage RPC bridge:

| Component | File | Role |
|---|---|---|
| Transport shim | `assets/docx-viewer/transport-shim.js` | Patches `fetch` + `XMLHttpRequest` inside the editor iframe; routes dynamic URLs over `postMessage` |
| Mock socket | `assets/docx-viewer/mock-socket.js` | Drop-in replacement for `socket.io`; completes the OnlyOffice handshake locally |
| Bridge | `main.js` (`TransportBridge`) | Receives RPC calls in the parent window; runs x2t WASM conversion; writes back to vault |
| View | `main.js` (`DocxView`) | Constructs a blob iframe with inlined CSS, SVG icons, and patched URL parameters |
| Asset patcher | `main.js` (`AssetPatcher`) | Idempotently injects the transport shim into OnlyOffice HTML entry files |

Static assets (JavaScript, CSS, fonts) are served by Obsidian's built-in `app://` protocol. The editor iframe is loaded as a `blob:` URL that inherits the parent origin, allowing same-origin sub-resource loading without a server.

## License

This plugin's code is provided as-is for personal use. OnlyOffice components are licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html).
