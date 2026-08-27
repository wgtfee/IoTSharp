import { CatmullRomCurve3, CurvePath, LineCurve3, Vector3 } from 'three';
import { normalizeTwinRoute, type TwinRouteDefinition, type TwinRouteEdgeDefinition, type TwinRoutePointDefinition } from '/@/digital-twin/contracts';

export interface TwinRouteEngineSnapshot {
	state: 'paused' | 'running' | 'waiting' | 'completed';
	distanceMeters: number;
	lengthMeters: number;
	progress: number;
	speed: number;
	activePointIds: string[];
	activeEdgeIds: string[];
	unavailableEdgeIds: string[];
	waitingReason?: 'ROUTE_NOT_READY' | 'DIVERTER_NOT_READY' | 'TARGET_SECTION_FULL' | 'TARGET_SECTION_BLOCKED' | 'TARGET_SECTION_SIGNAL_STALE';
	waitingEdgeId?: string;
	waitingPointId?: string;
}

export interface TwinResolvedRoutePath {
	points: TwinRoutePointDefinition[];
	edgeIds: string[];
	closed: boolean;
	unavailableEdgeIds: string[];
	unresolvedJunctionPointId?: string;
	edgeEntryGuards: Record<string, { bindingId: string; expectedValue: string | number | boolean }>;
}

export interface TwinRouteRoutingContext {
	payload?: Record<string, unknown>;
	bindingValues?: Record<string, unknown>;
	edgeOccupancy?: Record<string, number>;
	staleBindingIds?: string[];
}

interface TraversalEdge {
	edge: TwinRouteEdgeDefinition;
	toPointId: string;
}

/** 根据交叉口转向、方向、优先级和封锁状态生成本次运行采用的确定性路径。 */
const readPayloadValue = (payload: Record<string, unknown> | undefined, path: string | undefined): unknown => {
	if (!payload || !path) return undefined;
	return path.split('.').filter(Boolean).reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, payload);
};

const valuesEqual = (actual: unknown, expected: unknown) => {
	if (typeof actual === 'number') return actual === Number(expected);
	if (typeof actual === 'boolean') return actual === (expected === true || String(expected).toLowerCase() === 'true' || expected === 1 || expected === '1');
	return String(actual ?? '') === String(expected ?? '');
};

const matchesRule = (actual: unknown, operator: string, expected: unknown) => {
	switch (operator) {
		case 'notEquals': return !valuesEqual(actual, expected);
		case 'greaterThan': return Number(actual) > Number(expected);
		case 'greaterThanOrEqual': return Number(actual) >= Number(expected);
		case 'lessThan': return Number(actual) < Number(expected);
		case 'lessThanOrEqual': return Number(actual) <= Number(expected);
		case 'contains': return Array.isArray(actual) ? actual.some((item) => valuesEqual(item, expected)) : String(actual ?? '').includes(String(expected ?? ''));
		case 'truthy': return Boolean(actual);
		case 'falsy': return !actual;
		default: return valuesEqual(actual, expected);
	}
};

const isSignalTrue = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';

const getEdgeUnavailableReason = (edge: TwinRouteEdgeDefinition, context: TwinRouteRoutingContext): TwinRouteEngineSnapshot['waitingReason'] | undefined => {
	const staleBindingIds = new Set(context.staleBindingIds || []);
	const routeSignalStale = Boolean(
		(edge.blockedBindingId && staleBindingIds.has(edge.blockedBindingId)) ||
		(edge.occupancyBindingId && staleBindingIds.has(edge.occupancyBindingId)) ||
		(edge.fullBindingId && staleBindingIds.has(edge.fullBindingId))
	);
	if (routeSignalStale) return 'TARGET_SECTION_SIGNAL_STALE';
	if (edge.blocked === true || (edge.blockedBindingId && isSignalTrue(context.bindingValues?.[edge.blockedBindingId]))) return 'TARGET_SECTION_BLOCKED';
	const occupancyValue = edge.occupancyBindingId ? Number(context.bindingValues?.[edge.occupancyBindingId]) : Number(context.edgeOccupancy?.[edge.edgeId]);
	const capacityBlocked = Number.isFinite(occupancyValue) && occupancyValue >= Number(edge.capacity || 1);
	const fullSignal = edge.fullBindingId ? isSignalTrue(context.bindingValues?.[edge.fullBindingId]) : false;
	if (capacityBlocked || fullSignal) return 'TARGET_SECTION_FULL';
	return undefined;
};

