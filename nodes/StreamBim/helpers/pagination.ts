import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import type { StreamBimListPagination } from '../../shared/GenericFunctions';

/**
 * Phase 1 v8 helper.
 *
 * Goal: replace the legacy `listPaginationMode + pageLimit + pageSkip +
 * maxPages` set of node fields with the n8n-standard `returnAll + limit`
 * pair, and adapt the resulting options to the existing
 * `StreamBimListPagination` runtime shape so the request layer is unchanged.
 *
 * Two equivalent shapes are exposed:
 *   - `buildReturnAllAndLimit(operations, opts?)` + `getV8ListPagination(ctx, i)`
 *     scoped by `opts.resource` (used by R1/R2/R4/R5).
 *   - `paginationFields(resource, operations)` + `getV8Pagination(ctx, i)`
 *     with explicit resource arg (used by R3/R6).
 */

export type V8ListPaginationOptions = {
	returnAll: boolean;
	limit?: number;
};

export type BuildReturnAllAndLimitOpts = {
	/** Restrict display to one or more resources. */
	resource?: string | string[];
	/** Default page size used when Return All is false. */
	defaultLimit?: number;
	/** Max value for the Limit field (defaults to {@link MAX_LIMIT}). */
	maxLimit?: number;
};

function normalizeOpts(
	opts?: BuildReturnAllAndLimitOpts | string | string[],
): BuildReturnAllAndLimitOpts | undefined {
	if (opts === undefined) return undefined;
	if (typeof opts === 'string' || Array.isArray(opts)) {
		return { resource: opts };
	}
	return opts;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_PAGES_FOR_RETURN_ALL = 5000;
const KNOWN_LIST_OPERATIONS = new Set([
	'getMany',
	'getManyUsers',
	'getManyProjectUsers',
	'getManyProjectMembers',
	'getManyGroups',
	'getManyRevisions',
	'getManyLabels',
	'getManyFolders',
	'listConfigs',
	'listSyncStatuses',
]);

function looksLikeOperations(values: string[]): boolean {
	return values.length > 0 && values.every((value) => KNOWN_LIST_OPERATIONS.has(value));
}

const PARAM_MISSING = Symbol('streambim-param-missing');

function safeGetNodeParameter(
	ctx: IExecuteFunctions,
	i: number,
	name: string,
): unknown {
	// n8n throws "Could not get parameter" when the node has no entry for
	// `name` and no concrete fallback is provided. Use a unique sentinel as
	// fallback AND wrap in try/catch so this helper works across n8n versions
	// and across nodes saved with older parameter shapes.
	try {
		return ctx.getNodeParameter(name, i, PARAM_MISSING as unknown as never);
	} catch {
		return PARAM_MISSING;
	}
}

function readBooleanParam(
	ctx: IExecuteFunctions,
	i: number,
	name: string,
): boolean | undefined {
	const value = safeGetNodeParameter(ctx, i, name);
	return typeof value === 'boolean' ? value : undefined;
}

function readPositiveIntegerParam(
	ctx: IExecuteFunctions,
	i: number,
	names: string[],
): number | undefined {
	for (const name of names) {
		const value = safeGetNodeParameter(ctx, i, name);
		if (value === PARAM_MISSING || value === undefined || value === null || value === '') continue;
		const num = Number(value);
		if (Number.isFinite(num) && num > 0) return Math.floor(num);
	}
	return undefined;
}

function readNonNegativeIntegerParam(
	ctx: IExecuteFunctions,
	i: number,
	nameOrNames: string | string[],
): number | undefined {
	const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
	for (const name of names) {
		const value = safeGetNodeParameter(ctx, i, name);
		if (value === PARAM_MISSING || value === undefined || value === null || value === '') {
			continue;
		}
		const num = Number(value);
		if (Number.isFinite(num) && num >= 0) return Math.floor(num);
	}
	return undefined;
}

function getReturnAll(ctx: IExecuteFunctions, i: number): boolean {
	const returnAll = readBooleanParam(ctx, i, 'returnAll');
	if (returnAll !== undefined) return returnAll;
	const mode = safeGetNodeParameter(ctx, i, 'listPaginationMode');
	return mode === 'all';
}

/**
 * Returns the n8n-standard `returnAll` + `limit` INodeProperties pair shared
 * by list operations. `limit` is hidden when `returnAll` is true.
 *
 * @param operations Operation values these fields should be shown for.
 * @param opts Optional resource scoping + default page size.
 */
export type BuildReturnAllAndLimitConfig = {
	operations: string[];
	resources?: string[];
	maxLimit?: number;
	defaultLimit?: number;
};

export function buildReturnAllAndLimit(
	operations: string[],
	opts?: BuildReturnAllAndLimitOpts,
): INodeProperties[];
export function buildReturnAllAndLimit(
	operations: string[],
	resource: string | string[],
): INodeProperties[];
export function buildReturnAllAndLimit(
	config: BuildReturnAllAndLimitConfig,
): INodeProperties[];
export function buildReturnAllAndLimit(
	first: string[] | BuildReturnAllAndLimitConfig,
	optsOrResource?: BuildReturnAllAndLimitOpts | string | string[],
): INodeProperties[] {
	let operations: string[];
	let opts: BuildReturnAllAndLimitOpts | undefined;
	if (!Array.isArray(first)) {
		operations = first.operations;
		opts = {
			resource: first.resources,
			defaultLimit: first.defaultLimit,
			maxLimit: first.maxLimit,
		};
	} else {
		operations = first;
		opts = normalizeOpts(optsOrResource);
		if (
			Array.isArray(optsOrResource) &&
			!looksLikeOperations(first) &&
			looksLikeOperations(optsOrResource)
		) {
			operations = optsOrResource;
			opts = { resource: first };
		}
	}
	const baseShow: { resource?: string[]; operation: string[] } = { operation: operations };
	if (opts?.resource) {
		baseShow.resource = Array.isArray(opts.resource) ? opts.resource : [opts.resource];
	}
	const limitShow: { resource?: string[]; operation: string[]; returnAll: boolean[] } = {
		...baseShow,
		returnAll: [false],
	};
	const maxLimit = opts?.maxLimit ?? MAX_LIMIT;
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: {
				show: baseShow,
			},
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: {
				minValue: 1,
				maxValue: maxLimit,
			},
			description: 'Max number of results to return',
			displayOptions: {
				show: limitShow,
			},
		},
	];
}

