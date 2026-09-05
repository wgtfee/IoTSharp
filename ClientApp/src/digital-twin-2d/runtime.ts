import type { TwinDataUpdate } from '/@/api/digital-twin';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import type { Twin2DObjectView } from './types';

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
	statusText: string;
	lastUpdated?: string;
	values: Record<string, unknown>;
}

const truthy = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'running';
const keyText = (binding: any) => `${binding?.source?.key || ''} ${binding?.target?.kind || ''} ${binding?.target?.property || ''}`.toLowerCase();

export const resolveTwin2DRuntimeStates = (
	objects: Twin2DObjectView[],
	manifest: TwinSceneManifest,
	updates: TwinDataUpdate[],
): Record<string, Twin2DObjectRuntimeState> => {
	const updateMap = new Map(updates.map((item) => [item.bindingId, item]));
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
		let lastUpdated: string | undefined;
		const values: Record<string, unknown> = {};
		for (const binding of bindings) {
			const update = updateMap.get(binding.bindingId);
			if (!update) continue;
			values[binding.source.key || binding.bindingId] = update.value;
			lastUpdated = update.sourceTimestamp || update.serverTimestamp || lastUpdated;
			if (update.stale || update.quality === 'stale') quality = 'stale';
			else if (['bad', 'missing'].includes(update.quality)) quality = update.quality as 'bad' | 'missing';
			else if (quality === 'waiting' || quality === 'good') quality = 'good';
			const key = keyText(binding);
			if (binding.target.kind === 'animation' || key.includes('running') || key.includes('run')) running ||= truthy(update.value);
			if (key.includes('fault') || key.includes('alarm') || key.includes('error')) fault ||= truthy(update.value) || (typeof update.value === 'number' && update.value > 0);
			if (binding.target.kind === 'visible') visible = truthy(update.value);
			if (key.includes('blocked') || key.includes('block')) blocked ||= truthy(update.value);
			if (key.includes('waiting') || key.includes('wait')) waiting ||= truthy(update.value);
			if (key.includes('occupancy') && Number.isFinite(Number(update.value))) occupancy = Number(update.value);
			if (key.includes('capacity') && Number.isFinite(Number(update.value))) capacity = Number(update.value);
			if (key.includes('reserved') && Number.isFinite(Number(update.value))) reserved = Number(update.value);
			if ((binding.target.kind === 'routeProgress' || key.includes('routeprogress') || key === 'progress') && Number.isFinite(Number(update.value))) routeProgress = Math.max(0, Math.min(1, Number(update.value)));
		}
		if (capacity !== undefined && occupancy !== undefined && occupancy + (reserved || 0) >= capacity) blocked = true;
		const statusText = fault ? 'FAULT' : quality === 'stale' ? 'STALE' : quality === 'bad' || quality === 'missing' ? quality.toUpperCase() : blocked ? 'BLOCKED' : waiting ? 'WAITING' : running ? 'RUNNING' : bindings.length ? 'IDLE' : 'UNBOUND';
		result[object.id] = { quality, running, fault, visible, blocked, waiting, occupancy, capacity, reserved, routeProgress, statusText, lastUpdated, values };
	}
	return result;
};

export const interpolateTwin2DRoute = (manifest: TwinSceneManifest, routePoints: Record<string, { x: number; y: number }>, progress: number, routeId?: string) => {
	const route = routeId ? manifest.routes?.find((item) => item.routeId === routeId) : manifest.routes?.[0];
	if (!route?.edges?.length) return undefined;
	const segments = route.edges.flatMap((edge) => {
		const from = routePoints[edge.fromPointId];
		const to = routePoints[edge.toPointId];
		if (!from || !to || edge.enabled === false) return [];
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		return length > 0 ? [{ from, to, length }] : [];
	});
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

export interface Twin2DRouteRuntimeState {
	edgeId: string;
	blocked: boolean;
	full: boolean;
	stale: boolean;
	occupancy?: number;
	capacity?: number;
	reserved?: number;
}

export const resolveTwin2DRouteRuntimeStates = (manifest: TwinSceneManifest, updates: TwinDataUpdate[]): Record<string, Twin2DRouteRuntimeState> => {
	const updateMap = new Map(updates.map((item) => [item.bindingId, item]));
	const result: Record<string, Twin2DRouteRuntimeState> = {};
	for (const route of manifest.routes || []) for (const edge of route.edges || []) {
		const occupancyUpdate = edge.occupancyBindingId ? updateMap.get(edge.occupancyBindingId) : undefined;
		const fullUpdate = edge.fullBindingId ? updateMap.get(edge.fullBindingId) : undefined;
		const blockedUpdate = edge.blockedBindingId ? updateMap.get(edge.blockedBindingId) : undefined;
		const occupancy = occupancyUpdate && Number.isFinite(Number(occupancyUpdate.value)) ? Number(occupancyUpdate.value) : undefined;
		const capacity = Number.isFinite(Number(edge.capacity)) ? Number(edge.capacity) : undefined;
		const reserved = 0;
		const stale = Boolean(occupancyUpdate?.stale || fullUpdate?.stale || blockedUpdate?.stale);
		const full = truthy(fullUpdate?.value) || (capacity !== undefined && occupancy !== undefined && occupancy + reserved >= capacity);
		const blocked = truthy(blockedUpdate?.value) || full || stale;
		result[edge.edgeId] = { edgeId: edge.edgeId, blocked, full, stale, occupancy, capacity, reserved };
	}
	return result;
};
