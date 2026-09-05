import * as THREE from 'three';
import type { TwinComponentBuildResult, TwinComponentInternalFlowDefinition, TwinComponentPortDefinition } from './types';

export interface StraightRollerGeometryOptions {
	length: number;
	width: number;
	height: number;
	rollerDiameter: number;
	rollerPitch: number;
	frameHeight: number;
	frameThickness: number;
	supportSpacing: number;
	frameColor?: number;
	rollerColor?: number;
	supportColor?: number;
}

const disposableMaterials = new Set<THREE.Material>();

export const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return THREE.MathUtils.clamp(numeric, min, max);
};

export const resolveNumber = (
	properties: Record<string, unknown>,
	key: string,
	fallback: number,
	min: number,
	max: number,
) => clampNumber(properties[key], fallback, min, max);

export const resolveBoolean = (properties: Record<string, unknown>, key: string, fallback: boolean) => {
	const value = properties[key];
	return typeof value === 'boolean' ? value : fallback;
};

export const createMaterial = (color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
	const material = new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.48, ...options });
	disposableMaterials.add(material);
	return material;
};

export const markShadows = (root: THREE.Object3D) => {
	root.traverse((child: any) => {
		if (!child.isMesh) return;
		child.castShadow = true;
		child.receiveShadow = true;
	});
};

export const createStraightRollerGeometry = (options: StraightRollerGeometryOptions) => {
	const root = new THREE.Group();
	root.name = 'RollerConveyorGeometry';
	const length = Math.max(0.5, options.length);
	const width = Math.max(0.5, options.width);
	const height = Math.max(0.15, options.height);
	const rollerRadius = Math.max(0.025, options.rollerDiameter / 2);
	// `height` is the transport contact plane (roller top), not the roller center.
	const rollerCenterY = height - rollerRadius;
	const rollerPitch = Math.max(options.rollerDiameter * 1.1, options.rollerPitch);
	const frameHeight = Math.max(0.08, options.frameHeight);
	const frameThickness = Math.max(0.05, options.frameThickness);
	const frameMaterial = createMaterial(options.frameColor ?? 0x334155, { roughness: 0.62, metalness: 0.68 });
	const rollerMaterial = createMaterial(options.rollerColor ?? 0x94a3b8, { roughness: 0.35, metalness: 0.86 });
	const supportMaterial = createMaterial(options.supportColor ?? 0x475569, { roughness: 0.65, metalness: 0.62 });

	root.userData.conveyorSurfaceHeight = height;
	root.userData.rollerCenterY = rollerCenterY;
	root.userData.rollerRadius = rollerRadius;

	const railY = rollerCenterY - frameHeight / 2;
	for (const z of [-width / 2, width / 2]) {
		const rail = new THREE.Mesh(new THREE.BoxGeometry(length, frameHeight, frameThickness), frameMaterial);
		rail.position.set(0, railY, z);
		rail.name = z < 0 ? 'Frame_Left' : 'Frame_Right';
		root.add(rail);
	}

	const rollerCount = Math.max(2, Math.floor(length / rollerPitch) + 1);
	const rollerGeometry = new THREE.CylinderGeometry(rollerRadius, rollerRadius, Math.max(0.1, width - frameThickness * 2.2), 14);
	const rollers = new THREE.InstancedMesh(rollerGeometry, rollerMaterial, rollerCount);
	rollers.name = 'Rollers';
	rollers.userData.conveyorSurfaceHeight = height;
	rollers.userData.rollerCenterY = rollerCenterY;
	rollers.userData.rollerRadius = rollerRadius;
	rollers.userData.runtimeSpinInstances = { axis: [0, 1, 0], speedDegPerSecond: 360 };
	const dummy = new THREE.Object3D();
	for (let index = 0; index < rollerCount; index += 1) {
		const t = rollerCount <= 1 ? 0 : index / (rollerCount - 1);
		dummy.position.set(-length / 2 + t * length, rollerCenterY, 0);
		dummy.rotation.set(Math.PI / 2, 0, 0);
		dummy.updateMatrix();
		rollers.setMatrixAt(index, dummy.matrix);
	}
	rollers.instanceMatrix.needsUpdate = true;
	root.add(rollers);

	// 圆柱滚筒本身轴对称，虽然 Run/Test 时实例矩阵持续旋转，但肉眼几乎看不出变化。
	// 增加与滚筒同轴旋转的窄标记，让组件设计器和 3D 单组件测试能直观看到滚筒正在运行。
	const markerGeometry = new THREE.BoxGeometry(Math.max(0.012, rollerRadius * 0.28), Math.max(0.1, width - frameThickness * 2.35), Math.max(0.012, rollerRadius * 0.22));
	const markerMaterial = createMaterial(0x1e293b, { roughness: 0.44, metalness: 0.72 });
	const rollerMarkers = new THREE.InstancedMesh(markerGeometry, markerMaterial, rollerCount);
	rollerMarkers.name = 'RollerRotationMarkers';
	rollerMarkers.userData.runtimeSpinInstances = { axis: [0, 1, 0], speedDegPerSecond: 360 };
	for (let index = 0; index < rollerCount; index += 1) {
		const t = rollerCount <= 1 ? 0 : index / (rollerCount - 1);
		dummy.position.set(-length / 2 + t * length, rollerCenterY, rollerRadius * 0.82);
		dummy.rotation.set(Math.PI / 2, 0, 0);
		dummy.updateMatrix();
		rollerMarkers.setMatrixAt(index, dummy.matrix);
	}
	rollerMarkers.instanceMatrix.needsUpdate = true;
	root.add(rollerMarkers);

	const supportCount = Math.max(2, Math.ceil(length / Math.max(0.8, options.supportSpacing)) + 1);
	const legHeight = Math.max(0.1, rollerCenterY - frameHeight);
	const legGeometry = new THREE.BoxGeometry(0.12, legHeight, 0.12);
	const legs = new THREE.InstancedMesh(legGeometry, supportMaterial, supportCount * 2);
	legs.name = 'Supports';
	let legIndex = 0;
	for (let index = 0; index < supportCount; index += 1) {
		const t = supportCount <= 1 ? 0 : index / (supportCount - 1);
		const x = -length / 2 + t * length;
		for (const z of [-width / 2 + 0.12, width / 2 - 0.12]) {
			dummy.position.set(x, legHeight / 2, z);
			dummy.rotation.set(0, 0, 0);
			dummy.updateMatrix();
			legs.setMatrixAt(legIndex++, dummy.matrix);
		}
	}
	legs.instanceMatrix.needsUpdate = true;
	root.add(legs);

	const motorGroup = new THREE.Group();
	motorGroup.name = '驱动电机';
	motorGroup.userData.twinEquipmentType = 'motor';
	motorGroup.userData.equipmentRole = 'conveyor-drive';
	const motorMaterial = createMaterial(0x0ea5e9, { roughness: 0.36, metalness: 0.72 });
	const motorBody = new THREE.Mesh(new THREE.CylinderGeometry(rollerRadius * 1.75, rollerRadius * 1.75, Math.max(0.34, rollerRadius * 4), 20), motorMaterial);
	motorBody.name = 'Motor_Body';
	motorBody.rotation.x = Math.PI / 2;
	motorGroup.add(motorBody);
	const gearbox = new THREE.Mesh(new THREE.BoxGeometry(rollerRadius * 3.2, rollerRadius * 3.2, Math.max(0.22, rollerRadius * 1.6)), supportMaterial);
	gearbox.name = 'Motor_Gearbox';
	gearbox.position.z = -Math.max(0.28, rollerRadius * 2.8);
	motorGroup.add(gearbox);
	motorGroup.position.set(length / 2 - Math.min(0.45, length * 0.12), rollerCenterY - frameHeight * 0.65, width / 2 + Math.max(0.32, rollerRadius * 2.8));
	root.add(motorGroup);
	markShadows(root);
	return root;
};

