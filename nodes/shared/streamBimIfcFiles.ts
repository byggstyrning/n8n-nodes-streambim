import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

export type StreamBimIfcFileRow = {
	id?: string;
	type?: string;
	attributes?: IDataObject;
	relationships?: IDataObject;
};

function buildTokenCache(credentials: IDataObject): StreamBimTokenCache {
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	return { regionSubdomain };
}

/**
 * Fetch ifc-files for a building.
 *
 * @see GET /project-{projectId}/api/v1/v2/ifc-files?filter[building]={buildingId}
 */
export async function fetchStreamBimIfcFileRows(
	ctx: ILoadOptionsFunctions,
	projectId: string,
	buildingId: string,
	pageLimit = 500,
): Promise<StreamBimIfcFileRow[]> {
	const credentials = await ctx.getCredentials('streamBimApi');
	const tokenCache = buildTokenCache(credentials);

	const response = (await streamBimJsonApiRequest.call(
		ctx,
		'GET',
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/ifc-files`,
		tokenCache,
		undefined,
		{
			'filter[building]': buildingId,
			'page[limit]': pageLimit,
			'page[skip]': 0,
		},
	)) as IDataObject;

	return (response.data as StreamBimIfcFileRow[]) ?? [];
}

/**
 * IFC file picker (composite id + layer label).
 */
export async function loadStreamBimIfcFileOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	const buildingId = String(this.getCurrentNodeParameter('buildingId') ?? '').trim();
	if (!projectId || !buildingId) {
		return [];
	}

	const rows = await fetchStreamBimIfcFileRows(this, projectId, buildingId);
	const options = rows.map((row) => {
		const id = String(row.id ?? '');
		const attrs = row.attributes ?? {};
		const layer = String(attrs.layer ?? attrs['active-layer'] ?? 'layer').trim();
		return { name: `${layer} (${id})`, value: id };
	});
	options.sort((a, b) => a.name.localeCompare(b.name));
	return options;
}

/**
 * Distinct layer tokens from ifc-files rows (tilde-separated sublayers expanded).
 */
export function distinctLayerTokensFromIfcFileRows(rows: StreamBimIfcFileRow[]): string[] {
	const layers = new Set<string>();
	for (const row of rows) {
		const attrs = row.attributes ?? {};
		const raw = attrs.layer ?? attrs['active-layer'];
		const layer = String(raw ?? '').trim();
		if (!layer) continue;
		for (const token of layer.split('~')) {
			const trimmed = token.trim();
			if (trimmed) layers.add(trimmed);
		}
	}
	return [...layers].sort((a, b) => a.localeCompare(b));
}

/** Document id suffix from composite ifc-file id `{buildingId}-{documentId}`. */
export function parseDocumentIdFromIfcFileId(ifcFileId: string): string | null {
	const id = String(ifcFileId ?? '').trim();
	if (!id || !id.includes('-')) return null;
	const suffix = id.split('-').slice(1).join('-').trim();
	return suffix || null;
}

/** Building id prefix from composite ifc-file id `{buildingId}-{documentId}`. */
export function parseBuildingIdFromIfcFileId(ifcFileId: string): string | null {
	const id = String(ifcFileId ?? '').trim();
	if (!id || !id.includes('-')) return null;
	const prefix = id.split('-')[0]?.trim();
	return prefix || null;
}

export function extractDocumentIdFromIfcFileRow(row: StreamBimIfcFileRow): string | null {
	const rel = row.relationships?.document as IDataObject | undefined;
	const relData = rel?.data as IDataObject | undefined;
	const fromRel = String(relData?.id ?? '').trim();
	if (fromRel) return fromRel;
	return parseDocumentIdFromIfcFileId(String(row.id ?? ''));
}

export function extractBuildingIdFromIfcFileRow(row: StreamBimIfcFileRow): string | null {
	const rel = row.relationships?.building as IDataObject | undefined;
	const relData = rel?.data as IDataObject | undefined;
	const fromRel = String(relData?.id ?? '').trim();
	if (fromRel) return fromRel;
	return parseBuildingIdFromIfcFileId(String(row.id ?? ''));
}

export function isIfcFileRow(value: unknown): value is StreamBimIfcFileRow {
	if (!value || typeof value !== 'object') return false;
	const row = value as StreamBimIfcFileRow;
	return row.type === 'ifc-files' || Boolean(row.id && String(row.id).includes('-'));
}

/** Document ids linked via ifc-files rows, optionally scoped to one building. */
export function linkedDocumentIdsFromIfcFileRows(
	rows: StreamBimIfcFileRow[],
	buildingId?: string,
): Set<string> {
	const building = String(buildingId ?? '').trim();
	const ids = new Set<string>();
	for (const row of rows) {
		if (building) {
			const rowBuilding = extractBuildingIdFromIfcFileRow(row);
			if (rowBuilding && rowBuilding !== building) continue;
		}
		const documentId = extractDocumentIdFromIfcFileRow(row);
		if (documentId) ids.add(documentId);
	}
	return ids;
}

export function ifcFileRowsFromJsonApiResponse(response: unknown): StreamBimIfcFileRow[] {
	if (!response || typeof response !== 'object') return [];
	const envelope = response as IDataObject;
	if (Array.isArray(envelope.data)) {
		return envelope.data as StreamBimIfcFileRow[];
	}
	return [];
}

/** Node-only filter keys on Document → Get Many (not sent to StreamBIM API). */
export const DOCUMENT_IFC_FILE_FILTER_KEYS = ['ifcFileBuildingId', 'missingIfcFile'] as const;
