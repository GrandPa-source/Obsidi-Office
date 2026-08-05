// lib/doc-container.test.js
const test = require('node:test');
const assert = require('node:assert');
const dc = require('./doc-container.js');

// Task 1: version parsing
test('parseVersion: bare name is revision 1.0', () => {
  assert.deepStrictEqual(dc.parseVersion('FanOutPolicy.docx'),
    { base: 'FanOutPolicy', ext: 'docx', major: 1, minor: 0, label: 'rev 1.0', parsed: true });
});

test('parseVersion: _V2.0 suffix', () => {
  assert.deepStrictEqual(dc.parseVersion('FanOutPolicy_V2.0.docx'),
    { base: 'FanOutPolicy', ext: 'docx', major: 2, minor: 0, label: 'rev 2.0', parsed: true });
});

test('parseVersion: _V3.10 two-digit minor', () => {
  const r = dc.parseVersion('Plan_V3.10.xlsx');
  assert.strictEqual(r.major, 3); assert.strictEqual(r.minor, 10);
});

test('parseVersion: non-office or weird name still returns parsed=true with base', () => {
  const r = dc.parseVersion('contact-list.xlsx');
  assert.strictEqual(r.base, 'contact-list'); assert.strictEqual(r.major, 1);
});

// Task 2: compare versions & group document files
test('compareVersions orders ascending', () => {
  assert.ok(dc.compareVersions({major:2,minor:0},{major:2,minor:1}) < 0);
  assert.ok(dc.compareVersions({major:3,minor:0},{major:2,minor:9}) > 0);
  assert.strictEqual(dc.compareVersions({major:1,minor:0},{major:1,minor:0}), 0);
});

test('groupDocumentFiles: pins highest version of the primary base, lists attachments', () => {
  const files = ['FanOutPolicy_V2.0.docx','FanOutPolicy.docx','contact-list.xlsx','notes.txt'];
  const g = dc.groupDocumentFiles(files);
  assert.strictEqual(g.current, 'FanOutPolicy_V2.0.docx');
  assert.deepStrictEqual(g.versions, ['FanOutPolicy_V2.0.docx','FanOutPolicy.docx']); // current first, then history
  assert.deepStrictEqual(g.attachments, ['contact-list.xlsx','notes.txt']);
});

test('groupDocumentFiles: largest version-set base wins as primary', () => {
  // base "Plan" has 2 versions, "Annex" has 1 → Plan is primary, Annex is attachment
  const g = dc.groupDocumentFiles(['Plan.docx','Plan_V2.0.docx','Annex.docx']);
  assert.strictEqual(g.current, 'Plan_V2.0.docx');
  assert.deepStrictEqual(g.attachments, ['Annex.docx']);
});

// Task 3: buildTaxonomy
test('buildTaxonomy: classifies category/collection/document from paths', () => {
  const paths = [
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy_V2.0.docx',
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy.docx',
    'Documents/Governance/Policy/Fan-Out Notification Policy/FanOutPolicy_V2.0.docx.md',
    'Documents/Projects/Accreditation 2026/HIRA Methodology/BaycrestHIRA_Methodology_V1.0.xlsx',
  ];
  const tree = dc.buildTaxonomy(paths, 'Documents');
  const gov = tree.find(c => c.name === 'Governance');
  assert.strictEqual(gov.kind, 'category');
  const policy = gov.children.find(c => c.name === 'Policy');
  assert.strictEqual(policy.kind, 'collection');
  const doc = policy.children.find(d => d.name === 'Fan-Out Notification Policy');
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.current, 'FanOutPolicy_V2.0.docx');     // sidecar (.md) excluded from versions
  assert.deepStrictEqual(doc.files.sort(), ['FanOutPolicy.docx','FanOutPolicy_V2.0.docx']);
});

test('buildTaxonomy: ignores paths outside the managed root', () => {
  const tree = dc.buildTaxonomy(['Home.md','Meetings/note.md'], 'Documents');
  assert.deepStrictEqual(tree, []);
});

// Task 4: metadata schema constants
test('schema exposes Phase-1 fields, reserved fields, and status values', () => {
  assert.deepStrictEqual(dc.DOC_FIELDS.phase1.map(f => f.key),
    ['title','docNumber','docClass','revision','status','department','organization','sites','originator','originationDate','effectiveDate','reviewFrequencyDays','nextReviewDate','summary','tags']);
  assert.ok(dc.DOC_FIELDS.reserved.includes('reviewers'));
  assert.ok(dc.DOC_FIELDS.reserved.includes('finalApprover'));
  assert.ok(dc.STATUS_VALUES.includes('Draft') && dc.STATUS_VALUES.includes('Approved'));
  assert.deepStrictEqual(dc.DOC_CLASSES.slice(0,2), ['Policy','SOP']);
});

// Task 14: lifecycle (next review + overdue)
test('computeNextReview adds freq days to effective date', () => {
  assert.strictEqual(dc.computeNextReview('2026-04-20', 180), '2026-10-17');
  assert.strictEqual(dc.computeNextReview('2026-04-20', 0), null);   // no cadence
  assert.strictEqual(dc.computeNextReview('', 180), null);           // no effective date
});
test('isOverdue compares against today', () => {
  assert.strictEqual(dc.isOverdue('2026-01-01', '2026-06-11'), true);
  assert.strictEqual(dc.isOverdue('2026-12-01', '2026-06-11'), false);
  assert.strictEqual(dc.isOverdue(null, '2026-06-11'), false);
});

// Task 15: status rollup + overdue count
test('rollupByStatus counts documents per status', () => {
  const docs = [{status:'Draft'},{status:'Draft'},{status:'Active'},{status:null}];
  assert.deepStrictEqual(dc.rollupByStatus(docs), { Draft:2, Active:1, Unset:1 });
});
test('countOverdue counts docs whose nextReview is past', () => {
  const docs = [{nextReviewDate:'2026-01-01'},{nextReviewDate:'2027-01-01'},{nextReviewDate:null}];
  assert.strictEqual(dc.countOverdue(docs, '2026-06-11'), 1);
});

