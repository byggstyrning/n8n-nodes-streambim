import * as http from 'http';
import * as https from 'https';
import type { Readable } from 'stream';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	streamBimJsonApiGetMany,
	streamBimJsonApiRequest,
	streamBimS3Put,
	type StreamBimTokenCache,
} from './GenericFunctions';
import {
	buildJsonApiBody,
	pruneEmpty,
	relationshipRef,
} from '../StreamBim/helpers/jsonApiBody';

const FOLDER_LIST_PAGINATION = {
	mode: 'all' as const,
	pageLimit: 500,
	pageSkip: 0,
	maxPages: 5000,
};

export type StreamBimUploadTicketResult = {
	uploadTicketId: string;
	presignedUrl: string;
};

export async function createUploadTicket(
	ctx: IExecuteFunctions,
	projectId: string,
	filename: string,
	fileSize: number,
	tokenCache: StreamBimTokenCache,
): Promise<StreamBimUploadTicketResult> {
	const ticketBody: IDataObject = {
		data: {
			id: '0',
			type: 'attachments',
			attributes: {
				filename,
				'file-size': fileSize,
			},
		},
	};

	const ticketResponse = (await streamBimJsonApiRequest.call(
		ctx,
		'POST',
		`/project-${projectId}/api/v1/v2/upload-tickets`,
		tokenCache,
		ticketBody,
		{},
	)) as IDataObject;

	const data = ticketResponse.data as IDataObject | undefined;
	const attrs = data?.attributes as IDataObject | undefined;
	const uploadTicketId = data?.id as string | undefined;
	const presignedUrl = attrs?.s3presignedurl as string | undefined;
	if (!uploadTicketId || !presignedUrl) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Upload ticket response missing id or s3presignedurl',
		);
	}

	return { uploadTicketId, presignedUrl };
}

export async function uploadBufferToS3(
	ctx: IExecuteFunctions,
	presignedUrl: string,
	body: Buffer | Readable,
	fileSize: number,
	mimeType: string,
): Promise<void> {
	await streamBimS3Put.call(ctx, presignedUrl, body, fileSize, mimeType);
}

/** A file to upload that is fetched from a URL (e.g. a signed download URL) during the upload. */
export type UrlUploadSource = { sourceUrl: string };

function isUrlUploadSource(body: Buffer | Readable | UrlUploadSource): body is UrlUploadSource {
	return typeof (body as UrlUploadSource).sourceUrl === 'string';
}

const URL_UPLOAD_MAX_REDIRECTS = 5;
const URL_UPLOAD_IDLE_TIMEOUT_MS = 120_000; // a stalled source or target fails instead of hanging the run

function httpModule(url: string): typeof https | typeof http {
	return url.startsWith('https:') ? https : http;
}

function getSourceStream(
	ctx: IExecuteFunctions,
	url: string,
	redirectsLeft: number,
): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = httpModule(url).get(url, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				if (redirectsLeft <= 0) {
					reject(new NodeOperationError(ctx.getNode(), 'Source URL redirected too many times'));
					return;
				}
				const next = new URL(res.headers.location, url).toString();
				getSourceStream(ctx, next, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(
					new NodeOperationError(
						ctx.getNode(),
						`Source URL answered HTTP ${status}; a signed URL may have expired. Get a new one and run again.`,
					),
				);
				return;
			}
			resolve(res);
		});
		req.setTimeout(URL_UPLOAD_IDLE_TIMEOUT_MS, () =>
			req.destroy(new Error('Source URL did not answer in time')),
		);
		req.on('error', reject);
	});
}

/**
 * Pipe a file from a source URL straight into the upload ticket's presigned S3 PUT. Nothing is
 * written to n8n's binary store or held whole in memory: a 1.3 GB IFC went through with ~110 MB
 * peak RSS. Uses Node's http(s) directly so the body is known to be streamed end to end.
 * S3 refuses a chunked PUT to a presigned URL, so the size must be known up front; a source
 * that sends another number of bytes fails the upload rather than storing a truncated file.
 */
