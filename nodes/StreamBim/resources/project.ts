import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import {
	buildTypedFilters,
	rawJsonFiltersField,
	rawJsonFiltersToggle,
	typedFiltersField,
	type TypedFilterDef,
} from '../helpers/filters';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const PROJECT_FILTER_DEFS: TypedFilterDef[] = [
	{
		displayName: 'Active',
		name: 'active',
		type: 'boolean',
		default: true,
		description: 'Whether to filter by the active flag (sent as filter[active])',
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		description: 'Substring or exact match on project name (sent as filter[name])',
	},
	{
		displayName: 'Region',
		name: 'region',
		type: 'string',
		default: '',
		description: 'Filter by region (sent as filter[region])',
	},
];

const PROJECT_SORT_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Name (Ascending)', value: 'name' },
	{ name: 'Name (Descending)', value: '-name' },
	{ name: 'Created At (Ascending)', value: 'createdAt' },
	{ name: 'Created At (Descending)', value: '-createdAt' },
	{ name: 'Updated At (Ascending)', value: 'updatedAt' },
	{ name: 'Updated At (Descending)', value: '-updatedAt' },
];

export const projectOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List projects with JSON:API query parameters',
		action: 'List projects',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single project by ID',
		action: 'Get project',
	},
];

export const projectProperties: INodeProperties[] = [
	rawJsonFiltersToggle(['getMany'], {
		resource: 'project',
		name: 'projectsUseRawJson',
		displayName: 'Advanced — Use Raw JSON Query',
		description:
			'Whether to provide query parameters as a raw JSON object (escape hatch for filters not expressible in the Filters UI)',
	}),
	typedFiltersField(['getMany'], PROJECT_FILTER_DEFS, {
		resource: 'project',
		sortOptions: PROJECT_SORT_OPTIONS,
		name: 'projectsFilters',
		hideWhenRawJson: true,
		rawJsonToggleName: 'projectsUseRawJson',
	}),
	rawJsonFiltersField(['getMany'], {
		resource: 'project',
		name: 'projectsQueryParameters',
		toggleName: 'projectsUseRawJson',
		displayName: 'Query Parameters (Raw JSON)',
		defaultValue: '{\n  "filter[active]": true\n}\n',
		description:
			'JSON object merged into the query string (escape hatch).',
	}),
];

export async function runProject(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	if (operation === 'getMany') {
		const useRaw = ctx.getNodeParameter('projectsUseRawJson', i, false) as boolean;
		let qs: IDataObject = {};
		if (useRaw) {
			const raw = ctx.getNodeParameter('projectsQueryParameters', i, '') as string;
			if (raw && raw.trim()) qs = parseJsonBody(ctx, raw, i, 'Query parameters');
		} else {
			const filters = ctx.getNodeParameter('projectsFilters', i, {}) as IDataObject;
			qs = buildTypedFilters(filters, PROJECT_FILTER_DEFS);
		}
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			'/mgw/api/v3/projects',
			tokenCache,
			qs,
			{ mode: 'all', pageLimit: 1000, pageSkip: 0, maxPages: 5000 },
		);
		return response;
	}
	if (operation === 'get') {
		const projectId = getProjectIdString(ctx, i);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/mgw/api/v3/projects/${projectId}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}
	throw new NodeOperationError(ctx.getNode(), `Unknown project operation: ${operation}`);
}
