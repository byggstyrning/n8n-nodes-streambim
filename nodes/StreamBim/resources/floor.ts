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
import { buildJsonApiBody, relationshipNull, relationshipRef } from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString } from './_runHelpers';

const RESOURCE = 'floor';

export const floorOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List floors (optionally for one building)',
		action: 'List floors',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'Get one floor, including its custom floor plan document',
		action: 'Get a floor',
	},
	{
		name: 'Update',
		value: 'update',
		description: 'Set or clear the custom floor plan document of a floor',
		action: 'Update a floor',
	},
];

export const floorProperties: INodeProperties[] = [
	{
		displayName: 'Building Name or ID',
		name: 'floorBuildingId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getBuildings',
		},
		default: '',
		displayOptions: { show: { resource: [RESOURCE], operation: ['getMany'] } },
		description:
			'Only floors of this building (sent as filter[building]). Leave empty for all floors. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Floor ID',
		name: 'floorId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['get', 'update'] },
		},
	},
	{
		displayName: 'Custom Floor Plan Document ID',
		name: 'customFloorplanDocumentId',
		type: 'string',
		default: '',
		displayOptions: { show: { resource: [RESOURCE], operation: ['update'] } },
		description:
			'Document shown as the floor plan of this floor. The document needs a document alignment in the same building to be calibrated. Leave empty to clear it.',
	},
	{
		displayName: 'Use Custom Floor Plan',
		name: 'useCustomFloorplan',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [RESOURCE], operation: ['update'] } },
		description:
			'Whether the floor shows the custom floor plan instead of the plan generated from the model',
	},
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
];

/**
 * PATCH body that changes only the custom floor plan. StreamBIM treats a floor PATCH as a
 * full replacement (a body with only the floor plan fields blanks the name and sets the
 * height to 0), so every writable attribute of the current record is sent back.
 */
export function floorUpdateBody(
	current: IDataObject,
	documentId: string,
	useCustom: boolean,
): IDataObject {
	const attrs = (current.attributes as IDataObject) ?? {};
	const rels = (current.relationships as IDataObject) ?? {};
	const building = ((rels.building as IDataObject)?.data as IDataObject | null) ?? null;
	return buildJsonApiBody({
		type: 'floors',
		id: String(current.id),
		attributes: {
			name: attrs.name as string,
			height: attrs.height as number,
			hidden: attrs.hidden as boolean,
			'floor-bounds': (attrs['floor-bounds'] as IDataObject[]) ?? null,
			'use-custom-floorplan': useCustom,
		},
		relationships: {
			...(building ? { building: relationshipRef('buildings', String(building.id)) } : {}),
			'custom-floorplan-document': documentId
				? relationshipRef('documents', documentId)
				: relationshipNull(),
		},
	});
}

export async function runFloor(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId) {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for floor operations', {
			itemIndex: i,
		});
	}
	const base = `/project-${projectId}/api/v1/v2/floors`;

	if (operation === 'getMany') {
		const buildingId = String(ctx.getNodeParameter('floorBuildingId', i, '') ?? '').trim();
		return await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			buildingId ? { 'filter[building]': buildingId } : {},
			getV8ListPagination(ctx, i),
		);
	}

	const floorId = String(ctx.getNodeParameter('floorId', i, '') ?? '').trim();
	if (!floorId) {
		throw new NodeOperationError(ctx.getNode(), 'Floor ID is required', {
			itemIndex: i,
		});
	}

	if (operation === 'get') {
		return await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(floorId)}`,
			tokenCache,
			undefined,
			{},
		);
	}

	if (operation === 'update') {
		const documentId = String(
			ctx.getNodeParameter('customFloorplanDocumentId', i, '') ?? '',
		).trim();
		const useCustom = ctx.getNodeParameter('useCustomFloorplan', i, true) as boolean;
		const url = `${base}/${encodeURIComponent(floorId)}`;
		const current = (
			(await streamBimJsonApiRequest.call(
				ctx,
				'GET',
				url,
				tokenCache,
				undefined,
				{},
			)) as IDataObject
		).data as IDataObject;
		return await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			url,
			tokenCache,
			floorUpdateBody(current, documentId, useCustom && Boolean(documentId)),
			{},
		);
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown floor operation: ${operation}`);
}
