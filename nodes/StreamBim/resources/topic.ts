import type {
	IDataObject,
	IExecuteFunctions,
	INodeParameterResourceLocator,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	b64EncodeJson,
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimPlainJsonRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import { buildFilters, type FixedCollectionFilterValues } from '../helpers/filters';
import {
	buildJsonApiBody,
	relationshipRef,
	type JsonApiRelationshipRef,
} from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, toStreamBimListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody, parseJsonQueryParameters } from './_runHelpers';

export const topicOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List topics with filters',
		action: 'List topics',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a single topic by ID',
		action: 'Get topic',
	},
	{
		name: 'Export JSON',
		value: 'exportJson',
		description: 'Export topics to JSON for PowerBI or analytics',
		action: 'Export topics JSON',
	},
];

const TOPIC_SHOW: { resource: string[] } = { resource: ['topic'] };

export const topicProperties: INodeProperties[] = [
	// -------------------------------------------------------------------------
	// Delete: ID Type (id | publicId)
	// -------------------------------------------------------------------------
	{
		displayName: 'ID Type',
		name: 'topicIdType',
		type: 'options',
		options: [
			{
				name: 'Internal ID',
				value: 'id',
				description: 'Use the JSON:API record ID (e.g., 12345)',
			},
			{
				name: 'Public ID',
				value: 'publicId',
				description: 'Use the human-readable sequential ID shown in the StreamBIM UI (e.g., 42)',
			},
		],
		default: 'id',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['delete'],
			},
		},
		description:
			'How to interpret the Topic ID below. Only applies to "By ID" mode; "From List" always picks a topic by its internal ID.',
	},

	// -------------------------------------------------------------------------
	// Topic ID resourceLocator (get / update / delete)
	// -------------------------------------------------------------------------
	{
		displayName: 'Topic',
		name: 'topicId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['delete', 'get', 'update'],
			},
		},
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a topic…',
				typeOptions: {
					searchListMethod: 'getTopicsByPublicId',
					searchable: true,
				},
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 12345 (internal) or 42 (public)',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: '^[A-Za-z0-9_-]+$',
							errorMessage: 'Topic ID must contain only letters, numbers, dashes, or underscores',
						},
					},
				],
			},
		],
		description:
			'Pick a topic from the list (always resolves to the internal ID) or type one manually. For Delete, the ID Type field above controls whether a typed value is treated as internal ID or public ID.',
	},

	// -------------------------------------------------------------------------
	// Get Many: Filters + Raw JSON escape hatch + returnAll/limit
	// -------------------------------------------------------------------------
	{
		displayName: 'Advanced — Use Raw JSON Query',
		name: 'useRawQuery',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['getMany'],
			},
		},
		description:
			'Whether to bypass the Filters builder and send a raw JSON query parameters object. Use this escape hatch for filters that are not first-classed in the UI.',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		placeholder: 'Add Filter',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['getMany'],
				useRawQuery: [false],
			},
		},
		options: [
			{
				name: 'values',
				displayName: 'Filter',
				values: [
					{
						displayName: 'Channel',
						name: 'channel',
						type: 'options',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Public', value: 'public' },
							{ name: 'Workflows', value: 'workflows' },
						],
						default: '',
						description: 'Topic channel to filter by',
					},
					{
						displayName: 'Workflow Name or ID',
						name: 'workflow',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkflows' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Status Name or ID',
						name: 'status',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getTopicStatuses' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Building Name or ID',
						name: 'building',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getBuildings' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Assigned to User Name or ID',
						name: 'assignedToUser',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getProjectUsers' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Labels',
						name: 'labels',
						type: 'string',
						default: '',
						description: 'Comma-separated label IDs (becomes filter[labels])',
					},
					{
						displayName: 'Is Deleted',
						name: 'isDeleted',
						type: 'boolean',
						default: false,
						description: 'Whether to filter to only deleted topics',
					},
					{
						displayName: 'Sort',
						name: 'sort',
						type: 'string',
						default: '',
						// eslint-disable-next-line n8n-nodes-base/node-param-placeholder-miscased-id
						placeholder: '-public-id',
						// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
						description: 'JSON:API sort string (e.g., -public-id or title)',
					},
				],
			},
		],
	},
	{
		displayName: 'Query Parameters',
		name: 'topicQueryParameters',
		type: 'json',
		default: '{}\n',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['getMany'],
				useRawQuery: [true],
			},
		},
		description:
			'Raw JSON query parameters. Use Return All / Limit for page[limit] / page[skip] (values in JSON for those keys are ignored).',
	},
	...buildReturnAllAndLimit(['topic'], ['getMany']),

	// -------------------------------------------------------------------------
	// Create / Update: Use Raw JSON Body toggle + form fields + raw JSON
	// -------------------------------------------------------------------------
	{
		displayName: 'Advanced — Use Raw JSON Body',
		name: 'useRawBody',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
			},
		},
		description:
			'Whether to bypass the form fields and send a raw JSON:API body. Use this escape hatch for attributes / relationships not first-classed in the UI.',
	},
	{
		displayName: 'Title',
		name: 'topicTitle',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description: 'Topic title shown in the StreamBIM UI. Required on Create.',
	},
	{
		displayName: 'Description',
		name: 'topicDescription',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
	},
	{
		displayName: 'Channel',
		name: 'topicChannel',
		type: 'options',
		options: [
			{ name: 'Public', value: 'public' },
			{ name: 'Workflows', value: 'workflows' },
		],
		default: 'public',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
	},
	{
		displayName: 'Is Draft',
		name: 'topicIsDraft',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description: 'Whether the topic is a draft (defaults to true; publish later with Update)',
	},
	{
		displayName: 'Building Name or ID',
		name: 'topicBuildingId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getBuildings' },
		default: '',
		required: true,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description:
			'Building this topic belongs to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Status Name or ID',
		name: 'topicStatusId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getTopicStatuses' },
		default: '',
		required: true,
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description:
			'Topic status. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Workflow Name or ID',
		name: 'topicWorkflowId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getWorkflows' },
		default: '',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description:
			'Optional workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Priority Name or ID',
		name: 'topicPriorityId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getTopicPriorities' },
		default: '2',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description:
			'Topic priority (default 2). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Assigned To',
		name: 'topicAssignedTo',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		placeholder: 'Add Assignment',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [false],
			},
		},
		description: 'Assign the topic to a Group or a User (mutually exclusive)',
		options: [
			{
				name: 'group',
				displayName: 'To Group',
				values: [
					{
						displayName: 'Group Name or ID',
						name: 'groupId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getGroups' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
				],
			},
			{
				name: 'user',
				displayName: 'To User',
				values: [
					{
						displayName: 'User Name or ID',
						name: 'userId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getProjectUsers' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
				],
			},
		],
	},
	{
		displayName: 'Body',
		name: 'topicBody',
		type: 'json',
		default:
			'{\n  "data": {\n    "type": "topics",\n    "attributes": {\n      "title": "",\n      "description": "",\n      "channel": "public",\n      "is-draft": true\n    },\n    "relationships": {\n      "building": { "data": { "type": "buildings", "id": "1000" } },\n      "workflow": { "data": null },\n      "status": { "data": { "type": "topic-statuses", "id": "2000" } }\n    }\n  }\n}\n',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['create', 'update'],
				useRawBody: [true],
			},
		},
		description:
			'Raw JSON:API document for the topic. For create, is-draft defaults to true (publish later with update). Common channels: public, workflows.',
	},

	// -------------------------------------------------------------------------
	// Export JSON (unchanged)
	// -------------------------------------------------------------------------
	{
		displayName: 'Export Selectors',
		name: 'topicExportSelectors',
		type: 'json',
		default:
			'{\n  "channel": "workflows",\n  "isDeleted": false\n}\n',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['exportJson'],
			},
		},
		description:
			'JSON object with filter selectors. Common fields: channel, isDeleted, workflow, checklist, building, assignedToUser, status, labels. See StreamBIM API docs for all options.',
	},
	{
		displayName: 'Time Zone',
		name: 'topicExportTimeZone',
		type: 'string',
		default: 'Europe/Stockholm',
		displayOptions: {
			show: {
				...TOPIC_SHOW,
				operation: ['exportJson'],
			},
		},
		description: 'Time zone for date fields in export (e.g., Europe/Stockholm, UTC)',
	},
];

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function readTopicIdResourceLocator(
	ctx: IExecuteFunctions,
	i: number,
): { value: string; mode: 'list' | 'id' } {
	const raw = ctx.getNodeParameter('topicId', i) as
		| string
		| INodeParameterResourceLocator
		| undefined;
	if (raw === undefined || raw === null) {
		throw new NodeOperationError(ctx.getNode(), 'Topic is required and cannot be empty', {
			itemIndex: i,
		});
	}
	let value: string;
	let mode: 'list' | 'id' = 'id';
	if (typeof raw === 'string') {
		value = raw.trim();
	} else {
		value = String(raw.value ?? '').trim();
		mode = (raw.mode === 'list' ? 'list' : 'id') as 'list' | 'id';
	}
	if (!value || value === 'null' || value === 'undefined') {
		throw new NodeOperationError(ctx.getNode(), 'Topic is required and cannot be empty', {
			itemIndex: i,
		});
	}
	return { value, mode };
}

