# Note tab + vault-wide .md frontmatter — Design

**Date:** 2026-05-28
**Plugin:** Obsidi-Office (`obsidi-office`)
**Source:** `GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office/`

## Goal

Two related additions:

1. **Note tab** on the standalone landing page — a fourth tab (`Document · Presentation · Spreadsheet · Note`) with template cards and a searchable Recent table for plain `.md` notes, mirroring the office tabs.
2. **Vault-wide frontmatter normalization** — every newly-created `.md` file (except office sidecars) gets `tags`, `aliases`, and a `created` property. `created` is auto-filled with a timestamp; `tags`/`aliases` are added empty so they always appear in the Properties panel. Existing values are never overwritten.

## Background

The landing page is rendered by `renderStandaloneLandingPage(containerEl, plugin)` (main.js ~line 2453). It builds a tab strip (left group = format tabs, right group = `🔍 Search`), persists the active tab in `plugin.settings.lastLandingTab`, and per tab renders a **New** template grid + a **Recent** table via the shared `renderRecentTable(host, files, opts)`.

Office files pair with a `.docx.md` / `.pptx.md` / `.xlsx.md` **sidecar** that holds their tags/timestamps; the Recent table reads tags from that sidecar (`sidecarTagArray`). Templates live under a consolidated root `_obsidi-office-templates/{docx,pptx,xlsx}/`, seeded by `_initTemplateDir()` (~line 3653) and hidden from the file explorer by `_injectTemplateDirCSS()` (the templates-root selector hides all children).

Notes are fundamentally different: native `.md` opened directly by Obsidian, carrying their **own** frontmatter (no sidecar). The design accounts for this rather than forcing notes through the binary/sidecar-oriented office path.

## Design

### 1. Note tab

- Add `Note` as the **4th tab in the left group**, after Spreadsheet. `🔍 Search` stays in the right group.
- Notes get a dedicated `renderNoteTab()` instead of reusing `renderTab(fmt)` (which assumes a binary blank, a sidecar tag source, and office view routing). Layout still matches the office tabs: a **New** section (template grid) above a **Recent** section (searchable table).
- `plugin.settings.lastLandingTab` gains `"note"` as a valid value; the initial-render switch at the bottom of `renderStandaloneLandingPage` handles it (falls back to `docx` if invalid).
- Tab icons (emoji, matching existing tabs): blank note card `🗒️`, user-template card `📝`.

### 2. Note templates + directory

- Extend `_initTemplateDir()` to seed a fourth subfolder **`_obsidi-office-templates/notes/`** with **`Blank Note.md`**.
- A new module constant `BLANK_NOTE_MD` holds the seed text:

  ```
  ---
  tags:
  aliases:
  ---
  ```

  Empty `tags:`/`aliases:` (so they render as empty List properties) and **no `created`** — the create listener (section 4) fills `created` fresh on each new note, so copies don't inherit a stale stamp.
- Seeding writes text via `app.vault.create` / `adapter.write` (not `writeBinary`) guarded by an existence check, consistent with the other blanks.
- The `notes/` subfolder is hidden from the explorer automatically — `_injectTemplateDirCSS()` already hides every child of the templates root. No CSS change needed.
- Template cards in the Note tab list every `.md` under `notes/`, sorted with `Blank Note` first (same ordering rule as office blanks). If the folder is somehow empty, fall back to a single synthetic `Blank Note` card backed by `BLANK_NOTE_MD`.
- Clicking a card opens `FileNameModal` with `.md` extension → `app.vault.create(filename, templateText)` at vault root → `app.workspace.getLeaf(true).openFile(tfile)` (Obsidian routes `.md` to its native markdown editor). No sidecar is created for notes. The create listener then injects `created` (and any missing `tags`/`aliases`).

### 3. Recent table for notes

- Source list: all markdown files (`app.vault.getMarkdownFiles()`) **excluding**:
  - office sidecars — `/\.(docx|pptx|xlsx)\.md$/i`
  - anything under the templates root (`path.startsWith(templatesRoot + "/")`)
- Sorted by `mtime` desc, capped at 100 (same as office Recent).
- **Tags column reads the note's OWN frontmatter**, not a sidecar. Add a helper `noteTagArray(file)` that reads `metadataCache.getFileCache(file).frontmatter.tags` (handles array and space/comma string forms, strips leading `#`), parallel to `sidecarTagArray`.
- `renderRecentTable` gains a `tagSource` option (`"sidecar"` default | `"self"`). When `"self"`, pill rendering and filter matching use `noteTagArray(file)` instead of `sidecarTagArray(file)`. The `#` autocomplete tag set for the Note tab is collected from note frontmatter (a `tagSource`-aware variant of `allSidecarTags()`, e.g. `allNoteTags()` scoped to non-sidecar, non-template `.md`).
- Row click opens the note natively (`getLeaf(true).openFile(f)`), same as office rows.
- Empty state: "No notes found." when the filtered list is empty.

