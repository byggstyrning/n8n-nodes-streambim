import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import type { NodeConnectionType } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { type StreamBimTokenCache } from '../shared/GenericFunctions';
import { loadStreamBimBuildingOptions } from '../shared/streamBimBuildings';
import { loadStreamBimChecklistOptions } from '../shared/streamBimChecklists';
import { loadStreamBimDocumentLabelOptions } from '../shared/streamBimDocumentLabels';
import {
	loadStreamBimDocumentHintOptions,
	searchStreamBimDocumentHints,
} from '../shared/streamBimDocumentsHint';
import { loadStreamBimFloorplanLayerOptions } from '../shared/streamBimFloorplanLayers';
import { loadStreamBimIfcFileOptions } from '../shared/streamBimIfcFiles';
import { loadStreamBimFolderOptions } from '../shared/streamBimFolders';
import { loadStreamBimGroupOptions } from '../shared/streamBimGroups';
import { loadStreamBimProjectOptions } from '../shared/streamBimProjects';
import { loadStreamBimProjectMemberOptions } from '../shared/streamBimProjectMembers';
import { loadStreamBimProjectUserOptions } from '../shared/streamBimProjectUsers';
import { loadStreamBimSyncConfigOptions } from '../shared/streamBimSyncConfigs';
import { loadStreamBimTopicPriorityOptions } from '../shared/streamBimTopicPriorities';
import { loadStreamBimTopicStatusOptions } from '../shared/streamBimTopicStatuses';
import {
	loadStreamBimTopicsByPublicId,
	searchStreamBimTopicsByPublicId,
} from '../shared/streamBimTopics';
import { loadStreamBimWorkflowOptions } from '../shared/streamBimWorkflows';
import { projectIdFields } from './helpers/projectIdField';

import {
	buildingOperations,
	buildingProperties,
	runBuilding,
} from './resources/building';
import {
	documentAlignmentOperations,
	documentAlignmentProperties,
	runDocumentAlignment,
} from './resources/documentAlignment';
import { floorOperations, floorProperties, runFloor } from './resources/floor';
import {
	relinkOperations,
	relinkProperties,
	runRelink,
	runRelinkApplyAll,
	runRelinkPlan,
} from './resources/relink';
import {
	attachmentOperations,
	attachmentProperties,
	runAttachment,
} from './resources/attachment';
import {
	checklistOperations,
	checklistProperties,
	runChecklist,
} from './resources/checklist';
import {
	converterJobOperations,
	converterJobProperties,
	runConverterJob,
} from './resources/converterJob';
import {
	documentOperations,
	documentProperties,
	runDocument,
} from './resources/document';
import {
	documentLinkOperations,
	documentLinkProperties,
	runDocumentLink,
} from './resources/documentLink';
import {
	documentLabelOperations,
	documentLabelProperties,
	runDocumentLabel,
} from './resources/documentLabel';
import {
	documentRevisionOperations,
	documentRevisionProperties,
	runDocumentRevision,
} from './resources/documentRevision';
import {
	folderOperations,
	folderProperties,
	runFolder,
} from './resources/folder';
import {
	ifcFileOperations,
	ifcFileProperties,
	runIfcFile,
} from './resources/ifcFile';
import {
	ifcSearchOperations,
	ifcSearchProperties,
	runIfcSearch,
} from './resources/ifcSearch';
import {
	projectOperations,
	projectProperties,
	runProject,
} from './resources/project';
import {
	runSync,
	syncOperations,
	syncProperties,
} from './resources/sync';
import {
	runTopic,
	topicOperations,
	topicProperties,
} from './resources/topic';
import {
	runUser,
	userOperations,
	userProperties,
} from './resources/user';
import {
	runWorkflow,
	workflowOperations,
	workflowProperties,
} from './resources/workflow';

function operationFieldForResource(
	resource: string,
	options: INodePropertyOptions[],
	defaultOperation: string,
): INodeProperties {
	return {
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: [resource],
			},
		},
		options,
		default: defaultOperation,
		description: 'Action for the selected resource',
	};
}