// Task 16: next version filename
test('nextVersionName bumps minor by default, major on request', () => {
  assert.strictEqual(dc.nextVersionName('FanOutPolicy_V2.0.docx', 'minor'), 'FanOutPolicy_V2.1.docx');
  assert.strictEqual(dc.nextVersionName('FanOutPolicy_V2.0.docx', 'major'), 'FanOutPolicy_V3.0.docx');
  assert.strictEqual(dc.nextVersionName('FanOutPolicy.docx', 'minor'), 'FanOutPolicy_V1.1.docx'); // bare = rev 1.0
});

// Fix 1: buildTaxonomy single-segment path
test('buildTaxonomy: a document folder directly under the root is kind=document', () => {
  const tree = dc.buildTaxonomy(['Documents/StandaloneDoc/StandaloneDoc.docx'], 'Documents');
  assert.strictEqual(tree[0].kind, 'document');
  assert.strictEqual(tree[0].current, 'StandaloneDoc.docx');
});

// Fix 2: isOverdue boundary — due today is not overdue
test('isOverdue: due today is not overdue', () => {
  assert.strictEqual(dc.isOverdue('2026-06-11', '2026-06-11'), false);
});

// Fix 3: groupDocumentFiles tie-break
test('groupDocumentFiles: equal-version-count tie resolves alphabetically by base', () => {
  const g = dc.groupDocumentFiles(['Beta.docx', 'Alpha.docx']);
  assert.strictEqual(g.current, 'Alpha.docx');
  assert.deepStrictEqual(g.attachments, ['Beta.docx']);
});

// Task 21 (v0.2): inline note-tag extraction
test('extractInlineTags pulls completed #tags, leaves trailing partial', () => {
  assert.deepStrictEqual(dc.extractInlineTags('Looks good #review next #urgent '),
    { body: 'Looks good next', tags: ['review','urgent'] });
  assert.deepStrictEqual(dc.extractInlineTags('no tags here'),
    { body: 'no tags here', tags: [] });
  // trailing partial (no space) is captured on flush=true
  assert.deepStrictEqual(dc.extractInlineTags('done #final', true),
    { body: 'done', tags: ['final'] });
});

// B1 (create-side): document base name + first version filename
test('documentBaseName: PascalCases the title and strips non-alphanumerics', () => {
  assert.strictEqual(dc.documentBaseName('Fan-Out Policy'), 'FanOutPolicy');
  assert.strictEqual(dc.documentBaseName('Code of Conduct'), 'CodeOfConduct');
  assert.strictEqual(dc.documentBaseName('Incident Reporting SOP'), 'IncidentReportingSOP'); // existing caps preserved
  assert.strictEqual(dc.documentBaseName('  Visitor   Screening  '), 'VisitorScreening');     // collapses whitespace
});
test('documentBaseName: punctuation-only / empty falls back to Document', () => {
  assert.strictEqual(dc.documentBaseName('!!!'), 'Document');
  assert.strictEqual(dc.documentBaseName(''), 'Document');
  assert.strictEqual(dc.documentBaseName('   '), 'Document');
});
test('documentBaseName: keeps digits, drops symbols mid-word', () => {
  assert.strictEqual(dc.documentBaseName('Q2 2026 Plan'), 'Q22026Plan');
  assert.strictEqual(dc.documentBaseName('A&B Report'), 'ABReport');
});
test('firstVersionName builds <base>_V1.0.<ext>', () => {
  assert.strictEqual(dc.firstVersionName('FanOutPolicy', 'docx'), 'FanOutPolicy_V1.0.docx');
  assert.strictEqual(dc.firstVersionName('Plan', 'xlsx'), 'Plan_V1.0.xlsx');
});

// Task 30 (v0.3): aggregate stakeholders across a project's documents
test('aggregateStakeholders groups by name+title across docs', () => {
  const docs = [
    { title:'HIRA', stakeholders:[{name:'P. Nicholson',title:'Mgr',role:'Originator'},{name:'',title:'COO',role:'Final Approver'}] },
    { title:'Self-Assessment', stakeholders:[{name:'P. Nicholson',title:'Mgr',role:'Reviewer'}] },
  ];
  const agg = dc.aggregateStakeholders(docs);
  const pn = agg.find(a => a.name === 'P. Nicholson' && a.title === 'Mgr');
  assert.deepStrictEqual(pn.roles.sort(), ['Originator','Reviewer']);
  assert.deepStrictEqual(pn.docs.sort(), ['HIRA','Self-Assessment']);
  assert.ok(agg.find(a => a.title === 'COO' && a.name === ''));   // unfilled groups by title
});

// ── _document.md migration (2026-06-17) ──────────────────────────────────────

// Task 1: ownership constants
test('key-ownership sets are disjoint except the intentional docId overlap', () => {
  assert.strictEqual(dc.DOCUMENT_MD_NAME, '_document.md');
  const docSet = new Set(dc.DOC_LEVEL_KEYS);
  const overlap = dc.VERSION_KEYS.filter(k => docSet.has(k));
  assert.deepStrictEqual(overlap, ['docId']);                      // only docId is shared
  assert.ok(dc.DOC_LEVEL_KEYS.includes('status'));
  assert.ok(dc.DOC_LEVEL_KEYS.includes('activityLog'));
  assert.ok(dc.VERSION_KEYS.includes('docx') && dc.VERSION_KEYS.includes('created'));
});

// Task 2: partitionFrontmatter
test('partitionFrontmatter splits a fat legacy sidecar by ownership', () => {
  const front = {
    docx: '[[FanOutPolicy_V2.0.docx]]', created: '2026-01-01', modified: '2026-02-01',
    title: 'Fan-Out Policy', status: 'Active', summary: 'x', tags: ['gov'],
    stakeholders: [{ name: 'J', role: 'Originator' }], activityLog: [{ type: 'create' }],
  };
  const { docLevel, versionLevel } = dc.partitionFrontmatter(front);
  assert.deepStrictEqual(Object.keys(docLevel).sort(),
    ['activityLog', 'stakeholders', 'status', 'summary', 'tags', 'title']);
  assert.deepStrictEqual(Object.keys(versionLevel).sort(), ['created', 'docx', 'modified']);
});
test('partitionFrontmatter keeps unknown keys on the version side (least-destructive)', () => {
  const { docLevel, versionLevel } = dc.partitionFrontmatter({ status: 'Draft', customThing: 42 });
  assert.deepStrictEqual(docLevel, { status: 'Draft' });
  assert.deepStrictEqual(versionLevel, { customThing: 42 });
});
test('partitionFrontmatter on empty input → empty partitions', () => {
  assert.deepStrictEqual(dc.partitionFrontmatter({}), { docLevel: {}, versionLevel: {} });
  assert.deepStrictEqual(dc.partitionFrontmatter(null), { docLevel: {}, versionLevel: {} });
});

