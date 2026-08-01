# Container Navigation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Obsidian's back/forward arrows retrace doc-container navigation — container → collection → document → editor — instead of sitting greyed out.

**Architecture:** Two changes, both small. Declare `ContainerOverviewView` and `DocumentDetailView` navigable so their state enters the leaf history, and route navigation into the *active* doc-container leaf so the path forms one linear history in one tab rather than scattering across tabs. Semantics mirror core Obsidian exactly — page identity changes are steps, pane state is not.

**Tech Stack:** Plain JavaScript, no build step. Obsidian workspace/leaf API.

**Spec:** `docs/superpowers/specs/2026-07-31-container-navigation-history-design.md`

**Branch:** `nav-arrows` (off `container-notes`, which holds the smoke fixes b3b3bef and f4355e7)

## Global Constraints

- Plain JS, **no build step**; `main.js` is edited directly.
- **No `lib/doc-container.js` changes in this plan.** Nothing here is pure logic, so `scripts/inline-doc-container.js` is not run and no unit tests are added. Verification is by console probe and drill — stated plainly rather than papered over with a token test.
- `node --check main.js` must pass before every commit.
- `node --test lib/doc-container.test.js` must stay at 76/76 — this plan touches nothing it covers, so any change there means something went wrong.
- Bump `manifest.json` version on every commit that changes behaviour.
- iPad is a hard requirement: no Node or Electron APIs. Everything here is workspace API, available on both platforms.
- Deploy after each task:
  ```powershell
  Copy-Item main.js, manifest.json "C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\" -Force
  ```
  OB_Testing only.
- Do not change the floating **Return to Overview** button. It stays, and it pushes a history entry like a link (spec §3.5).
- Do not add history entries for in-page tab strips, edit-mode toggles, filters or scrolling (spec §3.3).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `main.js` — `DocumentDetailView` (4261) | Document detail page | add `navigation = true` |
| `main.js` — `ContainerOverviewView` (5385) | Container / project / collection page | add `navigation = true` |
| `main.js` — `OnlyObsidianTestPlugin` (~8700) | Navigation helpers | add `_isOurSurface`, `_navLeaf`; rewrite leaf selection in `openDocDetail`, `openContainerOverview`, `openNoteInEditor` |

One file, three regions. No new files, no restructuring.

---

### Task 1: Declare the views navigable, and probe the mechanism

**This task is a decision gate.** Everything after it assumes Obsidian records a history entry for a same-leaf `setViewState` on a custom `ItemView`. That is the documented mechanism but it is unverified here (spec §4). Do not proceed to Task 2 until the probe answers.

**Files:**
- Modify: `main.js` — `DocumentDetailView` class body (4261), `ContainerOverviewView` class body (5385)

**Interfaces:**
- Consumes: nothing
- Produces: `navigation = true` on both view classes — the precondition for every later task

- [ ] **Step 1: Add the flag to `DocumentDetailView`**

Immediately after the class's `getViewType()` / `getDisplayText()` methods, add:

```js
  // Obsidian records leaf history only for views that declare themselves
  // navigable. Without this the back/forward arrows stay greyed out no matter
  // how navigation is routed.
  navigation = true;
```

- [ ] **Step 2: Add the flag to `ContainerOverviewView`**

Same addition in that class body:

```js
  navigation = true;
```

- [ ] **Step 3: Syntax check, deploy**

Run: `node --check main.js`
Expected: no output.

```powershell
Copy-Item main.js, manifest.json "C:\Obsidian\OB_Testing\.obsidian\plugins\obsidi-office\" -Force
```

Reload Obsidian in OB_Testing.

- [ ] **Step 4: Run the probe**

Open a document detail page in the main area. Open the developer console (Ctrl+Shift+I) and run:

```js
const l = app.workspace.getMostRecentLeaf();
console.log('type:', l.view.getViewType(),
            'back:', l.history.backHistory.length,
            'fwd:', l.history.forwardHistory.length);
await l.setViewState({ type: 'obsidi-office-doc-container', active: true,
                       state: { path: 'Documents/Governance' } });
console.log('AFTER back:', l.history.backHistory.length,
            'fwd:', l.history.forwardHistory.length);
```

