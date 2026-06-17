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
    ['title','docNumber','docClass','revision','status','department','originator','originationDate','effectiveDate','reviewFrequencyDays','nextReviewDate','summary','tags']);
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