export async function streamUrlToS3(
	ctx: IExecuteFunctions,
	sourceUrl: string,
	presignedUrl: string,
	fileSize: number,
	mimeType: string,
): Promise<void> {
	const src = await getSourceStream(ctx, sourceUrl, URL_UPLOAD_MAX_REDIRECTS);

	const announced = Number(src.headers['content-length']);
	if (Number.isFinite(announced) && announced !== fileSize) {
		src.destroy();
		throw new NodeOperationError(
			ctx.getNode(),
			`Source URL serves ${announced} bytes but File Size says ${fileSize}. The source file changed or the size is wrong; nothing was uploaded.`,
		);
	}

	let streamed = 0;

	const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
		const put = httpModule(presignedUrl).request(
			presignedUrl,
			{
				method: 'PUT',
				headers: { 'Content-Type': mimeType, 'Content-Length': fileSize },
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (c: string) => {
					if (text.length < 1000) text += c;
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
				res.on('error', reject);
			},
		);
		put.setTimeout(URL_UPLOAD_IDLE_TIMEOUT_MS, () =>
			put.destroy(new Error('StreamBIM storage stopped accepting data')),
		);
		put.on('error', reject);
		// A source that ends early (or runs long) must abort the PUT at once: otherwise the
		// storage side keeps waiting for the promised Content-Length until a timeout.
		src.on('data', (chunk: Buffer) => {
			streamed += chunk.length;
			if (streamed > fileSize) put.destroy(new Error('source sent more bytes than File Size'));
		});
		src.on('end', () => {
			if (streamed < fileSize) put.destroy(new Error('source ended early'));
		});
		src.on('error', (e) => put.destroy(e));
		src.pipe(put);
	}).catch((e: Error) => {
		src.destroy();
		throw new NodeOperationError(
			ctx.getNode(),
			`Streaming the source URL into StreamBIM failed after ${streamed} of ${fileSize} bytes: ${e.message}`,
		);
	});

	if (status < 200 || status >= 300) {
		src.destroy();
		throw new NodeOperationError(
			ctx.getNode(),
			`StreamBIM storage refused the upload (HTTP ${status}) after ${streamed} of ${fileSize} bytes: ${body.slice(0, 300)}`,
		);
	}
	if (streamed !== fileSize) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Source URL delivered ${streamed} bytes, expected ${fileSize}. The upload is incomplete; run again.`,
		);
	}
}

function documentFilename(doc: IDataObject): string {
	const attrs = doc.attributes as IDataObject | undefined;
	return String(attrs?.filename ?? '').trim();
}

function documentRevisionCount(doc: IDataObject): number {
	const attrs = doc.attributes as IDataObject | undefined;
	const numRevisions = attrs?.['num-revisions'];
	if (typeof numRevisions === 'number' && Number.isFinite(numRevisions)) {
		return numRevisions;
	}
	const revision = attrs?.revision;
	if (typeof revision === 'number' && Number.isFinite(revision)) {
		return revision;
	}
	return 1;
}

function documentParentFolderId(doc: IDataObject): string {
	const relationships = doc.relationships as IDataObject | undefined;
	const parent = relationships?.parent as IDataObject | undefined;
	const data = parent?.data as IDataObject | undefined;
	return String(data?.id ?? '').trim();
}

function documentIsDeleted(doc: IDataObject): boolean {
	const attrs = doc.attributes as IDataObject | undefined;
	return attrs?.['is-deleted'] === true;
}

export async function findDocumentInFolder(
	ctx: IExecuteFunctions,
	projectId: string,
	folderId: string,
	filename: string,
	tokenCache: StreamBimTokenCache,
): Promise<IDataObject | null> {
	const targetFolderId = String(folderId).trim();
	if (!targetFolderId) {
		throw new NodeOperationError(ctx.getNode(), 'Folder ID is required for document lookup');
	}

	const base = `/project-${projectId}/api/v1/v2/documents`;
	const response = (await streamBimJsonApiGetMany.call(
		ctx,
		base,
		tokenCache,
		{
			'filter[folderId]': targetFolderId,
			'filter[freetext]': filename,
		},
		FOLDER_LIST_PAGINATION,
	)) as IDataObject;

	const docs = Array.isArray(response.data) ? (response.data as IDataObject[]) : [];
	for (const doc of docs) {
		if (documentIsDeleted(doc)) continue;
		if (documentFilename(doc) !== filename) continue;
		if (documentParentFolderId(doc) !== targetFolderId) continue;
		return doc;
	}
	return null;
}

export type DocumentUploadResult = {
	action: 'created' | 'revised';
	documentId: string;
	revisionId: string;
	revision: number;
	filename: string;
	folderId: string;
	filesize: number;
};

export async function uploadDocumentToFolder(
	ctx: IExecuteFunctions,
	projectId: string,
	folderId: string,
	filename: string,
	body: Buffer | Readable | UrlUploadSource,
	fileSize: number,
	mimeType: string,
	tokenCache: StreamBimTokenCache,
	opts?: { description?: string; externalId?: string },
): Promise<DocumentUploadResult> {
	const existing = await findDocumentInFolder(ctx, projectId, folderId, filename, tokenCache);

	const { uploadTicketId, presignedUrl } = await createUploadTicket(
		ctx,
		projectId,
		filename,
		fileSize,
		tokenCache,
	);
	// A URL source is opened only now, right before the PUT, so a short-lived signed URL is
	// not left idle while the folder is searched and the ticket created.
	if (isUrlUploadSource(body)) {
		await streamUrlToS3(ctx, body.sourceUrl, presignedUrl, fileSize, mimeType);
	} else {
		await uploadBufferToS3(ctx, presignedUrl, body, fileSize, mimeType);
	}

	const description = opts?.description ?? '';
	const externalId = opts?.externalId?.trim();

	if (existing) {
		const documentId = String(existing.id ?? '').trim();
		if (!documentId) {
			throw new NodeOperationError(ctx.getNode(), 'Matched document is missing an id');
		}
		const nextRevision = documentRevisionCount(existing) + 1;
		const revisionId = `${documentId}-${nextRevision}`;

		const revisionBody = buildJsonApiBody({
			type: 'document-revisions',
			id: revisionId,
			attributes: pruneEmpty({ description, filesize: fileSize }),
			relationships: {
				'upload-ticket': relationshipRef('upload-tickets', uploadTicketId),
			},
		});

		await streamBimJsonApiRequest.call(
			ctx,
			'POST',
			`/project-${projectId}/api/v1/v2/document-revisions`,
			tokenCache,
			revisionBody,
			{},
		);

		return {
			action: 'revised',
			documentId,
			revisionId,
			revision: nextRevision,
			filename,
			folderId,
			filesize: fileSize,
		};
	}

	const createAttributes: IDataObject = {
		filename,
		description,
		filesize: fileSize,
	};
	if (externalId) {
		createAttributes['external-id'] = externalId;
	}

	const createBody = buildJsonApiBody({
		type: 'documents',
		id: '0',
		attributes: createAttributes,
		relationships: {
			labels: { data: [] },
			parent: relationshipRef('folders', folderId),
			'upload-ticket': relationshipRef('upload-tickets', uploadTicketId),
		},
	});

	const createResponse = (await streamBimJsonApiRequest.call(
		ctx,
		'POST',
		`/project-${projectId}/api/v1/v2/documents`,
		tokenCache,
		createBody,
		{},
	)) as IDataObject;

	const created = createResponse.data as IDataObject | undefined;
	const documentId = String(created?.id ?? '').trim();
	if (!documentId) {
		throw new NodeOperationError(ctx.getNode(), 'Document create response missing id');
	}

	const revision = documentRevisionCount(created ?? {});

	return {
		action: 'created',
		documentId,
		revisionId: `${documentId}-${revision}`,
		revision,
		filename,
		folderId,
		filesize: fileSize,
	};
}

export type BinaryUploadSource = {
	/** A Readable when the binary is stored on disk (filesystem mode), else a Buffer. */
	body: Buffer | Readable;
	fileSize: number;
	filename: string;
	mimeType: string;
};

/**
 * Resolve the binary payload for upload without loading it fully into memory
 * when we don't have to. When the binary lives in n8n's binary-data store
 * (filesystem mode gives it an `id`), we read its size from metadata and return
 * a `Readable` stream so the S3 PUT can pipe disk → StreamBIM without ever
 * materialising the whole file (a 143 MB IFC otherwise costs ~143 MB heap here,
 * on top of the base64 copy). Falls back to a full Buffer for in-memory binaries
 * (no `id`), preserving the previous behaviour.
 */
export async function readBinaryForUpload(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	itemIndex: number,
	binaryPropertyName: string,
	filenameOverride?: string,
): Promise<BinaryUploadSource> {
	const item = items[itemIndex];
	if (!item.binary?.[binaryPropertyName]) {
		throw new NodeOperationError(
			ctx.getNode(),
			`No binary data in property "${binaryPropertyName}"`,
			{ itemIndex },
		);
	}
	const bin = item.binary[binaryPropertyName];
	const filename = (filenameOverride ?? bin.fileName ?? 'upload.bin').trim();
	if (!filename) {
		throw new NodeOperationError(ctx.getNode(), 'Filename is required for upload', {
			itemIndex,
		});
	}
	const mimeType = bin.mimeType ?? 'application/octet-stream';

	if (bin.id) {
		const metadata = await ctx.helpers.getBinaryMetadata(bin.id);
		const body = await ctx.helpers.getBinaryStream(bin.id);
		return { body, fileSize: metadata.fileSize, filename, mimeType };
	}

	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	return { body: buffer, fileSize: buffer.length, filename, mimeType };
}
