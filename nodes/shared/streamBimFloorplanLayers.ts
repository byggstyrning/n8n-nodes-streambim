import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import {
	distinctLayerTokensFromIfcFileRows,
	fetchStreamBimIfcFileRows,
} from './streamBimIfcFiles';

/**
 * Distinct IFC model layer names for the selected building (ifc-files `layer` attribute).
 * Used by Converter Job → Create → Floorplan Layer.
 *
 * @see GET /project-{projectId}/api/v1/v2/ifc-files?filter[building]={buildingId}
 */
export async function loadStreamBimFloorplanLayerOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const projectId = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
	const buildingId = String(this.getCurrentNodeParameter('buildingId') ?? '').trim();
	if (!projectId || !buildingId) {
		return [];
	}

	const rows = await fetchStreamBimIfcFileRows(this, projectId, buildingId);
	return distinctLayerTokensFromIfcFileRows(rows).map((layer) => ({
		name: layer,
		value: layer,
	}));
}
