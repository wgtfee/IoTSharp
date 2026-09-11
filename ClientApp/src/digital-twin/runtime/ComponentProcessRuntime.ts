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
	releaseElapsedSeconds?: number;
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
	/** 必须由场景 runtime.dataMode 显式传入，禁止再通过是否配置 Binding 猜测运行模式。 */
	dataMode: 'simulation' | 'live';
	getComponentRoot: (objectId: string) => THREE.Group | undefined;
	getRoutingContext: () => TwinRouteRoutingContext;
	/** 从场景 Behavior 自动发现工位需要完成的动作组，避免 Route 重复维护动作编排信息。 */
	getBehaviorRequirements?: (objectId: string) => Record<string, number>;
	entityId?: string;
}

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
		// 只有闭环真正从路线末端回到起点才开启新工艺周期。合流仲裁与全局
		// 防碰撞会把整列托盘沿当前边小幅退让；若把任意距离回退都当成换圈，
		// 已经完成桁架/机器人处理的托盘会再次进入同一工位并重复释放。
		const completedLoop = this.route.loop && routeSnapshot.lengthMeters > 0
			&& this.previousDistance > routeSnapshot.lengthMeters * 0.75
			&& routeSnapshot.distanceMeters < routeSnapshot.lengthMeters * 0.25;
		if (completedLoop) this.processed.clear();
		this.previousDistance = routeSnapshot.distanceMeters;

		if (this.active) {
			this.updateActive(deltaSeconds);
			return false;
		}
		if (!this.requestedRunning || routeSnapshot.lengthMeters <= 0 || routeSnapshot.state === 'waiting') return true;

		const nextDistance = routeSnapshot.distanceMeters + Math.max(0, routeSnapshot.speed) * Math.max(0, deltaSeconds);
		let nextStation = this.stations
			.filter((station) => !this.processed.has(station.stationId)
				|| this.canPreAdmitNextLoopBatch(station, routeSnapshot.distanceMeters, routeSnapshot.lengthMeters))
			.filter((station) => {
				// 批次工位的动态排队位置会随着 waitingIds 增长向上游移动；如果把这个
				// 移动后的距离用于“是否经过工位”判断，正在接近的后车会跨过新窗口，
				// 直接穿过工位而永远进不了批次。捕获统一以工位中心，登记后再由
				// prepareBehaviorBatch/queue visual 计算实际等候槽位。
				const captureDistance = station.behaviorCompletionGroups.length && station.batchSize > 1
					? station.distanceMeters
					: this.stationCaptureDistance(station, routeSnapshot.lengthMeters);
				// Collision hold leaves the pallet centre a few centimetres before/after the
				// ideal queue slot (the physical diameter is intentionally slightly larger
				// than the configured 1.55m pitch).  Keep the capture window wide enough to
				// register that slot, otherwise a pallet can pass the dynamic queue distance
				// while waiting for the pallet ahead and never enter the station batch.
				const captureTolerance = station.behaviorCompletionGroups.length && station.batchSize > 1
					// The station queue is a reservation window, not a single point: when
					// the head pallet is held at the station, the remaining batch members
					// must be admitted from their upstream queue slots in the same tick.
					? Math.max(0.75, this.batchQueueSpacing(station) * (station.batchSize + 1))
					: 0.0001;
				// 批次预约窗口只能沿输送方向命中。闭环起点附近若使用双向绝对
				// tolerance，已经离开机器人 10~20m 的托盘一旦因合流退让清空
				// processed，就会被错误回抓到起点并跳到路线末端等待。
				const rawForwardDistance = captureDistance - routeSnapshot.distanceMeters;
				// correctDistance 经过曲线弧长换算后会保留 1e-14 量级的浮点误差。
				// 工位中心只比当前距离小一个数值噪声时必须视为已经到位，不能经闭环
				// 取模后变成“还差整整一圈”；真正位于工位下游的托盘仍按正向闭环距离计算。
				const forwardDistance = this.route.loop && routeSnapshot.lengthMeters > 0 && rawForwardDistance < -0.0001
					? ((rawForwardDistance % routeSnapshot.lengthMeters) + routeSnapshot.lengthMeters) % routeSnapshot.lengthMeters
					: rawForwardDistance;
				const forwardStep = Math.max(0, nextDistance - routeSnapshot.distanceMeters);
				return forwardDistance >= -0.0001 && forwardDistance <= forwardStep + captureTolerance;
			})
			.sort((left, right) => this.stationCaptureDistance(left, routeSnapshot.lengthMeters) - this.stationCaptureDistance(right, routeSnapshot.lengthMeters))[0];
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
		if (!this.stationManager.canAccept(nextStation.stationId, this.entityId)) return false;
		this.stationManager.arrive(nextStation.stationId, this.entityId, {
			bindingValues: this.options.getRoutingContext().bindingValues,
			staleBindingIds: this.options.getRoutingContext().staleBindingIds,
		});
		this.active = { station: nextStation, entityId: this.entityId, elapsedSeconds: 0 };
		this.applyProcessMetadata(nextStation, 0, true);
		return false;
	}

	/**
	 * 闭环的 simulationEntry 批次工位通常位于 Route 起点（例如机器人 2×6 上料位）。
	 * 下一批前半批托盘可能已经跨过 length -> 0 并停在工位槽位中，而后半批仍位于
	 * 闭环尾端。如果后半批必须先物理跨过起点才能清除 processed，它会被前半批挡住，
	 * 形成“半批已到位、半批永远停在闭环尾端”的死锁。
	 *
	 * 这里只允许闭环最后 25% 的实体提前重新预约位于起点前 25%、明确标记
	 * simulationEntry 且 batchSize > 1 的批次工位。普通工位以及合流导致的小幅后退
	 * 仍不会绕过 processed，因此不会恢复旧的重复工艺执行问题。
	 */
	private canPreAdmitNextLoopBatch(station: ComponentProcessStationInfo, distanceMeters: number, routeLength: number) {
		if (!this.route.loop || routeLength <= 0 || station.process.simulationEntry !== true || station.batchSize <= 1) return false;
		return distanceMeters >= routeLength * 0.75 && station.distanceMeters <= routeLength * 0.25;
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

		if (!this.stationManager.canRelease(active.station.stationId, active.entityId).canRelease) return;
		if (active.station.behaviorCompletionGroups.length) {
			if (!this.authorizeBehaviorBatchRelease(active.station, active.entityId)) return;
			if (!this.waitForBehaviorBatchReleaseWave(active, deltaSeconds)) return;
		}
		this.stationManager.release(active.station.stationId, active.entityId);
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
			const physicalLane = String(this.options.getRoutingContext().payload?.physicalLane || '');
			if (process.physicalLane && physicalLane && process.physicalLane !== physicalLane) continue;
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
				stationId: `${componentObjectId}:${point.pointId}`,
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
				dataMode: this.options.dataMode,
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
		const useLinearQueue = !station.process.batchLayout;
		const routeLength = this.options.routeEngine.getSnapshot().lengthMeters;
		const batchHoldIndex = this.batchHoldQueueIndex(station);
		const physicalReleaseIds = this.stringArray(root.userData.stationPhysicalReleasePalletIds);
		if (physicalReleaseIds.length) {
			// 上一批逻辑 Release 已完成并不代表托盘已经物理离开工位。
			// 在 RouteSlotArrayRuntime 的错峰离站/交接完成前，下一批必须停在整个物理批次占位区之外，
			// 否则新托盘会被校正到 station center，与仍处于 stationReleaseVisual 的前批托盘重叠。
			const holdDistance = this.batchQueueDistance(station, batchHoldIndex, routeLength);
			this.options.routeEngine.correctDistance(holdDistance);
			this.options.routeEngine.setRunning(false);
			root.userData.processPhase = 'waiting-physical-release';
			return false;
		}
		const activeIds = this.stringArray(root.userData.stationPalletIds);
		if (activeIds.length) {
			if (activeIds.includes(this.entityId)) return true;
			// 当前批次尚未释放时，下一批必须停在当前物理批次占位区之外。
			// 对机器人 2×6，6 列中心范围为 ±2.5*spacing，额外再留 1 个半径级中心距，
			// 因而等待点位于 station 上游 3.5*spacing（1.55m 时为 5.425m），不能再停到共享 station center。
			const holdDistance = useLinearQueue
				? this.batchQueueDistance(station, station.batchSize, routeLength)
				: this.batchQueueDistance(station, batchHoldIndex, routeLength);
			this.options.routeEngine.correctDistance(holdDistance);
			this.options.routeEngine.setRunning(false);
			return false;
		}

		const waitingIds = this.stringArray(root.userData.stationWaitingPalletIds);
		if (!waitingIds.includes(this.entityId)) waitingIds.push(this.entityId);
		const waitingIndex = waitingIds.indexOf(this.entityId);
		const laneByPallet = root.userData.stationPalletLaneById && typeof root.userData.stationPalletLaneById === 'object'
			? root.userData.stationPalletLaneById as Record<string, string>
			: {};
		const sequenceByPallet = root.userData.stationPalletSequenceById && typeof root.userData.stationPalletSequenceById === 'object'
			? root.userData.stationPalletSequenceById as Record<string, number>
			: {};
		const physicalLane = String(this.options.getRoutingContext().payload?.physicalLane || station.process.physicalLane || '').trim();
		if (physicalLane) laneByPallet[this.entityId] = physicalLane;
		sequenceByPallet[this.entityId] = Number(this.options.getRoutingContext().payload?.weightSequence || 0);
		root.userData.stationPalletLaneById = laneByPallet;
		root.userData.stationPalletSequenceById = sequenceByPallet;
		root.userData.stationWaitingPalletIds = waitingIds;
		root.userData.stationRequiredBatchSize = station.batchSize;
		root.userData.stationRequiredBehaviorGroups = station.behaviorCompletionGroups;
		root.userData.stationBehaviorRequirements = station.behaviorCompletionRequirements;
		root.userData.stationProcessType = station.process.type;
		root.userData.palletPresent = true;
		root.userData.processPhase = waitingIds.length < station.batchSize ? 'waiting-batch' : 'waiting-equipment';
		this.setStationStopper(station, true, true);

		// 批次工位按真实队列槽登记：第一托在工位，后续托盘每隔一个安全间距停靠。
		// 这样后车在防碰撞逻辑生效前已经进入 Waiting，不会出现“第一托挡住其余五托、永远凑不齐批次”的死锁。
		this.options.routeEngine.correctDistance(useLinearQueue
			? this.batchQueueDistance(station, waitingIndex, this.options.routeEngine.getSnapshot().lengthMeters)
			: station.distanceMeters);
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

	private batchQueueSpacing(station: ComponentProcessStationInfo) {
		// 1.48m 小托盘 + 0.02m 防碰撞裕量的硬阈值是 1.50m；登记点必须位于阈值之前，
		// 否则后车会先被 collision hold 卡住而永远到不了 Waiting。1.55m 与现有小托盘物理中心距一致。
		return Math.max(1.55, Number(station.process.batchLayout?.columnSpacingMeters || 1.55));
	}

	private batchHoldQueueIndex(station: ComponentProcessStationInfo) {
		if (!station.process.batchLayout) return Math.max(1, station.batchSize);
		const columns = Math.max(1, Math.floor(Number(station.process.batchLayout.columns) || 1));
		if (station.process.type === 'gantry-stacking') {
			// 桁架 1×N 批次从工位中心沿入料方向向上游排队；下一批首托必须
			// 停在第 N 个槽之外，而不是使用对称布局的半宽，否则会占住离站通道。
			return columns + 0.15;
		}
		// 外侧批次槽与下一批首托之间至少保留一个完整托盘中心距。
		// 曲线路径按弧长校正到世界 position 时会产生约 0.1m 的投偏差，
		// 额外 0.15 个槽距作为工程裕量，避免 1.55m 名义间距被压到 1.50m 硬边界以内。
		return (columns - 1) / 2 + 1.15;
	}

	private batchQueueDistance(station: ComponentProcessStationInfo, queueIndex: number, routeLength: number) {
		const distance = station.distanceMeters - Math.max(0, queueIndex) * this.batchQueueSpacing(station);
		if (this.route.loop && routeLength > 0) return ((distance % routeLength) + routeLength) % routeLength;
		return Math.max(0, distance);
	}

	private stationCaptureDistance(station: ComponentProcessStationInfo, routeLength: number) {
		if (!station.behaviorCompletionGroups.length || station.batchSize <= 1 || station.process.batchLayout) return station.distanceMeters;
		const root = this.options.getComponentRoot(station.componentObjectId);
		if (!root) return station.distanceMeters;
		const activeIds = this.stringArray(root.userData.stationPalletIds);
		if (activeIds.includes(this.entityId)) return station.distanceMeters;
		if (activeIds.length) return this.batchQueueDistance(station, station.batchSize, routeLength);
		const waitingIds = this.stringArray(root.userData.stationWaitingPalletIds);
		const existingIndex = waitingIds.indexOf(this.entityId);
		const queueIndex = existingIndex >= 0 ? existingIndex : Math.min(waitingIds.length, Math.max(0, station.batchSize - 1));
		return this.batchQueueDistance(station, queueIndex, routeLength);
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

	private waitForBehaviorBatchReleaseWave(active: ActiveProcess, deltaSeconds: number) {
		const root = this.options.getComponentRoot(active.station.componentObjectId);
		if (!root) return true;
		const batchIds = this.stringArray(root.userData.stationPalletIds);
		const batchIndex = batchIds.indexOf(active.entityId);
		if (batchIndex <= 0 || batchIds.length <= 1) return true;
		// 桁架是一条单一的 1×6 物理队列，必须严格按槽位从下游到上游
		// Release；否则 elapsedSeconds 错峰仍可能让后车进入离站视觉层，
		// 和未离站的前车落入 1.50m 安全间距以内。机器人 A/B 两个入口
		// 共用同一组件根节点但拥有独立物理排，不能在这里用全局数组互相阻塞。
		if (active.station.process.type === 'gantry-stacking') {
			const releasedIds = this.stringArray(root.userData.stationReleasedPalletIds);
			if (!batchIds.slice(0, batchIndex).every((palletId) => releasedIds.includes(palletId))) return false;
		} else if (active.station.process.type === 'robot-loading') {
			// 机器人根节点同时承载 A/B 两条物理排；释放顺序只约束同一
			// physicalLane，A/B 可以并行，避免把两排互相锁死。
			const lane = String(active.station.process.physicalLane || this.options.getRoutingContext().payload?.physicalLane || '').trim();
			const laneByPallet = root.userData.stationPalletLaneById && typeof root.userData.stationPalletLaneById === 'object'
				? root.userData.stationPalletLaneById as Record<string, string>
				: {};
			const sequenceByPallet = root.userData.stationPalletSequenceById && typeof root.userData.stationPalletSequenceById === 'object'
				? root.userData.stationPalletSequenceById as Record<string, number>
				: {};
			if (lane) {
				const laneBatchIds = batchIds
					.filter((palletId) => laneByPallet[palletId] === lane)
					.sort((left, right) => Number(sequenceByPallet[left] || 0) - Number(sequenceByPallet[right] || 0));
				const laneIndex = laneBatchIds.indexOf(active.entityId);
				const releasedIds = this.stringArray(root.userData.stationReleasedPalletIds);
				if (laneIndex > 0 && !laneBatchIds.slice(0, laneIndex).every((palletId) => releasedIds.includes(palletId))) return false;
			}
		}
		active.releaseElapsedSeconds = (active.releaseElapsedSeconds || 0) + Math.max(0, deltaSeconds);
		const routeSpeed = Math.max(0.1, Number(this.options.routeEngine.getSnapshot().speed || 0.1));
		const layoutSpacing = Math.max(0.6, Number(active.station.process.batchLayout?.columnSpacingMeters || 1.5));
		const releaseIntervalSeconds = THREE.MathUtils.clamp(layoutSpacing / routeSpeed * 0.45, 0.22, 0.75);
		return active.releaseElapsedSeconds >= batchIndex * releaseIntervalSeconds;
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
		// 逻辑批次已全部 Release，但 RouteSlotArrayRuntime 仍需逐托完成真实错峰离站。
		// 只保留尚未完成物理 handoff 的 Release 标记；否则同一总 tick 中排在后面的托盘
		// 会在 captureManualStationRelease 读取前丢失标记，并停留在 station center。
		const physicalPending = this.stringArray(root.userData.stationPhysicalReleasePalletIds);
		// 行为工位（例如桁架）没有 PLC 的“物理离站确认”，但渲染层仍需知道
		// 本批次哪些托盘正在按槽位错峰离开；先登记整批，逐托 handoff 完成后再移除。
		for (const palletId of batchIds) if (!physicalPending.includes(palletId)) physicalPending.push(palletId);
		root.userData.stationPhysicalReleasePalletIds = physicalPending;
		root.userData.stationReleasedPalletIds = released.filter((id) => physicalPending.includes(id));
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
