import * as THREE from 'three';
import type { TwinRouteDefinition, TwinRouteEdgeDefinition } from '/@/digital-twin/contracts';
import { TwinMaterialFlowRuntime, type TwinFlowWaitingReason } from '/@/digital-twin/runtime/TwinMaterialFlowRuntime';

type SilkSide = 'A' | 'B';
type PalletStage = 'source-queue' | 'loading' | 'to-gantry-a' | 'to-gantry-b' | 'gantry-a' | 'gantry-b' | 'returning';
type WoodStage = 'stacking' | 'covering' | 'labeling' | 'wrapping' | 'inbound' | 'stored';

interface PlasticPalletRuntime {
	palletId: string;
	root: THREE.Group;
	cakeAnchor: THREE.Group;
	stage: PalletStage;
	progress: number;
	loaded: boolean;
	silkCakeId?: string;
	loadSlot?: number;
	gantrySlot?: number;
	returnFrom?: 'A' | 'B';
	waitingReason?: TwinFlowWaitingReason;
}

interface SilkCakeRuntime {
	silkCakeId: string;
	root: THREE.Group;
	state: 'on-cart' | 'robot-picking' | 'on-pallet' | 'gantry-picking' | 'on-wood-pallet' | 'stored';
	side: SilkSide;
	row: number;
	column: number;
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

interface LineSnapshot {
	running: boolean;
	speed: number;
	plasticPallets: {
		total: number;
		empty: number;
		loaded: number;
		waiting: number;
		sourceQueue: number;
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
	};
	gantry: {
		state: string;
		laneA: number;
		laneB: number;
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
const GANTRY_LANE_A_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(8 + index * 1.8, 0.94, -7.6));
const GANTRY_LANE_B_POSITIONS = Array.from({ length: 3 }, (_, index) => new THREE.Vector3(8 + index * 1.8, 0.94, -4.2));
const WOOD_STACK_POSITION = new THREE.Vector3(10, 0.72, -0.8);
const COVER_POSITION = new THREE.Vector3(16, 0.72, -0.8);
const LABEL_POSITION = new THREE.Vector3(20.5, 0.72, -0.8);
const WRAP_POSITION = new THREE.Vector3(25, 0.72, -0.8);
const INBOUND_POSITION = new THREE.Vector3(31, 0.72, -0.8);
const STORED_POSITION = new THREE.Vector3(35, 1.1, -0.8);
const RETURN_CORNER_EAST = new THREE.Vector3(15, 0.94, 4.8);
const RETURN_CORNER_WEST = new THREE.Vector3(-12.5, 0.94, 4.8);

const markShadow = (object: THREE.Object3D) => {
	object.traverse((child: any) => {
		if (!child.isMesh) return;
		child.castShadow = true;
		child.receiveShadow = true;
	});
};

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const lerpPose = (object: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, progress: number) => {
	object.position.lerpVectors(from, to, clamp01(progress));
	const direction = to.clone().sub(from).setY(0);
	if (direction.lengthSq() > 0.00001) object.rotation.y = Math.atan2(direction.x, direction.z);
};

/**
 * 丝饼产线程序化数字孪生。
 *
 * - 丝车 A/B 两面，每面 3 行 × 6 列；A 面三行抓完后旋转 180° 再抓 B 面。
 * - 上料机器人使用 1×6 夹具，只有凑齐 6 个空塑料托盘时才一次抓一整行。
 * - 塑料托盘通过 TwinMaterialFlowRuntime 的 Section Capacity / Reserved / Waiting 控制流转。
 * - 桁架下方两条塑料托盘辊道各 3 位，第三条木托盘辊道；2×3 夹具一次抓 6 个丝饼。
 * - 木托盘每层 2×3，共 8 层 = 48 个丝饼；之后盖板、贴标、缠膜、立体库入库。
 * - 桁架抓空后的塑料托盘回流，再组成下一组 6 个空托盘。
 */
export class ProceduralPackagingLine {
	readonly group = new THREE.Group();

