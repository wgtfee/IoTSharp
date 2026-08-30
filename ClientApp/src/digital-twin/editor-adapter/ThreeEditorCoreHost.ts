import type { ThreeEditorModelSnapshot, ThreeEditorSnapshot, TwinRouteDefinition, TwinSceneManifest, TwinSceneObjectDefinition, TwinVector3 } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import type { TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';
import { defaultComponentRegistry, isComponentSceneObject, revalidateComponentConnections, snapAndConnectNearestComponent, upsertGeneratedComponentRoute, type TwinComponentDefinition } from '/@/digital-twin/components';
import { ThreeEditorRouteOverlay } from '/@/digital-twin/editor-adapter/ThreeEditorRouteOverlay';

// 上游是固定提交的 Apache-2.0 JavaScript 源码，IoTSharp 通过本适配层隔离其动态 API。
// @ts-ignore -- vendored JavaScript intentionally has no TypeScript declarations.
import { ThreeEditor } from '/@/digital-twin/vendor/three-editor-cores/lib/main.js';
// @ts-ignore -- see the vendored source note above.
import { restoreHistoryHandler } from '/@/digital-twin/vendor/three-editor-cores/lib/Editor/Handler/History.js';

export interface ThreeEditorCoreHostEvents {
	onSelectionChange?: (selection: TwinSelectionInfo | null) => void;
	onRouteChange?: (route: TwinRouteDefinition) => void;
	onChanged?: () => void;
	onError?: (message: string) => void;
}

interface LoadedEditorModel {
	objectId: string;
	resourceId?: string;
	root: any;
	dispose?: () => void;
	kind: 'model' | 'component';
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

/** threejs-editor 专业编辑内核与 IoTSharp Manifest 的稳定边界。 */
export class ThreeEditorCoreHost {
	private readonly container: HTMLDivElement;
	private readonly events: ThreeEditorCoreHostEvents;
	private readonly resizeObserver: ResizeObserver;
	private readonly objectUrls = new Set<string>();
	private readonly loadedModels = new Map<string, LoadedEditorModel>();
	private readonly routeOverlay: ThreeEditorRouteOverlay;
	private manifest: TwinSceneManifest;
	private editor: any;
	private selectedObjectId?: string;
	private selectedRouteId?: string;
	private selectedRoutePointId?: string;
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

		this.editor.setGUIDomPosition(guiContainer);
		this.editor.setSceneControlMode('变换');
		this.editor.setOperateOption('openKey', false);
		this.editor.setOperateOption('grid', manifest.runtime.showGrid);
		this.routeOverlay = new ThreeEditorRouteOverlay(this.editor.viewer.scene, this.manifest);
		this.editor.viewer.transformControls.dragChangeCallback = (dragging: boolean) => {
			if (dragging) return;

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
				const snapped = snapAndConnectNearestComponent(this.manifest, selectedId, { maxDistance: 0.5, maxAngleDegrees: 15, preferFacingPorts: true });
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
			}
			this.routeOverlay.rebuild(this.manifest);
			this.events.onChanged?.();
		};
		this.container.addEventListener('click', this.handleSceneClick);
		this.resizeObserver = new ResizeObserver(() => this.editor?.viewer?.renderSceneResize?.());
		this.resizeObserver.observe(container);
		this.loadManifestComponents();
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
				componentType: object.component.componentType as TwinComponentDefinition['componentType'],
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
		this.routeOverlay.rebuild(this.manifest);
		this.selectObject(objectId);
		this.events.onChanged?.();
	}

	reloadAllComponents() {
		for (const model of [...this.loadedModels.values()].filter((item) => item.kind === 'component')) this.removeObject(model.objectId, false);
		this.loadManifestComponents();
		upsertGeneratedComponentRoute(this.manifest);
		this.routeOverlay.rebuild(this.manifest);
		this.events.onChanged?.();
	}

	refreshRouteOverlay() {
		this.routeOverlay.setManifest(this.manifest);
		this.editor.viewer.renderScene?.();
	}

	setRouteOverlayVisible(visible: boolean) {
		this.routeOverlay.setVisible(visible);
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
		this.editor.saveSceneEditor();
		const glbObjectIds = new Set(target.objects.filter((item) => item.kind === 'model').map((item) => item.objectId));
		this.latestModelParams = this.latestModelParams.filter((item) => glbObjectIds.has(item.rootInfo.iotsharpObjectId));
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

	setSelectionMode(mode: 'select' | 'root' | 'transform') { this.editor.setSceneControlMode(mode === 'select' ? '选择' : mode === 'root' ? '根选择' : '变换'); }
	setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
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
	undo() { restoreHistoryHandler('z'); this.reconcileComponentConnectionsAfterHistory(); }
	redo() { restoreHistoryHandler('y'); this.reconcileComponentConnectionsAfterHistory(); }

	selectObject(objectId: string) {
		const root = this.loadedModels.get(objectId)?.root;
		if (!root) return;
		this.clearRoutePointSelection(false);
		this.editor.setOutlinePass([root]);
		this.editor.viewer.transformControls.attach(root);
		this.selectRoot(root);
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
		const root = this.selectedObjectId ? this.loadedModels.get(this.selectedObjectId)?.root : undefined;
		if (!root) return;
		const { position, target } = this.editor.getObjectViews(root);
		this.editor.setGsapAnimation(this.editor.viewer.camera.position, position, { duration: 0.45 });
		this.editor.setGsapAnimation(this.editor.viewer.controls.target, target, { duration: 0.45 });
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
		if (this.selectedObjectId === objectId) { this.selectedObjectId = undefined; this.events.onSelectionChange?.(null); }
		if (notify) {
			upsertGeneratedComponentRoute(this.manifest);
			this.routeOverlay.rebuild(this.manifest);
			this.events.onChanged?.();
		}
	}

	private loadManifestComponents() {
		for (const object of this.manifest.objects as TwinV7SceneObjectDefinition[]) if (isComponentSceneObject(object)) this.loadComponent(object);
		this.routeOverlay.rebuild(this.manifest);
	}

	private readonly handleSceneClick = (event: MouseEvent) => {
		if (this.disposed || event.defaultPrevented) return;
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
				const root = info?.currentRootModel;
				if (root?.rootInfo?.iotsharpObjectId || root?.userData?.iotsharpObjectId) this.selectRoot(root, info.currentModel);
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

	private selectRoot(root: any, node = root) {
		const objectId = root.rootInfo?.iotsharpObjectId || root.userData?.iotsharpObjectId;
		if (!objectId) return;
		this.clearRoutePointSelection(false);
		this.selectedObjectId = objectId;
		const segments: string[] = [];
		let current = node;
		while (current && current !== root) {
			const index = current.parent?.children?.indexOf(current) ?? -1;
			segments.unshift(current.name || `${current.type}[${index}]`);
			current = current.parent;
		}
		this.events.onSelectionChange?.({ name: node.name || root.name || '未命名对象', uuid: node.uuid, path: `${this.manifest.name}/${root.name || objectId}`, kind: 'scene-object', objectId, nodePath: segments.join('/') });
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
		this.routeOverlay.rebuild(this.manifest);
		if (removedConnectionIds.length > 0) {
			this.events.onError?.(`撤销/重做后已清理 ${removedConnectionIds.length} 条失效组件连接。`);
		}
		this.events.onChanged?.();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.container.removeEventListener('click', this.handleSceneClick);
		this.resizeObserver.disconnect();
		this.routeOverlay.dispose();
		for (const model of this.loadedModels.values()) model.dispose?.();
		this.editor?.viewer?.destroySceneRender?.();
		for (const objectUrl of this.objectUrls) URL.revokeObjectURL(objectUrl);
		this.objectUrls.clear(); this.loadedModels.clear(); this.editor = undefined;
	}
}
