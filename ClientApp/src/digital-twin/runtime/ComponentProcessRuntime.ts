import * as THREE from 'three';
import type { TwinProcessDefinition, TwinRouteDefinition, TwinRouteEdgeDefinition, TwinRoutePointDefinition } from '../contracts';
import { resolveRoutePath, type RouteEngine, type TwinRouteRoutingContext } from '../routes/RouteEngine';
import { ProcessStationManager, type TwinProcessStationType } from './ProcessStationManager';

interface ComponentProcessStationInfo {
	stationId: string;
	sectionId: string;
	componentObjectId: string;
	pointId: string;
	edgeId?: string;
	distanceMeters: number;
	process: TwinProcessDefinition;
	capacity: number;
	batchSize: number;
	behaviorCompletionGroups: string[];
	behaviorCompletionRequirements: Record<string, number>;
	stopperComponentObjectId?: string;
	dataMode: 'simulation' | 'live';
}

interface ActiveProcess {
	station: ComponentProcessStationInfo;
	entityId: string;
	elapsedSeconds: number;
}

export interface ComponentProcessRuntimeSnapshot {
	requestedRunning: boolean;
	activeStationId?: string;
	activeComponentObjectId?: string;
	activeEntityId?: string;
	processedStationIds: string[];
	stations: ReturnType<ProcessStationManager['getAll']>;
}

export interface ComponentProcessRuntimeOptions {
	route: TwinRouteDefinition;
	routeEngine: RouteEngine;
	getComponentRoot: (objectId: string) => THREE.Group | undefined;
	getRoutingContext: () => TwinRouteRoutingContext;
	/** 从场景 Behavior 自动发现工位需要完成的动作组，避免 Route 重复维护动作编排信息。 */
	getBehaviorRequirements?: (objectId: string) => Record<string, number>;
	entityId?: string;
}

const hasLiveBindings = (process: TwinProcessDefinition) => Boolean(
	process.readyBindingId || process.busyBindingId || process.completeBindingId || process.resultBindingId || process.faultBindingId,
);

/**
 * 普通 V7 Component Network 的即插即用工艺运行时。
 * - 工艺组件内部 Section 中点自动成为停车位置；
 * - simulation 按 cycleSeconds 完成；live 等待标准 Binding Slot；
 * - 完成前 RouteEngine 被锁停，完成后自动恢复；
 * - 只管理普通组件路线，ProceduralPackagingLine 继续由其专用多托盘运行时负责。
 */
export class ComponentProcessRuntime {
	private route: TwinRouteDefinition;
	private stations: ComponentProcessStationInfo[] = [];
	private stationManager = new ProcessStationManager([]);
	private active?: ActiveProcess;
	private readonly processed = new Set<string>();
	private requestedRunning = false;
	private previousDistance = 0;
	private readonly entityId: string;
	private pendingStopperReset?: { objectId: string; elapsedSeconds: number };

	constructor(private readonly options: ComponentProcessRuntimeOptions) {
		this.route = structuredClone(options.route);
		this.entityId = options.entityId || 'component-route-material-01';
		this.rebuild();
	}

	setRoute(route: TwinRouteDefinition) {
		this.resetProcessMetadata();
		this.route = structuredClone(route);
		this.active = undefined;
		this.processed.clear();
		this.previousDistance = 0;
		this.rebuild();
	}

	setRunning(running: boolean) {
		this.requestedRunning = running;
		if (!this.active) this.options.routeEngine.setRunning(running);
	}

	reset() {
		this.requestedRunning = false;
		this.active = undefined;
		this.processed.clear();
		this.previousDistance = 0;
		this.stationManager.reset();
		this.resetProcessMetadata();
	}

	dispose() {
		this.reset();
	}

