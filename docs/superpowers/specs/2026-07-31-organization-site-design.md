# Organizations & Sites — design

Date: 2026-07-31
Branch: `org-sites` (off `container-notes`)
Status: design approved in conversation; not yet planned or built

## 1. Purpose

Documents, projects, SOPs and notes currently say what they are and who wrote them, but not
**whose** they are or **where** they apply. This adds two dimensions — Organization and Site —
and gives each one a page that is both its record and a dashboard of everything attributed to it.

The dimensions are deliberately different in kind:

- **Organization** — the party the work belongs to or concerns. Both internal (Baycrest and any
  affiliates) and external (vendors, contractors, agencies, regulators, unions, community partners).
- **Site** — a physical location. Every site belongs to exactly one organization.

## 2. Scope

**In scope**

- `organization` and `sites` metadata on documents, projects and container notes.
- Two new container types, `organization` and `site`, each with a record and a dashboard view.
- `Organizations/` and `Sites/` categories under the document root.
- Rollups of stamped work, notes and sites onto the entity pages.
- Archive → reassign → export → delete lifecycle for entities.
- A one-time backfill stamping existing items with a default organization.

**Out of scope (named successors, not omissions)**

- **Contacts** — a later folder/section. This spec renders a placeholder only.
- **Agreements & Procurements** — a later folder/section allowing contract, quote and invoice
  upload and tracking through the organization page. This spec renders a placeholder tab only.
- A general bulk re-stamp tool. Reassignment during archive is the only bulk write in v1.
- Bulk site attribution. Sites are stamped item by item.
- Encryption. Entity records are plaintext like all other metadata; see §12.

### 2.1 Release ladder

This is more than one sitting's work, and the doc-container rungs proved the value of shipping a
spine before depth. Three rungs, each independently useful and independently drillable:

| Rung | Contents | Ship gate |
|---|---|---|
| **v0.1 — records and attribution** | Entity types, records, taxonomy detection, the two categories, the stamp on documents/projects/notes, entity page with metadata card + Sites/Work/Notes tabs + both placeholders, `＋ New site`, `＋ New organizational note`, creation guards | Create an organization and a site, stamp real work, see it roll up |
| **v0.2 — lifecycle** | Rename pipeline, archive with reassignment, `organizationHistory`, archive folders | Archive a real organization and reassign its work |
| **v0.3 — export, delete, backfill** | Zip export, delete gate, default-organization backfill with dry-run | Backfill the existing vault; export and delete an archived entity |

## 3. Settled decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Organizations include internal and external parties in one folder | One vocabulary; a project can name Baycrest or a vendor without a second mechanism |
| D2 | One organization per item, many sites per item | The organization answers "whose work is this"; sites are genuinely plural for campus-spanning work |
| D3 | References are **quoted wikilinks** to the entity's folder note | Native graph edges, native backlinks, and Obsidian rewrites links on rename. Same form the note skeleton already uses for `links:` |
| D4 | The folder note is named after the entity (`Baycrest/Baycrest.md`), not `_org.md` | Links read `[[Baycrest]]`; the graph labels the node with the entity name rather than a path |
| D5 | Entity folders hold **no documents** — organizational notes are the one exception (§7.3) | Organizations and sites are records, not filing cabinets. A note is not a document; the document-storage need is what Agreements answers later |
| D6 | Creation inside an entity is limited: an organization may create **sites** and **organizational notes**; a site may create nothing | Keeps the entity page a record and a dashboard, not an entry point into the document taxonomy |
| D7 | Items are **pre-filled** from their container at creation, not **inherited** at read time | Every item answers for itself; the rollup stays a flat lookup; moving a document never silently changes its attribution |
| D8 | Only the metadata stamp counts as a reference | A `[[Baycrest]]` typed into a note body is surfaced as a `mention` in the Notes tab and never appears in Work |
| D9 | Rename, archive, export and delete exist only on the entity's own page | One pipeline, one order of operations, no half-renamed state |
| D10 | Archive precedes delete; delete is gated behind an export prompt | History survives; unresolved links are resolved deliberately rather than left behind |

## 4. Data model

### 4.1 Organization record

`Documents/Organizations/Baycrest/Baycrest.md`

```yaml
---
type: organization
name: Baycrest
orgType: Internal          # Internal | Health System Partner | Vendor | Contractor |
                           # Agency | Regulator | Union | Community Partner | Other
status: Active             # Active | Prospective | Inactive | Archived
relationship: Our own organization
website: https://www.baycrest.org
address: 3560 Bathurst Street, Toronto ON
summary: |
  Free-text description of who they are and what they do for us.
tags: [internal]
---
```