// Task 3: buildFilesManifest + planReconcile
test('buildFilesManifest lists versions oldest→newest with current pinned', () => {
  const m = dc.buildFilesManifest(['FanOutPolicy_V2.0.docx', 'FanOutPolicy.docx', 'notes.txt']);
  assert.deepStrictEqual(m.files, ['FanOutPolicy.docx', 'FanOutPolicy_V2.0.docx']); // chronological
  assert.strictEqual(m.currentVersion, 'FanOutPolicy_V2.0.docx');                   // attachment excluded
});

test('planReconcile: idempotent — skips a folder that already has _document.md', () => {
  assert.deepStrictEqual(dc.planReconcile({ folderFiles: ['A.docx'], hasDocumentMd: true }), { skip: true });
});

test('planReconcile: single version lifts doc-level keys, slims the sidecar', () => {
  const plan = dc.planReconcile({
    folderFiles: ['FanOutPolicy_V1.0.docx'],
    sidecarFronts: {
      'FanOutPolicy_V1.0.docx.md': {
        docx: '[[FanOutPolicy_V1.0.docx]]', created: '2026-01-01',
        title: 'Fan-Out Policy', status: 'Active', tags: ['gov'],
      },
    },
  });
  assert.strictEqual(plan.skip, false);
  assert.strictEqual(plan.needsDocId, true);
  assert.deepStrictEqual(plan.createDocumentMd.docLevelKeys,
    { title: 'Fan-Out Policy', status: 'Active', tags: ['gov'] });
  assert.deepStrictEqual(plan.createDocumentMd.files, ['FanOutPolicy_V1.0.docx']);
  assert.strictEqual(plan.createDocumentMd.currentVersion, 'FanOutPolicy_V1.0.docx');
  assert.deepStrictEqual(plan.sidecarRewrites,
    [{ name: 'FanOutPolicy_V1.0.docx.md', dropKeys: ['title', 'status', 'tags'] }]);
});

test('planReconcile: current version wins, divergence on older sidecar is noted', () => {
  const plan = dc.planReconcile({
    folderFiles: ['Plan_V1.0.docx', 'Plan_V2.0.docx'],
    sidecarFronts: {
      'Plan_V2.0.docx.md': { title: 'Plan', status: 'Active' },   // current
      'Plan_V1.0.docx.md': { title: 'Plan', status: 'Draft' },    // older, divergent status
    },
  });
  assert.strictEqual(plan.createDocumentMd.docLevelKeys.status, 'Active');  // current wins
  assert.ok(plan.notes.some(n => /Divergent status/.test(n) && /Plan_V1\.0/.test(n)));
  // both sidecars get slimmed
  assert.strictEqual(plan.sidecarRewrites.length, 2);
});

test('planReconcile: folder with no sidecars still gets manifest + docId', () => {
  const plan = dc.planReconcile({ folderFiles: ['Standalone.docx'], sidecarFronts: {} });
  assert.strictEqual(plan.skip, false);
  assert.strictEqual(plan.needsDocId, true);
  assert.deepStrictEqual(plan.createDocumentMd.docLevelKeys, {});
  assert.deepStrictEqual(plan.createDocumentMd.files, ['Standalone.docx']);
  assert.deepStrictEqual(plan.sidecarRewrites, []);
  assert.ok(plan.notes.some(n => /No sidecar metadata/.test(n)));
});

test('planReconcile: never drops the docId backref from a sidecar', () => {
  const plan = dc.planReconcile({
    folderFiles: ['A_V1.0.docx'],
    sidecarFronts: { 'A_V1.0.docx.md': { docId: 'abc123', status: 'Draft', docx: '[[A_V1.0.docx]]' } },
  });
  const rw = plan.sidecarRewrites.find(r => r.name === 'A_V1.0.docx.md');
  assert.ok(!rw.dropKeys.includes('docId'));   // backref preserved
  assert.ok(rw.dropKeys.includes('status'));
});

// ── Authorship + check-out (2026-06-19 plan) ───────────────────────────────────

test('slugifyAuthor: lowercases and dash-joins, strips junk', () => {
  assert.strictEqual(dc.slugifyAuthor('Jane Smith'), 'jane-smith');
  assert.strictEqual(dc.slugifyAuthor('PAUL.C'), 'paul-c');
  assert.strictEqual(dc.slugifyAuthor('  --weird__name!! '), 'weird-name');
  assert.strictEqual(dc.slugifyAuthor(''), 'unknown');
  assert.strictEqual(dc.slugifyAuthor(null), 'unknown');
});

test('formatLogEntry: builds a parseable markdown line, optional detail in parens', () => {
  assert.strictEqual(
    dc.formatLogEntry({ datetime: '2026-06-19 14:30', actor: 'jsmith', action: 'checked out' }),
    '- 2026-06-19 14:30 · jsmith · checked out');
  assert.strictEqual(
    dc.formatLogEntry({ datetime: '2026-06-19 15:20', actor: 'paul', action: 'fork saved', detail: 'base FanOutPolicy_V2.0.docx' }),
    '- 2026-06-19 15:20 · paul · fork saved (base FanOutPolicy_V2.0.docx)');
});

