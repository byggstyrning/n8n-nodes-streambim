import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	createUploadTicket,
	readBinaryForUpload,
	uploadBufferToS3,
} from '../../shared/streamBimUploadTicket';
import {
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimTextRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import {
	documentLinkBody,
	linkTargetObjectId,
	toExistingLink,
	type LinkTarget,
} from '../../shared/streamBimPropertyLinks';
import {
	buildFilterQs,
	fixedCollectionPairsToObject,
} from '../helpers/filters';
import { getV8Pagination, paginationFields } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody, parseJsonQueryParameters } from './_runHelpers';

const LINK_SHOW = { resource: ['attachment'], operation: ['linkDocument'] };

export const attachmentOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List attachments with JSON:API filters',
		action: 'List attachments',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single attachment by ID',
		action: 'Get attachment',
	},
	{
		name: 'Get Download Link',
		value: 'getDownloadLink',
		description: 'Resolve download path or URL for an attachment',
		action: 'Get attachment download link',
	},
	{
		name: 'Link Document',
		value: 'linkDocument',
		description:
			'Attach a project document to an element, or to every element with a property value',
		action: 'Link document to IFC object',
	},
	{
		name: 'Upload to Topic',
		value: 'uploadToTopic',
		description: 'Upload binary file via upload ticket and attach to a topic',
		action: 'Upload attachment to topic',
	},
];