export const resolveRoutePath = (source: TwinRouteDefinition, context: TwinRouteRoutingContext = {}): TwinResolvedRoutePath => {
	const hadConfiguredGraph = Array.isArray(source.edges) && source.edges.length > 0;
	const route = normalizeTwinRoute(source);
	const pointsById = new Map(route.points.map((point) => [point.pointId, point]));
	const start = pointsById.get(route.startPointId || '') || route.points[0];
	if (!start) return { points: [], edgeIds: [], closed: false, unavailableEdgeIds: [], edgeEntryGuards: {} };

	const adjacency = new Map<string, TraversalEdge[]>();
	const unavailableEdgeIds = new Set<string>();
	const edgeEntryGuards: TwinResolvedRoutePath['edgeEntryGuards'] = {};
	const staleBindingIds = new Set(context.staleBindingIds || []);
	const add = (pointId: string, value: TraversalEdge) => adjacency.set(pointId, [...(adjacency.get(pointId) || []), value]);
	for (const edge of route.edges || []) {
		if (edge.enabled === false || !pointsById.has(edge.fromPointId) || !pointsById.has(edge.toPointId)) {
			unavailableEdgeIds.add(edge.edgeId);
			continue;
		}
		// 动态满位/封锁只决定是否能进入，不能从拓扑删除，否则会把 PLC 已选中的托盘擅自改道。
		if (getEdgeUnavailableReason(edge, context)) unavailableEdgeIds.add(edge.edgeId);
		add(edge.fromPointId, { edge, toPointId: edge.toPointId });
		if (edge.bidirectional) add(edge.toPointId, { edge, toPointId: edge.fromPointId });
	}

	const pointPath = [start];
	const edgePath: string[] = [];
	const visited = new Set<string>();
	let closed = false;
	let currentPointId = start.pointId;
	for (let step = 0; step < (route.edges?.length || 0) + 1; step += 1) {
		const candidates = (adjacency.get(currentPointId) || [])
			.filter((candidate) => !visited.has(candidate.edge.edgeId))
			.sort((left, right) => (right.edge.priority || 0) - (left.edge.priority || 0) || left.edge.edgeId.localeCompare(right.edge.edgeId));
		if (candidates.length === 0) break;
		const currentPoint = pointsById.get(currentPointId);
		const decisionMode = currentPoint?.decisionMode || (route.routingMode === 'automatic' ? 'simulation' : 'manual');
		const matchedRule = decisionMode !== 'manual'
			? (route.decisionRules || [])
				.filter((rule) => rule.enabled !== false && rule.junctionPointId === currentPointId && (decisionMode !== 'plc' || rule.source === 'binding') && candidates.some((candidate) => candidate.edge.edgeId === rule.edgeId) && !(rule.source === 'binding' && rule.bindingId && staleBindingIds.has(rule.bindingId)))
				.sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.ruleId.localeCompare(right.ruleId))
				.find((rule) => matchesRule(rule.source === 'binding' ? context.bindingValues?.[rule.bindingId || ''] : readPayloadValue(context.payload, rule.payloadKey), rule.operator, rule.matchValue))
			: undefined;
		if (decisionMode === 'plc' && !matchedRule) {
			return { points: pointPath, edgeIds: edgePath, closed: false, unavailableEdgeIds: [...unavailableEdgeIds], unresolvedJunctionPointId: currentPointId, edgeEntryGuards };
		}
		const decisionEdgeId = matchedRule?.edgeId || route.junctionDecisions?.[currentPointId];
		const selected = candidates.find((candidate) => candidate.edge.edgeId === decisionEdgeId) || candidates[0];
		if (matchedRule?.expectedActuatorValue !== undefined && currentPoint?.actuatorBindingId) {
			edgeEntryGuards[selected.edge.edgeId] = { bindingId: currentPoint.actuatorBindingId, expectedValue: matchedRule.expectedActuatorValue };
		}
		visited.add(selected.edge.edgeId);
		edgePath.push(selected.edge.edgeId);
		const nextPoint = pointsById.get(selected.toPointId);
		if (!nextPoint) break;
		if (nextPoint.pointId === start.pointId && route.loop) {
			closed = true;
			break;
		}
		pointPath.push(nextPoint);
		currentPointId = nextPoint.pointId;
	}

	// 没有可用边时仍兼容早期只有顺序 points 的草稿。
	if (!hadConfiguredGraph && pointPath.length < 2 && route.points.length >= 2) return { points: route.points, edgeIds: [], closed: route.loop, unavailableEdgeIds: [...unavailableEdgeIds], edgeEntryGuards };
	return { points: pointPath, edgeIds: edgePath, closed, unavailableEdgeIds: [...unavailableEdgeIds], edgeEntryGuards };
};

