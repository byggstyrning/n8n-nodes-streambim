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
import { buildTypedFilters } from '../helpers/filters';
import {
	buildJsonApiBody,
	pruneEmpty,
	relationshipRef,
	relationshipRefsFromIds,
} from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const RESOURCE = 'folder';

export const folderOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List folders for the project',
		action: 'List folders',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single folder by ID',
		action: 'Get folder',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Create a folder (typed fields or raw JSON:API body)',
		action: 'Create folder',
	},
	{
		name: 'Update',
		value: 'update',
		description: 'PATCH a folder by ID',
		action: 'Update folder',
	},
];

const folderIdField: INodeProperties = {
	displayName: 'Folder Name or ID',
	name: 'folderId',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getFolders' },
	default: '',
	required: true,
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['get', 'update'] },
	},
	description:
		'Folder to operate on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

const folderFiltersField: INodeProperties = {
	displayName: 'Filters',
	name: 'filters',
	type: 'collection',
	placeholder: 'Add Filter',
	default: {},
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['getMany'] },
	},
	options: [
		{
			displayName: 'Parent Folder Name or ID',
			name: 'parent',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getFolders' },
			default: '0',
			description:
				'Show folders whose parent matches this ID (use 0 for root-level folders). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'Sort',
			name: 'sort',
			type: 'string',
			default: '',
			description: 'JSON:API sort string (e.g. "name" or "-created")',
		},
	],
};

const folderUseRawBody: INodeProperties = {
	displayName: 'Use Raw JSON Body',
	name: 'useRawJsonBody',
	type: 'boolean',
	default: false,
	description: 'Whether to edit the full JSON:API body instead of typed fields',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['create', 'update'] },
	},
};

const folderTypedFields: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'folderName',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description: 'Display name of the folder',
	},
	{
		displayName: 'Parent Folder Name or ID',
		name: 'folderParentId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFolders' },
		default: '0',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description:
			'Parent folder (use 0 for root). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Label Names or IDs',
		name: 'folderLabelIds',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getDocumentLabels' },
		default: [],
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description:
			'Labels to attach to the folder. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
];

const folderRawBody: INodeProperties = {
	displayName: 'Body',
	name: 'folderBody',
	type: 'json',
	default:
		'{\n  "data": {\n    "type": "folders",\n    "attributes": {\n      "name": "NewFolder"\n    },\n    "relationships": {\n      "labels": { "data": [] },\n      "parent": { "data": { "id": "0", "type": "folders" } }\n    }\n  }\n}\n',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['create', 'update'],
			useRawJsonBody: [true],
		},
	},
	description: 'Raw JSON:API folder body for create/update',
};

export const folderProperties: INodeProperties[] = [
	folderIdField,
	folderFiltersField,
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
	folderUseRawBody,
	...folderTypedFields,
	folderRawBody,
];

function buildFolderTypedBody(ctx: IExecuteFunctions, i: number, isUpdate: boolean): IDataObject {
	const name = (ctx.getNodeParameter('folderName', i, '') as string).trim();
	const parentId = (ctx.getNodeParameter('folderParentId', i, '0') as string).trim();
	const labelIds = ctx.getNodeParameter('folderLabelIds', i, []) as Array<string | number>;

	const attributes = pruneEmpty({ name });
	if (!isUpdate && Object.keys(attributes).length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'Folder name is required to create a folder');
	}

	const relationships: Record<string, ReturnType<typeof relationshipRef> | ReturnType<typeof relationshipRefsFromIds>> = {};
	if (parentId) relationships.parent = relationshipRef('folders', parentId);
	if (labelIds && labelIds.length > 0) {
		relationships.labels = relationshipRefsFromIds('document-labels', labelIds);
	}

	return buildJsonApiBody({
		type: 'folders',
		...(Object.keys(attributes).length > 0 ? { attributes } : {}),
		...(Object.keys(relationships).length > 0 ? { relationships } : {}),
	});
}

export async function runFolder(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId || projectId === 'null' || projectId === 'undefined') {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for folder operations', {
			itemIndex: i,
		});
	}
	const base = `/project-${projectId}/api/v1/v2/folders`;

	if (operation === 'getMany') {
		const filters = ctx.getNodeParameter('filters', i, {}) as IDataObject;
		const qs = buildTypedFilters(filters);
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	if (operation === 'get') {
		const folderId = String(ctx.getNodeParameter('folderId', i, '') ?? '').trim();
		if (!folderId) {
			throw new NodeOperationError(ctx.getNode(), 'Folder ID is required', { itemIndex: i });
		}
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(folderId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create' || operation === 'update') {
		const useRawJsonBody = ctx.getNodeParameter('useRawJsonBody', i, false) as boolean;
		const body = useRawJsonBody
			? parseJsonBody(ctx, ctx.getNodeParameter('folderBody', i) as string, i, 'Folder body')
			: buildFolderTypedBody(ctx, i, operation === 'update');

		if (operation === 'create') {
			const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
			return response;
		}
		const folderId = String(ctx.getNodeParameter('folderId', i, '') ?? '').trim();
		if (!folderId) {
			throw new NodeOperationError(ctx.getNode(), 'Folder ID is required', { itemIndex: i });
		}
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(folderId)}`,
			tokenCache,
			body,
			{},
		);
		return response;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown folder operation: ${operation}`);
}
