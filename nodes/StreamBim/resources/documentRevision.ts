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

const RESOURCE = 'documentRevision';

export const documentRevisionOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List revisions for a document',
		action: 'List document revisions',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single document revision by composite ID',
		action: 'Get document revision',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Create a new revision for an existing document',
		action: 'Create document revision',
	},
];

const revisionIdField: INodeProperties = {
	displayName: 'Revision ID',
	name: 'revisionId',
	type: 'string',
	default: '',
	required: true,
	placeholder: '1002-1',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['get'] },
	},
	description: 'Composite revision ID in format DocumentID-RevisionNumber (e.g. 1002-1)',
};

const documentRevisionFiltersField: INodeProperties = {
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
			displayName: 'Document ID',
			name: 'document',
			type: 'string',
			default: '',
			description: 'Show only revisions of this document (sent as filter[document])',
		},
		{
			displayName: 'Sort',
			name: 'sort',
			type: 'string',
			default: '',
			description: 'JSON:API sort string (e.g. "-revision")',
		},
	],
};

const documentRevisionUseRawBody: INodeProperties = {
	displayName: 'Use Raw JSON Body',
	name: 'useRawJsonBody',
	type: 'boolean',
	default: false,
	description: 'Whether to edit the full JSON:API body instead of typed fields',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['create'] },
	},
};

const documentRevisionTypedFields: INodeProperties[] = [
	{
		displayName: 'New Revision ID',
		name: 'documentRevisionIdComposite',
		type: 'string',
		default: '',
		required: true,
		placeholder: '1002-2',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create'],
				useRawJsonBody: [false],
			},
		},
		description: 'Composite revision ID for the new revision (DocumentID-RevisionNumber, e.g. 1002-2)',
	},
	{
		displayName: 'Description',
		name: 'documentRevisionDescription',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create'],
				useRawJsonBody: [false],
			},
		},
	},
	{
		displayName: 'File Size',
		name: 'documentRevisionFilesize',
		type: 'number',
		default: 0,
		typeOptions: { minValue: 0 },
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create'],
				useRawJsonBody: [false],
			},
		},
		description: 'Size of the uploaded file in bytes (sent as attributes.filesize)',
	},
	{
		displayName: 'Upload Ticket ID',
		name: 'documentRevisionUploadTicketId',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create'],
				useRawJsonBody: [false],
			},
		},
		description:
			'Optional ID of an upload-ticket created beforehand. Leave empty if uploading is handled elsewhere.',
	},
];

const documentRevisionRawBody: INodeProperties = {
	displayName: 'Body',
	name: 'documentRevisionBody',
	type: 'json',
	default:
		'{\n  "data": {\n    "id": "1002-2",\n    "type": "document-revisions",\n    "attributes": {\n      "description": "",\n      "filesize": 406602\n    },\n    "relationships": {\n      "upload-ticket": { "data": null }\n    }\n  }\n}\n',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['create'],
			useRawJsonBody: [true],
		},
	},
	description: 'Raw JSON:API body for creating a new document revision',
};

export const documentRevisionProperties: INodeProperties[] = [
	revisionIdField,
	documentRevisionFiltersField,
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
	documentRevisionUseRawBody,
	...documentRevisionTypedFields,
	documentRevisionRawBody,
];

function buildDocumentRevisionTypedBody(ctx: IExecuteFunctions, i: number): IDataObject {
	const id = (ctx.getNodeParameter('documentRevisionIdComposite', i, '') as string).trim();
	if (!id) {
		throw new NodeOperationError(
			ctx.getNode(),
			'New Revision ID is required (format DocumentID-RevisionNumber, e.g. 1002-2)',
			{ itemIndex: i },
		);
	}
	const description = ctx.getNodeParameter('documentRevisionDescription', i, '') as string;
	const filesize = ctx.getNodeParameter('documentRevisionFilesize', i, 0) as number;
	const uploadTicketId = (ctx.getNodeParameter('documentRevisionUploadTicketId', i, '') as string).trim();

	const attributes: IDataObject = { description };
	if (filesize !== undefined && filesize !== null) attributes.filesize = filesize;

	const relationships: Record<string, ReturnType<typeof relationshipRef> | ReturnType<typeof relationshipNull>> = {
		'upload-ticket': uploadTicketId
			? relationshipRef('upload-tickets', uploadTicketId)
			: relationshipNull(),
	};

	return buildJsonApiBody({
		type: 'document-revisions',
		id,
		attributes: pruneEmpty(attributes),
		relationships,
	});
}

export async function runDocumentRevision(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId || projectId === 'null' || projectId === 'undefined') {
		throw new NodeOperationError(
			ctx.getNode(),
			'Project ID is required for document revision operations',
			{ itemIndex: i },
		);
	}
	const base = `/project-${projectId}/api/v1/v2/document-revisions`;

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
		const revisionId = (ctx.getNodeParameter('revisionId', i, '') as string).trim();
		if (!revisionId) {
			throw new NodeOperationError(ctx.getNode(), 'Revision ID is required', { itemIndex: i });
		}
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(revisionId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create') {
		const useRawJsonBody = ctx.getNodeParameter('useRawJsonBody', i, false) as boolean;
		const body = useRawJsonBody
			? parseJsonBody(ctx, ctx.getNodeParameter('documentRevisionBody', i) as string, i, 'Revision body')
			: buildDocumentRevisionTypedBody(ctx, i);
		const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
		return response;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown document revision operation: ${operation}`);
}