/**
 * Phase 0 路线运行内核。逻辑使用固定步长和米制距离，渲染阶段只做插值。
 */
export class RouteEngine {
	private route: TwinRouteDefinition;
	private curve: any;
	private target: any;
	private lengthMeters = 0;
	private previousDistance = 0;
	private distanceMeters = 0;
	private speed = 1;
	private running = false;
	private requestedRunning = false;
	private pathLocked = false;
	private pathLoops = false;
	private activePointIds: string[] = [];
	private activeEdgeIds: string[] = [];
	private unavailableEdgeIds: string[] = [];
	private edgeStartDistances: number[] = [];
	private readonly enteredEdgeIds = new Set<string>();
	private waitingReason?: TwinRouteEngineSnapshot['waitingReason'];
	private waitingEdgeId?: string;
	private waitingPointId?: string;
	private unresolvedJunctionPointId?: string;
	private edgeEntryGuards: TwinResolvedRoutePath['edgeEntryGuards'] = {};
	private routingContext: TwinRouteRoutingContext = {};

	constructor(route: TwinRouteDefinition, target?: any) {
		this.route = route;
		this.target = target;
		this.speed = route.defaultSpeed;
		this.curve = this.createCurve(route);
		this.lengthMeters = this.curve.getLength();
		this.applyPose(0);
	}

	setTarget(target: any) {
		this.target = target;
		this.applyPose(this.distanceMeters);
	}

	setRoute(route: TwinRouteDefinition) {
		const progress = this.lengthMeters > 0 ? this.distanceMeters / this.lengthMeters : 0;
		this.route = route;
		this.speed = route.defaultSpeed;
		this.curve = this.createCurve(route);
		this.lengthMeters = this.curve.getLength();
		this.distanceMeters = Math.min(this.lengthMeters, Math.max(0, progress * this.lengthMeters));
		this.previousDistance = this.distanceMeters;
		this.requestedRunning = false;
		this.running = false;
		this.pathLocked = this.distanceMeters > 0;
		this.enteredEdgeIds.clear();
		this.markTraversedEdgesEntered();
		this.clearWaiting();
		this.applyPose(this.distanceMeters);
	}

	setRunning(running: boolean) {
		this.requestedRunning = running && (this.lengthMeters > 0 || Boolean(this.unresolvedJunctionPointId));
		this.running = this.requestedRunning;
		if (this.requestedRunning) this.pathLocked = true;
		else this.clearWaiting();
		if (this.requestedRunning && this.lengthMeters <= 0 && this.unresolvedJunctionPointId) this.setWaiting(undefined, 'ROUTE_NOT_READY', this.unresolvedJunctionPointId);
	}

	setSpeed(speed: number) {
		if (!Number.isFinite(speed) || speed <= 0) return;
		this.speed = speed;
	}

	setRoutingContext(context: TwinRouteRoutingContext) {
		this.routingContext = {
			payload: { ...(context.payload || {}) },
			bindingValues: { ...(context.bindingValues || {}) },
			edgeOccupancy: { ...(context.edgeOccupancy || {}) },
			staleBindingIds: [...(context.staleBindingIds || [])],
		};
		if (!this.pathLocked || this.unresolvedJunctionPointId) {
			const preservedDistance = this.distanceMeters;
			this.curve = this.createCurve(this.route);
			this.lengthMeters = this.curve.getLength();
			this.distanceMeters = Math.min(preservedDistance, this.lengthMeters);
			this.previousDistance = this.distanceMeters;
			if (!this.unresolvedJunctionPointId && this.waitingReason === 'ROUTE_NOT_READY') this.clearWaiting();
			this.applyPose(this.distanceMeters);
		} else {
			this.refreshUnavailableEdges();
		}
	}

	reset() {
		this.previousDistance = 0;
		this.distanceMeters = 0;
		this.requestedRunning = false;
		this.running = false;
		this.pathLocked = false;
		this.enteredEdgeIds.clear();
		this.clearWaiting();
		this.curve = this.createCurve(this.route);
		this.lengthMeters = this.curve.getLength();
		this.applyPose(0);
	}

