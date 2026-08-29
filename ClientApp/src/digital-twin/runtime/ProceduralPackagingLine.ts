import * as THREE from 'three';
import type { SilkLineSimulationOptions, TwinRouteDefinition, TwinRouteEdgeDefinition } from '../contracts';
import type { TwinRouteRoutingContext } from '../routes/RouteEngine';
import { TwinMaterialFlowRuntime, type TwinFlowWaitingReason } from './TwinMaterialFlowRuntime';
import { resolveGantryPose } from './GantryPoseResolver';
import { ProcessStationManager } from './ProcessStationManager';
import { createProcessStationVisual } from './ProcessStationVisualFactory';
import { silkLineLayout } from './SilkLineLayout';

type SilkSide = 'A' | 'B';
type PalletStage = 'source-queue' | 'loading' | 'to-load-check' | 'to-external-inspection' | 'external-inspection' | 'to-bagging' | 'bagging' | 'to-diverter' | 'to-gantry-a' | 'to-gantry-b' | 'gantry-a' | 'gantry-b' | 'empty-return-drop' | 'empty-return-main' | 'empty-return-rise' | 'returning';
type WoodStage = 'stacking' | 'covering' | 'labeling' | 'wrapping' | 'inbound' | 'stored';

interface PlasticPalletRuntime {
	palletId: string;
	root: THREE.Group;
	cakeAnchor: THREE.Group;
	stage: PalletStage;
	progress: number;
	loaded: boolean;
	loadAttempted?: boolean;
	silkCakeId?: string;
	loadSlot?: number;
	gantrySlot?: number;
	returnFrom?: 'A' | 'B' | 'buffer' | 'empty-bypass';
	returnOrder?: number;
	returnSequence?: number;
	returnQueueIndex?: number;
	returnLoadSlot?: number;
	cycleCount: number;
	waitingReason?: TwinFlowWaitingReason;
}

interface SilkCakeRuntime {
	silkCakeId: string;
	root: THREE.Group;
	state: 'on-cart' | 'robot-picking' | 'on-pallet' | 'gantry-picking' | 'on-wood-pallet' | 'stored';
	side: SilkSide;
	row: number;
	column: number;
	quality: 'normal' | 'ng' | 'unknown';
	appearanceInspection: { state: 'pending' | 'processing' | 'completed' | 'fault'; result: 'pass' | 'ng' | 'unknown'; defectCode?: string; completedAt?: number };
	bagging: { state: 'pending' | 'processing' | 'completed' | 'fault'; bagged: boolean; completedAt?: number };
	bagVisual: THREE.Mesh;
}

interface SilkCartSlotRuntime {
	side: SilkSide;
	row: number;
	column: number;
	anchor: THREE.Group;
	silkCakeId?: string;
}

interface RobotTaskRuntime {
	state: 'idle' | 'picking';
	progress: number;
	side: SilkSide;
	row: number;
	palletIds: string[];
	silkCakeIds: string[];
	attachedAtPick: boolean;
	attachedAtPlace: boolean;
	skipLoading: boolean;
}

interface GantryTaskRuntime {
	state: 'idle' | 'picking';
	progress: number;
	palletIds: string[];
	silkCakeIds: string[];
	targetLayer: number;
	attachedAtPick: boolean;
	attachedAtPlace: boolean;
}

interface WoodenPalletRuntime {
	woodenPalletId: string;
	root: THREE.Group;
	stackAnchor: THREE.Group;
	stage: WoodStage;
	progress: number;
	layer: number;
	silkCakeIds: string[];
	coverApplied: boolean;
	labelApplied: boolean;
	wrapped: boolean;
}

export interface SilkPackagingLineSnapshot {
	running: boolean;
	speed: number;
	plasticPallets: {
		total: number;
		online: number;
		empty: number;
		loaded: number;
		waiting: number;
		sourceQueue: number;
		cycled: number;
	};
	silkCart: {
		cartId: string;
		activeSide: SilkSide;
		currentRow: number;
		remaining: number;
		capacity: number;
		state: string;
	};
	robot: {
		state: string;
		batchSize: number;
		emptyPalletsReady: number;
		progress: number;
		side: SilkSide;
		row: number;
	};
	gantry: {
		state: string;
		laneA: number;
		laneB: number;
		progress: number;
		phase?: string;
		targetLayer: number;
		carriageY: number;
		safeCarriageY: number;
	};
	preProcess: {
		emptyBypassCount: number;
		inspection: { state: string; currentPalletId?: string; passed: number; ng: number; progress: number };
		bagging: { state: string; currentPalletId?: string; completed: number; progress: number };
	};
	woodenPallet: {
		id?: string;
		layer: number;
		maxLayers: number;
		silkCakeCount: number;
		maxSilkCakeCount: number;
		stage?: WoodStage;
	};
	postProcess: {
		covered: number;
		labeled: number;
		wrapped: number;
		stored: number;
	};
	watchdog: {
		state: 'healthy' | 'recovering';
		idleSeconds: number;
		recoveryCount: number;
		blockedPalletIds: string[];
	};
	sections: ReturnType<TwinMaterialFlowRuntime['sections']['getSnapshots']>;
	entities: ReturnType<TwinMaterialFlowRuntime['entities']['getAll']>;
}

const SILK_ROWS = 3;
const SILK_COLUMNS = 6;
const SILK_SIDES = 2;
const SILK_PER_CART = SILK_ROWS * SILK_COLUMNS * SILK_SIDES;
const ROBOT_BATCH = 6;
const GANTRY_ROWS = 2;
const GANTRY_COLUMNS = 3;
const GANTRY_BATCH = GANTRY_ROWS * GANTRY_COLUMNS;
const WOOD_MAX_LAYERS = 8;
const SILK_PER_WOOD_PALLET = GANTRY_BATCH * WOOD_MAX_LAYERS;

const LOAD_SLOT_POSITIONS = Array.from({ length: ROBOT_BATCH }, (_, index) => new THREE.Vector3(-10 + index * 1.55, 0.94, -5.8));
const GANTRY_LANE_A_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(silkLineLayout.gantryStartX + index * 1.8, 0.94, -7.6));
const GANTRY_LANE_B_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(silkLineLayout.gantryStartX + index * 1.8, 0.94, -4.2));
// 木托盘主辊道布置在两条塑料托盘缓存线的上方，避免与空托盘回流线及岔口交叉。
const WOOD_LANE_Z = -11.0;
const WOOD_STACK_POSITION = new THREE.Vector3(silkLineLayout.woodPalletX, 0.72, WOOD_LANE_Z);
const COVER_POSITION = new THREE.Vector3(silkLineLayout.coverX, 0.72, WOOD_LANE_Z);
const LABEL_POSITION = new THREE.Vector3(silkLineLayout.labelX, 0.72, WOOD_LANE_Z);
const WRAP_POSITION = new THREE.Vector3(silkLineLayout.wrappingX, 0.72, WOOD_LANE_Z);
const INBOUND_POSITION = new THREE.Vector3(silkLineLayout.inboundX, 0.72, WOOD_LANE_Z);
const STORED_POSITION = new THREE.Vector3(silkLineLayout.storedX, 1.1, WOOD_LANE_Z);
const RETURN_EAST_LOWER = new THREE.Vector3(silkLineLayout.returnEastX, 0.94, -4.2);
const RETURN_CORNER_EAST = new THREE.Vector3(silkLineLayout.returnEastX, 0.94, silkLineLayout.returnNorthZ);
const RETURN_CORNER_WEST = new THREE.Vector3(silkLineLayout.returnWestX, 0.94, silkLineLayout.returnNorthZ);
const RETURN_WEST_LOWER = new THREE.Vector3(silkLineLayout.returnWestX, 0.94, -5.8);
const RETURN_ENTRY = new THREE.Vector3(-11, 0.94, -5.8);
// 塑料托盘外径约 1.48 m。中心距必须大于外径；直角弯/汇流按 2.2 m 节距排队，
// 保证两个托盘分别位于拐角两侧时，欧氏距离仍不会小于托盘外径。
const PALLET_MIN_CENTER_GAP = 1.5;
const RETURN_CONVOY_GAP = 2.2;
const RETURN_BUFFER_GAP = RETURN_CONVOY_GAP;
const MAX_PALLET_STEP_METERS = 0.65;
const SOURCE_QUEUE_GAP = 1.7;

const markShadow = (object: THREE.Object3D) => {
	object.traverse((child: any) => {
		if (!child.isMesh) return;
		child.castShadow = true;
		child.receiveShadow = true;
	});
};

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const polylineLength = (points: THREE.Vector3[]) => points.slice(1).reduce((sum, point, index) => sum + point.distanceTo(points[index]), 0);
const pointOnPolyline = (points: THREE.Vector3[], progress: number) => {
	if (!points.length) return new THREE.Vector3();
	if (points.length === 1) return points[0].clone();
	const lengths = points.slice(1).map((point, index) => point.distanceTo(points[index]));
	const totalLength = lengths.reduce((sum, length) => sum + length, 0);
	if (totalLength <= 0.00001) return points[points.length - 1].clone();
	let remaining = clamp01(progress) * totalLength;
	for (let index = 0; index < lengths.length; index += 1) {
		const length = lengths[index];
		if (remaining <= length || index === lengths.length - 1) {
			return points[index].clone().lerp(points[index + 1], length <= 0.00001 ? 1 : remaining / length);
		}
		remaining -= length;
	}
	return points[points.length - 1].clone();
};
const lerpPose = (object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, progress: number) => {
	object.position.lerpVectors(from, to, clamp01(progress));
	const direction = to.clone().sub(from).setY(0);
	if (direction.lengthSq() > 0.00001) object.rotation.y = Math.atan2(direction.x, direction.z);
};

const lerpPolylinePose = (object: THREE.Object3D, points: THREE.Vector3[], progress: number) => {
	if (points.length < 2) return;
	const lengths = points.slice(1).map((point, index) => point.distanceTo(points[index]));
	const totalLength = lengths.reduce((sum, length) => sum + length, 0);
	if (totalLength <= 0.00001) {
		object.position.copy(points[points.length - 1]);
		return;
	}
	let remaining = clamp01(progress) * totalLength;
	for (let index = 0; index < lengths.length; index += 1) {
		const length = lengths[index];
		if (remaining <= length || index === lengths.length - 1) {
			lerpPose(object, points[index], points[index + 1], length <= 0.00001 ? 1 : remaining / length);
			return;
		}
		remaining -= length;
	}
};

/**
 * 丝饼产线程序化数字孪生。
 *
 * - 丝车 A/B 两面，每面 3 行 × 6 列；A 面三行抓完后旋转 180° 再抓 B 面。
 * - 上料机器人使用 1×6 夹具，只有凑齐 6 个空塑料托盘时才一次抓一整行。
 * - 塑料托盘通过 TwinMaterialFlowRuntime 的 Section Capacity / Reserved / Waiting 控制流转。
 * - 桁架内两条塑料托盘辊道各 3 位，木托盘主辊道独立布置在上方；2×3 夹具一次抓 6 个丝饼。
 * - 木托盘每层 2×3，共 8 层 = 48 个丝饼；之后盖板、贴标、缠膜、立体库入库。
 * - 桁架抓空后的塑料托盘回流，再组成下一组 6 个空托盘。
 */
export class ProceduralPackagingLine {
	readonly group = new THREE.Group();

	private route: TwinRouteDefinition;
	private readonly palletCount: number;
	private flowRuntime: TwinMaterialFlowRuntime;
	private processStations: ProcessStationManager;
	private readonly pallets = new Map<string, PlasticPalletRuntime>();
	private readonly cakes = new Map<string, SilkCakeRuntime>();
	private readonly cartSlots: SilkCartSlotRuntime[] = [];
	private readonly sourceQueue: string[] = [];
	private readonly loadingSlots: Array<string | undefined> = Array(ROBOT_BATCH).fill(undefined);
	private readonly gantryLaneA: Array<string | undefined> = Array(3).fill(undefined);
	private readonly gantryLaneB: Array<string | undefined> = Array(3).fill(undefined);
	private readonly woodProcessQueue: WoodenPalletRuntime[] = [];
	private readonly storedWoodPallets: WoodenPalletRuntime[] = [];

	private running = false;
	private speed = 1.35;
	private silkSequence = 0;
	private cartSequence = 0;
	private woodSequence = 0;
	private returnSequence = 0;
	private currentCartId = '';
	private currentSide: SilkSide = 'A';
	private currentRow = 0;
	private cartState: 'ready-a' | 'feeding-a' | 'turning-to-b' | 'ready-b' | 'feeding-b' | 'empty' | 'replacing' = 'ready-a';
	private cartTurnProgress = 0;
	private cartReplaceProgress = 0;
	private robotTask: RobotTaskRuntime = this.createIdleRobotTask();
	private gantryTask: GantryTaskRuntime = this.createIdleGantryTask();
	private activeWoodPallet?: WoodenPalletRuntime;
	private woodFeedElapsed = 0;
	private motionThisTick = false;
	private watchdogIdleSeconds = 0;
	private watchdogRecoveryCount = 0;
	private inspectionElapsed = 0;
	private baggingElapsed = 0;
	private inspectionPassed = 0;
	private inspectionNg = 0;
	private baggingCompleted = 0;
	private emptyBypassCount = 0;
	private robotBatchSequence = 0;
	private readonly options: {
		robotCycleSeconds: number;
		emptyPalletBatchRate: number;
		gantryCycleSeconds: number;
		inspectionCycleSeconds: number;
		inspectionNgRate: number;
		baggingCycleSeconds: number;
		cartChangeDelaySeconds: number;
		coverCycleSeconds: number;
		labelCycleSeconds: number;
		wrappingCycleSeconds: number;
		warehouseInboundCycleSeconds: number;
		emptyWoodPalletFeedSeconds: number;
		autoReplaceSilkCart: boolean;
		autoFeedWoodPallet: boolean;
	};