**Expected if the mechanism works:** `AFTER back:` is one greater than `back:`, and the back arrow in the title bar is now enabled.

- [ ] **Step 5: Decide**

- **`back` incremented →** the mechanism holds. Record the numbers, commit, continue to Task 2.
- **`back` did NOT increment →** STOP. Do not implement Tasks 2–4. Report to Paul with the observed numbers. The only remaining route is pushing onto `leaf.history` directly, which is internal API outside the public typings, and per the spec that is his decision, not an implementation detail. His stated fallback preference is to park the arrows and move to the org-sites v0.1 rung rather than take on internal-API navigation plumbing.
- **`l.history` is undefined →** same STOP and report; it means the history object is not reachable from a plugin at all on this Obsidian version.

- [ ] **Step 6: Commit**

```bash
# manifest.json: version 0.1.30 -> 0.1.31
git add main.js manifest.json
git commit -m "feat(nav): declare container and detail views navigable"
```

---

### Task 2: Route container and detail navigation into the active leaf

**Files:**
- Modify: `main.js` — new helpers on `OnlyObsidianTestPlugin` before `openDocDetail` (8711); `openDocDetail` (8711); `openContainerOverview` (8718)

**Interfaces:**
- Consumes: `navigation = true` (Task 1)
- Produces:
  - `plugin._isOurSurface(leaf) → boolean`
  - `plugin._navLeaf(fallbackTypes) → WorkspaceLeaf` where `fallbackTypes` is an array of view-type strings tried in order before opening a new tab

- [ ] **Step 1: Add the leaf-selection helpers**

Insert directly above `async openDocDetail(node, opts) {`:

```js
  // Leaves this plugin owns. Navigating from one of these stays in the same tab,
  // which is what makes Obsidian's back/forward retrace the path. Anything else
  // — a markdown note, canvas, graph — is not ours to hijack.
  _isOurSurface(leaf) {
    const t = leaf && leaf.view && typeof leaf.view.getViewType === 'function' && leaf.view.getViewType();
    return t === VIEW_TYPE_DOC_CONTAINER || t === VIEW_TYPE_DOC_DETAIL || t === VIEW_TYPE_NOTE
        || t === VIEW_TYPE || t === VIEW_TYPE_PPTX || t === VIEW_TYPE_XLSX || t === VIEW_TYPE_PDF;
  }

  // The leaf a doc-container page should open in: the active main-area leaf when
  // it is already one of ours (so the step joins that tab's history), else the
  // first leaf of each fallback type, else a new tab. getMostRecentLeaf() returns
  // a main-area leaf, never a sidebar one — so a click in the Document Browser
  // tree navigates the main area rather than trying to navigate the tree itself.
  _navLeaf(fallbackTypes) {
    const active = this.app.workspace.getMostRecentLeaf();
    if (active && this._isOurSurface(active)) return active;
    for (const t of (fallbackTypes || [])) {
      const l = this.app.workspace.getLeavesOfType(t)[0];
      if (l) return l;
    }
    return this.app.workspace.getLeaf('tab');
  }
```

- [ ] **Step 2: Rewrite `openDocDetail`**

Replace the whole method with:

```js
  async openDocDetail(node, opts) {
    const leaf = this._navLeaf([VIEW_TYPE_DOC_DETAIL]);
    // Core Obsidian does not stack a second entry when the same link is clicked
    // twice. An explicit edit/fresh intent is not a re-navigation, so it passes.
    const v = leaf.view;
    const samePage = v && typeof v.getViewType === 'function' && v.getViewType() === VIEW_TYPE_DOC_DETAIL
      && v.node && v.node.path === node.path && !(opts && (opts.edit || opts.fresh));
    if (samePage) { this.app.workspace.revealLeaf(leaf); return; }
    await leaf.setViewState({ type: VIEW_TYPE_DOC_DETAIL, active: true, state: { docPath: node.path, edit: !!(opts && opts.edit), fresh: !!(opts && opts.fresh) } });
    this.app.workspace.revealLeaf(leaf);
  }
```

