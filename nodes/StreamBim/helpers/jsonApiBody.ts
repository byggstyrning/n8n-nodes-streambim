import type { IDataObject } from 'n8n-workflow';

/**
 * Phase 1 v8 helper.
 *
 * Goal: build standard JSON:API request documents from typed inputs so the
 * resource files stop hand-rolling `{ data: { type, attributes, relationships } }`.
 */

export type JsonApiRelationshipRef = {
	type: string;
	id: string;
};

export type JsonApiRelationshipValue =
	| { data: JsonApiRelationshipRef }
	| { data: JsonApiRelationshipRef[] }
	| { data: null };

export type JsonApiBodyInput = {
	type: string;
	id?: string;
	attributes?: IDataObject;
	relationships?: Record<string, JsonApiRelationshipValue>;
};

/**
 * Build a `{ data: ... }` JSON:API document.
 */
export function buildJsonApiBody(input: JsonApiBodyInput): IDataObject {
	const data: IDataObject = { type: input.type };
	if (input.id !== undefined) data.id = input.id;
	if (input.attributes !== undefined) data.attributes = input.attributes;
	if (input.relationships !== undefined) {
		data.relationships = input.relationships as unknown as IDataObject;
	}
	return { data };
}

/**
 * Build a single relationship reference: `{ data: { type, id } }`.
 */
export function relationshipRef(type: string, id: string): { data: JsonApiRelationshipRef } {
	return { data: { type, id } };
}

/**
 * Build a multi-relationship reference: `{ data: [{ type, id }, ...] }`.
 */
export function relationshipRefs(
	refs: JsonApiRelationshipRef[],
): { data: JsonApiRelationshipRef[] } {
	return { data: refs };
}

/**
 * Build a multi-relationship from a list of bare IDs.
 */
export function relationshipRefsFromIds(
	type: string,
	ids: Array<string | number>,
): { data: JsonApiRelationshipRef[] } {
	return { data: ids.map((id) => ({ type, id: String(id) })) };
}

/**
 * Null/empty relationship: `{ data: null }`.
 */
export function relationshipNull(): { data: null } {
	return { data: null };
}

/**
 * Drop keys whose value is `undefined`, `null`, or empty string. Empty arrays
 * are kept (the caller usually wants `labels: []` to remain).
 */
export function pruneEmpty(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (typeof v === 'string' && v === '') continue;
		out[k] = v;
	}
	return out;
}
