import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimChecklistRow = {
	id?: string;
	attributes?: { title?: string } & IDataObject;
};

/**
 * Lists checklists for the selected project, used as a loadOptions source
 * for the v8 "Filter Checklist" picker on the checklist exportJson form.
 *
 * Endpoint: JSON:API GET /project-{projectId}/api/v1/v2/checklists
 * Returns:  { name: attributes.title, value: id }
 *
 * Falls back to an empty list when no project is selected so the dropdown
 * stays usable while the user is still picking a project.
 */
export async function loadStreamBimChecklistOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/checklists`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimChecklistRow[]) ?? [];
	return rows.map((row) => {
		const id = String(row.id ?? '');
		const title = String(row.attributes?.title ?? '').trim() || `Checklist ${id}`;
		return {
			name: `${title} (${id})`,
			value: id,
		};
	});
}
