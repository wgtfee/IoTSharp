import * as THREE from 'three';
import type { PlasticPalletDefinition, SilkCakeDefinition, SilkCartDefinition, SilkCartSlotDefinition, TwinRouteDefinition } from '/@/digital-twin/contracts';
import type { GantryStackSnapshot } from '/@/digital-twin/runtime/GantryStackController';
import type { PalletFlowSnapshot } from '/@/digital-twin/runtime/PalletFlowController';
import type { RobotLoadingSnapshot } from '/@/digital-twin/runtime/RobotLoadingController';
import type { RotaryTableRuntimeSnapshot } from '/@/digital-twin/runtime/RotaryTableController';
import type { SilkCakeStackRuntime } from '/@/digital-twin/runtime/StackAreaManager';
import { TwinSectionGeometryResolver } from '/@/digital-twin/runtime/TwinSectionGeometryResolver';

export interface SilkCakeLineVisualState {
	palletFlow: PalletFlowSnapshot;
	cakes: SilkCakeDefinition[];
	cart?: SilkCartDefinition;
	slots: SilkCartSlotDefinition[];
	rotary: RotaryTableRuntimeSnapshot;
	robot: RobotLoadingSnapshot;
	gantry: GantryStackSnapshot;
	stack: SilkCakeStackRuntime;
}

interface RobotRig {
	shoulder: any;
	elbow: any;
	wrist: any;
	gripper: any;
}

const shadow = (root: any) => root.traverse((child: any) => {
	if (!child.isMesh) return;
	child.castShadow = true;
	child.receiveShadow = true;
});

const segmentValue = (progress: number, from: number, to: number) => THREE.MathUtils.smoothstep(progress, from, to);

