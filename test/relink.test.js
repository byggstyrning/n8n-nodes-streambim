// Unit tests for the relink planner. Run with `pnpm test` (compiles, then node --test).
// All fixtures are synthetic; they mirror patterns seen on real projects.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	buildRelinkPlan,
	lastSyncEnded,
	retirableDocuments,
	supersededUploads,
	mergeSnapshots,
	nextBaseline,
	shouldApply,
	normaliseStem,
	toRelinkAlignment,
	toRelinkSourceFile,
} = require('../dist/nodes/shared/streamBimRelink');

const doc = (id, path, filename, externalId, extra = {}) => ({
	id: String(id),
	filename,
	path,
	externalId,
	isDeleted: false,
	deletedDate: null,
	uploadedDate: '2026-10-01T00:00:00Z',
	lastModified: null,
	revision: 1,
	parentId: null,
	scale: null,
	...extra,
});
const deleted = (id, path, filename, externalId, extra = {}) =>
	doc(id, path, filename, externalId, { isDeleted: true, ...extra });
const ifcFile = (b, d, layer, extra = {}) => ({
	id: `${b}-${d}`,
	buildingId: String(b),
	documentId: String(d),
	layer,
	markedForDeletion: false,
	currentlyActive: true,
	...extra,
});
const alignment = (d, b, name, uploadedDate = '2026-10-02T00:00:00Z') => ({
	id: `${d}-${b}`,
	buildingId: String(b),
	documentId: String(d),
	name,
	imagePoints: [
		[-10, 0, 5],
		[10, 0, -5],
	],
	worldPoints: [
		[-20, 3.5, 0],
		[20, 3.5, 0],
	],
	maskPoints: [],
	uploadedDate,
});
const floor = (id, b, docId) => ({
	id: String(id),
	buildingId: String(b),
	name: 'Plan 02',
	height: 3.5,
	useCustomFloorplan: true,
	customFloorplanDocumentId: docId ? String(docId) : null,
});
const ops = (item) => item.actions.map((a) => a.op);

// Interaxo: an entry moves from step "New" to "Open". StreamBIM mirrors steps as folders.
const SRC = '/Project/Design/WORKFLOW FOLDER';
const stepMove = () => ({
	documents: [
		deleted(10, 'INTERAXO/New/Model entry', 'X-K-20-V-0001.ifc', 'file-ifc'),
		doc(20, 'INTERAXO/Open/Model entry', 'X-K-20-V-0001.ifc', 'file-ifc'),
		deleted(11, 'INTERAXO/New/Drawing entry', 'plan.pdf', 'file-pdf', { scale: 50 }),
		doc(21, 'INTERAXO/Open/Drawing entry', 'plan.pdf', 'file-pdf'),
	],
	ifcFiles: [ifcFile(1000, 10, 'MainLayer~Sublayer')],
	alignments: [alignment(11, 1000, 'Kraft')],
	floors: [floor(1001, 1000, 11)],
	sourceFiles: [
		{
			id: 'file-ifc',
			name: 'X-K-20-V-0001.ifc',
			path: `${SRC}/Open/Model entry/X-K-20-V-0001.ifc`,
		},
		{ id: 'file-pdf', name: 'plan.pdf', path: `${SRC}/Open/Drawing entry/plan.pdf` },
	],
});

test('step move: model layer and drawing (placement + floor plan) move to the successor', () => {
	const plan = buildRelinkPlan(stepMove());
	assert.deepEqual(
		plan.map((p) => p.kind),
		['ifcFile', 'drawing'],
	);
	for (const p of plan) {
		assert.equal(p.link_profile, 'by_external_id', `${p.kind}: ${p.reasons.join(' ')}`);
		assert.deepEqual(p.warnings, []);
		assert.equal(p.match, 'source_path');
		assert.equal(p.sourceState, 'moved');
	}
	const [model, drawing] = plan;
	assert.deepEqual(ops(model), ['createIfcFile', 'retireIfcFile']);
	assert.deepEqual(model.actions[0], {
		op: 'createIfcFile',
		buildingId: '1000',
		documentId: '20',
		layer: 'MainLayer~Sublayer',
	});
	// same floor first, then copy the placement, remove the old one, and set the name
	assert.deepEqual(ops(drawing), [
		'updateFloor',
		'copyAlignment',
		'copyDocumentScale',
		'deleteAlignment',
		'renameAlignment',
	]);
	assert.deepEqual(drawing.actions[0], { op: 'updateFloor', floorId: '1001', documentId: '21' });
	assert.deepEqual(drawing.actions[1].worldPoints, alignment(11, 1000, '').worldPoints);
	assert.equal(drawing.actions[2].scale, 50);
	assert.deepEqual(drawing.actions[4], {
		op: 'renameAlignment',
		buildingId: '1000',
		documentId: '21',
		name: 'Kraft',
	});
	assert.deepEqual(drawing.old.floors, [{ id: '1001', name: 'Plan 02' }]);
});