test('parseLogBody: round-trips formatted lines, ignores non-entry lines', () => {
  const body = [
    '---', 'docContainer: log', '---', '# Activity log', '',
    '- 2026-06-19 14:30 · jsmith · checked out',
    '- 2026-06-19 15:20 · paul · fork saved (base X_V2.0.docx)',
  ].join('\n');
  assert.deepStrictEqual(dc.parseLogBody(body), [
    { datetime: '2026-06-19 14:30', actor: 'jsmith', action: 'checked out' },
    { datetime: '2026-06-19 15:20', actor: 'paul', action: 'fork saved (base X_V2.0.docx)' },
  ]);
});

test('lockStateFromFront: reads lock fields, computes staleness against timeout', () => {
  assert.deepStrictEqual(dc.lockStateFromFront({}, '2026-06-19T15:00:00.000Z', 0),
    { by: null, at: null, stale: false });
  assert.deepStrictEqual(
    dc.lockStateFromFront({ checkedOutBy: 'jsmith', checkedOutAt: '2026-06-19T14:00:00.000Z' }, '2026-06-19T15:00:00.000Z', 0),
    { by: 'jsmith', at: '2026-06-19T14:00:00.000Z', stale: false });
  assert.strictEqual(
    dc.lockStateFromFront({ checkedOutBy: 'jsmith', checkedOutAt: '2026-06-19T10:00:00.000Z' }, '2026-06-19T15:00:00.000Z', 2).stale,
    true);
});

test('forkFileName: base_fork_<slug>_<date>.<ext>, strips version', () => {
  assert.strictEqual(dc.forkFileName('FanOutPolicy_V2.0.docx', 'paul', '20260619'),
    'FanOutPolicy_fork_paul_20260619.docx');
  assert.strictEqual(dc.forkFileName('Plan.pptx', 'jsmith', '20260101'),
    'Plan_fork_jsmith_20260101.pptx');
});

test('isPendingFork: true only when forkOf set and not reconciled', () => {
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a', reconciled: false }), true);
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a' }), true);          // missing = pending
  assert.strictEqual(dc.isPendingFork({ forkOf: '7f3a', reconciled: true }), false);
  assert.strictEqual(dc.isPendingFork({}), false);
});

// edit-gate decision table
test('editGateDecision: non-managed file is always editable', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: false }),
    { editable: true, state: 'unmanaged' });
});
test('editGateDecision: managed old version is read-only history', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: false, heldByMe: true, heldByOther: false }),
    { editable: false, state: 'old-version' });
});
test('editGateDecision: current held by me is editable', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: true, heldByOther: false }),
    { editable: true, state: 'held-by-me' });
});
test('editGateDecision: current held by other is read-only', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: false, heldByOther: true }),
    { editable: false, state: 'held-by-other' });
});
test('editGateDecision: current unlocked is read-only (must check out)', () => {
  assert.deepStrictEqual(dc.editGateDecision({ managed: true, current: true, heldByMe: false, heldByOther: false }),
    { editable: false, state: 'unlocked' });
});

// Related-doc lifecycle: collision-free folder name
test('dedupeName returns desired when free', () => {
  assert.equal(dc.dedupeName('Minutes', ['A', 'B']), 'Minutes');
});
test('dedupeName suffixes on collision', () => {
  assert.equal(dc.dedupeName('Minutes', ['Minutes']), 'Minutes (2)');
});
test('dedupeName finds next free suffix', () => {
  assert.equal(dc.dedupeName('Minutes', ['Minutes', 'Minutes (2)']), 'Minutes (3)');
});

// Related-doc lifecycle: a bare loose file must never outrank an explicit _V version
test('groupDocumentFiles: bare loose file never hijacks current from an explicit _V version', () => {
  const g = dc.groupDocumentFiles(['FanOutPolicy_V1.0.docx', 'Agenda.docx']);
  assert.equal(g.current, 'FanOutPolicy_V1.0.docx');
  assert.ok(g.attachments.includes('Agenda.docx'));
});
test('groupDocumentFiles: lexicographic tie-break still applies among explicit versions', () => {
  const g = dc.groupDocumentFiles(['Zebra_V1.0.docx', 'Alpha_V1.0.docx']);
  assert.equal(g.current, 'Alpha_V1.0.docx');
});

// ── Container-notes: note body detection + skeleton extraction ───────────────
test('isNoteBody: matches .cnote only', () => {
  assert.ok(dc.isNoteBody('body.cnote'));
  assert.ok(dc.isNoteBody('BODY.CNOTE'));
  assert.ok(!dc.isNoteBody('body.md'));
  assert.ok(!dc.isNoteBody('Plan.docx'));
});

test('extractNoteSkeleton: title from first H1', () => {
  const r = dc.extractNoteSkeleton('# Shift Notes\n\nBody text');
  assert.strictEqual(r.title, 'Shift Notes');
});

test('extractNoteSkeleton: no H1 gives null title', () => {
  assert.strictEqual(dc.extractNoteSkeleton('just text, no heading').title, null);
});

test('extractNoteSkeleton: inline tags deduped, no leading #', () => {
  const r = dc.extractNoteSkeleton('# T\nsaw #incident near #lobby, filed #incident');
  assert.deepStrictEqual(r.tags, ['incident', 'lobby']);
});

test('extractNoteSkeleton: headings and numbers are not tags', () => {
  const r = dc.extractNoteSkeleton('# Title\n## Section\nitem #1 and #2026');
  assert.deepStrictEqual(r.tags, []);
});

test('extractNoteSkeleton: wikilinks captured; alias and subpath stripped; deduped', () => {
  const r = dc.extractNoteSkeleton(
    'see [[Fan-Out Policy|the policy]] and [[HIRA#Methods]] and [[Fan-Out Policy]]');
  assert.deepStrictEqual(r.links, ['[[Fan-Out Policy]]', '[[HIRA]]']);
});

test('extractNoteSkeleton: empty/absent input is safe', () => {
  assert.deepStrictEqual(dc.extractNoteSkeleton(''), { title: null, tags: [], links: [] });
  assert.deepStrictEqual(dc.extractNoteSkeleton(null), { title: null, tags: [], links: [] });
});

