import type { IHttpRequestOptions, INodePropertyOptions } from 'n8n-workflow';

const REGIONS_JSON_URL = 'https://global.streambim.com/regions.json';

/** Subdomains not offered in the UI (non-production). */
const HIDDEN_SUBDOMAINS = new Set(['staging', 'dev']);

export type StreamBimRegion = {
	subdomain: string;
	title?: string;
	isDefault?: boolean;
};

type RegionsPayload = { regions?: StreamBimRegion[] };

type HttpRequestFn = (options: IHttpRequestOptions) => Promise<unknown>;

/**
 * Loads region subdomains from StreamBIM global regions API for dropdowns.
 */
export async function loadStreamBimRegionOptions(httpRequest: HttpRequestFn): Promise<INodePropertyOptions[]> {
	const data = (await httpRequest({
		method: 'GET',
		url: REGIONS_JSON_URL,
		json: true,
	})) as RegionsPayload;

	const regions = (data.regions ?? []).filter((r) => r.subdomain && !HIDDEN_SUBDOMAINS.has(r.subdomain));

	const sorted = [...regions].sort((a, b) => {
		if (a.isDefault && !b.isDefault) return -1;
		if (!a.isDefault && b.isDefault) return 1;
		return a.subdomain.localeCompare(b.subdomain);
	});

	return sorted.map((r) => ({
		name: r.subdomain,
		value: r.subdomain,
	}));
}