test('without source inventory the external id still finds the successor', () => {
	const input = stepMove();
	delete input.sourceFiles;
	const plan = buildRelinkPlan(input);
	assert.ok(
		plan.every(
			(p) =>
				p.match === 'external_id' &&
				p.link_profile === 'by_external_id' &&
				p.sourceState === 'unknown',
		),
	);
});

test('moved to a step outside the sync scope: nothing to relink yet', () => {
	const input = stepMove();
	input.documents = input.documents.filter((d) => d.id === '10');
	input.sourceFiles = [
		{
			id: 'file-ifc',
			name: 'X-K-20-V-0001.ifc',
			path: `${SRC}/Closed/Model entry/X-K-20-V-0001.ifc`,
		},
	];
	input.alignments = [];
	input.floors = [];
	const [p] = buildRelinkPlan(input);
	assert.equal(p.link_profile, 'none');
	assert.equal(p.sourceState, 'not-synced');
	assert.deepEqual(p.actions, []);
});

test('re-upload with a new id falls back to the file name and needs review', () => {
	const plan = buildRelinkPlan({
		documents: [
			deleted(10, 'ACC/Project Files/A/PDF', 'A-40-1-1095.pdf', 'lineage-1'),
			doc(30, 'ACC/Project Files/11.02 Arkitekt/Aktuella pdfer', 'A-40-1-1095.pdf', 'lineage-2'),
		],
		ifcFiles: [],
		alignments: [alignment(10, 1000, '')],
		floors: [],
		sourceFiles: [],
	});
	assert.equal(plan[0].match, 'filename');
	assert.equal(plan[0].sourceState, 'missing-at-source');
	assert.equal(plan[0].link_profile, 'by_filename');
});

test('a dropped revision suffix matches on the normalised name', () => {
	assert.equal(normaliseStem('A1_3_FPL_010_1001_00.pdf'), normaliseStem('A1_3_FPL_010_1001.pdf'));
	const [p] = buildRelinkPlan({
		documents: [
			deleted(10, 'SHAREPOINT/A1/02. DRAWINGS/A10_Floorplans', 'A1_3_FPL_010_1001_00.pdf', 'sp-1'),
			doc(30, 'SHAREPOINT/A1/02. DRAWINGS/A10_Floor plans', 'A1_3_FPL_010_1001.pdf', 'sp-2'),
		],
		ifcFiles: [],
		alignments: [alignment(10, 1000, '')],
		floors: [],
	});
	assert.equal(p.match, 'filename_normalised');
	assert.equal(p.score.suffix, 4, 'A10_Floorplans and A10_Floor plans compare equal');
	assert.equal(p.link_profile, 'by_filename');
	assert.deepEqual(p.warnings, []);
});

test('a successor in an archive folder is sent to review', () => {
	const [p] = buildRelinkPlan({
		documents: [
			deleted(10, 'SHAREPOINT/Kitchen/01. MODEL', 'K-Plan 1.ifc', 'sp-1'),
			doc(30, 'SHAREPOINT/Kitchen/01. MODEL/Old', 'K-Plan 1.ifc', 'sp-1'),
		],
		ifcFiles: [ifcFile(1000, 10, 'KITCHEN~Floor_1')],
		alignments: [],
		floors: [],
	});
	assert.equal(p.match, 'external_id');
	assert.equal(p.link_profile, 'by_external_id');
	assert.deepEqual(p.warnings, ['archive_folder']);
	assert.match(p.reasons.join(' '), /archive/);
});

