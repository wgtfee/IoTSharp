import * as THREE from 'three';
import type { ThreeEditorModelSnapshot, ThreeEditorSnapshot, TwinEquipmentType, TwinRouteDefinition, TwinSceneManifest, TwinSceneObjectDefinition, TwinVector3 } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import type { TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';
import { ProceduralPackagingLine } from '/@/digital-twin/runtime/ProceduralPackagingLine';
import { clearTransportRouteAttachment, defaultComponentRegistry, isComponentSceneObject, isTransportUnitSceneObject, revalidateComponentConnections, snapSceneComponent, upsertGeneratedComponentRoute, type TwinComponentDefinition } from '/@/digital-twin/components';
import { ThreeEditorRouteOverlay } from '/@/digital-twin/editor-adapter/ThreeEditorRouteOverlay';
import { EngineeringOverlayManager, type EngineeringOverlayLayer } from '/@/digital-twin/editor-adapter/EngineeringOverlayManager';
import { normalizeScreenRect, projectWorldBoundsToScreen, screenRectsIntersect, type TwinScreenRect } from '/@/digital-twin/editor-adapter/MultiSelectionGeometry';

// 上游是固定提交的 Apache-2.0 JavaScript 源码，IoTSharp 通过本适配层隔离其动态 API。
// @ts-ignore -- vendored JavaScript intentionally has no TypeScript declarations.
import { ThreeEditor } from '/@/digital-twin/vendor/three-editor-cores/lib/main.js';
// @ts-ignore -- see the vendored source note above.
import { restoreHistoryHandler } from '/@/digital-twin/vendor/three-editor-cores/lib/Editor/Handler/History.js';

export interface ThreeEditorCoreHostEvents {
	onSelectionChange?: (selection: TwinSelectionInfo | null) => void;
	onMultiSelectionChange?: (objectIds: string[]) => void;
	onMarqueeChange?: (rectangle?: TwinScreenRect) => void;
	onRouteChange?: (route: TwinRouteDefinition) => void;
	onChanged?: () => void;
	onError?: (message: string) => void;
}

interface LoadedEditorModel {
	objectId: string;
	resourceId?: string;
	root: any;
	dispose?: () => void;
	kind: 'model' | 'component' | 'procedural' | 'equipment';
}

interface GroupMoveSnapshot {
	pivotPosition: THREE.Vector3;
	worldPositions: Map<string, THREE.Vector3>;
}

interface GroupMoveHistoryEntry {
	before: Map<string, THREE.Vector3>;
	after: Map<string, THREE.Vector3>;
}

const editorCommit = 'd7e2ddf6cc1fa8c626356a3606167abff68daaed';
const coreCommit = '98197115af2318ed20f334873517018509b8e079';
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isTransientUrl = (value: unknown): value is string => typeof value === 'string' && /^(blob:|data:|https?:)/i.test(value.trim());
const forbiddenExecutablePropertyNames = new Set(['script', 'scripts', 'function', 'functions', 'javascript']);
const containsIdentifierToken = (propertyName: string, token: string) => {
	for (let searchFrom = 0; searchFrom < propertyName.length;) {
		const index = propertyName.toLowerCase().indexOf(token, searchFrom);
		if (index < 0) return false;
		const end = index + token.length;
		const startsToken = index === 0 || !/[a-z0-9]/i.test(propertyName[index - 1]) || (/[a-z]/.test(propertyName[index - 1]) && /[A-Z]/.test(propertyName[index]));
		const endsToken = end === propertyName.length || !/[a-z0-9]/i.test(propertyName[end]) || /[A-Z]/.test(propertyName[end]);
		if (startsToken && endsToken) return true;
		searchFrom = index + 1;
	}
	return false;
};
const isForbiddenExecutablePropertyName = (propertyName: string) => forbiddenExecutablePropertyNames.has(propertyName.toLowerCase())
	|| containsIdentifierToken(propertyName, 'script')
	|| containsIdentifierToken(propertyName, 'function');
const sanitizeEditorJson = (value: unknown): unknown => {
	if (isTransientUrl(value)) return undefined;
	if (Array.isArray(value)) return value.map(sanitizeEditorJson).filter((item) => item !== undefined);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !isForbiddenExecutablePropertyName(key))
			.map(([key, child]) => [key, sanitizeEditorJson(child)] as const)
			.filter(([, child]) => child !== undefined));
	}
	return value;
};
const sanitizeModelSnapshot = (value: any): ThreeEditorModelSnapshot | null => {
	const objectId = value?.rootInfo?.iotsharpObjectId;
	if (typeof objectId !== 'string' || !objectId) return null;
	return {
		rootInfo: {
			type: 'GLTF',
			iotsharpObjectId: objectId,
			iotsharpResourceId: typeof value.rootInfo.iotsharpResourceId === 'string' ? value.rootInfo.iotsharpResourceId : undefined,
			name: typeof value.rootInfo.name === 'string' ? value.rootInfo.name : undefined,
		},
		group: value.group ? sanitizeEditorJson(cloneJson(value.group)) as Record<string, unknown> : undefined,
	};
};

const disposeObjectTree = (root: any) => {
	root?.traverse?.((object: any) => {
		object.geometry?.dispose?.();
		const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
		for (const material of materials) material?.dispose?.();
	});
};

/** threejs-editor 专业编辑内核与 IoTSharp Manifest 的稳定边界。 */
export class ThreeEditorCoreHost {
	private readonly container: HTMLDivElement;
	private readonly events: ThreeEditorCoreHostEvents;
	private readonly resizeObserver: ResizeObserver;
	private readonly objectUrls = new Set<string>();
	private readonly loadedModels = new Map<string, LoadedEditorModel>();
	private readonly routeOverlay: ThreeEditorRouteOverlay;
	private readonly engineeringOverlay: EngineeringOverlayManager;
	private manifest: TwinSceneManifest;
	private editor: any;
	private selectedObjectId?: string;
	private readonly selectedObjectIds = new Set<string>();
	private selectedRouteId?: string;
	private selectedRoutePointId?: string;
	private selectionMode: 'select' | 'root' | 'multi' = 'root';
	private readonly multiSelectionPivot = new THREE.Object3D();
	private groupMoveSnapshot?: GroupMoveSnapshot;
	private readonly groupMoveHistory: GroupMoveHistoryEntry[] = [];
	private readonly groupMoveRedoHistory: GroupMoveHistoryEntry[] = [];
	private marqueeStart?: { x: number; y: number; additive: boolean; baseIds: Set<string> };
	private suppressNextClick = false;
	private routeEditMode = false;
	private routeDrawMode = false;
	private latestSceneParams: Record<string, unknown> = {};
	private latestModelParams: ThreeEditorModelSnapshot[] = [];
	private disposed = false;

