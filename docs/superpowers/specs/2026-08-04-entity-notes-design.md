# Entity notes — Recent Notes, Search Notes and Log on Organization and Site records — design

Date: 2026-08-04
Branch: `org-sites`
Status: design approved in conversation (Paul, 2026-08-04); not yet planned or built
Builds on: `2026-07-31-organization-site-design.md` (the Site and Organization records)

## 1. Purpose

An Organization or Site record can be edited, and it rolls up the sites, work and note pages
that reference it. What it cannot do is hold a thought.

There is no way to write down "spoke to their facilities lead, they will confirm Monday" against
the organization it concerns. Every other container in this plugin has that affordance — the
document detail page and the project container both carry a quick-note composer — and the entity
pages were built without one.

The second gap is narrower but more useful. Activity against an organization is scattered: a note
on one of its sites, a note on a policy attributed to it, a note page filed under it. Nothing shows
that activity in one place, so answering "what has been happening with this vendor" means opening
each related record in turn.

This adds the composer, and a single feed that answers the second question.

## 2. Scope

**In:**

- A quick-note composer on Organization and Site pages, behaviourally identical to the project
  container's (§4).
- Three tabs on the entity page: **Recent Notes**, **Search Notes**, and **Log** (pinned right).
- A merged Recent Notes feed carrying both quick-note entries and note pages, each row stamped with
  where it came from (§5).
- An entity-level `log.md`, written through the existing `appendLog`.

**Out — and why:**

| Excluded | Reason |
|---|---|
| Editing or deleting an existing note entry | Neither the document nor the project pane allows it. Adding it here alone would make entity notes the odd one out, and an append-only log is the safer default for a record of correspondence |
| Notes on Agreements and Contacts | Both are placeholders that render "not built yet". Nothing to attach to |
| Cross-vault note search | Search Notes searches this record's feed, matching the document pane's scope |
| Reassigning a note to a different record | A lifecycle concern, belongs with the v0.2 rename/archive/reassign rung |

## 3. Decisions taken (Paul, 2026-08-04)

1. **The existing "Notes" tab is absorbed, not kept alongside.** It currently lists note *pages*
   found by backlink. Those become rows in the Recent Notes feed, and the separate tab is removed.
   Rejected alternative: keep both and rename the old one "Note Pages" — clearer as objects, but it
   preserves the two-places-to-look problem this feature exists to fix.
2. **An Organization's feed reaches its own notes, its sites' notes, and notes on work attributed
   to it.** A Site's feed reaches its own notes and work attributed to that site. Rejected
   alternatives: sites-only (misses correspondence, which usually attaches to documents) and
   direct-backlinks-only (a note on a document belonging to a site under this org would vanish).

## 4. The composer

Lifted from `_projNotesPane`, not reinvented. Same behaviour, same classes, same idioms:

- A single-line input, placeholder `Add a note…  (type #tag to add a tag)`, and an **Add note**
  button. Enter submits.
- Inline `#tag` extraction as the user types (`extractInlineTags`), staged as removable green chips
  separate from the record's own tags.
- A drop zone, disabled until there is note text, reading `Enter note text first to attach files`.
  Attachments are written to `<entityFolder>/_notes/`, with a timestamp prefix on collision.
- An entry is appended to `noteLog` on the entity's folder note.

A note with only tags or only attachments is allowed, and stores the body `(tag / attachment only)`
— same as the project pane. The hint line beneath states that note tags and attachments are scoped
to the note, separate from the record's tags.

## 5. The feed

### 5.1 Sources

For an Organization, in this order of discovery:

| Source | Where the entries come from | Origin kind |
|---|---|---|
| The record itself | `noteLog` on its own folder note | `self` |
| Each site under it | `noteLog` on each site's folder note | `site` |
| Work attributed to it | `noteLog` on each document's `_document.md` / project's `_project.md` | `work` |
| Note pages | one row per note page from `entityReferences().notes` | `page` |

For a Site: the same, minus the sites row — its own notes, work attributed to that site, and its
note pages.

Sites and work are already discovered by `entityReferences()`. This spec adds no new traversal;
it reads `noteLog` from records that function already returns.

### 5.2 Provenance

Every row is labelled with where it came from. A row from the record's own log reads **This
organization** / **This site**; every other row names its source record — `Terraces`, `Fan-Out
Policy`. The label is the row's own affordance: clicking a row with a source opens that record.

Without the label the feed is worse than useless — a note saying "confirmed Monday" means nothing
if you cannot see which site it was about.

### 5.3 Ordering and size