No `phone` field. Phone numbers are captured in Contacts when that lands.

### 4.2 Site record

`Documents/Sites/Apotex Centre/Apotex Centre.md`

```yaml
---
type: site
name: Apotex Centre
organization: "[[Baycrest]]"
siteType: Long-Term Care   # Hospital | Long-Term Care | Residential | Clinic |
                           # Office | Campus Building | Parking | External
siteCode: APO
address: 3560 Bathurst Street
city: Toronto
province: ON
postalCode: M6A 2E1
status: Active             # Active | Planned | Closed | Archived
summary: 472-bed long-term care home.
tags: []
---
```

### 4.3 The stamp

Two keys, identical on every item type:

```yaml
organization: "[[Baycrest]]"
sites:
  - "[[Apotex Centre]]"
  - "[[Terraces]]"
```

| Item type | File that carries the stamp |
|---|---|
| Document | `_document.md` where present, else the current version's sidecar (the existing read-fallback; no migration required first) |
| Project | `_project.md` |
| Container note | the note's machine skeleton `_document.md`, on its human-owned side beside `noteType`, `noteDate` and `summary` |

`organization` and `sites` join `DOC_LEVEL_KEYS` so the `_document.md` migration treats them as
document-level facts rather than version facts.

The note skeleton writer must **preserve** both keys. It owns `title`, `tags` and `links` only;
`organization` and `sites` are human-owned like `summary`. They are not copied into `links[]` —
a quoted wikilink in frontmatter is already indexed, and duplicating it would double every edge.

### 4.4 Reassignment history

When an item's organization changes during an archive reassignment, the item gains:

```yaml
organizationHistory:
  - from: "[[Baycrest]]"
    to: "[[3D Network Company]]"
    date: 2026-07-31
    actor: paul
```

Append-only, and it travels with the item. Documents and projects additionally get a `log.md`
line through the existing `_appendActivity` path. The frontmatter list is the record; the log is
the human-facing feed.

## 5. Storage layout

```
Documents/
  Organizations/
    Baycrest/
      Baycrest.md
      Vendor performance 2026/        ← organizational note (folder + body.cnote + skeleton)
        body.cnote
        _document.md
    3D Network Company/
      3D Network Company.md
    Archive/
      Dissolved Vendor Inc/
        Dissolved Vendor Inc.md
        <export zip lands here>
  Sites/
    Apotex Centre/
      Apotex Centre.md
    Terraces/
      Terraces.md
    Archive/
```

Archiving moves the folder under `Archive/`. Because Obsidian resolves a wikilink by basename
regardless of path, **archiving breaks no references** — every stamped item still points at the
same record. Archiving is a filing decision, not a link event.

## 6. Taxonomy and container-type integration

### 6.1 Pure-core changes (`lib/doc-container.js`)

1. `ENTITY_TYPES = ['organization', 'site']` plus the field schemas `ORG_FIELDS` and `SITE_FIELDS`,
   declared the same way `DOC_FIELDS` is, so the view renders them generically.
2. **Entity leaf detection.** `buildTaxonomy` gains a fourth leaf kind. A folder is an entity when
   it contains a markdown file whose basename equals the folder name and whose frontmatter `type`
   is an entity type. Frontmatter is not available inside the pure core, so `buildTaxonomy` takes an
   optional `entityFolders` set (folder path → entity type) resolved by the caller from
   `metadataCache`, mirroring how the runtime already resolves container type. Detection itself
   stays pure and testable.
3. **Kind override.** A folder can be both an entity and the parent of note folders. The existing
   rule that an intermediate path segment becomes a `collection` must not overwrite an entity kind.
   Entity kind wins.
4. `classifyEntityBacklink(sourcePath, taxonomyIndex)` → `document | project | note | site | other`,
   plus the owning folder path. Pure; drives which tab a rollup row lands in.
5. `planDefaultOrgStamp(items, orgLink)` → the list of items to stamp and the reason each was
   skipped. Pure, so the dry-run report and the apply step cannot drift — the same discipline as
   `planReconcile`.

### 6.2 Runtime

`resolveContainerType` already reads a folder note's `type:` before consulting
`docCategoryTypeMap`, so it needs only to learn the new folder-note filename convention
(`<folderName>.md` in addition to `_project.md`). Category defaults are added to the map:
`{ Organizations: 'organization', Sites: 'site' }`.

