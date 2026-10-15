import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	b64EncodeJson,
	getStreamBimBaseUrl,
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimPlainJsonRequest,
	streamBimTextRequest,
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
import {
	DOCUMENT_IFC_FILE_FILTER_KEYS,
	ifcFileRowsFromJsonApiResponse,
	linkedDocumentIdsFromIfcFileRows,
} from '../../shared/streamBimIfcFiles';
import {
	getProjectIdString,
	getRequiredStringParameter,
	parseJsonBody,
} from './_runHelpers';
import {
	readBinaryForUpload,
	uploadDocumentToFolder,
} from '../../shared/streamBimUploadTicket';

const ALL_PAGES_PAGINATION = {
	mode: 'all' as const,
	pageLimit: 500,
	pageSkip: 0,
	maxPages: 5000,
};

function stripDocumentIfcFileFilterKeys(filters: IDataObject): {
	apiFilters: IDataObject;
	ifcFileBuildingId: string;
	missingIfcFile: boolean;
	useIfcFileFilter: boolean;
} {
	const ifcFileBuildingId = String(filters.ifcFileBuildingId ?? '').trim();
	const missingIfcFile = filters.missingIfcFile !== false;
	const apiFilters = { ...filters };
	for (const key of DOCUMENT_IFC_FILE_FILTER_KEYS) {
		delete apiFilters[key];
	}
	return {
		apiFilters,
		ifcFileBuildingId,
		missingIfcFile,
		useIfcFileFilter: Boolean(ifcFileBuildingId),
	};
}

function applyDocumentLimit(ctx: IExecuteFunctions, i: number, rows: IDataObject[]): IDataObject[] {
	try {
		const returnAll = ctx.getNodeParameter('returnAll', i, true) as boolean;
		if (returnAll) return rows;
		const limit = ctx.getNodeParameter('limit', i, 50) as number;
		if (Number.isFinite(limit) && limit > 0) {
			return rows.slice(0, limit);
		}
	} catch {
		// operation may not expose returnAll/limit
	}
	return rows;
}

const RESOURCE = 'document';

export const documentOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List documents with filters (folder, deleted, extensions)',
		action: 'List documents',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single document by ID',
		action: 'Get document',
	},
	{
		name: 'Create',
		value: 'create',
		description: 'Create a document metadata record (no file upload — use Upload for files)',
		action: 'Create document',
	},
	{
		name: 'Update',
		value: 'update',
		description: 'PATCH a document by ID',
		action: 'Update document',
	},
	{
		name: 'Delete',
		value: 'delete',
		description: 'Delete a document by ID',
		action: 'Delete document',
	},
	{
		name: 'Get Download Link',
		value: 'getDownloadLink',
		description:
			'Get pre-signed download path and full absolute URL (environment + project + document) for a document',
		action: 'Get document download link',
	},
	{
		name: 'Export JSON',
		value: 'exportJson',
		description: 'Export documents as JSON (base64 query object)',
		action: 'Export documents JSON',
	},
	{
		name: 'Upload',
		value: 'upload',
		description:
			'Upload a file to a folder; creates a new document or adds a revision when the filename already exists in that folder',
		action: 'Upload document',
	},
];

const documentIdField: INodeProperties = {
	displayName: 'Document',
	name: 'documentId',
	type: 'resourceLocator',
	default: { mode: 'id', value: '' },
	required: true,
	description: 'Document to operate on. Pick from a 200-item hint list, paste an ID, or paste a StreamBIM URL.',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['get', 'update', 'delete', 'getDownloadLink'],
		},
	},
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'searchDocumentsHint',
				searchable: true,
			},
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: '1002',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^[0-9]+$',
						errorMessage: 'Document ID must be a positive integer',
					},
				},
			],
		},
		{
			displayName: 'By URL',
			name: 'url',
			type: 'string',
			placeholder: 'https://app.streambim.com/project-1/documents/1002/...',
			extractValue: {
				type: 'regex',
				regex: '/documents/([0-9]+)(?:[/?#]|$)',
			},
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '.*/documents/[0-9]+(?:[/?#].*)?',
						errorMessage: 'URL must contain /documents/{id}/',
					},
				},
			],
		},
	],
};

