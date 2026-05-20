# Obsidi-Office

An [Obsidian](https://obsidian.md) plugin that embeds the [OnlyOffice](https://www.onlyoffice.com/) editor for viewing and editing Microsoft Office documents (`.docx`, `.pptx`, `.xlsx`) directly inside your vault.

## What makes this different

OnlyOffice integrations — including the official [Document Server](https://helpcenter.onlyoffice.com/installation/docs-community-install-docker.aspx) — normally require either a Docker container or a localhost HTTP server to host the editor frontend and to handle the save protocol. That is a non-starter on locked-down endpoints where Docker is unavailable, loopback TCP binding is denied by endpoint security policies, or firewall rules prevent local server creation.

**Obsidi-Office uses none of that.** The OnlyOffice editor runs inside a `blob:` iframe that inherits the parent window's origin (`app://obsidian.md`), with `window.postMessage` carrying all dynamic traffic (document load, save, image upload, font serving, spellcheck assets). There is no HTTP server, no Docker container, no TCP socket, and no network dependency at runtime. The full conversion pipeline (DOCX / PPTX / XLSX ↔ Editor.bin) runs as in-process WebAssembly via x2t.

The plugin runs on desktop (Windows / macOS / Linux) and on iPadOS Obsidian.

## Status

Work in progress. Public source: https://github.com/GrandPa-source/Obsidi-Office

| Format | Status |
|---|---|
| `.docx` | Full — view, edit, save, print, PDF export, sidecar metadata, image upload + paste, spellcheck |
| `.pptx` | Full — view, edit, save, print, PDF export with 4 layouts (Full Page / Notes / 2-Slide / 3-Slide), sidecar metadata |
| `.xlsx` | Beta — view, edit, save, sidecar metadata. PDF export and print are deferred (see Roadmap below) |

Other features:

- Save: Ctrl+S, toolbar button, 10-second idle autosave with on-screen status indicator (blue spinner → green checkmark)
- Spellcheck: en_US + en_CA Hunspell dictionaries (MPL-2.0), red-underline live
- Image upload via Insert → Image, and clipboard paste (Ctrl+V from external apps)
- Font handling: Arial substitution dialog for missing fonts; subset metric fonts shipped for x2t conversion
- Sidecar metadata: `<document>.docx.md` / `.pptx.md` / `.xlsx.md` files with YAML frontmatter — tags and wikilinks autocompleted against your vault, indexed by Obsidian for graph / tag-search / backlinks
- Landing page with a template grid and a recent-files table
- iPad: AirPrint via transient PDF + iOS share sheet

## Installation

1. Copy the plugin files to your vault:
   ```
   <vault>/.obsidian/plugins/obsidi-office/
   ```

2. Enable **ObsidiOffice** in **Settings → Community plugins**.

3. On first activation, the plugin downloads the OnlyOffice asset bundle from this repository's GitHub Releases. The download streams in-memory via `requestUrl` + `fflate.unzipSync` and writes per-file into the plugin folder — no temporary zip is ever stored in your vault.

   - Asset bundle: [`obsidi-office-assets-v9.3.2.zip`](https://github.com/GrandPa-source/Obsidi-Office/releases/download/v0.1.0-assets/obsidi-office-assets-v9.3.2.zip) (~83 MB compressed)
   - Bundled contents: OnlyOffice web-apps v9.3.1 (`documenteditor` + `presentationeditor` + `spreadsheeteditor`), sdkjs (word + slide + cell engines), x2t WebAssembly converter, 44 subset metric fonts for x2t conversion, Hunspell en_US / en_CA dictionaries
   - Re-extract from **Settings → Reinstall assets** if the bundle ever corrupts

4. Open any `.docx`, `.pptx`, or `.xlsx` file from your vault — or use the ribbon icon to open the landing page and start a new document from a template.

## Architecture

The plugin replaces the conventional localhost HTTP server with a `postMessage` RPC bridge:

| Component | File | Role |
|---|---|---|
| Transport shim | `assets/docx-viewer/transport-shim.js` | Loaded first inside the editor iframe. Patches `fetch` and `XMLHttpRequest` so dynamic URLs (`/document`, `/media`, `/downloadas`, `/upload`, `/callback`, `/fonts/...`, spellcheck assets) are routed over `postMessage` to the parent. Static URLs fall through to native fetch. |
| Mock socket | `assets/docx-viewer/mock-socket.js` | Drop-in replacement for `socket.io`. Completes the OnlyOffice handshake locally (license, auth, `documentOpen`) without any real socket. Uses an AMD UMD wrapper so OnlyOffice's RequireJS loader is satisfied. |
| Bridge | `main.js` (`TransportBridge`) | Receives RPC calls in the parent window. Runs x2t WASM conversion both directions (DOCX/PPTX/XLSX → Editor.bin → DOCX/PPTX/XLSX). Writes results back through Obsidian's vault adapter. |
| View classes | `main.js` (`DocxView`, `PptxView`, `XlsxView`) | Construct a `blob:` iframe with inlined CSS, pre-injected SVG icons, and patched URL parameters. Wire save shortcuts, print, PDF export, sidecar metadata UI. |
| Asset patcher | `main.js` (`AssetPatcher`) | Idempotently injects the transport shim and swaps in the mock socket at first launch. Sentinel comments prevent re-patching on subsequent loads (including legacy sentinels from earlier plugin ids, to avoid forcing re-patches on existing installs). |

The `blob:` iframe inherits the parent window's origin (`app://obsidian.md`), which lets it load OnlyOffice's static assets (JS, CSS, fonts) via Obsidian's built-in `app://` protocol without cross-origin sub-resource blocks. All editor ↔ plugin communication is `postMessage` with a `__shim: "docx-viewer"` filter field.

Earlier iterations attempted serving static assets via a direct `app://` iframe (Obsidian blocked sub-resource loads with `ERR_BLOCKED_BY_CLIENT`) and via `file://` URLs (Chromium opaque-origin restrictions broke postMessage targeting). Both were abandoned. The `blob:` URL inheriting parent origin is the working solution — if you are reading the source and considering "fixing" the use of `blob:`, you will rediscover the same blockers.

## Roadmap

- `.xlsx` PDF export and print are deferred. The cell engine's `asc_initPrintPreview` path expects a Backbone UI view that is only constructed via the normal print-preview flow, and programmatic init crashes the engine. Native PDF via `asc_DownloadAs(513)` is the intended replacement path.
- Other OnlyOffice-supported formats (Visio, ODT/ODS/ODP) may be reviewed for future phases.

## License

This plugin's code is provided as-is for personal use. OnlyOffice components are licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html). Hunspell dictionaries are MPL-2.0.
