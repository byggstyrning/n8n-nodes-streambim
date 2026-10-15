import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	b64EncodeJson,
	streamBimJsonApiGetMany,
	streamBimPlainJsonRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import { buildFilterQs } from '../helpers/filters';
import { getV8Pagination, paginationFields } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody, parseJsonQueryParameters } from './_runHelpers';

export const checklistOperations: INodePropertyOptions[] = [
	{
		name: 'Get Many',
		value: 'getMany',
		description: 'List checklists in the project',
		action: 'List checklists',
	},
	{
		name: 'Export JSON',
		value: 'exportJson',
		description: 'Export checklist data as JSON (base64 query object)',
		action: 'Export checklist JSON',
	},
];

export const checklistProperties: INodeProperties[] = [
	// ── Get Many ──────────────────────────────────────────────────────────────
	{
		displayName: 'Advanced — Use Raw Query Object JSON',
		name: 'checklistUseRawQuery',
		type: 'boolean',
		default: false,
		description:
			'Whether to bypass the Filters form and send a raw JSON:API query object instead',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['getMany'],
			},
		},
	},
	{
		displayName: 'Filters',
		name: 'checklistFilters',
		type: 'fixedCollection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['getMany'],
				checklistUseRawQuery: [false],
			},
		},
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				values: [
					{
						displayName: 'Is Draft',
						name: 'isDraft',
						type: 'boolean',
						default: false,
						description: 'Whether to include draft checklists (filter[isDraft])',
					},
				],
			},
		],
	},
	{
		displayName: 'Query Parameters (Raw JSON)',
		name: 'checklistQueryParametersJson',
		type: 'json',
		default: '{\n  "filter[isDraft]": false\n}\n',
		description:
			'Raw JSON:API query parameters. page[limit] / page[skip] here are ignored — use Return All / Limit instead.',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['getMany'],
				checklistUseRawQuery: [true],
			},
		},
	},
	...paginationFields('checklist', ['getMany']),

	// ── Export JSON ───────────────────────────────────────────────────────────
	{
		displayName: 'Advanced — Use Raw Query Object JSON',
		name: 'checklistUseRawExportQuery',
		type: 'boolean',
		default: false,
		description:
			'Whether to bypass the export form fields and send a raw base64-encoded query object instead',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
			},
		},
	},
	{
		displayName: 'Key',
		name: 'checklistExportKey',
		type: 'options',
		default: 'object',
		description:
			'Grouping key for the export. "object" groups by IFC object (resolve via IFC Search), "checklist" lists checklists.',
		options: [
			{ name: 'Object', value: 'object' },
			{ name: 'Checklist', value: 'checklist' },
		],
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Filter Checklist Name or ID',
		name: 'checklistExportFilterChecklist',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getChecklists',
			loadOptionsDependsOn: ['projectId'],
		},
		default: '',
		required: true,
		description:
			'Checklist to export (filter.checklist). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
				checklistExportKey: ['object'],
			},
		},
	},
	{
		displayName: 'Snapshot',
		name: 'checklistExportSnapshot',
		type: 'string',
		default: '',
		description: 'Optional snapshot identifier (omit to use the latest)',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Sort Field',
		name: 'checklistExportSortField',
		type: 'string',
		default: 'title',
		description: 'Attribute used for ordering rows in the export',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Sort Descending',
		name: 'checklistExportSortDescending',
		type: 'boolean',
		default: false,
		description: 'Whether to sort in descending order',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Time Zone',
		name: 'checklistExportTimeZone',
		type: 'string',
		default: 'Europe/Stockholm',
		description: 'IANA time zone used to render dates in the export',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Format',
		name: 'checklistExportFormat',
		type: 'options',
		default: 'json',
		description: 'Output format. Only JSON is supported by this node.',
		options: [{ name: 'JSON', value: 'json' }],
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Filename',
		name: 'checklistExportFilename',
		type: 'string',
		default: '',
		description: 'Optional filename to suggest in the export response',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Page Skip',
		name: 'checklistExportPageSkip',
		type: 'number',
		default: 0,
		typeOptions: { minValue: 0 },
		description: 'Offset for export pagination (page.skip)',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Page Limit',
		name: 'checklistExportPageLimit',
		type: 'number',
		default: 10000,
		typeOptions: { minValue: 1 },
		description: 'Max rows to include in the export (page.limit)',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [false],
			},
		},
	},
	{
		displayName: 'Export Query Object (Raw JSON)',
		name: 'checklistExportQueryObjectJson',
		type: 'json',
		default:
			'{\n  "key": "object",\n  "sort": { "field": "title", "descending": false },\n  "page": { "skip": 0, "limit": 10000 },\n  "filter": { "checklist": "1004" },\n  "timeZone": "Europe/Stockholm",\n  "format": "json",\n  "filename": ""\n}\n',
		description:
			'Raw base64-source object for checklist export. See StreamBIM export docs for the full schema.',
		displayOptions: {
			show: {
				resource: ['checklist'],
				operation: ['exportJson'],
				checklistUseRawExportQuery: [true],
			},
		},
	},
];

