import {
	normalizeTwinRoute,
	type TwinRouteDecisionRule,
	type TwinRouteDefinition,
	type TwinRouteEdgeDefinition,
	type TwinRoutePointDefinition,
	type TwinSectionOccupancyMode,
	type TwinTransportUnitType,
} from '../contracts';
import type { TwinRouteRoutingContext } from '../routes/RouteEngine';

export type TwinFlowWaitingReason = 'ROUTE_NOT_READY' | 'DIVERTER_NOT_READY' | 'TARGET_SECTION_FULL' | 'TARGET_SECTION_BLOCKED' | 'TARGET_SECTION_SIGNAL_STALE' | 'TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED';
export type TwinSectionState = 'available' | 'full' | 'blocked' | 'signal-stale';

export interface TwinSectionRuntimeSnapshot {
	sectionId: string;
	name: string;
	occupancyMode: TwinSectionOccupancyMode;
	capacity: number;
	occupancy: number;
	reserved: number;
	available: number;
	state: TwinSectionState;
	entityIds: string[];
	reservationEntityIds: string[];
}

export interface TwinRouteDecision {
	entityId: string;
	junctionPointId: string;
	edgeId: string;
	targetSectionId: string;
	source: 'plc' | 'simulation' | 'manual';
	sourceValue?: unknown;
	ruleId?: string;
	expectedActuatorValue?: string | number | boolean;
	decidedAt: number;
}

export interface TwinFlowEntitySnapshot {
	entityId: string;
	entityType?: TwinTransportUnitType;
	currentSectionId?: string;
	state: 'moving' | 'waiting' | 'completed';
	waitingReason?: TwinFlowWaitingReason;
	waitingForSectionId?: string;
	activeDecision?: TwinRouteDecision;
	routeTrace: TwinRouteDecision[];
	updatedAt: number;
}

export interface TwinFlowEvent {
	type:
		| 'SectionReserved'
		| 'SectionReservationReleased'
		| 'SectionReservationExpired'
		| 'EntityEnteredSection'
		| 'EntityLeftSection'
		| 'EntityWaiting'
		| 'EntityResumed'
		| 'RouteDecisionLocked'
		| 'RouteDecisionReleased';
	timestamp: number;
	entityId?: string;
	sectionId?: string;
	junctionPointId?: string;
	reason?: TwinFlowWaitingReason | 'entered' | 'released' | 'expired';
	payload?: Record<string, unknown>;
}

type TwinFlowEventListener = (event: TwinFlowEvent) => void;

/** 小型同步事件总线；业务状态先提交，再发事件，监听器不能改变本次事务结果。 */
export class TwinFlowEventBus {
	private readonly listeners = new Set<TwinFlowEventListener>();

	on(listener: TwinFlowEventListener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: TwinFlowEvent) {
		for (const listener of [...this.listeners]) listener(event);
	}
}

interface TwinReservation {
	entityId: string;
	expiresAt: number;
	createdAt: number;
}

interface TwinSectionRecord {
	edge: TwinRouteEdgeDefinition;
	entities: Set<string>;
	reservations: Map<string, TwinReservation>;
	/** Live 模式下已经放行、等待 PLC 计数确认的实体仍占预留容量。 */
	inFlight: Map<string, TwinReservation>;
	liveOccupancy?: number;
	liveFull?: boolean;
	blockedSignal: boolean;
	signalStale: boolean;
}

export interface TwinSectionAvailability {
	canAccept: boolean;
	reason?: 'full' | 'blocked' | 'signal-stale' | 'unit-type-not-allowed' | 'not-found';
}

const isSignalTrue = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';

/**
 * 路线边就是物理缓存段。Manager 提供同步、原子的 Reserve/Enter/Leave，避免最后一个空位被重复预占。
 * calculated/simulation 由实体集合计数；live 以 PLC 数量为权威，同时保留短租约覆盖信号回传窗口。
 */
export class TwinSectionManager {
	private readonly sections = new Map<string, TwinSectionRecord>();

	constructor(edges: TwinRouteEdgeDefinition[], private readonly eventBus = new TwinFlowEventBus()) {
		this.setEdges(edges);
	}

