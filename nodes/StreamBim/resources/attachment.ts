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
	buildFilterQs,
	fixedCollectionPairsToObject,
} from '../helpers/filters';
import { getV8Pagination, paginationFields } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody, parseJsonQueryParameters } from './_runHelpers';

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
			const category = form?.filter?.category ?? '';
			qs = buildFilterQs({
				parentTopic: parentTopic || undefined,
				category: category || undefined,
			});
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
