import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	b64EncodeUnicodeFieldNames,
	PLAIN_JSON_EXPORT_DEFAULT_PAGE_LIMIT,
	PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT,
	streamBimPlainJsonGetMany,
	streamBimPlainJsonRequest,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import { getV8ListPagination } from '../helpers/pagination';
import { getProjectIdString, parseJsonBody } from './_runHelpers';

const IFC_EXPORT_SHOW = {
	resource: ['ifcSearch'],
	operation: ['exportJson'],
};

/** Return All + Limit for IFC export JSON (auto-paginates via page[limit]/page[skip]). */
function ifcExportPaginationFields(): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			// eslint-disable-next-line n8n-nodes-base/node-param-default-missing -- IFC export should fetch all pages by default
			default: true,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show: IFC_EXPORT_SHOW },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			// eslint-disable-next-line n8n-nodes-base/node-param-default-wrong-for-limit -- 1000 rows/page matches StreamBIM IFC export API defaults
			default: PLAIN_JSON_EXPORT_DEFAULT_PAGE_LIMIT,
			typeOptions: {
				minValue: 1,
				maxValue: PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT,
			},
			// eslint-disable-next-line n8n-nodes-base/node-param-description-wrong-for-limit -- also used as page size when Return All is on
			description:
				'Rows per API page when Return All is on, or max rows for a single request when Return All is off',
			displayOptions: { show: IFC_EXPORT_SHOW },
		},
	];
}

/**
 * IFC search rule row as edited in the Search Rules fixedCollection.
 * Each row contributes a single `{buildingId, propKey, propValue}` entry to
 * the AND group built at runtime.
 */
type IfcRuleRow = {
	buildingId?: string;
	propKey?: string;
	propValue?: string;
};

export const ifcSearchOperations: INodePropertyOptions[] = [
	{
		name: 'Create',
		value: 'create',
		description: 'Create an IFC search with rules',
		action: 'Create IFC search',
	},
	{
		name: 'Export JSON',
		value: 'exportJson',
		description: 'Export IFC search results as JSON',
		action: 'Export IFC search JSON',
	},
];

export const ifcSearchProperties: INodeProperties[] = [
	{
		displayName: 'Advanced — Use Raw JSON Rules',
		name: 'ifcRulesUseRawJson',
		type: 'boolean',
		default: false,
		description:
			'Whether to provide search rules as raw JSON (escape hatch for multi-OR groups not expressible in the Search Rules UI). When off, the Search Rules table compiles to a single AND group inside one OR.',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['create'],
			},
		},
	},
	{
		displayName: 'Search Rules',
		name: 'ifcSearchRules',
		type: 'fixedCollection',
		placeholder: 'Add Rule',
		default: {},
		typeOptions: { multipleValues: true },
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['create'],
				ifcRulesUseRawJson: [false],
			},
		},
		description:
			'Each row contributes one {buildingId, propKey, propValue} entry to the AND group. At runtime the rules compile to {rules: [[ ...rows ]]} — a single AND group inside one OR.',
		options: [
			{
				displayName: 'Rule',
				name: 'rule',
				values: [
					{
						displayName: 'Building Name or ID',
						name: 'buildingId',
						type: 'options',
						typeOptions: {
							loadOptionsDependsOn: ['projectId'],
							loadOptionsMethod: 'getBuildings',
						},
						default: '',
						required: true,
						description:
							'Building from the selected project. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Property Key',
						name: 'propKey',
						type: 'string',
						default: '',
						placeholder: '@kind',
						description: 'IFC property key, e.g. "@kind", "Name", or a propertyset key',
					},
					{
						displayName: 'Property Value',
						name: 'propValue',
						type: 'string',
						default: '',
						description: 'Value to match for the given property key',
					},
				],
			},
		],
	},
	{
		displayName: 'Search Rules (Raw JSON)',
		name: 'rulesJson',
		type: 'json',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['create'],
				ifcRulesUseRawJson: [true],
			},
		},
		default:
			'{\n  "rules": [\n    [\n      {\n        "buildingId": "1000",\n        "propKey": "@kind",\n        "propValue": "Space"\n      }\n    ]\n  ]\n}\n',
		description: 'Raw request body with rules array (OR of AND groups). Used when "Advanced — Use Raw JSON Rules" is on.',
	},
	{
		displayName: 'Search ID',
		name: 'searchId',
		type: 'string',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
			},
		},
		default: '',
		required: true,
		description: 'The search ID returned by Create',
	},
	{
		displayName: 'Field Names',
		name: 'ifcFieldNames',
		type: 'string',
		typeOptions: {
			multipleValues: true,
			multipleValueButtonText: 'Add Field',
		},
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
			},
		},
		default: ['GUID', 'Name', 'IFC Type'],
		description:
			'Field names included in the export. Joined with "|" at runtime and base64-encoded.',
	},
	{
		displayName: 'Field Union',
		name: 'ifcFieldUnion',
		type: 'boolean',
		default: true,
		description: 'Whether to return the union of fields across rows (StreamBIM fieldUnion flag)',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
				ifcExportUseRawJson: [false],
			},
		},
	},
	{
		displayName: 'Job Fields',
		name: 'ifcJobFields',
		type: 'boolean',
		default: false,
		description: 'Whether to include job-specific fields in the export (StreamBIM jobFields flag)',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
				ifcExportUseRawJson: [false],
			},
		},
	},
	{
		displayName: 'Field Limit',
		name: 'ifcFieldLimit',
		type: 'number',
		default: 0,
		typeOptions: { minValue: 0 },
		description: 'Maximum number of fields to return (0 = no limit)',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
				ifcExportUseRawJson: [false],
			},
		},
	},
	{
		displayName: 'Sort Descending',
		name: 'ifcSortDescending',
		type: 'boolean',
		default: false,
		description: 'Whether to sort results in descending order (StreamBIM sortDescending flag)',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
				ifcExportUseRawJson: [false],
			},
		},
	},
	...ifcExportPaginationFields(),
	{
		displayName: 'Advanced — Use Raw JSON Query',
		name: 'ifcExportUseRawJson',
		type: 'boolean',
		default: false,
		description: 'Whether to provide additional query parameters as a raw JSON object',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
			},
		},
	},
	{
		displayName: 'Additional Query Parameters (Raw JSON)',
		name: 'ifcExportQueryParameters',
		type: 'json',
		displayOptions: {
			show: {
				resource: ['ifcSearch'],
				operation: ['exportJson'],
				ifcExportUseRawJson: [true],
			},
		},
		default:
			'{\n  "fieldUnion": true,\n  "jobFields": false,\n  "fieldLimit": 0,\n  "sortDescending": false\n}\n',
		description:
			'Raw query parameters merged into the request. page[limit] and page[skip] here are ignored — use Return All / Limit instead.',
	},
];

