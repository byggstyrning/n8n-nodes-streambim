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
	relationshipNull,
	relationshipRef,
} from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const RESOURCE = 'documentLabel';

export const documentLabelOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List all document labels in the project',
		action: 'List document labels',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single document label by ID',
		action: 'Get document label',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Create a new document label (typed fields or raw JSON:API body)',
		action: 'Create document label',
	},
	{
		name: 'Update',
		value: 'update',
		description: 'PATCH a document label by ID',
		action: 'Update document label',
	},
	{
		name: 'Delete',
		value: 'delete',
		description: 'Delete a document label by ID',
		action: 'Delete document label',
	},
];

const documentLabelIdField: INodeProperties = {
	displayName: 'Document Label Name or ID',
	name: 'documentLabelId',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getDocumentLabels' },
	default: '',
	required: true,
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['get', 'update', 'delete'] },
	},
	description:
		'Document label to operate on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

const documentLabelFiltersField: INodeProperties = {
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
			displayName: 'Label Group ID',
			name: 'group',
			type: 'string',
			default: '',
			description: 'Show only labels in this label-group (sent as filter[group])',
		},
		{
			displayName: 'Sort',
			name: 'sort',
			type: 'string',
			default: '',
			description: 'JSON:API sort string (e.g. "name")',
		},
	],
};

const documentLabelUseRawBody: INodeProperties = {
	displayName: 'Use Raw JSON Body',
	name: 'useRawJsonBody',
	type: 'boolean',
	default: false,
	description: 'Whether to edit the full JSON:API body instead of typed fields',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['create', 'update'] },
	},
};

const documentLabelTypedFields: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'documentLabelName',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description: 'Display name of the document label (e.g. "ARK")',
	},
	{
		displayName: 'Label Group ID',
		name: 'documentLabelGroupId',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description: 'Optional ID of the label-group this label belongs to. Leave empty for none.',
	},
];

const documentLabelRawBody: INodeProperties = {
	displayName: 'Body',
	name: 'documentLabelBody',
	type: 'json',
	default:
		'{\n  "data": {\n    "type": "document-labels",\n    "attributes": {\n      "name": "ARK"\n    },\n    "relationships": {\n      "label-group": { "data": null }\n    }\n  }\n}\n',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['create', 'update'],
			useRawJsonBody: [true],
		},
	},
	description: 'Raw JSON:API body for the document label',
};

export const documentLabelProperties: INodeProperties[] = [
	documentLabelIdField,
	documentLabelFiltersField,
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
	documentLabelUseRawBody,
	...documentLabelTypedFields,
	documentLabelRawBody,
];

function buildDocumentLabelTypedBody(
	ctx: IExecuteFunctions,
	i: number,
	isUpdate: boolean,
): IDataObject {
	const name = (ctx.getNodeParameter('documentLabelName', i, '') as string).trim();
	const groupId = (ctx.getNodeParameter('documentLabelGroupId', i, '') as string).trim();

	const attributes = pruneEmpty({ name });
	if (!isUpdate && Object.keys(attributes).length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'Label name is required to create a document label');
	}

	const relationships: Record<string, ReturnType<typeof relationshipRef> | ReturnType<typeof relationshipNull>> = {
		'label-group': groupId ? relationshipRef('label-groups', groupId) : relationshipNull(),
	};

	return buildJsonApiBody({
		type: 'document-labels',
		...(Object.keys(attributes).length > 0 ? { attributes } : {}),
		relationships,
	});
}

export async function runDocumentLabel(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId || projectId === 'null' || projectId === 'undefined') {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for document label operations', {
			itemIndex: i,
		});
	}
	const base = `/project-${projectId}/api/v1/v2/document-labels`;

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
		const id = String(ctx.getNodeParameter('documentLabelId', i, '') ?? '').trim();
		if (!id) {
			throw new NodeOperationError(ctx.getNode(), 'Document label ID is required', { itemIndex: i });
		}
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(id)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create' || operation === 'update') {
		const useRawJsonBody = ctx.getNodeParameter('useRawJsonBody', i, false) as boolean;
		const body = useRawJsonBody
			? parseJsonBody(ctx, ctx.getNodeParameter('documentLabelBody', i) as string, i, 'Label body')
			: buildDocumentLabelTypedBody(ctx, i, operation === 'update');

		if (operation === 'create') {
			const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
			return response;
		}
		const id = String(ctx.getNodeParameter('documentLabelId', i, '') ?? '').trim();
		if (!id) {
			throw new NodeOperationError(ctx.getNode(), 'Document label ID is required', { itemIndex: i });
		}
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(id)}`,
			tokenCache,
			body,
			{},
		);
		return response;
	}

	if (operation === 'delete') {
		const id = String(ctx.getNodeParameter('documentLabelId', i, '') ?? '').trim();
		if (!id) {
			throw new NodeOperationError(ctx.getNode(), 'Document label ID is required', { itemIndex: i });
		}
		let responseData = await streamBimJsonApiRequest.call(
			ctx,
			'DELETE',
			`${base}/${encodeURIComponent(id)}`,
			tokenCache,
			undefined,
			{},
		);
		if (responseData === undefined || responseData === null || responseData === '') {
			responseData = { deleted: true };
		}
		return responseData;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown document label operation: ${operation}`);
}