// ── Container-notes: taxonomy detection ──────────────────────────────────────
test('buildTaxonomy: note folder (body.cnote, no office file) becomes a note node', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Notes/Shift Notes/body.cnote',
     'Documents/Notes/Shift Notes/_document.md'], 'Documents');
  const cat = tree.find(n => n.name === 'Notes');
  assert.ok(cat, 'Notes category exists');
  const note = cat.children.find(n => n.name === 'Shift Notes');
  assert.strictEqual(note.kind, 'note');
  assert.strictEqual(note.noteBody, 'body.cnote');
  assert.strictEqual(note.path, 'Documents/Notes/Shift Notes');
});

test('buildTaxonomy: office file wins - folder with both stays a document', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/G/Doc1/Plan_V1.0.docx',
     'Documents/G/Doc1/body.cnote'], 'Documents');
  const doc = tree.find(n => n.name === 'G').children.find(n => n.name === 'Doc1');
  assert.strictEqual(doc.kind, 'document');
  assert.ok(doc.attachments.includes('body.cnote'));
});

test('buildTaxonomy: plain .md files still never create nodes', () => {
  const tree = dc.buildTaxonomy(['Documents/Notes/loose.md'], 'Documents');
  assert.deepStrictEqual(tree, []);
});

test('buildTaxonomy: note node has empty children', () => {
  const tree = dc.buildTaxonomy(['Documents/Notes/N1/body.cnote'], 'Documents');
  const note = tree.find(n => n.name === 'Notes').children.find(n => n.name === 'N1');
  assert.deepStrictEqual(note.children, []);
});

test('buildTaxonomy: note folder directly under root', () => {
  const tree = dc.buildTaxonomy(['Documents/QuickNote/body.cnote'], 'Documents');
  const note = tree.find(n => n.name === 'QuickNote');
  assert.strictEqual(note.kind, 'note');
  assert.strictEqual(note.noteBody, 'body.cnote');
});

test('buildTaxonomy: note folder three levels deep keeps category/collection ancestors', () => {
  const tree = dc.buildTaxonomy(['Documents/Cat/Coll/Deep Note/body.cnote'], 'Documents');
  const cat = tree.find(n => n.name === 'Cat');
  assert.strictEqual(cat.kind, 'category');
  const coll = cat.children.find(n => n.name === 'Coll');
  assert.strictEqual(coll.kind, 'collection');
  const note = coll.children.find(n => n.name === 'Deep Note');
  assert.strictEqual(note.kind, 'note');
});

// ── Container-notes hybrid card: types + link union ──────────────────────────
test('noteShowsPeople: true only for Meeting/Decision/Incident', () => {
  assert.ok(dc.noteShowsPeople('Meeting'));
  assert.ok(dc.noteShowsPeople('Decision'));
  assert.ok(dc.noteShowsPeople('Incident'));
  assert.ok(!dc.noteShowsPeople('General'));
});

test('noteShowsPeople: absent/unknown types are false', () => {
  assert.ok(!dc.noteShowsPeople(undefined));
  assert.ok(!dc.noteShowsPeople(null));
  assert.ok(!dc.noteShowsPeople('Banana'));
});

test('note type constant lists are exact', () => {
  assert.deepStrictEqual(dc.NOTE_TYPES, ['General', 'Meeting', 'Decision', 'Incident']);
  assert.deepStrictEqual(dc.NOTE_PEOPLE_TYPES, ['Meeting', 'Decision', 'Incident']);
  assert.deepStrictEqual(dc.PERSON_TYPES,
    ['Complainant', 'Subject', 'Victim', 'Witness', 'Stakeholder', 'User', 'Staff', 'Attendee']);
});

test('mergeNoteLinks: body order first, parent links appended, deduped', () => {
  assert.deepStrictEqual(
    dc.mergeNoteLinks(['[[A]]', '[[B]]'], ['[[B]]', '[[C]]']),
    ['[[A]]', '[[B]]', '[[C]]']);
});

test('mergeNoteLinks: empty and null inputs are safe', () => {
  assert.deepStrictEqual(dc.mergeNoteLinks([], []), []);
  assert.deepStrictEqual(dc.mergeNoteLinks(null, ['[[P]]']), ['[[P]]']);
  assert.deepStrictEqual(dc.mergeNoteLinks(['[[A]]'], null), ['[[A]]']);
});

test('mergeNoteLinks: dedupes within a single source too', () => {
  assert.deepStrictEqual(dc.mergeNoteLinks(['[[A]]', '[[A]]'], null), ['[[A]]']);
});

test('mergeNoteLinks: skips empty strings', () => {
  assert.deepStrictEqual(dc.mergeNoteLinks(['', '[[A]]'], ['']), ['[[A]]']);
});

// 2026-07-16: pending documents (upload-first-version design)
test('buildTaxonomy: folder with only a _V sidecar is a pending document', () => {
  const tree = dc.buildTaxonomy(['Documents/Gov/Policy/Policy_V1.0.md'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.pending, 'Policy_V1.0.md');
  assert.strictEqual(doc.current, null);
  assert.deepStrictEqual(doc.files, []);
});

test('buildTaxonomy: ext-named pending sidecar (half-completed attach) still pending', () => {
  const tree = dc.buildTaxonomy(['Documents/Gov/Policy/Policy_V1.0.docx.md'], 'Documents');
  assert.strictEqual(tree[0].children[0].pending, 'Policy_V1.0.docx.md');
});

test('buildTaxonomy: office file wins over pending sidecar (normal document)', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Gov/Policy/Policy_V1.0.docx', 'Documents/Gov/Policy/Policy_V1.0.docx.md'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.current, 'Policy_V1.0.docx');
  assert.strictEqual(doc.pending, undefined);
});

test('buildTaxonomy: cnote body wins over pending sidecar (note container)', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Notes/Idea/body.cnote', 'Documents/Notes/Idea/Idea_V1.0.md'], 'Documents');
  assert.strictEqual(tree[0].children[0].kind, 'note');
});

test('buildTaxonomy: plain sidecars do NOT create a pending document', () => {
  assert.deepStrictEqual(dc.buildTaxonomy(['Documents/Gov/Policy/notes.md'], 'Documents'), []);
});

