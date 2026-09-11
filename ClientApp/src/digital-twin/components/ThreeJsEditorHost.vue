<template>
	<div ref="editorRoot" class="three-editor-host">
		<div class="three-editor-toolbar">
			<el-button-group size="small">
				<el-button :type="selectionMode === 'select' ? 'primary' : 'default'" @click="changeSelectionMode('select')">节点选择</el-button>
				<el-button :type="selectionMode === 'root' ? 'primary' : 'default'" @click="changeSelectionMode('root')">根选择</el-button>
				<el-button :type="selectionMode === 'multi' ? 'primary' : 'default'" title="左键从空白处拖框；Ctrl/Shift 可增减选择" @click="changeSelectionMode('multi')">框选多选</el-button>
			</el-button-group>
			<span v-if="selectedObjectIds.length > 1" class="multi-selection-count">已选 {{ selectedObjectIds.length }} 个</span>
			<span class="toolbar-divider"></span>
			<el-button-group size="small">
				<el-button :type="routeEditMode ? 'warning' : 'default'" @click="toggleRouteEditMode">{{ routeEditMode ? '结束路线编辑' : '路线编辑' }}</el-button>
				<el-button v-if="routeEditMode" :type="routeDrawMode ? 'warning' : 'default'" @click="toggleRouteDrawMode">{{ routeDrawMode ? '停止绘制' : '画路线' }}</el-button>
				<el-button v-if="routeEditMode" :disabled="!selectedRoutePointId" type="danger" plain @click="deleteSelectedRoutePoint">删除路线点</el-button>
			</el-button-group>
			<span class="toolbar-divider"></span>
			<el-button-group size="small"><el-button title="撤销 Ctrl+Z" @click="host?.undo()">撤销</el-button><el-button title="重做 Ctrl+Y" @click="host?.redo()">重做</el-button></el-button-group>
			<el-button-group size="small"><el-button title="拉近视角（也可使用鼠标滚轮）" @click="host?.zoomBy(0.78)">放大</el-button><el-button title="拉远视角（也可使用鼠标滚轮）" @click="host?.zoomBy(1.28)">缩小</el-button><el-button title="显示全部已加载设备" @click="host?.fitScene()">适配全景</el-button><el-button :disabled="!selectedObjectId && !selectedRoutePointId" title="聚焦当前选中对象" @click="host?.focusSelected()">聚焦选中</el-button></el-button-group>
			<el-button size="small" title="切换专业编辑画布全屏" @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
			<el-checkbox v-model="transformChildren" @change="host?.setTransformChildren(Boolean($event))">编辑子节点</el-checkbox>
			<el-checkbox v-model="showGrid" @change="host?.setGrid(Boolean($event))">网格</el-checkbox>
			<el-checkbox v-model="showAxes" @change="host?.setAxes(Boolean($event))">坐标轴</el-checkbox>
			<el-checkbox v-model="showRoute" @change="host?.setRouteOverlayVisible(Boolean($event))">路线</el-checkbox>
			<el-checkbox v-model="showPorts" @change="host?.setEngineeringOverlayVisible('ports', Boolean($event))">Port</el-checkbox>
			<el-checkbox v-model="showConnections" @change="host?.setEngineeringOverlayVisible('connections', Boolean($event))">Connection</el-checkbox>
			<el-checkbox v-model="showBounds" @change="host?.setEngineeringOverlayVisible('bounds', Boolean($event))">Bounds</el-checkbox>
			<el-checkbox v-model="keyboardEnabled" @change="host?.setKeyboard(Boolean($event))">快捷键</el-checkbox>
			<el-button-group size="small">
				<el-button @click="treeOpen = !treeOpen">{{ treeOpen ? '收起场景树' : '展开场景树' }}</el-button>
				<el-button @click="guiOpen = !guiOpen">{{ guiOpen ? '收起编辑面板' : '展开编辑面板' }}</el-button>
			</el-button-group>
		</div>

		<div v-show="treeOpen" class="three-editor-tree">
			<div class="three-editor-tree__header">
				<div class="three-editor-tree__title"><span>SCENE TREE</span><strong>{{ filteredSceneObjects.length === manifest.objects.length ? `${manifest.objects.length} 个对象` : `${filteredSceneObjects.length} / ${manifest.objects.length}` }}</strong></div>
				<el-input v-model="treeSearch" class="three-editor-tree__search" size="small" clearable placeholder="搜索名称 / ID / 类型" />
			</div>
			<div v-for="item in filteredSceneObjects" :key="item.objectId" class="three-editor-tree__item" :class="{ 'is-selected': selectedObjectIds.includes(item.objectId) }" role="button" tabindex="0" @click="selectObject(item.objectId, $event)" @dblclick.stop="startTreeRename(item)">
				<i :class="item.kind"></i>
				<el-input v-if="editingTreeObjectId === item.objectId" v-model="editingTreeName" size="small" autofocus @click.stop @dblclick.stop @keyup.enter.stop="commitTreeRename(item.objectId)" @keyup.esc.stop="cancelTreeRename" @blur="commitTreeRename(item.objectId)" />
				<span v-else :title="'双击修改名称：' + item.name">{{ item.name }}</span><small>{{ objectKindLabel(item) }}</small>
			</div>
			<div v-if="filteredSceneObjects.length === 0" class="three-editor-tree__empty">没有匹配的场景对象</div>
		</div>

		<div ref="viewport" class="three-editor-viewport"></div>
		<div v-if="marqueeRect" class="three-editor-marquee" :style="{ left: marqueeRect.left + 'px', top: marqueeRect.top + 'px', width: marqueeRect.width + 'px', height: marqueeRect.height + 'px' }"></div>
		<aside ref="gui" class="three-editor-properties" :class="{ 'is-open': guiOpen && !selectedComponent }" @pointerdown.stop @pointerup.stop @click.stop @dblclick.stop @wheel.stop></aside>
		<aside v-if="guiOpen && selectedComponent" class="three-editor-component-properties" @pointerdown.stop @pointerup.stop @click.stop @dblclick.stop @wheel.stop>
			<ComponentPropertyPanel
				:manifest="manifest"
				:object-id="selectedComponent.objectId"
				@changed="emit('changed')"
				@reload-component="reloadComponent"
				@reload-all="reloadAllComponents"
				@transform-changed="applyObjectTransform"
			/>
		</aside>
		<div v-if="routeEditMode" class="three-editor-route-hint">
			<strong>路线与模型共用专业编辑坐标系</strong>
			<span v-if="routeDrawMode">先点已有自动/手工节点可作为起点，再点击场景地面连续绘制手工路线；自动节点本身只读。</span>
			<span v-else>点击彩色路线点后可直接使用移动 Gizmo 调整位置。</span>
		</div>
		<div v-if="initializing" class="three-editor-loading">正在启动 threejs-editor…</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { TwinRouteDefinition, TwinSceneManifest, TwinSceneObjectDefinition, TwinVector3 } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import type { TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';
import { isComponentSceneObject } from '/@/digital-twin/components/ComponentConnectionEngine';
import ComponentPropertyPanel from '/@/digital-twin/components/ComponentPropertyPanel.vue';
import { ThreeEditorCoreHost } from '/@/digital-twin/editor-adapter/ThreeEditorCoreHost';
import type { TwinScreenRect } from '/@/digital-twin/editor-adapter/MultiSelectionGeometry';

const props = defineProps<{ manifest: TwinSceneManifest }>();
const emit = defineEmits<{
	(e: 'selection-change', value: TwinSelectionInfo | null): void;
	(e: 'multi-selection-change', value: string[]): void;
	(e: 'route-change', value: TwinRouteDefinition): void;
	(e: 'changed'): void;
	(e: 'ready'): void;
	(e: 'error', message: string): void;
}>();

const editorRoot = ref<HTMLDivElement>();
const viewport = ref<HTMLDivElement>();
const gui = ref<HTMLDivElement>();
const host = shallowRef<ThreeEditorCoreHost>();
const initializing = ref(true);
const fullscreen = ref(false);
const treeOpen = ref(true);
const guiOpen = ref(true);
const transformChildren = ref(false);
const showGrid = ref(props.manifest.runtime.showGrid);
const showAxes = ref(false);
const showRoute = ref(true);
const showPorts = ref(false);
const showConnections = ref(true);
const showBounds = ref(false);
const keyboardEnabled = ref(false);
const routeEditMode = ref(false);
const routeDrawMode = ref(false);
const selectionMode = ref<'select' | 'root' | 'multi'>('root');
const treeSearch = ref('');
const selectedObjectId = ref('');
const selectedObjectIds = ref<string[]>([]);
const editingTreeObjectId = ref('');
const editingTreeName = ref('');
const marqueeRect = ref<TwinScreenRect>();
const selectedRouteId = ref('');
const selectedRoutePointId = ref('');
const filteredSceneObjects = computed(() => {
	const keyword = treeSearch.value.trim().toLocaleLowerCase();
	if (!keyword) return props.manifest.objects;
	return props.manifest.objects.filter((item) => {
		const v7 = item as TwinV7SceneObjectDefinition & Record<string, any>;
		const searchable = [
			item.name,
			item.objectId,
			item.kind,
			v7.resourceId,
			v7.resourceKey,
			v7.component?.componentType,
			v7.equipment?.equipmentType,
		].filter(Boolean).join(' ').toLocaleLowerCase();
		return searchable.includes(keyword);
	});
});
const selectedComponent = computed(() => {
	if (selectedObjectIds.value.length > 1) return undefined;
	const object = (props.manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === selectedObjectId.value);
	return isComponentSceneObject(object) ? object : undefined;
});
const primaryRouteGenerated = computed(() => {
	const routeId = selectedRouteId.value || props.manifest.routes[0]?.routeId;
	return props.manifest.routes.find((route) => route.routeId === routeId)?.generatedBy === 'component-connections';
});
let resolveReady: () => void;
const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

const syncFullscreenState = () => { fullscreen.value = document.fullscreenElement === editorRoot.value; };
const toggleFullscreen = async () => {
	try {
		if (document.fullscreenElement === editorRoot.value) await document.exitFullscreen();
		else if (editorRoot.value?.requestFullscreen) await editorRoot.value.requestFullscreen();
		else ElMessage.warning('当前浏览器不支持页面全屏');
	} catch {
		ElMessage.warning('当前浏览器不允许进入全屏');
	}
};

onMounted(() => {
	document.addEventListener('fullscreenchange', syncFullscreenState);
	try {
		if (!viewport.value || !gui.value) throw new Error('threejs-editor 容器尚未就绪');
		host.value = new ThreeEditorCoreHost(viewport.value, gui.value, props.manifest, {
			onSelectionChange: (value) => {
				selectedObjectId.value = value?.kind === 'scene-object' ? value.objectId || '' : '';
				selectedRouteId.value = value?.kind === 'route-point' ? value.routeId || '' : '';
				selectedRoutePointId.value = value?.kind === 'route-point' ? value.routePointId || '' : '';
				emit('selection-change', value);
			},
			onMultiSelectionChange: (value) => {
				selectedObjectIds.value = [...value];
				if (!value.includes(selectedObjectId.value)) selectedObjectId.value = value[0] || '';
				emit('multi-selection-change', [...value]);
			},
			onMarqueeChange: (value) => { marqueeRect.value = value; },
			onRouteChange: (value) => emit('route-change', value),
			onChanged: () => emit('changed'),
			onError: (message) => emit('error', message),
		});
		host.value.setSelectionMode('root');
		host.value.setTransformMode('translate');
		host.value.setRouteOverlayVisible(showRoute.value);
		emit('ready');
	} catch (error: any) {
		emit('error', error?.message || 'threejs-editor 启动失败');
	} finally {
		initializing.value = false;
		resolveReady();
	}
});

let routeOverlayRefreshFrame = 0;
const scheduleRouteOverlayRefresh = () => {
	if (routeOverlayRefreshFrame) return;
	routeOverlayRefreshFrame = requestAnimationFrame(() => {
		routeOverlayRefreshFrame = 0;
		host.value?.refreshRouteOverlay();
	});
};
watch(() => [props.manifest.routes, props.manifest.connections], scheduleRouteOverlayRefresh, { deep: true });

const changeSelectionMode = (mode: 'select' | 'root' | 'multi') => { selectionMode.value = mode; host.value?.setSelectionMode(mode); };
const selectObject = async (objectId: string, event?: MouseEvent) => {
	await ready;
	selectedRouteId.value = ''; selectedRoutePointId.value = '';
	host.value?.selectObject(objectId, Boolean(event?.ctrlKey || event?.metaKey || event?.shiftKey));
};
const startTreeRename = (item: TwinSceneObjectDefinition) => {
	editingTreeObjectId.value = item.objectId;
	editingTreeName.value = item.name;
};
const cancelTreeRename = () => { editingTreeObjectId.value = ''; editingTreeName.value = ''; };
const commitTreeRename = (objectId: string) => {
	if (editingTreeObjectId.value !== objectId) return;
	const name = editingTreeName.value.trim();
	if (!name) { ElMessage.warning('场景对象名称不能为空'); return; }
	if (!host.value?.renameObject(objectId, name)) return;
	const item = props.manifest.objects.find((object) => object.objectId === objectId);
	if (item) item.name = name;
	cancelTreeRename();
	emit('changed');
};
const objectKindLabel = (item: TwinSceneObjectDefinition) => {
	const kind = (item as TwinV7SceneObjectDefinition).kind;
	return kind === 'model' ? 'GLB模型' : kind === 'component' ? 'V7组件' : kind === 'equipment' ? '整机对象' : '程序对象';
};
const toggleRouteEditMode = () => {
	routeEditMode.value = !routeEditMode.value;
	if (!routeEditMode.value) routeDrawMode.value = false;
	host.value?.setRouteEditMode(routeEditMode.value);
	host.value?.setRouteDrawMode(routeDrawMode.value);
};
const toggleRouteDrawMode = () => {
	routeDrawMode.value = !routeDrawMode.value;
	if (routeDrawMode.value) routeEditMode.value = true;
	host.value?.setRouteEditMode(routeEditMode.value);
	host.value?.setRouteDrawMode(routeDrawMode.value);
};
const deleteSelectedRoutePoint = () => {
	if (!host.value?.removeSelectedRoutePoint()) return;
	selectedRouteId.value = '';
	selectedRoutePointId.value = '';
};
const loadGlbBuffer = async (object: TwinSceneObjectDefinition, fileName: string, buffer: ArrayBuffer) => {
	await ready;
	if (!host.value) throw new Error('threejs-editor 未初始化');
	await host.value.loadGlbBuffer(object, fileName, buffer);
};
const reloadComponent = (objectId: string) => host.value?.reloadComponent(objectId);
const reloadAllComponents = () => host.value?.reloadAllComponents();
const applyObjectTransform = (objectId: string) => host.value?.applyObjectTransform(objectId);
const refreshRouteOverlay = () => host.value?.refreshRouteOverlay();
const setRouteEditMode = (enabled: boolean) => { routeEditMode.value = enabled; if (!enabled) routeDrawMode.value = false; host.value?.setRouteEditMode(enabled); host.value?.setRouteDrawMode(routeDrawMode.value); };
const setRouteDrawMode = (enabled: boolean) => { routeDrawMode.value = enabled; if (enabled) routeEditMode.value = true; host.value?.setRouteEditMode(routeEditMode.value); host.value?.setRouteDrawMode(enabled); };
const setRoute = (route: TwinRouteDefinition) => host.value?.setRoute(route);
const getRoute = () => host.value?.getRoute();
const updateRoutePoint = (index: number, position: TwinVector3) => host.value?.updateRoutePoint(index, position);
const addRoutePoint = (position?: TwinVector3) => host.value?.addRoutePoint(position);
const removeRoutePoint = (index: number) => host.value?.removeRoutePoint(index);
const captureManifest = (manifest: TwinSceneManifest) => host.value?.captureManifest(manifest) || manifest;
const focusSelected = () => host.value?.focusSelected();
const removeObject = (objectId: string) => host.value?.removeObject(objectId);
const getSelectedObjectIds = () => host.value?.getSelectedObjectIds() || [];
const clearSelection = () => host.value?.clearSelection();
const worldPositionFromClientPoint = async (clientX: number, clientY: number, groundY = 0) => {
	await ready;
	return host.value?.worldPositionFromClientPoint(clientX, clientY, groundY);
};
const setObjectWorldPosition = (objectId: string, position: TwinVector3) => host.value?.setObjectWorldPosition(objectId, position);
const reloadProceduralReferences = () => host.value?.reloadProceduralReferences();

defineExpose({
	loadGlbBuffer,
	captureManifest,
	focusSelected,
	removeObject,
	getSelectedObjectIds,
	clearSelection,
	selectObject,
	reloadComponent,
	reloadAllComponents,
	refreshRouteOverlay,
	setRouteEditMode,
	setRouteDrawMode,
	setRoute,
	getRoute,
	updateRoutePoint,
	addRoutePoint,
	removeRoutePoint,
	worldPositionFromClientPoint,
	setObjectWorldPosition,
	reloadProceduralReferences,
});

onBeforeUnmount(() => {
	document.removeEventListener('fullscreenchange', syncFullscreenState);
	if (routeOverlayRefreshFrame) cancelAnimationFrame(routeOverlayRefreshFrame);
	routeOverlayRefreshFrame = 0;
	host.value?.dispose();
	host.value = undefined;
});
</script>

<style scoped lang="scss">
.three-editor-host{position:absolute;inset:0;overflow:hidden;background:#050b13}.three-editor-host:fullscreen{width:100vw;height:100vh}.three-editor-viewport{position:absolute;inset:0}.three-editor-viewport :deep(canvas){display:block;width:100%;height:100%;outline:none}.three-editor-toolbar{position:absolute;top:12px;left:50%;z-index:12;display:flex;flex-flow:row nowrap;align-items:center;gap:7px;max-width:calc(100% - 40px);padding:6px 8px;border:1px solid rgba(148,163,184,.24);border-radius:10px;transform:translateX(-50%);background:rgba(12,24,40,.92);box-shadow:0 12px 36px rgba(0,0,0,.28);overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;white-space:nowrap}.three-editor-toolbar>*{flex:0 0 auto}.three-editor-toolbar :deep(.el-button-group){display:inline-flex;flex-flow:row nowrap;vertical-align:middle}.three-editor-toolbar :deep(.el-button){white-space:nowrap}.three-editor-toolbar :deep(.el-checkbox){flex:0 0 auto}.three-editor-toolbar :deep(.el-checkbox__label){font-size:11px;color:#cbd5e1}.toolbar-divider{width:1px;height:22px;flex:0 0 1px;background:rgba(148,163,184,.28)}
.multi-selection-count{padding:3px 7px;border:1px solid rgba(34,197,94,.35);border-radius:999px;font-size:10px;color:#86efac;background:rgba(22,101,52,.22)}
.three-editor-marquee{position:absolute;z-index:18;border:1px solid rgba(56,189,248,.95);background:rgba(14,165,233,.14);box-shadow:0 0 0 1px rgba(14,165,233,.18) inset;pointer-events:none}
.three-editor-tree{position:absolute;top:82px;left:12px;z-index:10;width:230px;max-height:calc(100% - 124px);padding:9px;border:1px solid rgba(148,163,184,.2);border-radius:10px;background:rgba(7,17,31,.88);overflow:auto;backdrop-filter:blur(8px)}.three-editor-tree__header{position:sticky;top:-9px;z-index:2;margin:-9px -9px 5px;padding:9px 9px 7px;background:rgba(7,17,31,.97);backdrop-filter:blur(8px)}.three-editor-tree__title{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;padding:3px 4px 8px;border-bottom:1px solid rgba(148,163,184,.18)}.three-editor-tree__title span{font-size:9px;letter-spacing:.14em;color:#38bdf8}.three-editor-tree__title strong{font-size:10px;color:#94a3b8}.three-editor-tree__search{width:100%}.three-editor-tree__search :deep(.el-input__wrapper){background:rgba(15,31,52,.9);box-shadow:0 0 0 1px rgba(148,163,184,.22) inset}.three-editor-tree__empty{padding:18px 8px;text-align:center;font-size:10px;color:#64748b}.three-editor-tree__item{display:grid;grid-template-columns:9px 1fr auto;align-items:center;gap:7px;width:100%;padding:7px;border:0;border-radius:7px;color:#cbd5e1;background:transparent;text-align:left;cursor:pointer}.three-editor-tree__item:hover,.three-editor-tree__item.is-selected{color:#fff;background:rgba(14,165,233,.18)}.three-editor-tree__item i{width:7px;height:7px;border-radius:2px;background:#64748b}.three-editor-tree__item i.model{background:#38bdf8}.three-editor-tree__item i.component{background:#22c55e}.three-editor-tree__item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.three-editor-tree__item small{font-size:9px;color:#64748b}
.three-editor-tree__item i.equipment{background:#f59e0b}
.three-editor-properties,.three-editor-component-properties{position:absolute;top:82px;right:12px;z-index:14;max-height:calc(100% - 124px);height:max-content;overflow:auto;overscroll-behavior:contain}.three-editor-properties{width:0;opacity:0;transition:width .2s ease,opacity .2s ease;pointer-events:none}.three-editor-properties.is-open{width:285px;opacity:1;pointer-events:auto}.three-editor-properties :deep(.dg.main){position:static;width:100%!important;margin:0;border:1px solid rgba(148,163,184,.22);border-radius:8px;overflow:hidden}.three-editor-properties :deep(.dg .cr){border-left:0}.three-editor-component-properties{width:320px;padding-bottom:12px;pointer-events:auto;background:linear-gradient(90deg,rgba(7,17,31,.18),rgba(7,17,31,.82) 16%,rgba(7,17,31,.96))}.three-editor-route-hint{position:absolute;left:50%;bottom:18px;z-index:12;display:flex;flex-direction:column;gap:3px;max-width:560px;padding:8px 12px;border:1px solid rgba(245,158,11,.3);border-radius:8px;transform:translateX(-50%);background:rgba(7,17,31,.9);box-shadow:0 8px 24px rgba(0,0,0,.24);pointer-events:none}.three-editor-route-hint strong{font-size:10px;color:#fbbf24}.three-editor-route-hint span{font-size:9px;color:#cbd5e1}.three-editor-loading{position:absolute;inset:0;z-index:20;display:grid;place-items:center;color:#7dd3fc;background:#050b13}
@media(max-width:1500px){.three-editor-toolbar{left:12px;right:12px;transform:none;overflow-x:auto}}
</style>
