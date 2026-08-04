// lib/doc-container.js
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const MANAGED_EXTS = ['docx', 'pptx', 'xlsx', 'pdf'];

// Pending-document marker: an explicitly _V-versioned sidecar, with or without
// the office extension in its name ("Policy_V1.0.md" or "Policy_V1.0.docx.md" —
// the latter = a half-completed attach, still pending/retryable).
const PENDING_SIDECAR_RE = /_V\d+\.\d+(\.[a-z0-9]+)?\.md$/i;

// Container-notes (2026-07-09 plan): a note is a folder holding a machine-written
// _document.md skeleton + the body in a .cnote file. NOTE_EXT is deliberately
// NOT in MANAGED_EXTS — notes bypass the check-out gate and version grouping.
const NOTE_EXT = 'cnote';
const NOTE_BODY_NAME = 'body.' + NOTE_EXT;

// Hybrid card (2026-07-10 design): note types, which of them carry a People
// section, and the person-type vocabulary for that section.
const NOTE_TYPES = ['General', 'Meeting', 'Decision', 'Incident'];
const NOTE_PEOPLE_TYPES = ['Meeting', 'Decision', 'Incident'];
const PERSON_TYPES = ['Complainant', 'Subject', 'Victim', 'Witness', 'Stakeholder', 'User', 'Staff', 'Attendee'];

const STATUS_VALUES = ['Draft','In Review','Pending Approval','Approved','Active','Archived','Obsolete'];
const DOC_CLASSES   = ['Policy','SOP','Work Instruction','Form','Flowchart','Other'];

// ── Organizations & Sites (2026-07-31 spec) ──────────────────────────────────
// An entity is a folder holding a folder note named after the folder, carrying
// `type: organization|site`. Entities are NOT document containers: they hold
// their record and (organizations only) their own notes. See spec §4, §5.

const ENTITY_TYPES = ['organization', 'site'];

const ORG_TYPES = ['Internal', 'Health System Partner', 'Vendor', 'Contractor',
                   'Agency', 'Regulator', 'Union', 'Community Partner', 'Other'];
const ORG_STATUS = ['Active', 'Prospective', 'Inactive', 'Archived'];

const SITE_TYPES = ['Hospital', 'Long-Term Care', 'Residential', 'Clinic',
                    'Office', 'Campus Building', 'Parking', 'External'];
const SITE_STATUS = ['Active', 'Planned', 'Closed', 'Archived'];

// No `phone` on the organization record — phone numbers belong to Contacts,
// which is a later piece of work (spec §2).
const ORG_FIELDS = [
  { key: 'name',         label: 'Name',         type: 'text' },
  { key: 'orgType',      label: 'Type',         type: 'select', options: ORG_TYPES },
  { key: 'status',       label: 'Status',       type: 'select', options: ORG_STATUS },
  { key: 'relationship', label: 'Relationship', type: 'text' },
  { key: 'website',      label: 'Website',      type: 'text' },
  { key: 'address',      label: 'Address',      type: 'text' },
  { key: 'summary',      label: 'Summary',      type: 'textarea' },
  { key: 'tags',         label: 'Tags',         type: 'tags' },
];

const SITE_FIELDS = [
  { key: 'name',         label: 'Name',         type: 'text' },
  { key: 'organization', label: 'Organization', type: 'entity' },
  { key: 'siteType',     label: 'Site Type',    type: 'select', options: SITE_TYPES },
  { key: 'siteCode',     label: 'Site Code',    type: 'text' },
  { key: 'address',      label: 'Address',      type: 'text' },
  { key: 'city',         label: 'City',         type: 'text' },
  { key: 'province',     label: 'Province',     type: 'text' },
  { key: 'postalCode',   label: 'Postal Code',  type: 'text' },
  { key: 'lat',           label: 'Latitude',      type: 'text' },
  { key: 'lon',           label: 'Longitude',     type: 'text' },
  { key: 'geocodedAt',    label: 'Geocoded',      type: 'text' },
  { key: 'geocodeSource', label: 'Coord Source',  type: 'text' },
  { key: 'status',       label: 'Status',       type: 'select', options: SITE_STATUS },
  { key: 'summary',      label: 'Summary',      type: 'textarea' },
  { key: 'tags',         label: 'Tags',         type: 'tags' },
];

