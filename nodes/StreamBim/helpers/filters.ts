import type {
	IDataObject,
	IExecuteFunctions,
	INodeProperties,
	INodePropertyOptions,
	NodeParameterValue,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

type DisplayShow = { [key: string]: NodeParameterValue[] };

/**
 * Phase 1 v8 helper.
 *
 * Goal: replace the per-resource "Query Parameters" raw JSON fields with
 * typed Filters fixedCollections that produce `filter[...]` JSON:API keys
 * at runtime, plus an optional raw-JSON escape hatch for power users.
 *
 * Flavors provided:
 *
 * - `filtersField(operations, opts)` — a single fixedCollection with
 *   user-supplied `Name`/`Value` pairs and an optional `Sort` field. The user
 *   can add as many filter rows as needed.
 * - `typedFiltersField(operations, defs, opts)` — a fixedCollection with a
 *   predefined set of typed fields (boolean/string/number/options).
 * - `rawJsonFiltersToggle(operations, opts)` + `rawJsonFiltersField(...)` —
 *   the optional escape hatch when the typed UI is not expressive enough.
 * - `buildFilterQs(typed)` — flatten a `{ name: value }` object to
 *   `{ "filter[name]": value }` (used by resources with locally-built typed
 *   collections, e.g. checklist / attachment).
 * - `fixedCollectionPairsToObject(rows)` — convert `[{name,value}]` rows to
 *   a flat object (used by attachment.uploadToTopic metadata).
 */

export type FixedCollectionFilterEntry = {
	name: string;
	value: string;
};

export type FixedCollectionFilterValues = {
	filter?: FixedCollectionFilterEntry[];
	sort?: string;
};

export type FiltersFieldOpts = {
	/** Restrict display to one or more resources. */
	resource?: string | string[];
	/** Predefined Sort options. When omitted the Sort sub-field is a free string. */
	sortOptions?: INodePropertyOptions[];
	/** When true, includes a "Sort" string field (default true). */
	includeSort?: boolean;
	/** Display name for the field (defaults to "Filters"). */
	displayName?: string;
	/** Property name for the field (defaults to "filters"). */
	name?: string;
	/**
	 * When set, the field is only shown when the toggle parameter (set via
	 * `rawJsonFiltersToggle`) is false.
	 */
	hideWhenRawJson?: boolean;
	/** Name of the raw-JSON toggle parameter (defaults to "useRawJsonFilters"). */
	rawJsonToggleName?: string;
};

/**
 * Returns a `Filters` fixedCollection with generic `name`/`value` rows (the
 * user can add as many rows as needed) plus an optional `sort` sub-field.
 *
 * Two calling forms:
 *   filtersField(operations: string[], opts?: FiltersFieldOpts): INodeProperties
 *   filtersField(config: FiltersFieldConfig): INodeProperties[]   // R4 style
 */
export function filtersField(operations: string[], opts?: FiltersFieldOpts): INodeProperties;
export function filtersField(config: FiltersFieldConfig): INodeProperties[];
export function filtersField(
	first: string[] | FiltersFieldConfig,
	opts?: FiltersFieldOpts,
): INodeProperties | INodeProperties[] {
	if (!Array.isArray(first)) {
		return filtersFieldConfig(first);
	}
	return filtersFieldPositional(first, opts);
}

function filtersFieldPositional(operations: string[], opts?: FiltersFieldOpts): INodeProperties {
	const show: DisplayShow = { operation: operations };
	if (opts?.resource) show.resource = Array.isArray(opts.resource) ? opts.resource : [opts.resource];
	if (opts?.hideWhenRawJson) {
		show[opts.rawJsonToggleName ?? 'useRawJsonFilters'] = [false];
	}

	const innerOptions: Array<{ displayName: string; name: string; values: INodeProperties[] }> = [
		{
			displayName: 'Filter Entry',
			name: 'filter',
			values: [
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					default: '',
					placeholder: 'active',
					description: 'Filter key. Sent as filter[&lt;name&gt;] in the query string.',
				},
				{
					displayName: 'Value',
					name: 'value',
					type: 'string',
					default: '',
					description: 'Filter value (string). For booleans use "true" / "false".',
				},
			],
		},
	];

	if (opts?.includeSort ?? true) {
		innerOptions.push({
			displayName: 'Sort',
			name: 'sortEntry',
			values: [
				opts?.sortOptions
					? {
							displayName: 'Sort',
							name: 'value',
							type: 'options',
							default: '',
							description:
								'Sort key (sent as the JSON:API "sort" parameter). Prefix with "-" for descending.',
							options: [{ name: '— None —', value: '' }, ...opts.sortOptions],
						}
					: {
							displayName: 'Sort',
							name: 'value',
							type: 'string',
							default: '',
							placeholder: '-createdAt',
							description:
								'Sort key (sent as the JSON:API "sort" parameter). Prefix with "-" for descending.',
						},
			],
		});
	}

	return {
		displayName: opts?.displayName ?? 'Filters',
		name: opts?.name ?? 'filters',
		type: 'fixedCollection',
		placeholder: 'Add Filter',
		default: {},
		typeOptions: { multipleValues: true },
		displayOptions: { show },
		options: innerOptions,
	};
}