- [ ] **Step 3: Rewrite `openContainerOverview`**

Replace the whole method with:

```js
  async openContainerOverview(node) {
    const leaf = this._navLeaf([VIEW_TYPE_DOC_CONTAINER, VIEW_TYPE_DOC_DETAIL]);
    const path = node ? node.path : this.settings.docRoot;
    const v = leaf.view;
    const samePage = v && typeof v.getViewType === 'function' && v.getViewType() === VIEW_TYPE_DOC_CONTAINER
      && v.path === path;
    if (samePage) { this.app.workspace.revealLeaf(leaf); return; }
    await leaf.setViewState({ type: VIEW_TYPE_DOC_CONTAINER, active: true, state: { path } });
    this.app.workspace.revealLeaf(leaf);
  }
```

- [ ] **Step 4: Syntax check and deploy**

Run: `node --check main.js`
Expected: no output.

Run: `node --test lib/doc-container.test.js`
Expected: 76/76 pass — this task touches nothing they cover.

Deploy and reload.

- [ ] **Step 5: Verify by drill**

1. Sidebar tree → a category → a collection → a document detail, all in one tab.
   Expected: one tab is used throughout; the back arrow becomes enabled; pressing back walks collection → category; forward replays.
2. From a container, Ctrl/Cmd-click a document.
   Expected: a new tab opens; the original tab's history is unchanged (its back arrow still points where it did).
3. Click the same document in the tree twice.
   Expected: one history entry, not two — pressing back once leaves that document.
4. Create a new document (which opens the detail in edit mode).
   Expected: the detail opens in edit mode as before. This is the case the `opts.edit` exemption protects; if it opens in view mode, the exemption is wrong.

- [ ] **Step 6: Commit**

```bash
# manifest.json: version -> 0.1.32
git add main.js manifest.json
git commit -m "feat(nav): navigate container and detail pages in the active leaf"
```

---

### Task 3: Route the note editor into the active leaf

**Files:**
- Modify: `main.js` — `openNoteInEditor` (9184)

**Interfaces:**
- Consumes: `_navLeaf` (Task 2)
- Produces: no new interface — the note editor now joins the same history chain

The existing one-editor-per-note dedup must survive: two tabs open on the same `body.cnote` autosave from divergent buffers and the last writer silently wins. That guard predates this work and is load-bearing.

- [ ] **Step 1: Rewrite the leaf selection**

Replace this block:

```js
    const leaf = this.app.workspace.getLeaf('tab');
```

with:

```js
    const leaf = this._navLeaf([]);   // active doc-container leaf, else a new tab
```

Leave everything else in the method untouched — in particular the `existing` dedup block above it, which returns early when this note is already open somewhere.

- [ ] **Step 2: Syntax check and deploy**

Run: `node --check main.js`
Expected: no output.

Deploy and reload.

- [ ] **Step 3: Verify by drill**

1. From a document detail's Related Documents tab, open a note.
   Expected: the note editor replaces the detail page in that tab; back returns to the detail page.
2. With that note open, navigate elsewhere and open the same note again from the tree.
   Expected: it focuses the already-open note rather than opening a second copy — the dedup still wins over in-place navigation.
3. Open a note, type a line, wait 6 seconds, press back, then forward.
   Expected: the edit is saved and present; no duplicate note editor exists.

- [ ] **Step 4: Commit**

```bash
# manifest.json: version -> 0.1.33
git add main.js manifest.json
git commit -m "feat(nav): open container notes in the active leaf, dedup preserved"
```

---

### Task 4: Full drill against the acceptance criteria, then ship

**Files:**
- Modify: `manifest.json`

**Interfaces:**
- Consumes: Tasks 1–3

- [ ] **Step 1: Walk every acceptance criterion**

From spec §7. Record PASS/FAIL for each:

1. Arrows are live on a container page and on a document detail page reached by navigation.
2. Back retraces container → detail → editor in reverse; forward replays it.
3. In-page tab switches (Files & Versions ↔ Stakeholders, Recent Notes ↔ Log), edit-mode toggles, and workspace tab switches record nothing.
4. Each workspace tab keeps an independent stack.
5. Ctrl/Cmd-click still opens a new tab and leaves the current stack untouched.
6. A restored entry renders in view mode, never edit mode.
7. Back into a deleted container shows the existing "Container not found." state, not an exception.

For 7, create a throwaway container, navigate into it, delete it from the file explorer, then press back. Watch the console for an exception.

- [ ] **Step 2: Check the one interaction this plan could plausibly break**

The office editor's **Return to Overview** button and the editor's `getState`/`setState` restore path were both built around `_returnToDocPath` surviving a restart. Navigation changes touch the same leaves.

1. Open a document in the editor, quit Obsidian entirely, reopen.
   Expected: the editor reopens with the Return to Overview button still present (this was a real bug once — the button vanished after restart when the editor was the last tab).
2. Press Return to Overview.
   Expected: lands on the detail page, and back returns to the editor.

- [ ] **Step 3: Run the full check**

Run: `node --check main.js` — expect no output.
Run: `node --test lib/doc-container.test.js` — expect 76/76.

- [ ] **Step 4: Bump, deploy, commit**

```bash
# manifest.json: version -> 0.1.34
git add main.js manifest.json
git commit -m "feat(nav): container navigation history — drilled and shipped"
```

- [ ] **Step 5: Hand back**

Report to Paul: the probe result from Task 1, each acceptance criterion's outcome, and the restart check. Name the iPad items still outstanding — mobile Obsidian surfaces back/forward differently from the desktop title bar, so the bar there is "navigation must not regress and Return to Overview must still work", with working arrows a bonus (spec §6).

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 Declare views navigable | Task 1 |
| §3.2 Navigate in place, and the definition of a doc-container surface | Task 2 (`_isOurSurface`, `_navLeaf`), Task 3 (note editor) |
| §3.3 What counts as a history step | Task 2 and 3 implement the "yes" rows; the "no" rows are satisfied by not touching pane state, and are verified in Task 4 step 1 item 3 |
| §3.4 No duplicate entry; restored entry in view mode | Task 2 (`samePage` guard); view mode holds because `getState` emits only the path — verified Task 4 step 1 item 6 |
| §3.5 Return to Overview unchanged | No task modifies it; Task 4 step 2 verifies it still works |
| §4 Probe and decision gate | Task 1 steps 4–5 |
| §6 Testing | Tasks 2, 3 drills; Task 4 full pass |
| §7 Acceptance criteria | Task 4 step 1 |

No gaps.

**Placeholder scan:** none. Every step carries the code or the exact command with its expected output.

**Type consistency:**
- `_isOurSurface(leaf)` and `_navLeaf(fallbackTypes)` are defined in Task 2 and used in Tasks 2 and 3 with those exact names and shapes.
- `_navLeaf` takes an array in all three call sites: `[VIEW_TYPE_DOC_DETAIL]`, `[VIEW_TYPE_DOC_CONTAINER, VIEW_TYPE_DOC_DETAIL]`, `[]`.
- The `samePage` check reads `v.node.path` for the detail view and `v.path` for the container view. These differ deliberately: `DocumentDetailView` stores a `node` object (`getState()` returns `{ docPath: this.node.path }`) while `ContainerOverviewView` stores a bare `this.path` (`getState()` returns `{ path: this.path }`). Do not "harmonise" them.
- View-type constants used: `VIEW_TYPE_DOC_CONTAINER`, `VIEW_TYPE_DOC_DETAIL`, `VIEW_TYPE_NOTE`, `VIEW_TYPE`, `VIEW_TYPE_PPTX`, `VIEW_TYPE_XLSX`, `VIEW_TYPE_PDF` — all declared at `main.js:695-702`.

**Known limitation, stated rather than hidden:** there are no automated tests in this plan. The changed code is entirely Obsidian workspace API with no pure logic to extract, and this repo has no runtime test harness. Verification rests on the Task 1 probe and the drills. That is a real weakness of this plan, not an oversight.