/** 纯 Three.js 显示层：不决定容量、路线、任务或载具关系。 */
export class ProceduralSilkCakeLine {
	readonly group = new THREE.Group();
	private readonly palletObjects = new Map<string, any>();
	private readonly cakeObjects = new Map<string, any>();
	private readonly slotObjects = new Map<string, any>();
	private readonly frameMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.46, metalness: 0.76 });
	private readonly beltMaterial = new THREE.MeshStandardMaterial({ color: 0x101827, roughness: 0.82, metalness: 0.14 });
	private readonly rollerMaterial = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.28, metalness: 0.88 });
	private readonly safetyMaterial = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b2400, roughness: 0.36, metalness: 0.42 });
	private readonly plasticMaterial = new THREE.MeshStandardMaterial({ color: 0x15803d, emissive: 0x052e16, roughness: 0.48, metalness: 0.12 });
	private readonly silkMaterial = new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0x252b34, roughness: 0.82, metalness: 0.02 });
	private readonly robotMaterial = new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0x2b1204, roughness: 0.32, metalness: 0.42 });
	private readonly jointMaterial = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.3, metalness: 0.84 });
	private readonly sensorMaterial = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x075985, roughness: 0.2, metalness: 0.3 });
	private readonly cartRoot = new THREE.Group();
	private readonly rotaryDisc = new THREE.Group();
	private readonly stackRoot = new THREE.Group();
	private readonly gantryCarriage = new THREE.Group();
	private readonly gantryGripper = new THREE.Group();
	private readonly robotRig: RobotRig;
	private currentCartId?: string;

	constructor(private route: TwinRouteDefinition, private readonly geometry: TwinSectionGeometryResolver, palletCount: number) {
		this.group.name = '丝饼生产物流数字孪生场景';
		this.buildConveyors();
		this.buildRotaryAndCart();
		this.robotRig = this.buildLoadingRobot();
		this.buildGantryAndStack();
		this.buildSafetyAndSensors();
		for (let index = 0; index < palletCount; index += 1) this.createPlasticPallet(`PlasticPallet-${String(index + 1).padStart(3, '0')}`);
		shadow(this.group);
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = route;
	}

	updateVisuals(state: SilkCakeLineVisualState) {
		this.syncCart(state.cart, state.slots);
		this.syncCakes(state.cakes, state.slots);
		this.rotaryDisc.rotation.y = state.rotary.currentAngle;
		this.updatePallets(state.palletFlow);
		this.updateRobot(state.robot);
		this.updateGantry(state.gantry, state.stack);
		this.updateCakeCarriers(state.cakes, state.slots, state.stack);
	}

	private buildConveyors() {
		const parent = new THREE.Group();
		parent.name = '丝饼托盘分段辊道';
		const points = new Map(this.route.points.map((point) => [point.pointId, point]));
		for (const edge of this.route.edges) {
			const from = points.get(edge.fromPointId);
			const to = points.get(edge.toPointId);
			if (!from || !to) continue;
			const dx = to.position[0] - from.position[0];
			const dz = to.position[2] - from.position[2];
			const length = Math.hypot(dx, dz);
			const segment = new THREE.Group();
			segment.name = edge.name || edge.edgeId;
			segment.position.set((from.position[0] + to.position[0]) / 2, from.position[1] - 0.28, (from.position[2] + to.position[2]) / 2);
			segment.rotation.y = -Math.atan2(dz, dx);
			const bed = new THREE.Mesh(new THREE.BoxGeometry(length, 0.18, 1.48), this.beltMaterial);
			segment.add(bed);
			for (const side of [-0.87, 0.87]) {
				const rail = new THREE.Mesh(new THREE.BoxGeometry(length + 0.08, 0.13, 0.09), this.frameMaterial);
				rail.position.set(0, 0.24, side);
				segment.add(rail);
			}
			const rollerCount = Math.max(2, Math.ceil(length / 0.72));
			for (let index = 0; index <= rollerCount; index += 1) {
				const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 1.4, 10), this.rollerMaterial);
				roller.rotation.x = Math.PI / 2;
				roller.position.set(-length / 2 + index / rollerCount * length, 0.13, 0);
				segment.add(roller);
			}
			const legCount = Math.max(2, Math.ceil(length / 3.2));
			for (let index = 0; index <= legCount; index += 1) {
				for (const side of [-0.63, 0.63]) {
					const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.76, 0.12), this.frameMaterial);
					leg.position.set(-length / 2 + index / legCount * length, -0.45, side);
					segment.add(leg);
				}
			}
			parent.add(segment);
		}
		this.group.add(parent);
	}

	private buildRotaryAndCart() {
		const loadingPoint = this.route.points.find((point) => point.pointId === 'silk-loading')?.position || [-10, 0.92, -6];
		const rotary = new THREE.Group();
		rotary.name = '旋转台与丝车供料区';
		rotary.userData.twinEntityType = 'rotary-table';
		rotary.userData.twinEntityId = 'RotaryTable-01';
		rotary.position.set(loadingPoint[0], 0, loadingPoint[2] - 4.3);
		const base = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.2, 0.42, 36), this.jointMaterial);
		base.position.y = 0.22;
		rotary.add(base);
		const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.92, 1.92, 0.18, 36), this.safetyMaterial);
		disc.position.y = 0.52;
		this.rotaryDisc.add(disc);
		this.rotaryDisc.add(this.cartRoot);
		rotary.add(this.rotaryDisc);
		this.cartRoot.name = '丝车';
		this.cartRoot.position.y = 0.62;
		const cartFloor = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.18, 3.1), this.frameMaterial);
		this.cartRoot.add(cartFloor);
		for (const [x, z] of [[-1.35, -1.35], [-1.35, 1.35], [1.35, -1.35], [1.35, 1.35]]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.12), this.frameMaterial);
			post.position.set(x, 1.02, z);
			this.cartRoot.add(post);
			const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14), this.jointMaterial);
			wheel.rotation.z = Math.PI / 2;
			wheel.position.set(x, -0.18, z);
			this.cartRoot.add(wheel);
		}
		this.group.add(rotary);
	}

	private buildLoadingRobot(): RobotRig {
		const loadingPoint = this.route.points.find((point) => point.pointId === 'silk-loading')?.position || [-10, 0.92, -6];
		const root = new THREE.Group();
		root.name = '上料机器人';
		root.userData.twinEntityType = 'loading-robot';
		root.userData.twinEntityId = 'LoadingRobot-01';
		root.position.set(loadingPoint[0] + 2.4, 0, loadingPoint[2] - 2.3);
		const base = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.8, 0.7, 24), this.jointMaterial);
		base.position.y = 0.35;
		root.add(base);
		const shoulder = new THREE.Group();
		shoulder.position.y = 0.9;
		shoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 16), this.jointMaterial));
		const arm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.55, 0.42), this.robotMaterial);
		arm.position.y = 0.75;
		shoulder.add(arm);
		root.add(shoulder);
		const elbow = new THREE.Group();
		elbow.position.y = 1.5;
		elbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 16), this.jointMaterial));
		const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.36, 1.32, 0.36), this.robotMaterial);
		forearm.position.y = 0.64;
		elbow.add(forearm);
		shoulder.add(elbow);
		const wrist = new THREE.Group();
		wrist.position.y = 1.28;
		wrist.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 16), this.jointMaterial));
		elbow.add(wrist);
		const gripper = new THREE.Group();
		gripper.name = 'LoadingRobot-01-Gripper';
		gripper.position.y = 0.25;
		for (const side of [-0.25, 0.25]) {
			const finger = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.46, 0.12), this.jointMaterial);
			finger.position.set(side, 0.18, 0);
			gripper.add(finger);
		}
		wrist.add(gripper);
		this.group.add(root);
		return { shoulder, elbow, wrist, gripper };
	}

	private buildGantryAndStack() {
		const gantry = new THREE.Group();
		gantry.name = '桁架码垛机构';
		gantry.userData.twinEntityType = 'gantry-stacker';
		gantry.userData.twinEntityId = 'GantryStacker-01';
		for (const [x, z] of [[22, -11], [31, -11], [22, -2], [31, -2]]) {
			const column = new THREE.Mesh(new THREE.BoxGeometry(0.28, 5.2, 0.28), this.frameMaterial);
			column.position.set(x, 2.6, z);
			gantry.add(column);
		}
		for (const z of [-11, -2]) {
			const beam = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.28, 0.28), this.frameMaterial);
			beam.position.set(26.5, 5.15, z);
			gantry.add(beam);
		}
		for (const x of [22, 31]) {
			const beam = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 9.2), this.frameMaterial);
			beam.position.set(x, 5.15, -6.5);
			gantry.add(beam);
		}
		this.gantryCarriage.name = '桁架移动小车';
		this.gantryCarriage.position.set(25, 5, -6);
		const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.9), this.safetyMaterial);
		this.gantryCarriage.add(trolley);
		const lift = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.8, 0.18), this.jointMaterial);
		lift.position.y = -1.8;
		this.gantryCarriage.add(lift);
		this.gantryGripper.name = 'GantryStacker-01-Gripper';
		this.gantryGripper.position.y = -3.65;
		this.gantryGripper.add(new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 1.15), this.jointMaterial));
		this.gantryCarriage.add(this.gantryGripper);
		gantry.add(this.gantryCarriage);
		this.stackRoot.name = 'Stack-A';
		this.stackRoot.userData.twinEntityType = 'stack-area';
		this.stackRoot.userData.twinEntityId = 'Stack-A';
		this.stackRoot.position.set(28.5, 0.18, -9.2);
		const stackBase = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.24, 3.6), this.safetyMaterial);
		this.stackRoot.add(stackBase);
		gantry.add(this.stackRoot);
		this.group.add(gantry);
	}

	private buildSafetyAndSensors() {
		for (const point of this.route.points.filter((item) => item.kind === 'sensor' || item.kind === 'diverter')) {
			const beacon = new THREE.Group();
			beacon.name = `${point.name}状态灯`;
			beacon.position.set(point.position[0], 0, point.position[2] + 1.5);
			const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.4, 10), this.frameMaterial);
			pole.position.y = 1.2;
			beacon.add(pole);
			const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14), this.sensorMaterial);
			lamp.position.y = 2.35;
			beacon.add(lamp);
			this.group.add(beacon);
		}
	}

	private createPlasticPallet(palletId: string) {
		const pallet = new THREE.Group();
		pallet.name = palletId;
		pallet.userData.twinEntityType = 'plastic-pallet';
		pallet.userData.twinEntityId = palletId;
		const base = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.5, 0.12, 28), this.plasticMaterial);
		pallet.add(base);
		const ring = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.055, 8, 28), this.plasticMaterial);
		ring.rotation.x = Math.PI / 2;
		ring.position.y = 0.08;
		pallet.add(ring);
		const center = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.38, 20), this.plasticMaterial);
		center.position.y = 0.22;
		pallet.add(center);
		for (let index = 0; index < 8; index += 1) {
			const rib = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.055, 0.055), this.plasticMaterial);
			rib.position.set(Math.cos(index * Math.PI / 4) * 0.2, 0.1, Math.sin(index * Math.PI / 4) * 0.2);
			rib.rotation.y = -index * Math.PI / 4;
			pallet.add(rib);
		}
		this.palletObjects.set(palletId, pallet);
		this.group.add(pallet);
	}

	private createSilkCake(cake: SilkCakeDefinition) {
		const root = new THREE.Group();
		root.name = cake.silkCakeId;
		root.userData.twinEntityType = 'silk-cake';
		root.userData.twinEntityId = cake.silkCakeId;
		const yarn = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.17, 14, 36), this.silkMaterial);
		yarn.rotation.x = Math.PI / 2;
		root.add(yarn);
		const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.24, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xd6d3d1, side: THREE.DoubleSide, roughness: 0.88 }));
		root.add(inner);
		this.cakeObjects.set(cake.silkCakeId, root);
		this.group.add(root);
		shadow(root);
		return root;
	}

	private syncCart(cart: SilkCartDefinition | undefined, slots: SilkCartSlotDefinition[]) {
		if (!cart || cart.cartId === this.currentCartId) return;
		for (const slot of this.slotObjects.values()) this.cartRoot.remove(slot);
		this.slotObjects.clear();
		this.currentCartId = cart.cartId;
		this.cartRoot.userData.twinEntityType = 'silk-cart';
		this.cartRoot.userData.twinEntityId = cart.cartId;
		for (const slot of slots) {
			const carrier = new THREE.Group();
			carrier.name = slot.slotId;
			carrier.position.set(...slot.localPosition);
			const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.42, 10), this.frameMaterial);
			pin.rotation.z = Math.PI / 2;
			carrier.add(pin);
			this.slotObjects.set(slot.slotId, carrier);
			this.cartRoot.add(carrier);
		}
	}

	private syncCakes(cakes: SilkCakeDefinition[], slots: SilkCartSlotDefinition[]) {
		for (const cake of cakes) if (!this.cakeObjects.has(cake.silkCakeId)) this.createSilkCake(cake);
		for (const slot of slots) {
			if (!slot.silkCakeId) continue;
			const cake = this.cakeObjects.get(slot.silkCakeId);
			const carrier = this.slotObjects.get(slot.slotId);
			if (cake && carrier && cake.parent !== carrier) {
				carrier.attach(cake);
				cake.position.set(0, 0, 0);
				cake.rotation.set(0, 0, Math.PI / 2);
			}
		}
	}

	private updatePallets(flow: PalletFlowSnapshot) {
		const queueIndex = new Map(flow.sourceQueue.map((id, index) => [id, index]));
		for (const pallet of flow.pallets) {
			const object = this.palletObjects.get(pallet.palletId);
			if (!object) continue;
			if (pallet.currentSectionId) {
				const pose = this.geometry.getPose(pallet.currentSectionId, pallet.sectionProgress);
				if (!pose) continue;
				object.position.copy(pose.position);
				object.rotation.y = Math.atan2(pose.tangent.x, pose.tangent.z);
			} else {
				const index = queueIndex.get(pallet.palletId) ?? 0;
				object.position.set(-20 + index % 5 * 0.92, 0.15, 1.5 + Math.floor(index / 5) * 0.92);
				object.rotation.y = 0;
			}
			object.userData.state = pallet.state;
			object.userData.sectionId = pallet.currentSectionId;
			object.userData.waitingReason = pallet.waitingReason;
		}
	}

	private updateRobot(robot: RobotLoadingSnapshot) {
		const progress = robot.task?.progress ?? 0;
		if (!robot.task) {
			this.robotRig.shoulder.rotation.z = -0.18;
			this.robotRig.elbow.rotation.z = 0.55;
			this.robotRig.wrist.rotation.y = 0;
			return;
		}
		const toPick = segmentValue(progress, 0, 0.25);
		const toPlace = segmentValue(progress, 0.4, 0.78);
		const toHome = segmentValue(progress, 0.82, 1);
		this.robotRig.shoulder.rotation.z = THREE.MathUtils.lerp(-0.18, -0.95, toPick) + THREE.MathUtils.lerp(0, 1.3, toPlace) - THREE.MathUtils.lerp(0, 0.35, toHome);
		this.robotRig.elbow.rotation.z = THREE.MathUtils.lerp(0.55, 1.15, toPick) - THREE.MathUtils.lerp(0, 0.85, toPlace) + THREE.MathUtils.lerp(0, 0.3, toHome);
		this.robotRig.wrist.rotation.y = THREE.MathUtils.lerp(0, Math.PI * 0.7, toPlace) * (1 - toHome);
	}

	private updateGantry(gantry: GantryStackSnapshot, stack: SilkCakeStackRuntime) {
		const task = gantry.task;
		if (!task) {
			this.gantryCarriage.position.set(25, 5, -6);
			return;
		}
		const moveToStack = segmentValue(task.progress, 0.36, 0.72);
		const returnHome = segmentValue(task.progress, 0.84, 1);
		const targetX = this.stackRoot.position.x + (task.targetPosition.column - (stack.columns - 1) / 2) * 0.86;
		const targetZ = this.stackRoot.position.z + (task.targetPosition.row - (stack.rows - 1) / 2) * 0.86;
		this.gantryCarriage.position.x = THREE.MathUtils.lerp(25, targetX, moveToStack) * (1 - returnHome) + 25 * returnHome;
		this.gantryCarriage.position.z = THREE.MathUtils.lerp(-6, targetZ, moveToStack) * (1 - returnHome) - 6 * returnHome;
		this.gantryGripper.position.y = -3.65 - segmentValue(task.progress, 0.12, 0.25) * 0.45 + segmentValue(task.progress, 0.28, 0.42) * 0.45 - segmentValue(task.progress, 0.7, 0.8) * 0.55;
	}

	private updateCakeCarriers(cakes: SilkCakeDefinition[], slots: SilkCartSlotDefinition[], stack: SilkCakeStackRuntime) {
		for (const cake of cakes) {
			const object = this.cakeObjects.get(cake.silkCakeId);
			if (!object) continue;
			let carrier: any;
			if (cake.currentCarrierType === 'plastic-pallet') carrier = this.palletObjects.get(cake.currentCarrierId || '');
			else if (cake.currentCarrierType === 'robot-gripper') carrier = this.robotRig.gripper;
			else if (cake.currentCarrierType === 'gantry-gripper') carrier = this.gantryGripper;
			else if (cake.currentCarrierType === 'stack-area') carrier = this.stackRoot;
			else {
				const slot = slots.find((item) => item.silkCakeId === cake.silkCakeId);
				carrier = slot ? this.slotObjects.get(slot.slotId) : undefined;
			}
			if (!carrier || object.parent === carrier) continue;
			carrier.attach(object);
			if (cake.currentCarrierType === 'plastic-pallet') {
				object.position.set(0, 0.52, 0);
				object.rotation.set(0, 0, 0);
			} else if (cake.currentCarrierType === 'stack-area' && cake.stackPosition) {
				object.position.set(
					(cake.stackPosition.column - (stack.columns - 1) / 2) * 0.86,
					0.3 + cake.stackPosition.layer * 0.38,
					(cake.stackPosition.row - (stack.rows - 1) / 2) * 0.86,
				);
				object.rotation.set(0, 0, 0);
			} else if (cake.currentCarrierType === 'robot-gripper' || cake.currentCarrierType === 'gantry-gripper') {
				object.position.set(0, 0.38, 0);
				object.rotation.set(0, 0, 0);
			}
		}
	}
}