export const createPortMarker = (port: TwinComponentPortDefinition, color = 0x22c55e) => {
	const marker = new THREE.Group();
	marker.name = `Port_${port.portId}`;
	marker.userData.twinPortId = port.portId;
	marker.userData.twinPortType = port.type;
	marker.position.set(...port.localPosition);
	const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), createMaterial(color, { emissive: color, emissiveIntensity: 0.32 }));
	sphere.name = 'PortMarker';
	marker.add(sphere);
	marker.visible = false;
	return marker;
};

export const attachPortMarkers = (root: THREE.Group, ports: TwinComponentPortDefinition[]) => {
	for (const port of ports) root.add(createPortMarker(port));
};

export const createCanvasLabel = (text: string, options: { width?: number; height?: number; fontSize?: number; background?: string; color?: string } = {}) => {
	const canvas = document.createElement('canvas');
	canvas.width = options.width ?? 512;
	canvas.height = options.height ?? 160;
	const context = canvas.getContext('2d');
	if (!context) return new THREE.Sprite();
	context.fillStyle = options.background ?? 'rgba(7,17,31,0.82)';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = options.color ?? '#f8fafc';
	context.font = `600 ${options.fontSize ?? 64}px sans-serif`;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(text, canvas.width / 2, canvas.height / 2);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
	const sprite = new THREE.Sprite(material);
	sprite.name = `Label_${text}`;
	sprite.userData.disposeTexture = texture;
	sprite.scale.set(3.2, 1.0, 1);
	return sprite;
};