### 4. Vault-wide `created` auto-fill

- **Registration timing (critical):** register the `create` handler inside `this.app.workspace.onLayoutReady(() => this.registerEvent(this.app.vault.on("create", handler)))`. Obsidian fires a `create` event for *every existing file* while it indexes the vault on startup; registering only after layout-ready ensures the handler fires solely for files created during the live session. Existing notes are never rewritten.
- **Handler logic** for a created `TFile`:
  1. Bail if not `.md`.
  2. Bail if office sidecar (`/\.(docx|pptx|xlsx)\.md$/i`).
  3. Bail if under the templates root.
  4. Bail if the setting toggle (section 5) is off.
  5. Defer one tick — `setTimeout(fn, 0)` (or a short delay) — so template-based creators (Templater, daily notes, "new from template") write their content/frontmatter first.
  6. Call `app.fileManager.processFrontMatter(file, (fm) => { ... })`:
     - `if (fm.created == null) fm.created = new Date().toISOString();`
     - `if (fm.tags == null) fm.tags = [];`
     - `if (fm.aliases == null) fm.aliases = [];`
  - `processFrontMatter` parses existing frontmatter and merges keys without touching the body, so it is safe even when a template already wrote frontmatter. Only absent keys are added; present values (including non-empty `tags`/`aliases` or a template-supplied `created`) are left untouched.
- This single listener covers notes created by the Note tab, Obsidian's native "new note", and other plugins uniformly. The Note-tab creation path needs no special-casing beyond writing template text.

### 5. Settings & format

- `created`: lowercase key, full **ISO-8601 datetime** (`new Date().toISOString()`), matching the existing sidecar `created` format.
- `tags` / `aliases`: empty lists (`[]`), present so they surface in the Properties panel.
- New setting **`autoNoteFrontmatter`** (boolean, **default `true`**), surfaced in the settings tab as a toggle **"Auto-add frontmatter to new notes"** with a description noting it adds `tags`/`aliases`/`created` to every new `.md` (excluding office sidecars). A vault-wide mutation warrants an off-switch.

## Out of scope (YAGNI)

- The `🔍 Search` tab stays office-only (docx/pptx/xlsx); notes are not folded into the cross-format search.
- No back-fill of frontmatter into pre-existing notes — only files created after the listener is active are affected.
- The pre-existing `_autoCreateSidecar` quirk (always emits a `docx:` wikilink key regardless of parent extension) is left untouched; out of scope here.

## Edge cases / risks

- **Startup create burst** — mitigated by registering inside `onLayoutReady`.
- **Template-writer race** — mitigated by the one-tick defer + add-only-missing `processFrontMatter`.
- **Sync-created files** — a note synced from another device fires a `create` here, so its `created` reflects sync-arrival time, not original authorship. Acceptable; the toggle disables the behavior if undesired.
- **Note created with template-supplied `created`** — preserved (only absent keys are filled).

## Affected code (all in `main.js`)

- `BLANK_NOTE_MD` constant (near other blank constants, ~line 160-185).
- `DEFAULT_SETTINGS` — add `autoNoteFrontmatter: true`; `lastLandingTab` already free-form.
- `_initTemplateDir()` (~3653) — seed `notes/Blank Note.md`.
- `renderStandaloneLandingPage` (~2453) — add `note` format metadata, `Note` tab wiring, `renderNoteTab()`, `noteTagArray()`/`allNoteTags()` helpers, `tagSource` option on `renderRecentTable`, `"note"` handling in initial render.
- Plugin `onload` — register the `onLayoutReady` + `vault.on("create")` frontmatter handler; add a `_normalizeNoteFrontmatter(file)` method.
- Settings tab class (~2351 area) — add the toggle.

## Verification

- Desktop smoke: open landing → Note tab present (4th), shows Blank Note card + Recent `.md` list (sidecars + templates excluded); create from Blank Note → opens in native editor with `tags`/`aliases`/`created` populated.
- Create a `.md` via Obsidian's native "new note" → gains the three properties.
- Create a note from a Templater/daily-note template that already has frontmatter → existing keys preserved, only missing ones added; no duplicate frontmatter block.
- Reload with many existing notes → none are rewritten (onLayoutReady guard).
- Toggle off → new notes get no injected frontmatter.
- iPad smoke (no asset-zip rebuild needed — all changes are parent-window `main.js`).
