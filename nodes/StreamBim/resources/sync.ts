import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	streamBimGetSyncStartedRequest,
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimSyncTriggerRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import { buildJsonApiBody } from '../helpers/jsonApiBody';
import { buildReturnAllAndLimit, getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

export const syncOperations: INodePropertyOptions[] = [
	{
		name: 'Trigger Sync',
		value: 'triggerSync',
		description: 'POST to trigger a sync run',
		action: 'Trigger sync',
	},
	{
		name: 'Get Sync Activity',
		value: 'getSyncActivity',
		description: 'GET sync activity started for the project',
		action: 'Get sync activity',
	},
	{
		name: 'List Configs',
		value: 'listConfigs',
		description: 'List project sync configs',
		action: 'List sync configs',
	},
	{
		name: 'List Sync Statuses',
		value: 'listSyncStatuses',
		description: 'List sync statuses for the project',
		action: 'List sync statuses',
	},
];

export const syncProperties: INodeProperties[] = [
	{
		displayName: 'Config Name or ID',
		name: 'configKey',
		type: 'options',
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
			loadOptionsMethod: 'getSyncConfigs',
		},
		displayOptions: {
			show: {
				resource: ['sync'],
				operation: ['updateConfig'],
			},
		},
		default: '',
		required: true,
		description:
			'Sync config from the selected project. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Advanced — Use Raw JSON Body',
		name: 'syncConfigUseRawJson',
		type: 'boolean',
		default: false,
		description:
			'Whether to provide the full JSON:API body manually instead of using the Value / Version fields',
		displayOptions: {
			show: {
				resource: ['sync'],
				operation: ['updateConfig'],
			},
		},
	},
	{
		displayName: 'Value',
		name: 'syncConfigValue',
		type: 'string',
		default: '',
		description: 'Value to set on the sync config (sent as data.attributes.value)',
		displayOptions: {
			show: {
				resource: ['sync'],
				operation: ['updateConfig'],
				syncConfigUseRawJson: [false],
			},
		},
	},
	{
		displayName: 'Version',
		name: 'syncConfigVersion',
		type: 'number',
		default: 1,
		typeOptions: { minValue: 0 },
		description: 'Version number for the config update (sent as data.attributes.version)',
		displayOptions: {
			show: {
				resource: ['sync'],
				operation: ['updateConfig'],
				syncConfigUseRawJson: [false],
			},
		},
	},
	{
		displayName: 'Config Body (Raw JSON)',
		name: 'configBody',
		type: 'json',
		displayOptions: {
			show: {
				resource: ['sync'],
				operation: ['updateConfig'],
				syncConfigUseRawJson: [true],
			},
		},
		default:
			'{\n  "data": {\n    "id": "INTERAXO_COMMUNITY",\n    "type": "configs",\n    "attributes": {\n      "value": "example.com",\n      "version": 1\n    }\n  }\n}\n',
		description: 'Raw JSON:API body sent to PATCH the config. Used when "Use Raw JSON Body" is on.',
	},
	...buildReturnAllAndLimit(['listConfigs', 'listSyncStatuses'], {
		resource: 'sync',
		defaultLimit: 100,
	}),
];

export async function runSync(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (operation === 'triggerSync') {
		return streamBimSyncTriggerRequest.call(ctx, projectId, tokenCache);
	}
	if (operation === 'getSyncActivity') {
		const response = await streamBimGetSyncStartedRequest.call(ctx, projectId, tokenCache);
		return response;
	}
	if (operation === 'listConfigs') {
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/configs`,
			tokenCache,
			{},
			getV8ListPagination(ctx, i, { defaultLimit: 100 }),
		);
		return response;
	}
	if (operation === 'updateConfig') {
		const configKey = ctx.getNodeParameter('configKey', i) as string;
		const useRaw = ctx.getNodeParameter('syncConfigUseRawJson', i, false) as boolean;
		let body: IDataObject;
		if (useRaw) {
			const configBody = ctx.getNodeParameter('configBody', i, '') as string;
			body = parseJsonBody(ctx, configBody, i, 'Config body');
		} else {
			const value = ctx.getNodeParameter('syncConfigValue', i, '') as string;
			const version = Number(ctx.getNodeParameter('syncConfigVersion', i, 1));
			body = buildJsonApiBody({
				type: 'configs',
				id: configKey,
				attributes: {
					value,
					version: Number.isFinite(version) ? version : 1,
				},
			});
		}
		return streamBimJsonApiRequest.call(
			ctx,
			'PATCH',
			`/project-${projectId}/api/v1/v2/configs/${encodeURIComponent(configKey)}`,
			tokenCache,
			body,
			{},
		);
	}
	if (operation === 'listSyncStatuses') {
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/sync-statuses`,
			tokenCache,
			{},
			getV8ListPagination(ctx, i, { defaultLimit: 100 }),
		);
		return response;
	}
	throw new NodeOperationError(ctx.getNode(), `Unknown sync operation: ${operation}`);
}
