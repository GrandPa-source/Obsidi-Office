# Note tab + vault-wide .md frontmatter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Note" tab to the Obsidi-Office landing page (template cards + searchable Recent table for plain `.md` notes) and a vault-wide listener that gives every new non-sidecar `.md` empty `tags`/`aliases` plus an auto-filled `created` timestamp.

**Architecture:** All changes live in the single plugin file `main.js` (plain JS, no build). A new `BLANK_NOTE_MD` constant + a `notes/` template subfolder feed a dedicated `renderNoteTab()`. The shared `renderRecentTable` gains a `tagSource` option so notes read their own frontmatter instead of a sidecar. A `vault.on("create")` handler, registered inside `app.workspace.onLayoutReady` (so it never fires for the startup index burst), calls `app.fileManager.processFrontMatter` to add only missing keys.

**Tech Stack:** Obsidian plugin API (`Vault`, `FileManager.processFrontMatter`, `MetadataCache`, `Workspace`). No test framework exists in this project — verification is `node --check main.js` (syntax) plus manual desktop/iPad smoke testing, consistent with the project's entire history.

**Spec:** `docs/superpowers/specs/2026-05-28-note-tab-and-md-frontmatter-design.md`

**Source root:** `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office\`
**Deploy target (staging):** `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\`

---

## File Structure

- **Modify only:** `main.js`
  - Module constants region (~line 161) — add `BLANK_NOTE_MD`.
  - `DEFAULT_SETTINGS` (~line 278) — add `autoNoteFrontmatter: true`.
  - `OnlyObsidianTestPlugin._initTemplateDir` (~line 3653) — seed `notes/Blank Note.md`.
  - `OnlyObsidianTestPlugin.onload` (~line 3303) — register the create listener.
  - `OnlyObsidianTestPlugin._normalizeNoteFrontmatter` (new method, ~line 4145).
  - Settings tab class (~line 2349) — add the toggle.
  - `renderStandaloneLandingPage` (~line 2453) — helpers, `tagSource`, `renderNoteTab`, tab wiring, initial render.
  - `FileNameModal` (~line 4561/4570) — `.md` entries in the blank/kind maps.

**Task order matters:** Task 5 (adds `noteTagArray`/`allNoteTags`) must precede Task 6 (`renderNoteTab` uses them). Task 1 (constant + setting) must precede Tasks 2–4.

---

### Task 1: Add `BLANK_NOTE_MD` constant and `autoNoteFrontmatter` setting

**Files:**
- Modify: `main.js` (constants region ~161; `DEFAULT_SETTINGS` ~291)

- [ ] **Step 1: Add the `BLANK_NOTE_MD` constant**

Edit `main.js`. Find this anchor (the spell-check Worker prologue comment, immediately after the three blank base64 constants):

```
// Spell-check Worker prologue. Mirrored from onlyobsidian-mobile (commit
```

Replace it with:

```
// Seed content for `_obsidi-office-templates/notes/Blank Note.md`.
// Empty tags/aliases render as List properties in Obsidian; no `created`
// here on purpose — the vault create listener fills `created` fresh on each
// new note, so copies of this template don't inherit a stale timestamp.
const BLANK_NOTE_MD = "---\ntags:\naliases:\n---\n";

// Spell-check Worker prologue. Mirrored from onlyobsidian-mobile (commit
```

- [ ] **Step 2: Add the `autoNoteFrontmatter` default setting**

Find this anchor in `DEFAULT_SETTINGS`:

```
  lastLandingTab: "docx",
```

Replace it with:

```
  lastLandingTab: "docx",
  // 2026-05-28 — vault-wide note frontmatter normalization. When on, every
  // new non-sidecar .md gets empty tags/aliases + an ISO `created` (missing
  // keys only; existing values are never overwritten).
  autoNoteFrontmatter: true,
```

- [ ] **Step 3: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note frontmatter: add BLANK_NOTE_MD constant + autoNoteFrontmatter setting"
```

---

### Task 2: Seed `notes/Blank Note.md` in `_initTemplateDir`

**Files:**
- Modify: `main.js` (`_initTemplateDir`, ~line 3653)

- [ ] **Step 1: Add the notes seeding block**

