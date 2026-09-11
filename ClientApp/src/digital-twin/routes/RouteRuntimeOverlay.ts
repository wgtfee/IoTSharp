import type { TwinRouteDefinition, TwinRouteEdgeDefinition } from '../contracts';
import type { TwinRouteEngineSnapshot, TwinRouteRoutingContext } from './RouteEngine';

export type TwinRuntimeRouteStatus = 'ready' | 'occupied' | 'blocked' | 'full' | 'not-ready' | 'disabled' | 'stale';

export const runtimeRouteStatusColors: Record<TwinRuntimeRouteStatus, number> = {
	ready: 0x22c55e,
	occupied: 0xeab308,
	blocked: 0xef4444,
	full: 0xb91c1c,
	'not-ready': 0xf97316,
	disabled: 0x64748b,
	stale: 0x756b8a,
};

export interface TwinRuntimeRouteEdgeOverlayState {
	routeId: string;
	edgeId: string;
	sectionId?: string;
	status: TwinRuntimeRouteStatus;
	color: number;
	occupancy?: number;
}

const isSignalTrue = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
const edgeBindingIds = (edge: TwinRouteEdgeDefinition) => [
	edge.releasePermitBindingId,
	edge.readyBindingId,
	edge.blockedBindingId,
	edge.occupancyBindingId,
	edge.fullBindingId,
].filter((value): value is string => Boolean(value));

const resolveOccupancy = (edge: TwinRouteEdgeDefinition, context: TwinRouteRoutingContext) => {
	const useLiveSignals = context.dataMode !== 'simulation';
	const value = useLiveSignals && edge.occupancyBindingId
		? Number(context.bindingValues?.[edge.occupancyBindingId])
		: Number(context.edgeOccupancy?.[edge.edgeId]);
	return Number.isFinite(value) ? value : undefined;
};

export const resolveRuntimeRouteEdgeOverlayState = (
	route: TwinRouteDefinition,
	edge: TwinRouteEdgeDefinition,
	context: TwinRouteRoutingContext = {},
	snapshot?: TwinRouteEngineSnapshot,
): TwinRuntimeRouteEdgeOverlayState => {
	const useLiveSignals = context.dataMode !== 'simulation';
	const staleBindingIds = new Set(context.staleBindingIds || []);
	const waitingHere = snapshot?.waitingEdgeId === edge.edgeId;
	const section = edge.sectionId ? route.sections?.find((item) => item.sectionId === edge.sectionId) : undefined;
	const occupancy = resolveOccupancy(edge, context);

	// 运行态覆盖层采用稳定优先级：Stale > Disabled > Blocked > Full > NotReady > Occupied > Ready。
	// 这只是可视化判定，不参与 RouteEngine 放行决策，避免形成第二套路由运行时。
	const stale = useLiveSignals && edgeBindingIds(edge).some((bindingId) => staleBindingIds.has(bindingId));
	if (stale || (waitingHere && snapshot?.waitingReason === 'TARGET_SECTION_SIGNAL_STALE')) {
		return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'stale', color: runtimeRouteStatusColors.stale, occupancy };
	}
	if (edge.enabled === false || section?.enabled === false) {
		return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'disabled', color: runtimeRouteStatusColors.disabled, occupancy };
	}
	const blocked = edge.blocked === true
		|| Boolean(useLiveSignals && edge.blockedBindingId && isSignalTrue(context.bindingValues?.[edge.blockedBindingId]))
		|| (waitingHere && snapshot?.waitingReason === 'TARGET_SECTION_BLOCKED');
	if (blocked) return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'blocked', color: runtimeRouteStatusColors.blocked, occupancy };

	const full = (Number.isFinite(occupancy) && Number(occupancy) >= Number(edge.capacity || 1))
		|| Boolean(useLiveSignals && edge.fullBindingId && isSignalTrue(context.bindingValues?.[edge.fullBindingId]))
		|| (waitingHere && snapshot?.waitingReason === 'TARGET_SECTION_FULL');
	if (full) return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'full', color: runtimeRouteStatusColors.full, occupancy };

	const notReady = Boolean(useLiveSignals && edge.releasePermitBindingId && !isSignalTrue(context.bindingValues?.[edge.releasePermitBindingId]))
		|| Boolean(useLiveSignals && edge.readyBindingId && !isSignalTrue(context.bindingValues?.[edge.readyBindingId]))
		|| Boolean(waitingHere && ['TARGET_SECTION_NOT_READY', 'DIVERTER_NOT_READY', 'ROUTE_NOT_READY'].includes(String(snapshot?.waitingReason || '')));
	if (notReady) return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'not-ready', color: runtimeRouteStatusColors['not-ready'], occupancy };

	const occupied = (Number.isFinite(occupancy) && Number(occupancy) > 0) || snapshot?.currentEdgeId === edge.edgeId;
	if (occupied) return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'occupied', color: runtimeRouteStatusColors.occupied, occupancy };
	return { routeId: route.routeId, edgeId: edge.edgeId, sectionId: edge.sectionId, status: 'ready', color: runtimeRouteStatusColors.ready, occupancy };
};

export const resolveRuntimeRouteOverlayStates = (
	route: TwinRouteDefinition,
	context: TwinRouteRoutingContext = {},
	snapshot?: TwinRouteEngineSnapshot,
) => route.edges.map((edge) => resolveRuntimeRouteEdgeOverlayState(route, edge, context, snapshot));
