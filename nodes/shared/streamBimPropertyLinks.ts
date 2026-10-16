import type { IDataObject } from 'n8n-workflow';

/**
 * Document links by property value.
 *
 * StreamBIM groups every element that shares a property value under a
 * "virtual" IFC object. An attachment on that object shows on all of those
 * elements. Its id is base64url("ifcelement~<pset>~<property>~<type>~<value>").
 *
 * This module holds the pure planning logic: which value gets which document,
 * which existing links already cover it and which links point at documents that
 * are gone. The node resource does the HTTP calls.
 */

export type PropertyRef = { psetName: string; propertyName: string };

/** "Text.Sheet Number" or "Text~Sheet Number" → { psetName: "Text", propertyName: "Sheet Number" }. */
export function parsePropertyRef(raw: string): PropertyRef | undefined {
	const s = String(raw ?? '').trim();
	const sep = s.includes('~') ? '~' : '.';
	const at = s.indexOf(sep);
	if (at <= 0 || at === s.length - 1) return undefined;
	const psetName = s.slice(0, at).trim();
	const propertyName = s.slice(at + 1).trim();
	if (!psetName || !propertyName) return undefined;
	return { psetName, propertyName };
}

/** Field name in IFC search exports, e.g. "Text~Sheet Number". */
export function exportFieldName(ref: PropertyRef): string {
	return `${ref.psetName}~${ref.propertyName}`;
}

