import * as THREE from 'three';
import type { SilkLineSimulationOptions, TwinEquipmentType, TwinRouteDefinition, TwinRouteEdgeDefinition } from '../contracts';
import type { TwinRouteRoutingContext } from '../routes/RouteEngine';
import { TwinMaterialFlowRuntime, type TwinFlowWaitingReason } from './TwinMaterialFlowRuntime';
import { resolveGantryPose } from './GantryPoseResolver';
import { ProcessStationManager } from './ProcessStationManager';
import { createProcessStationVisual } from './ProcessStationVisualFactory';
import { silkLineLayout } from './SilkLineLayout';
import { TwinSectionGeometryResolver } from './TwinSectionGeometryResolver';
import { LabelingMachineComponent, SilkGantryComponent, TopCoverGantryComponent, WrapperMachineComponent } from '../components/PackagingLineComponents';
import { PACKAGING_WOOD_PALLET_LENGTH, PACKAGING_WOOD_PALLET_WIDTH } from '../components/PackagingLineDimensions';

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
	pickCenterWorld?: THREE.Vector3;
	pickApproachWorld?: THREE.Vector3;
	placeCenterWorld?: THREE.Vector3;
	pickLocalPositions: THREE.Vector3[];
	pickLocalQuaternions: THREE.Quaternion[];
}

interface GantryTaskRuntime {
	state: 'idle' | 'picking' | 'separator';
	progress: number;
	palletIds: string[];
	silkCakeIds: string[];
	targetLayer: number;
	attachedAtPick: boolean;
	attachedAtPlace: boolean;
	separatorSourceIndex?: number;
}