`ContainerOverviewView.render` gains one branch: entity types route to `renderEntityView(c, node, type)`,
shared by both, differing by field schema and which tabs are present.

## 7. Views

### 7.1 Organization page

Header: name, org-type chip, status chip, `Edit` (inline view/edit toggle, the pattern the project
view already uses). Then the metadata card — Identification / Contact / Description. Then one tab strip:

| Tab | Content | Actions |
|---|---|---|
| **Sites** | Sites whose `organization` points here: code, type, city, status; click opens the site page | `＋ New site` |
| **Work** | Projects and documents stamped to this organization, grouped by home container, with class, status, next-review and an overdue count | none |
| **Notes** | Consolidated notes (see §7.3) | `＋ New organizational note` |
| **Agreements & Procurements** | Placeholder: red sample rows (contract, quote, invoice, expiry, value, owner) over a note that upload-and-track arrives with the Agreements work | none |
| **Contacts** | Placeholder: red sample people rows over a note that Contacts becomes a real folder later | none |

### 7.2 Site page

Same header and metadata card. Tabs: **Work**, **Notes**, **Contacts** (placeholder). No Sites tab,
no Agreements tab, and no creation action of any kind.

The site's Work and Notes tabs match on the `sites` list rather than `organization` — an item
appears on a site page when that site is among its sites, regardless of which organization owns it.

### 7.3 The Notes tab

One pane, three row types, newest first:

| Row type | Meaning |
|---|---|
| `organizational` | A note living inside the entity folder — the entity's own note, not tied to one document |
| `stamped` | A note elsewhere whose `organization`/`sites` names this entity; the row shows its parent document |
| `mention` | A note whose **body** contains a `[[Baycrest]]` link but which carries no stamp |

Nothing is copied. Every row opens the note where it already lives.

### 7.4 Placeholder treatment

Placeholder tabs render sample rows in red plaintext with an explicit "sample — not real data"
label, so a screenshot can never be mistaken for live content.

## 8. Creation rules and guards

- `＋ New site` (organization page only) opens a modal — name, site type, optional address — and
  writes `Documents/Sites/<Name>/<Name>.md` with `organization` already stamped. The site appears in
  the organization's Sites tab and in the Sites category of the browser tree. Created here, stored there.
- `＋ New organizational note` creates a note folder **inside** the organization folder, stamped
  with `organization` and carrying no `relatedParents`.
- Document creation is **refused**, not merely hidden. `createDocumentInContainer`,
  `createPendingDocument` and `createNoteContainer` (except the organizational-note path) reject a
  target under the Organizations or Sites categories with an explanatory Notice. Hiding a button is
  a UI state; refusing at the choke point is a rule, and the choke points already exist.
- The `＋ New Document` affordances do not render on entity pages.

## 9. Rollup resolution

References are wikilinks, so rollups are a link-index read rather than a file scan.

- Source: `metadataCache.resolvedLinks` (public API), inverted into a target → sources map, cached
  and rebuilt on `metadataCache.on('resolved')`.
- For each source path, walk up to its owning folder and classify it via `classifyEntityBacklink`.
- Field stamps and body mentions are distinguished by re-reading the source's frontmatter: a link
  present in `organization`/`sites` is a stamp, anything else is a mention.
- Mentions appear only in the Notes tab (D8).

**Verification step — RESOLVED 2026-08-01: PASS.** A temporary `Probe: entity backlinks` command
found all 3 stamped sources on desktop: a document whose stamp sits on its current-version sidecar
(no `_document.md`), a PDF document, and a project's `_project.md`. Quoted wikilinks in frontmatter
do reach `resolvedLinks`, so the rollups read the link index as designed and no fallback to
`frontmatterLinks` or a file scan is needed. The probe has been removed. iPad remains unconfirmed,
but the link index is core Obsidian rather than platform code, so it rides the normal iPad pass
instead of gating the build.

Refresh follows the project view's pattern: the entity view listens for metadata changes under the
document root and re-renders, so stamping a document updates the organization's Work tab live.

## 10. Lifecycle

All four actions exist only on the entity's own page (D9). The plugin cannot prevent a rename in
Obsidian's file explorer; a watcher keeps folder and folder note in sync if that happens, as a
repair, not a supported route.

### 10.1 Rename

Fixed order: rename the folder note first — this is what makes Obsidian rewrite every reference —
then the folder, then log the change on the record. The order matters because the plugin's own
rename watcher reacts to file moves; doing the note first leaves nothing for it to collide with.
This is the same failure class as the break-away race fixed in `bf91c25`.

