// lib/doc-container.js
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const MANAGED_EXTS = ['docx', 'pptx', 'xlsx', 'pdf'];

const STATUS_VALUES = ['Draft','In Review','Pending Approval','Approved','Active','Archived','Obsolete'];
const DOC_CLASSES   = ['Policy','SOP','Work Instruction','Form','Flowchart','Other'];

const DOC_FIELDS = {
  phase1: [
    { key:'title',           label:'Title',            type:'text' },
    { key:'docNumber',       label:'Document Number',  type:'text' },
    { key:'docClass',        label:'Document Class',   type:'select', options: DOC_CLASSES },
    { key:'revision',        label:'Revision',         type:'text' },
    { key:'status',          label:'Status',           type:'select', options: STATUS_VALUES },
    { key:'department',      label:'Department',       type:'text' },
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
const PROJECT_MD_NAME  = '_project.md';    // existing project-container folder-note
const DOC_MARKER       = 'document';       // _document.md frontmatter: `docContainer: document`

// Keys owned by _document.md (the logical-document system of record).
const DOC_LEVEL_KEYS = [
  'docContainer', 'docId',
  'title', 'docNumber', 'docClass', 'revision', 'status', 'department',
  'originator', 'originatorTitle', 'originationDate', 'effectiveDate',
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
    if (!byBase.has(v.base)) byBase.set(v.base, []);
    byBase.get(v.base).push({ name: f, ...v });
  }
  let primaryBase = null, primaryCount = -1;
  for (const [base, arr] of byBase) {
    const officeCount = arr.filter(x => MANAGED_EXTS.includes(x.ext)).length;
    if (officeCount > primaryCount ||
       (officeCount === primaryCount && primaryBase !== null && base < primaryBase)) {
      primaryCount = officeCount; primaryBase = base;
    }
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
function buildTaxonomy(paths, root) {
  const prefix = root.replace(/\/+$/, '') + '/';
  // folderPath → all direct child filenames (non-sidecar)
  const folderFiles = new Map();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const slash = p.lastIndexOf('/');
    const folder = p.slice(0, slash);
    const name = p.slice(slash + 1);
    if (isSidecar(name)) continue;
    if (!isManaged(name)) { // remember stray files too, as attachments
      if (!folderFiles.has(folder)) folderFiles.set(folder, []);
      folderFiles.get(folder).push(name);
      continue;
    }
    if (!folderFiles.has(folder)) folderFiles.set(folder, []);
    folderFiles.get(folder).push(name);
  }
  // A folder is a Document if it has ≥1 managed office file directly in it.
  const documents = new Set();
  for (const [folder, files] of folderFiles) {
    if (files.some(isManaged)) documents.add(folder);
  }
  // Build nested category/collection/document tree.
  const rootNode = { children: [] };
  const ensure = (parent, name, path) => {
    let n = parent.children.find(c => c.name === name && c.path === path);
    if (!n) { n = { name, path, kind: null, children: [] }; parent.children.push(n); }
    return n;
  };
  for (const docFolder of documents) {
    const rel = docFolder.slice(prefix.length);          // e.g. Governance/Policy/Fan-Out…
    const segs = rel.split('/');
    let parent = rootNode, acc = root;
    segs.forEach((seg, i) => {
      acc += '/' + seg;
      const node = ensure(parent, seg, acc);
      if (i === segs.length - 1) node.kind = 'document';
      else if (i === 0) node.kind = 'category';
      else if (!node.kind) node.kind = 'collection';
      parent = node;
    });
    // attach grouped files to the document node
    const docNode = parent;
    const grouped = groupDocumentFiles(folderFiles.get(docFolder));
    docNode.current = grouped.current;
    docNode.files = grouped.versions;
    docNode.attachments = grouped.attachments;
  }
  return rootNode.children;
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  MANAGED_EXTS,
  STATUS_VALUES,
  DOC_CLASSES,
  DOC_FIELDS,
  parseVersion,
  compareVersions,
  groupDocumentFiles,
  isManaged,
  isSidecar,
  buildTaxonomy,
  computeNextReview,
  isOverdue,
  rollupByStatus,
  countOverdue,
  nextVersionName,
  documentBaseName,
  firstVersionName,
  extractInlineTags,
  aggregateStakeholders,
  DOCUMENT_MD_NAME,
  PROJECT_MD_NAME,
  DOC_MARKER,
  DOC_LEVEL_KEYS,
  VERSION_KEYS,
  partitionFrontmatter,
  buildFilesManifest,
  planReconcile,
  slugifyAuthor,
};
