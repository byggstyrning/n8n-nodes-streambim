// Unit tests for document links by property value. Run with `pnpm test`.
// All fixtures are synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	base64Url,
	documentLinkBody,
	groupPropertyValues,
	indexDocumentsByStem,
	linkTargetObjectId,
	matchDocument,
	parseExtensions,
	parsePropertyRef,
	planPropertyLink,
	toExistingLink,
	toLinkDocument,
	virtualObjectId,
} = require('../dist/nodes/shared/streamBimPropertyLinks');

const REF = { psetName: 'Text', propertyName: 'Sheet Number' };

const docRow = (id, filename, extra = {}) => ({
	id: String(id),
	type: 'documents',
	attributes: { filename, path: 'SOURCE/Drawings', revision: 3, 'is-deleted': false, 'deleted-date': null, ...extra },
});
const attachmentRow = (id, documentId, deleted = false) => ({
	id: String(id),
	type: 'attachments',
	attributes: { filename: `${documentId}.pdf`, 'is-deleted': deleted, 'deleted-at': deleted ? '2026-01-01T00:00:00Z' : null },
	relationships: { 'linked-document': { data: documentId === null ? null : { id: String(documentId), type: 'documents' } } },
});
const group = (value) => groupPropertyValues([{ buildingId: '1000', value }], REF, 'str')[0];
const index = (...rows) => indexDocumentsByStem(rows.map(toLinkDocument), ['pdf']);
const OPTS = { relinkRemoved: false, removeDeleted: true };

test('parsePropertyRef accepts dot and tilde, rejects a bare name', () => {
	assert.deepEqual(parsePropertyRef('Text.Sheet Number'), REF);
	assert.deepEqual(parsePropertyRef(' Text~Sheet Number '), REF);
	assert.deepEqual(parsePropertyRef('Pset_Custom.Code.Part'), { psetName: 'Pset_Custom', propertyName: 'Code.Part' });
	assert.equal(parsePropertyRef('Sheet Number'), undefined);
	assert.equal(parsePropertyRef('.Sheet Number'), undefined);
	assert.equal(parsePropertyRef('Text.'), undefined);
});

test('virtual object id is unpadded base64url of the UTF-8 key', () => {
	assert.equal(
		virtualObjectId(REF, 'str', 'A-101'),
		Buffer.from('ifcelement~Text~Sheet Number~str~A-101').toString('base64url'),
	);
	// "+" and "/" in standard base64 become "-" and "_"; no "=" padding.
	const id = base64Url('ifcelement~Text~Sheet Number~str~Ritning på plan 2 ?>>');
	assert.equal(id, Buffer.from('ifcelement~Text~Sheet Number~str~Ritning på plan 2 ?>>').toString('base64url'));
	assert.doesNotMatch(id, /[+/=]/);
});

test('groupPropertyValues groups across buildings and drops empty values', () => {
	const groups = groupPropertyValues(
		[
			{ buildingId: '1000', guid: 'g1', value: 'A-102' },
			{ buildingId: '1000', guid: 'g2', value: 'A-101' },
			{ buildingId: '1001', guid: 'g3', value: 'A-101' },
			{ buildingId: '1000', guid: 'g4', value: '' },
			{ buildingId: '1000', guid: 'g5', value: '  ' },
			{ buildingId: '1000', guid: 'g6', value: null },
		],
		REF,
		'str',
	);
	assert.deepEqual(groups.map((g) => [g.value, g.elementCount, g.buildingIds]), [
		['A-101', 2, ['1000', '1001']],
		['A-102', 1, ['1000']],
	]);
	assert.deepEqual(groups[0].sampleGuids, ['g2', 'g3']);
});

test('matchDocument: exact stem, case-insensitive, extension filter, ambiguity', () => {
	const idx = index(
		docRow(1, 'A-101.pdf'),
		docRow(2, 'a-102.PDF'),
		docRow(3, 'A-103.dwg'),
		docRow(4, 'A-104.pdf'),
		docRow(5, 'A-104.pdf'),
		docRow(6, 'A-105.pdf', { 'is-deleted': true }),
		docRow(7, 'A-101 rev B.pdf'),
	);
	assert.equal(matchDocument('A-101', idx).document.id, '1');
	assert.equal(matchDocument('A-102', idx).document.id, '2');
	assert.equal(matchDocument('A-103', idx).status, 'no_document');
	assert.equal(matchDocument('A-104', idx).status, 'ambiguous');
	assert.equal(matchDocument('A-104', idx).candidates.length, 2);
	assert.equal(matchDocument('A-105', idx).status, 'no_document');
	assert.equal(parseExtensions(' pdf, .DWG ,').join(), 'pdf,dwg');
	assert.equal(matchDocument('A-103', indexDocumentsByStem([toLinkDocument(docRow(3, 'A-103.dwg'))], [])).status, 'matched');
});