	/** 返回 true 时 TwinRuntime 可继续执行 RouteEngine.updateFixed。 */
	updateFixed(deltaSeconds: number) {
		this.updatePendingStopperReset(deltaSeconds);
		const routeSnapshot = this.options.routeEngine.getSnapshot();
		if (routeSnapshot.distanceMeters + 0.0001 < this.previousDistance) this.processed.clear();
		this.previousDistance = routeSnapshot.distanceMeters;

		if (this.active) {
			this.updateActive(deltaSeconds);
			return false;
		}
		if (!this.requestedRunning || routeSnapshot.lengthMeters <= 0 || routeSnapshot.state === 'waiting') return true;

		const nextDistance = routeSnapshot.distanceMeters + Math.max(0, routeSnapshot.speed) * Math.max(0, deltaSeconds);
		let nextStation = this.stations
			.filter((station) => !this.processed.has(station.stationId))
			.filter((station) => station.distanceMeters >= routeSnapshot.distanceMeters - 0.0001 && station.distanceMeters <= nextDistance + 0.0001)
			.sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
		// 闭环路线跨越 length -> 0 时必须检查新一圈起点区间。
		// 否则位于 Route 起点的机器人/工位只会在第一圈命中，后续运输单元会直接越站。
		if (!nextStation && this.route.loop && routeSnapshot.lengthMeters > 0 && nextDistance >= routeSnapshot.lengthMeters) {
			const wrappedDistance = nextDistance % routeSnapshot.lengthMeters;
			this.processed.clear();
			nextStation = this.stations
				.filter((station) => station.distanceMeters <= wrappedDistance + 0.0001)
				.sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
		}
		if (!nextStation) return true;

		if (nextStation.behaviorCompletionGroups.length && !this.prepareBehaviorBatch(nextStation)) return false;
		this.options.routeEngine.correctDistance(nextStation.distanceMeters);
		this.options.routeEngine.setRunning(false);
		if (!this.stationManager.canAccept(nextStation.sectionId, this.entityId)) return false;
		this.stationManager.arrive(nextStation.sectionId, this.entityId);
		this.active = { station: nextStation, entityId: this.entityId, elapsedSeconds: 0 };
		this.applyProcessMetadata(nextStation, 0, true);
		return false;
	}

	getSnapshot(): ComponentProcessRuntimeSnapshot {
		return {
			requestedRunning: this.requestedRunning,
			activeStationId: this.active?.station.stationId,
			activeComponentObjectId: this.active?.station.componentObjectId,
			activeEntityId: this.active?.entityId,
			processedStationIds: [...this.processed],
			stations: this.stationManager.getAll(),
		};
	}

	private updateActive(deltaSeconds: number) {
		const active = this.active!;
		active.elapsedSeconds += Math.max(0, deltaSeconds);
		const context = this.options.getRoutingContext();
		this.stationManager.updateEntity(active.station.stationId, active.entityId, deltaSeconds, {
			bindingValues: context.bindingValues,
			staleBindingIds: context.staleBindingIds,
		});
		const entity = this.stationManager.getEntity(active.station.stationId, active.entityId);
		const cycle = Math.max(0.1, active.station.process.cycleSeconds || 1);
		const progress = active.station.dataMode === 'simulation'
			? THREE.MathUtils.clamp(active.elapsedSeconds / cycle, 0, 1)
			: (active.elapsedSeconds % cycle) / cycle;
		this.applyProcessMetadata(active.station, progress, entity?.state !== 'fault');

		if (!this.stationManager.canRelease(active.station.sectionId, active.entityId).canRelease) return;
		if (active.station.behaviorCompletionGroups.length && !this.authorizeBehaviorBatchRelease(active.station, active.entityId)) return;
		this.stationManager.release(active.station.sectionId, active.entityId);
		this.processed.add(active.station.stationId);
		this.clearProcessMetadata(active.station.componentObjectId);
		this.active = undefined;
		this.options.routeEngine.setRunning(this.requestedRunning);
		if (active.station.behaviorCompletionGroups.length) this.finishBehaviorBatchRelease(active.station, active.entityId);
	}