export const createComponentResult = (
	root: THREE.Group,
	ports: TwinComponentPortDefinition[],
	internalFlows: TwinComponentInternalFlowDefinition[] = [],
): TwinComponentBuildResult => {
	attachStandardOutputStoppers(root, ports, internalFlows);
	attachPortMarkers(root, ports);
	markShadows(root);
	root.updateMatrixWorld(true);
	const bounds = new THREE.Box3().setFromObject(root);
	return {
		root,
		ports,
		internalFlows,
		bounds,
		dispose: () => {
			root.traverse((child: any) => {
				child.geometry?.dispose?.();
				const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
				for (const material of materials) {
					material.map?.dispose?.();
					material.dispose?.();
				}
				child.userData?.disposeTexture?.dispose?.();
			});
		},
	};
};

export const attachStandardOutputStoppers = (
	root: THREE.Group,
	ports: TwinComponentPortDefinition[],
	internalFlows: TwinComponentInternalFlowDefinition[],
) => {
	if (!internalFlows.some((flow) => flow.conveyorSizeClass === 'small')) return;
	const supportedTypes = new Set(['roller-conveyor', 'double-small-roller-conveyor', 'turn-conveyor-90', 'diverter-conveyor', 'merger-conveyor']);
	if (!supportedTypes.has(String(root.userData.componentType || ''))) return;
	if (root.userData.disableAutoOutputStoppers === true) return;
	const outputs = ports.filter((port) => port.type === 'material-output' || port.type === 'material-bidirectional');
	if (!outputs.length) return;
	const metal = createMaterial(0xf59e0b, { roughness: 0.42, metalness: 0.72 });
	const dark = createMaterial(0x334155, { roughness: 0.55, metalness: 0.72 });
	const sensorMaterial = createMaterial(0x22c55e, { roughness: 0.35, metalness: 0.18, emissive: 0x14532d, emissiveIntensity: 0.65 });
	const definitions: Array<Record<string, unknown>> = Array.isArray(root.userData.actuatorDefinitions) ? [...root.userData.actuatorDefinitions] : [];
	const stopperMetadata: Array<Record<string, unknown>> = [];
	for (const port of outputs) {
		const direction = new THREE.Vector3(...port.localDirection).normalize();
		const position = new THREE.Vector3(...port.localPosition).addScaledVector(direction, -0.26);
		const safePortId = port.portId.replace(/[^a-zA-Z0-9_-]/g, '-');
		const group = new THREE.Group();
		group.name = `OutputStopper-${safePortId}`;
		group.position.copy(position);
		group.userData.retractableStopper = true;
		group.userData.outputPortId = port.portId;
		group.userData.stopperRaised = true;
		group.userData.raisedY = position.y;
		group.userData.loweredY = position.y - 0.22;
		const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.28, 12), dark);
		cylinder.name = `OutputStopper-Cylinder-${safePortId}`;
		cylinder.position.y = -0.14;
		group.add(cylinder);
		const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.30, 1.05), metal);
		bar.name = `OutputStopper-Bar-${safePortId}`;
		bar.position.y = 0.09;
		group.add(bar);
		const sensor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.16), sensorMaterial);
		sensor.name = `OutputSensor-${safePortId}`;
		sensor.position.copy(direction.clone().multiplyScalar(-0.18));
		sensor.position.y = 0.05;
		sensor.userData.palletSensor = true;
		sensor.userData.outputPortId = port.portId;
		sensor.userData.palletPresent = false;
		group.add(sensor);
		const actuatorId = `stopper-${port.portId}`;
		const actuator = { actuatorId, name: `${port.name}挡停气缸`, kind: 'linear-axis', motionAxis: 'y', unit: 'meter', minValue: -0.22, maxValue: 0, homeValue: 0, speed: 0.6 };
		group.userData.actuator = actuator;
		group.userData.actuatorId = actuatorId;
		definitions.push(actuator);
		stopperMetadata.push({ portId: port.portId, nodePath: group.name, sensorNodePath: sensor.name, actuatorId, stopOffsetMeters: 0.26 });
		root.add(group);
	}
	root.userData.actuatorDefinitions = definitions;
	root.userData.outputStoppers = stopperMetadata;
};

export const applyComponentIdentity = (root: THREE.Group, objectId: string, componentType: string, sectionId?: string) => {
	root.userData.twinObjectId = objectId;
	root.userData.twinObjectType = 'component';
	root.userData.componentType = componentType;
	if (sectionId) root.userData.sectionId = sectionId;
};

export const setTransform = (root: THREE.Object3D, transform?: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }) => {
	if (!transform) return;
	root.position.set(...transform.position);
	root.rotation.set(...transform.rotation);
	root.scale.set(...transform.scale);
};