test('equal path scores are a tie and go to review', () => {
	const [p] = buildRelinkPlan({
		documents: [
			deleted(10, 'SHAREPOINT/Site', 'K-200.ifc', 'old'),
			doc(30, 'SHAREPOINT/01. MODELLS/IFC', 'K-200.ifc', 'a'),
			doc(31, 'IFC/Site', 'K-200.ifc', 'b'),
		],
		ifcFiles: [ifcFile(1000, 10, 'SITE~DESIGN')],
		alignments: [],
		floors: [],
	});
	assert.deepEqual(p.warnings, ['tie']);
	assert.match(p.reasons.join(' '), /share the best path score/);
});

test('a successor already on the same layer only retires the old row', () => {
	const input = stepMove();
	input.ifcFiles.push(ifcFile(1000, 20, 'MainLayer~Sublayer'));
	const model = buildRelinkPlan(input, { kinds: ['ifcFile'] })[0];
	assert.deepEqual(ops(model), ['retireIfcFile']);
	assert.deepEqual(model.warnings, []);
});

test('several deleted versions with placements: the newest one is copied, the rest removed', () => {
	const plan = buildRelinkPlan({
		documents: [
			deleted(10, 'ACC/A/PDF', 'A-1.pdf', 'l'),
			deleted(11, 'ACC/A/PDF2', 'A-1.pdf', 'l'),
			doc(30, 'ACC/B/PDF', 'A-1.pdf', 'l'),
		],
		ifcFiles: [],
		alignments: [
			alignment(10, 1000, 'old', '2023-05-01T00:00:00Z'),
			alignment(11, 1000, 'newest', '2023-11-01T00:00:00Z'),
		],
		floors: [],
	});
	assert.equal(plan.length, 2);
	assert.deepEqual(ops(plan[0]), ['copyAlignment', 'deleteAlignment', 'renameAlignment']);
	assert.equal(plan[0].old.name, 'newest');
	assert.equal(plan[0].actions[2].name, 'newest');
	assert.deepEqual(ops(plan[1]), ['deleteAlignment']);
});

test('a floor plan without any placement is sent to review', () => {
	const input = stepMove();
	input.alignments = [];
	const drawing = buildRelinkPlan(input, { kinds: ['drawing'] })[0];
	assert.deepEqual(ops(drawing), ['updateFloor']);
	assert.deepEqual(drawing.warnings, ['uncalibrated_floor']);
	assert.match(drawing.reasons.join(' '), /uncalibrated/);
});

test('a successor that is already placed keeps its placement; the floor still moves', () => {
	const input = stepMove();
	input.alignments.push(alignment(21, 1000, 'placed by hand'));
	const drawing = buildRelinkPlan(input, { kinds: ['drawing'] })[0];
	assert.deepEqual(ops(drawing), ['updateFloor', 'deleteAlignment']);
	assert.deepEqual(drawing.warnings, []);
});

test('mappings on live documents are left alone', () => {
	const plan = buildRelinkPlan({
		documents: [doc(10, 'INTERAXO/New/E', 'a.ifc', 'f')],
		ifcFiles: [ifcFile(1000, 10, 'L')],
		alignments: [],
		floors: [],
	});
	assert.deepEqual(plan, []);
});

test('row parsers', () => {
	assert.deepEqual(toRelinkSourceFile({ id: 'f', name: 'a.pdf', path: '/X/Open/E' }), {
		id: 'f',
		name: 'a.pdf',
		path: '/X/Open/E/a.pdf',
	});
	const a = toRelinkAlignment({
		id: '1003-1000',
		type: 'document-alignments',
		attributes: { name: 'N' },
	});
	assert.equal(a.documentId, '1003');
	assert.equal(a.buildingId, '1000');
});

test('floor update body keeps name, height and building (PATCH replaces the record)', () => {
	const { floorUpdateBody } = require('../dist/nodes/StreamBim/resources/floor');
	const body = floorUpdateBody(
		{
			id: '1000',
			type: 'floors',
			attributes: {
				name: 'PL09',
				height: 13.31,
				hidden: false,
				'floor-bounds': [],
				'use-custom-floorplan': false,
			},
			relationships: {
				building: { data: { id: '1000', type: 'buildings' } },
				'custom-floorplan-document': { data: null },
			},
		},
		'1007',
		true,
	);
	assert.deepEqual(body.data.attributes, {
		name: 'PL09',
		height: 13.31,
		hidden: false,
		'floor-bounds': [],
		'use-custom-floorplan': true,
	});
	assert.deepEqual(body.data.relationships.building, { data: { type: 'buildings', id: '1000' } });
	assert.deepEqual(body.data.relationships['custom-floorplan-document'], {
		data: { type: 'documents', id: '1007' },
	});
});

