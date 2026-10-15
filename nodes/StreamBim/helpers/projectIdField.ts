import type { INodeProperties } from 'n8n-workflow';

/**
 * Phase 1 v8 helper.
 *
 * Goal: the `Project Name or ID` field should only render for operations that
 * actually need it. The legacy field was always shown and silently ignored by
 * a handful of operations.
 *
 * n8n's `displayOptions` apply AND across keys (so a `hide` block listing
 * resources X/Y and operations A/B hides on the full cartesian product
 * X×{A,B} ∪ Y×{A,B}). Because operation names are shared across resources
 * (`getMany` is used by project, converterJob, topic, etc.), we can't encode
 * the "hide only this specific (resource, op) pair" set in a single
 * INodeProperties entry. Instead we emit one INodeProperties per resource
 * (all sharing the same `name: 'projectId'`) with disjoint `show.resource`
 * filters; n8n only renders one at a time, and the parameter value is
 * preserved across resource changes because the name is the same.
 *
 * Resources requiring per-resource hide rules:
 *
 *   - project:      hide on `getMany` (global projects list — no project id)
 *   - converterJob: hide on `getStatus` (looked up by job ID across projects)
 *   - user:         hide on `get` and `getManyUsers` (global user lookups)
 *
 * All other resources show the field unconditionally.
 */

/**
 * Operations that don't use the project context. Kept for documentation /
 * external reference (e.g. n8n-as-code tooling).
 */
export const PROJECT_ID_HIDDEN_OPERATIONS: string[] = [
	// project.getMany — global projects list
	'getMany',
	// user.get — global user lookup
	'get',
	// user.getManyUsers — global users list
	'getManyUsers',
	// converterJob.getStatus — looked up by job ID across projects
	'getStatus',
];

/**
 * Per-(resource, operation) entries describing where the projectId field
 * should be hidden. Used by `projectIdFields()` to emit one variant per
 * resource group.
 */
const HIDDEN_PAIRS: Record<string, string[]> = {
	project: ['getMany'],
	converterJob: ['getStatus'],
	user: ['get', 'getManyUsers'],
};

/**
 * Resources that need a per-resource projectId field with `hide` rules.
 */
const RESOURCES_WITH_HIDE = Object.keys(HIDDEN_PAIRS);

/**
 * Resources that always show the projectId field. Kept in sync with the
 * resource list declared in `StreamBim.node.ts`.
 */
const RESOURCES_ALWAYS_SHOW = [
	'ifcFile',
	'ifcSearch',
	'sync',
	'workflow',
	'topic',
	'checklist',
	'attachment',
	'document',
	'documentLabel',
	'documentRevision',
	'folder',
	'building',
	'floor',
	'documentAlignment',
	'relink',
];

function makeProjectIdProperty(
	showResources: string[],
	hideOps?: string[],
): INodeProperties {
	const prop: INodeProperties = {
		displayName: 'Project Name or ID',
		name: 'projectId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getProjects',
		},
		default: '',
		description:
			'Project from your StreamBIM account (loaded via the credential Region). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: {
			show: { resource: showResources },
		},
	};
	if (hideOps && hideOps.length > 0) {
		prop.displayOptions!.hide = { operation: hideOps };
	}
	return prop;
}

/**
 * Returns one or more `projectId` INodeProperties variants — one per resource
 * group that needs per-operation hide rules, plus one catch-all for resources
 * that always show the field. n8n renders at most one at a time because the
 * `show.resource` filters are disjoint.
 *
 * The catch-all entry is intentionally listed last so that it never overlaps
 * with the per-resource variants.
 */
export function projectIdFields(): INodeProperties[] {
	const fields: INodeProperties[] = [];
	for (const resource of RESOURCES_WITH_HIDE) {
		fields.push(makeProjectIdProperty([resource], HIDDEN_PAIRS[resource]));
	}
	fields.push(makeProjectIdProperty(RESOURCES_ALWAYS_SHOW));
	return fields;
}

/**
 * Backwards-compatible singular accessor. Returns the first variant (project
 * resource); kept for any external callers that expected a single property.
 *
 * @deprecated Use `projectIdFields()` to get the full set.
 */
export function projectIdField(): INodeProperties {
	return projectIdFields()[0];
}
