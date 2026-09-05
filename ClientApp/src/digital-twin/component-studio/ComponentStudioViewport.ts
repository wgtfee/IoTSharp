import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { defaultComponentRegistry } from '../components/ComponentRegistry';
import { createStudioPart } from './types';
import type {
	ComponentStudioDefinition,
	ComponentStudioHelperState,
	ComponentStudioMode,
	ComponentStudioRuntimeState,
	StudioGeneratedNodeInfo,
	StudioGeneratedNodeTransform,
	StudioPartDefinition,
	StudioVector3,
} from './types';

export interface ComponentStudioViewportEvents {
	onSelectPart?: (partId: string, additive?: boolean) => void;
	onSelectGeneratedNode?: (partId: string, node: StudioGeneratedNodeInfo, additive?: boolean) => void;
	onTransformPart?: (partId: string, transform: { position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }) => void;
	onTransformGeneratedNode?: (partId: string, nodeKey: string, transform: StudioGeneratedNodeTransform) => void;
	onError?: (message: string) => void;
}

const deg = (value: number) => THREE.MathUtils.degToRad(value || 0);
const rad = (value: number) => Number(THREE.MathUtils.radToDeg(value).toFixed(3));

export class ComponentStudioViewport {
	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.05, 500);
	private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
	private readonly orbit: any;
	private readonly transform: any;
	private readonly loader = new GLTFLoader();
	private readonly componentGroup = new THREE.Group();
	private readonly helperGroup = new THREE.Group();
	private readonly selectionGroup = new THREE.Group();
	private readonly partObjects = new Map<string, THREE.Object3D>();
	private readonly generatedNodeObjects = new Map<string, THREE.Object3D>();
	private readonly generatedStructures = new Map<string, StudioGeneratedNodeInfo[]>();
	private readonly glbSources = new Map<string, THREE.Group>();
	private readonly resizeObserver: ResizeObserver;
	private animationFrame = 0;
	private lastFrame = performance.now();
	private definition: ComponentStudioDefinition;
	private mode: ComponentStudioMode = 'design';
	private selectedPartId = '';
	private readonly selectedPartIds = new Set<string>();
	private selectedGeneratedNodeKey = '';
	private helpers: ComponentStudioHelperState = { ports: true, collisions: true, origin: true, grid: true };
	private runtimeState: ComponentStudioRuntimeState = { run: false, alarm: false, visible: true, speedMultiplier: 1 };
	private disposed = false;
	private readonly grid = new THREE.GridHelper(30, 30, 0x334155, 0x172033);
	private selectionBox?: THREE.BoxHelper;
	private readonly selectionPartBoxes: THREE.BoxHelper[] = [];
	private selectionInstanceOverlay?: THREE.Mesh;
	private selectionInstanceSource?: THREE.InstancedMesh;
	private selectionInstanceIndex = -1;
	private instanceTransformProxy?: THREE.Object3D;
	private instanceTransformSource?: THREE.InstancedMesh;
	private instanceTransformIndex = -1;
	private readonly selectionColor = 0xfacc15;

	constructor(private readonly container: HTMLElement, definition: ComponentStudioDefinition, private readonly events: ComponentStudioViewportEvents = {}) {
		this.definition = JSON.parse(JSON.stringify(definition)) as ComponentStudioDefinition;
		this.scene.background = new THREE.Color('#07111f');
		this.scene.add(this.componentGroup, this.helperGroup, this.selectionGroup, this.grid);
		this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x172033, 1.6));
		const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
		keyLight.position.set(5, 9, 6);
		this.scene.add(keyLight);
		const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.8);
		rimLight.position.set(-5, 4, -6);
		this.scene.add(rimLight);

		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.container.appendChild(this.renderer.domElement);

		this.camera.position.set(6, 4.8, 6);
		this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
		this.orbit.enableDamping = true;
		this.orbit.target.set(0, 0.7, 0);
		this.orbit.minDistance = 1.2;
		this.orbit.maxDistance = 80;

		this.transform = new TransformControls(this.camera, this.renderer.domElement);
		this.transform.setMode('translate');
		this.transform.addEventListener('dragging-changed', (event: any) => { this.orbit.enabled = !event.value; });
		this.transform.addEventListener('objectChange', () => this.applyInstanceTransformProxy());
		this.transform.addEventListener('mouseUp', () => this.commitTransform());
		this.scene.add(this.transform);
		this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(container);
		this.rebuild();
		this.fit();
		this.render();
	}

	setDefinition(definition: ComponentStudioDefinition) {
		this.definition = JSON.parse(JSON.stringify(definition)) as ComponentStudioDefinition;
		this.rebuild();
	}

	setMode(mode: ComponentStudioMode) {
		this.mode = mode;
		if (mode !== 'design') {
			this.transform.detach();
			this.clearInstanceTransformProxy();
			this.clearSelectionHighlight();
		} else {
			this.attachSelected();
			this.rebuildSelectionHighlight();
		}
		this.applyRuntimeVisualState();
		this.rebuildHelpers();
	}

	setTransformMode(mode: 'translate' | 'rotate' | 'scale') { this.transform.setMode(mode); }

	setHelpers(value: ComponentStudioHelperState) {
		this.helpers = { ...value };
		this.grid.visible = value.grid && this.mode !== 'preview';
		this.rebuildHelpers();
	}

	setRuntimeState(value: ComponentStudioRuntimeState) {
		this.runtimeState = { ...value };
		this.applyRuntimeVisualState();
	}

	selectPart(partId: string) {
		this.selectedPartIds.clear();
		if (partId) this.selectedPartIds.add(partId);
		this.selectedPartId = partId;
		this.selectedGeneratedNodeKey = '';
		this.clearInstanceTransformProxy();
		this.attachSelected();
		this.rebuildSelectionHighlight();
	}

	setSelectedParts(partIds: string[], primaryPartId = '') {
		this.selectedPartIds.clear();
		for (const partId of partIds) if (partId) this.selectedPartIds.add(partId);
		this.selectedPartId = primaryPartId && this.selectedPartIds.has(primaryPartId) ? primaryPartId : (partIds[partIds.length - 1] || '');
		this.selectedGeneratedNodeKey = '';
		this.clearInstanceTransformProxy();
		this.attachSelected();
		this.rebuildSelectionHighlight();
	}

	getGeneratedStructure(partId: string): StudioGeneratedNodeInfo[] {
		return JSON.parse(JSON.stringify(this.generatedStructures.get(partId) || [])) as StudioGeneratedNodeInfo[];
	}

	selectGeneratedNode(partId: string, nodeKey: string, additive = false) {
		this.selectedPartIds.clear();
		this.selectedPartIds.add(partId);
		this.selectedPartId = partId;
		this.selectedGeneratedNodeKey = nodeKey;
		this.clearInstanceTransformProxy();
		this.attachSelected();
		this.rebuildSelectionHighlight();
		const node = this.generatedStructures.get(partId)?.find((item) => item.nodeKey === nodeKey);
		if (node) this.events.onSelectGeneratedNode?.(partId, JSON.parse(JSON.stringify(node)) as StudioGeneratedNodeInfo, additive);
	}

	async loadGlb(partId: string, buffer: ArrayBuffer) {
		try {
			const gltf: any = await new Promise((resolve, reject) => this.loader.parse(buffer, '', resolve, reject));
			this.glbSources.set(partId, gltf.scene);
			this.rebuild();
			this.selectedPartId = partId;
			this.attachSelected();
			this.fit();
		} catch (error: any) {
			this.events.onError?.(error?.message || 'GLB 解析失败');
			throw error;
		}
	}

	cloneGlbSource(sourcePartId: string, targetPartId: string) {
		const source = this.glbSources.get(sourcePartId);
		if (!source) return false;
		this.glbSources.set(targetPartId, source);
		return true;
	}

	snapshotGeneratedNodeAsPart(partId: string, nodeKey: string): StudioPartDefinition | undefined {
		const info = this.generatedStructures.get(partId)?.find((item) => item.nodeKey === nodeKey);
		if (!info) return undefined;
		const instanceMatch = nodeKey.match(/#instance:(\d+)$/);
		const sourceKey = instanceMatch ? nodeKey.replace(/#instance:\d+$/, '') : nodeKey;
		const source = this.generatedNodeObjects.get(sourceKey);
		if (!(source instanceof THREE.Mesh)) return undefined;
		const geometry = source.geometry as THREE.BufferGeometry & { parameters?: Record<string, number> };
		const parameters = geometry.parameters || {};
		let kind: StudioPartDefinition['kind'];
		if (geometry instanceof THREE.BoxGeometry || geometry.type === 'BoxGeometry') kind = 'box';
		else if (geometry instanceof THREE.CylinderGeometry || geometry.type === 'CylinderGeometry') kind = 'cylinder';
		else if (geometry instanceof THREE.SphereGeometry || geometry.type === 'SphereGeometry') kind = 'sphere';
		else if (geometry instanceof THREE.PlaneGeometry || geometry.type === 'PlaneGeometry') kind = 'plane';
		else return undefined;

		this.scene.updateMatrixWorld(true);
		let worldMatrix = source.matrixWorld.clone();
		if (source instanceof THREE.InstancedMesh && instanceMatch) {
			const instanceMatrix = new THREE.Matrix4();
			source.getMatrixAt(Number(instanceMatch[1]), instanceMatrix);
			worldMatrix = source.matrixWorld.clone().multiply(instanceMatrix);
		}
		const localMatrix = this.componentGroup.matrixWorld.clone().invert().multiply(worldMatrix);
		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3();
		localMatrix.decompose(position, quaternion, scale);
		const rotation = new THREE.Euler().setFromQuaternion(quaternion);

		const part = createStudioPart(kind, 0);
		part.name = info.name;
		part.transform = {
			position: [Number(position.x.toFixed(3)), Number(position.y.toFixed(3)), Number(position.z.toFixed(3))],
			rotation: [rad(rotation.x), rad(rotation.y), rad(rotation.z)],
			scale: [Number(scale.x.toFixed(3)), Number(scale.y.toFixed(3)), Number(scale.z.toFixed(3))],
		};
		if (kind === 'box') {
			part.geometry.width = Number(parameters.width || 1);
			part.geometry.height = Number(parameters.height || 1);
			part.geometry.depth = Number(parameters.depth || 1);
		} else if (kind === 'cylinder') {
			part.geometry.radiusTop = Number(parameters.radiusTop || 0.5);
			part.geometry.radiusBottom = Number(parameters.radiusBottom || 0.5);
			part.geometry.height = Number(parameters.height || 1);
			part.geometry.segments = Number(parameters.radialSegments || 32);
		} else if (kind === 'sphere') {
			part.geometry.radius = Number(parameters.radius || 0.5);
			part.geometry.segments = Number(parameters.widthSegments || 32);
		} else if (kind === 'plane') {
			part.geometry.width = Number(parameters.width || 1);
			part.geometry.depth = Number(parameters.height || 1);
		}
		const sourceMaterial = (Array.isArray(source.material) ? source.material[0] : source.material) as any;
		if (sourceMaterial) {
			if (sourceMaterial.color?.getHexString) part.material.color = '#' + sourceMaterial.color.getHexString();
			if (Number.isFinite(sourceMaterial.opacity)) part.material.opacity = Number(sourceMaterial.opacity);
			if (Number.isFinite(sourceMaterial.metalness)) part.material.metalness = Number(sourceMaterial.metalness);
			if (Number.isFinite(sourceMaterial.roughness)) part.material.roughness = Number(sourceMaterial.roughness);
		}
		return part;
	}

	fit() {
		const box = new THREE.Box3().setFromObject(this.componentGroup);
		if (box.isEmpty()) {
			this.camera.position.set(6, 4.8, 6);
			this.orbit.target.set(0, 0.7, 0);
			this.orbit.update();
			return;
		}
		const sphere = box.getBoundingSphere(new THREE.Sphere());
		const radius = Math.max(0.8, sphere.radius);
		this.orbit.target.copy(sphere.center);
		this.camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(radius * 3.2));
		this.camera.near = Math.max(0.02, radius / 100);
		this.camera.far = Math.max(100, radius * 80);
		this.camera.updateProjectionMatrix();
		this.orbit.update();
	}

	setCameraPreset(preset: 'iso' | 'front' | 'side' | 'top') {
		const box = new THREE.Box3().setFromObject(this.componentGroup);
		const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 2) : box.getBoundingSphere(new THREE.Sphere());
		const distance = Math.max(3, sphere.radius * 3.2);
		const direction = preset === 'front' ? new THREE.Vector3(0, 0.18, 1) : preset === 'side' ? new THREE.Vector3(1, 0.18, 0) : preset === 'top' ? new THREE.Vector3(0.001, 1, 0.001) : new THREE.Vector3(1, 0.75, 1);
		this.orbit.target.copy(sphere.center);
		this.camera.position.copy(sphere.center).add(direction.normalize().multiplyScalar(distance));
		this.orbit.update();
	}

	private rebuild() {
		this.transform.detach();
		this.clearInstanceTransformProxy();
		this.clearSelectionHighlight();
		this.partObjects.clear();
		this.generatedNodeObjects.clear();
		this.generatedStructures.clear();
		this.componentGroup.clear();
		for (const part of this.definition.parts) {
			const object = this.createPartObject(part);
			this.partObjects.set(part.id, object);
			this.componentGroup.add(object);
		}
		this.grid.visible = this.helpers.grid && this.mode !== 'preview';
		this.applyRuntimeVisualState();
		this.rebuildHelpers();
		this.attachSelected();
		this.rebuildSelectionHighlight();
	}

	private clearSelectionHighlight() {
		for (const box of this.selectionPartBoxes.splice(0)) {
			this.selectionGroup.remove(box);
			box.geometry.dispose();
			(box.material as THREE.Material).dispose();
		}
		if (this.selectionBox) {
			this.selectionGroup.remove(this.selectionBox);
			this.selectionBox.geometry.dispose();
			(this.selectionBox.material as THREE.Material).dispose();
			this.selectionBox = undefined;
		}
		if (this.selectionInstanceOverlay) {
			this.selectionGroup.remove(this.selectionInstanceOverlay);
			const materials = Array.isArray(this.selectionInstanceOverlay.material) ? this.selectionInstanceOverlay.material : [this.selectionInstanceOverlay.material];
			for (const material of materials) material.dispose();
			this.selectionInstanceOverlay = undefined;
		}
		this.selectionInstanceSource = undefined;
		this.selectionInstanceIndex = -1;
	}

	private rebuildSelectionHighlight() {
		this.clearSelectionHighlight();
		if (this.mode !== 'design') return;
		if (!this.selectedGeneratedNodeKey) {
			for (const partId of this.selectedPartIds) {
				const object = this.partObjects.get(partId);
				if (!object || !object.visible) continue;
				const box = new THREE.BoxHelper(object, this.selectionColor);
				const material = box.material as THREE.LineBasicMaterial;
				material.depthTest = false; material.transparent = true; material.opacity = 0.98;
				box.renderOrder = 999;
				this.selectionPartBoxes.push(box); this.selectionGroup.add(box);
			}
			return;
		}
		if (!this.selectedPartId) return;
		const info = this.generatedStructures.get(this.selectedPartId)?.find((item) => item.nodeKey === this.selectedGeneratedNodeKey);
		if (!info || info.hidden) return;
		if (Number.isInteger(info.instanceIndex)) {
			const sourceKey = this.selectedGeneratedNodeKey.replace(/#instance:\d+$/, '');
			const source = this.generatedNodeObjects.get(sourceKey);
			if (!(source instanceof THREE.InstancedMesh)) return;
			const overlay = new THREE.Mesh(source.geometry, new THREE.MeshBasicMaterial({ color: this.selectionColor, wireframe: true, transparent: true, opacity: 0.98, depthTest: false, depthWrite: false }));
			overlay.name = 'ComponentStudioInstanceSelection';
			overlay.matrixAutoUpdate = false;
			overlay.frustumCulled = false;
			overlay.renderOrder = 999;
			this.selectionInstanceOverlay = overlay;
			this.selectionInstanceSource = source;
			this.selectionInstanceIndex = info.instanceIndex!;
			this.selectionGroup.add(overlay);
			this.updateSelectionHighlight();
			return;
		}
		const object = this.generatedNodeObjects.get(this.selectedGeneratedNodeKey);
		if (!object || !object.visible) return;
		const box = new THREE.BoxHelper(object, this.selectionColor);
		const material = box.material as THREE.LineBasicMaterial;
		material.depthTest = false;
		material.transparent = true;
		material.opacity = 0.98;
		box.renderOrder = 999;
		this.selectionBox = box;
		this.selectionGroup.add(box);
	}

	private updateSelectionHighlight() {
		for (const box of this.selectionPartBoxes) box.update();
		this.selectionBox?.update();
		const overlay = this.selectionInstanceOverlay;
		const source = this.selectionInstanceSource;
		if (!overlay || !source || this.selectionInstanceIndex < 0) return;
		if (!source.visible) { overlay.visible = false; return; }
		const instanceMatrix = new THREE.Matrix4();
		source.getMatrixAt(this.selectionInstanceIndex, instanceMatrix);
		source.updateWorldMatrix(true, false);
		overlay.matrix.multiplyMatrices(source.matrixWorld, instanceMatrix);
		overlay.matrixWorldNeedsUpdate = true;
		overlay.visible = true;
	}

	private createPartObject(part: StudioPartDefinition) {
		const root = new THREE.Group();
		root.name = part.name;
		root.userData.studioPartId = part.id;
		let visual: THREE.Object3D;
		if (part.kind === 'component' && part.source?.component) {
			const component = part.source.component;
			try {
				const built = defaultComponentRegistry.create({
					objectId: part.id,
					name: part.name,
					resourceKey: component.resourceKey,
					resourceId: component.resourceId,
					componentType: component.componentType,
					generator: component.generator,
					generatorVersion: component.generatorVersion,
					properties: JSON.parse(JSON.stringify(component.properties)),
				});
				visual = built.root;
			} catch (error: any) {
				this.events.onError?.(`组件 ${part.name} 生成失败：${error?.message || error}`);
				visual = this.createMissingGlbPlaceholder();
			}
			this.registerGeneratedStructure(part, visual);
			visual.traverse((child: any) => {
				if (!child.isMesh) return;
				child.castShadow = true;
				child.receiveShadow = true;
			});
		} else if (part.kind === 'glb') {
			const source = this.glbSources.get(part.id);
			visual = source ? source.clone(true) : this.createMissingGlbPlaceholder();
			visual.traverse((child: any) => {
				if (!child.isMesh) return;
				child.castShadow = true;
				child.receiveShadow = true;
				if (Array.isArray(child.material)) child.material = child.material.map((material: any) => material?.clone?.() || material);
				else if (child.material?.clone) child.material = child.material.clone();
			});
		} else {
			const geometry = this.createGeometry(part);
			const material = new THREE.MeshStandardMaterial({
				color: part.material.color,
				transparent: part.material.opacity < 1,
				opacity: part.material.opacity,
				metalness: part.material.metalness,
				roughness: part.material.roughness,
				side: part.kind === 'plane' ? THREE.DoubleSide : THREE.FrontSide,
			});
			const mesh = new THREE.Mesh(geometry, material);
			mesh.castShadow = part.kind !== 'plane';
			mesh.receiveShadow = true;
			visual = mesh;
		}
		visual.userData.studioPartId = part.id;
		root.add(visual);
		root.position.set(...part.transform.position);
		root.rotation.set(deg(part.transform.rotation[0]), deg(part.transform.rotation[1]), deg(part.transform.rotation[2]));
		root.scale.set(...part.transform.scale);
		return root;
	}

	private registerGeneratedStructure(part: StudioPartDefinition, visual: THREE.Object3D) {
		const component = part.source?.component;
		if (!component) return;
		const overrides = component.structuralOverrides || { hiddenNodeKeys: [], nodeTransforms: {} };
		const hidden = new Set(overrides.hiddenNodeKeys || []);
		const infos: StudioGeneratedNodeInfo[] = [];
		const visitChildren = (parent: THREE.Object3D, parentPath: string, depth: number) => {
			const nameCounts = new Map<string, number>();
			for (const child of parent.children) {
				if (child.name?.startsWith('Port_')) continue;
				const baseName = child.name || child.type || 'Object3D';
				const occurrence = nameCounts.get(baseName) || 0;
				nameCounts.set(baseName, occurrence + 1);
				const nodeKey = `${parentPath}/${baseName}[${occurrence}]`;
				child.userData.studioGeneratedNodeKey = nodeKey;
				child.userData.studioGeneratedPartId = part.id;
				const transformOverride = overrides.nodeTransforms?.[nodeKey];
				if (transformOverride) {
					child.position.set(...transformOverride.position);
					child.rotation.set(deg(transformOverride.rotation[0]), deg(transformOverride.rotation[1]), deg(transformOverride.rotation[2]));
					child.scale.set(...transformOverride.scale);
				}
				const isInstanced = child instanceof THREE.InstancedMesh;
				const type: StudioGeneratedNodeInfo['type'] = isInstanced ? 'InstancedMesh' : child instanceof THREE.Mesh ? 'Mesh' : child instanceof THREE.Group ? 'Group' : 'Object3D';
				const nodeHidden = hidden.has(nodeKey);
				child.visible = !nodeHidden;
				this.generatedNodeObjects.set(nodeKey, child);
				infos.push({
					partId: part.id,
					nodeKey,
					name: baseName,
					type,
					depth,
					hidden: nodeHidden,
					canTransform: !isInstanced,
					transform: {
						position: [Number(child.position.x.toFixed(3)), Number(child.position.y.toFixed(3)), Number(child.position.z.toFixed(3))],
						rotation: [rad(child.rotation.x), rad(child.rotation.y), rad(child.rotation.z)],
						scale: [Number(child.scale.x.toFixed(3)), Number(child.scale.y.toFixed(3)), Number(child.scale.z.toFixed(3))],
					},
				});
				if (isInstanced) {
					const matrix = new THREE.Matrix4();
					for (let index = 0; index < child.count; index += 1) {
						const instanceKey = `${nodeKey}#instance:${index}`;
						const instanceHidden = hidden.has(instanceKey);
						child.getMatrixAt(index, matrix);
						const position = new THREE.Vector3();
						const quaternion = new THREE.Quaternion();
						const scale = new THREE.Vector3();
						matrix.decompose(position, quaternion, scale);
						const instanceOverride = overrides.nodeTransforms?.[instanceKey];
						if (instanceOverride) {
							position.set(...instanceOverride.position);
							quaternion.setFromEuler(new THREE.Euler(deg(instanceOverride.rotation[0]), deg(instanceOverride.rotation[1]), deg(instanceOverride.rotation[2])));
							scale.set(...instanceOverride.scale);
							matrix.compose(position, quaternion, scale);
							child.setMatrixAt(index, matrix);
						}
						const rotation = new THREE.Euler().setFromQuaternion(quaternion);
						const effectiveTransform: StudioGeneratedNodeTransform = {
							position: [Number(position.x.toFixed(3)), Number(position.y.toFixed(3)), Number(position.z.toFixed(3))],
							rotation: [rad(rotation.x), rad(rotation.y), rad(rotation.z)],
							scale: [Number(scale.x.toFixed(3)), Number(scale.y.toFixed(3)), Number(scale.z.toFixed(3))],
						};
						if (instanceHidden) {
							matrix.compose(position, quaternion, new THREE.Vector3(0, 0, 0));
							child.setMatrixAt(index, matrix);
						}
						infos.push({
							partId: part.id,
							nodeKey: instanceKey,
							name: baseName === 'Rollers' ? `滚筒 ${index + 1}` : `${baseName} ${index + 1}`,
							type: 'Instance',
							depth: depth + 1,
							hidden: instanceHidden,
							canTransform: true,
							instanceIndex: index,
							transform: effectiveTransform,
						});
					}
					child.instanceMatrix.needsUpdate = true;
				}
				visitChildren(child, nodeKey, depth + 1);
			}
		};
		visitChildren(visual, part.id, 0);
		this.generatedStructures.set(part.id, infos);
	}

	private createGeometry(part: StudioPartDefinition): THREE.BufferGeometry {
		const g = part.geometry;
		if (part.kind === 'cylinder') return new THREE.CylinderGeometry(Math.max(0.01, g.radiusTop), Math.max(0.01, g.radiusBottom), Math.max(0.01, g.height), Math.max(8, Math.round(g.segments || 32)));
		if (part.kind === 'sphere') return new THREE.SphereGeometry(Math.max(0.01, g.radius), Math.max(8, Math.round(g.segments || 32)), Math.max(6, Math.round((g.segments || 32) / 2)));
		if (part.kind === 'plane') return new THREE.PlaneGeometry(Math.max(0.01, g.width), Math.max(0.01, g.depth));
		return new THREE.BoxGeometry(Math.max(0.01, g.width), Math.max(0.01, g.height), Math.max(0.01, g.depth));
	}

	private createMissingGlbPlaceholder() {
		const group = new THREE.Group();
		const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1.4), new THREE.MeshStandardMaterial({ color: 0x475569, transparent: true, opacity: 0.45, wireframe: true }));
		const axes = new THREE.AxesHelper(0.9);
		group.add(box, axes);
		return group;
	}

	private rebuildHelpers() {
		this.helperGroup.clear();
		if (this.helpers.origin) this.helperGroup.add(new THREE.AxesHelper(1.5));
		if (this.helpers.ports) {
			for (const port of this.definition.ports) {
				const group = new THREE.Group();
				group.position.set(...port.position);
				const color = new THREE.Color(port.color || '#38bdf8');
				const marker = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
				const direction = new THREE.Vector3(...port.direction).normalize();
				group.add(marker, new THREE.ArrowHelper(direction.lengthSq() > 0 ? direction : new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.65, color.getHex(), 0.16, 0.08));
				this.helperGroup.add(group);
			}
		}
		if (this.helpers.collisions) {
			for (const collision of this.definition.collisions) {
				let geometry: THREE.BufferGeometry;
				if (collision.kind === 'sphere') geometry = new THREE.SphereGeometry(Math.max(0.01, collision.radius), 16, 10);
				else if (collision.kind === 'cylinder') geometry = new THREE.CylinderGeometry(Math.max(0.01, collision.radius), Math.max(0.01, collision.radius), Math.max(0.01, collision.height), 20);
				else geometry = new THREE.BoxGeometry(Math.max(0.01, collision.size[0]), Math.max(0.01, collision.size[1]), Math.max(0.01, collision.size[2]));
				const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: true, transparent: true, opacity: 0.62, depthTest: false }));
				mesh.position.set(...collision.position);
				this.helperGroup.add(mesh);
			}
		}
		this.helperGroup.visible = this.mode !== 'test' || this.helpers.ports || this.helpers.collisions || this.helpers.origin;
	}

	private applyRuntimeVisualState() {
		this.componentGroup.visible = this.runtimeState.visible;
		this.componentGroup.traverse((child: any) => {
			if (!child.isMesh) return;
			const materials = Array.isArray(child.material) ? child.material : [child.material];
			for (const material of materials) {
				if (!material?.color) continue;
				if (!material.userData.studioBaseColor) material.userData.studioBaseColor = `#${material.color.getHexString()}`;
				material.color.set(this.runtimeState.alarm ? '#ef4444' : material.userData.studioBaseColor);
				if ('emissive' in material) material.emissive.set(this.runtimeState.alarm ? '#7f1d1d' : '#000000');
			}
		});
	}

	private attachSelected() {
		if (this.mode !== 'design' || !this.selectedPartId || this.selectedPartIds.size > 1) { this.transform.detach(); return; }
		if (this.selectedGeneratedNodeKey) {
			const info = this.generatedStructures.get(this.selectedPartId)?.find((item) => item.nodeKey === this.selectedGeneratedNodeKey);
			if (info && Number.isInteger(info.instanceIndex) && !info.hidden) {
				const sourceKey = this.selectedGeneratedNodeKey.replace(/#instance:\d+$/, '');
				const source = this.generatedNodeObjects.get(sourceKey);
				if (source instanceof THREE.InstancedMesh) {
					this.attachInstanceTransformProxy(source, info.instanceIndex!);
					return;
				}
			}
			const generated = this.generatedNodeObjects.get(this.selectedGeneratedNodeKey);
			if (generated && !(generated instanceof THREE.InstancedMesh)) { this.transform.attach(generated); return; }
			this.transform.detach();
			return;
		}
		const object = this.partObjects.get(this.selectedPartId);
		if (object) this.transform.attach(object);
	}

	private commitTransform() {
		if (!this.selectedPartId) return;
		if (this.selectedGeneratedNodeKey) {
			if (this.instanceTransformProxy && this.instanceTransformSource && this.instanceTransformIndex >= 0) {
				this.applyInstanceTransformProxy();
				const proxy = this.instanceTransformProxy;
				this.events.onTransformGeneratedNode?.(this.selectedPartId, this.selectedGeneratedNodeKey, {
					position: [Number(proxy.position.x.toFixed(3)), Number(proxy.position.y.toFixed(3)), Number(proxy.position.z.toFixed(3))],
					rotation: [rad(proxy.rotation.x), rad(proxy.rotation.y), rad(proxy.rotation.z)],
					scale: [Number(proxy.scale.x.toFixed(3)), Number(proxy.scale.y.toFixed(3)), Number(proxy.scale.z.toFixed(3))],
				});
				return;
			}
			const generated = this.generatedNodeObjects.get(this.selectedGeneratedNodeKey);
			if (!generated || generated instanceof THREE.InstancedMesh) return;
			this.events.onTransformGeneratedNode?.(this.selectedPartId, this.selectedGeneratedNodeKey, {
				position: [Number(generated.position.x.toFixed(3)), Number(generated.position.y.toFixed(3)), Number(generated.position.z.toFixed(3))],
				rotation: [rad(generated.rotation.x), rad(generated.rotation.y), rad(generated.rotation.z)],
				scale: [Number(generated.scale.x.toFixed(3)), Number(generated.scale.y.toFixed(3)), Number(generated.scale.z.toFixed(3))],
			});
			return;
		}
		const object = this.partObjects.get(this.selectedPartId);
		if (!object) return;
		this.events.onTransformPart?.(this.selectedPartId, {
			position: [Number(object.position.x.toFixed(3)), Number(object.position.y.toFixed(3)), Number(object.position.z.toFixed(3))],
			rotation: [rad(object.rotation.x), rad(object.rotation.y), rad(object.rotation.z)],
			scale: [Number(object.scale.x.toFixed(3)), Number(object.scale.y.toFixed(3)), Number(object.scale.z.toFixed(3))],
		});
	}

	private readonly handlePointerDown = (event: PointerEvent) => {
		if (this.mode !== 'design' || event.button !== 0) return;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, this.camera);
		const intersection: any = raycaster.intersectObjects(this.componentGroup.children, true)[0];
		const hit = intersection?.object;
		if (hit?.userData?.studioGeneratedNodeKey && hit instanceof THREE.InstancedMesh && Number.isInteger(intersection?.instanceId)) {
			const partId = String(hit.userData.studioGeneratedPartId || '');
			const nodeKey = `${hit.userData.studioGeneratedNodeKey}#instance:${intersection.instanceId}`;
			if (partId) { this.selectGeneratedNode(partId, nodeKey, event.ctrlKey || event.metaKey); return; }
		}
		let generated: any = hit;
		while (generated && !generated.userData?.studioGeneratedNodeKey && !generated.userData?.studioPartId) generated = generated.parent;
		if (generated?.userData?.studioGeneratedNodeKey) {
			const partId = String(generated.userData.studioGeneratedPartId || '');
			if (partId) { this.selectGeneratedNode(partId, String(generated.userData.studioGeneratedNodeKey), event.ctrlKey || event.metaKey); return; }
		}
		let current: any = hit;
		while (current && !current.userData?.studioPartId) current = current.parent;
		const partId = current?.userData?.studioPartId;
		if (!partId) return;
		const selectedId = String(partId);
		const additive = event.ctrlKey || event.metaKey;
		if (!additive) this.selectPart(selectedId);
		this.events.onSelectPart?.(selectedId, additive);
	};

	private resize() {
		const width = Math.max(1, this.container.clientWidth);
		const height = Math.max(1, this.container.clientHeight);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height, false);
	}

	private attachInstanceTransformProxy(source: THREE.InstancedMesh, index: number) {
		this.clearInstanceTransformProxy();
		const matrix = new THREE.Matrix4();
		source.getMatrixAt(index, matrix);
		const proxy = new THREE.Object3D();
		matrix.decompose(proxy.position, proxy.quaternion, proxy.scale);
		proxy.name = 'ComponentStudioInstanceTransformProxy';
		source.add(proxy);
		this.instanceTransformProxy = proxy;
		this.instanceTransformSource = source;
		this.instanceTransformIndex = index;
		this.transform.attach(proxy);
	}

	private applyInstanceTransformProxy() {
		if (!this.instanceTransformProxy || !this.instanceTransformSource || this.instanceTransformIndex < 0) return;
		this.instanceTransformProxy.updateMatrix();
		this.instanceTransformSource.setMatrixAt(this.instanceTransformIndex, this.instanceTransformProxy.matrix);
		this.instanceTransformSource.instanceMatrix.needsUpdate = true;
	}

	private clearInstanceTransformProxy() {
		if (!this.instanceTransformProxy) {
			this.instanceTransformSource = undefined;
			this.instanceTransformIndex = -1;
			return;
		}
		if (this.transform.object === this.instanceTransformProxy) this.transform.detach();
		this.instanceTransformProxy.removeFromParent();
		this.instanceTransformProxy = undefined;
		this.instanceTransformSource = undefined;
		this.instanceTransformIndex = -1;
	}

	private render = () => {
		if (this.disposed) return;
		const now = performance.now();
		const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
		this.lastFrame = now;
		if (this.mode === 'test' && this.runtimeState.run && this.runtimeState.visible) {
			for (const animation of this.definition.animations) {
				if (animation.kind !== 'rotate') continue;
				const object = this.partObjects.get(animation.targetPartId);
				if (!object) continue;
				const amount = deg(animation.speed * this.runtimeState.speedMultiplier) * delta;
				object.rotation[animation.axis] += amount;
			}
		}
		this.orbit.update();
		this.updateSelectionHighlight();
		this.renderer.render(this.scene, this.camera);
		this.animationFrame = requestAnimationFrame(this.render);
	};

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		cancelAnimationFrame(this.animationFrame);
		this.resizeObserver.disconnect();
		this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
		this.clearInstanceTransformProxy();
		this.transform.detach();
		this.clearSelectionHighlight();
		this.transform.dispose?.();
		this.orbit.dispose?.();
		this.renderer.dispose();
		this.container.removeChild(this.renderer.domElement);
	}
}