type ChecklistFiltersForm = {
	filter?: {
		isDraft?: boolean;
	};
};

function buildChecklistExportQueryObject(
	ctx: IExecuteFunctions,
	i: number,
): IDataObject {
	const key = ctx.getNodeParameter('checklistExportKey', i, 'object') as
		| 'object'
		| 'checklist';
	const sortField = (
		ctx.getNodeParameter('checklistExportSortField', i, 'title') as string
	).trim() || 'title';
	const sortDescending = ctx.getNodeParameter(
		'checklistExportSortDescending',
		i,
		false,
	) as boolean;
	const pageSkipRaw = Number(
		ctx.getNodeParameter('checklistExportPageSkip', i, 0),
	);
	const pageLimitRaw = Number(
		ctx.getNodeParameter('checklistExportPageLimit', i, 10000),
	);
	const timeZone = (
		ctx.getNodeParameter('checklistExportTimeZone', i, 'Europe/Stockholm') as string
	).trim() || 'Europe/Stockholm';
	const format = ctx.getNodeParameter('checklistExportFormat', i, 'json') as string;
	const filename = (
		ctx.getNodeParameter('checklistExportFilename', i, '') as string
	).trim();
	const snapshot = (
		ctx.getNodeParameter('checklistExportSnapshot', i, '') as string
	).trim();

	const filter: IDataObject = {};
	if (key === 'object') {
		const checklistId = (
			ctx.getNodeParameter('checklistExportFilterChecklist', i, '') as string
		).trim();
		if (!checklistId) {
			throw new NodeOperationError(
				ctx.getNode(),
				'Filter Checklist is required when Key is "object"',
				{ itemIndex: i },
			);
		}
		filter.checklist = checklistId;
	}
	if (snapshot) {
		filter.snapshot = snapshot;
	}

	const obj: IDataObject = {
		key,
		sort: {
			field: sortField,
			descending: sortDescending,
		},
		page: {
			skip: Number.isFinite(pageSkipRaw) && pageSkipRaw >= 0 ? Math.floor(pageSkipRaw) : 0,
			limit:
				Number.isFinite(pageLimitRaw) && pageLimitRaw > 0
					? Math.floor(pageLimitRaw)
					: 10000,
		},
		filter,
		timeZone,
		format,
		filename,
	};
	return obj;
}

export async function runChecklist(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);

	if (operation === 'getMany') {
		const useRaw = ctx.getNodeParameter('checklistUseRawQuery', i, false) as boolean;
		let qs: IDataObject;
		if (useRaw) {
			const raw = ctx.getNodeParameter('checklistQueryParametersJson', i, '') as string;
			qs = parseJsonQueryParameters(ctx, raw, i, 'Query parameters');
		} else {
			const form = ctx.getNodeParameter(
				'checklistFilters',
				i,
				{},
			) as ChecklistFiltersForm;
			const isDraft = form?.filter?.isDraft;
			qs = buildFilterQs({ isDraft });
		}
		const response = await streamBimJsonApiGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/v2/checklists`,
			tokenCache,
			qs,
			getV8Pagination(ctx, i, { allPagesPageSize: 200 }),
		);
		return response;
	}

	if (operation === 'exportJson') {
		const useRaw = ctx.getNodeParameter(
			'checklistUseRawExportQuery',
			i,
			false,
		) as boolean;
		let obj: IDataObject;
		if (useRaw) {
			const raw = ctx.getNodeParameter('checklistExportQueryObjectJson', i) as string;
			obj = parseJsonBody(ctx, raw, i, 'Export query object');
		} else {
			obj = buildChecklistExportQueryObject(ctx, i);
		}
		const query = b64EncodeJson(obj);
		return streamBimPlainJsonRequest.call(
			ctx,
			'GET',
			`/project-${projectId}/api/v1/checklists/export/json/`,
			tokenCache,
			undefined,
			{ query },
		);
	}

	throw new NodeOperationError(ctx.getNode(), `Unknown checklist operation: ${operation}`);
}
