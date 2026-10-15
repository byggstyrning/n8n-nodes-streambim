import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type FolderRow = {
	id?: string | number;
	attributes?: { name?: string; [k: string]: unknown };
	relationships?: {
		parent?: { data?: { id?: string | number; type?: string } | null };
	};
};

/**
 * Lists folders for the selected project (JSON:API
 * GET /project-{projectId}/api/v1/v2/folders) with recursive path resolution
 * so options display as "Parent / Sub / Leaf (123)". A synthetic root option
 * (id "0") is always included.
 *
 * Fetches up to 20 pages of 1000 rows. If a project exceeds 20k folders the
 * dropdown will be capped; users can still pass the ID via an expression.
 */
export async function loadStreamBimFolderOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) return [];

	const credentials = await this.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const all: FolderRow[] = [];
	const limit = 1000;
	let skip = 0;
	for (let p = 0; p < 20; p++) {
		const res = (await streamBimJsonApiRequest.call(
			this,
			'GET',
			`/project-${encodeURIComponent(projectId)}/api/v1/v2/folders`,
			tokenCache,
			undefined,
			{ 'page[limit]': limit, 'page[skip]': skip },
		)) as IDataObject;
		const data = Array.isArray(res.data) ? (res.data as FolderRow[]) : [];
		all.push(...data);
		if (data.length < limit) break;
		skip += limit;
	}

	const byId = new Map<string, FolderRow>();
	for (const row of all) {
		if (row?.id !== undefined && row.id !== null) byId.set(String(row.id), row);
	}

	const pathFor = (id: string, seen: Set<string>): string => {
		if (seen.has(id)) return '';
		seen.add(id);
		const row = byId.get(id);
		if (!row) return '';
		const name = String(row.attributes?.name ?? id);
		const parentRaw = row.relationships?.parent?.data?.id;
		const parentId = parentRaw === undefined || parentRaw === null ? '' : String(parentRaw);
		if (!parentId || parentId === '0' || parentId === id) return name;
		const parentPath = pathFor(parentId, seen);
		return parentPath ? `${parentPath} / ${name}` : name;
	};

	const options: INodePropertyOptions[] = [
		{ name: '(Root) 0', value: '0' },
	];
	for (const row of all) {
		const id = String(row.id ?? '');
		if (!id || id === '0') continue;
		const display = pathFor(id, new Set<string>());
		const name = display || String(row.attributes?.name ?? id);
		options.push({ name: `${name} (${id})`, value: id });
	}
	options.sort((a, b) => a.name.localeCompare(b.name));
	return options;
}