const resourceField: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{
			name: 'Building',
			value: 'building',
			description: 'Buildings with model layers, floor plan layer and floors',
			action: 'Use buildings',
		},
		{
			name: 'Checklist',
			value: 'checklist',
			description: 'Project checklists export and list',
			action: 'Use checklists',
		},
		{
			name: 'Converter Job',
			value: 'converterJob',
			description: 'IFC converter jobs and status',
			action: 'Use converter jobs',
		},
		{
			name: 'Document',
			value: 'document',
			description: 'Documents only (PDFs, drawings, IFC files). Revisions, labels and folders are separate resources.',
			action: 'Use documents',
		},
		{
			name: 'Document Alignment',
			value: 'documentAlignment',
			description: 'Plan placements: a document (PDF/DWG) positioned in a building, with a display name',
			action: 'Use document alignments',
		},
		{
			name: 'Document Label',
			value: 'documentLabel',
			description: 'Document labels: CRUD label tags applied to documents and folders',
			action: 'Use document labels',
		},
		{
			name: 'Document Link',
			value: 'documentLink',
			description: 'Link documents to elements by property value, e.g. drawings by sheet number',
			action: 'Use document links',
		},
		{
			name: 'Floor',
			value: 'floor',
			description: 'Floors and their custom floor plan document',
			action: 'Use floors',
		},
		{
			name: 'Folder',
			value: 'folder',
			description: 'Document folders (folder tree under a project)',
			action: 'Use folders',
		},
		{
			name: 'IFC File',
			value: 'ifcFile',
			description: 'IFC model file assignments (link documents to building layers)',
			action: 'Use IFC files',
		},
		{
			name: 'IFC Search',
			value: 'ifcSearch',
			description: 'Create IFC searches and export JSON',
			action: 'Use IFC search',
		},
		{
			name: 'Project',
			value: 'project',
			description: 'List or get projects (gateway JSON:API)',
			action: 'Use projects',
		},
		{
			name: 'Relink',
			value: 'relink',
			description: 'Move layer, placement and floor plan mappings from deleted documents to their successors after a source move',
			action: 'Use relink',
		},
		{
			name: 'Sync',
			value: 'sync',
			description: 'Sync trigger, activity, configs, statuses',
			action: 'Use sync',
		},
		{
			name: 'Topic',
			value: 'topic',
			description: 'Topics (issues) CRUD',
			action: 'Use topics',
		},
		{
			name: 'User',
			value: 'user',
			description: 'Users, invites, groups, email settings, project members (global and project-scoped)',
			action: 'Use users',
		},
		{
			name: 'Workflow',
			value: 'workflow',
			description: 'Project workflows CRUD',
			action: 'Use workflows',
		},
	],
	default: 'project',
};

const operationFields: INodeProperties[] = [
	operationFieldForResource('project', projectOperations, 'getMany'),
	operationFieldForResource('ifcFile', ifcFileOperations, 'getMany'),
	operationFieldForResource('ifcSearch', ifcSearchOperations, 'create'),
	operationFieldForResource('converterJob', converterJobOperations, 'getMany'),
	operationFieldForResource('sync', syncOperations, 'triggerSync'),
	operationFieldForResource('user', userOperations, 'inviteUser'),
	operationFieldForResource('workflow', workflowOperations, 'getMany'),
	operationFieldForResource('topic', topicOperations, 'getMany'),
	operationFieldForResource('checklist', checklistOperations, 'getMany'),
	operationFieldForResource('attachment', attachmentOperations, 'getMany'),
	operationFieldForResource('document', documentOperations, 'getMany'),
	operationFieldForResource('folder', folderOperations, 'getMany'),
	operationFieldForResource('documentLabel', documentLabelOperations, 'getMany'),
	operationFieldForResource('documentLink', documentLinkOperations, 'syncByProperty'),
	operationFieldForResource('documentRevision', documentRevisionOperations, 'getMany'),
	operationFieldForResource('building', buildingOperations, 'getMany'),
	operationFieldForResource('floor', floorOperations, 'getMany'),
	operationFieldForResource('documentAlignment', documentAlignmentOperations, 'getMany'),
	operationFieldForResource('relink', relinkOperations, 'plan'),
];

// Phase 1: Project field set is generated by `helpers/projectIdField.ts`. One
// INodeProperties variant per resource group, each with its own show/hide
// rules so e.g. project.getMany and converterJob.getStatus correctly hide the
// field while project.get and converterJob.getMany still show it.
const projectIdFieldVariants: INodeProperties[] = projectIdFields();

