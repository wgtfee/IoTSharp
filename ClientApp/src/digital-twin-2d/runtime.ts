import type { TwinDataUpdate } from '/@/api/digital-twin';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import type { Twin2DObjectView } from './types';
import { resolveRoutePath, type TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';
import { telemetryBoolean, transformTwinBindingValue } from '/@/digital-twin/bindings/BindingValueTransform';
import { parseRouteSlotArray, routeSlotProgress } from '/@/digital-twin/bindings/RouteSlotArray';
import type { Twin2DViewDefinition } from './types';

export interface Twin2DObjectRuntimeState {
	quality: 'good' | 'stale' | 'bad' | 'missing' | 'waiting';
	running: boolean;
	fault: boolean;
	visible: boolean;
	blocked: boolean;
	waiting: boolean;
	occupancy?: number;
	capacity?: number;
	reserved?: number;
	routeProgress?: number;
	routeId?: string;
	color?: string;
	text?: string;
	statusText: string;
	lastUpdated?: string;
	values: Record<string, unknown>;
}

const truthy = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'running';
const keyText = (binding: any) => `${binding?.source?.key || ''} ${binding?.target?.kind || ''} ${binding?.target?.property || ''}`.toLowerCase();

/** 数据库快照的 bindingId 是版本行 GUID，业务声明须按 bindingKey 对齐。 */
export const mapTwin2DUpdates = (updates: TwinDataUpdate[]) => {
	const map = new Map<string, TwinDataUpdate>();
	for (const update of updates) if (update.bindingId) map.set(update.bindingId, update);
	for (const update of updates) if (update.bindingKey) map.set(update.bindingKey, update);
	return map;
};

const qualityRank = { good: 0, waiting: 1, stale: 2, missing: 3, bad: 4 } as const;
const worsen = (current: Twin2DObjectRuntimeState['quality'], next: Twin2DObjectRuntimeState['quality']) =>
	qualityRank[next] > qualityRank[current] ? next : current;

export const resolveTwin2DRuntimeStates = (
	objects: Twin2DObjectView[],
	manifest: TwinSceneManifest,
	updates: TwinDataUpdate[],
): Record<string, Twin2DObjectRuntimeState> => {
	const updateMap = mapTwin2DUpdates(updates);
	const result: Record<string, Twin2DObjectRuntimeState> = {};
	for (const object of objects) {
		const bindings = object.businessObjectId ? (manifest.bindings || []).filter((item) => item.objectId === object.businessObjectId && item.enabled !== false) : [];
		let quality: Twin2DObjectRuntimeState['quality'] = bindings.length ? 'waiting' : 'good';
		let running = false;
		let fault = false;
		let visible = true;
		let blocked = false;
		let waiting = false;
		let occupancy: number | undefined;
		let capacity: number | undefined;
		let reserved: number | undefined;
		let routeProgress: number | undefined;
		let routeId: string | undefined;
		let color: string | undefined;
		let text: string | undefined;
		let lastUpdated: string | undefined;
		let missingUpdate = false;
		const values: Record<string, unknown> = {};
		for (const binding of bindings) {
			const update = updateMap.get(binding.bindingId);
			if (!update) { missingUpdate = true; continue; }
			values[binding.source.key || binding.bindingId] = update.value;
			lastUpdated = update.sourceTimestamp || lastUpdated;
			const receivedQuality = update.stale || update.quality === 'stale' ? 'stale' : update.quality;
			quality = quality === 'waiting' ? receivedQuality : worsen(quality, receivedQuality);
			if (receivedQuality !== 'good') continue;
			const transformed = transformTwinBindingValue(binding, update.value);
			const key = keyText(binding);
			if (binding.target.kind === 'animation') running ||= binding.transform.kind === 'booleanAnimation' ? Number.isFinite(Number(transformed)) && Number(transformed) !== 0 : telemetryBoolean(transformed);
			else if (key.includes('running') || key.includes('run')) running ||= truthy(transformed);
			if (key.includes('fault') || key.includes('alarm') || key.includes('error')) fault ||= truthy(update.value) || (typeof update.value === 'number' && update.value > 0);
			if (binding.target.kind === 'visible') visible = telemetryBoolean(transformed);
			if (key.includes('blocked') || key.includes('block')) blocked ||= truthy(update.value);
			if (key.includes('waiting') || key.includes('wait')) waiting ||= truthy(update.value);
			if (key.includes('occupancy') && Number.isFinite(Number(update.value))) occupancy = Number(update.value);
			if (key.includes('capacity') && Number.isFinite(Number(update.value))) capacity = Number(update.value);
			if (key.includes('reserved') && Number.isFinite(Number(update.value))) reserved = Number(update.value);
			if (binding.target.kind === 'color' && typeof transformed === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(transformed)) color = transformed;
			if (binding.target.kind === 'text') text = String(transformed ?? '');
			if ((binding.target.kind === 'routeProgress' || key.includes('routeprogress') || key === 'progress') && Number.isFinite(Number(update.value))) {
				if (Number.isFinite(Number(transformed))) routeProgress = Math.max(0, Math.min(1, Number(transformed)));
				routeId = String((binding.transform as any).routeId || binding.target.property || '').replace(/^routeProgress:/, '') || undefined;
			}
		}
		if (missingUpdate) quality = worsen(quality, 'missing');
		if (capacity !== undefined && occupancy !== undefined && occupancy + (reserved || 0) >= capacity) blocked = true;
		const statusText = fault ? 'FAULT' : quality === 'stale' ? 'STALE' : quality === 'bad' || quality === 'missing' ? quality.toUpperCase() : quality === 'waiting' ? 'WAITING' : blocked ? 'BLOCKED' : waiting ? 'WAITING' : running ? 'RUNNING' : bindings.length ? 'IDLE' : 'UNBOUND';
		result[object.id] = { quality, running, fault, visible, blocked, waiting, occupancy, capacity, reserved, routeProgress, routeId, color, text, statusText, lastUpdated, values };
	}
	return result;
};

export const interpolateTwin2DRoute = (manifest: TwinSceneManifest, routePoints: Record<string, { x: number; y: number }>, progress: number, routeId?: string, context: TwinRouteRoutingContext = {}) => {
	if (!Number.isFinite(progress)) return undefined;
	const route = routeId ? manifest.routes?.find((item) => item.routeId === routeId) : manifest.routes?.length === 1 ? manifest.routes[0] : undefined;
	if (!route?.edges?.length) return undefined;
	const path = resolveRoutePath(route, { dataMode: manifest.runtime.dataMode, ...context });
	if (path.unresolvedJunctionPointId || !path.edgeIds.length) return undefined;
	const edges = new Map(route.edges.map(edge => [edge.edgeId, edge]));
	const segments = path.edgeIds.flatMap((edgeId, index) => {
		const edge = edges.get(edgeId);
		const fromId = path.points[index]?.pointId;
		const toId = path.points[index + 1]?.pointId || (path.closed ? path.points[0]?.pointId : undefined);
		if (!edge || !fromId || !toId || !((edge.fromPointId === fromId && edge.toPointId === toId) || (edge.bidirectional && edge.toPointId === fromId && edge.fromPointId === toId))) return [];
		const from = routePoints[fromId];
		const to = routePoints[toId];
		if (!from || !to) return [];
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		return length > 0 ? [{ from, to, length }] : [];
	});
	if (segments.length !== path.edgeIds.length) return undefined;
	const total = segments.reduce((sum, item) => sum + item.length, 0);
	if (!total) return undefined;
	let remaining = Math.max(0, Math.min(1, progress)) * total;
	for (const segment of segments) {
		if (remaining <= segment.length) {
			const t = remaining / segment.length;
			return {
				x: segment.from.x + (segment.to.x - segment.from.x) * t,
				y: segment.from.y + (segment.to.y - segment.from.y) * t,
			};
		}
		remaining -= segment.length;
	}
	return { ...segments[segments.length - 1].to };
};

/** 把批量遥测交给共享路线引擎，未收到和坏质量的决策值不可触发分流。 */
export const resolveTwin2DRoutingContext = (manifest: TwinSceneManifest, updates: TwinDataUpdate[]): TwinRouteRoutingContext => {
	const map = mapTwin2DUpdates(updates);
	const keys = new Set((manifest.bindings || []).filter(binding => binding.enabled !== false).map(binding => binding.bindingId));
	for (const route of manifest.routes || []) {
		for (const point of route.points || []) if (point.actuatorBindingId) keys.add(point.actuatorBindingId);
		for (const rule of route.decisionRules || []) if (rule.bindingId) keys.add(rule.bindingId);
		for (const edge of route.edges || []) for (const id of [edge.occupancyBindingId, edge.fullBindingId, edge.blockedBindingId, edge.readyBindingId, edge.releasePermitBindingId]) if (id) keys.add(id);
	}
	const bindingValues: Record<string, unknown> = {}, staleBindingIds: string[] = [];
	for (const id of keys) {
		const update = map.get(id);
		if (!update || update.stale || update.quality !== 'good') staleBindingIds.push(id);
		else bindingValues[id] = update.value;
	}
	return { dataMode: 'live', bindingValues, staleBindingIds };
};

/** Designer 预览与线上 Viewer 使用同一份 PLC 槽位数组和路线解析结果。 */
export const resolveTwin2DRouteSlotPallets = (manifest: TwinSceneManifest, view: Twin2DViewDefinition, updates: TwinDataUpdate[]) => {
	const map = mapTwin2DUpdates(updates), context = resolveTwin2DRoutingContext(manifest, updates);
	const result: Array<{ key: string; palletId: string; slotIndex: number; x: number; y: number; routeName: string }> = [];
	for (const binding of manifest.bindings || []) {
		if (binding.enabled === false || binding.transform.kind !== 'routeSlotArray') continue;
		const update = map.get(binding.bindingId);
		if (!update || update.stale || update.quality !== 'good') continue;
		const config = binding.transform as Record<string, unknown>;
		const routeId = String(config.routeId || '').trim() || String(binding.target.property || '').replace(/^routeSlots:/, '');
		const route = manifest.routes?.find(item => item.routeId === routeId);
		if (!route) continue;
		for (const slot of parseRouteSlotArray(update.value, config.emptyValue ?? 0)) {
			const position = interpolateTwin2DRoute(manifest, view.routePoints, routeSlotProgress(slot.slotIndex, slot.slotCount, route.loop === true), routeId, context);
			if (position) result.push({ ...position, key: `${binding.bindingId}:${slot.slotIndex}:${slot.palletId}`, palletId: slot.palletId, slotIndex: slot.slotIndex, routeName: route.name });
		}
	}
	return result;
};

export interface Twin2DRouteRuntimeState {
	edgeId: string;
	blocked: boolean;
	full: boolean;
	stale: boolean;
	occupancy?: number;
	capacity?: number;
	reserved?: number;
}

export const resolveTwin2DRouteRuntimeStates = (manifest: TwinSceneManifest, updates: TwinDataUpdate[], dataMode = manifest.runtime.dataMode): Record<string, Twin2DRouteRuntimeState> => {
	const updateMap = mapTwin2DUpdates(updates);
	const result: Record<string, Twin2DRouteRuntimeState> = {};
	for (const route of manifest.routes || []) for (const edge of route.edges || []) {
		const occupancyUpdate = edge.occupancyBindingId ? updateMap.get(edge.occupancyBindingId) : undefined;
		const fullUpdate = edge.fullBindingId ? updateMap.get(edge.fullBindingId) : undefined;
		const blockedUpdate = edge.blockedBindingId ? updateMap.get(edge.blockedBindingId) : undefined;
		const readyUpdate = edge.readyBindingId ? updateMap.get(edge.readyBindingId) : undefined;
		const permitUpdate = edge.releasePermitBindingId ? updateMap.get(edge.releasePermitBindingId) : undefined;
		const valid = (update?: TwinDataUpdate) => update && !update.stale && update.quality === 'good';
		const occupancy = valid(occupancyUpdate) && Number.isFinite(Number(occupancyUpdate!.value)) ? Number(occupancyUpdate!.value) : undefined;
		const capacity = Number.isFinite(Number(edge.capacity)) ? Number(edge.capacity) : undefined;
		const reserved = 0;
		const expected = [
			{ configured: Boolean(edge.occupancyBindingId), update: occupancyUpdate },
			{ configured: Boolean(edge.fullBindingId), update: fullUpdate },
			{ configured: Boolean(edge.blockedBindingId), update: blockedUpdate },
			{ configured: Boolean(edge.readyBindingId), update: readyUpdate },
			{ configured: Boolean(edge.releasePermitBindingId), update: permitUpdate },
		];
		const stale = dataMode === 'live' && expected.some(({ configured, update }) => configured && (!update || update.stale || update.quality !== 'good'));
		const full = (valid(fullUpdate) && truthy(fullUpdate!.value)) || (capacity !== undefined && occupancy !== undefined && occupancy + reserved >= capacity);
		const blocked = edge.blocked === true || (valid(blockedUpdate) && truthy(blockedUpdate!.value)) || (valid(readyUpdate) && !telemetryBoolean(readyUpdate!.value)) || (valid(permitUpdate) && !telemetryBoolean(permitUpdate!.value)) || full || stale;
		result[edge.edgeId] = { edgeId: edge.edgeId, blocked, full, stale, occupancy, capacity, reserved };
	}
	return result;
};
