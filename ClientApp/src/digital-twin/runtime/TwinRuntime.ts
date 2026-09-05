import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TwinDataUpdate } from '/@/api/digital-twin';
import { BindingEngine } from '/@/digital-twin/bindings/BindingEngine';
import { createRouteEdge, createRoutePoint, normalizeTwinRoute, type TwinRouteDefinition, type TwinSceneManifest, type TwinSceneObjectDefinition, type TwinVector3 } from '/@/digital-twin/contracts';
import { RouteEngine, type TwinRouteEngineSnapshot, type TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';
import { ProceduralPackagingLine } from '/@/digital-twin/runtime/ProceduralPackagingLine';
import { upgradeSilkPackagingLayout } from '/@/digital-twin/runtime/SilkPackagingLayoutMigration';
import { upgradeReferencePackagingLineLayout } from '/@/digital-twin/presets/ReferencePackagingLineManifest';
import { TwinMaterialFlowRuntime } from '/@/digital-twin/runtime/TwinMaterialFlowRuntime';
import { RouteSlotArrayRuntime } from '/@/digital-twin/runtime/RouteSlotArrayRuntime';
import { ComponentProcessRuntime } from '/@/digital-twin/runtime/ComponentProcessRuntime';
import { BehaviorRuntime } from '/@/digital-twin/runtime/BehaviorRuntime';
import { advanceComponentVisualRuntime } from '/@/digital-twin/components/ComponentVisualRuntime';
import { createComponentDefinitionFromTemplate, defaultComponentRegistry, hasCompleteSilkV7Infrastructure, hasSilkV7Infrastructure, migrateSilkLineInfrastructureToV7, resolveComponentInternalFlows, type TwinComponentDefinition } from '/@/digital-twin/components';

export interface TwinSelectionInfo {
	name: string;
	uuid: string;
	path: string;
	kind: 'scene-object' | 'route-point' | 'runtime-entity';
	objectId?: string;
	nodePath?: string;
	entityType?: string;
	entityId?: string;
	equipmentType?: string;
	equipmentId?: string;
	runtimeData?: Record<string, unknown>;
	routeId?: string;
	routePointIndex?: number;
	routePointId?: string;
	worldPosition?: TwinVector3;
}

export interface TwinRuntimeOptions {
	readOnly?: boolean;
}

export const resolveRouteTransportUnitResourceKey = (route: TwinRouteDefinition) => {
	const edge = route.edges.find((candidate) => candidate.enabled !== false && (candidate.transportUnitResourceKey || candidate.transportUnitType));
	if (edge?.transportUnitResourceKey) return edge.transportUnitResourceKey;
	const unitType = edge?.transportUnitType || 'plastic-pallet';
	return unitType === 'carton' ? 'builtin-carton' : unitType === 'wooden-pallet' ? 'builtin-wooden-pallet' : 'builtin-plastic-pallet';
};


export interface TwinRuntimeScreenAnchor {
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
	worldPosition: TwinVector3;
}

export interface TwinModelSummary {
	fileName: string;
	meshCount: number;
	triangleCount: number;
	nodeCount: number;
	animationCount: number;
}

export interface TwinRuntimeMetrics extends TwinRouteEngineSnapshot {
	fps: number;
	drawCalls: number;
	triangles: number;
	geometries: number;
	textures: number;
	silkLine?: {
		onlinePallets: number;
		loadedPallets: number;
		emptyPallets: number;
		waitingPallets: number;
		cartRemaining: number;
		robotState: string;
		gantryState: string;
		inspectionState: string;
		inspectionPassed: number;
		inspectionNg: number;
		inspectionProgress: number;
		baggingState: string;
		baggingCompleted: number;
		baggingProgress: number;
		stackOccupied: number;
		stackCapacity: number;
		blockedSections: number;
		cartSide: string;
		cartRow: number;
		cartCapacity: number;
		robotBatchSize: number;
		emptyBypassCount: number;
		loadingBufferReady: number;
		gantryLaneA: number;
		gantryLaneB: number;
		woodenPalletLayer: number;
		woodenPalletLayers: number;
		woodenPalletCakes: number;
		woodenPalletCapacity: number;
		coveredPackages: number;
		labeledPackages: number;
		wrappedPackages: number;
		storedPackages: number;
		woodenPalletStage: string;
	};
}

export interface TwinRuntimeEvents {
	onSelectionChange?: (selection: TwinSelectionInfo | null) => void;
	onRouteChange?: (route: TwinRouteDefinition) => void;
	onModelLoaded?: (summary: TwinModelSummary) => void;
	onMetrics?: (metrics: TwinRuntimeMetrics) => void;
	onError?: (message: string) => void;
}

const helperFlag = 'iotsharpTwinHelper';

interface TwinRouteDistanceCurveInfo {
	route: TwinRouteDefinition;
	curve: THREE.Curve<THREE.Vector3>;
	lengthMeters: number;
	loop: boolean;
}

/**
 * IoTSharp 数字孪生 Phase 0 运行时。
 * 编辑器页面只能通过适配器调用本类，后续接入 threejs-editor 时保持运行边界不变。
 */
export class TwinRuntime {
	private readonly container: HTMLDivElement;
	private readonly events: TwinRuntimeEvents;
	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
	private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
	private readonly orbitControls: any;
	private readonly transformControls: any;
	private readonly raycaster = new THREE.Raycaster();
	private readonly pointer = new THREE.Vector2();
	private readonly resizeObserver: ResizeObserver;
	private readonly loader = new GLTFLoader();
	private readonly fixedStep = 1 / 30;
	private readonly routePointGroup = new THREE.Group();
	private readonly routeEdgeGroup = new THREE.Group();
	private readonly routeLineMaterial = new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.95 });
	private readonly movingObject = new THREE.Group();
	private readonly pointerDown = new THREE.Vector2();
	private manifest: TwinSceneManifest;
	private readonly objectIndex = new Map<string, any>();
	private readonly loadedModels = new Map<string, any>();
	private readonly componentModels = new Map<string, { root: THREE.Group; dispose: () => void }>();
	private readonly proceduralComponentAnimationBases = new Map<string, Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>>();
	private readonly routeDistanceCurves = new Map<string, TwinRouteDistanceCurveInfo>();
	private readonly bindingEngine: BindingEngine;
	private route: TwinRouteDefinition;
	private routeEngine: RouteEngine;
	private readonly materialFlowRuntime: TwinMaterialFlowRuntime;
	private readonly routeSlotArrayRuntime: RouteSlotArrayRuntime;
	private packagingLine?: ProceduralPackagingLine;
	private componentProcessRuntime?: ComponentProcessRuntime;
	private behaviorRuntime?: BehaviorRuntime;
	private runtimeRunning = false;
	private componentTestObjectId?: string;
	private componentTestPath: THREE.Vector3[] = [];
	private componentTestDistance = 0;
	private componentTestElapsed = 0;
	private componentTestMarker?: THREE.Mesh;
	private routeLine?: any;
	private ground?: any;
	private selectionHelper?: any;
	private selectedRoutePointIndex: number | null = null;
	private animationFrame = 0;
	private lastFrameAt = performance.now();
	private accumulator = 0;
	private frameCounter = 0;
	private metricsStartedAt = performance.now();
	private routeDrawMode = false;
	private routingContext: TwinRouteRoutingContext = { payload: {}, bindingValues: {}, edgeOccupancy: {}, staleBindingIds: [] };
	private transformDragging = false;
	private disposed = false;
	private readonly readOnly: boolean;

	constructor(container: HTMLDivElement, manifest: TwinSceneManifest, events: TwinRuntimeEvents = {}, options: TwinRuntimeOptions = {}) {
		this.container = container;
		this.events = events;
		this.readOnly = options.readOnly === true;
		this.manifest = structuredClone(manifest);
		upgradeReferencePackagingLineLayout(this.manifest);
		upgradeSilkPackagingLayout(this.manifest);
		migrateSilkLineInfrastructureToV7(this.manifest);
		this.route = normalizeTwinRoute(structuredClone(this.manifest.routes[0]));
		this.routeEngine = new RouteEngine(this.route, this.movingObject);
		this.materialFlowRuntime = new TwinMaterialFlowRuntime(this.route);
		this.routeSlotArrayRuntime = new RouteSlotArrayRuntime(this.scene, this.manifest, (message) => this.events.onError?.(message));
		this.rebuildRouteDistanceCurves();
		this.bindingEngine = new BindingEngine(
			this.manifest,
			(objectId) => this.objectIndex.get(objectId),
			(progress) => this.routeEngine.correctDistance(Math.min(1, Math.max(0, progress)) * this.routeEngine.getSnapshot().lengthMeters),
			(message) => this.events.onError?.(message),
			(bindingId, value, stale) => this.applyRouteSignal(bindingId, value, stale),
			(binding, value, stale) => this.routeSlotArrayRuntime.apply(binding, value, stale),
			(binding, object, distanceMeters) => this.applyRouteDistance(binding, object, distanceMeters),
		);

		this.scene.background = new THREE.Color(manifest.world.background);
		const isSilkCakeLine = manifest.objects.some((item) => ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
		const isLargeComponentScene = manifest.objects.filter((item: any) => item.kind === 'component').length >= 16;
		this.camera.position.set(...(isSilkCakeLine ? [32, 26, 38] as const : isLargeComponentScene ? [28, 32, 38] as const : [11, 9, 13] as const));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, manifest.runtime.maxPixelRatio));
		this.renderer.domElement.className = 'twin-runtime-canvas';
		this.container.appendChild(this.renderer.domElement);

		this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
		this.orbitControls.enableDamping = true;
		this.orbitControls.target.set(...(isSilkCakeLine ? [5, 1.2, -2] as const : isLargeComponentScene ? [0, 1, 2] as const : [0, 0.8, 0] as const));
		this.orbitControls.maxPolarAngle = Math.PI * 0.49;
		this.orbitControls.minDistance = 2;
		this.orbitControls.maxDistance = isLargeComponentScene ? 120 : 80;

		this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
		this.transformControls.setMode('translate');
		this.transformControls.setSpace('world');
		this.transformControls.enabled = !this.readOnly;
		this.transformControls.addEventListener('dragging-changed', (event: any) => {
			this.transformDragging = Boolean(event.value);
			this.orbitControls.enabled = !event.value;
		});
		this.transformControls.addEventListener('objectChange', () => this.commitSelectedRoutePoint());
		this.scene.add(this.transformControls);

		this.routePointGroup.name = '路线控制点';
		this.routePointGroup.userData[helperFlag] = true;
		this.scene.add(this.routePointGroup);
		this.routeEdgeGroup.name = '路线图连线';
		this.routeEdgeGroup.userData[helperFlag] = true;
		this.scene.add(this.routeEdgeGroup);

		this.createEnvironment(manifest.runtime.showGrid);
		this.createProceduralConveyor();
		this.rebuildComponents();
		this.createMovingObject();
		this.rebuildRouteVisuals();

		this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
		this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.container);
		this.resize();
		this.animationFrame = requestAnimationFrame(this.animate);
	}

	setRunning(running: boolean) {
		this.runtimeRunning = running;
		if (this.componentTestObjectId) {
			this.componentProcessRuntime?.setRunning(false);
			this.routeEngine.setRunning(false);
			this.packagingLine?.setRunning(false);
			this.behaviorRuntime?.setRunning(running);
			return;
		}
		if (this.componentProcessRuntime) this.componentProcessRuntime.setRunning(running);
		else this.routeEngine.setRunning(running);
		this.packagingLine?.setRunning(running);
		this.behaviorRuntime?.setRunning(running);
	}

	setComponentTestObject(objectId?: string) {
		this.componentTestObjectId = objectId?.trim() || undefined;
		this.behaviorRuntime?.setActorFilter(this.componentTestObjectId);
		this.clearComponentTestMarker();
		if (this.componentTestObjectId) {
			this.componentProcessRuntime?.setRunning(false);
			this.routeEngine.setRunning(false);
			this.packagingLine?.setRunning(false);
			this.behaviorRuntime?.reset();
			this.behaviorRuntime?.setRunning(this.runtimeRunning);
			this.buildComponentTestPath(this.componentTestObjectId);
			return;
		}
		this.behaviorRuntime?.reset();
		this.behaviorRuntime?.setRunning(this.runtimeRunning);
		if (this.componentProcessRuntime) this.componentProcessRuntime.setRunning(this.runtimeRunning);
		else this.routeEngine.setRunning(this.runtimeRunning);
		this.packagingLine?.setRunning(this.runtimeRunning);
	}

	resetComponentTest() {
		this.behaviorRuntime?.reset();
		this.componentTestDistance = 0;
		this.componentTestElapsed = 0;
		if (this.componentTestMarker && this.componentTestPath.length) this.componentTestMarker.position.copy(this.componentTestPath[0]);
		if (this.componentTestObjectId) this.setOutputStopperVisual(this.objectIndex.get(this.componentTestObjectId), true, false);
	}

	setSpeed(speed: number) {
		this.route.defaultSpeed = speed;
		this.routeEngine.setSpeed(speed);
		this.packagingLine?.setSpeed(speed);
		this.emitRouteChange();
	}

	resetRoute() {
		this.routeEngine.reset();
		this.componentProcessRuntime?.reset();
		this.packagingLine?.reset();
		this.behaviorRuntime?.reset();
	}

	correctRouteDistance(distanceMeters: number) {
		this.routeEngine.correctDistance(distanceMeters);
	}

	setRouteDrawMode(enabled: boolean) {
		if (this.readOnly) {
			this.routeDrawMode = false;
			this.clearSelection();
			return;
		}
		this.routeDrawMode = enabled;
		if (enabled) this.clearSelection();
	}

	setRouteCurveKind(curveKind: TwinRouteDefinition['curveKind']) {
		if (this.readOnly) return;
		this.route.curveKind = curveKind;
		this.applyRouteChange();
	}

	setRouteLoop(loop: boolean) {
		if (this.readOnly) return;
		this.route.loop = loop;
		this.applyRouteChange();
	}

	updateRoutePoint(index: number, position: TwinVector3) {
		if (this.readOnly) return;
		const point = this.route.points[index];
		if (!point || position.some((component) => !Number.isFinite(component))) return;
		point.position = [...position] as TwinVector3;
		this.applyRouteChange();
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(structuredClone(route));
		this.materialFlowRuntime.setRoute(this.route);
		this.applyRouteChange();
	}

	setRouteRoutingContext(context: TwinRouteRoutingContext) {
		this.routingContext = {
			payload: { ...(context.payload || {}) },
			bindingValues: { ...(this.routingContext.bindingValues || {}), ...(context.bindingValues || {}) },
			edgeOccupancy: { ...(context.edgeOccupancy || {}) },
			staleBindingIds: [...(context.staleBindingIds || this.routingContext.staleBindingIds || [])],
		};
		this.materialFlowRuntime.applyRoutingContext(this.routingContext);
		this.packagingLine?.setRoutingContext(this.routingContext);
		this.routeEngine.setRoutingContext(this.routingContext);
		this.rebuildRouteLines();
	}

	addRoutePoint(position?: TwinVector3) {
		if (this.readOnly) return;
		const lastPoint = this.route.points[this.route.points.length - 1]?.position ?? [0, 0.72, 0];
		const nextPosition = position ?? [lastPoint[0] + 2, lastPoint[1], lastPoint[2]];
		const previousPoint = this.route.points[this.route.points.length - 1];
		const point = createRoutePoint([...nextPosition] as TwinVector3, this.route.points.length);
		this.route.points.push(point);
		if (previousPoint) {
			const edges = (this.route.edges ||= []);
			edges.push(createRouteEdge(previousPoint.pointId, point.pointId, edges.length));
		}
		this.applyRouteChange();
	}

	removeRoutePoint(index: number) {
		if (this.readOnly) return;
		if (this.route.points.length <= 2 || index < 0 || index >= this.route.points.length) return;
		const [removed] = this.route.points.splice(index, 1);
		if (removed) {
			const removedEdgeIds = new Set((this.route.edges || []).filter((edge) => edge.fromPointId === removed.pointId || edge.toPointId === removed.pointId).map((edge) => edge.edgeId));
			this.route.edges = (this.route.edges || []).filter((edge) => !removedEdgeIds.has(edge.edgeId));
			this.route.decisionRules = (this.route.decisionRules || []).filter((rule) => rule.junctionPointId !== removed.pointId && !removedEdgeIds.has(rule.edgeId));
			if (this.route.startPointId === removed.pointId) this.route.startPointId = this.route.points[0]?.pointId;
			for (const [pointId, edgeId] of Object.entries(this.route.junctionDecisions || {})) {
				if (pointId === removed.pointId || removedEdgeIds.has(edgeId)) delete this.route.junctionDecisions?.[pointId];
			}
			const incidentCounts = new Map<string, number>();
			for (const edge of (this.route.edges || []).filter((item) => item.enabled !== false)) {
				incidentCounts.set(edge.fromPointId, (incidentCounts.get(edge.fromPointId) || 0) + 1);
				incidentCounts.set(edge.toPointId, (incidentCounts.get(edge.toPointId) || 0) + 1);
			}
			for (const point of this.route.points) {
				if (point.kind === 'junction' && (incidentCounts.get(point.pointId) || 0) < 3) {
					point.kind = 'waypoint';
					delete this.route.junctionDecisions?.[point.pointId];
				}
			}
		}
		this.clearSelection();
		this.applyRouteChange();
	}

	loadManifest(manifest: TwinSceneManifest) {
		if (!manifest.routes[0]) return;
		this.manifest = structuredClone(manifest);
		upgradeReferencePackagingLineLayout(this.manifest);
		upgradeSilkPackagingLayout(this.manifest);
		migrateSilkLineInfrastructureToV7(this.manifest);
		this.route = normalizeTwinRoute(structuredClone(this.manifest.routes[0]));
		this.scene.background = new THREE.Color(this.manifest.world.background);
		this.bindingEngine.setManifest(this.manifest);
		this.routeSlotArrayRuntime.setManifest(this.manifest);
		this.rebuildRouteDistanceCurves();
		const routeBindingIds = new Set(this.manifest.bindings.filter((binding) => binding.enabled !== false && binding.transform.kind === 'routeEvent').map((binding) => binding.bindingId));
		this.routingContext = {
			...this.routingContext,
			bindingValues: Object.fromEntries(Object.entries(this.routingContext.bindingValues || {}).filter(([bindingId]) => routeBindingIds.has(bindingId))),
			staleBindingIds: (this.routingContext.staleBindingIds || []).filter((bindingId) => routeBindingIds.has(bindingId)),
		};
		this.routeEngine.setRoutingContext(this.routingContext);
		for (const objectDefinition of this.manifest.objects) {
			const object = this.objectIndex.get(objectDefinition.objectId);
			if (object) this.applyTransform(object, objectDefinition);
		}
		this.rebuildComponents();
		this.applyRouteChange();
	}

	getRoute(): TwinRouteDefinition {
		return structuredClone(this.route);
	}

	getMaterialFlowSnapshot() {
		return {
			sections: this.materialFlowRuntime.sections.getSnapshots(),
			entities: this.materialFlowRuntime.entities.getAll(),
			silkCakeLine: this.packagingLine?.getSnapshot(),
			componentProcesses: this.componentProcessRuntime?.getSnapshot(),
			behaviors: this.behaviorRuntime?.getSnapshot(),
		};
	}

	async loadLocalGlb(file: File): Promise<TwinModelSummary> {
		if (!file.name.toLowerCase().endsWith('.glb')) throw new Error('Phase 0 仅支持单文件 GLB。');
		const localObjectId = this.manifest.objects.find((item) => item.kind === 'model')?.objectId ?? `local-${file.name}`;
		return this.loadGlbBuffer(localObjectId, file.name, await file.arrayBuffer());
	}

	/** 从鉴权后的 IoTSharp 模型资源接口加载 GLB，避免把租户 Token 暴露给 Three.js URLLoader。 */
	async loadGlbBuffer(objectId: string, fileName: string, buffer: ArrayBuffer): Promise<TwinModelSummary> {
		const gltf = await this.loader.parseAsync(buffer, '');
		const previous = this.loadedModels.get(objectId);
		if (previous) {
			this.scene.remove(previous);
			this.disposeObject(previous);
		}
		const model = gltf.scene;
		const definition = this.manifest.objects.find((item) => item.objectId === objectId);
		model.name = definition?.name || fileName;
		model.userData.twinObjectId = objectId;
		if (definition) this.applyTransform(model, definition);
		let meshCount = 0;
		let triangleCount = 0;
		let nodeCount = 0;
		model.traverse((object: any) => {
			nodeCount += 1;
			if (!object.isMesh) return;
			meshCount += 1;
			object.castShadow = true;
			object.receiveShadow = true;
			const geometry = object.geometry;
			triangleCount += geometry?.index ? geometry.index.count / 3 : (geometry?.attributes?.position?.count ?? 0) / 3;
		});
		this.loadedModels.set(objectId, model);
		this.objectIndex.set(objectId, model);
		this.scene.add(model);
		this.focusObject(model);
		const summary = { fileName, meshCount, triangleCount: Math.round(triangleCount), nodeCount, animationCount: gltf.animations?.length ?? 0 };
		this.events.onModelLoaded?.(summary);
		return summary;
	}

	applyDataUpdates(updates: TwinDataUpdate[]) {
		this.bindingEngine.apply(updates);
		this.behaviorRuntime?.setBindingContext(this.bindingEngine.getSignalSnapshot());
		this.syncOutputStopperBindings();
	}

	getSelectionScreenAnchor(): TwinRuntimeScreenAnchor | undefined {
		const selectedObject = this.selectionHelper?.object as THREE.Object3D | undefined;
		if (!selectedObject || this.disposed) return undefined;
		selectedObject.updateWorldMatrix(true, true);
		this.camera.updateMatrixWorld(true);
		const box = new THREE.Box3().setFromObject(selectedObject);
		const world = new THREE.Vector3();
		const objectWorld = new THREE.Vector3();
		selectedObject.getWorldPosition(objectWorld);
		if (box.isEmpty()) world.copy(objectWorld);
		else {
			box.getCenter(world);
			world.y = box.max.y;
		}
		const projected = world.clone().project(this.camera);
		const width = this.renderer.domElement.clientWidth || this.container.clientWidth || 1;
		const height = this.renderer.domElement.clientHeight || this.container.clientHeight || 1;
		return {
			x: (projected.x * 0.5 + 0.5) * width,
			y: (-projected.y * 0.5 + 0.5) * height,
			width,
			height,
			visible: projected.z >= -1 && projected.z <= 1 && projected.x >= -1.2 && projected.x <= 1.2 && projected.y >= -1.2 && projected.y <= 1.2,
			worldPosition: [objectWorld.x, objectWorld.y, objectWorld.z],
		};
	}

	focusSelected() {
		const selectedObject = this.selectionHelper?.object;
		if (selectedObject) this.focusObject(selectedObject);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		cancelAnimationFrame(this.animationFrame);
		this.resizeObserver.disconnect();
		this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
		this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
		this.transformControls.detach();
		this.transformControls.dispose?.();
		this.scene.remove(this.transformControls);
		this.orbitControls.dispose();
		this.bindingEngine.dispose();
		this.routeSlotArrayRuntime.dispose();
		this.behaviorRuntime?.dispose();
		this.behaviorRuntime = undefined;
		this.componentProcessRuntime?.dispose();
		this.componentProcessRuntime = undefined;
		for (const component of this.componentModels.values()) { this.scene.remove(component.root); component.dispose(); }
		this.componentModels.clear();
		this.objectIndex.clear();
		this.loadedModels.clear();
		this.scene.traverse((object: any) => {
			this.disposeRenderable(object);
		});
		this.routeLineMaterial.dispose();
		this.renderer.renderLists.dispose();
		this.renderer.dispose();
		this.renderer.forceContextLoss?.();
		this.renderer.domElement.remove();
	}

	private readonly animate = (now: number) => {
		if (this.disposed) return;
		const deltaSeconds = Math.min(0.25, Math.max(0, (now - this.lastFrameAt) / 1000));
		this.lastFrameAt = now;
		this.accumulator += deltaSeconds;
		while (this.accumulator >= this.fixedStep) {
			this.bindingEngine.tick(this.fixedStep);
			this.routeSlotArrayRuntime.tick(this.fixedStep);
			const allowRouteStep = this.componentProcessRuntime?.updateFixed(this.fixedStep) ?? true;
			if (allowRouteStep) this.routeEngine.updateFixed(this.fixedStep);
			this.packagingLine?.updateFixed(this.fixedStep);
			this.behaviorRuntime?.updateFixed(this.fixedStep);
			this.syncProceduralProcessComponentAnimations();
			this.accumulator -= this.fixedStep;
		}
		if (this.runtimeRunning) advanceComponentVisualRuntime(this.scene, deltaSeconds, 1);
		if (this.runtimeRunning && this.componentTestObjectId) this.advanceComponentTestPath(deltaSeconds);
		this.routeEngine.render(this.accumulator / this.fixedStep);
		this.orbitControls.update();
		this.renderer.render(this.scene, this.camera);
		this.frameCounter += 1;
		if (now - this.metricsStartedAt >= 500) {
			const elapsedSeconds = (now - this.metricsStartedAt) / 1000;
			const memory = this.renderer.info.memory;
			const render = this.renderer.info.render;
			const silkSnapshot = this.packagingLine?.getSnapshot();
			this.events.onMetrics?.({
				...this.routeEngine.getSnapshot(),
				fps: Math.round(this.frameCounter / elapsedSeconds),
				drawCalls: render.calls,
				triangles: render.triangles,
				geometries: memory.geometries,
				textures: memory.textures,
				silkLine: silkSnapshot ? {
					onlinePallets: silkSnapshot.plasticPallets.total - silkSnapshot.plasticPallets.sourceQueue,
					loadedPallets: silkSnapshot.plasticPallets.loaded,
					emptyPallets: silkSnapshot.plasticPallets.empty,
					waitingPallets: silkSnapshot.plasticPallets.waiting,
					cartRemaining: silkSnapshot.silkCart.remaining,
					robotState: silkSnapshot.robot.state,
					gantryState: silkSnapshot.gantry.state,
					inspectionState: silkSnapshot.preProcess.inspection.state,
					inspectionPassed: silkSnapshot.preProcess.inspection.passed,
					inspectionNg: silkSnapshot.preProcess.inspection.ng,
					inspectionProgress: silkSnapshot.preProcess.inspection.progress,
					baggingState: silkSnapshot.preProcess.bagging.state,
					baggingCompleted: silkSnapshot.preProcess.bagging.completed,
					baggingProgress: silkSnapshot.preProcess.bagging.progress,
					stackOccupied: silkSnapshot.woodenPallet.silkCakeCount,
					stackCapacity: silkSnapshot.woodenPallet.maxSilkCakeCount,
					blockedSections: silkSnapshot.sections.filter((section) => section.state !== 'available').length,
					cartSide: silkSnapshot.silkCart.activeSide,
					cartRow: silkSnapshot.silkCart.currentRow,
					cartCapacity: silkSnapshot.silkCart.capacity,
					robotBatchSize: silkSnapshot.robot.batchSize,
					emptyBypassCount: silkSnapshot.preProcess.emptyBypassCount,
					loadingBufferReady: silkSnapshot.robot.emptyPalletsReady,
					gantryLaneA: silkSnapshot.gantry.laneA,
					gantryLaneB: silkSnapshot.gantry.laneB,
					woodenPalletLayer: silkSnapshot.woodenPallet.layer,
					woodenPalletLayers: silkSnapshot.woodenPallet.maxLayers,
					woodenPalletCakes: silkSnapshot.woodenPallet.silkCakeCount,
					woodenPalletCapacity: silkSnapshot.woodenPallet.maxSilkCakeCount,
					coveredPackages: silkSnapshot.postProcess.covered,
					labeledPackages: silkSnapshot.postProcess.labeled,
					wrappedPackages: silkSnapshot.postProcess.wrapped,
					storedPackages: silkSnapshot.postProcess.stored,
					woodenPalletStage: silkSnapshot.woodenPallet.stage || 'waiting-source',
				} : undefined,
			});
			this.frameCounter = 0;
			this.metricsStartedAt = now;
		}
		this.animationFrame = requestAnimationFrame(this.animate);
	};

	private createEnvironment(showGrid: boolean) {
		const hemisphere = new THREE.HemisphereLight(0xc7e7ff, 0x102033, 2.1);
		this.scene.add(hemisphere);
		const directional = new THREE.DirectionalLight(0xffffff, 3.2);
		directional.position.set(7, 12, 6);
		directional.castShadow = true;
		directional.shadow.mapSize.set(2048, 2048);
		this.scene.add(directional);

		const hasLargeComponentLayout = this.manifest.objects.filter((item: any) => item.kind === 'component').length >= 16;
		const environmentSize = this.manifest.objects.some((item) => ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || '')) ? 80 : hasLargeComponentLayout ? 64 : 40;
		if (showGrid) {
			const grid = new THREE.GridHelper(environmentSize, environmentSize, 0x1d4ed8, 0x1f3a55);
			grid.userData[helperFlag] = true;
			this.scene.add(grid);
		}

		const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x081525, roughness: 0.92, metalness: 0.02, transparent: true, opacity: 0.88 });
		this.ground = new THREE.Mesh(new THREE.PlaneGeometry(environmentSize, environmentSize), groundMaterial);
		this.ground.name = '路线绘制平面';
		this.ground.rotation.x = -Math.PI / 2;
		this.ground.position.y = -0.02;
		this.ground.receiveShadow = true;
		this.ground.userData[helperFlag] = true;
		this.scene.add(this.ground);
	}

	private createProceduralConveyor() {
		const silkLineDefinition = this.manifest.objects.find((item) => item.kind === 'procedural' && ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || ''));
		if (silkLineDefinition) {
			const palletCount = silkLineDefinition.procedural?.palletCount ?? this.manifest.runtime.silkLineSimulation?.palletCount ?? 50;
			const hasV7Infrastructure = hasSilkV7Infrastructure(this.manifest);
			const hasCompleteV7Infrastructure = hasCompleteSilkV7Infrastructure(this.manifest);
			this.packagingLine = new ProceduralPackagingLine(this.route, palletCount, this.manifest.runtime.silkLineSimulation, {
				renderLegacyPlasticConveyors: !hasV7Infrastructure,
				renderLegacyPreProcessStations: !hasV7Infrastructure,
				renderLegacyGantryConveyors: !hasCompleteV7Infrastructure,
				renderLegacyPostProcessConveyor: !hasCompleteV7Infrastructure,
				woodPackagingRoute: this.manifest.routes.find((route) => route.routeId === 'silk-wood-packaging-route'),
			});
			this.packagingLine.setRoutingContext(this.routingContext);
			this.packagingLine.group.userData.twinObjectId = silkLineDefinition.objectId;
			this.applyTransform(this.packagingLine.group, silkLineDefinition);
			this.objectIndex.set(silkLineDefinition.objectId, this.packagingLine.group);
			const equipmentRoots = this.packagingLine.getEquipmentRoots();
			for (const equipmentObject of this.manifest.objects.filter((item) => item.kind === 'equipment'
				&& item.equipment?.parentObjectId === silkLineDefinition.objectId)) {
				const equipmentRoot = equipmentRoots[equipmentObject.equipment!.equipmentType];
				if (!equipmentRoot) continue;
				equipmentRoot.name = equipmentObject.name;
				equipmentRoot.userData = {
					...equipmentRoot.userData,
					twinObjectId: equipmentObject.objectId,
					twinEquipmentType: equipmentObject.equipment!.equipmentType,
					twinEquipmentId: equipmentObject.objectId,
				};
				this.applyTransform(equipmentRoot, equipmentObject);
				this.objectIndex.set(equipmentObject.objectId, equipmentRoot);
			}
			this.scene.add(this.packagingLine.group);
			return;
		}

		const group = new THREE.Group();
		group.name = 'Phase 0 程序化输送线';
		const definition = this.manifest.objects.find((item) => item.objectId === 'phase0-procedural-conveyor')
			?? this.manifest.objects.find((item) => item.kind === 'procedural' && item.procedural?.preset === 'basic-conveyor');
		if (!definition) return;
		group.userData.twinObjectId = definition.objectId;
		this.objectIndex.set(definition.objectId, group);
		this.applyTransform(group, definition);
		const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6, metalness: 0.65 });
		const beltMaterial = new THREE.MeshStandardMaterial({ color: 0x162337, roughness: 0.82, metalness: 0.12 });
		const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.38, metalness: 0.45 });
		const belt = new THREE.Mesh(new THREE.BoxGeometry(12, 0.24, 1.5), beltMaterial);
		belt.name = 'Belt_Main';
		belt.position.set(0, 0.48, -2);
		belt.castShadow = true;
		belt.receiveShadow = true;
		group.add(belt);

		for (let index = 0; index < 7; index += 1) {
			const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.42, 20), accentMaterial);
			roller.name = `Roller_${String(index + 1).padStart(2, '0')}`;
			roller.rotation.x = Math.PI / 2;
			roller.position.set(-5.4 + index * 1.8, 0.67, -2);
			roller.castShadow = true;
			group.add(roller);
		}

		for (const x of [-5.2, -1.8, 1.8, 5.2]) {
			for (const z of [-2.58, -1.42]) {
				const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.85, 0.18), frameMaterial);
				leg.name = `Frame_${x}_${z}`;
				leg.position.set(x, 0.02, z);
				leg.castShadow = true;
				group.add(leg);
			}
		}

		const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.9, 24), accentMaterial);
		motor.name = 'Motor_01';
		motor.userData.twinEquipmentType = 'motor';
		motor.userData.twinEquipmentId = `${definition.objectId}:drive-motor-01`;
		motor.userData.equipmentRole = 'conveyor-drive';
		motor.rotation.z = Math.PI / 2;
		motor.position.set(5.7, 0.2, -3);
		motor.castShadow = true;
		group.add(motor);
		this.scene.add(group);
	}

	private rebuildComponents() {
		this.behaviorRuntime?.dispose();
		this.behaviorRuntime = undefined;
		this.componentProcessRuntime?.dispose();
		this.componentProcessRuntime = undefined;
		for (const [objectId, component] of this.componentModels) {
			this.scene.remove(component.root);
			component.dispose();
			this.objectIndex.delete(objectId);
		}
		this.componentModels.clear();
		this.proceduralComponentAnimationBases.clear();
		for (const objectDefinition of this.manifest.objects as any[]) {
			if (objectDefinition.kind !== 'component') continue;
			const component = objectDefinition.component;
			if (!component?.componentType) continue;
			try {
				const definition = {
					objectId: objectDefinition.objectId,
					name: objectDefinition.name,
					resourceKey: component.resourceKey,
					componentType: component.componentType,
					generator: component.generator,
					generatorVersion: component.generatorVersion,
					resourceId: objectDefinition.resourceId || component.resourceKey,
					resourceVersion: component.generatorVersion,
					properties: component.properties || {},
					transform: objectDefinition.transform,
					sectionId: component.sectionId,
					routeEdgeId: component.routeEdgeId,
				} as TwinComponentDefinition;
				const built = defaultComponentRegistry.create(definition);
				built.root.userData.componentResourceKey = component.resourceKey;
				this.scene.add(built.root);
				this.objectIndex.set(objectDefinition.objectId, built.root);
				this.componentModels.set(objectDefinition.objectId, { root: built.root, dispose: built.dispose });
			} catch (error) {
				this.events.onError?.(`组件 ${objectDefinition.name || objectDefinition.objectId} 加载失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.rebuildComponentProcessRuntime();
		this.rebuildBehaviorRuntime();
	}

	private rebuildBehaviorRuntime() {
		if (!(this.manifest.behaviors?.length || this.manifest.workPoints?.length)) return;
		this.behaviorRuntime = new BehaviorRuntime(
			this.manifest,
			this.scene,
			(objectId) => this.objectIndex.get(objectId),
			(message) => this.events.onError?.(message),
		);
		this.behaviorRuntime.setBindingContext(this.bindingEngine.getSignalSnapshot());
		this.behaviorRuntime.setActorFilter(this.componentTestObjectId);
		this.behaviorRuntime.setRunning(this.runtimeRunning);
	}

	private buildComponentTestPath(objectId: string) {
		const object = (this.manifest.objects as any[]).find((item) => item.objectId === objectId && item.kind === 'component');
		if (!object) return;
		const flow = resolveComponentInternalFlows(object)[0];
		if (!flow?.points?.length) return;
		const pointMap = new Map(flow.points.map((point) => [point.pointId, point.worldPosition.clone()]));
		const path: THREE.Vector3[] = [];
		if (flow.edges?.length) {
			let edge = flow.edges[0];
			const first = pointMap.get(edge.fromPointId);
			if (first) path.push(first);
			const visited = new Set<string>();
			while (edge && !visited.has(edge.edgeId)) {
				visited.add(edge.edgeId);
				const nextPoint = pointMap.get(edge.toPointId);
				if (nextPoint) path.push(nextPoint);
				edge = flow.edges.find((candidate) => !visited.has(candidate.edgeId) && candidate.fromPointId === edge.toPointId) as any;
			}
		}
		if (path.length < 2) path.push(...flow.points.map((point) => point.worldPosition.clone()));
		this.componentTestPath = path.filter((point, index) => index === 0 || point.distanceTo(path[index - 1]) > 0.001);
		if (this.componentTestPath.length < 2) return;
		this.componentTestDistance = 0;
		this.componentTestElapsed = 0;
		const marker = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 12), new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x14532d, emissiveIntensity: 0.55 }));
		marker.name = 'Component-Isolated-Test-Marker';
		marker.userData.helper = true;
		marker.position.copy(this.componentTestPath[0]);
		this.scene.add(marker);
		this.componentTestMarker = marker;
	}

	private advanceComponentTestPath(deltaSeconds: number) {
		if (!this.componentTestMarker || this.componentTestPath.length < 2) return;
		const lengths: number[] = [];
		let total = 0;
		for (let index = 1; index < this.componentTestPath.length; index += 1) {
			total += this.componentTestPath[index - 1].distanceTo(this.componentTestPath[index]);
			lengths.push(total);
		}
		if (total <= 0.001) return;
		const root = this.componentTestObjectId ? this.objectIndex.get(this.componentTestObjectId) : undefined;
		const hasOutputStopper = Array.isArray(root?.userData?.outputStoppers) && root!.userData.outputStoppers.length > 0;
		if (hasOutputStopper) {
			this.componentTestElapsed = (this.componentTestElapsed + deltaSeconds) % 6;
			const elapsed = this.componentTestElapsed;
			let normalized = 0;
			if (elapsed < 3) {
				normalized = (elapsed / 3) * 0.84;
				this.setOutputStopperVisual(root, true, elapsed >= 2.6);
			} else if (elapsed < 4) {
				normalized = 0.84;
				this.setOutputStopperVisual(root, true, true);
			} else if (elapsed < 5) {
				normalized = 0.84 + (elapsed - 4) * 0.16;
				this.setOutputStopperVisual(root, false, elapsed < 4.35);
			} else {
				normalized = 0;
				this.setOutputStopperVisual(root, true, false);
			}
			this.componentTestDistance = Math.min(total, normalized * total);
		} else {
			this.componentTestDistance = (this.componentTestDistance + deltaSeconds) % total;
		}
		let segment = lengths.findIndex((value) => this.componentTestDistance <= value);
		if (segment < 0) segment = lengths.length - 1;
		const segmentStart = segment === 0 ? 0 : lengths[segment - 1];
		const segmentLength = Math.max(0.001, lengths[segment] - segmentStart);
		const ratio = (this.componentTestDistance - segmentStart) / segmentLength;
		this.componentTestMarker.position.lerpVectors(this.componentTestPath[segment], this.componentTestPath[segment + 1], ratio);
	}

	private setOutputStopperVisual(root: THREE.Object3D | undefined, raised: boolean, palletPresent: boolean, portId?: string) {
		if (!root) return;
		const definitions = Array.isArray(root.userData?.outputStoppers) ? root.userData.outputStoppers as Array<any> : [];
		for (const definition of definitions) {
			if (portId && definition.portId !== portId) continue;
			const stopper = root.getObjectByName(String(definition.nodePath || ''));
			if (stopper) {
				const raisedY = Number(stopper.userData?.raisedY ?? stopper.position.y);
				const loweredY = Number(stopper.userData?.loweredY ?? raisedY - 0.22);
				stopper.position.y = raised ? raisedY : loweredY;
				stopper.userData.stopperRaised = raised;
			}
			const sensor = root.getObjectByName(String(definition.sensorNodePath || ''));
			if (sensor) sensor.userData.palletPresent = palletPresent;
		}
	}

	private syncOutputStopperBindings() {
		if (this.manifest.runtime.dataMode !== 'live') return;
		const values = this.bindingEngine.getSignalSnapshot().bindingValues as Record<string, unknown>;
		const truthy = (value: unknown): boolean => {
			if (typeof value === 'boolean') return value;
			if (typeof value === 'number') return value !== 0;
			if (typeof value === 'string') return value.trim() !== '' && value !== '0' && value.toLowerCase() !== 'false';
			if (Array.isArray(value)) return value.some(truthy);
			return Boolean(value);
		};
		for (const object of this.manifest.objects as any[]) {
			if (object.kind !== 'component' || !object.component?.bindings) continue;
			const root = this.objectIndex.get(object.objectId);
			const definitions = Array.isArray(root?.userData?.outputStoppers) ? root!.userData.outputStoppers as Array<any> : [];
			for (const definition of definitions) {
				const prefix = String(definition.portId || '').replace(/[^a-zA-Z0-9_-]/g, '-');
				const upId = object.component.bindings[`${prefix}-stopperUp`];
				const downId = object.component.bindings[`${prefix}-stopperDown`];
				const presentId = object.component.bindings[`${prefix}-palletPresent`];
				const hasUp = Boolean(upId && Object.prototype.hasOwnProperty.call(values, upId));
				const hasDown = Boolean(downId && Object.prototype.hasOwnProperty.call(values, downId));
				const stopper = root?.getObjectByName(String(definition.nodePath || ''));
				const raised = hasUp ? truthy(values[upId]) : hasDown ? !truthy(values[downId]) : Boolean(stopper?.userData?.stopperRaised ?? true);
				const present = Boolean(presentId && Object.prototype.hasOwnProperty.call(values, presentId) && truthy(values[presentId]));
				this.setOutputStopperVisual(root, raised, present, definition.portId);
			}
		}
	}

	private clearComponentTestMarker() {
		this.componentTestPath = [];
		this.componentTestDistance = 0;
		this.componentTestElapsed = 0;
		if (!this.componentTestMarker) return;
		this.scene.remove(this.componentTestMarker);
		this.componentTestMarker.geometry.dispose();
		(this.componentTestMarker.material as THREE.Material).dispose();
		this.componentTestMarker = undefined;
	}

	private rebuildComponentProcessRuntime() {
		this.componentProcessRuntime?.dispose();
		this.componentProcessRuntime = undefined;
		if (this.packagingLine || !this.route.points.some((point) => point.kind === 'processStation' && point.process)) return;
		this.componentProcessRuntime = new ComponentProcessRuntime({
			route: this.route,
			routeEngine: this.routeEngine,
			getComponentRoot: (objectId) => this.componentModels.get(objectId)?.root,
			getRoutingContext: () => this.routingContext,
		});
	}

	private captureProceduralComponentBase(objectId: string, root: THREE.Group) {
		let bases = this.proceduralComponentAnimationBases.get(objectId);
		if (bases) return bases;
		bases = new Map();
		root.traverse((node) => bases!.set(node, { position: node.position.clone(), rotation: node.rotation.clone(), scale: node.scale.clone() }));
		this.proceduralComponentAnimationBases.set(objectId, bases);
		return bases;
	}

	private restoreProceduralComponent(objectId: string) {
		for (const [node, base] of this.proceduralComponentAnimationBases.get(objectId) || []) {
			node.position.copy(base.position);
			node.rotation.copy(base.rotation);
			node.scale.copy(base.scale);
		}
	}

	/** 完整丝饼场景保留多托盘专用停车/背压逻辑，只把真实工艺进度同步给 V7 设备机械节点。 */
	private syncProceduralProcessComponentAnimations() {
		if (!this.packagingLine) return;
		const snapshot = this.packagingLine.getSnapshot();
		for (const [objectId, component] of this.componentModels) {
			const root = component.root;
			const resourceKey = String(root.userData?.componentResourceKey || root.userData?.resourceKey || '');
			const processType = String(root.userData?.processType || '');
			const isInspection = processType === 'external-inspection';
			const isPrimaryBagging = processType === 'bagging' && resourceKey === 'builtin-bagging-machine';
			if (!isInspection && !isPrimaryBagging) continue;
			const process = isInspection ? snapshot.preProcess.inspection : snapshot.preProcess.bagging;
			const active = process.state === 'processing' || process.state === 'waiting';
			if (!active) {
				this.restoreProceduralComponent(objectId);
				continue;
			}
			const bases = this.captureProceduralComponentBase(objectId, root);
			const progress = THREE.MathUtils.clamp(Number(process.progress) || 0, 0, 1);
			const wave = Math.sin(Math.PI * progress);
			if (isInspection) {
				root.traverse((node) => {
					if (node.userData?.rotaryInspectionGripper !== true) return;
					const base = bases.get(node); if (!base) return;
					node.rotation.y = base.rotation.y + progress * Math.PI * 6;
					node.position.y = base.position.y - wave * 0.16;
				});
			} else {
				const pickup = root.getObjectByName('Bagging-Vacuum-Pickup');
				if (pickup) { const base = bases.get(pickup); if (base) pickup.position.z = base.position.z - wave * Math.abs(base.position.z) * 0.72; }
				const lift = root.getObjectByName('Bagging-Z-Lift');
				if (lift) { const base = bases.get(lift); if (base) lift.position.y = base.position.y - wave * 0.82; }
			}
		}
	}

	private createMovingObject() {
		if (this.packagingLine) return;
		this.movingObject.name = '路线测试物料';
		const definition = this.manifest.objects.find((item) => item.objectId === 'phase0-moving-package' || item.objectId === 'moving-package');
		if (!definition) return;
		this.movingObject.userData.twinObjectId = definition.objectId;
		this.objectIndex.set(definition.objectId, this.movingObject);

		// 运行预览物料必须服从主路线运输类型，不能再固定画成橙色纸箱。
		const transportUnitType = this.route.edges.find((edge) => edge.enabled !== false && edge.transportUnitType)?.transportUnitType || 'plastic-pallet';
		const resourceKey = resolveRouteTransportUnitResourceKey(this.route);
		try {
			const transportDefinition = createComponentDefinitionFromTemplate(resourceKey, {
				objectId: definition.objectId + ':runtime-transport-unit',
				name: transportUnitType === 'carton' ? '运行纸箱' : transportUnitType === 'wooden-pallet' ? '运行木托盘' : '运行小托盘',
			});
			const built = defaultComponentRegistry.create(transportDefinition);
			built.root.name = 'RouteTransportUnit';
			built.root.userData.runtimeTransportUnit = true;
			built.root.userData.transportUnitType = transportUnitType;
			this.movingObject.add(built.root);
		} catch (error) {
			this.events.onError?.('运行运输单元创建失败：' + (error instanceof Error ? error.message : String(error)));
		}
		this.scene.add(this.movingObject);
		this.routeEngine.setTarget(this.movingObject);
	}

	private rebuildRouteVisuals() {
		const hadRoutePointSelection = this.selectedRoutePointIndex !== null;
		this.transformControls.detach();
		this.selectedRoutePointIndex = null;
		for (const child of [...this.routePointGroup.children]) {
			this.routePointGroup.remove(child);
			this.disposeObject(child);
		}
		this.route.points.forEach((point, index) => {
			const geometry = point.kind === 'junction' || point.kind === 'diverter'
				? new THREE.OctahedronGeometry(0.26, 0)
				: point.kind === 'merger'
					? new THREE.DodecahedronGeometry(0.24, 0)
					: point.kind === 'sensor'
						? new THREE.ConeGeometry(0.18, 0.38, 12)
						: point.kind === 'buffer'
							? new THREE.CylinderGeometry(0.18, 0.18, 0.34, 16)
				: point.kind === 'station'
					? new THREE.BoxGeometry(0.3, 0.3, 0.3)
					: point.kind === 'processStation'
						? new THREE.BoxGeometry(0.38, 0.38, 0.38)
					: new THREE.SphereGeometry(0.16, 18, 18);
			const color = point.kind === 'junction' || point.kind === 'diverter' ? 0xf59e0b : point.kind === 'merger' ? 0xa855f7 : point.kind === 'sensor' ? 0xf43f5e : point.kind === 'buffer' ? 0x06b6d4 : point.kind === 'station' || point.kind === 'processStation' ? 0x22c55e : 0x38bdf8;
			const handle = new THREE.Mesh(
				geometry,
				new THREE.MeshStandardMaterial({ color, emissive: point.kind === 'junction' || point.kind === 'diverter' ? 0x422006 : 0x082f49, roughness: 0.35 })
			);
			handle.name = point.name;
			handle.position.set(point.position[0], point.position[1], point.position[2]);
			handle.userData.routePointIndex = index;
			handle.castShadow = true;
			this.routePointGroup.add(handle);
		});
		this.rebuildRouteLines();
		if (hadRoutePointSelection) this.events.onSelectionChange?.(null);
	}

	private rebuildRouteLines() {
		for (const child of [...this.routeEdgeGroup.children]) {
			this.routeEdgeGroup.remove(child);
			this.disposeObject(child);
		}

		const pointIndex = new Map(this.route.points.map((point) => [point.pointId, point]));
		const snapshot = this.routeEngine.getSnapshot();
		const activeEdgeIds = new Set(snapshot.activeEdgeIds);
		const unavailableEdgeIds = new Set(snapshot.unavailableEdgeIds);
		for (const edge of this.route.edges || []) {
			const from = pointIndex.get(edge.fromPointId), to = pointIndex.get(edge.toPointId);
			if (!from || !to) continue;
			const color = unavailableEdgeIds.has(edge.edgeId) ? 0xef4444 : activeEdgeIds.has(edge.edgeId) ? 0x22c55e : edge.enabled === false ? 0x475569 : 0x64748b;
			const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: edge.enabled === false ? 0.35 : 0.8 });
			const geometry = new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(...from.position),
				new THREE.Vector3(...to.position),
			]);
			const line = new THREE.Line(geometry, material);
			line.name = edge.name || edge.edgeId;
			line.userData[helperFlag] = true;
			this.routeEdgeGroup.add(line);
		}

		if (this.routeLine) {
			this.scene.remove(this.routeLine);
			this.routeLine.geometry.dispose();
			this.routeLine = undefined;
		}
		// 有显式边的路线（尤其是分叉/汇流拓扑）已经逐边绘制。再次按 points 数组顺序
		// 生成一条曲线会跨越分支并造成“交叉口重叠”的假象，仅为旧式无边路线保留预览线。
		if ((this.route.edges || []).length > 0) return;
		const curve = this.routeEngine.getCurve();
		const sampleCount = Math.max(32, this.route.points.length * 28);
		const lineGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(sampleCount));
		this.routeLine = new THREE.Line(lineGeometry, this.routeLineMaterial);
		this.routeLine.name = '路线预览';
		this.routeLine.userData[helperFlag] = true;
		this.scene.add(this.routeLine);
	}

	private applyRouteChange() {
		this.materialFlowRuntime.setRoute(this.route);
		this.routeEngine.setRoute(this.route);
		this.componentProcessRuntime?.setRoute(this.route);
		this.packagingLine?.setRoute(this.route);
		this.rebuildRouteDistanceCurves();
		this.rebuildRouteVisuals();
		this.emitRouteChange();
	}

	private emitRouteChange() {
		this.events.onRouteChange?.(structuredClone(this.route));
	}

	private rebuildRouteDistanceCurves() {
		this.routeDistanceCurves.clear();
		for (const route of this.manifest.routes || []) {
			const vectors = (route.points || []).map((point) => new THREE.Vector3(point.position[0], point.position[1], point.position[2]));
			if (vectors.length < 2) continue;
			const loop = route.loop === true;
			let curve: THREE.Curve<THREE.Vector3>;
			if (route.curveKind === 'line' || vectors.length === 2) {
				const path = new THREE.CurvePath<THREE.Vector3>();
				for (let index = 1; index < vectors.length; index += 1) path.add(new THREE.LineCurve3(vectors[index - 1], vectors[index]));
				if (loop && vectors.length > 2) path.add(new THREE.LineCurve3(vectors[vectors.length - 1], vectors[0]));
				curve = path;
			} else {
				curve = new THREE.CatmullRomCurve3(vectors, loop, 'centripetal', 0.5);
			}
			const lengthMeters = curve.getLength();
			if (lengthMeters > 0) this.routeDistanceCurves.set(route.routeId, { route, curve, lengthMeters, loop });
		}
	}

	private applyRouteDistance(binding: TwinObjectBindingDefinition, object: any, distanceMeters: number) {
		if (!Number.isFinite(distanceMeters)) return this.events.onError?.(`路线位置绑定 ${binding.bindingId} 收到的距离不是有效数字`);
		const routeId = String((binding.transform as Record<string, unknown>).routeId || '').trim();
		const info = this.routeDistanceCurves.get(routeId);
		if (!info) return this.events.onError?.(`路线位置绑定 ${binding.bindingId} 引用的路线 ${routeId || '(空)'} 不存在或不可绘制`);
		const corrected = info.loop
			? ((distanceMeters % info.lengthMeters) + info.lengthMeters) % info.lengthMeters
			: THREE.MathUtils.clamp(distanceMeters, 0, info.lengthMeters);
		const progress = corrected / info.lengthMeters;
		const position = info.curve.getPointAt(progress);
		object.position.copy(position);
		if (info.route.orientToPath !== false) {
			const tangent = info.curve.getTangentAt(progress);
			if (tangent.lengthSq() > 0.000001) object.lookAt(position.clone().add(tangent));
		}
		object.userData.routeId = routeId;
		object.userData.routeDistanceMeters = corrected;
	}

	private applyRouteSignal(bindingId: string, value: unknown, stale: boolean) {
		const bindingValues = { ...(this.routingContext.bindingValues || {}) };
		const staleBindingIds = new Set(this.routingContext.staleBindingIds || []);
		if (stale) {
			delete bindingValues[bindingId];
			staleBindingIds.add(bindingId);
		} else {
			bindingValues[bindingId] = value;
			staleBindingIds.delete(bindingId);
		}
		this.routingContext = { ...this.routingContext, bindingValues, staleBindingIds: [...staleBindingIds] };
		this.materialFlowRuntime.applyRoutingContext(this.routingContext);
		this.packagingLine?.setRoutingContext(this.routingContext);
		this.routeEngine.setRoutingContext(this.routingContext);
		this.rebuildRouteLines();
	}

	private commitSelectedRoutePoint() {
		if (this.readOnly) return;
		if (this.selectedRoutePointIndex === null) return;
		const object = this.transformControls.object;
		if (!object) return;
		const position: TwinVector3 = [object.position.x, object.position.y, object.position.z];
		this.route.points[this.selectedRoutePointIndex].position = position;
		this.routeEngine.setRoute(this.route);
		this.packagingLine?.setRoute(this.route);
		this.rebuildRouteLines();
		this.emitRouteChange();
	}

	private readonly handlePointerDown = (event: PointerEvent) => {
		this.pointerDown.set(event.clientX, event.clientY);
	};

	private readonly handlePointerUp = (event: PointerEvent) => {
		if (this.transformDragging || this.pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
		const bounds = this.renderer.domElement.getBoundingClientRect();
		this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
		this.raycaster.setFromCamera(this.pointer, this.camera);

		if (this.routeDrawMode && this.ground) {
			const groundHit = this.raycaster.intersectObject(this.ground, false)[0];
			if (groundHit) this.addRoutePoint([groundHit.point.x, 0.72, groundHit.point.z]);
			return;
		}

		const routePointHit = this.raycaster.intersectObjects(this.routePointGroup.children, false)[0];
		if (routePointHit) {
			if (this.readOnly) {
				this.clearSelection();
				return;
			}
			const routePointIndex = Number(routePointHit.object.userData.routePointIndex);
			this.selectedRoutePointIndex = routePointIndex;
			this.transformControls.attach(routePointHit.object);
			this.removeSelectionHelper();
			this.events.onSelectionChange?.({
				name: this.route.points[routePointIndex]?.name ?? routePointHit.object.name,
				uuid: routePointHit.object.uuid,
				path: `routes[0].points[${routePointIndex}]`,
				kind: 'route-point',
				routeId: this.route.routeId,
				routePointIndex,
				routePointId: this.route.points[routePointIndex]?.pointId,
			});
			return;
		}

		const hits = this.raycaster.intersectObjects(this.scene.children, true).filter((hit: any) => {
			if (!hit.object?.isMesh) return false;
			if (hit.object === this.ground) return false;
			let current = hit.object;
			while (current) {
				if (current.userData?.[helperFlag]) return false;
				current = current.parent;
			}
			return true;
		});
		const hitObject = hits[0]?.object;
		if (!hitObject) {
			this.clearSelection();
			return;
		}
		const semantic = this.resolveRuntimeSelection(hitObject);
		const selected = semantic.root;
		this.transformControls.detach();
		this.selectedRoutePointIndex = null;
		this.removeSelectionHelper();
		this.selectionHelper = new THREE.BoxHelper(selected, 0xfacc15);
		this.selectionHelper.object = selected;
		this.selectionHelper.userData[helperFlag] = true;
		this.scene.add(this.selectionHelper);
		const entityInfo = semantic.entityInfo;
		const twinInfo = semantic.twinInfo;
		const equipmentInfo = semantic.equipmentInfo;
		const objectDefinition = twinInfo?.objectId ? this.manifest.objects.find((item) => item.objectId === twinInfo.objectId) : undefined;
		const worldPosition = new THREE.Vector3();
		selected.getWorldPosition(worldPosition);
		this.events.onSelectionChange?.({
			name: entityInfo?.entityId || objectDefinition?.name || selected.name || selected.type,
			uuid: selected.uuid,
			path: this.getObjectPath(selected),
			kind: entityInfo ? 'runtime-entity' : 'scene-object',
			objectId: entityInfo ? undefined : twinInfo?.objectId,
			nodePath: undefined,
			entityType: entityInfo?.entityType,
			entityId: entityInfo?.entityId,
			equipmentType: equipmentInfo?.equipmentType,
			equipmentId: equipmentInfo?.equipmentId,
			runtimeData: entityInfo
				? this.routeSlotArrayRuntime.getEntityDetail(entityInfo.entityType, entityInfo.entityId) ?? this.packagingLine?.getEntityDetail(entityInfo.entityType, entityInfo.entityId)
				: this.getSceneObjectRuntimeDetail(twinInfo?.objectId, equipmentInfo?.equipmentType, equipmentInfo?.equipmentId),
			worldPosition: [worldPosition.x, worldPosition.y, worldPosition.z],
		});
	};

	private resolveRuntimeSelection(object: THREE.Object3D) {
		let current: THREE.Object3D | null = object;
		let entityRoot: THREE.Object3D | undefined;
		let equipmentRoot: THREE.Object3D | undefined;
		let twinRoot: THREE.Object3D | undefined;
		while (current && current !== this.scene) {
			const data = current.userData || {};
			if (!entityRoot && (data.twinEntityType || data.entityType) && (data.twinEntityId || data.entityId)) entityRoot = current;
			if (!equipmentRoot && (data.twinEquipmentType || data.equipmentType)) equipmentRoot = current;
			if (!twinRoot && data.twinObjectId) twinRoot = current;
			current = current.parent;
		}
		// Runtime inspection is business-object oriented: a pallet/entity wins first,
		// then the enclosing Twin component/object, and only truly standalone equipment
		// may fall back to its equipment root. This prevents a motor/roller child Mesh
		// from becoming the runtime selection instead of the whole component.
		const root = entityRoot || twinRoot || equipmentRoot || object;
		return {
			root,
			entityInfo: this.getTwinEntityInfo(root),
			equipmentInfo: this.getTwinEquipmentInfo(root),
			twinInfo: this.getTwinObjectInfo(root),
		};
	}

	private getSceneObjectRuntimeDetail(objectId?: string, equipmentType?: string, equipmentId?: string): Record<string, unknown> | undefined {
		const definition = objectId ? this.manifest.objects.find((item) => item.objectId === objectId) : undefined;
		const behaviorDetail = objectId ? this.behaviorRuntime?.getObjectDetail(objectId) : undefined;
		const packaging = this.packagingLine;
		if (packaging) {
			const snapshot = packaging.getSnapshot();
			switch (equipmentType || definition?.equipment?.equipmentType) {
				case 'loading-robot': return packaging.getEntityDetail('loading-robot', equipmentId || objectId || '') ?? snapshot.robot;
				case 'gantry-stacker': return packaging.getEntityDetail('gantry-stacker', equipmentId || objectId || '') ?? snapshot.gantry;
				case 'silk-cart-turntable': return snapshot.silkCart;
				case 'cover-applicator': return { station: 'cover-applicator', woodenPallet: snapshot.woodenPallet, postProcess: snapshot.postProcess };
				case 'labeler': return { station: 'labeler', woodenPallet: snapshot.woodenPallet, postProcess: snapshot.postProcess };
				case 'wrapper': return { station: 'wrapper', woodenPallet: snapshot.woodenPallet, postProcess: snapshot.postProcess };
				case 'inbound-lift': return { station: 'inbound-lift', woodenPallet: snapshot.woodenPallet, postProcess: snapshot.postProcess };
			}
			const semantic = `${definition?.name || ''} ${definition?.component?.resourceKey || ''} ${definition?.component?.componentType || ''}`.toLocaleLowerCase();
			if (/external[-_ ]?inspection|外检/.test(semantic)) return { station: 'external-inspection', ...snapshot.preProcess.inspection };
			if (/bagging|套袋/.test(semantic)) return { station: 'bagging', ...snapshot.preProcess.bagging };
			if (/gantry|桁架/.test(semantic)) return snapshot.gantry;
			if (/robot|机器人/.test(semantic)) return snapshot.robot;
		}
		if (definition?.component) return {
			componentType: definition.component.componentType,
			resourceKey: definition.component.resourceKey,
			properties: definition.component.properties,
			...(behaviorDetail || {}),
		};
		return behaviorDetail;
	}

	private clearSelection() {
		this.transformControls.detach();
		this.selectedRoutePointIndex = null;
		this.removeSelectionHelper();
		this.events.onSelectionChange?.(null);
	}

	private removeSelectionHelper() {
		if (!this.selectionHelper) return;
		this.scene.remove(this.selectionHelper);
		this.selectionHelper.geometry?.dispose?.();
		this.selectionHelper.material?.dispose?.();
		this.selectionHelper = undefined;
	}

	private getObjectPath(object: any) {
		const path: string[] = [];
		let current = object;
		while (current && current !== this.scene) {
			path.unshift(current.name || current.type);
			current = current.parent;
		}
		return path.join('/');
	}

	private getTwinObjectInfo(object: any): { objectId: string; nodePath?: string } | undefined {
		const nodes: any[] = [];
		let current = object;
		while (current && current !== this.scene) {
			nodes.unshift(current);
			if (current.userData?.twinObjectId) {
				const relativeNodes = nodes.slice(1).map((item) => item.name || item.type);
				return { objectId: String(current.userData.twinObjectId), nodePath: relativeNodes.length ? relativeNodes.join('/') : undefined };
			}
			current = current.parent;
		}
		return undefined;
	}

	private getTwinEntityInfo(object: any): { entityType: string; entityId: string } | undefined {
		let current = object;
		while (current && current !== this.scene) {
			const entityType = current.userData?.twinEntityType || current.userData?.entityType;
			const entityId = current.userData?.twinEntityId || current.userData?.entityId;
			if (entityType && entityId) {
				return { entityType: String(entityType), entityId: String(entityId) };
			}
			current = current.parent;
		}
		return undefined;
	}

	private getTwinEquipmentInfo(object: any): { equipmentType: string; equipmentId?: string } | undefined {
		let current = object;
		while (current && current !== this.scene) {
			const equipmentType = current.userData?.twinEquipmentType || current.userData?.equipmentType;
			if (equipmentType) {
				const equipmentId = current.userData?.twinEquipmentId || current.userData?.equipmentId;
				return { equipmentType: String(equipmentType), equipmentId: equipmentId ? String(equipmentId) : undefined };
			}
			current = current.parent;
		}
		const semanticName = `${object?.name || ''} ${this.getObjectPath(object)}`.toLocaleLowerCase();
		if (/motor|drive[_ -]?motor|电机|马达|减速机/.test(semanticName)) return { equipmentType: 'motor' };
		return undefined;
	}

	private applyTransform(object: any, definition: TwinSceneObjectDefinition) {
		object.position.set(...definition.transform.position);
		object.rotation.set(...definition.transform.rotation);
		object.scale.set(...definition.transform.scale);
	}

	private focusObject(object: any) {
		const box = new THREE.Box3().setFromObject(object);
		if (box.isEmpty()) return;
		const sphere = box.getBoundingSphere(new THREE.Sphere());
		const distance = Math.max(2.5, sphere.radius * 2.8);
		const direction = this.camera.position.clone().sub(this.orbitControls.target).normalize();
		this.orbitControls.target.copy(sphere.center);
		this.camera.position.copy(sphere.center).add(direction.multiplyScalar(distance));
		this.camera.near = Math.max(0.01, distance / 200);
		this.camera.far = Math.max(1000, distance * 100);
		this.camera.updateProjectionMatrix();
		this.orbitControls.update();
	}

	private resize() {
		const width = Math.max(1, this.container.clientWidth);
		const height = Math.max(1, this.container.clientHeight);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height, false);
	}

	private disposeObject(object: any) {
		object.traverse?.((child: any) => this.disposeRenderable(child));
	}

	private disposeRenderable(object: any) {
		object.geometry?.dispose?.();
		const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if ((value as any)?.isTexture) (value as any).dispose();
			}
			material.dispose?.();
		}
	}
}