// v8 migration: resources that have moved to the helper-built `returnAll +
// limit` pair opt out of the legacy pagination block via `hide.resource` so
// the user doesn't see two pagination UIs at once. Append a resource name to
// this list as new R-branches migrate; once every resource is migrated the
// legacy `paginationFields` block below can be removed entirely.
const V8_PAGINATED_RESOURCES = [
	'project',
	'converterJob',
	'sync',
	'ifcFile',
	'document',
	'folder',
	'documentLabel',
	'documentRevision',
	'checklist',
	'attachment',
	'topic',
	'building',
	'floor',
	'documentAlignment',
	'relink',
];
const paginationFields: INodeProperties[] = [
	{
		displayName: 'List Pagination',
		name: 'listPaginationMode',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Single Page', value: 'single' },
			{ name: 'All Pages', value: 'all' },
		],
		default: 'single',
		description:
			'Single page: one request using Page Size and Skip. All pages: repeat requests until a page returns fewer rows than the page size (capped by Max Pages). Filters in Query Parameters stay; page[limit] and page[skip] there are overridden by these fields.',
		displayOptions: {
			show: {
				operation: [
					'getMany',
					'getManyUsers',
					'getManyProjectUsers',
					'getManyProjectMembers',
					'getManyGroups',
					'getManyRevisions',
					'getManyLabels',
					'getManyFolders',
				],
			},
			hide: { resource: V8_PAGINATED_RESOURCES },
		},
	},
	{
		displayName: 'Page Size',
		name: 'pageLimit',
		type: 'number',
		default: 100,
		typeOptions: {
			minValue: 1,
			maxValue: 1000,
		},
		description: 'Rows per request (page[limit])',
		displayOptions: {
			show: {
				operation: [
					'getMany',
					'getManyUsers',
					'getManyProjectUsers',
					'getManyProjectMembers',
					'getManyGroups',
					'getManyRevisions',
					'getManyLabels',
					'getManyFolders',
				],
			},
			hide: { resource: V8_PAGINATED_RESOURCES },
		},
	},
	{
		displayName: 'Skip',
		name: 'pageSkip',
		type: 'number',
		default: 0,
		typeOptions: {
			minValue: 0,
		},
		description: 'Offset for Single Page (page[skip])',
		displayOptions: {
			show: {
				operation: [
					'getMany',
					'getManyUsers',
					'getManyProjectUsers',
					'getManyProjectMembers',
					'getManyGroups',
				],
				listPaginationMode: ['single'],
			},
			hide: { resource: V8_PAGINATED_RESOURCES },
		},
	},
	{
		displayName: 'Max Pages',
		name: 'maxPages',
		type: 'number',
		default: 500,
		typeOptions: {
			minValue: 1,
			maxValue: 5000,
		},
		description: 'Maximum loop iterations for All Pages (safety cap)',
		displayOptions: {
			show: {
				operation: [
					'getMany',
					'getManyUsers',
					'getManyProjectUsers',
					'getManyProjectMembers',
					'getManyGroups',
				],
				listPaginationMode: ['all'],
			},
			hide: { resource: V8_PAGINATED_RESOURCES },
		},
	},
];

const allResourceProperties: INodeProperties[] = [
	...projectProperties,
	...ifcFileProperties,
	...ifcSearchProperties,
	...converterJobProperties,
	...syncProperties,
	...userProperties,
	...workflowProperties,
	...topicProperties,
	...checklistProperties,
	...attachmentProperties,
	...documentProperties,
	...folderProperties,
	...documentLabelProperties,
	...documentLinkProperties,
	...documentRevisionProperties,
	...buildingProperties,
	...floorProperties,
	...documentAlignmentProperties,
	...relinkProperties,
];

/**
 * Unwrap a JSON:API envelope so each row becomes its own n8n item.
 *
 * - `{ data: [a, b, c], meta?, included? }` → `[a, b, c]` (one item per row).
 * - `{ data: { id, type, attributes, ... } }`  → the single record as one item.
 * - Anything else (download links, plain JSON exports, etc.) is returned
 *   untouched so non-JSON:API responses still pass through.
 */
function unwrapJsonApiEnvelope(response: unknown): IDataObject | IDataObject[] {
	if (response && typeof response === 'object' && !Array.isArray(response)) {
		const envelope = response as IDataObject;
		if ('data' in envelope) {
			const data = envelope.data;
			if (Array.isArray(data)) {
				return data as IDataObject[];
			}
			if (
				data &&
				typeof data === 'object' &&
				('id' in (data as IDataObject) || 'type' in (data as IDataObject))
			) {
				return data as IDataObject;
			}
		}
	}
	return response as IDataObject | IDataObject[];
}

