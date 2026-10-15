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
	buildJsonApiBody,
	relationshipRef,
	type JsonApiRelationshipRef,
} from '../helpers/jsonApiBody';
import {
	buildReturnAllAndLimit,
	toStreamBimListPagination,
} from '../helpers/pagination';
import {
	getProjectIdString,
	getRequiredStringParameter,
	parseJsonBody,
	parseJsonQueryParameters,
} from './_runHelpers';

export const workflowOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List workflows',
		action: 'List workflows',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a workflow by ID',
		action: 'Get workflow',
	},
];

const WORKFLOW_SHOW: { resource: string[] } = { resource: ['workflow'] };

export const workflowProperties: INodeProperties[] = [
	// -------------------------------------------------------------------------
	// Workflow ID picker (get / update / delete)
	// -------------------------------------------------------------------------
	{
		displayName: 'Workflow Name or ID',
		name: 'workflowId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getWorkflows',
			loadOptionsDependsOn: ['projectId'],
		},
		default: '',
		required: true,
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['delete', 'get', 'update'],
			},
		},
		description:
			'Workflow to operate on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},

	// -------------------------------------------------------------------------
	// Get Many: Filters + Raw JSON escape hatch + returnAll/limit
	// -------------------------------------------------------------------------
	{
		displayName: 'Advanced — Use Raw JSON Query',
		name: 'workflowUseRawQuery',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['getMany'],
			},
		},
		description:
			'Whether to bypass the Filters builder and send a raw JSON query parameters object. Use this escape hatch for filters that are not first-classed in the UI.',
	},
	{
		displayName: 'Filters',
		name: 'workflowFilters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		placeholder: 'Add Filter',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['getMany'],
				workflowUseRawQuery: [false],
			},
		},
		options: [
			{
				name: 'values',
				displayName: 'Filter',
				values: [
					{
						displayName: 'Accessible',
						name: 'accessible',
						type: 'boolean',
						default: true,
						description:
							'Whether to only return workflows the current user can access (filter[accessible])',
					},
					{
						displayName: 'For Creation',
						name: 'forCreation',
						type: 'boolean',
						default: true,
						description:
							'Whether to only return workflows that can be used when creating topics (filter[forCreation])',
					},
					{
						displayName: 'Include System',
						name: 'includeSystem',
						type: 'boolean',
						default: false,
						description:
							'Whether to include built-in StreamBIM system workflows (filter[includeSystem])',
					},
					{
						displayName: 'Workflow Type',
						name: 'workflowType',
						type: 'options',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Workflow', value: 'workflow' },
							{ name: 'Checklist', value: 'checklist' },
						],
						default: '',
						description: 'Filter by workflow type (filter[workflowType])',
					},
				],
			},
		],
	},
	{
		displayName: 'Query Parameters',
		name: 'workflowQueryParameters',
		type: 'json',
		default:
			'{\n  "filter[accessible]": true,\n  "filter[forCreation]": true,\n  "filter[includeSystem]": true,\n  "filter[workflowType]": "workflow"\n}\n',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['getMany'],
				workflowUseRawQuery: [true],
			},
		},
		description:
			'Raw JSON query parameters. Use Return All / Limit for page[limit] / page[skip] (values in JSON for those keys are ignored).',
	},
	...buildReturnAllAndLimit(['workflow'], ['getMany']),

	// -------------------------------------------------------------------------
	// Create / Update: Use Raw JSON Body toggle + form fields + raw JSON
	// -------------------------------------------------------------------------
	{
		displayName: 'Advanced — Use Raw JSON Body',
		name: 'workflowUseRawBody',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
			},
		},
		description:
			'Whether to bypass the form fields and send a raw JSON:API body. Use this escape hatch for attributes / relationships not first-classed in the UI.',
	},
	{
		displayName: 'Name',
		name: 'workflowName',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description: 'Workflow name shown in the StreamBIM UI. Required on Create.',
	},
	{
		displayName: 'Title',
		name: 'workflowTitle',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description: 'Optional display title for the workflow',
	},
	{
		displayName: 'Description',
		name: 'workflowDescription',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
	},
	{
		displayName: 'Cost',
		name: 'workflowCost',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description: 'Optional cost string (StreamBIM stores this as a free-form value)',
	},
	{
		displayName: 'Due Date',
		name: 'workflowDueDate',
		type: 'dateTime',
		default: '',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description: 'Optional due date for the workflow. Sent as null when left empty.',
	},
	{
		displayName: 'Workflow Type',
		name: 'workflowTypeField',
		type: 'options',
		options: [
			{ name: 'Workflow', value: 'workflow' },
			{ name: 'Checklist', value: 'checklist' },
		],
		default: 'workflow',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description: 'Type of workflow record to create',
	},
	{
		displayName: 'Priority Name or ID',
		name: 'workflowPriorityId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getTopicPriorities',
			loadOptionsDependsOn: ['projectId'],
		},
		default: '',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description:
			'Optional topic priority for the workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Assigned To',
		name: 'workflowAssignedTo',
		type: 'fixedCollection',
		typeOptions: { multipleValues: false },
		default: {},
		placeholder: 'Add Assignment',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [false],
			},
		},
		description:
			'Assign the workflow to a Group or a User (mutually exclusive). Leave empty to send both relationships as null.',
		options: [
			{
				name: 'group',
				displayName: 'To Group',
				values: [
					{
						displayName: 'Group Name or ID',
						name: 'groupId',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getGroups',
							loadOptionsDependsOn: ['projectId'],
						},
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
						typeOptions: {
							loadOptionsMethod: 'getProjectUsers',
							loadOptionsDependsOn: ['projectId'],
						},
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
		name: 'workflowBody',
		type: 'json',
		default:
			'{\n  "data": {\n    "id": "",\n    "type": "workflows",\n    "attributes": {\n      "name": "My Workflow",\n      "cost": "",\n      "description": "",\n      "due-date": null,\n      "title": "",\n      "workflow-type": "workflow"\n    },\n    "relationships": {\n      "priority": { "data": { "id": "2", "type": "topic-priorities" } },\n      "assigned-to-group": { "data": null },\n      "assigned-to-user": { "data": null }\n    }\n  }\n}\n',
		displayOptions: {
			show: {
				...WORKFLOW_SHOW,
				operation: ['create', 'update'],
				workflowUseRawBody: [true],
			},
		},
		description:
			'Raw JSON:API document for the workflow. For create, use ID: "" (empty string). Common workflow-types: workflow, checklist.',
	},
];

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type WorkflowFilterValues = {
	accessible?: boolean;
	forCreation?: boolean;
	includeSystem?: boolean;
	workflowType?: string;
};

function buildWorkflowFiltersFromForm(ctx: IExecuteFunctions, i: number): IDataObject {
	const filters = ctx.getNodeParameter('workflowFilters', i, {}) as {
		values?: WorkflowFilterValues;
	};
	const values = filters?.values ?? {};
	const qs: IDataObject = {};
	if (typeof values.accessible === 'boolean') qs['filter[accessible]'] = values.accessible;
	if (typeof values.forCreation === 'boolean') qs['filter[forCreation]'] = values.forCreation;
	if (typeof values.includeSystem === 'boolean') qs['filter[includeSystem]'] = values.includeSystem;
	const wfType = (values.workflowType ?? '').toString().trim();
	if (wfType) qs['filter[workflowType]'] = wfType;
	return qs;
}

function buildWorkflowAttributesFromForm(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
): IDataObject {
	const name = (ctx.getNodeParameter('workflowName', i, '') as string).trim();
	const title = ctx.getNodeParameter('workflowTitle', i, '') as string;
	const description = ctx.getNodeParameter('workflowDescription', i, '') as string;
	const cost = ctx.getNodeParameter('workflowCost', i, '') as string;
	const dueDateRaw = ctx.getNodeParameter('workflowDueDate', i, '') as string;
	const workflowType = ctx.getNodeParameter('workflowTypeField', i, 'workflow') as string;

	if (operation === 'create' && !name) {
		throw new NodeOperationError(ctx.getNode(), 'Name is required for Create', {
			itemIndex: i,
		});
	}

	const attrs: IDataObject = {};
	if (name) attrs.name = name;
	if (title !== undefined && title !== '') attrs.title = title;
	if (description !== undefined && description !== '') attrs.description = description;
	if (cost !== undefined && cost !== '') attrs.cost = cost;
	const dueDate = (dueDateRaw ?? '').toString().trim();
	attrs['due-date'] = dueDate ? dueDate : null;
	if (workflowType) attrs['workflow-type'] = workflowType;
	return attrs;
}

function buildWorkflowRelationshipsFromForm(
	ctx: IExecuteFunctions,
	i: number,
): Record<string, { data: JsonApiRelationshipRef | JsonApiRelationshipRef[] | null }> | undefined {
	const priorityId = (ctx.getNodeParameter('workflowPriorityId', i, '') as string).trim();
	const assignedTo = ctx.getNodeParameter('workflowAssignedTo', i, {}) as {
		group?: { groupId?: string };
		user?: { userId?: string };
	};

	const rels: Record<string, { data: JsonApiRelationshipRef | JsonApiRelationshipRef[] | null }> = {};
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
	} else {
		rels['assigned-to-group'] = { data: null };
		rels['assigned-to-user'] = { data: null };
	}

	return Object.keys(rels).length > 0 ? rels : undefined;
}

