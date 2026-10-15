import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	streamBimJsonApiGetMany,
	type StreamBimListPagination,
	type StreamBimTokenCache,
} from '../../shared/GenericFunctions';

/**
 * Internal runtime helpers shared by per-resource run functions. These are
 * verbatim copies of the helpers that previously lived inside
 * `StreamBim.node.ts`. They will be progressively replaced by the public
 * helpers under `nodes/StreamBim/helpers/` in Phase 1.
 */

export function getProjectIdString(ctx: IExecuteFunctions, i: number): string {
	return String(ctx.getNodeParameter('projectId', i));
}

export function getProjectIdNumber(ctx: IExecuteFunctions, i: number): number {
	const n = Number(ctx.getNodeParameter('projectId', i));
	if (Number.isNaN(n)) {
		throw new NodeOperationError(ctx.getNode(), 'Project is required', { itemIndex: i });
	}
	return n;
}

export function getListPagination(ctx: IExecuteFunctions, i: number): StreamBimListPagination {
	const mode = ctx.getNodeParameter('listPaginationMode', i, 'single') as string;
	const pageLimit = Number(ctx.getNodeParameter('pageLimit', i, 100));
	const pageSkip = Number(ctx.getNodeParameter('pageSkip', i, 0));
	const maxPages = Number(ctx.getNodeParameter('maxPages', i, 500));
	return {
		mode: mode === 'all' ? 'all' : 'single',
		pageLimit: Number.isFinite(pageLimit) ? pageLimit : 100,
		pageSkip: Number.isFinite(pageSkip) ? pageSkip : 0,
		maxPages: Number.isFinite(maxPages) ? maxPages : 500,
	};
}

export function parseJsonQueryParameters(
	ctx: IExecuteFunctions,
	raw: string,
	i: number,
	label: string,
): IDataObject {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON`, { itemIndex: i });
	}
}

export function parseInviteSsoProviders(
	ctx: IExecuteFunctions,
	raw: string,
	i: number,
): string[] {
	if (!raw.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.map((x) => String(x));
		}
		if (typeof parsed === 'string') {
			return [parsed];
		}
		throw new NodeOperationError(
			ctx.getNode(),
			'SSO providers JSON must be an array of strings or a single string',
			{ itemIndex: i },
		);
	} catch (e) {
		if (e instanceof NodeOperationError) throw e;
		return raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}
}

export function getRequiredStringParameter(
	ctx: IExecuteFunctions,
	paramName: string,
	i: number,
	label?: string,
): string {
	const value = (ctx.getNodeParameter(paramName, i, '') as string).trim();
	if (!value || value === 'null' || value === 'undefined') {
		throw new NodeOperationError(
			ctx.getNode(),
			`${label || paramName} is required and cannot be empty or null`,
			{ itemIndex: i },
		);
	}
	return value;
}

export function parseJsonBody(
	ctx: IExecuteFunctions,
	raw: string,
	i: number,
	label: string,
): IDataObject {
	try {
		return JSON.parse(raw) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON`, { itemIndex: i });
	}
}

export async function jsonApiGetMany(
	ctx: IExecuteFunctions,
	path: string,
	tokenCache: StreamBimTokenCache,
	qs: IDataObject,
	i: number,
): Promise<unknown> {
	return streamBimJsonApiGetMany.call(ctx, path, tokenCache, qs, getListPagination(ctx, i));
}