	correctDistance(distanceMeters: number) {
		if (!Number.isFinite(distanceMeters) || this.lengthMeters <= 0) return;
		const correctedDistance = this.pathLoops
			? ((distanceMeters % this.lengthMeters) + this.lengthMeters) % this.lengthMeters
			: Math.min(this.lengthMeters, Math.max(0, distanceMeters));
		this.previousDistance = correctedDistance;
		this.distanceMeters = correctedDistance;
		this.pathLocked = correctedDistance > 0;
		this.markTraversedEdgesEntered();
		this.applyPose(correctedDistance);
	}

	updateFixed(deltaSeconds: number) {
		this.previousDistance = this.distanceMeters;
		if (!this.requestedRunning || this.lengthMeters <= 0) return;
		const currentEdgeIndex = this.getEdgeIndexAtDistance(this.distanceMeters);
		if (currentEdgeIndex >= 0) {
			const currentEdgeId = this.activeEdgeIds[currentEdgeIndex];
			const currentReason = this.getWaitingReason(currentEdgeId, this.enteredEdgeIds.has(currentEdgeId));
			if (currentReason) {
				this.setWaiting(currentEdgeId, currentReason);
				return;
			}
			this.enteredEdgeIds.add(currentEdgeId);
		}
		const nextDistance = this.distanceMeters + this.speed * deltaSeconds;
		for (let index = Math.max(1, currentEdgeIndex + 1); index < this.edgeStartDistances.length; index += 1) {
			const edgeStart = this.edgeStartDistances[index];
			if (edgeStart > nextDistance + 0.000001) break;
			const edgeId = this.activeEdgeIds[index];
			const reason = this.getWaitingReason(edgeId, false);
			if (reason) {
				this.distanceMeters = Math.max(0, edgeStart - 0.000001);
				this.setWaiting(edgeId, reason);
				return;
			}
			this.enteredEdgeIds.add(edgeId);
		}
		this.clearWaiting();
		this.running = true;
		if (this.pathLoops) {
			this.distanceMeters = nextDistance % this.lengthMeters;
			return;
		}
		this.distanceMeters = Math.min(this.lengthMeters, nextDistance);
		if (this.distanceMeters >= this.lengthMeters) {
			if (this.unresolvedJunctionPointId) this.setWaiting(undefined, 'ROUTE_NOT_READY', this.unresolvedJunctionPointId);
			else {
				this.running = false;
				this.requestedRunning = false;
			}
		}
	}

	render(alpha: number) {
		let current = this.distanceMeters;
		if (this.pathLoops && current < this.previousDistance) current += this.lengthMeters;
		const interpolated = this.previousDistance + (current - this.previousDistance) * Math.min(1, Math.max(0, alpha));
		const renderedDistance = this.pathLoops && this.lengthMeters > 0 ? interpolated % this.lengthMeters : Math.min(this.lengthMeters, interpolated);
		this.applyPose(renderedDistance);
	}

	getSnapshot(): TwinRouteEngineSnapshot {
		const completed = !this.pathLoops && this.lengthMeters > 0 && this.distanceMeters >= this.lengthMeters;
		return {
			state: completed ? 'completed' : this.waitingReason ? 'waiting' : this.running ? 'running' : 'paused',
			distanceMeters: this.distanceMeters,
			lengthMeters: this.lengthMeters,
			progress: this.lengthMeters > 0 ? this.distanceMeters / this.lengthMeters : 0,
			speed: this.speed,
			activePointIds: [...this.activePointIds],
			activeEdgeIds: [...this.activeEdgeIds],
			unavailableEdgeIds: [...this.unavailableEdgeIds],
			waitingReason: this.waitingReason,
			waitingEdgeId: this.waitingEdgeId,
			waitingPointId: this.waitingPointId,
		};
	}

	getCurve() {
		return this.curve;
	}