/** RFC 4648 §5 base64url of the UTF-8 bytes, without padding. */
export function base64Url(s: string): string {
	return Buffer.from(s, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function virtualObjectId(ref: PropertyRef, valueType: string, value: string): string {
	return base64Url(`ifcelement~${ref.psetName}~${ref.propertyName}~${valueType}~${value}`);
}

export type LinkTarget =
	| { kind: 'element'; guid: string }
	| { kind: 'property'; property: string; value: string; valueType?: string };

/** IFC object id to attach to: the element GUID as given, or the virtual object of a property value. */
export function linkTargetObjectId(target: LinkTarget): string {
	if (target.kind === 'element') {
		const guid = String(target.guid ?? '').trim();
		if (!guid) throw new Error('Element GUID is required');
		return guid;
	}
	const ref = parsePropertyRef(target.property);
	if (!ref) {
		throw new Error(
			`Property "${target.property}" must be "Property Set.Property", e.g. "Text.Sheet Number"`,
		);
	}
	const value = String(target.value ?? '');
	if (!value.trim()) throw new Error('Property value is required');
	return virtualObjectId(ref, target.valueType || 'str', value);
}

export type ExportRow = { buildingId: string; guid?: string; value: unknown };

export type PropertyValueGroup = {
	value: string;
	objectId: string;
	elementCount: number;
	buildingIds: string[];
	sampleGuids: string[];
};

/**
 * One group per distinct value. Virtual objects are project-wide, so a value
 * found in several buildings is still one group. Empty values are dropped.
 */
export function groupPropertyValues(
	rows: ExportRow[],
	ref: PropertyRef,
	valueType: string,
): PropertyValueGroup[] {
	const groups = new Map<string, PropertyValueGroup>();
	for (const row of rows) {
		if (row.value === undefined || row.value === null) continue;
		const value = String(row.value);
		if (!value.trim()) continue;
		let g = groups.get(value);
		if (!g) {
			g = {
				value,
				objectId: virtualObjectId(ref, valueType, value),
				elementCount: 0,
				buildingIds: [],
				sampleGuids: [],
			};
			groups.set(value, g);
		}
		g.elementCount += 1;
		if (!g.buildingIds.includes(row.buildingId)) g.buildingIds.push(row.buildingId);
		if (row.guid && g.sampleGuids.length < 5) g.sampleGuids.push(row.guid);
	}
	return [...groups.values()].sort((a, b) => a.value.localeCompare(b.value));
}

export type LinkDocument = {
	id: string;
	filename: string;
	path: string;
	revision: number | null;
	isDeleted: boolean;
};

export function toLinkDocument(row: IDataObject): LinkDocument {
	const a = (row.attributes ?? {}) as IDataObject;
	return {
		id: String(row.id ?? ''),
		filename: String(a.filename ?? ''),
		path: String(a.path ?? ''),
		revision: typeof a.revision === 'number' ? a.revision : null,
		isDeleted: a['is-deleted'] === true || (a['deleted-date'] ?? null) !== null,
	};
}

export function splitFilename(filename: string): { stem: string; ext: string } {
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return { stem: filename, ext: '' };
	return { stem: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

/** "pdf, .DWG" → ["pdf", "dwg"]. Empty means any extension. */
export function parseExtensions(raw: string): string[] {
	return String(raw ?? '')
		.split(',')
		.map((e) => e.trim().toLowerCase().replace(/^\./, ''))
		.filter((e) => e.length > 0);
}

function matchKey(s: string): string {
	return s.trim().toLowerCase();
}

/** Live documents with an allowed extension, keyed by case-insensitive filename stem. */
export function indexDocumentsByStem(
	docs: LinkDocument[],
	extensions: string[],
): Map<string, LinkDocument[]> {
	const index = new Map<string, LinkDocument[]>();
	for (const d of docs) {
		if (d.isDeleted) continue;
		const { stem, ext } = splitFilename(d.filename);
		if (!stem.trim()) continue;
		if (extensions.length && !extensions.includes(ext)) continue;
		const key = matchKey(stem);
		const list = index.get(key);
		if (list) list.push(d);
		else index.set(key, [d]);
	}
	return index;
}

export type MatchStatus = 'matched' | 'no_document' | 'ambiguous';

export type DocumentMatch = {
	status: MatchStatus;
	document?: LinkDocument;
	candidates?: LinkDocument[];
};

/** Exactly one document whose filename stem equals the value. Two or more is ambiguous: no link. */
export function matchDocument(value: string, index: Map<string, LinkDocument[]>): DocumentMatch {
	const hits = index.get(matchKey(value)) ?? [];
	if (hits.length === 1) return { status: 'matched', document: hits[0] };
	if (hits.length === 0) return { status: 'no_document' };
	return { status: 'ambiguous', candidates: hits };
}

export type ExistingLink = {
	attachmentId: string;
	documentId: string;
	isDeleted: boolean;
	filename: string;
};

/** Attachment rows that link a project document. Uploaded files, screenshots etc. return undefined. */
export function toExistingLink(row: IDataObject): ExistingLink | undefined {
	if (row.type !== 'attachments') return undefined;
	const rel = (row.relationships ?? {}) as IDataObject;
	const linked = ((rel['linked-document'] ?? {}) as IDataObject).data as IDataObject | null;
	if (!linked || linked.id === undefined || linked.id === null) return undefined;
	const a = (row.attributes ?? {}) as IDataObject;
	return {
		attachmentId: String(row.id),
		documentId: String(linked.id),
		isDeleted: a['is-deleted'] === true || (a['deleted-at'] ?? null) !== null,
		filename: String(a.filename ?? ''),
	};
}

export type LinkAction = 'create' | 'exists' | 'removed_by_user' | 'none';

export type PropertyLinkPlan = PropertyValueGroup & {
	status: MatchStatus;
	document: LinkDocument | null;
	candidates?: LinkDocument[];
	link: LinkAction;
	/** Live links whose document is not among the live documents. Verified before removal. */
	stale: ExistingLink[];
};

export type PlanOptions = {
	/** Link again when someone removed the link to this document by hand. */
	relinkRemoved: boolean;
	removeDeleted: boolean;
};

export function planPropertyLink(
	group: PropertyValueGroup,
	match: DocumentMatch,
	links: ExistingLink[],
	liveDocumentIds: Set<string>,
	opts: PlanOptions,
): PropertyLinkPlan {
	let link: LinkAction = 'none';
	if (match.status === 'matched' && match.document) {
		const same = links.filter((l) => l.documentId === match.document!.id);
		if (same.some((l) => !l.isDeleted)) link = 'exists';
		else if (same.length > 0 && !opts.relinkRemoved) link = 'removed_by_user';
		else link = 'create';
	}
	const stale = opts.removeDeleted
		? links.filter((l) => !l.isDeleted && !liveDocumentIds.has(l.documentId))
		: [];
	return {
		...group,
		status: match.status,
		document: match.document ?? null,
		...(match.candidates ? { candidates: match.candidates } : {}),
		link,
		stale,
	};
}

/** JSON:API body that links a project document to an IFC object (element GUID or virtual object id). */
export function documentLinkBody(objectId: string, documentId: string): IDataObject {
	const none = { data: null };
	return {
		data: {
			type: 'attachments',
			attributes: { 'is-deleted': false, category: 'document', url: null },
			relationships: {
				'parent-ifc-object': { data: { id: objectId, type: 'ifc-object' } },
				'linked-document': { data: { type: 'documents', id: documentId } },
				'parent-topic': none,
				'parent-topic-comment': none,
				'parent-topic-viewpoint': none,
				'parent-workflow': none,
				'parent-checklist-item': none,
				'parent-checklist-item-instance': none,
				'parent-project': none,
				'parent-checklist': none,
				'parent-topic-report-template': none,
			},
		},
	};
}
