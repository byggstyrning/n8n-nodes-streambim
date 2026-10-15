import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
	streamBimGetSyncStartedRequest,
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimSyncTriggerRequest,
	type StreamBimListPagination,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';
import {
	buildRelinkPlan,
	DEFAULT_ARCHIVE_PATTERN,
	lastSyncEnded,
	mergeSnapshots,
	nextBaseline,
	retirableDocuments,
	shouldApply,
	toRelinkAlignment,
	toRelinkDocument,
	toRelinkFloor,
	toRelinkIfcFile,
	toRelinkSourceFile,
	type RelinkAction,
	type RelinkDocument,
	type RelinkKind,
	type RelinkLinkProfile,
	type RelinkPlanItem,
	type RelinkSourceFile,
	type RelinkSnapshot,
} from '../../shared/streamBimRelink';
import { buildJsonApiBody, relationshipRef } from '../helpers/jsonApiBody';
import { documentAlignmentCreateBody } from './documentAlignment';
import { floorUpdateBody } from './floor';
import { getProjectIdString } from './_runHelpers';

const RESOURCE = 'relink';

const ALL_PAGES: StreamBimListPagination = {
	mode: 'all',
	pageLimit: 500,
	pageSkip: 0,
	maxPages: 200,
};

export const relinkOperations: INodePropertyOptions[] = [
	{
		name: 'Plan',
		value: 'plan',
		description:
			'Sync StreamBIM, then find mappings (model layers, drawings) left on deleted documents and their successors. Changes nothing.',
		action: 'Plan relinks',
	},
	{
		name: 'Apply',
		value: 'apply',
		description: 'Execute the actions of plan items (new mapping first, then retire the old one)',
		action: 'Apply relinks',
	},
];

const kindOptions: INodePropertyOptions[] = [
	{ name: 'Model Layers (IFC, DWG)', value: 'ifcFile' },
	{ name: 'Drawings (PDF Placement and Floor Plan)', value: 'drawing' },
];

export const relinkProperties: INodeProperties[] = [
	{
		displayName: 'Sync Before Planning',
		name: 'relinkSyncFirst',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [RESOURCE], operation: ['plan'] } },
		description:
			'Whether to record the current mappings, trigger the StreamBIM sync and wait for it before planning. The record matters when the source deleted a file: the sync may then hard-delete the document together with its placement.',
	},
	{
		displayName: 'Options',
		name: 'relinkOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: [RESOURCE], operation: ['plan'] } },
		options: [
			{
				displayName: 'Archive Folder Pattern',
				name: 'archivePattern',
				type: 'string',
				default:
					'(^|/)(old|_old|gamla?|arkiv|archive|archived|superseded|utg[aå]tt|ersatt|\\d+\\.\\s*old)(/|$)',
				description:
					'Case-insensitive regular expression for folder names that mean "retired". A successor inside such a folder gets the warning archive_folder.',
			},
			{
				displayName: 'Building IDs',
				name: 'buildingIds',
				type: 'string',
				default: '',
				placeholder: '1000,1002',
				description: 'Comma-separated building IDs. Empty means every building in the project.',
			},
			{
				displayName: 'Mapping Types',
				name: 'kinds',
				type: 'multiOptions',
				options: kindOptions,
				default: ['ifcFile', 'drawing'],
			},
			{
				displayName: 'Source ID Field',
				name: 'sourceIdField',
				type: 'string',
				default: 'id',
				description:
					'Input items with an ID and a path are read as the source inventory (e.g. Interaxo Content Search, an ACC or SharePoint folder listing). Optional: moves are found by external ID anyway.',
			},
			{
				displayName: 'Source Name Field',
				name: 'sourceNameField',
				type: 'string',
				default: 'name',
			},
			{
				displayName: 'Source Path Field',
				name: 'sourcePathField',
				type: 'string',
				default: 'path',
			},
			{
				displayName: 'Sync Timeout (Minutes)',
				name: 'syncTimeout',
				type: 'number',
				default: 20,
				typeOptions: { minValue: 1, maxValue: 120 },
				description:
					'If the sync is still running after this, the plan is made on the current state and marked sync.finished = false. Apply only acts on certain links, so the rest is caught by the next run.',
			},
		],
	},
	{
		displayName: 'Dry Run',
		name: 'relinkDryRun',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [RESOURCE], operation: ['apply'] } },
		description: 'Whether to only report the calls that would be made',
	},
	{
		displayName: 'Apply',
		name: 'relinkApplyLevel',
		type: 'options',
		options: [
			{
				name: 'Certain Links Only',
				value: 'by_external_id',
				description: 'Link profile by_external_id without warnings: the source kept the file ID',
			},
			{
				name: 'Also File-Name Matches',
				value: 'by_filename',
				description:
					'Also by_filename: the source gave the file a new ID (deleted and uploaded again)',
			},
			{
				name: 'Everything',
				value: 'all',
				description:
					'Also items with warnings (tie, archive_folder, layer_conflict, uncalibrated_floor)',
			},
		],
		default: 'by_external_id',
		displayOptions: { show: { resource: [RESOURCE], operation: ['apply'] } },
		description: 'Which plan items to apply. Items with approved = true are always applied.',
	},
	{
		displayName: 'Start Conversion',
		name: 'relinkConvertAfter',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [RESOURCE], operation: ['apply'] } },
		description:
			'Whether to start a conversion for every building whose model layers were relinked (after any conversion already running there). New layers become active only after a conversion. Drawings need none.',
	},
];

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

