import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveBoolean, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentPortDefinition } from './types';

const addBox = (parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name;
	mesh.position.set(...position);
	parent.add(mesh);
	return mesh;
};

const addCamera = (parent: THREE.Object3D, name: string, position: [number, number, number], rotation: [number, number, number], bodyMaterial: THREE.Material, lensMaterial: THREE.Material) => {
	const camera = new THREE.Group();
	camera.name = name;
	camera.position.set(...position);
	camera.rotation.set(...rotation);
	camera.userData.visionCamera = true;
	camera.userData.inspectionTarget = 'chemical-fiber-cake';
	addBox(camera, name + '-Body', [0.24, 0.19, 0.32], [0, 0, 0], bodyMaterial);
	const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.10, 18), lensMaterial);
	lens.name = name + '-Lens';
	lens.rotation.x = Math.PI / 2;
	lens.position.z = -0.21;
	camera.add(lens);
	parent.add(camera);
	return camera;
};

export class DualExternalInspectionComponent implements TwinComponentGenerator {
	readonly componentType = 'external-inspection' as const;
	readonly generator = 'external-inspection-dual-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 6.2, 4.8, 14);
		const width = resolveNumber(props, 'width', 2.8, 2.0, 8);
		const machineHeight = resolveNumber(props, 'machineHeight', 3.1, 2.2, 8);
		const conveyorHeight = resolveNumber(props, 'conveyorHeight', 0.9, 0.2, 3);
		const legacyLaneWidth = resolveNumber(props, 'laneWidth', 1.6, 0.8, 2.4);
		const conveyorWidth = resolveNumber(props, 'conveyorWidth', legacyLaneWidth, 0.8, Math.max(0.9, width - 0.5));
		const legacyLaneSpacing = resolveNumber(props, 'laneSpacing', 2.0, 1.2, 4.5);
		const stationSpacing = resolveNumber(props, 'stationSpacing', legacyLaneSpacing, 1.2, Math.min(4.5, length - 1.2));
		const chamberLength = Math.min(length - 0.5, resolveNumber(props, 'chamberLength', 5.0, 3.4, Math.max(3.4, length - 0.5)));
		const withRotaryInspection = resolveBoolean(props, 'withRotaryInspection', true);
		const root = new THREE.Group();
		root.name = definition.name;
		Object.assign(root.userData, {
			processType: 'external-inspection',
			inspectionType: 'chemical-fiber-appearance-dual-inline',
			simultaneousInspection: true,
			simultaneousCapacity: 2,
			capacity: 2,
			conveyorCount: 1,
			stationCount: 2,
			cameraCount: 6,
			darkChamber: true,
			rotaryInspection: withRotaryInspection,
		});

		const frame = createMaterial(0x475569, { roughness: 0.56, metalness: 0.72 });
		const panel = createMaterial(0xd6dde5, { roughness: 0.58, metalness: 0.28 });
		const dark = createMaterial(0x111827, { roughness: 0.84, metalness: 0.08 });
		const cameraMat = createMaterial(0x111827, { roughness: 0.38, metalness: 0.52 });
		const lensMat = createMaterial(0x0f172a, { emissive: 0x1d4ed8, emissiveIntensity: 0.14, roughness: 0.18, metalness: 0.16 });
		const lightMat = createMaterial(0xf8fafc, { emissive: 0xffffff, emissiveIntensity: 0.72, roughness: 0.24, metalness: 0.02 });
		const moving = createMaterial(0x64748b, { roughness: 0.40, metalness: 0.72 });
		const accent = createMaterial(0x0891b2, { emissive: 0x083344, emissiveIntensity: 0.10, roughness: 0.42, metalness: 0.44 });
		const screen = createMaterial(0x0f172a, { emissive: 0x0ea5e9, emissiveIntensity: 0.24, roughness: 0.18, metalness: 0.12 });

		// 一条小辊道贯穿两个串列检测位，两个丝饼在同一输送线上前后停靠并同时检测。
		const conveyor = createStraightRollerGeometry({
			length,
			width: conveyorWidth,
			height: conveyorHeight,
			rollerDiameter: 0.14,
			rollerPitch: 0.38,
			frameHeight: 0.16,
			frameThickness: 0.10,
			supportSpacing: 1.8,
			frameColor: 0x334155,
			rollerColor: 0x94a3b8,
		});
		conveyor.name = 'Inspection-Dual-Inline-Conveyor';
		conveyor.userData.throughConveyor = true;
		conveyor.userData.singleConveyorForTwoStations = true;
		conveyor.userData.stationCapacity = 2;
		root.add(conveyor);

		const halfX = chamberLength / 2;
		const halfZ = width / 2;
		const chamber = new THREE.Group();
		chamber.name = 'Inspection-Dual-Inline-Chamber';
		chamber.userData.sharedTwoStationChamber = true;
		for (const x of [-halfX, halfX]) for (const z of [-halfZ, halfZ]) {
			const post = addBox(chamber, 'Inspection-Dual-Post-' + (x < 0 ? 'In' : 'Out') + '-' + (z < 0 ? 'ZN' : 'ZP'), [0.13, machineHeight, 0.13], [x, machineHeight / 2, z], frame);
			post.userData.inspectionSupportPost = true;
		}
		for (const z of [-halfZ, halfZ]) addBox(chamber, 'Inspection-Dual-Top-X-' + z, [chamberLength + 0.13, 0.17, 0.17], [0, machineHeight, z], frame).userData.topFrameBeam = true;
		for (const x of [-halfX, halfX]) addBox(chamber, 'Inspection-Dual-Top-Z-' + x, [0.17, 0.17, width + 0.13], [x, machineHeight, 0], frame).userData.topFrameBeam = true;
		addBox(chamber, 'Inspection-Dual-Chamber-Roof', [chamberLength, 0.08, width], [0, machineHeight - 0.04, 0], panel).userData.lightShieldPanel = true;
		addBox(chamber, 'Inspection-Dual-Inner-Light-Shield', [chamberLength - 0.28, 0.04, width - 0.30], [0, machineHeight - 0.20, 0], dark).userData.darkInterior = true;
		const sideHeight = Math.max(1.0, machineHeight - conveyorHeight - 0.45);
		for (const z of [-halfZ, halfZ]) addBox(chamber, 'Inspection-Dual-Side-Panel-' + (z < 0 ? 'ZN' : 'ZP'), [chamberLength - 0.18, sideHeight, 0.06], [0, conveyorHeight + 0.32 + sideHeight / 2, z], panel).userData.lightShieldPanel = true;
		root.add(chamber);