/**
 * Toggle that switches between the typed Filters UI and a raw JSON escape
 * hatch. Pair with `rawJsonFiltersField` for the JSON input.
 */
export function rawJsonFiltersToggle(
	operations: string[],
	opts?: {
		resource?: string | string[];
		name?: string;
		displayName?: string;
		description?: string;
	},
): INodeProperties {
	const show: DisplayShow = { operation: operations };
	if (opts?.resource) show.resource = Array.isArray(opts.resource) ? opts.resource : [opts.resource];
	return {
		displayName: opts?.displayName ?? 'Advanced — Use Raw JSON Query',
		name: opts?.name ?? 'useRawJsonFilters',
		type: 'boolean',
		default: false,
		description:
			opts?.description ??
			'Whether to provide query parameters as a raw JSON object (escape hatch for filters not expressible in the Filters UI)',
		displayOptions: { show },
	};
}

/**
 * Raw-JSON input shown when the toggle is true. Returns a JSON node property.
 */
export function rawJsonFiltersField(
	operations: string[],
	opts?: {
		resource?: string | string[];
		name?: string;
		displayName?: string;
		toggleName?: string;
		defaultValue?: string;
		description?: string;
	},
): INodeProperties {
	const show: DisplayShow = { operation: operations };
	if (opts?.resource) show.resource = Array.isArray(opts.resource) ? opts.resource : [opts.resource];
	show[opts?.toggleName ?? 'useRawJsonFilters'] = [true];
	const prop: INodeProperties = {
		displayName: opts?.displayName ?? 'Query Parameters (Raw JSON)',
		name: opts?.name ?? 'rawJsonFilters',
		type: 'json',
		default: '{}\n',
		description:
			opts?.description ??
			'JSON object merged into the query string. Used only when "Use Raw JSON Query" is on.',
		displayOptions: { show },
	};
	if (opts?.defaultValue !== undefined) prop.default = opts.defaultValue;
	return prop;
}

/**
 * Turn fixedCollection values into `{ "filter[name]": value, sort: "..." }`.
 *
 * Empty entries (missing name) are skipped silently. Reads both the inline
 * `sort` shape and the `sortEntry: { value }` shape produced by the
 * fixedCollection variant of `filtersField`.
 */
export function buildFilters(
	values:
		| (FixedCollectionFilterValues & { sortEntry?: { value?: string } | Array<{ value?: string }> })
		| undefined,
): IDataObject {
	const result: IDataObject = {};
	if (!values) return result;
	const rows = Array.isArray(values.filter) ? values.filter : [];
	for (const entry of rows) {
		if (!entry || typeof entry.name !== 'string') continue;
		const name = entry.name.trim();
		if (!name) continue;
		result[`filter[${name}]`] = entry.value ?? '';
	}
	const sortDirect = values.sort;
	if (typeof sortDirect === 'string' && sortDirect.trim()) {
		result.sort = sortDirect.trim();
	}
	const sortEntry = values.sortEntry;
	if (sortEntry) {
		const sortValue = Array.isArray(sortEntry)
			? sortEntry[0]?.value
			: (sortEntry as { value?: string }).value;
		if (typeof sortValue === 'string' && sortValue.trim()) {
			result.sort = sortValue.trim();
		}
	}
	return result;
}

