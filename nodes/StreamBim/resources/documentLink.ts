import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	b64EncodeUnicodeFieldNames,
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimPlainJsonGetMany,
	streamBimPlainJsonRequest,
	type StreamBimListPagination,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import {
	documentLinkBody,
	exportFieldName,
	groupPropertyValues,
	indexDocumentsByStem,
	matchDocument,
	parseExtensions,
	parsePropertyRef,
	planPropertyLink,
	toExistingLink,
	toLinkDocument,
	type ExistingLink,
	type ExportRow,
	type PropertyLinkPlan,
} from '../../shared/streamBimPropertyLinks';
import { getProjectIdString } from './_runHelpers';

const RESOURCE = 'documentLink';
const SHOW_SYNC = { resource: [RESOURCE], operation: ['syncByProperty'] };

const ALL_PAGES: StreamBimListPagination = {
	mode: 'all',
	pageLimit: 500,
	pageSkip: 0,
	maxPages: 200,
};

const EXPORT_ALL_PAGES: StreamBimListPagination = {
	mode: 'all',
	pageLimit: 10000,
	pageSkip: 0,
	maxPages: 100,
};

/** Parallel GETs for the per-value attachment lookups. */
const LOOKUP_CONCURRENCY = 4;

export const documentLinkOperations: INodePropertyOptions[] = [
	{
		name: 'Sync by Property',
		value: 'syncByProperty',
		description:
			'Link each property value to the document whose filename (without extension) equals it, and remove links to deleted documents',
		action: 'Sync document links by property',
	},
];

export const documentLinkProperties: INodeProperties[] = [
	{
		displayName: 'Property',
		name: 'linkProperty',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Text.Sheet Number',
		description:
			'Property set and property name, separated by a dot. Every element that has this property is linked to the document whose filename (without extension) equals the value. The link is set on the value, so it shows on all elements that share it.',
		displayOptions: { show: SHOW_SYNC },
	},
	{
		displayName: 'File Extensions',
		name: 'linkFileExtensions',
		type: 'string',
		default: 'pdf',
		placeholder: 'pdf',
		description: 'Comma-separated document types that may be linked. Empty means any type.',
		displayOptions: { show: SHOW_SYNC },
	},
	{
		displayName: 'Remove Links to Deleted Documents',
		name: 'linkRemoveDeleted',
		type: 'boolean',
		default: true,
		description:
			'Whether to remove links on these values whose document was deleted, or moved at the source (StreamBIM then makes a new document and soft-deletes the old one). The new document is linked in the same run.',
		displayOptions: { show: SHOW_SYNC },
	},
	{
		displayName: 'Dry Run',
		name: 'linkDryRun',
		type: 'boolean',
		default: true,
		description: 'Whether to only report what would be linked and removed',
		displayOptions: { show: SHOW_SYNC },
	},
	{
		displayName: 'Options',
		name: 'linkOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: SHOW_SYNC },
		options: [
			{
				displayName: 'Building IDs',
				name: 'buildingIds',
				type: 'string',
				default: '',
				placeholder: '1000,1002',
				description:
					'Comma-separated building IDs to search for elements. Empty means every building.',
			},
			{
				displayName: 'Link Again After Manual Removal',
				name: 'relinkRemoved',
				type: 'boolean',
				default: false,
				description:
					'Whether to link a document again when someone removed its link by hand. Off: a removed link stays removed.',
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				options: [
					{
						name: 'One Item per Value',
						value: 'perValue',
						description: 'Every property value with its document and what was done',
					},
					{
						name: 'Changes Only',
						value: 'changes',
						description: 'Values where a link was added or removed, plus ambiguous values and errors',
					},
					{
						name: 'Summary',
						value: 'summary',
						description: 'A single item with counts and the list of changes',
					},
				],
				default: 'perValue',
			},
			{
				displayName: 'Value Type',
				name: 'valueType',
				type: 'string',
				default: 'str',
				description:
					'Type segment of the property value in StreamBIM ("str" for text). Change only for non-text properties.',
			},
		],
	},
];

