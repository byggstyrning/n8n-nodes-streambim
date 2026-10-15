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
	getFiltersQuery,
	filtersField,
	parseRawQueryJson,
	rawQueryEscapeHatch,
} from '../helpers/filters';
import {
	buildReturnAllAndLimit,
	getV8ListPagination,
} from '../helpers/pagination';
import {
	buildJsonApiBody,
	relationshipNull,
	relationshipRef,
} from '../helpers/jsonApiBody';
import { projectMemberUserIdFromMemberId } from '../../shared/streamBimProjectMembers';
import {
	getProjectIdString,
	parseJsonBody,
} from './_runHelpers';

const USER_RESOURCE = ['user'];

const LIST_OPERATIONS = [
	'getManyUsers',
	'getManyProjectUsers',
	'getManyProjectMembers',
	'getManyGroups',
];

const SSO_PROVIDER_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Azure AD', value: 'AzureAD' },
	{ name: 'Google', value: 'Google' },
	{ name: 'Okta', value: 'Okta' },
];

export const userOperations: INodePropertyOptions[] = [
	{
		name: 'Invite User',
		value: 'inviteUser',
		description: 'Send a project invite by email (uses Project above). Toggle Advanced for raw JSON body.',
		action: 'Invite a user',
	},
	{
		name: 'Get',
		value: 'get',
		description: 'GET a global user by ID',
		action: 'Get user',
	},
	{
		name: 'Get Many Groups',
		value: 'getManyGroups',
		description: 'List groups for the project (discover group IDs for filters)',
		action: 'List groups',
	},
	{
		name: 'Get Many Project Members',
		value: 'getManyProjectMembers',
		description: 'List project members',
		action: 'List project members',
	},
	{
		name: 'Get Many Project Users',
		value: 'getManyProjectUsers',
		description: 'List users in the project (optional filter by group IDs)',
		action: 'List project users',
	},
	{
		name: 'Get Many Users (Global)',
		value: 'getManyUsers',
		description: 'List users in the global gateway (not project-scoped)',
		action: 'List global users',
	},
	{
		name: 'Deactivate Project Member',
		value: 'deactivateProjectMember',
		description:
			'Set a project member to inactive (PATCH privilege-level 0). Uses the Project field above.',
		action: 'Deactivate project member',
	},
];

