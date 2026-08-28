import type { ThreeEditorModelSnapshot, ThreeEditorSnapshot, TwinSceneManifest, TwinSceneObjectDefinition } from '/@/digital-twin/contracts';
import type { TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';

// 上游是固定提交的 Apache-2.0 JavaScript 源码，IoTSharp 通过本适配层隔离其动态 API。
// @ts-ignore -- vendored JavaScript intentionally has no TypeScript declarations.
import { ThreeEditor } from '/@/digital-twin/vendor/three-editor-cores/lib/main.js';
// @ts-ignore -- see the vendored source note above.
import { restoreHistoryHandler } from '/@/digital-twin/vendor/three-editor-cores/lib/Editor/Handler/History.js';

export interface ThreeEditorCoreHostEvents {
	onSelectionChange?: (selection: TwinSelectionInfo | null) => void;
	onChanged?: () => void;
	onError?: (message: string) => void;
}

interface LoadedEditorModel {
	objectId: string;
	resourceId?: string;
	root: any;
}

const editorCommit = 'd7e2ddf6cc1fa8c626356a3606167abff68daaed';
const coreCommit = '98197115af2318ed20f334873517018509b8e079';

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isTransientUrl = (value: unknown): value is string => typeof value === 'string' && /^(blob:|data:|https?:)/i.test(value.trim());
const sanitizeEditorJson = (value: unknown): unknown => {
	if (isTransientUrl(value)) return undefined;
	if (Array.isArray(value)) return value.map(sanitizeEditorJson).filter((item) => item !== undefined);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
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

/**
 * threejs-editor 专业编辑内核与 IoTSharp Manifest 的稳定边界。
 * 二进制模型永远从 IoTSharp resourceId 加载，编辑器快照不保存 blob/http/data URL。
 */
export class ThreeEditorCoreHost {
	private readonly container: HTMLDivElement;
	private readonly events: ThreeEditorCoreHostEvents;
	private readonly resizeObserver: ResizeObserver;
	private readonly objectUrls = new Set<string>();
	private readonly loadedModels = new Map<string, LoadedEditorModel>();
	private manifest: TwinSceneManifest;
	private editor: any;
	private selectedObjectId?: string;
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
				this.latestModelParams = (modelParams || []).map(sanitizeModelSnapshot).filter(Boolean) as ThreeEditorModelSnapshot[];
			},
		});

		this.editor.setGUIDomPosition(guiContainer);
		this.editor.setSceneControlMode('变换');
		this.editor.setOperateOption('openKey', false);
		this.editor.setOperateOption('grid', manifest.runtime.showGrid);
		this.editor.viewer.transformControls.dragChangeCallback = (dragging: boolean) => {
			if (!dragging) {
				this.syncTransformsToManifest();
				this.events.onChanged?.();
			}
		};
		this.container.addEventListener('click', this.handleSceneClick);
		this.resizeObserver = new ResizeObserver(() => this.editor?.viewer?.renderSceneResize?.());
		this.resizeObserver.observe(container);
	}

	async loadGlbBuffer(object: TwinSceneObjectDefinition, fileName: string, buffer: ArrayBuffer) {
		if (this.disposed || object.kind !== 'model') return;
		this.removeObject(object.objectId, false);
		const objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
		this.objectUrls.add(objectUrl);
		const stored = this.latestModelParams.find((item) => item.rootInfo.iotsharpObjectId === object.objectId);
		const rootInfo = {
			type: 'GLTF',
			url: objectUrl,
			name: fileName,
			iotsharpObjectId: object.objectId,
			iotsharpResourceId: object.resourceId,
		};

		await new Promise<void>((resolve) => {
			const { loaderService } = this.editor.setModelFromInfo(rootInfo, stored?.group);
			loaderService.complete = (root: any) => {
				queueMicrotask(() => {
					root.name = object.name;
					root.userData = { ...root.userData, iotsharpObjectId: object.objectId, iotsharpResourceId: object.resourceId };
					root.position.set(...object.transform.position);
					root.rotation.set(...object.transform.rotation);
					root.scale.set(...object.transform.scale);
					this.loadedModels.set(object.objectId, { objectId: object.objectId, resourceId: object.resourceId, root });
					this.editor.setOutlinePass([root]);
					this.editor.viewer.transformControls.attach(root);
					this.selectRoot(root);
					resolve();
				});
			};
		});
	}

	captureManifest(target: TwinSceneManifest): TwinSceneManifest {
		this.manifest = target;
		this.syncTransformsToManifest();
		this.editor.saveSceneEditor();
		const snapshot: ThreeEditorSnapshot = {
			sceneParams: sanitizeEditorJson(cloneJson(this.latestSceneParams)) as Record<string, unknown>,
			modelParams: cloneJson(this.latestModelParams),
			upstream: {
				repository: 'z2586300277/threejs-editor',
				editorCommit,
				coreRepository: 'z2586300277/three-editor-cores',
				coreCommit,
				license: 'Apache-2.0',
			},
		};
		target.editorExtension = { source: 'threejs-editor', payloadVersion: 2, threeEditor: snapshot };
		return target;
	}

	setSelectionMode(mode: 'select' | 'root' | 'transform') {
		this.editor.setSceneControlMode(mode === 'select' ? '选择' : mode === 'root' ? '根选择' : '变换');
	}

	setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
		this.editor.setSceneControlMode('变换');
		this.editor.setTransformControlsProperty('mode', mode);
	}

	setTransformChildren(enabled: boolean) {
		this.editor.viewer.handler.isTransformChildren = enabled;
	}

	setGrid(visible: boolean) {
		this.editor.setOperateOption('grid', visible);
		this.manifest.runtime.showGrid = visible;
	}

	setAxes(visible: boolean) {
		this.editor.setOperateOption('axes', visible);
	}

	setKeyboard(enabled: boolean) {
		this.editor.setOperateOption('openKey', enabled);
	}

	undo() {
		restoreHistoryHandler('z');
		this.syncTransformsToManifest();
		this.events.onChanged?.();
	}

	redo() {
		restoreHistoryHandler('y');
		this.syncTransformsToManifest();
		this.events.onChanged?.();
	}

	selectObject(objectId: string) {
		const root = this.loadedModels.get(objectId)?.root;
		if (!root) return;
		this.editor.setOutlinePass([root]);
		this.editor.viewer.transformControls.attach(root);
		this.selectRoot(root);
	}

	focusSelected() {
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
		model.root.disposeRoot?.();
		this.loadedModels.delete(objectId);
		this.latestModelParams = this.latestModelParams.filter((item) => item.rootInfo.iotsharpObjectId !== objectId);
		if (this.selectedObjectId === objectId) {
			this.selectedObjectId = undefined;
			this.events.onSelectionChange?.(null);
		}
		if (notify) this.events.onChanged?.();
	}

	private readonly handleSceneClick = (event: MouseEvent) => {
		if (this.disposed || event.defaultPrevented) return;
		try {
			this.editor.getSceneEvent(event, (info: any) => {
				const root = info?.currentRootModel;
				if (root?.rootInfo?.iotsharpObjectId) this.selectRoot(root, info.currentModel);
			});
		} catch {
			this.events.onError?.('threejs-editor 未能选中该对象，请切换“根选择”后重试。');
		}
	};

	private selectRoot(root: any, node = root) {
		const objectId = root.rootInfo?.iotsharpObjectId || root.userData?.iotsharpObjectId;
		if (!objectId) return;
		this.selectedObjectId = objectId;
		const segments: string[] = [];
		let current = node;
		while (current && current !== root) {
			const index = current.parent?.children?.indexOf(current) ?? -1;
			segments.unshift(current.name || `${current.type}[${index}]`);
			current = current.parent;
		}
		this.events.onSelectionChange?.({
			name: node.name || root.name || '未命名对象',
			uuid: node.uuid,
			path: `${this.manifest.name}/${root.name || objectId}`,
			kind: 'scene-object',
			objectId,
			nodePath: segments.join('/'),
		});
	}

	private syncTransformsToManifest() {
		for (const object of this.manifest.objects) {
			const root = this.loadedModels.get(object.objectId)?.root;
			if (!root) continue;
			object.name = root.name || object.name;
			object.transform.position = [root.position.x, root.position.y, root.position.z];
			object.transform.rotation = [root.rotation.x, root.rotation.y, root.rotation.z];
			object.transform.scale = [root.scale.x, root.scale.y, root.scale.z];
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.container.removeEventListener('click', this.handleSceneClick);
		this.resizeObserver.disconnect();
		this.editor?.viewer?.destroySceneRender?.();
		for (const objectUrl of this.objectUrls) URL.revokeObjectURL(objectUrl);
		this.objectUrls.clear();
		this.loadedModels.clear();
		this.editor = undefined;
	}
}
