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
import { buildJsonApiBody, relationshipRef } from '../helpers/jsonApiBody';
import {
	buildFilters,
	filtersField,
	rawJsonFiltersField,
	rawJsonFiltersToggle,
} from '../helpers/filters';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import {
	getProjectIdNumber,
	getProjectIdString,
	parseJsonBody,
} from './_runHelpers';

export const converterJobOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List converter jobs (filter by project)',
		action: 'List converter jobs',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Create a converter job for a building',
		action: 'Create converter job',
	},
	{
		name: 'Get Status',
		value: 'getStatus',
		description: 'GET converter status by job ID',
		action: 'Get converter job status',
	},
];

export const converterJobProperties: INodeProperties[] = [
	{
		displayName: 'Building Name or ID',
		name: 'buildingId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getBuildings',
		},
		displayOptions: {
			show: {
				resource: ['converterJob'],
				operation: ['create', 'getMany'],
			},
		},
		default: '',
		description:
			'Building from the selected project. Optional filter for Get Many; required for Create. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		displayOptions: {
			show: {
				resource: ['converterJob'],
				operation: ['getStatus'],
			},
		},
		default: '',
		required: true,
		placeholder: 'e.g. 4f3c0b1e-8a99-4b6f-9b8d-…',
		description: 'Converter job ID returned by Create. Used to fetch /cmv3/converter-statuses/{jobId}.',
	},
	{
		displayName: 'Floorplan Layer Name or ID',
		name: 'converterFloorplanLayer',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId', 'buildingId'],
			loadOptionsMethod: 'getFloorplanLayers',
		},
		default: 'M',
		description:
			'IFC model layer for floor plan generation (`floorplan-layer`), loaded from ifc-files on the selected building. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: {
			show: {
				resource: ['converterJob'],
				operation: ['create'],
			},
		},
	},
	{
		displayName: 'Name',
		name: 'converterName',
		type: 'string',
		default: 'Conversion',
		description: 'Display name for the conversion job (sent as the `name` attribute)',
		displayOptions: {
			show: {
				resource: ['converterJob'],
				operation: ['create'],
			},
		},
	},
	{
		displayName: 'Persist',
		name: 'converterPersist',
		type: 'boolean',
		default: false,
		description: 'Whether to persist the conversion result (sent as the `persist` attribute)',
		displayOptions: {
			show: {
				resource: ['converterJob'],
				operation: ['create'],
			},
		},
	},
	rawJsonFiltersToggle(['getMany'], {
		resource: 'converterJob',
		name: 'converterUseRawJson',
		displayName: 'Advanced — Use Raw JSON Query',
		description:
			'Whether to provide additional filter[...] parameters as a raw JSON object (escape hatch beyond the Filters UI)',
	}),
	filtersField(['getMany'], {
		resource: 'converterJob',
		name: 'converterFilters',
		displayName: 'Filters',
		hideWhenRawJson: true,
		rawJsonToggleName: 'converterUseRawJson',
	}),
	rawJsonFiltersField(['getMany'], {
		resource: 'converterJob',
		name: 'converterRawJsonFilters',
		toggleName: 'converterUseRawJson',
		displayName: 'Query Parameters (Raw JSON)',
		defaultValue: '{\n  "filter[status]": "complete"\n}\n',
		description:
			'JSON object merged into the query string (escape hatch). filter[project] and filter[building] are always added from the dropdowns above.',
	}),
	...buildReturnAllAndLimit(['getMany'], { resource: 'converterJob', defaultLimit: 100 }),
];

export async function runConverterJob(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	if (operation === 'getMany') {
		const projectId = getProjectIdNumber(ctx, i);
		const buildingId = ctx.getNodeParameter('buildingId', i, '') as string;
		const useRaw = ctx.getNodeParameter('converterUseRawJson', i, false) as boolean;
		let extraQs: IDataObject = {};
		if (useRaw) {
			const raw = ctx.getNodeParameter('converterRawJsonFilters', i, '') as string;
			if (raw && raw.trim()) extraQs = parseJsonBody(ctx, raw, i, 'Query parameters');
		} else {
			const filters = ctx.getNodeParameter('converterFilters', i, {}) as IDataObject;
			extraQs = buildFilters(filters);
		}
		const qs: IDataObject = {
			...extraQs,
			'filter[project]': projectId,
		};
		if (buildingId) qs['filter[building]'] = buildingId;
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			'/cmv3/converter-jobs',
			tokenCache,
			qs,
			getV8ListPagination(ctx, i, { defaultLimit: 100 }),
		);
		return response;
	}
	if (operation === 'create') {
		const projectId = getProjectIdString(ctx, i);
		const buildingId = ctx.getNodeParameter('buildingId', i) as string;
		if (!buildingId) {
			throw new NodeOperationError(ctx.getNode(), 'Building ID is required to create a converter job', {
				itemIndex: i,
			});
		}
		const floorplanLayer = ctx.getNodeParameter('converterFloorplanLayer', i, 'M') as string;
		const name = ctx.getNodeParameter('converterName', i, 'Conversion') as string;
		const persist = ctx.getNodeParameter('converterPersist', i, false) as boolean;
		const body = buildJsonApiBody({
			type: 'converter-jobs',
			attributes: {
				'floorplan-layer': floorplanLayer,
				name,
				persist,
			},
			relationships: {
				building: relationshipRef('buildings', buildingId),
				project: relationshipRef('projects', String(projectId)),
			},
		});
		return streamBimJsonApiRequest.call(ctx, 'POST', '/cmv3/converter-jobs', tokenCache, body, {});
	}
	if (operation === 'getStatus') {
		const jobId = ctx.getNodeParameter('jobId', i) as string;
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/cmv3/converter-statuses/${encodeURIComponent(jobId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}
	throw new NodeOperationError(ctx.getNode(), `Unknown converter job operation: ${operation}`);
}