function buildWorkflowBodyFromForm(
	ctx: IExecuteFunctions,
	i: number,
	operation: 'create' | 'update',
	id?: string,
): IDataObject {
	const attributes = buildWorkflowAttributesFromForm(ctx, i, operation);
	const relationships = buildWorkflowRelationshipsFromForm(ctx, i);
	return buildJsonApiBody({
		type: 'workflows',
		id,
		attributes,
		relationships,
	});
}

export async function runWorkflow(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	const base = `/project-${projectId}/api/v1/v2/workflows`;

	if (operation === 'getMany') {
		const useRawQuery = ctx.getNodeParameter('workflowUseRawQuery', i, false) as boolean;
		const qs = useRawQuery
			? parseJsonQueryParameters(
					ctx,
					ctx.getNodeParameter('workflowQueryParameters', i, '') as string,
					i,
					'Query parameters',
				)
			: buildWorkflowFiltersFromForm(ctx, i);
		const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? undefined : (ctx.getNodeParameter('limit', i, 50) as number);
		const pagination = toStreamBimListPagination({ returnAll, limit });
		const response = await streamBimJsonApiGetMany.call(ctx, base, tokenCache, qs, pagination);
		return response;
	}

	if (operation === 'get') {
		const workflowId = getRequiredStringParameter(ctx, 'workflowId', i, 'Workflow');
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${base}/${encodeURIComponent(workflowId)}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'create') {
		const useRawBody = ctx.getNodeParameter('workflowUseRawBody', i, false) as boolean;
		const body = useRawBody
			? parseJsonBody(
					ctx,
					ctx.getNodeParameter('workflowBody', i) as string,
					i,
					'Workflow body',
				)
			: buildWorkflowBodyFromForm(ctx, i, 'create');
		const response = await streamBimJsonApiRequest.call(ctx, 'POST', base, tokenCache, body, {});
		return response;
	}

	if (operation === 'update') {
		const workflowId = getRequiredStringParameter(ctx, 'workflowId', i, 'Workflow');
		const useRawBody = ctx.getNodeParameter('workflowUseRawBody', i, false) as boolean;
		const body = useRawBody
			? parseJsonBody(
					ctx,
					ctx.getNodeParameter('workflowBody', i) as string,
					i,
					'Workflow body',
				)
			: buildWorkflowBodyFromForm(ctx, i, 'update', workflowId);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`${base}/${encodeURIComponent(workflowId)}`,
			tokenCache,
			body,
			{},
		);
		return response;
	}

	if (operation === 'delete') {
		const workflowId = getRequiredStringParameter(ctx, 'workflowId', i, 'Workflow');
		let responseData = await streamBimJsonApiRequest.call(
			ctx,
			'DELETE',
			`${base}/${encodeURIComponent(workflowId)}`,
			tokenCache,
			undefined,
			{},
		);
		if (responseData === undefined || responseData === null || responseData === '') {
			responseData = { deleted: true };
		}
		return responseData;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown workflow operation: ${operation}`);
}
