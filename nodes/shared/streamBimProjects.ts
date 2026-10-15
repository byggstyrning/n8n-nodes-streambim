import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

/**
 * Lists projects for the node Project dropdown (JSON:API GET /mgw/api/v3/projects).
 */
export async function loadStreamBimProjectOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const response = (await streamBimJsonApiRequest.call(
		this,
		'GET',
		'/mgw/api/v3/projects',
		tokenCache,
		undefined,
		{
			'page[limit]': 100,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as Array<{ id?: string; attributes?: { name?: string } }>) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const label = row.attributes?.name ?? 'Project';
		return {
			name: `${label} (${id})`,
			value: id,
		};
	});
}