/**
 * Reads `returnAll` + `limit` from the current node parameters and returns a
 * `StreamBimListPagination` value compatible with `streamBimJsonApiGetMany`.
 */
export type GetV8ListPaginationOpts = {
	defaultLimit?: number;
	/** Cap per-request page size (defaults to {@link MAX_LIMIT}). */
	maxPageLimit?: number;
	/** Extra parameter names to read page size from (e.g. legacy `ifcPageLimit`). */
	limitParamNames?: string[];
	/** Extra parameter names to read page skip from (e.g. legacy `ifcPageSkip`). */
	skipParamNames?: string[];
};

export function getV8ListPagination(
	ctx: IExecuteFunctions,
	i: number,
	opts?: GetV8ListPaginationOpts,
): StreamBimListPagination {
	const defaultLimit = opts?.defaultLimit ?? DEFAULT_LIMIT;
	const maxPageLimit = opts?.maxPageLimit ?? MAX_LIMIT;
	const limitNames = opts?.limitParamNames ?? ['limit', 'pageLimit'];
	const skipNames = opts?.skipParamNames ?? ['pageSkip'];
	const returnAll = getReturnAll(ctx, i);
	const limit = readPositiveIntegerParam(ctx, i, limitNames) ?? defaultLimit;
	const cappedLimit = Math.max(1, Math.min(Math.floor(limit), maxPageLimit));
	const pagination = toStreamBimListPagination({ returnAll, limit: cappedLimit });
	if (!returnAll) {
		pagination.pageSkip = readNonNegativeIntegerParam(ctx, i, skipNames) ?? 0;
	}
	if (returnAll) {
		pagination.pageLimit = cappedLimit;
	}
	return pagination;
}

/**
 * Runtime adapter: turns `returnAll + limit` (v8 UI) into the existing
 * `StreamBimListPagination` shape used by `streamBimJsonApiGetMany`.
 *
 * Kept as a stub for backwards compatibility; prefer `getV8Pagination`.
 */
export function toStreamBimListPagination(
	opts: V8ListPaginationOptions,
): StreamBimListPagination {
	const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
	if (opts.returnAll) {
		return {
			mode: 'all',
			pageLimit: Math.min(Math.max(limit, 1), MAX_LIMIT),
			pageSkip: 0,
			maxPages: MAX_PAGES_FOR_RETURN_ALL,
		};
	}
	return {
		mode: 'single',
		pageLimit: Math.min(Math.max(limit, 1), MAX_LIMIT),
		pageSkip: 0,
		maxPages: 1,
	};
}

/**
 * v8 helper: returns the n8n-standard `Return All` + `Limit` pair scoped to a
 * specific resource and operation list.
 *
 * Both fields filter on `resource` AND `operation` so they only show on the
 * intended Get Many operations and don't bleed into other resources that
 * happen to share an operation name (e.g. `getMany`).
 */
export function paginationFields(
	resource: string,
	operations: string[],
): INodeProperties[] {
	const showBase: { resource: string[]; operation: string[] } = {
		resource: [resource],
		operation: operations,
	};

	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: {
				show: showBase,
			},
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: {
				minValue: 1,
				maxValue: MAX_LIMIT,
			},
			default: 50,
			description: 'Max number of results to return',
			displayOptions: {
				show: {
					...showBase,
					returnAll: [false],
				},
			},
		},
	];
}

/**
 * v8 runtime helper: reads `returnAll` + `limit` from the current item and
 * returns a `StreamBimListPagination` suitable for `streamBimJsonApiGetMany`.
 *
 * - returnAll=true → mode='all' with a generous internal page size
 *   (`allPagesPageSize`, default 200) and a `maxPages` safety cap.
 * - returnAll=false → mode='single' with `pageLimit=limit` and a single page.
 */
export function getV8Pagination(
	ctx: IExecuteFunctions,
	i: number,
	opts: { allPagesPageSize?: number; defaultLimit?: number } = {},
): StreamBimListPagination {
	const returnAll = getReturnAll(ctx, i);
	if (returnAll) {
		const limit =
			readPositiveIntegerParam(ctx, i, ['limit', 'pageLimit']) ?? opts.allPagesPageSize ?? 200;
		const pageLimit = Math.max(
			1,
			Math.min(Math.floor(limit), MAX_LIMIT),
		);
		return {
			mode: 'all',
			pageLimit,
			pageSkip: 0,
			maxPages: 5000,
		};
	}
	const limit = readPositiveIntegerParam(ctx, i, ['limit', 'pageLimit']) ?? opts.defaultLimit ?? 50;
	return {
		mode: 'single',
		pageLimit: Math.min(limit, MAX_LIMIT),
		pageSkip: readNonNegativeIntegerParam(ctx, i, 'pageSkip') ?? 0,
		maxPages: 1,
	};
}
