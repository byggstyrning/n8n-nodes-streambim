import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimWorkflowRow = {
	id?: string;
	attributes?: { name?: string; title?: string } & IDataObject;
};

/**
 * Lists accessible workflows for the selected project
 * (JSON:API GET /project-{id}/api/v1/v2/workflows?filter[accessible]=true).
 */
export async function loadStreamBimWorkflowOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/workflows`,
		tokenCache,
		undefined,
		{
			'filter[accessible]': true,
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimWorkflowRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const label =
			(row.attributes?.name ?? row.attributes?.title ?? '').toString().trim() ||
			`Workflow ${id}`;
		return {
			name: `${label} (${id})`,
			value: id,
		};
	});
}
