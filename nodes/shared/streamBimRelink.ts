import type { IDataObject } from 'n8n-workflow';

/**
 * Re-link StreamBIM mappings after a file moved in the source CDE.
 *
 * When a synced file changes folder in the source (ACC or SharePoint move or folder rename,
 * Interaxo workflow step change) the StreamBIM sync creates a NEW document and soft-deletes
 * the old one. Every mapping stays on the deleted document: its ifc-files row (still
 * active, so conversions keep using the frozen last revision), its document-alignments
 * and every floor whose custom floor plan points at it. This module finds the successor
 * of each such document and plans the API calls that move the mappings across.
 *
 * Pure logic only: no n8n runtime calls, so it can be unit tested on plain JSON.
 */

export type RelinkDocument = {
	id: string;
	filename: string;
	path: string;
	externalId: string | null;
	isDeleted: boolean;
	deletedDate: string | null;
	uploadedDate: string | null;
	lastModified: string | null;
	revision: number | null;
	parentId: string | null;
	scale: number | null;
	/** Snapshots only: when this document was last seen in StreamBIM. */
	seenAt?: string;
};

export type RelinkIfcFile = {
	id: string;
	buildingId: string;
	documentId: string;
	layer: string;
	markedForDeletion: boolean;
	currentlyActive: boolean;
};

export type RelinkAlignment = {
	id: string;
	buildingId: string;
	documentId: string;
	name: string;
	imagePoints: unknown;
	worldPoints: unknown;
	maskPoints: unknown;
	uploadedDate: string | null;
};

export type RelinkFloor = {
	id: string;
	buildingId: string;
	name: string;
	height: number | null;
	useCustomFloorplan: boolean;
	customFloorplanDocumentId: string | null;
};

/** A file as the source CDE sees it now. `path` includes the file name. */
export type RelinkSourceFile = {
	id: string;
	name: string;
	path: string;
};

/**
 * - `ifcFile`: a model layer row.
 * - `drawing`: a 2D document's placement in a building plus the floors using it as floor plan.
 * - `document`: an older uploaded copy that a newer upload with the same external id replaced;
 *   it is soft-deleted after its mappings moved (what the StreamBIM sync does on a move).
 */
export type RelinkKind = 'ifcFile' | 'drawing' | 'document';
/**
 * How the successor was found:
 * - `source_path`: the old document's source id was found at its new place in the source inventory;
 * - `external_id`: a live document carries the same source id (ACC lineage URN, SharePoint
 *   driveItem id, Interaxo file id);
 * - `filename` / `filename_normalised`: only the file name matches (revision suffix ignored).
 */
export type RelinkMatch =
	| 'source_path'
	| 'external_id'
	| 'filename'
	| 'filename_normalised'
	| 'none';
/** `by_external_id` is a certain link; `by_filename` is a guess (the source gave the file a new id). */
export type RelinkLinkProfile = 'by_external_id' | 'by_filename' | 'none';
/** Reasons to look at an item before applying it, whatever its link profile. */
export type RelinkWarning = 'tie' | 'archive_folder' | 'layer_conflict' | 'uncalibrated_floor';

/**
 * Apply rule: approved items always; otherwise the link profile must be selected and the item
 * must carry no warning (unless items with warnings are allowed too).
 */
export function shouldApply(
	item: Pick<RelinkPlanItem, 'link_profile' | 'warnings' | 'approved'>,
	profiles: RelinkLinkProfile[],
	withWarnings = false,
): boolean {
	if (item.approved === true) return true;
	if (item.link_profile === 'none' || !profiles.includes(item.link_profile)) return false;
	return withWarnings || (item.warnings ?? []).length === 0;
}

export function linkProfileOf(match: RelinkMatch): RelinkLinkProfile {
	if (match === 'source_path' || match === 'external_id') return 'by_external_id';
	if (match === 'filename' || match === 'filename_normalised') return 'by_filename';
	return 'none';
}
/**
 * - `unknown`: no source inventory was given.
 * - `moved`: the source file still exists, and StreamBIM has a live document at its current path.
 * - `not-synced`: the source file exists elsewhere, but StreamBIM has no live document there
 *   (sync not run yet, or the target folder/step is outside the sync scope).
 * - `missing-at-source`: the source no longer lists the file id (deleted, or re-uploaded as a new file).
 */
