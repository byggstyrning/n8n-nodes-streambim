import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type DocumentRow = {
	id?: string | number;
	attributes?: { filename?: string };
};

async function fetchDocumentRows(
	ctx: ILoadOptionsFunctions,
	projectId: string,
): Promise<DocumentRow[]> {
	const credentials = await ctx.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const response = (await streamBimJsonApiRequest.call(
		ctx,
		'GET',
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/documents`,
		tokenCache,
		undefined,
		{ 'page[limit]': 200, 'page[skip]': 0, 'filter[isDeleted]': false },
	)) as IDataObject;

	return (response.data as DocumentRow[]) ?? [];
}

/**
 * Document picker hint as loadOptions (used by typed dropdowns).
 * Lists the first 200 non-deleted documents in the project.
 */
export async function loadStreamBimDocumentHintOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) return [];

	const rows = await fetchDocumentRows(this, projectId);
	const options = rows.map((row) => {
		const id = String(row.id ?? '');
		const name = row.attributes?.filename ?? 'Document';
		return { name: `${name} (${id})`, value: id };
	});
	options.sort((a, b) => a.name.localeCompare(b.name));
	return options;
}

/**
 * Document picker hint as searchListMethod (used by the resourceLocator
 * "From List" mode). Returns the first 200 non-deleted documents; the
 * optional `filter` substring is matched against the filename, case-insensitive.
 */
export async function searchStreamBimDocumentHints(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) return { results: [] };

	const rows = await fetchDocumentRows(this, projectId);
	const needle = (filter ?? '').trim().toLowerCase();
	const items = rows
		.map((row) => {
			const id = String(row.id ?? '');
			const name = row.attributes?.filename ?? `Document ${id}`;
			return { name: `${name} (${id})`, value: id };
		})
		.filter((item) => !needle || item.name.toLowerCase().includes(needle));
	items.sort((a, b) => a.name.localeCompare(b.name));
	return { results: items };
}
