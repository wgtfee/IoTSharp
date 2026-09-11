import { cloneTwinManifest, normalizeTwinRoute, type TwinCompiledRouteGraphDefinition, type TwinRouteDefinition, type TwinSceneManifest } from '../contracts';

export type TwinRouteAuthoringDiagnosticSeverity = 'error' | 'warning';
export interface TwinRouteAuthoringDiagnostic {
	severity: TwinRouteAuthoringDiagnosticSeverity;
	code: string;
	message: string;
	routeId: string;
	pointId?: string;
	edgeId?: string;
}

export interface TwinRouteSourceMapEntry {
	runtimeEdgeId: string;
	authoringMode: 'generated' | 'manual';
	sourceRouteId?: string;
	objectId?: string;
	internalFlowId?: string;
	manualEdgeId?: string;
}

export interface TwinRouteAuthoringCompileResult {
	routes: TwinRouteDefinition[];
	diagnostics: TwinRouteAuthoringDiagnostic[];
	sourceMap: TwinRouteSourceMapEntry[];
	routeAliases: Record<string, string>;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * 双路线设计的统一编译/归一入口。这里只处理设计来源、拓扑完整性和 SourceMap；
 * 输出仍然是现有 TwinRouteDefinition，RouteEngine/RouteSlotArrayRuntime 不需要第二套运行时。
 */
export const compileRouteAuthoringGraph = (sourceRoutes: TwinRouteDefinition[]): TwinRouteAuthoringCompileResult => {
	const sourceRouteByEdgeId = new Map(sourceRoutes.flatMap((route) => route.edges.map((edge) => [edge.edgeId, route.routeId] as const)));
	let routes = sourceRoutes.map((route) => normalizeTwinRoute(clone(route)));
	const diagnostics: TwinRouteAuthoringDiagnostic[] = [];
	const sourceMap: TwinRouteSourceMapEntry[] = [];
	const routeAliases: Record<string, string> = {};

	// 先按 hard Port Attachment 合并原本分属不同 Component Network 的 authoring routes。
	// 合并后的 routeId 使用输入顺序中最前面的 routeId，所有旧 routeId 都记录 alias，
	// 以便 Runtime pallet initializer / routeSlotArray Binding 做稳定迁移。
	const parent = routes.map((_, index) => index);
	const find = (value: number): number => parent[value] === value ? value : (parent[value] = find(parent[value]));
	const union = (left: number, right: number) => { const a = find(left), b = find(right); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
	const generatedPortOwner = new Map<string, number>();
	for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) for (const point of routes[routeIndex].points) {
		if (point.authoring?.mode === 'manual') continue;
		const objectId = point.authoring?.sourceObjectId || point.componentObjectId;
		const portId = point.authoring?.sourcePortId || point.componentPortId;
		if (objectId && portId && !generatedPortOwner.has(`${objectId}::${portId}`)) generatedPortOwner.set(`${objectId}::${portId}`, routeIndex);
	}
	for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) for (const point of routes[routeIndex].points) {
		if (point.authoring?.mode !== 'manual' || !point.attachment || point.attachment.snapMode !== 'hard') continue;
		const owner = generatedPortOwner.get(`${point.attachment.objectId}::${point.attachment.portId}`);
		if (owner !== undefined) union(routeIndex, owner);
	}
	const groupedIndexes = new Map<number, number[]>();
	for (let index = 0; index < routes.length; index += 1) groupedIndexes.set(find(index), [...(groupedIndexes.get(find(index)) || []), index]);
	if ([...groupedIndexes.values()].some((items) => items.length > 1)) {
		const merged: TwinRouteDefinition[] = [];
		for (const indexes of [...groupedIndexes.values()].sort((a, b) => a[0] - b[0])) {
			const base = clone(routes[indexes[0]]);
			routeAliases[base.routeId] = base.routeId;
			for (const index of indexes.slice(1)) {
				const extra = routes[index];
				routeAliases[extra.routeId] = base.routeId;
				base.points.push(...clone(extra.points));
				base.edges.push(...clone(extra.edges));
				base.decisionRules.push(...clone(extra.decisionRules || []));
				Object.assign(base.junctionDecisions, clone(extra.junctionDecisions || {}));
				base.sections = [...(base.sections || []), ...(clone(extra.sections || []))].filter((section, sectionIndex, all) => all.findIndex((candidate) => candidate.sectionId === section.sectionId) === sectionIndex);
				base.loop = base.loop || extra.loop;
			}
			merged.push(base);
		}
		routes = merged;
	}
	for (const route of routes) routeAliases[route.routeId] ||= route.routeId;
	const routeIds = new Set<string>();

