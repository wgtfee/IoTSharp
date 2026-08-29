import * as THREE from 'three';
import type { TwinComponentBuildResult, TwinComponentPortDefinition } from './types';

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
	const rollerPitch = Math.max(options.rollerDiameter * 1.1, options.rollerPitch);
	const frameHeight = Math.max(0.08, options.frameHeight);
	const frameThickness = Math.max(0.05, options.frameThickness);
	const frameMaterial = createMaterial(options.frameColor ?? 0x334155, { roughness: 0.62, metalness: 0.68 });
	const rollerMaterial = createMaterial(options.rollerColor ?? 0x94a3b8, { roughness: 0.35, metalness: 0.86 });
	const supportMaterial = createMaterial(options.supportColor ?? 0x475569, { roughness: 0.65, metalness: 0.62 });

	const railY = height - frameHeight / 2;
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
	const dummy = new THREE.Object3D();
	for (let index = 0; index < rollerCount; index += 1) {
		const t = rollerCount <= 1 ? 0 : index / (rollerCount - 1);
		dummy.position.set(-length / 2 + t * length, height, 0);
		dummy.rotation.set(Math.PI / 2, 0, 0);
		dummy.updateMatrix();
		rollers.setMatrixAt(index, dummy.matrix);
	}
	rollers.instanceMatrix.needsUpdate = true;
	root.add(rollers);

	const supportCount = Math.max(2, Math.ceil(length / Math.max(0.8, options.supportSpacing)) + 1);
	const legGeometry = new THREE.BoxGeometry(0.12, Math.max(0.1, height - frameHeight), 0.12);
	const legs = new THREE.InstancedMesh(legGeometry, supportMaterial, supportCount * 2);
	legs.name = 'Supports';
	let legIndex = 0;
	for (let index = 0; index < supportCount; index += 1) {
		const t = supportCount <= 1 ? 0 : index / (supportCount - 1);
		const x = -length / 2 + t * length;
		for (const z of [-width / 2 + 0.12, width / 2 - 0.12]) {
			dummy.position.set(x, (height - frameHeight) / 2, z);
			dummy.rotation.set(0, 0, 0);
			dummy.updateMatrix();
			legs.setMatrixAt(legIndex++, dummy.matrix);
		}
	}
	legs.instanceMatrix.needsUpdate = true;
	root.add(legs);
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

export const createComponentResult = (root: THREE.Group, ports: TwinComponentPortDefinition[]): TwinComponentBuildResult => {
	attachPortMarkers(root, ports);
	markShadows(root);
	root.updateMatrixWorld(true);
	const bounds = new THREE.Box3().setFromObject(root);
	return {
		root,
		ports,
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
