import type { IExecuteFunctions, INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString } from './_runHelpers';

const RESOURCE = 'building';

export const buildingOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List buildings with model layers, floor plan layer and floors',
		action: 'List buildings',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'Get one building',
		action: 'Get a building',
	},
];

export const buildingProperties: INodeProperties[] = [
	{
		displayName: 'Building Name or ID',
		name: 'buildingRecordId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getBuildings',
		},
		default: '',
		required: true,
		displayOptions: { show: { resource: [RESOURCE], operation: ['get'] } },
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	},
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
];

export async function runBuilding(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId) {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for building operations', {
			itemIndex: i,
		});
	}
	const base = `/project-${projectId}/api/v1/v2/buildings`;

	if (operation === 'getMany') {
		return await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			{},
			getV8ListPagination(ctx, i),
		);
	}
	if (operation === 'get') {
		const buildingId = String(ctx.getNodeParameter('buildingRecordId', i, '') ?? '').trim();
		if (!buildingId) {
			throw new NodeOperationError(ctx.getNode(), 'Building ID is required', {
				itemIndex: i,
			});
		}
		return await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(buildingId)}`,
			tokenCache,
			undefined,
			{},
		);
	}
	throw new NodeOperationError(ctx.getNode(), `Unknown building operation: ${operation}`);
}
