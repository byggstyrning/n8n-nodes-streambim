import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimProjectUserRow = {
	id?: string;
	attributes?: {
		username?: string;
		email?: string;
		'full-name'?: string;
		name?: string;
	} & IDataObject;
};

/**
 * Lists users in the selected project
 * (JSON:API GET /project-{id}/api/v1/v2/users).
 */
export async function loadStreamBimProjectUserOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/users`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimProjectUserRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const attrs = row.attributes ?? {};
		const label =
			(attrs['full-name'] ?? attrs.name ?? attrs.username ?? attrs.email ?? '')
				.toString()
				.trim() || `User ${id}`;
		return {
			name: `${label} (${id})`,
			value: id,
		};
	});
}