	constructor(container: HTMLDivElement, guiContainer: HTMLDivElement, manifest: TwinSceneManifest, events: ThreeEditorCoreHostEvents = {}) {
		this.container = container;
		this.events = events;
		this.manifest = manifest;
		const snapshot = manifest.editorExtension?.threeEditor;
		this.latestSceneParams = cloneJson(snapshot?.sceneParams || {});
		this.latestModelParams = cloneJson(snapshot?.modelParams || []);

		ThreeEditor.dracoPath = `${import.meta.env.BASE_URL}iotsharp-three-editor/draco/`;
		this.editor = new ThreeEditor({
			threeBoxRef: container,
			rendererParams: {
				fps: null,
				pixelRatio: Math.min(window.devicePixelRatio || 1, manifest.runtime.maxPixelRatio || 2),
				webglRenderParams: { antialias: true, alpha: true, logarithmicDepthBuffer: true },
				userPermissions: { autoPlace: false, proxy: false },
			},
			sceneParams: this.latestSceneParams,
			meshListParams: [],
			saveEditorCallBack: (sceneParams: Record<string, unknown>, modelParams: unknown[]) => {
				this.latestSceneParams = sanitizeEditorJson(cloneJson(sceneParams || {})) as Record<string, unknown>;
				const glbIds = new Set((this.manifest.objects || []).filter((item) => item.kind === 'model').map((item) => item.objectId));
				this.latestModelParams = (modelParams || []).map(sanitizeModelSnapshot).filter((item): item is ThreeEditorModelSnapshot => Boolean(item && glbIds.has(item.rootInfo.iotsharpObjectId)));
			},
		});
		this.ensureIndustrialEditorEnvironment();

		this.editor.setGUIDomPosition(guiContainer);
		this.editor.setSceneControlMode('变换');
		this.editor.setOperateOption('openKey', false);
		this.editor.setOperateOption('grid', manifest.runtime.showGrid);
		this.multiSelectionPivot.name = 'IoTSharp 多选移动中心';
		this.multiSelectionPivot.userData.iotsharpTwinHelper = true;
		this.editor.viewer.scene.add(this.multiSelectionPivot);
		this.routeOverlay = new ThreeEditorRouteOverlay(this.editor.viewer.scene, this.manifest);
		this.engineeringOverlay = new EngineeringOverlayManager(this.editor.viewer.scene, this.manifest, this.routeOverlay);
		this.editor.viewer.transformControls.dragChangeCallback = (dragging: boolean) => {
			if (dragging) {
				this.suppressNextClick = true;
				if (this.editor.viewer.transformControls.object === this.multiSelectionPivot && this.selectedObjectIds.size > 1) {
					this.groupMoveSnapshot = {
						pivotPosition: this.multiSelectionPivot.position.clone(),
						worldPositions: this.captureSelectedWorldPositions(),
					};
				}
				return;
			}

			if (this.groupMoveSnapshot && this.editor.viewer.transformControls.object === this.multiSelectionPivot) {
				this.applyMultiSelectionTranslation();
				const before = this.groupMoveSnapshot.worldPositions;
				const after = this.captureSelectedWorldPositions();
				if ([...before].some(([objectId, position]) => position.distanceToSquared(after.get(objectId) || position) > 0.0000001)) {
					this.groupMoveHistory.push({ before, after });
					this.groupMoveRedoHistory.length = 0;
				}
				this.groupMoveSnapshot = undefined;
				this.commitMovedObjectGroup();
				return;
			}

			if (this.selectedRouteId && this.selectedRoutePointId) {
				const selectedRoute = this.manifest.routes.find((candidate) => candidate.routeId === this.selectedRouteId);
				if (selectedRoute?.generatedBy === 'component-connections') {
					this.routeOverlay.rebuild(this.manifest);
					this.events.onError?.('自动路线由组件端口连接生成，请移动组件或修改 Connection。');
					return;
				}
				const route = this.routeOverlay.updatePointFromMesh(this.selectedRouteId, this.selectedRoutePointId);
				if (route) {
					this.events.onRouteChange?.(cloneJson(route));
					this.events.onChanged?.();
					return;
				}
			}

			this.syncTransformsToManifest();
			const selectedId = this.selectedObjectId;
			const selected = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === selectedId);
			if (selectedId && isComponentSceneObject(selected)) {
				revalidateComponentConnections(this.manifest);
				const autoSnapEnabled = selected.component.properties?.autoSnap !== false;
				const transportUnit = isTransportUnitSceneObject(selected);
				const snapped = autoSnapEnabled ? snapSceneComponent(this.manifest, selectedId) : undefined;
				// 运输单元被明确拖离兼容辊道时解除 Route/Section 归属；关闭自动吸附时保留人工配置。
				if (transportUnit && autoSnapEnabled && !snapped) clearTransportRouteAttachment(selected);
				if (snapped) {
					const root = this.loadedModels.get(selectedId)?.root;
					if (root) {
						root.position.set(...selected.transform.position);
						root.rotation.set(...selected.transform.rotation);
						root.scale.set(...selected.transform.scale);
						root.updateMatrixWorld?.(true);
					}
					this.selectObject(selectedId);
				}
				upsertGeneratedComponentRoute(this.manifest);
				this.syncLoadedComponentTransformsFromManifest();
			}
			this.routeOverlay.rebuild(this.manifest);
			this.engineeringOverlay.rebuild(this.manifest);
			this.events.onChanged?.();
		};
		this.editor.viewer.transformControls.addEventListener('change', this.handleTransformControlsChange);
		this.container.addEventListener('click', this.handleSceneClick);
		this.container.addEventListener('pointerdown', this.handleMarqueePointerDown, true);
		window.addEventListener('pointermove', this.handleMarqueePointerMove, true);
		window.addEventListener('pointerup', this.handleMarqueePointerUp, true);
		this.resizeObserver = new ResizeObserver(() => this.editor?.viewer?.renderSceneResize?.());
		this.resizeObserver.observe(container);
		this.loadManifestComponents();
		this.loadManifestProceduralReferences();
	}

	async loadGlbBuffer(object: TwinSceneObjectDefinition, fileName: string, buffer: ArrayBuffer) {
		if (this.disposed || object.kind !== 'model') return;
		this.removeObject(object.objectId, false);
		const objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
		this.objectUrls.add(objectUrl);
		const stored = this.latestModelParams.find((item) => item.rootInfo.iotsharpObjectId === object.objectId);
		const rootInfo = { type: 'GLTF', url: objectUrl, name: fileName, iotsharpObjectId: object.objectId, iotsharpResourceId: object.resourceId };
		await new Promise<void>((resolve) => {
			const { loaderService } = this.editor.setModelFromInfo(rootInfo, stored?.group);
			loaderService.complete = (root: any) => {
				queueMicrotask(() => {
					root.name = object.name;
					root.userData = { ...root.userData, iotsharpObjectId: object.objectId, iotsharpResourceId: object.resourceId };
					root.position.set(...object.transform.position);
					root.rotation.set(...object.transform.rotation);
					root.scale.set(...object.transform.scale);
					this.loadedModels.set(object.objectId, { objectId: object.objectId, resourceId: object.resourceId, root, kind: 'model' });
					this.editor.setOutlinePass([root]);
					this.editor.viewer.transformControls.attach(root);
					this.selectRoot(root);
					resolve();
				});
			};
		});
	}

	loadComponent(object: TwinV7SceneObjectDefinition) {
		if (this.disposed || !isComponentSceneObject(object)) return;
		this.removeObject(object.objectId, false);
		try {
			object.transform.scale = [1, 1, 1];
			const definition: TwinComponentDefinition = {
				objectId: object.objectId,
				name: object.name,
				resourceKey: object.component.resourceKey,
				componentType: object.component.componentType as TwinComponentDefinition['componentType'],
				generator: object.component.generator,
				generatorVersion: object.component.generatorVersion,
				resourceId: object.resourceId || object.component.resourceKey,
				resourceVersion: object.component.generatorVersion,
				properties: object.component.properties || {},
				transform: object.transform,
				sectionId: object.component.sectionId,
				routeEdgeId: object.component.routeEdgeId,
			};
			const built = defaultComponentRegistry.create(definition);
			const root: any = built.root;
			root.name = object.name;
			root.userData = { ...root.userData, iotsharpObjectId: object.objectId, componentResourceKey: object.component.resourceKey };
			root.rootInfo = { type: 'IOTSHARP_COMPONENT', name: object.name, iotsharpObjectId: object.objectId, iotsharpResourceId: object.resourceId };
			root.position.set(...object.transform.position);
			root.rotation.set(...object.transform.rotation);
			root.scale.set(1, 1, 1);
			this.editor.viewer.scene.add(root);
			this.loadedModels.set(object.objectId, { objectId: object.objectId, resourceId: object.resourceId, root, dispose: built.dispose, kind: 'component' });
			this.editor.viewer.renderScene?.();
		} catch (error) {
			this.events.onError?.(`V7 组件 ${object.name} 加载失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	reloadComponent(objectId: string) {
		this.syncTransformsToManifest();
		const object = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === objectId);
		if (!isComponentSceneObject(object)) return;
		this.loadComponent(object);
		upsertGeneratedComponentRoute(this.manifest);
		this.syncLoadedComponentTransformsFromManifest();
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		this.selectObject(objectId);
		this.events.onChanged?.();
	}

	reloadAllComponents() {
		for (const model of [...this.loadedModels.values()].filter((item) => item.kind === 'component')) this.removeObject(model.objectId, false);
		this.loadManifestComponents();
		upsertGeneratedComponentRoute(this.manifest);
		this.syncLoadedComponentTransformsFromManifest();
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		this.events.onChanged?.();
	}

	/** 按 Manifest 中的持久化 Transform 立即更新已加载对象，不先从旧 root 反向覆盖。 */
	applyObjectTransform(objectId: string) {
		const object = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === objectId);
		const model = this.loadedModels.get(objectId);
		if (!object || !model?.root) return false;
		model.root.position.set(...object.transform.position);
		model.root.rotation.set(...object.transform.rotation);
		if (isComponentSceneObject(object)) {
			model.root.scale.set(1, 1, 1);
			object.transform.scale = [1, 1, 1];
			revalidateComponentConnections(this.manifest);
			upsertGeneratedComponentRoute(this.manifest);
			this.syncLoadedComponentTransformsFromManifest();
		} else model.root.scale.set(...object.transform.scale);
		model.root.updateMatrixWorld?.(true);
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		this.selectObject(objectId);
		this.editor.viewer.renderScene?.();
		this.events.onChanged?.();
		return true;
	}

	refreshRouteOverlay() {
		this.routeOverlay.setManifest(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		this.editor.viewer.renderScene?.();
	}

	/**
	 * 将浏览器客户区坐标转换成专业编辑器工程落点。
	 * 拖模型到辊道时必须优先命中用户实际看到的 V7 输送组件；如果只投影到 Y=0 地面，
	 * 斜视相机会让鼠标视觉落点与 Route 中心线产生数米偏差，导致“看起来放在辊道上却不吸附”。
	 * 命中输送组件时只采用命中点的 X/Z，Y 仍保持工程地面高度，避免新增设备根节点悬浮。
	 */
	worldPositionFromClientPoint(clientX: number, clientY: number, groundY = 0): TwinVector3 | undefined {
		if (this.disposed || !Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(groundY)) return undefined;
		const bounds = this.container.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return undefined;
		const pointer = new THREE.Vector2(
			((clientX - bounds.left) / bounds.width) * 2 - 1,
			-((clientY - bounds.top) / bounds.height) * 2 + 1,
		);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, this.editor.viewer.camera);

		const conveyorRoots: THREE.Object3D[] = [];
		for (const [objectId, loaded] of this.loadedModels) {
			if (loaded.kind !== 'component' || !loaded.root?.visible) continue;
			const object = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === objectId);
			if (!isComponentSceneObject(object)) continue;
			const properties = object.component.properties || {};
			const isConveyor = properties.conveyorSizeClass === 'small' || properties.conveyorSizeClass === 'large'
				|| ['roller-conveyor', 'turn-conveyor-90', 'diverter-conveyor', 'merger-conveyor'].includes(object.component.componentType);
			if (isConveyor) conveyorRoots.push(loaded.root);
		}
		if (conveyorRoots.length) {
			const hit = raycaster.intersectObjects(conveyorRoots, true).find((item) => item.object.visible !== false);
			if (hit) return [hit.point.x, groundY, hit.point.z];
		}

		const point = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY), new THREE.Vector3());
		return point ? [point.x, point.y, point.z] : undefined;
	}

	/** 把顶层对象或程序化整机移动到指定世界坐标，并同步其 Manifest 局部变换。 */
	setObjectWorldPosition(objectId: string, position: TwinVector3) {
		const model = this.loadedModels.get(objectId);
		const object = this.manifest.objects.find((item) => item.objectId === objectId);
		if (!model?.root || !object) return false;
		const localPosition = new THREE.Vector3(...position);
		model.root.parent?.updateWorldMatrix?.(true, false);
		model.root.parent?.worldToLocal(localPosition);
		model.root.position.copy(localPosition);
		model.root.updateMatrixWorld?.(true);
		object.transform.position = [localPosition.x, localPosition.y, localPosition.z];
		this.editor.viewer.renderScene?.();
		this.selectObject(objectId);
		this.events.onChanged?.();
		return true;
	}

	/** 场景新增整机映射后，重建程序化参考及其独立可选对象。 */
	reloadProceduralReferences() {
		this.editor.viewer.transformControls.detach();
		for (const item of [...this.loadedModels.values()].filter((candidate) => candidate.kind === 'equipment')) {
			this.loadedModels.delete(item.objectId);
		}
		for (const item of [...this.loadedModels.values()].filter((candidate) => candidate.kind === 'procedural')) {
			this.removeObject(item.objectId, false);
		}
		this.loadManifestProceduralReferences();
		this.engineeringOverlay.rebuild(this.manifest);
		this.editor.viewer.renderScene?.();
		this.events.onChanged?.();
	}

	/**
	 * 在专业编辑器中加载程序化产线的静态工程参考。
	 * 输送机仍由 V7 Component 绘制；这里补齐运行时拥有的机器人、旋转台、丝车、桁架、托盘和后包装设备。
	 */
	private loadManifestProceduralReferences() {
		const supportedPresets = new Set(['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line']);
		for (const object of this.manifest.objects) {
			if (object.kind !== 'procedural' || !supportedPresets.has(object.procedural?.preset || '') || this.loadedModels.has(object.objectId)) continue;
			const route = this.manifest.routes.find((candidate) => candidate.routeId === 'silk-cake-line-main') || this.manifest.routes[0];
			if (!route) continue;
			try {
				const palletCount = object.procedural?.palletCount ?? this.manifest.runtime.silkLineSimulation?.palletCount ?? 80;
				// manifest 来自 Vue ref，route/options 可能是响应式 Proxy；程序化运行时内部会 structuredClone，
				// 因此必须在编辑器适配边界先转成纯 JSON 数据。
				const routeSnapshot = cloneJson(route);
				const simulationSnapshot = cloneJson(this.manifest.runtime.silkLineSimulation || {});
				const woodPackagingRoute = this.manifest.routes.find((candidate) => candidate.routeId === 'silk-wood-packaging-route');
				const reference = new ProceduralPackagingLine(routeSnapshot, palletCount, simulationSnapshot, {
					renderLegacyPlasticConveyors: false,
					renderLegacyPreProcessStations: false,
					renderLegacyGantryConveyors: false,
					renderLegacyPostProcessConveyor: false,
					woodPackagingRoute: woodPackagingRoute ? cloneJson(woodPackagingRoute) : undefined,
				});
				const root: any = reference.group;
				root.name = object.name;
				root.userData = { ...root.userData, iotsharpObjectId: object.objectId, editorProceduralReference: true };
				root.rootInfo = { type: 'IOTSHARP_PROCEDURAL', name: object.name, iotsharpObjectId: object.objectId };
				root.position.set(...object.transform.position);
				root.rotation.set(...object.transform.rotation);
				root.scale.set(...object.transform.scale);
				this.editor.viewer.scene.add(root);
				this.loadedModels.set(object.objectId, { objectId: object.objectId, root, dispose: () => disposeObjectTree(root), kind: 'procedural' });
				const equipmentRoots = reference.getEquipmentRoots();
				const equipmentObjects = this.manifest.objects.filter((candidate) => candidate.kind === 'equipment'
					&& candidate.equipment?.parentObjectId === object.objectId);
				for (const equipmentObject of equipmentObjects) {
					const equipmentType = equipmentObject.equipment!.equipmentType as TwinEquipmentType;
					const equipmentRoot: any = equipmentRoots[equipmentType];
					if (!equipmentRoot) continue;
					equipmentRoot.name = equipmentObject.name;
					equipmentRoot.userData = {
						...equipmentRoot.userData,
						iotsharpObjectId: equipmentObject.objectId,
						twinEquipmentType: equipmentType,
						twinEquipmentId: equipmentObject.objectId,
					};
					equipmentRoot.rootInfo = {
						type: 'IOTSHARP_EQUIPMENT',
						name: equipmentObject.name,
						iotsharpObjectId: equipmentObject.objectId,
					};
					equipmentRoot.position.set(...equipmentObject.transform.position);
					equipmentRoot.rotation.set(...equipmentObject.transform.rotation);
					equipmentRoot.scale.set(...equipmentObject.transform.scale);
					this.loadedModels.set(equipmentObject.objectId, {
						objectId: equipmentObject.objectId,
						root: equipmentRoot,
						kind: 'equipment',
					});
				}
				this.editor.viewer.renderScene?.();
			} catch (error) {
				this.events.onError?.(`程序化设备参考加载失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** 没有用户灯光配置时，提供与运行预览一致的工业场景照明及默认观察视角。 */
	private ensureIndustrialEditorEnvironment() {
		const scene: THREE.Scene = this.editor.viewer.scene;
		const renderer: THREE.WebGLRenderer = this.editor.viewer.renderer;
		const camera: THREE.PerspectiveCamera = this.editor.viewer.camera;
		const controls = this.editor.viewer.controls;
		const hasStoredRenderer = Boolean((this.latestSceneParams as any).renderer);
		const hasStoredCamera = Boolean((this.latestSceneParams as any).camera || (this.latestSceneParams as any).controls);
		const isSilkLine = this.manifest.objects.some((item) => item.kind === 'procedural' && ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
		// 兼容历史快照中的缺失/非法控制参数；否则 OrbitControls 的滚轮缩放会静默失效。
		controls.enableZoom = true;
		controls.zoomSpeed = Number.isFinite(controls.zoomSpeed) && controls.zoomSpeed > 0 ? controls.zoomSpeed : 1.1;
		controls.minDistance = Number.isFinite(controls.minDistance) && controls.minDistance >= 0 ? Math.min(controls.minDistance, 1) : 0.5;
		controls.maxDistance = Number.isFinite(controls.maxDistance) && controls.maxDistance > controls.minDistance ? Math.max(controls.maxDistance, 500) : 5000;

		if (!hasStoredRenderer) {
			renderer.outputColorSpace = THREE.SRGBColorSpace;
			renderer.toneMapping = THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = 1.08;
			renderer.shadowMap.enabled = true;
			renderer.shadowMap.type = THREE.PCFSoftShadowMap;
			renderer.setClearColor(this.manifest.world.background || '#07111f', 1);
		}

		if (!scene.children.some((item) => item instanceof THREE.Light)) {
			const hemisphere = new THREE.HemisphereLight(0xd9efff, 0x17243a, 1.8);
			hemisphere.name = 'IoTSharp 默认半球光';
			scene.add(hemisphere);
			const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
			keyLight.name = 'IoTSharp 主平行光';
			keyLight.position.set(18, 28, 16);
			keyLight.castShadow = true;
			keyLight.shadow.mapSize.set(2048, 2048);
			keyLight.shadow.camera.left = -60;
			keyLight.shadow.camera.right = 60;
			keyLight.shadow.camera.top = 60;
			keyLight.shadow.camera.bottom = -60;
			scene.add(keyLight);
			const fillLight = new THREE.DirectionalLight(0x8fd3ff, 0.9);
			fillLight.name = 'IoTSharp 侧向补光';
			fillLight.position.set(-20, 14, -18);
			scene.add(fillLight);
		}

		if (!hasStoredCamera && isSilkLine) {
			camera.position.set(32, 26, 38);
			controls.target.set(5, 1.2, -2);
			camera.updateProjectionMatrix();
			controls.update?.();
		}
	}

	setRouteOverlayVisible(visible: boolean) {
		this.engineeringOverlay.setVisible('routes', visible);
		this.editor.viewer.renderScene?.();
	}

	setEngineeringOverlayVisible(layer: Exclude<EngineeringOverlayLayer, 'routes'>, visible: boolean) {
		this.engineeringOverlay.setVisible(layer, visible);
		this.editor.viewer.renderScene?.();
	}

	setRouteEditMode(enabled: boolean) {
		this.routeEditMode = enabled;
		if (!enabled) {
			this.routeDrawMode = false;
			this.clearRoutePointSelection();
		}
		this.routeOverlay.setVisible(true);
	}

	setRouteDrawMode(enabled: boolean) {
		this.routeDrawMode = enabled;
		if (enabled) this.routeEditMode = true;
		this.routeOverlay.setVisible(true);
	}

	getRoute() {
		const route = this.manifest.routes.find((candidate) => candidate.routeId === this.selectedRouteId) || this.manifest.routes[0];
		return route ? cloneJson(route) : undefined;
	}

	setRoute(route: TwinRouteDefinition) {
		const index = this.manifest.routes.findIndex((candidate) => candidate.routeId === route.routeId);
		if (index >= 0) this.manifest.routes.splice(index, 1, cloneJson(route));
		else if (this.manifest.routes.length) this.manifest.routes.splice(0, 1, cloneJson(route));
		else this.manifest.routes.push(cloneJson(route));
		this.routeOverlay.rebuild(this.manifest);
	}

	updateRoutePoint(index: number, position: TwinVector3) {
		const routeIndex = this.manifest.routes.findIndex((candidate) => candidate.routeId === this.selectedRouteId);
		const targetIndex = routeIndex >= 0 ? routeIndex : 0;
		if (this.manifest.routes[targetIndex]?.generatedBy === 'component-connections') { this.events.onError?.('自动路线控制点只读，请调整组件或 Connection。'); return; }
		const route = this.routeOverlay.updatePoint(targetIndex, index, position);
		if (!route) return;
		this.events.onRouteChange?.(cloneJson(route));
		this.events.onChanged?.();
	}

	addRoutePoint(position?: TwinVector3) {
		const routeIndex = this.manifest.routes.findIndex((candidate) => candidate.routeId === this.selectedRouteId);
		const targetIndex = routeIndex >= 0 ? routeIndex : 0;
		if (this.manifest.routes[targetIndex]?.generatedBy === 'component-connections') { this.events.onError?.('自动路线不能手工增加控制点，请先创建手工路线。'); return; }
		const created = this.routeOverlay.addPoint(position, targetIndex);
		if (!created) return;
		this.selectRoutePoint(created.route.routeId, created.point.pointId);
		this.events.onRouteChange?.(cloneJson(created.route));
		this.events.onChanged?.();
	}

	removeRoutePoint(index: number) {
		const route = this.manifest.routes.find((candidate) => candidate.routeId === this.selectedRouteId) || this.manifest.routes?.[0];
		const point = route?.points?.[index];
		if (!route || !point) return;
		if (route.generatedBy === 'component-connections') { this.events.onError?.('自动路线控制点只读，请调整组件或 Connection。'); return; }
		const changed = this.routeOverlay.removePoint(route.routeId, point.pointId);
		if (!changed) return;
		this.clearRoutePointSelection();
		this.events.onRouteChange?.(cloneJson(changed));
		this.events.onChanged?.();
	}

	removeSelectedRoutePoint() {
		if (!this.selectedRouteId || !this.selectedRoutePointId) return false;
		const selectedRoute = this.manifest.routes.find((candidate) => candidate.routeId === this.selectedRouteId);
		if (selectedRoute?.generatedBy === 'component-connections') { this.events.onError?.('自动路线控制点只读，请调整组件或 Connection。'); return false; }
		const route = this.routeOverlay.removePoint(this.selectedRouteId, this.selectedRoutePointId);
		if (!route) return false;
		this.clearRoutePointSelection();
		this.events.onRouteChange?.(cloneJson(route));
		this.events.onChanged?.();
		return true;
	}

	captureManifest(target: TwinSceneManifest): TwinSceneManifest {
		this.manifest = target;
		this.syncTransformsToManifest();
		upsertGeneratedComponentRoute(this.manifest);
		this.routeOverlay.setManifest(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		const glbObjectIds = new Set(target.objects.filter((item) => item.kind === 'model').map((item) => item.objectId));
		this.latestModelParams = this.latestModelParams.filter((item) => glbObjectIds.has(item.rootInfo.iotsharpObjectId));
		if (glbObjectIds.size === 0) {
			delete target.editorExtension;
			return target;
		}

		// three-editor 的原生快照只认识 GLB 根模型。V7 组件和程序化工程参考虽然也有 rootInfo，
		// 但没有上游模型的 globalConfig，直接参与快照会中断保存及“运行预览”切换。
		const excludedRootInfo = [...this.loadedModels.values()]
			.filter((item) => item.kind !== 'model' && item.root?.rootInfo)
			.map((item) => ({ root: item.root, rootInfo: item.root.rootInfo }));
		for (const item of excludedRootInfo) delete item.root.rootInfo;
		try {
			this.editor.saveSceneEditor();
		} finally {
			for (const item of excludedRootInfo) item.root.rootInfo = item.rootInfo;
		}
		if (this.latestModelParams.length === 0) {
			delete target.editorExtension;
			return target;
		}
		const snapshot: ThreeEditorSnapshot = {
			sceneParams: sanitizeEditorJson(cloneJson(this.latestSceneParams)) as Record<string, unknown>,
			modelParams: cloneJson(this.latestModelParams),
			upstream: { repository: 'z2586300277/threejs-editor', editorCommit, coreRepository: 'z2586300277/three-editor-cores', coreCommit, license: 'Apache-2.0' },
		};
		target.editorExtension = { source: 'threejs-editor', payloadVersion: 2, threeEditor: snapshot };
		return target;
	}

	setSelectionMode(mode: 'select' | 'root' | 'multi' | 'transform') {
		this.selectionMode = mode === 'transform' ? 'root' : mode;
		this.cancelMarqueeSelection();
		this.editor.setSceneControlMode(mode === 'select' || mode === 'multi' ? '选择' : mode === 'root' ? '根选择' : '变换');
		if (mode !== 'multi' && this.selectedObjectIds.size > 1) {
			const primary = this.selectedObjectId && this.selectedObjectIds.has(this.selectedObjectId) ? this.selectedObjectId : [...this.selectedObjectIds][0];
			this.setSelectedObjectIds(primary ? [primary] : [], primary);
		}
	}
	setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
		if (this.selectedObjectIds.size > 1 && mode !== 'translate') {
			this.events.onError?.('多选对象当前只支持整体移动；旋转和缩放请切换为单选。');
			this.editor.setTransformControlsProperty('mode', 'translate');
			return;
		}
		const selected = (this.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === this.selectedObjectId);
		if (mode === 'scale' && isComponentSceneObject(selected)) {
			this.events.onError?.('参数化组件禁止 Scale；请在 V7 属性面板修改长度、宽度和高度。');
			this.editor.setTransformControlsProperty('mode', 'translate');
			return;
		}
		this.editor.setSceneControlMode('变换'); this.editor.setTransformControlsProperty('mode', mode);
	}
	setTransformChildren(enabled: boolean) { this.editor.viewer.handler.isTransformChildren = enabled; }
	setGrid(visible: boolean) { this.editor.setOperateOption('grid', visible); this.manifest.runtime.showGrid = visible; }
	setAxes(visible: boolean) { this.editor.setOperateOption('axes', visible); }
	setKeyboard(enabled: boolean) { this.editor.setOperateOption('openKey', enabled); }
	undo() {
		const entry = this.groupMoveHistory.pop();
		if (entry) {
			this.applyWorldPositions(entry.before);
			this.groupMoveRedoHistory.push(entry);
			this.commitMovedObjectGroup();
			return;
		}
		restoreHistoryHandler('z'); this.reconcileComponentConnectionsAfterHistory();
	}
	redo() {
		const entry = this.groupMoveRedoHistory.pop();
		if (entry) {
			this.applyWorldPositions(entry.after);
			this.groupMoveHistory.push(entry);
			this.commitMovedObjectGroup();
			return;
		}
		restoreHistoryHandler('y'); this.reconcileComponentConnectionsAfterHistory();
	}

	selectObject(objectId: string, additive = false) {
		const root = this.loadedModels.get(objectId)?.root;
		if (!root) return;
		if (additive) {
			const next = new Set(this.selectedObjectIds);
			if (next.has(objectId)) next.delete(objectId);
			else next.add(objectId);
			this.setSelectedObjectIds([...next], next.has(objectId) ? objectId : [...next][0]);
			return;
		}
		this.setSelectedObjectIds([objectId], objectId, root);
	}

	focusSelected() {
		if (this.selectedRouteId && this.selectedRoutePointId) {
			const point = this.routeOverlay.getPointMesh(this.selectedRouteId, this.selectedRoutePointId);
			if (!point) return;
			const target = point.position.clone();
			const position = target.clone().add({ x: 4, y: 4, z: 4 } as any);
			this.editor.setGsapAnimation(this.editor.viewer.camera.position, position, { duration: 0.45 });
			this.editor.setGsapAnimation(this.editor.viewer.controls.target, target, { duration: 0.45 });
			return;
		}
		const roots = this.getSelectedRoots();
		if (!roots.length) return;
		if (roots.length === 1) {
			const { position, target } = this.editor.getObjectViews(roots[0]);
			this.editor.setGsapAnimation(this.editor.viewer.camera.position, position, { duration: 0.45 });
			this.editor.setGsapAnimation(this.editor.viewer.controls.target, target, { duration: 0.45 });
			return;
		}
		this.focusRoots(roots);
	}

	/** 按当前观察方向拉近或拉远，作为鼠标滚轮之外的稳定缩放入口。 */
	zoomBy(scale: number) {
		if (!Number.isFinite(scale) || scale <= 0) return;
		const camera: THREE.PerspectiveCamera = this.editor.viewer.camera;
		const controls = this.editor.viewer.controls;
		const offset = camera.position.clone().sub(controls.target);
		const currentDistance = Math.max(offset.length(), 0.001);
		const minimum = Number.isFinite(controls.minDistance) ? Math.max(0.2, controls.minDistance) : 0.5;
		const maximum = Number.isFinite(controls.maxDistance) ? Math.max(minimum + 1, controls.maxDistance) : 1000;
		const distance = THREE.MathUtils.clamp(currentDistance * scale, minimum, maximum);
		camera.position.copy(controls.target).add(offset.normalize().multiplyScalar(distance));
		controls.update?.();
		this.editor.viewer.renderScene?.();
	}

	/** 根据当前已加载设备的包围盒适配专业编辑全景。 */
	fitScene() {
		const roots = [...this.loadedModels.values()].map((item) => item.root).filter((root) => root?.visible !== false);
		if (!roots.length) return;
		const bounds = new THREE.Box3();
		for (const root of roots) bounds.expandByObject(root);
		if (bounds.isEmpty()) return;
		const center = bounds.getCenter(new THREE.Vector3());
		const size = bounds.getSize(new THREE.Vector3());
		const camera: THREE.PerspectiveCamera = this.editor.viewer.camera;
		const controls = this.editor.viewer.controls;
		const maxSize = Math.max(size.x, size.y, size.z, 1);
		const distance = Math.max(4, maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.25);
		const direction = camera.position.clone().sub(controls.target);
		if (direction.lengthSq() < 0.0001) direction.set(1, 0.75, 1);
		controls.target.copy(center);
		camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
		camera.near = Math.max(0.05, distance / 2000);
		camera.far = Math.max(1000, distance * 20);
		camera.updateProjectionMatrix();
		controls.update?.();
		this.editor.viewer.renderScene?.();
	}

	removeObject(objectId: string, notify = true) {
		const model = this.loadedModels.get(objectId);
		if (!model) return;
		this.editor.viewer.transformControls.detach();
		this.editor.setOutlinePass([]);
		model.root.parent?.remove(model.root);
		if (model.dispose) model.dispose();
		else model.root.disposeRoot?.();
		this.loadedModels.delete(objectId);
		this.latestModelParams = this.latestModelParams.filter((item) => item.rootInfo.iotsharpObjectId !== objectId);
		if (this.selectedObjectIds.delete(objectId)) {
			const remaining = [...this.selectedObjectIds];
			this.setSelectedObjectIds(remaining, remaining[0]);
		}
		if (notify) {
			upsertGeneratedComponentRoute(this.manifest);
			this.routeOverlay.rebuild(this.manifest);
			this.events.onChanged?.();
		}
	}

	private loadManifestComponents() {
		for (const object of this.manifest.objects as TwinV7SceneObjectDefinition[]) if (isComponentSceneObject(object)) this.loadComponent(object);
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
	}

	getSelectedObjectIds() { return [...this.selectedObjectIds]; }

	clearSelection() {
		this.cancelMarqueeSelection();
		this.setSelectedObjectIds([]);
	}

	private getSelectedRoots() {
		return [...this.selectedObjectIds]
			.map((objectId) => this.loadedModels.get(objectId)?.root)
			.filter(Boolean);
	}

	private captureSelectedWorldPositions() {
		const positions = new Map<string, THREE.Vector3>();
		for (const objectId of this.selectedObjectIds) {
			const root = this.loadedModels.get(objectId)?.root;
			if (!root) continue;
			root.updateMatrixWorld?.(true);
			positions.set(objectId, root.getWorldPosition(new THREE.Vector3()));
		}
		return positions;
	}

	private setRootWorldPosition(root: THREE.Object3D, worldPosition: THREE.Vector3) {
		if (root.parent) {
			root.parent.updateMatrixWorld?.(true);
			root.position.copy(root.parent.worldToLocal(worldPosition.clone()));
		} else root.position.copy(worldPosition);
		root.updateMatrixWorld?.(true);
	}

	private applyWorldPositions(positions: Map<string, THREE.Vector3>) {
		for (const [objectId, worldPosition] of positions) {
			const root = this.loadedModels.get(objectId)?.root;
			if (root) this.setRootWorldPosition(root, worldPosition);
		}
		this.positionMultiSelectionPivot();
		this.editor.viewer.renderScene?.();
	}

	private applyMultiSelectionTranslation() {
		if (!this.groupMoveSnapshot) return;
		const delta = this.multiSelectionPivot.position.clone().sub(this.groupMoveSnapshot.pivotPosition);
		for (const [objectId, startWorld] of this.groupMoveSnapshot.worldPositions) {
			const root = this.loadedModels.get(objectId)?.root;
			if (root) this.setRootWorldPosition(root, startWorld.clone().add(delta));
		}
		this.editor.viewer.renderScene?.();
	}

	private commitMovedObjectGroup() {
		this.syncTransformsToManifest();
		const removedConnectionIds = revalidateComponentConnections(this.manifest);
		upsertGeneratedComponentRoute(this.manifest);
		this.syncLoadedComponentTransformsFromManifest();
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		this.positionMultiSelectionPivot();
		if (removedConnectionIds.length) this.events.onError?.(`整体移动后已清理 ${removedConnectionIds.length} 条失效组件连接。`);
		this.events.onChanged?.();
	}

	private positionMultiSelectionPivot() {
		const roots = this.getSelectedRoots();
		if (roots.length < 2) return;
		const center = new THREE.Vector3();
		for (const root of roots) center.add(root.getWorldPosition(new THREE.Vector3()));
		center.multiplyScalar(1 / roots.length);
		this.multiSelectionPivot.position.copy(center);
		this.multiSelectionPivot.rotation.set(0, 0, 0);
		this.multiSelectionPivot.scale.set(1, 1, 1);
		this.multiSelectionPivot.updateMatrixWorld(true);
	}

	private emitPrimarySelection(objectId?: string) {
		if (!objectId) { this.events.onSelectionChange?.(null); return; }
		const root = this.loadedModels.get(objectId)?.root;
		if (!root) { this.events.onSelectionChange?.(null); return; }
		this.events.onSelectionChange?.({
			name: root.name || objectId,
			uuid: root.uuid,
			path: `${this.manifest.name}/${root.name || objectId}`,
			kind: 'scene-object',
			objectId,
		});
	}

	private setSelectedObjectIds(objectIds: string[], primaryObjectId?: string, explicitPrimaryRoot?: any) {
		const validIds = [...new Set(objectIds)].filter((objectId) => this.loadedModels.has(objectId));
		this.selectedObjectIds.clear();
		for (const objectId of validIds) this.selectedObjectIds.add(objectId);
		this.selectedObjectId = primaryObjectId && this.selectedObjectIds.has(primaryObjectId) ? primaryObjectId : validIds[0];
		this.clearRoutePointSelection(false);
		const roots = this.getSelectedRoots();
		this.editor.viewer.transformControls.detach();
		this.editor.setOutlinePass(roots);
		if (roots.length > 1) {
			this.positionMultiSelectionPivot();
			this.editor.setTransformControlsProperty('mode', 'translate');
			this.editor.viewer.transformControls.attach(this.multiSelectionPivot);
		} else if (roots.length === 1) {
			this.editor.viewer.transformControls.attach(explicitPrimaryRoot || roots[0]);
		}
		this.events.onMultiSelectionChange?.(validIds);
		this.emitPrimarySelection(this.selectedObjectId);
		this.editor.viewer.renderScene?.();
	}

	private topLevelObjectIdForNode(node: THREE.Object3D | null | undefined) {
		let current: any = node;
		while (current) {
			const objectId = current.rootInfo?.iotsharpObjectId || current.userData?.iotsharpObjectId || current.userData?.twinObjectId;
			if (objectId && this.loadedModels.has(String(objectId))) return String(objectId);
			current = current.parent;
		}
		return undefined;
	}

	private pickLoadedObjectId(clientX: number, clientY: number) {
		const rect = this.container.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return undefined;
		const pointer = new THREE.Vector2(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, this.editor.viewer.camera);
		const roots = [...this.loadedModels.values()].map((item) => item.root).filter((root) => root?.visible !== false);
		for (const hit of raycaster.intersectObjects(roots, true)) {
			const objectId = this.topLevelObjectIdForNode(hit.object);
			if (objectId) return objectId;
		}
		return undefined;
	}

	private readonly handleTransformControlsChange = () => {
		if (this.groupMoveSnapshot && this.editor.viewer.transformControls.object === this.multiSelectionPivot) this.applyMultiSelectionTranslation();
	};

	private readonly handleMarqueePointerDown = (event: PointerEvent) => {
		// 框选必须显式进入“框选多选”模式后才接管左键。
		// root/select 模式下完全放行 pointerdown，保留 three-editor 原有左键旋转/视角交互。
		if (this.disposed || event.button !== 0 || this.routeEditMode || this.selectionMode !== 'multi') return;
		if (!this.container.contains(event.target as Node)) return;
		const transform = this.editor.viewer.transformControls;
		if (transform?.dragging || transform?.axis) return;
		// Dragging starts only from empty scene space. Clicking a component keeps normal object selection/Gizmo behavior.
		if (this.pickLoadedObjectId(event.clientX, event.clientY)) return;
		const rect = this.container.getBoundingClientRect();
		this.marqueeStart = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			additive: event.ctrlKey || event.metaKey || event.shiftKey,
			baseIds: new Set(this.selectedObjectIds),
		};
		this.editor.viewer.controls.enabled = false;
		event.preventDefault();
		event.stopPropagation();
	};

	private readonly handleMarqueePointerMove = (event: PointerEvent) => {
		if (!this.marqueeStart) return;
		const viewport = this.container.getBoundingClientRect();
		const currentX = THREE.MathUtils.clamp(event.clientX - viewport.left, 0, viewport.width);
		const currentY = THREE.MathUtils.clamp(event.clientY - viewport.top, 0, viewport.height);
		const rectangle = normalizeScreenRect(this.marqueeStart.x, this.marqueeStart.y, currentX, currentY);
		this.events.onMarqueeChange?.(rectangle);
		if (rectangle.width < 3 && rectangle.height < 3) return;
		this.suppressNextClick = true;
		const hitIds: string[] = [];
		for (const [objectId, model] of this.loadedModels) {
			if (!model.root?.visible) continue;
			model.root.updateMatrixWorld?.(true);
			const bounds = new THREE.Box3().setFromObject(model.root);
			const projected = projectWorldBoundsToScreen(bounds, this.editor.viewer.camera, viewport.width, viewport.height);
			if (projected && screenRectsIntersect(rectangle, projected)) hitIds.push(objectId);
		}
		if (this.marqueeStart.additive) {
			const next = new Set(this.marqueeStart.baseIds);
			for (const objectId of hitIds) next.has(objectId) ? next.delete(objectId) : next.add(objectId);
			this.setSelectedObjectIds([...next], hitIds[0] || this.selectedObjectId);
		} else this.setSelectedObjectIds(hitIds, hitIds[0]);
		event.preventDefault();
	};

	private readonly handleMarqueePointerUp = (event: PointerEvent) => {
		if (!this.marqueeStart) return;
		const viewport = this.container.getBoundingClientRect();
		const rectangle = normalizeScreenRect(this.marqueeStart.x, this.marqueeStart.y, event.clientX - viewport.left, event.clientY - viewport.top);
		if (rectangle.width < 3 && rectangle.height < 3 && !this.marqueeStart.additive) this.setSelectedObjectIds([]);
		this.marqueeStart = undefined;
		this.editor.viewer.controls.enabled = true;
		this.events.onMarqueeChange?.(undefined);
		if (rectangle.width >= 3 || rectangle.height >= 3) {
			this.suppressNextClick = true;
			event.preventDefault();
		}
	};

	private cancelMarqueeSelection() {
		this.marqueeStart = undefined;
		if (this.editor?.viewer?.controls) this.editor.viewer.controls.enabled = true;
		this.events.onMarqueeChange?.(undefined);
	}

	private readonly handleSceneClick = (event: MouseEvent) => {
		if (this.disposed || event.defaultPrevented) return;
		if (this.suppressNextClick) { this.suppressNextClick = false; return; }
		if (this.routeEditMode) {
			const hit = this.routeOverlay.pickPoint(event, this.editor.viewer.camera, this.container);
			if (hit?.pointId && hit.routeId) {
				this.selectRoutePoint(hit.routeId, hit.pointId);
				return;
			}
			if (this.routeDrawMode) {
				const worldPoint = this.routeOverlay.worldPointFromEvent(event, this.editor.viewer.camera, this.container, this.routeOverlay.getPreferredDrawHeight());
				if (worldPoint) {
					this.addRoutePoint([worldPoint.x, worldPoint.y, worldPoint.z]);
					return;
				}
			}
		}
		try {
			this.editor.getSceneEvent(event, (info: any) => {
				let root = info?.currentModel;
				while (root && !root?.rootInfo?.iotsharpObjectId && !root?.userData?.iotsharpObjectId) root = root.parent;
				root ||= info?.currentRootModel;
				if (root?.rootInfo?.iotsharpObjectId || root?.userData?.iotsharpObjectId) this.selectRoot(root, info.currentModel, event.ctrlKey || event.metaKey || event.shiftKey);
			});
		} catch {
			this.events.onError?.('threejs-editor 未能选中该对象，请切换“根选择”后重试。');
		}
	};

	private selectRoutePoint(routeId: string, pointId: string) {
		const mesh = this.routeOverlay.getPointMesh(routeId, pointId);
		if (!mesh) return;
		this.selectedObjectId = undefined;
		this.selectedRouteId = routeId;
		this.selectedRoutePointId = pointId;
		this.routeOverlay.setSelectedPoint(routeId, pointId);
		this.editor.setOutlinePass([]);
		const route = this.manifest.routes.find((candidate) => candidate.routeId === routeId);
		const index = route?.points.findIndex((point) => point.pointId === pointId) ?? -1;
		const point = route?.points[index];
		if (!point || !route) return;
		if (route.generatedBy === 'component-connections') {
			this.editor.viewer.transformControls.detach();
			this.events.onError?.('该路线由组件连接自动生成，只能通过移动组件或修改 Connection 调整。');
		} else this.editor.viewer.transformControls.attach(mesh);
		this.events.onSelectionChange?.({
			name: point.name,
			uuid: mesh.uuid,
			path: `${this.manifest.name}/${route.name}/${point.name}`,
			kind: 'route-point',
			routeId: route.routeId,
			routePointIndex: index,
			routePointId: point.pointId,
		});
	}

	private clearRoutePointSelection(detach = true) {
		if (!this.selectedRoutePointId) return;
		this.selectedRouteId = undefined;
		this.selectedRoutePointId = undefined;
		this.routeOverlay.setSelectedPoint(undefined, undefined);
		if (detach) this.editor.viewer.transformControls.detach();
	}

	private selectRoot(root: any, node = root, additive = false) {
		const objectId = root.rootInfo?.iotsharpObjectId || root.userData?.iotsharpObjectId;
		if (!objectId) return;
		this.clearRoutePointSelection(false);
		if (additive) {
			const next = new Set(this.selectedObjectIds);
			if (next.has(objectId)) next.delete(objectId); else next.add(objectId);
			this.setSelectedObjectIds([...next], next.has(objectId) ? objectId : [...next][0]);
			if (!next.has(objectId)) return;
		} else this.setSelectedObjectIds([objectId], objectId, root);
		const segments: string[] = [];
		let current = node;
		while (current && current !== root) {
			const index = current.parent?.children?.indexOf(current) ?? -1;
			segments.unshift(current.name || `${current.type}[${index}]`);
			current = current.parent;
		}
		const equipmentInfo = this.getEquipmentInfo(node, root, segments);
		this.events.onSelectionChange?.({
			name: node.name || root.name || '未命名对象',
			uuid: node.uuid,
			path: `${this.manifest.name}/${root.name || objectId}`,
			kind: 'scene-object',
			objectId,
			nodePath: segments.join('/'),
			equipmentType: equipmentInfo?.equipmentType,
			equipmentId: equipmentInfo?.equipmentId,
		});
	}

	private getEquipmentInfo(node: any, root: any, segments: string[]): { equipmentType: string; equipmentId?: string } | undefined {
		let current = node;
		while (current) {
			const equipmentType = current.userData?.twinEquipmentType || current.userData?.equipmentType;
			if (equipmentType) {
				const equipmentId = current.userData?.twinEquipmentId || current.userData?.equipmentId;
				return { equipmentType: String(equipmentType), equipmentId: equipmentId ? String(equipmentId) : undefined };
			}
			if (current === root) break;
			current = current.parent;
		}
		const semanticName = `${node?.name || ''} ${segments.join('/')}`.toLocaleLowerCase();
		if (/motor|drive[_ -]?motor|电机|马达|减速机/.test(semanticName)) return { equipmentType: 'motor' };
		return undefined;
	}

	private syncLoadedComponentTransformsFromManifest() {
		for (const object of this.manifest.objects as TwinV7SceneObjectDefinition[]) {
			if (!isComponentSceneObject(object)) continue;
			const root = this.loadedModels.get(object.objectId)?.root;
			if (!root) continue;
			root.position.set(...object.transform.position);
			root.rotation.set(...object.transform.rotation);
			root.scale.set(1, 1, 1);
			root.updateMatrixWorld?.(true);
		}
		this.editor.viewer.renderScene?.();
	}

	private syncTransformsToManifest() {
		for (const object of this.manifest.objects as TwinV7SceneObjectDefinition[]) {
			const root = this.loadedModels.get(object.objectId)?.root;
			if (!root) continue;
			object.name = root.name || object.name;
			object.transform.position = [root.position.x, root.position.y, root.position.z];
			object.transform.rotation = [root.rotation.x, root.rotation.y, root.rotation.z];
			if (isComponentSceneObject(object)) {
				root.scale.set(1, 1, 1);
				object.transform.scale = [1, 1, 1];
			} else object.transform.scale = [root.scale.x, root.scale.y, root.scale.z];
		}
	}

	private reconcileComponentConnectionsAfterHistory() {
		this.syncTransformsToManifest();
		const removedConnectionIds = revalidateComponentConnections(this.manifest);
		upsertGeneratedComponentRoute(this.manifest);
		this.syncLoadedComponentTransformsFromManifest();
		this.routeOverlay.rebuild(this.manifest);
		this.engineeringOverlay.rebuild(this.manifest);
		if (removedConnectionIds.length > 0) {
			this.events.onError?.(`撤销/重做后已清理 ${removedConnectionIds.length} 条失效组件连接。`);
		}
		this.events.onChanged?.();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelMarqueeSelection();
		this.container.removeEventListener('click', this.handleSceneClick);
		this.container.removeEventListener('pointerdown', this.handleMarqueePointerDown, true);
		window.removeEventListener('pointermove', this.handleMarqueePointerMove, true);
		window.removeEventListener('pointerup', this.handleMarqueePointerUp, true);
		this.editor?.viewer?.transformControls?.removeEventListener?.('change', this.handleTransformControlsChange);
		this.resizeObserver.disconnect();
		this.routeOverlay.dispose();
		this.engineeringOverlay.dispose();
		this.multiSelectionPivot.parent?.remove(this.multiSelectionPivot);
		for (const model of this.loadedModels.values()) model.dispose?.();
		this.editor?.viewer?.destroySceneRender?.();
		for (const objectUrl of this.objectUrls) URL.revokeObjectURL(objectUrl);
		this.objectUrls.clear(); this.loadedModels.clear(); this.editor = undefined;
	}
}