// A file deleted at the source (e.g. renamed by delete + upload) can make StreamBIM
// hard-delete the document and its placement; only the floor keeps a dangling reference.
const hardDelete = () => ({
	documents: [doc(19, 'INTERAXO/New/Plan entry', 'A-40-1-TAKFOT_01.pdf', 'file-new')],
	ifcFiles: [],
	alignments: [],
	floors: [floor(1003, 1000, 18)],
});

test('hard-deleted drawing without snapshot: reported, nothing to apply', () => {
	const [p] = buildRelinkPlan(hardDelete());
	assert.equal(p.link_profile, 'none');
	assert.deepEqual(p.actions, []);
	assert.match(p.reasons.join(' '), /no longer exists/);
});

test('hard-deleted drawing with a pre-sync snapshot: placement restored on the successor', () => {
	const input = hardDelete();
	input.snapshot = {
		documents: [doc(18, 'INTERAXO/New/Plan entry', 'A-40-1-TAKFOT_00.pdf', 'file-old')],
		ifcFiles: [],
		alignments: [alignment(18, 1000, 'A-plan TAKFOT')],
	};
	const [p] = buildRelinkPlan(input);
	assert.equal(p.match, 'filename_normalised');
	assert.equal(p.link_profile, 'by_filename');
	assert.equal(p.candidate.documentId, '19');
	assert.deepEqual(ops(p), ['updateFloor', 'copyAlignment', 'renameAlignment']);
	assert.match(p.reasons.join(' '), /snapshot/);
});

test('a snapshot does not change anything for documents that still exist', () => {
	const input = stepMove();
	input.snapshot = {
		documents: input.documents,
		ifcFiles: input.ifcFiles,
		alignments: input.alignments,
	};
	assert.deepEqual(buildRelinkPlan(input).map(ops), buildRelinkPlan(stepMove()).map(ops));
});

test('last sync end over sync-status rows', () => {
	assert.equal(lastSyncEnded([]), null);
	assert.equal(
		lastSyncEnded([
			{ attributes: { 'last-sync-ended': '2026-10-14T13:20:51.377Z' } },
			{ attributes: { 'last-sync-ended': null } },
			{ attributes: { 'last-sync-ended': '2026-10-14T13:14:27.625Z' } },
		]),
		Date.parse('2026-10-14T13:20:51.377Z'),
	);
});

test('a snapshot-restored mapping that the successor already has is not reported again', () => {
	const input = hardDelete();
	input.alignments = [alignment(19, 1000, 'A-plan TAKFOT')];
	input.floors = [floor(1003, 1000, 19)];
	input.snapshot = {
		documents: [doc(18, 'INTERAXO/New/Plan entry', 'A-40-1-TAKFOT_00.pdf', 'file-old')],
		ifcFiles: [],
		alignments: [alignment(18, 1000, 'A-plan TAKFOT')],
	};
	assert.deepEqual(buildRelinkPlan(input), []);
});

test('baseline keeps current mappings and unresolved vanished documents, drops old ones', () => {
	const now = new Date('2026-10-14T12:00:00Z');
	const gone = { ...doc(18, 'I/New/E', 'a_00.pdf', 'x'), seenAt: '2026-10-13T12:00:00Z' };
	const ancient = { ...doc(17, 'I/New/E', 'b_00.pdf', 'y'), seenAt: '2026-08-01T12:00:00Z' };
	const merged = {
		documents: [gone, ancient],
		ifcFiles: [],
		alignments: [alignment(18, 1000, 'A'), alignment(17, 1000, 'B')],
	};
	const current = {
		documents: [doc(19, 'I/New/E', 'a_01.pdf', 'z')],
		ifcFiles: [],
		alignments: [alignment(19, 1000, 'A')],
	};
	const plan = [{ old: { documentId: '18' } }, { old: { documentId: '17' } }];
	const next = nextBaseline(merged, current, plan, now);
	assert.deepEqual(
		next.documents.map((d) => d.id),
		['19', '18'],
	);
	assert.deepEqual(
		next.alignments.map((a) => a.id),
		['19-1000', '18-1000'],
	);
	assert.deepEqual(
		nextBaseline(merged, current, [], now).documents.map((d) => d.id),
		['19'],
	);
	const m = mergeSnapshots(merged, current);
	assert.equal(m.documents.length, 3);
});