function buildTopicAttributesFromForm(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
): IDataObject {
	const title = (ctx.getNodeParameter('topicTitle', i, '') as string).trim();
	const description = ctx.getNodeParameter('topicDescription', i, '') as string;
	const channel = ctx.getNodeParameter('topicChannel', i, 'public') as string;
	const isDraft = ctx.getNodeParameter('topicIsDraft', i, true) as boolean;

	if (operation === 'create' && !title) {
		throw new NodeOperationError(ctx.getNode(), 'Title is required for Create', {
			itemIndex: i,
		});
	}

	const attrs: IDataObject = {};
	if (title) attrs.title = title;
	if (description !== undefined && description !== '') attrs.description = description;
	if (channel) attrs.channel = channel;
	attrs['is-draft'] = isDraft;
	return attrs;
}

function buildTopicRelationshipsFromForm(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
): Record<string, { data: JsonApiRelationshipRef | JsonApiRelationshipRef[] | null }> | undefined {
	const buildingId = (ctx.getNodeParameter('topicBuildingId', i, '') as string).trim();
	const statusId = (ctx.getNodeParameter('topicStatusId', i, '') as string).trim();
	const workflowId = (ctx.getNodeParameter('topicWorkflowId', i, '') as string).trim();
	const priorityId = (ctx.getNodeParameter('topicPriorityId', i, '') as string).trim();
	const assignedTo = ctx.getNodeParameter('topicAssignedTo', i, {}) as {
		group?: { groupId?: string };
		user?: { userId?: string };
	};

	if (operation === 'create') {
		if (!buildingId) {
			throw new NodeOperationError(ctx.getNode(), 'Building is required for Create', {
				itemIndex: i,
			});
		}
		if (!statusId) {
			throw new NodeOperationError(ctx.getNode(), 'Status is required for Create', {
				itemIndex: i,
			});
		}
	}

	const rels: Record<string, { data: JsonApiRelationshipRef | JsonApiRelationshipRef[] | null }> = {};
	if (buildingId) rels.building = relationshipRef('buildings', buildingId);
	if (statusId) rels.status = relationshipRef('topic-statuses', statusId);
	if (workflowId) rels.workflow = relationshipRef('workflows', workflowId);
	if (priorityId) rels.priority = relationshipRef('topic-priorities', priorityId);

	const groupId = (assignedTo.group?.groupId ?? '').toString().trim();
	const userId = (assignedTo.user?.userId ?? '').toString().trim();
	if (groupId && userId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Assigned To must be either a Group or a User, not both',
			{ itemIndex: i },
		);
	}
	if (groupId) {
		rels['assigned-to-group'] = relationshipRef('groups', groupId);
		rels['assigned-to-user'] = { data: null };
	} else if (userId) {
		rels['assigned-to-user'] = relationshipRef('users', userId);
		rels['assigned-to-group'] = { data: null };
	}

	return Object.keys(rels).length > 0 ? rels : undefined;
}

