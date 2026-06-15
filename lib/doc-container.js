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
  extractInlineTags,
  aggregateStakeholders,
};
