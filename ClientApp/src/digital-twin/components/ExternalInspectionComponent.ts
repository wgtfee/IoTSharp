import * as THREE from 'three';
import { applyComponentIdentity, createCanvasLabel, createComponentResult, createMaterial, createStraightRollerGeometry, resolveBoolean, resolveNumber, setTransform } from './geometry';
import type { TwinComponentBuildContext, TwinComponentGenerator, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

const addBox = (
	parent: THREE.Object3D,
	name: string,
	size: [number, number, number],
	position: [number, number, number],
	material: THREE.Material,
) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
	mesh.name = name;
	mesh.position.set(...position);
	parent.add(mesh);
	return mesh;
};

const addCamera = (
	parent: THREE.Object3D,
	name: string,
	position: [number, number, number],
	rotation: [number, number, number],
	bodyMaterial: THREE.Material,
	lensMaterial: THREE.Material,
) => {
	const camera = new THREE.Group();
	camera.name = name;
	camera.position.set(...position);
	camera.rotation.set(...rotation);
	camera.userData.visionCamera = true;
	camera.userData.inspectionTarget = 'chemical-fiber-cake';
	addBox(camera, `${name}-Body`, [0.26, 0.20, 0.34], [0, 0, 0], bodyMaterial);
	const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.11, 20), lensMaterial);
	lens.name = `${name}-Lens`;
	lens.rotation.x = Math.PI / 2;
	lens.position.z = -0.22;
	lens.userData.cameraLens = true;
	camera.add(lens);
	parent.add(camera);
	return camera;
};

export class ExternalInspectionComponent implements TwinComponentGenerator {
	readonly componentType = 'external-inspection' as const;
	readonly generator = 'external-inspection-v1';
	readonly generatorVersion = 1;

