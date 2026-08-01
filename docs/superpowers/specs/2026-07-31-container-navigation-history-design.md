# Container navigation history — design

Date: 2026-07-31
Branch: `container-notes`
Status: design approved in conversation; not yet planned or built

## 1. Purpose

Obsidian's back/forward arrows are permanently greyed out while browsing doc-container pages.
Browsing Documents → Projects → Accreditation 2026 → a document leaves no trail: the only way back
is the sidebar tree or the floating Return to Overview button. This makes the arrows retrace
container navigation, matching how core Obsidian behaves for links.

## 2. Why they are inert today

Two independent causes. Fixing either alone leaves the arrows working only sometimes.

1. **The views never enter the history stack.** Obsidian records history per leaf, and only for
   views that declare `navigation = true`. `ContainerOverviewView` and `DocumentDetailView` both
   extend `ItemView` and neither declares it. (`OfficeEditorView` and `ContainerNoteView` extend
   `FileView`, which sets it — which is why arrows behave on file views and not on ours.)
2. **Navigation frequently lands in a different tab.** `openDocDetail` reuses the first existing
   detail leaf, else opens a new tab; `openContainerOverview` prefers a container leaf, else a
   detail leaf, else a new tab. Arriving at a document therefore often means arriving in a tab whose
   history is empty — so the arrows are grey even once cause 1 is fixed.

## 3. Design

**Governing principle: mirror core Obsidian.** No invented semantics. A doc-container page behaves
like a note opened from a link.

### 3.1 Declare the views navigable

`navigation = true` on `ContainerOverviewView` and `DocumentDetailView`. Their existing
`getState`/`setState` already round-trip everything a restored entry needs — `{ path }` and
`{ docPath }` — so no new state plumbing is required.

### 3.2 Navigate in place

The open helpers change from "find a leaf of the right type" to "if the active leaf is already a
doc-container surface, navigate that leaf; otherwise fall back to the current lookup". Container →
collection → document → editor then happen in one tab, and each step is a history entry.

"Doc-container surface" means a leaf whose view type is one of `VIEW_TYPE_DOC_CONTAINER`,
`VIEW_TYPE_DOC_DETAIL`, `VIEW_TYPE_NOTE`, or an office editor view (`VIEW_TYPE`, `VIEW_TYPE_PPTX`,
`VIEW_TYPE_XLSX`, `VIEW_TYPE_PDF`). Anything else — a markdown note, a graph, a canvas — is not ours
to hijack, and navigation from there uses the existing lookup and may open a new tab.

Ctrl/Cmd-click and middle-click keep their current meaning: open in a new tab, adding nothing to the
current tab's stack.

### 3.3 What counts as a history step

| Step | Records history |
|---|---|
| Container → another container | Yes |
| Container → document detail | Yes |
| Detail → a different document | Yes |
| Detail → editor (office or note) | Yes |
| Opening any page from the sidebar tree | Yes |
| Switching the in-page tab strip (Files & Versions ↔ Stakeholders, Recent Notes ↔ Log) | No |
| Entering or leaving edit mode | No |
| Filter typing, scrolling, expanding the metadata card | No |
| Switching workspace tabs | No — each tab keeps its own stack, as core does |

Rationale for the in-page tab strip: core Obsidian records no history entry for switching workspace
tabs, so pane state within a single page certainly should not.

### 3.4 Two rules taken from core behaviour

- **Re-navigating to the current page is a no-op**, not a duplicate entry. Core does not stack a
  second entry when the same link is clicked twice.
- **A restored entry lands in view mode, never edit mode.** `getState` emits only the path, so
  pressing back can never resurrect an interrupted metadata edit. Back returns you to a place, not
  to an unsaved form.

### 3.5 Return to Overview

Stays, and behaves like a link: it navigates and pushes an entry rather than acting as a hidden back
button. This keeps the button and the arrows from disagreeing about where you are. It also remains
the primary route on iPad, where the arrows are small or absent depending on layout.

## 4. The one unverified assumption

`navigation = true` is the documented mechanism, but it is not confirmed that Obsidian records a
history entry for a **same-leaf `setViewState`** on a custom `ItemView`, as opposed to only on file
opens. This is the first implementation step, not an assumption to build on:

**Probe.** With a doc-container page open, navigate container → detail in one tab, then inspect the
active leaf's history state in the console and confirm an entry was added.

**If the probe passes:** the design above is complete and no further mechanism is needed.

**If the probe fails:** the fallback is pushing entries onto `leaf.history` directly. That works but
relies on internal API outside the public typings, which this plugin has used before (the mock
socket, the asset patcher) but never without saying so. **Decision gate: report to Paul before
taking the fallback** — the trade-off is his to accept, and an alternative is to leave the arrows
alone and keep Return to Overview as the only route.

## 5. Files touched

| File | Change |
|---|---|
| `main.js` — `ContainerOverviewView` (5385) | `navigation = true` |
| `main.js` — `DocumentDetailView` (4261) | `navigation = true` |
| `main.js` — `openContainerOverview` (8694) | prefer the active doc-container leaf |
| `main.js` — `openDocDetail` (8687) | prefer the active doc-container leaf; no-op when already on that page |
| `main.js` — `openNoteInEditor` (9160) | prefer the active doc-container leaf, preserving the existing one-editor-per-note dedup |

No pure-core changes. No new files.

## 6. Testing

**Desktop drill**

1. Tree → container → sub-container → document detail. Back retraces each step; forward replays it.
2. Detail → editor → back returns to the detail page.
3. Switch in-page tabs and toggle edit mode; confirm neither adds an entry.
4. Open a second workspace tab; confirm its history is independent and switching tabs adds nothing.
5. Ctrl/Cmd-click a document; confirm a new tab opens and the original tab's stack is unchanged.
6. Press back into a page whose folder was deleted meanwhile; confirm a "not found" state rather
   than a thrown error.
7. Click the same document twice; confirm one entry, not two.

**iPad pass**

Rides the next mobile session. Mobile Obsidian surfaces back/forward differently from the desktop
title bar, so the acceptance bar on iPad is narrower: navigation must not regress and Return to
Overview must still work. Working arrows on mobile are a bonus, not a requirement.

## 7. Acceptance criteria

1. The arrows are live on a container page and a document detail page reached by navigation.
2. Back retraces container → detail → editor in reverse; forward replays it.
3. In-page tab switches, edit-mode toggles and workspace tab switches record nothing.
4. Each workspace tab keeps an independent stack.
5. Ctrl/Cmd-click still opens a new tab and leaves the current stack untouched.
6. A restored entry renders in view mode.
7. Back into a deleted container shows the existing "Container not found." state, not an exception.

## 8. Out of scope

- A custom in-page breadcrumb history or dropdown. The breadcrumb line stays display-only.
- Cross-tab or session-persistent history beyond what Obsidian already persists per leaf.
- Changing how the sidebar tree itself is navigated.
