# PDF Editor — Left-rail enhancements (OnlyOffice parity)

**Date:** 2026-06-03
**Status:** Design — reference images supplied by user 2026-06-03 (OnlyOffice PDF-editor left rail). Two open decisions flagged in §6, to be resolved as plan probe-tasks.
**Builds on:** left rail shipped 2026-06-02 (`fdbaae4`) — rail + 3 panels (thumbnails/search/comments). This brings those panels to OnlyOffice parity and adds a Headings panel.
**Sibling spec:** `2026-06-03-pdf-editor-edit-text-design.md` (independent feature; same plan, different phase).

---

## 1. Goal

Bring the left-rail panels to OnlyOffice PDF-editor parity:
- **Thumbnails:** panel-header settings popover (size slider + "highlight visible part of page").
- **Headings:** new 4th rail panel listing the document outline; click-to-navigate.
- **Comments:** richer per-comment styling (author avatar) + actions (edit / delete / resolve / reply) and a panel-header **Add Comment** + **sort/filter** popover.

All work is inside the `pdf-editor` Preact bundle; no `main.js` change. Reuses already-registered EmbedPDF plugins where possible; adds the bookmark read path for Headings.

## 2. Verified engine/plugin hooks

- **Headings:** `engine.getBookmarks(doc) → PdfBookmarksObject { bookmarks: PdfBookmarkObject[] (nested children) }`. Navigate on click to the bookmark target (page/dest). `setBookmarks` exists but is out of scope (read-only panel in v1).
- **Comments replies/state:** annotation base carries `inReplyToId` + `replyType` (`PdfAnnotationReplyType.R` = comment reply) → threads; `stateModel` + state for review status. Edit/delete/create via the annotation plugin's `updateAnnotation` / `deleteAnnotation` / `createAnnotation` (already used).
- **Thumbnail config:** `ThumbnailPluginConfig { width?, gap?, labelHeight? }` (registration-time). Runtime resize mechanism is decision §6.2.

## 3. Thumbnails panel — settings popover

- Panel header gains a right-aligned **settings icon** (sliders glyph, `btn-menu-settings`-style) + caret; clicking opens a small popover anchored under it (matches reference image).
- Popover contents:
  - **"Thumbnails size"** — a slider between a small-page icon and a large-page icon. Drives the rendered thumbnail width; persisted (per-plugin setting). Discrete stops (e.g. 90 / 120 / 160 / 220 px).
  - **"Highlight visible part of page"** — toggle (default on). When on, the **active** thumbnail overlays a translucent rect showing the current viewport's visible fraction, computed from scroll position + zoom + page size.
- Closing: click-away / Esc / re-click the settings icon.

## 4. Headings panel (new rail item)

- New rail icon (`btn-menu-navigation`/headings glyph) inserted into the rail order (Headings between Search and Thumbnails, matching reference). `RailId` gains `'headings'`.
- On open: `getBookmarks(doc)` → render the bookmark tree (indented by depth; expand/collapse for nodes with children). Click a heading → navigate to its destination page (via scroll plugin).
- **Empty state:** the exact OnlyOffice copy — *"There are no headings in the document."*
- Panel header may carry the same settings-icon affordance as Thumbnails (e.g. an optional "wrap long headings" toggle); v1 ships the panel + empty state + navigation, header settings optional/deferred if it adds no value.

## 5. Comments panel — styling + actions + header controls

**Per-comment item (restyle):**
- **Author avatar** — a colored circle with the author's initial (color derived deterministically from the author string); author name bold beside it.
- Existing meta (page, relative time) + body retained, restyled to match.
- **Row actions** (hover/selected): **edit** (pencil → inline-edit `contents` via `updateAnnotation`), **delete** (trash → `deleteAnnotation`, confirm), **resolve** (check → mark resolved, see §6.1).
- **"Add reply"** affordance under each comment → creates a child annotation with `inReplyToId = parent.id`, `replyType = R`; replies render threaded (indented) under the parent.

**Panel header controls:**
- **Add Comment** button (chat-plus glyph) — creates a new comment (anchoring decision §6.3) and opens it for text entry.
- **Sort/filter** button (`…` / overflow) → popover:
  - **Sort:** Newest (default) / Oldest / Author A→Z / Author Z→A.
  - **"Show comments"** submenu: **All** / **Resolved** / **Open** — filters the list.

## 6. Open decisions (resolve as plan probe-tasks, before building the dependent UI)

1. **"Resolved" persistence.** Options: (a) PDF-standard **state-reply** annotation (a child Text annot with `stateModel` + state "Completed") — portable, round-trips through other PDF tools; (b) an EmbedPDF-side flag (`custom.resolved`) — simplest, but verify it survives `saveAsCopy`/reopen. Probe both; prefer (a) if EmbedPDF can create/read a state-reply, else (b) with a documented portability caveat.
2. **Thumbnail runtime resize.** Probe whether the thumbnail plugin can be reconfigured at runtime (config update / re-register) vs. our-side display scaling of the rendered `ThumbImg`. Pick the one that resizes cleanly without full remount flicker.
3. **"Add Comment" anchor.** Options: (a) create a sticky-note **Text** annotation at a default page position the user then drags; (b) require a prior text/region selection to anchor to; (c) a non-anchored page-level comment. v1 recommendation: (a) — a Text annotation placed at top-left of the current page, immediately in edit mode, movable. Confirm with user if (b) is preferred.

## 7. Non-goals (v1)

- Editing/authoring the document outline (Headings is read + navigate only).
- Rich text in comments (plain `contents`).
- Cross-device author identity (author = the editor's configured author string, as today).
- @-mentions, comment notifications.

## 8. Platform

Desktop + iPad. All APIs are the supported EmbedPDF set already in the bundle plus `getBookmarks`. Touch: rail icons and popovers must meet the touch-target minimum; comment row actions need a touch-reachable affordance (not hover-only) on iPad.

## 9. Risks

- **Bookmark coverage** — many PDFs (incl. scans, simple exports) have no outline → the empty state is the common case, not an error. Headings is most useful for Word/LibreOffice exports with heading styles.
- **Resolved-state portability** (§6.1).
- **Thumbnail resize flicker** (§6.2) — windowed render-prop list must recompute cleanly on size change.
- **Touch affordances** for per-comment actions — hover-only would be unusable on iPad (§8).
