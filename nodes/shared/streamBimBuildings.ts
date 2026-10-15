import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimBuildingRow = {
	id?: string;
	attributes?: IDataObject;
};

function isPlaceholderName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return normalized === '' || normalized === '<no name>' || normalized === 'no name';
}

function getRawBuildingName(row: StreamBimBuildingRow): string {
	const attributes = row.attributes ?? {};
	const raw =
		attributes.name ??
		attributes.filename ??
		attributes.label ??
		attributes.title ??
		attributes['building-name'];
	return String(raw ?? '').trim();
}

function getBuildingName(row: StreamBimBuildingRow, fallbackName: string): string {
	const name = getRawBuildingName(row);
	return isPlaceholderName(name) ? fallbackName || String(row.id ?? 'Building') : name;
}

async function loadStreamBimProjectName(
	ctx: ILoadOptionsFunctions,
	projectId: string,
	tokenCache: StreamBimTokenCache,
): Promise<string> {
	try {
		const response = (await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/mgw/api/v3/projects/${encodeURIComponent(projectId)}`,
			tokenCache,
			undefined,
			{},
		)) as IDataObject;
		const row = response.data as { attributes?: IDataObject } | undefined;
		const name = String(row?.attributes?.name ?? '').trim();
		return name || `Project ${projectId}`;
	} catch {
		return `Project ${projectId}`;
	}
}

/**
 * Lists buildings for the selected project (JSON:API GET /project-{id}/api/v1/v2/buildings).
 */
export async function loadStreamBimBuildingOptions(
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
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/buildings`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimBuildingRow[]) ?? [];
	const hasUnnamedBuilding = rows.some((row) => isPlaceholderName(getRawBuildingName(row)));
	const fallbackName = hasUnnamedBuilding
		? await loadStreamBimProjectName(this, projectId, tokenCache)
		: '';
	return rows.map((row) => {
		const id = String(row.id ?? '');
		return {
			name: `${getBuildingName(row, fallbackName)} (${id})`,
			value: id,
		};
	});
}