async function getAll(
	ctx: IExecuteFunctions,
	path: string,
	tokenCache: StreamBimTokenCache,
	qs: IDataObject = {},
): Promise<IDataObject[]> {
	const res = (await streamBimJsonApiGetMany.call(ctx, path, tokenCache, qs, ALL_PAGES)) as IDataObject;
	return Array.isArray(res.data) ? (res.data as IDataObject[]) : [];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const at = next++;
			out[at] = await fn(items[at]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function errorMessage(error: unknown): string {
	const e = error as { description?: string; message?: string };
	return String(e?.description || e?.message || error);
}

/** Every element in the chosen buildings where the property exists, with its value. */
async function exportPropertyRows(
	ctx: IExecuteFunctions,
	v1: string,
	tokenCache: StreamBimTokenCache,
	buildingIds: string[],
	psetName: string,
	propertyName: string,
	field: string,
): Promise<ExportRow[]> {
	const rows: ExportRow[] = [];
	for (const buildingId of buildingIds) {
		// startsWith "" matches every element that has the property at all.
		const search = (await streamBimPlainJsonRequest.call(
			ctx,
			'POST',
			`${v1}/ifc-searches`,
			tokenCache,
			{
				rules: [[{ buildingId, psetName, propKey: propertyName, operator: 'startsWith', propValue: '' }]],
			},
			{},
		)) as IDataObject;
		const searchId = String(search?.searchId ?? '');
		if (!searchId) {
			throw new NodeOperationError(ctx.getNode(), `IFC search returned no searchId for building ${buildingId}`);
		}
		const exported = await streamBimPlainJsonGetMany.call(
			ctx,
			`${v1}/ifc-searches/export/json`,
			tokenCache,
			{
				searchId,
				fieldNames: b64EncodeUnicodeFieldNames(`GUID|${field}`),
				fieldUnion: true,
				jobFields: false,
				fieldLimit: 0,
			},
			EXPORT_ALL_PAGES,
		);
		for (const r of (exported.data as IDataObject[]) ?? []) {
			rows.push({
				buildingId,
				guid: r.GUID ? String(r.GUID) : undefined,
				value: r[field],
			});
		}
	}
	return rows;
}

type StaleReason = 'document_deleted' | 'document_missing';

/** A link is only removed after a GET confirms its document is gone (404) or soft-deleted. */
async function staleReason(
	ctx: IExecuteFunctions,
	v2: string,
	tokenCache: StreamBimTokenCache,
	documentId: string,
): Promise<StaleReason | undefined> {
	try {
		const res = (await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`${v2}/documents/${encodeURIComponent(documentId)}`,
			tokenCache,
			undefined,
			{},
		)) as IDataObject;
		const doc = toLinkDocument((res?.data ?? {}) as IDataObject);
		return doc.isDeleted ? 'document_deleted' : undefined;
	} catch (error) {
		if (String((error as { httpCode?: string }).httpCode ?? '') === '404') return 'document_missing';
		throw error;
	}
}

type UnlinkResult = {
	attachmentId: string;
	documentId: string;
	filename: string;
	reason: StaleReason;
	result: 'planned' | 'removed' | 'error';
	error?: string;
};

type ValueResult = {
	value: string;
	status: PropertyLinkPlan['status'];
	document: IDataObject | null;
	link: 'planned' | 'created' | 'exists' | 'removed_by_user' | 'none' | 'error';
	attachmentId?: string;
	unlinked: UnlinkResult[];
	changed: boolean;
	elementCount: number;
	buildingIds: string[];
	objectId: string;
	sampleGuids: string[];
	candidates?: IDataObject[];
	errors?: string[];
	dryRun: boolean;
};

function docSummary(d: PropertyLinkPlan['document']): IDataObject | null {
	return d ? { id: d.id, filename: d.filename, path: d.path, revision: d.revision } : null;
}

export async function runDocumentLink(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	tokenCache: StreamBimTokenCache,
): Promise<IDataObject | IDataObject[]> {
	if (operation !== 'syncByProperty') {
		throw new NodeOperationError(ctx.getNode(), `Unknown document link operation: ${operation}`, {
			itemIndex: i,
		});
	}
	const projectId = getProjectIdString(ctx, i);
	const v1 = `/project-${projectId}/api/v1`;
	const v2 = `${v1}/v2`;

	const rawProperty = ctx.getNodeParameter('linkProperty', i, '') as string;
	const ref = parsePropertyRef(rawProperty);
	if (!ref) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Property "${rawProperty}" must be "Property Set.Property", e.g. "Text.Sheet Number"`,
			{ itemIndex: i },
		);
	}
	const extensions = parseExtensions(ctx.getNodeParameter('linkFileExtensions', i, 'pdf') as string);
	const removeDeleted = ctx.getNodeParameter('linkRemoveDeleted', i, true) as boolean;
	const dryRun = ctx.getNodeParameter('linkDryRun', i, true) as boolean;
	const options = ctx.getNodeParameter('linkOptions', i, {}) as IDataObject;
	const buildingFilter = String(options.buildingIds ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const valueType = String(options.valueType || 'str');
	const relinkRemoved = options.relinkRemoved === true;
	const output = String(options.output || 'perValue');
	const field = exportFieldName(ref);

	// 1. Values: every element where the property exists, grouped by value.
	const buildingIds = (await getAll(ctx, `${v2}/buildings`, tokenCache))
		.map((b) => String(b.id))
		.filter((id) => buildingFilter.length === 0 || buildingFilter.includes(id));
	const rows = await exportPropertyRows(
		ctx,
		v1,
		tokenCache,
		buildingIds,
		ref.psetName,
		ref.propertyName,
		field,
	);
	const groups = groupPropertyValues(rows, ref, valueType);

	// 2. Live documents, indexed by filename stem.
	const docs = (await getAll(ctx, `${v2}/documents`, tokenCache, { 'filter[isDeleted]': 'false' }))
		.map(toLinkDocument)
		.filter((d) => d.id && !d.isDeleted);
	const liveIds = new Set(docs.map((d) => d.id));
	const index = indexDocumentsByStem(docs, extensions);

	// 3. Existing links per value (incl. removed ones), then the plan.
	const plans = await mapLimit(groups, LOOKUP_CONCURRENCY, async (g) => {
		const res = (await streamBimJsonApiRequest.call(ctx, 'GET', `${v2}/attachments`, tokenCache, undefined, {
			'filter[object]': g.objectId,
			'filter[building]': g.buildingIds[0],
			withDeletedAttachments: 'true',
		})) as IDataObject;
		const links = ((Array.isArray(res?.data) ? res.data : []) as IDataObject[])
			.map(toExistingLink)
			.filter((l): l is ExistingLink => l !== undefined);
		return planPropertyLink(g, matchDocument(g.value, index), links, liveIds, {
			relinkRemoved,
			removeDeleted,
		});
	});

	// 4. Confirm stale links one by one, then apply (link first, then remove).
	const results: ValueResult[] = [];
	for (const plan of plans) {
		const errors: string[] = [];
		const unlinked: UnlinkResult[] = [];
		for (const l of plan.stale) {
			try {
				const reason = await staleReason(ctx, v2, tokenCache, l.documentId);
				if (reason) {
					unlinked.push({
						attachmentId: l.attachmentId,
						documentId: l.documentId,
						filename: l.filename,
						reason,
						result: 'planned',
					});
				}
			} catch (error) {
				errors.push(`check document ${l.documentId}: ${errorMessage(error)}`);
			}
		}

		let link: ValueResult['link'] = plan.link === 'create' ? 'planned' : plan.link;
		let attachmentId: string | undefined;
		if (!dryRun && plan.link === 'create' && plan.document) {
			try {
				const res = (await streamBimJsonApiRequest.call(
					ctx,
					'POST',
					`${v2}/attachments`,
					tokenCache,
					documentLinkBody(plan.objectId, plan.document.id),
					{},
				)) as IDataObject;
				attachmentId = String(((res?.data ?? {}) as IDataObject).id ?? '') || undefined;
				link = 'created';
			} catch (error) {
				link = 'error';
				errors.push(`link document ${plan.document.id}: ${errorMessage(error)}`);
			}
		}
		if (!dryRun) {
			for (const u of unlinked) {
				try {
					await streamBimJsonApiRequest.call(
						ctx,
						'DELETE',
						`${v2}/attachments/${encodeURIComponent(u.attachmentId)}`,
						tokenCache,
						undefined,
						{},
					);
					u.result = 'removed';
				} catch (error) {
					u.result = 'error';
					u.error = errorMessage(error);
					errors.push(`remove link ${u.attachmentId}: ${u.error}`);
				}
			}
		}

		results.push({
			value: plan.value,
			status: plan.status,
			document: docSummary(plan.document),
			link,
			...(attachmentId ? { attachmentId } : {}),
			unlinked,
			changed: link === 'planned' || link === 'created' || unlinked.length > 0,
			elementCount: plan.elementCount,
			buildingIds: plan.buildingIds,
			objectId: plan.objectId,
			sampleGuids: plan.sampleGuids,
			...(plan.candidates ? { candidates: plan.candidates.map((c) => docSummary(c)!) } : {}),
			...(errors.length ? { errors } : {}),
			dryRun,
		});
	}

	if (output === 'perValue') return results as unknown as IDataObject[];
	const notable = results.filter((r) => r.changed || r.status === 'ambiguous' || r.errors);
	if (output === 'changes') return notable as unknown as IDataObject[];

	const count = (pred: (r: ValueResult) => boolean) => results.filter(pred).length;
	return {
		projectId,
		property: `${ref.psetName}.${ref.propertyName}`,
		dryRun,
		elements: rows.length,
		values: results.length,
		matched: count((r) => r.status === 'matched'),
		noDocument: count((r) => r.status === 'no_document'),
		ambiguous: count((r) => r.status === 'ambiguous'),
		linked: count((r) => r.link === (dryRun ? 'planned' : 'created')),
		alreadyLinked: count((r) => r.link === 'exists'),
		removedByUserSkipped: count((r) => r.link === 'removed_by_user'),
		unlinked: results.reduce(
			(n, r) => n + r.unlinked.filter((u) => u.result === (dryRun ? 'planned' : 'removed')).length,
			0,
		),
		errors: count((r) => Boolean(r.errors)),
		changes: notable as unknown as IDataObject[],
	};
}
