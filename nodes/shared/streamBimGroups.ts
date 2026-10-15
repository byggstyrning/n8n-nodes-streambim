import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimGroupRow = {
	id?: string;
	attributes?: { name?: string } & IDataObject;
};

/**
 * Lists project groups (JSON:API GET /project-{id}/api/v1/v2/groups).
 */
export async function loadStreamBimGroupOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/groups`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimGroupRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const name = (row.attributes?.name ?? '').toString().trim() || `Group ${id}`;
		return {
			name: `${name} (${id})`,
			value: id,
		};
	});
}
