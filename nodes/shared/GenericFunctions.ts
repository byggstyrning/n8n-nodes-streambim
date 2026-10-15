import type { Readable } from 'stream';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type { IHttpRequestMethods } from 'n8n-workflow';

export type StreamBimTokenCache = {
	token?: string;
	/** Subdomain from node Region (overrides credential) for this item. */
	regionSubdomain?: string;
};

export function getStreamBimBaseUrl(credentials: IDataObject, tokenCache?: StreamBimTokenCache): string {
	const env =
		(tokenCache?.regionSubdomain?.trim() ||
			(credentials.environment as string) ||
			'app').trim() || 'app';
	return `https://${env}.streambim.com`;
}

export async function streamBimLogin(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	tokenCache?: StreamBimTokenCache,
): Promise<string> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const username = credentials.username as string;
	const password = credentials.password as string;
	if (!username || !password) {
		throw new NodeOperationError(this.getNode(), 'Username and password are required for this authentication mode');
	}
	const options: IRequestOptions = {
		method: 'POST',
		url: `${baseUrl}/auth/v1/login`,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: {
			username,
			password,
		},
		json: true,
	};
	try {
		const response = (await this.helpers.request(options)) as IDataObject;
		if (response.result === 'CHALLENGE_REQUESTED') {
			throw new NodeOperationError(
				this.getNode(),
				'MFA is required. Use Bearer token authentication with an idToken from a completed login instead.',
			);
		}
		const idToken = response.idToken as string | undefined;
		if (!idToken) {
			throw new NodeOperationError(this.getNode(), 'Login did not return an idToken');
		}
		return idToken;
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;
		throw new NodeApiError(this.getNode(), error as any);
	}
}

export async function getStreamBimAccessToken(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	tokenCache?: StreamBimTokenCache,
): Promise<string> {
	const credentials = await this.getCredentials('streamBimApi');
	const auth = credentials.authentication as string;
	if (auth === 'bearer') {
		const idToken = credentials.idToken as string;
		if (!idToken) {
			throw new NodeOperationError(this.getNode(), 'ID token is required when using Bearer authentication');
		}
		return idToken;
	}
	if (tokenCache?.token) {
		return tokenCache.token;
	}
	const token = await streamBimLogin.call(this, tokenCache);
	if (tokenCache) {
		tokenCache.token = token;
	}
	return token;
}

const PAGE_LIMIT_KEY = 'page[limit]';
const PAGE_SKIP_KEY = 'page[skip]';

function stripStreamBimPaginationKeys(qs: IDataObject): IDataObject {
	const next: IDataObject = { ...qs };
	delete next[PAGE_LIMIT_KEY];
	delete next[PAGE_SKIP_KEY];
	return next;
}

export type StreamBimListPagination = {
	mode: 'single' | 'all';
	pageLimit: number;
	pageSkip: number;
	maxPages: number;
};

/**
 * JSON:API list GET with embedded pagination: single page or fetch-all via page[limit]/page[skip].
 * Strips page[limit]/page[skip] from baseQs and applies values from pagination (filters in baseQs are kept).
 */