	private rebuild() {
		const routeSnapshot = this.options.routeEngine.getSnapshot();
		const resolved = resolveRoutePath(this.route, this.options.getRoutingContext());
		const points = resolved.points;
		const segmentLengths = points.slice(1).map((point, index) => new THREE.Vector3(...points[index].position).distanceTo(new THREE.Vector3(...point.position)));
		if (resolved.closed && resolved.edgeIds.length > segmentLengths.length && points.length > 1) {
			segmentLengths.push(new THREE.Vector3(...points[points.length - 1].position).distanceTo(new THREE.Vector3(...points[0].position)));
		}
		const straightLength = segmentLengths.reduce((total, length) => total + length, 0) || 1;
		let accumulated = 0;
		const edgeStartDistances = resolved.edgeIds.map((_, index) => {
			const start = accumulated / straightLength * routeSnapshot.lengthMeters;
			accumulated += segmentLengths[index] || 0;
			return start;
		});

		const routeEdges = new Map(this.route.edges.map((edge) => [edge.edgeId, edge]));
		const nextStations: ComponentProcessStationInfo[] = [];
		for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
			const point = points[pointIndex] as TwinRoutePointDefinition;
			if (point.kind !== 'processStation' || !point.process) continue;
			const componentObjectId = point.componentObjectId || '';
			if (!componentObjectId) continue;
			const edgeId = resolved.edgeIds[pointIndex];
			const edge = edgeId ? routeEdges.get(edgeId) : undefined;
			const componentEdge = edge?.componentObjectId === componentObjectId
				? edge
				: this.route.edges.find((candidate) => candidate.componentObjectId === componentObjectId && resolved.edgeIds.includes(candidate.edgeId));
			const activeEdgeIndex = componentEdge ? resolved.edgeIds.indexOf(componentEdge.edgeId) : -1;
			const startDistance = activeEdgeIndex >= 0 ? edgeStartDistances[activeEdgeIndex] : 0;
			const segmentLength = activeEdgeIndex >= 0 ? (segmentLengths[activeEdgeIndex] || 0) / straightLength * routeSnapshot.lengthMeters : 0;
			const distanceMeters = activeEdgeIndex >= 0
				? startDistance + segmentLength * 0.5
				: this.pointDistance(pointIndex, segmentLengths, straightLength, routeSnapshot.lengthMeters);
			const sectionId = componentEdge?.sectionId || componentEdge?.edgeId || 'process-' + componentObjectId;
			const process = structuredClone(point.process);
			const behaviorRequirements = this.options.getBehaviorRequirements?.(componentObjectId) || {};
			const processRequirements = Object.fromEntries(Object.entries(process.behaviorCompletionRequirements || {}).map(([group, count]) => [group, Math.max(1, Math.floor(Number(count) || 1))]));
			const mergedRequirements = { ...behaviorRequirements, ...processRequirements };
			const completionGroups = [...new Set([
				...(process.behaviorCompletionGroups || []).map((item) => String(item).trim()).filter(Boolean),
				...Object.keys(behaviorRequirements),
			])];
			const incomingEdgeIndex = pointIndex > 0 ? pointIndex - 1 : resolved.closed ? resolved.edgeIds.length - 1 : -1;
			const incomingEdge = incomingEdgeIndex >= 0 ? routeEdges.get(resolved.edgeIds[incomingEdgeIndex]) : undefined;
			nextStations.push({
				stationId: componentObjectId,
				sectionId,
				componentObjectId,
				pointId: point.pointId,
				edgeId: componentEdge?.edgeId,
				distanceMeters,
				process,
				capacity: Math.max(1, Math.floor(Number(componentEdge?.capacity) || 1)),
				batchSize: Math.max(1, Math.floor(Number(process.batchSize) || 1)),
				behaviorCompletionGroups: completionGroups,
				behaviorCompletionRequirements: mergedRequirements,
				stopperComponentObjectId: incomingEdge?.componentObjectId,
				dataMode: hasLiveBindings(process) ? 'live' : 'simulation',
			});
		}
		this.stations = nextStations.sort((left, right) => left.distanceMeters - right.distanceMeters);
		this.stationManager = new ProcessStationManager(this.stations.map((station) => ({
			stationId: station.stationId,
			sectionId: station.sectionId,
			type: station.process.type || 'process',
			process: station.process,
			dataMode: station.dataMode,
			capacity: station.capacity,
		})));
	}

	private prepareBehaviorBatch(station: ComponentProcessStationInfo) {
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return true;
		const activeIds = this.stringArray(root.userData.stationPalletIds);
		if (activeIds.length) {
			if (activeIds.includes(this.entityId)) return true;
			this.options.routeEngine.correctDistance(station.distanceMeters);
			this.options.routeEngine.setRunning(false);
			return false;
		}

		const waitingIds = this.stringArray(root.userData.stationWaitingPalletIds);
		if (!waitingIds.includes(this.entityId)) waitingIds.push(this.entityId);
		root.userData.stationWaitingPalletIds = waitingIds;
		root.userData.stationRequiredBatchSize = station.batchSize;
		root.userData.stationRequiredBehaviorGroups = station.behaviorCompletionGroups;
		root.userData.stationBehaviorRequirements = station.behaviorCompletionRequirements;
		root.userData.stationProcessType = station.process.type;
		root.userData.palletPresent = true;
		root.userData.processPhase = waitingIds.length < station.batchSize ? 'waiting-batch' : 'waiting-equipment';
		this.setStationStopper(station, true, true);

		this.options.routeEngine.correctDistance(station.distanceMeters);
		this.options.routeEngine.setRunning(false);
		if (waitingIds.length < station.batchSize) return false;

		const selected = waitingIds.slice(0, station.batchSize);
		root.userData.stationPalletIds = selected;
		root.userData.stationPalletId = selected[0];
		root.userData.stationCompletedGroupCounts = {};
		root.userData.stationCompletedGroups = [];
		root.userData.stationReadyToReleasePalletIds = [];
		root.userData.stationReleasedPalletIds = [];
		root.userData.stationReleaseAuthorized = false;
		root.userData.processActive = true;
		root.userData.processPhase = 'waiting-equipment';
		return selected.includes(this.entityId);
	}

	private authorizeBehaviorBatchRelease(station: ComponentProcessStationInfo, entityId: string) {
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return true;
		const counts = this.numberRecord(root.userData.stationCompletedGroupCounts);
		const complete = station.behaviorCompletionGroups.every((group) => counts[group] >= (station.behaviorCompletionRequirements[group] || 1));
		if (!complete) return false;

		const batchIds = this.stringArray(root.userData.stationPalletIds);
		const ready = this.stringArray(root.userData.stationReadyToReleasePalletIds);
		if (!ready.includes(entityId)) ready.push(entityId);
		root.userData.stationReadyToReleasePalletIds = ready;
		if (batchIds.length > 0 && ready.length >= batchIds.length) {
			root.userData.stationReleaseAuthorized = true;
			root.userData.processPhase = 'release';
			this.setStationStopper(station, false, true);
		}
		return root.userData.stationReleaseAuthorized === true;
	}

	private finishBehaviorBatchRelease(station: ComponentProcessStationInfo, entityId: string) {
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return;
		const batchIds = this.stringArray(root.userData.stationPalletIds);
		const released = this.stringArray(root.userData.stationReleasedPalletIds);
		if (!released.includes(entityId)) released.push(entityId);
		root.userData.stationReleasedPalletIds = released;
		if (!batchIds.length || released.length < batchIds.length) return;

		root.userData.stationLastCompletedPalletIds = batchIds;
		root.userData.stationWaitingPalletIds = [];
		root.userData.stationPalletIds = [];
		delete root.userData.stationPalletId;
		root.userData.stationCompletedGroupCounts = {};
		root.userData.stationCompletedGroups = [];
		root.userData.stationReadyToReleasePalletIds = [];
		root.userData.stationReleasedPalletIds = [];
		root.userData.stationReleaseAuthorized = false;
		root.userData.palletPresent = false;
		root.userData.processActive = false;
		root.userData.processPhase = 'idle';
		if (station.stopperComponentObjectId) this.pendingStopperReset = { objectId: station.stopperComponentObjectId, elapsedSeconds: 0 };
	}

	private setStationStopper(station: ComponentProcessStationInfo, raised: boolean, palletPresent: boolean) {
		const root = station.stopperComponentObjectId ? this.options.getComponentRoot(station.stopperComponentObjectId) : undefined;
		if (!root) return;
		const definitions = Array.isArray(root.userData?.outputStoppers) ? root.userData.outputStoppers as Array<Record<string, unknown>> : [];
		const definition = definitions[0];
		if (!definition) return;
		const stopper = root.getObjectByName(String(definition.nodePath || ''));
		if (stopper) {
			const raisedY = Number(stopper.userData?.raisedY ?? stopper.position.y);
			const loweredY = Number(stopper.userData?.loweredY ?? raisedY - 0.22);
			stopper.position.y = raised ? raisedY : loweredY;
			stopper.userData.stopperRaised = raised;
		}
		const sensor = root.getObjectByName(String(definition.sensorNodePath || ''));
		if (sensor) sensor.userData.palletPresent = palletPresent;
		root.userData.processStopperRaised = raised;
		root.userData.processPalletPresent = palletPresent;
	}

	private updatePendingStopperReset(deltaSeconds: number) {
		if (!this.pendingStopperReset) return;
		this.pendingStopperReset.elapsedSeconds += Math.max(0, deltaSeconds);
		if (this.pendingStopperReset.elapsedSeconds < 0.5) return;
		const root = this.options.getComponentRoot(this.pendingStopperReset.objectId);
		if (root) {
			const definitions = Array.isArray(root.userData?.outputStoppers) ? root.userData.outputStoppers as Array<Record<string, unknown>> : [];
			const definition = definitions[0];
			if (definition) {
				const stopper = root.getObjectByName(String(definition.nodePath || ''));
				if (stopper) {
					const raisedY = Number(stopper.userData?.raisedY ?? stopper.position.y);
					stopper.position.y = raisedY;
					stopper.userData.stopperRaised = true;
				}
				const sensor = root.getObjectByName(String(definition.sensorNodePath || ''));
				if (sensor) sensor.userData.palletPresent = false;
			}
			root.userData.processStopperRaised = true;
			root.userData.processPalletPresent = false;
		}
		this.pendingStopperReset = undefined;
	}

	private stringArray(value: unknown) {
		return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
	}

	private numberRecord(value: unknown) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
		return Object.fromEntries(Object.entries(source).map(([key, count]) => [key, Math.max(0, Number(count) || 0)]));
	}

	private pointDistance(pointIndex: number, segmentLengths: number[], straightLength: number, routeLength: number) {
		const before = segmentLengths.slice(0, pointIndex).reduce((total, length) => total + length, 0);
		return before / straightLength * routeLength;
	}

	private applyProcessMetadata(station: ComponentProcessStationInfo, progress: number, healthy: boolean) {
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return;
		root.userData.processActive = healthy;
		root.userData.processPhase = healthy ? 'processing' : 'fault';
		root.userData.processProgress = THREE.MathUtils.clamp(progress, 0, 1);
		root.userData.processType = station.process.type || 'process';
	}

	private clearProcessMetadata(objectId: string) {
		const root = this.options.getComponentRoot(objectId);
		if (!root) return;
		root.userData.processActive = false;
		root.userData.processPhase = 'idle';
		root.userData.processProgress = 0;
		delete root.userData.processType;
	}

	private resetProcessMetadata() {
		for (const station of this.stations) this.clearProcessMetadata(station.componentObjectId);
	}

}