// The folder note is named after its folder so references read `[[Baycrest]]`
// and the graph labels the node with the entity name (spec D4).
function entityNoteName(folderName) {
  return String(folderName || '') + '.md';
}

// References are quoted wikilinks in frontmatter — the form the native indexer
// parses at boot, which is what makes backlinks and graph edges work (spec D3).
function entityLink(name) {
  return '[[' + String(name || '').trim() + ']]';
}

// Comma-separated user input to link strings, order preserved, deduped.
function parseEntityListInput(text) {
  const out = [];
  for (const part of String(text == null ? '' : text).split(',')) {
    const name = entityLinkName(part.trim());
    if (!name) continue;
    const link = entityLink(name);
    if (!out.includes(link)) out.push(link);
  }
  return out;
}

// True when `path` is an entity category itself or anything beneath it. Guards
// document creation: entity folders are records, not filing cabinets (spec D5).
function underEntityCategory(path, root, categories) {
  const p = String(path || '');
  if (!p) return false;
  const base = String(root || '').replace(/\/+$/, '');
  for (const cat of (categories || [])) {
    const c = base + '/' + cat;
    if (p === c || p.startsWith(c + '/')) return true;
  }
  return false;
}

// Accepts '[[Name]]', '[[Name|alias]]', '[[Name#sub]]' or a bare name.
function entityLinkName(link) {
  const s = String(link == null ? '' : link).trim();
  if (!s) return null;
  const m = s.match(/^\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]$/);
  const name = (m ? m[1] : s).trim();
  return name || null;
}

const DOC_FIELDS = {
  phase1: [
    { key:'title',           label:'Title',            type:'text' },
    { key:'docNumber',       label:'Document Number',  type:'text' },
    { key:'docClass',        label:'Document Class',   type:'select', options: DOC_CLASSES },
    { key:'revision',        label:'Revision',         type:'text' },
    { key:'status',          label:'Status',           type:'select', options: STATUS_VALUES },
    { key:'department',      label:'Department',       type:'text' },
  { key:'organization',    label:'Organization',     type:'entity' },
  { key:'sites',           label:'Sites',            type:'entities' },
    { key:'originator',      label:'Originator',       type:'text' },
    { key:'originationDate',      label:'Origination Date',          type:'date' },
    { key:'effectiveDate',        label:'Effective Date',            type:'date' },
    { key:'reviewFrequencyDays',  label:'Review Frequency (days)',   type:'number' },
    { key:'nextReviewDate',       label:'Next Review',               type:'date' },
    { key:'summary',              label:'Summary',                   type:'textarea' },
    { key:'tags',            label:'Tags',             type:'tags' },
  ],
  // reserved — defined now, not edited in Phase 1 (workflow phases activate these)
  reserved: ['reviewers','finalApprover','statusHistory','relatedDocuments'],
};

// ── _document.md migration: ownership constants (2026-06-17 metadata migration) ──
// Document-level metadata moves to a `_document.md` folder-note (system of record);
// per-version sidecars keep only version-specific facts. See spec
// docs/superpowers/specs/2026-06-17-doc-container-document-md-metadata-migration-design.md

const DOCUMENT_MD_NAME = '_document.md';   // folder-note: the logical Document's record
const LOG_MD_NAME      = 'log.md';         // per-document append-only activity log (markdown body)

// Keys owned by _document.md (the logical-document system of record).
const DOC_LEVEL_KEYS = [
  'docContainer', 'docId',
  'title', 'docNumber', 'docClass', 'revision', 'status', 'department',
  'originator', 'originatorTitle', 'originationDate', 'effectiveDate',
  'organization', 'sites',
  'reviewFrequencyDays', 'nextReviewDate', 'summary', 'tags',
  'currentVersion', 'files',
  'stakeholders', 'relatedDocuments', 'definitions',
  'activityLog', 'noteLog',
];

// Keys owned by the per-version sidecar (`<file>.<ext>.md`).
// `docId` is the one intentional cross-set key: it is the document's id on
// _document.md and a move-resilient backref on each sidecar.
const VERSION_KEYS = ['docx', 'docId', 'created', 'modified', 'versionNote', 'links'];