Newest first, by entry date. Ties broken by source name so ordering is stable between repaints
rather than depending on traversal order.

**Capped at 50 rows**, with a hint reading `Showing 50 of N` when the cap bites. This is an
assumption, not Paul's instruction: a feed reaching an organization's sites and all its attributed
work has no natural bound, and an unbounded list would degrade the page on the largest records.
Revisit if 50 proves wrong in use.

## 6. The Log tab

Reads `log.md` from the entity folder via `parseLogBody`, rendered by the same idiom as
`_projLogPane`. Pinned to the right of the tab bar, and carries no count — entries live in the
markdown body and are read asynchronously, so a count would either be wrong or force a blocking
read, which is why neither the document nor the project tab carries one.

Entity actions write to it through the existing `appendLog(path, action, detail)`. At minimum:
record created, metadata edited, note added.

## 7. Structure

**Pure, in `lib/doc-container.js`** — unit-tested, no Obsidian, no I/O:

- `mergeNoteFeed(sources)` → flat array, newest first, each row carrying `{origin, originKind,
  originPath, date, author, body, noteTags, attachments}`. Takes
  `[{origin, originKind, originPath, entries}]`. The whole ordering, stamping and cap-free merge
  lives here so it can be tested without a vault.
- `filterNoteFeed(rows, {text, tag, from, to})` → filtered array. Powers Search Notes, and is the
  same shape the document pane's search uses.

**Runtime, in `main.js`:**

- `writeEntityNote(folderPath, mutator)` — the single write path for entity frontmatter, mirroring
  `writeProjectNote`. All `noteLog` appends go through it.
- `_entRecentNotesPane`, `_entSearchNotesPane`, `_entLogPane` on the overview view.
- `_entTabs` gains the three specs and loses the `enotes` spec.

## 8. Invariants this must not violate

These are established failure classes in this codebase, not hypotheticals:

- **Optimistic render.** After any `processFrontMatter` write, `metadataCache` is stale until the
  re-parse `changed` event. The pane must repaint the new entry from an override, exactly as
  `_projNotesPane` does when `_projEditMode` suppresses the listener repaint. This bug class has
  recurred at least three times.
- **Two async indexes.** Frontmatter (`getFileCache().frontmatter`) and the link graph
  (`resolvedLinks`) populate on separate passes. The feed reads frontmatter for entries but relies
  on `entityReferences()`, which is backlink-driven. A newly created site will not appear in the
  feed until `on('resolve')` fires, not merely `on('changed')`.
- **Guard flags self-heal.** The composer-dirty flag that suppresses repaint needs a guaranteed
  clear path. `_composerDirty` once froze a view for a day of drilling.
- **Live-derive writes.** Inside the `processFrontMatter` callback, derive `noteLog` from the
  callback's current `fm` value — never assign a render-time snapshot, or a stale pane silently
  drops entries another surface added.

## 9. Testing

**Pure (`node --test lib/doc-container.test.js`):**

- `mergeNoteFeed`: newest-first ordering across sources; stable tie-break; origin stamped on every
  row; empty sources yield `[]`; a source with no `noteLog` is skipped rather than throwing.
- `filterNoteFeed`: text match is case-insensitive and matches the body; tag match is exact;
  date range is inclusive at both ends; combined filters intersect.
- Malformed entries (missing date, `noteLog` not an array) never throw.

**Manual (desktop, then iPad):**

- Add a note on an Organization; it appears immediately, labelled as this organization.
- A note added on one of its sites appears in the organization's feed, labelled with the site name,
  and clicking the row opens that site.
- The same note does NOT appear on an unrelated organization.
- Search by text, by tag, and by date range narrows the feed.
- The Log tab shows record-created and note-added entries.
- A record with no notes anywhere shows the empty state, not a broken pane.

## 10. Acceptance criteria

1. Organization and Site pages carry Recent Notes, Search Notes and Log tabs; the separate Notes
   tab is gone.
2. The composer writes a structured entry to `noteLog` on the entity's folder note, with inline
   tags extracted and attachments in `_notes/`.
3. Every feed row states its origin, and rows from another record open that record.
4. An Organization's feed includes notes from its sites and from work attributed to it; a Site's
   includes notes from work attributed to it.
5. Note pages appear as rows in the feed.
6. The feed is newest-first and stable across repaints.
7. A newly added note is visible without reloading the vault.
8. Search filters by text, tag and date range over the same feed.
9. The Log tab reads `log.md` from the entity folder.
10. No pure-core function touches Obsidian or the network; `mergeNoteFeed` and `filterNoteFeed` are
    covered by tests.
