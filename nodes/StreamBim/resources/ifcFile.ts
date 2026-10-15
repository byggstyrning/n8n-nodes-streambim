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
	extractDocumentIdFromIfcFileRow,
	isIfcFileRow,
	parseDocumentIdFromIfcFileId,
	type StreamBimIfcFileRow,
} from '../../shared/streamBimIfcFiles';
import {
	buildJsonApiBody,
	pruneEmpty,
	relationshipRef,
} from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const RESOURCE = 'ifcFile';

export const ifcFileOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List IFC file records for a building',
		action: 'List IFC files',
	},
	{
		name: 'Get Document',
		value: 'getDocument',
		description: 'GET the linked StreamBIM document for an IFC file (by composite ID or input row)',
		action: 'Get document for IFC file',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Link a document to a building in a model layer',
		action: 'Create IFC file',
	},
	{
		name: 'Update',
		value: 'update',
		description: 'PATCH layer assignment or deletion status',
		action: 'Update IFC file',
	},
];

const buildingIdField: INodeProperties = {
	displayName: 'Building Name or ID',
	name: 'buildingId',
	type: 'options',
	typeOptions: {
		loadOptionsDependsOn: ['projectId'],
		loadOptionsMethod: 'getBuildings',
	},
	default: '',
	required: true,
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['getMany', 'create', 'update'] },
	},
	description:
		'Building for IFC file operations. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

const ifcFileIdField: INodeProperties = {
	displayName: 'IFC File Name or ID',
	name: 'ifcFileId',
	type: 'options',
	typeOptions: {
		loadOptionsDependsOn: ['projectId', 'buildingId'],
		loadOptionsMethod: 'getIfcFiles',
	},
	default: '',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['getDocument', 'update'] },
	},
	description:
		'Composite IFC file ID `{buildingId}-{documentId}` (e.g. `1000-1094`). Leave empty to use the input item when it is an ifc-files row. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

const ifcFileDocumentOutputField: INodeProperties = {
	displayName: 'Output',
	name: 'ifcFileDocumentOutput',
	type: 'options',
	options: [
		{
			name: 'Document Only',
			value: 'documentOnly',
			description: 'Return the linked document JSON:API record',
		},
		{
			name: 'IFC File and Document',
			value: 'ifcFileAndDocument',
			description: 'Return `{ ifcFile, document }` with both records',
		},
	],
	default: 'documentOnly',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['getDocument'] },
	},
	description: 'Shape of the response item',
};

const ifcFileUseRawBody: INodeProperties = {
	displayName: 'Use Raw JSON Body',
	name: 'useRawJsonBody',
	type: 'boolean',
	default: false,
	description: 'Whether to edit the full JSON:API body instead of typed fields',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['create', 'update'] },
	},
};

const ifcFileTypedFields: INodeProperties[] = [
	{
		displayName: 'Document Name or ID',
		name: 'documentId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getDocumentsHint' },
		default: '',
		required: true,
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create'],
				useRawJsonBody: [false],
			},
		},
		description:
			'StreamBIM document to link. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Layer',
		name: 'layer',
		type: 'string',
		default: 'M',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description:
			'Model layer assignment. Use tilde for multiple sublayers (e.g. `M~E`). When no layer exists yet, any string is accepted.',
	},
	{
		displayName: 'Marked for Deletion',
		name: 'markedForDeletion',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description: 'Whether the IFC file record is marked for deletion',
	},
];

const ifcFileRawBody: INodeProperties = {
	displayName: 'Body',
	name: 'ifcFileBody',
	type: 'json',
	default:
		'{\n  "data": {\n    "type": "ifc-files",\n    "attributes": {\n      "layer": "M",\n      "marked-for-deletion": false\n    },\n    "relationships": {\n      "document": { "data": { "type": "documents", "id": "1022" } },\n      "building": { "data": { "type": "buildings", "id": "1000" } }\n    }\n  }\n}\n',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['create', 'update'],
			useRawJsonBody: [true],
		},
	},
	description: 'Raw JSON:API ifc-files body for create/update',
};

export const ifcFileProperties: INodeProperties[] = [
	buildingIdField,
	ifcFileIdField,
	ifcFileDocumentOutputField,
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
	ifcFileUseRawBody,
	...ifcFileTypedFields,
	ifcFileRawBody,
];

