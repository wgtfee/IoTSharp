import * as THREE from 'three';
import type { TwinRouteDefinition, TwinRoutePointDefinition } from '/@/digital-twin/contracts';
import { resolveRoutePath } from '/@/digital-twin/routes/RouteEngine';

interface PalletEntity {
	root: any;
	path: 'A' | 'B';
	distance: number;
	initialDistance: number;
}

interface RobotRig {
	shoulder: any;
	elbow: any;
	wrist: any;
	phase: number;
}

interface PalletPath {
	curve: any;
	length: number;
}

const markShadow = (object: any) => {
	object.traverse((child: any) => {
		if (!child.isMesh) return;
		child.castShadow = true;
		child.receiveShadow = true;
	});
};

/**
 * 无外部模型依赖的包装线演示组件。
 * 线体几何来自路线边，A/B 托盘复用同一份岔口规则生成两条确定性闭环路径。
 */
export class ProceduralPackagingLine {
	readonly group = new THREE.Group();
	private route: TwinRouteDefinition;
	private readonly palletCount: number;
	private readonly pallets: PalletEntity[] = [];
	private readonly turntableDiscs: any[] = [];
	private readonly robotRigs: RobotRig[] = [];
	private readonly diverterBlade = new THREE.Group();
	private paths: Record<'A' | 'B', PalletPath>;
	private running = false;
	private speed = 1.35;
	private elapsedSeconds = 0;