	private createCurve(route: TwinRouteDefinition) {
		const resolved = resolveRoutePath(route, this.routingContext);
		this.activePointIds = resolved.points.map((point) => point.pointId);
		this.activeEdgeIds = resolved.edgeIds;
		this.unavailableEdgeIds = resolved.unavailableEdgeIds;
		this.unresolvedJunctionPointId = resolved.unresolvedJunctionPointId;
		this.edgeEntryGuards = resolved.edgeEntryGuards;
		this.pathLoops = route.loop && resolved.closed;
		const vectors = resolved.points.map((point) => new Vector3(point.position[0], point.position[1], point.position[2]));
		if (vectors.length < 2) vectors.push(vectors[0]?.clone() ?? new Vector3(1, 0, 0));
		let curve: any;
		if (route.curveKind === 'line' || vectors.length === 2) {
			const path = new CurvePath();
			for (let index = 1; index < vectors.length; index += 1) path.add(new LineCurve3(vectors[index - 1], vectors[index]));
			if (this.pathLoops && vectors.length > 2) path.add(new LineCurve3(vectors[vectors.length - 1], vectors[0]));
			curve = path;
		} else {
			curve = new CatmullRomCurve3(vectors, this.pathLoops, 'centripetal', 0.5);
		}
		const curveLength = curve.getLength();
		const segmentLengths = resolved.points.slice(1).map((point, index) => new Vector3(...resolved.points[index].position).distanceTo(new Vector3(...point.position)));
		if (this.pathLoops && resolved.points.length > 2 && resolved.edgeIds.length > segmentLengths.length) segmentLengths.push(new Vector3(...resolved.points[resolved.points.length - 1].position).distanceTo(new Vector3(...resolved.points[0].position)));
		const straightLength = segmentLengths.reduce((total, length) => total + length, 0) || 1;
		let accumulated = 0;
		this.edgeStartDistances = resolved.edgeIds.map((_, index) => {
			const start = accumulated / straightLength * curveLength;
			accumulated += segmentLengths[index] || 0;
			return start;
		});
		return curve;
	}

	private refreshUnavailableEdges() {
		this.unavailableEdgeIds = this.route.edges
			.filter((edge) => edge.enabled === false || Boolean(getEdgeUnavailableReason(edge, this.routingContext)))
			.map((edge) => edge.edgeId);
	}

	private getEdgeIndexAtDistance(distanceMeters: number) {
		if (this.activeEdgeIds.length === 0) return -1;
		let selected = 0;
		for (let index = 1; index < this.edgeStartDistances.length; index += 1) {
			if (this.edgeStartDistances[index] <= distanceMeters + 0.000001) selected = index;
			else break;
		}
		return selected;
	}

	private getWaitingReason(edgeId: string, alreadyEntered: boolean) {
		const edge = this.route.edges.find((item) => item.edgeId === edgeId);
		if (!edge || edge.enabled === false) return 'TARGET_SECTION_BLOCKED' as const;
		const guard = this.edgeEntryGuards[edgeId];
		if (!alreadyEntered && guard) {
			if ((this.routingContext.staleBindingIds || []).includes(guard.bindingId) || !valuesEqual(this.routingContext.bindingValues?.[guard.bindingId], guard.expectedValue)) return 'DIVERTER_NOT_READY' as const;
		}
		const reason = getEdgeUnavailableReason(edge, this.routingContext);
		// 已经在当前分段中的物料不因“本段已满”停止；故障、封锁和信号失效仍立即生效。
		return alreadyEntered && reason === 'TARGET_SECTION_FULL' ? undefined : reason;
	}

	private setWaiting(edgeId: string | undefined, reason: NonNullable<TwinRouteEngineSnapshot['waitingReason']>, pointId?: string) {
		this.running = false;
		this.waitingEdgeId = edgeId;
		this.waitingPointId = pointId;
		this.waitingReason = reason;
	}

	private clearWaiting() {
		this.waitingEdgeId = undefined;
		this.waitingPointId = undefined;
		this.waitingReason = undefined;
	}

	private markTraversedEdgesEntered() {
		const currentIndex = this.getEdgeIndexAtDistance(this.distanceMeters);
		for (let index = 0; index < currentIndex; index += 1) this.enteredEdgeIds.add(this.activeEdgeIds[index]);
	}

	private applyPose(distanceMeters: number) {
		if (!this.target || this.lengthMeters <= 0) return;
		const normalizedDistance = Math.min(1, Math.max(0, distanceMeters / this.lengthMeters));
		const position = this.curve.getPointAt(normalizedDistance);
		this.target.position.copy(position);
		if (!this.route.orientToPath) return;
		const tangent = this.curve.getTangentAt(normalizedDistance);
		if (tangent.lengthSq() > 0.000001) this.target.lookAt(position.clone().add(tangent));
	}
}