		const stationXs = [-stationSpacing / 2, stationSpacing / 2];
		for (const [index, stationX] of stationXs.entries()) {
			const stationName = index === 0 ? 'A' : 'B';
			const station = new THREE.Group();
			station.name = 'Inspection-Dual-Station-' + stationName;
			station.position.x = stationX;
			station.userData.inspectionStation = stationName;
			station.userData.simultaneousInspectionStation = true;
			station.userData.cameraCount = 3;

			addCamera(station, 'Inspection-Dual-' + stationName + '-Top-Camera', [0, machineHeight - 0.48, 0], [-Math.PI / 2, 0, 0], cameraMat, lensMat).userData.viewFace = 'top-tube';
			const ring = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.045, 10, 36), lightMat);
			ring.name = 'Inspection-Dual-' + stationName + '-Top-Ring-Light';
			ring.rotation.x = Math.PI / 2;
			ring.position.y = machineHeight - 0.68;
			ring.userData.inspectionLight = true;
			station.add(ring);

			const sideInset = Math.min(conveyorWidth / 2 + 0.22, halfZ - 0.22);
			addCamera(station, 'Inspection-Dual-' + stationName + '-Side-Camera-ZN', [0.10, conveyorHeight + 0.78, -sideInset], [0, 0, 0], cameraMat, lensMat).userData.viewFace = 'circumference';
			addCamera(station, 'Inspection-Dual-' + stationName + '-Side-Camera-ZP', [-0.10, conveyorHeight + 0.78, sideInset], [0, Math.PI, 0], cameraMat, lensMat).userData.viewFace = 'circumference';
			for (const z of [-sideInset + 0.08, sideInset - 0.08]) addBox(station, 'Inspection-Dual-' + stationName + '-Side-Light-' + z, [0.92, 0.10, 0.05], [0, conveyorHeight + 1.20, z], lightMat).userData.inspectionLight = true;

			if (withRotaryInspection) {
				const rotary = new THREE.Group();
				rotary.name = 'Inspection-Dual-' + stationName + '-Rotary-Gripper';
				rotary.position.y = machineHeight - 0.38;
				Object.assign(rotary.userData, { rotaryInspectionGripper: true, inspectionStation: stationName, rotationAxis: 'y', verticalTravelAxis: 'y' });
				const spindleLength = Math.max(0.55, machineHeight - conveyorHeight - 1.45);
				const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, spindleLength, 20), moving);
				spindle.name = 'Inspection-Dual-' + stationName + '-Rotary-Spindle';
				spindle.position.y = -spindleLength / 2;
				rotary.add(spindle);
				addBox(rotary, 'Inspection-Dual-' + stationName + '-Rotary-Chuck', [0.62, 0.16, 0.34], [0, -spindleLength, 0], accent).userData.rotaryChuck = true;
				station.add(rotary);
			}

			const stopper = new THREE.Group();
			stopper.name = 'Inspection-Dual-' + stationName + '-Positioning-Stopper';
			stopper.position.set(0.32, conveyorHeight + 0.10, 0);
			Object.assign(stopper.userData, { retractableStopper: true, inspectionStation: stationName });
			addBox(stopper, 'Inspection-Dual-' + stationName + '-Stopper-Beam', [0.12, 0.24, Math.max(0.65, conveyorWidth * 0.70)], [0, 0, 0], accent);
			station.add(stopper);
			root.add(station);
		}

		addBox(root, 'Inspection-Dual-Control-Cabinet', [0.76, 1.52, 0.44], [-halfX + 0.50, 0.76, halfZ - 0.30], frame).userData.controlCabinet = true;
		const hmi = new THREE.Group();
		hmi.name = 'Inspection-Dual-HMI';
		hmi.position.set(halfX - 0.50, 1.52, halfZ - 0.30);
		hmi.userData.operatorPanel = true;
		addBox(hmi, 'Inspection-Dual-HMI-Body', [0.48, 0.54, 0.18], [0, 0, 0], frame);
		addBox(hmi, 'Inspection-Dual-HMI-Screen', [0.35, 0.31, 0.025], [0, 0.02, -0.102], screen);
		root.add(hmi);

		const title = createCanvasLabel('双工位化纤外检机');
		title.position.set(0, machineHeight + 0.52, width / 2 + 0.02);
		root.add(title);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, conveyorHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, conveyorHeight, 0], localDirection: [1, 0, 0] },
		];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.resourceKey = definition.resourceKey;
		root.userData.generator = this.generator;
		root.userData.generatorVersion = definition.generatorVersion;
		root.userData.capabilities = ['material-flow', 'capacity', 'process-station', 'plc-binding', 'vision-inspection', 'dual-station-inline'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth, stationSpacing, chamberLength, withRotaryInspection, capacity: 2 };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports);
	}
}