interface WoodenPalletRuntime {
	woodenPalletId: string;
	root: THREE.Group;
	stackAnchor: THREE.Group;
	stage: WoodStage;
	progress: number;
	layer: number;
	silkCakeIds: string[];
	separatorCount: number;
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
		separatorCount: number;
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
const ROBOT_AXIS_COUNT = 6;
const ROBOT_BASE_AXIS_Y = 0.78;
const ROBOT_SHOULDER_OFFSET_Y = 0.30;
const ROBOT_SHOULDER_Y = ROBOT_BASE_AXIS_Y + ROBOT_SHOULDER_OFFSET_Y;
const ROBOT_UPPER_ARM_LENGTH = 3.00;
const ROBOT_FOREARM_LENGTH = 2.80;
// 1×6 抓头中心位于横梁原点下方约 0.20m；取丝时让抓头中心与丝锭轴线等高，
// TCP 本身只需高出丝锭中心 0.20m，而不是从丝锭上方垂直抓取。
const ROBOT_PICK_APPROACH_DISTANCE = 1.25;
const ROBOT_SILK_HALF_LENGTH = 0.21;
const ROBOT_GRIPPER_HEAD_LENGTH = 0.32;
const ROBOT_GRIPPER_HEAD_CENTER_OFFSET = 0.20;
const ROBOT_GRIPPER_CONTACT_GAP = 0.02;
const ROBOT_GRIPPER_HEAD_TIP_REACH = ROBOT_GRIPPER_HEAD_CENTER_OFFSET + ROBOT_GRIPPER_HEAD_LENGTH / 2;
const ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE = ROBOT_GRIPPER_HEAD_TIP_REACH + ROBOT_GRIPPER_CONTACT_GAP + ROBOT_SILK_HALF_LENGTH;
const ROBOT_PLACE_TCP_OFFSET_Y = ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE;
const ROBOT_SAFE_TCP_Y = 4.65;
// 1×6 抓具横梁宽 6.2m，高位换向时不能用“丝车侧 -> 托盘侧”的直线弦穿过机器人本体。
// 先沿当前射线退到安全半径，再围绕 J1 基座旋转，最后才向辊道侧伸臂。
const ROBOT_BASE_TRANSFER_CLEARANCE_RADIUS = 3.75;
const ROBOT_TRANSFER_SWING_RADIUS = 4.10;
const GANTRY_ROWS = 2;
const GANTRY_COLUMNS = 3;
const GANTRY_BATCH = GANTRY_ROWS * GANTRY_COLUMNS;
const WOOD_MAX_LAYERS = 8;
const SILK_PER_WOOD_PALLET = GANTRY_BATCH * WOOD_MAX_LAYERS;
// 8 层满托包络：木托盘根节点在 y=0.72，StackAnchor 在 +0.24；
// 第 8 层丝饼中心 = 0.36 + 7*0.46，丝饼半高 0.21。
const WOOD_FULL_STACK_SILK_TOP_Y = 0.72 + 0.24 + 0.36 + (WOOD_MAX_LAYERS - 1) * 0.46 + 0.21;
const SEPARATOR_BOARD_THICKNESS = 0.03;
const WOOD_FULL_STACK_SEPARATOR_TOP_Y = WOOD_FULL_STACK_SILK_TOP_Y + SEPARATOR_BOARD_THICKNESS;
// 天盖中心相对木托盘根节点 = 0.45 + 8*0.46，厚度 0.12。
const WOOD_COVERED_PACKAGE_TOP_Y = 0.72 + 0.45 + WOOD_MAX_LAYERS * 0.46 + 0.06;
const WOOD_PACKAGE_HALF_X = 2.35;
const WOOD_PACKAGE_HALF_Z = 1.24;
const POST_PROCESS_SAFETY_CLEARANCE = 0.65;
const POST_PROCESS_PORTAL_TOP_Y = WOOD_COVERED_PACKAGE_TOP_Y + POST_PROCESS_SAFETY_CLEARANCE + 0.18;
const POST_PROCESS_PORTAL_HALF_SPAN_Z = WOOD_PACKAGE_HALF_Z + 0.42;
const GANTRY_MODEL_LENGTH_X = 8.2;
const GANTRY_MODEL_LENGTH_Z = 27.0;
const GANTRY_MODEL_HEIGHT = 8.4;
const GANTRY_RAIL_Y = GANTRY_MODEL_HEIGHT - 0.13;
const GANTRY_BRIDGE_Y = GANTRY_MODEL_HEIGHT;
const GANTRY_TOOL_STOW_SLIDE_Y = GANTRY_RAIL_Y - 0.60;
const GANTRY_SEPARATOR_BOARD_LOCAL_Y = -0.42;
const GANTRY_SEPARATOR_SAFE_SLIDE_Y = GANTRY_RAIL_Y - 0.48;
// 桁架整机安装中心必须对准木托盘码垛位；夹具沿 Z 向双轨去取丝/取隔板，桁架本体不跟着取丝位置偏移。
const GANTRY_FRAME_CENTER_X = silkLineLayout.woodPalletX;
const GANTRY_FRAME_CENTER_Z = -11.0;
const GANTRY_FRAME_X0 = GANTRY_FRAME_CENTER_X - GANTRY_MODEL_LENGTH_X / 2;
const GANTRY_FRAME_X1 = GANTRY_FRAME_CENTER_X + GANTRY_MODEL_LENGTH_X / 2;
const GANTRY_FRAME_Z0 = GANTRY_FRAME_CENTER_Z - GANTRY_MODEL_LENGTH_Z / 2;
const GANTRY_FRAME_Z1 = GANTRY_FRAME_CENTER_Z + GANTRY_MODEL_LENGTH_Z / 2;
const GANTRY_SHARED_RAIL_PAIR_ID = 'SilkGantry-Shared-Rail-Pair';
// 丝锭夹具的取丝工作位在两条 3 位塑料托盘线之间，属于桥式小车行程，不是桁架安装中心。
const GANTRY_SILK_HOME_X = GANTRY_FRAME_CENTER_X;
const GANTRY_SILK_HOME_Z = (-7.6 + -4.2) / 2;
// 隔板夹具默认停在第一个隔板暂存台上方；组件模型内第一个暂存台局部 Z=-5.6。
const GANTRY_SEPARATOR_HOME_X = GANTRY_FRAME_CENTER_X;
const GANTRY_SEPARATOR_HOME_Z = GANTRY_FRAME_CENTER_Z - 5.6;
const COVER_GANTRY_RAIL_Y = POST_PROCESS_PORTAL_TOP_Y + 0.30;
const COVER_GANTRY_MODEL_LENGTH_X = 7.05;
const COVER_GANTRY_MODEL_LENGTH_Z = 10.5;
// 组件内橙色轨道中心 Y = height - 0.13；保持替换前天盖工位的实际净空不变。
const COVER_GANTRY_MODEL_HEIGHT = COVER_GANTRY_RAIL_Y + 0.13;
const COVER_GANTRY_BRIDGE_Y = COVER_GANTRY_MODEL_HEIGHT;
const COVER_GANTRY_Z_POSITIVE_END = 2.85;
const COVER_GANTRY_Z_NEGATIVE_END = COVER_GANTRY_Z_POSITIVE_END - COVER_GANTRY_MODEL_LENGTH_Z;
const COVER_GANTRY_STOCK_Z = COVER_GANTRY_Z_NEGATIVE_END + PACKAGING_WOOD_PALLET_WIDTH / 2 + 0.55;
const COVER_WAIT_LOCAL = new THREE.Vector3(0, COVER_GANTRY_RAIL_Y - 0.72, 0);
const COVER_STOCK_LOCAL = new THREE.Vector3(0, COVER_GANTRY_RAIL_Y - 0.72, COVER_GANTRY_STOCK_Z);

const LOAD_SLOT_POSITIONS = Array.from({ length: ROBOT_BATCH }, (_, index) => new THREE.Vector3(-10 + index * 1.55, 0.94, -5.8));
const GANTRY_LANE_A_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(GANTRY_FRAME_CENTER_X + (index - 1) * 1.8, 0.94, -7.6));
const GANTRY_LANE_B_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(GANTRY_FRAME_CENTER_X + (index - 1) * 1.8, 0.94, -4.2));
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
const smooth01 = (value: number) => {
	const clamped = clamp01(value);
	return clamped * clamped * (3 - 2 * clamped);
};
const averageVectors = (vectors: THREE.Vector3[]) => {
	if (!vectors.length) return new THREE.Vector3();
	return vectors.reduce((sum, vector) => sum.add(vector), new THREE.Vector3()).multiplyScalar(1 / vectors.length);
};
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
	private readonly topCoverMaterial = new THREE.MeshStandardMaterial({ color: 0x9b6a3c, roughness: 0.92, metalness: 0 });
	private readonly labelMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x111111, roughness: 0.9, metalness: 0 });
	private readonly wrapMaterial = new THREE.MeshStandardMaterial({ color: 0xdbeafe, transparent: true, opacity: 0.22, roughness: 0.16, metalness: 0.02, side: THREE.DoubleSide });

	private readonly silkCartRoot = new THREE.Group();
	private readonly silkCartBody = new THREE.Group();
	private readonly rotaryCell = new THREE.Group();
	private readonly rotaryDisc = new THREE.Group();
	private readonly robotRoot = new THREE.Group();
	private readonly robotAxis1 = new THREE.Group();
	private readonly robotShoulder = new THREE.Group();
	private readonly robotElbow = new THREE.Group();
	private readonly robotWristRoll = new THREE.Group();
	private readonly robotWristPitch = new THREE.Group();
	private readonly robotWrist = new THREE.Group();
	private readonly robotRowGripper = new THREE.Group();
	private readonly robotGripperHeads: THREE.Group[] = [];
	private gantryRoot = new THREE.Group();
	private gantryCarriage = new THREE.Group();
	private gantryTrolley = new THREE.Group();
	private gantrySeparatorCarriage = new THREE.Group();
	private gantrySeparatorTrolley = new THREE.Group();
	private gantryLift = new THREE.Group();
	private gantryGripper = new THREE.Group();
	private gantrySeparatorLift = new THREE.Group();
	private gantrySeparatorGripper = new THREE.Group();
	private gantryGuide?: THREE.Mesh;
	private gantrySlideBar?: THREE.Mesh;
	private gantrySeparatorGuide?: THREE.Mesh;
	private gantrySeparatorSlideBar?: THREE.Mesh;
	private readonly separatorFeeders: THREE.Group[] = [];
	private gantryServoOverrides: { silkZ?: number; separatorZ?: number } = {};
	private activeSeparatorBoard?: THREE.Mesh;
	private readonly coverStationRoot = new THREE.Group();
	private coverGantryBridge = new THREE.Group();
	private coverGantryTrolley = new THREE.Group();
	private coverGantrySlide = new THREE.Group();
	private coverGantryHead = new THREE.Group();
	private coverStockTable = new THREE.Group();
	private coverGantryState: 'waiting' | 'placing' | 'reload-to-stock' | 'reload-pick' | 'reload-return' = 'waiting';
	private coverGantryProgress = 0;
	private activeCoverBlank?: THREE.Mesh;
	private coverTargetWood?: WoodenPalletRuntime;
	private readonly labelStationRoot = new THREE.Group();
	private labelArmJoint1 = new THREE.Group();
	private labelArmJoint2 = new THREE.Group();
	private labelArmJoint3 = new THREE.Group();
	private labelTampPad = new THREE.Group();
	private readonly wrapperStationRoot = new THREE.Group();
	private wrapperRotaryArm = new THREE.Group();
	private wrapperFilmCarriage = new THREE.Group();
	private wrapperFilmCarriageHomeY = 0;
	private readonly wrapperFilm = new THREE.Group();
	private readonly inboundLiftRoot = new THREE.Group();
	private readonly inboundLiftPlatform = new THREE.Group();

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
	private readonly woodSectionGeometry?: TwinSectionGeometryResolver;

	constructor(route: TwinRouteDefinition, palletCount = 80, options: Partial<SilkLineSimulationOptions> = {}, visualOptions: {
		renderLegacyPlasticConveyors?: boolean;
		renderLegacyPreProcessStations?: boolean;
		renderLegacyGantryConveyors?: boolean;
		renderLegacyPostProcessConveyor?: boolean;
		woodPackagingRoute?: TwinRouteDefinition;
	} = {}) {
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
		if (visualOptions.woodPackagingRoute) this.woodSectionGeometry = new TwinSectionGeometryResolver(visualOptions.woodPackagingRoute);
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
		this.buildGantryCell(visualOptions.renderLegacyGantryConveyors !== false);
		this.buildPostProcessLine(visualOptions.renderLegacyPostProcessConveyor !== false);
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

	/** 两套夹具共用 Z 向橙色双轨，丝锭/隔板行走位置由独立伺服轴输入。silkX/separatorX 仅保留旧调用兼容。 */
	setGantryServoPositions(positions?: { silkZ?: number | null; separatorZ?: number | null; silkX?: number | null; separatorX?: number | null }) {
		if (!positions) { this.gantryServoOverrides = {}; this.updateGantry(0); return; }
		let cleared = false;
		const updateAxis = (target: 'silkZ' | 'separatorZ', primary: 'silkZ' | 'separatorZ', legacy: 'silkX' | 'separatorX') => {
			const hasPrimary = Object.prototype.hasOwnProperty.call(positions, primary);
			const hasLegacy = Object.prototype.hasOwnProperty.call(positions, legacy);
			if (!hasPrimary && !hasLegacy) return;
			const value = hasPrimary ? positions[primary] : positions[legacy];
			if (value === null || value === undefined) { delete this.gantryServoOverrides[target]; cleared = true; }
			else if (Number.isFinite(value)) this.gantryServoOverrides[target] = value as number;
		};
		updateAxis('silkZ', 'silkZ', 'silkX');
		updateAxis('separatorZ', 'separatorZ', 'separatorX');
		if (cleared) this.updateGantry(0); else this.applyGantryServoOverrides();
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
		this.gantryServoOverrides = {};
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
		this.activeSeparatorBoard?.removeFromParent();
		this.activeSeparatorBoard = undefined;
		for (const feeder of this.separatorFeeders) feeder.userData.pickCount = 0;
		this.activeCoverBlank?.removeFromParent();
		this.activeCoverBlank = undefined;
		this.coverTargetWood = undefined;
		this.coverGantryState = 'waiting';
		this.coverGantryProgress = 0;
		this.wrapperFilm.visible = false;
		this.wrapperRotaryArm.rotation.y = 0;
		this.wrapperFilmCarriage.position.y = this.wrapperFilmCarriageHomeY;
		this.wrapperStationRoot.userData.wrapperState = 'idle';
		this.ensureCoverLoaded();
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
		for (const cake of this.cakes.values()) cake.root.parent?.remove(cake.root);
		this.cakes.clear();
		this.replaceSilkCart(true);
		this.feedInitialPlasticPallets();
		this.feedNewWoodPallet();
		this.applyAllPoses();
		this.updateRobot(0);
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
		this.updateCoverGantry(deltaSeconds);
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
				separatorCount: this.activeWoodPallet?.separatorCount ?? 0,
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
			const silkCake = pallet?.silkCakeId ? this.cakes.get(pallet.silkCakeId) : undefined;
			return pallet ? {
				palletId: pallet.palletId,
				loaded: pallet.loaded,
				stage: pallet.stage,
				state: pallet.loaded ? 'loaded' : pallet.stage === 'returning' ? 'empty-return' : pallet.stage,
				silkCakeId: pallet.silkCakeId,
				content: silkCake ? {
					silkCakeId: silkCake.silkCakeId,
					state: silkCake.state,
					side: silkCake.side,
					row: silkCake.row + 1,
					column: silkCake.column + 1,
					quality: silkCake.quality,
					appearanceInspection: silkCake.appearanceInspection,
					bagging: silkCake.bagging,
				} : undefined,
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
				silkCakeIds: [...pallet.silkCakeIds],
				separatorCount: pallet.separatorCount,
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
		this.rotaryCell.name = '双面丝车旋转供料单元';
		this.rotaryCell.userData.twinEntityType = 'silk-cart-turntable';
		this.rotaryCell.userData.twinEntityId = 'SilkCartTurntable-01';
		this.rotaryCell.position.set(-6.4, 0, -10.5);
		const base = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.35, 0.35, 40), this.darkFrameMaterial);
		base.position.y = 0.18;
		this.rotaryCell.add(base);
		const discMesh = new THREE.Mesh(new THREE.CylinderGeometry(2.08, 2.08, 0.18, 40), this.safetyMaterial);
		discMesh.position.y = 0.44;
		this.rotaryDisc.add(discMesh);
		this.rotaryCell.add(this.rotaryDisc);
		this.silkCartRoot.name = '丝车';
		this.silkCartRoot.userData.twinEntityType = 'silk-cart';
		this.silkCartRoot.position.y = 0.55;
		this.rotaryDisc.add(this.silkCartRoot);
		this.silkCartRoot.add(this.silkCartBody);
		this.buildSilkCartFrame();
		this.group.add(this.rotaryCell);
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
		this.robotRoot.userData.robotAxisCount = ROBOT_AXIS_COUNT;
		this.robotRoot.position.set(-6.5, 0, -7.9);
		const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.82, 0.6, 24), this.robotJointMaterial);
		pedestal.position.y = 0.3;
		this.robotRoot.add(pedestal);

		this.robotAxis1.name = 'RobotAxis1-BaseYaw';
		this.robotAxis1.position.y = ROBOT_BASE_AXIS_Y;
		const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.58, 0.5, 24), this.robotMaterial);
		this.robotAxis1.add(turret);
		this.robotRoot.add(this.robotAxis1);

		this.robotShoulder.name = 'RobotAxis2-ShoulderPitch';
		this.robotShoulder.position.y = ROBOT_SHOULDER_OFFSET_Y;
		this.robotShoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 18), this.robotJointMaterial));
		const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.48, ROBOT_UPPER_ARM_LENGTH, 0.48), this.robotMaterial);
		upperArm.position.y = ROBOT_UPPER_ARM_LENGTH / 2;
		this.robotShoulder.add(upperArm);
		this.robotAxis1.add(this.robotShoulder);

		this.robotElbow.name = 'RobotAxis3-ElbowPitch';
		this.robotElbow.position.y = ROBOT_UPPER_ARM_LENGTH;
		this.robotElbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.33, 18, 18), this.robotJointMaterial));
		const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.42, ROBOT_FOREARM_LENGTH, 0.42), this.robotMaterial);
		forearm.position.y = ROBOT_FOREARM_LENGTH / 2;
		this.robotElbow.add(forearm);
		this.robotShoulder.add(this.robotElbow);

		this.robotWristRoll.name = 'RobotAxis4-WristRoll';
		this.robotWristRoll.position.y = ROBOT_FOREARM_LENGTH;
		const axis4 = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.34, 18), this.robotJointMaterial);
		this.robotWristRoll.add(axis4);
		this.robotElbow.add(this.robotWristRoll);

		this.robotWristPitch.name = 'RobotAxis5-WristPitch';
		const axis5 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.32, 18), this.robotMaterial);
		axis5.rotation.x = Math.PI / 2;
		this.robotWristPitch.add(axis5);
		this.robotWristRoll.add(this.robotWristPitch);

		this.robotWrist.name = 'RobotAxis6-ToolYaw';
		const axis6 = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.28, 18), this.robotJointMaterial);
		this.robotWrist.add(axis6);
		this.robotWristPitch.add(this.robotWrist);

		this.robotRowGripper.name = 'RobotRowGripper-1x6';
		const rail = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.16, 0.18), this.darkFrameMaterial);
		rail.name = 'RobotRowGripperRail';
		this.robotRowGripper.add(rail);
		for (let index = 0; index < ROBOT_BATCH; index += 1) {
			const head = new THREE.Group();
			head.name = `RobotGripperHead-${index + 1}`;
			head.position.x = -2.75 + index * 1.1;
			const headMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, ROBOT_GRIPPER_HEAD_LENGTH, 16), this.robotJointMaterial);
			headMesh.position.y = -ROBOT_GRIPPER_HEAD_CENTER_OFFSET;
			head.add(headMesh);
			head.userData.headLengthMeters = ROBOT_GRIPPER_HEAD_LENGTH;
			head.userData.headTipReachMeters = ROBOT_GRIPPER_HEAD_TIP_REACH;
			this.robotRowGripper.add(head);
			this.robotGripperHeads.push(head);
		}
		this.robotRowGripper.userData.contactGapMeters = ROBOT_GRIPPER_CONTACT_GAP;
		this.robotRowGripper.userData.contactCenterDistanceMeters = ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE;
		// 夹具是 J6 的真实末端执行器。运行时只给 TCP 目标，六轴链通过 IK 到达目标，
		// 不再让夹具脱离机械臂独立“飞行”。
		this.robotWrist.add(this.robotRowGripper);
		this.group.add(this.robotRoot);
		this.applyRobotTcpTarget(this.getRobotHomeWorld());
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

	private buildGantryCell(renderLegacyConveyors: boolean) {
		const built = new SilkGantryComponent().create({
			definition: {
				objectId: 'GantryStacker-01',
				name: '2×3丝饼码垛桁架',
				resourceKey: 'builtin-silk-gantry',
				componentType: 'silk-gantry',
				generator: 'silk-gantry-v1',
				generatorVersion: 1,
				properties: { length: GANTRY_MODEL_LENGTH_X, width: GANTRY_MODEL_LENGTH_Z, height: GANTRY_MODEL_HEIGHT },
			},
		});
		this.gantryRoot = built.root;
		this.gantryRoot.position.set(GANTRY_FRAME_CENTER_X, 0, GANTRY_FRAME_CENTER_Z);
		this.gantryRoot.userData.twinEntityType = 'gantry-stacker';
		this.gantryRoot.userData.twinEntityId = 'GantryStacker-01';
		this.gantryRoot.userData.sharedRailPairId = GANTRY_SHARED_RAIL_PAIR_ID;
		this.gantryRoot.userData.travelAxis = 'z';
		this.gantryRoot.userData.runtimeModelSource = 'builtin-silk-gantry';
		this.gantryRoot.userData.gantryRailY = GANTRY_RAIL_Y;

		const getGroup = (name: string) => {
			const object = this.gantryRoot.getObjectByName(name);
			if (!(object instanceof THREE.Group)) throw new Error(`Runtime silk gantry missing group: ${name}`);
			return object;
		};
		this.gantryCarriage = getGroup('Gantry-Silk-Rail-Carriage');
		this.gantryTrolley = getGroup('Gantry-Silk-Trolley');
		this.gantryLift = getGroup('Gantry-Z-Slide');
		this.gantryGripper = getGroup('GantryGripper-2x3');
		this.gantrySeparatorCarriage = getGroup('Gantry-Separator-Rail-Carriage');
		this.gantrySeparatorTrolley = getGroup('Gantry-Separator-Trolley');
		this.gantrySeparatorLift = getGroup('Gantry-Separator-Z-Slide');
		this.gantrySeparatorGripper = getGroup('Gantry-Separator-Gripper');
		this.gantryGuide = this.gantryRoot.getObjectByName('Gantry-Z-Guide') as THREE.Mesh;
		this.gantrySlideBar = this.gantryRoot.getObjectByName('Gantry-Z-Slide-Bar') as THREE.Mesh;
		this.gantrySeparatorGuide = this.gantryRoot.getObjectByName('Gantry-Separator-Z-Guide') as THREE.Mesh;
		this.gantrySeparatorSlideBar = this.gantryRoot.getObjectByName('Gantry-Separator-Z-Slide-Bar') as THREE.Mesh;

		this.gantryCarriage.userData.railCarriage = true;
		this.gantryCarriage.userData.servoAxisId = 'Gantry-Silk-Z-Travel';
		this.gantrySeparatorCarriage.userData.railCarriage = true;
		this.gantrySeparatorCarriage.userData.servoAxisId = 'Gantry-Separator-Z-Travel';

		this.separatorFeeders.length = 0;
		for (const [index, category] of (['A', 'B'] as const).entries()) {
			const feeder = this.gantryRoot.getObjectByName(`SeparatorFeeder-${category}`);
			if (!(feeder instanceof THREE.Group)) throw new Error(`Runtime silk gantry missing separator feeder ${category}`);
			feeder.userData.sourceIndex = index;
			feeder.userData.pickCount = 0;
			feeder.userData.pickY = 1.30;
			let pickPoint = feeder.getObjectByName(`SeparatorFeeder-${category}-PickPoint`);
			if (!pickPoint) {
				pickPoint = new THREE.Group();
				pickPoint.name = `SeparatorFeeder-${category}-PickPoint`;
				pickPoint.position.y = Number(feeder.userData.pickY);
				feeder.add(pickPoint);
			}
			this.separatorFeeders.push(feeder);
		}

		if (renderLegacyConveyors) {
			this.addRollerLane(this.group, new THREE.Vector3(22.8, 0.55, -7.6), new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.55, -7.6), 1.5, 'Gantry-Lane-A-3位', 'silk-edge-left-b');
			this.addRollerLane(this.group, new THREE.Vector3(22.8, 0.55, -4.2), new THREE.Vector3(silkLineLayout.gantryLaneEndX, 0.55, -4.2), 1.5, 'Gantry-Lane-B-3位', 'silk-edge-right-b');
			this.addRollerLane(this.group, new THREE.Vector3(22.8, 0.42, WOOD_LANE_Z), new THREE.Vector3(30.4, 0.42, WOOD_LANE_Z), 2.1, 'Gantry-Wood-Pallet-Lane', 'silk-wood-edge-stack');
		}

		markShadow(this.gantryRoot);
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
		for (const z of [-PACKAGING_WOOD_PALLET_WIDTH * 0.34, 0, PACKAGING_WOOD_PALLET_WIDTH * 0.34]) {
			const slat = new THREE.Mesh(new THREE.BoxGeometry(PACKAGING_WOOD_PALLET_LENGTH, 0.14, 0.42), this.woodMaterial);
			slat.position.set(0, 0.12, z);
			root.add(slat);
		}
		for (const x of [-PACKAGING_WOOD_PALLET_LENGTH * 0.38, 0, PACKAGING_WOOD_PALLET_LENGTH * 0.38]) {
			const cross = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, PACKAGING_WOOD_PALLET_WIDTH), this.woodMaterial);
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
			separatorCount: 0,
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

	private buildPostProcessLine(renderLegacyConveyor: boolean) {
		const process = new THREE.Group();
		process.name = '木托盘后包装与立库入库线';
		if (renderLegacyConveyor) this.addRollerLane(process, new THREE.Vector3(30.4, 0.42, WOOD_LANE_Z), new THREE.Vector3(silkLineLayout.inboundX + 1.8, 0.42, WOOD_LANE_Z), 2.2, '满托后包装辊道', 'silk-wood-edge-post-process');
		process.userData.largeConveyorStartX = 30.4;
		process.userData.largeConveyorEndX = silkLineLayout.inboundX + 1.8;
		process.userData.processOrder = ['cover', 'wrap', 'label', 'inbound'];

		this.coverStationRoot.name = '天盖安装机';
		this.coverStationRoot.userData.twinEntityType = 'cover-applicator';
		this.coverStationRoot.userData.twinEntityId = 'CoverApplicator-01';
		this.coverStationRoot.position.set(COVER_POSITION.x, 0, COVER_POSITION.z);
		this.coverStationRoot.userData.requiredPackageTopMeters = WOOD_COVERED_PACKAGE_TOP_Y;
		this.coverStationRoot.userData.portalClearanceMeters = COVER_GANTRY_RAIL_Y - 0.09 - WOOD_COVERED_PACKAGE_TOP_Y;

		// 场景直接复用组件设计器中的最新版天盖桁架，保持天盖工位世界坐标不变，只替换机械模型。
		const builtTopCover = new TopCoverGantryComponent().create({
			definition: {
				objectId: 'TopCoverGantry-01',
				name: '天盖桁架组件',
				resourceKey: 'builtin-top-cover-gantry',
				componentType: 'top-cover-gantry',
				generator: 'top-cover-gantry-v1',
				generatorVersion: 1,
				properties: { length: COVER_GANTRY_MODEL_LENGTH_X, width: COVER_GANTRY_MODEL_LENGTH_Z, height: COVER_GANTRY_MODEL_HEIGHT },
			},
		});
		const topCoverModel = builtTopCover.root;
		topCoverModel.userData.runtimeModelSource = 'builtin-top-cover-gantry';
		topCoverModel.userData.originalStationPosition = [COVER_POSITION.x, 0, COVER_POSITION.z];
		this.coverStationRoot.add(topCoverModel);
		this.coverStationRoot.userData.doubleRail = true;
		this.coverStationRoot.userData.coverRailY = COVER_GANTRY_RAIL_Y;
		this.coverStationRoot.userData.runtimeModelSource = 'builtin-top-cover-gantry';

		const getCoverGroup = (name: string) => {
			const object = topCoverModel.getObjectByName(name);
			if (!(object instanceof THREE.Group)) throw new Error(`Runtime top-cover gantry missing group: ${name}`);
			return object;
		};
		this.coverGantryBridge = getCoverGroup('TopCover-Gantry-Bridge');
		this.coverGantryTrolley = getCoverGroup('TopCover-Gantry-Trolley');
		this.coverGantrySlide = getCoverGroup('TopCover-Gantry-Z-Slide');
		this.coverGantryHead = getCoverGroup('TopCover-Gantry-Gripper');
		this.coverStockTable = getCoverGroup('TopCover-Stock-Table');
		this.coverStockTable.userData.pickCount = 0;
		const stockPickPoint = new THREE.Group();
		stockPickPoint.name = 'TopCover-Stock-PickPoint';
		stockPickPoint.position.y = 1.45;
		this.coverStockTable.add(stockPickPoint);
		const initialCover = this.coverGantryHead.getObjectByName('TopCover-Ready');
		if (initialCover instanceof THREE.Mesh) this.activeCoverBlank = initialCover;
		this.applyCoverGantryPose(COVER_WAIT_LOCAL);
		this.ensureCoverLoaded();

		this.labelStationRoot.name = '贴标机';
		this.labelStationRoot.userData.twinEntityType = 'labeler';
		this.labelStationRoot.userData.twinEntityId = 'Labeler-01';
		this.labelStationRoot.position.set(LABEL_POSITION.x, 0, LABEL_POSITION.z);
		this.labelStationRoot.userData.requiredPackageTopMeters = WOOD_COVERED_PACKAGE_TOP_Y;

		// 场景直接复用组件设计器中的三关节托盘打印贴标机，保持原贴标工位世界坐标不变。
		const builtLabeler = new LabelingMachineComponent().create({
			definition: {
				objectId: 'Labeler-01',
				name: '托盘打印贴标机组件',
				resourceKey: 'builtin-labeling-machine',
				componentType: 'labeling-machine',
				generator: 'labeling-machine-v1',
				generatorVersion: 1,
				properties: { height: 2.40, sideOffset: 1.85, armReach: 0.60 },
			},
		});
		const labelerModel = builtLabeler.root;
		labelerModel.userData.runtimeModelSource = 'builtin-labeling-machine';
		this.labelStationRoot.add(labelerModel);
		this.labelStationRoot.userData.runtimeModelSource = 'builtin-labeling-machine';
		this.labelStationRoot.userData.labelerType = 'pallet-print-apply';
		this.labelStationRoot.userData.loadStationary = true;
		const getLabelGroup = (name: string) => {
			const object = labelerModel.getObjectByName(name);
			if (!(object instanceof THREE.Group)) throw new Error(`Runtime labeler missing group: ${name}`);
			return object;
		};
		this.labelArmJoint1 = getLabelGroup('Labeler-Arm-Joint-1');
		this.labelArmJoint2 = getLabelGroup('Labeler-Arm-Joint-2');
		this.labelArmJoint3 = getLabelGroup('Labeler-Arm-Joint-3');
		this.labelTampPad = getLabelGroup('Labeler-Tamp-Pad');
		this.applyLabelerArmPose(0);

		this.wrapperStationRoot.name = '缠膜机';
		this.wrapperStationRoot.userData.twinEntityType = 'wrapper';
		this.wrapperStationRoot.userData.twinEntityId = 'Wrapper-01';
		this.wrapperStationRoot.position.set(WRAP_POSITION.x, 0, WRAP_POSITION.z);
		this.wrapperStationRoot.userData.requiredPackageTopMeters = WOOD_COVERED_PACKAGE_TOP_Y;

		// 场景直接复用组件设计器中的四立柱悬臂缠膜机，保持原缠膜工位世界坐标不变。
		const wrapperHeight = 6.2;
		const builtWrapper = new WrapperMachineComponent().create({
			definition: {
				objectId: 'WrapperMachine-01',
				name: '四立柱悬臂缠膜机组件',
				resourceKey: 'builtin-wrapper-machine',
				componentType: 'wrapper-machine',
				generator: 'wrapper-machine-v1',
				generatorVersion: 1,
				properties: { height: wrapperHeight, width: 6.8, armRadius: 3.0 },
			},
		});
		const wrapperModel = builtWrapper.root;
		wrapperModel.userData.runtimeModelSource = 'builtin-wrapper-machine';
		wrapperModel.userData.originalStationPosition = [WRAP_POSITION.x, 0, WRAP_POSITION.z];
		this.wrapperStationRoot.add(wrapperModel);
		this.wrapperStationRoot.userData.runtimeModelSource = 'builtin-wrapper-machine';
		this.wrapperStationRoot.userData.wrapperType = 'rotary-arm';
		this.wrapperStationRoot.userData.loadStationary = true;
		this.wrapperStationRoot.userData.wrapperState = 'idle';
		this.wrapperStationRoot.userData.portalClearanceMeters = wrapperHeight - 0.25 - WOOD_COVERED_PACKAGE_TOP_Y;

		const getWrapperGroup = (name: string) => {
			const object = wrapperModel.getObjectByName(name);
			if (!(object instanceof THREE.Group)) throw new Error(`Runtime rotary-arm wrapper missing group: ${name}`);
			return object;
		};
		this.wrapperRotaryArm = getWrapperGroup('Wrapper-Rotary-Arm');
		this.wrapperFilmCarriage = getWrapperGroup('Wrapper-Film-Carriage');
		this.wrapperFilmCarriageHomeY = this.wrapperFilmCarriage.position.y;

		// 透明包膜层只表示已经缠到货物上的薄膜，不再充当设备本体或旋转圆环。
		const film = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.55, 5.20, 32, 1, true), this.wrapMaterial);
		film.name = 'WrapperEnvelope';
		film.position.y = 2.60;
		this.wrapperFilm.add(film);
		this.wrapperFilm.position.set(0, 0, 0);
		this.wrapperFilm.visible = false;
		this.wrapperStationRoot.add(this.wrapperFilm);

		this.inboundLiftRoot.name = '入库提升机';
		this.inboundLiftRoot.userData.twinEntityType = 'inbound-lift';
		this.inboundLiftRoot.userData.twinEntityId = 'InboundLift-01';
		this.inboundLiftRoot.position.set(INBOUND_POSITION.x, 0, INBOUND_POSITION.z);
		const inboundHalfX = WOOD_PACKAGE_HALF_X + 0.35;
		const inboundHalfZ = WOOD_PACKAGE_HALF_Z + 0.32;
		this.inboundLiftRoot.userData.clearanceHalfX = inboundHalfX;
		this.inboundLiftRoot.userData.clearanceHalfZ = inboundHalfZ;
		for (const x of [-inboundHalfX, inboundHalfX]) for (const z of [-inboundHalfZ, inboundHalfZ]) {
			const rail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 6.1, 0.18), this.frameMaterial);
			rail.name = `InboundLift-Guide-${x > 0 ? 'R' : 'L'}-${z > 0 ? 'F' : 'B'}`;
			rail.position.set(x, 3.05, z);
			this.inboundLiftRoot.add(rail);
		}
		this.inboundLiftPlatform.name = '提升机轿厢平台';
		const liftDeck = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.2, 2.7), this.safetyMaterial);
		liftDeck.position.y = 0.58;
		this.inboundLiftPlatform.add(liftDeck);
		this.inboundLiftRoot.add(this.inboundLiftPlatform);

		this.group.add(this.coverStationRoot, this.labelStationRoot, this.wrapperStationRoot, this.inboundLiftRoot);
		this.buildWarehouse(process);
		this.group.add(process);
	}

	private addProcessPortal(parent: THREE.Group, name: string, color: number, topY = POST_PROCESS_PORTAL_TOP_Y, halfSpanZ = POST_PROCESS_PORTAL_HALF_SPAN_Z) {
		const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, roughness: 0.4, metalness: 0.32 });
		const portal = new THREE.Group();
		portal.name = name;
		portal.userData.topY = topY;
		portal.userData.halfSpanZ = halfSpanZ;
		portal.userData.requiredPackageTopMeters = WOOD_COVERED_PACKAGE_TOP_Y;
		for (const z of [-halfSpanZ, halfSpanZ]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, topY, 0.16), material);
			post.position.set(0, topY / 2, z);
			portal.add(post);
		}
		const top = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, halfSpanZ * 2 + 0.18), material);
		top.name = `${name}-TopCrossbar`;
		top.position.set(0, topY, 0);
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
			['后包装区', 0xa855f7, new THREE.Vector3(47, 0.015, WOOD_LANE_Z), new THREE.Vector3(38, 0.02, 4.2)],
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
		this.group.updateMatrixWorld(true);
		// B 面经过旋转台 180° 后，逻辑 column 顺序与世界 X 顺序相反。
		// 抓取批次必须按真实空间从左到右排序，否则 6 个丝饼会在机器人手上交叉换位。
		const orderedRowSlots = [...rowSlots].sort((left, right) =>
			left.anchor.getWorldPosition(new THREE.Vector3()).x - right.anchor.getWorldPosition(new THREE.Vector3()).x);
		const orderedPallets = [...pallets].sort((left, right) =>
			left.cakeAnchor.getWorldPosition(new THREE.Vector3()).x - right.cakeAnchor.getWorldPosition(new THREE.Vector3()).x);
		const orderedPalletIds = orderedPallets.map((item) => item.palletId);
		const pickCenterWorld = averageVectors(orderedRowSlots.map((slot) => {
			const cake = slot.silkCakeId ? this.cakes.get(slot.silkCakeId) : undefined;
			return cake?.root.getWorldPosition(new THREE.Vector3()) || slot.anchor.getWorldPosition(new THREE.Vector3());
		}));
		const firstCake = orderedRowSlots[0]?.silkCakeId ? this.cakes.get(orderedRowSlots[0].silkCakeId!) : undefined;
		const pickApproachWorld = firstCake
			? new THREE.Vector3(0, 1, 0).applyQuaternion(firstCake.root.getWorldQuaternion(new THREE.Quaternion())).normalize()
			: new THREE.Vector3(0, 0, 1);
		// 丝锭轴线本身没有正负方向。选择指向机器人一侧的方向作为“退出/接近外侧”，
		// 这样 A/B 面无论经过多少父级旋转，都从当前实际朝向的一侧水平进出。
		const robotWorld = this.robotRoot.getWorldPosition(new THREE.Vector3());
		if (pickApproachWorld.dot(robotWorld.clone().sub(pickCenterWorld)) < 0) pickApproachWorld.negate();
		const placeCenterWorld = averageVectors(orderedPallets.map((pallet) => pallet.cakeAnchor.localToWorld(new THREE.Vector3(0, 0.22, 0))));
		this.robotTask = {
			state: 'picking',
			progress: 0,
			side: this.currentSide,
			row: this.currentRow,
			palletIds: orderedPalletIds,
			silkCakeIds: skipLoading ? [] : orderedRowSlots.map((slot) => slot.silkCakeId!),
			attachedAtPick: false,
			attachedAtPlace: false,
			skipLoading,
			pickCenterWorld,
			pickApproachWorld,
			placeCenterWorld,
			pickLocalPositions: [],
			pickLocalQuaternions: [],
		};
		this.cartState = this.currentSide === 'A' ? 'feeding-a' : 'feeding-b';
	}

	private updateRobot(deltaSeconds: number) {
		if (this.robotTask.state === 'idle') {
			this.applyRobotTcpTarget(this.getRobotHomeWorld());
			this.updateRobotGripperSpread(0);
			return;
		}
		const duration = Math.max(0.2, this.options.robotCycleSeconds);
		this.robotTask.progress = clamp01(this.robotTask.progress + deltaSeconds / duration);
		const p = this.robotTask.progress;
		this.updateRobotGripperPose(p);
		this.updateRobotGripperSpread(smooth01((p - 0.38) / 0.32));

		if (!this.robotTask.attachedAtPick && p >= 0.22) {
			this.robotTask.attachedAtPick = true;
			this.group.updateMatrixWorld(true);
			for (let index = 0; index < this.robotTask.silkCakeIds.length; index += 1) {
				const silkCakeId = this.robotTask.silkCakeIds[index];
				const cake = this.cakes.get(silkCakeId);
				const head = this.robotGripperHeads[index];
				if (!cake || !head) continue;
				head.attach(cake.root);
				// 抓头只接触丝饼端面，不允许进入丝饼实体。抓取阶段抓头本地 +Y 已与丝饼轴线平行，
				// 因此丝饼中心固定在抓头原点的 -Y 方向，距离由抓头前端 + 间隙 + 丝饼半长共同决定。
				cake.root.position.set(0, -ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE, 0);
				cake.root.quaternion.identity();
				this.robotTask.pickLocalPositions.push(cake.root.position.clone());
				this.robotTask.pickLocalQuaternions.push(cake.root.quaternion.clone());
				cake.state = 'robot-picking';
			}
			for (const slot of this.cartSlots.filter((slot) => this.robotTask.silkCakeIds.includes(slot.silkCakeId || ''))) delete slot.silkCakeId;
		}

		if (this.robotTask.attachedAtPick && !this.robotTask.attachedAtPlace) this.updateRobotCarriedCakes(p);
		if (!this.robotTask.attachedAtPlace && p >= 0.78) {
			this.robotTask.attachedAtPlace = true;
			this.group.updateMatrixWorld(true);
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

	private updateRobotGripperPose(progress: number) {
		const pickCenter = this.robotTask.pickCenterWorld;
		const pickApproach = this.robotTask.pickApproachWorld;
		const placeCenter = this.robotTask.placeCenterWorld;
		if (!pickCenter || !pickApproach || !placeCenter) return;
		const home = this.getRobotHomeWorld();
		// TCP 位于丝饼朝机器人一侧的端面外。抓头前端与丝饼端面保留 2 cm 可视间隙，
		// 不能再把 TCP 放到丝饼中心，否则 0.32m 抓头会直接穿进丝饼模型。
		const pick = pickCenter.clone().addScaledVector(pickApproach, ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE);
		const place = placeCenter.clone().add(new THREE.Vector3(0, ROBOT_PLACE_TCP_OFFSET_Y, 0));
		const safeY = Math.max(ROBOT_SAFE_TCP_Y, pick.y + 1.55, place.y + 1.55);
		const prePick = pick.clone().addScaledVector(pickApproach, ROBOT_PICK_APPROACH_DISTANCE);
		const safeOutsidePick = prePick.clone().setY(safeY);
		const abovePlace = place.clone().setY(safeY);
		this.robotRoot.updateMatrixWorld(true);
		const robotBaseWorld = this.robotRoot.getWorldPosition(new THREE.Vector3());
		const robotBase = robotBaseWorld.clone().setY(safeY);
		const startOffsetX = safeOutsidePick.x - robotBase.x;
		const startOffsetZ = safeOutsidePick.z - robotBase.z;
		const endOffsetX = abovePlace.x - robotBase.x;
		const endOffsetZ = abovePlace.z - robotBase.z;
		const startAngle = Math.atan2(startOffsetZ, startOffsetX);
		const endAngle = Math.atan2(endOffsetZ, endOffsetX);
		const angleDelta = Math.atan2(Math.sin(endAngle - startAngle), Math.cos(endAngle - startAngle));
		// safeY 会随丝车高排继续抬高；高度越高，J2+J3 剩余水平臂展越小。
		// 因此绕行半径必须按当前高度动态限制，不能固定 4.10m 后再由 IK 硬 clamp。
		const shoulderWorldY = robotBaseWorld.y + ROBOT_SHOULDER_Y;
		const verticalAtSafeY = safeY - shoulderWorldY;
		const ikMaxReach = ROBOT_UPPER_ARM_LENGTH + ROBOT_FOREARM_LENGTH - 0.02;
		const horizontalReachAtSafeY = Math.sqrt(Math.max(0, ikMaxReach * ikMaxReach - verticalAtSafeY * verticalAtSafeY));
		const swingRadius = Math.min(ROBOT_TRANSFER_SWING_RADIUS, horizontalReachAtSafeY - 0.10);
		this.robotRowGripper.userData.transferReachableHorizontalRadiusMeters = horizontalReachAtSafeY;
		this.robotRowGripper.userData.transferClearanceFeasible = swingRadius >= ROBOT_BASE_TRANSFER_CLEARANCE_RADIUS;
		const swingStart = new THREE.Vector3(
			robotBase.x + Math.cos(startAngle) * swingRadius,
			safeY,
			robotBase.z + Math.sin(startAngle) * swingRadius,
		);
		const swingEnd = new THREE.Vector3(
			robotBase.x + Math.cos(endAngle) * swingRadius,
			safeY,
			robotBase.z + Math.sin(endAngle) * swingRadius,
		);
		const keys: Array<{ at: number; position: THREE.Vector3 }> = [
			{ at: 0, position: home },
			// 先在丝车外侧下降到丝锭轴线高度，再沿丝锭轴向水平插入；禁止从上方直接落到丝锭上。
			{ at: 0.08, position: safeOutsidePick },
			{ at: 0.14, position: prePick },
			{ at: 0.22, position: pick },
			// 抓住后先沿同一轴线水平抽出丝车，完全离开挂架后才抬升。
			{ at: 0.30, position: prePick },
			// 完全抽出丝车后原地把夹具从水平取料姿态翻转为垂直放料姿态，再抬升。
			{ at: 0.36, position: prePick },
			{ at: 0.42, position: safeOutsidePick },
			// 先沿丝车侧射线离开机器人本体，再由 J1 绕基座转到辊道方向；禁止用直线穿过机器人中心。
			{ at: 0.48, position: swingStart },
			{ at: 0.62, position: swingEnd },
			{ at: 0.68, position: abovePlace },
			{ at: 0.78, position: place },
			{ at: 0.88, position: abovePlace },
			{ at: 1, position: home },
		];
		let from = keys[0], to = keys[keys.length - 1];
		for (let index = 1; index < keys.length; index += 1) {
			if (progress <= keys[index].at) {
				from = keys[index - 1];
				to = keys[index];
				break;
			}
		}
		const segmentProgress = smooth01((progress - from.at) / Math.max(0.0001, to.at - from.at));
		let worldPosition: THREE.Vector3;
		if (progress >= 0.48 && progress <= 0.62) {
			// 在固定半径上做极角插值，而不是对两个圆周点做 chord lerp；这样整段始终不会切入基座禁区。
			const swingProgress = smooth01((progress - 0.48) / 0.14);
			const angle = startAngle + angleDelta * swingProgress;
			worldPosition = new THREE.Vector3(
				robotBase.x + Math.cos(angle) * swingRadius,
				safeY,
				robotBase.z + Math.sin(angle) * swingRadius,
			);
			this.robotRowGripper.userData.transferSwingAngleProgress = swingProgress;
			this.robotRowGripper.userData.transferCurrentAngleRadians = angle;
		} else {
			worldPosition = from.position.clone().lerp(to.position, segmentProgress);
		}
		const baseDistance = Math.hypot(worldPosition.x - robotBase.x, worldPosition.z - robotBase.z);
		this.robotRowGripper.userData.transferBaseDistanceMeters = baseDistance;
		this.robotRowGripper.userData.transferSwingRadiusMeters = swingRadius;
		this.robotRowGripper.userData.transferBaseClearanceRadiusMeters = ROBOT_BASE_TRANSFER_CLEARANCE_RADIUS;
		this.robotRowGripper.userData.transferStartAngleRadians = startAngle;
		this.robotRowGripper.userData.transferEndAngleRadians = endAngle;
		this.robotRowGripper.userData.transferAngleDeltaRadians = angleDelta;
		this.applyRobotTcpTarget(worldPosition);
		this.applyRobotGripperOrientation(progress, pickApproach);
	}

	private applyRobotGripperOrientation(progress: number, pickApproachWorld: THREE.Vector3) {
		// 保持横梁的本地 X 轴沿世界 X 排列 6 个抓头，只把本地 +Y 轴转到丝饼轴线。
		// 这样每个圆柱抓头的轴线与丝饼轴线平行，而不是竖直插进丝饼。
		const worldX = new THREE.Vector3(1, 0, 0);
		const pickupY = pickApproachWorld.clone().addScaledVector(worldX, -pickApproachWorld.dot(worldX));
		if (pickupY.lengthSq() < 0.000001) pickupY.set(0, 0, 1);
		pickupY.normalize();
		const pickupZ = worldX.clone().cross(pickupY).normalize();
		const pickupWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(
			new THREE.Matrix4().makeBasis(worldX, pickupY, pickupZ));

		let desiredWorldQuaternion = pickupWorldQuaternion;
		if (progress > 0.30) {
			const verticalWorldQuaternion = new THREE.Quaternion();
			const turnProgress = smooth01((progress - 0.30) / 0.06);
			desiredWorldQuaternion = pickupWorldQuaternion.clone().slerp(verticalWorldQuaternion, turnProgress);
		}

		this.robotWrist.updateMatrixWorld(true);
		const parentWorldQuaternion = this.robotWrist.getWorldQuaternion(new THREE.Quaternion());
		this.robotRowGripper.quaternion.copy(parentWorldQuaternion.invert().multiply(desiredWorldQuaternion));
		this.robotRowGripper.updateMatrixWorld(true);
	}

	private getRobotHomeWorld() {
		this.robotRoot.updateMatrixWorld(true);
		return this.robotRoot.localToWorld(new THREE.Vector3(0.75, ROBOT_SAFE_TCP_Y, 0.35));
	}

	private applyRobotTcpTarget(worldTarget: THREE.Vector3) {
		this.robotRoot.updateMatrixWorld(true);
		const localTarget = this.robotRoot.worldToLocal(worldTarget.clone());
		const horizontal = Math.max(0.001, Math.hypot(localTarget.x, localTarget.z));
		const vertical = localTarget.y - ROBOT_SHOULDER_Y;
		const requestedDistance = Math.hypot(horizontal, vertical);
		const minReach = Math.abs(ROBOT_UPPER_ARM_LENGTH - ROBOT_FOREARM_LENGTH) + 0.02;
		const maxReach = ROBOT_UPPER_ARM_LENGTH + ROBOT_FOREARM_LENGTH - 0.02;
		const reach = THREE.MathUtils.clamp(requestedDistance, minReach, maxReach);
		const scale = requestedDistance > 0.000001 ? reach / requestedDistance : 1;
		const radial = horizontal * scale;
		const height = vertical * scale;
		const cosineElbow = THREE.MathUtils.clamp(
			(reach * reach - ROBOT_UPPER_ARM_LENGTH * ROBOT_UPPER_ARM_LENGTH - ROBOT_FOREARM_LENGTH * ROBOT_FOREARM_LENGTH)
			/ (2 * ROBOT_UPPER_ARM_LENGTH * ROBOT_FOREARM_LENGTH), -1, 1);
		// elbow-up：肘部保持在工件上方，横移阶段不会从丝车和托盘中间扫过去。
		const elbow = -Math.acos(cosineElbow);
		const alpha = Math.atan2(height, radial) - Math.atan2(
			ROBOT_FOREARM_LENGTH * Math.sin(elbow),
			ROBOT_UPPER_ARM_LENGTH + ROBOT_FOREARM_LENGTH * Math.cos(elbow));
		const shoulder = alpha - Math.PI / 2;
		const baseYaw = Math.atan2(-localTarget.z, localTarget.x);

		this.robotAxis1.rotation.y = baseYaw;
		this.robotShoulder.rotation.z = shoulder;
		this.robotElbow.rotation.z = elbow;
		this.robotWristRoll.rotation.y = 0;
		// J5 抵消 J2+J3 的俯仰，J6 抵消 J1 的回转，保证 1×6 横梁始终水平并沿世界 X 排列。
		this.robotWristPitch.rotation.z = -(shoulder + elbow);
		this.robotWrist.rotation.y = -baseYaw;
		this.robotRoot.updateMatrixWorld(true);

		const actual = this.robotRowGripper.getWorldPosition(new THREE.Vector3());
		this.robotRowGripper.userData.tcpTargetWorld = worldTarget.toArray();
		this.robotRowGripper.userData.tcpErrorMeters = actual.distanceTo(worldTarget);
	}

	private updateRobotGripperSpread(progress: number) {
		for (let index = 0; index < this.robotGripperHeads.length; index += 1) {
			const pickupX = -2.75 + index * 1.1;
			const placementX = -3.875 + index * 1.55;
			this.robotGripperHeads[index].position.x = THREE.MathUtils.lerp(pickupX, placementX, progress);
		}
		const rail = this.robotRowGripper.getObjectByName('RobotRowGripperRail');
		if (rail) rail.scale.x = THREE.MathUtils.lerp(1, 1.3, progress);
	}

	private updateRobotCarriedCakes(progress: number) {
		this.group.updateMatrixWorld(true);
		for (let index = 0; index < this.robotTask.silkCakeIds.length; index += 1) {
			const cake = this.cakes.get(this.robotTask.silkCakeIds[index]);
			if (!cake) continue;
			// 丝饼与对应抓头形成刚性抓取关系。姿态变化由 J6 末端夹具整体完成，
			// 不再让丝饼在抓头内部插值穿行，否则会重新产生视觉重叠。
			cake.root.position.set(0, -ROBOT_GRIPPER_CONTACT_CENTER_DISTANCE, 0);
			cake.root.quaternion.identity();
		}
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
		// 每一层丝锭之后必须先完成隔板；未完成隔板时绝不允许下一批丝锭进入桁架动作。
		if (this.activeWoodPallet.separatorCount !== this.activeWoodPallet.layer) return;
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
			const idlePose = resolveGantryPose(1, 0);
			this.applyGantryMechanicalPose(idlePose);
			return;
		}
		if (this.gantryTask.state === 'separator') {
			this.updateSeparatorGantry(deltaSeconds);
			return;
		}
		const duration = Math.max(0.2, this.options.gantryCycleSeconds);
		this.gantryTask.progress = clamp01(this.gantryTask.progress + deltaSeconds / duration);
		const p = this.gantryTask.progress;
		const pose = resolveGantryPose(p, this.gantryTask.targetLayer);
		this.applyGantryMechanicalPose(pose);
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
		if (p >= 1) {
			// 丝锭层完成后切换右夹具取隔板；隔板完成前不释放本批塑料托盘，也不进入下一层。
			this.gantryTask.state = 'separator';
			this.gantryTask.progress = 0;
			this.gantryTask.attachedAtPick = false;
			this.gantryTask.attachedAtPlace = false;
			this.gantryTask.separatorSourceIndex = this.gantryTask.targetLayer % this.separatorFeeders.length;
			this.gantryCarriage.userData.motionPhase = 'separator-start';
		}
	}

	private applyGantryMechanicalPose(pose: ReturnType<typeof resolveGantryPose>) {
		this.gantryCarriage.position.set(0, GANTRY_BRIDGE_Y, pose.carriage.z - GANTRY_FRAME_CENTER_Z);
		this.gantryTrolley.position.set(pose.carriage.x - GANTRY_FRAME_CENTER_X, 0, 0);
		// resolveGantryPose 的 Y 仍按旧逻辑表示“旧小车基准高度”；保持实际丝锭夹具中心高度不变。
		const desiredGripperWorldY = pose.carriage.y - 2.2;
		this.gantryLift.position.set(0, desiredGripperWorldY - GANTRY_BRIDGE_Y - this.gantryGripper.position.y, 0);
		// 丝锭作业期间隔板桥停在 Z- 初始位，X 小车居中。
		this.gantrySeparatorCarriage.position.set(0, GANTRY_BRIDGE_Y, GANTRY_SEPARATOR_HOME_Z - GANTRY_FRAME_CENTER_Z);
		this.gantrySeparatorTrolley.position.set(GANTRY_SEPARATOR_HOME_X - GANTRY_FRAME_CENTER_X, 0, 0);
		this.gantrySeparatorLift.position.set(0, GANTRY_TOOL_STOW_SLIDE_Y - GANTRY_BRIDGE_Y, 0);
		this.updateGantryLiftContinuity(this.gantryLift, this.gantryGripper, this.gantryGuide, this.gantrySlideBar);
		this.updateGantryLiftContinuity(this.gantrySeparatorLift, this.gantrySeparatorGripper, this.gantrySeparatorGuide, this.gantrySeparatorSlideBar);
		this.applyGantryServoOverrides();
		this.gantryRoot.updateMatrixWorld(true);
		const gripperWorld = this.gantryGripper.getWorldPosition(new THREE.Vector3());
		this.gantryRoot.userData.gantryGripperWorldY = gripperWorld.y;
		this.gantryRoot.userData.gantryRailY = GANTRY_RAIL_Y;
		this.updateGantryVerticalDiagnostics();
	}

	private updateSeparatorGantry(deltaSeconds: number) {
		const wood = this.activeWoodPallet;
		if (!wood || this.separatorFeeders.length < 2) {
			this.gantryTask = this.createIdleGantryTask();
			return;
		}
		const duration = Math.max(0.2, this.options.gantryCycleSeconds * 0.90);
		this.gantryTask.progress = clamp01(this.gantryTask.progress + deltaSeconds / duration);
		const p = this.gantryTask.progress;
		const sourceIndex = Math.max(0, Math.min(this.separatorFeeders.length - 1, this.gantryTask.separatorSourceIndex ?? (this.gantryTask.targetLayer % this.separatorFeeders.length)));
		const feeder = this.separatorFeeders[sourceIndex];
		this.gantryRoot.updateMatrixWorld(true);
		const pickPoint = feeder.getObjectByName(`${feeder.name}-PickPoint`);
		const sourceBoardWorld = pickPoint?.getWorldPosition(new THREE.Vector3()) ?? feeder.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, Number(feeder.userData.pickY || 1.46), 0));
		const boardOffsetFromSlideY = this.gantrySeparatorGripper.position.y + GANTRY_SEPARATOR_BOARD_LOCAL_Y;
		const sourceSlideY = sourceBoardWorld.y - boardOffsetFromSlideY;
		const separatorRelativeY = 0.36 + this.gantryTask.targetLayer * 0.46 + 0.21 + SEPARATOR_BOARD_THICKNESS / 2;
		const placeBoardWorldY = WOOD_STACK_POSITION.y + 0.24 + separatorRelativeY;
		const placeSlideY = placeBoardWorldY - boardOffsetFromSlideY;
		const safeSlideY = Math.max(GANTRY_SEPARATOR_SAFE_SLIDE_Y, placeSlideY + 0.30);
		const start = new THREE.Vector3(
			GANTRY_SEPARATOR_HOME_X,
			GANTRY_TOOL_STOW_SLIDE_Y,
			GANTRY_SEPARATOR_HOME_Z,
		);
		const sourceSafe = new THREE.Vector3(sourceBoardWorld.x, safeSlideY, sourceBoardWorld.z);
		const sourcePick = new THREE.Vector3(sourceBoardWorld.x, sourceSlideY, sourceBoardWorld.z);
		const placeSafe = new THREE.Vector3(WOOD_STACK_POSITION.x, safeSlideY, WOOD_STACK_POSITION.z);
		const placeContact = new THREE.Vector3(WOOD_STACK_POSITION.x, placeSlideY, WOOD_STACK_POSITION.z);
		const blend = (from: number, to: number) => THREE.MathUtils.smoothstep(p, from, to);
		const slideWorld = new THREE.Vector3();
		let phase = 'separator-source-approach';
		if (p < 0.14) slideWorld.copy(start).lerp(sourceSafe, blend(0, 0.14));
		else if (p < 0.28) {
			phase = 'separator-source-descend';
			slideWorld.copy(sourceSafe).lerp(sourcePick, blend(0.14, 0.28));
		} else if (p < 0.36) {
			phase = 'separator-pick';
			slideWorld.copy(sourcePick);
		} else if (p < 0.50) {
			phase = 'separator-source-lift';
			slideWorld.copy(sourcePick).lerp(sourceSafe, blend(0.36, 0.50));
		} else if (p < 0.68) {
			phase = 'separator-transfer';
			slideWorld.copy(sourceSafe).lerp(placeSafe, blend(0.50, 0.68));
		} else if (p < 0.82) {
			phase = 'separator-place-descend';
			slideWorld.copy(placeSafe).lerp(placeContact, blend(0.68, 0.82));
		} else if (p < 0.88) {
			phase = 'separator-release';
			slideWorld.copy(placeContact);
		} else if (p < 0.94) {
			phase = 'separator-place-lift';
			slideWorld.copy(placeContact).lerp(placeSafe, blend(0.88, 0.94));
		} else {
			phase = 'separator-return-home';
			slideWorld.copy(placeSafe).lerp(start, blend(0.94, 1));
		}
		this.applySeparatorMechanicalPose(slideWorld, phase);

		if (!this.gantryTask.attachedAtPick && p >= 0.31) {
			this.gantryTask.attachedAtPick = true;
			const board = new THREE.Mesh(new THREE.BoxGeometry(PACKAGING_WOOD_PALLET_LENGTH, SEPARATOR_BOARD_THICKNESS, PACKAGING_WOOD_PALLET_WIDTH), this.coverMaterial);
			board.name = `SeparatorBoard-Layer-${this.gantryTask.targetLayer + 1}`;
			board.userData.separatorBoard = true;
			board.userData.layer = this.gantryTask.targetLayer + 1;
			board.userData.woodenPalletId = wood.woodenPalletId;
			board.userData.sourceFeeder = feeder.name;
			board.position.copy(sourceBoardWorld);
			this.group.add(board);
			this.gantrySeparatorGripper.attach(board);
			board.position.set(0, GANTRY_SEPARATOR_BOARD_LOCAL_Y, 0);
			board.rotation.set(0, 0, 0);
			this.activeSeparatorBoard = board;
			feeder.userData.pickCount = Number(feeder.userData.pickCount || 0) + 1;
		}

		if (!this.gantryTask.attachedAtPlace && p >= 0.84 && this.activeSeparatorBoard) {
			this.gantryTask.attachedAtPlace = true;
			wood.stackAnchor.attach(this.activeSeparatorBoard);
			this.activeSeparatorBoard.position.set(0, separatorRelativeY, 0);
			this.activeSeparatorBoard.rotation.set(0, 0, 0);
			wood.separatorCount = Math.max(wood.separatorCount, this.gantryTask.targetLayer + 1);
			this.activeSeparatorBoard = undefined;
		}

		if (p >= 1) this.finishGantryBatch();
	}

	private applySeparatorMechanicalPose(slideWorld: THREE.Vector3, phase: string) {
		this.gantrySeparatorCarriage.position.set(0, GANTRY_BRIDGE_Y, slideWorld.z - GANTRY_FRAME_CENTER_Z);
		this.gantrySeparatorTrolley.position.set(slideWorld.x - GANTRY_FRAME_CENTER_X, 0, 0);
		this.gantrySeparatorLift.position.set(0, slideWorld.y - GANTRY_BRIDGE_Y, 0);
		// 隔板作业时丝锭桥回到 Z+ 初始位，X 小车回到取丝中心。
		this.gantryCarriage.position.set(0, GANTRY_BRIDGE_Y, GANTRY_SILK_HOME_Z - GANTRY_FRAME_CENTER_Z);
		this.gantryTrolley.position.set(GANTRY_SILK_HOME_X - GANTRY_FRAME_CENTER_X, 0, 0);
		const stowGripperWorldY = GANTRY_TOOL_STOW_SLIDE_Y - 2.2;
		this.gantryLift.position.set(0, stowGripperWorldY - GANTRY_BRIDGE_Y - this.gantryGripper.position.y, 0);
		this.updateGantryLiftContinuity(this.gantryLift, this.gantryGripper, this.gantryGuide, this.gantrySlideBar);
		this.updateGantryLiftContinuity(this.gantrySeparatorLift, this.gantrySeparatorGripper, this.gantrySeparatorGuide, this.gantrySeparatorSlideBar);
		this.applyGantryServoOverrides();
		this.gantrySeparatorCarriage.userData.motionPhase = phase;
		this.gantrySeparatorCarriage.userData.targetLayer = this.gantryTask.targetLayer;
		this.gantrySeparatorCarriage.userData.safeCarriageY = GANTRY_SEPARATOR_SAFE_SLIDE_Y;
		this.gantryCarriage.userData.motionPhase = phase;
		this.gantryCarriage.userData.targetLayer = this.gantryTask.targetLayer;
		this.gantryCarriage.userData.safeCarriageY = GANTRY_SEPARATOR_SAFE_SLIDE_Y;
		this.gantryRoot.updateMatrixWorld(true);
		this.gantryRoot.userData.gantrySeparatorGripperWorldY = this.gantrySeparatorGripper.getWorldPosition(new THREE.Vector3()).y;
		this.updateGantryVerticalDiagnostics();
	}

	/**
	 * 让固定导向套与移动牵引轴在全部升降行程内保持机械重叠。
	 * 移动滑台下降时动态延长内轴到固定导向套下端，避免隔板夹爪出现悬空断层。
	 */
	private updateGantryLiftContinuity(lift: THREE.Group, gripper: THREE.Group, guide?: THREE.Mesh, slideBar?: THREE.Mesh) {
		if (!guide || !slideBar) return;
		const guideLowerY = Number(guide.userData.lowerEndY);
		if (!Number.isFinite(guideLowerY)) return;
		const lowerY = gripper.position.y + 0.10;
		const upperY = Math.max(lowerY + 0.45, guideLowerY - lift.position.y + 0.10);
		const geometry = slideBar.geometry as THREE.BoxGeometry;
		const baseLength = Number(slideBar.userData.baseLength || geometry.parameters.height || 1);
		const continuousLength = Math.max(0.45, upperY - lowerY);
		slideBar.position.y = (upperY + lowerY) / 2;
		slideBar.scale.y = continuousLength / Math.max(0.001, baseLength);
		slideBar.userData.continuousLength = continuousLength;
		slideBar.userData.axisContinuous = true;
	}

	private applyGantryServoOverrides() {
		const silkZ = this.gantryServoOverrides.silkZ;
		const separatorZ = this.gantryServoOverrides.separatorZ;
		const clampZ = (value: number) => THREE.MathUtils.clamp(value, GANTRY_FRAME_Z0 + 0.45, GANTRY_FRAME_Z1 - 0.45);
		if (typeof silkZ === 'number' && Number.isFinite(silkZ)) this.gantryCarriage.position.z = clampZ(silkZ) - GANTRY_FRAME_CENTER_Z;
		if (typeof separatorZ === 'number' && Number.isFinite(separatorZ)) this.gantrySeparatorCarriage.position.z = clampZ(separatorZ) - GANTRY_FRAME_CENTER_Z;
		const silkWorldZ = this.gantryCarriage.position.z + GANTRY_FRAME_CENTER_Z;
		const separatorWorldZ = this.gantrySeparatorCarriage.position.z + GANTRY_FRAME_CENTER_Z;
		this.gantryCarriage.userData.servoOverrideActive = typeof silkZ === 'number' && Number.isFinite(silkZ);
		this.gantrySeparatorCarriage.userData.servoOverrideActive = typeof separatorZ === 'number' && Number.isFinite(separatorZ);
		this.gantryCarriage.userData.servoPositionZ = silkWorldZ;
		this.gantrySeparatorCarriage.userData.servoPositionZ = separatorWorldZ;
		this.gantryRoot.userData.silkServoPositionZ = silkWorldZ;
		this.gantryRoot.userData.separatorServoPositionZ = separatorWorldZ;
	}

	private updateGantryVerticalDiagnostics() {
		this.gantryRoot.updateMatrixWorld(true);
		const names = ['Gantry-Z-Guide', 'Gantry-Separator-Z-Guide', 'Gantry-Z-Slide-Bar', 'Gantry-Separator-Z-Slide-Bar'];
		let maxY = Number.NEGATIVE_INFINITY;
		for (const name of names) {
			const object = this.gantryRoot.getObjectByName(name);
			if (!object) continue;
			const box = new THREE.Box3().setFromObject(object);
			maxY = Math.max(maxY, box.max.y);
		}
		this.gantryRoot.userData.verticalStructureMaxY = Number.isFinite(maxY) ? maxY : 0;
		this.gantryRoot.userData.verticalStructureBelowRail = Number.isFinite(maxY) && maxY < GANTRY_RAIL_Y - 0.02;
		this.gantryRoot.userData.gantryRailY = GANTRY_RAIL_Y;
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
		if (this.activeWoodPallet && this.activeWoodPallet.layer >= WOOD_MAX_LAYERS && this.activeWoodPallet.separatorCount >= WOOD_MAX_LAYERS) {
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
				// 满托先移动到天盖桁架正下方；夹具默认带盖等待，不再临时生成一个“执行头”。
				const travelProgress = Math.min(1, wood.progress * 1.8);
				this.applyWoodSectionPose(wood.root, 'silk-wood-edge-stack', travelProgress, WOOD_STACK_POSITION, COVER_POSITION);
				if (travelProgress >= 1 && !wood.coverApplied && !this.coverTargetWood
					&& this.coverGantryState === 'waiting' && this.activeCoverBlank) {
					this.coverTargetWood = wood;
					this.coverGantryState = 'placing';
					this.coverGantryProgress = 0;
				}
				continue;
			}
			if (wood.stage === 'wrapping') {
				this.applyWoodSectionPose(wood.root, 'silk-wood-edge-cover', Math.min(1, wood.progress * 0.25), COVER_POSITION, WRAP_POSITION);
				this.wrapperFilm.visible = true;
				this.wrapperStationRoot.userData.wrapperState = 'wrapping';
				// 悬臂绕静止满托 360° 连续公转；膜车沿立杆上下往复形成螺旋缠膜。
				this.wrapperRotaryArm.rotation.y += deltaSeconds * 2.5;
				const minCarriageY = Number(this.wrapperFilmCarriage.userData.minLocalY ?? this.wrapperFilmCarriageHomeY);
				const maxCarriageY = Number(this.wrapperFilmCarriage.userData.maxLocalY ?? this.wrapperFilmCarriageHomeY);
				const liftTriangle = 1 - Math.abs(wood.progress * 2 - 1);
				this.wrapperFilmCarriage.position.y = THREE.MathUtils.lerp(minCarriageY, maxCarriageY, liftTriangle);
				this.wrapperStationRoot.userData.rotaryArmAngle = this.wrapperRotaryArm.rotation.y;
				this.wrapperStationRoot.userData.filmCarriageLocalY = this.wrapperFilmCarriage.position.y;
				if (wood.progress >= 1) {
					wood.wrapped = true;
					wood.stage = 'labeling';
					wood.progress = 0;
					this.wrapperFilm.visible = false;
					this.wrapperFilmCarriage.position.y = this.wrapperFilmCarriageHomeY;
					this.wrapperStationRoot.userData.wrapperState = 'idle';
				}
				continue;
			}
			if (wood.stage === 'labeling') {
				// 前半段把满托送到贴标位，后半段托盘保持静止，三关节电动臂完成压贴后回位。
				const travelProgress = Math.min(1, wood.progress * 2);
				this.applyWoodSectionPose(wood.root, 'silk-wood-edge-wrap', travelProgress, WRAP_POSITION, LABEL_POSITION);
				const armPhase = THREE.MathUtils.clamp((wood.progress - 0.50) / 0.50, 0, 1);
				const applyFactor = 1 - Math.abs(armPhase * 2 - 1);
				this.applyLabelerArmPose(applyFactor);
				this.labelStationRoot.userData.labelerState = armPhase <= 0 ? 'waiting-pallet' : armPhase < 0.5 ? 'applying' : 'returning';
				if (armPhase >= 0.45 && !wood.labelApplied) {
					this.attachLabel(wood);
					wood.labelApplied = true;
				}
				if (wood.progress >= 1) {
					this.applyLabelerArmPose(0);
					this.labelStationRoot.userData.labelerState = 'idle';
					wood.stage = 'inbound';
					wood.progress = 0;
				}
				continue;
			}
			if (wood.stage === 'inbound') {
				this.applyWoodSectionPose(wood.root, 'silk-wood-edge-post-process', wood.progress, LABEL_POSITION, INBOUND_POSITION);
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

	private applyCoverGantryPose(headLocal: THREE.Vector3) {
		// 新模型的双橙色轨道沿 Z；桥式小车沿 Z 行走，桥上的小车只负责必要的 X 微调。
		this.coverGantryBridge.position.set(0, COVER_GANTRY_BRIDGE_Y, headLocal.z);
		this.coverGantryTrolley.position.set(headLocal.x, 0, 0);
		this.coverGantrySlide.position.set(0, headLocal.y - COVER_GANTRY_BRIDGE_Y - this.coverGantryHead.position.y, 0);
		this.coverStationRoot.userData.coverGantryState = this.coverGantryState;
		this.coverStationRoot.userData.coverReady = Boolean(this.activeCoverBlank);
		this.coverStationRoot.updateMatrixWorld(true);
	}

	private ensureCoverLoaded() {
		if (this.activeCoverBlank?.parent) return;
		const cover = new THREE.Mesh(new THREE.BoxGeometry(PACKAGING_WOOD_PALLET_LENGTH, 0.12, PACKAGING_WOOD_PALLET_WIDTH), this.topCoverMaterial);
		cover.name = 'TopCover-Ready';
		cover.userData.preloadedCover = true;
		cover.position.set(0, -0.43, 0);
		this.coverGantryHead.add(cover);
		this.activeCoverBlank = cover;
		this.coverGantryHead.userData.loaded = true;
	}

	private updateCoverGantry(deltaSeconds: number) {
		const wait = COVER_WAIT_LOCAL.clone();
		const stockSafe = COVER_STOCK_LOCAL.clone();
		const stockPick = new THREE.Vector3(COVER_STOCK_LOCAL.x, 1.65, COVER_STOCK_LOCAL.z);
		const contact = new THREE.Vector3(0, WOOD_COVERED_PACKAGE_TOP_Y + 0.37, 0);
		const duration = Math.max(0.2, this.options.coverCycleSeconds * 0.65);

		if (this.coverGantryState === 'waiting') {
			this.applyCoverGantryPose(wait);
			this.ensureCoverLoaded();
			return;
		}

		this.coverGantryProgress = clamp01(this.coverGantryProgress + deltaSeconds / duration);
		const p = this.coverGantryProgress;
		const smooth = (from: number, to: number) => THREE.MathUtils.smoothstep(p, from, to);

		if (this.coverGantryState === 'placing') {
			const pose = p < 0.44
				? wait.clone().lerp(contact, smooth(0, 0.44))
				: p < 0.62
					? contact
					: contact.clone().lerp(wait, smooth(0.62, 1));
			this.applyCoverGantryPose(pose);
			if (p >= 0.48 && this.coverTargetWood && !this.coverTargetWood.coverApplied) {
				this.attachCover(this.coverTargetWood);
				this.coverTargetWood.coverApplied = true;
				this.coverTargetWood.stage = 'wrapping';
				this.coverTargetWood.progress = 0;
			}
			if (p >= 1) {
				this.coverTargetWood = undefined;
				this.coverGantryState = 'reload-to-stock';
				this.coverGantryProgress = 0;
			}
			return;
		}

		if (this.coverGantryState === 'reload-to-stock') {
			const pose = p < 0.62
				? wait.clone().lerp(stockSafe, smooth(0, 0.62))
				: stockSafe.clone().lerp(stockPick, smooth(0.62, 1));
			this.applyCoverGantryPose(pose);
			if (p >= 1) {
				this.coverGantryState = 'reload-pick';
				this.coverGantryProgress = 0;
			}
			return;
		}

		if (this.coverGantryState === 'reload-pick') {
			this.applyCoverGantryPose(stockPick);
			this.ensureCoverLoaded();
			this.coverStockTable.userData.pickCount = Number(this.coverStockTable.userData.pickCount || 0) + 1;
			this.coverGantryState = 'reload-return';
			this.coverGantryProgress = 0;
			return;
		}

		if (this.coverGantryState === 'reload-return') {
			const pose = p < 0.34
				? stockPick.clone().lerp(stockSafe, smooth(0, 0.34))
				: stockSafe.clone().lerp(wait, smooth(0.34, 1));
			this.applyCoverGantryPose(pose);
			if (p >= 1) {
				this.coverGantryState = 'waiting';
				this.coverGantryProgress = 0;
				this.applyCoverGantryPose(wait);
			}
		}
	}

	/** 供专业编辑器和运行时把程序化产线中的整机映射为独立 Manifest 对象。 */
	getEquipmentRoots(): Partial<Record<TwinEquipmentType, THREE.Group>> {
		return {
			'loading-robot': this.robotRoot,
			'silk-cart-turntable': this.rotaryCell,
			'gantry-stacker': this.gantryRoot,
			'cover-applicator': this.coverStationRoot,
			labeler: this.labelStationRoot,
			wrapper: this.wrapperStationRoot,
			'inbound-lift': this.inboundLiftRoot,
		};
	}

	private applyWoodSectionPose(root: THREE.Object3D, sectionId: string, progress: number, fallbackFrom: THREE.Vector3, fallbackTo: THREE.Vector3) {
		const pose = this.woodSectionGeometry?.getPose(sectionId, progress);
		if (!pose) {
			lerpPose(root, fallbackFrom, fallbackTo, progress);
			return;
		}
		root.position.copy(pose.position);
		if (pose.tangent.lengthSq() > 0.000001) root.rotation.y = -Math.atan2(pose.tangent.z, pose.tangent.x);
	}

	private applyLabelerArmPose(applyFactor: number) {
		const t = THREE.MathUtils.clamp(applyFactor, 0, 1);
		// 0=折叠待机，1=三段臂基本伸直并让 Tamp 板到达满托侧面。
		this.labelArmJoint1.rotation.y = THREE.MathUtils.lerp(0.70, 0, t);
		this.labelArmJoint2.rotation.y = THREE.MathUtils.lerp(-1.20, 0, t);
		this.labelArmJoint3.rotation.y = THREE.MathUtils.lerp(0.72, 0, t);
		this.labelStationRoot.userData.armApplyFactor = t;
		this.labelStationRoot.updateMatrixWorld(true);
	}

	private attachCover(wood: WoodenPalletRuntime) {
		if (wood.root.getObjectByName('TopCover')) return;
		const cover = this.activeCoverBlank || new THREE.Mesh(new THREE.BoxGeometry(PACKAGING_WOOD_PALLET_LENGTH, 0.12, PACKAGING_WOOD_PALLET_WIDTH), this.topCoverMaterial);
		if (cover.parent) wood.root.attach(cover);
		else wood.root.add(cover);
		cover.name = 'TopCover';
		cover.userData.preloadedCover = false;
		cover.position.set(0, 0.45 + WOOD_MAX_LAYERS * 0.46, 0);
		cover.rotation.set(0, 0, 0);
		if (this.activeCoverBlank === cover) this.activeCoverBlank = undefined;
		this.coverGantryHead.userData.loaded = false;
	}

	private attachLabel(wood: WoodenPalletRuntime) {
		if (wood.root.getObjectByName('PackageLabel')) return;
		const label = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.65), this.labelMaterial);
		label.name = 'PackageLabel';
		// 贴标机安装在大辊道 Z+ 侧，标签贴到满托朝向贴标机的侧面。
		label.position.set(0, 2.1, WOOD_PACKAGE_HALF_Z + 0.012);
		label.rotation.y = 0;
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
		return {
			state: 'idle', progress: 0, side: this.currentSide, row: this.currentRow,
			palletIds: [], silkCakeIds: [], attachedAtPick: false, attachedAtPlace: false,
			skipLoading: false, pickLocalPositions: [], pickLocalQuaternions: [],
		};
	}

	private createIdleGantryTask(): GantryTaskRuntime {
		return { state: 'idle', progress: 0, palletIds: [], silkCakeIds: [], targetLayer: 0, attachedAtPick: false, attachedAtPlace: false };
	}
}