Find this anchor (the end of the office-format seeding loop and the method's closing brace):

```
        await adapter.writeBinary(blankPath, bytes);
      }
    }
  }
```

Replace it with:

```
        await adapter.writeBinary(blankPath, bytes);
      }
    }
    // Note templates live alongside the office subfolders, but as plain text.
    const notesDir = root + "/notes";
    if (!(await adapter.exists(notesDir))) {
      await adapter.mkdir(notesDir);
    }
    const blankNotePath = notesDir + "/Blank Note.md";
    if (!(await adapter.exists(blankNotePath))) {
      await adapter.write(blankNotePath, BLANK_NOTE_MD);
    }
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note frontmatter: seed _obsidi-office-templates/notes/Blank Note.md"
```

---

### Task 3: Vault-wide create listener + `_normalizeNoteFrontmatter`

**Files:**
- Modify: `main.js` (`onload` ~line 3303; new method near `_autoCreateSidecar` ~line 4145)

- [ ] **Step 1: Register the create listener (gated on layout-ready)**

Find this anchor (the existing sidecar `delete` handler at the end of the rename/delete block):

```
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (isSidecarParent(file)) {
        const sidecarPath = file.path + ".md";
        const sf = this.app.vault.getAbstractFileByPath(sidecarPath);
        if (sf && sf instanceof obsidian.TFile) {
          this.app.vault.delete(sf);
          dlog("sidecar deleted:", sidecarPath);
        }
      }
    }));
```

Replace it with (the same block plus the new listener):

```
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (isSidecarParent(file)) {
        const sidecarPath = file.path + ".md";
        const sf = this.app.vault.getAbstractFileByPath(sidecarPath);
        if (sf && sf instanceof obsidian.TFile) {
          this.app.vault.delete(sf);
          dlog("sidecar deleted:", sidecarPath);
        }
      }
    }));

    // Vault-wide note frontmatter normalization. Registered INSIDE
    // onLayoutReady: Obsidian fires a "create" event for every existing file
    // while indexing the vault on startup, so registering after layout-ready
    // ensures only files created during the live session reach the handler —
    // existing notes are never rewritten.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (!(file instanceof obsidian.TFile)) return;
        if (file.extension !== "md") return;
        if (/\.(docx|pptx|xlsx)\.md$/i.test(file.path)) return;  // office sidecar
        const root = this.settings.templatesRoot || "_obsidi-office-templates";
        if (file.path === root || file.path.startsWith(root + "/")) return;  // template file
        if (this.settings.autoNoteFrontmatter === false) return;
        // Defer one tick so template-based creators (Templater, daily notes,
        // "new from template") write their content/frontmatter first;
        // processFrontMatter then only adds keys that are still absent.
        setTimeout(() => this._normalizeNoteFrontmatter(file), 0);
      }));
    });
```

- [ ] **Step 2: Add the `_normalizeNoteFrontmatter` method**

Find this anchor (the start of the existing `_autoCreateSidecar` method):

```
  async _autoCreateSidecar(parentFile) {
```

Replace it with (new method, then the original method header):

```
  // 2026-05-28 — add the three standard properties to a new note's own
  // frontmatter. Only missing keys are filled; existing values and the note
  // body are left untouched. `created` is a full ISO-8601 datetime matching
  // the sidecar `created` format.
  async _normalizeNoteFrontmatter(file) {
    if (!file || file.extension !== "md") return;
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (fm.created == null) fm.created = new Date().toISOString();
        if (fm.tags == null) fm.tags = [];
        if (fm.aliases == null) fm.aliases = [];
      });
      dlog("normalized note frontmatter:", file.path);
    } catch (err) {
      elog("note frontmatter normalize failed:", err && err.message);
    }
  }

  async _autoCreateSidecar(parentFile) {
```

- [ ] **Step 3: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note frontmatter: vault create listener + _normalizeNoteFrontmatter (layout-ready gated)"
```

---

### Task 4: Settings toggle "Auto-add frontmatter to new notes"

**Files:**
- Modify: `main.js` (settings tab `display()`, after the "Templates root" setting, ~line 2358)

- [ ] **Step 1: Add the toggle after the Templates-root setting**

Find this anchor (the full "Templates root" `addText` block):

```
      .addText(t => t
        .setValue(this.plugin.settings.templatesRoot || "_obsidi-office-templates")
        .onChange(async v => {
          this.plugin.settings.templatesRoot = v;
          await this.plugin.saveSettings();
          this.plugin._injectTemplateDirCSS();
        }));
```

Replace it with (same block plus the new Setting):

```
      .addText(t => t
        .setValue(this.plugin.settings.templatesRoot || "_obsidi-office-templates")
        .onChange(async v => {
          this.plugin.settings.templatesRoot = v;
          await this.plugin.saveSettings();
          this.plugin._injectTemplateDirCSS();
        }));

    new obsidian.Setting(containerEl)
      .setName("Auto-add frontmatter to new notes")
      .setDesc(
        "Adds empty tags and aliases properties and an auto-filled created " +
        "timestamp to every new .md note. Excludes .docx.md/.pptx.md/.xlsx.md " +
        "sidecars and template files. Existing values are never overwritten."
      )
      .addToggle(t => t
        .setValue(this.plugin.settings.autoNoteFrontmatter !== false)
        .onChange(async v => {
          this.plugin.settings.autoNoteFrontmatter = v;
          await this.plugin.saveSettings();
        }));
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note frontmatter: settings toggle for auto-add frontmatter"
```

---

### Task 5: Tag helpers + `tagSource` option on `renderRecentTable`

**Files:**
- Modify: `main.js` (`renderStandaloneLandingPage`: helpers ~2521/2541, `matchAgainstQuery` ~2584, `renderRecentTable` ~2692)

- [ ] **Step 1: Add `noteTagArray` helper**

Find this anchor (the existing `sidecarTagText` wrapper):

```
  // Back-compat thin wrapper — returns space-joined lowercased text.
  function sidecarTagText(file) {
    return sidecarTagArray(file).join(" ");
  }
```

Replace it with (same plus `noteTagArray`):

```
  // Back-compat thin wrapper — returns space-joined lowercased text.
  function sidecarTagText(file) {
    return sidecarTagArray(file).join(" ");
  }

  // Note tab — read tags from the note's OWN frontmatter (notes carry their
  // own frontmatter; they have no sidecar). Same array/string handling as
  // sidecarTagArray.
  function noteTagArray(file) {
    if (!(file instanceof obsidian.TFile)) return [];
    const cache = app.metadataCache.getFileCache(file);
    const tags = cache && cache.frontmatter && cache.frontmatter.tags;
    if (Array.isArray(tags)) return tags.map((t) => String(t).replace(/^#/, ""));
    if (typeof tags === "string") return tags.split(/[\s,]+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
    return [];
  }
```

- [ ] **Step 2: Add `allNoteTags` helper**

Find this anchor (the end of the existing `allSidecarTags` function):

```
      else if (typeof tags === "string") {
        tags.split(/[\s,]+/).forEach((t) => { const c = t.replace(/^#/, ""); if (c) set.add(c); });
      }
    }
    return Array.from(set).sort();
  }
```

Replace it with (same plus `allNoteTags`):

```
      else if (typeof tags === "string") {
        tags.split(/[\s,]+/).forEach((t) => { const c = t.replace(/^#/, ""); if (c) set.add(c); });
      }
    }
    return Array.from(set).sort();
  }

  // Note tab — unique tag set across all non-sidecar, non-template notes
  // (read from each note's own frontmatter). Feeds the `#` autocomplete.
  function allNoteTags() {
    const set = new Set();
    for (const f of app.vault.getMarkdownFiles()) {
      if (/\.(docx|pptx|xlsx)\.md$/i.test(f.path)) continue;
      if (f.path.startsWith(templatesRoot + "/")) continue;
      const cache = app.metadataCache.getFileCache(f);
      const tags = cache && cache.frontmatter && cache.frontmatter.tags;
      if (Array.isArray(tags)) tags.forEach((t) => set.add(String(t).replace(/^#/, "")));
      else if (typeof tags === "string") {
        tags.split(/[\s,]+/).forEach((t) => { const c = t.replace(/^#/, ""); if (c) set.add(c); });
      }
    }
    return Array.from(set).sort();
  }
```

- [ ] **Step 3: Make `matchAgainstQuery` accept a tag-array function**

Find this anchor (the whole `matchAgainstQuery` function):

```
  function matchAgainstQuery(file, parsed) {
    const basename = file.basename.toLowerCase();
    for (const nt of parsed.nameTokens) {
      if (!basename.includes(nt)) return false;
    }
    if (parsed.tagTokens.length > 0) {
      const tags = sidecarTagArray(file).map((t) => t.toLowerCase());
      for (const tt of parsed.tagTokens) {
        if (!tags.some((t) => t.includes(tt))) return false;
      }
    }
    return true;
  }
```

Replace it with:

```
  function matchAgainstQuery(file, parsed, tagArrayFn) {
    const basename = file.basename.toLowerCase();
    for (const nt of parsed.nameTokens) {
      if (!basename.includes(nt)) return false;
    }
    if (parsed.tagTokens.length > 0) {
      const getTags = tagArrayFn || sidecarTagArray;
      const tags = getTags(file).map((t) => t.toLowerCase());
      for (const tt of parsed.tagTokens) {
        if (!tags.some((t) => t.includes(tt))) return false;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Derive tag source inside `renderRecentTable`**

Find this anchor (the first line inside `renderRecentTable`):

```
    const showTypeCol = !!(opts && opts.showTypeCol);
```

Replace it with:

```
    const showTypeCol = !!(opts && opts.showTypeCol);
    // tagSource: "sidecar" (default — office tabs) | "self" (Note tab, reads
    // the file's own frontmatter).
    const tagSource = (opts && opts.tagSource) || "sidecar";
    const tagArrayFn = tagSource === "self" ? noteTagArray : sidecarTagArray;
    const allTagsFn = tagSource === "self" ? allNoteTags : allSidecarTags;
```

- [ ] **Step 5: Use `tagArrayFn` in `renderRowPills`**

Find this anchor:

```
    function renderRowPills(r) {
      r.tagFlex.empty();
      const tags = sidecarTagArray(r.file);
```

Replace it with:

```
    function renderRowPills(r) {
      r.tagFlex.empty();
      const tags = tagArrayFn(r.file);
```

- [ ] **Step 6: Use `allTagsFn` in `showSuggestionsFor`**

Find this anchor:

```
      const allTags = allSidecarTags();
```

Replace it with:

```
      const allTags = allTagsFn();
```

- [ ] **Step 7: Pass `tagArrayFn` into `matchAgainstQuery` from `applyFilter`**

Find this anchor:

```
        const hit = matchAgainstQuery(r.file, parsed);
```

Replace it with:

```
        const hit = matchAgainstQuery(r.file, parsed, tagArrayFn);
```

- [ ] **Step 8: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note tab: noteTagArray/allNoteTags helpers + tagSource option on renderRecentTable"
```

---

### Task 6: `renderNoteTab` + Note tab wiring + FileNameModal `.md` support

**Files:**
- Modify: `main.js` (`renderStandaloneLandingPage`: `renderNoteTab` after `renderSearchTab` ~2687, tab wiring ~2849 and ~2864; `FileNameModal` ~4561/4570)

- [ ] **Step 1: Add `renderNoteTab` after `renderSearchTab`**

Find this anchor (the end of `renderSearchTab`):

```
    renderRecentTable(content, allRecent, { showTypeCol: true });
  }
```

Replace it with (same plus `renderNoteTab`):

```
    renderRecentTable(content, allRecent, { showTypeCol: true });
  }

  // Note tab — plain .md notes. Mirrors renderTab but: text templates (not
  // binary blanks), no sidecar (tagSource "self"), opened by Obsidian's
  // native markdown editor, and excludes office sidecars + template files.
  function renderNoteTab() {
    content.empty();
    const dir = templatesRoot + "/notes";

    // --- NEW (note templates) ---
    content.createEl("h2", { text: "New" });
    const grid = content.createEl("div", { cls: "template-grid" });
    const templates = [];
    for (const f of app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(dir + "/") && f.extension === "md") {
        templates.push({ name: f.basename, path: f.path });
      }
    }
    templates.sort((a, b) => {
      if (a.name === "Blank Note") return -1;
      if (b.name === "Blank Note") return 1;
      return a.name.localeCompare(b.name);
    });
    if (templates.length === 0) templates.push({ name: "Blank Note", path: "" });

    for (const tmpl of templates) {
      const card = grid.createEl("div", { cls: "template-card" });
      card.createEl("div", { cls: "icon", text: tmpl.name === "Blank Note" ? "\u{1F5D2}️" : "\u{1F4DD}" });
      card.createEl("div", { cls: "label", text: tmpl.name });
      card.addEventListener("click", () => {
        const modal = new FileNameModal(app, tmpl.name, async (filename) => {
          if (!filename) return;
          if (!filename.endsWith(".md")) filename += ".md";
          if (await app.vault.adapter.exists(filename)) {
            new obsidian.Notice('File "' + filename + '" already exists.');
            return;
          }
          let text;
          if (tmpl.path && await app.vault.adapter.exists(tmpl.path)) {
            text = await app.vault.adapter.read(tmpl.path);
          } else {
            text = BLANK_NOTE_MD;
          }
          // vault.create registers the TFile fully before openFile (mirrors
          // the office createBinary path). The vault create listener then
          // fills created + any missing tags/aliases.
          const tfile = await app.vault.create(filename, text);
          new obsidian.Notice("Created: " + filename);
          const leaf = app.workspace.getLeaf(true);
          await leaf.openFile(tfile);  // .md → Obsidian's native markdown editor
        }, ".md");
        modal.open();
      });
    }

    // --- RECENT (.md, excluding sidecars + templates; own-frontmatter tags) ---
    content.createEl("h2", { text: "Recent" });
    const allRecent = app.vault.getMarkdownFiles()
      .filter((f) => !/\.(docx|pptx|xlsx)\.md$/i.test(f.path) && !f.path.startsWith(templatesRoot + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 100);

    if (allRecent.length === 0) {
      content.createEl("p", { text: "No notes found." });
      return;
    }

    renderRecentTable(content, allRecent, { showTypeCol: false, tagSource: "self" });
  }
```

- [ ] **Step 2: Add the Note tab to the left tab group**

Find this anchor (the end of the `FORMATS` tab-building loop, just before the Search tab):

```
    tabEls[fmt.ext] = tab;
  }
  // Search tab (Phase 7.6) — opposite the format tabs.
```

Replace it with:

```
    tabEls[fmt.ext] = tab;
  }
  // Note tab (2026-05-28) — 4th left tab, plain .md notes.
  const noteTab = tabsLeft.createEl("div", { cls: "tab", text: "Note" });
  noteTab.addEventListener("click", async () => {
    for (const t of Object.values(tabEls)) t.classList.remove("active");
    noteTab.classList.add("active");
    plugin.settings.lastLandingTab = "note";
    await plugin.saveSettings();
    renderNoteTab();
  });
  tabEls["note"] = noteTab;
  // Search tab (Phase 7.6) — opposite the format tabs.
```

- [ ] **Step 3: Handle `"note"` in the initial render**

Find this anchor (the initial-render block at the bottom of `renderStandaloneLandingPage`):

```
  const initialExt = plugin.settings.lastLandingTab || "docx";
  if (initialExt === "search") {
    searchTab.classList.add("active");
    renderSearchTab();
  } else {
    const initialFmt = FORMATS.find((f) => f.ext === initialExt) || FORMATS[0];
    tabEls[initialFmt.ext].classList.add("active");
    renderTab(initialFmt);
  }
```

Replace it with:

```
  const initialExt = plugin.settings.lastLandingTab || "docx";
  if (initialExt === "search") {
    searchTab.classList.add("active");
    renderSearchTab();
  } else if (initialExt === "note") {
    noteTab.classList.add("active");
    renderNoteTab();
  } else {
    const initialFmt = FORMATS.find((f) => f.ext === initialExt) || FORMATS[0];
    tabEls[initialFmt.ext].classList.add("active");
    renderTab(initialFmt);
  }
```

- [ ] **Step 4: Teach `FileNameModal` about `.md` (blank-name map)**

Find this anchor:

```
    const blanks = { ".docx": "Blank Document", ".pptx": "Blank Presentation", ".xlsx": "Blank Spreadsheet" };
```

Replace it with:

```
    const blanks = { ".docx": "Blank Document", ".pptx": "Blank Presentation", ".xlsx": "Blank Spreadsheet", ".md": "Blank Note" };
```

- [ ] **Step 5: Teach `FileNameModal` about `.md` (kind map)**

Find this anchor:

```
    const kind = ({ ".docx": "Document", ".pptx": "Presentation", ".xlsx": "Spreadsheet" })[this.dotExt] || "Document";
```

Replace it with:

```
    const kind = ({ ".docx": "Document", ".pptx": "Presentation", ".xlsx": "Spreadsheet", ".md": "Note" })[this.dotExt] || "Document";
```

- [ ] **Step 6: Syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" add main.js
git -C "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office" commit -m "Note tab: renderNoteTab + tab wiring + FileNameModal .md support"
```

---

### Task 7: Deploy to OB_Testing + manual smoke verification

**Files:**
- Copy: `main.js` → `C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\main.js`

- [ ] **Step 1: Final syntax check**

Run: `node --check main.js`
Expected: no output, exit code 0.

- [ ] **Step 2: Deploy to OB_Testing**

```bash
cp "C:/Users/paulc/GrandpaProjects/Obsidian/P21_OnlyOffice/obsidi-office/main.js" "C:/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/main.js"
```

(No asset-zip rebuild needed — all changes are parent-window `main.js`. The cell/slide engines and dictionaries already shipped in v9.3.2.)

- [ ] **Step 3: Manual smoke test in Obsidian (OB_Testing) — record PASS/FAIL for each**

Reload OB_Testing (Ctrl+R or disable/enable the plugin), then verify:

1. **Templates seeded** — file explorer shows nothing new at the root (templates root stays hidden); confirm `_obsidi-office-templates/notes/Blank Note.md` exists via a search or by temporarily unhiding. Expected: present.
2. **Note tab present** — open the landing page (ribbon icon or `Ctrl/Cmd+P` → "Obsidi-Office: Open landing page"). Tab strip reads `Document · Presentation · Spreadsheet · Note` on the left and `🔍 Search` on the right. Expected: Note is the 4th left tab.
3. **New section** — Note tab shows a `Blank Note` card (plus any other `.md` you drop into `notes/`). Expected: Blank Note card present.
4. **Create from Blank Note** — click the card, the modal title reads "New Note", enter a name, Create. Expected: a new `.md` opens in Obsidian's native editor with `tags`, `aliases` (both empty), and `created` (ISO datetime) in its Properties panel.
5. **Recent table** — lists your real `.md` notes, sorted by Modified, EXCLUDING `*.docx.md/.pptx.md/.xlsx.md` sidecars and anything under the templates root. Tags column shows each note's own tags. Expected: sidecars/templates absent; tag pills reflect note frontmatter.
6. **Recent search** — type a name fragment (filters), type `#` (autocomplete suggests tags found on notes), pick a tag (filters by tag). Expected: name + `#tag` AND-filtering works against note frontmatter.
7. **Native new-note auto-fill** — create a `.md` via Obsidian's own "New note" command (not the Note tab). Expected: within a moment it gains `tags`, `aliases` (empty), `created` (ISO).
8. **Existing-note safety** — open a pre-existing note that had no frontmatter. Expected: it is NOT modified by the reload (the onLayoutReady guard prevents the startup create-burst from rewriting it).
9. **Merge-not-clobber** — if you have a template workflow (Templater/daily note) that writes its own frontmatter, create one. Expected: existing keys/values preserved; only missing ones (`created`/`tags`/`aliases`) added; no duplicate `---` block.
10. **Toggle off** — Settings → Obsidi-Office → turn off "Auto-add frontmatter to new notes". Create a new `.md`. Expected: no frontmatter injected.
11. **Tab persistence** — leave the Note tab active, reopen the landing page. Expected: Note tab is restored as active.
12. **Office tabs regression** — open Document/Presentation/Spreadsheet tabs; create a blank docx; confirm Recent + sidecar tag pills still work. Expected: unchanged behavior.

- [ ] **Step 4: (Optional) iPad smoke** — sync OB_Testing, reload on iPad, repeat checks 2–6. No asset reinstall needed (main.js-only change).

- [ ] **Step 5: Record results** — note any FAILs; fix before declaring complete. If all PASS, the feature is verified.

---

## Self-Review (completed during planning)

- **Spec coverage:** Note tab (Tasks 5–6), template directory + Blank Note seed (Tasks 1–2), Recent table reading own frontmatter (Task 5), vault-wide auto-fill via processFrontMatter + onLayoutReady (Task 3), ISO `created` + empty tags/aliases (Tasks 1, 3), settings toggle (Task 4), tab persistence (Task 6). All spec sections map to a task.
- **Type/name consistency:** `noteTagArray`, `allNoteTags`, `tagArrayFn`, `allTagsFn`, `tagSource`, `renderNoteTab`, `_normalizeNoteFrontmatter`, `autoNoteFrontmatter`, `BLANK_NOTE_MD` are used consistently across tasks.
- **No placeholders:** every code step shows the full replacement text and an exact anchor.
- **Out of scope (per spec):** Search tab stays office-only; no back-fill of existing notes; `_autoCreateSidecar` `docx:`-key quirk untouched.