### 10.2 Archive

Moves the container to `<Category>/Archive/<Name>/`, sets `status: Archived` with date and actor.
Organizational notes inside the folder move with it and keep their stamps; their links survive the
move for the same basename reason the record's do.

`Archive` is a fixed folder name under each category, not a setting — one less thing to configure
wrong, and the lifecycle code needs a name it can rely on.

The prompt states counts — "37 documents, 12 notes and 4 sites reference Baycrest" — and offers:

1. Reassign all to a chosen organization,
2. Leave them pointing at the archived record,
3. Decide per item from a list.

Reassignment writes the new stamp and appends `organizationHistory` on each item (§4.4).

Archiving an organization with active sites asks whether to archive its sites too; default yes.

Sites have the same lifecycle, archived to `Sites/Archive/`.

### 10.3 Export

Available once archived. Produces a zip via the fflate build already inlined in `main.js` (no Node,
so desktop and iPad behave identically), written into the archived entity's folder:

- current version of each stamped document (checkbox for full version history; default off),
- every stamped and organizational note body as markdown,
- each document's `log.md`,
- the reassignment history,
- `manifest.md` — an inventory of everything included and everything skipped.

`exportedAt` and `exportPath` are recorded on the entity record.

### 10.4 Delete

If no export is recorded, the delete dialog says so and offers Export first. Proceeding anyway
requires the typed-title confirmation **plus** an explicit acknowledgement that no export exists.
Prompted, not blocked.

## 11. Backfill of existing items

A settings command, `Stamp existing documents with a default organization`:

1. Creates `Documents/Organizations/Baycrest/Baycrest.md` if absent.
2. Writes a **dry-run report** (`_migration-report.md`) listing every item it would touch by type
   and count. Nothing is written until the apply step is run separately.
3. Applies `organization: "[[Baycrest]]"` to every project, document and note with **no**
   `organization` key. It never overwrites an existing value, so it is safe to re-run.
4. Leaves `sites` empty. A wrong bulk site answer is worse than an absent one.

The dry-run and the apply are driven by the same pure planner (`planDefaultOrgStamp`).

## 12. Relationship to the encryption roadmap

Entity names are plaintext metadata in the same class as note people — arguably the loudest
plaintext in the vault, since "Baycrest ↔ vendor X" is itself information. Consistent with the
container-notes people accessors, all entity reads and writes go through a small accessor pair
(`readEntityRecord` / `writeEntityRecord`) so a future Phase D can relocate or encrypt the payload
by changing those two methods rather than every call site. No cryptography is built here.

## 13. Testing

**Pure core (`node --test`)**

- entity leaf detection, including a folder that is both an entity and a note parent (kind override),
- `classifyEntityBacklink` across document / project / note / site / unrelated sources,
- `planDefaultOrgStamp`: skips items that already carry a value, is idempotent across runs,
- site-record shape validation (organization link required).

**Desktop drill**

Create an organization; create a site from it and confirm it lands in `Sites/`; stamp a document and
a note and watch both rollups populate; write a body mention and confirm it appears as `mention` and
not in Work; rename the organization and confirm every reference follows; archive with reassignment
and confirm `organizationHistory` on the touched items; export and open the zip; attempt delete
without an export and confirm the gate; attempt to create a document inside an entity and confirm the
refusal.

**iPad pass**

Rides the existing container-notes iPad session. Nothing here uses Node or Electron APIs. The zip
export is the one genuinely new mobile path and needs its own step.

## 14. Acceptance criteria

1. An organization and a site can be created, edited and rendered, with records on disk in the shapes in §4.
2. A document, project and note can each carry `organization` and `sites`, and each appears on the
   correct entity page within one metadata refresh.
3. The organization page lists its sites; the site page has no Sites tab.
4. Document creation inside an entity folder is refused at the choke point, not merely hidden.
5. Body mentions appear in the Notes tab flagged `mention` and never in Work.
6. Rename updates every reference with no manual repair.
7. Archive offers reassignment, writes `organizationHistory`, and breaks no links.
8. Delete is gated behind the export prompt.
9. The backfill dry-run and apply agree exactly, and re-running the apply changes nothing.
10. Pure-core tests pass; desktop drill passes; iPad pass completes including the zip export.

## 15. Open questions

None blocking. Deferred by decision: Contacts, Agreements upload and tracking, a general bulk
re-stamp tool, and bulk site attribution.