export type RelinkSourceState = 'unknown' | 'moved' | 'not-synced' | 'missing-at-source';

export type RelinkAction =
	| {
			op: 'createIfcFile';
			buildingId: string;
			documentId: string;
			layer: string;
	  }
	| {
			op: 'restoreIfcFile';
			ifcFileId: string;
			buildingId: string;
			documentId: string;
			layer: string;
	  }
	| {
			op: 'retireIfcFile';
			ifcFileId: string;
			buildingId: string;
			documentId: string;
			layer: string;
	  }
	| {
			/** Create the new document's placement, or update the one StreamBIM made for the floor. */
			op: 'copyAlignment';
			buildingId: string;
			documentId: string;
			imagePoints: unknown;
			worldPoints: unknown;
			maskPoints: unknown;
	  }
	| { op: 'renameAlignment'; buildingId: string; documentId: string; name: string }
	| { op: 'copyDocumentScale'; documentId: string; scale: number }
	| { op: 'deleteAlignment'; alignmentId: string }
	| { op: 'updateFloor'; floorId: string; documentId: string }
	| { op: 'retireDocument'; documentId: string };

export type RelinkDocRef = {
	documentId: string;
	filename: string;
	path: string;
	externalId: string | null;
};

export type RelinkPlanItem = {
	kind: RelinkKind;
	buildingId: string;
	link_profile: RelinkLinkProfile;
	match: RelinkMatch;
	warnings: RelinkWarning[];
	sourceState: RelinkSourceState;
	reasons: string[];
	old: RelinkDocRef & {
		/** ifc-files ID, or the document alignment ID for a drawing ('' when it had none). */
		mappingId: string;
		layer?: string;
		/** Placement display name. */
		name?: string;
		/** Floors that show the document as their floor plan. */
		floors?: Array<{ id: string; name: string }>;
	};
	candidate: RelinkDocRef | null;
	score: { prefix: number; suffix: number; candidates: number };
	actions: RelinkAction[];
	approved: boolean;
};

export type RelinkOptions = {
	/** Folder names that mean "retired" (a move INTO one is reported, not re-mapped). */
	archivePattern?: RegExp;
	kinds?: RelinkKind[];
	/** Restrict to these buildings (empty = all buildings present in the input). */
	buildingIds?: string[];
};

export const DEFAULT_ARCHIVE_PATTERN =
	/(^|\/)(old|_old|gamla?|arkiv|archive|archived|superseded|utg[aå]tt|ersatt|\d+\.\s*old)(\/|$)/i;

export type RelinkInput = {
	documents: RelinkDocument[];
	ifcFiles: RelinkIfcFile[];
	alignments: RelinkAlignment[];
	floors: RelinkFloor[];
	/** Current source inventory; enables the `source-id` tier and `sourceState`. */
	sourceFiles?: RelinkSourceFile[];
	/**
	 * State taken before the sync (Relink → Snapshot). When the source deletes a file,
	 * StreamBIM may hard-delete the document together with its placement, leaving only a
	 * dangling floor reference; the snapshot is then the only copy of the old mapping.
	 */
	snapshot?: RelinkSnapshot;
};

export type RelinkSnapshot = {
	takenAt?: string;
	documents: RelinkDocument[];
	ifcFiles: RelinkIfcFile[];
	alignments: RelinkAlignment[];
};

// ---------------------------------------------------------------------------
// Name and path helpers
// ---------------------------------------------------------------------------

