import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type LabelRow = {
	id?: string | number;
	attributes?: { name?: string };
};

/**
 * Lists document labels for the selected project
 * (JSON:API GET /project-{projectId}/api/v1/v2/document-labels), up to 500.
 */
export async function loadStreamBimDocumentLabelOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) return [];

	const credentials = await this.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const response = (await streamBimJsonApiRequest.call(
		this,
		'GET',
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/document-labels`,
		tokenCache,
		undefined,
		{ 'page[limit]': 500, 'page[skip]': 0 },
	)) as IDataObject;

	const rows = (response.data as LabelRow[]) ?? [];
	const options = rows.map((row) => {
		const id = String(row.id ?? '');
		const label = row.attributes?.name ?? 'Label';
		return { name: `${label} (${id})`, value: id };
	});
	options.sort((a, b) => a.name.localeCompare(b.name));
	return options;
}