// ── Task 1: Version parsing ───────────────────────────────────────────────────

// "<base>_V<major>.<minor>.<ext>" → version; bare "<base>.<ext>" → rev 1.0
function parseVersion(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  // Matches two-part _V<major>.<minor> only — e.g. _V1.2.3 falls back to the bare-name branch
  const m = stem.match(/^(.*)_V(\d+)\.(\d+)$/);
  if (m) {
    return { base: m[1], ext, major: Number(m[2]), minor: Number(m[3]),
             label: `rev ${Number(m[2])}.${Number(m[3])}`, parsed: true };
  }
  return { base: stem, ext, major: 1, minor: 0, label: 'rev 1.0', parsed: true };
}

// ── Task 2: Compare versions & group document files ──────────────────────────

function compareVersions(a, b) {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

// Group a Document folder's filenames: choose the base with the most versions as
// primary; its highest version = current; the rest of that base = history;
// everything else = attachments.
function groupDocumentFiles(filenames) {
  const byBase = new Map();
  for (const f of filenames) {
    const v = parseVersion(f);
    const stem = f.lastIndexOf('.') >= 0 ? f.slice(0, f.lastIndexOf('.')) : f;
    const explicit = /_V\d+\.\d+$/.test(stem);   // true only for an explicit _V<major>.<minor> name
    if (!byBase.has(v.base)) byBase.set(v.base, []);
    byBase.get(v.base).push({ name: f, explicit, ...v });
  }
  // Pick the primary base: most office versions wins; on a tie, an explicitly
  // _V-versioned base beats a bare-named one (so a loose attachment file like
  // "Agenda.docx" can never hijack current from a real "<Base>_V1.0.docx");
  // remaining ties fall back to lexicographically-smallest base.
  let primaryBase = null, primaryCount = -1, primaryExplicit = false;
  for (const [base, arr] of byBase) {
    const officeCount = arr.filter(x => MANAGED_EXTS.includes(x.ext)).length;
    const hasExplicit = arr.some(x => x.explicit && MANAGED_EXTS.includes(x.ext));
    const better = officeCount > primaryCount
      || (officeCount === primaryCount && primaryBase !== null && hasExplicit && !primaryExplicit)
      || (officeCount === primaryCount && hasExplicit === primaryExplicit && primaryBase !== null && base < primaryBase);
    if (better) { primaryCount = officeCount; primaryBase = base; primaryExplicit = hasExplicit; }
  }
  const primary = (byBase.get(primaryBase) || []).slice()
    .sort((a, b) => compareVersions(b, a)); // descending → current first
  const versions = primary.map(x => x.name);
  const current = versions[0] || null;
  const attachments = filenames.filter(f => !versions.includes(f));
  return { current, versions, attachments };
}

// ── Task 3: Build taxonomy tree from a path list ─────────────────────────────

function isManaged(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MANAGED_EXTS.includes(ext);
}
function isSidecar(name) { return name.toLowerCase().endsWith('.md'); }

// paths: vault-relative file paths (forward slashes). root: managed-root folder name.
function buildTaxonomy(paths, root, entityFolders) {
  const prefix = root.replace(/\/+$/, '') + '/';
  // folderPath → all direct child filenames (non-sidecar)
  const folderFiles = new Map();
  // folderPath → direct child sidecar names (kept ONLY to detect pending documents)
  const folderSidecars = new Map();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const slash = p.lastIndexOf('/');
    const folder = p.slice(0, slash);
    const name = p.slice(slash + 1);
    if (isSidecar(name)) {
      if (!folderSidecars.has(folder)) folderSidecars.set(folder, []);
      folderSidecars.get(folder).push(name);
      continue;
    }
    // managed office files AND stray files both collect here (strays become attachments)
    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder).push(name);
  }
  // A folder is a Document if it has ≥1 managed office file directly in it.
  // A folder is a NOTE container if it has a .cnote body and NO office file
  // (office wins: the .cnote then rides along as an attachment).
  // A folder is a PENDING document if it has neither, but holds an explicitly
  // _V-versioned sidecar (a "Decide Later" container awaiting its file).
  const documents = new Set();
  const notes = new Set();
  for (const [folder, files] of folderFiles) {
    if (files.some(isManaged)) documents.add(folder);
    else if (files.some(isNoteBody)) notes.add(folder);
  }
  const pending = new Map();   // folder → marker sidecar name
  for (const [folder, sidecars] of folderSidecars) {
    if (documents.has(folder) || notes.has(folder)) continue;
    const marker = sidecars.find(s => PENDING_SIDECAR_RE.test(s));
    if (marker) pending.set(folder, marker);
  }
  // Entity folders are supplied by the caller (frontmatter is not readable from
  // the pure core). Only those under the managed root participate.
  const entities = new Map();
  if (entityFolders) {
    const pairs = (typeof entityFolders.entries === 'function')
      ? entityFolders.entries() : Object.entries(entityFolders);
    for (const [folder, kind] of pairs) {
      if (String(folder).startsWith(prefix) && ENTITY_TYPES.includes(kind)) entities.set(folder, kind);
    }
  }
  // Build nested category/collection/document tree.
  const rootNode = { children: [] };
  const ensure = (parent, name, path) => {
    let n = parent.children.find(c => c.name === name && c.path === path);
    if (!n) { n = { name, path, kind: null, children: [] }; parent.children.push(n); }
    return n;
  };
  const leaves = [];
  // Entities first so their nodes exist before any nested note claims the path.
  for (const [f, k] of entities) leaves.push({ folder: f, leafKind: k });
  for (const f of documents) leaves.push({ folder: f, leafKind: 'document' });
  for (const f of notes)     leaves.push({ folder: f, leafKind: 'note' });
  for (const f of pending.keys()) leaves.push({ folder: f, leafKind: 'pending' });
  for (const { folder: docFolder, leafKind } of leaves) {
    const rel = docFolder.slice(prefix.length);          // e.g. Governance/Policy/Fan-Out…
    const segs = rel.split('/');
    let parent = rootNode, acc = root;
    segs.forEach((seg, i) => {
      acc += '/' + seg;
      const node = ensure(parent, seg, acc);
      if (i === segs.length - 1) node.kind = (leafKind === 'pending') ? 'document' : leafKind;
      else if (i === 0) node.kind = 'category';
      else if (!node.kind) node.kind = 'collection';
      parent = node;
    });
    const docNode = parent;
    if (leafKind === 'document') {
      const grouped = groupDocumentFiles(folderFiles.get(docFolder));
      docNode.current = grouped.current;
      docNode.files = grouped.versions;
      docNode.attachments = grouped.attachments;
    } else if (leafKind === 'pending') {
      docNode.pending = pending.get(docFolder);
      docNode.current = null; docNode.files = [];
      docNode.attachments = (folderFiles.get(docFolder) || []).slice();
    } else if (ENTITY_TYPES.includes(leafKind)) {
      docNode.entityType = leafKind;
      docNode.current = null; docNode.files = []; docNode.attachments = [];
    } else {
      docNode.noteBody = folderFiles.get(docFolder).find(isNoteBody);
      docNode.current = null; docNode.files = []; docNode.attachments = [];
    }
  }
  // An entity folder can also be the parent of note folders; the "intermediate
  // segment becomes a collection" rule must not demote it. Stamping last makes
  // the result independent of leaf ordering.
  if (entities.size) _stampEntityKinds(rootNode.children, entities);
  return rootNode.children;
}

