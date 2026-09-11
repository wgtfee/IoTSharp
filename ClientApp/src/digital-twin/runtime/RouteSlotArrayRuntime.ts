import * as THREE from 'three';
import type { TwinObjectBindingDefinition, TwinRouteDefinition, TwinRouteEdgeDefinition, TwinSceneManifest, TwinTransportUnitType } from '/@/digital-twin/contracts';
import { parseRouteSlotArray, routeSlotProgress } from '/@/digital-twin/bindings/RouteSlotArray';
import { createComponentDefinitionFromTemplate, defaultComponentRegistry } from '/@/digital-twin/components';
import { RouteEngine, type TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';
import { ComponentProcessRuntime } from '/@/digital-twin/runtime/ComponentProcessRuntime';

interface ManualStationReleaseState {
	pointId: string;
	componentObjectId: string;
	station: THREE.Vector3;
	direction: THREE.Vector3;
	handoffProjection: number;
	routeDistanceAtRelease: number;
	routeDistanceAtHandoff?: number;
}

interface RouteSlotEntity {
	key: string;
	bindingId: string;
	palletId: string;
	routeId: string;
	slotIndex: number;
	slotCount: number;
	currentProgress: number;
	targetProgress: number;
	transportUnitType: TwinTransportUnitType;
	resourceKey: string;
	root: THREE.Group;
	simulationEngine?: RouteEngine;
	simulationProcess?: ComponentProcessRuntime;
	routingContext?: TwinRouteRoutingContext;
	routeCode?: 'A' | 'B';
	physicalLane?: 'A' | 'B';
	physicalLaneOrdinal?: number;
	simulationRoute?: TwinRouteDefinition;
	manualStationRelease?: ManualStationReleaseState;
	initialProgress?: number;
}

interface RouteCurveInfo {
	route: TwinRouteDefinition;
	curve: THREE.Curve<THREE.Vector3>;
	loop: boolean;
}

/**
 * PLC/IoT 离散槽位数组运行时。
 * 例如 [12,23,0,0] 表示槽位 0/1 分别存在托盘 12/23，0 表示空位。
 * 数组索引只负责“位置事实”，不参与工艺推进和路径决策。
 */
export class RouteSlotArrayRuntime {
	private manifest: TwinSceneManifest;
	private readonly entities = new Map<string, RouteSlotEntity>();
	private readonly curves = new Map<string, RouteCurveInfo>();
	private readonly bindingRouteIds = new Map<string, string>();
	private readonly group = new THREE.Group();
	private readonly simulationAutoFeedSequences = new Map<string, number>();
	private readonly linearQueueDistanceCache = new Map<string, number>();
	private running = false;

	constructor(
		private readonly scene: THREE.Scene,
		manifest: TwinSceneManifest,
		private readonly reportError?: (message: string) => void,
		private readonly getComponentRoot?: (objectId: string) => THREE.Group | undefined,
	) {
		this.manifest = structuredClone(manifest);
		this.group.name = 'IoTSharp Route Slot Array Runtime';
		this.group.userData.iotsharpTwinHelper = false;
		this.scene.add(this.group);
		this.setManifest(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		// Simulation route engines carry resolved branch/process state. Recreate them from the new Manifest
		// so a layout/route upgrade never keeps stale path state. Stable pallet IDs are recreated unchanged.
		for (const entity of [...this.entities.values()]) {
			if (entity.simulationEngine) this.removeEntity(entity.key);
		}
		this.manifest = structuredClone(manifest);
		this.simulationAutoFeedSequences.clear();
		this.linearQueueDistanceCache.clear();
		this.curves.clear();
		this.bindingRouteIds.clear();
		for (const route of this.manifest.routes || []) {
			const info = this.createCurve(route);
			if (info) this.curves.set(route.routeId, info);
		}
		const activeBindings = new Set<string>();
		const authoritativeRouteIds = new Set<string>();
		const simulationMode = this.manifest.runtime.dataMode === 'simulation';
		const initializerByRouteId = new Map((this.manifest.runtime.routePalletInitializers || []).map((item) => [item.routeId, item]));
		for (const binding of this.manifest.bindings || []) {
			if (binding.enabled === false || binding.transform.kind !== 'routeSlotArray') continue;
			const routeId = this.resolveRouteId(binding);
			if (!routeId) continue;
			this.bindingRouteIds.set(binding.bindingId, routeId);
			if (!simulationMode) {
				const configuredLiveBindingId = initializerByRouteId.get(routeId)?.liveBindingId?.trim();
				if (configuredLiveBindingId && configuredLiveBindingId !== binding.bindingId) continue;
				activeBindings.add(binding.bindingId);
				authoritativeRouteIds.add(routeId);
			}
		}
		if (simulationMode) {
			for (const initializer of this.manifest.runtime.routePalletInitializers || []) {
				if (authoritativeRouteIds.has(initializer.routeId)) continue;
				const route = this.manifest.routes.find((item) => item.routeId === initializer.routeId);
				if (!route || !this.curves.has(route.routeId)) continue;
				const bindingId = this.simulationBindingId(route.routeId);
				activeBindings.add(bindingId);
				this.bindingRouteIds.set(bindingId, route.routeId);
			}
		}
		for (const entity of [...this.entities.values()]) {
			if (!activeBindings.has(entity.bindingId)) this.removeEntity(entity.key);
		}
		if (simulationMode) this.applySimulationDefaults(authoritativeRouteIds);
	}

	private applySimulationDefaults(authoritativeRouteIds: Set<string>) {
		for (const initializer of this.manifest.runtime.routePalletInitializers || []) {
			if (authoritativeRouteIds.has(initializer.routeId)) continue;
			const route = this.manifest.routes.find((item) => item.routeId === initializer.routeId);
			if (!route) continue;
			const capacity = Math.max(0, route.edges.filter((edge) => edge.enabled !== false).reduce((sum, edge) => sum + Math.max(0, Number(edge.capacity) || 0), 0));
			if (capacity <= 0) continue;
			const count = THREE.MathUtils.clamp(Math.floor(Number(initializer.simulationDefaultCount) || 0), 0, capacity);
			const emptyValue = initializer.emptyValue ?? 0;
			// 仿真默认托盘不是 PLC 槽位快照。只创建 count 个稳定 ID，让 routeSlotProgress 将它们均匀铺开，
			// 后续由各自 RouteEngine 沿完整工艺闭环推进；live 模式仍只服从真实数组索引。
			const slots: unknown[] = Array.from({ length: count }, (_, index) => `SIM-${initializer.routeId}-${index + 1}`);
			const bindingId = this.simulationBindingId(initializer.routeId);
			const binding: TwinObjectBindingDefinition = {
				bindingId,
				objectId: `simulation:${initializer.routeId}`,
				source: { kind: 'telemetry', key: initializer.telemetryKey },
				target: { kind: 'customProperty', property: `routeSlots:${initializer.routeId}` },
				transform: { kind: 'routeSlotArray', routeId: initializer.routeId, emptyValue },
				staleAfterMs: 0,
			};
			this.apply(binding, slots, false);
		}
	}

	private simulationBindingId(routeId: string) {
		return `simulation-route-slots:${routeId}`;
	}

	apply(binding: TwinObjectBindingDefinition, value: unknown, stale: boolean) {
		const simulationBinding = binding.bindingId.startsWith('simulation-route-slots:');
		if (this.manifest.runtime.dataMode === 'simulation' && !simulationBinding) return;
		if (this.manifest.runtime.dataMode === 'live' && simulationBinding) return;
		const routeId = this.bindingRouteIds.get(binding.bindingId) || this.resolveRouteId(binding);
		if (!routeId) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 未配置目标路线`);
			return;
		}
		if (this.manifest.runtime.dataMode === 'live') {
			const initializer = (this.manifest.runtime.routePalletInitializers || []).find((item) => item.routeId === routeId);
			const configuredLiveBindingId = initializer?.liveBindingId?.trim();
			if (configuredLiveBindingId && configuredLiveBindingId !== binding.bindingId) return;
		}
		const curveInfo = this.curves.get(routeId);
		if (!curveInfo) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 引用的路线 ${routeId} 不存在或不可绘制`);
			return;
		}
		const existing = [...this.entities.values()].filter((item) => item.bindingId === binding.bindingId);
		if (stale) {
			for (const entity of existing) entity.root.visible = false;
			return;
		}
		const config = binding.transform as Record<string, unknown>;
		let rawArray: unknown = value;
		if (typeof rawArray === 'string') {
			try { rawArray = JSON.parse(rawArray); } catch {
				this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 收到的值不是合法 JSON 数组`);
				return;
			}
		}
		if (!Array.isArray(rawArray)) {
			this.reportError?.(`托盘位置数组绑定 ${binding.bindingId} 需要 JSON 数组，实际收到 ${typeof value}`);
			return;
		}
		const emptyValue = config.emptyValue ?? 0;
		const slots = parseRouteSlotArray(rawArray, emptyValue);
		const activeKeys = new Set<string>();
		const transportUnitType = this.resolveTransportUnitType(curveInfo.route);
		const resourceKey = this.resolveTransportUnitResourceKey(curveInfo.route, transportUnitType);
		for (const slot of slots) {
			const key = `${binding.bindingId}:${slot.palletId}`;
			activeKeys.add(key);
			const progress = routeSlotProgress(slot.slotIndex, slot.slotCount, curveInfo.loop);
			let entity = this.entities.get(key);
			if (entity && (entity.transportUnitType !== transportUnitType || entity.resourceKey !== resourceKey)) {
				this.removeEntity(key);
				entity = undefined;
			}
			if (!entity) {
				entity = {
					key,
					bindingId: binding.bindingId,
					palletId: slot.palletId,
					routeId,
					slotIndex: slot.slotIndex,
					slotCount: rawArray.length,
					currentProgress: progress,
					targetProgress: progress,
					transportUnitType,
					resourceKey,
					root: this.createTransportUnitMesh(binding.bindingId, slot.palletId, transportUnitType, resourceKey),
					initialProgress: progress,
				};
				this.entities.set(key, entity);
				this.group.add(entity.root);
				if (binding.bindingId.startsWith('simulation-route-slots:') && this.manifest.runtime.dataMode === 'simulation') {
					const routeCode: 'A' | 'B' = slot.slotIndex % 2 === 0 ? 'A' : 'B';
					const physicalLane = routeCode;
					const physicalLaneOrdinal = Math.floor(slot.slotIndex / 2);
					const simulationRoute = structuredClone(curveInfo.route);
					const laneStart = simulationRoute.points.find((point) => point.kind === 'processStation'
						&& point.process?.simulationEntry === true
						&& (!point.process.physicalLane || point.process.physicalLane === physicalLane));
					if (laneStart) simulationRoute.startPointId = laneStart.pointId;
					const routingContext: TwinRouteRoutingContext = { dataMode: 'simulation', payload: { routeCode, physicalLane, palletId: slot.palletId, weightSequence: slot.slotIndex }, bindingValues: {}, edgeOccupancy: {}, staleBindingIds: [] };
					const engine = new RouteEngine(simulationRoute, entity.root);
					engine.setRoutingContext(routingContext);
					const routeSnapshot = engine.getSnapshot();
					const isSimulationEntryRoute = Boolean(laneStart);
					const isQueuedNonLoopSimulationRoute = curveInfo.loop === false && slot.slotCount > 1;
					// Simulation 的默认小托盘逻辑上必须全部从机器人批次工位开始；
					// 视觉排队由 applyStationQueueVisual 单独拉开，绝不能靠“靠近路线尾端”伪造，
					// 否则尾端若存在桁架工位会先被桁架截停，形成 1+5 永久死锁。
					const initialDistance = (isSimulationEntryRoute || isQueuedNonLoopSimulationRoute) && routeSnapshot.lengthMeters > 0
						? 0
						: progress * routeSnapshot.lengthMeters;
					const initialProgress = routeSnapshot.lengthMeters > 0 ? initialDistance / routeSnapshot.lengthMeters : 0;
					engine.correctDistance(initialDistance);
					engine.setRunning(this.running);
					const process = new ComponentProcessRuntime({
						route: structuredClone(simulationRoute),
						routeEngine: engine,
						dataMode: 'simulation',
						getComponentRoot: (objectId) => this.getComponentRoot?.(objectId),
						getRoutingContext: () => routingContext,
						getBehaviorRequirements: (objectId) => this.getBehaviorRequirements(objectId),
						entityId: slot.palletId,
					});
					process.setRunning(this.running);
					entity.simulationEngine = engine;
					entity.simulationProcess = process;
					entity.routingContext = routingContext;
					entity.routeCode = routeCode;
					entity.physicalLane = physicalLane;
					entity.physicalLaneOrdinal = physicalLaneOrdinal;
					entity.simulationRoute = simulationRoute;
					entity.initialProgress = initialProgress;
					entity.currentProgress = initialProgress;
					entity.targetProgress = initialProgress;
					entity.root.userData.simulationRouteDriven = true;
					entity.root.userData.routeCode = routeCode;
					entity.root.userData.physicalLaneId = physicalLane;
					entity.root.userData.physicalLaneOrdinal = physicalLaneOrdinal;
					entity.root.userData.initialRouteProgress = initialProgress;
					entity.root.userData.simulationQueueIndex = slot.slotIndex;
					engine.render(1);
					this.applyTransportUnitYawOffset(entity);
					this.applyInitialPhysicalStationLayout(entity);
				}
			} else {
				entity.routeId = routeId;
				entity.slotIndex = slot.slotIndex;
				entity.slotCount = rawArray.length;
				entity.targetProgress = progress;
				entity.root.visible = true;
			}
			entity.slotIndex = slot.slotIndex;
			entity.slotCount = rawArray.length;
			entity.root.userData.slotIndex = slot.slotIndex;
			entity.root.userData.slotCount = rawArray.length;
			entity.root.userData.routeSlotRawValue = slot.rawValue;
			if (!entity.simulationEngine) this.applyPose(entity, curveInfo, entity.currentProgress);
		}
		for (const entity of existing) {
			if (!activeKeys.has(entity.key)) this.removeEntity(entity.key);
		}
	}

	tick(deltaSeconds: number) {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		if (this.running) this.ensureSimulationAutoFeed();
		this.cleanupStalePhysicalReleaseFlags();
		const blend = 1 - Math.exp(-Math.min(deltaSeconds, 0.25) * 10);
		for (const entity of this.orderedEntitiesForMovement()) {
			if (!entity.root.visible) continue;
			if (entity.simulationEngine) {
				this.refreshSimulationRoutingContext(entity);
				const beforeSnapshot = entity.simulationEngine.getSnapshot();
				const beforeDistance = beforeSnapshot.distanceMeters;
				const beforePosition = entity.root.position.clone();
				const allowRouteStep = entity.simulationProcess?.updateFixed(deltaSeconds) ?? true;
				this.captureManualStationRelease(entity);
				const mergeYieldRemaining = Math.max(0, Number(entity.root.userData.mergeYieldSeconds || 0) - deltaSeconds);
				entity.root.userData.mergeYieldSeconds = mergeYieldRemaining;
				if (entity.manualStationRelease) {
					this.advanceManualStationRelease(entity, deltaSeconds);
				} else if (mergeYieldRemaining > 0) {
					// 合流仲裁退让的托盘需要保持一个短暂让行窗口，避免它在
					// 下一帧立即前进又把优先托盘顶回去。
					entity.root.userData.collisionHeld = true;
				} else {
					if (allowRouteStep) entity.simulationEngine.updateFixed(deltaSeconds);
					entity.simulationEngine.render(1);
					this.applyTransportUnitYawOffset(entity);
					const movingSnapshot = entity.simulationEngine.getSnapshot();
					this.applyStationQueueVisual(entity, movingSnapshot.distanceMeters, movingSnapshot.lengthMeters);
					const stationVisual = Boolean(entity.root.userData.stationBatchVisual || entity.root.userData.stationQueueVisual || entity.root.userData.stationReleaseVisual);
					const gantryStationVisual = stationVisual && (entity.root.userData.stationProcessType === 'gantry-stacking'
						|| entity.simulationProcess?.getSnapshot().activeComponentObjectId === 'reference-stacking-gantry');
					if ((!stationVisual || gantryStationVisual) && !this.isPlasticPalletPositionClear(entity, entity.root.position)) {
						// 两条入边在同一合流点附近可能形成“双方下一步都碰撞”的几何死锁。
						// 先让稳定优先级更高的实体通行，并把另一实体退回一个很小的上游安全间距；
						// 只对共同目标点的不同入边启用，普通同道跟车仍按碰撞保持不后退。
						if (this.tryResolveMergeConflict(entity, movingSnapshot, beforeSnapshot.currentEdgeId)) continue;
						entity.simulationEngine.correctDistance(beforeDistance);
						entity.root.position.copy(beforePosition);
						entity.root.userData.collisionHeld = true;
					} else {
						delete entity.root.userData.collisionHeld;
					}
				}
				const snapshot = entity.simulationEngine.getSnapshot();
				entity.currentProgress = snapshot.progress;
				entity.targetProgress = snapshot.progress;
				entity.root.userData.routeProgress = snapshot.progress;
				entity.root.userData.routeState = snapshot.state;
				entity.root.userData.routeCompleted = this.curves.get(entity.routeId)?.loop === false && snapshot.progress >= 0.999;
				if (entity.root.userData.routeCompleted === true) this.cleanupCompletedEntityStationMembership(entity);
				entity.root.userData.activeProcessComponentObjectId = entity.simulationProcess?.getSnapshot().activeComponentObjectId;
				continue;
			}
			const curveInfo = this.curves.get(entity.routeId);
			if (!curveInfo) continue;
			let delta = entity.targetProgress - entity.currentProgress;
			if (curveInfo.loop) {
				if (delta > 0.5) delta -= 1;
				else if (delta < -0.5) delta += 1;
			}
			entity.currentProgress += delta * blend;
			if (curveInfo.loop) entity.currentProgress = ((entity.currentProgress % 1) + 1) % 1;
			else entity.currentProgress = THREE.MathUtils.clamp(entity.currentProgress, 0, 1);
			this.applyPose(entity, curveInfo, entity.currentProgress);
			entity.root.userData.routeCompleted = !curveInfo.loop && entity.currentProgress >= 0.999;
			if (entity.root.userData.routeCompleted === true) this.cleanupCompletedEntityStationMembership(entity);
		}
		this.resolvePhysicalLaneOverlaps();
		this.resolveStationEnvelopeOverlaps();
		this.syncSimulationOutputStoppers();
	}

	/**
	 * 最后一层同段跟车互锁：同一路线、同一物理排、同一当前 Edge 的运行托盘不得重叠。
	 *
	 * 闭环路线包含合流、回流和同平面交叉；不同 Edge 的托盘即使属于同一 A/B 排，
	 * 也不能在这里按一条线性队列统一后退，否则交叉口一次避让会把另一段托盘沿
	 * Route 倒退数十米，长期运行会出现“几乎走不完一圈”的吞吐退化。不同 Edge
	 * 的空间冲突由每步的全局碰撞检查以及 merge/geometric crossing 仲裁负责。
	 */
	private resolvePhysicalLaneOverlaps() {
		const groups = new Map<string, RouteSlotEntity[]>();
		for (const entity of this.entities.values()) {
			if (!entity.simulationEngine || !entity.root.visible || entity.transportUnitType !== 'plastic-pallet') continue;
			if (entity.manualStationRelease || entity.root.userData.stationBatchVisual || entity.root.userData.stationQueueVisual || entity.root.userData.stationReleaseVisual) continue;
			const currentEdgeId = entity.simulationEngine.getSnapshot().currentEdgeId;
			if (!currentEdgeId) continue;
			const key = `${entity.routeId}:${entity.physicalLane || ''}:${currentEdgeId}`;
			groups.set(key, [...(groups.get(key) || []), entity]);
		}
		for (const entities of groups.values()) {
			entities.sort((left, right) => right.simulationEngine!.getSnapshot().distanceMeters - left.simulationEngine!.getSnapshot().distanceMeters);
			const groupSet = new Set(entities);
			const settled: RouteSlotEntity[] = [];
			for (const entity of entities) {
				if (settled.some((front) => !this.isPlasticPalletPositionClearAgainst(entity, entity.root.position, front))) {
					const snapshot = entity.simulationEngine!.getSnapshot();
					const previousDistance = snapshot.distanceMeters;
					const previousPosition = entity.root.position.clone();
					const step = Math.max(0.18, this.palletDiameter(entity) + 0.04);
					let resolved = false;
					for (let attempt = 1; attempt <= 18; attempt += 1) {
						entity.simulationEngine!.correctDistance(previousDistance - attempt * step);
						entity.simulationEngine!.render(1);
						this.applyTransportUnitYawOffset(entity);
						if (this.isPhysicalLanePositionClear(entity, entity.root.position, groupSet, settled)) { resolved = true; break; }
					}
					if (!resolved) {
						entity.simulationEngine!.correctDistance(previousDistance);
						entity.root.position.copy(previousPosition);
					}
				}
				settled.push(entity);
			}
		}
	}

	/**
	 * 工位批次槽位属于已预占的物理包络。普通 Route Edge 上的托盘若在同一 tick
	 * 进入该包络，必须让普通输送队列退回上游，而不能把工位托盘挪出已确认槽位。
	 * 这里只处理 stationBatch/Queue/ReleaseVisual 与普通运行托盘之间的最终安全兜底；
	 * 不把不同 Edge 合并成一条全局线性队列，因此不会恢复闭环吞吐退化。
	 */
	private resolveStationEnvelopeOverlaps() {
		const stationEntities = [...this.entities.values()].filter((item) => item.transportUnitType === 'plastic-pallet'
			&& item.root.visible
			&& Boolean(item.root.userData.stationBatchVisual || item.root.userData.stationQueueVisual || item.root.userData.stationReleaseVisual));
		if (!stationEntities.length) return;

		for (const stationEntity of stationEntities) {
			for (const moving of this.entities.values()) {
				if (moving === stationEntity || moving.transportUnitType !== 'plastic-pallet' || !moving.root.visible || !moving.simulationEngine) continue;
				if (moving.manualStationRelease || moving.root.userData.stationBatchVisual || moving.root.userData.stationQueueVisual || moving.root.userData.stationReleaseVisual) continue;
				const required = (this.palletDiameter(stationEntity) + this.palletDiameter(moving)) / 2 + 0.02;
				const distance = stationEntity.root.position.distanceTo(moving.root.position);
				if (distance >= required - 0.000001) continue;

				// 某些汇流器的整条支路 Edge 都位于工位托盘 1.50m 排他包络内，
				// 因此不能只在“当前 Edge 内”后退，而必须让同一物理排的进场队列
				// 整体退回上一段安全区。下游已经通过汇流点的托盘不参与退让。
				if (this.backoffStationApproachQueue(moving, stationEntity)) continue;

				// 普通单段冲突仍保留当前 Edge 的轻量退让作为兜底。
				const backoff = Math.max(0.22, required - distance + 0.08);
				this.backoffCurrentEdgeQueue(moving, backoff);
			}
		}
	}

	private isPlasticPalletPositionClearAgainst(entity: RouteSlotEntity, candidate: THREE.Vector3, other: RouteSlotEntity) {
		const required = (this.palletDiameter(entity) + this.palletDiameter(other)) / 2 + 0.02;
		return candidate.distanceTo(other.root.position) >= required - 0.000001;
	}

	private isPhysicalLanePositionClear(entity: RouteSlotEntity, candidate: THREE.Vector3, groupSet: Set<RouteSlotEntity>, settled: RouteSlotEntity[]) {
		for (const other of this.entities.values()) {
			if (other === entity || other.transportUnitType !== 'plastic-pallet' || !other.root.visible) continue;
			// 同一物理排中尚未排序的后车暂时忽略，由后续迭代逐个退回；
			// 其他路线/物理排仍按全局碰撞边界检查。
			if (groupSet.has(other) && !settled.includes(other)) continue;
			if (!this.isPlasticPalletPositionClearAgainst(entity, candidate, other)) return false;
		}
		return true;
	}

	/**
	 * 清理跨周期遗留的物理离站标记。
	 *
	 * 行为工位会先完成逻辑 Release，再由 RouteSlotArrayRuntime 逐托执行
	 * stationReleaseVisual。旧周期若在路由切换/重置/实体被移除时只留下 ID，
	 * 下一批会永远停在物理占位区之外。只有已经明确 handoff 完成的托盘，或
	 * 已经不存在/不可见的实体，才允许从 pending 列表中幂等移除；仍处于
	 * manualStationRelease 的实体必须保留，不能用距离工位的粗略判断提前放行。
	 */
	private cleanupStalePhysicalReleaseFlags() {
		if (this.manifest.runtime.dataMode !== 'simulation' || !this.getComponentRoot) return;
		const visited = new Set<string>();
		for (const route of this.manifest.routes || []) for (const point of route.points || []) {
			if (point.kind !== 'processStation' || !point.componentObjectId) continue;
			if (!point.process?.behaviorCompletionGroups?.length && point.process?.simulationEntry !== true) continue;
			const root = this.getComponentRoot(point.componentObjectId);
			if (!root || !Array.isArray(root.userData?.stationPhysicalReleasePalletIds)) continue;
			const key = `${point.componentObjectId}:${point.pointId}`;
			if (visited.has(key)) continue;
			visited.add(key);
			const pending = root.userData.stationPhysicalReleasePalletIds.map(String).filter(Boolean);
			if (!pending.length) continue;
			const nextPending = pending.filter((palletId) => {
				const entity = [...this.entities.values()].find((item) => item.palletId === palletId);
				if (!entity || !entity.root.visible) return false;
				// Loading robot A/B share one component root, but each process point
				// owns a different physical lane. Do not let the A point clean B's
				// release marker (or vice versa) during the same simulation tick.
				const pointLane = point.process?.physicalLane;
				const entityLane = entity.physicalLane || entity.root.userData?.physicalLane;
				if (pointLane && entityLane && pointLane !== entityLane) return true;
				if (entity.manualStationRelease?.pointId === point.pointId) return true;
				return entity.root.userData.routeHandoffCompletePointId !== point.pointId;
			});
			if (nextPending.length === pending.length) continue;
			root.userData.stationPhysicalReleasePalletIds = nextPending;
			const released = this.stringArray(root.userData.stationReleasedPalletIds);
			const activeBatch = this.stringArray(root.userData.stationPalletIds);
			// stationReleasedPalletIds 同时承担“逻辑批次已 Release”的计数；
			// activeBatch 尚未清空时，即使托盘已经完成物理 handoff，也必须保留
			// released ID，否则批次永远达不到 batchSize，后续工位会永久等待。
			root.userData.stationReleasedPalletIds = activeBatch.length
				? released.filter((palletId) => activeBatch.includes(palletId))
				: released.filter((palletId) => nextPending.includes(palletId));
			if (!nextPending.length && !activeBatch.length) {
				root.userData.stationReleaseAuthorized = false;
				if (root.userData.processPhase === 'waiting-physical-release') root.userData.processPhase = 'idle';
			}
		}
	}

	private setOutputStopperVisual(root: THREE.Group, definition: any, raised: boolean, palletPresent: boolean) {
		const stopper = root.getObjectByName(String(definition.nodePath || ''));
		if (stopper) {
			const raisedY = Number(stopper.userData?.raisedY ?? stopper.position.y);
			const loweredY = Number(stopper.userData?.loweredY ?? raisedY - 0.22);
			stopper.position.y = raised ? raisedY : loweredY;
			stopper.userData.stopperRaised = raised;
		}
		const sensor = root.getObjectByName(String(definition.sensorNodePath || ''));
		if (sensor) sensor.userData.palletPresent = palletPresent;
	}

	private syncSimulationOutputStoppers() {
		if (this.manifest.runtime.dataMode !== 'simulation' || !this.getComponentRoot) return;
		const states = new Map<string, { root: THREE.Group; definition: any; raised: boolean; present: boolean }>();
		for (const route of this.manifest.routes || []) for (const edge of route.edges || []) {
			if (edge.enabled === false || edge.conveyorSizeClass !== 'small') continue;
			const objectId = edge.componentObjectId || edge.conveyorObjectId;
			if (!objectId) continue;
			const root = this.getComponentRoot(objectId);
			const definitions = Array.isArray(root?.userData?.outputStoppers) ? root.userData.outputStoppers as any[] : [];
			for (const definition of definitions) states.set(objectId + ':' + definition.portId, { root: root!, definition, raised: true, present: false });
		}
		for (const entity of this.entities.values()) {
			if (!entity.simulationEngine || !entity.root.visible) continue;
			const route = this.curves.get(entity.routeId)?.route;
			const snapshot = entity.simulationEngine.getSnapshot();
			const edge = route?.edges.find((item) => item.edgeId === snapshot.currentEdgeId);
			if (!route || !edge || edge.conveyorSizeClass !== 'small') continue;
			const objectId = edge.componentObjectId || edge.conveyorObjectId;
			if (!objectId) continue;
			const toPoint = route.points.find((point) => point.pointId === edge.toPointId);
			const root = this.getComponentRoot(objectId);
			const definitions = Array.isArray(root?.userData?.outputStoppers) ? root.userData.outputStoppers as any[] : [];
			const portId = toPoint?.componentPortId;
			const definition = definitions.find((item) => item.portId === portId) || (definitions.length === 1 ? definitions[0] : undefined);
			if (!definition || !toPoint) continue;
			const state = states.get(objectId + ':' + definition.portId);
			if (!state) continue;
			const distance = entity.root.position.distanceTo(new THREE.Vector3(...toPoint.position));
			if (distance <= 0.85) state.present = true;
			if (distance <= 0.62 && snapshot.state !== 'waiting') state.raised = false;
		}
		for (const state of states.values()) this.setOutputStopperVisual(state.root, state.definition, state.raised, state.present);
	}

	private refreshSimulationRoutingContext(entity: RouteSlotEntity) {
		if (!entity.simulationEngine || !entity.routingContext) return;
		let materialCount = 0;
		const materialTypes = new Set<string>();
		entity.root.traverse((node) => {
			if (node.userData?.materialEntity !== true) return;
			materialCount += 1;
			const payloadType = String(node.userData?.payloadType || '').trim();
			if (payloadType) materialTypes.add(payloadType);
		});
		entity.routingContext.payload = {
			...(entity.routingContext.payload || {}),
			materialCount,
			materialTypes: [...materialTypes],
		};
		entity.root.userData.materialCount = materialCount;
		entity.root.userData.materialTypes = [...materialTypes];
		entity.simulationEngine.setRoutingContext(entity.routingContext);
	}

	private applyInitialPhysicalStationLayout(entity: RouteSlotEntity) {
		if (!entity.simulationRoute || !entity.physicalLane) return;
		const point = entity.simulationRoute.points.find((item) => item.kind === 'processStation'
			&& item.process?.simulationEntry === true
			&& (!item.process.physicalLane || item.process.physicalLane === entity.physicalLane));
		if (!point?.process?.batchLayout) return;
		this.applyPhysicalBatchSlot(entity, point);
		entity.root.userData.initialPhysicalLaneLayout = true;
	}

	private applyPhysicalBatchSlot(entity: RouteSlotEntity, point: TwinRouteDefinition['points'][number]) {
		const layout = point.process?.batchLayout;
		if (!layout) return;
		const columns = Math.max(1, Math.floor(Number(layout.columns) || 6));
		const ordinal = Math.max(0, Math.min(columns - 1, Number(entity.physicalLaneOrdinal || 0)));
		// 创建顺序 A0/B0/A1/B1...；0 号托盘放在前端，释放顺序天然是前车先走。
		const column = columns - 1 - ordinal;
		const center = new THREE.Vector3(...point.position).add(new THREE.Vector3(...(layout.centerOffset || [0, 0, 0])));
		const columnOffset = (column - (columns - 1) / 2) * Number(layout.columnSpacingMeters || 1.55);
		if ((layout.columnAxis || 'x') === 'z') center.z += columnOffset; else center.x += columnOffset;
		entity.root.position.copy(center);
		entity.root.userData.stationBatchColumn = column;
		entity.root.userData.stationBatchLane = entity.physicalLane;
	}

	private applyStationBatchSlot(entity: RouteSlotEntity, point: TwinRouteDefinition['points'][number], ordinal: number) {
		const layout = point.process?.batchLayout;
		if (!layout) return;
		const columns = Math.max(1, Math.floor(Number(layout.columns) || 6));
		const slotOrdinal = Math.max(0, Math.min(columns - 1, Number(ordinal) || 0));
		if (point.process?.type === 'gantry-stacking' && entity.simulationRoute && entity.simulationEngine) {
			const activeEdgeIds = new Set(entity.simulationEngine.getSnapshot().activeEdgeIds);
			const incoming = entity.simulationRoute.edges.find((edge) => edge.enabled !== false && edge.toPointId === point.pointId && activeEdgeIds.has(edge.edgeId));
			const upstreamPoint = incoming ? entity.simulationRoute.points.find((candidate) => candidate.pointId === incoming.fromPointId) : undefined;
			if (upstreamPoint) {
				// 桁架是单排直通工位：第一个到达的托盘停在抓取中心，后续托盘
				// 沿入料方向向上游排队。不能沿工位中心对称展开，否则一半托盘
				// 会落到出料侧，离站时必然穿过同批托盘。
				const station = new THREE.Vector3(...point.position);
				const upstream = new THREE.Vector3(...upstreamPoint.position).sub(station).setY(0);
				if (upstream.lengthSq() > 0.000001) {
					const spacing = Math.max(1.50, Number(layout.columnSpacingMeters || 1.55));
					entity.root.position.copy(station.addScaledVector(upstream.normalize(), slotOrdinal * spacing));
					entity.root.userData.stationBatchColumn = slotOrdinal;
					entity.root.userData.stationBatchLane = entity.physicalLane;
					return;
				}
			}
		}
		const column = columns - 1 - slotOrdinal;
		const center = new THREE.Vector3(...point.position).add(new THREE.Vector3(...(layout.centerOffset || [0, 0, 0])));
		const columnOffset = (column - (columns - 1) / 2) * Number(layout.columnSpacingMeters || 1.55);
		if ((layout.columnAxis || 'x') === 'z') center.z += columnOffset; else center.x += columnOffset;
		entity.root.position.copy(center);
		entity.root.userData.stationBatchColumn = column;
		entity.root.userData.stationBatchLane = entity.physicalLane;
	}

	private captureManualStationRelease(entity: RouteSlotEntity) {
		if (entity.manualStationRelease || !entity.simulationRoute || !entity.physicalLane) return;
		for (const point of entity.simulationRoute.points) {
			const isPhysicalLaneMatch = !point.process?.physicalLane || point.process.physicalLane === entity.physicalLane;
			const hasBatchHandoff = Boolean(point.process?.behaviorCompletionGroups?.length || point.process?.simulationEntry);
			if (point.kind !== 'processStation' || !isPhysicalLaneMatch || !hasBatchHandoff || !point.componentObjectId) continue;
			const root = this.getComponentRoot?.(point.componentObjectId);
			const releasedIds = Array.isArray(root?.userData?.stationReleasedPalletIds) ? root!.userData.stationReleasedPalletIds.map(String) : [];
			if (!releasedIds.includes(entity.palletId)) continue;
			if (entity.root.userData.routeHandoffCompletePointId === point.pointId) {
				// handoff 标记跨圈保留时，下一圈会把同一托盘再次登记为
				// stationReleased；当它已经离开工位安全半径后及时幂等清理，
				// 避免旧周期的 physicalRelease 永久阻塞新批次。
				const stationPosition = new THREE.Vector3(...point.position);
				if (entity.root.position.distanceTo(stationPosition) > 2.5) this.unregisterPhysicalStationRelease(entity, point.componentObjectId);
				return;
			}
			// ComponentProcessRuntime 会把 RouteEngine 的逻辑距离校正到 processStation 中心。
			// 批次视觉之前虽然把托盘拉回了各自 1×6 槽位，但释放这一帧不再走 queue visual，
			// 因此必须在开始物理 handoff 前再次恢复自己的槽位，绝不能从共享 station center 起步。
			const activeBatchIds = Array.isArray(root?.userData?.stationPalletIds) ? root!.userData.stationPalletIds.map(String) : [];
			const completedBatchIds = Array.isArray(root?.userData?.stationLastCompletedPalletIds) ? root!.userData.stationLastCompletedPalletIds.map(String) : [];
			// 最后一托完成逻辑 Release 时 ComponentProcessRuntime 会清空 active batch，
			// 但物理离站才刚开始。必须继续使用刚完成批次的稳定顺序计算各自槽位；
			// 否则最后一托会因 batchIndex=-1 落到 0 号槽，与第一托重叠。
			const batchIds = activeBatchIds.includes(entity.palletId) ? activeBatchIds : completedBatchIds;
			if (point.process?.type === 'gantry-stacking') {
				const batchIndex = batchIds.indexOf(entity.palletId);
				this.applyStationBatchSlot(entity, point, batchIndex >= 0 ? batchIndex : 0);
			} else {
				this.applyPhysicalBatchSlot(entity, point);
			}
			const outgoingCandidates = entity.simulationRoute.edges
				.filter((edge) => edge.enabled !== false && edge.fromPointId === point.pointId)
				.map((edge) => ({ edge, target: entity.simulationRoute!.points.find((candidate) => candidate.pointId === edge.toPointId) }))
				.filter((item) => Boolean(item.target));
			const outgoing = (point.process?.releaseEdgeId
				? outgoingCandidates.find((item) => item.edge.edgeId === point.process?.releaseEdgeId)
				: undefined) || outgoingCandidates[0];
			if (!outgoing?.target) return;
			const station = new THREE.Vector3(...point.position);
			const straightThroughHandoff = point.process?.type === 'gantry-stacking'
				? this.resolveStraightThroughBatchHandoff(entity, point, station)
				: undefined;
			const direction = straightThroughHandoff?.direction
				|| new THREE.Vector3(...outgoing.target.position).sub(station).setY(0);
			if (direction.lengthSq() < 0.000001) return;
			direction.normalize();
			const columns = Math.max(1, Math.floor(Number(point.process?.batchLayout?.columns) || 6));
			const spacing = Math.max(1.50, Number(point.process?.batchLayout?.columnSpacingMeters || 1.55));
			const physicalReleaseIds = Array.isArray(root?.userData?.stationPhysicalReleasePalletIds)
				? root!.userData.stationPhysicalReleasePalletIds.map(String)
				: [];
			// 第一托开始物理离站时就把整批登记为 pending，避免错峰 Release 的间隙里 pending 暂时归零，
			// 从而让下一批提前占住 station center。每一托完成真实 Route handoff 后再逐个移除。
			for (const palletId of [...batchIds, entity.palletId]) if (!physicalReleaseIds.includes(palletId)) physicalReleaseIds.push(palletId);
			root!.userData.stationPhysicalReleasePalletIds = physicalReleaseIds;
			entity.manualStationRelease = {
				pointId: point.pointId,
				componentObjectId: point.componentObjectId,
				station,
				direction,
				handoffProjection: straightThroughHandoff?.projection ?? ((columns - 1) / 2 + 1) * spacing,
				routeDistanceAtRelease: entity.simulationEngine.getSnapshot().distanceMeters,
				routeDistanceAtHandoff: straightThroughHandoff?.routeDistance,
			};
			entity.root.userData.stationReleaseVisual = true;
			delete entity.root.userData.stationBatchVisual;
			return;
		}
	}

	/**
	 * 桁架参考线的历史组件拓扑在抓取位后包含一个用于空托合流的回头段。
	 * 真实 1×6 批次不能沿该折返段离站，否则会与仍在入料侧等待的下一批迎头相撞。
	 * 这里从当前已解析路径中寻找“沿入料方向继续直行”的第一个下游点，并返回
	 * 与 RouteEngine 相同弧长口径的交接距离；托盘先连续移动到该点，再恢复路线驱动。
	 */
	private resolveStraightThroughBatchHandoff(entity: RouteSlotEntity, point: TwinRouteDefinition['points'][number], station: THREE.Vector3) {
		if (!entity.simulationRoute || !entity.simulationEngine) return undefined;
		const snapshot = entity.simulationEngine.getSnapshot();
		const pointIndex = snapshot.activePointIds.indexOf(point.pointId);
		if (pointIndex <= 0) return undefined;
		const routePoints = new Map(entity.simulationRoute.points.map((candidate) => [candidate.pointId, candidate]));
		const upstreamPoint = routePoints.get(snapshot.activePointIds[pointIndex - 1]);
		if (!upstreamPoint) return undefined;
		const forward = station.clone().sub(new THREE.Vector3(...upstreamPoint.position)).setY(0);
		if (forward.lengthSq() < 0.000001) return undefined;
		forward.normalize();

		let accumulated = 0;
		let total = 0;
		const segmentLengths: number[] = [];
		for (let index = 1; index < snapshot.activePointIds.length; index += 1) {
			const left = routePoints.get(snapshot.activePointIds[index - 1]);
			const right = routePoints.get(snapshot.activePointIds[index]);
			const length = left && right ? new THREE.Vector3(...left.position).distanceTo(new THREE.Vector3(...right.position)) : 0;
			segmentLengths.push(length);
			total += length;
		}
		if (entity.simulationRoute.loop && snapshot.activePointIds.length > 1) {
			const last = routePoints.get(snapshot.activePointIds[snapshot.activePointIds.length - 1]);
			const first = routePoints.get(snapshot.activePointIds[0]);
			total += last && first ? new THREE.Vector3(...last.position).distanceTo(new THREE.Vector3(...first.position)) : 0;
		}
		if (total <= 0) return undefined;
		for (let index = 1; index < snapshot.activePointIds.length; index += 1) {
			accumulated += segmentLengths[index - 1] || 0;
			if (index <= pointIndex) continue;
			const candidate = routePoints.get(snapshot.activePointIds[index]);
			if (!candidate) continue;
			const offset = new THREE.Vector3(...candidate.position).sub(station).setY(0);
			const projection = offset.dot(forward);
			const lateral = offset.clone().addScaledVector(forward, -projection).length();
			if (projection < 1.5 || lateral > 0.35) continue;
			return {
				direction: forward,
				projection,
				routeDistance: accumulated / total * snapshot.lengthMeters,
			};
		}
		return undefined;
	}

	private advanceManualStationRelease(entity: RouteSlotEntity, deltaSeconds: number) {
		const state = entity.manualStationRelease;
		if (!state || !entity.simulationEngine) return;
		const stationRoot = this.getComponentRoot?.(state.componentObjectId);
		const pendingIds = this.stringArray(stationRoot?.userData?.stationPhysicalReleasePalletIds);
		const processType = String(stationRoot?.userData?.stationProcessType || '');
		const laneByPallet = stationRoot?.userData?.stationPalletLaneById && typeof stationRoot.userData.stationPalletLaneById === 'object'
			? stationRoot.userData.stationPalletLaneById as Record<string, string>
			: {};
		const sequenceByPallet = stationRoot?.userData?.stationPalletSequenceById && typeof stationRoot.userData.stationPalletSequenceById === 'object'
			? stationRoot.userData.stationPalletSequenceById as Record<string, number>
			: {};
		const orderedPendingIds = processType === 'robot-loading' && entity.physicalLane
			? pendingIds
				.filter((palletId) => laneByPallet[palletId] === entity.physicalLane)
				.sort((left, right) => Number(sequenceByPallet[left] || 0) - Number(sequenceByPallet[right] || 0))
			: pendingIds;
		// 逻辑 Release 可以按节拍提前完成，但同一条物理排只有最前方托盘
		// 能够移动。机器人 A/B 两排彼此独立并行，桁架 1×6 则保持全局顺序。
		// 这条约束避免多个托盘同时向同一个 Route handoff 点收敛后互相锁死。
		if (orderedPendingIds.length && orderedPendingIds[0] !== entity.palletId) {
			entity.root.userData.collisionHeld = true;
			return;
		}
		const speed = Math.max(0.25, Number(entity.simulationEngine.getSnapshot().speed || 1.2));
		const candidate = entity.root.position.clone().addScaledVector(state.direction, speed * Math.max(0, deltaSeconds));
		if (this.isPlasticPalletPositionClear(entity, candidate)) {
			entity.root.position.copy(candidate);
			delete entity.root.userData.collisionHeld;
		} else {
			entity.root.userData.collisionHeld = true;
		}
		const projection = entity.root.position.clone().sub(state.station).dot(state.direction);
		if (projection < state.handoffProjection) return;
		// 不能在整条闭环上按世界坐标找最近点：机器人回流段与装载段、合流段
		// 在平面上相邻甚至交叉，最近点可能落到路线尾端，导致托盘从装载工位
		// 瞬移到反向回流道并永久卡住。物理离站只允许沿当前工位的 releaseEdge
		// 前进，因此以进入工位时的路线距离加离站投影完成确定性交接。
		const previousRouteDistance = entity.simulationEngine.getSnapshot().distanceMeters;
		const previousPosition = entity.root.position.clone();
		entity.simulationEngine.correctDistance(state.routeDistanceAtHandoff ?? state.routeDistanceAtRelease + state.handoffProjection);
		entity.simulationEngine.render(1);
		this.applyTransportUnitYawOffset(entity);
		if (!this.isPlasticPalletPositionClear(entity, entity.root.position)) {
			// RouteEngine 的理想 handoff 点如果被前车占据，保持当前安全位置，
			// 不能用 candidate 覆盖碰撞保护，否则会把两托盘强行压进同一槽位。
			entity.simulationEngine.correctDistance(previousRouteDistance);
			entity.root.position.copy(previousPosition);
			return;
		}
		this.unregisterPhysicalStationRelease(entity, state.componentObjectId);
		entity.manualStationRelease = undefined;
		delete entity.root.userData.stationReleaseVisual;
		entity.root.userData.routeHandoffComplete = true;
		entity.root.userData.routeHandoffCompletePointId = state.pointId;
	}

	private unregisterPhysicalStationRelease(entity: RouteSlotEntity, componentObjectId?: string) {
		if (!componentObjectId) return;
		const root = this.getComponentRoot?.(componentObjectId);
		if (!root) return;
		const ids = Array.isArray(root.userData?.stationPhysicalReleasePalletIds)
			? root.userData.stationPhysicalReleasePalletIds.map(String).filter((id: string) => id !== entity.palletId)
			: [];
		root.userData.stationPhysicalReleasePalletIds = ids;
		// stationPalletIds 为空说明逻辑批次已经完整结束，此时 Release 标记只承担物理离站确认作用，
		// 当前托盘完成 handoff 后可以安全逐个清掉；批次尚未结束时必须保留，供逻辑 Release 计数使用。
		const activeBatchIds = Array.isArray(root.userData?.stationPalletIds) ? root.userData.stationPalletIds.map(String) : [];
		if (!activeBatchIds.length) {
			root.userData.stationReleasedPalletIds = Array.isArray(root.userData?.stationReleasedPalletIds)
				? root.userData.stationReleasedPalletIds.map(String).filter((id: string) => id !== entity.palletId)
				: [];
			if (!ids.length) {
				delete root.userData.stationPalletLaneById;
				delete root.userData.stationPalletSequenceById;
			}
		}
	}

	/**
	 * 非闭环运输单元完成整条 Route 后已经物理离开所有工位。
	 * 单托行为工位（例如木托码垛完成确认）不一定经过 manualStationRelease，
	 * 因而历史 released/waiting 标记可能残留到成品出库。这里只移除当前已完成
	 * 实体自己的成员关系，绝不清空同工位内其他仍在运行的托盘。
	 */
	private cleanupCompletedEntityStationMembership(entity: RouteSlotEntity) {
		if (!this.getComponentRoot) return;
		const palletId = entity.palletId;
		const arrayKeys = [
			'stationPalletIds',
			'stationWaitingPalletIds',
			'stationReadyToReleasePalletIds',
			'stationReleasedPalletIds',
			'stationPhysicalReleasePalletIds',
			'stationLastCompletedPalletIds',
		] as const;
		for (const object of this.manifest.objects || []) {
			if (object.kind !== 'component') continue;
			const root = this.getComponentRoot(object.objectId);
			if (!root) continue;
			for (const key of arrayKeys) {
				const ids = Array.isArray(root.userData?.[key]) ? root.userData[key].map(String) : [];
				if (ids.includes(palletId)) root.userData[key] = ids.filter((id: string) => id !== palletId);
			}
			if (String(root.userData?.stationPalletId || '') === palletId) delete root.userData.stationPalletId;
			for (const key of ['stationPalletLaneById', 'stationPalletSequenceById'] as const) {
				const map = root.userData?.[key];
				if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, palletId)) delete map[palletId];
			}
		}
	}

	private findNearestRouteDistance(engine: RouteEngine, worldPosition: THREE.Vector3) {
		const snapshot = engine.getSnapshot();
		if (snapshot.lengthMeters <= 0) return 0;
		const curve = engine.getCurve();
		let bestT = 0, bestDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index <= 512; index += 1) {
			const t = index / 512;
			const distance = curve.getPointAt(t).distanceToSquared(worldPosition);
			if (distance < bestDistance) { bestDistance = distance; bestT = t; }
		}
		return bestT * snapshot.lengthMeters;
	}

	private palletDiameter(entity: RouteSlotEntity) {
		const diameter = Number(entity.root.userData?.properties?.diameter || 1.48);
		return Number.isFinite(diameter) && diameter > 0 ? diameter : 1.48;
	}

	private isPlasticPalletPositionClear(entity: RouteSlotEntity, candidate: THREE.Vector3) {
		if (entity.transportUnitType !== 'plastic-pallet') return true;
		for (const other of this.entities.values()) {
			if (other === entity || other.transportUnitType !== 'plastic-pallet' || !other.root.visible) continue;
			// 物理碰撞边界按托盘真实外径计算，并保留 20mm 工程安全裕量；
			// 合流互锁由 tryResolveMergeConflict 负责仲裁，不能为了放行而降低
			// 产线上的最小安全中心距。
			const required = (this.palletDiameter(entity) + this.palletDiameter(other)) / 2 + 0.02;
			const dx = candidate.x - other.root.position.x, dz = candidate.z - other.root.position.z;
			if (dx * dx + dz * dz < required * required - 0.000001) {
				entity.root.userData.collisionBlockerPalletId = other.palletId;
				entity.root.userData.collisionBlockerEdgeId = other.simulationEngine?.getSnapshot().currentEdgeId;
				entity.root.userData.collisionBlockerPosition = other.root.position.toArray();
				entity.root.userData.collisionCandidatePosition = candidate.toArray();
				entity.root.userData.collisionRequiredDistance = required;
				return false;
			}
		}
		return true;
	}

	private tryResolveMergeConflict(entity: RouteSlotEntity, candidateSnapshot: ReturnType<RouteEngine['getSnapshot']>, previousEdgeId?: string) {
		if (!entity.simulationEngine || entity.transportUnitType !== 'plastic-pallet') return false;
		const incoming = entity.simulationRoute?.edges.find((edge) => edge.edgeId === previousEdgeId)
			|| entity.simulationRoute?.edges.find((edge) => edge.edgeId === candidateSnapshot.currentEdgeId);
		if (!incoming?.toPointId) return false;
		const relationships = [...this.entities.values()].map((other) => {
			if (other === entity || other.transportUnitType !== 'plastic-pallet' || !other.root.visible || !other.simulationEngine) return false;
			const otherSnapshot = other.simulationEngine.getSnapshot();
			const otherIncoming = other.simulationRoute?.edges.find((edge) => edge.edgeId === otherSnapshot.currentEdgeId);
			if (!otherIncoming || otherIncoming.edgeId === incoming.edgeId) return false;
			const sharedPointId = incoming.toPointId === otherIncoming.fromPointId || incoming.toPointId === otherIncoming.toPointId
				? incoming.toPointId
				: incoming.fromPointId === otherIncoming.toPointId ? incoming.fromPointId : undefined;
			if (!sharedPointId) return false;
			const sharedPoint = entity.simulationRoute?.points.find((point) => point.pointId === sharedPointId);
			if (!sharedPoint) return false;
			const junction = new THREE.Vector3(...sharedPoint.position);
			if (entity.root.position.distanceTo(junction) > 2.25 || other.root.position.distanceTo(junction) > 2.25) return false;
			const required = (this.palletDiameter(entity) + this.palletDiameter(other)) / 2 + 0.02;
		if (entity.root.position.distanceTo(other.root.position) >= required + 0.06) return false;
		return { other, edge: otherIncoming, sharedPointId, currentIsOutgoing: incoming.fromPointId === sharedPointId, otherIsOutgoing: otherIncoming.fromPointId === sharedPointId };
		}).filter((item): item is { other: RouteSlotEntity; edge: TwinRouteEdgeDefinition; sharedPointId: string; currentIsOutgoing: boolean; otherIsOutgoing: boolean } => Boolean(item));
		if (!relationships.length) return this.tryResolveGeometricCrossingConflict(entity, incoming);
		const winner = relationships.every((item) => (item.currentIsOutgoing && !item.otherIsOutgoing) || (!item.currentIsOutgoing && !item.otherIsOutgoing && this.compareMergePriority(entity, item.other) < 0));
		if (!winner) return false;

		let changed = false;
		for (const relationship of relationships) {
			// 已在合流点下游的实体优先清空共享区；只把仍在入边上的实体退回上游。
			if (relationship.otherIsOutgoing) continue;
			// A merge blocker must clear the full pallet envelope, not merely move a
			// few centimetres.  With the 1.50m hard safety distance, a 0.22m nudge
			// lets the branch pallet re-enter the junction before the main-line
			// pallet has passed, producing an oscillating collision hold.  Move the
			// whole branch queue upstream by at least half a pallet diameter and keep
			// it yielded long enough for the winner to clear the junction.
			const backoff = Math.min(1.2, Math.max(0.75, Number(relationship.other.simulationEngine!.getSnapshot().speed || 1.2) * 0.5));
			// 合流前通常是整列托盘等距排队；只退第一托会被后车再次顶住，
			// 必须把同一入边上的队列按尾到头整体后移，保留托盘间距。
			changed = this.backoffMergeQueue(relationship.other, relationship.sharedPointId, backoff) || changed;
		}
		if (changed && this.isPlasticPalletPositionClear(entity, entity.root.position)) return true;
		return this.tryResolveGeometricCrossingConflict(entity, incoming);
	}

	/**
	 * 图纸中的上下行辊道与纵向回路存在同平面几何交叉，但不一定共享 Route point。
	 * 这种交叉不能靠“穿过去”处理：稳定优先级较高的托盘预占交叉区，另一条
	 * 当前物理段上的整列托盘保持间距后退，让出完整托盘包络后再继续。
	 */
	private tryResolveGeometricCrossingConflict(entity: RouteSlotEntity, incoming: TwinRouteEdgeDefinition) {
		const blockers = [...this.entities.values()].filter((other) => {
			if (other === entity || other.transportUnitType !== 'plastic-pallet' || !other.root.visible || !other.simulationEngine || other.manualStationRelease) return false;
			if (other.root.userData.stationBatchVisual || other.root.userData.stationQueueVisual || other.root.userData.stationReleaseVisual) return false;
			const otherSnapshot = other.simulationEngine.getSnapshot();
			const otherEdge = other.simulationRoute?.edges.find((edge) => edge.edgeId === otherSnapshot.currentEdgeId);
			if (!otherEdge || otherEdge.edgeId === incoming.edgeId) return false;
			const required = (this.palletDiameter(entity) + this.palletDiameter(other)) / 2 + 0.02;
			return entity.root.position.distanceTo(other.root.position) < required - 0.000001;
		});
		if (!blockers.length || blockers.some((other) => this.compareGeometricConflictPriority(entity, other) >= 0)) return false;
		let changed = false;
		for (const blocker of blockers) {
			// Preserve the historical queue retreat first.  Only an actual failed
			// retreat on physically opposing edges is allowed to use the small-step
			// deadlock breaker; this keeps normal merge/gantry batching unchanged.
			const regularBackoff = this.backoffCurrentEdgeQueue(blocker, 1.0);
			const fallbackBackoff = !regularBackoff && this.areCurrentEdgesOpposing(entity, blocker)
				? this.backoffOpposingEdgeQueue(blocker, 1.0)
				: false;
			changed = regularBackoff || fallbackBackoff || changed;
		}
		return changed && this.isPlasticPalletPositionClear(entity, entity.root.position);
	}

	/**
	 * Geometric conflicts may happen between two different edges that belong to
	 * the same closed physical lane.  In that case pallet id is not a meaningful
	 * right-of-way rule: the pallet already farther downstream must clear the
	 * shared physical envelope first, otherwise two opposite/overlapping edges
	 * can hold each other forever.  Cross-lane conflicts keep the existing A/B
	 * priority semantics.
	 *
	 * Negative means left has the higher priority, matching compareMergePriority.
	 */
	private compareGeometricConflictPriority(left: RouteSlotEntity, right: RouteSlotEntity) {
		const leftEdgeId = left.simulationEngine?.getSnapshot().currentEdgeId;
		const rightEdgeId = right.simulationEngine?.getSnapshot().currentEdgeId;
		const leftEdge = left.simulationRoute?.edges.find((edge) => edge.edgeId === leftEdgeId);
		const rightEdge = right.simulationRoute?.edges.find((edge) => edge.edgeId === rightEdgeId);
		// Directly connected physical edges are not an A/B merge decision anymore:
		// the pallet already on the downstream edge must clear the shared envelope
		// before an upstream pallet advances.  Historical lane origin must not make
		// the upstream pallet win and create a mutual hold across the edge boundary.
		if (leftEdge && rightEdge) {
			if (leftEdge.fromPointId === rightEdge.toPointId) return -1;
			if (rightEdge.fromPointId === leftEdge.toPointId) return 1;
		}
		if (left.routeId === right.routeId
			&& left.physicalLane === right.physicalLane
			&& this.areCurrentEdgesOpposing(left, right)
			&& left.simulationEngine
			&& right.simulationEngine) {
			const leftDistance = left.simulationEngine.getSnapshot().distanceMeters;
			const rightDistance = right.simulationEngine.getSnapshot().distanceMeters;
			if (Math.abs(leftDistance - rightDistance) > 0.0001) return rightDistance - leftDistance;
		}
		return this.compareMergePriority(left, right);
	}

	private areCurrentEdgesOpposing(left: RouteSlotEntity, right: RouteSlotEntity) {
		const resolveDirection = (entity: RouteSlotEntity) => {
			const edgeId = entity.simulationEngine?.getSnapshot().currentEdgeId;
			const edge = entity.simulationRoute?.edges.find((item) => item.edgeId === edgeId);
			const from = edge && entity.simulationRoute?.points.find((point) => point.pointId === edge.fromPointId);
			const to = edge && entity.simulationRoute?.points.find((point) => point.pointId === edge.toPointId);
			if (!from || !to) return undefined;
			const direction = new THREE.Vector3(...to.position).sub(new THREE.Vector3(...from.position)).setY(0);
			return direction.lengthSq() > 0.000001 ? direction.normalize() : undefined;
		};
		const leftDirection = resolveDirection(left), rightDirection = resolveDirection(right);
		return Boolean(leftDirection && rightDirection && leftDirection.dot(rightDirection) < -0.25);
	}

	private backoffStationApproachQueue(blocker: RouteSlotEntity, stationEntity: RouteSlotEntity) {
		if (!blocker.simulationEngine || blocker.routeId !== stationEntity.routeId) return false;
		const blockerEdgeId = blocker.simulationEngine.getSnapshot().currentEdgeId;
		if (!blockerEdgeId) return false;
		const blockerDistance = blocker.simulationEngine.getSnapshot().distanceMeters;
		const lane = blocker.physicalLane;
		const queue = [...this.entities.values()]
			.filter((item) => item.transportUnitType === 'plastic-pallet' && item.root.visible && Boolean(item.simulationEngine))
			.filter((item) => item.routeId === blocker.routeId && item.physicalLane === lane)
			// A closed physical lane traverses multiple neighboring/crossing Route edges.
			// Only the queue on the blocker's current physical edge may be backed off;
			// otherwise the 20m route-distance window repeatedly drags unrelated downstream
			// pallets backwards and starves the next loading/gantry batch. correctDistance
			// can still move this local queue across the edge start into its immediate
			// upstream safe zone, so the >=1.50m physical envelope remains unchanged.
			.filter((item) => item.simulationEngine!.getSnapshot().currentEdgeId === blockerEdgeId)
			.filter((item) => !item.manualStationRelease && !item.root.userData.stationBatchVisual && !item.root.userData.stationQueueVisual && !item.root.userData.stationReleaseVisual)
			.filter((item) => {
				const distance = item.simulationEngine!.getSnapshot().distanceMeters;
				return distance <= blockerDistance + 0.0001 && blockerDistance - distance <= 20;
			});
		if (!queue.length) return false;

		const saved = queue.map((item) => ({ item, distance: item.simulationEngine!.getSnapshot().distanceMeters, position: item.root.position.clone() }));
		for (let attempt = 1; attempt <= 30; attempt += 1) {
			const backoff = attempt * 0.4;
			for (const state of saved) {
				state.item.simulationEngine!.correctDistance(state.distance - backoff);
				state.item.simulationEngine!.render(1);
				this.applyTransportUnitYawOffset(state.item);
			}
			const valid = saved.every(({ item }) => this.isPlasticPalletPositionClear(item, item.root.position));
			if (valid) {
				for (const { item } of saved) {
					item.root.userData.collisionHeld = true;
					item.root.userData.mergeYieldSeconds = Math.max(Number(item.root.userData.mergeYieldSeconds || 0), 0.8);
				}
				return true;
			}
		}

		for (const state of saved) {
			state.item.simulationEngine!.correctDistance(state.distance);
			state.item.root.position.copy(state.position);
		}
		return false;
	}

	private backoffCurrentEdgeQueue(blocker: RouteSlotEntity, backoff: number) {
		const edgeId = blocker.simulationEngine?.getSnapshot().currentEdgeId;
		if (!edgeId) return false;
		const queue = [...this.entities.values()]
			.filter((item) => item.transportUnitType === 'plastic-pallet' && item.root.visible && Boolean(item.simulationEngine))
			.filter((item) => item.simulationEngine!.getSnapshot().currentEdgeId === edgeId)
			.filter((item) => !item.manualStationRelease && !item.root.userData.stationBatchVisual && !item.root.userData.stationQueueVisual && !item.root.userData.stationReleaseVisual);
		if (!queue.length) return false;
		const saved = queue.map((item) => ({ item, distance: item.simulationEngine!.getSnapshot().distanceMeters, position: item.root.position.clone() }));
		for (const state of saved) {
			state.item.simulationEngine!.correctDistance(state.distance - Math.max(0.2, backoff));
			state.item.simulationEngine!.render(1);
			this.applyTransportUnitYawOffset(state.item);
		}
		const valid = saved.every(({ item }) => this.isPlasticPalletPositionClear(item, item.root.position));
		if (!valid) {
			for (const state of saved) {
				state.item.simulationEngine!.correctDistance(state.distance);
				state.item.root.position.copy(state.position);
			}
			return false;
		}
		for (const { item } of saved) {
			item.root.userData.collisionHeld = true;
			item.root.userData.mergeYieldSeconds = Math.max(Number(item.root.userData.mergeYieldSeconds || 0), 1.2);
		}
		return true;
	}

	private backoffOpposingEdgeQueue(blocker: RouteSlotEntity, backoff: number) {
		const blockerSnapshot = blocker.simulationEngine?.getSnapshot();
		if (!blockerSnapshot) return false;
		const blockerEdgeId = blockerSnapshot.currentEdgeId;
		if (!blockerEdgeId) return false;
		const blockerEdgeIndex = blockerSnapshot.activeEdgeIds.indexOf(blockerEdgeId);
		if (blockerEdgeIndex < 0) return false;
		const upstreamPathEdgeIds = new Set(blockerSnapshot.activeEdgeIds.slice(0, blockerEdgeIndex + 1));
		const queue = [...this.entities.values()]
			.filter((item) => item.transportUnitType === 'plastic-pallet' && item.root.visible && Boolean(item.simulationEngine))
			.filter((item) => item.routeId === blocker.routeId)
			.filter((item) => !item.manualStationRelease && !item.root.userData.stationBatchVisual && !item.root.userData.stationQueueVisual && !item.root.userData.stationReleaseVisual)
			// An opposing-edge deadlock can span an edge boundary: retreating only the
			// blocker's current edge makes its tail collide with the first pallet on
			// the immediately-upstream edge. Route distance is branch-specific on the
			// closed A/B loop, so it cannot safely decide which pallets physically trail
			// the blocker after branches have merged. Follow the blocker's actual active
			// edge path instead and move that local physical train atomically, preserving
			// the existing >=1.50m gaps.
			.filter((item) => {
				const itemEdgeId = item.simulationEngine!.getSnapshot().currentEdgeId;
				return Boolean(itemEdgeId)
					&& upstreamPathEdgeIds.has(itemEdgeId!)
					&& item.root.position.distanceTo(blocker.root.position) <= 20;
			});
		if (!queue.length) return false;
		const saved = queue.map((item) => ({ item, distance: item.simulationEngine!.getSnapshot().distanceMeters, position: item.root.position.clone() }));
		// Geometric deadlocks often need only a few centimetres of clearance.
		// Jumping the whole edge queue back by 1m can make its tail collide with
		// the immediately upstream edge and roll the entire arbitration back.
		// Search from a small displacement upward and keep the first position that
		// still satisfies the unchanged global pallet envelope.
		const maxBackoff = Math.max(0.04, backoff);
		const attempts: number[] = [];
		for (let candidate = 0.04; candidate < maxBackoff - 0.0001; candidate += 0.04) attempts.push(candidate);
		attempts.push(maxBackoff);
		for (const candidateBackoff of attempts) {
			for (const state of saved) {
				state.item.simulationEngine!.correctDistance(state.distance - candidateBackoff);
				state.item.simulationEngine!.render(1);
				this.applyTransportUnitYawOffset(state.item);
			}
			const valid = saved.every(({ item }) => this.isPlasticPalletPositionClear(item, item.root.position));
			if (valid) {
				for (const { item } of saved) {
					item.root.userData.collisionHeld = true;
					item.root.userData.mergeYieldSeconds = Math.max(Number(item.root.userData.mergeYieldSeconds || 0), 1.2);
				}
				return true;
			}
		}
		for (const state of saved) {
			state.item.simulationEngine!.correctDistance(state.distance);
			state.item.root.position.copy(state.position);
		}
		return false;
	}

	/** 同一物理 Edge 必须按下游到上游更新，否则 10 Hz 长跑时会形成整列互等。 */
	private orderedEntitiesForMovement() {
		return [...this.entities.values()].sort((left, right) => {
			if (!left.simulationEngine || !right.simulationEngine) return left.simulationEngine ? -1 : right.simulationEngine ? 1 : left.key.localeCompare(right.key);
			const leftSnapshot = left.simulationEngine.getSnapshot();
			const rightSnapshot = right.simulationEngine.getSnapshot();
			if (leftSnapshot.currentEdgeId && leftSnapshot.currentEdgeId === rightSnapshot.currentEdgeId) {
				return this.edgeLocalProgress(right) - this.edgeLocalProgress(left) || left.palletId.localeCompare(right.palletId);
			}
			return rightSnapshot.distanceMeters - leftSnapshot.distanceMeters || left.palletId.localeCompare(right.palletId);
		});
	}

	private edgeLocalProgress(entity: RouteSlotEntity) {
		const edgeId = entity.simulationEngine?.getSnapshot().currentEdgeId;
		const edge = entity.simulationRoute?.edges.find((item) => item.edgeId === edgeId);
		const from = edge && entity.simulationRoute?.points.find((point) => point.pointId === edge.fromPointId);
		const to = edge && entity.simulationRoute?.points.find((point) => point.pointId === edge.toPointId);
		if (!from || !to) return entity.simulationEngine?.getSnapshot().distanceMeters || 0;
		const start = new THREE.Vector3(...from.position), direction = new THREE.Vector3(...to.position).sub(start).setY(0);
		const lengthSquared = direction.lengthSq();
		return lengthSquared > 0.000001 ? entity.root.position.clone().sub(start).setY(0).dot(direction) / lengthSquared : 0;
	}

	private compareMergePriority(left: RouteSlotEntity, right: RouteSlotEntity) {
		// 物理布局将 A 排作为主线、B 排作为支线；合流只在一个方向上放行，
		// 再以稳定托盘 ID 做同排内排序，保证同一输入序列可重放。
		const laneOrder = (lane?: 'A' | 'B') => lane === 'A' ? 0 : lane === 'B' ? 1 : 2;
		return laneOrder(left.physicalLane) - laneOrder(right.physicalLane) || left.palletId.localeCompare(right.palletId);
	}

	private backoffMergeQueue(blocker: RouteSlotEntity, sharedPointId: string, backoff: number) {
		const sharedPoint = blocker.simulationRoute?.points.find((point) => point.pointId === sharedPointId);
		const blockerSnapshot = blocker.simulationEngine?.getSnapshot();
		if (!sharedPoint || !blockerSnapshot) return false;
		const junction = new THREE.Vector3(...sharedPoint.position);
		const blockerEdgeIndex = blockerSnapshot.activeEdgeIds.indexOf(blockerSnapshot.currentEdgeId || '');
		const upstreamPathEdgeIds = new Set(blockerEdgeIndex >= 0
			? blockerSnapshot.activeEdgeIds.slice(0, blockerEdgeIndex + 1)
			: [blockerSnapshot.currentEdgeId].filter(Boolean) as string[]);
		const queue = [...this.entities.values()]
			.filter((item) => item.transportUnitType === 'plastic-pallet' && item.root.visible && item.simulationEngine)
			.filter((item) => item.routeId === blocker.routeId)
			.filter((item) => !item.root.userData.stationBatchVisual && !item.root.userData.stationQueueVisual && !item.root.userData.stationReleaseVisual)
			.filter((item) => item.root.position.distanceTo(junction) < 12)
			.filter((item) => {
				const currentEdgeId = item.simulationEngine!.getSnapshot().currentEdgeId;
				const edge = item.simulationRoute?.edges.find((candidate) => candidate.edgeId === currentEdgeId);
				// 合流点下游实体不能后退；其余同一物理排的近端队列都要一起让行。
				// A/B 是历史来源标签；一旦两排已经进入同一物理 Edge，就必须按
				// blocker 的真实 active path 组成一列退让，不能再按 physicalLane 拆开。
				return Boolean(edge) && upstreamPathEdgeIds.has(currentEdgeId || '') && edge!.fromPointId !== sharedPointId;
			})
			.sort((left, right) => right.root.position.distanceTo(junction) - left.root.position.distanceTo(junction));
		if (!queue.length) return false;
		// This is a coordinated queue retreat.  Validating each pallet immediately
		// after moving it checks against followers that have not moved yet and can
		// falsely reject an otherwise safe retreat.  Move the whole queue first so
		// the existing spacing is preserved, then validate the final physical state
		// atomically with the unchanged global collision envelope.
		const saved = queue.map((item) => ({
			item,
			distance: item.simulationEngine!.getSnapshot().distanceMeters,
			position: item.root.position.clone(),
		}));
		for (const state of saved) {
			state.item.simulationEngine!.correctDistance(Math.max(0, state.distance - backoff));
			state.item.simulationEngine!.render(1);
			this.applyTransportUnitYawOffset(state.item);
		}
		const valid = saved.every(({ item }) => this.isPlasticPalletPositionClear(item, item.root.position));
		if (!valid) {
			for (const state of saved) {
				state.item.simulationEngine!.correctDistance(state.distance);
				state.item.root.position.copy(state.position);
			}
			return false;
		}
		for (const { item } of saved) {
			item.root.userData.collisionHeld = true;
			item.root.userData.mergeYieldSeconds = Math.max(Number(item.root.userData.mergeYieldSeconds || 0), 2.2);
		}
		return true;
	}

	private applyStationQueueVisual(entity: RouteSlotEntity, stationDistance: number, routeLength: number) {
		if (!entity.simulationEngine || routeLength <= 0 || entity.manualStationRelease) return;
		const route = entity.simulationRoute || this.curves.get(entity.routeId)?.route;
		if (!route) return;
		delete entity.root.userData.stationBatchVisual;
		delete entity.root.userData.stationQueueVisual;
		let queueIndex = -1;
		for (const point of route.points || []) {
			if (point.kind !== 'processStation' || !point.componentObjectId) continue;
			if (point.process?.physicalLane && entity.physicalLane && point.process.physicalLane !== entity.physicalLane) continue;
			const root = this.getComponentRoot?.(point.componentObjectId);
			if (!root) continue;
			const activeIds = Array.isArray(root.userData?.stationPalletIds) ? root.userData.stationPalletIds.map(String) : [];
			const waitingIds = Array.isArray(root.userData?.stationWaitingPalletIds) ? root.userData.stationWaitingPalletIds.map(String) : [];
			const releasedIds = Array.isArray(root.userData?.stationReleasedPalletIds) ? root.userData.stationReleasedPalletIds.map(String) : [];
			const activeIndex = activeIds.indexOf(entity.palletId);
			const waitingIndex = waitingIds.indexOf(entity.palletId);
			const released = releasedIds.includes(entity.palletId);
			if (!released && (activeIndex >= 0 || waitingIndex >= 0) && entity.root.userData.routeHandoffCompletePointId === point.pointId) {
				delete entity.root.userData.routeHandoffComplete;
				delete entity.root.userData.routeHandoffCompletePointId;
			}
			if (released) return;
			if ((activeIndex >= 0 || waitingIndex >= 0) && point.process?.batchLayout && entity.physicalLane) {
				if (point.process.type === 'gantry-stacking') this.applyStationBatchSlot(entity, point, activeIndex >= 0 ? activeIndex : waitingIndex);
				else this.applyPhysicalBatchSlot(entity, point);
				entity.root.userData.stationBatchVisual = true;
				entity.root.userData.stationQueueIndex = activeIndex >= 0 ? activeIndex : waitingIndex;
				return;
			}
			if (waitingIndex >= 0 && activeIndex < 0) {
				this.applyLinearBatchQueueSlot(entity, route, point, waitingIndex);
				return;
			}
			queueIndex = activeIndex >= 0 ? activeIndex : waitingIndex;
			if (queueIndex >= 0) {
				this.applyLinearBatchQueueSlot(entity, route, point, queueIndex);
				return;
			}
		}
		if (queueIndex <= 0) return;
	}

	private applyLinearBatchQueueSlot(entity: RouteSlotEntity, route: TwinRouteDefinition, point: TwinRouteDefinition['points'][number], queueIndex: number) {
		if (!entity.simulationEngine || queueIndex < 0) return;
		const activeEdgeIds = new Set(entity.simulationEngine.getSnapshot().activeEdgeIds || []);
		const incoming = route.edges.find((edge) => edge.enabled !== false && edge.toPointId === point.pointId && activeEdgeIds.has(edge.edgeId))
			|| route.edges.find((edge) => edge.enabled !== false && edge.toPointId === point.pointId);
		const source = incoming ? route.points.find((candidate) => candidate.pointId === incoming.fromPointId) : undefined;
		if (!source) return;
		const station = new THREE.Vector3(...point.position);
		const upstream = new THREE.Vector3(...source.position).sub(station).setY(0);
		if (upstream.lengthSq() < 0.000001) return;
		upstream.normalize();
		const spacing = Math.max(1.55, Number(point.process?.batchLayout?.columnSpacingMeters || 1.55));
		const position = station.clone().addScaledVector(upstream, queueIndex * spacing);
		const cacheKey = `${entity.routeId}:${entity.routeCode || entity.physicalLane || ''}:${point.pointId}:${queueIndex}`;
		let correctedDistance = this.linearQueueDistanceCache.get(cacheKey);
		if (correctedDistance === undefined) {
			correctedDistance = this.findNearestRouteDistance(entity.simulationEngine, position);
			this.linearQueueDistanceCache.set(cacheKey, correctedDistance);
		}
		entity.simulationEngine.correctDistance(correctedDistance);
		entity.root.position.copy(position);
		if (route.orientToPath !== false) entity.root.lookAt(position.clone().sub(upstream));
		entity.root.userData.stationQueueIndex = queueIndex;
		entity.root.userData.stationQueueVisual = true;
	}

	private getBehaviorRequirements(objectId: string) {
		const requirements: Record<string, number> = {};
		for (const behavior of this.manifest.behaviors || []) {
			if (behavior.enabled === false || behavior.actorObjectId !== objectId) continue;
			const group = behavior.stationCompletionGroup?.trim();
			if (!group) continue;
			requirements[group] = Math.max(requirements[group] || 0, Math.max(1, Math.floor(Number(behavior.stationRequiredCycles) || 1)));
		}
		return requirements;
	}

	setRunning(running: boolean) {
		this.running = Boolean(running) && this.manifest.runtime.dataMode === 'simulation';
		for (const entity of this.entities.values()) {
			if (!entity.simulationEngine) continue;
			entity.simulationEngine.setRunning(this.running);
			entity.simulationProcess?.setRunning(this.running);
		}
		if (this.running) this.ensureSimulationAutoFeed();
	}

	private ensureSimulationAutoFeed() {
		if (this.manifest.runtime.dataMode !== 'simulation') return;
		for (const initializer of this.manifest.runtime.routePalletInitializers || []) {
			if (initializer.simulationAutoFeed !== true) continue;
			const route = this.manifest.routes.find((item) => item.routeId === initializer.routeId);
			if (!route || !this.curves.has(route.routeId)) continue;
			const bindingId = this.simulationBindingId(route.routeId);
			const routeEntities = [...this.entities.values()].filter((entity) => entity.bindingId === bindingId && entity.simulationEngine);
			const activeCount = routeEntities.filter((entity) => entity.root.userData.routeCompleted !== true).length;
			const maxActive = Math.max(1, Math.floor(Number(initializer.simulationAutoFeedMaxActive) || 1));
			if (activeCount >= maxActive) continue;
			const sequence = (this.simulationAutoFeedSequences.get(route.routeId) || routeEntities.length) + 1;
			this.simulationAutoFeedSequences.set(route.routeId, sequence);
			const palletId = `SIM-AUTO-${route.routeId}-${String(sequence).padStart(4, '0')}`;
			const binding: TwinObjectBindingDefinition = {
				bindingId, objectId: `simulation:${route.routeId}`,
				source: { kind: 'telemetry', key: initializer.telemetryKey },
				target: { kind: 'customProperty', property: `routeSlots:${route.routeId}` },
				transform: { kind: 'routeSlotArray', routeId: route.routeId, emptyValue: initializer.emptyValue ?? 0 },
				staleAfterMs: 0,
			};
			this.bindingRouteIds.set(bindingId, route.routeId);
			this.apply(binding, [...routeEntities.map((entity) => entity.palletId), palletId], false);
		}
	}

	reset() {
		this.running = false;
		for (const entity of this.entities.values()) {
			if (!entity.simulationEngine) continue;
			entity.simulationProcess?.reset();
			entity.simulationEngine.reset();
			entity.simulationEngine.setRoutingContext({
				dataMode: 'simulation',
				payload: { routeCode: entity.routeCode || 'A', physicalLane: entity.physicalLane, palletId: entity.palletId, weightSequence: entity.slotIndex },
				bindingValues: {}, edgeOccupancy: {}, staleBindingIds: [],
			});
			const snapshot = entity.simulationEngine.getSnapshot();
			const initialProgress = THREE.MathUtils.clamp(Number(entity.initialProgress) || 0, 0, 1);
			entity.simulationEngine.correctDistance(initialProgress * snapshot.lengthMeters);
			entity.simulationEngine.render(1);
			this.applyTransportUnitYawOffset(entity);
			entity.currentProgress = initialProgress;
			entity.targetProgress = initialProgress;
			entity.root.userData.routeProgress = initialProgress;
			entity.root.userData.routeState = 'paused';
			delete entity.root.userData.activeProcessComponentObjectId;
		}
	}

	getDiagnostics() {
		const simulationEntities = [...this.entities.values()].filter((entity) => Boolean(entity.simulationEngine));
		const plastic = simulationEntities.filter((entity) => entity.transportUnitType === 'plastic-pallet');
		const wooden = simulationEntities.filter((entity) => entity.transportUnitType === 'wooden-pallet');
		const uniquePositions = (items) => new Set(items.map((entity) => [entity.root.position.x, entity.root.position.y, entity.root.position.z].map((value) => value.toFixed(3)).join(','))).size;
		return {
			total: simulationEntities.length,
			visible: simulationEntities.filter((entity) => entity.root.visible).length,
			uniquePositions: uniquePositions(simulationEntities),
			plasticPallets: plastic.length,
			visiblePlasticPallets: plastic.filter((entity) => entity.root.visible).length,
			uniquePlasticPositions: uniquePositions(plastic),
			woodenPallets: wooden.length,
		};
	}

	getTransportUnitBounds(transportUnitType: TwinTransportUnitType) {
		const box = new THREE.Box3();
		let found = false;
		for (const entity of this.entities.values()) {
			if (!entity.simulationEngine || entity.transportUnitType !== transportUnitType || !entity.root.visible) continue;
			box.union(new THREE.Box3().setFromObject(entity.root));
			found = true;
		}
		return found && !box.isEmpty() ? box : undefined;
	}

	getSimulationSnapshot() {
		return [...this.entities.values()]
			.filter((entity) => Boolean(entity.simulationEngine))
			.map((entity) => ({
				palletId: entity.palletId,
				routeId: entity.routeId,
				routeCode: entity.routeCode,
				physicalLane: entity.physicalLane,
				physicalLaneOrdinal: entity.physicalLaneOrdinal,
				progress: entity.simulationEngine!.getSnapshot().progress,
				state: entity.simulationEngine!.getSnapshot().state,
				activeEdgeIds: entity.simulationEngine!.getSnapshot().activeEdgeIds,
				currentEdgeId: entity.simulationEngine!.getSnapshot().currentEdgeId,
				position: entity.root.position.toArray() as [number, number, number],
				activeProcessComponentObjectId: entity.simulationProcess?.getSnapshot().activeComponentObjectId,
			}));
	}

	getEntityDetail(entityType: string, entityId: string): Record<string, unknown> | undefined {
		if (entityType !== 'route-slot-pallet') return undefined;
		const entity = [...this.entities.values()].find((item) => item.palletId === entityId);
		return entity ? {
			palletId: entity.palletId,
			routeId: entity.routeId,
			slotIndex: entity.slotIndex,
			slotNumber: entity.slotIndex + 1,
			slotCount: entity.slotCount,
			progress: entity.targetProgress,
			bindingId: entity.bindingId,
			transportUnitType: entity.transportUnitType,
			resourceKey: entity.resourceKey,
		} : undefined;
	}

	dispose() {
		this.running = false;
		for (const key of [...this.entities.keys()]) this.removeEntity(key);
		this.scene.remove(this.group);
		this.curves.clear();
		this.bindingRouteIds.clear();
	}

	private resolveRouteId(binding: TwinObjectBindingDefinition) {
		const config = binding.transform as Record<string, unknown>;
		const configured = String(config.routeId || '').trim();
		if (configured) return configured;
		const target = String(binding.target.path || binding.target.property || '').trim();
		return target.startsWith('routeSlots:') ? target.slice('routeSlots:'.length) : '';
	}

	private stringArray(value: unknown) {
		return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
	}

	private createCurve(route: TwinRouteDefinition): RouteCurveInfo | undefined {
		const vectors = (route.points || []).map((point) => new THREE.Vector3(point.position[0], point.position[1], point.position[2]));
		if (vectors.length < 2) return undefined;
		const loop = route.loop === true;
		let curve: THREE.Curve<THREE.Vector3>;
		if (route.curveKind === 'line' || vectors.length === 2) {
			const path = new THREE.CurvePath<THREE.Vector3>();
			for (let index = 1; index < vectors.length; index += 1) path.add(new THREE.LineCurve3(vectors[index - 1], vectors[index]));
			if (loop && vectors.length > 2) path.add(new THREE.LineCurve3(vectors[vectors.length - 1], vectors[0]));
			curve = path;
		} else {
			curve = new THREE.CatmullRomCurve3(vectors, loop, 'centripetal', 0.5);
		}
		return { route, curve, loop };
	}

	private resolveTransportUnitType(route: TwinRouteDefinition): TwinTransportUnitType {
		const explicit = route.edges.find((edge) => edge.enabled !== false && edge.transportUnitType)?.transportUnitType;
		if (explicit) return explicit;
		return route.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'large')
			? 'wooden-pallet'
			: 'plastic-pallet';
	}

	private resolveTransportUnitResourceKey(route: TwinRouteDefinition, transportUnitType: TwinTransportUnitType) {
		const explicit = route.edges.find((edge) => edge.enabled !== false && edge.transportUnitResourceKey)?.transportUnitResourceKey;
		if (explicit) return explicit;
		if (transportUnitType === 'carton') return 'builtin-carton';
		if (transportUnitType === 'wooden-pallet') return 'builtin-wooden-pallet';
		return 'builtin-plastic-pallet';
	}

	private createTransportUnitMesh(bindingId: string, palletId: string, transportUnitType: TwinTransportUnitType, resourceKey: string) {
		const displayName = transportUnitType === 'carton'
			? `PLC 纸箱 ${palletId}`
			: transportUnitType === 'wooden-pallet'
				? `PLC 木托盘 ${palletId}`
				: `PLC 小托盘 ${palletId}`;
		const definition = createComponentDefinitionFromTemplate(resourceKey, {
			objectId: `route-slot:${bindingId}:${palletId}`,
			name: displayName,
		});
		const built = defaultComponentRegistry.create(definition);
		const root = built.root;
		root.name = displayName;
		// 这是运行时物流实体，不是 Manifest 中的场景对象；选择时必须以实体身份为准。
		delete root.userData.twinObjectId;
		root.userData.twinEntityType = 'route-slot-pallet';
		root.userData.twinEntityId = palletId;
		root.userData.bindingId = bindingId;
		root.userData.transportUnitType = transportUnitType;
		root.userData.runtimeTransportUnit = true;
		root.userData.componentResourceKey = resourceKey;

		const label = this.createLabelSprite(palletId);
		if (label) root.add(label);
		return root;
	}

	private createLabelSprite(text: string) {
		if (typeof document === 'undefined') return undefined;
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 80;
		const context = canvas.getContext('2d');
		if (!context) return undefined;
		context.fillStyle = 'rgba(7,17,31,0.88)';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.strokeStyle = '#fbbf24';
		context.lineWidth = 4;
		context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
		context.fillStyle = '#fef3c7';
		context.font = 'bold 38px sans-serif';
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(text, canvas.width / 2, canvas.height / 2);
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
		const sprite = new THREE.Sprite(material);
		sprite.name = `托盘编号 ${text}`;
		sprite.position.set(0, 0.8, 0);
		sprite.scale.set(1.5, 0.48, 1);
		sprite.userData.twinEntityType = 'route-slot-pallet';
		sprite.userData.twinEntityId = text;
		return sprite;
	}

	private applyPose(entity: RouteSlotEntity, curveInfo: RouteCurveInfo, progress: number) {
		const normalized = curveInfo.loop ? ((progress % 1) + 1) % 1 : THREE.MathUtils.clamp(progress, 0, 1);
		const position = curveInfo.curve.getPointAt(normalized);
		entity.root.position.copy(position);
		if (curveInfo.route.orientToPath !== false) {
			const tangent = curveInfo.curve.getTangentAt(normalized);
			if (tangent.lengthSq() > 0.000001) entity.root.lookAt(position.clone().add(tangent));
		}
		this.applyTransportUnitYawOffset(entity);
	}

	private applyTransportUnitYawOffset(entity: RouteSlotEntity) {
		if (entity.transportUnitType !== 'wooden-pallet') return;
		// 木托长边相对默认路线切线横转 90°；每次都在 RouteEngine/lookAt 重建基础姿态后调用，因此不会累计。
		entity.root.rotateY(Math.PI / 2);
		entity.root.userData.routeYawOffsetRadians = Math.PI / 2;
	}

	private removeEntity(key: string) {
		const entity = this.entities.get(key);
		if (!entity) return;
		if (entity.manualStationRelease) this.unregisterPhysicalStationRelease(entity, entity.manualStationRelease.componentObjectId);
		entity.simulationProcess?.dispose();
		entity.root.parent?.remove(entity.root);
		entity.root.traverse((object: any) => {
			object.geometry?.dispose?.();
			const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
			for (const material of materials) {
				material.map?.dispose?.();
				material.dispose?.();
			}
		});
		this.entities.delete(key);
	}
}