export const userProperties: INodeProperties[] = [
	// ── Deactivate project member (privilege-level 0) ─────────────
	{
		displayName: 'Project Member Name or ID',
		name: 'projectMemberId',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getProjectMembers',
		},
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['deactivateProjectMember'],
				deactivateUseRawJsonBody: [false],
			},
		},
		default: '',
		required: true,
		description:
			'Member to deactivate (inactive privilege level 0). Only members who are not already inactive are listed. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Advanced — Use Raw JSON Body',
		name: 'deactivateUseRawJsonBody',
		type: 'boolean',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['deactivateProjectMember'],
			},
		},
		default: false,
		description: 'Whether to ignore the member picker and PATCH a full JSON:API body to .../project-members/{ID}',
	},
	{
		displayName: 'JSON Body',
		name: 'deactivateBody',
		type: 'json',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['deactivateProjectMember'],
				deactivateUseRawJsonBody: [true],
			},
		},
		default:
			'{\n  "data": {\n    "type": "project-members",\n    "id": "PROJECT_ID-user@example.com",\n    "attributes": {\n      "privilege-level": 0,\n      "send-invitation": false\n    },\n    "relationships": {\n      "project": { "data": { "type": "projects", "id": "PROJECT_ID" } },\n      "user": { "data": { "type": "users", "id": "user@example.com" } },\n      "user-organization": { "data": null }\n    }\n  }\n}\n',
		description:
			'Full JSON:API payload for PATCH .../project-members/{projectMemberID}. Used only when the Advanced toggle is on.',
	},

	// ── Get (global) ────────────────────────────────────────────────
	{
		displayName: 'User ID',
		name: 'userId',
		type: 'string',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['get'],
			},
		},
		default: '',
		required: true,
		description: 'User identifier (often the email address)',
	},

	// ── Invite User (form + raw-JSON escape hatch) ──────────────────
	{
		displayName: 'Email Address',
		name: 'inviteEmail',
		type: 'string',
		placeholder: 'name@company.com',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['inviteUser'],
				inviteUseRawJsonBody: [false],
			},
		},
		default: '',
		required: true,
		description:
			'Email address to invite. Uses the Project field above. Matches POST .../invites in the StreamBIM API.',
	},
	{
		displayName: 'SSO Providers',
		name: 'inviteSsoProviders',
		type: 'multiOptions',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['inviteUser'],
				inviteUseRawJsonBody: [false],
			},
		},
		default: [],
		options: SSO_PROVIDER_OPTIONS,
		description:
			'Restrict the invite to specific SSO providers. Leave empty to allow any sign-in method.',
	},
	{
		displayName: 'Other SSO Providers',
		name: 'inviteSsoProvidersOther',
		type: 'string',
		placeholder: 'CustomIdp1, CustomIdp2',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['inviteUser'],
				inviteUseRawJsonBody: [false],
			},
		},
		default: '',
		description:
			'Comma-separated additional SSO provider identifiers to append to the list above (free-text "Add other")',
	},
	{
		displayName: 'Advanced — Use Raw JSON Body',
		name: 'inviteUseRawJsonBody',
		type: 'boolean',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['inviteUser'],
			},
		},
		default: false,
		description:
			'Whether to ignore the form fields and POST a full JSON:API body to .../invites (advanced)',
	},
	{
		displayName: 'JSON Body',
		name: 'inviteBody',
		type: 'json',
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['inviteUser'],
				inviteUseRawJsonBody: [true],
			},
		},
		default:
			'{\n  "data": {\n    "type": "invites",\n    "attributes": {\n      "email": "user@example.com",\n      "sso-providers": []\n    },\n    "relationships": {\n      "project": {\n        "data": { "id": "PROJECT_ID", "type": "projects" }\n      }\n    }\n  }\n}\n',
		description:
			'Full JSON:API payload for POST .../invites. Used only when the Advanced toggle is on.',
	},

	// ── Get Many Project Users: extra typed filter ─────────────────
	{
		displayName: 'Filter Users by Group Names or IDs',
		name: 'projectUsersFilterGroupIds',
		type: 'multiOptions',
		typeOptions: {
			loadOptionsMethod: 'getGroups',
			loadOptionsDependsOn: ['projectId'],
		},
		displayOptions: {
			show: {
				resource: USER_RESOURCE,
				operation: ['getManyProjectUsers'],
			},
		},
		default: [],
		description:
			'Project groups to filter by (compiled to filter[groups]). Leave empty to list all project users. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},

	// ── Filters fixedCollections + raw-JSON escape hatches ─────────
	...filtersField({
		operations: ['getManyUsers', 'getManyProjectUsers', 'getManyProjectMembers'],
		resources: USER_RESOURCE,
		name: 'userListFilters',
		options: [
			{ name: 'email', displayName: 'Email contains', description: 'Filter by user email substring' },
			{ name: 'name', displayName: 'Name contains', description: 'Filter by user name substring' },
		],
		includeSort: true,
	}),
	...rawQueryEscapeHatch({
		operations: ['getManyUsers', 'getManyProjectUsers', 'getManyProjectMembers'],
		resources: USER_RESOURCE,
		toggleName: 'userListUseRawQueryJson',
		jsonName: 'userListRawQueryJson',
		description:
			'Whether to ignore the Filters above and send a raw JSON object as the query string for user list endpoints',
	}),

	...filtersField({
		operations: ['getManyGroups'],
		resources: USER_RESOURCE,
		name: 'groupsFilters',
		options: [
			{ name: 'name', displayName: 'Name contains', description: 'Filter groups by name substring' },
		],
		includeSort: true,
	}),
	...rawQueryEscapeHatch({
		operations: ['getManyGroups'],
		resources: USER_RESOURCE,
		toggleName: 'groupsUseRawQueryJson',
		jsonName: 'groupsRawQueryJson',
		description:
			'Whether to ignore the Filters above and send a raw JSON object as the query string for GET /groups',
	}),

	// ── Pagination (returnAll + limit) for all Get-Many ops ────────
	...buildReturnAllAndLimit({
		operations: LIST_OPERATIONS,
		resources: USER_RESOURCE,
	}),
];

/**
 * Reads the filters fixedCollection (+ sibling sort) or the raw-JSON escape
 * hatch, depending on the toggle state.
 */
function readListQs(
	ctx: IExecuteFunctions,
	i: number,
	toggleName: string,
	rawJsonName: string,
	filtersName: string,
): IDataObject {
	const useRaw = ctx.getNodeParameter(toggleName, i, false) as boolean;
	if (useRaw) {
		const raw = ctx.getNodeParameter(rawJsonName, i, '') as string;
		return parseRawQueryJson(ctx, raw, i);
	}
	return getFiltersQuery(ctx, filtersName, i, `${filtersName}Sort`);
}

function parseSsoProviders(
	ctx: IExecuteFunctions,
	i: number,
): string[] {
	const fromList = ctx.getNodeParameter('inviteSsoProviders', i, []) as string[];
	const otherRaw = ctx.getNodeParameter('inviteSsoProvidersOther', i, '') as string;
	const other = otherRaw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const merged = [...(Array.isArray(fromList) ? fromList : []), ...other];
	// Dedupe but keep first occurrence order.
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const p of merged) {
		if (!p) continue;
		if (seen.has(p)) continue;
		seen.add(p);
		unique.push(p);
	}
	if (unique.some((p) => !p.trim())) {
		throw new NodeOperationError(ctx.getNode(), 'SSO providers cannot contain empty values', {
			itemIndex: i,
		});
	}
	return unique;
}