export type TypedFilterDef = {
	/** Filter key (sent as `filter[<name>]`). */
	name: string;
	/** Display name shown in the UI. */
	displayName: string;
	/** Field type. */
	type: 'string' | 'boolean' | 'number' | 'options';
	/** Default value. */
	default?: unknown;
	/** Options when `type === 'options'`. */
	options?: INodePropertyOptions[];
	/** Help text. */
	description?: string;
	/** Placeholder. */
	placeholder?: string;
};

/**
 * Returns a `Filters` fixedCollection with a single inner sub-collection
 * (`filter`) whose values are a fixed set of typed fields plus an optional
 * `sort` field. Each filter is sent as `filter[<name>]` at runtime.
 *
 * Unlike `filtersField`, the set of filter keys is predefined and cannot be
 * extended in the UI. Use this for resources where the filter surface is
 * known up-front (e.g. project: active/name/region).
 *
 * Parameter shape returned by n8n: `{ filter: { active?: bool, name?: str, ...sort? } }`.
 */
export function typedFiltersField(
	operations: string[],
	defs: TypedFilterDef[],
	opts?: FiltersFieldOpts,
): INodeProperties {
	const show: DisplayShow = { operation: operations };
	if (opts?.resource) show.resource = Array.isArray(opts.resource) ? opts.resource : [opts.resource];
	if (opts?.hideWhenRawJson) {
		show[opts.rawJsonToggleName ?? 'useRawJsonFilters'] = [false];
	}

	const values: INodeProperties[] = defs.map((def) => {
		const fallbackDefault =
			def.type === 'boolean' ? false : def.type === 'number' ? 0 : '';
		const prop: INodeProperties = {
			displayName: def.displayName,
			name: def.name,
			type: def.type,
			default: (def.default ?? fallbackDefault) as NodeParameterValue,
		};
		if (def.description) prop.description = def.description;
		if (def.placeholder) prop.placeholder = def.placeholder;
		if (def.type === 'options' && def.options) prop.options = def.options;
		return prop;
	});

	if (opts?.includeSort ?? true) {
		values.push(
			opts?.sortOptions
				? {
						displayName: 'Sort',
						name: 'sort',
						type: 'options',
						default: '',
						description:
							'Sort key (sent as the JSON:API "sort" parameter). Prefix with "-" for descending.',
						options: [{ name: '— None —', value: '' }, ...opts.sortOptions],
					}
				: {
						displayName: 'Sort',
						name: 'sort',
						type: 'string',
						default: '',
						placeholder: '-createdAt',
						description:
							'Sort key (sent as the JSON:API "sort" parameter). Prefix with "-" for descending.',
					},
		);
	}

	return {
		displayName: opts?.displayName ?? 'Filters',
		name: opts?.name ?? 'filters',
		type: 'fixedCollection',
		placeholder: 'Add Filters',
		default: {},
		typeOptions: { multipleValues: false },
		displayOptions: { show },
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				values,
			},
		],
	};
}

/**
 * Build a query-string IDataObject from typed-filter values.
 *
 * Two calling forms are supported:
 *
 * - `buildTypedFilters(values)` — no `defs`. Walks every key in `values` (or
 *   `values.filter` when wrapped by a fixedCollection) and emits
 *   `filter[<name>]=value`. Used by R3-style typed `collection`s.
 * - `buildTypedFilters(values, defs)` — with `defs`. Only emits keys listed in
 *   `defs`, with per-type coercion (booleans → "true"/"false"). Used by
 *   `typedFiltersField`.
 *
 * In both forms, the `sort` key is passed through, and arrays are joined with
 * a comma. Empty / undefined values are skipped.
 */