function buildTopicBodyFromForm(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
	id?: string,
): IDataObject {
	const attributes = buildTopicAttributesFromForm(ctx, i, operation);
	const relationships = buildTopicRelationshipsFromForm(ctx, i, operation);
	return buildJsonApiBody({
		type: 'topics',
		id,
		attributes,
		relationships,
	});
}

function buildTopicFilters(ctx: IExecuteFunctions, i: number): IDataObject {
	const filters = ctx.getNodeParameter('filters', i, {}) as {
		values?: FixedCollectionFilterValues;
	};
	return buildFilters(filters?.values);
}

export async function runTopic(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	const base = `/project-${projectId}/api/v1/v2/topics`;

	if (operation === 'getMany') {
		const useRawQuery = ctx.getNodeParameter('useRawQuery', i, false) as boolean;
		const qs = useRawQuery
			? parseJsonQueryParameters(
					ctx,
					ctx.getNodeParameter('topicQueryParameters', i, '') as string,
					i,
					'Query parameters',
				)
			: buildTopicFilters(ctx, i);
		const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? undefined : (ctx.getNodeParameter('limit', i, 50) as number);
		const pagination = toStreamBimListPagination({ returnAll, limit });
		const response = await streamBimJsonApiGetMany.call(ctx, base, tokenCache, qs, pagination);
		return response;
	}

	if (operation === 'get') {
		const { value } = readTopicIdResourceLocator(ctx, i);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(value)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create') {
		const useRawBody = ctx.getNodeParameter('useRawBody', i, false) as boolean;
		const body = useRawBody
			? parseJsonBody(ctx, ctx.getNodeParameter('topicBody', i) as string, i, 'Topic body')
			: buildTopicBodyFromForm(ctx, i, 'create');
		const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
		return response;
	}

	if (operation === 'update') {
		const { value } = readTopicIdResourceLocator(ctx, i);
		const useRawBody = ctx.getNodeParameter('useRawBody', i, false) as boolean;
		const body = useRawBody
			? parseJsonBody(ctx, ctx.getNodeParameter('topicBody', i) as string, i, 'Topic body')
			: buildTopicBodyFromForm(ctx, i, 'update', value);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(value)}`,
			tokenCache,
			body,
			{},
		);
		return response;
	}

	if (operation === 'delete') {
		const { value, mode } = readTopicIdResourceLocator(ctx, i);
		const idType = ctx.getNodeParameter('topicIdType', i, 'id') as 'id' | 'publicId';
		// "From List" always resolves to internal IDs, regardless of idType.
		const effectiveType: 'id' | 'publicId' = mode === 'list' ? 'id' : idType;
		let responseData: unknown;
		if (effectiveType === 'publicId') {
			const qs: IDataObject = { 'filter[publicId]': value };
			responseData = await streamBimJsonApiRequest.call(
				ctx,
				'DELETE',
				base,
				tokenCache,
				undefined,
				qs,
			);
		} else {
			responseData = await streamBimJsonApiRequest.call(
				ctx,
				'DELETE',
				`${base}/${encodeURIComponent(value)}`,
				tokenCache,
				undefined,
				{},
			);
		}
		if (responseData === undefined || responseData === null || responseData === '') {
			responseData = { deleted: true };
		}
		return responseData;
	}

	if (operation === 'exportJson') {
		const selectorsRaw = ctx.getNodeParameter('topicExportSelectors', i, '{}') as string;
		const selectors = parseJsonBody(ctx, selectorsRaw, i, 'Topic export selectors');
		const timeZone = ctx.getNodeParameter('topicExportTimeZone', i, '') as string;
		const queryObj: IDataObject = { selectors };
		if (timeZone?.trim()) {
			queryObj.timeZone = timeZone.trim();
		}
		const query = b64EncodeJson(queryObj);
		return streamBimPlainJsonRequest.call(
			ctx,
			'GET',
			`/project-${projectId}/api/v1/topics/export/json/`,
			tokenCache,
			undefined,
			{ query },
		);
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown topic operation: ${operation}`);
}
