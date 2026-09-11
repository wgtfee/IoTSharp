import type { TwinRouteDefinition, TwinRouteEdgeDefinition, TwinRouteSectionDefinition } from '../contracts';

export interface TwinRouteConversionResult {
	route: TwinRouteDefinition;
	convertedPointIds: string[];
	convertedEdgeIds: string[];
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * 将组件生成 Route 转成可编辑 Route。所有运行时 ID、Binding、Section 和几何都原样保留，
 * 只改变 authoring source；ComponentConnectionEngine 在后续自动重建时会优先保留这些同 ID 的 manual override。
 */
export const convertGeneratedRouteToManual = (source: TwinRouteDefinition): TwinRouteConversionResult => {
	const route = clone(source);
	const convertedPointIds: string[] = [];
	const convertedEdgeIds: string[] = [];
	for (const point of route.points) {
		if (point.authoring?.mode === 'manual') continue;
		point.authoring = {
			...(point.authoring || { mode: 'generated' as const }),
			mode: 'manual',
			locked: false,
		};
		convertedPointIds.push(point.pointId);
	}
	for (const edge of route.edges) {
		if (edge.authoring?.mode === 'manual') continue;
		edge.authoring = {
			...(edge.authoring || { mode: 'generated' as const }),
			mode: 'manual',
			locked: false,
			convertedFromGenerated: true,
		};
		convertedEdgeIds.push(edge.edgeId);
	}
	return { route, convertedPointIds, convertedEdgeIds };
};

export const routeHasGeneratedAuthoring = (route: TwinRouteDefinition) =>
	route.points.some((point) => point.authoring?.mode !== 'manual')
	|| route.edges.some((edge) => edge.authoring?.mode !== 'manual');

export const ensureRouteSection = (route: TwinRouteDefinition, name: string, sectionId?: string): TwinRouteSectionDefinition => {
	route.sections ||= [];
	if (sectionId) {
		const existing = route.sections.find((section) => section.sectionId === sectionId);
		if (existing) return existing;
	}
	const stableId = sectionId || `route-section-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
	const section: TwinRouteSectionDefinition = { sectionId: stableId, name: name.trim() || `路线区段 ${route.sections.length + 1}` };
	route.sections.push(section);
	return section;
};

export const renameRouteSection = (route: TwinRouteDefinition, sectionId: string, name: string) => {
	const section = route.sections?.find((item) => item.sectionId === sectionId);
	if (!section) return false;
	section.name = name.trim() || section.name;
	return true;
};

export const assignEdgeToRouteSection = (route: TwinRouteDefinition, edge: TwinRouteEdgeDefinition, sectionId?: string) => {
	if (!sectionId) {
		delete edge.sectionId;
		return true;
	}
	if (!route.sections?.some((section) => section.sectionId === sectionId)) return false;
	edge.sectionId = sectionId;
	return true;
};