	private route: TwinRouteDefinition;
	private readonly palletCount: number;
	private flowRuntime: TwinMaterialFlowRuntime;
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
	private currentCartId = '';
	private currentSide: SilkSide = 'A';
	private currentRow = 0;
	private cartState: 'ready-a' | 'feeding-a' | 'turning-to-b' | 'ready-b' | 'feeding-b' | 'empty' | 'replacing' = 'ready-a';
	private cartTurnProgress = 0;
	private cartReplaceProgress = 0;
	private robotTask: RobotTaskRuntime = this.createIdleRobotTask();
	private gantryTask: GantryTaskRuntime = this.createIdleGantryTask();
	private activeWoodPallet?: WoodenPalletRuntime;

	private readonly frameMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.48, metalness: 0.76 });
	private readonly darkFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.58, metalness: 0.68 });
	private readonly rollerMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb8c6, roughness: 0.32, metalness: 0.86 });
	private readonly plasticMaterial = new THREE.MeshStandardMaterial({ color: 0x087f5b, roughness: 0.55, metalness: 0.08 });
	private readonly plasticDarkMaterial = new THREE.MeshStandardMaterial({ color: 0x065f46, roughness: 0.62, metalness: 0.08 });
	private readonly silkMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f4ef, roughness: 0.86, metalness: 0.01 });
	private readonly silkEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0xdde3dc, roughness: 0.72, metalness: 0.01 });
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

	private readonly sectionIds: {
		loading?: string;
		transit?: string;
		laneA?: string;
		laneB?: string;
		returning?: string;
	};

	constructor(route: TwinRouteDefinition, palletCount = 50) {
		this.route = structuredClone(route);
		this.applySilkLineSectionCapacities(this.route);
		this.palletCount = Math.min(200, Math.max(6, Math.floor(palletCount)));
		this.speed = route.defaultSpeed;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.sectionIds = this.resolveSectionIds(this.route.edges || []);
		this.group.name = '丝饼包装与立库入库数字孪生线';
		this.buildFloorLabels();
		this.buildPlasticConveyors();
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

	setRoute(route: TwinRouteDefinition) {
		this.route = structuredClone(route);
		this.applySilkLineSectionCapacities(this.route);
		this.speed = route.defaultSpeed;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.reset();
	}

	reset() {
		this.running = false;
		this.flowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.currentSide = 'A';
		this.currentRow = 0;
		this.cartState = 'ready-a';
		this.cartTurnProgress = 0;
		this.cartReplaceProgress = 0;
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
			delete pallet.silkCakeId;
			delete pallet.loadSlot;
			delete pallet.gantrySlot;
			delete pallet.returnFrom;
			delete pallet.waitingReason;
			pallet.cakeAnchor.clear();
			this.sourceQueue.push(pallet.palletId);
			this.flowRuntime.entities.ensure(pallet.palletId);
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
		this.updateSilkCart(deltaSeconds);
		this.updateRobot(deltaSeconds);
		this.updatePlasticPalletFlow(deltaSeconds);
		this.updateGantry(deltaSeconds);
		this.updateWoodPostProcess(deltaSeconds);
		this.tryStartRobotBatch();
		this.tryStartGantryBatch();
		this.tryFillLoadingSlots();
		this.applyAllPoses();
	}

	getSnapshot(): LineSnapshot {
		const palletValues = [...this.pallets.values()];
		return {
			running: this.running,
			speed: this.speed,
			plasticPallets: {
				total: palletValues.length,
				empty: palletValues.filter((item) => !item.loaded).length,
				loaded: palletValues.filter((item) => item.loaded).length,
				waiting: palletValues.filter((item) => Boolean(item.waitingReason)).length,
				sourceQueue: this.sourceQueue.length,
			},
			silkCart: {
				cartId: this.currentCartId,
				activeSide: this.currentSide,
				currentRow: this.currentRow + 1,
				remaining: Math.min(SILK_PER_CART, this.cartSlots.filter((slot) => Boolean(slot.silkCakeId)).length),
				capacity: SILK_PER_CART,
				state: this.cartState,
			},
			robot: { state: this.robotTask.state, batchSize: this.robotTask.silkCakeIds.length },
			gantry: {
				state: this.gantryTask.state,
				laneA: this.gantryLaneA.filter(Boolean).length,
				laneB: this.gantryLaneB.filter(Boolean).length,
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
			sections: this.flowRuntime.sections.getSnapshots(),
			entities: this.flowRuntime.entities.getAll(),
		};
	}

	private applySilkLineSectionCapacities(route: TwinRouteDefinition) {
		const capacities: Record<string, number> = {
			'pack-edge-scan': 6,
			'pack-edge-load': 6,
			'pack-edge-left-pack': 3,
			'pack-edge-right-pack': 3,
			'pack-edge-return-main': Math.max(6, Math.min(24, this.palletCount || 24)),
		};
		for (const edge of route.edges || []) {
			if (capacities[edge.edgeId] !== undefined) edge.capacity = capacities[edge.edgeId];
			if (!edge.occupancyMode) edge.occupancyMode = 'simulation';
		}
	}

	private resolveSectionIds(edges: TwinRouteEdgeDefinition[]) {
		const byId = (id: string) => edges.find((edge) => edge.edgeId === id)?.edgeId;
		return {
			loading: byId('pack-edge-scan') || edges[0]?.edgeId,
			transit: byId('pack-edge-load') || edges[1]?.edgeId || edges[0]?.edgeId,
			laneA: byId('pack-edge-left-pack') || edges[2]?.edgeId || edges[0]?.edgeId,
			laneB: byId('pack-edge-right-pack') || edges[3]?.edgeId || edges[0]?.edgeId,
			returning: byId('pack-edge-return-main') || edges[edges.length - 1]?.edgeId || edges[0]?.edgeId,
		};
	}

	private transferPallet(pallet: PlasticPalletRuntime, targetSectionId: string | undefined) {
		if (!targetSectionId) return true;
		const entity = this.flowRuntime.entities.ensure(pallet.palletId);
		const result = this.flowRuntime.sections.tryTransfer(pallet.palletId, entity.currentSectionId, targetSectionId);
		if (!result.canAccept) {
			const reason: TwinFlowWaitingReason = result.reason === 'signal-stale'
				? 'TARGET_SECTION_SIGNAL_STALE'
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
			const runtime: PlasticPalletRuntime = { palletId, root, cakeAnchor, stage: 'source-queue', progress: 0, loaded: false };
			this.pallets.set(palletId, runtime);
			this.sourceQueue.push(palletId);
			this.flowRuntime.entities.ensure(palletId);
			group.add(root);
		}
		this.group.add(group);
	}

	private createPlasticPallet(palletId: string) {
		const root = new THREE.Group();
		root.name = palletId;
		root.userData.entityType = 'plastic-pallet';
		root.userData.entityId = palletId;
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
		const runtime: SilkCakeRuntime = { silkCakeId: id, root, state: 'on-cart', side, row, column };
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
		this.addRollerLane(conveyors, new THREE.Vector3(-11, 0.55, -5.8), new THREE.Vector3(4.5, 0.55, -5.8), 1.55, '机器人上料及主输送');
		this.addRollerLane(conveyors, new THREE.Vector3(4.5, 0.55, -5.8), new THREE.Vector3(13, 0.55, -7.6), 1.55, '桁架塑料托盘A线');
		this.addRollerLane(conveyors, new THREE.Vector3(4.5, 0.55, -5.8), new THREE.Vector3(13, 0.55, -4.2), 1.55, '桁架塑料托盘B线');
		this.addRollerLane(conveyors, new THREE.Vector3(13, 0.55, -5.9), new THREE.Vector3(15, 0.55, 4.8), 1.55, '空托盘回流东段');
		this.addRollerLane(conveyors, new THREE.Vector3(15, 0.55, 4.8), new THREE.Vector3(-12.5, 0.55, 4.8), 1.55, '空托盘回流主段');
		this.addRollerLane(conveyors, new THREE.Vector3(-12.5, 0.55, 4.8), new THREE.Vector3(-10, 0.55, -5.8), 1.55, '空托盘回流入口');
		this.group.add(conveyors);
	}

	private addRollerLane(parent: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, width: number, name: string) {
		const delta = to.clone().sub(from);
		const length = Math.hypot(delta.x, delta.z);
		if (length <= 0.01) return;
		const segment = new THREE.Group();
		segment.name = name;
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
		const x0 = 6.2, x1 = 14.2, z0 = -9.5, z1 = 1.0;
		for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as Array<[number, number]>) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 4.8, 0.24), this.frameMaterial);
			post.position.set(x, 2.4, z);
			this.gantryRoot.add(post);
		}
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, 4.8, z0), new THREE.Vector3(x1, 4.8, z0), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, 4.8, z1), new THREE.Vector3(x1, 4.8, z1), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x0, 4.8, z0), new THREE.Vector3(x0, 4.8, z1), 0.16);
		this.addBeam(this.gantryRoot, new THREE.Vector3(x1, 4.8, z0), new THREE.Vector3(x1, 4.8, z1), 0.16);
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(6.8, 0.55, -7.6), new THREE.Vector3(13.2, 0.55, -7.6), 1.5, 'Gantry-Lane-A-3位');
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(6.8, 0.55, -4.2), new THREE.Vector3(13.2, 0.55, -4.2), 1.5, 'Gantry-Lane-B-3位');
		this.addRollerLane(this.gantryRoot, new THREE.Vector3(6.8, 0.42, -0.8), new THREE.Vector3(14.4, 0.42, -0.8), 2.1, 'Gantry-Wood-Pallet-Lane');
		this.gantryCarriage.name = 'Gantry-X-Carriage';
		const carriageBeam = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.22, 0.34), this.safetyMaterial);
		this.gantryCarriage.add(carriageBeam);
		this.gantryCarriage.position.set(10, 4.35, -5.9);
		this.gantryRoot.add(this.gantryCarriage);
		this.gantryLift.name = 'Gantry-Lift';
		const liftBar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.2, 0.22), this.darkFrameMaterial);
		liftBar.position.y = -1.1;
		this.gantryLift.add(liftBar);
		this.gantryLift.position.y = -0.1;
		this.gantryCarriage.add(this.gantryLift);
		this.gantryGripper.name = 'GantryGripper-2x3';
		this.gantryGripper.position.y = -2.2;
		const gripperFrame = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 2.4), this.robotJointMaterial);
		this.gantryGripper.add(gripperFrame);
		for (let row = 0; row < 2; row += 1) for (let column = 0; column < 3; column += 1) {
			const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 16), this.robotJointMaterial);
			head.position.set(-1.6 + column * 1.6, -0.2, -0.8 + row * 1.6);
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

	private buildPostProcessLine() {
		const process = new THREE.Group();
		process.name = '木托盘后包装与立库入库线';
		this.addRollerLane(process, new THREE.Vector3(13.2, 0.42, -0.8), new THREE.Vector3(32.5, 0.42, -0.8), 2.2, '满托后包装辊道');
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
		for (const z of [-1.8, 0.2]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.0, 0.16), material);
			post.position.set(x, 1.5, z);
			portal.add(post);
		}
		const top = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 2.2), material);
		top.position.set(x, 3.0, -0.8);
		portal.add(top);
		parent.add(portal);
	}

	private buildWarehouse(parent: THREE.Group) {
		const warehouse = new THREE.Group();
		warehouse.name = '立体库入库口';
		for (const x of [33.5, 36.5]) for (const z of [-3.5, 1.8]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5.2, 0.18), this.frameMaterial);
			post.position.set(x, 2.6, z);
			warehouse.add(post);
		}
		for (let level = 0; level < 4; level += 1) {
			const y = 0.7 + level * 1.35;
			const shelfA = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 0.18), this.frameMaterial);
			shelfA.position.set(35, y, -3.4);
			warehouse.add(shelfA);
			const shelfB = shelfA.clone();
			shelfB.position.z = 1.7;
			warehouse.add(shelfB);
		}
		parent.add(warehouse);
	}

	private buildFloorLabels() {
		const zones: Array<[string, number, THREE.Vector3, THREE.Vector3]> = [
			['机器人上料区', 0x0ea5e9, new THREE.Vector3(-6, 0.015, -7.4), new THREE.Vector3(12, 0.02, 7.5)],
			['桁架码垛区', 0xf59e0b, new THREE.Vector3(10, 0.015, -4.3), new THREE.Vector3(9, 0.02, 11.5)],
			['后包装区', 0xa855f7, new THREE.Vector3(22, 0.015, -0.8), new THREE.Vector3(18, 0.02, 4.2)],
		];
		for (const [name, color, position, size] of zones) {
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.09, roughness: 1 }));
			mesh.name = name;
			mesh.position.copy(position);
			this.group.add(mesh);
		}
	}

	private feedInitialPlasticPallets() {
		this.tryFillLoadingSlots();
	}

	private tryFillLoadingSlots() {
		for (let index = 0; index < ROBOT_BATCH; index += 1) {
			if (this.loadingSlots[index]) continue;
			const palletId = this.sourceQueue[0];
			if (!palletId) break;
			const pallet = this.pallets.get(palletId);
			if (!pallet) {
				this.sourceQueue.shift();
				continue;
			}
			if (!this.transferPallet(pallet, this.sectionIds.loading)) break;
			this.sourceQueue.shift();
			this.loadingSlots[index] = palletId;
			pallet.stage = 'loading';
			pallet.loadSlot = index;
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
		this.robotTask = {
			state: 'picking',
			progress: 0,
			side: this.currentSide,
			row: this.currentRow,
			palletIds,
			silkCakeIds: rowSlots.map((slot) => slot.silkCakeId!),
			attachedAtPick: false,
			attachedAtPlace: false,
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
		const duration = 5.0;
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
		// 机器人只负责把 6 个空托盘变成 Loaded。是否能离开上料位由 Section Capacity 决定，
		// 后续 updatePlasticPalletFlow 会持续重试，避免下游满时只尝试一次造成死锁。
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
			this.cartState = 'replacing';
			this.cartReplaceProgress += deltaSeconds;
			if (this.cartReplaceProgress >= 4.0) this.replaceSilkCart();
		}
	}

	private updatePlasticPalletFlow(deltaSeconds: number) {
		const transitSpeed = Math.max(0.25, this.speed) / 8;
		for (const pallet of this.pallets.values()) {
			// Loaded 托盘停在上料位时持续尝试进入下游 Section；下游满则保留原位 Waiting，
			// 下游一旦释放 Capacity 即自动 Resume，不依赖机器人任务结束瞬间的一次性 Transfer。
			if (pallet.stage === 'loading' && pallet.loaded && pallet.loadSlot !== undefined) {
				const loadSlot = pallet.loadSlot;
				if (this.transferPallet(pallet, this.sectionIds.transit)) {
					this.loadingSlots[loadSlot] = undefined;
					pallet.stage = loadSlot < 3 ? 'to-gantry-a' : 'to-gantry-b';
					pallet.progress = 0;
				}
				continue;
			}
			if (pallet.stage === 'to-gantry-a' || pallet.stage === 'to-gantry-b') {
				pallet.progress = clamp01(pallet.progress + deltaSeconds * transitSpeed);
				if (pallet.progress < 1) continue;
				const lane = pallet.stage === 'to-gantry-a' ? this.gantryLaneA : this.gantryLaneB;
				const freeIndex = lane.findIndex((item) => !item);
				if (freeIndex < 0) {
					pallet.progress = 0.985;
					pallet.waitingReason = 'TARGET_SECTION_FULL';
					continue;
				}
				const targetSection = pallet.stage === 'to-gantry-a' ? this.sectionIds.laneA : this.sectionIds.laneB;
				if (!this.transferPallet(pallet, targetSection)) {
					pallet.progress = 0.985;
					continue;
				}
				lane[freeIndex] = pallet.palletId;
				pallet.gantrySlot = freeIndex;
				pallet.stage = pallet.stage === 'to-gantry-a' ? 'gantry-a' : 'gantry-b';
				pallet.progress = 1;
				delete pallet.loadSlot;
				delete pallet.waitingReason;
			}
			if (pallet.stage === 'returning') {
				pallet.progress = clamp01(pallet.progress + deltaSeconds * transitSpeed * 0.75);
				if (pallet.progress < 1) continue;
				const freeLoadSlot = this.loadingSlots.findIndex((item) => !item);
				if (freeLoadSlot < 0 || !this.transferPallet(pallet, this.sectionIds.loading)) {
					pallet.progress = 0.985;
					continue;
				}
				this.loadingSlots[freeLoadSlot] = pallet.palletId;
				pallet.stage = 'loading';
				pallet.loadSlot = freeLoadSlot;
				pallet.progress = 1;
				delete pallet.gantrySlot;
				delete pallet.returnFrom;
			}
		}
	}

	private tryStartGantryBatch() {
		if (this.gantryTask.state !== 'idle') return;
		if (!this.activeWoodPallet || this.activeWoodPallet.layer >= WOOD_MAX_LAYERS) return;
		const palletIds = [...this.gantryLaneA, ...this.gantryLaneB].filter((item): item is string => Boolean(item));
		if (palletIds.length !== GANTRY_BATCH) return;
		const pallets = palletIds.map((id) => this.pallets.get(id)).filter(Boolean) as PlasticPalletRuntime[];
		if (pallets.some((item) => !item.loaded || !item.silkCakeId)) return;
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
			this.gantryCarriage.position.set(10, 4.35, -5.9);
			return;
		}
		const duration = 5.0;
		this.gantryTask.progress = clamp01(this.gantryTask.progress + deltaSeconds / duration);
		const p = this.gantryTask.progress;
		if (p < 0.45) {
			this.gantryCarriage.position.x = 10;
			this.gantryCarriage.position.z = -5.9;
			this.gantryLift.position.y = -Math.sin((p / 0.45) * Math.PI) * 0.75;
		} else {
			const local = (p - 0.45) / 0.55;
			this.gantryCarriage.position.z = THREE.MathUtils.lerp(-5.9, -0.8, local);
			this.gantryLift.position.y = -Math.sin(local * Math.PI) * 0.65;
		}
		if (!this.gantryTask.attachedAtPick && p >= 0.28) {
			this.gantryTask.attachedAtPick = true;
			for (const silkCakeId of this.gantryTask.silkCakeIds) {
				const cake = this.cakes.get(silkCakeId);
				if (!cake) continue;
				this.gantryGripper.attach(cake.root);
				cake.state = 'gantry-picking';
			}
		}
		if (!this.gantryTask.attachedAtPlace && p >= 0.78 && this.activeWoodPallet) {
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
		for (const palletId of this.gantryTask.palletIds) {
			const pallet = this.pallets.get(palletId);
			if (!pallet) continue;
			pallet.loaded = false;
			delete pallet.silkCakeId;
			pallet.cakeAnchor.clear();
			const fromLane: 'A' | 'B' = pallet.stage === 'gantry-a' ? 'A' : 'B';
			const lane = fromLane === 'A' ? this.gantryLaneA : this.gantryLaneB;
			const index = lane.indexOf(palletId);
			if (index >= 0) lane[index] = undefined;
			if (this.transferPallet(pallet, this.sectionIds.returning)) {
				pallet.returnFrom = fromLane;
				pallet.stage = 'returning';
				pallet.progress = 0;
			}
		}
		if (this.activeWoodPallet && this.activeWoodPallet.layer >= WOOD_MAX_LAYERS) {
			this.activeWoodPallet.stage = 'covering';
			this.activeWoodPallet.progress = 0;
			this.woodProcessQueue.push(this.activeWoodPallet);
			this.activeWoodPallet = undefined;
			this.feedNewWoodPallet();
		}
		this.gantryTask = this.createIdleGantryTask();
	}

	private updateWoodPostProcess(deltaSeconds: number) {
		for (const wood of this.woodProcessQueue) {
			if (wood.stage === 'stored') continue;
			const duration = wood.stage === 'covering' ? 3 : wood.stage === 'labeling' ? 2 : wood.stage === 'wrapping' ? 7 : wood.stage === 'inbound' ? 5 : 1;
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
				pallet.root.position.set(-14 - Math.floor(Math.max(0, queueIndex) / 8) * 1.0, 0.94, -5.8 + (Math.max(0, queueIndex) % 8) * 0.26);
				continue;
			}
			if (pallet.stage === 'to-gantry-a' || pallet.stage === 'to-gantry-b') {
				const from = pallet.loadSlot !== undefined ? LOAD_SLOT_POSITIONS[pallet.loadSlot] : LOAD_SLOT_POSITIONS[5];
				const target = pallet.stage === 'to-gantry-a' ? GANTRY_LANE_A_POSITIONS[2] : GANTRY_LANE_B_POSITIONS[2];
				lerpPose(pallet.root, from, target, pallet.progress);
				continue;
			}
			if (pallet.stage === 'gantry-a' && pallet.gantrySlot !== undefined) pallet.root.position.copy(GANTRY_LANE_A_POSITIONS[pallet.gantrySlot]);
			if (pallet.stage === 'gantry-b' && pallet.gantrySlot !== undefined) pallet.root.position.copy(GANTRY_LANE_B_POSITIONS[pallet.gantrySlot]);
			if (pallet.stage === 'returning') {
				const slot = pallet.gantrySlot ?? 2;
				const start = pallet.returnFrom === 'A' ? GANTRY_LANE_A_POSITIONS[slot] : GANTRY_LANE_B_POSITIONS[slot];
				const p = pallet.progress;
				if (p < 0.28) lerpPose(pallet.root, start, RETURN_CORNER_EAST, p / 0.28);
				else if (p < 0.76) lerpPose(pallet.root, RETURN_CORNER_EAST, RETURN_CORNER_WEST, (p - 0.28) / 0.48);
				else lerpPose(pallet.root, RETURN_CORNER_WEST, LOAD_SLOT_POSITIONS[0], (p - 0.76) / 0.24);
			}
		}
		if (this.activeWoodPallet?.stage === 'stacking') this.activeWoodPallet.root.position.copy(WOOD_STACK_POSITION);
	}

	private createIdleRobotTask(): RobotTaskRuntime {
		return { state: 'idle', progress: 0, side: this.currentSide, row: this.currentRow, palletIds: [], silkCakeIds: [], attachedAtPick: false, attachedAtPlace: false };
	}

	private createIdleGantryTask(): GantryTaskRuntime {
		return { state: 'idle', progress: 0, palletIds: [], silkCakeIds: [], targetLayer: 0, attachedAtPick: false, attachedAtPlace: false };
	}
}