export const attachmentProperties: INodeProperties[] = [
	// ── Get Many ──────────────────────────────────────────────────────────────
	{
		displayName: 'Advanced — Use Raw Query Object JSON',
		name: 'attachmentUseRawQuery',
		type: 'boolean',
		default: false,
		description:
			'Whether to bypass the Filters form and send a raw JSON:API query object instead',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['getMany'],
			},
		},
	},
	{
		displayName: 'Filters',
		name: 'attachmentFilters',
		type: 'fixedCollection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['getMany'],
				attachmentUseRawQuery: [false],
			},
		},
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				values: [
					{
						displayName: 'Parent Topic ID',
						name: 'parentTopic',
						type: 'string',
						default: '',
						description:
							'Topic ID to filter attachments by (filter[parentTopic]). Use the Topic resource Get Many to discover IDs.',
					},
					{
						displayName: 'IFC Object ID',
						name: 'object',
						type: 'string',
						default: '',
						description:
							'Element GUID, or the ID of a property-value object (filter[object]). Needs Building.',
					},
					{
						displayName: 'Building Name or ID',
						name: 'building',
						type: 'options',
						typeOptions: {
							loadOptionsDependsOn: ['projectId'],
							loadOptionsMethod: 'getBuildings',
						},
						default: '',
						description:
							'Building of the IFC object (filter[building]). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Include Removed',
						name: 'withDeleted',
						type: 'boolean',
						default: false,
						description:
							'Whether to include soft-deleted attachments (withDeletedAttachments). Check is-deleted on each row.',
					},
					{
						displayName: 'Category',
						name: 'category',
						type: 'options',
						default: '',
						description: 'Restrict to a single attachment category (filter[category])',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Document', value: 'document' },
							{ name: 'File', value: 'file' },
							{ name: 'Floorplan', value: 'floorplan' },
							{ name: 'Screenshot', value: 'screenshot' },
						],
					},
				],
			},
		],
	},
	{
		displayName: 'Query Parameters (Raw JSON)',
		name: 'attachmentQueryParametersJson',
		type: 'json',
		default: '{\n  "filter[parentTopic]": "1034"\n}\n',
		description:
			'Raw JSON:API query parameters. page[limit] / page[skip] here are ignored — use Return All / Limit instead.',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['getMany'],
				attachmentUseRawQuery: [true],
			},
		},
	},
	...paginationFields('attachment', ['getMany']),

	// ── Get / Get Download Link ───────────────────────────────────────────────
	{
		displayName: 'Attachment ID',
		name: 'attachmentId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 21845',
		description:
			'Numeric attachment ID. Often discoverable via Attachment → Get Many filtered by parent topic.',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['get', 'getDownloadLink'],
			},
		},
	},

	// ── Link Document ─────────────────────────────────────────────────────────
	{
		displayName: 'Document',
		name: 'linkDocumentId',
		type: 'resourceLocator',
		default: { mode: 'id', value: '' },
		required: true,
		description: 'Project document to link. Pick from a 200-item hint list, paste an ID, or paste a StreamBIM URL.',
		displayOptions: { show: LINK_SHOW },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchDocumentsHint', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: '1002',
				validation: [
					{
						type: 'regex',
						properties: { regex: '^[0-9]+$', errorMessage: 'Document ID must be a positive integer' },
					},
				],
			},
			{
				displayName: 'By URL',
				name: 'url',
				type: 'string',
				placeholder: 'https://app.streambim.com/project-1/documents/1002/...',
				extractValue: { type: 'regex', regex: '/documents/([0-9]+)(?:[/?#]|$)' },
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
	},
	{
		displayName: 'Link To',
		name: 'linkTarget',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Property Value',
				value: 'property',
				description:
					'Every element with this property value, including elements added later (e.g. all with Sheet Number A-101)',
			},
			{
				name: 'Element',
				value: 'element',
				description: 'One element, by its IFC GUID',
			},
		],
		default: 'property',
		displayOptions: { show: LINK_SHOW },
	},
	{
		displayName: 'Property',
		name: 'linkProperty',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Text.Sheet Number',
		description: 'Property set and property name, separated by a dot',
		displayOptions: { show: { ...LINK_SHOW, linkTarget: ['property'] } },
	},
	{
		displayName: 'Value',
		name: 'linkValue',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'A-101',
		description: 'Property value whose elements get the document',
		displayOptions: { show: { ...LINK_SHOW, linkTarget: ['property'] } },
	},
	{
		displayName: 'Element GUID',
		name: 'linkElementGuid',
		type: 'string',
		required: true,
		default: '',
		placeholder: '2xVoYhqg9CBvb8FmWO83Zc',
		description: 'IFC GlobalId of the element',
		displayOptions: { show: { ...LINK_SHOW, linkTarget: ['element'] } },
	},
	{
		displayName: 'Skip If Already Linked',
		name: 'linkSkipExisting',
		type: 'boolean',
		default: true,
		description:
			'Whether to return the existing link instead of adding a second one when the document is already linked there',
		displayOptions: { show: LINK_SHOW },
	},
	{
		displayName: 'Building Name or ID',
		name: 'linkBuildingId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getBuildings',
		},
		default: '',
		description:
			'Building of the element, used for the duplicate check. Empty: the first building, which is fine for property values (their links are project-wide). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: { ...LINK_SHOW, linkSkipExisting: [true] } },
	},
	{
		displayName: 'Value Type',
		name: 'linkValueType',
		type: 'string',
		default: 'str',
		description:
			'Type segment of the property value in StreamBIM ("str" for text). Change only for non-text properties.',
		displayOptions: { show: { ...LINK_SHOW, linkTarget: ['property'] } },
	},

	// ── Upload to Topic ───────────────────────────────────────────────────────
	{
		displayName: 'Binary Property',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		description: 'Binary field containing the file to upload',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
			},
		},
	},
	{
		displayName: 'Parent Topic ID',
		name: 'parentTopicId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 1034',
		description:
			'Topic to attach this upload to. Discover via the Topic resource Get Many.',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
			},
		},
	},
	{
		displayName: 'Category',
		name: 'attachmentCategory',
		type: 'options',
		default: 'file',
		options: [
			{ name: 'File', value: 'file' },
			{ name: 'Screenshot', value: 'screenshot' },
			{ name: 'Floorplan', value: 'floorplan' },
			{ name: 'Document', value: 'document' },
		],
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
			},
		},
	},
	{
		displayName: 'Advanced — Use Raw Metadata JSON',
		name: 'attachmentUseRawMetadata',
		type: 'boolean',
		default: false,
		description: 'Whether to send raw metadata JSON instead of the key/value form',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
			},
		},
	},
	{
		displayName: 'Metadata',
		name: 'attachmentMetadata',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Metadata Entry',
		default: {},
		description: 'Optional key/value pairs attached to the upload',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
				attachmentUseRawMetadata: [false],
			},
		},
		options: [
			{
				displayName: 'Entry',
				name: 'entry',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						description: 'Metadata key',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Metadata value',
					},
				],
			},
		],
	},
	{
		displayName: 'Metadata (Raw JSON)',
		name: 'metadataJson',
		type: 'json',
		default: '{}',
		description: 'Raw metadata object sent as attributes.metadata on the new attachment',
		displayOptions: {
			show: {
				resource: ['attachment'],
				operation: ['uploadToTopic'],
				attachmentUseRawMetadata: [true],
			},
		},
	},
];