	private readonly frameMaterial = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.48, metalness: 0.76 });
	private readonly darkFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.58, metalness: 0.68 });
	private readonly beltMaterial = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.82, metalness: 0.12 });
	private readonly rollerMaterial = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.32, metalness: 0.86 });
	private readonly safetyMaterial = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3b2400, roughness: 0.36, metalness: 0.42 });
	private readonly robotMaterial = new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0x2b1204, roughness: 0.32, metalness: 0.42 });
	private readonly robotJointMaterial = new THREE.MeshStandardMaterial({ color: 0x202b3c, roughness: 0.34, metalness: 0.82 });
	private readonly sensorMaterial = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x064e5c, roughness: 0.24, metalness: 0.32 });

	constructor(route: TwinRouteDefinition, palletCount = 50) {
		this.route = structuredClone(route);
		this.palletCount = Math.min(200, Math.max(1, Math.floor(palletCount)));
		this.speed = route.defaultSpeed;
		this.paths = this.createPaths();
		this.group.name = '50托盘智能包装线';
		this.buildConveyorNetwork();
		this.buildStations();
		this.buildGantry();
		this.buildPallets();
		markShadow(this.group);
	}

	setRunning(running: boolean) {
		this.running = running;
	}

	setSpeed(speed: number) {
		if (Number.isFinite(speed) && speed > 0) this.speed = speed;
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = structuredClone(route);
		this.speed = route.defaultSpeed;
		this.paths = this.createPaths();
		this.distributePallets();
	}

	reset() {
		this.running = false;
		this.elapsedSeconds = 0;
		for (const pallet of this.pallets) pallet.distance = pallet.initialDistance;
		this.applyPalletPoses();
		this.applyMachineAnimation();
	}

	updateFixed(deltaSeconds: number) {
		if (!this.running || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		this.elapsedSeconds += deltaSeconds;
		for (const pallet of this.pallets) {
			const path = this.paths[pallet.path];
			if (path.length <= 0) continue;
			pallet.distance = (pallet.distance + this.speed * deltaSeconds) % path.length;
		}
		this.applyPalletPoses();
		this.applyMachineAnimation();
	}

	getSnapshot() {
		return {
			palletCount: this.pallets.length,
			running: this.running,
			speed: this.speed,
			pathLengths: { A: this.paths.A.length, B: this.paths.B.length },
		};
	}

	private createPaths(): Record<'A' | 'B', PalletPath> {
		return {
			A: this.createPath('A'),
			B: this.createPath('B'),
		};
	}

	private createPath(sku: 'A' | 'B'): PalletPath {
		const resolved = resolveRoutePath(this.route, { payload: { sku } });
		const curve = new THREE.CurvePath();
		for (let index = 0; index < resolved.points.length - 1; index += 1) {
			curve.add(new THREE.LineCurve3(new THREE.Vector3(...resolved.points[index].position), new THREE.Vector3(...resolved.points[index + 1].position)));
		}
		if (resolved.closed && resolved.points.length > 1) {
			curve.add(new THREE.LineCurve3(new THREE.Vector3(...resolved.points[resolved.points.length - 1].position), new THREE.Vector3(...resolved.points[0].position)));
		}
		return { curve, length: curve.getLength() };
	}

	private buildConveyorNetwork() {
		const points = new Map(this.route.points.map((point) => [point.pointId, point]));
		const conveyorGroup = new THREE.Group();
		conveyorGroup.name = '输送机网络（含分叉与汇流）';
		for (const edge of this.route.edges || []) {
			if (edge.enabled === false) continue;
			const from = points.get(edge.fromPointId);
			const to = points.get(edge.toPointId);
			if (from && to) this.addConveyorSegment(conveyorGroup, from, to, edge.name || edge.edgeId);
		}
		this.group.add(conveyorGroup);
	}

	private addConveyorSegment(parent: any, from: TwinRoutePointDefinition, to: TwinRoutePointDefinition, name: string) {
		const deltaX = to.position[0] - from.position[0];
		const deltaZ = to.position[2] - from.position[2];
		const length = Math.hypot(deltaX, deltaZ);
		if (length < 0.05) return;
		const segment = new THREE.Group();
		segment.name = name;
		segment.position.set((from.position[0] + to.position[0]) / 2, from.position[1] - 0.27, (from.position[2] + to.position[2]) / 2);
		segment.rotation.y = -Math.atan2(deltaZ, deltaX);

		const belt = new THREE.Mesh(new THREE.BoxGeometry(length, 0.2, 1.58), this.beltMaterial);
		belt.name = `${name}_皮带`;
		segment.add(belt);

		for (const side of [-0.9, 0.9]) {
			const rail = new THREE.Mesh(new THREE.BoxGeometry(length + 0.08, 0.14, 0.1), this.frameMaterial);
			rail.name = `${name}_护栏`;
			rail.position.set(0, 0.23, side);
			segment.add(rail);
		}

		const rollerCount = Math.max(2, Math.ceil(length / 0.85));
		for (let index = 0; index <= rollerCount; index += 1) {
			const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 1.48, 12), this.rollerMaterial);
			roller.name = `${name}_滚筒_${index + 1}`;
			roller.rotation.x = Math.PI / 2;
			roller.position.set(-length / 2 + length * index / rollerCount, 0.14, 0);
			segment.add(roller);
		}

		const legCount = Math.max(2, Math.ceil(length / 3));
		for (let index = 0; index <= legCount; index += 1) {
			const x = -length / 2 + length * index / legCount;
			for (const z of [-0.68, 0.68]) {
				const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.78, 0.13), this.darkFrameMaterial);
				leg.name = `${name}_支腿`;
				leg.position.set(x, -0.46, z);
				segment.add(leg);
			}
		}

		parent.add(segment);
	}

	private buildStations() {
		const pointIndex = new Map(this.route.points.map((point) => [point.pointId, point]));
		const scan = pointIndex.get('pack-scan');
		const load = pointIndex.get('pack-load');
		if (scan) this.addPortal(scan.position[0], scan.position[2], '扫码检测门', this.sensorMaterial);
		if (load) this.addPortal(load.position[0], load.position[2], '自动装箱门', this.safetyMaterial);

		const leftTurn = pointIndex.get('pack-left-turntable');
		const rightTurn = pointIndex.get('pack-right-turntable');
		if (leftTurn) this.addTurntable(leftTurn.position, '左线旋转台');
		if (rightTurn) this.addTurntable(rightTurn.position, '右线旋转台');

		const leftRobot = pointIndex.get('pack-left-robot');
		const rightRobot = pointIndex.get('pack-right-robot');
		if (leftRobot) this.addRobot([leftRobot.position[0], 0, leftRobot.position[2] - 2.35], 0);
		if (rightRobot) this.addRobot([rightRobot.position[0], 0, rightRobot.position[2] + 2.35], Math.PI);

		const diverter = pointIndex.get('pack-diverter');
		if (diverter) this.addDiverter(diverter.position);
		const merger = pointIndex.get('pack-merger');
		if (merger) this.addBufferBeacon(merger.position, '汇流状态灯');
	}

	private addPortal(x: number, z: number, name: string, material: any) {
		const portal = new THREE.Group();
		portal.name = name;
		portal.position.set(x, 0, z);
		for (const side of [-1.35, 1.35]) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.8, 0.16), material);
			post.position.set(0, 1.4, side);
			portal.add(post);
		}
		const beam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 2.86), material);
		beam.position.y = 2.75;
		portal.add(beam);
		const sensor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.5), this.sensorMaterial);
		sensor.position.set(0, 2.48, 0);
		portal.add(sensor);
		this.group.add(portal);
	}

	private addTurntable(position: [number, number, number], name: string) {
		const station = new THREE.Group();
		station.name = name;
		station.position.set(position[0], 0, position[2]);
		const base = new THREE.Mesh(new THREE.CylinderGeometry(1.28, 1.35, 0.35, 32), this.darkFrameMaterial);
		base.position.y = 0.52;
		station.add(base);
		const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.17, 1.17, 0.16, 32), this.safetyMaterial);
		disc.name = `${name}_转盘`;
		disc.position.y = 0.76;
		station.add(disc);
		for (let index = 0; index < 4; index += 1) {
			const marker = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.06, 0.09), this.sensorMaterial);
			marker.position.y = 0.86;
			marker.rotation.y = index * Math.PI / 2;
			disc.add(marker);
		}
		this.turntableDiscs.push(disc);
		this.group.add(station);
	}

	private addRobot(position: [number, number, number], rotationY: number) {
		const robot = new THREE.Group();
		robot.name = `包装机器人_${this.robotRigs.length + 1}`;
		robot.position.set(...position);
		robot.rotation.y = rotationY;
		const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.82, 0.6, 24), this.robotJointMaterial);
		pedestal.position.y = 0.3;
		robot.add(pedestal);
		const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.58, 0.5, 24), this.robotMaterial);
		turret.position.y = 0.78;
		robot.add(turret);

		const shoulder = new THREE.Group();
		shoulder.position.y = 1;
		const shoulderJoint = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 18), this.robotJointMaterial);
		shoulder.add(shoulderJoint);
		const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.48, 1.65, 0.48), this.robotMaterial);
		upperArm.position.y = 0.8;
		shoulder.add(upperArm);
		robot.add(shoulder);

		const elbow = new THREE.Group();
		elbow.position.y = 1.62;
		const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.33, 18, 18), this.robotJointMaterial);
		elbow.add(elbowJoint);
		const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.42, 0.4), this.robotMaterial);
		forearm.position.y = 0.69;
		elbow.add(forearm);
		shoulder.add(elbow);

		const wrist = new THREE.Group();
		wrist.position.y = 1.4;
		const wristJoint = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.38, 18), this.robotJointMaterial);
		wristJoint.rotation.z = Math.PI / 2;
		wrist.add(wristJoint);
		for (const side of [-0.2, 0.2]) {
			const finger = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.48, 0.1), this.robotJointMaterial);
			finger.position.set(side, -0.28, 0);
			wrist.add(finger);
		}
		elbow.add(wrist);
		this.robotRigs.push({ shoulder, elbow, wrist, phase: this.robotRigs.length * Math.PI });
		this.group.add(robot);
	}

	private addDiverter(position: [number, number, number]) {
		this.diverterBlade.name = '分流岔口摆臂';
		this.diverterBlade.position.set(position[0], position[1] + 0.08, position[2]);
		const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 18), this.safetyMaterial);
		pivot.position.y = 0.08;
		this.diverterBlade.add(pivot);
		const blade = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 0.16), this.safetyMaterial);
		blade.position.x = 1.05;
		this.diverterBlade.add(blade);
		this.group.add(this.diverterBlade);
	}

	private addBufferBeacon(position: [number, number, number], name: string) {
		const beacon = new THREE.Group();
		beacon.name = name;
		beacon.position.set(position[0] + 1.7, 0, position[2]);
		const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.5, 12), this.frameMaterial);
		pole.position.y = 1.25;
		beacon.add(pole);
		for (const [index, color] of [0x22c55e, 0xf59e0b, 0xef4444].entries()) {
			const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: index === 0 ? 1.4 : 0.18 }));
			lamp.position.set(0, 2.15 + index * 0.3, 0);
			beacon.add(lamp);
		}
		this.group.add(beacon);
	}

	private buildGantry() {
		const gantry = new THREE.Group();
		gantry.name = '包装线桁架';
		const corners: Array<[number, number]> = [[5, -12], [19, -12], [5, 0], [19, 0]];
		for (const [x, z] of corners) {
			const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, 4.7, 0.26), this.frameMaterial);
			post.position.set(x, 2.35, z);
			gantry.add(post);
		}
		this.addBeamBetween(gantry, [5, 4.7, -12], [19, 4.7, -12], 0.24, this.frameMaterial);
		this.addBeamBetween(gantry, [5, 4.7, 0], [19, 4.7, 0], 0.24, this.frameMaterial);
		this.addBeamBetween(gantry, [5, 4.7, -12], [5, 4.7, 0], 0.24, this.frameMaterial);
		this.addBeamBetween(gantry, [19, 4.7, -12], [19, 4.7, 0], 0.24, this.frameMaterial);
		for (const x of [7.5, 10, 12.5, 15, 17.5]) {
			this.addBeamBetween(gantry, [x, 4.7, -12], [x, 4.7, 0], 0.09, this.safetyMaterial);
		}
		this.addBeamBetween(gantry, [5, 0.2, -12], [19, 4.5, -12], 0.08, this.darkFrameMaterial);
		this.addBeamBetween(gantry, [19, 0.2, -12], [5, 4.5, -12], 0.08, this.darkFrameMaterial);
		this.addBeamBetween(gantry, [5, 0.2, 0], [19, 4.5, 0], 0.08, this.darkFrameMaterial);
		this.addBeamBetween(gantry, [19, 0.2, 0], [5, 4.5, 0], 0.08, this.darkFrameMaterial);
		this.group.add(gantry);
	}

	private addBeamBetween(parent: any, from: [number, number, number], to: [number, number, number], radius: number, material: any) {
		const start = new THREE.Vector3(...from);
		const end = new THREE.Vector3(...to);
		const direction = end.clone().sub(start);
		const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 10), material);
		beam.position.copy(start).add(end).multiplyScalar(0.5);
		beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
		parent.add(beam);
	}

	private buildPallets() {
		const palletsGroup = new THREE.Group();
		palletsGroup.name = `${this.palletCount}个运行托盘`;
		for (let index = 0; index < this.palletCount; index += 1) {
			const path: 'A' | 'B' = index % 2 === 0 ? 'A' : 'B';
			const pallet = this.createPallet(index, path);
			this.pallets.push({ root: pallet, path, distance: 0, initialDistance: 0 });
			palletsGroup.add(pallet);
		}
		this.group.add(palletsGroup);
		this.distributePallets();
	}

	private createPallet(index: number, path: 'A' | 'B') {
		const pallet = new THREE.Group();
		pallet.name = `托盘_${String(index + 1).padStart(2, '0')}_SKU-${path}`;
		pallet.userData.palletIndex = index;
		pallet.userData.sku = path;
		const woodMaterial = new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.78, metalness: 0.04 });
		const boxMaterial = new THREE.MeshStandardMaterial({ color: path === 'A' ? 0x38bdf8 : 0xa78bfa, emissive: path === 'A' ? 0x082f49 : 0x2e1065, roughness: 0.58, metalness: 0.08 });
		for (const z of [-0.24, 0, 0.24]) {
			const slat = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.1, 0.17), woodMaterial);
			slat.position.set(0, 0, z);
			pallet.add(slat);
		}
		const carton = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.52), boxMaterial);
		carton.name = '包装箱';
		carton.position.y = 0.37;
		pallet.add(carton);
		const band = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.04, 0.56), this.safetyMaterial);
		band.position.y = 0.57;
		pallet.add(band);
		markShadow(pallet);
		return pallet;
	}

	private distributePallets() {
		for (const pathName of ['A', 'B'] as const) {
			const entities = this.pallets.filter((pallet) => pallet.path === pathName);
			const length = this.paths[pathName].length;
			entities.forEach((pallet, index) => {
				const phaseOffset = pathName === 'B' ? 0.5 : 0;
				pallet.initialDistance = entities.length && length > 0 ? ((index + phaseOffset) / entities.length) * length : 0;
				pallet.distance = pallet.initialDistance;
			});
		}
		this.applyPalletPoses();
	}

	private applyPalletPoses() {
		for (const pallet of this.pallets) {
			const path = this.paths[pallet.path];
			if (path.length <= 0) {
				pallet.root.visible = false;
				continue;
			}
			pallet.root.visible = true;
			const progress = THREE.MathUtils.clamp(pallet.distance / path.length, 0, 1);
			const position = path.curve.getPointAt(progress);
			const tangent = path.curve.getTangentAt(progress).setY(0).normalize();
			pallet.root.position.copy(position);
			pallet.root.rotation.y = Math.atan2(tangent.x, tangent.z);
		}
	}

	private applyMachineAnimation() {
		for (const [index, disc] of this.turntableDiscs.entries()) disc.rotation.y = this.elapsedSeconds * (index % 2 === 0 ? 0.8 : -0.8);
		this.diverterBlade.rotation.y = -0.25 + (Math.sin(this.elapsedSeconds * 0.72) + 1) * 0.4;
		for (const rig of this.robotRigs) {
			const cycle = this.elapsedSeconds * 1.15 + rig.phase;
			rig.shoulder.rotation.z = -0.28 + Math.sin(cycle) * 0.38;
			rig.elbow.rotation.z = 0.58 + Math.sin(cycle + 1.1) * 0.48;
			rig.wrist.rotation.y = Math.sin(cycle * 1.7) * 0.72;
		}
	}
}