export async function runUser(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	if (operation === 'get') {
		const userId = encodeURIComponent(ctx.getNodeParameter('userId', i) as string);
		const response = await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/mgw/api/v3/users/${userId}`,
			tokenCache,
			undefined,
			{},
		);
		return response;
	}

	if (operation === 'getManyUsers') {
		const qs = readListQs(
			ctx,
			i,
			'userListUseRawQueryJson',
			'userListRawQueryJson',
			'userListFilters',
		);
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			'/mgw/api/v3/users',
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	const projectId = getProjectIdString(ctx, i);

	if (operation === 'getManyProjectUsers') {
		const qs = readListQs(
			ctx,
			i,
			'userListUseRawQueryJson',
			'userListRawQueryJson',
			'userListFilters',
		);
		const groupIds = ctx.getNodeParameter('projectUsersFilterGroupIds', i, []) as string[];
		if (Array.isArray(groupIds) && groupIds.length > 0) {
			qs['filter[groups]'] = JSON.stringify(groupIds.map((id) => String(id)));
		}
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/users`,
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	if (operation === 'getManyProjectMembers') {
		const qs = readListQs(
			ctx,
			i,
			'userListUseRawQueryJson',
			'userListRawQueryJson',
			'userListFilters',
		);
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/project-members`,
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	if (operation === 'deactivateProjectMember') {
		const useRaw = ctx.getNodeParameter('deactivateUseRawJsonBody', i, false) as boolean;
		let body: IDataObject;
		let projectMemberId: string;
		if (useRaw) {
			const raw = ctx.getNodeParameter('deactivateBody', i) as string;
			body = parseJsonBody(ctx, raw, i, 'Deactivate body');
			const data = body.data as IDataObject | undefined;
			projectMemberId = String(data?.id ?? '').trim();
			if (!projectMemberId) {
				throw new NodeOperationError(
					ctx.getNode(),
					'Deactivate body must include data.id (project member ID, e.g. PROJECT_ID-user@example.com)',
					{ itemIndex: i },
				);
			}
		} else {
			projectMemberId = String(ctx.getNodeParameter('projectMemberId', i, '') ?? '').trim();
			if (!projectMemberId) {
				throw new NodeOperationError(ctx.getNode(), 'Project member is required', {
					itemIndex: i,
				});
			}
			let userId: string;
			try {
				userId = projectMemberUserIdFromMemberId(projectId, projectMemberId);
			} catch (error) {
				throw new NodeOperationError(
					ctx.getNode(),
					error instanceof Error ? error.message : 'Invalid project member ID',
					{ itemIndex: i },
				);
			}
			body = buildJsonApiBody({
				type: 'project-members',
				id: projectMemberId,
				attributes: {
					'privilege-level': 0,
					'send-invitation': false,
				},
				relationships: {
					project: relationshipRef('projects', projectId),
					user: relationshipRef('users', userId),
					'user-organization': relationshipNull(),
				},
			});
		}
		return streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`/project-${projectId}/api/v1/v2/project-members/${encodeURIComponent(projectMemberId)}`,
			tokenCache,
			body,
			{},
		);
	}

	if (operation === 'inviteUser') {
		const useRaw = ctx.getNodeParameter('inviteUseRawJsonBody', i, false) as boolean;
		let body: IDataObject;
		if (useRaw) {
			const raw = ctx.getNodeParameter('inviteBody', i) as string;
			body = parseJsonBody(ctx, raw, i, 'Invite body');
		} else {
			const email = (ctx.getNodeParameter('inviteEmail', i, '') as string).trim();
			if (!email) {
				throw new NodeOperationError(ctx.getNode(), 'Email address is required', {
					itemIndex: i,
				});
			}
			const ssoProviders = parseSsoProviders(ctx, i);
			body = buildJsonApiBody({
				type: 'invites',
				attributes: {
					email,
					'sso-providers': ssoProviders,
				},
				relationships: {
					project: relationshipRef('projects', projectId),
				},
			});
		}
		return streamBimJsonApiRequest.call(
			ctx,
			'POST',
			`/project-${projectId}/api/v1/v2/invites`,
			tokenCache,
			body,
			{},
		);
	}

	if (operation === 'getManyGroups') {
		const qs = readListQs(
			ctx,
			i,
			'groupsUseRawQueryJson',
			'groupsRawQueryJson',
			'groupsFilters',
		);
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/groups`,
			tokenCache,
			qs,
			getV8ListPagination(ctx, i),
		);
		return response;
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown user operation: ${operation}`);
}