export async function streamBimJsonApiGetMany(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	path: string,
	tokenCache: StreamBimTokenCache | undefined,
	baseQs: IDataObject,
	pagination: StreamBimListPagination,
): Promise<unknown> {
	const limit = Math.max(1, Math.min(Math.floor(pagination.pageLimit), 1000));
	const base = stripStreamBimPaginationKeys(baseQs);

	if (pagination.mode === 'single') {
		const skip = Math.max(0, Math.floor(pagination.pageSkip));
		const qs: IDataObject = { ...base, [PAGE_LIMIT_KEY]: limit, [PAGE_SKIP_KEY]: skip };
		return streamBimJsonApiRequest.call(this, 'GET', path, tokenCache, undefined, qs);
	}

	const maxPages = Math.max(1, Math.min(Math.floor(pagination.maxPages), 5000));
	let skip = 0;
	const all: IDataObject[] = [];
	let mergedIncluded: IDataObject[] | undefined;
	const includedSeen = new Set<string>();

	for (let p = 0; p < maxPages; p++) {
		const qs: IDataObject = { ...base, [PAGE_LIMIT_KEY]: limit, [PAGE_SKIP_KEY]: skip };
		const res = (await streamBimJsonApiRequest.call(
			this,
			'GET',
			path,
			tokenCache,
			undefined,
			qs,
		)) as IDataObject;

		const chunk = Array.isArray(res.data) ? (res.data as IDataObject[]) : [];
		all.push(...chunk);

		const inc = res.included;
		if (Array.isArray(inc) && inc.length > 0) {
			if (!mergedIncluded) mergedIncluded = [];
			for (const item of inc) {
				const o = item as IDataObject;
				const id = o.id as string | undefined;
				const type = o.type as string | undefined;
				const key = `${type ?? ''}:${id ?? ''}`;
				if (!includedSeen.has(key)) {
					includedSeen.add(key);
					mergedIncluded!.push(o);
				}
			}
		}

		if (chunk.length < limit) break;
		skip += limit;
	}

	const out: IDataObject = {
		data: all,
		meta: {
			aggregated: true,
			[PAGE_LIMIT_KEY]: limit,
			totalReturned: all.length,
		},
	};
	if (mergedIncluded && mergedIncluded.length > 0) {
		out.included = mergedIncluded;
	}
	return out;
}

/** Default per-request page size for plain-JSON export endpoints (IFC search export). */
export const PLAIN_JSON_EXPORT_DEFAULT_PAGE_LIMIT = 1000;
/** API max rows per IFC search export page (see StreamBIM ifc-searches docs). */
export const PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT = 10000;

function extractPlainJsonDataRows(response: unknown): IDataObject[] {
	if (!response || typeof response !== 'object') return [];
	if (Array.isArray(response)) return response as IDataObject[];
	const envelope = response as IDataObject;
	if (Array.isArray(envelope.data)) return envelope.data as IDataObject[];
	return [];
}

/**
 * Plain-JSON list/export GET with pagination via `page[limit]` / `page[skip]`.
 * Merges `{ data: [...] }` row arrays across pages when `pagination.mode === 'all'`.
 */
export async function streamBimPlainJsonGetMany(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	path: string,
	tokenCache: StreamBimTokenCache | undefined,
	baseQs: IDataObject,
	pagination: StreamBimListPagination,
	opts?: { maxPageLimit?: number },
): Promise<IDataObject> {
	const cap = opts?.maxPageLimit ?? PLAIN_JSON_EXPORT_MAX_PAGE_LIMIT;
	const limit = Math.max(1, Math.min(Math.floor(pagination.pageLimit), cap));
	const base = stripStreamBimPaginationKeys(baseQs);

	if (pagination.mode === 'single') {
		const skip = Math.max(0, Math.floor(pagination.pageSkip));
		const qs: IDataObject = { ...base, [PAGE_LIMIT_KEY]: limit, [PAGE_SKIP_KEY]: skip };
		const res = await streamBimPlainJsonRequest.call(this, 'GET', path, tokenCache, undefined, qs);
		const rows = extractPlainJsonDataRows(res);
		return {
			data: rows,
			meta: {
				[PAGE_LIMIT_KEY]: limit,
				[PAGE_SKIP_KEY]: skip,
				totalReturned: rows.length,
			},
		};
	}

	const maxPages = Math.max(1, Math.min(Math.floor(pagination.maxPages), 5000));
	let skip = 0;
	const all: IDataObject[] = [];

	for (let p = 0; p < maxPages; p++) {
		const qs: IDataObject = { ...base, [PAGE_LIMIT_KEY]: limit, [PAGE_SKIP_KEY]: skip };
		const res = await streamBimPlainJsonRequest.call(this, 'GET', path, tokenCache, undefined, qs);
		const chunk = extractPlainJsonDataRows(res);
		all.push(...chunk);
		if (chunk.length < limit) break;
		skip += limit;
	}

	return {
		data: all,
		meta: {
			aggregated: true,
			[PAGE_LIMIT_KEY]: limit,
			totalReturned: all.length,
		},
	};
}