test('buildTaxonomy: stray files in a pending folder become attachments', () => {
  const tree = dc.buildTaxonomy(
    ['Documents/Gov/Policy/Policy_V1.0.md', 'Documents/Gov/Policy/scan.png'], 'Documents');
  const doc = tree[0].children[0];
  assert.strictEqual(doc.pending, 'Policy_V1.0.md');
  assert.deepStrictEqual(doc.attachments, ['scan.png']);
});

// ── Organizations & Sites (2026-07-31 spec) ─────────────────────────────────

test('entityNoteName: folder note is named after its folder', () => {
  assert.strictEqual(dc.entityNoteName('Baycrest'), 'Baycrest.md');
});

test('ORG_FIELDS/SITE_FIELDS expose the documented keys', () => {
  const orgKeys = dc.ORG_FIELDS.map(f => f.key);
  assert.deepStrictEqual(orgKeys,
    ['name','orgType','status','relationship','website','address','summary','tags']);
  const siteKeys = dc.SITE_FIELDS.map(f => f.key);
  assert.deepStrictEqual(siteKeys,
    ['name','organization','siteType','siteCode','address','city','province','postalCode','lat','lon','geocodedAt','geocodeSource','status','summary','tags']);
  assert.ok(!orgKeys.includes('phone'), 'phone belongs to Contacts, not the org record');
});