function buildIfcRulesBody(rules: IfcRuleRow[]): IDataObject {
	const andGroup = rules
		.filter((row) => row && row.buildingId)
		.map((row) => ({
			buildingId: String(row.buildingId),
			propKey: row.propKey ?? '',
			propValue: row.propValue ?? '',
		}));
	return { rules: [andGroup] };
}

export async function runIfcSearch(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	const projectId = getProjectIdString(ctx, i);
	if (operation === 'create') {
		const useRaw = ctx.getNodeParameter('ifcRulesUseRawJson', i, false) as boolean;
		let body: IDataObject;
		if (useRaw) {
			const rulesJson = ctx.getNodeParameter('rulesJson', i, '') as string;
			body = parseJsonBody(ctx, rulesJson, i, 'Search rules');
		} else {
			const collection = ctx.getNodeParameter('ifcSearchRules', i, {}) as {
				rule?: IfcRuleRow[];
			};
			const rows = Array.isArray(collection.rule) ? collection.rule : [];
			if (rows.length === 0) {
				throw new NodeOperationError(
					ctx.getNode(),
					'At least one Search Rule is required (or enable "Use Raw JSON Rules")',
					{ itemIndex: i },
				);
			}
			body = buildIfcRulesBody(rows);
		}
		return streamBimPlainJsonRequest.call(
			ctx,
			'POST',
			`/project-${projectId}/api/v1/ifc-searches`,
			tokenCache,
			body,
			{},
		);
	}
	if (operation === 'exportJson') {
		const searchId = ctx.getNodeParameter('searchId', i) as string;
		const fieldNames = ctx.getNodeParameter('ifcFieldNames', i, []) as string[];
		const joined = (Array.isArray(fieldNames) ? fieldNames : [])
			.map((s) => String(s ?? '').trim())
			.filter((s) => s.length > 0)
			.join('|');
		const useRaw = ctx.getNodeParameter('ifcExportUseRawJson', i, false) as boolean;
		let qs: IDataObject = {};
		if (useRaw) {
			const raw = ctx.getNodeParameter('ifcExportQueryParameters', i, '') as string;
			if (raw && raw.trim()) qs = parseJsonBody(ctx, raw, i, 'Additional query parameters');
		} else {
			qs = {
				fieldUnion: ctx.getNodeParameter('ifcFieldUnion', i, true) as boolean,
				jobFields: ctx.getNodeParameter('ifcJobFields', i, false) as boolean,
				fieldLimit: ctx.getNodeParameter('ifcFieldLimit', i, 0) as number,
				sortDescending: ctx.getNodeParameter('ifcSortDescending', i, false) as boolean,
			};
		}
		qs.searchId = searchId;
		qs.fieldNames = b64EncodeUnicodeFieldNames(joined);
		const pagination = getV8ListPagination(ctx, i, {
			defaultLimit: PLAIN_JSON_EXPORT_DEFAULT_PAGE_LIMIT,
			maxPageLimit: PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT,
			limitParamNames: ['limit', 'pageLimit', 'ifcPageLimit'],
			skipParamNames: ['pageSkip', 'ifcPageSkip'],
		});
		const response = await streamBimPlainJsonGetMany.call(
			ctx,
			`/project-${projectId}/api/v1/ifc-searches/export/json`,
			tokenCache,
			qs,
			pagination,
			{ maxPageLimit: PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT },
		);
		return response;
	}
	throw new NodeOperationError(ctx.getNode(), `Unknown IFC search operation: ${operation}`);
}