	setEdges(edges: TwinRouteEdgeDefinition[]) {
		const previous = new Map(this.sections);
		this.sections.clear();
		for (const edge of edges) {
			const old = previous.get(edge.edgeId);
			this.sections.set(edge.edgeId, {
				edge: { ...edge },
				entities: old?.entities ?? new Set(),
				reservations: old?.reservations ?? new Map(),
				inFlight: old?.inFlight ?? new Map(),
				liveOccupancy: old?.liveOccupancy,
				liveFull: old?.liveFull,
				blockedSignal: old?.blockedSignal ?? false,
				signalStale: old?.signalStale ?? false,
			});
		}
	}

	resetState() {
		for (const record of this.sections.values()) {
			record.entities.clear();
			record.reservations.clear();
			record.inFlight.clear();
			delete record.liveOccupancy;
			delete record.liveFull;
			record.blockedSignal = false;
			record.signalStale = false;
		}
	}

	applyRoutingContext(context: TwinRouteRoutingContext, now = Date.now()) {
		const stale = new Set(context.staleBindingIds || []);
		for (const record of this.sections.values()) {
			const { edge } = record;
			const oldLiveOccupancy = record.liveOccupancy;
			if (edge.occupancyBindingId && !stale.has(edge.occupancyBindingId)) {
				const value = Number(context.bindingValues?.[edge.occupancyBindingId]);
				if (Number.isFinite(value)) record.liveOccupancy = Math.max(0, Math.floor(value));
			} else if (context.edgeOccupancy?.[edge.edgeId] !== undefined) {
				const value = Number(context.edgeOccupancy[edge.edgeId]);
				if (Number.isFinite(value)) record.liveOccupancy = Math.max(0, Math.floor(value));
			}
			if (edge.fullBindingId && !stale.has(edge.fullBindingId)) record.liveFull = isSignalTrue(context.bindingValues?.[edge.fullBindingId]);
			record.blockedSignal = edge.blockedBindingId ? isSignalTrue(context.bindingValues?.[edge.blockedBindingId]) : false;
			record.signalStale = Boolean(
				(edge.occupancyBindingId && stale.has(edge.occupancyBindingId)) ||
				(edge.fullBindingId && stale.has(edge.fullBindingId)) ||
				(edge.blockedBindingId && stale.has(edge.blockedBindingId))
			);
			const confirmedEntries = Math.max(0, (record.liveOccupancy ?? 0) - (oldLiveOccupancy ?? record.liveOccupancy ?? 0));
			if (confirmedEntries > 0) {
				for (const reservation of [...record.inFlight.values()].sort((left, right) => left.createdAt - right.createdAt).slice(0, confirmedEntries)) {
					record.inFlight.delete(reservation.entityId);
				}
			}
		}
		this.expireReservations(now);
	}

	getSnapshot(sectionId: string, now = Date.now()): TwinSectionRuntimeSnapshot | undefined {
		this.expireReservations(now);
		const record = this.sections.get(sectionId);
		if (!record) return undefined;
		const capacity = Math.max(1, Math.floor(record.edge.capacity ?? 1));
		const occupancyMode = record.edge.occupancyMode || (record.edge.occupancyBindingId || record.edge.fullBindingId ? 'live' : 'calculated');
		const occupancy = occupancyMode === 'live' ? Math.max(0, record.liveOccupancy ?? 0) : record.entities.size;
		const reserved = record.reservations.size + record.inFlight.size;
		const state: TwinSectionState = record.signalStale
			? 'signal-stale'
			: record.edge.blocked === true || record.blockedSignal
				? 'blocked'
				: record.liveFull === true || occupancy + reserved >= capacity
					? 'full'
					: 'available';
		return {
			sectionId,
			name: record.edge.name || sectionId,
			occupancyMode,
			capacity,
			occupancy,
			reserved,
			available: Math.max(0, capacity - occupancy - reserved),
			state,
			entityIds: [...record.entities],
			reservationEntityIds: [...record.reservations.keys(), ...record.inFlight.keys()],
		};
	}

	getSnapshots(now = Date.now()) {
		return [...this.sections.keys()].map((sectionId) => this.getSnapshot(sectionId, now)!).filter(Boolean);
	}