type AttachmentFiltersForm = {
	filter?: {
		parentTopic?: string;
		object?: string;
		building?: string;
		withDeleted?: boolean;
		category?: string;
	};
};

type AttachmentMetadataForm = {
	entry?: Array<{ name?: string; value?: string }>;
};

export async function runAttachment(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	items: INodeExecutionData[],
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	const base = `/project-${projectId}/api/v1/v2/attachments`;

	if (operation === 'getMany') {
		const useRaw = ctx.getNodeParameter('attachmentUseRawQuery', i, false) as boolean;
		let qs: IDataObject;
		if (useRaw) {
			const raw = ctx.getNodeParameter('attachmentQueryParametersJson', i, '') as string;
			qs = parseJsonQueryParameters(ctx, raw, i, 'Query parameters');
		} else {
			const form = ctx.getNodeParameter(
				'attachmentFilters',
				i,
				{},
			) as AttachmentFiltersForm;
			const parentTopic = (form?.filter?.parentTopic ?? '').trim();
			const object = (form?.filter?.object ?? '').trim();
			const building = String(form?.filter?.building ?? '').trim();
			const category = form?.filter?.category ?? '';
			qs = buildFilterQs({
				parentTopic: parentTopic || undefined,
				object: object || undefined,
				building: building || undefined,
				category: category || undefined,
			});
			if (form?.filter?.withDeleted) qs.withDeletedAttachments = 'true';
		}
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			base,
			tokenCache,
			qs,
			getV8Pagination(ctx, i, { allPagesPageSize: 200 }),
		);
		return response;
	}

	if (operation === 'get') {
		const attachmentId = ctx.getNodeParameter('attachmentId', i) as string;
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(attachmentId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'getDownloadLink') {
		const attachmentId = ctx.getNodeParameter('attachmentId', i) as string;
		const text = await streamBimTextRequest.call(
			ctx,
			`${base}/${encodeURIComponent(attachmentId)}/download-link`,
			tokenCache,
			{},
		);
		return { downloadPathOrUrl: text };
	}

	if (operation === 'linkDocument') {
		return await linkDocument(ctx, i, projectId, base, tokenCache);
	}

	if (operation === 'uploadToTopic') {
		const binaryPropertyName = ctx.getNodeParameter('binaryPropertyName', i) as string;
		const parentTopicId = ctx.getNodeParameter('parentTopicId', i) as string;
		const attachmentCategory = ctx.getNodeParameter('attachmentCategory', i) as string;
		const useRawMetadata = ctx.getNodeParameter(
			'attachmentUseRawMetadata',
			i,
			false,
		) as boolean;

		const { body, fileSize, filename: fileName, mimeType } = await readBinaryForUpload(
			ctx,
			items,
			i,
			binaryPropertyName,
		);

		let metadata: IDataObject;
		if (useRawMetadata) {
			const raw = ctx.getNodeParameter('metadataJson', i, '{}') as string;
			metadata = parseJsonBody(ctx, raw, i, 'Metadata JSON');
		} else {
			const form = ctx.getNodeParameter(
				'attachmentMetadata',
				i,
				{},
			) as AttachmentMetadataForm;
			metadata = fixedCollectionPairsToObject(form?.entry);
		}

		const { uploadTicketId, presignedUrl } = await createUploadTicket(
			ctx,
			projectId,
			fileName,
			fileSize,
			tokenCache,
		);

		await uploadBufferToS3(ctx, presignedUrl, body, fileSize, mimeType);

		const createBody: IDataObject = {
			data: {
				id: '0',
				type: 'attachments',
				attributes: {
					category: attachmentCategory,
					metadata,
					url: '',
				},
				relationships: {
					'upload-ticket': {
						data: { type: 'upload-tickets', id: uploadTicketId },
					},
					'parent-topic': {
						data: { id: parentTopicId, type: 'topics' },
					},
					'parent-topic-viewpoint': { data: null },
					'parent-topic-comment': { data: null },
				},
			},
		};

		const response = await streamBimJsonApiRequest.call(
			ctx,
			'POST',
			base,
			tokenCache,
			createBody,
			{},
		);
		return response;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown attachment operation: ${operation}`);
}

async function linkDocument(
	ctx: IExecuteFunctions,
	i: number,
	projectId: string,
	base: string,
	tokenCache: StreamBimTokenCache,
): Promise<IDataObject> {
	const documentId = String(
		ctx.getNodeParameter('linkDocumentId', i, '', { extractValue: true }) ?? '',
	).trim();
	if (!documentId) {
		throw new NodeOperationError(ctx.getNode(), 'Document is required', { itemIndex: i });
	}
	const targetKind = ctx.getNodeParameter('linkTarget', i, 'property') as string;
	const target: LinkTarget =
		targetKind === 'element'
			? { kind: 'element', guid: ctx.getNodeParameter('linkElementGuid', i, '') as string }
			: {
					kind: 'property',
					property: ctx.getNodeParameter('linkProperty', i, '') as string,
					value: ctx.getNodeParameter('linkValue', i, '') as string,
					valueType: ctx.getNodeParameter('linkValueType', i, 'str') as string,
				};
	let objectId: string;
	try {
		objectId = linkTargetObjectId(target);
	} catch (error) {
		throw new NodeOperationError(ctx.getNode(), (error as Error).message, { itemIndex: i });
	}

	if (ctx.getNodeParameter('linkSkipExisting', i, true) as boolean) {
		let buildingId = String(ctx.getNodeParameter('linkBuildingId', i, '') ?? '').trim();
		if (!buildingId) {
			const buildings = (await streamBimJsonApiRequest.call(
				ctx,
				'GET',
				`/project-${projectId}/api/v1/v2/buildings`,
				tokenCache,
				undefined,
				{},
			)) as IDataObject;
			const first = ((buildings?.data as IDataObject[]) ?? [])[0];
			buildingId = first ? String(first.id) : '';
		}
		if (buildingId) {
			const res = (await streamBimJsonApiRequest.call(ctx, 'GET', base, tokenCache, undefined, {
				'filter[object]': objectId,
				'filter[building]': buildingId,
				withDeletedAttachments: 'true',
			})) as IDataObject;
			const rows = (Array.isArray(res?.data) ? res.data : []) as IDataObject[];
			const existing = rows.find((row) => {
				const link = toExistingLink(row);
				return link !== undefined && !link.isDeleted && link.documentId === documentId;
			});
			if (existing) return { ...existing, objectId, alreadyLinked: true };
		}
	}

	const created = (await streamBimJsonApiRequest.call(
		ctx,
		'POST',
		base,
		tokenCache,
		documentLinkBody(objectId, documentId),
		{},
	)) as IDataObject;
	const record = (created?.data ?? created) as IDataObject;
	return { ...record, objectId, alreadyLinked: false };
}
