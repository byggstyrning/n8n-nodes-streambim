import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimTopicRow = {
	id?: string;
	attributes?: {
		title?: string;
		'public-id'?: number | string;
		publicId?: number | string;
	} & IDataObject;
};

/**
 * Lists topics in the selected project, formatted for resourceLocator list
 * mode where the human label shows the public (sequential) ID and the
 * stored value is the JSON:API record ID.
 *
 * Capped to 500 most recent topics to keep the dropdown responsive.
 */
export async function loadStreamBimTopicsByPublicId(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) {
		return [];
	}

	const credentials = await this.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const response = (await streamBimJsonApiRequest.call(
		this,
		'GET',
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/topics`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
			sort: '-public-id',
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimTopicRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const attrs = row.attributes ?? {};
		const publicId = String(attrs['public-id'] ?? attrs.publicId ?? '').trim();
		const title = (attrs.title ?? '').toString().trim();
		const label = publicId
			? `#${publicId}${title ? ` — ${title}` : ''}`
			: title || `Topic ${id}`;
		return {
			name: `${label} (id: ${id})`,
			value: id,
		};
	});
}

/**
 * `listSearch` variant of `loadStreamBimTopicsByPublicId`. Used by
 * `resourceLocator` list mode (via `searchListMethod`). The optional `filter`
 * argument trims results client-side so the user can search by publicId or
 * title in the dropdown.
 */
export async function searchStreamBimTopicsByPublicId(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const options = await loadStreamBimTopicsByPublicId.call(this);
	const needle = (filter ?? '').toString().trim().toLowerCase();
	const filtered = needle
		? options.filter((opt) => opt.name.toLowerCase().includes(needle))
		: options;
	return {
		results: filtered.map((opt) => ({
			name: opt.name,
			value: String(opt.value),
		})),
	};
}