	private readonly frameMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.48, metalness: 0.76 });
	private readonly darkFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.58, metalness: 0.68 });
	private readonly rollerMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb8c6, roughness: 0.32, metalness: 0.86 });
	private readonly plasticMaterial = new THREE.MeshStandardMaterial({ color: 0x087f5b, roughness: 0.55, metalness: 0.08 });
	private readonly plasticDarkMaterial = new THREE.MeshStandardMaterial({ color: 0x065f46, roughness: 0.62, metalness: 0.08 });
	private readonly silkMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f4ef, roughness: 0.86, metalness: 0.01 });
	private readonly silkEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0xdde3dc, roughness: 0.72, metalness: 0.01 });
	private readonly bagMaterial = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.26, roughness: 0.18, metalness: 0.01, side: THREE.DoubleSide });
	private readonly robotMaterial = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.32, metalness: 0.42 });
	private readonly robotJointMaterial = new THREE.MeshStandardMaterial({ color: 0x202b3c, roughness: 0.34, metalness: 0.82 });
	private readonly safetyMaterial = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b2400, roughness: 0.36, metalness: 0.42 });
	private readonly woodMaterial = new THREE.MeshStandardMaterial({ color: 0x9a6a2f, roughness: 0.82, metalness: 0.03 });
	private readonly coverMaterial = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.66, metalness: 0.08 });
	private readonly labelMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x111111, roughness: 0.9, metalness: 0 });
	private readonly wrapMaterial = new THREE.MeshStandardMaterial({ color: 0xdbeafe, transparent: true, opacity: 0.22, roughness: 0.16, metalness: 0.02, side: THREE.DoubleSide });

	private readonly silkCartRoot = new THREE.Group();
	private readonly silkCartBody = new THREE.Group();
	private readonly rotaryDisc = new THREE.Group();
	private readonly robotRoot = new THREE.Group();
	private readonly robotShoulder = new THREE.Group();
	private readonly robotElbow = new THREE.Group();
	private readonly robotWrist = new THREE.Group();
	private readonly robotRowGripper = new THREE.Group();
	private readonly gantryRoot = new THREE.Group();
	private readonly gantryCarriage = new THREE.Group();
	private readonly gantryLift = new THREE.Group();
	private readonly gantryGripper = new THREE.Group();
	private readonly coverGantryHead = new THREE.Group();
	private readonly wrapperFilm = new THREE.Group();

	private sectionIds: {
		loading?: string;
		loadBuffer?: string;
		emptyReturnDrop?: string;
		emptyReturnMain?: string;
		emptyReturnRise?: string;
		inspection?: string;
		inspectionBuffer?: string;
		bagging?: string;
		baggingBuffer?: string;
		diverter?: string;
		laneA?: string;
		laneB?: string;
		returning?: string;
	};

	constructor(route: TwinRouteDefinition, palletCount = 80, options: Partial<SilkLineSimulationOptions> = {}, visualOptions: { renderLegacyPlasticConveyors?: boolean; renderLegacyPreProcessStations?: boolean } = {}) {
		this.options = {
			robotCycleSeconds: options.robotCycleSeconds ?? 5,
			emptyPalletBatchRate: THREE.MathUtils.clamp(options.emptyPalletBatchRate ?? 0, 0, 1),
			gantryCycleSeconds: options.gantryCycleSeconds ?? 5,
			inspectionCycleSeconds: options.inspectionCycleSeconds ?? 2,
			inspectionNgRate: THREE.MathUtils.clamp(options.inspectionNgRate ?? 0, 0, 1),
			baggingCycleSeconds: options.baggingCycleSeconds ?? 3,
			cartChangeDelaySeconds: options.cartChangeDelaySeconds ?? 4,
			coverCycleSeconds: options.coverCycleSeconds ?? 3,
			labelCycleSeconds: options.labelCycleSeconds ?? 2,
			wrappingCycleSeconds: options.wrappingCycleSeconds ?? 8,
			warehouseInboundCycleSeconds: options.warehouseInboundCycleSeconds ?? 5,
			emptyWoodPalletFeedSeconds: options.emptyWoodPalletFeedSeconds ?? 1,
			autoReplaceSilkCart: options.autoReplaceSilkCart ?? true,
			autoFeedWoodPallet: options.autoFeedWoodPallet ?? true,
		};
		this.route = structuredClone(route);
		this.applySilkLineSectionCapacities(this.route);
		this.palletCount = Math.min(200, Math.max(6, Math.floor(palletCount)));
		this.speed = route.defaultSpeed;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.sectionIds = this.resolveSectionIds(this.route.edges || []);
		this.processStations = this.createProcessStations();
		this.group.name = '丝饼包装与立库入库数字孪生线';
		this.buildFloorLabels();
		if (visualOptions.renderLegacyPlasticConveyors !== false) this.buildPlasticConveyors();
		if (visualOptions.renderLegacyPreProcessStations !== false) this.buildPreProcessStations();
		this.buildRotaryTableAndSilkCart();
		this.buildRobot();
		this.buildGantryCell();
		this.buildPostProcessLine();
		this.buildPlasticPallets();
		this.replaceSilkCart(true);
		this.feedInitialPlasticPallets();
		this.feedNewWoodPallet();
		markShadow(this.group);
		this.applyAllPoses();
	}

	setRunning(running: boolean) {
		this.running = running;
	}

	setSpeed(speed: number) {
		if (Number.isFinite(speed) && speed > 0) this.speed = speed;
	}

	setRoutingContext(context: TwinRouteRoutingContext) {
		this.flowRuntime.applyRoutingContext(context);
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = structuredClone(route);
		this.applySilkLineSectionCapacities(this.route);
		this.speed = route.defaultSpeed;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.sectionIds = this.resolveSectionIds(this.route.edges || []);
		this.processStations = this.createProcessStations();
		this.reset();
	}

	reset() {
		this.running = false;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.processStations = this.createProcessStations();
		this.currentSide = 'A';
		this.currentRow = 0;
		this.cartState = 'ready-a';
		this.cartTurnProgress = 0;
		this.cartReplaceProgress = 0;
		this.woodFeedElapsed = 0;
		this.returnSequence = 0;
		this.motionThisTick = false;
		this.watchdogIdleSeconds = 0;
		this.watchdogRecoveryCount = 0;
		this.inspectionElapsed = 0;
		this.baggingElapsed = 0;
		this.inspectionPassed = 0;
		this.inspectionNg = 0;
		this.baggingCompleted = 0;
		this.emptyBypassCount = 0;
		this.robotBatchSequence = 0;
		this.robotTask = this.createIdleRobotTask();
		this.gantryTask = this.createIdleGantryTask();
		this.loadingSlots.fill(undefined);
		this.gantryLaneA.fill(undefined);
		this.gantryLaneB.fill(undefined);
		this.sourceQueue.splice(0, this.sourceQueue.length);
		for (const pallet of this.pallets.values()) {
			pallet.stage = 'source-queue';
			pallet.progress = 0;
			pallet.loaded = false;
			pallet.cycleCount = 0;
			delete pallet.loadAttempted;
			delete pallet.silkCakeId;
			delete pallet.loadSlot;
			delete pallet.gantrySlot;
			delete pallet.returnFrom;
			delete pallet.returnOrder;
			delete pallet.returnSequence;
			delete pallet.returnQueueIndex;
			delete pallet.returnLoadSlot;
			delete pallet.returnLoadSlot;
			delete pallet.waitingReason;
			pallet.cakeAnchor.clear();
			this.sourceQueue.push(pallet.palletId);
			this.flowRuntime.entities.ensure(pallet.palletId, undefined, Date.now(), 'plastic-pallet');
		}
		for (const queueItem of this.woodProcessQueue.splice(0)) this.group.remove(queueItem.root);
		for (const stored of this.storedWoodPallets.splice(0)) this.group.remove(stored.root);
		if (this.activeWoodPallet) this.group.remove(this.activeWoodPallet.root);
		this.activeWoodPallet = undefined;
		this.replaceSilkCart(true);
		this.feedInitialPlasticPallets();
		this.feedNewWoodPallet();
		this.applyAllPoses();
	}

	updateFixed(deltaSeconds: number) {
		if (!this.running || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		this.motionThisTick = false;
		this.updateSilkCart(deltaSeconds);
		this.updateRobot(deltaSeconds);
		this.updatePreProcessStations(deltaSeconds);
		this.updatePlasticPalletFlow(deltaSeconds);
		this.updateGantry(deltaSeconds);
		this.updateWoodPalletFeed(deltaSeconds);
		this.updateWoodPostProcess(deltaSeconds);
		this.tryStartRobotBatch();
		this.tryStartGantryBatch();
		this.tryFillLoadingSlots();
		this.applyAllPoses();
		const processActive = this.motionThisTick || this.robotTask.state !== 'idle' || this.gantryTask.state !== 'idle'
			|| this.processStations.getAll().some((station) => station.state !== 'idle')
			|| this.cartState === 'turning-to-b' || this.cartState === 'replacing' || this.woodProcessQueue.length > 0;
		if (processActive) this.watchdogIdleSeconds = 0;
		else this.watchdogIdleSeconds += deltaSeconds;
		if (this.watchdogIdleSeconds >= 15) {
			// 清除可能过期的目标槽预留，由下一帧按当前真实空位重新压实；保持 FIFO 且不瞬移实体。
			for (const pallet of this.pallets.values()) if (pallet.stage === 'returning') delete pallet.returnLoadSlot;
			this.watchdogRecoveryCount += 1;
			this.watchdogIdleSeconds = 0;
		}
	}

	getSnapshot(): SilkPackagingLineSnapshot {
		const palletValues = [...this.pallets.values()];
		const inspection = this.processStations.get('silk-external-inspection');
		const bagging = this.processStations.get('silk-bagging');
		return {
			running: this.running,
			speed: this.speed,
			plasticPallets: {
				total: palletValues.length,
				online: palletValues.filter((item) => item.stage !== 'source-queue').length,
				empty: palletValues.filter((item) => !item.loaded).length,
				loaded: palletValues.filter((item) => item.loaded).length,
				waiting: palletValues.filter((item) => Boolean(item.waitingReason)).length,
				sourceQueue: this.sourceQueue.length,
				cycled: palletValues.filter((item) => item.cycleCount > 0).length,
			},
			silkCart: {
				cartId: this.currentCartId,
				activeSide: this.currentSide,
				currentRow: this.currentRow + 1,
				remaining: Math.min(SILK_PER_CART, this.cartSlots.filter((slot) => Boolean(slot.silkCakeId)).length),
				capacity: SILK_PER_CART,
				state: this.cartState,
			},
			robot: {
				state: this.robotTask.state,
				batchSize: this.robotTask.palletIds.length,
				emptyPalletsReady: this.loadingSlots.filter(Boolean).length,
				progress: this.robotTask.progress,
				side: this.robotTask.side,
				row: this.robotTask.row + 1,
			},
			gantry: {
				state: this.gantryTask.state,
				laneA: this.gantryLaneA.filter(Boolean).length,
				laneB: this.gantryLaneB.filter(Boolean).length,
				progress: this.gantryTask.progress,
				phase: this.gantryCarriage.userData.motionPhase,
				targetLayer: this.gantryTask.targetLayer,
				carriageY: this.gantryCarriage.position.y,
				safeCarriageY: Number(this.gantryCarriage.userData.safeCarriageY || 7.45),
			},
			woodenPallet: {
				id: this.activeWoodPallet?.woodenPalletId,
				layer: this.activeWoodPallet?.layer ?? 0,
				maxLayers: WOOD_MAX_LAYERS,
				silkCakeCount: Math.min(SILK_PER_WOOD_PALLET, this.activeWoodPallet?.silkCakeIds.length ?? 0),
				maxSilkCakeCount: SILK_PER_WOOD_PALLET,
				stage: this.activeWoodPallet?.stage,
			},
			postProcess: {
				covered: this.woodProcessQueue.filter((item) => item.coverApplied).length,
				labeled: this.woodProcessQueue.filter((item) => item.labelApplied).length,
				wrapped: this.woodProcessQueue.filter((item) => item.wrapped).length,
				stored: this.storedWoodPallets.length,
			},
			preProcess: {
				emptyBypassCount: this.emptyBypassCount,
				inspection: {
					state: inspection?.state || 'idle',
					currentPalletId: inspection?.currentEntityId,
					passed: this.inspectionPassed,
					ng: this.inspectionNg,
					progress: inspection?.state === 'completed' ? 1 : clamp01(this.inspectionElapsed / Math.max(0.2, this.options.inspectionCycleSeconds)),
				},
				bagging: {
					state: bagging?.state || 'idle',
					currentPalletId: bagging?.currentEntityId,
					completed: this.baggingCompleted,
					progress: bagging?.state === 'completed' ? 1 : clamp01(this.baggingElapsed / Math.max(0.2, this.options.baggingCycleSeconds)),
				},
			},
			watchdog: {
				state: this.watchdogRecoveryCount > 0 && this.watchdogIdleSeconds > 0 ? 'recovering' : 'healthy',
				idleSeconds: this.watchdogIdleSeconds,
				recoveryCount: this.watchdogRecoveryCount,
				blockedPalletIds: palletValues.filter((item) => Boolean(item.waitingReason)).map((item) => item.palletId),
			},
			sections: this.flowRuntime.sections.getSnapshots(),
			entities: this.flowRuntime.entities.getAll(),
		};
	}

	/** 运行实体只读诊断。业务状态来自 Runtime，不从 Three.js 反推。 */
	getEntityDetail(entityType: string, entityId: string): Record<string, unknown> | undefined {
		if (entityType === 'plastic-pallet') {
			const pallet = this.pallets.get(entityId);
			return pallet ? {
				palletId: pallet.palletId,
				stage: pallet.stage,
				state: pallet.loaded ? 'loaded' : pallet.stage === 'returning' ? 'empty-return' : pallet.stage,
				silkCakeId: pallet.silkCakeId,
				progress: pallet.progress,
				loadSlot: pallet.loadSlot,
				gantrySlot: pallet.gantrySlot,
				returnOrder: pallet.returnOrder,
				returnSequence: pallet.returnSequence,
				returnQueueIndex: pallet.returnQueueIndex,
				returnLoadSlot: pallet.returnLoadSlot,
				cycleCount: pallet.cycleCount,
				waitingReason: pallet.waitingReason,
				section: this.flowRuntime.entities.get(entityId)?.currentSectionId,
			} : undefined;
		}
		if (entityType === 'silk-cake') {
			const cake = this.cakes.get(entityId);
			return cake ? { silkCakeId: cake.silkCakeId, state: cake.state, side: cake.side, row: cake.row + 1, column: cake.column + 1, quality: cake.quality, appearanceInspection: cake.appearanceInspection, bagging: cake.bagging } : undefined;
		}
		if (entityType === 'silk-cart') return {
			...this.getSnapshot().silkCart,
			rowsPerSide: SILK_ROWS,
			columnsPerRow: SILK_COLUMNS,
			A: this.getCartSideDetail('A'),
			B: this.getCartSideDetail('B'),
		};
		if (entityType === 'loading-robot') return { ...this.getSnapshot().robot, task: this.robotTask } as unknown as Record<string, unknown>;
		if (entityType === 'gantry-stacker') return { ...this.getSnapshot().gantry, task: this.gantryTask, woodenPallet: this.getSnapshot().woodenPallet } as unknown as Record<string, unknown>;
		if (entityType === 'wooden-pallet') {
			const pallet = [this.activeWoodPallet, ...this.woodProcessQueue, ...this.storedWoodPallets].find((item) => item?.woodenPalletId === entityId);
			return pallet ? {
				woodenPalletId: pallet.woodenPalletId,
				state: pallet.stage,
				layer: pallet.layer,
				maxLayers: WOOD_MAX_LAYERS,
				silkCakeCount: pallet.silkCakeIds.length,
				capacity: SILK_PER_WOOD_PALLET,
				coverApplied: pallet.coverApplied,
				labelApplied: pallet.labelApplied,
				wrapped: pallet.wrapped,
			} : undefined;
		}
		return undefined;
	}

	private applySilkLineSectionCapacities(route: TwinRouteDefinition) {
		const capacities: Record<string, number> = {
			'pack-edge-scan': 6,
			'pack-edge-load': 6,
			'pack-edge-left-pack': 3,
			'pack-edge-right-pack': 3,
			'pack-edge-return-main': Math.max(80, this.palletCount || 80),
			'silk-edge-loading': 6,
			'silk-edge-load-buffer': 6,
			'silk-edge-empty-return-drop': 6,
			'silk-edge-empty-return-main': 12,
			'silk-edge-empty-return-rise': 6,
			'silk-edge-external-inspection': 1,
			'silk-edge-inspection-out-buffer': 6,
			'silk-edge-bagging': 1,
			'silk-edge-bagging-out-buffer': 6,
			'silk-edge-diverter-in': 6,
			'silk-edge-left-b': 3,
			'silk-edge-right-b': 3,
			'silk-edge-return-main': Math.max(80, this.palletCount || 80),
		};
		for (const edge of route.edges || []) {
			if (capacities[edge.edgeId] !== undefined) edge.capacity = capacities[edge.edgeId];
			if (!edge.occupancyMode) edge.occupancyMode = 'simulation';
			if (!edge.conveyorSizeClass) edge.conveyorSizeClass = 'small';
			if (!edge.transportUnitType) edge.transportUnitType = 'plastic-pallet';
		}
	}

	private resolveSectionIds(edges: TwinRouteEdgeDefinition[]) {
		const byId = (id: string) => edges.find((edge) => edge.edgeId === id)?.edgeId;
		return {
			loading: byId('pack-edge-scan') || byId('silk-edge-loading') || edges[0]?.edgeId,
			loadBuffer: byId('pack-edge-load') || byId('silk-edge-load-buffer') || edges[1]?.edgeId || edges[0]?.edgeId,
			emptyReturnDrop: byId('silk-edge-empty-return-drop'),
			emptyReturnMain: byId('silk-edge-empty-return-main'),
			emptyReturnRise: byId('silk-edge-empty-return-rise'),
			inspection: byId('silk-edge-external-inspection') || byId('silk-edge-load-buffer') || edges[1]?.edgeId,
			inspectionBuffer: byId('silk-edge-inspection-out-buffer') || byId('silk-edge-load-buffer') || edges[1]?.edgeId,
			bagging: byId('silk-edge-bagging') || byId('silk-edge-load-buffer') || edges[1]?.edgeId,
			baggingBuffer: byId('silk-edge-bagging-out-buffer') || byId('silk-edge-load-buffer') || edges[1]?.edgeId,
			diverter: byId('silk-edge-diverter-in') || byId('silk-edge-load-buffer') || edges[1]?.edgeId,
			laneA: byId('pack-edge-left-pack') || byId('silk-edge-left-b') || edges[2]?.edgeId || edges[0]?.edgeId,
			laneB: byId('pack-edge-right-pack') || byId('silk-edge-right-b') || edges[3]?.edgeId || edges[0]?.edgeId,
			returning: byId('pack-edge-return-main') || byId('silk-edge-return-main') || edges[edges.length - 1]?.edgeId || edges[0]?.edgeId,
		};
	}

	private createProcessStations() {
		return new ProcessStationManager([
			{ stationId: 'silk-external-inspection', sectionId: this.sectionIds.inspection || 'silk-edge-external-inspection', type: 'external-inspection' },
			{ stationId: 'silk-bagging', sectionId: this.sectionIds.bagging || 'silk-edge-bagging', type: 'bagging' },
		]);
	}

	private getCartSideDetail(side: SilkSide) {
		const slots = this.cartSlots.filter((slot) => slot.side === side);
		return {
			remaining: slots.filter((slot) => Boolean(slot.silkCakeId)).length,
			rows: Array.from({ length: SILK_ROWS }, (_, row) => ({
				row: row + 1,
				remaining: slots.filter((slot) => slot.row === row && Boolean(slot.silkCakeId)).length,
			})),
		};
	}

	private transferPallet(pallet: PlasticPalletRuntime, targetSectionId: string | undefined) {
		if (!targetSectionId) return true;
		const entity = this.flowRuntime.entities.ensure(pallet.palletId, undefined, Date.now(), 'plastic-pallet');
		const result = this.flowRuntime.sections.tryTransfer(pallet.palletId, entity.currentSectionId, targetSectionId, Date.now(), 'plastic-pallet');
		if (!result.canAccept) {
			const reason: TwinFlowWaitingReason = result.reason === 'signal-stale'
				? 'TARGET_SECTION_SIGNAL_STALE'
				: result.reason === 'unit-type-not-allowed'
					? 'TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED'
				: result.reason === 'full'
					? 'TARGET_SECTION_FULL'
					: 'TARGET_SECTION_BLOCKED';
			pallet.waitingReason = reason;
			this.flowRuntime.entities.wait(pallet.palletId, reason, targetSectionId);
			return false;
		}
		delete pallet.waitingReason;
		this.flowRuntime.entities.resume(pallet.palletId, targetSectionId);
		return true;
	}

	private buildPlasticPallets() {
		const group = new THREE.Group();
		group.name = `${this.palletCount}个循环塑料托盘`;
		for (let index = 0; index < this.palletCount; index += 1) {
			const palletId = `PLASTIC-PALLET-${String(index + 1).padStart(3, '0')}`;
			const root = this.createPlasticPallet(palletId);
			const cakeAnchor = root.getObjectByName('SilkCakeAnchor') as THREE.Group;
			const runtime: PlasticPalletRuntime = { palletId, root, cakeAnchor, stage: 'source-queue', progress: 0, loaded: false, cycleCount: 0 };
			this.pallets.set(palletId, runtime);
			this.sourceQueue.push(palletId);
			this.flowRuntime.entities.ensure(palletId, undefined, Date.now(), 'plastic-pallet');
			group.add(root);
		}
		this.group.add(group);
	}

	private createPlasticPallet(palletId: string) {
		const root = new THREE.Group();
		root.name = palletId;
		root.userData.entityType = 'plastic-pallet';
		root.userData.entityId = palletId;
		root.userData.twinEntityType = 'plastic-pallet';
		root.userData.twinEntityId = palletId;
		const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.74, 0.12, 32), this.plasticMaterial);
		base.position.y = 0.06;
		root.add(base);
		const inner = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.055, 10, 32), this.plasticDarkMaterial);
		inner.rotation.x = Math.PI / 2;
		inner.position.y = 0.135;
		root.add(inner);
		const outer = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 10, 32), this.plasticDarkMaterial);
		outer.rotation.x = Math.PI / 2;
		outer.position.y = 0.135;
		root.add(outer);
		for (let index = 0; index < 12; index += 1) {
			const holder = new THREE.Group();
			holder.rotation.y = index * Math.PI / 6;
			const rib = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.055), this.plasticDarkMaterial);
			rib.position.set(0.3, 0.145, 0);
			holder.add(rib);
			root.add(holder);
		}
		const column = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.25, 0.92, 28), this.plasticMaterial);
		column.position.y = 0.58;
		root.add(column);
		const cakeAnchor = new THREE.Group();
		cakeAnchor.name = 'SilkCakeAnchor';
		cakeAnchor.position.y = 0.68;
		root.add(cakeAnchor);
		return root;
	}

	private createSilkCake(id: string, side: SilkSide, row: number, column: number) {
		const root = new THREE.Group();
		root.name = id;
		root.userData.entityType = 'silk-cake';
		root.userData.entityId = id;
		root.userData.twinEntityType = 'silk-cake';
		root.userData.twinEntityId = id;
		const body = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.42, 40, 1, false), this.silkMaterial);
		root.add(body);
		const edgeA = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.025, 8, 40), this.silkEdgeMaterial);
		edgeA.rotation.x = Math.PI / 2;
		edgeA.position.y = -0.215;
		root.add(edgeA);
		const edgeB = edgeA.clone();
		edgeB.position.y = 0.215;
		root.add(edgeB);
		const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.46, 24), this.plasticDarkMaterial);
		root.add(hole);
		const bagVisual = new THREE.Mesh(new THREE.CylinderGeometry(0.61, 0.61, 0.54, 40, 1, true), this.bagMaterial);
		bagVisual.name = `${id}-bag`;
		bagVisual.visible = false;
		root.add(bagVisual);
		const runtime: SilkCakeRuntime = {
			silkCakeId: id,
			root,
			state: 'on-cart',
			side,
			row,
			column,
			quality: 'unknown',
			appearanceInspection: { state: 'pending', result: 'unknown' },
			bagging: { state: 'pending', bagged: false },
			bagVisual,
		};
		this.cakes.set(id, runtime);
		return runtime;
	}

	private buildRotaryTableAndSilkCart() {
		const cell = new THREE.Group();
		cell.name = '双面丝车旋转供料单元';
		cell.position.set(-6.4, 0, -10.5);
		const base = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.35, 0.35, 40), this.darkFrameMaterial);
		base.position.y = 0.18;
		cell.add(base);
		const discMesh = new THREE.Mesh(new THREE.CylinderGeometry(2.08, 2.08, 0.18, 40), this.safetyMaterial);
		discMesh.position.y = 0.44;
		this.rotaryDisc.add(discMesh);
		cell.add(this.rotaryDisc);
		this.silkCartRoot.name = '丝车';
		this.silkCartRoot.userData.twinEntityType = 'silk-cart';
		this.silkCartRoot.position.y = 0.55;
		this.rotaryDisc.add(this.silkCartRoot);
		this.silkCartRoot.add(this.silkCartBody);
		this.buildSilkCartFrame();
		this.group.add(cell);
	}

	private buildSilkCartFrame() {
		this.silkCartBody.clear();
		this.cartSlots.splice(0, this.cartSlots.length);
		const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.24, 2.0), this.frameMaterial);
		chassis.position.y = 0.18;
		this.silkCartBody.add(chassis);
		for (const x of [-3, 3]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.7, 0.14), this.frameMaterial);
			post.position.set(x, 2.0, 0);
			this.silkCartBody.add(post);
		}
		for (let row = 0; row < SILK_ROWS; row += 1) {
			const y = 0.9 + row * 1.15;
			const beam = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.1, 0.1), this.frameMaterial);
			beam.position.set(0, y, 0);
			this.silkCartBody.add(beam);
			for (const side of ['A', 'B'] as SilkSide[]) {
				const z = side === 'A' ? 0.78 : -0.78;
				for (let column = 0; column < SILK_COLUMNS; column += 1) {
					const x = -2.75 + column * 1.1;
					const anchor = new THREE.Group();
					anchor.name = `Cart-${side}-R${row + 1}-C${column + 1}`;
					anchor.position.set(x, y, z);
					anchor.rotation.y = side === 'A' ? 0 : Math.PI;
					this.silkCartBody.add(anchor);
					this.cartSlots.push({ side, row, column, anchor });
				}
			}
		}
		for (const x of [-2.7, 2.7]) for (const z of [-0.72, 0.72]) {
			const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 18), this.robotJointMaterial);
			wheel.rotation.z = Math.PI / 2;
			wheel.position.set(x, 0.08, z);
			this.silkCartBody.add(wheel);
		}
	}

	private replaceSilkCart(initial = false) {
		for (const slot of this.cartSlots) {
			if (slot.silkCakeId) {
				const cake = this.cakes.get(slot.silkCakeId);
				if (cake && cake.state === 'on-cart') this.cakes.delete(cake.silkCakeId);
			}
			while (slot.anchor.children.length) slot.anchor.remove(slot.anchor.children[0]);
			delete slot.silkCakeId;
		}
		this.cartSequence += 1;
		this.currentCartId = `SILK-CART-${String(this.cartSequence).padStart(3, '0')}`;
		this.silkCartRoot.userData.twinEntityId = this.currentCartId;
		for (const slot of this.cartSlots) {
			this.silkSequence += 1;
			const silkCakeId = `SILK-${String(this.silkSequence).padStart(6, '0')}`;
			const cake = this.createSilkCake(silkCakeId, slot.side, slot.row, slot.column);
			slot.silkCakeId = silkCakeId;
			slot.anchor.add(cake.root);
			cake.root.rotation.x = Math.PI / 2;
		}
		this.currentSide = 'A';
		this.currentRow = 0;
		this.cartState = 'ready-a';
		this.cartTurnProgress = 0;
		this.cartReplaceProgress = 0;
		this.rotaryDisc.rotation.y = 0;
		if (!initial) this.robotTask = this.createIdleRobotTask();
	}

	private buildRobot() {
		this.robotRoot.name = '1×6上料机器人';
		this.robotRoot.userData.twinEntityType = 'loading-robot';
		this.robotRoot.userData.twinEntityId = 'LoadingRobot-01';
		this.robotRoot.position.set(-6.5, 0, -7.9);
		const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.82, 0.6, 24), this.robotJointMaterial);
		pedestal.position.y = 0.3;
		this.robotRoot.add(pedestal);
		const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.58, 0.5, 24), this.robotMaterial);
		turret.position.y = 0.78;
		this.robotRoot.add(turret);
		this.robotShoulder.position.y = 1.0;
		this.robotShoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 18), this.robotJointMaterial));
		const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.48, 1.75, 0.48), this.robotMaterial);
		upperArm.position.y = 0.84;
		this.robotShoulder.add(upperArm);
		this.robotRoot.add(this.robotShoulder);
		this.robotElbow.position.y = 1.7;
		this.robotElbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.33, 18, 18), this.robotJointMaterial));
		const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.55, 0.42), this.robotMaterial);
		forearm.position.y = 0.74;
		this.robotElbow.add(forearm);
		this.robotShoulder.add(this.robotElbow);
		this.robotWrist.position.y = 1.5;
		const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.38, 18), this.robotJointMaterial);
		wrist.rotation.z = Math.PI / 2;
		this.robotWrist.add(wrist);
		this.robotElbow.add(this.robotWrist);
		this.robotRowGripper.name = 'RobotRowGripper-1x6';
		this.robotRowGripper.position.set(0, 0.38, 0);
		const rail = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.16, 0.18), this.darkFrameMaterial);
		this.robotRowGripper.add(rail);
		for (let index = 0; index < ROBOT_BATCH; index += 1) {
			const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.32, 16), this.robotJointMaterial);
			head.position.set(-2.75 + index * 1.1, -0.2, 0);
			this.robotRowGripper.add(head);
		}
		this.robotWrist.add(this.robotRowGripper);
		this.group.add(this.robotRoot);
	}

	private buildPlasticConveyors() {
		const conveyors = new THREE.Group();
		conveyors.name = '塑料托盘循环输送线';
		const source = this.getRoutePointPosition('silk-source', RETURN_ENTRY).setY(0.55);
		const loadBuffer = this.getRoutePointPosition('silk-buffer', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const emptyReturnSouthEast = this.getRoutePointPosition('silk-empty-return-southeast', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.emptyReturnZ)).setY(0.55);
		const emptyReturnSouthWest = this.getRoutePointPosition('silk-empty-return-southwest', new THREE.Vector3(silkLineLayout.emptyReturnWestX, 0.94, silkLineLayout.emptyReturnZ)).setY(0.55);
		const inspection = this.getRoutePointPosition('silk-external-inspection', new THREE.Vector3(silkLineLayout.externalInspectionX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const inspectionBuffer = this.getRoutePointPosition('silk-inspection-out-buffer', new THREE.Vector3(silkLineLayout.inspectionBufferX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const bagging = this.getRoutePointPosition('silk-bagging', new THREE.Vector3(silkLineLayout.baggingX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const baggingBuffer = this.getRoutePointPosition('silk-bagging-out-buffer', new THREE.Vector3(silkLineLayout.baggingBufferX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const diverter = this.getRoutePointPosition('silk-diverter', new THREE.Vector3(silkLineLayout.diverterX, 0.94, silkLineLayout.lineZ)).setY(0.55);
		const laneAEntry = this.getRoutePointPosition('silk-left-buffer', new THREE.Vector3(22.8, 0.94, -7.6)).setY(0.55);
		const laneBEntry = this.getRoutePointPosition('silk-right-buffer', new THREE.Vector3(22.8, 0.94, -4.2)).setY(0.55);
		const laneAExit = this.getRoutePointPosition('silk-left-inspection', new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.94, -7.6)).setY(0.55);
		const laneBExit = this.getRoutePointPosition('silk-right-inspection', new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.94, -4.2)).setY(0.55);
		const gantry = this.getRoutePointPosition('silk-gantry', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -7.6)).setY(0.55);
		const merger = this.getRoutePointPosition('silk-merger', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -4.2)).setY(0.55);
		const east = this.getRoutePointPosition('silk-return-east', RETURN_EAST_LOWER).setY(0.55);
		const northEast = this.getRoutePointPosition('silk-return-northeast', RETURN_CORNER_EAST).setY(0.55);
		const west = this.getRoutePointPosition('silk-return-west', RETURN_CORNER_WEST).setY(0.55);
		const southWest = this.getRoutePointPosition('silk-return-southwest', RETURN_WEST_LOWER).setY(0.55);
		this.addRollerLane(conveyors, source, loadBuffer, 1.55, '机器人上料及主输送', 'silk-edge-load-buffer');
		this.addRollerLane(conveyors, loadBuffer, inspection, 1.55, '外检机输送段', 'silk-edge-external-inspection');
		this.addRollerLane(conveyors, loadBuffer, emptyReturnSouthEast, 1.45, '空托检测分流段', 'silk-edge-empty-return-drop');
		this.addRollerLane(conveyors, emptyReturnSouthEast, emptyReturnSouthWest, 1.45, '外检前空托短回流', 'silk-edge-empty-return-main');
		this.addRollerLane(conveyors, emptyReturnSouthWest, source, 1.45, '空托短回流机器人前接入段', 'silk-edge-empty-return-rise');
		this.addRollerLane(conveyors, inspection, inspectionBuffer, 1.55, '外检后缓存', 'silk-edge-inspection-out-buffer');
		this.addRollerLane(conveyors, inspectionBuffer, bagging, 1.55, '套袋机输送段', 'silk-edge-bagging');
		this.addRollerLane(conveyors, bagging, baggingBuffer, 1.55, '套袋后缓存', 'silk-edge-bagging-out-buffer');
		this.addRollerLane(conveyors, baggingBuffer, diverter, 1.55, '分流前缓存段', 'silk-edge-diverter-in');
		// A/B 长直缓存线由桁架单元统一绘制；这里只保留两条短分叉连接，避免重复模型叠加。
		this.addRollerLane(conveyors, diverter, laneAEntry, 1.45, '桁架A线分叉连接');
		this.addRollerLane(conveyors, diverter, laneBEntry, 1.45, '桁架B线分叉连接');
		this.addRollerLane(conveyors, laneAExit, gantry, 1.45, 'A线空托盘出站');
		this.addRollerLane(conveyors, laneBExit, merger, 1.45, 'B线空托盘出站');
		this.addRollerLane(conveyors, gantry, merger, 1.55, 'A/B空托盘汇流段');
		this.addRollerLane(conveyors, merger, east, 1.55, '空托盘回流东段');
		this.addRollerLane(conveyors, east, northEast, 1.55, '空托盘回流东提升段');
		this.addRollerLane(conveyors, northEast, west, 1.55, '空托盘回流主段');
		this.addRollerLane(conveyors, west, southWest, 1.55, '空托盘回流西下降段');
		this.addRollerLane(conveyors, southWest, source, 1.55, '空托盘回流入口');
		this.group.add(conveyors);
	}

	private buildPreProcessStations() {
		const stations = new THREE.Group();
		stations.name = '外检与套袋前处理单元';
		stations.add(createProcessStationVisual({
			stationId: 'silk-external-inspection',
			name: '外检机',
			processType: 'external-inspection',
			position: [silkLineLayout.externalInspectionX, 0.42, silkLineLayout.lineZ],
			size: [4, 3.2, 3],
			color: 0x38bdf8,
		}));
		stations.add(createProcessStationVisual({
			stationId: 'silk-bagging',
			name: '套袋机',
			processType: 'bagging',
			position: [silkLineLayout.baggingX, 0.42, silkLineLayout.lineZ],
			size: [4, 3.2, 3],
			color: 0xa855f7,
		}));
		this.group.add(stations);
	}

	private addRollerLane(parent: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, width: number, name: string, sectionId?: string) {
		const delta = to.clone().sub(from);
		const length = Math.hypot(delta.x, delta.z);
		if (length <= 0.01) return;
		const segment = new THREE.Group();
		segment.name = name;
		segment.userData.twinObjectType = 'conveyor-section';
		segment.userData.sectionId = sectionId;
		segment.position.copy(from).add(to).multiplyScalar(0.5);
		segment.rotation.y = -Math.atan2(delta.z, delta.x);
		const railA = new THREE.Mesh(new THREE.BoxGeometry(length, 0.16, 0.1), this.frameMaterial);
		railA.position.set(0, 0.12, -width / 2);
		segment.add(railA);
		const railB = railA.clone();
		railB.position.z = width / 2;
		segment.add(railB);
		const rollerCount = Math.max(2, Math.ceil(length / 0.55));
		for (let index = 0; index <= rollerCount; index += 1) {
			const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, width - 0.12, 12), this.rollerMaterial);
			roller.rotation.x = Math.PI / 2;
			roller.position.set(-length / 2 + index * length / rollerCount, 0.13, 0);
			segment.add(roller);
		}
		parent.add(segment);
	}

	private buildGantryCell() {
		this.gantryRoot.name = '2×3丝饼码垛桁架';
		this.gantryRoot.userData.twinEntityType = 'gantry-stacker';
		this.gantryRoot.userData.twinEntityId = 'GantryStacker-01';
		const x0 = silkLineLayout.gantryStartX - 1.8, x1 = silkLineLayout.gantryLaneEndX + 1, z0 = -12.4, z1 = -2.4, frameHeight = 8.4;
		for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as Array<[number, number]>) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, frameHeight, 0.24), this.frameMaterial);
			post.position.set(x, frameHeight / 2, z);
			this.gantryRoot.add(post);
		}
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, frameHeight, z0), new THREE.Vector3(x1, frameHeight, z0), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, frameHeight, z1), new THREE.Vector3(x1, frameHeight, z1), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, frameHeight, z0), new THREE.Vector3(x0, frameHeight, z1), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x1, frameHeight, z0), new THREE.Vector3(x1, frameHeight, z1), 0.16);
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(22.8, 0.55, -7.6), new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.55, -7.6), 1.5, 'Gantry-Lane-A-3位', 'silk-edge-left-b');
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(22.8, 0.55, -4.2), new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.55, -4.2), 1.5, 'Gantry-Lane-B-3位', 'silk-edge-right-b');
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(22.8, 0.42, WOOD_LANE_Z), new THREE.Vector3(30.4, 0.42, WOOD_LANE_Z), 2.1, 'Gantry-Wood-Pallet-Lane', 'silk-wood-edge-stack');
		this.gantryCarriage.name = 'Gantry-X-Carriage';
		const carriageBeam = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.22, 0.34), this.safetyMaterial);
		this.gantryCarriage.add(carriageBeam);
		this.gantryCarriage.position.set(silkLineLayout.woodPalletX, 7.45, -5.9);
		this.gantryRoot.add(this.gantryCarriage);
		this.gantryLift.name = 'Gantry-Lift';
		const liftBar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.2, 0.22), this.darkFrameMaterial);
		liftBar.position.y = -1.1;
		this.gantryLift.add(liftBar);
		this.gantryLift.position.y = -0.1;
		this.gantryCarriage.add(this.gantryLift);
		this.gantryGripper.name = 'GantryGripper-2x3';
		this.gantryGripper.position.y = -2.2;
		const gripperFrame = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 4.0), this.robotJointMaterial);
		this.gantryGripper.add(gripperFrame);
		for (let row = 0; row < 2; row += 1) for (let column = 0; column < 3; column += 1) {
			const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 16), this.robotJointMaterial);
			head.position.set(-1.8 + column * 1.8, -0.2, -1.7 + row * 3.4);
			this.gantryGripper.add(head);
		}
		this.gantryLift.add(this.gantryGripper);
		this.group.add(this.gantryRoot);
	}

	private addBeam(parent: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
		const direction = to.clone().sub(from);
		const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 10), this.frameMaterial);
		beam.position.copy(from).add(to).multiplyScalar(0.5);
		beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
		parent.add(beam);
	}

	private createWoodenPallet(id: string) {
		const root = new THREE.Group();
		root.name = id;
		root.userData.entityType = 'wooden-pallet';
		root.userData.entityId = id;
		root.userData.twinEntityType = 'wooden-pallet';
		root.userData.twinEntityId = id;
		for (const z of [-0.75, 0, 0.75]) {
			const slat = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.14, 0.42), this.woodMaterial);
			slat.position.set(0, 0.12, z);
			root.add(slat);
		}
		for (const x of [-1.7, 0, 1.7]) {
			const cross = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 2.1), this.woodMaterial);
			cross.position.set(x, 0.02, 0);
			root.add(cross);
		}
		const stackAnchor = new THREE.Group();
		stackAnchor.name = 'WoodStackAnchor';
		stackAnchor.position.y = 0.24;
		root.add(stackAnchor);
		return { root, stackAnchor };
	}

	private feedNewWoodPallet() {
		if (this.activeWoodPallet) return;
		this.woodSequence += 1;
		const woodenPalletId = `WOOD-PALLET-${String(this.woodSequence).padStart(4, '0')}`;
		const { root, stackAnchor } = this.createWoodenPallet(woodenPalletId);
		const runtime: WoodenPalletRuntime = {
			woodenPalletId,
			root,
			stackAnchor,
			stage: 'stacking',
			progress: 0,
			layer: 0,
			silkCakeIds: [],
			coverApplied: false,
			labelApplied: false,
			wrapped: false,
		};
		this.activeWoodPallet = runtime;
		root.position.copy(WOOD_STACK_POSITION);
		this.group.add(root);
	}

	private updateWoodPalletFeed(deltaSeconds: number) {
		if (this.activeWoodPallet || !this.options.autoFeedWoodPallet) return;
		this.woodFeedElapsed += deltaSeconds;
		if (this.woodFeedElapsed < this.options.emptyWoodPalletFeedSeconds) return;
		this.woodFeedElapsed = 0;
		this.feedNewWoodPallet();
	}

	private buildPostProcessLine() {
		const process = new THREE.Group();
		process.name = '木托盘后包装与立库入库线';
		this.addRollerLane(process, new THREE.Vector3(30.4, 0.42, WOOD_LANE_Z), new THREE.Vector3(silkLineLayout.inboundX + 1.5, 0.42, WOOD_LANE_Z), 2.2, '满托后包装辊道', 'silk-wood-edge-post-process');
		this.addProcessPortal(process, COVER_POSITION.x, '盖板桁架工位', 0x38bdf8);
		this.addProcessPortal(process, LABEL_POSITION.x, '贴标工位', 0x22c55e);
		this.addProcessPortal(process, WRAP_POSITION.x, '缠膜工位', 0xa855f7);
		const coverGantry = new THREE.Group();
		coverGantry.name = '盖板桁架';
		coverGantry.position.set(COVER_POSITION.x, 4.2, COVER_POSITION.z);
		const beam = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 0.3), this.frameMaterial);
		coverGantry.add(beam);
		const head = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.16, 1.8), this.safetyMaterial);
		head.position.y = -1.0;
		this.coverGantryHead.add(head);
		coverGantry.add(this.coverGantryHead);
		process.add(coverGantry);
		const wrapperRing = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.12, 12, 48), this.safetyMaterial);
		wrapperRing.rotation.y = Math.PI / 2;
		wrapperRing.position.set(WRAP_POSITION.x, 2.2, WRAP_POSITION.z);
		process.add(wrapperRing);
		const film = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 4.0, 32, 1, true), this.wrapMaterial);
		film.position.y = 1.8;
		this.wrapperFilm.add(film);
		this.wrapperFilm.position.set(WRAP_POSITION.x, 0, WRAP_POSITION.z);
		this.wrapperFilm.visible = false;
		process.add(this.wrapperFilm);
		this.buildWarehouse(process);
		this.group.add(process);
	}

	private addProcessPortal(parent: THREE.Group, x: number, name: string, color: number) {
		const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, roughness: 0.4, metalness: 0.32 });
		const portal = new THREE.Group();
		portal.name = name;
		for (const z of [WOOD_LANE_Z - 1, WOOD_LANE_Z + 1]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.0, 0.16), material);
			post.position.set(x, 1.5, z);
			portal.add(post);
		}
		const top = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 2.2), material);
		top.position.set(x, 3.0, WOOD_LANE_Z);
		portal.add(top);
		parent.add(portal);
	}

	private buildWarehouse(parent: THREE.Group) {
		const warehouse = new THREE.Group();
		warehouse.name = '立体库入库口';
		for (const x of [silkLineLayout.storedX - 1.5, silkLineLayout.storedX + 1.5]) for (const z of [WOOD_LANE_Z - 2.7, WOOD_LANE_Z + 2.6]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5.2, 0.18), this.frameMaterial);
			post.position.set(x, 2.6, z);
			warehouse.add(post);
		}
		for (let level = 0; level < 4; level += 1) {
			const y = 0.7 + level * 1.35;
			const shelfA = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 0.18), this.frameMaterial);
			shelfA.position.set(silkLineLayout.storedX, y, WOOD_LANE_Z - 2.6);
			warehouse.add(shelfA);
			const shelfB = shelfA.clone();
			shelfB.position.z = WOOD_LANE_Z + 2.5;
			warehouse.add(shelfB);
		}
		parent.add(warehouse);
	}

	private buildFloorLabels() {
		const zones: Array<[string, number, THREE.Vector3, THREE.Vector3]> = [
			['机器人上料区', 0x0ea5e9, new THREE.Vector3(-6, 0.015, -7.4), new THREE.Vector3(12, 0.02, 7.5)],
			['外检与套袋区', 0x38bdf8, new THREE.Vector3(11, 0.015, -5.8), new THREE.Vector3(16, 0.02, 5.2)],
			['桁架码垛区', 0xf59e0b, new THREE.Vector3(26.2, 0.015, -7.3), new THREE.Vector3(10, 0.02, 10.8)],
			['后包装区', 0xa855f7, new THREE.Vector3(40, 0.015, WOOD_LANE_Z), new THREE.Vector3(22, 0.02, 4.2)],
		];
		for (const [name, color, position, size] of zones) {
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.09, roughness: 1 }));
			mesh.name = name;
			mesh.position.copy(position);
			this.group.add(mesh);
		}
	}

	private feedInitialPlasticPallets() {
		// V5 closed-loop：启动时全部托盘已经在物理线体中，SourceQueue 必须清空。
		// 前 6 个占据机器人上料位，其余托盘按安全节距分布在扩展回流缓存线上。
		for (let index = 0; index < ROBOT_BATCH; index += 1) {
			const palletId = this.sourceQueue.shift();
			if (!palletId) break;
			const pallet = this.pallets.get(palletId)!;
			if (!this.transferPallet(pallet, this.sectionIds.loading)) break;
			this.loadingSlots[index] = palletId;
			pallet.stage = 'loading';
			pallet.loadSlot = index;
			pallet.loadAttempted = false;
			pallet.progress = 1;
		}
		let queueIndex = 0;
		while (this.sourceQueue.length) {
			const palletId = this.sourceQueue.shift()!;
			const pallet = this.pallets.get(palletId)!;
			pallet.returnFrom = 'buffer';
			pallet.returnOrder = queueIndex;
			pallet.returnSequence = this.returnSequence++;
			pallet.returnQueueIndex = queueIndex;
			pallet.returnLoadSlot = ROBOT_BATCH - 1 - queueIndex % ROBOT_BATCH;
			pallet.stage = 'returning';
			if (!this.transferPallet(pallet, this.sectionIds.returning)) {
				throw new Error(`V5 closed-loop 回流容量不足，无法上线 ${palletId}`);
			}
			const path = this.getReturnRoutePoints(pallet);
			pallet.progress = this.getReturnQueueHoldProgress(pallet, path);
			// 折线拐角两侧的“沿线间距”不等于实体欧氏距离。上线时逐步向队尾退让，
			// 直到与已经排入回流线的每个托盘都满足安全中心距，避免首帧在直角处相交。
			const progressStep = 0.04 / Math.max(0.001, polylineLength(path));
			let guard = 0;
			while (!this.isPalletPositionClear(pallet, pointOnPolyline(path, pallet.progress)) && pallet.progress > 0 && guard < 2_000) {
				pallet.progress = Math.max(0, pallet.progress - progressStep);
				guard += 1;
			}
			if (!this.isPalletPositionClear(pallet, pointOnPolyline(path, pallet.progress))) {
				throw new Error(`V5 回流缓存物理长度不足，${palletId} 无法保持 ${PALLET_MIN_CENTER_GAP}m 安全间距`);
			}
			queueIndex += 1;
		}
	}

	private tryFillLoadingSlots() {
		// 空托盘回流优先：存在已释放的回流托盘时，不再用初始 SourceQueue 抢占新空位。
		// 否则 50 托盘场景会长期消费新托盘，已经回流的托盘反而堵在回流线末端。
		if ([...this.pallets.values()].some((pallet) => pallet.stage === 'returning')) return;
		for (let index = 0; index < ROBOT_BATCH; index += 1) {
			if (this.loadingSlots[index]) continue;
			const palletId = this.sourceQueue[0];
			if (!palletId) break;
			const pallet = this.pallets.get(palletId);
			if (!pallet) {
				this.sourceQueue.shift();
				continue;
			}
			// 刚离开上料位的前一批托盘必须先拉开一个完整托盘直径，才能补入新托盘；
			// 否则 SourceQueue 的瞬时补位会与仍在机器人辊道上的前车重合。
			if (!this.isPalletPositionClear(pallet, LOAD_SLOT_POSITIONS[index])) continue;
			if (!this.transferPallet(pallet, this.sectionIds.loading)) break;
			this.sourceQueue.shift();
			this.loadingSlots[index] = palletId;
			pallet.stage = 'loading';
			pallet.loadSlot = index;
			pallet.loadAttempted = false;
			pallet.progress = 1;
		}
	}

	private tryStartRobotBatch() {
		if (this.robotTask.state !== 'idle') return;
		if (this.cartState === 'turning-to-b' || this.cartState === 'empty' || this.cartState === 'replacing') return;
		const palletIds = this.loadingSlots.filter((item): item is string => Boolean(item));
		if (palletIds.length !== ROBOT_BATCH) return;
		const pallets = palletIds.map((id) => this.pallets.get(id)).filter(Boolean) as PlasticPalletRuntime[];
		if (pallets.some((item) => item.loaded)) return;
		const rowSlots = this.cartSlots.filter((slot) => slot.side === this.currentSide && slot.row === this.currentRow && Boolean(slot.silkCakeId));
		if (rowSlots.length !== SILK_COLUMNS) return;
		this.robotBatchSequence += 1;
		const emptyBatchSample = (this.robotBatchSequence * 37 % 100) / 100;
		const skipLoading = emptyBatchSample < this.options.emptyPalletBatchRate;
		this.robotTask = {
			state: 'picking',
			progress: 0,
			side: this.currentSide,
			row: this.currentRow,
			palletIds,
			silkCakeIds: skipLoading ? [] : rowSlots.map((slot) => slot.silkCakeId!),
			attachedAtPick: false,
			attachedAtPlace: false,
			skipLoading,
		};
		this.cartState = this.currentSide === 'A' ? 'feeding-a' : 'feeding-b';
	}

	private updateRobot(deltaSeconds: number) {
		if (this.robotTask.state === 'idle') {
			this.robotShoulder.rotation.z = -0.18;
			this.robotElbow.rotation.z = 0.48;
			this.robotWrist.rotation.y = 0;
			return;
		}
		const duration = Math.max(0.2, this.options.robotCycleSeconds);
		this.robotTask.progress = clamp01(this.robotTask.progress + deltaSeconds / duration);
		const p = this.robotTask.progress;
		this.robotShoulder.rotation.z = -0.25 + Math.sin(p * Math.PI) * 0.55;
		this.robotElbow.rotation.z = 0.45 + Math.sin(p * Math.PI) * 0.75;
		this.robotWrist.rotation.y = (this.robotTask.side === 'A' ? -1 : 1) * Math.sin(p * Math.PI) * 0.4;
		if (!this.robotTask.attachedAtPick && p >= 0.2) {
			this.robotTask.attachedAtPick = true;
			for (const silkCakeId of this.robotTask.silkCakeIds) {
				const cake = this.cakes.get(silkCakeId);
				if (!cake) continue;
				this.robotRowGripper.attach(cake.root);
				cake.state = 'robot-picking';
			}
			for (const slot of this.cartSlots.filter((slot) => this.robotTask.silkCakeIds.includes(slot.silkCakeId || ''))) delete slot.silkCakeId;
		}
		if (!this.robotTask.attachedAtPlace && p >= 0.72) {
			this.robotTask.attachedAtPlace = true;
			for (let index = 0; index < ROBOT_BATCH; index += 1) {
				const pallet = this.pallets.get(this.robotTask.palletIds[index]);
				const cake = this.cakes.get(this.robotTask.silkCakeIds[index]);
				if (!pallet || !cake) continue;
				pallet.cakeAnchor.attach(cake.root);
				cake.root.position.set(0, 0.22, 0);
				cake.root.rotation.set(0, 0, 0);
				cake.state = 'on-pallet';
				pallet.loaded = true;
				pallet.silkCakeId = cake.silkCakeId;
			}
		}
		if (p >= 1) this.finishRobotBatch();
	}

	private finishRobotBatch() {
		// 上料尝试结束后，无论 6 个托盘是否都有丝饼，都必须离开机器人位进入外检前检测岔口。
		// 有料托盘继续外检，空托盘进入短回流；否则空托会永久占据机器人位造成整线死锁。
		for (const palletId of this.robotTask.palletIds) {
			const pallet = this.pallets.get(palletId);
			if (pallet) pallet.loadAttempted = true;
		}
		if (this.robotTask.skipLoading) {
			this.cartState = this.currentSide === 'A' ? 'ready-a' : 'ready-b';
			this.robotTask = this.createIdleRobotTask();
			return;
		}
		this.currentRow += 1;
		if (this.currentRow >= SILK_ROWS) {
			if (this.currentSide === 'A') {
				this.currentRow = 0;
				this.cartState = 'turning-to-b';
				this.cartTurnProgress = 0;
			} else {
				this.currentRow = 0;
				this.cartState = 'empty';
				this.cartReplaceProgress = 0;
			}
		} else {
			this.cartState = this.currentSide === 'A' ? 'ready-a' : 'ready-b';
		}
		this.robotTask = this.createIdleRobotTask();
	}

	private updateSilkCart(deltaSeconds: number) {
		if (this.cartState === 'turning-to-b') {
			this.cartTurnProgress = clamp01(this.cartTurnProgress + deltaSeconds / 2.2);
			this.rotaryDisc.rotation.y = Math.PI * this.cartTurnProgress;
			if (this.cartTurnProgress >= 1) {
				this.currentSide = 'B';
				this.currentRow = 0;
				this.cartState = 'ready-b';
			}
			return;
		}
		if (this.cartState === 'empty' || this.cartState === 'replacing') {
			if (!this.options.autoReplaceSilkCart) return;
			this.cartState = 'replacing';
			this.cartReplaceProgress += deltaSeconds;
			if (this.cartReplaceProgress >= this.options.cartChangeDelaySeconds) this.replaceSilkCart();
		}
	}

	private updatePreProcessStations(deltaSeconds: number) {
		const inspection = this.processStations.get('silk-external-inspection');
		if (inspection?.currentEntityId) {
			const pallet = this.pallets.get(inspection.currentEntityId);
			const cake = pallet?.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			if (inspection.state === 'waiting' && cake?.appearanceInspection.state === 'pending') {
				this.inspectionElapsed = 0;
				cake.appearanceInspection.state = 'processing';
				this.processStations.begin('silk-external-inspection');
			}
			if (this.processStations.get('silk-external-inspection')?.state === 'processing' && cake) {
				this.inspectionElapsed += deltaSeconds;
				if (this.inspectionElapsed >= Math.max(0.2, this.options.inspectionCycleSeconds)) {
					const deterministicSample = [...cake.silkCakeId].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2166136261) % 10_000 / 10_000;
					const isNg = deterministicSample < this.options.inspectionNgRate;
					cake.appearanceInspection = { state: 'completed', result: isNg ? 'ng' : 'pass', defectCode: isNg ? 'APPEARANCE_NG' : undefined, completedAt: Date.now() };
					cake.quality = isNg ? 'ng' : 'normal';
					if (isNg) {
						this.inspectionNg += 1;
						pallet!.waitingReason = 'TARGET_SECTION_BLOCKED';
						this.processStations.wait('silk-external-inspection', 'INSPECTION_NG_HOLD');
					} else {
						this.inspectionPassed += 1;
						this.processStations.complete('silk-external-inspection');
					}
				}
			}
		}

		const bagging = this.processStations.get('silk-bagging');
		if (bagging?.currentEntityId) {
			const pallet = this.pallets.get(bagging.currentEntityId);
			const cake = pallet?.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			const inspectionPassed = cake?.quality === 'normal' && cake.appearanceInspection.state === 'completed' && cake.appearanceInspection.result === 'pass';
			if (bagging.state === 'waiting' && cake?.bagging.state === 'pending' && inspectionPassed) {
				this.baggingElapsed = 0;
				cake.bagging.state = 'processing';
				this.processStations.begin('silk-bagging');
			}
			if (this.processStations.get('silk-bagging')?.state === 'processing' && cake) {
				this.baggingElapsed += deltaSeconds;
				if (this.baggingElapsed >= Math.max(0.2, this.options.baggingCycleSeconds)) {
					cake.bagging = { state: 'completed', bagged: true, completedAt: Date.now() };
					cake.bagVisual.visible = true;
					this.baggingCompleted += 1;
					this.processStations.complete('silk-bagging');
				}
			}
		}

		this.updateStationLamp('silk-external-inspection');
		this.updateStationLamp('silk-bagging');
	}

	private updateStationLamp(stationId: string) {
		const station = this.processStations.get(stationId);
		const lamp = this.group.getObjectByName(`${stationId}-status-lamp`) as THREE.Mesh | undefined;
		const material = lamp?.material as THREE.MeshStandardMaterial | undefined;
		if (!material || !station) return;
		const color = station.state === 'processing' ? 0xfacc15 : station.state === 'completed' ? 0x22c55e : station.state === 'fault' || station.waitingReason === 'INSPECTION_NG_HOLD' ? 0xef4444 : 0x94a3b8;
		material.color.setHex(color);
		material.emissive.setHex(color);
	}

	private updatePlasticPalletFlow(deltaSeconds: number) {
		const travelMeters = Math.min(MAX_PALLET_STEP_METERS, Math.max(0.25, this.speed) * deltaSeconds);
		// Robot 后的每个前处理工位都是 Capacity=1 的真实 Section。完成工艺且下游有容量时才释放，
		// 因此套袋慢、Gantry 满都会沿外检后缓存、上料后缓存逐级产生 Backpressure。
		for (const pallet of this.pallets.values()) {
			if (pallet.stage === 'loading' && pallet.loadAttempted && pallet.loadSlot !== undefined) {
				const loadSlot = pallet.loadSlot;
				if (this.transferPallet(pallet, this.sectionIds.loadBuffer)) {
					this.loadingSlots[loadSlot] = undefined;
					pallet.stage = 'to-load-check';
					pallet.progress = 0;
				}
			}
		}

		const toLoadCheck = [...this.pallets.values()].filter((pallet) => pallet.stage === 'to-load-check').sort((left, right) => {
			const remaining = (pallet: PlasticPalletRuntime) => (1 - pallet.progress) * Math.max(0.001, polylineLength(this.getPreProcessRoutePoints(pallet)));
			return remaining(left) - remaining(right) || (right.loadSlot ?? -1) - (left.loadSlot ?? -1);
		});
		for (const pallet of toLoadCheck) {
			const path = this.getPreProcessRoutePoints(pallet);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			const targetSection = pallet.loaded ? this.sectionIds.inspection : this.sectionIds.emptyReturnDrop;
			if (!this.transferPallet(pallet, targetSection)) {
				continue;
			}
			pallet.progress = 0;
			if (pallet.loaded) {
				pallet.stage = 'to-external-inspection';
			} else {
				pallet.stage = 'empty-return-drop';
				pallet.returnFrom = 'empty-bypass';
				pallet.returnSequence = this.returnSequence++;
				this.emptyBypassCount += 1;
				delete pallet.loadSlot;
			}
			delete pallet.waitingReason;
		}

		const toInspection = [...this.pallets.values()].filter((pallet) => pallet.stage === 'to-external-inspection').sort((left, right) => right.progress - left.progress || (right.loadSlot ?? -1) - (left.loadSlot ?? -1));
		for (const pallet of toInspection) {
			const path = this.getPreProcessRoutePoints(pallet);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			pallet.stage = 'external-inspection';
			pallet.progress = 1;
			this.processStations.arrive(this.sectionIds.inspection || 'silk-edge-external-inspection', pallet.palletId);
		}

		this.advanceEmptyReturnStage('empty-return-drop', 'empty-return-main', this.sectionIds.emptyReturnMain, travelMeters);
		this.advanceEmptyReturnStage('empty-return-main', 'empty-return-rise', this.sectionIds.emptyReturnRise, travelMeters);
		this.advanceEmptyReturnStage('empty-return-rise', 'returning', undefined, travelMeters);

		for (const pallet of [...this.pallets.values()].filter((item) => item.stage === 'external-inspection')) {
			const cake = pallet.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			if (!cake || cake.appearanceInspection.state !== 'completed' || cake.appearanceInspection.result !== 'pass') continue;
			if (!this.processStations.canRelease(this.sectionIds.inspection || '', pallet.palletId).canRelease) continue;
			if (!this.transferPallet(pallet, this.sectionIds.inspectionBuffer)) continue;
			this.processStations.release(this.sectionIds.inspection || '', pallet.palletId);
			pallet.stage = 'to-bagging';
			pallet.progress = 0;
			delete pallet.waitingReason;
		}

		const toBagging = [...this.pallets.values()].filter((pallet) => pallet.stage === 'to-bagging').sort((left, right) => right.progress - left.progress || left.palletId.localeCompare(right.palletId));
		for (const pallet of toBagging) {
			const path = this.getPreProcessRoutePoints(pallet);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			if (!this.transferPallet(pallet, this.sectionIds.bagging)) {
				continue;
			}
			pallet.stage = 'bagging';
			pallet.progress = 1;
			this.processStations.arrive(this.sectionIds.bagging || 'silk-edge-bagging', pallet.palletId);
		}

		for (const pallet of [...this.pallets.values()].filter((item) => item.stage === 'bagging')) {
			const cake = pallet.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			if (!cake || cake.bagging.state !== 'completed' || !cake.bagging.bagged) continue;
			if (!this.processStations.canRelease(this.sectionIds.bagging || '', pallet.palletId).canRelease) continue;
			if (!this.transferPallet(pallet, this.sectionIds.baggingBuffer)) continue;
			this.processStations.release(this.sectionIds.bagging || '', pallet.palletId);
			pallet.stage = 'to-diverter';
			pallet.progress = 0;
			delete pallet.waitingReason;
		}

		const toDiverter = [...this.pallets.values()].filter((pallet) => pallet.stage === 'to-diverter').sort((left, right) => right.progress - left.progress || left.palletId.localeCompare(right.palletId));
		for (const pallet of toDiverter) {
			const path = this.getPreProcessRoutePoints(pallet);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			if (!this.transferPallet(pallet, this.sectionIds.diverter)) {
				continue;
			}
			const loadSlot = pallet.loadSlot ?? 0;
			pallet.stage = loadSlot < 3 ? 'to-gantry-a' : 'to-gantry-b';
			pallet.gantrySlot = loadSlot < 3 ? loadSlot : loadSlot - 3;
			pallet.progress = 0;
		}

		const outbound = [...this.pallets.values()]
			.filter((pallet) => pallet.stage === 'to-gantry-a' || pallet.stage === 'to-gantry-b')
			.sort((left, right) => (right.loadSlot ?? -1) - (left.loadSlot ?? -1) || left.palletId.localeCompare(right.palletId));
		for (const pallet of outbound) {
			const path = this.getOutboundRoutePoints(pallet);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			const lane = pallet.stage === 'to-gantry-a' ? this.gantryLaneA : this.gantryLaneB;
			const preferredIndex = pallet.gantrySlot ?? lane.findIndex((item) => !item);
			const freeIndex = preferredIndex >= 0 && preferredIndex < lane.length && !lane[preferredIndex] ? preferredIndex : -1;
			if (freeIndex < 0) {
				pallet.waitingReason = 'TARGET_SECTION_FULL';
				continue;
			}
			const targetSection = pallet.stage === 'to-gantry-a' ? this.sectionIds.laneA : this.sectionIds.laneB;
			if (!this.transferPallet(pallet, targetSection)) {
				continue;
			}
			lane[freeIndex] = pallet.palletId;
			pallet.gantrySlot = freeIndex;
			pallet.stage = pallet.stage === 'to-gantry-a' ? 'gantry-a' : 'gantry-b';
			pallet.progress = 1;
			delete pallet.loadSlot;
			delete pallet.waitingReason;
		}

		const returning = [...this.pallets.values()]
			.filter((pallet) => pallet.stage === 'returning')
			.sort((left, right) => {
				const coordinate = (pallet: PlasticPalletRuntime) => {
					const path = this.getReturnRoutePoints(pallet);
					return polylineLength(path.slice(0, -1)) - pallet.progress * Math.max(0.001, polylineLength(path));
				};
				return coordinate(left) - coordinate(right)
					|| (left.returnSequence ?? Number.MAX_SAFE_INTEGER) - (right.returnSequence ?? Number.MAX_SAFE_INTEGER)
					|| left.palletId.localeCompare(right.palletId);
			});
		// 下置短回流与整线长回流在机器人前共用同一个物理合流点。短回流托盘接近或正在
		// 穿越合流点时，长回流队首必须停在合流点前的安全节距外；否则两路队首会各自按
		// 1.5m 防碰撞规则停车，形成谁也无法进入合流点的几何死锁。
		const shortReturnHasMergePriority = [...this.pallets.values()].some((pallet) =>
			pallet.stage === 'empty-return-rise'
			|| (pallet.stage === 'returning' && pallet.returnFrom === 'empty-bypass' && pallet.progress < 1 - 0.000001));
		returning.forEach((pallet, index) => { pallet.returnQueueIndex = index; });
		this.assignReturnLoadingSlots(returning);
		let previousReturnCoordinate: number | undefined;
		for (const pallet of returning) {
			const path = this.getReturnRoutePoints(pallet);
			const pathLength = Math.max(0.001, polylineLength(path));
			const distanceToReturnEntry = polylineLength(path.slice(0, -1));
			const preferredLoadSlot = pallet.returnLoadSlot ?? -1;
			const targetOccupied = preferredLoadSlot < 0 || Boolean(this.loadingSlots[preferredLoadSlot]);
			const mustYieldAtMerger = shortReturnHasMergePriority && pallet.returnFrom !== 'empty-bypass';
			const targetMaxProgress = targetOccupied || mustYieldAtMerger ? this.getReturnQueueHoldProgress(pallet, path) : 1;
			// 仅靠欧氏碰撞圆会让直角拐角处的后车在直线上追到 1.5m，随后前车无法转弯。
			// 以“距回流入口的有符号沿线距离”为统一坐标，强制 FIFO 相邻车保持 2.2m 路径节距。
			const convoyMaxProgress = previousReturnCoordinate === undefined
				? 1
				: (distanceToReturnEntry - previousReturnCoordinate - RETURN_CONVOY_GAP) / pathLength;
			const maxProgress = Math.min(targetMaxProgress, convoyMaxProgress);
			// 队首进入上料位后，后续托盘的 queueIndex 与目标槽路径会重新基准化。
			// 若新基准比旧 progress 更严格，必须先回写安全上限，不能让旧归一化进度在同一直线上压缩实体间距。
			if (pallet.progress > maxProgress) pallet.progress = maxProgress;
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters * 0.75, maxProgress);
			previousReturnCoordinate = distanceToReturnEntry - pallet.progress * pathLength;
			if (pallet.progress <= previousProgress + 0.000001 && pallet.progress >= 0) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			if (preferredLoadSlot < 0 || this.loadingSlots[preferredLoadSlot] || !this.transferPallet(pallet, this.sectionIds.loading)) {
				continue;
			}
			this.loadingSlots[preferredLoadSlot] = pallet.palletId;
			pallet.stage = 'loading';
			pallet.loadSlot = preferredLoadSlot;
			pallet.loadAttempted = false;
			pallet.progress = 1;
			pallet.cycleCount += 1;
			delete pallet.gantrySlot;
			delete pallet.returnFrom;
			delete pallet.returnOrder;
			delete pallet.returnSequence;
			delete pallet.returnQueueIndex;
			delete pallet.returnLoadSlot;
		}
	}

	private advanceEmptyReturnStage(stage: 'empty-return-drop' | 'empty-return-main' | 'empty-return-rise', nextStage: 'empty-return-main' | 'empty-return-rise' | 'returning', targetSectionId: string | undefined, travelMeters: number) {
		const pallets = [...this.pallets.values()]
			.filter((pallet) => pallet.stage === stage)
			.sort((left, right) => right.progress - left.progress || left.palletId.localeCompare(right.palletId));
		for (const pallet of pallets) {
			const path = this.getEmptyReturnRoutePoints(stage);
			const previousProgress = pallet.progress;
			this.advancePalletOnPath(pallet, path, travelMeters * 0.8);
			if (pallet.progress <= previousProgress + 0.000001) pallet.waitingReason = 'TARGET_SECTION_FULL';
			else delete pallet.waitingReason;
			if (pallet.progress < 1 - 0.000001) continue;
			if (!this.transferPallet(pallet, targetSectionId)) {
				continue;
			}
			pallet.stage = nextStage;
			pallet.progress = 0;
			if (nextStage === 'returning') {
				pallet.returnFrom = 'empty-bypass';
				pallet.returnOrder = 0;
			}
			delete pallet.waitingReason;
		}
	}

	private tryStartGantryBatch() {
		if (this.gantryTask.state !== 'idle') return;
		if (!this.activeWoodPallet || this.activeWoodPallet.layer >= WOOD_MAX_LAYERS) return;
		const palletIds = [...this.gantryLaneA, ...this.gantryLaneB].filter((item): item is string => Boolean(item));
		if (palletIds.length !== GANTRY_BATCH) return;
		const pallets = palletIds.map((id) => this.pallets.get(id)).filter(Boolean) as PlasticPalletRuntime[];
		const isProcessComplete = (pallet: PlasticPalletRuntime) => {
			const cake = pallet.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			return Boolean(pallet.loaded && cake && cake.quality === 'normal'
				&& cake.appearanceInspection.state === 'completed' && cake.appearanceInspection.result === 'pass'
				&& cake.bagging.state === 'completed' && cake.bagging.bagged);
		};
		if (pallets.some((item) => !isProcessComplete(item))) return;
		this.gantryTask = {
			state: 'picking',
			progress: 0,
			palletIds,
			silkCakeIds: pallets.map((item) => item.silkCakeId!),
			targetLayer: this.activeWoodPallet.layer,
			attachedAtPick: false,
			attachedAtPlace: false,
		};
	}

	private updateGantry(deltaSeconds: number) {
		if (this.gantryTask.state === 'idle') {
			this.gantryCarriage.position.copy(resolveGantryPose(1, 0).carriage);
			this.gantryLift.position.y = 0;
			return;
		}
		const duration = Math.max(0.2, this.options.gantryCycleSeconds);
		this.gantryTask.progress = clamp01(this.gantryTask.progress + deltaSeconds / duration);
		const p = this.gantryTask.progress;
		const pose = resolveGantryPose(p, this.gantryTask.targetLayer);
		this.gantryCarriage.position.copy(pose.carriage);
		this.gantryLift.position.y = 0;
		this.gantryCarriage.userData.motionPhase = pose.phase;
		this.gantryCarriage.userData.targetLayer = this.gantryTask.targetLayer;
		this.gantryCarriage.userData.safeCarriageY = pose.safeCarriageY;
		this.gantryCarriage.userData.placeCarriageY = pose.placeCarriageY;
		if (!this.gantryTask.attachedAtPick && p >= pose.attachAt) {
			this.gantryTask.attachedAtPick = true;
			for (const silkCakeId of this.gantryTask.silkCakeIds) {
				const cake = this.cakes.get(silkCakeId);
				if (!cake) continue;
				this.gantryGripper.attach(cake.root);
				cake.state = 'gantry-picking';
			}
		}
		if (this.gantryTask.attachedAtPick && !this.gantryTask.attachedAtPlace) {
			// 夹具从两条辊道的 2×3 取料节距平滑收拢到木托盘 2×3 堆叠节距，
			// 六个丝饼始终保持两行三列拓扑，不会在空中合并或互穿。
			for (let index = 0; index < this.gantryTask.silkCakeIds.length; index += 1) {
				const cake = this.cakes.get(this.gantryTask.silkCakeIds[index]);
				if (!cake || cake.root.parent !== this.gantryGripper) continue;
				const row = Math.floor(index / 3);
				const column = index % 3;
				cake.root.position.set(
					THREE.MathUtils.lerp(-1.8 + column * 1.8, -1.55 + column * 1.55, pose.patternCompression),
					-0.3,
					THREE.MathUtils.lerp(-1.7 + row * 3.4, -0.68 + row * 1.36, pose.patternCompression),
				);
			}
		}
		if (!this.gantryTask.attachedAtPlace && p >= pose.placeAt && this.activeWoodPallet) {
			this.gantryTask.attachedAtPlace = true;
			this.placeGantryLayer(this.activeWoodPallet);
		}
		if (p >= 1) this.finishGantryBatch();
	}

	private placeGantryLayer(wood: WoodenPalletRuntime) {
		const layer = this.gantryTask.targetLayer;
		for (let index = 0; index < this.gantryTask.silkCakeIds.length; index += 1) {
			const silkCakeId = this.gantryTask.silkCakeIds[index];
			const cake = this.cakes.get(silkCakeId);
			if (!cake) continue;
			wood.stackAnchor.attach(cake.root);
			const row = Math.floor(index / 3);
			const column = index % 3;
			cake.root.position.set(-1.55 + column * 1.55, 0.36 + layer * 0.46, -0.68 + row * 1.36);
			cake.root.rotation.set(0, 0, 0);
			cake.state = 'on-wood-pallet';
			wood.silkCakeIds.push(silkCakeId);
		}
		wood.layer += 1;
	}

	private finishGantryBatch() {
		const returnPlans = this.gantryTask.palletIds.map((palletId) => {
			const pallet = this.pallets.get(palletId)!;
			const fromLane: 'A' | 'B' = pallet.stage === 'gantry-a' ? 'A' : 'B';
			pallet.returnFrom = fromLane;
			const pathToMerger = fromLane === 'A'
				? [GANTRY_LANE_A_POSITIONS[pallet.gantrySlot ?? 2], this.getRoutePointPosition('silk-gantry', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -7.6)), this.getRoutePointPosition('silk-merger', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -4.2))]
				: [GANTRY_LANE_B_POSITIONS[pallet.gantrySlot ?? 2], this.getRoutePointPosition('silk-merger', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -4.2))];
			return { pallet, fromLane, preMergeDistance: polylineLength(pathToMerger) };
		}).filter((item) => Boolean(item.pallet));
		// 两条支路按“到汇流口的距离”统一编队；同一支路自然保持前车先行，
		// 两支路在 merger 处也严格按 RETURN_CONVOY_GAP 依次通过。
		returnPlans.sort((left, right) => left.preMergeDistance - right.preMergeDistance || left.pallet.palletId.localeCompare(right.pallet.palletId));
		const baseMergeDistance = Math.max(0, ...returnPlans.map((item) => item.preMergeDistance));
		for (let returnOrder = 0; returnOrder < returnPlans.length; returnOrder += 1) {
			const { pallet, fromLane, preMergeDistance } = returnPlans[returnOrder];
			pallet.loaded = false;
			pallet.loadAttempted = false;
			delete pallet.silkCakeId;
			pallet.cakeAnchor.clear();
			const lane = fromLane === 'A' ? this.gantryLaneA : this.gantryLaneB;
			const index = lane.indexOf(pallet.palletId);
			if (index >= 0) lane[index] = undefined;
			if (this.transferPallet(pallet, this.sectionIds.returning)) {
				pallet.returnOrder = returnOrder;
				pallet.returnSequence = this.returnSequence++;
				// 回流从上料线左端进入，最前面的托盘先进入最远的 5 号位，后车依次停靠，禁止穿过已停托盘。
				pallet.returnLoadSlot = ROBOT_BATCH - 1 - returnOrder;
				pallet.stage = 'returning';
				const returnPath = this.getReturnRoutePoints(pallet);
				const waitDistance = Math.max(0, baseMergeDistance + returnOrder * RETURN_CONVOY_GAP - preMergeDistance);
				pallet.progress = -waitDistance / Math.max(0.001, polylineLength(returnPath));
			}
		}
		if (this.activeWoodPallet && this.activeWoodPallet.layer >= WOOD_MAX_LAYERS) {
			this.activeWoodPallet.stage = 'covering';
			this.activeWoodPallet.progress = 0;
			this.woodProcessQueue.push(this.activeWoodPallet);
			this.activeWoodPallet = undefined;
			this.woodFeedElapsed = 0;
		}
		this.gantryTask = this.createIdleGantryTask();
	}

	private updateWoodPostProcess(deltaSeconds: number) {
		for (const wood of this.woodProcessQueue) {
			if (wood.stage === 'stored') continue;
			const duration = wood.stage === 'covering' ? this.options.coverCycleSeconds
				: wood.stage === 'labeling' ? this.options.labelCycleSeconds
					: wood.stage === 'wrapping' ? this.options.wrappingCycleSeconds
						: wood.stage === 'inbound' ? this.options.warehouseInboundCycleSeconds : 1;
			wood.progress = clamp01(wood.progress + deltaSeconds / duration);
			if (wood.stage === 'covering') {
				lerpPose(wood.root, WOOD_STACK_POSITION, COVER_POSITION, wood.progress);
				this.coverGantryHead.position.y = -Math.sin(wood.progress * Math.PI) * 0.8;
				if (wood.progress >= 1) {
					this.attachCover(wood);
					wood.coverApplied = true;
					wood.stage = 'labeling';
					wood.progress = 0;
				}
				continue;
			}
			if (wood.stage === 'labeling') {
				lerpPose(wood.root, COVER_POSITION, LABEL_POSITION, wood.progress);
				if (wood.progress >= 1) {
					this.attachLabel(wood);
					wood.labelApplied = true;
					wood.stage = 'wrapping';
					wood.progress = 0;
				}
				continue;
			}
			if (wood.stage === 'wrapping') {
				lerpPose(wood.root, LABEL_POSITION, WRAP_POSITION, Math.min(1, wood.progress * 0.25));
				this.wrapperFilm.visible = true;
				this.wrapperFilm.rotation.y += deltaSeconds * 2.5;
				if (wood.progress >= 1) {
					wood.wrapped = true;
					wood.stage = 'inbound';
					wood.progress = 0;
					this.wrapperFilm.visible = false;
				}
				continue;
			}
			if (wood.stage === 'inbound') {
				lerpPose(wood.root, WRAP_POSITION, INBOUND_POSITION, wood.progress);
				if (wood.progress >= 1) {
					wood.stage = 'stored';
					wood.progress = 1;
					wood.root.position.copy(STORED_POSITION).add(new THREE.Vector3(0, this.storedWoodPallets.length * 0.08, 0));
					for (const id of wood.silkCakeIds) {
						const cake = this.cakes.get(id);
						if (cake) cake.state = 'stored';
					}
					this.storedWoodPallets.push(wood);
				}
			}
		}
		for (let index = this.woodProcessQueue.length - 1; index >= 0; index -= 1) {
			if (this.woodProcessQueue[index].stage === 'stored') this.woodProcessQueue.splice(index, 1);
		}
	}

	private attachCover(wood: WoodenPalletRuntime) {
		if (wood.root.getObjectByName('TopCover')) return;
		const cover = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.12, 2.35), this.coverMaterial);
		cover.name = 'TopCover';
		cover.position.y = 0.45 + WOOD_MAX_LAYERS * 0.46;
		wood.root.add(cover);
	}

	private attachLabel(wood: WoodenPalletRuntime) {
		if (wood.root.getObjectByName('PackageLabel')) return;
		const label = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.65), this.labelMaterial);
		label.name = 'PackageLabel';
		label.position.set(2.36, 2.1, 0);
		label.rotation.y = Math.PI / 2;
		wood.root.add(label);
	}

	private getRoutePointPosition(pointId: string, fallback: THREE.Vector3) {
		const point = this.route.points.find((item) => item.pointId === pointId);
		return point ? new THREE.Vector3(point.position[0], point.position[1], point.position[2]) : fallback.clone();
	}

	private getPreProcessRoutePoints(pallet: PlasticPalletRuntime) {
		if (pallet.stage === 'to-load-check') {
			const from = pallet.loadSlot !== undefined ? LOAD_SLOT_POSITIONS[pallet.loadSlot] : LOAD_SLOT_POSITIONS[5];
			return [
				from,
				this.getRoutePointPosition('silk-buffer', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.lineZ)),
			];
		}
		if (pallet.stage === 'to-external-inspection') return [
			this.getRoutePointPosition('silk-buffer', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.lineZ)),
			this.getRoutePointPosition('silk-external-inspection', new THREE.Vector3(silkLineLayout.externalInspectionX, 0.94, silkLineLayout.lineZ)),
		];
		if (pallet.stage === 'to-bagging') return [
			this.getRoutePointPosition('silk-external-inspection', new THREE.Vector3(silkLineLayout.externalInspectionX, 0.94, silkLineLayout.lineZ)),
			this.getRoutePointPosition('silk-inspection-out-buffer', new THREE.Vector3(silkLineLayout.inspectionBufferX, 0.94, silkLineLayout.lineZ)),
			this.getRoutePointPosition('silk-bagging', new THREE.Vector3(silkLineLayout.baggingX, 0.94, silkLineLayout.lineZ)),
		];
		return [
			this.getRoutePointPosition('silk-bagging', new THREE.Vector3(silkLineLayout.baggingX, 0.94, silkLineLayout.lineZ)),
			this.getRoutePointPosition('silk-bagging-out-buffer', new THREE.Vector3(silkLineLayout.baggingBufferX, 0.94, silkLineLayout.lineZ)),
			this.getRoutePointPosition('silk-diverter', new THREE.Vector3(silkLineLayout.diverterX, 0.94, silkLineLayout.lineZ)),
		];
	}

	private getEmptyReturnRoutePoints(stage: 'empty-return-drop' | 'empty-return-main' | 'empty-return-rise') {
		const diverter = this.getRoutePointPosition('silk-buffer', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.lineZ));
		const southEast = this.getRoutePointPosition('silk-empty-return-southeast', new THREE.Vector3(silkLineLayout.loadBufferX, 0.94, silkLineLayout.emptyReturnZ));
		const southWest = this.getRoutePointPosition('silk-empty-return-southwest', new THREE.Vector3(silkLineLayout.emptyReturnWestX, 0.94, silkLineLayout.emptyReturnZ));
		const merger = this.getRoutePointPosition('silk-source', RETURN_ENTRY);
		if (stage === 'empty-return-drop') return [diverter, southEast];
		if (stage === 'empty-return-main') return [southEast, southWest];
		return [southWest, merger];
	}

	private getOutboundRoutePoints(pallet: PlasticPalletRuntime) {
		const from = this.getRoutePointPosition('silk-diverter', new THREE.Vector3(silkLineLayout.diverterX, 0.94, silkLineLayout.lineZ));
		const isLaneA = pallet.stage === 'to-gantry-a';
		const lanePositions = isLaneA ? GANTRY_LANE_A_POSITIONS : GANTRY_LANE_B_POSITIONS;
		const target = lanePositions[pallet.gantrySlot ?? 2];
		const laneEntry = this.getRoutePointPosition(isLaneA ? 'silk-left-buffer' : 'silk-right-buffer', new THREE.Vector3(22.8, 0.94, isLaneA ? -7.6 : -4.2));
		return [from, laneEntry, target];
	}

	private getReturnRoutePoints(pallet: PlasticPalletRuntime) {
		const slot = pallet.gantrySlot ?? 2;
		const gantryExit = this.getRoutePointPosition('silk-gantry', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -7.6));
		const merger = this.getRoutePointPosition('silk-merger', new THREE.Vector3(silkLineLayout.gantryExitX, 0.94, -4.2));
		const east = this.getRoutePointPosition('silk-return-east', RETURN_EAST_LOWER);
		const northEast = this.getRoutePointPosition('silk-return-northeast', RETURN_CORNER_EAST);
		const west = this.getRoutePointPosition('silk-return-west', RETURN_CORNER_WEST);
		const southWest = this.getRoutePointPosition('silk-return-southwest', RETURN_WEST_LOWER);
		const returnEntry = this.getRoutePointPosition('silk-source', RETURN_ENTRY);
		const target = LOAD_SLOT_POSITIONS[pallet.returnLoadSlot ?? 0];
		if (pallet.returnFrom === 'empty-bypass') {
			return [returnEntry, target];
		}
		if (pallet.returnFrom === 'buffer') return [merger, east, northEast, west, southWest, returnEntry, target];
		const start = pallet.returnFrom === 'A' ? GANTRY_LANE_A_POSITIONS[slot] : GANTRY_LANE_B_POSITIONS[slot];
		return pallet.returnFrom === 'A'
			? [start, gantryExit, merger, east, northEast, west, southWest, returnEntry, target]
			: [start, merger, east, northEast, west, southWest, returnEntry, target];
	}

	private getPalletPlannedPosition(pallet: PlasticPalletRuntime) {
		if (pallet.stage === 'loading' && pallet.loadSlot !== undefined) return LOAD_SLOT_POSITIONS[pallet.loadSlot].clone();
		if (pallet.stage === 'to-load-check' || pallet.stage === 'to-external-inspection' || pallet.stage === 'to-bagging' || pallet.stage === 'to-diverter') return pointOnPolyline(this.getPreProcessRoutePoints(pallet), pallet.progress);
		if (pallet.stage === 'empty-return-drop' || pallet.stage === 'empty-return-main' || pallet.stage === 'empty-return-rise') return pointOnPolyline(this.getEmptyReturnRoutePoints(pallet.stage), pallet.progress);
		if (pallet.stage === 'external-inspection') return this.getRoutePointPosition('silk-external-inspection', new THREE.Vector3(silkLineLayout.externalInspectionX, 0.94, silkLineLayout.lineZ));
		if (pallet.stage === 'bagging') return this.getRoutePointPosition('silk-bagging', new THREE.Vector3(silkLineLayout.baggingX, 0.94, silkLineLayout.lineZ));
		if (pallet.stage === 'to-gantry-a' || pallet.stage === 'to-gantry-b') return pointOnPolyline(this.getOutboundRoutePoints(pallet), pallet.progress);
		if (pallet.stage === 'gantry-a' && pallet.gantrySlot !== undefined) return GANTRY_LANE_A_POSITIONS[pallet.gantrySlot].clone();
		if (pallet.stage === 'gantry-b' && pallet.gantrySlot !== undefined) return GANTRY_LANE_B_POSITIONS[pallet.gantrySlot].clone();
		if (pallet.stage === 'returning') return pointOnPolyline(this.getReturnRoutePoints(pallet), pallet.progress);
		return pallet.root.position.clone();
	}

	private isPalletPositionClear(pallet: PlasticPalletRuntime, candidate: THREE.Vector3) {
		return this.getPalletClearanceSquared(pallet, candidate) >= PALLET_MIN_CENTER_GAP * PALLET_MIN_CENTER_GAP - 0.000001;
	}

	private getPalletClearanceSquared(pallet: PlasticPalletRuntime, candidate: THREE.Vector3) {
		let clearanceSquared = Number.POSITIVE_INFINITY;
		for (const other of this.pallets.values()) {
			if (other === pallet || other.stage === 'source-queue') continue;
			const otherPosition = this.getPalletPlannedPosition(other);
			const dx = candidate.x - otherPosition.x;
			const dz = candidate.z - otherPosition.z;
			clearanceSquared = Math.min(clearanceSquared, dx * dx + dz * dz);
		}
		return clearanceSquared;
	}

	private isPalletSweepClear(pallet: PlasticPalletRuntime, from: THREE.Vector3, to: THREE.Vector3) {
		const required = PALLET_MIN_CENTER_GAP * PALLET_MIN_CENTER_GAP - 0.000001;
		const moveX = to.x - from.x;
		const moveZ = to.z - from.z;
		const lengthSquared = moveX * moveX + moveZ * moveZ;
		for (const other of this.pallets.values()) {
			if (other === pallet || other.stage === 'source-queue') continue;
			const point = this.getPalletPlannedPosition(other);
			const projection = lengthSquared <= 0.0000001 ? 0 : THREE.MathUtils.clamp(((point.x - from.x) * moveX + (point.z - from.z) * moveZ) / lengthSquared, 0, 1);
			const nearestX = from.x + moveX * projection;
			const nearestZ = from.z + moveZ * projection;
			const dx = point.x - nearestX;
			const dz = point.z - nearestZ;
			if (dx * dx + dz * dz < required) return false;
		}
		return true;
	}

	private advancePalletOnPath(pallet: PlasticPalletRuntime, points: THREE.Vector3[], travelMeters: number, maxProgress = 1) {
		const length = Math.max(0.001, polylineLength(points));
		const current = pallet.progress;
		const desired = Math.min(maxProgress, current + Math.max(0, travelMeters) / length);
		if (desired <= current + 0.0000001) return;
		const currentPosition = pointOnPolyline(points, current);
		const desiredPosition = pointOnPolyline(points, desired);
		const desiredClearance = this.getPalletClearanceSquared(pallet, desiredPosition);
		if (desiredClearance >= PALLET_MIN_CENTER_GAP * PALLET_MIN_CENTER_GAP - 0.000001 && this.isPalletSweepClear(pallet, currentPosition, desiredPosition)) {
			pallet.progress = desired;
			this.motionThisTick = true;
			return;
		}
		// 在当前位置和目标位置之间二分寻找最后一个安全点，避免把托盘简单退回固定百分比造成不同长度路线间距失真。
		let low = current;
		let high = desired;
		for (let index = 0; index < 14; index += 1) {
			const middle = (low + high) / 2;
			const middlePosition = pointOnPolyline(points, middle);
			if (this.isPalletPositionClear(pallet, middlePosition) && this.isPalletSweepClear(pallet, currentPosition, middlePosition)) low = middle;
			else high = middle;
		}
		pallet.progress = low;
		if (low > current + 0.0000001) this.motionThisTick = true;
	}

	private getReturnQueueHoldProgress(pallet: PlasticPalletRuntime, points: THREE.Vector3[]) {
		const length = Math.max(0.001, polylineLength(points));
		const distanceToReturnEntry = polylineLength(points.slice(0, -1));
		// 队首也必须停在上料位之前一个完整托盘间距；其余托盘沿回流缓存线紧凑排队，
		// 不能因队列超过路径长度而全部压在同一个起点。
		const queueDistance = Math.max(0, distanceToReturnEntry - RETURN_CONVOY_GAP - (pallet.returnQueueIndex ?? pallet.returnOrder ?? 0) * RETURN_BUFFER_GAP);
		return Math.min(1, queueDistance / length);
	}

	private assignReturnLoadingSlots(returning: PlasticPalletRuntime[]) {
		const reserved = new Set<number>();
		for (let index = 0; index < this.loadingSlots.length; index += 1) {
			if (this.loadingSlots[index]) reserved.add(index);
		}
		for (const pallet of returning) {
			let freeSlot = -1;
			for (let index = ROBOT_BATCH - 1; index >= 0; index -= 1) {
				if (!reserved.has(index)) {
					freeSlot = index;
					break;
				}
			}
			if (freeSlot < 0) continue;
			if (pallet.returnLoadSlot === freeSlot) {
				reserved.add(freeSlot);
				continue;
			}
			const oldPath = this.getReturnRoutePoints(pallet);
			const travelledDistance = pallet.progress * Math.max(0.001, polylineLength(oldPath));
			pallet.returnLoadSlot = freeSlot;
			const newPath = this.getReturnRoutePoints(pallet);
			pallet.progress = travelledDistance / Math.max(0.001, polylineLength(newPath));
			reserved.add(freeSlot);
		}
	}

	private applyAllPoses() {
		for (let index = 0; index < this.loadingSlots.length; index += 1) {
			const palletId = this.loadingSlots[index];
			if (!palletId) continue;
			const pallet = this.pallets.get(palletId);
			if (pallet) pallet.root.position.copy(LOAD_SLOT_POSITIONS[index]);
		}
		for (const pallet of this.pallets.values()) {
			if (pallet.stage === 'source-queue') {
				const queueIndex = this.sourceQueue.indexOf(pallet.palletId);
				const safeQueueIndex = Math.max(0, queueIndex);
				pallet.root.position.set(-18 - Math.floor(safeQueueIndex / 10) * SOURCE_QUEUE_GAP, 0.94, -13 + (safeQueueIndex % 10) * SOURCE_QUEUE_GAP);
				continue;
			}
			if (pallet.stage === 'to-load-check' || pallet.stage === 'to-external-inspection' || pallet.stage === 'to-bagging' || pallet.stage === 'to-diverter') {
				lerpPolylinePose(pallet.root, this.getPreProcessRoutePoints(pallet), pallet.progress);
				continue;
			}
			if (pallet.stage === 'empty-return-drop' || pallet.stage === 'empty-return-main' || pallet.stage === 'empty-return-rise') {
				lerpPolylinePose(pallet.root, this.getEmptyReturnRoutePoints(pallet.stage), pallet.progress);
				continue;
			}
			if (pallet.stage === 'external-inspection') {
				pallet.root.position.copy(this.getRoutePointPosition('silk-external-inspection', new THREE.Vector3(silkLineLayout.externalInspectionX, 0.94, silkLineLayout.lineZ)));
				continue;
			}
			if (pallet.stage === 'bagging') {
				pallet.root.position.copy(this.getRoutePointPosition('silk-bagging', new THREE.Vector3(silkLineLayout.baggingX, 0.94, silkLineLayout.lineZ)));
				continue;
			}
			if (pallet.stage === 'to-gantry-a' || pallet.stage === 'to-gantry-b') {
				lerpPolylinePose(pallet.root, this.getOutboundRoutePoints(pallet), pallet.progress);
				continue;
			}
			if (pallet.stage === 'gantry-a' && pallet.gantrySlot !== undefined) pallet.root.position.copy(GANTRY_LANE_A_POSITIONS[pallet.gantrySlot]);
			if (pallet.stage === 'gantry-b' && pallet.gantrySlot !== undefined) pallet.root.position.copy(GANTRY_LANE_B_POSITIONS[pallet.gantrySlot]);
			if (pallet.stage === 'returning') {
				lerpPolylinePose(pallet.root, this.getReturnRoutePoints(pallet), pallet.progress);
			}
		}
		if (this.activeWoodPallet?.stage === 'stacking') this.activeWoodPallet.root.position.copy(WOOD_STACK_POSITION);
	}

	private createIdleRobotTask(): RobotTaskRuntime {
		return { state: 'idle', progress: 0, side: this.currentSide, row: this.currentRow, palletIds: [], silkCakeIds: [], attachedAtPick: false, attachedAtPlace: false, skipLoading: false };
	}

	private createIdleGantryTask(): GantryTaskRuntime {
		return { state: 'idle', progress: 0, palletIds: [], silkCakeIds: [], targetLayer: 0, attachedAtPick: false, attachedAtPlace: false };
	}
}