const documentFiltersField: INodeProperties = {
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
			displayName: 'External ID',
			name: 'externalId',
			type: 'string',
			default: '',
			description:
				'ID the sync integration stored on the document (sent as filter[externalId]): Interaxo file ID, ACC lineage URN, SharePoint driveItem ID',
		},
		{
			displayName: 'File Extensions',
			name: 'fileExtensions',
			type: 'string',
			default: '',
			placeholder: 'ifc,pdf,dwg',
			description: 'Comma-separated list of extensions (sent as filter[fileExtensions])',
		},
		{
			displayName: 'Folder Name or ID',
			name: 'folderId',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getFolders' },
			default: '',
			description:
				'Filter by folder. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'Freetext Search',
			name: 'freetext',
			type: 'string',
			default: '',
			description: 'Freetext search string (sent as filter[freetext])',
		},
		{
			displayName: 'IFC File Building Name or ID',
			name: 'ifcFileBuildingId',
			type: 'options',
			typeOptions: {
				loadOptionsDependsOn: ['projectId'],
				loadOptionsMethod: 'getBuildings',
			},
			default: '',
			description:
				'When set, filters documents by ifc-file assignment on this building (see Missing IFC File). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'Include Deleted',
			name: 'isDeleted',
			type: 'boolean',
			default: false,
			description: 'Whether to include soft-deleted documents (sent as filter[isDeleted])',
		},
		{
			displayName: 'Label Names or IDs',
			name: 'labelIds',
			type: 'multiOptions',
			typeOptions: { loadOptionsMethod: 'getDocumentLabels' },
			default: [],
			description:
				'Filter by labels. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'Missing IFC File',
			name: 'missingIfcFile',
			type: 'boolean',
			default: true,
			description:
				'Whether documents lack an ifc-file on the selected IFC File Building (ON) or already have one (OFF). Only applies when IFC File Building is set.',
		},
		{
			displayName: 'Since (Epoch Nanoseconds)',
			name: 'since',
			type: 'string',
			default: '',
			placeholder: '1577836800000000000',
			description:
				'Only documents changed after this time (sent as filter[since]). Use meta.timestamp of an earlier response. Cannot be combined with the search filters.',
		},
		{
			displayName: 'Sort',
			name: 'sort',
			type: 'string',
			default: '',
			description: 'JSON:API sort string (e.g. "filename" or "-created")',
		},
	],
};

const documentUseRawBody: INodeProperties = {
	displayName: 'Use Raw JSON Body',
	name: 'useRawJsonBody',
	type: 'boolean',
	default: false,
	description: 'Whether to edit the full JSON:API body instead of typed fields',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['create', 'update'] },
	},
};

const documentTypedFields: INodeProperties[] = [
	{
		displayName: 'Filename',
		name: 'documentFilename',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description: 'Document filename including extension (e.g. drawing.pdf)',
	},
	{
		displayName: 'Description',
		name: 'documentDescription',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
	},
	{
		displayName: 'Folder Name or ID',
		name: 'documentFolderId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFolders' },
		default: '',
		displayOptions: {
			show: {
				resource: [RESOURCE],
				operation: ['create', 'update'],
				useRawJsonBody: [false],
			},
		},
		description:
			'Folder for the document. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Label Names or IDs',
		name: 'documentLabelIds',
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
			'Labels to attach. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
];

const documentRawBody: INodeProperties = {
	displayName: 'Body',
	name: 'documentBody',
	type: 'json',
	default:
		'{\n  "data": {\n    "type": "documents",\n    "attributes": {\n      "filename": "",\n      "description": ""\n    },\n    "relationships": {\n      "parent": { "data": { "type": "folders", "id": "0" } },\n      "labels": { "data": [] }\n    }\n  }\n}\n',
	displayOptions: {
		show: {
			resource: [RESOURCE],
			operation: ['create', 'update'],
			useRawJsonBody: [true],
		},
	},
	description: 'Raw JSON:API document body for create/update',
};