export function pathSegments(path: string | null | undefined): string[] {
	return String(path ?? '')
		.split('/')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Folder names compare case-insensitively, ignoring spaces, `_`, `-`, `.` and brackets. */
export function normaliseFolder(name: string): string {
	return name.toLowerCase().replace(/[\s_\-.()]+/g, '');
}

export function fileExtension(filename: string): string {
	const m = /\.([^./]+)$/.exec(filename);
	return m ? m[1].toLowerCase() : '';
}

/**
 * Filename stem without trailing revision tokens: `A1_3_FPL_010_1001_00.pdf` and
 * `A1_3_FPL_010_1001.pdf` both become `a1_3_fpl_010_1001`.
 */
export function normaliseStem(filename: string): string {
	return filename
		.replace(/\.[^./]+$/, '')
		.toLowerCase()
		.replace(/\.v\d+(\.\d+)*p?$/, '')
		.replace(/\s*-\s*\d{1,2}$/, '')
		.replace(/[_\-\s](rev)?[a-z]?\d{2}$/, '')
		.replace(/[_\-\s]+/g, '_');
}

/** Number of leading folder names two paths share. */
export function prefixMatch(a: string[], b: string[]): number {
	let i = 0;
	while (i < a.length && i < b.length && normaliseFolder(a[i]) === normaliseFolder(b[i])) i++;
	return i;
}

/** Number of trailing folder names two paths share. */
export function suffixMatch(a: string[], b: string[]): number {
	return prefixMatch([...a].reverse(), [...b].reverse());
}

function isArchived(path: string, pattern: RegExp): boolean {
	return pattern.test(`/${pathSegments(path).join('/')}/`);
}

function docRef(d: RelinkDocument): RelinkDocRef {
	return {
		documentId: d.id,
		filename: d.filename,
		path: d.path,
		externalId: d.externalId,
	};
}

function time(value: string | null): number {
	const t = value ? Date.parse(value) : NaN;
	return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Successor matching
// ---------------------------------------------------------------------------

export type SuccessorMatch = {
	match: RelinkMatch;
	candidate: RelinkDocument | null;
	sourceState: RelinkSourceState;
	prefix: number;
	suffix: number;
	candidates: number;
	tie: boolean;
	reasons: string[];
};

type Index = {
	live: RelinkDocument[];
	liveByExternalId: Map<string, RelinkDocument[]>;
	liveByFilename: Map<string, RelinkDocument[]>;
	liveByStem: Map<string, RelinkDocument[]>;
	sourceById: Map<string, RelinkSourceFile> | null;
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function buildIndex(input: RelinkInput): Index {
	const live = input.documents.filter((d) => !d.isDeleted);
	const liveByExternalId = new Map<string, RelinkDocument[]>();
	const liveByFilename = new Map<string, RelinkDocument[]>();
	const liveByStem = new Map<string, RelinkDocument[]>();
	for (const d of live) {
		if (d.externalId) push(liveByExternalId, d.externalId, d);
		push(liveByFilename, d.filename.toLowerCase(), d);
		push(liveByStem, `${normaliseStem(d.filename)}.${fileExtension(d.filename)}`, d);
	}
	let sourceById: Map<string, RelinkSourceFile> | null = null;
	if (input.sourceFiles) {
		sourceById = new Map();
		for (const f of input.sourceFiles) if (f.id) sourceById.set(f.id, f);
	}
	return { live, liveByExternalId, liveByFilename, liveByStem, sourceById };
}

/**
 * Does `doc` sit where the source says the file is now? StreamBIM paths start with an
 * integration root (`INTERAXO`, `ACC`, `SHAREPOINT`) that replaces the synced source
 * folder, so everything after that root must equal the tail of the source directory.
 */
function sitsAtSourcePath(doc: RelinkDocument, source: RelinkSourceFile): boolean {
	const docDir = pathSegments(doc.path);
	const srcDir = pathSegments(source.path).slice(0, -1);
	const needed = Math.max(docDir.length - 1, 0);
	return suffixMatch(docDir, srcDir) >= needed && docDir.length - 1 <= srcDir.length;
}

function rank(old: RelinkDocument, pool: RelinkDocument[]) {
	const o = pathSegments(old.path);
	return pool
		.map((c) => {
			const s = pathSegments(c.path);
			return { c, prefix: prefixMatch(o, s), suffix: suffixMatch(o, s) };
		})
		.sort(
			(a, b) =>
				b.prefix + b.suffix - (a.prefix + a.suffix) ||
				time(b.c.uploadedDate) - time(a.c.uploadedDate) ||
				Number(b.c.id) - Number(a.c.id),
		);
}

export function findSuccessor(old: RelinkDocument, index: Index): SuccessorMatch {
	const ext = fileExtension(old.filename);
	const sameType = (d: RelinkDocument) => fileExtension(d.filename) === ext && d.id !== old.id;
	const reasons: string[] = [];

	let sourceState: RelinkSourceState = 'unknown';
	if (index.sourceById) {
		const source = old.externalId ? index.sourceById.get(old.externalId) : undefined;
		if (!source) {
			sourceState = 'missing-at-source';
			reasons.push(
				'The source no longer lists this file id (deleted, or re-uploaded as a new file).',
			);
		} else {
			const atSource = (index.liveByExternalId.get(old.externalId as string) ?? []).filter(
				(d) => sameType(d) && sitsAtSourcePath(d, source),
			);
			if (atSource.length === 1) {
				const c = atSource[0];
				const o = pathSegments(old.path);
				const s = pathSegments(c.path);
				return {
					match: 'source_path',
					candidate: c,
					sourceState: 'moved',
					prefix: prefixMatch(o, s),
					suffix: suffixMatch(o, s),
					candidates: 1,
					tie: false,
					reasons: [`The source moved the file to "${source.path}".`],
				};
			}
			sourceState = 'not-synced';
			reasons.push(
				`The source has the file at "${source.path}", but StreamBIM has no live document there yet (sync not run, or that folder/step is outside the sync scope).`,
			);
		}
	}

	const tiers: Array<[RelinkMatch, RelinkDocument[]]> = [
		['external_id', old.externalId ? (index.liveByExternalId.get(old.externalId) ?? []) : []],
		['filename', index.liveByFilename.get(old.filename.toLowerCase()) ?? []],
		['filename_normalised', index.liveByStem.get(`${normaliseStem(old.filename)}.${ext}`) ?? []],
	];
	for (const [tier, raw] of tiers) {
		const pool = raw.filter(sameType);
		if (pool.length === 0) continue;
		const ranked = rank(old, pool);
		const top = ranked[0];
		const tie =
			ranked.length > 1 && ranked[1].prefix + ranked[1].suffix === top.prefix + top.suffix;
		if (tie) reasons.push(`${ranked.length} candidates share the best path score.`);
		return {
			match: tier,
			candidate: top.c,
			sourceState,
			prefix: top.prefix,
			suffix: top.suffix,
			candidates: pool.length,
			tie,
			reasons,
		};
	}
	reasons.push('No live document of the same type matches by id or file name.');
	return {
		match: 'none',
		candidate: null,
		sourceState,
		prefix: 0,
		suffix: 0,
		candidates: 0,
		tie: false,
		reasons,
	};
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function warningsFor(
	match: SuccessorMatch,
	old: RelinkDocument,
	archivePattern: RegExp,
	reasons: string[],
): RelinkWarning[] {
	const warnings: RelinkWarning[] = [];
	if (!match.candidate) return warnings;
	if (match.tie) warnings.push('tie');
	if (isArchived(match.candidate.path, archivePattern) && !isArchived(old.path, archivePattern)) {
		reasons.push(
			'The successor sits in an archive folder: the file was probably retired, not moved.',
		);
		warnings.push('archive_folder');
	}
	return warnings;
}

export function buildRelinkPlan(input: RelinkInput, options: RelinkOptions = {}): RelinkPlanItem[] {
	const archivePattern = options.archivePattern ?? DEFAULT_ARCHIVE_PATTERN;
	const kinds = new Set<RelinkKind>(options.kinds ?? ['ifcFile', 'drawing']);
	const buildingFilter = new Set((options.buildingIds ?? []).map(String).filter(Boolean));
	const inBuilding = (b: string) => buildingFilter.size === 0 || buildingFilter.has(b);

	// Documents that vanished since the snapshot (hard-deleted) come back as deleted ones,
	// together with the mappings the snapshot saw on them. Those mappings no longer exist in
	// StreamBIM, so they are restored on the successor but never "retired".
	const live = new Set(input.documents.map((d) => d.id));
	const gone = (input.snapshot?.documents ?? []).filter((d) => !live.has(d.id));
	const goneIds = new Set(gone.map((d) => d.id));
	const fromSnapshot = new Set<string>();
	const fromSnap = <T extends { id: string; documentId: string }>(rows: T[] | undefined) =>
		(rows ?? []).filter((r) => goneIds.has(r.documentId)).map((r) => (fromSnapshot.add(r.id), r));
	input = {
		...input,
		documents: [...input.documents, ...gone.map((d) => ({ ...d, isDeleted: true }))],
		ifcFiles: [...input.ifcFiles, ...fromSnap(input.snapshot?.ifcFiles)],
		alignments: [...input.alignments, ...fromSnap(input.snapshot?.alignments)],
	};
	const SNAPSHOT_REASON =
		'StreamBIM hard-deleted the old document and its mapping; it is restored from the pre-sync snapshot.';

	// Uploads (Document → Upload with an External ID) that land in a new folder leave the
	// older copy live, because no sync deletes it. Treat the older copies as moved: their
	// mappings go to the newest copy, and they are soft-deleted afterwards.
	const superseded = supersededUploads(input.documents);
	if (superseded.size > 0) {
		input = {
			...input,
			documents: input.documents.map((d) => (superseded.has(d.id) ? { ...d, isDeleted: true } : d)),
		};
	}
	const SUPERSEDED_REASON =
		'An upload with the same external id replaced this live copy; it is treated as moved.';

	const docsById = new Map(input.documents.map((d) => [d.id, d]));
	const index = buildIndex(input);
	const matchCache = new Map<string, SuccessorMatch>();
	const matchFor = (d: RelinkDocument) => {
		let m = matchCache.get(d.id);
		if (!m) {
			m = findSuccessor(d, index);
			matchCache.set(d.id, m);
		}
		return m;
	};
	const deletedDoc = (id: string | null) => {
		const d = id ? docsById.get(id) : undefined;
		return d && d.isDeleted ? d : undefined;
	};

	const plan: RelinkPlanItem[] = [];
	const item = (
		kind: RelinkKind,
		buildingId: string,
		old: RelinkDocument,
		mapping: {
			mappingId: string;
			layer?: string;
			name?: string;
			floors?: Array<{ id: string; name: string }>;
		},
	): RelinkPlanItem => {
		const m = matchFor(old);
		const reasons = superseded.has(old.id) ? [SUPERSEDED_REASON, ...m.reasons] : [...m.reasons];
		const warnings = warningsFor(m, old, archivePattern, reasons);
		return {
			kind,
			buildingId,
			link_profile: linkProfileOf(m.match),
			match: m.match,
			warnings,
			sourceState: m.sourceState,
			reasons,
			old: { ...docRef(old), ...mapping },
			candidate: m.candidate ? docRef(m.candidate) : null,
			score: { prefix: m.prefix, suffix: m.suffix, candidates: m.candidates },
			actions: [],
			approved: false,
		};
	};

	// Model layers ------------------------------------------------------------
	if (kinds.has('ifcFile')) {
		const byBuildingDoc = new Map(
			input.ifcFiles.map((f) => [`${f.buildingId}-${f.documentId}`, f]),
		);
		for (const f of input.ifcFiles) {
			const old = deletedDoc(f.documentId);
			if (!old || f.markedForDeletion || !inBuilding(f.buildingId)) continue;
			const p = item('ifcFile', f.buildingId, old, {
				mappingId: f.id,
				layer: f.layer,
			});
			if (p.candidate) {
				const existing = byBuildingDoc.get(`${f.buildingId}-${p.candidate.documentId}`);
				if (!existing) {
					p.actions.push({
						op: 'createIfcFile',
						buildingId: f.buildingId,
						documentId: p.candidate.documentId,
						layer: f.layer,
					});
				} else if (existing.markedForDeletion) {
					p.actions.push({
						op: 'restoreIfcFile',
						ifcFileId: existing.id,
						buildingId: f.buildingId,
						documentId: p.candidate.documentId,
						layer: f.layer,
					});
				} else if (existing.layer !== f.layer) {
					p.reasons.push(
						`The successor is already on layer "${existing.layer}"; it is left as is.`,
					);
					p.warnings.push('layer_conflict');
				} else {
					p.reasons.push('The successor is already on the same layer.');
				}
				if (fromSnapshot.has(f.id)) {
					p.reasons.push(SNAPSHOT_REASON);
					if (p.actions.length === 0) continue; // already restored on the successor
				} else
					p.actions.push({
						op: 'retireIfcFile',
						ifcFileId: f.id,
						buildingId: f.buildingId,
						documentId: f.documentId,
						layer: f.layer,
					});
			}
			plan.push(p);
		}
	}

	// Drawings: placement + custom floor plans of one PDF, per building ----------
	// Grouped per (deleted document, building), newest placement first, so the most
	// recent placement is the one copied when several deleted versions share a successor.
	if (kinds.has('drawing')) {
		const liveAlignments = new Map(
			input.alignments
				.filter((a) => !deletedDoc(a.documentId))
				.map((a) => [`${a.documentId}-${a.buildingId}`, a] as [string, RelinkAlignment]),
		);
		const copied = new Set<string>();
		const named = new Set<string>();
		type Group = {
			old: RelinkDocument;
			buildingId: string;
			alignment?: RelinkAlignment;
			floors: RelinkFloor[];
		};
		const groups = new Map<string, Group>();
		const group = (old: RelinkDocument, buildingId: string): Group => {
			const key = `${old.id}-${buildingId}`;
			let g = groups.get(key);
			if (!g) {
				g = { old, buildingId, floors: [] };
				groups.set(key, g);
			}
			return g;
		};
		for (const a of input.alignments) {
			const old = deletedDoc(a.documentId);
			if (old && inBuilding(a.buildingId)) group(old, a.buildingId).alignment = a;
		}
		for (const fl of input.floors) {
			const old = fl.useCustomFloorplan ? deletedDoc(fl.customFloorplanDocumentId) : undefined;
			if (old && inBuilding(fl.buildingId)) group(old, fl.buildingId).floors.push(fl);
		}
		const ordered = [...groups.values()].sort(
			(x, y) => time(y.alignment?.uploadedDate ?? null) - time(x.alignment?.uploadedDate ?? null),
		);
		for (const g of ordered) {
			const a = g.alignment;
			const p = item('drawing', g.buildingId, g.old, {
				mappingId: a?.id ?? '',
				name: a?.name,
				floors: g.floors.map((f) => ({ id: f.id, name: f.name })),
			});
			if (p.candidate) {
				// Order (as done by hand in StreamBIM):
				// 1. put the new document on the same floor(s) as custom floor plan,
				// 2. copy the placement (calibration points) to the new document,
				// 3. remove the old placement from the deleted document,
				// 4. give the new placement the old display name.
				const newId = p.candidate.documentId;
				const existing = liveAlignments.get(`${newId}-${g.buildingId}`);
				for (const fl of g.floors) {
					p.actions.push({ op: 'updateFloor', floorId: fl.id, documentId: newId });
				}
				if (a && !existing && !copied.has(`${newId}-${g.buildingId}`)) {
					p.actions.push({
						op: 'copyAlignment',
						buildingId: g.buildingId,
						documentId: newId,
						imagePoints: a.imagePoints,
						worldPoints: a.worldPoints,
						maskPoints: a.maskPoints,
					});
					copied.add(`${newId}-${g.buildingId}`);
					const successor = docsById.get(newId);
					if (g.old.scale != null && successor && successor.scale == null) {
						p.actions.push({ op: 'copyDocumentScale', documentId: newId, scale: g.old.scale });
					}
				} else if (a && existing) {
					p.reasons.push(
						'The successor already has its own placement in this building; its calibration is kept.',
					);
				} else if (!a && !existing && g.floors.length > 0) {
					p.reasons.push(
						'Neither the old nor the new document has a placement in this building, so the floor plan would be uncalibrated.',
					);
					p.warnings.push('uncalibrated_floor');
				}
				if (a && fromSnapshot.has(a.id)) p.reasons.push(SNAPSHOT_REASON);
				else if (a) p.actions.push({ op: 'deleteAlignment', alignmentId: a.id });
				if (
					a &&
					a.name &&
					(!existing || !existing.name) &&
					!named.has(`${newId}-${g.buildingId}`)
				) {
					p.actions.push({
						op: 'renameAlignment',
						buildingId: g.buildingId,
						documentId: newId,
						name: a.name,
					});
					named.add(`${newId}-${g.buildingId}`);
				}
			}
			if (a && fromSnapshot.has(a.id) && p.candidate && p.actions.length === 0) continue;
			plan.push(p);
		}
		// Floors showing a document StreamBIM no longer has at all (hard-deleted, no snapshot).
		for (const fl of input.floors) {
			const id = fl.customFloorplanDocumentId;
			if (!fl.useCustomFloorplan || !id || docsById.has(id) || !inBuilding(fl.buildingId)) continue;
			plan.push({
				kind: 'drawing',
				buildingId: fl.buildingId,
				link_profile: 'none',
				match: 'none',
				warnings: [],
				sourceState: 'unknown',
				reasons: [
					`Floor "${fl.name}" shows document ${id}, which no longer exists in StreamBIM (hard-deleted). Without a pre-sync snapshot its placement is lost; map the successor by hand.`,
				],
				old: {
					documentId: id,
					filename: '',
					path: '',
					externalId: null,
					mappingId: '',
					floors: [{ id: fl.id, name: fl.name }],
				},
				candidate: null,
				score: { prefix: 0, suffix: 0, candidates: 0 },
				actions: [],
				approved: false,
			});
		}
	}

	// Retire superseded uploads last, after every mapping on them has been planned.
	for (const id of superseded) {
		const old = docsById.get(id) as RelinkDocument;
		const p = item('document', '', old, { mappingId: id });
		p.actions.push({ op: 'retireDocument', documentId: id });
		plan.push(p);
	}

	return plan;
}

/** Path roots the StreamBIM sync integrations create; documents below them are synced, not uploaded. */
const SYNC_ROOTS = /^(INTERAXO|ACC|SHAREPOINT|STREAMBIM)(\/|$)/;

/**
 * Live uploaded documents that a newer upload with the same external id replaced. Only
 * groups where every copy is an upload count (a synced file and an upload derived from it
 * may share the id on purpose). The newest copy (highest document id) is the one kept.
 */
export function supersededUploads(documents: RelinkDocument[]): Set<string> {
	const groups = new Map<string, RelinkDocument[]>();
	for (const d of documents) {
		if (d.isDeleted || !d.externalId) continue;
		const key = `${d.externalId}|${fileExtension(d.filename)}`;
		const g = groups.get(key);
		if (g) g.push(d);
		else groups.set(key, [d]);
	}
	const out = new Set<string>();
	for (const g of groups.values()) {
		if (g.length < 2 || g.some((d) => SYNC_ROOTS.test(d.path))) continue;
		const newest = g.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
		for (const d of g) if (d.id !== newest.id) out.add(d.id);
	}
	return out;
}

/**
 * Old documents Apply may soft-delete: a `document` item is only safe when every mapping
 * item of the same old document was applied (otherwise its mappings would be stranded).
 */
export function retirableDocuments(
	results: Array<{ kind: string; old?: { documentId?: string }; applied?: boolean }>,
): Set<string> {
	const blocked = new Set<string>();
	for (const r of results) {
		if (r.kind !== 'document' && r.old?.documentId && r.applied !== true) {
			blocked.add(r.old.documentId);
		}
	}
	const out = new Set<string>();
	for (const r of results) {
		if (r.kind === 'document' && r.old?.documentId && !blocked.has(r.old.documentId)) {
			out.add(r.old.documentId);
		}
	}
	return out;
}

/** Union of two snapshots; rows of `newer` win. */
export function mergeSnapshots(
	older?: RelinkSnapshot,
	newer?: RelinkSnapshot,
): RelinkSnapshot | undefined {
	if (!older) return newer;
	if (!newer) return older;
	const byId = <T extends { id: string }>(a: T[], b: T[]) => [
		...new Map([...a, ...b].map((r) => [r.id, r] as [string, T])).values(),
	];
	return {
		takenAt: newer.takenAt,
		documents: byId(older.documents, newer.documents),
		ifcFiles: byId(older.ifcFiles, newer.ifcFiles),
		alignments: byId(older.alignments, newer.alignments),
	};
}

/**
 * Snapshot to keep for the next run: the current mappings, plus the mappings of documents
 * that have vanished from StreamBIM and are still unresolved in `plan` (kept up to `maxAgeDays`).
 */
export function nextBaseline(
	merged: RelinkSnapshot | undefined,
	current: RelinkSnapshot,
	plan: RelinkPlanItem[],
	now: Date = new Date(),
	maxAgeDays = 30,
): RelinkSnapshot {
	if (!merged) return current;
	const present = new Set(current.documents.map((d) => d.id));
	const pending = new Set(plan.map((p) => p.old.documentId));
	const cutoff = now.getTime() - maxAgeDays * 86_400_000;
	const keep = merged.documents.filter(
		(d) => !present.has(d.id) && pending.has(d.id) && time(d.seenAt ?? null) >= cutoff,
	);
	const keepIds = new Set(keep.map((d) => d.id));
	return {
		takenAt: current.takenAt,
		documents: [...current.documents, ...keep],
		ifcFiles: [...current.ifcFiles, ...merged.ifcFiles.filter((f) => keepIds.has(f.documentId))],
		alignments: [
			...current.alignments,
			...merged.alignments.filter((a) => keepIds.has(a.documentId)),
		],
	};
}

/** Latest `last-sync-ended` (epoch ms) over sync-statuses rows, or null. */
export function lastSyncEnded(rows: IDataObject[]): number | null {
	const ended = rows
		.map((r) => Date.parse(String(((r.attributes as IDataObject) ?? {})['last-sync-ended'] ?? '')))
		.filter((t) => Number.isFinite(t));
	return ended.length ? Math.max(...ended) : null;
}

// ---------------------------------------------------------------------------
// JSON:API row → model
// ---------------------------------------------------------------------------

function attrs(row: IDataObject): IDataObject {
	return (row.attributes as IDataObject) ?? {};
}

function relId(row: IDataObject, name: string): string | null {
	const rel = (row.relationships as IDataObject | undefined)?.[name] as IDataObject | undefined;
	const data = rel?.data as IDataObject | null | undefined;
	return data && data.id != null ? String(data.id) : null;
}

function str(v: unknown): string | null {
	return v === undefined || v === null || v === '' ? null : String(v);
}

function num(v: unknown): number | null {
	const n = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v);
	return Number.isFinite(n) ? n : null;
}

export function toRelinkDocument(row: IDataObject): RelinkDocument {
	const a = attrs(row);
	return {
		id: String(row.id),
		filename: String(a.filename ?? ''),
		path: String(a.path ?? ''),
		externalId: str(a['external-id']),
		isDeleted: a['is-deleted'] === true,
		deletedDate: str(a['deleted-date']),
		uploadedDate: str(a['uploaded-date']),
		lastModified: str(a['last-modified']),
		revision: num(a.revision),
		parentId: relId(row, 'parent'),
		scale: num(a.scale),
	};
}

export function toRelinkIfcFile(row: IDataObject): RelinkIfcFile {
	const a = attrs(row);
	const id = String(row.id);
	const dash = id.indexOf('-');
	return {
		id,
		buildingId: relId(row, 'building') ?? (dash > 0 ? id.slice(0, dash) : ''),
		documentId: relId(row, 'document') ?? (dash > 0 ? id.slice(dash + 1) : ''),
		layer: String(a.layer ?? ''),
		markedForDeletion: a['marked-for-deletion'] === true,
		currentlyActive: a['currently-active'] === true,
	};
}

export function toRelinkAlignment(row: IDataObject): RelinkAlignment {
	const a = attrs(row);
	const id = String(row.id);
	const dash = id.lastIndexOf('-');
	return {
		id,
		buildingId: relId(row, 'building') ?? (dash > 0 ? id.slice(dash + 1) : ''),
		documentId: relId(row, 'document') ?? (dash > 0 ? id.slice(0, dash) : ''),
		name: String(a.name ?? ''),
		imagePoints: a['image-points'] ?? [],
		worldPoints: a['world-points'] ?? [],
		maskPoints: a['mask-points'] ?? [],
		uploadedDate: str(a['uploaded-date']),
	};
}

export function toRelinkFloor(row: IDataObject): RelinkFloor {
	const a = attrs(row);
	return {
		id: String(row.id),
		buildingId: relId(row, 'building') ?? '',
		name: String(a.name ?? ''),
		height: num(a.height),
		useCustomFloorplan: a['use-custom-floorplan'] === true,
		customFloorplanDocumentId: relId(row, 'custom-floorplan-document'),
	};
}

/**
 * Source inventory row from any CDE node output. Defaults fit the Interaxo node's
 * Content Search (`id`, `name`, `path` with the file name at the end).
 */
export function toRelinkSourceFile(
	row: IDataObject,
	fields: { id?: string; name?: string; path?: string } = {},
): RelinkSourceFile | null {
	const id = str(row[fields.id ?? 'id']);
	if (!id) return null;
	const name = String(row[fields.name ?? 'name'] ?? '');
	let path = String(row[fields.path ?? 'path'] ?? '');
	if (name && pathSegments(path).slice(-1)[0] !== name)
		path = `${path.replace(/\/+$/, '')}/${name}`;
	return { id, name, path };
}
