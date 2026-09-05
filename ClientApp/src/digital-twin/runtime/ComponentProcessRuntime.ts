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
	entityId?: string;
}

const hasLiveBindings = (process: TwinProcessDefinition) => Boolean(
	process.readyBindingId || process.busyBindingId || process.completeBindingId || process.resultBindingId || process.faultBindingId,
);

const processStationType = (process: TwinProcessDefinition): TwinProcessStationType => {
	if (process.type === 'external-inspection') return 'external-inspection';
	if (process.type === 'bagging') return 'bagging';
	if (process.type === 'gantry-stacking') return 'gantry-stacking';
	if (process.type === 'robot-loading') return 'robot-loading';
	return 'scan';
};

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
	private readonly baseTransforms = new Map<string, Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>>();

	constructor(private readonly options: ComponentProcessRuntimeOptions) {
		this.route = structuredClone(options.route);
		this.entityId = options.entityId || 'component-route-material-01';
		this.rebuild();
	}

	setRoute(route: TwinRouteDefinition) {
		this.restoreAllModels();
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
		this.restoreAllModels();
	}

	dispose() {
		this.reset();
		this.baseTransforms.clear();
	}

	/** 返回 true 时 TwinRuntime 可继续执行 RouteEngine.updateFixed。 */
	updateFixed(deltaSeconds: number) {
		const routeSnapshot = this.options.routeEngine.getSnapshot();
		if (routeSnapshot.distanceMeters + 0.0001 < this.previousDistance) this.processed.clear();
		this.previousDistance = routeSnapshot.distanceMeters;

		if (this.active) {
			this.updateActive(deltaSeconds);
			return false;
		}
		if (!this.requestedRunning || routeSnapshot.lengthMeters <= 0 || routeSnapshot.state === 'waiting') return true;

		const nextDistance = routeSnapshot.distanceMeters + Math.max(0, routeSnapshot.speed) * Math.max(0, deltaSeconds);
		const nextStation = this.stations
			.filter((station) => !this.processed.has(station.stationId))
			.filter((station) => station.distanceMeters >= routeSnapshot.distanceMeters - 0.0001 && station.distanceMeters <= nextDistance + 0.0001)
			.sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
		if (!nextStation) return true;

		this.options.routeEngine.correctDistance(nextStation.distanceMeters);
		this.options.routeEngine.setRunning(false);
		if (!this.stationManager.canAccept(nextStation.sectionId, this.entityId)) return false;
		this.stationManager.arrive(nextStation.sectionId, this.entityId);
		this.active = { station: nextStation, entityId: this.entityId, elapsedSeconds: 0 };
		this.captureModel(nextStation.componentObjectId);
		this.applyModelAnimation(nextStation, 0, true);
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
		this.applyModelAnimation(active.station, progress, entity?.state !== 'fault');

		if (!this.stationManager.canRelease(active.station.sectionId, active.entityId).canRelease) return;
		this.stationManager.release(active.station.sectionId, active.entityId);
		this.processed.add(active.station.stationId);
		this.restoreModel(active.station.componentObjectId);
		this.active = undefined;
		this.options.routeEngine.setRunning(this.requestedRunning);
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
			nextStations.push({
				stationId: componentObjectId,
				sectionId,
				componentObjectId,
				pointId: point.pointId,
				edgeId: componentEdge?.edgeId,
				distanceMeters,
				process,
				capacity: Math.max(1, Math.floor(Number(componentEdge?.capacity) || 1)),
				dataMode: hasLiveBindings(process) ? 'live' : 'simulation',
			});
		}
		this.stations = nextStations.sort((left, right) => left.distanceMeters - right.distanceMeters);
		this.stationManager = new ProcessStationManager(this.stations.map((station) => ({
			stationId: station.stationId,
			sectionId: station.sectionId,
			type: processStationType(station.process),
			process: station.process,
			dataMode: station.dataMode,
			capacity: station.capacity,
		})));
	}

	private pointDistance(pointIndex: number, segmentLengths: number[], straightLength: number, routeLength: number) {
		const before = segmentLengths.slice(0, pointIndex).reduce((total, length) => total + length, 0);
		return before / straightLength * routeLength;
	}

	private captureModel(objectId: string) {
		if (this.baseTransforms.has(objectId)) return;
		const root = this.options.getComponentRoot(objectId);
		if (!root) return;
		const map = new Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>();
		root.traverse((node) => map.set(node, { position: node.position.clone(), rotation: node.rotation.clone(), scale: node.scale.clone() }));
		this.baseTransforms.set(objectId, map);
	}

	private restoreModel(objectId: string) {
		for (const [node, base] of this.baseTransforms.get(objectId) || []) {
			node.position.copy(base.position);
			node.rotation.copy(base.rotation);
			node.scale.copy(base.scale);
		}
		const root = this.options.getComponentRoot(objectId);
		if (root) {
			root.userData.processActive = false;
			root.userData.processPhase = 'idle';
			root.userData.processProgress = 0;
		}
	}

	private restoreAllModels() {
		for (const objectId of this.baseTransforms.keys()) this.restoreModel(objectId);
	}

	private setProcessPhase(root: THREE.Group, phase: string, progress: number) {
		root.userData.processActive = true;
		root.userData.processPhase = phase;
		root.userData.processProgress = THREE.MathUtils.clamp(progress, 0, 1);
	}

	private range(value: number, start: number, end: number) {
		if (end <= start) return value >= end ? 1 : 0;
		return THREE.MathUtils.clamp((value - start) / (end - start), 0, 1);
	}

	private applyModelAnimation(station: ComponentProcessStationInfo, progress: number, healthy: boolean) {
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return;
		const bases = this.baseTransforms.get(station.componentObjectId);
		if (!bases) return;
		const phase = THREE.MathUtils.clamp(progress, 0, 1);
		if (!healthy) { this.restoreModel(station.componentObjectId); root.userData.processPhase = 'fault'; return; }

		if (station.process.type === 'external-inspection') {
			const processPhase = phase < 0.12 ? 'positioning'
				: phase < 0.28 ? 'gripper-down'
					: phase < 0.70 ? 'rotate-scan'
						: phase < 0.88 ? 'gripper-up' : 'release';
			this.setProcessPhase(root, processPhase, phase);
			const rotary = root.getObjectByName('Inspection-Rotary-Gripper');
			if (rotary) {
				const base = bases.get(rotary);
				if (base) {
					const down = phase < 0.28 ? this.range(phase, 0.12, 0.28)
						: phase < 0.70 ? 1
							: 1 - this.range(phase, 0.70, 0.88);
					rotary.position.y = base.position.y - down * 0.48;
					const scan = this.range(phase, 0.28, 0.70);
					rotary.rotation.y = base.rotation.y + scan * Math.PI * 4;
				}
			}
			const stopper = root.getObjectByName('Inspection-Positioning-Stopper');
			if (stopper) {
				const base = bases.get(stopper);
				if (base) stopper.position.y = base.position.y + (phase < 0.88 ? 0.10 : 0);
			}
			root.userData.inspectionCaptureActive = phase >= 0.28 && phase < 0.70;
			return;
		}

		if (station.process.type !== 'bagging') return;
		if (root.userData?.stationType === 'vacuum-film-tuck') {
			const processPhase = phase < 0.16 ? 'positioning'
				: phase < 0.34 ? 'lift-cake'
					: phase < 0.72 ? 'vacuum-tuck'
						: phase < 0.90 ? 'return-cake' : 'release';
			this.setProcessPhase(root, processPhase, phase);
			const lift = root.getObjectByName('VacuumTuck-Cake-Lift');
			if (lift) {
				const base = bases.get(lift);
				if (base) {
					const stroke = Math.max(0.2, Number(root.userData?.properties?.liftStroke) || 0.95);
					const raised = phase < 0.34 ? this.range(phase, 0.16, 0.34) : phase < 0.72 ? 1 : 1 - this.range(phase, 0.72, 0.90);
					lift.position.y = base.position.y + raised * stroke * 0.72;
				}
			}
			const film = root.getObjectByName('VacuumTuck-Film-Inward-Preview');
			if (film) {
				const base = bases.get(film);
				if (base) {
					const suction = phase >= 0.34 && phase < 0.72 ? Math.sin(this.range(phase, 0.34, 0.72) * Math.PI) : 0;
					film.scale.set(base.scale.x * (1 - 0.28 * suction), base.scale.y * (1 + 0.35 * suction), base.scale.z * (1 - 0.28 * suction));
				}
			}
			root.userData.vacuumActive = phase >= 0.34 && phase < 0.72;
			return;
		}

		// 连续膜侧封机内部流程：定位 -> 送膜 -> 包覆 -> 侧封 -> 切膜 -> 放行。
		const processPhase = phase < 0.15 ? 'positioning'
			: phase < 0.35 ? 'film-feed'
				: phase < 0.60 ? 'wrap'
					: phase < 0.78 ? 'side-seal'
						: phase < 0.90 ? 'cut' : 'release';
		this.setProcessPhase(root, processPhase, phase);

		const centering = root.getObjectByName('Bagging-Centering-Pusher');
		if (centering) {
			centering.traverse((node) => {
				if (node.userData?.centeringPad !== true) return;
				const base = bases.get(node); if (!base) return;
				const center = phase < 0.15 ? this.range(phase, 0, 0.15) : phase < 0.90 ? 1 : 1 - this.range(phase, 0.90, 1);
				node.position.z = base.position.z - Math.sign(base.position.z) * 0.14 * center;
			});
		}
		const feed = root.getObjectByName('Bagging-Film-Feed-Assembly');
		feed?.traverse((node) => {
			if (node.userData?.filmGuideRoller !== true) return;
			const base = bases.get(node); if (!base) return;
			const feedProgress = this.range(phase, 0.15, 0.60);
			node.rotation.y = base.rotation.y + feedProgress * Math.PI * 8;
		});
		const film = root.getObjectByName('Bagging-Film-Sleeve-Preview');
		if (film) {
			const base = bases.get(film);
			if (base) {
				const wrapProgress = this.range(phase, 0.35, 0.60);
				film.scale.set(base.scale.x * (0.82 + 0.18 * wrapProgress), base.scale.y, base.scale.z * (0.82 + 0.18 * wrapProgress));
			}
		}
		const seal = root.getObjectByName('Bagging-Side-Seal-Unit');
		seal?.traverse((node) => {
			if (node.userData?.sideSealJaw !== true) return;
			const base = bases.get(node); if (!base) return;
			const closed = phase < 0.78 ? this.range(phase, 0.60, 0.70) : 1 - this.range(phase, 0.78, 0.86);
			node.position.z = base.position.z * (1 - 0.72 * closed);
		});
		const cutter = root.getObjectByName('Bagging-Cut-Knife');
		if (cutter) {
			const base = bases.get(cutter);
			if (base) {
				const cut = phase < 0.84 ? this.range(phase, 0.78, 0.84) : 1 - this.range(phase, 0.84, 0.90);
				cutter.position.z = base.position.z - cut * 0.26;
			}
		}
		root.userData.filmFeedActive = phase >= 0.15 && phase < 0.60;
		root.userData.sideSealActive = phase >= 0.60 && phase < 0.78;
		root.userData.filmCutActive = phase >= 0.78 && phase < 0.90;
	}

}