	canAccept(sectionId: string, entityId?: string, now = Date.now(), entityType?: TwinTransportUnitType): TwinSectionAvailability {
		const snapshot = this.getSnapshot(sectionId, now);
		const record = this.sections.get(sectionId);
		if (!snapshot) return { canAccept: false, reason: 'not-found' };
		if (record?.edge.transportUnitType && entityType && record.edge.transportUnitType !== entityType) return { canAccept: false, reason: 'unit-type-not-allowed' };
		if (snapshot.state === 'signal-stale') return { canAccept: false, reason: 'signal-stale' };
		if (snapshot.state === 'blocked') return { canAccept: false, reason: 'blocked' };
		if (entityId && (snapshot.entityIds.includes(entityId) || snapshot.reservationEntityIds.includes(entityId))) return { canAccept: true };
		if (snapshot.available <= 0 || snapshot.state === 'full') return { canAccept: false, reason: 'full' };
		return { canAccept: true };
	}

	reserve(sectionId: string, entityId: string, now = Date.now(), entityType?: TwinTransportUnitType): TwinSectionAvailability {
		const record = this.sections.get(sectionId);
		const availability = this.canAccept(sectionId, entityId, now, entityType);
		if (!record || !availability.canAccept) return availability;
		if (record.entities.has(entityId) || record.reservations.has(entityId) || record.inFlight.has(entityId)) return { canAccept: true };
		const timeoutMs = Math.max(1000, Number(record.edge.reservationTimeoutSeconds ?? 30) * 1000);
		record.reservations.set(entityId, { entityId, createdAt: now, expiresAt: now + timeoutMs });
		this.eventBus.emit({ type: 'SectionReserved', timestamp: now, entityId, sectionId });
		return { canAccept: true };
	}

	releaseReservation(sectionId: string, entityId: string, now = Date.now(), reason: 'released' | 'expired' = 'released') {
		const record = this.sections.get(sectionId);
		if (!record) return false;
		const removed = record.reservations.delete(entityId) || record.inFlight.delete(entityId);
		if (removed) this.eventBus.emit({ type: reason === 'expired' ? 'SectionReservationExpired' : 'SectionReservationReleased', timestamp: now, entityId, sectionId, reason });
		return removed;
	}

	enter(sectionId: string, entityId: string, now = Date.now(), entityType?: TwinTransportUnitType) {
		const record = this.sections.get(sectionId);
		if (!record) return false;
		if (!record.reservations.has(entityId) && !record.entities.has(entityId) && !record.inFlight.has(entityId)) {
			const reserved = this.reserve(sectionId, entityId, now, entityType);
			if (!reserved.canAccept) return false;
		}
		const reservation = record.reservations.get(entityId);
		record.reservations.delete(entityId);
		const mode = record.edge.occupancyMode || (record.edge.occupancyBindingId || record.edge.fullBindingId ? 'live' : 'calculated');
		if (mode === 'live') {
			const timeoutMs = Math.max(1000, Number(record.edge.reservationTimeoutSeconds ?? 30) * 1000);
			record.inFlight.set(entityId, reservation ?? { entityId, createdAt: now, expiresAt: now + timeoutMs });
		} else {
			record.entities.add(entityId);
		}
		this.eventBus.emit({ type: 'EntityEnteredSection', timestamp: now, entityId, sectionId, reason: 'entered' });
		return true;
	}

	leave(sectionId: string, entityId: string, now = Date.now()) {
		const record = this.sections.get(sectionId);
		if (!record) return false;
		const removed = record.entities.delete(entityId) || record.inFlight.delete(entityId);
		if (removed) this.eventBus.emit({ type: 'EntityLeftSection', timestamp: now, entityId, sectionId });
		return removed;
	}

	/** 目标段成功 Enter 后才释放源段；失败时源段状态不变。 */
	tryTransfer(entityId: string, sourceSectionId: string | undefined, targetSectionId: string, now = Date.now(), entityType?: TwinTransportUnitType) {
		const reserved = this.reserve(targetSectionId, entityId, now, entityType);
		if (!reserved.canAccept) return reserved;
		if (!this.enter(targetSectionId, entityId, now, entityType)) {
			this.releaseReservation(targetSectionId, entityId, now);
			return { canAccept: false, reason: 'blocked' as const };
		}
		if (sourceSectionId && sourceSectionId !== targetSectionId) this.leave(sourceSectionId, entityId, now);
		return { canAccept: true };
	}