test('apply rule: certain links by default, guesses and warnings only when asked or approved', () => {
	const certain = { link_profile: 'by_external_id', warnings: [], approved: false };
	const guess = { link_profile: 'by_filename', warnings: [], approved: false };
	const warned = { link_profile: 'by_external_id', warnings: ['archive_folder'], approved: false };
	const none = { link_profile: 'none', warnings: [], approved: false };
	const dflt = ['by_external_id'];
	assert.equal(shouldApply(certain, dflt), true);
	assert.equal(shouldApply(guess, dflt), false);
	assert.equal(shouldApply(guess, ['by_external_id', 'by_filename']), true);
	assert.equal(shouldApply(warned, dflt), false);
	assert.equal(shouldApply(warned, dflt, true), true);
	assert.equal(shouldApply({ ...guess, approved: true }, dflt), true);
	assert.equal(shouldApply(none, ['by_external_id', 'by_filename'], true), false);
});

// Document → Upload with an External ID into a new folder leaves the older copy live.
const uploadMove = () => ({
	documents: [
		doc(50, 'UPLOADS/Etapp1/Modell', 'U-A-40-V-0001.ifc', 'lineage-1'),
		doc(51, 'UPLOADS/Etapp1/Ritningar', 'U-A-40-1-PL09_00.pdf', 'lineage-2', { scale: 50 }),
		doc(60, 'UPLOADS/Etapp2/Modell', 'U-A-40-V-0001.ifc', 'lineage-1'),
		doc(61, 'UPLOADS/Etapp2/Ritningar', 'U-A-40-1-PL09_00.pdf', 'lineage-2'),
	],
	ifcFiles: [ifcFile(1000, 50, 'UPLOAD~A40')],
	alignments: [alignment(51, 1000, 'Upload plan')],
	floors: [floor(1004, 1000, 51)],
});

test('an upload into a new folder: mappings move to the newest copy, old copies are retired last', () => {
	const plan = buildRelinkPlan(uploadMove());
	assert.deepEqual(
		plan.map((p) => p.kind),
		['ifcFile', 'drawing', 'document', 'document'],
	);
	const [model, drawing] = plan;
	assert.equal(model.link_profile, 'by_external_id');
	assert.equal(model.candidate.documentId, '60');
	assert.deepEqual(ops(model), ['createIfcFile', 'retireIfcFile']);
	assert.equal(drawing.candidate.documentId, '61');
	assert.deepEqual(ops(drawing), [
		'updateFloor',
		'copyAlignment',
		'copyDocumentScale',
		'deleteAlignment',
		'renameAlignment',
	]);
	assert.match(model.reasons[0], /same external id replaced/);
	assert.deepEqual(
		plan.slice(2).map((p) => [p.old.documentId, p.candidate.documentId, ops(p)[0]]),
		[
			['50', '60', 'retireDocument'],
			['51', '61', 'retireDocument'],
		],
	);
});

test('superseded uploads: newest copy kept, synced files never count', () => {
	const three = [
		doc(5, 'UPLOADS/a', 'x.ifc', 'L'),
		doc(9, 'UPLOADS/c', 'x.ifc', 'L'),
		doc(7, 'UPLOADS/b', 'x.ifc', 'L'),
	];
	assert.deepEqual([...supersededUploads(three)].sort(), ['5', '7']);
	const mixed = [doc(5, 'INTERAXO/New/E', 'x.ifc', 'L'), doc(9, 'UPLOADS/processed', 'x.ifc', 'L')];
	assert.equal(supersededUploads(mixed).size, 0);
	const otherType = [doc(5, 'UPLOADS/a', 'x.ifc', 'L'), doc(9, 'UPLOADS/b', 'x.pdf', 'L')];
	assert.equal(supersededUploads(otherType).size, 0);
	assert.equal(supersededUploads([doc(5, 'UPLOADS/a', 'x.ifc', null)]).size, 0);
});

test('an old upload is only retired when all its mappings were moved', () => {
	const results = [
		{ kind: 'ifcFile', old: { documentId: '50' }, applied: true },
		{ kind: 'drawing', old: { documentId: '51' }, applied: false },
		{ kind: 'document', old: { documentId: '50' } },
		{ kind: 'document', old: { documentId: '51' } },
	];
	assert.deepEqual([...retirableDocuments(results)], ['50']);
});
