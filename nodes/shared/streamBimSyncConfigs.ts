import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimSyncConfigRow = {
	id?: string;
	attributes?: {
		label?: string;
		[k: string]: unknown;
	};
};

/**
 * Lists sync configs for the selected project — used by the Sync.updateConfig
 * dropdown. Calls GET /project-{projectId}/api/v1/v2/configs.
 *
 * Each row maps to `{ name: attributes.label || id, value: id }`. Returns an
 * empty list when no project is selected so the dropdown stays clean.
 */
export async function loadStreamBimSyncConfigOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/configs`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimSyncConfigRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const label = (row.attributes?.label as string | undefined)?.trim() || id || 'Config';
		return {
			name: id ? `${label} (${id})` : label,
			value: id,
		};
	});
}