async function getAll(
	ctx: IExecuteFunctions,
	path: string,
	tokenCache: StreamBimTokenCache,
	qs: IDataObject = {},
): Promise<IDataObject[]> {
	const res = (await streamBimJsonApiGetMany.call(
		ctx,
		path,
		tokenCache,
		qs,
		ALL_PAGES,
	)) as IDataObject;
	return Array.isArray(res.data) ? (res.data as IDataObject[]) : [];
}

/** Input items that carry an ID and a path are the source inventory; anything else is ignored. */
function sourceInventory(
	items: INodeExecutionData[],
	options: IDataObject,
): RelinkSourceFile[] | undefined {
	const fields = {
		id: String(options.sourceIdField || 'id'),
		name: String(options.sourceNameField || 'name'),
		path: String(options.sourcePathField || 'path'),
	};
	const out: RelinkSourceFile[] = [];
	for (const it of items) {
		const row = it.json ?? {};
		if (row.type !== undefined && row.type !== 'file') continue;
		if (!row[fields.path]) continue;
		const f = toRelinkSourceFile(row, fields);
		if (f) out.push(f);
	}
	return out.length ? out : undefined;
}

export async function runRelinkPlan(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	tokenCache: StreamBimTokenCache,
): Promise<INodeExecutionData[]> {
	const projectId = getProjectIdString(ctx, 0);
	if (!projectId) {
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for relink');
	}
	const v2 = `/project-${projectId}/api/v1/v2`;
	const options = ctx.getNodeParameter('relinkOptions', 0, {}) as IDataObject;
	const kinds = (
		Array.isArray(options.kinds) && options.kinds.length ? options.kinds : ['ifcFile', 'drawing']
	) as RelinkKind[];
	const buildingIds = String(options.buildingIds ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const patternRaw = String(options.archivePattern ?? '').trim();
	let archivePattern = DEFAULT_ARCHIVE_PATTERN;
	if (patternRaw) {
		try {
			archivePattern = new RegExp(patternRaw, 'i');
		} catch {
			throw new NodeOperationError(
				ctx.getNode(),
				`Archive Folder Pattern is not a valid regular expression: ${patternRaw}`,
			);
		}
	}

	// The last run's record covers documents a sync outside this flow (e.g. StreamBIM's own
	// schedule) hard-deleted since then; this run's record covers the sync below.
	const statePath = baselinePath(tokenCache.regionSubdomain ?? 'app', projectId);
	let snapshot = await readBaseline(statePath);
	let sync: IDataObject | undefined;
	if (ctx.getNodeParameter('relinkSyncFirst', 0, true) as boolean) {
		const before = await loadState(ctx, v2, tokenCache, ['ifcFile', 'drawing'], buildingIds);
		snapshot = mergeSnapshots(snapshot, takeSnapshot(before));
		// Save the record before the sync, so a failing or hanging sync cannot lose it.
		await writeBaseline(statePath, snapshot as RelinkSnapshot);
		sync = await syncAndWait(ctx, projectId, tokenCache, Number(options.syncTimeout) || 20);
		// The document list can lag a few seconds behind the sync status.
		await sleep(15_000);
	}
	const state = await loadState(ctx, v2, tokenCache, kinds, buildingIds);

	const plan = buildRelinkPlan(
		{
			documents: state.documents,
			ifcFiles: state.ifcFiles,
			alignments: state.alignments,
			floors: state.floors,
			sourceFiles: sourceInventory(items, options),
			snapshot,
		},
		{ archivePattern, kinds, buildingIds: state.buildingIds },
	);

	const saved = await writeBaseline(statePath, nextBaseline(snapshot, takeSnapshot(state), plan));

	const extra: IDataObject = {
		...(sync ? { sync } : {}),
		...(sync && sync.finished === false
			? {
					warning: `The StreamBIM sync was still running after ${String(sync.timeoutMinutes)} minutes; planned on the current state. Run again later for the rest.`,
				}
			: {}),
		...(saved ? {} : { warning: `Could not save the mapping record to ${statePath}` }),
	};
	if (plan.length === 0) {
		// One status item, so the flow continues and shows that the check ran.
		return [{ json: { projectId, nothingToRelink: true, ...extra }, pairedItem: { item: 0 } }];
	}
	return plan.map((p) => ({
		json: { projectId, ...p, ...extra } as unknown as IDataObject,
		pairedItem: { item: 0 },
	}));
}

type State = Awaited<ReturnType<typeof loadState>>;

/** Mappings and the mapped documents, as they were before the sync. */
function takeSnapshot(state: State): RelinkSnapshot {
	const mapped = new Set([
		...state.ifcFiles.map((f) => f.documentId),
		...state.alignments.map((a) => a.documentId),
		...state.floors.map((f) => f.customFloorplanDocumentId ?? ''),
	]);
	const now = new Date().toISOString();
	return {
		takenAt: now,
		documents: state.documents.filter((d) => mapped.has(d.id)).map((d) => ({ ...d, seenAt: now })),
		ifcFiles: state.ifcFiles,
		alignments: state.alignments,
	};
}

/** Where the last mapping record of a project is kept (inside the n8n user folder). */
function baselinePath(region: string, projectId: string): string {
	const root =
		process.env.STREAMBIM_RELINK_STATE_DIR ||
		join(process.env.N8N_USER_FOLDER || homedir(), '.n8n', 'streambim-relink');
	return join(
		root,
		`${region.replace(/[^a-z0-9-]/gi, '_')}-project-${projectId.replace(/\D/g, '')}.json`,
	);
}

async function readBaseline(path: string): Promise<RelinkSnapshot | undefined> {
	try {
		const v = JSON.parse(await fs.readFile(path, 'utf8')) as RelinkSnapshot;
		return Array.isArray(v.documents) ? v : undefined;
	} catch {
		return undefined;
	}
}

async function writeBaseline(path: string, snapshot: RelinkSnapshot): Promise<boolean> {
	try {
		await fs.mkdir(join(path, '..'), { recursive: true });
		await fs.writeFile(`${path}.tmp`, JSON.stringify(snapshot));
		await fs.rename(`${path}.tmp`, path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Trigger the sync and wait until no sync runs and one has ended after the trigger.
 * A failing trigger throws (nothing has changed yet). Up to 3 failed polls in a row are
 * tolerated. On timeout the result says finished = false instead of throwing: planning on a
 * half-synced state is safe, because only links whose old and new document both exist apply.
 */
async function syncAndWait(
	ctx: IExecuteFunctions,
	projectId: string,
	tokenCache: StreamBimTokenCache,
	timeoutMinutes: number,
): Promise<IDataObject> {
	const triggeredAt = Date.now();
	try {
		await streamBimSyncTriggerRequest.call(ctx, projectId, tokenCache);
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Could not start the StreamBIM sync: ${(error as Error).message}`,
		);
	}
	const deadline = triggeredAt + timeoutMinutes * 60_000;
	let failures = 0;
	let polls = 0;
	// StreamBIM sometimes answers OK to a trigger and never runs the sync (seen 2026-10-15).
	// No sign of a sync within 2 minutes → trigger again, at most twice.
	let seenRunning = false;
	let lastTrigger = triggeredAt;
	let retriggers = 0;
	while (Date.now() < deadline) {
		await sleep(polls === 0 ? 5_000 : 10_000);
		polls++;
		try {
			const activity = (await streamBimGetSyncStartedRequest.call(
				ctx,
				projectId,
				tokenCache,
			)) as IDataObject;
			failures = 0;
			if (activity?.['started-at']) {
				seenRunning = true;
				continue;
			}
			const ended = lastSyncEnded(
				await getAll(ctx, `/project-${projectId}/api/v1/v2/sync-statuses`, tokenCache),
			);
			// 30 s margin for clock differences between n8n and StreamBIM
			if (ended !== null && ended >= triggeredAt - 30_000) {
				return {
					finished: true,
					triggeredAt: new Date(triggeredAt).toISOString(),
					endedAt: new Date(ended).toISOString(),
					polls,
					...(retriggers ? { retriggers } : {}),
				};
			}
			if (!seenRunning && retriggers < 2 && Date.now() - lastTrigger > 120_000) {
				await streamBimSyncTriggerRequest.call(ctx, projectId, tokenCache);
				lastTrigger = Date.now();
				retriggers++;
			}
		} catch (error) {
			if (++failures > 3) {
				throw new NodeOperationError(
					ctx.getNode(),
					`Lost contact with StreamBIM while waiting for the sync: ${(error as Error).message}`,
				);
			}
		}
	}
	return {
		finished: false,
		triggeredAt: new Date(triggeredAt).toISOString(),
		timeoutMinutes,
		polls,
		retriggers,
	};
}

async function loadState(
	ctx: IExecuteFunctions,
	v2: string,
	tokenCache: StreamBimTokenCache,
	kinds: RelinkKind[],
	buildingIds: string[],
) {
	// Live and deleted documents separately: `isDeleted` cannot be combined with the
	// search filters, and some tenants only return one of the two without it.
	const seen = new Map<string, RelinkDocument>();
	for (const isDeleted of ['false', 'true']) {
		for (const row of await getAll(ctx, `${v2}/documents`, tokenCache, {
			'filter[isDeleted]': isDeleted,
		})) {
			const d = toRelinkDocument(row);
			seen.set(d.id, d);
		}
	}

	const buildings = await getAll(ctx, `${v2}/buildings`, tokenCache);
	const targetBuildings = buildings
		.map((b) => String(b.id))
		.filter((id) => buildingIds.length === 0 || buildingIds.includes(id));

	const ifcFiles = [];
	if (kinds.includes('ifcFile')) {
		for (const b of targetBuildings) {
			for (const row of await getAll(ctx, `${v2}/ifc-files`, tokenCache, {
				'filter[building]': b,
			})) {
				ifcFiles.push(toRelinkIfcFile(row));
			}
		}
	}
	const drawings = kinds.includes('drawing');
	const alignments = drawings
		? (await getAll(ctx, `${v2}/document-alignments`, tokenCache)).map(toRelinkAlignment)
		: [];
	const floors = drawings ? (await getAll(ctx, `${v2}/floors`, tokenCache)).map(toRelinkFloor) : [];

	return {
		documents: [...seen.values()],
		ifcFiles,
		alignments,
		floors,
		buildingIds: targetBuildings,
	};
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type ActionResult = {
	op: string;
	ok: boolean;
	dryRun?: boolean;
	detail?: unknown;
	error?: string;
};

function ifcFileBody(
	buildingId: string,
	documentId: string,
	layer: string,
	markedForDeletion: boolean,
	id?: string,
): IDataObject {
	return buildJsonApiBody({
		type: 'ifc-files',
		...(id ? { id } : {}),
		attributes: { layer, 'marked-for-deletion': markedForDeletion },
		relationships: {
			document: relationshipRef('documents', documentId),
			building: relationshipRef('buildings', buildingId),
		},
	});
}

function dataOf(res: unknown): IDataObject {
	const d = (res as IDataObject | undefined)?.data;
	return d && typeof d === 'object' && !Array.isArray(d) ? (d as IDataObject) : {};
}

async function getOrNull(
	ctx: IExecuteFunctions,
	v2: string,
	tokenCache: StreamBimTokenCache,
	path: string,
): Promise<IDataObject | null> {
	try {
		return dataOf(
			await streamBimJsonApiRequest.call(ctx, 'GET', `${v2}${path}`, tokenCache, undefined, {}),
		);
	} catch (error) {
		const code = String((error as { httpCode?: string }).httpCode ?? '');
		if (code === '404') return null;
		throw error;
	}
}

/**
 * Document PATCH body that changes only `overrides`: the current writable fields are sent
 * back, so a full-record PATCH cannot blank them.
 */
function documentPatchBody(doc: IDataObject, overrides: IDataObject): IDataObject {
	const attrs = (doc.attributes as IDataObject) ?? {};
	const rels = (doc.relationships as IDataObject) ?? {};
	return buildJsonApiBody({
		type: 'documents',
		id: String(doc.id),
		attributes: {
			filename: attrs.filename as string,
			description: (attrs.description as string) ?? '',
			'external-id': attrs['external-id'] as string,
			scale: attrs.scale as number,
			...overrides,
		},
		relationships: {
			parent:
				(rels.parent as { data: { type: string; id: string } }) ?? relationshipRef('folders', '0'),
			labels: (rels.labels as { data: Array<{ type: string; id: string }> }) ?? { data: [] },
		},
	});
}

async function runAction(
	ctx: IExecuteFunctions,
	v2: string,
	tokenCache: StreamBimTokenCache,
	a: RelinkAction,
): Promise<unknown> {
	const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: IDataObject) =>
		streamBimJsonApiRequest.call(ctx, method, `${v2}${path}`, tokenCache, body, {});

	switch (a.op) {
		case 'createIfcFile': {
			await req('POST', '/ifc-files', ifcFileBody(a.buildingId, a.documentId, a.layer, false));
			const check = dataOf(await req('GET', `/ifc-files/${a.buildingId}-${a.documentId}`));
			const attrs = (check.attributes as IDataObject) ?? {};
			if (attrs.layer !== a.layer)
				throw new Error(`verification failed: layer is "${String(attrs.layer)}"`);
			return { id: check.id, layer: attrs.layer };
		}
		case 'restoreIfcFile':
			return dataOf(
				await req(
					'PATCH',
					`/ifc-files/${a.ifcFileId}`,
					ifcFileBody(a.buildingId, a.documentId, a.layer, false, a.ifcFileId),
				),
			).id;
		case 'retireIfcFile':
			return dataOf(
				await req(
					'PATCH',
					`/ifc-files/${a.ifcFileId}`,
					ifcFileBody(a.buildingId, a.documentId, a.layer, true, a.ifcFileId),
				),
			).id;
		case 'copyAlignment': {
			// Setting the floor plan may already have given the document a placement; update it
			// in that case, otherwise create one. Either way the old calibration points are copied.
			const id = `${a.documentId}-${a.buildingId}`;
			const current = await getOrNull(ctx, v2, tokenCache, `/document-alignments/${id}`);
			const body = documentAlignmentCreateBody({
				documentId: a.documentId,
				buildingId: a.buildingId,
				name: String(((current?.attributes as IDataObject) ?? {}).name ?? ''),
				imagePoints: a.imagePoints,
				worldPoints: a.worldPoints,
				maskPoints: a.maskPoints,
			});
			if (current) {
				(body.data as IDataObject).id = id;
				await req('PATCH', `/document-alignments/${id}`, body);
			} else {
				await req('POST', '/document-alignments', body);
			}
			const check = dataOf(await req('GET', `/document-alignments/${id}`));
			const attrs = (check.attributes as IDataObject) ?? {};
			if (JSON.stringify(attrs['world-points']) !== JSON.stringify(a.worldPoints)) {
				throw new Error('verification failed: world-points differ from the copied placement');
			}
			return { id: check.id, mode: current ? 'updated' : 'created' };
		}
		case 'renameAlignment': {
			const id = `${a.documentId}-${a.buildingId}`;
			const current = dataOf(await req('GET', `/document-alignments/${id}`));
			const attrs = (current.attributes as IDataObject) ?? {};
			const body = documentAlignmentCreateBody({
				documentId: a.documentId,
				buildingId: a.buildingId,
				name: a.name,
				imagePoints: attrs['image-points'],
				worldPoints: attrs['world-points'],
				maskPoints: attrs['mask-points'],
			});
			(body.data as IDataObject).id = id;
			const res = dataOf(await req('PATCH', `/document-alignments/${id}`, body));
			const name = ((res.attributes as IDataObject) ?? {}).name;
			if (name !== undefined && name !== a.name) {
				throw new Error(`verification failed: name is "${String(name)}"`);
			}
			return { id, name: a.name };
		}
		case 'copyDocumentScale': {
			const doc = dataOf(await req('GET', `/documents/${a.documentId}`));
			return dataOf(
				await req(
					'PATCH',
					`/documents/${a.documentId}`,
					documentPatchBody(doc, { scale: a.scale }),
				),
			).id;
		}
		case 'retireDocument': {
			const doc = dataOf(await req('GET', `/documents/${a.documentId}`));
			await req(
				'PATCH',
				`/documents/${a.documentId}`,
				documentPatchBody(doc, { 'is-deleted': true }),
			);
			const check = dataOf(await req('GET', `/documents/${a.documentId}`));
			if (((check.attributes as IDataObject) ?? {})['is-deleted'] !== true) {
				throw new Error('verification failed: the document is still live');
			}
			return { retired: a.documentId };
		}
		case 'deleteAlignment':
			await req('DELETE', `/document-alignments/${a.alignmentId}`);
			return { deleted: a.alignmentId };
		case 'updateFloor': {
			const floor = dataOf(await req('GET', `/floors/${a.floorId}`));
			const body = floorUpdateBody(floor, a.documentId, true);
			const res = dataOf(await req('PATCH', `/floors/${a.floorId}`, body));
			const doc = ((res.relationships as IDataObject)?.['custom-floorplan-document'] as IDataObject)
				?.data as IDataObject;
			if (doc && String(doc.id) !== a.documentId)
				throw new Error(`verification failed: floor points at ${String(doc.id)}`);
			const resAttrs = (res.attributes as IDataObject) ?? {};
			const before = (floor.attributes as IDataObject) ?? {};
			if (resAttrs.name !== undefined && resAttrs.name !== before.name) {
				throw new Error(`verification failed: floor name changed to "${String(resAttrs.name)}"`);
			}
			return { id: res.id, customFloorplanDocument: doc?.id };
		}
	}
	return undefined;
}

export async function runRelinkApply(
	ctx: IExecuteFunctions,
	i: number,
	items: INodeExecutionData[],
	tokenCache: StreamBimTokenCache,
): Promise<IDataObject> {
	const item = (items[i]?.json ?? {}) as unknown as RelinkPlanItem & {
		projectId?: string;
	};
	const projectId = getProjectIdString(ctx, i) || String(item.projectId ?? '');
	if (!projectId)
		throw new NodeOperationError(ctx.getNode(), 'Project ID is required for relink', {
			itemIndex: i,
		});
	if (!Array.isArray(item.actions)) {
		// Plan's "nothing to relink" status item (or anything else) passes through untouched.
		if ((item as unknown as IDataObject).nothingToRelink === true) {
			return { ...(item as unknown as IDataObject), applied: false, skipped: true };
		}
		throw new NodeOperationError(
			ctx.getNode(),
			'Input item is not a relink plan item (no "actions" array)',
			{ itemIndex: i },
		);
	}
	const dryRun = ctx.getNodeParameter('relinkDryRun', i, true) as boolean;
	const level = ctx.getNodeParameter('relinkApplyLevel', i, 'by_external_id') as string;
	const profiles: RelinkLinkProfile[] =
		level === 'by_external_id' ? ['by_external_id'] : ['by_external_id', 'by_filename'];
	const selected = shouldApply(item, profiles, level === 'all');

	const results: ActionResult[] = [];
	if (selected && !dryRun) {
		const v2 = `/project-${projectId}/api/v1/v2`;
		for (const a of item.actions) {
			try {
				results.push({
					op: a.op,
					ok: true,
					detail: await runAction(ctx, v2, tokenCache, a),
				});
			} catch (error) {
				results.push({ op: a.op, ok: false, error: (error as Error).message });
				break; // never retire the old mapping when creating the new one failed
			}
		}
	} else if (selected) {
		for (const a of item.actions) results.push({ op: a.op, ok: true, dryRun: true, detail: a });
	}

	return {
		...(item as unknown as IDataObject),
		applied:
			selected && !dryRun && results.length === item.actions.length && results.every((r) => r.ok),
		skipped: !selected,
		dryRun,
		results: results as unknown as IDataObject[],
	};
}

/** Apply every input item, then start one conversion per building whose layers changed. */
export async function runRelinkApplyAll(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	tokenCache: StreamBimTokenCache,
): Promise<INodeExecutionData[]> {
	const out: IDataObject[] = [];
	const dryRunAll = ctx.getNodeParameter('relinkDryRun', 0, true) as boolean;
	for (let i = 0; i < items.length; i++) {
		const json = (items[i].json ?? {}) as IDataObject;
		const oldId = String(((json.old as IDataObject) ?? {}).documentId ?? '');
		if (
			!dryRunAll &&
			json.kind === 'document' &&
			!retirableDocuments([...out, json] as never).has(oldId)
		) {
			out.push({
				...json,
				applied: false,
				skipped: true,
				reasons: [
					...((json.reasons as string[]) ?? []),
					'Not retired: a mapping on this document was not moved, so it stays live.',
				],
			});
			continue;
		}
		try {
			out.push(await runRelinkApply(ctx, i, items, tokenCache));
		} catch (error) {
			if (!ctx.continueOnFail()) throw error;
			out.push({ ...(items[i].json ?? {}), error: (error as Error).message });
		}
	}
	const dryRun = ctx.getNodeParameter('relinkDryRun', 0, true) as boolean;
	if (!dryRun && (ctx.getNodeParameter('relinkConvertAfter', 0, true) as boolean)) {
		const projectId = getProjectIdString(ctx, 0) || String(out[0]?.projectId ?? '');
		const buildings = [
			...new Set(
				out.filter((o) => o.kind === 'ifcFile' && o.applied).map((o) => String(o.buildingId)),
			),
		];
		for (const buildingId of buildings) {
			let conversion: IDataObject;
			try {
				conversion = await startConversion(ctx, projectId, buildingId, tokenCache);
			} catch (error) {
				conversion = { buildingId, error: (error as Error).message };
			}
			for (const o of out)
				if (o.kind === 'ifcFile' && String(o.buildingId) === buildingId) o.conversion = conversion;
		}
	}
	return out.map((json, i) => ({ json, pairedItem: { item: i } }));
}

const ACTIVE_JOB = new Set(['initializing', 'queued', 'pending', 'running', 'finalizing']);

/**
 * Start a conversion for one building. A conversion already running there (e.g. the one
 * StreamBIM starts itself after a sync when RECONVERT_AFTER_SYNC is on) was started with
 * the old mappings, so wait for it (up to 30 minutes) and start ours after it.
 */
async function startConversion(
	ctx: IExecuteFunctions,
	projectId: string,
	buildingId: string,
	tokenCache: StreamBimTokenCache,
): Promise<IDataObject> {
	const waitUntil = Date.now() + 30 * 60_000;
	let waitedFor: string | undefined;
	for (;;) {
		const jobs = (await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			'/cmv3/converter-jobs',
			tokenCache,
			undefined,
			{
				'filter[project]': projectId,
				'filter[building]': buildingId,
			},
		)) as IDataObject;
		const active = ((jobs.data as IDataObject[]) ?? []).find((j) =>
			ACTIVE_JOB.has(String(((j.attributes as IDataObject) ?? {})['job-status'] ?? '')),
		);
		if (!active) break;
		waitedFor = String(active.id);
		if (Date.now() > waitUntil) {
			return {
				buildingId,
				error: `Conversion ${waitedFor} still running after 30 minutes; none started`,
			};
		}
		await sleep(15_000);
	}
	const building = dataOf(
		await streamBimJsonApiRequest.call(
			ctx,
			'GET',
			`/project-${projectId}/api/v1/v2/buildings/${buildingId}`,
			tokenCache,
			undefined,
			{},
		),
	);
	const floorplanLayer = String(
		((building.attributes as IDataObject) ?? {})['floorplan-layer'] ?? '',
	);
	const job = dataOf(
		await streamBimJsonApiRequest.call(
			ctx,
			'POST',
			'/cmv3/converter-jobs',
			tokenCache,
			buildJsonApiBody({
				type: 'converter-jobs',
				attributes: {
					'floorplan-layer': floorplanLayer,
					name: `Relink ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
					persist: false,
				},
				relationships: {
					building: relationshipRef('buildings', buildingId),
					project: relationshipRef('projects', projectId),
				},
			}),
			{},
		),
	);
	return {
		buildingId,
		jobId: job.id,
		status: ((job.attributes as IDataObject) ?? {})['job-status'],
		...(waitedFor ? { waitedForJob: waitedFor } : {}),
	};
}

export async function runRelink(
	ctx: IExecuteFunctions,
	operation: string,
	i: number,
	items: INodeExecutionData[],
	tokenCache: StreamBimTokenCache,
): Promise<unknown> {
	if (operation === 'apply') return await runRelinkApply(ctx, i, items, tokenCache);
	throw new NodeOperationError(ctx.getNode(), `Unknown relink operation: ${operation}`, {
		itemIndex: i,
	});
}