test('entityLink / entityLinkName round-trip', () => {
  assert.strictEqual(dc.entityLink('Baycrest'), '[[Baycrest]]');
  assert.strictEqual(dc.entityLinkName('[[Baycrest]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('[[Baycrest|BC]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('[[Baycrest#Sites]]'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName('Baycrest'), 'Baycrest');
  assert.strictEqual(dc.entityLinkName(''), null);
  assert.strictEqual(dc.entityLinkName(null), null);
});

test('buildTaxonomy: an entity folder becomes a leaf of its own kind', () => {
  const paths = ['Documents/Organizations/Baycrest/Baycrest.md'];
  const ents = new Map([['Documents/Organizations/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const cat = tree.find(n => n.name === 'Organizations');
  assert.strictEqual(cat.kind, 'category');
  const org = cat.children.find(n => n.name === 'Baycrest');
  assert.strictEqual(org.kind, 'organization');
  assert.strictEqual(org.entityType, 'organization');
  assert.strictEqual(org.current, null);
});

test('buildTaxonomy: a site folder becomes a site leaf (plain-object map accepted)', () => {
  const paths = ['Documents/Sites/Apotex Centre/Apotex Centre.md'];
  const ents = { 'Documents/Sites/Apotex Centre': 'site' };
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const site = tree.find(n => n.name === 'Sites').children[0];
  assert.strictEqual(site.kind, 'site');
});

test('buildTaxonomy: an entity that owns notes keeps its kind (override beats collection)', () => {
  const paths = [
    'Documents/Organizations/Baycrest/Baycrest.md',
    'Documents/Organizations/Baycrest/Vendor review/body.cnote',
    'Documents/Organizations/Baycrest/Vendor review/_document.md',
  ];
  const ents = new Map([['Documents/Organizations/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  const org = tree.find(n => n.name === 'Organizations').children.find(n => n.name === 'Baycrest');
  assert.strictEqual(org.kind, 'organization', 'note child must not demote the org to a collection');
  const note = org.children.find(n => n.name === 'Vendor review');
  assert.strictEqual(note.kind, 'note');
});

test('buildTaxonomy: entityFolders outside the root are ignored', () => {
  const paths = ['Documents/Governance/Policy/Fan-Out/FanOut_V1.0.docx'];
  const ents = new Map([['Elsewhere/Baycrest', 'organization']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  assert.strictEqual(tree.length, 1);
  assert.strictEqual(tree[0].name, 'Governance');
});

test('buildTaxonomy: an unknown entity kind is ignored, not stamped', () => {
  const paths = ['Documents/Organizations/Baycrest/Baycrest.md'];
  const ents = new Map([['Documents/Organizations/Baycrest', 'wharf']]);
  const tree = dc.buildTaxonomy(paths, 'Documents', ents);
  assert.strictEqual(tree.length, 0, 'a folder holding only a sidecar is not a leaf on its own');
});

test('buildTaxonomy: two-argument calls behave exactly as before', () => {
  const paths = ['Documents/Governance/Policy/Fan-Out/FanOut_V1.0.docx'];
  const tree = dc.buildTaxonomy(paths, 'Documents');
  const doc = tree[0].children[0].children[0];
  assert.strictEqual(doc.kind, 'document');
  assert.strictEqual(doc.current, 'FanOut_V1.0.docx');
});

test('DOC_FIELDS carries the organization and sites stamp fields', () => {
  const byKey = {}; for (const f of dc.DOC_FIELDS.phase1) byKey[f.key] = f;
  assert.strictEqual(byKey.organization.type, 'entity');
  assert.strictEqual(byKey.sites.type, 'entities');
});

test('organization and sites are document-level keys, not version keys', () => {
  assert.ok(dc.DOC_LEVEL_KEYS.includes('organization'));
  assert.ok(dc.DOC_LEVEL_KEYS.includes('sites'));
  const part = dc.partitionFrontmatter({ organization: '[[Baycrest]]', sites: ['[[Terraces]]'], created: 'x' });
  assert.deepStrictEqual(Object.keys(part.docLevel).sort(), ['organization', 'sites']);
  assert.deepStrictEqual(Object.keys(part.versionLevel), ['created']);
});

test('parseEntityListInput: names to link strings, deduped, empties dropped', () => {
  assert.deepStrictEqual(dc.parseEntityListInput('Apotex Centre, Terraces'),
    ['[[Apotex Centre]]', '[[Terraces]]']);
  assert.deepStrictEqual(dc.parseEntityListInput('[[Apotex Centre]], Apotex Centre'),
    ['[[Apotex Centre]]']);
  assert.deepStrictEqual(dc.parseEntityListInput('  '), []);
  assert.deepStrictEqual(dc.parseEntityListInput(null), []);
});

test('underEntityCategory: true inside the entity categories, false elsewhere', () => {
  const cats = ['Organizations', 'Sites'];
  assert.strictEqual(dc.underEntityCategory('Documents/Organizations/Baycrest', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Sites/Terraces/Sub', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Organizations', 'Documents', cats), true);
  assert.strictEqual(dc.underEntityCategory('Documents/Governance/Policy', 'Documents', cats), false);
  assert.strictEqual(dc.underEntityCategory('Documents/OrganizationsExtra/X', 'Documents', cats), false);
  assert.strictEqual(dc.underEntityCategory('', 'Documents', cats), false);
});

// 2026-08-03: site geolocation — coordinate helpers
test('formatCoord: rounds to 6 decimal places', () => {
  assert.strictEqual(dc.formatCoord(43.72911234), '43.729112');
  assert.strictEqual(dc.formatCoord(-79.4394), '-79.439400');
  assert.strictEqual(dc.formatCoord(0), '0.000000');
});

test('formatCoord: null for non-finite or non-numeric', () => {
  assert.strictEqual(dc.formatCoord(NaN), null);
  assert.strictEqual(dc.formatCoord(Infinity), null);
  assert.strictEqual(dc.formatCoord(-Infinity), null);
  assert.strictEqual(dc.formatCoord('abc'), null);
  assert.strictEqual(dc.formatCoord(null), null);
  assert.strictEqual(dc.formatCoord(undefined), null);
});

test('parseCoord: accepts numbers and numeric strings, rejects junk', () => {
  assert.strictEqual(dc.parseCoord(43.729112), 43.729112);
  assert.strictEqual(dc.parseCoord('43.729112'), 43.729112);
  assert.strictEqual(dc.parseCoord('  -79.4394 '), -79.4394);
  assert.strictEqual(dc.parseCoord(''), null);
  assert.strictEqual(dc.parseCoord('north'), null);
  assert.strictEqual(dc.parseCoord(null), null);
});

test('siteCoord: returns a pair only when BOTH lat and lon parse', () => {
  assert.deepStrictEqual(dc.siteCoord({ lat: '43.729112', lon: '-79.439400' }),
    { lat: 43.729112, lon: -79.4394 });
  assert.strictEqual(dc.siteCoord({ lat: '43.729112' }), null);
  assert.strictEqual(dc.siteCoord({ lon: '-79.4394' }), null);
  assert.strictEqual(dc.siteCoord({ lat: 'x', lon: 'y' }), null);
  assert.strictEqual(dc.siteCoord({}), null);
});

test('haversineKm: Baycrest to downtown Toronto is about 9 km', () => {
  const baycrest = { lat: 43.729112, lon: -79.439400 };
  const downtown = { lat: 43.653226, lon: -79.383184 };
  const d = dc.haversineKm(baycrest, downtown);
  assert.ok(d > 8 && d < 10, `expected 8-10 km, got ${d}`);
});

test('haversineKm: zero for identical points, and symmetric', () => {
  const a = { lat: 43.729112, lon: -79.4394 };
  const b = { lat: 45.4215, lon: -75.6972 };
  assert.strictEqual(dc.haversineKm(a, a), 0);
  assert.ok(Math.abs(dc.haversineKm(a, b) - dc.haversineKm(b, a)) < 1e-9);
});

test('haversineKm: handles sign changes across equator and meridian', () => {
  const d = dc.haversineKm({ lat: -1, lon: -1 }, { lat: 1, lon: 1 });
  assert.ok(d > 310 && d < 320, `expected ~314 km, got ${d}`);
});

test('SITE_FIELDS carries lat, lon, geocodedAt and geocodeSource as text', () => {
  const byKey = {}; for (const f of dc.SITE_FIELDS) byKey[f.key] = f;
  for (const k of ['lat', 'lon', 'geocodedAt', 'geocodeSource']) {
    assert.ok(byKey[k], `missing SITE_FIELDS entry: ${k}`);
    assert.strictEqual(byKey[k].type, 'text', `${k} should be text so it stays manually editable`);
  }
});

// 2026-08-03: site geolocation — Nominatim jsonv2 parsing
const NOMINATIM_FULL = [{
  lat: '43.7291123', lon: '-79.4394002',
  display_name: '3560, Bathurst Street, North York, Toronto, Ontario, M6A 2E1, Canada',
  address: {
    house_number: '3560', road: 'Bathurst Street', suburb: 'North York',
    city: 'Toronto', state: 'Ontario', postcode: 'M6A 2E1',
    country: 'Canada', country_code: 'ca',
  },
}];

test('parseGeocodeResults: maps a full match to flat fields', () => {
  const r = dc.parseGeocodeResults(NOMINATIM_FULL);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].address, '3560 Bathurst Street');
  assert.strictEqual(r[0].city, 'Toronto');
  assert.strictEqual(r[0].province, 'Ontario');
  assert.strictEqual(r[0].postalCode, 'M6A 2E1');
  assert.strictEqual(r[0].lat, '43.729112');
  assert.strictEqual(r[0].lon, '-79.439400');
  assert.ok(r[0].display.startsWith('3560, Bathurst Street'));
});

test('parseGeocodeResults: missing postcode yields empty string, not undefined', () => {
  const r = dc.parseGeocodeResults([{
    lat: '43.7', lon: '-79.4', display_name: 'Somewhere, Ontario, Canada',
    address: { road: 'Some Road', city: 'Toronto', state: 'Ontario' },
  }]);
  assert.strictEqual(r[0].postalCode, '');
  assert.strictEqual(r[0].address, 'Some Road');
});

test('parseGeocodeResults: falls back through town and village for city', () => {
  const town = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', town: 'Aurora', state: 'Ontario' },
  }]);
  assert.strictEqual(town[0].city, 'Aurora');

  const village = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', village: 'Elora', state: 'Ontario' },
  }]);
  assert.strictEqual(village[0].city, 'Elora');

  const muni = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', municipality: 'Chatham-Kent', state: 'Ontario' },
  }]);
  assert.strictEqual(muni[0].city, 'Chatham-Kent');
});

test('parseGeocodeResults: with no house_number or road, uses the first display_name segment', () => {
  const r = dc.parseGeocodeResults([{
    lat: '43.6', lon: '-79.3', display_name: 'Baycrest Hospital, Bathurst Street, Toronto, Canada',
    address: { city: 'Toronto', state: 'Ontario' },
  }]);
  assert.strictEqual(r[0].address, 'Baycrest Hospital');
});