const documentExportField: INodeProperties = {
	displayName: 'Export Query Object',
	name: 'documentExportQueryObject',
	type: 'json',
	default: '{\n  "filter": {\n    "freetext": ".ifc",\n    "isDeleted": false\n  }\n}\n',
	displayOptions: {
		show: { resource: [RESOURCE], operation: ['exportJson'] },
	},
	description:
		'JSON object (will be base64-encoded). Common filter fields: freetext, isDeleted, fileExtensions, labelIds, folderId.',
};

const documentUploadFields: INodeProperties[] = [
	{
		displayName: 'Folder Name or ID',
		name: 'uploadFolderId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFolders' },
		default: '',
		required: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'] },
		},
		description:
			'Target folder. If a document with the same filename exists here, a new revision is created. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Source',
		name: 'uploadSource',
		type: 'options',
		options: [
			{
				name: 'Binary Property',
				value: 'binary',
				description: 'A binary field on the input item',
			},
			{
				name: 'URL',
				value: 'url',
				description:
					'Download from a URL (e.g. a signed URL) and stream it straight into StreamBIM, never stored in n8n',
			},
		],
		default: 'binary',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'] },
		},
	},
	{
		displayName: 'Binary Property',
		name: 'uploadBinaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'], uploadSource: ['binary'] },
		},
		description: 'Binary field containing the file to upload',
	},
	{
		displayName: 'Source URL',
		name: 'uploadSourceUrl',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'], uploadSource: ['url'] },
		},
		description: 'URL the file is downloaded from with a plain GET, without credentials',
	},
	{
		displayName: 'File Size',
		name: 'uploadFileSize',
		type: 'number',
		default: 0,
		required: true,
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'], uploadSource: ['url'] },
		},
		description:
			'Exact size of the file in bytes. StreamBIM storage needs it before the upload starts; the upload fails if the URL serves another size.',
	},
	{
		displayName: 'Filename',
		name: 'uploadFilename',
		type: 'string',
		default: '',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'] },
		},
		description:
			'Override filename; defaults to the binary property file name. Required for a URL source.',
	},
	{
		displayName: 'Description',
		name: 'uploadDescription',
		type: 'string',
		default: '',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'] },
		},
		description: 'Optional description for the new document or revision',
	},
	{
		displayName: 'External ID',
		name: 'uploadExternalId',
		type: 'string',
		default: '',
		displayOptions: {
			show: { resource: [RESOURCE], operation: ['upload'] },
		},
		description: 'Optional external ID (set on create only)',
	},
];

export const documentProperties: INodeProperties[] = [
	documentIdField,
	documentFiltersField,
	...buildReturnAllAndLimit(['getMany'], RESOURCE),
	documentUseRawBody,
	...documentTypedFields,
	documentRawBody,
	documentExportField,
	...documentUploadFields,
];

function buildDocumentTypedBody(ctx: IExecuteFunctions, i: number, isUpdate: boolean): IDataObject {
	const filename = (ctx.getNodeParameter('documentFilename', i, '') as string).trim();
	const description = ctx.getNodeParameter('documentDescription', i, '') as string;
	const folderId = (ctx.getNodeParameter('documentFolderId', i, '') as string).trim();
	const labelIds = ctx.getNodeParameter('documentLabelIds', i, []) as Array<string | number>;

	const attributes = pruneEmpty({ filename, description });
	const relationships: Record<string, ReturnType<typeof relationshipRef> | { data: null } | ReturnType<typeof relationshipRefsFromIds>> = {};
	if (folderId) relationships.parent = relationshipRef('folders', folderId);
	if (labelIds && labelIds.length > 0) {
		relationships.labels = relationshipRefsFromIds('document-labels', labelIds);
	} else if (!isUpdate) {
		relationships.labels = { data: [] };
	}

	if (Object.keys(relationships).length === 0 && Object.keys(attributes).length === 0 && !isUpdate) {
		throw new NodeOperationError(ctx.getNode(), 'At least one field is required to create a document');
	}

	return buildJsonApiBody({
		type: 'documents',
		...(Object.keys(attributes).length > 0 ? { attributes } : {}),
		...(Object.keys(relationships).length > 0 ? { relationships } : {}),
	});
}