	private expireReservations(now: number) {
		for (const [sectionId, record] of this.sections) {
			for (const reservation of [...record.reservations.values(), ...record.inFlight.values()]) {
				if (reservation.expiresAt <= now) this.releaseReservation(sectionId, reservation.entityId, now, 'expired');
			}
		}
	}
}

const readPayloadValue = (payload: Record<string, unknown> | undefined, path: string | undefined): unknown => {
	if (!payload || !path) return undefined;
	return path.split('.').filter(Boolean).reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, payload);
};

const valuesEqual = (actual: unknown, expected: unknown) => {
	if (typeof actual === 'number') return actual === Number(expected);
	if (typeof actual === 'boolean') return actual === (expected === true || expected === 1 || expected === '1' || String(expected).toLowerCase() === 'true');
	return String(actual ?? '') === String(expected ?? '');
};

const matchesRule = (actual: unknown, rule: TwinRouteDecisionRule) => {
	const expected = rule.matchValue;
	switch (rule.operator) {
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

export class TwinEntityManager {
	private readonly entities = new Map<string, TwinFlowEntitySnapshot>();

	constructor(private readonly eventBus = new TwinFlowEventBus()) {}

	ensure(entityId: string, currentSectionId?: string, now = Date.now(), entityType?: TwinTransportUnitType) {
		let entity = this.entities.get(entityId);
		if (!entity) {
			entity = { entityId, entityType, currentSectionId, state: 'moving', routeTrace: [], updatedAt: now };
			this.entities.set(entityId, entity);
		} else {
			if (currentSectionId !== undefined) entity.currentSectionId = currentSectionId;
			if (entityType !== undefined) entity.entityType = entityType;
		}
		return entity;
	}

	get(entityId: string) {
		const entity = this.entities.get(entityId);
		return entity ? structuredClone(entity) : undefined;
	}

	getAll() {
		return [...this.entities.values()].map((entity) => structuredClone(entity));
	}

	clear() {
		this.entities.clear();
	}

	lockDecision(entityId: string, decision: TwinRouteDecision) {
		const entity = this.ensure(entityId, undefined, decision.decidedAt);
		if (entity.activeDecision) return entity.activeDecision;
		entity.activeDecision = decision;
		entity.routeTrace.push(decision);
		entity.updatedAt = decision.decidedAt;
		this.eventBus.emit({ type: 'RouteDecisionLocked', timestamp: decision.decidedAt, entityId, junctionPointId: decision.junctionPointId, payload: { edgeId: decision.edgeId, source: decision.source } });
		return decision;
	}

	releaseDecision(entityId: string, now = Date.now()) {
		const entity = this.entities.get(entityId);
		if (!entity?.activeDecision) return;
		const junctionPointId = entity.activeDecision.junctionPointId;
		delete entity.activeDecision;
		entity.updatedAt = now;
		this.eventBus.emit({ type: 'RouteDecisionReleased', timestamp: now, entityId, junctionPointId });
	}

	wait(entityId: string, reason: TwinFlowWaitingReason, targetSectionId: string | undefined, now = Date.now()) {
		const entity = this.ensure(entityId, undefined, now);
		entity.state = 'waiting';
		entity.waitingReason = reason;
		entity.waitingForSectionId = targetSectionId;
		entity.updatedAt = now;
		this.eventBus.emit({ type: 'EntityWaiting', timestamp: now, entityId, sectionId: entity.currentSectionId, reason, payload: { targetSectionId } });
	}

	resume(entityId: string, targetSectionId: string, now = Date.now()) {
		const entity = this.ensure(entityId, targetSectionId, now);
		const wasWaiting = entity.state === 'waiting';
		entity.currentSectionId = targetSectionId;
		entity.state = 'moving';
		delete entity.waitingReason;
		delete entity.waitingForSectionId;
		entity.updatedAt = now;
		if (wasWaiting) this.eventBus.emit({ type: 'EntityResumed', timestamp: now, entityId, sectionId: targetSectionId });
	}
}

export interface TwinJunctionDecisionResult {
	decision?: TwinRouteDecision;
	waitingReason?: TwinFlowWaitingReason;
}

/** 每个 entity + junction 只生成一次决定；之后 PLC 值变化不会修改已经锁存的出口。 */
export class TwinJunctionManager {
	constructor(private route: TwinRouteDefinition, private readonly entities: TwinEntityManager) {
		this.route = normalizeTwinRoute(route);
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(route);
	}

	decide(entityId: string, junctionPointId: string, context: TwinRouteRoutingContext, manualEdgeId?: string, now = Date.now()): TwinJunctionDecisionResult {
		const existing = this.entities.get(entityId)?.activeDecision;
		if (existing?.junctionPointId === junctionPointId) return { decision: existing };
		const point = this.route.points.find((item) => item.pointId === junctionPointId);
		if (!point) return { waitingReason: 'ROUTE_NOT_READY' };
		const candidates = this.route.edges.filter((edge) => edge.enabled !== false && (edge.fromPointId === junctionPointId || (edge.bidirectional && edge.toPointId === junctionPointId)));
		const bindingRules = this.route.decisionRules.filter((rule) => rule.enabled !== false && rule.junctionPointId === junctionPointId && rule.source === 'binding');
		const mode = point.decisionMode || (this.route.routingMode === 'automatic' ? (bindingRules.length ? 'plc' : 'simulation') : 'manual');
		const staleBindings = new Set(context.staleBindingIds || []);
		let selectedEdgeId: string | undefined;
		let selectedRule: TwinRouteDecisionRule | undefined;
		let sourceValue: unknown;

		if (mode === 'manual') selectedEdgeId = manualEdgeId || this.route.junctionDecisions[junctionPointId];
		else {
			const rules = this.route.decisionRules
				.filter((rule) => rule.enabled !== false && rule.junctionPointId === junctionPointId && (mode === 'plc' ? rule.source === 'binding' : true))
				.sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.ruleId.localeCompare(right.ruleId));
			selectedRule = rules.find((rule) => {
				if (rule.source === 'binding' && (!rule.bindingId || staleBindings.has(rule.bindingId))) return false;
				const actual = rule.source === 'binding' ? context.bindingValues?.[rule.bindingId || ''] : readPayloadValue(context.payload, rule.payloadKey);
				if (!matchesRule(actual, rule)) return false;
				sourceValue = actual;
				return true;
			});
			// 离线规则未命中时使用已配置默认出口；PLC 模式必须继续等待，不能擅自回退。
			selectedEdgeId = selectedRule?.edgeId || (mode === 'simulation' ? this.route.junctionDecisions[junctionPointId] : undefined);
		}

		if (!selectedEdgeId || !candidates.some((edge) => edge.edgeId === selectedEdgeId)) return { waitingReason: 'ROUTE_NOT_READY' };
		const decision: TwinRouteDecision = {
			entityId,
			junctionPointId,
			edgeId: selectedEdgeId,
			targetSectionId: selectedEdgeId,
			source: mode,
			sourceValue,
			ruleId: selectedRule?.ruleId,
			expectedActuatorValue: selectedRule?.expectedActuatorValue,
			decidedAt: now,
		};
		return { decision: this.entities.lockDecision(entityId, decision) };
	}

	canRelease(point: TwinRoutePointDefinition, decision: TwinRouteDecision, context: TwinRouteRoutingContext, sections: TwinSectionManager, now = Date.now()): TwinFlowWaitingReason | undefined {
		if (decision.expectedActuatorValue !== undefined && point.actuatorBindingId) {
			if ((context.staleBindingIds || []).includes(point.actuatorBindingId) || !valuesEqual(context.bindingValues?.[point.actuatorBindingId], decision.expectedActuatorValue)) return 'DIVERTER_NOT_READY';
		}
		const availability = sections.canAccept(decision.targetSectionId, decision.entityId, now, this.entities.get(decision.entityId)?.entityType);
		if (availability.reason === 'unit-type-not-allowed') return 'TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED';
		if (availability.reason === 'signal-stale') return 'TARGET_SECTION_SIGNAL_STALE';
		if (availability.reason === 'blocked' || availability.reason === 'not-found') return 'TARGET_SECTION_BLOCKED';
		if (availability.reason === 'full') return 'TARGET_SECTION_FULL';
		return undefined;
	}
}

export interface TwinJunctionAdvanceRequest {
	entityId: string;
	currentSectionId?: string;
	junctionPointId: string;
	context: TwinRouteRoutingContext;
	manualEdgeId?: string;
	now?: number;
}

/** 编排 Manager 的确定性入口，供 Three.js 渲染器、仿真器和未来服务端运行器共同复用。 */
export class TwinMaterialFlowRuntime {
	readonly eventBus = new TwinFlowEventBus();
	readonly sections: TwinSectionManager;
	readonly entities: TwinEntityManager;
	readonly junctions: TwinJunctionManager;
	private route: TwinRouteDefinition;

	constructor(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(route);
		this.sections = new TwinSectionManager(this.route.edges, this.eventBus);
		this.entities = new TwinEntityManager(this.eventBus);
		this.junctions = new TwinJunctionManager(this.route, this.entities);
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(route);
		this.sections.setEdges(this.route.edges);
		this.junctions.setRoute(this.route);
	}

	applyRoutingContext(context: TwinRouteRoutingContext, now = Date.now()) {
		this.sections.applyRoutingContext(context, now);
	}

	resetState() {
		this.sections.resetState();
		this.entities.clear();
	}

	tryAdvanceAtJunction(request: TwinJunctionAdvanceRequest): TwinJunctionDecisionResult {
		const now = request.now ?? Date.now();
		const entity = this.entities.ensure(request.entityId, request.currentSectionId, now);
		const decisionResult = this.junctions.decide(request.entityId, request.junctionPointId, request.context, request.manualEdgeId, now);
		if (!decisionResult.decision) {
			this.entities.wait(request.entityId, decisionResult.waitingReason || 'ROUTE_NOT_READY', undefined, now);
			return decisionResult;
		}
		const point = this.route.points.find((item) => item.pointId === request.junctionPointId)!;
		const waitingReason = this.junctions.canRelease(point, decisionResult.decision, request.context, this.sections, now);
		if (waitingReason) {
			this.entities.wait(request.entityId, waitingReason, decisionResult.decision.targetSectionId, now);
			return { decision: decisionResult.decision, waitingReason };
		}
		const transfer = this.sections.tryTransfer(request.entityId, entity.currentSectionId, decisionResult.decision.targetSectionId, now, entity.entityType);
		if (!transfer.canAccept) {
			const reason: TwinFlowWaitingReason = transfer.reason === 'signal-stale' ? 'TARGET_SECTION_SIGNAL_STALE' : transfer.reason === 'unit-type-not-allowed' ? 'TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED' : transfer.reason === 'full' ? 'TARGET_SECTION_FULL' : 'TARGET_SECTION_BLOCKED';
			this.entities.wait(request.entityId, reason, decisionResult.decision.targetSectionId, now);
			return { decision: decisionResult.decision, waitingReason: reason };
		}
		this.entities.resume(request.entityId, decisionResult.decision.targetSectionId, now);
		this.entities.releaseDecision(request.entityId, now);
		return { decision: decisionResult.decision };
	}

	/** 从等待实体沿目标 Section 追踪，返回可被 MCP 直接解释的阻塞链。 */
	getBlockingChain(entityId: string) {
		const chain: Array<{ entityId: string; sectionId?: string; waitingForSectionId?: string; reason?: TwinFlowWaitingReason }> = [];
		const visited = new Set<string>();
		let current = this.entities.get(entityId);
		while (current && !visited.has(current.entityId)) {
			visited.add(current.entityId);
			chain.push({ entityId: current.entityId, sectionId: current.currentSectionId, waitingForSectionId: current.waitingForSectionId, reason: current.waitingReason });
			if (!current.waitingForSectionId) break;
			current = this.entities.getAll().find((candidate) => candidate.currentSectionId === current!.waitingForSectionId && candidate.state === 'waiting');
		}
		return chain;
	}
}
