import type { TwinRouteDefinition } from '../contracts';
import { resolveRoutePath, RouteEngine, type TwinRouteEngineSnapshot, type TwinRouteRoutingContext } from './RouteEngine';

export const ROUTE_DEBUG_MIN_SAFETY_DISTANCE_METERS = 1.5;

export interface TwinRouteDebugRunResult {
	kind: 'single' | 'diverter';
	routeId: string;
	state: 'completed' | 'lap-complete' | 'waiting' | 'invalid';
	activeEdgeIds: string[];
	traversedEdgeIds: string[];
	waitingReason?: TwinRouteEngineSnapshot['waitingReason'];
	waitingEdgeId?: string;
	waitingPointId?: string;
	steps: number;
}

export interface TwinRouteMergeDebugResult {
	kind: 'merge';
	routeId: string;
	valid: boolean;
	mergePointId?: string;
	winnerEdgeId?: string;
	heldEdgeId?: string;
	safetyDistanceMeters: number;
	engineStates: [TwinRouteEngineSnapshot['state'], TwinRouteEngineSnapshot['state']];
}

const cloneRoute = (route: TwinRouteDefinition): TwinRouteDefinition => JSON.parse(JSON.stringify(route)) as TwinRouteDefinition;

const runEngine = (route: TwinRouteDefinition, context: TwinRouteRoutingContext): TwinRouteDebugRunResult => {
	const path = resolveRoutePath(route, context);
	if (path.points.length < 2 || path.edgeIds.length === 0) {
		return { kind: 'single', routeId: route.routeId, state: 'invalid', activeEdgeIds: path.edgeIds, traversedEdgeIds: [], steps: 0 };
	}
	const engine = new RouteEngine(route);
	engine.setRoutingContext(context);
	engine.setRunning(true);
	const traversed = new Set<string>();
	const stepSeconds = 1 / 30;
	const targetSeconds = Math.max(2, engine.getSnapshot().lengthMeters / Math.max(0.01, route.defaultSpeed) + 1);
	const maxSteps = Math.min(120000, Math.max(120, Math.ceil(targetSeconds / stepSeconds)));
	let previousProgress = engine.getSnapshot().progress;
	let steps = 0;
	for (; steps < maxSteps; steps += 1) {
		engine.updateFixed(stepSeconds);
		const snapshot = engine.getSnapshot();
		if (snapshot.currentEdgeId) traversed.add(snapshot.currentEdgeId);
		if (snapshot.state === 'waiting') return {
			kind: 'single', routeId: route.routeId, state: 'waiting', activeEdgeIds: snapshot.activeEdgeIds,
			traversedEdgeIds: [...traversed], waitingReason: snapshot.waitingReason, waitingEdgeId: snapshot.waitingEdgeId,
			waitingPointId: snapshot.waitingPointId, steps: steps + 1,
		};
		if (snapshot.state === 'completed') return { kind: 'single', routeId: route.routeId, state: 'completed', activeEdgeIds: snapshot.activeEdgeIds, traversedEdgeIds: [...traversed], steps: steps + 1 };
		if (route.loop === true && steps > 0 && snapshot.progress + 0.001 < previousProgress) {
			return { kind: 'single', routeId: route.routeId, state: 'lap-complete', activeEdgeIds: snapshot.activeEdgeIds, traversedEdgeIds: [...traversed], steps: steps + 1 };
		}
		previousProgress = snapshot.progress;
	}
	const snapshot = engine.getSnapshot();
	return {
		kind: 'single', routeId: route.routeId, state: snapshot.state === 'waiting' ? 'waiting' : route.loop ? 'lap-complete' : 'invalid',
		activeEdgeIds: snapshot.activeEdgeIds, traversedEdgeIds: [...traversed], waitingReason: snapshot.waitingReason,
		waitingEdgeId: snapshot.waitingEdgeId, waitingPointId: snapshot.waitingPointId, steps,
	};
};

/** 只创建当前路线的临时 RouteEngine，绝不启动 TwinRuntime/整线运行时。 */
export const runSingleRouteDebug = (route: TwinRouteDefinition, context: TwinRouteRoutingContext = {}) => runEngine(cloneRoute(route), context);

/** 强制指定一个分流出口后仍由原 RouteEngine 完成整条路径解析和步进。 */
export const runDiverterRouteDebug = (
	route: TwinRouteDefinition,
	junctionPointId: string,
	edgeId: string,
	context: TwinRouteRoutingContext = {},
): TwinRouteDebugRunResult => {
	const candidate = cloneRoute(route);
	candidate.routingMode = 'manual';
	candidate.junctionDecisions = { ...(candidate.junctionDecisions || {}), [junctionPointId]: edgeId };
	const result = runEngine(candidate, context);
	return { ...result, kind: 'diverter' };
};

/**
 * 合流调试只验证两条进入同一合流点的分支竞争关系。两个候选都用现有 RouteEngine 建立调试会话，
 * winner 采用 Route Edge priority（同优先级按 edgeId 稳定排序）；实际生产互锁仍由统一 Runtime 的占用/PLC 信号执行。
 */
export const runMergeRouteDebug = (
	route: TwinRouteDefinition,
	incomingEdgeAId: string,
	incomingEdgeBId: string,
	requestedSafetyDistanceMeters = ROUTE_DEBUG_MIN_SAFETY_DISTANCE_METERS,
	context: TwinRouteRoutingContext = {},
): TwinRouteMergeDebugResult => {
	const safetyDistanceMeters = Math.max(ROUTE_DEBUG_MIN_SAFETY_DISTANCE_METERS, Number(requestedSafetyDistanceMeters) || 0);
	const edgeA = route.edges.find((edge) => edge.edgeId === incomingEdgeAId);
	const edgeB = route.edges.find((edge) => edge.edgeId === incomingEdgeBId);
	if (!edgeA || !edgeB || edgeA.toPointId !== edgeB.toPointId) {
		return { kind: 'merge', routeId: route.routeId, valid: false, safetyDistanceMeters, engineStates: ['paused', 'paused'] };
	}
	const createBranchEngine = (fromPointId: string) => {
		const candidate = cloneRoute(route);
		candidate.loop = false;
		candidate.startPointId = fromPointId;
		const engine = new RouteEngine(candidate);
		engine.setRoutingContext(context);
		engine.setRunning(true);
		engine.updateFixed(1 / 30);
		return engine;
	};
	const engineA = createBranchEngine(edgeA.fromPointId);
	const engineB = createBranchEngine(edgeB.fromPointId);
	const ranked = [edgeA, edgeB].sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || left.edgeId.localeCompare(right.edgeId));
	return {
		kind: 'merge', routeId: route.routeId, valid: true, mergePointId: edgeA.toPointId,
		winnerEdgeId: ranked[0].edgeId, heldEdgeId: ranked[1].edgeId, safetyDistanceMeters,
		engineStates: [engineA.getSnapshot().state, engineB.getSnapshot().state],
	};
};
