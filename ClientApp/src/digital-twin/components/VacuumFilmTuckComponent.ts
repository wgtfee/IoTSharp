import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

const addBox = (parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name;
	mesh.position.set(...position);
	parent.add(mesh);
	return mesh;
};

export class VacuumFilmTuckComponent implements TwinComponentGenerator {
	readonly componentType = 'bagging-machine' as const;
	readonly generator = 'vacuum-film-tuck-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 3.2, 2.2, 8);
		const width = resolveNumber(props, 'width', 2.4, 1.8, 6);
		const machineHeight = resolveNumber(props, 'machineHeight', 2.9, 2.0, 5.5);
		const conveyorHeight = resolveNumber(props, 'conveyorHeight', 0.9, 0.3, 2.0);
		const conveyorWidth = resolveNumber(props, 'conveyorWidth', 1.6, 0.8, Math.max(0.9, width - 0.45));
		const liftStroke = resolveNumber(props, 'liftStroke', 0.95, 0.45, 1.8);
		const coreDiameter = resolveNumber(props, 'coreDiameter', 0.22, 0.10, 0.50);

		const root = new THREE.Group();
		root.name = definition.name;
		root.userData.processType = 'bagging';
		root.userData.stationType = 'vacuum-film-tuck';
		root.userData.chemicalFiberProcess = true;
		root.userData.palletRemainsOnConveyor = true;
		root.userData.cakeLiftedFromPallet = true;
		root.userData.vacuumFilmTuck = true;
		root.userData.returnCakeToSamePallet = true;

		const frame = createMaterial(0x475569, { roughness: 0.56, metalness: 0.72 });
		const moving = createMaterial(0x64748b, { roughness: 0.38, metalness: 0.74 });
		const accent = createMaterial(0x0ea5e9, { emissive: 0x082f49, emissiveIntensity: 0.10, roughness: 0.40, metalness: 0.42 });
		const dark = createMaterial(0x111827, { roughness: 0.42, metalness: 0.56 });
		const suctionMat = createMaterial(0x334155, { roughness: 0.34, metalness: 0.66 });
		const filmMat = createMaterial(0xe0f2fe, { transparent: true, opacity: 0.24, roughness: 0.08, metalness: 0.0, side: THREE.DoubleSide });
		const screenMat = createMaterial(0x0f172a, { emissive: 0x0284c7, emissiveIntensity: 0.22, roughness: 0.18, metalness: 0.12 });

		const conveyor = createStraightRollerGeometry({
			length,
			width: conveyorWidth,
			height: conveyorHeight,
			rollerDiameter: 0.14,
			rollerPitch: 0.38,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: 1.6,
			frameColor: 0x334155,
			rollerColor: 0x94a3b8,
		});
		conveyor.name = 'VacuumTuck-Conveyor';
		conveyor.userData.smallPalletConveyor = true;
		root.add(conveyor);

		const postX = Math.max(0.90, length * 0.34);
		const postZ = width / 2;
		for (const [xi, x] of [-postX, postX].entries()) {
			for (const [zi, z] of [-postZ, postZ].entries()) {
				const post = addBox(root, 'VacuumTuck-Frame-Post-' + (xi + 1) + '-' + (zi + 1), [0.14, machineHeight, 0.14], [x, machineHeight / 2, z], frame);
				post.userData.fixedFrame = true;
			}
		}
		for (const z of [-postZ, postZ]) addBox(root, 'VacuumTuck-Top-Longitudinal-' + (z < 0 ? 'ZN' : 'ZP'), [postX * 2 + 0.18, 0.18, 0.18], [0, machineHeight, z], frame);
		for (const x of [-postX, postX]) addBox(root, 'VacuumTuck-Top-Cross-' + (x < 0 ? 'XN' : 'XP'), [0.18, 0.18, width + 0.16], [x, machineHeight, 0], frame);
		addBox(root, 'VacuumTuck-Lift-Bridge', [0.34, 0.26, width + 0.04], [0, machineHeight - 0.14, 0], frame).userData.liftSupportBridge = true;

		const lift = new THREE.Group();
		lift.name = 'VacuumTuck-Cake-Lift';
		lift.position.set(0, machineHeight - 0.32, 0);
		lift.userData.travelAxis = 'y';
		lift.userData.liftStroke = liftStroke;
		lift.userData.liftsCakeOnly = true;
		const guideLength = Math.max(0.65, machineHeight - conveyorHeight - 1.05);
		addBox(lift, 'VacuumTuck-Z-Guide', [0.20, guideLength, 0.20], [0, -guideLength / 2, 0], moving).userData.travelAxis = 'y';
		const slide = addBox(lift, 'VacuumTuck-Z-Slide', [0.42, 0.30, 0.42], [0, -guideLength + 0.08, 0], accent);
		slide.userData.verticalSlide = true;

		const gripper = new THREE.Group();
		gripper.name = 'VacuumTuck-Core-Gripper';
		gripper.position.set(0, -guideLength - 0.10, 0);
		gripper.userData.gripMethod = 'internal-core-expansion';
		gripper.userData.coreDiameter = coreDiameter;
		gripper.userData.jawCount = 3;
		const spindle = new THREE.Mesh(new THREE.CylinderGeometry(coreDiameter * 0.22, coreDiameter * 0.22, 0.48, 20), moving);
		spindle.name = 'VacuumTuck-Core-Spindle';
		spindle.position.y = -0.24;
		gripper.add(spindle);
		for (let i = 0; i < 3; i += 1) {
			const angle = (Math.PI * 2 * i) / 3;
			const radius = coreDiameter * 0.34;
			const jaw = addBox(gripper, 'VacuumTuck-Core-Jaw-' + (i + 1), [0.07, 0.24, 0.10], [Math.cos(angle) * radius, -0.36, Math.sin(angle) * radius], accent);
			jaw.rotation.y = -angle;
			jaw.userData.coreExpansionJaw = true;
		}
		lift.add(gripper);
		root.add(lift);