function getDocumentId(ctx: IExecuteFunctions, i: number): string {
	const id = String(
		ctx.getNodeParameter('documentId', i, '', { extractValue: true }) ?? '',
	).trim();
	if (!id || id === 'null' || id === 'undefined') {
		throw new NodeOperationError(
			ctx.getNode(),
			'Document ID is required and cannot be null or undefined',
			{ itemIndex: i },
		);
	}
	return id;
}

export async function runDocument(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
	items: INodeExecutionData[] = [],
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (!projectId || projectId === 'null' || projectId === 'undefined') {
		throw new NodeOperationError(
			ctx.getNode(),
			'Project ID is required for document operations',
			{ itemIndex: i },
		);
	}
	const base = `/project-${projectId}/api/v1/v2/documents`;

	if (operation === 'getMany') {
		const filters = ctx.getNodeParameter('filters', i, {}) as IDataObject;
		const { apiFilters, ifcFileBuildingId, missingIfcFile, useIfcFileFilter } =
			stripDocumentIfcFileFilterKeys(filters);
		const qs = buildTypedFilters(apiFilters);
		const pagination = useIfcFileFilter ? ALL_PAGES_PAGINATION : getV8ListPagination(ctx, i);
		const response = (await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			qs,
			pagination,
		)) as IDataObject;

		if (!useIfcFileFilter) {
			return response;
		}

		const ifcResponse = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/ifc-files`,
			tokenCache,
			{ 'filter[building]': ifcFileBuildingId },
			ALL_PAGES_PAGINATION,
		);
		const linkedDocumentIds = linkedDocumentIdsFromIfcFileRows(
			ifcFileRowsFromJsonApiResponse(ifcResponse),
			ifcFileBuildingId,
		);

		const docs = Array.isArray(response.data) ? (response.data as IDataObject[]) : [];
		const filtered = docs.filter((doc) => {
			const documentId = String(doc.id ?? '').trim();
			if (!documentId) return false;
			const hasIfcFile = linkedDocumentIds.has(documentId);
			return missingIfcFile ? !hasIfcFile : hasIfcFile;
		});

		return {
			...response,
			data: applyDocumentLimit(ctx, i, filtered),
			meta: {
				...(response.meta as IDataObject),
				ifcFileBuildingId,
				missingIfcFile,
				filteredByIfcFileAssignment: true,
				totalBeforeIfcFileFilter: docs.length,
				totalAfterIfcFileFilter: filtered.length,
			},
		};
	}

	if (operation === 'get') {
		const documentId = getDocumentId(ctx, i);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(documentId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create' || operation === 'update') {
		const useRawJsonBody = ctx.getNodeParameter('useRawJsonBody', i, false) as boolean;
		const body = useRawJsonBody
			? parseJsonBody(ctx, ctx.getNodeParameter('documentBody', i) as string, i, 'Document body')
			: buildDocumentTypedBody(ctx, i, operation === 'update');

		if (operation === 'create') {
			const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
			return response;
		}
		const documentId = getDocumentId(ctx, i);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(documentId)}`,
			tokenCache,
			body,
			{},
		);
		return response;
	}

	if (operation === 'delete') {
		const documentId = getDocumentId(ctx, i);
		let responseData = await streamBimJsonApiRequest.call(
			ctx,
			'DELETE',
			`${base}/${encodeURIComponent(documentId)}`,
			tokenCache,
			undefined,
			{},
		);
		if (responseData === undefined || responseData === null || responseData === '') {
			responseData = { deleted: true };
		}
		return responseData;
	}

	if (operation === 'getDownloadLink') {
		const documentId = getDocumentId(ctx, i);
		const documentBase = `/project-${projectId}/api/v1/documents/${encodeURIComponent(documentId)}`;
		const rawResponse = await streamBimTextRequest.call(
			ctx,
			`${documentBase}/downloadlink`,
			tokenCache,
			{},
		);
		const credentials = await ctx.getCredentials('streamBimApi');
		const baseUrl = getStreamBimBaseUrl(credentials as IDataObject, tokenCache);
		// API may return a quoted JSON string, a relative path, an absolute path, or a full URL.
		const cleaned = (rawResponse ?? '').toString().trim().replace(/^"+|"+$/g, '');
		let downloadUrl: string;
		if (/^https?:\/\//i.test(cleaned)) {
			downloadUrl = cleaned;
		} else if (cleaned.startsWith('/')) {
			downloadUrl = `${baseUrl}${cleaned}`;
		} else {
			downloadUrl = `${baseUrl}${documentBase}/${cleaned}`;
		}
		return {
			downloadPathOrUrl: cleaned,
			downloadUrl,
			environment: baseUrl,
			projectId,
			documentId,
		};
	}

	if (operation === 'exportJson') {
		const exportQueryObject = getRequiredStringParameter(
			ctx,
			'documentExportQueryObject',
			i,
			'Export query object',
		);
		const obj = parseJsonBody(ctx, exportQueryObject, i, 'Export query object');
		const query = b64EncodeJson(obj);
		return streamBimPlainJsonRequest.call(
			ctx,
			'GET',
			`/project-${projectId}/api/v1/documents/export/json/`,
			tokenCache,
			undefined,
			{ query },
		);
	}

	if (operation === 'upload') {
		const folderId = (ctx.getNodeParameter('uploadFolderId', i, '') as string).trim();
		if (!folderId) {
			throw new NodeOperationError(ctx.getNode(), 'Folder is required for upload', { itemIndex: i });
		}
		const filenameOverride = (ctx.getNodeParameter('uploadFilename', i, '') as string).trim();
		const description = ctx.getNodeParameter('uploadDescription', i, '') as string;
		const externalId = (ctx.getNodeParameter('uploadExternalId', i, '') as string).trim();
		const source = ctx.getNodeParameter('uploadSource', i, 'binary') as string;

		if (source === 'url') {
			const sourceUrl = (ctx.getNodeParameter('uploadSourceUrl', i, '') as string).trim();
			const fileSize = Number(ctx.getNodeParameter('uploadFileSize', i, 0));
			if (!/^https?:\/\//i.test(sourceUrl)) {
				throw new NodeOperationError(ctx.getNode(), 'Source URL must be an http(s) URL', { itemIndex: i });
			}
			if (!Number.isInteger(fileSize) || fileSize <= 0) {
				throw new NodeOperationError(
					ctx.getNode(),
					`File Size must be the file's exact size in bytes, got: ${fileSize}`,
					{ itemIndex: i },
				);
			}
			if (!filenameOverride) {
				throw new NodeOperationError(ctx.getNode(), 'Filename is required when uploading from a URL', {
					itemIndex: i,
				});
			}
			return uploadDocumentToFolder(
				ctx,
				projectId,
				folderId,
				filenameOverride,
				{ sourceUrl },
				fileSize,
				'application/octet-stream',
				tokenCache,
				{ description, externalId: externalId || undefined },
			);
		}

		const binaryPropertyName = ctx.getNodeParameter('uploadBinaryPropertyName', i, 'data') as string;
		const { body, fileSize, filename, mimeType } = await readBinaryForUpload(
			ctx,
			items,
			i,
			binaryPropertyName,
			filenameOverride || undefined,
		);

		return uploadDocumentToFolder(
			ctx,
			projectId,
			folderId,
			filename,
			body,
			fileSize,
			mimeType,
			tokenCache,
			{ description, externalId: externalId || undefined },
		);
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown document operation: ${operation}`);
}