function _stampEntityKinds(nodes, entities) {
  for (const n of nodes) {
    const k = entities.get(n.path);
    if (k) { n.kind = k; n.entityType = k; }
    if (n.children && n.children.length) _stampEntityKinds(n.children, entities);
  }
}

// ── Task 14: Lifecycle (next review + overdue) ───────────────────────────────

function computeNextReview(effectiveDate, freqDays) {
  const f = Number(freqDays);
  if (!effectiveDate || !f) return null;
  const d = new Date(effectiveDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + f);
  return d.toISOString().slice(0, 10);
}
function isOverdue(nextReviewISO, todayISO) {
  if (!nextReviewISO) return false;
  return nextReviewISO < todayISO;   // ISO date strings compare lexicographically
}

// ── Task 15: Status rollup + overdue count ───────────────────────────────────

function rollupByStatus(docs) {
  const out = {};
  for (const d of docs) { const k = d.status || 'Unset'; out[k] = (out[k]||0)+1; }
  return out;
}
function countOverdue(docs, todayISO) {
  return docs.filter(d => isOverdue(d.nextReviewDate, todayISO)).length;
}

// ── Task 16: Next version filename ───────────────────────────────────────────

function nextVersionName(current, bump) {
  const v = parseVersion(current);
  const major = bump === 'major' ? v.major + 1 : v.major;
  const minor = bump === 'major' ? 0 : v.minor + 1;
  const extPart = v.ext ? `.${v.ext}` : '';
  return `${v.base}_V${major}.${minor}${extPart}`;
}