		const vacuum = new THREE.Group();
		vacuum.name = 'VacuumTuck-Vacuum-System';
		vacuum.userData.negativePressureFilmSuction = true;
		const suctionY = Math.max(0.16, conveyorHeight - 0.48);
		const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.58, 0.38, 28), suctionMat);
		chamber.name = 'VacuumTuck-Suction-Chamber';
		chamber.position.set(0, suctionY, 0);
		chamber.userData.vacuumChamber = true;
		vacuum.add(chamber);
		const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.055, 10, 32), accent);
		mouth.name = 'VacuumTuck-Suction-Mouth';
		mouth.rotation.x = Math.PI / 2;
		mouth.position.set(0, suctionY + 0.22, 0);
		mouth.userData.vacuumMouth = true;
		mouth.userData.suctionDirection = 'downward-inward';
		mouth.userData.requiresPalletCenterPassThrough = true;
		vacuum.add(mouth);
		const guideFilm = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.32, 0.48, 32, 1, true), filmMat);
		guideFilm.name = 'VacuumTuck-Film-Inward-Preview';
		guideFilm.position.set(0, suctionY + 0.48, 0);
		guideFilm.userData.previewOnly = true;
		guideFilm.userData.filmTuckedByVacuum = true;
		vacuum.add(guideFilm);

		const blowerZ = postZ + 0.46;
		const blower = addBox(vacuum, 'VacuumTuck-Vacuum-Blower', [0.82, 0.86, 0.58], [0.72, 0.48, blowerZ], dark);
		blower.userData.vacuumBlower = true;
		const ductA = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.95, 16), suctionMat);
		ductA.name = 'VacuumTuck-Vacuum-Duct-A';
		ductA.rotation.z = Math.PI / 2;
		ductA.position.set(0.40, 0.34, 0);
		vacuum.add(ductA);
		const ductB = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, blowerZ, 16), suctionMat);
		ductB.name = 'VacuumTuck-Vacuum-Duct-B';
		ductB.rotation.x = Math.PI / 2;
		ductB.position.set(0.85, 0.34, blowerZ / 2);
		vacuum.add(ductB);
		root.add(vacuum);

		const stopper = addBox(root, 'VacuumTuck-Pallet-Stopper', [0.12, 0.28, Math.max(0.72, conveyorWidth * 0.72)], [0.32, conveyorHeight + 0.10, 0], accent);
		stopper.userData.retractableStopper = true;
		stopper.userData.holdsSamePallet = true;
		for (const z of [-1, 1]) {
			const guide = addBox(root, 'VacuumTuck-Pallet-Centering-' + (z < 0 ? 'ZN' : 'ZP'), [0.48, 0.18, 0.12], [0, conveyorHeight + 0.10, z * (conveyorWidth / 2 - 0.12)], moving);
			guide.userData.centeringGuide = true;
		}

		const cabinet = addBox(root, 'VacuumTuck-Control-Cabinet', [0.70, 1.35, 0.42], [-postX + 0.42, 0.675, postZ + 0.34], frame);
		cabinet.userData.controlCabinet = true;
		const hmi = new THREE.Group();
		hmi.name = 'VacuumTuck-HMI';
		hmi.position.set(postX - 0.38, 1.42, postZ + 0.34);
		addBox(hmi, 'VacuumTuck-HMI-Body', [0.46, 0.50, 0.18], [0, 0, 0], frame);
		addBox(hmi, 'VacuumTuck-HMI-Screen', [0.34, 0.28, 0.025], [0, 0.02, -0.102], screenMat);
		hmi.userData.operatorPanel = true;
		root.add(hmi);

		const stack = new THREE.Group();
		stack.name = 'VacuumTuck-Stack-Light';
		stack.position.set(postX - 0.18, machineHeight + 0.16, postZ + 0.18);
		stack.userData.stackLight = true;
		const lampSpecs = [['Red', 0xef4444, 0.18], ['Amber', 0xf59e0b, 0], ['Green', 0x22c55e, -0.18]] as const;
		for (const [name, color, y] of lampSpecs) {
			const mat = createMaterial(color, { emissive: color, emissiveIntensity: name === 'Green' ? 0.68 : 0.20, roughness: 0.25, metalness: 0.10 });
			const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 16), mat);
			lamp.name = 'VacuumTuck-Stack-Light-' + name;
			lamp.position.y = y;
			stack.add(lamp);
		}
		root.add(stack);

		const label = createCanvasLabel('化纤真空吸膜工位');
		label.position.set(0, machineHeight + 0.48, width / 2 + 0.02);
		root.add(label);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, conveyorHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, conveyorHeight, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.resourceKey = definition.resourceKey;
		root.userData.generator = this.generator;
		root.userData.generatorVersion = definition.generatorVersion;
		root.userData.capabilities = ['material-flow', 'capacity', 'process-station', 'plc-binding', 'vacuum-film-tuck'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth, liftStroke, coreDiameter, capacity: 1 };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