test('toExistingLink keeps document links only', () => {
	assert.equal(toExistingLink(attachmentRow(10, null)), undefined);
	assert.equal(toExistingLink({ id: '1', type: 'documents' }), undefined);
	assert.deepEqual(toExistingLink(attachmentRow(11, 5, true)), {
		attachmentId: '11',
		documentId: '5',
		isDeleted: true,
		filename: '5.pdf',
	});
});

test('plan: new document is linked, existing link is kept', () => {
	const idx = index(docRow(1, 'A-101.pdf'));
	const live = new Set(['1']);
	assert.equal(planPropertyLink(group('A-101'), matchDocument('A-101', idx), [], live, OPTS).link, 'create');
	const existing = [toExistingLink(attachmentRow(20, 1))];
	const plan = planPropertyLink(group('A-101'), matchDocument('A-101', idx), existing, live, OPTS);
	assert.equal(plan.link, 'exists');
	assert.deepEqual(plan.stale, []);
});

test('plan: a link removed by hand stays removed unless relinkRemoved', () => {
	const idx = index(docRow(1, 'A-101.pdf'));
	const removed = [toExistingLink(attachmentRow(20, 1, true))];
	const m = matchDocument('A-101', idx);
	assert.equal(planPropertyLink(group('A-101'), m, removed, new Set(['1']), OPTS).link, 'removed_by_user');
	assert.equal(
		planPropertyLink(group('A-101'), m, removed, new Set(['1']), { ...OPTS, relinkRemoved: true }).link,
		'create',
	);
});

test('plan: moved document, old link is stale and the new document is linked', () => {
	// The source moved the file: document 1 is soft-deleted, document 2 is its successor.
	const idx = index(docRow(1, 'A-101.pdf', { 'is-deleted': true }), docRow(2, 'A-101.pdf'));
	const links = [toExistingLink(attachmentRow(20, 1))];
	const plan = planPropertyLink(group('A-101'), matchDocument('A-101', idx), links, new Set(['2']), OPTS);
	assert.equal(plan.link, 'create');
	assert.equal(plan.document.id, '2');
	assert.deepEqual(plan.stale.map((l) => l.attachmentId), ['20']);
});

test('plan: deleted document with no successor, link is stale, nothing to link', () => {
	const links = [toExistingLink(attachmentRow(20, 1)), toExistingLink(attachmentRow(21, 9, true))];
	const plan = planPropertyLink(group('A-101'), matchDocument('A-101', index()), links, new Set(), OPTS);
	assert.equal(plan.status, 'no_document');
	assert.equal(plan.link, 'none');
	// Already-removed links are never removed again.
	assert.deepEqual(plan.stale.map((l) => l.attachmentId), ['20']);
	assert.deepEqual(
		planPropertyLink(group('A-101'), matchDocument('A-101', index()), links, new Set(), { ...OPTS, removeDeleted: false }).stale,
		[],
	);
});

test('plan: links to other live documents are left alone', () => {
	const idx = index(docRow(1, 'A-101.pdf'), docRow(3, 'Detail 7.pdf'));
	const links = [toExistingLink(attachmentRow(30, 3))];
	const plan = planPropertyLink(group('A-101'), matchDocument('A-101', idx), links, new Set(['1', '3']), OPTS);
	assert.equal(plan.link, 'create');
	assert.deepEqual(plan.stale, []);
});

test('documentLinkBody links the document to the object', () => {
	const body = documentLinkBody('OBJ', '42');
	assert.equal(body.data.type, 'attachments');
	assert.equal(body.data.attributes.category, 'document');
	assert.deepEqual(body.data.relationships['parent-ifc-object'], { data: { id: 'OBJ', type: 'ifc-object' } });
	assert.deepEqual(body.data.relationships['linked-document'], { data: { type: 'documents', id: '42' } });
	assert.deepEqual(body.data.relationships['parent-topic'], { data: null });
});

test('linkTargetObjectId: element GUID as given, property value as virtual object', () => {
	assert.equal(linkTargetObjectId({ kind: 'element', guid: ' 2xVoYhqg9CBvb8FmWO83Zc ' }), '2xVoYhqg9CBvb8FmWO83Zc');
	assert.equal(
		linkTargetObjectId({ kind: 'property', property: 'Text.Sheet Number', value: 'A-101' }),
		virtualObjectId(REF, 'str', 'A-101'),
	);
	assert.equal(
		linkTargetObjectId({ kind: 'property', property: 'Pset_Data~Size', value: '12', valueType: 'num' }),
		base64Url('ifcelement~Pset_Data~Size~num~12'),
	);
	assert.throws(() => linkTargetObjectId({ kind: 'element', guid: ' ' }), /GUID is required/);
	assert.throws(() => linkTargetObjectId({ kind: 'property', property: 'Sheet Number', value: 'A-101' }), /Property Set\.Property/);
	assert.throws(() => linkTargetObjectId({ kind: 'property', property: 'Text.Sheet Number', value: '' }), /value is required/);
});
