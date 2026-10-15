import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { streamBimJsonApiRequest, type StreamBimTokenCache } from './GenericFunctions';

type StreamBimProjectMemberRow = {
	id?: string;
	attributes?: {
		'privilege-level'?: number;
		'given-name'?: string;
		'family-name'?: string;
		invited?: boolean;
		guest?: boolean;
	} & IDataObject;
	relationships?: {
		user?: { data?: { id?: string } };
	};
};

const PRIVILEGE_LABELS: Record<number, string> = {
	0: 'Inactive',
	5: 'Guest',
	10: 'User',
	15: 'Workflows admin',
	20: 'Project admin',
	25: 'Customer admin',
	30: 'Owner',
};

function memberLabel(row: StreamBimProjectMemberRow): string {
	const attrs = row.attributes ?? {};
	const relUserId = row.relationships?.user?.data?.id;
	const given = String(attrs['given-name'] ?? '').trim();
	const family = String(attrs['family-name'] ?? '').trim();
	const name = [given, family].filter(Boolean).join(' ').trim();
	const email = relUserId ? String(relUserId) : '';
	const level = attrs['privilege-level'];
	const levelLabel =
		typeof level === 'number' ? (PRIVILEGE_LABELS[level] ?? `Level ${level}`) : 'Unknown level';
	const who = name || email || String(row.id ?? 'Member');
	return `${who} — ${levelLabel}`;
}

/**
 * Lists project members for the selected project.
 * Endpoint: GET /project-{projectId}/api/v1/v2/project-members
 */
export async function loadStreamBimProjectMemberOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	if (!projectId) {
		return [];
	}

	const credentials = await this.getCredentials('streamBimApi');
	const regionSubdomain = ((credentials.environment as string) || 'app').trim() || 'app';
	const tokenCache: StreamBimTokenCache = { regionSubdomain };

	const response = (await streamBimJsonApiRequest.call(
		this,
		'GET',
		`/project-${encodeURIComponent(projectId)}/api/v1/v2/project-members`,
		tokenCache,
		undefined,
		{
			'page[limit]': 500,
			'page[skip]': 0,
		},
	)) as IDataObject;

	const rows = (response.data as StreamBimProjectMemberRow[]) ?? [];
	return rows
		.filter((row) => {
			const level = row.attributes?.['privilege-level'];
			return typeof level !== 'number' || level !== 0;
		})
		.map((row) => {
			const id = String(row.id ?? '');
			return {
				name: `${memberLabel(row)} (${id})`,
				value: id,
			};
		});
}

/**
 * Project member IDs use `{projectId}-{userEmail}` (user id is the email).
 */
export function projectMemberUserIdFromMemberId(projectId: string, projectMemberId: string): string {
	const prefix = `${projectId}-`;
	if (!projectMemberId.startsWith(prefix)) {
		throw new Error(
			`Project member ID "${projectMemberId}" does not match project ${projectId} (expected prefix "${prefix}")`,
		);
	}
	const userId = projectMemberId.slice(prefix.length);
	if (!userId) {
		throw new Error(`Project member ID "${projectMemberId}" is missing the user email suffix`);
	}
	return userId;
}