// ── B1 (create-side): new-document naming ─────────────────────────────────────

// Human title → PascalCase file base. Strips every non-alphanumeric character;
// each whitespace-delimited word keeps its remaining characters and gets its
// first character upper-cased (so an all-caps acronym like "SOP" survives).
// Punctuation-only or empty input falls back to "Document".
//   "Fan-Out Policy" → "FanOutPolicy"   "Code of Conduct" → "CodeOfConduct"
//   "Incident Reporting SOP" → "IncidentReportingSOP"   "!!!" → "Document"
function documentBaseName(title) {
  const cleaned = String(title || '').replace(/[^A-Za-z0-9\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const base = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return base || 'Document';
}

// First-version filename for a freshly created document: "<base>_V1.0.<ext>".
function firstVersionName(base, ext) {
  return `${base}_V1.0.${ext}`;
}

// A child name not already taken in a folder: "<desired>", else "<desired> (2)", "(3)"…
function dedupeName(desired, taken) {
  const set = new Set(taken || []);
  if (!set.has(desired)) return desired;
  let n = 2;
  while (set.has(desired + ' (' + n + ')')) n++;
  return desired + ' (' + n + ')';
}

// ── Task 21 (v0.2): inline note-tag extraction ───────────────────────────────

// Pull completed "#tag " tokens out of free text. `flush=true` (on Add) also
// captures a trailing "#tag" with no following space. Returns the cleaned body
// (collapsed whitespace) + the extracted tag names (no leading #).
function extractInlineTags(text, flush) {
  const tags = []; let body = text;
  const re = /(^|\s)#([\w-]+)\s/;            // a completed "#tag " token
  let m; while ((m = body.match(re))) { tags.push(m[2]); body = body.replace(re, '$1'); }
  if (flush) {                                // on Add: also take a trailing "#tag" with no space
    const t = body.match(/(^|\s)#([\w-]+)\s*$/);
    if (t) { tags.push(t[2]); body = body.replace(/(^|\s)#([\w-]+)\s*$/, '$1'); }
  }
  return { body: body.trim().replace(/\s+/g, ' '), tags };
}

// ── Container-notes: skeleton extraction ─────────────────────────────────────

function isNoteBody(name) {
  return String(name || '').toLowerCase().endsWith('.' + NOTE_EXT);
}

// Extract the machine-written skeleton fields from a note's PLAINTEXT body:
// title = first ATX H1; tags = inline #tag tokens (letter-first, so "#1"/"##"
// never match); links = [[wikilink]] targets with alias (|…) and subpath (#…)
// stripped, returned as '[[Target]]' strings ready for a frontmatter links:
// array (the quoted-wikilink form the native indexer parses at boot).
// v1 limitation (accepted): fenced code blocks are not excluded from scanning.
function extractNoteSkeleton(text) {
  const src = String(text || '');
  const h1 = src.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : null;
  const tags = [];
  const tagRe = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
  let m;
  while ((m = tagRe.exec(src))) { if (!tags.includes(m[2])) tags.push(m[2]); }
  const links = [];
  const linkRe = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;
  while ((m = linkRe.exec(src))) {
    const t = m[1].trim();
    if (t && !links.includes('[[' + t + ']]')) links.push('[[' + t + ']]');
  }
  return { title, tags, links };
}

function noteShowsPeople(noteType) {
  return NOTE_PEOPLE_TYPES.includes(String(noteType || ''));
}

// Machine links[] for a note = body-extracted links ∪ relation-derived parent
// links (body order first, deduped, empties skipped). The union runs on every
// skeleton write so parent edges self-heal and removals converge.
function mergeNoteLinks(bodyLinks, parentLinks) {
  const out = [];
  for (const l of [...(bodyLinks || []), ...(parentLinks || [])]) {
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

// ── Task 30 (v0.3): aggregate stakeholders across a container's documents ─────

// Group every document's stakeholders[] by (name + title); collect each person's
// distinct roles and the documents they appear in. Sorted by document-count desc,
// then title asc. Derived/read-only — the cross-document rollup on the Project view.
function aggregateStakeholders(docs) {
  const map = new Map();
  for (const d of docs) for (const s of (d.stakeholders || [])) {
    const key = (s.name || '') + '|' + (s.title || '');
    if (!map.has(key)) map.set(key, { name: s.name || '', title: s.title || '', roles: new Set(), docs: new Set() });
    const e = map.get(key); if (s.role) e.roles.add(s.role); e.docs.add(d.title);
  }
  return [...map.values()].map(e => ({ name: e.name, title: e.title, roles: [...e.roles], docs: [...e.docs] }))
    .sort((a, b) => b.docs.length - a.docs.length || (a.title > b.title ? 1 : -1));
}

// ── _document.md migration: pure partition + reconcile planning ───────────────

function _isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

// Split a frontmatter object by key ownership. Unknown keys ride along on the
// version side (least-destructive — reconcile never drops a key it doesn't own).
function partitionFrontmatter(front) {
  const docSet = new Set(DOC_LEVEL_KEYS);
  const verSet = new Set(VERSION_KEYS);
  const docLevel = {}, versionLevel = {};
  for (const [k, v] of Object.entries(front || {})) {
    if (docSet.has(k)) docLevel[k] = v;
    else if (verSet.has(k)) versionLevel[k] = v;
    else versionLevel[k] = v;          // unknown → keep on the sidecar
  }
  return { docLevel, versionLevel };
}

// Expected-files manifest for a Document folder: version files (chronological,
// oldest→newest) + the pinned current version. Attachments are excluded (they
// are stray files, not versions). Reuses groupDocumentFiles for the grouping.
function buildFilesManifest(fileNames) {
  const g = groupDocumentFiles(fileNames || []);
  return { files: g.versions.slice().reverse(), currentVersion: g.current };
}

// Produce a pure, disk-free migration plan for ONE document folder. The same
// plan drives both the dry-run report and the apply step, so they cannot drift.
//   input: { folderFiles:[name…], sidecarFronts:{ '<file>.md': front }, hasDocumentMd:bool }
//   → { skip } | { skip:false, needsDocId, createDocumentMd, sidecarRewrites, notes }
// docId is NOT generated here (no randomness in the pure core); the runtime
// stamps it when needsDocId is set.
function planReconcile(input) {
  const { folderFiles = [], sidecarFronts = {}, hasDocumentMd = false } = input || {};
  if (hasDocumentMd) return { skip: true };

  const manifest = buildFilesManifest(folderFiles);
  const currentSidecarName = manifest.currentVersion ? manifest.currentVersion + '.md' : null;
  const notes = [];

  // Metadata source = the current version's sidecar; fall back to any sidecar
  // that carries doc-level keys.
  let sourceFront = currentSidecarName ? sidecarFronts[currentSidecarName] : null;
  if (!sourceFront) {
    const alt = Object.keys(sidecarFronts).find(
      n => Object.keys(partitionFrontmatter(sidecarFronts[n]).docLevel).length > 0);
    if (alt) { sourceFront = sidecarFronts[alt]; notes.push('No current-version sidecar; used ' + alt + ' as metadata source.'); }
  }
  const docLevel = partitionFrontmatter(sourceFront || {}).docLevel;
  if (!sourceFront) notes.push('No sidecar metadata found; created _document.md with manifest + docId only.');

  // Flag divergent scalar doc-level values on non-current sidecars (current wins).
  for (const [name, front] of Object.entries(sidecarFronts)) {
    if (name === currentSidecarName) continue;
    const other = partitionFrontmatter(front).docLevel;
    for (const k of Object.keys(other)) {
      if (_isScalar(other[k]) && k in docLevel && _isScalar(docLevel[k]) && other[k] !== docLevel[k]) {
        notes.push(`Divergent ${k}: '${name}' = ${JSON.stringify(other[k])}, using current's ${JSON.stringify(docLevel[k])}.`);
      }
    }
  }

  // Every sidecar drops its doc-level keys (never docId — that backref stays).
  const sidecarRewrites = Object.keys(sidecarFronts).map(name => ({
    name,
    dropKeys: Object.keys(partitionFrontmatter(sidecarFronts[name]).docLevel).filter(k => k !== 'docId'),
  })).filter(r => r.dropKeys.length > 0);

  return {
    skip: false,
    needsDocId: true,
    createDocumentMd: { docLevelKeys: docLevel, files: manifest.files, currentVersion: manifest.currentVersion },
    sidecarRewrites,
    notes,
  };
}

// ── Authorship + check-out (2026-06-19 plan) ───────────────────────────────────

function slugifyAuthor(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function formatLogEntry(e) {
  const dt = (e && e.datetime) || '';
  const actor = (e && e.actor) || '';
  const action = (e && e.action) || '';
  const detail = e && e.detail ? ' (' + e.detail + ')' : '';
  return '- ' + dt + ' · ' + actor + ' · ' + action + detail;
}

function parseLogBody(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^- (.+?) · (.+?) · (.+)$/.exec(line);
    if (m) out.push({ datetime: m[1], actor: m[2], action: m[3] });
  }
  return out;
}

// Read the check-out lock from a frontmatter object. timeoutHours > 0 marks a
// lock older than that window as stale (0 = never stale). nowISO is passed in so
// this stays pure/testable.
function lockStateFromFront(front, nowISO, timeoutHours) {
  const by = front && front.checkedOutBy ? String(front.checkedOutBy) : null;
  const at = front && front.checkedOutAt ? String(front.checkedOutAt) : null;
  let stale = false;
  if (by && at && timeoutHours > 0) {
    const age = Date.parse(nowISO) - Date.parse(at);
    stale = isFinite(age) && age > timeoutHours * 3600 * 1000;
  }
  return { by: by, at: at, stale: stale };
}

// Name for an outlier fork copy saved from a check-out conflict: strips the
// version off the current filename and tags it with the author slug + date.
function forkFileName(currentVersionName, authorSlug, dateStr) {
  const v = parseVersion(currentVersionName);
  return v.base + '_fork_' + authorSlug + '_' + dateStr + '.' + v.ext;
}
// A fork sidecar is pending reconciliation when it has forkOf and is not reconciled
// (missing reconciled counts as pending).
function isPendingFork(front) {
  return !!(front && front.forkOf) && front.reconciled !== true;
}

// Pure edit-gate decision for a doc-container document. Inputs are booleans the
// caller resolves from Obsidian; output drives editor read-only state + banner copy.
// Order matters: managed -> current -> held-by-me -> held-by-other -> unlocked.
function editGateDecision(g) {
  if (!g || !g.managed) return { editable: true, state: 'unmanaged' };
  if (!g.current) return { editable: false, state: 'old-version' };
  if (g.heldByMe) return { editable: true, state: 'held-by-me' };
  if (g.heldByOther) return { editable: false, state: 'held-by-other' };
  return { editable: false, state: 'unlocked' };
}

// ── Site geolocation (spec 2026-08-03) ──────────────────────────────────────
// WGS84 decimal degrees at 6 dp, matching P22_CampusMap's AssetPos.wgs84 so a
// site can feed that project without conversion.

function formatCoord(n) {
  const v = parseCoord(n);
  return v == null ? null : v.toFixed(6);
}

function parseCoord(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function siteCoord(rec) {
  const lat = parseCoord(rec && rec.lat);
  const lon = parseCoord(rec && rec.lon);
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

// Great-circle distance in km. Pure maths — no service, no network.
function haversineKm(a, b) {
  const R = 6371;                       // mean Earth radius, km
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Nominatim jsonv2 -> flat fields. This function is the ENTIRE provider-shape
// dependency (spec §3.2): swapping geocoders means rewriting this and its
// fixtures, nothing else. Never throws — a malformed body is simply no results,
// because a parse error must not surface as a UI exception.
function parseGeocodeResults(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const lat = formatCoord(item.lat);
    const lon = formatCoord(item.lon);
    if (lat == null || lon == null) continue;      // unusable without a position

    const a = (item.address && typeof item.address === 'object') ? item.address : {};
    const display = typeof item.display_name === 'string' ? item.display_name : '';

    let street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
    if (!street) street = display.split(',')[0].trim();

    out.push({
      display: display || street,
      address: street,
      city: a.city || a.town || a.village || a.municipality || '',
      province: a.state || '',
      postalCode: a.postcode || '',
      lat, lon,
    });
  }
  return out;
}

// ── Entity notes: merged activity feed (spec 2026-08-04) ────────────────────
// A record's own notes, its sites' notes and notes on work attributed to it are
// one chronological story. These two functions are the whole of that logic, kept
// pure so the ordering rules are testable without a vault.

// sources: [{ origin, originKind, originPath, entries }] -> flat rows, newest first.
// Ties break by origin name so repaints are stable rather than depending on the
// order entityReferences happened to discover sources in.
function mergeNoteFeed(sources) {
  if (!Array.isArray(sources)) return [];
  const rows = [];
  for (const s of sources) {
    if (!s || !Array.isArray(s.entries)) continue;
    for (const e of s.entries) {
      if (!e || typeof e !== 'object') continue;
      rows.push({
        origin: s.origin || '',
        originKind: s.originKind || '',
        originPath: s.originPath || '',
        date: e.date || '',
        author: e.author || '',
        body: e.body || '',
        noteTags: Array.isArray(e.noteTags) ? e.noteTags : [],
        attachments: Array.isArray(e.attachments) ? e.attachments : [],
      });
    }
  }
  rows.sort((a, b) => {
    const d = String(b.date).localeCompare(String(a.date));
    return d !== 0 ? d : String(a.origin).localeCompare(String(b.origin));
  });
  return rows;
}

// Text terms are ANDed; `#` is stripped so "#meeting" and "meeting" behave the
// same, matching the document pane's search. Dates are inclusive at both ends.
function filterNoteFeed(rows, criteria) {
  if (!Array.isArray(rows)) return [];
  const c = criteria || {};
  const terms = String(c.text || '').toLowerCase().replace(/#/g, '').split(/\s+/).filter(Boolean);
  return rows.filter((n) => {
    if (!n || typeof n !== 'object') return false;
    const hay = ((n.date || '') + ' ' + (n.author || '') + ' ' + (n.body || '') + ' '
      + (n.origin || '') + ' ' + (n.noteTags || []).join(' ')).toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
    if (c.from && String(n.date) < c.from) return false;
    if (c.to && String(n.date) > c.to) return false;
    return true;
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  MANAGED_EXTS,
  PENDING_SIDECAR_RE,
  STATUS_VALUES,
  DOC_CLASSES,
  DOC_FIELDS,
  ENTITY_TYPES,
  ORG_TYPES,
  ORG_STATUS,
  SITE_TYPES,
  SITE_STATUS,
  ORG_FIELDS,
  SITE_FIELDS,
  entityNoteName,
  entityLink,
  entityLinkName,
  parseEntityListInput,
  underEntityCategory,
  parseVersion,
  compareVersions,
  groupDocumentFiles,
  isManaged,
  isSidecar,
  NOTE_EXT,
  NOTE_BODY_NAME,
  isNoteBody,
  extractNoteSkeleton,
  NOTE_TYPES,
  NOTE_PEOPLE_TYPES,
  PERSON_TYPES,
  noteShowsPeople,
  mergeNoteLinks,
  buildTaxonomy,
  computeNextReview,
  isOverdue,
  rollupByStatus,
  countOverdue,
  nextVersionName,
  documentBaseName,
  firstVersionName,
  dedupeName,
  extractInlineTags,
  aggregateStakeholders,
  DOCUMENT_MD_NAME,
  LOG_MD_NAME,
  DOC_LEVEL_KEYS,
  VERSION_KEYS,
  partitionFrontmatter,
  buildFilesManifest,
  planReconcile,
  slugifyAuthor,
  formatLogEntry,
  parseLogBody,
  lockStateFromFront,
  editGateDecision,
  forkFileName,
  isPendingFork,
  formatCoord,
  parseCoord,
  siteCoord,
  haversineKm,
  parseGeocodeResults,
  mergeNoteFeed,
  filterNoteFeed,
};