export class StreamBim implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'StreamBIM',
		name: 'streamBim',
		icon: 'file:streambim.svg',
		group: ['transform'],
		version: 8,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'StreamBIM API: projects, buildings, floors, IFC files, document alignments, relink, IFC search, converter jobs, sync, users, workflows, topics, checklists, attachments, documents, document links',
		usableAsTool: true,
		defaults: {
			name: 'StreamBIM',
		},
		inputs: ['main'] as NodeConnectionType[],
		outputs: ['main'] as NodeConnectionType[],
		credentials: [
			{
				name: 'streamBimApi',
				required: true,
			},
		],
		properties: [
			resourceField,
			...operationFields,
			...projectIdFieldVariants,
			...paginationFields,
			...allResourceProperties,
		],
	};

	methods = {
		loadOptions: {
			async getBuildings(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimBuildingOptions.call(this);
			},
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimProjectOptions.call(this);
			},
			async getChecklists(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimChecklistOptions.call(this);
			},
			async getSyncConfigs(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimSyncConfigOptions.call(this);
			},
			async getFloorplanLayers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimFloorplanLayerOptions.call(this);
			},
			async getIfcFiles(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimIfcFileOptions.call(this);
			},
			async getFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimFolderOptions.call(this);
			},
			async getDocumentLabels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimDocumentLabelOptions.call(this);
			},
			async getDocumentsHint(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimDocumentHintOptions.call(this);
			},
			async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimGroupOptions.call(this);
			},
			async getProjectMembers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimProjectMemberOptions.call(this);
			},
			async getProjectUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimProjectUserOptions.call(this);
			},
			async getTopicPriorities(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimTopicPriorityOptions.call(this);
			},
			async getTopicStatuses(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimTopicStatusOptions.call(this);
			},
			async getTopicsByPublicId(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimTopicsByPublicId.call(this);
			},
			async getWorkflows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadStreamBimWorkflowOptions.call(this);
			},
		},
		listSearch: {
			async searchDocumentsHint(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				return await searchStreamBimDocumentHints.call(this, filter);
			},
			async getTopicsByPublicId(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				return await searchStreamBimTopicsByPublicId.call(this, filter);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const tokenCache: StreamBimTokenCache = {};

		// Relink runs once over all items: Plan reads them as one source inventory, Apply
		// starts one conversion per building after the whole plan is applied.
		const relinkOp =
			items.length > 0 && this.getNodeParameter('resource', 0) === 'relink'
				? (this.getNodeParameter('operation', 0) as string)
				: '';
		if (relinkOp === 'plan' || relinkOp === 'apply') {
			const credentials = await this.getCredentials('streamBimApi');
			tokenCache.regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
			try {
				return [
					relinkOp === 'plan'
						? await runRelinkPlan(this, items, tokenCache)
						: await runRelinkApplyAll(this, items, tokenCache),
				];
			} catch (error) {
				if (this.continueOnFail()) {
					return [[{ json: { error: (error as Error).message }, pairedItem: { item: 0 } }]];
				}
				throw error;
			}
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = await this.getCredentials('streamBimApi');
				const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
				if (
					tokenCache.regionSubdomain !== undefined &&
					tokenCache.regionSubdomain !== regionSubdomain
				) {
					tokenCache.token = undefined;
				}
				tokenCache.regionSubdomain = regionSubdomain;

				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let responseData: unknown;

				if (resource === 'project') {
					responseData = await runProject(this, operation, i, tokenCache);
				} else if (resource === 'ifcFile') {
					responseData = await runIfcFile(this, operation, i, tokenCache);
				} else if (resource === 'ifcSearch') {
					responseData = await runIfcSearch(this, operation, i, tokenCache);
				} else if (resource === 'converterJob') {
					responseData = await runConverterJob(this, operation, i, tokenCache);
				} else if (resource === 'sync') {
					responseData = await runSync(this, operation, i, tokenCache);
				} else if (resource === 'user') {
					responseData = await runUser(this, operation, i, tokenCache);
				} else if (resource === 'workflow') {
					responseData = await runWorkflow(this, operation, i, tokenCache);
				} else if (resource === 'topic') {
					responseData = await runTopic(this, operation, i, tokenCache);
				} else if (resource === 'checklist') {
					responseData = await runChecklist(this, operation, i, tokenCache);
				} else if (resource === 'attachment') {
					responseData = await runAttachment(this, operation, i, items, tokenCache);
				} else if (resource === 'document') {
					responseData = await runDocument(this, operation, i, tokenCache, items);
				} else if (resource === 'folder') {
					responseData = await runFolder(this, operation, i, tokenCache);
				} else if (resource === 'documentLink') {
					responseData = await runDocumentLink(this, operation, i, tokenCache);
				} else if (resource === 'documentLabel') {
					responseData = await runDocumentLabel(this, operation, i, tokenCache);
				} else if (resource === 'documentRevision') {
					responseData = await runDocumentRevision(this, operation, i, tokenCache);
				} else if (resource === 'building') {
					responseData = await runBuilding(this, operation, i, tokenCache);
				} else if (resource === 'floor') {
					responseData = await runFloor(this, operation, i, tokenCache);
				} else if (resource === 'documentAlignment') {
					responseData = await runDocumentAlignment(this, operation, i, tokenCache);
				} else if (resource === 'relink') {
					responseData = await runRelink(this, operation, i, items, tokenCache);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, { itemIndex: i });
				}

				let unwrapped = unwrapJsonApiEnvelope(responseData);

				// If Return All is false and we have a Limit, enforce the limit on any array results
				try {
					const returnAll = this.getNodeParameter('returnAll', i, true) as boolean;
					if (!returnAll) {
						const limit = this.getNodeParameter('limit', i, 50) as number;
						if (Number.isFinite(limit) && limit > 0 && Array.isArray(unwrapped)) {
							unwrapped = unwrapped.slice(0, limit);
						}
					}
				} catch {
					// Some operations do not have returnAll/limit parameters
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(unwrapped),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