	create(context: TwinComponentBuildContext) {
		const { definition } = context;
		const props = definition.properties;
		const length = resolveNumber(props, 'length', 4.5, 3.2, 12);
		const width = resolveNumber(props, 'width', 2.8, 2.0, 8);
		const machineHeight = resolveNumber(props, 'machineHeight', 3.0, 2.2, 8);
		const conveyorHeight = resolveNumber(props, 'conveyorHeight', 0.9, 0.2, 3);
		const conveyorWidth = resolveNumber(props, 'conveyorWidth', 1.6, 0.8, Math.max(0.9, width - 0.5));
		const chamberLength = Math.min(
			length - 0.6,
			resolveNumber(props, 'chamberLength', 2.6, 1.6, Math.max(1.6, length - 0.6)),
		);
		const withRotaryInspection = resolveBoolean(props, 'withRotaryInspection', true);
		const root = new THREE.Group();
		root.name = definition.name;
		root.userData.processType = 'external-inspection';
		root.userData.inspectionType = 'chemical-fiber-appearance';
		root.userData.inspectionFaces = ['top', 'bottom', 'circumference', 'tube'];
		root.userData.cameraCount = 3;
		root.userData.darkChamber = true;
		root.userData.rotaryInspection = withRotaryInspection;

		const conveyor = createStraightRollerGeometry({
			length,
			width: conveyorWidth,
			height: conveyorHeight,
			rollerDiameter: 0.14,
			rollerPitch: 0.38,
			frameHeight: 0.16,
			frameThickness: 0.1,
			supportSpacing: 1.8,
			frameColor: 0x334155,
			rollerColor: 0x94a3b8,
		});
		conveyor.name = 'InspectionConveyor';
		conveyor.userData.throughConveyor = true;
		root.add(conveyor);

		const frameMaterial = createMaterial(0x475569, { roughness: 0.56, metalness: 0.72 });
		const panelMaterial = createMaterial(0xd6dde5, { roughness: 0.58, metalness: 0.28 });
		const darkInterior = createMaterial(0x111827, { roughness: 0.84, metalness: 0.08 });
		const windowMaterial = createMaterial(0x93c5d8, { transparent: true, opacity: 0.20, roughness: 0.22, metalness: 0.12, side: THREE.DoubleSide });
		const cameraMaterial = createMaterial(0x111827, { roughness: 0.38, metalness: 0.52 });
		const lensMaterial = createMaterial(0x0f172a, { emissive: 0x1d4ed8, emissiveIntensity: 0.14, roughness: 0.18, metalness: 0.16 });
		const lightMaterial = createMaterial(0xf8fafc, { emissive: 0xffffff, emissiveIntensity: 0.72, roughness: 0.24, metalness: 0.02 });
		const movingMaterial = createMaterial(0x64748b, { roughness: 0.40, metalness: 0.72 });
		const accentMaterial = createMaterial(0x0891b2, { emissive: 0x083344, emissiveIntensity: 0.10, roughness: 0.42, metalness: 0.44 });

		// 封闭视觉检测舱：X 方向保留进/出口，Z 两侧和顶部形成暗室，避免环境光干扰视觉检测。
		const chamber = new THREE.Group();
		chamber.name = 'Inspection-Chamber';
		chamber.userData.darkChamber = true;
		const chamberHalfX = chamberLength / 2;
		const chamberHalfZ = width / 2;
		for (const x of [-chamberHalfX, chamberHalfX]) {
			for (const z of [-chamberHalfZ, chamberHalfZ]) {
				const post = addBox(chamber, `Inspection-Frame-Post-${x < 0 ? 'In' : 'Out'}-${z < 0 ? 'ZN' : 'ZP'}`, [0.12, machineHeight, 0.12], [x, machineHeight / 2, z], frameMaterial);
				post.userData.inspectionSupportPost = true;
			}
		}
		for (const [index, z] of [-chamberHalfZ, chamberHalfZ].entries()) {
			const beam = addBox(chamber, `Inspection-Frame-Top-Longitudinal-${index + 1}`, [chamberLength + 0.12, 0.16, 0.16], [0, machineHeight, z], frameMaterial);
			beam.userData.topFrameBeam = true;
		}
		for (const [index, x] of [-chamberHalfX, chamberHalfX].entries()) {
			const beam = addBox(chamber, `Inspection-Frame-Top-Cross-${index + 1}`, [0.16, 0.16, width + 0.12], [x, machineHeight, 0], frameMaterial);
			beam.userData.topFrameBeam = true;
		}
		const sidePanelHeight = Math.max(1.0, machineHeight - conveyorHeight - 0.45);
		for (const [index, z] of [-chamberHalfZ, chamberHalfZ].entries()) {
			const panel = addBox(chamber, `Inspection-Chamber-Side-Panel-${index === 0 ? 'ZN' : 'ZP'}`, [chamberLength - 0.18, sidePanelHeight, 0.055], [0, conveyorHeight + 0.32 + sidePanelHeight / 2, z], panelMaterial);
			panel.userData.lightShieldPanel = true;
			const window = addBox(chamber, `Inspection-Chamber-Window-${index === 0 ? 'ZN' : 'ZP'}`, [1.05, 0.72, 0.025], [0, conveyorHeight + 0.95, z + (z < 0 ? -0.035 : 0.035)], windowMaterial);
			window.userData.inspectionWindow = true;
		}
		const roof = addBox(chamber, 'Inspection-Chamber-Roof', [chamberLength, 0.08, width], [0, machineHeight - 0.04, 0], panelMaterial);
		roof.userData.lightShieldPanel = true;
		const innerBack = addBox(chamber, 'Inspection-Chamber-Inner-Light-Shield', [chamberLength - 0.28, 0.04, width - 0.30], [0, machineHeight - 0.20, 0], darkInterior);
		innerBack.userData.darkInterior = true;
		root.add(chamber);

		// 三相机视觉系统：顶部负责上端面/纸管，两侧负责圆周表面；光源与相机形成稳定照明几何。
		const vision = new THREE.Group();
		vision.name = 'Inspection-Vision-System';
		vision.userData.cameraCount = 3;
		const topCamera = addCamera(vision, 'Inspection-Top-Camera', [0, machineHeight - 0.48, 0], [-Math.PI / 2, 0, 0], cameraMaterial, lensMaterial);
		topCamera.userData.viewFace = 'top-tube';
		const topRing = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 10, 36), lightMaterial);
		topRing.name = 'Inspection-Top-Ring-Light';
		topRing.rotation.x = Math.PI / 2;
		topRing.position.set(0, machineHeight - 0.68, 0);
		topRing.userData.inspectionLight = true;
		vision.add(topRing);
		const sideCameraY = conveyorHeight + 0.78;
		const sideCameraInset = chamberHalfZ - 0.20;
		const sideCameraZN = addCamera(vision, 'Inspection-Side-Camera-ZN', [0.12, sideCameraY, -sideCameraInset], [0, 0, 0], cameraMaterial, lensMaterial);
		sideCameraZN.userData.viewFace = 'circumference';
		const sideCameraZP = addCamera(vision, 'Inspection-Side-Camera-ZP', [-0.12, sideCameraY, sideCameraInset], [0, Math.PI, 0], cameraMaterial, lensMaterial);
		sideCameraZP.userData.viewFace = 'circumference';
		for (const [index, z] of [-sideCameraInset + 0.10, sideCameraInset - 0.10].entries()) {
			const strip = addBox(vision, `Inspection-Side-Light-${index === 0 ? 'ZN' : 'ZP'}`, [1.05, 0.10, 0.055], [0, conveyorHeight + 1.20, z], lightMaterial);
			strip.userData.inspectionLight = true;
		}
		root.add(vision);

		// 可升降旋转检测夹具：丝饼定位后从顶部夹持并绕 Y 轴旋转，完成 360° 圆周外观采集。
		if (withRotaryInspection) {
			const rotary = new THREE.Group();
			rotary.name = 'Inspection-Rotary-Gripper';
			rotary.position.set(0, machineHeight - 0.38, 0);
			rotary.userData.rotaryInspectionGripper = true;
			rotary.userData.rotationAxis = 'y';
			rotary.userData.verticalTravelAxis = 'y';
			const spindleLength = Math.max(0.55, machineHeight - conveyorHeight - 1.45);
			const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, spindleLength, 20), movingMaterial);
			spindle.name = 'Inspection-Rotary-Spindle';
			spindle.position.y = -spindleLength / 2;
			rotary.add(spindle);
			const chuck = addBox(rotary, 'Inspection-Rotary-Chuck', [0.62, 0.16, 0.34], [0, -spindleLength, 0], accentMaterial);
			chuck.userData.rotaryChuck = true;
			for (const [index, z] of [-0.28, 0.28].entries()) {
				const jaw = addBox(rotary, `Inspection-Rotary-Jaw-${index + 1}`, [0.14, 0.26, 0.18], [0, -spindleLength - 0.18, z], movingMaterial);
				jaw.userData.gripperJaw = true;
			}
			root.add(rotary);
		}

		// 托盘到位后由可伸缩挡停机构锁定拍照位置，避免检测时工件继续移动。
		const stopper = new THREE.Group();
		stopper.name = 'Inspection-Positioning-Stopper';
		stopper.position.set(chamberLength * 0.18, conveyorHeight + 0.10, 0);
		stopper.userData.retractableStopper = true;
		stopper.userData.positioningAxis = 'y';
		addBox(stopper, 'Inspection-Stopper-Beam', [0.12, 0.24, Math.max(0.7, conveyorWidth * 0.72)], [0, 0, 0], accentMaterial);
		root.add(stopper);

		// 侧置电控柜、HMI 和三色灯均避开中间输送通道。
		const cabinetZ = chamberHalfZ - 0.30;
		const cabinet = addBox(root, 'Inspection-Control-Cabinet', [0.72, 1.45, 0.42], [-chamberHalfX + 0.48, 0.725, cabinetZ], frameMaterial);
		cabinet.userData.controlCabinet = true;
		const hmi = new THREE.Group();
		hmi.name = 'Inspection-HMI';
		hmi.position.set(chamberHalfX - 0.48, 1.48, cabinetZ);
		hmi.userData.operatorPanel = true;
		addBox(hmi, 'Inspection-HMI-Body', [0.46, 0.52, 0.18], [0, 0, 0], frameMaterial);
		const screenMaterial = createMaterial(0x0f172a, { emissive: 0x0ea5e9, emissiveIntensity: 0.24, roughness: 0.18, metalness: 0.12 });
		addBox(hmi, 'Inspection-HMI-Screen', [0.34, 0.30, 0.025], [0, 0.02, -0.102], screenMaterial);
		root.add(hmi);

		const stackLight = new THREE.Group();
		stackLight.name = 'Inspection-Stack-Light';
		stackLight.position.set(chamberHalfX - 0.22, machineHeight + 0.16, cabinetZ);
		stackLight.userData.stackLight = true;
		const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 12), frameMaterial);
		pole.position.y = -0.12;
		stackLight.add(pole);
		const lampSpecs = [
			['Red', 0xef4444, 0.18],
			['Amber', 0xf59e0b, 0.00],
			['Green', 0x22c55e, -0.18],
		] as const;
		for (const [name, color, y] of lampSpecs) {
			const material = createMaterial(color, { emissive: color, emissiveIntensity: name === 'Green' ? 0.72 : 0.20, roughness: 0.26, metalness: 0.12 });
			const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.14, 16), material);
			lamp.name = `Inspection-Stack-Light-${name}`;
			lamp.position.y = y;
			stackLight.add(lamp);
		}
		root.add(stackLight);

		const label = createCanvasLabel('化纤外检机');
		label.position.set(0, machineHeight + 0.52, width / 2 + 0.02);
		root.add(label);

		const ports: TwinComponentPortDefinition[] = [
			{ portId: 'input', name: '入口', type: 'material-input', localPosition: [-length / 2, conveyorHeight, 0], localDirection: [-1, 0, 0] },
			{ portId: 'output', name: '出口', type: 'material-output', localPosition: [length / 2, conveyorHeight, 0], localDirection: [1, 0, 0] },
		];
		const internalFlows: TwinComponentInternalFlowDefinition[] = [{
			flowId: 'inspection', name: '外检机内置路线', conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
			points: [
				{ pointId: 'input', name: '入口', localPosition: [-length / 2, conveyorHeight, 0], portId: 'input' },
				{ pointId: 'process', name: '外观检测工位', localPosition: [0, conveyorHeight, 0], kind: 'processStation', processType: 'external-inspection' },
				{ pointId: 'output', name: '出口', localPosition: [length / 2, conveyorHeight, 0], portId: 'output' },
			],
			edges: [
				{ edgeId: 'input-to-process', fromPointId: 'input', toPointId: 'process', capacity: 1 },
				{ edgeId: 'process-to-output', fromPointId: 'process', toPointId: 'output', capacity: 1 },
			],
		}];
		applyComponentIdentity(root, definition.objectId, this.componentType, definition.sectionId);
		root.userData.resourceKey = definition.resourceKey;
		root.userData.generator = this.generator;
		root.userData.generatorVersion = definition.generatorVersion;
		root.userData.capabilities = ['material-flow', 'capacity', 'process-station', 'plc-binding', 'vision-inspection'];
		root.userData.properties = { ...props, length, width, machineHeight, conveyorHeight, conveyorWidth, chamberLength, withRotaryInspection };
		setTransform(root, definition.transform);
		return createComponentResult(root, ports, internalFlows);
	}
}