	for (const route of routes) {
		const generatedPortPoints = new Map<string, string>();
		for (const point of route.points) {
			if (point.authoring?.mode === 'manual') continue;
			const objectId = point.authoring?.sourceObjectId || point.componentObjectId;
			const portId = point.authoring?.sourcePortId || point.componentPortId;
			if (objectId && portId) generatedPortPoints.set(`${objectId}::${portId}`, point.pointId);
		}
		const aliases = new Map<string, string>();
		for (const point of route.points) {
			if (point.authoring?.mode !== 'manual' || !point.attachment || point.attachment.snapMode !== 'hard') continue;
			const generatedPointId = generatedPortPoints.get(`${point.attachment.objectId}::${point.attachment.portId}`);
			if (generatedPointId && generatedPointId !== point.pointId) aliases.set(point.pointId, generatedPointId);
		}
		const remapPointId = (pointId: string) => aliases.get(pointId) || pointId;
		if (aliases.size) {
			for (const edge of route.edges) {
				edge.fromPointId = remapPointId(edge.fromPointId);
				edge.toPointId = remapPointId(edge.toPointId);
			}
			if (route.startPointId) route.startPointId = remapPointId(route.startPointId);
			for (const rule of route.decisionRules || []) rule.junctionPointId = remapPointId(rule.junctionPointId);
			const nextDecisions: Record<string, string> = {};
			for (const [pointId, edgeId] of Object.entries(route.junctionDecisions || {})) nextDecisions[remapPointId(pointId)] = edgeId;
			route.junctionDecisions = nextDecisions;
			route.points = route.points.filter((point) => !aliases.has(point.pointId));
		}
		if (routeIds.has(route.routeId)) diagnostics.push({ severity: 'error', code: 'route.authoring.route-id.duplicate', message: `路线 ID 重复：${route.routeId}`, routeId: route.routeId });
		routeIds.add(route.routeId);
		const pointIds = new Set<string>();
		for (const point of route.points) {
			if (pointIds.has(point.pointId)) diagnostics.push({ severity: 'error', code: 'route.authoring.point-id.duplicate', message: `路线点 ID 重复：${point.pointId}`, routeId: route.routeId, pointId: point.pointId });
			pointIds.add(point.pointId);
		}
		const edgeIds = new Set<string>();
		const directedPairs = new Set<string>();
		for (const edge of route.edges) {
			if (edgeIds.has(edge.edgeId)) diagnostics.push({ severity: 'error', code: 'route.authoring.edge-id.duplicate', message: `路线边 ID 重复：${edge.edgeId}`, routeId: route.routeId, edgeId: edge.edgeId });
			edgeIds.add(edge.edgeId);
			if (!pointIds.has(edge.fromPointId) || !pointIds.has(edge.toPointId)) diagnostics.push({ severity: 'error', code: 'route.authoring.edge.dangling', message: `路线边 ${edge.edgeId} 引用了不存在的端点`, routeId: route.routeId, edgeId: edge.edgeId });
			const pair = `${edge.fromPointId}->${edge.toPointId}`;
			if (directedPairs.has(pair)) diagnostics.push({ severity: 'error', code: 'route.authoring.edge.duplicate-topology', message: `存在重复同向连接：${pair}`, routeId: route.routeId, edgeId: edge.edgeId });
			directedPairs.add(pair);
			const mode = edge.authoring?.mode === 'manual' ? 'manual' : 'generated';
			sourceMap.push({ runtimeEdgeId: edge.edgeId, authoringMode: mode, sourceRouteId: sourceRouteByEdgeId.get(edge.edgeId), objectId: edge.authoring?.sourceObjectId, internalFlowId: edge.authoring?.sourceInternalFlowId, manualEdgeId: mode === 'manual' ? edge.edgeId : undefined });
		}
	}
	return { routes, diagnostics, sourceMap, routeAliases };
};

/** Runtime/发布使用统一 Graph；编辑草稿仍保留原 Authoring Route。 */
export const createCompiledRuntimeManifest = (source: TwinSceneManifest) => {
	const manifest = cloneTwinManifest(source);
	const compile = compileRouteAuthoringGraph(manifest.routes || []);
	return materializeCompiledRouteGraph(manifest, compile);
};

export const persistCompiledRouteGraph = (manifest: TwinSceneManifest): TwinRouteAuthoringCompileResult => {
	const compile = compileRouteAuthoringGraph(manifest.routes || []);
	manifest.routeGraph = {
		compilerVersion: 1,
		routes: clone(compile.routes),
		sourceMap: clone(compile.sourceMap),
		routeAliases: { ...compile.routeAliases },
	};
	return compile;
};

export const createPublishedRuntimeManifest = (source: TwinSceneManifest) => {
	const manifest = cloneTwinManifest(source);
	const graph = manifest.routeGraph;
	if (!graph?.routes?.length) return createCompiledRuntimeManifest(source);
	const compile: TwinRouteAuthoringCompileResult = { routes: clone(graph.routes), diagnostics: [], sourceMap: clone(graph.sourceMap || []), routeAliases: { ...(graph.routeAliases || {}) } };
	return materializeCompiledRouteGraph(manifest, compile);
};

const materializeCompiledRouteGraph = (manifest: TwinSceneManifest, compile: TwinRouteAuthoringCompileResult) => {
	manifest.routes = clone(compile.routes);
	for (const initializer of manifest.runtime.routePalletInitializers || []) initializer.routeId = compile.routeAliases[initializer.routeId] || initializer.routeId;
	const initializerRouteIds = new Set<string>();
	manifest.runtime.routePalletInitializers = (manifest.runtime.routePalletInitializers || []).filter((initializer) => {
		if (initializerRouteIds.has(initializer.routeId)) return false;
		initializerRouteIds.add(initializer.routeId);
		return true;
	});
	for (const binding of manifest.bindings || []) {
		const transform = binding.transform as Record<string, unknown>;
		const oldRouteId = String(transform.routeId || '').trim();
		if (oldRouteId) transform.routeId = compile.routeAliases[oldRouteId] || oldRouteId;
		if (binding.target.property?.startsWith('routeSlots:')) {
			const oldTargetRouteId = binding.target.property.slice('routeSlots:'.length);
			binding.target.property = `routeSlots:${compile.routeAliases[oldTargetRouteId] || oldTargetRouteId}`;
		}
	}
	return { manifest, compile };
};