export function buildTypedFilters(
	values: IDataObject | undefined,
	defs?: TypedFilterDef[],
): IDataObject {
	const result: IDataObject = {};
	if (!values) return result;
	const inner = (values.filter && typeof values.filter === 'object' && !Array.isArray(values.filter)
		? (values.filter as IDataObject)
		: values) as IDataObject;

	if (defs) {
		for (const def of defs) {
			const value = inner[def.name];
			if (value === undefined || value === null || value === '') continue;
			if (def.type === 'boolean') {
				result[`filter[${def.name}]`] = value ? 'true' : 'false';
			} else {
				result[`filter[${def.name}]`] = value as IDataObject[string];
			}
		}
	} else {
		for (const [name, value] of Object.entries(inner)) {
			if (name === 'sort') continue;
			if (value === undefined || value === null) continue;
			if (typeof value === 'string' && value.trim() === '') continue;
			if (Array.isArray(value)) {
				if (value.length === 0) continue;
				result[`filter[${name}]`] = value.join(',');
			} else if (typeof value === 'boolean') {
				result[`filter[${name}]`] = value ? 'true' : 'false';
			} else {
				result[`filter[${name}]`] = value as IDataObject[string];
			}
		}
	}

	const sort = inner.sort;
	if (typeof sort === 'string' && sort.trim()) result.sort = sort.trim();
	return result;
}

/**
 * Reads the Filters field as built by `filtersField` plus the optional raw
 * JSON escape hatch, and returns a merged `IDataObject` of query-string keys.
 *
 * Raw JSON wins over the typed UI when the toggle is true.
 */
export function readFiltersQueryString(
	ctx: IExecuteFunctions,
	i: number,
	opts?: {
		filtersName?: string;
		toggleName?: string;
		rawJsonName?: string;
	},
): IDataObject {
	const filtersName = opts?.filtersName ?? 'filters';
	const toggleName = opts?.toggleName ?? 'useRawJsonFilters';
	const rawJsonName = opts?.rawJsonName ?? 'rawJsonFilters';

	const useRaw = ctx.getNodeParameter(toggleName, i, false) as boolean;
	if (useRaw) {
		const raw = ctx.getNodeParameter(rawJsonName, i, '') as string;
		if (!raw || !raw.trim()) return {};
		try {
			return JSON.parse(raw) as IDataObject;
		} catch {
			throw new NodeOperationError(ctx.getNode(), 'Query parameters must be valid JSON', {
				itemIndex: i,
			});
		}
	}
	const values = ctx.getNodeParameter(filtersName, i, {}) as FixedCollectionFilterValues;
	return buildFilters(values);
}

// ── R4-style config-object API ──────────────────────────────────────────
// R4 (user) and other parallel branches use a config-object form. We expose
// these as additional exports so resources using either style coexist.

export type FilterFieldOption = {
	name: string;
	displayName: string;
	description?: string;
};

export type FiltersFieldConfig = {
	operations: string[];
	resources?: string[];
	options?: FilterFieldOption[];
	includeSort?: boolean;
	name?: string;
	sortName?: string;
};

/** R4-style filters builder: emits a typed dropdown of `Filter Name` options. */
export function filtersFieldConfig(config: FiltersFieldConfig): INodeProperties[] {
	const options = config.options ?? [];
	const filtersName = config.name ?? 'filters';
	const sortName = config.sortName ?? `${filtersName}Sort`;
	const showBase: IDataObject = { operation: config.operations };
	if (config.resources) showBase.resource = config.resources;

	const filterNameValues: INodeProperties =
		options.length > 0
			? {
					displayName: 'Filter Name or ID',
					name: 'name',
					type: 'options',
					default: '',
					options: options.map((o) => ({
						name: o.displayName,
						value: o.name,
						description: o.description,
					})),
					description:
						'Which filter key to apply (mapped to filter[name] in the JSON:API query). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				}
			: {
					displayName: 'Filter Name',
					name: 'name',
					type: 'string',
					default: '',
					description: 'Filter key (without the `filter[]` wrapper)',
				};

	const filtersProp: INodeProperties = {
		displayName: 'Filters',
		name: filtersName,
		type: 'fixedCollection',
		placeholder: 'Add Filter',
		typeOptions: { multipleValues: true },
		default: {},
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				values: [
					filterNameValues,
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Filter value (passed verbatim as the JSON:API filter[name] value)',
					},
				],
			},
		],
		displayOptions: { show: showBase } as unknown as INodeProperties['displayOptions'],
		description: 'Typed filters expanded to filter[name]=value in the request query string',
	};

	const props: INodeProperties[] = [filtersProp];
	if (config.includeSort !== false) {
		props.push({
			displayName: 'Sort',
			name: sortName,
			type: 'string',
			default: '',
			placeholder: '-created-at',
			description:
				'JSON:API sort string (e.g. "name" or "-created-at"). Prefix with "-" for descending.',
			displayOptions: { show: showBase } as unknown as INodeProperties['displayOptions'],
		});
	}
	return props;
}