test('parseGeocodeResults: empty array in, empty array out', () => {
  assert.deepStrictEqual(dc.parseGeocodeResults([]), []);
});

test('parseGeocodeResults: malformed input never throws', () => {
  for (const bad of [null, undefined, 'not json', 42, {}, [null], [{}], [{ lat: 'x', lon: 'y' }]]) {
    assert.deepStrictEqual(dc.parseGeocodeResults(bad), [], `should be [] for ${JSON.stringify(bad)}`);
  }
});

test('parseGeocodeResults: drops entries whose coordinates do not parse', () => {
  const r = dc.parseGeocodeResults([
    { lat: 'nope', lon: '-79.4', display_name: 'bad', address: {} },
    NOMINATIM_FULL[0],
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].city, 'Toronto');
});

// 2026-08-04: entity notes — merged feed
const FEED_SRC = [
  { origin: 'This organization', originKind: 'self', originPath: 'Documents/Organizations/Acme',
    entries: [{ date: '2026-08-01', author: 'paul', body: 'kickoff', noteTags: ['meeting'], attachments: [] }] },
  { origin: 'Terraces', originKind: 'site', originPath: 'Documents/Sites/Terraces',
    entries: [{ date: '2026-08-03', author: 'paul', body: 'site walk', noteTags: [], attachments: ['x.pdf'] }] },
  { origin: 'Fan-Out Policy', originKind: 'work', originPath: 'Documents/Governance/Fan-Out Policy',
    entries: [{ date: '2026-07-20', author: 'sam', body: 'reviewed', noteTags: [], attachments: [] }] },
];

test('mergeNoteFeed: newest first across sources', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.deepStrictEqual(r.map(x => x.date), ['2026-08-03', '2026-08-01', '2026-07-20']);
});

test('mergeNoteFeed: stamps origin on every row', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(r[0].origin, 'Terraces');
  assert.strictEqual(r[0].originKind, 'site');
  assert.strictEqual(r[0].originPath, 'Documents/Sites/Terraces');
  assert.ok(r.every(x => x.origin && x.originKind));
});

test('mergeNoteFeed: preserves entry fields', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(r[1].body, 'kickoff');
  assert.deepStrictEqual(r[1].noteTags, ['meeting']);
  assert.deepStrictEqual(r[0].attachments, ['x.pdf']);
});

test('mergeNoteFeed: passes through noteKind and noteSource when present', () => {
  const r = dc.mergeNoteFeed([{ origin: 'x', originKind: 'page', originPath: 'p',
    entries: [{ date: '2026-08-01', body: 'note page', noteKind: 'Mention', noteSource: 'Fan-Out Policy' }] }]);
  assert.strictEqual(r[0].noteKind, 'Mention');
  assert.strictEqual(r[0].noteSource, 'Fan-Out Policy');
});

test('mergeNoteFeed: noteKind and noteSource default to empty string when absent', () => {
  const r = dc.mergeNoteFeed(FEED_SRC);
  assert.ok(r.every(x => x.noteKind === '' && x.noteSource === ''));
});

test('mergeNoteFeed: ties break by origin name, so order is stable', () => {
  const same = [
    { origin: 'Zulu',  originKind: 'site', originPath: 'z', entries: [{ date: '2026-08-01', body: 'z' }] },
    { origin: 'Alpha', originKind: 'site', originPath: 'a', entries: [{ date: '2026-08-01', body: 'a' }] },
  ];
  assert.deepStrictEqual(dc.mergeNoteFeed(same).map(x => x.origin), ['Alpha', 'Zulu']);
  assert.deepStrictEqual(dc.mergeNoteFeed(same.slice().reverse()).map(x => x.origin), ['Alpha', 'Zulu']);
});

test('mergeNoteFeed: sources with no entries are skipped, never throw', () => {
  assert.deepStrictEqual(dc.mergeNoteFeed([]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed(null), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x', entries: null }]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x' }]), []);
  assert.deepStrictEqual(dc.mergeNoteFeed([{ origin: 'x', entries: 'nope' }]), []);
});

test('mergeNoteFeed: malformed entries do not throw and keep safe defaults', () => {
  const r = dc.mergeNoteFeed([{ origin: 'x', originKind: 'self', originPath: 'p',
    entries: [null, 'string', { body: 'no date' }] }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].body, 'no date');
  assert.strictEqual(r[0].date, '');
  assert.deepStrictEqual(r[0].noteTags, []);
});

test('filterNoteFeed: text matches body, author and tags, case-insensitively', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'SITE' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'sam' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'meeting' }).length, 1);
});

test('filterNoteFeed: all terms must match (AND), and # is ignored', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: '#meeting' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'kickoff meeting' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'kickoff nomatch' }).length, 0);
});

test('filterNoteFeed: date range is inclusive at both ends', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { from: '2026-08-01', to: '2026-08-03' }).length, 2);
  assert.strictEqual(dc.filterNoteFeed(rows, { from: '2026-08-03' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { to: '2026-07-20' }).length, 1);
});

test('filterNoteFeed: text and dates intersect', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'walk', from: '2026-08-02' }).length, 1);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'walk', to: '2026-07-01' }).length, 0);
});

test('filterNoteFeed: empty criteria returns everything; bad input returns []', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, {}).length, 3);
  assert.strictEqual(dc.filterNoteFeed(rows).length, 3);
  assert.deepStrictEqual(dc.filterNoteFeed(null, { text: 'x' }), []);
});

test('filterNoteFeed: searching also matches the origin label', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed(rows, { text: 'terraces' }).length, 1);
});

test('filterNoteFeed: malformed rows are dropped, never throw', () => {
  const rows = dc.mergeNoteFeed(FEED_SRC);
  assert.strictEqual(dc.filterNoteFeed([null, 'oops', 5, undefined], { text: 'x' }).length, 0);
  assert.strictEqual(dc.filterNoteFeed(rows.concat([null, 42]), {}).length, rows.length);
});
