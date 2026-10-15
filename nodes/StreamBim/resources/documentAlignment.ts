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
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const RESOURCE = 'documentAlignment';

export const documentAlignmentOperations: INodePropertyOptions[] = [
	{
		name: 'Create',
		value: 'create',
		description: 'Place a document (PDF/DWG/image) in a building',
		action: 'Create a document alignment',
	},
	{
		name: 'Delete',
		value: 'delete',
		description: 'Remove a document placement',
		action: 'Delete a document alignment',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'Get one placement by `{documentId}-{buildingId}`',
		action: 'Get a document alignment',
	},
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List placements (optionally per building or document)',
		action: 'List document alignments',
	},
];

export const documentAlignmentProperties: INodeProperties[] = [
	{
		displayName: 'Building Name or ID',
		name: 'alignmentBuildingId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getBuildings',
		},
		default: '',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['getMany', 'create'] },
		},
		description:
			'Building of the placement. For Get Many, leave empty for all buildings. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Document ID',
		name: 'alignmentDocumentId',
		type: 'string',
		default: '',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['getMany', 'create'] },
		},
		description: 'Document to place. For Get Many, filters to this document.',
	},
	{
		displayName: 'Alignment ID',
		name: 'alignmentId',
		type: 'string',
		default: '',
		required: true,
		placeholder: '1154-1000',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['get', 'delete'] },
		},
		description: 'Composite ID `{documentId}-{buildingId}`',
	},
	{
		displayName: 'Name',
		name: 'alignmentName',
		type: 'string',
		default: '',
		displayOptions: { show: { resource: [RESOURCE], operation: ['create'] } },
		description: 'Display name in the plan picker (empty shows the file name)',
	},
	{
		displayName: 'Image Points',
		name: 'imagePoints',
		type: 'json',
		default: '[[0, 0, 0], [1, 0, 1]]',
		displayOptions: { show: { resource: [RESOURCE], operation: ['create'] } },
		description: 'Two control points in document space, `[[x, 0, z], [x, 0, z]]`',
	},
	{
		displayName: 'World Points',
		name: 'worldPoints',
		type: 'json',
		default: '[[0, 0, 0], [1, 0, 1]]',
		displayOptions: { show: { resource: [RESOURCE], operation: ['create'] } },
		description:
			'The same two points in building space, `[[x, height, z], …]`. Height is the floor elevation.',
	},
	{
		displayName: 'Mask Points',
		name: 'maskPoints',
		type: 'json',
		default: '[]',
		displayOptions: { show: { resource: [RESOURCE], operation: ['create'] } },
		description: 'Optional clip polygon',
	},
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
];

export function documentAlignmentCreateBody(input: {
	documentId: string;
	buildingId: string;
	name: string;
	imagePoints: unknown;
	worldPoints: unknown;
	maskPoints: unknown;
}): IDataObject {
	return buildJsonApiBody({
		type: 'document-alignments',
		attributes: {
			name: input.name ?? '',
			'image-points': input.imagePoints as IDataObject[],
			'world-points': input.worldPoints as IDataObject[],
			'mask-points': (input.maskPoints ?? []) as IDataObject[],
		},
		relationships: {
			document: relationshipRef('documents', input.documentId),
			building: relationshipRef('buildings', input.buildingId),
		},
	});
}

function jsonParam(ctx: IExecuteFunctions, name: string, i: number): unknown {
	const raw = ctx.getNodeParameter(name, i, '[]') as unknown;
	return typeof raw === 'string' ? parseJsonBody(ctx, raw, i, name) : raw;
}

export async function runDocumentAlignment(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Project ID is required for document alignment operations',
			{
				itemIndex: i,
			},
		);
	}
	const base = `/project-${projectId}/api/v1/v2/document-alignments`;

	if (operation === 'getMany') {
		const qs: IDataObject = {};
		const buildingId = String(ctx.getNodeParameter('alignmentBuildingId', i, '') ?? '').trim();
		const documentId = String(ctx.getNodeParameter('alignmentDocumentId', i, '') ?? '').trim();
		if (buildingId) qs['filter[building]'] = buildingId;
		if (documentId) qs['filter[document]'] = documentId;
		return await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
	}

	if (operation === 'create') {
		const buildingId = String(ctx.getNodeParameter('alignmentBuildingId', i, '') ?? '').trim();
		const documentId = String(ctx.getNodeParameter('alignmentDocumentId', i, '') ?? '').trim();
		if (!buildingId || !documentId) {
			throw new NodeOperationError(ctx.getNode(), 'Building ID and Document ID are required', {
				itemIndex: i,
			});
		}
		const body = documentAlignmentCreateBody({
			documentId,
			buildingId,
			name: ctx.getNodeParameter('alignmentName', i, '') as string,
			imagePoints: jsonParam(ctx, 'imagePoints', i),
			worldPoints: jsonParam(ctx, 'worldPoints', i),
			maskPoints: jsonParam(ctx, 'maskPoints', i),
		});
		return await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
	}

	const alignmentId = String(ctx.getNodeParameter('alignmentId', i, '') ?? '').trim();
	if (!alignmentId) {
		throw new NodeOperationError(ctx.getNode(), 'Alignment ID is required', {
			itemIndex: i,
		});
	}
	const url = `${base}/${encodeURIComponent(alignmentId)}`;

	if (operation === 'get') {
		return await streamBimJsonApiRequest.call(ctx, 'GET', url, tokenCache, undefined, {});
	}
	if (operation === 'delete') {
		await streamBimJsonApiRequest.call(ctx, 'DELETE', url, tokenCache, undefined, {});
		return { deleted: true, id: alignmentId };
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown document alignment operation: ${operation}`);
}