/** R4-style raw-JSON escape hatch toggle + JSON body. */
export function rawQueryEscapeHatch(config: {
	operations: string[];
	resources?: string[];
	toggleName?: string;
	jsonName?: string;
	description?: string;
}): INodeProperties[] {
	const toggleName = config.toggleName ?? 'useRawQueryJson';
	const jsonName = config.jsonName ?? 'rawQueryJson';
	const showBase: IDataObject = { operation: config.operations };
	if (config.resources) showBase.resource = config.resources;
	const showWithToggle: IDataObject = { ...showBase, [toggleName]: [true] };
	return [
		{
			displayName: 'Advanced — Use Raw JSON Query Parameters',
			name: toggleName,
			type: 'boolean',
			default: false,
			description:
				config.description ??
				'Whether to ignore the Filters above and send a raw JSON object as the request query string',
			displayOptions: { show: showBase } as unknown as INodeProperties['displayOptions'],
		},
		{
			displayName: 'Query Parameters (Raw JSON)',
			name: jsonName,
			type: 'json',
			default: '{}\n',
			description:
				'Raw JSON object sent as the request query string. Used only when the toggle above is on.',
			displayOptions: { show: showWithToggle } as unknown as INodeProperties['displayOptions'],
		},
	];
}

/** R4-style filter query reader. */
export function getFiltersQuery(
	ctx: IExecuteFunctions,
	filtersName: string,
	itemIndex: number,
	sortName?: string,
): IDataObject {
	const raw = ctx.getNodeParameter(filtersName, itemIndex, {}) as
		| { filter?: unknown }
		| undefined;
	const normalized: FixedCollectionFilterValues = {};
	if (raw && typeof raw === 'object' && Array.isArray((raw as IDataObject).filter)) {
		normalized.filter = ((raw as IDataObject).filter as IDataObject[]).map((e) => ({
			name: String(e.name ?? ''),
			value: String(e.value ?? ''),
		}));
	}
	if (sortName) {
		const sortValue = ctx.getNodeParameter(sortName, itemIndex, '') as string;
		if (typeof sortValue === 'string' && sortValue.trim()) {
			normalized.sort = sortValue;
		}
	}
	return buildFilters(normalized);
}

/** R4-style raw-JSON parser. */
export function parseRawQueryJson(
	ctx: IExecuteFunctions,
	raw: string,
	itemIndex: number,
): IDataObject {
	if (!raw || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new NodeOperationError(
				ctx.getNode(),
				'Query Parameters (Raw JSON) must be a JSON object, e.g. {"filter[email]":"alice"}',
				{ itemIndex },
			);
		}
		return parsed as IDataObject;
	} catch (err) {
		if (err instanceof NodeOperationError) throw err;
		throw new NodeOperationError(ctx.getNode(), 'Query Parameters (Raw JSON) must be valid JSON', {
			itemIndex,
		});
	}
}

/**
 * v8 helper: take a typed filter map (e.g. `{ isDraft: false, parentTopic: '1234' }`)
 * and emit a JSON:API query string object with `filter[<name>]` keys.
 *
 * Skips entries that are `undefined`, `null`, or an empty string. Boolean
 * `false` is preserved (important for `filter[isDraft]=false`).
 */
export function buildFilterQs(typed: Record<string, unknown>): IDataObject {
	const out: IDataObject = {};
	for (const [name, value] of Object.entries(typed)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.trim() === '') continue;
		out[`filter[${name}]`] = value as IDataObject[string];
	}
	return out;
}

/**
 * v8 helper: turn a fixedCollection of `{ name, value }` rows into a flat
 * `Record<string, string>`. Used by attachment.uploadToTopic to build the
 * `metadata` object from key/value pairs.
 *
 * Empty names are skipped. Later duplicates override earlier ones.
 */
export function fixedCollectionPairsToObject(
	rows: Array<{ name?: string; value?: string }> | undefined,
): IDataObject {
	const out: IDataObject = {};
	if (!rows) return out;
	for (const row of rows) {
		const name = (row?.name ?? '').trim();
		if (!name) continue;
		out[name] = row.value ?? '';
	}
	return out;
}