export async function streamBimJsonApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	method: IHttpRequestMethods,
	path: string,
	tokenCache: StreamBimTokenCache | undefined,
	body: IDataObject | undefined,
	qs: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const token = await getStreamBimAccessToken.call(this, tokenCache);
	const options: IRequestOptions = {
		method,
		uri: `${baseUrl}${path}`,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
		},
		json: true,
	};
	if (body !== undefined && Object.keys(body).length > 0) {
		options.body = body;
	} else {
		delete options.body;
	}
	if (Object.keys(qs).length > 0) {
		options.qs = qs;
	}
	try {
		return await this.helpers.request(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

export async function streamBimPlainJsonRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	method: IHttpRequestMethods,
	path: string,
	tokenCache: StreamBimTokenCache | undefined,
	body: IDataObject | undefined,
	qs: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const token = await getStreamBimAccessToken.call(this, tokenCache);
	const options: IRequestOptions = {
		method,
		uri: `${baseUrl}${path}`,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		json: true,
	};
	if (body !== undefined && Object.keys(body).length > 0) {
		options.body = body;
	} else {
		delete options.body;
	}
	if (Object.keys(qs).length > 0) {
		options.qs = qs;
	}
	try {
		return await this.helpers.request(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

export async function streamBimSyncTriggerRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	projectId: number | string,
	tokenCache: StreamBimTokenCache | undefined,
): Promise<unknown> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const token = await getStreamBimAccessToken.call(this, tokenCache);
	const options: IRequestOptions = {
		method: 'POST',
		uri: `${baseUrl}/project-${projectId}/api/v1/sync`,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: {},
		json: true,
	};
	try {
		return await this.helpers.request(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

export async function streamBimGetSyncStartedRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	projectId: number | string,
	tokenCache: StreamBimTokenCache | undefined,
): Promise<unknown> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const token = await getStreamBimAccessToken.call(this, tokenCache);
	const options: IRequestOptions = {
		method: 'GET',
		uri: `${baseUrl}/project-${projectId}/api/v1/sync`,
		headers: {
			Authorization: `Bearer ${token}`,
		},
		json: true,
	};
	try {
		return await this.helpers.request(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

/** GET returning plain text (e.g. attachment download link path). */
export async function streamBimTextRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	path: string,
	tokenCache: StreamBimTokenCache | undefined,
	qs: IDataObject,
): Promise<string> {
	const credentials = await this.getCredentials('streamBimApi');
	const baseUrl = getStreamBimBaseUrl(credentials, tokenCache);
	const token = await getStreamBimAccessToken.call(this, tokenCache);
	const options: IRequestOptions = {
		method: 'GET',
		uri: `${baseUrl}${path}`,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
		},
		json: false,
	};
	if (Object.keys(qs).length > 0) {
		options.qs = qs;
	}
	try {
		const response = await this.helpers.request(options);
		if (typeof response === 'string') {
			return response;
		}
		return JSON.stringify(response);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

export async function streamBimS3Put(
	this: IExecuteFunctions,
	presignedUrl: string,
	body: Buffer | Readable,
	contentLength: number,
	contentType: string,
): Promise<unknown> {
	// S3 presigned PUT requires a known length — a streamed body would otherwise
	// use chunked transfer-encoding, which S3 rejects. Set Content-Length
	// explicitly so we can pipe a Readable straight from n8n's binary store.
	const options: IRequestOptions = {
		method: 'PUT',
		uri: presignedUrl,
		headers: {
			'Content-Type': contentType,
			'Content-Length': contentLength,
		},
		body,
		json: false,
	};
	try {
		return await this.helpers.request(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any);
	}
}

/**
 * Unicode-safe Base64 for IFC search export fieldNames (see StreamBIM API docs).
 */
export function b64EncodeUnicodeFieldNames(pipeSeparated: string): string {
	return Buffer.from(
		encodeURIComponent(pipeSeparated).replace(/%([0-9A-F]{2})/g, (_match, p1: string) => {
			return String.fromCharCode(parseInt('0x' + p1, 16));
		}),
		'binary',
	).toString('base64');
}

/** Base64 JSON for checklist export `query` parameter. */
export function b64EncodeJson(obj: IDataObject): string {
	return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}