function buildIfcFileTypedBody(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
): IDataObject {
	const buildingId = String(ctx.getNodeParameter('buildingId', i, '') ?? '').trim();
	const layer = (ctx.getNodeParameter('layer', i, '') as string).trim();
	const markedForDeletion = ctx.getNodeParameter('markedForDeletion', i, false) as boolean;

	const attributes = pruneEmpty({
		layer: layer || undefined,
		'marked-for-deletion': markedForDeletion,
	});

	const relationships: Record<string, ReturnType<typeof relationshipRef>> = {};
	if (buildingId) {
		relationships.building = relationshipRef('buildings', buildingId);
	}

	if (operation === 'create') {
		const documentId = String(ctx.getNodeParameter('documentId', i, '') ?? '').trim();
		if (!documentId) {
			throw new NodeOperationError(ctx.getNode(), 'Document ID is required to create an IFC file', {
				itemIndex: i,
			});
		}
		if (!layer) {
			throw new NodeOperationError(ctx.getNode(), 'Layer is required to create an IFC file', {
				itemIndex: i,
			});
		}
		relationships.document = relationshipRef('documents', documentId);
	}

	if (operation === 'update') {
		const ifcFileId = String(ctx.getNodeParameter('ifcFileId', i, '') ?? '').trim();
		if (!ifcFileId) {
			throw new NodeOperationError(ctx.getNode(), 'IFC File ID is required', { itemIndex: i });
		}
		const documentId = ifcFileId.includes('-') ? ifcFileId.split('-').slice(1).join('-') : '';
		if (documentId) {
			relationships.document = relationshipRef('documents', documentId);
		}
		return buildJsonApiBody({
			type: 'ifc-files',
			id: ifcFileId,
			...(Object.keys(attributes).length > 0 ? { attributes } : {}),
			...(Object.keys(relationships).length > 0 ? { relationships } : {}),
		});
	}

	return buildJsonApiBody({
		type: 'ifc-files',
		attributes,
		relationships,
	});
}

function resolveIfcFileRow(ctx: IExecuteFunctions, i: number): StreamBimIfcFileRow {
	const paramId = String(ctx.getNodeParameter('ifcFileId', i, '') ?? '').trim();
	if (paramId) {
		return { id: paramId, type: 'ifc-files' };
	}

	const inputItem = ctx.getInputData()[i]?.json;
	if (isIfcFileRow(inputItem)) {
		return inputItem;
	}

	throw new NodeOperationError(
		ctx.getNode(),
		'IFC File ID is required, or connect an ifc-files item from a prior node (e.g. Get Many)',
		{ itemIndex: i },
	);
}

function resolveDocumentIdForIfcFile(ctx: IExecuteFunctions, i: number, ifcFile: StreamBimIfcFileRow): string {
	const fromRow = extractDocumentIdFromIfcFileRow(ifcFile);
	if (fromRow) return fromRow;

	const fromId = parseDocumentIdFromIfcFileId(String(ifcFile.id ?? ''));
	if (fromId) return fromId;

	throw new NodeOperationError(
		ctx.getNode(),
		'Could not resolve document ID from IFC file row or composite id',
		{ itemIndex: i },
	);
}

function unwrapJsonApiData(response: unknown): IDataObject {
	if (response && typeof response === 'object' && !Array.isArray(response)) {
		const envelope = response as IDataObject;
		const data = envelope.data;
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			return data as IDataObject;
		}
	}
	return response as IDataObject;
}

export async function runIfcFile(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId || projectId === 'null' || projectId === 'undefined') {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for IFC file operations', {
			itemIndex: i,
		});
	}

	const base = `/project-${projectId}/api/v1/v2/ifc-files`;

	if (operation === 'getDocument') {
		const ifcFile = resolveIfcFileRow(ctx, i);
		const documentId = resolveDocumentIdForIfcFile(ctx, i, ifcFile);
		const documentResponse = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/project-${projectId}/api/v1/v2/documents/${encodeURIComponent(documentId)}`,
			tokenCache,
			undefined,
			{},
		);
		const outputMode = ctx.getNodeParameter('ifcFileDocumentOutput', i, 'documentOnly') as string;
		if (outputMode === 'ifcFileAndDocument') {
			return {
				ifcFile,
				document: unwrapJsonApiData(documentResponse),
				documentId,
			};
		}
		return documentResponse;
	}

	const buildingId = String(ctx.getNodeParameter('buildingId', i, '') ?? '').trim();
	if (!buildingId) {
		throw new NodeOperationError(ctx.getNode(), 'Building ID is required for IFC file operations', {
			itemIndex: i,
		});
	}

	if (operation === 'getMany') {
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			{ 'filter[building]': buildingId },
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	if (operation === 'create' || operation === 'update') {
		const useRawJsonBody = ctx.getNodeParameter('useRawJsonBody', i, false) as boolean;
		const body = useRawJsonBody
			? parseJsonBody(ctx, ctx.getNodeParameter('ifcFileBody', i) as string, i, 'IFC file body')
			: buildIfcFileTypedBody(ctx, i, operation);

		if (operation === 'create') {
			return await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
		}

		const ifcFileId = String(ctx.getNodeParameter('ifcFileId', i, '') ?? '').trim();
		if (!ifcFileId) {
			throw new NodeOperationError(ctx.getNode(), 'IFC File ID is required', { itemIndex: i });
		}
		return await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(ifcFileId)}`,
			tokenCache,
			body,
			{},
		);
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown IFC file operation: ${operation}`);
}
