"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/digital-twin/runtime/TwinMaterialFlowRuntime.ts
var TwinMaterialFlowRuntime_exports = {};
__export(TwinMaterialFlowRuntime_exports, {
  TwinEntityManager: () => TwinEntityManager,
  TwinFlowEventBus: () => TwinFlowEventBus,
  TwinJunctionManager: () => TwinJunctionManager,
  TwinMaterialFlowRuntime: () => TwinMaterialFlowRuntime,
  TwinSectionManager: () => TwinSectionManager
});
module.exports = __toCommonJS(TwinMaterialFlowRuntime_exports);

// src/digital-twin/contracts/index.ts
var createId = (prefix) => {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`;
};
var createRouteEdge = (fromPointId, toPointId, index) => ({
  edgeId: createId("route-edge"),
  fromPointId,
  toPointId,
  name: `\u8DEF\u7EBF\u6BB5 ${index + 1}`,
  bidirectional: false,
  enabled: true,
  priority: 0,
  capacity: 1,
  occupancyMode: "calculated",
  reservationTimeoutSeconds: 30
});
var normalizeTwinRoute = (route) => {
  const points = (route.points || []).map((point) => {
    const isJunction = ["junction", "diverter", "merger"].includes(point.kind || "");
    const inferredDecisionMode = route.routingMode === "automatic" ? (route.decisionRules || []).some((rule) => rule.junctionPointId === point.pointId && rule.source === "binding") ? "plc" : "simulation" : "manual";
    return {
      ...point,
      kind: point.kind || "waypoint",
      decisionMode: isJunction ? point.decisionMode || inferredDecisionMode : point.decisionMode,
      decisionTimeoutSeconds: isJunction ? point.decisionTimeoutSeconds ?? 10 : point.decisionTimeoutSeconds
    };
  });
  const configuredEdges = Array.isArray(route.edges) ? route.edges : [];
  const edges = configuredEdges.length > 0 ? configuredEdges.map((edge) => ({
    ...edge,
    bidirectional: edge.bidirectional === true,
    enabled: edge.enabled !== false,
    priority: edge.priority ?? 0,
    capacity: edge.capacity ?? 1,
    occupancyMode: edge.occupancyMode || (edge.occupancyBindingId || edge.fullBindingId ? "live" : "calculated"),
    reservationTimeoutSeconds: edge.reservationTimeoutSeconds ?? 30
  })) : points.slice(1).map((point, index) => createRouteEdge(points[index].pointId, point.pointId, index));
  if (configuredEdges.length === 0 && route.loop && points.length > 2) edges.push(createRouteEdge(points[points.length - 1].pointId, points[0].pointId, edges.length));
  return {
    ...route,
    points,
    edges,
    startPointId: route.startPointId && points.some((point) => point.pointId === route.startPointId) ? route.startPointId : points[0]?.pointId,
    junctionDecisions: { ...route.junctionDecisions || {} },
    routingMode: route.routingMode || "manual",
    decisionRules: (route.decisionRules || []).map((rule) => ({ ...rule, enabled: rule.enabled !== false, priority: rule.priority ?? 0 }))
  };
};

// src/digital-twin/runtime/TwinMaterialFlowRuntime.ts
var TwinFlowEventBus = class {
  listeners = /* @__PURE__ */ new Set();
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
};
var isSignalTrue = (value) => value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
var TwinSectionManager = class {
  constructor(edges, eventBus = new TwinFlowEventBus()) {
    this.eventBus = eventBus;
    this.setEdges(edges);
  }
  sections = /* @__PURE__ */ new Map();
  setEdges(edges) {
    const previous = new Map(this.sections);
    this.sections.clear();
    for (const edge of edges) {
      const old = previous.get(edge.edgeId);
      this.sections.set(edge.edgeId, {
        edge: { ...edge },
        entities: old?.entities ?? /* @__PURE__ */ new Set(),
        reservations: old?.reservations ?? /* @__PURE__ */ new Map(),
        inFlight: old?.inFlight ?? /* @__PURE__ */ new Map(),
        liveOccupancy: old?.liveOccupancy,
        liveFull: old?.liveFull,
        blockedSignal: old?.blockedSignal ?? false,
        signalStale: old?.signalStale ?? false
      });
    }
  }
  applyRoutingContext(context, now = Date.now()) {
    const stale = new Set(context.staleBindingIds || []);
    for (const record of this.sections.values()) {
      const { edge } = record;
      const oldLiveOccupancy = record.liveOccupancy;
      if (edge.occupancyBindingId && !stale.has(edge.occupancyBindingId)) {
        const value = Number(context.bindingValues?.[edge.occupancyBindingId]);
        if (Number.isFinite(value)) record.liveOccupancy = Math.max(0, Math.floor(value));
      } else if (context.edgeOccupancy?.[edge.edgeId] !== void 0) {
        const value = Number(context.edgeOccupancy[edge.edgeId]);
        if (Number.isFinite(value)) record.liveOccupancy = Math.max(0, Math.floor(value));
      }
      if (edge.fullBindingId && !stale.has(edge.fullBindingId)) record.liveFull = isSignalTrue(context.bindingValues?.[edge.fullBindingId]);
      record.blockedSignal = edge.blockedBindingId ? isSignalTrue(context.bindingValues?.[edge.blockedBindingId]) : false;
      record.signalStale = Boolean(
        edge.occupancyBindingId && stale.has(edge.occupancyBindingId) || edge.fullBindingId && stale.has(edge.fullBindingId) || edge.blockedBindingId && stale.has(edge.blockedBindingId)
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
  getSnapshot(sectionId, now = Date.now()) {
    this.expireReservations(now);
    const record = this.sections.get(sectionId);
    if (!record) return void 0;
    const capacity = Math.max(1, Math.floor(record.edge.capacity ?? 1));
    const occupancyMode = record.edge.occupancyMode || (record.edge.occupancyBindingId || record.edge.fullBindingId ? "live" : "calculated");
    const occupancy = occupancyMode === "live" ? Math.max(0, record.liveOccupancy ?? 0) : record.entities.size;
    const reserved = record.reservations.size + record.inFlight.size;
    const state = record.signalStale ? "signal-stale" : record.edge.blocked === true || record.blockedSignal ? "blocked" : record.liveFull === true || occupancy + reserved >= capacity ? "full" : "available";
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
      reservationEntityIds: [...record.reservations.keys(), ...record.inFlight.keys()]
    };
  }
  getSnapshots(now = Date.now()) {
    return [...this.sections.keys()].map((sectionId) => this.getSnapshot(sectionId, now)).filter(Boolean);
  }
  canAccept(sectionId, entityId, now = Date.now()) {
    const snapshot = this.getSnapshot(sectionId, now);
    if (!snapshot) return { canAccept: false, reason: "not-found" };
    if (snapshot.state === "signal-stale") return { canAccept: false, reason: "signal-stale" };
    if (snapshot.state === "blocked") return { canAccept: false, reason: "blocked" };
    if (entityId && (snapshot.entityIds.includes(entityId) || snapshot.reservationEntityIds.includes(entityId))) return { canAccept: true };
    if (snapshot.available <= 0 || snapshot.state === "full") return { canAccept: false, reason: "full" };
    return { canAccept: true };
  }
  reserve(sectionId, entityId, now = Date.now()) {
    const record = this.sections.get(sectionId);
    const availability = this.canAccept(sectionId, entityId, now);
    if (!record || !availability.canAccept) return availability;
    if (record.entities.has(entityId) || record.reservations.has(entityId) || record.inFlight.has(entityId)) return { canAccept: true };
    const timeoutMs = Math.max(1e3, Number(record.edge.reservationTimeoutSeconds ?? 30) * 1e3);
    record.reservations.set(entityId, { entityId, createdAt: now, expiresAt: now + timeoutMs });
    this.eventBus.emit({ type: "SectionReserved", timestamp: now, entityId, sectionId });
    return { canAccept: true };
  }
  releaseReservation(sectionId, entityId, now = Date.now(), reason = "released") {
    const record = this.sections.get(sectionId);
    if (!record) return false;
    const removed = record.reservations.delete(entityId) || record.inFlight.delete(entityId);
    if (removed) this.eventBus.emit({ type: reason === "expired" ? "SectionReservationExpired" : "SectionReservationReleased", timestamp: now, entityId, sectionId, reason });
    return removed;
  }
  enter(sectionId, entityId, now = Date.now()) {
    const record = this.sections.get(sectionId);
    if (!record) return false;
    if (!record.reservations.has(entityId) && !record.entities.has(entityId) && !record.inFlight.has(entityId)) {
      const reserved = this.reserve(sectionId, entityId, now);
      if (!reserved.canAccept) return false;
    }
    const reservation = record.reservations.get(entityId);
    record.reservations.delete(entityId);
    const mode = record.edge.occupancyMode || (record.edge.occupancyBindingId || record.edge.fullBindingId ? "live" : "calculated");
    if (mode === "live") {
      const timeoutMs = Math.max(1e3, Number(record.edge.reservationTimeoutSeconds ?? 30) * 1e3);
      record.inFlight.set(entityId, reservation ?? { entityId, createdAt: now, expiresAt: now + timeoutMs });
    } else {
      record.entities.add(entityId);
    }
    this.eventBus.emit({ type: "EntityEnteredSection", timestamp: now, entityId, sectionId, reason: "entered" });
    return true;
  }
  leave(sectionId, entityId, now = Date.now()) {
    const record = this.sections.get(sectionId);
    if (!record) return false;
    const removed = record.entities.delete(entityId) || record.inFlight.delete(entityId);
    if (removed) this.eventBus.emit({ type: "EntityLeftSection", timestamp: now, entityId, sectionId });
    return removed;
  }
  /** 目标段成功 Enter 后才释放源段；失败时源段状态不变。 */
  tryTransfer(entityId, sourceSectionId, targetSectionId, now = Date.now()) {
    const reserved = this.reserve(targetSectionId, entityId, now);
    if (!reserved.canAccept) return reserved;
    if (!this.enter(targetSectionId, entityId, now)) {
      this.releaseReservation(targetSectionId, entityId, now);
      return { canAccept: false, reason: "blocked" };
    }
    if (sourceSectionId && sourceSectionId !== targetSectionId) this.leave(sourceSectionId, entityId, now);
    return { canAccept: true };
  }
  expireReservations(now) {
    for (const [sectionId, record] of this.sections) {
      for (const reservation of [...record.reservations.values(), ...record.inFlight.values()]) {
        if (reservation.expiresAt <= now) this.releaseReservation(sectionId, reservation.entityId, now, "expired");
      }
    }
  }
};
var readPayloadValue = (payload, path) => {
  if (!payload || !path) return void 0;
  return path.split(".").filter(Boolean).reduce((value, key) => value && typeof value === "object" ? value[key] : void 0, payload);
};
var valuesEqual = (actual, expected) => {
  if (typeof actual === "number") return actual === Number(expected);
  if (typeof actual === "boolean") return actual === (expected === true || expected === 1 || expected === "1" || String(expected).toLowerCase() === "true");
  return String(actual ?? "") === String(expected ?? "");
};
var matchesRule = (actual, rule) => {
  const expected = rule.matchValue;
  switch (rule.operator) {
    case "notEquals":
      return !valuesEqual(actual, expected);
    case "greaterThan":
      return Number(actual) > Number(expected);
    case "greaterThanOrEqual":
      return Number(actual) >= Number(expected);
    case "lessThan":
      return Number(actual) < Number(expected);
    case "lessThanOrEqual":
      return Number(actual) <= Number(expected);
    case "contains":
      return Array.isArray(actual) ? actual.some((item) => valuesEqual(item, expected)) : String(actual ?? "").includes(String(expected ?? ""));
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    default:
      return valuesEqual(actual, expected);
  }
};
var TwinEntityManager = class {
  constructor(eventBus = new TwinFlowEventBus()) {
    this.eventBus = eventBus;
  }
  entities = /* @__PURE__ */ new Map();
  ensure(entityId, currentSectionId, now = Date.now()) {
    let entity = this.entities.get(entityId);
    if (!entity) {
      entity = { entityId, currentSectionId, state: "moving", routeTrace: [], updatedAt: now };
      this.entities.set(entityId, entity);
    } else if (currentSectionId !== void 0) entity.currentSectionId = currentSectionId;
    return entity;
  }
  get(entityId) {
    const entity = this.entities.get(entityId);
    return entity ? structuredClone(entity) : void 0;
  }
  getAll() {
    return [...this.entities.values()].map((entity) => structuredClone(entity));
  }
  lockDecision(entityId, decision) {
    const entity = this.ensure(entityId, void 0, decision.decidedAt);
    if (entity.activeDecision) return entity.activeDecision;
    entity.activeDecision = decision;
    entity.routeTrace.push(decision);
    entity.updatedAt = decision.decidedAt;
    this.eventBus.emit({ type: "RouteDecisionLocked", timestamp: decision.decidedAt, entityId, junctionPointId: decision.junctionPointId, payload: { edgeId: decision.edgeId, source: decision.source } });
    return decision;
  }
  releaseDecision(entityId, now = Date.now()) {
    const entity = this.entities.get(entityId);
    if (!entity?.activeDecision) return;
    const junctionPointId = entity.activeDecision.junctionPointId;
    delete entity.activeDecision;
    entity.updatedAt = now;
    this.eventBus.emit({ type: "RouteDecisionReleased", timestamp: now, entityId, junctionPointId });
  }
  wait(entityId, reason, targetSectionId, now = Date.now()) {
    const entity = this.ensure(entityId, void 0, now);
    entity.state = "waiting";
    entity.waitingReason = reason;
    entity.waitingForSectionId = targetSectionId;
    entity.updatedAt = now;
    this.eventBus.emit({ type: "EntityWaiting", timestamp: now, entityId, sectionId: entity.currentSectionId, reason, payload: { targetSectionId } });
  }
  resume(entityId, targetSectionId, now = Date.now()) {
    const entity = this.ensure(entityId, targetSectionId, now);
    const wasWaiting = entity.state === "waiting";
    entity.currentSectionId = targetSectionId;
    entity.state = "moving";
    delete entity.waitingReason;
    delete entity.waitingForSectionId;
    entity.updatedAt = now;
    if (wasWaiting) this.eventBus.emit({ type: "EntityResumed", timestamp: now, entityId, sectionId: targetSectionId });
  }
};
var TwinJunctionManager = class {
  constructor(route, entities) {
    this.route = route;
    this.entities = entities;
    this.route = normalizeTwinRoute(route);
  }
  setRoute(route) {
    this.route = normalizeTwinRoute(route);
  }
  decide(entityId, junctionPointId, context, manualEdgeId, now = Date.now()) {
    const existing = this.entities.get(entityId)?.activeDecision;
    if (existing?.junctionPointId === junctionPointId) return { decision: existing };
    const point = this.route.points.find((item) => item.pointId === junctionPointId);
    if (!point) return { waitingReason: "ROUTE_NOT_READY" };
    const candidates = this.route.edges.filter((edge) => edge.enabled !== false && (edge.fromPointId === junctionPointId || edge.bidirectional && edge.toPointId === junctionPointId));
    const bindingRules = this.route.decisionRules.filter((rule) => rule.enabled !== false && rule.junctionPointId === junctionPointId && rule.source === "binding");
    const mode = point.decisionMode || (this.route.routingMode === "automatic" ? bindingRules.length ? "plc" : "simulation" : "manual");
    const staleBindings = new Set(context.staleBindingIds || []);
    let selectedEdgeId;
    let selectedRule;
    let sourceValue;
    if (mode === "manual") selectedEdgeId = manualEdgeId || this.route.junctionDecisions[junctionPointId];
    else {
      const rules = this.route.decisionRules.filter((rule) => rule.enabled !== false && rule.junctionPointId === junctionPointId && (mode === "plc" ? rule.source === "binding" : true)).sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.ruleId.localeCompare(right.ruleId));
      selectedRule = rules.find((rule) => {
        if (rule.source === "binding" && (!rule.bindingId || staleBindings.has(rule.bindingId))) return false;
        const actual = rule.source === "binding" ? context.bindingValues?.[rule.bindingId || ""] : readPayloadValue(context.payload, rule.payloadKey);
        if (!matchesRule(actual, rule)) return false;
        sourceValue = actual;
        return true;
      });
      selectedEdgeId = selectedRule?.edgeId;
    }
    if (!selectedEdgeId || !candidates.some((edge) => edge.edgeId === selectedEdgeId)) return { waitingReason: "ROUTE_NOT_READY" };
    const decision = {
      entityId,
      junctionPointId,
      edgeId: selectedEdgeId,
      targetSectionId: selectedEdgeId,
      source: mode,
      sourceValue,
      ruleId: selectedRule?.ruleId,
      expectedActuatorValue: selectedRule?.expectedActuatorValue,
      decidedAt: now
    };
    return { decision: this.entities.lockDecision(entityId, decision) };
  }
  canRelease(point, decision, context, sections, now = Date.now()) {
    if (decision.expectedActuatorValue !== void 0 && point.actuatorBindingId) {
      if ((context.staleBindingIds || []).includes(point.actuatorBindingId) || !valuesEqual(context.bindingValues?.[point.actuatorBindingId], decision.expectedActuatorValue)) return "DIVERTER_NOT_READY";
    }
    const availability = sections.canAccept(decision.targetSectionId, decision.entityId, now);
    if (availability.reason === "signal-stale") return "TARGET_SECTION_SIGNAL_STALE";
    if (availability.reason === "blocked" || availability.reason === "not-found") return "TARGET_SECTION_BLOCKED";
    if (availability.reason === "full") return "TARGET_SECTION_FULL";
    return void 0;
  }
};
var TwinMaterialFlowRuntime = class {
  eventBus = new TwinFlowEventBus();
  sections;
  entities;
  junctions;
  route;
  constructor(route) {
    this.route = normalizeTwinRoute(route);
    this.sections = new TwinSectionManager(this.route.edges, this.eventBus);
    this.entities = new TwinEntityManager(this.eventBus);
    this.junctions = new TwinJunctionManager(this.route, this.entities);
  }
  setRoute(route) {
    this.route = normalizeTwinRoute(route);
    this.sections.setEdges(this.route.edges);
    this.junctions.setRoute(this.route);
  }
  applyRoutingContext(context, now = Date.now()) {
    this.sections.applyRoutingContext(context, now);
  }
  tryAdvanceAtJunction(request) {
    const now = request.now ?? Date.now();
    const entity = this.entities.ensure(request.entityId, request.currentSectionId, now);
    const decisionResult = this.junctions.decide(request.entityId, request.junctionPointId, request.context, request.manualEdgeId, now);
    if (!decisionResult.decision) {
      this.entities.wait(request.entityId, decisionResult.waitingReason || "ROUTE_NOT_READY", void 0, now);
      return decisionResult;
    }
    const point = this.route.points.find((item) => item.pointId === request.junctionPointId);
    const waitingReason = this.junctions.canRelease(point, decisionResult.decision, request.context, this.sections, now);
    if (waitingReason) {
      this.entities.wait(request.entityId, waitingReason, decisionResult.decision.targetSectionId, now);
      return { decision: decisionResult.decision, waitingReason };
    }
    const transfer = this.sections.tryTransfer(request.entityId, entity.currentSectionId, decisionResult.decision.targetSectionId, now);
    if (!transfer.canAccept) {
      const reason = transfer.reason === "signal-stale" ? "TARGET_SECTION_SIGNAL_STALE" : transfer.reason === "full" ? "TARGET_SECTION_FULL" : "TARGET_SECTION_BLOCKED";
      this.entities.wait(request.entityId, reason, decisionResult.decision.targetSectionId, now);
      return { decision: decisionResult.decision, waitingReason: reason };
    }
    this.entities.resume(request.entityId, decisionResult.decision.targetSectionId, now);
    this.entities.releaseDecision(request.entityId, now);
    return { decision: decisionResult.decision };
  }
  /** 从等待实体沿目标 Section 追踪，返回可被 MCP 直接解释的阻塞链。 */
  getBlockingChain(entityId) {
    const chain = [];
    const visited = /* @__PURE__ */ new Set();
    let current = this.entities.get(entityId);
    while (current && !visited.has(current.entityId)) {
      visited.add(current.entityId);
      chain.push({ entityId: current.entityId, sectionId: current.currentSectionId, waitingForSectionId: current.waitingForSectionId, reason: current.waitingReason });
      if (!current.waitingForSectionId) break;
      current = this.entities.getAll().find((candidate) => candidate.currentSectionId === current.waitingForSectionId && candidate.state === "waiting");
    }
    return chain;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TwinEntityManager,
  TwinFlowEventBus,
  TwinJunctionManager,
  TwinMaterialFlowRuntime,
  TwinSectionManager
});
