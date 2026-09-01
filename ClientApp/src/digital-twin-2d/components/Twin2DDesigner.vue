<template>
	<div class="designer" v-loading="pageLoading">
		<header class="toolbar">
			<div class="toolbar__title">
				<div><small>IOTSHARP TWIN 2D DESIGNER</small><strong>{{ currentScene?.name || '2D 场景设计器' }}</strong></div>
				<el-select v-model="selectedSceneId" class="scene-select" placeholder="选择场景" filterable @change="loadScene">
					<el-option v-for="scene in scenes" :key="scene.id" :label="scene.name" :value="scene.id" />
				</el-select>
				<el-tag :type="currentScene?.status === 'Published' ? 'success' : 'warning'" effect="dark">{{ sceneStatus }}</el-tag>
				<el-tag v-if="dirty" type="danger" effect="plain">未保存</el-tag>
			</div>
			<div class="toolbar__actions">
				<el-button-group>
					<el-button :disabled="historyIndex <= 0 || mode === 'runtime'" @click="undo">撤销</el-button>
					<el-button :disabled="historyIndex >= history.length - 1 || mode === 'runtime'" @click="redo">重做</el-button>
				</el-button-group>
				<el-segmented v-model="mode" :options="modeOptions" />
				<el-button @click="templatePreviewVisible = true">亚特模板预览</el-button>
				<el-button @click="createDialogVisible = true">新建场景</el-button>
				<el-button :disabled="!currentScene" :loading="saving" @click="saveDraft">保存草稿</el-button>
				<el-button :disabled="!currentScene" @click="validateScene">场景校验</el-button>
				<el-button type="success" :disabled="!currentScene" :loading="publishing" @click="publishScene">发布</el-button>
				<el-dropdown trigger="click"><el-button>更多</el-button><template #dropdown><el-dropdown-menu>
					<el-dropdown-item @click="openVersions">版本与回滚</el-dropdown-item>
					<el-dropdown-item @click="router.push('/iot/digital-twin/scenes')">场景中心</el-dropdown-item>
					<el-dropdown-item @click="router.push('/iot/digital-twin/workbench')">三维场景</el-dropdown-item>
				</el-dropdown-menu></template></el-dropdown>
			</div>
		</header>

		<div v-if="mode === 'runtime'" class="runtime-strip">
			<span><b>TELEMETRY</b> {{ polling ? '轮询中' : '暂停' }}</span>
			<span>Bindings {{ manifest.bindings.length }}</span>
			<span class="is-good">Good {{ runtimeCounts.good }}</span>
			<span class="is-warning">Stale {{ runtimeCounts.stale }}</span>
			<span class="is-danger">Bad {{ runtimeCounts.bad }}</span>
			<span>Published v{{ currentScene?.publishedVersion || '-' }}</span>
		</div>

		<main class="workspace">
			<aside class="panel panel--left">
				<el-tabs v-model="leftTab" stretch>
					<el-tab-pane label="2D 模型库" name="library">
						<el-input v-model="libraryKeyword" clearable placeholder="搜索模型" />
						<div class="library">
							<div v-for="item in filteredLibrary" :key="item.resourceKey" class="library-card" draggable="true" @dragstart="beginLibraryDrag($event, item)">
								<div class="library-icon"><span :class="`symbol-${item.symbolKey}`"></span></div>
								<div><strong>{{ item.name }}</strong><small>{{ item.category }}</small><p>{{ item.description }}</p></div>
								<el-button link type="primary" @click="addLibraryItem(item)">添加</el-button>
							</div>
						</div>
					</el-tab-pane>
					<el-tab-pane label="场景树" name="tree">
						<div class="scene-summary"><strong>{{ manifest.name }}</strong><small>{{ view.objects.length }} 个 2D 对象</small></div>
						<div class="tree-list">
							<div v-for="item in orderedObjects" :key="item.id" :class="{ selected: item.id === selectedObjectId }" @click="selectObject(item.id)">
								<span>{{ item.hidden ? '◌' : '●' }}</span><b>{{ item.name }}</b><small>{{ item.businessObjectId ? '已关联' : '纯2D' }}</small>
							</div>
						</div>
					</el-tab-pane>
				</el-tabs>
			</aside>

			<section class="stage-shell">
				<div class="stage-tools">
					<el-button-group size="small"><el-button @click="zoomBy(0.85)">放大</el-button><el-button @click="zoomBy(1.18)">缩小</el-button><el-button @click="resetViewport">复位</el-button></el-button-group>
					<el-checkbox v-model="view.canvas.showGrid" :disabled="mode === 'runtime'" @change="markDirty">网格</el-checkbox>
					<el-checkbox v-model="view.canvas.snapToGrid" :disabled="mode === 'runtime'" @change="markDirty">吸附</el-checkbox>
					<span>Zoom {{ zoomPercent }}%</span>
				</div>
				<svg ref="canvas" class="canvas" :viewBox="`${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`" :style="{ background: view.canvas.background }"
					@wheel.prevent="handleWheel" @mousedown="handleCanvasDown" @mousemove="handleCanvasMove" @mouseup="endInteraction" @mouseleave="endInteraction" @dragover.prevent @drop.prevent="handleDrop">
					<defs><pattern id="twin2d-grid" :width="view.canvas.gridSize" :height="view.canvas.gridSize" patternUnits="userSpaceOnUse"><path :d="`M ${view.canvas.gridSize} 0 L 0 0 0 ${view.canvas.gridSize}`" fill="none" stroke="rgba(148,163,184,.16)" stroke-width="1" /></pattern></defs>
					<rect x="0" y="0" :width="view.canvas.width" :height="view.canvas.height" :fill="view.canvas.showGrid ? 'url(#twin2d-grid)' : view.canvas.background" />

					<g class="routes" opacity=".8">
						<template v-for="routeItem in manifest.routes" :key="routeItem.routeId"><line v-for="edge in routeItem.edges" :key="edge.edgeId" v-bind="edgeLine(edge, routeItem)" class="route-edge" /></template>
						<circle v-for="point in visibleRoutePoints" :key="point.id" :cx="point.x" :cy="point.y" r="7" class="route-point"><title>{{ point.name }}</title></circle>
					</g>

					<g v-for="item in orderedObjects" v-show="!item.hidden && runtimeState(item).visible" :key="item.id" :data-object-id="item.id"
						:transform="`translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})`" class="scene-object"
						:class="{ selected: selectedObjectId === item.id, 'is-running': runtimeState(item).running, 'is-fault': runtimeState(item).fault, 'is-stale': runtimeState(item).quality === 'stale' }"
						:opacity="item.opacity ?? 1" @mousedown.stop="startMove($event, item)" @dblclick.stop="openRuntimeDialog(item)">
						<template v-if="item.symbolKey === 'conveyor-small' || item.symbolKey === 'conveyor-large'">
							<rect x="0" y="0" :width="item.width" :height="item.height" rx="10" :fill="objectFill(item)" :stroke="item.stroke || '#60a5fa'" stroke-width="3" />
							<line v-for="n in 7" :key="n" :x1="(item.width / 8) * n" y1="8" :x2="(item.width / 8) * n" :y2="item.height - 8" stroke="rgba(226,232,240,.38)" stroke-width="3" />
							<path class="flow-marker" :d="`M 14 ${item.height / 2} H ${item.width - 14}`" fill="none" stroke="#e0f2fe" stroke-width="4" stroke-dasharray="18 14" />
						</template>
						<template v-else-if="item.symbolKey === 'turntable'">
							<circle :cx="item.width/2" :cy="item.height/2" :r="Math.min(item.width,item.height)/2-5" :fill="objectFill(item)" stroke="#38bdf8" stroke-width="4"/><path :d="`M ${item.width*.25} ${item.height*.5} H ${item.width*.75} M ${item.width*.62} ${item.height*.35} L ${item.width*.78} ${item.height*.5} L ${item.width*.62} ${item.height*.65}`" fill="none" stroke="#e0f2fe" stroke-width="5"/>
					</template>
					<template v-else-if="item.symbolKey === 'robot'">
						<circle :cx="item.width*.5" :cy="item.height*.72" :r="item.height*.18" :fill="objectFill(item)" stroke="#22d3ee" stroke-width="4"/><path :d="`M ${item.width*.5} ${item.height*.62} L ${item.width*.42} ${item.height*.38} L ${item.width*.62} ${item.height*.25} L ${item.width*.72} ${item.height*.42}`" fill="none" stroke="#e0f2fe" stroke-width="9" stroke-linecap="round" />
					</template>
					<template v-else-if="item.symbolKey === 'gantry'">
						<path :d="`M 12 ${item.height-12} V 18 H ${item.width-12} V ${item.height-12} M 12 45 H ${item.width-12}`" fill="none" stroke="#67e8f9" stroke-width="8"/><rect :x="item.width*.42" y="38" :width="item.width*.16" :height="item.height*.45" :fill="objectFill(item)" rx="6"/>
					</template>
					<template v-else-if="item.symbolKey === 'buffer'">
						<rect x="0" y="0" :width="item.width" :height="item.height" rx="8" :fill="objectFill(item)" stroke="#818cf8" stroke-width="3"/><line v-for="n in 4" :key="n" :x1="item.width/5*n" y1="8" :x2="item.width/5*n" :y2="item.height-8" stroke="#c7d2fe" stroke-width="2"/>
					</template>
					<template v-else-if="item.symbolKey === 'pallet'">
						<rect x="3" y="8" :width="item.width-6" :height="item.height-16" rx="6" :fill="objectFill(item)" stroke="#a7f3d0" stroke-width="3"/><line x1="8" :y1="item.height*.45" :x2="item.width-8" :y2="item.height*.45" stroke="#ecfdf5" stroke-width="3"/>
					</template>
					<template v-else>
						<rect x="0" y="0" :width="item.width" :height="item.height" rx="12" :fill="objectFill(item)" :stroke="item.stroke || '#60a5fa'" stroke-width="3"/><path v-if="item.symbolKey === 'inspection'" :d="`M ${item.width*.35} ${item.height*.25} L ${item.width*.65} ${item.height*.75} M ${item.width*.65} ${item.height*.25} L ${item.width*.35} ${item.height*.75}`" stroke="#e0f2fe" stroke-width="5"/><path v-if="item.symbolKey === 'bagging'" :d="`M ${item.width*.36} ${item.height*.2} H ${item.width*.64} L ${item.width*.72} ${item.height*.78} H ${item.width*.28} Z`" fill="none" stroke="#e0f2fe" stroke-width="4"/>
					</template>
					<text v-if="item.symbolKey !== 'label'" :x="item.width/2" :y="item.height + 22" text-anchor="middle" class="object-label">{{ item.name }}</text>
					<text v-else :x="item.width/2" :y="item.height/2+8" text-anchor="middle" class="label-symbol">{{ item.name }}</text>
					<g v-if="mode === 'runtime' && item.businessObjectId" class="runtime-badge"><rect :x="Math.max(0,item.width-82)" y="-26" width="82" height="22" rx="7"/><text :x="item.width-41" y="-11" text-anchor="middle">{{ runtimeState(item).statusText }}</text></g>
					<rect v-if="selectedObjectId === item.id && mode === 'design'" x="-7" y="-7" :width="item.width+14" :height="item.height+14" fill="none" stroke="#fbbf24" stroke-width="3" stroke-dasharray="9 6" />
					<rect v-if="selectedObjectId === item.id && mode === 'design'" :x="item.width-7" :y="item.height-7" width="15" height="15" rx="2" fill="#fbbf24" stroke="#fff" stroke-width="2" class="resize-handle" @mousedown.stop="startResize($event,item)" />
				</g>
				</svg>
				<div class="canvas-hint">{{ mode === 'design' ? '拖拽模型到画布 · 拖动对象 · 右下角缩放 · 属性面板旋转 · 中键拖动画布' : '运行预览只读取已发布版本 Telemetry，不修改真实设备' }}</div>
			</section>

			<aside class="panel panel--right">
				<template v-if="selectedObject">
					<div class="panel-heading"><div><small>PROPERTIES</small><strong>{{ selectedObject.name }}</strong></div><el-button link type="danger" :disabled="mode==='runtime'" @click="removeSelected">删除</el-button></div>
					<el-tabs v-model="rightTab">
						<el-tab-pane label="基础" name="base">
							<el-form label-position="top" size="small">
								<el-form-item label="名称"><el-input v-model="selectedObject.name" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item>
								<div class="property-grid"><el-form-item label="X"><el-input-number v-model="selectedObject.x" :disabled="mode==='runtime'" @change="normalizeSelected" /></el-form-item><el-form-item label="Y"><el-input-number v-model="selectedObject.y" :disabled="mode==='runtime'" @change="normalizeSelected" /></el-form-item></div>
								<div class="property-grid"><el-form-item label="宽"><el-input-number v-model="selectedObject.width" :min="20" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item><el-form-item label="高"><el-input-number v-model="selectedObject.height" :min="20" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item></div>
								<el-form-item label="旋转"><el-slider v-model="selectedObject.rotation" :min="-180" :max="180" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item>
								<el-form-item label="业务对象"><el-select v-model="selectedObject.businessObjectId" clearable filterable :disabled="mode==='runtime'" placeholder="关联 Manifest 对象后可绑定遥测" @change="businessObjectChanged"><el-option v-for="item in manifest.objects" :key="item.objectId" :label="item.name" :value="item.objectId" /></el-select></el-form-item>
								<el-checkbox v-model="selectedObject.locked" :disabled="mode==='runtime'" @change="markDirty">锁定</el-checkbox><el-checkbox v-model="selectedObject.hidden" :disabled="mode==='runtime'" @change="markDirty">隐藏</el-checkbox>
							</el-form>
						</el-tab-pane>
						<el-tab-pane label="外观" name="style">
							<el-form label-position="top" size="small"><el-form-item label="填充颜色"><el-color-picker v-model="selectedObject.fill" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item><el-form-item label="边框颜色"><el-color-picker v-model="selectedObject.stroke" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item><el-form-item label="透明度"><el-slider v-model="selectedObject.opacity" :min="0.1" :max="1" :step="0.05" :disabled="mode==='runtime'" @change="markDirty" /></el-form-item></el-form>
						</el-tab-pane>
						<el-tab-pane label="数据绑定" name="binding">
							<el-alert v-if="!selectedObject.businessObjectId" type="warning" :closable="false" title="先在“基础”中关联已有业务对象，再建立 Telemetry Binding。" />
							<template v-else>
								<div class="binding-list"><div v-for="binding in selectedBindings" :key="binding.bindingId"><div><strong>{{ binding.source.kind }} · {{ binding.source.key || '-' }}</strong><small>{{ binding.target.kind }} · stale {{ binding.staleAfterMs }}ms</small></div><el-button link type="danger" :disabled="mode==='runtime'" @click="removeBinding(binding.bindingId)">删除</el-button></div></div>
								<el-divider>新增 Telemetry Binding</el-divider>
								<el-form label-position="top" size="small"><el-form-item label="Device"><el-select v-model="bindingForm.deviceId" filterable :disabled="mode==='runtime'" placeholder="选择根 Asset 下设备"><el-option v-for="device in assetDevices" :key="device.id" :label="device.name" :value="device.id" /></el-select></el-form-item><el-form-item label="Telemetry Key"><el-select v-model="bindingForm.key" filterable allow-create default-first-option :disabled="mode==='runtime'" placeholder="选择或输入遥测 Key"><el-option v-for="key in telemetryKeys" :key="key" :label="key" :value="key" /></el-select></el-form-item><el-form-item label="目标"><el-select v-model="bindingForm.targetKind" :disabled="mode==='runtime'"><el-option label="运行动画" value="animation"/><el-option label="可见性" value="visible"/><el-option label="颜色" value="color"/><el-option label="文字" value="text"/></el-select></el-form-item><el-button type="primary" :disabled="!canAddBinding || mode==='runtime'" @click="addBinding">添加绑定</el-button></el-form>
							</template>
						</el-tab-pane>
						<el-tab-pane label="运行态" name="runtime">
							<div class="runtime-card"><el-tag :type="runtimeTagType(runtimeState(selectedObject))">{{ runtimeState(selectedObject).statusText }}</el-tag><p>Quality: {{ runtimeState(selectedObject).quality }}</p><p>Updated: {{ runtimeState(selectedObject).lastUpdated || '-' }}</p><pre>{{ JSON.stringify(runtimeState(selectedObject).values, null, 2) }}</pre></div>
						</el-tab-pane>
					</el-tabs>
				</template>
				<el-empty v-else description="选择画布对象查看属性" />
			</aside>
		</main>

		<footer class="statusbar"><span>Objects {{ view.objects.length }}</span><span>Business {{ linkedObjectCount }}</span><span>Bindings {{ manifest.bindings.length }}</span><span>Grid {{ view.canvas.gridSize }}</span><span>View {{ Math.round(viewport.x) }}, {{ Math.round(viewport.y) }}</span></footer>

		<el-dialog v-model="createDialogVisible" title="新建 2D 数字孪生场景" width="520px"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="createForm.name" /></el-form-item><el-form-item label="Root Asset"><el-select v-model="createForm.rootAssetId" filterable style="width:100%"><el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" /></el-select></el-form-item><el-form-item label="说明"><el-input v-model="createForm.description" type="textarea" /></el-form-item></el-form><template #footer><el-button @click="createDialogVisible=false">取消</el-button><el-button type="primary" :loading="creating" :disabled="!createForm.name.trim() || !createForm.rootAssetId" @click="createScene">创建</el-button></template></el-dialog>

		<el-drawer v-model="validationDrawerVisible" title="2D 场景校验" size="560px"><el-empty v-if="diagnostics.length===0" description="没有诊断项"/><div class="diagnostics"><el-alert v-for="(item,index) in diagnostics" :key="index" :type="item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'info'" :title="item.message" :description="item.path || item.code" :closable="false" show-icon/></div></el-drawer>
		<el-drawer v-model="versionsDrawerVisible" title="发布版本与回滚" size="560px"><el-empty v-if="versions.length===0" description="尚无发布版本"/><el-timeline v-else><el-timeline-item v-for="version in versions" :key="version.id" :timestamp="formatDate(version.createdAt)" :type="version.isCurrent?'success':'primary'"><div class="version-card"><strong>v{{version.version}} <el-tag v-if="version.isCurrent" size="small" type="success">当前</el-tag></strong><span>{{version.changeSummary || '无变更说明'}}</span><small>来源草稿 r{{version.sourceDraftRevision}}</small><el-button v-if="!version.isCurrent" size="small" @click="rollbackVersion(version.version)">回滚到此版本</el-button></div></el-timeline-item></el-timeline></el-drawer>
		<el-drawer v-model="templatePreviewVisible" title="亚特包装线 · 原始 2D 模板预览" size="94%" direction="btt"><YtPack2dScene /></el-drawer>
		<el-dialog v-model="runtimeDialogVisible" :title="runtimeDialogObject?.name || '设备运行态'" width="520px"><template v-if="runtimeDialogObject"><el-descriptions :column="1" border><el-descriptions-item label="业务对象">{{ runtimeDialogObject.businessObjectId || '未关联' }}</el-descriptions-item><el-descriptions-item label="状态">{{ runtimeState(runtimeDialogObject).statusText }}</el-descriptions-item><el-descriptions-item label="Quality">{{ runtimeState(runtimeDialogObject).quality }}</el-descriptions-item><el-descriptions-item label="更新时间">{{ runtimeState(runtimeDialogObject).lastUpdated || '-' }}</el-descriptions-item></el-descriptions><pre class="runtime-json">{{ JSON.stringify(runtimeState(runtimeDialogObject).values,null,2) }}</pre></template></el-dialog>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { assetApi } from '/@/api/asset';
import { digitalTwinApi, type DigitalTwinSceneDetail, type DigitalTwinSceneSummary, type TwinDataUpdate, type TwinRuntimeSnapshot, type TwinSceneVersion } from '/@/api/digital-twin';
import { createDefaultTwinSceneManifest, type TwinObjectBindingDefinition, type TwinSceneManifest } from '/@/digital-twin/contracts';
import { createTwin2DLibraryObject, twin2DBuiltInLibrary, type Twin2DLibraryItem } from '../library';
import { resolveTwin2DRuntimeStates, type Twin2DObjectRuntimeState } from '../runtime';
import { createDefaultTwin2DView, ensureTwin2DView, snap2DValue, validateTwin2DView, type Twin2DObjectView, type Twin2DValidationDiagnostic, type Twin2DViewDefinition, type TwinSceneManifestWith2D } from '../types';
import YtPack2dScene from '/@/views/iot/digital-twin/yt-pack-2d/index.vue';

interface AssetOption { id: string; name: string }
interface AssetDevice { id: string; name: string; temps?: Array<{ keyName?: string; name?: string }>; attrs?: Array<{ keyName?: string; name?: string }> }
interface InteractionState { type: 'move' | 'resize' | 'pan'; objectId?: string; startX: number; startY: number; objectX?: number; objectY?: number; width?: number; height?: number; viewportX?: number; viewportY?: number }

const router = useRouter();
const canvas = ref<SVGSVGElement>();
const scenes = ref<DigitalTwinSceneSummary[]>([]);
const currentScene = ref<DigitalTwinSceneDetail>();
const selectedSceneId = ref('');
const manifest = ref<TwinSceneManifest>(createDefaultTwinSceneManifest());
const view = ref<Twin2DViewDefinition>(createDefaultTwin2DView());
const assets = ref<AssetOption[]>([]);
const assetDevices = ref<AssetDevice[]>([]);
const versions = ref<TwinSceneVersion[]>([]);
const selectedObjectId = ref('');
const mode = ref<'design'|'runtime'>('design');
const leftTab = ref('library');
const rightTab = ref('base');
const libraryKeyword = ref('');
const dirty = ref(false);
const pageLoading = ref(false), saving = ref(false), publishing = ref(false), creating = ref(false);
const createDialogVisible = ref(false), validationDrawerVisible = ref(false), versionsDrawerVisible = ref(false), templatePreviewVisible = ref(false), runtimeDialogVisible = ref(false);
const diagnostics = ref<Twin2DValidationDiagnostic[]>([]);
const runtimeUpdates = ref<TwinDataUpdate[]>([]);
const polling = ref(false);
const runtimeDialogObject = ref<Twin2DObjectView>();
const viewport = reactive({ x: 0, y: 0, w: 1600, h: 1000 });
const interaction = ref<InteractionState>();
const draggingLibraryItem = ref<Twin2DLibraryItem>();
const history = ref<Twin2DViewDefinition[]>([]);
const historyIndex = ref(-1);
let pollTimer: number | undefined;
const createForm = reactive({ name: '新建 2D 数字孪生场景', rootAssetId: '', description: '' });
const bindingForm = reactive({ deviceId: '', key: '', targetKind: 'animation' as 'animation'|'visible'|'color'|'text' });
const modeOptions = [{ label: '设计模式', value: 'design' }, { label: '运行预览', value: 'runtime' }];
const apiData = <T,>(response: any): T => response?.data as T;

const selectedObject = computed(() => view.value.objects.find((item) => item.id === selectedObjectId.value));
const orderedObjects = computed(() => [...view.value.objects].sort((a,b) => a.zIndex-b.zIndex));
const filteredLibrary = computed(() => { const key=libraryKeyword.value.trim().toLowerCase(); return !key ? twin2DBuiltInLibrary : twin2DBuiltInLibrary.filter((item)=>`${item.name} ${item.category} ${item.description}`.toLowerCase().includes(key)); });
const selectedBindings = computed(() => selectedObject.value?.businessObjectId ? manifest.value.bindings.filter((item)=>item.objectId===selectedObject.value!.businessObjectId) : []);
const selectedDevice = computed(() => assetDevices.value.find((item)=>item.id===bindingForm.deviceId));
const telemetryKeys = computed(() => (selectedDevice.value?.temps || []).map((item)=>item.keyName || item.name || '').filter(Boolean));
const canAddBinding = computed(() => Boolean(selectedObject.value?.businessObjectId && bindingForm.deviceId && bindingForm.key));
const runtimeStates = computed(() => resolveTwin2DRuntimeStates(view.value.objects, manifest.value, runtimeUpdates.value));
const linkedObjectCount = computed(() => view.value.objects.filter((item)=>item.businessObjectId).length);
const zoomPercent = computed(() => Math.round(1600 / viewport.w * 100));
const sceneStatus = computed(() => currentScene.value ? `${currentScene.value.status} · r${currentScene.value.revision}` : '本地空白');
const runtimeCounts = computed(() => Object.values(runtimeStates.value).reduce((acc,state)=>{ if(state.quality==='stale') acc.stale++; else if(['bad','missing'].includes(state.quality)) acc.bad++; else acc.good++; return acc; },{good:0,stale:0,bad:0}));
const visibleRoutePoints = computed(() => (manifest.value.routes || []).flatMap((route)=>route.points.map((point)=>({ id:`${route.routeId}:${point.pointId}`, name:point.name, ...(view.value.routePoints[point.pointId] || {x:0,y:0}) }))));

const edgeLine = (edge:any, route:any) => { const from=view.value.routePoints[edge.fromPointId] || {x:0,y:0}; const to=view.value.routePoints[edge.toPointId] || {x:0,y:0}; return { x1:from.x,y1:from.y,x2:to.x,y2:to.y,'data-route':route.routeId }; };
const runtimeState = (item:Twin2DObjectView): Twin2DObjectRuntimeState => runtimeStates.value[item.id] || { quality:'good',running:false,fault:false,visible:true,statusText:'UNBOUND',values:{} };
const runtimeTagType = (state:Twin2DObjectRuntimeState) => state.fault ? 'danger' : state.quality==='stale' ? 'warning' : state.running ? 'success' : 'info';
const objectFill = (item:Twin2DObjectView) => { const state=runtimeState(item); if(mode.value==='runtime'){ if(state.fault || ['bad','missing'].includes(state.quality)) return '#7f1d1d'; if(state.quality==='stale') return '#4c1d95'; if(state.running) return '#166534'; } return item.fill || '#1e3a8a'; };
const formatDate = (value:string) => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '-';
const markDirty = () => { if(mode.value==='design') dirty.value=true; };
const cloneView = () => structuredClone(view.value);
const pushHistory = () => { const snapshot=cloneView(); history.value=history.value.slice(0,historyIndex.value+1); history.value.push(snapshot); if(history.value.length>60) history.value.shift(); historyIndex.value=history.value.length-1; };
const resetHistory = () => { history.value=[cloneView()]; historyIndex.value=0; };
const undo = () => { if(historyIndex.value<=0)return; historyIndex.value--; view.value=structuredClone(history.value[historyIndex.value]); markDirty(); };
const redo = () => { if(historyIndex.value>=history.value.length-1)return; historyIndex.value++; view.value=structuredClone(history.value[historyIndex.value]); markDirty(); };

const loadAssets = async () => { try { const response=await assetApi().assetList({offset:0,limit:500,name:''}); assets.value=response.data?.rows || []; } catch { assets.value=[]; } };
const loadAssetDevices = async (assetId?:string) => { assetDevices.value=[]; if(!assetId)return; try { const response=await assetApi().relations({assetId}); assetDevices.value=response.data?.rows || []; } catch { assetDevices.value=[]; } };
const loadScenes = async () => { const response=await digitalTwinApi.listScenes(); scenes.value=apiData<DigitalTwinSceneSummary[]>(response) || []; if(!selectedSceneId.value && scenes.value.length){ selectedSceneId.value=scenes.value[0].id; await loadScene(); } };
const loadScene = async () => { if(!selectedSceneId.value)return; stopPolling(); pageLoading.value=true; try { const detail=apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(selectedSceneId.value)); currentScene.value=detail; manifest.value=structuredClone(detail.draftPayload); view.value=ensureTwin2DView(manifest.value as TwinSceneManifestWith2D); selectedObjectId.value=view.value.objects[0]?.id || ''; dirty.value=false; resetHistory(); await loadAssetDevices(detail.rootAssetId); if(mode.value==='runtime') startPolling(); } catch(error:any){ ElMessage.error(error?.msg || error?.message || '2D 场景加载失败'); } finally { pageLoading.value=false; } };

const createScene = async () => { creating.value=true; try { const draft=createDefaultTwinSceneManifest(); draft.name=createForm.name.trim(); draft.description=createForm.description.trim(); draft.rootAssetId=createForm.rootAssetId; (draft as TwinSceneManifestWith2D).view2d=createDefaultTwin2DView(); const detail=apiData<DigitalTwinSceneDetail>(await digitalTwinApi.createScene({name:draft.name,description:draft.description,rootAssetId:draft.rootAssetId,draftPayload:draft})); createDialogVisible.value=false; await loadScenes(); selectedSceneId.value=detail.id; await loadScene(); ElMessage.success('2D 场景已创建'); } catch(error:any){ ElMessage.error(error?.msg || error?.message || '创建失败'); } finally { creating.value=false; } };
const saveDraft = async () => { if(!currentScene.value)return; saving.value=true; try { const payload=structuredClone(manifest.value) as TwinSceneManifestWith2D; payload.view2d=cloneView(); await digitalTwinApi.saveDraft(currentScene.value.id,currentScene.value.revision,payload); ElMessage.success('2D 草稿已保存'); dirty.value=false; await loadScene(); } catch(error:any){ ElMessage.error(error?.msg || error?.message || '保存失败'); } finally { saving.value=false; } };
const validateScene = async () => { diagnostics.value=validateTwin2DView(view.value,manifest.value); if(currentScene.value){ try { const result=apiData<any>(await digitalTwinApi.validateScene(currentScene.value.id,false)); diagnostics.value.push(...(result?.diagnostics || [])); } catch(error:any){ diagnostics.value.push({severity:'error',code:'server.validate',message:error?.msg || error?.message || '后端校验失败'}); } } validationDrawerVisible.value=true; if(!diagnostics.value.some((item)=>item.severity==='error')) ElMessage.success('场景校验未发现阻断项'); };
const publishScene = async () => { if(!currentScene.value)return; if(dirty.value){ ElMessage.warning('请先保存草稿再发布'); return; } await validateScene(); if(diagnostics.value.some((item)=>item.severity==='error')) return; try { await ElMessageBox.confirm('发布后将生成不可变版本，2D 运行预览会读取该版本的 Telemetry Binding。','确认发布',{type:'warning'}); publishing.value=true; await digitalTwinApi.publishScene(currentScene.value.id,currentScene.value.revision,'2D 场景设计器发布'); ElMessage.success('发布成功'); validationDrawerVisible.value=false; await loadScene(); } catch(error:any){ if(error!=='cancel') ElMessage.error(error?.msg || error?.message || '发布失败'); } finally { publishing.value=false; } };
const openVersions = async () => { if(!currentScene.value)return; try { versions.value=apiData<TwinSceneVersion[]>(await digitalTwinApi.listVersions(currentScene.value.id)) || []; versionsDrawerVisible.value=true; } catch(error:any){ ElMessage.error(error?.msg || error?.message || '版本加载失败'); } };
const rollbackVersion = async (version:number) => { if(!currentScene.value)return; try { await ElMessageBox.confirm(`确定回滚到发布版本 v${version}？`,'版本回滚',{type:'warning'}); await digitalTwinApi.rollback(currentScene.value.id,version); ElMessage.success(`已回滚到 v${version}`); versionsDrawerVisible.value=false; await loadScene(); } catch(error:any){ if(error!=='cancel') ElMessage.error(error?.msg || error?.message || '回滚失败'); } };

const beginLibraryDrag = (event:DragEvent,item:Twin2DLibraryItem) => { draggingLibraryItem.value=item; event.dataTransfer?.setData('text/plain',item.resourceKey); if(event.dataTransfer) event.dataTransfer.effectAllowed='copy'; };
const clientPoint = (event:{clientX:number;clientY:number}) => { const svg=canvas.value; if(!svg)return {x:0,y:0}; const point=svg.createSVGPoint(); point.x=event.clientX; point.y=event.clientY; const matrix=svg.getScreenCTM()?.inverse(); return matrix ? point.matrixTransform(matrix) : {x:0,y:0}; };
const addLibraryItem = (item:Twin2DLibraryItem,x=viewport.x+viewport.w/2-item.width/2,y=viewport.y+viewport.h/2-item.height/2) => { if(mode.value==='runtime')return; pushHistory(); const object=createTwin2DLibraryObject(item,snap2DValue(x,view.value),snap2DValue(y,view.value),view.value.objects.length+1); view.value.objects.push(object); selectedObjectId.value=object.id; dirty.value=true; leftTab.value='tree'; };
const handleDrop = (event:DragEvent) => { const item=draggingLibraryItem.value || twin2DBuiltInLibrary.find((entry)=>entry.resourceKey===event.dataTransfer?.getData('text/plain')); if(!item)return; const point=clientPoint(event); addLibraryItem(item,point.x-item.width/2,point.y-item.height/2); draggingLibraryItem.value=undefined; };
const selectObject = (id:string) => { selectedObjectId.value=id; };
const startMove = (event:MouseEvent,item:Twin2DObjectView) => { selectObject(item.id); if(mode.value==='runtime' || item.locked)return; pushHistory(); const point=clientPoint(event); interaction.value={type:'move',objectId:item.id,startX:point.x,startY:point.y,objectX:item.x,objectY:item.y}; };
const startResize = (event:MouseEvent,item:Twin2DObjectView) => { if(mode.value==='runtime' || item.locked)return; pushHistory(); const point=clientPoint(event); interaction.value={type:'resize',objectId:item.id,startX:point.x,startY:point.y,width:item.width,height:item.height}; };
const handleCanvasDown = (event:MouseEvent) => { if(event.button!==1 && event.target!==canvas.value && (event.target as Element)?.tagName!=='rect')return; if(event.button===1 || (event.target as Element)?.getAttribute('fill')?.includes('url(') || event.target===canvas.value){ const point=clientPoint(event); interaction.value={type:'pan',startX:point.x,startY:point.y,viewportX:viewport.x,viewportY:viewport.y}; } };
const handleCanvasMove = (event:MouseEvent) => { const state=interaction.value; if(!state)return; const point=clientPoint(event); if(state.type==='pan'){ viewport.x=(state.viewportX||0)-(point.x-state.startX); viewport.y=(state.viewportY||0)-(point.y-state.startY); return; } const item=view.value.objects.find((entry)=>entry.id===state.objectId); if(!item)return; if(state.type==='move'){ item.x=snap2DValue((state.objectX||0)+(point.x-state.startX),view.value); item.y=snap2DValue((state.objectY||0)+(point.y-state.startY),view.value); } else { item.width=Math.max(20,snap2DValue((state.width||20)+(point.x-state.startX),view.value)); item.height=Math.max(20,snap2DValue((state.height||20)+(point.y-state.startY),view.value)); } dirty.value=true; };
const endInteraction = () => { if(interaction.value && interaction.value.type!=='pan') pushHistory(); interaction.value=undefined; };
const removeSelected = () => { if(!selectedObject.value)return; pushHistory(); view.value.objects=view.value.objects.filter((item)=>item.id!==selectedObjectId.value); selectedObjectId.value=view.value.objects[0]?.id || ''; dirty.value=true; pushHistory(); };
const normalizeSelected = () => { if(!selectedObject.value)return; selectedObject.value.x=snap2DValue(selectedObject.value.x,view.value); selectedObject.value.y=snap2DValue(selectedObject.value.y,view.value); markDirty(); };
const businessObjectChanged = () => { bindingForm.deviceId=''; bindingForm.key=''; markDirty(); };

const addBinding = () => { if(!selectedObject.value?.businessObjectId || !canAddBinding.value)return; const transformKind = bindingForm.targetKind==='animation' ? 'booleanAnimation' : bindingForm.targetKind==='visible' ? 'booleanVisibility' : bindingForm.targetKind==='text' ? 'formatText' : 'identity'; const binding:TwinObjectBindingDefinition={ bindingId:`2d-binding-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, objectId:selectedObject.value.businessObjectId, source:{kind:'telemetry',deviceId:bindingForm.deviceId,key:bindingForm.key}, target:{kind:bindingForm.targetKind}, transform:{kind:transformKind}, staleAfterMs:3000, enabled:true }; manifest.value.bindings.push(binding); dirty.value=true; bindingForm.key=''; ElMessage.success('Telemetry Binding 已加入草稿'); };
const removeBinding = (bindingId:string) => { manifest.value.bindings=manifest.value.bindings.filter((item)=>item.bindingId!==bindingId); dirty.value=true; };

const pollSnapshot = async () => { if(!currentScene.value?.publishedVersion)return; try { const snapshot=apiData<TwinRuntimeSnapshot>(await digitalTwinApi.snapshot(currentScene.value.id,currentScene.value.publishedVersion)); runtimeUpdates.value=snapshot?.updates || []; } catch(error:any){ stopPolling(); ElMessage.warning(error?.msg || error?.message || 'Telemetry Snapshot 获取失败'); } };
const startPolling = () => { stopPolling(); if(!currentScene.value?.publishedVersion){ ElMessage.info('当前场景尚未发布，运行预览暂无生产 Telemetry 快照'); return; } polling.value=true; pollSnapshot(); pollTimer=window.setInterval(pollSnapshot,1000); };
const stopPolling = () => { polling.value=false; if(pollTimer){ window.clearInterval(pollTimer); pollTimer=undefined; } };
const openRuntimeDialog = (item:Twin2DObjectView) => { runtimeDialogObject.value=item; runtimeDialogVisible.value=true; };

const zoomBy = (factor:number) => { const nextW=Math.min(6000,Math.max(300,viewport.w*factor)); const nextH=nextW*(viewport.h/viewport.w); viewport.x+=(viewport.w-nextW)/2; viewport.y+=(viewport.h-nextH)/2; viewport.w=nextW; viewport.h=nextH; };
const handleWheel = (event:WheelEvent) => zoomBy(event.deltaY>0 ? 1.12 : 0.88);
const resetViewport = () => Object.assign(viewport,{x:0,y:0,w:1600,h:1000});

watch(mode,(value)=>{ if(value==='runtime') startPolling(); else { stopPolling(); runtimeUpdates.value=[]; } });
watch(()=>bindingForm.deviceId,()=>{ bindingForm.key=''; });
onMounted(async()=>{ await loadAssets(); try { await loadScenes(); } catch(error:any){ ElMessage.warning(error?.msg || error?.message || '场景列表加载失败，已进入本地空白设计器'); resetHistory(); } });
onBeforeUnmount(()=>stopPolling());
</script>

<style scoped lang="scss">
.designer{height:calc(100vh - 112px);min-height:700px;margin:-15px;display:flex;flex-direction:column;overflow:hidden;background:#050b14;color:#dbeafe}.toolbar{height:66px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;border-bottom:1px solid rgba(148,163,184,.18);background:#091321}.toolbar__title,.toolbar__actions{display:flex;align-items:center;gap:10px}.toolbar__title>div{display:flex;flex-direction:column;min-width:190px}.toolbar small,.panel-heading small{font-size:10px;color:#38bdf8;letter-spacing:.12em}.toolbar strong{font-size:15px;color:#f8fafc}.scene-select{width:220px}.runtime-strip{height:34px;display:flex;align-items:center;gap:22px;padding:0 16px;border-bottom:1px solid rgba(56,189,248,.18);background:#071a28;font-size:11px;color:#9fb4c9}.runtime-strip .is-good{color:#86efac}.runtime-strip .is-warning{color:#fbbf24}.runtime-strip .is-danger{color:#fca5a5}.workspace{flex:1;min-height:0;display:grid;grid-template-columns:270px minmax(0,1fr) 320px}.panel{min-height:0;overflow:auto;background:#08121f}.panel--left{border-right:1px solid rgba(148,163,184,.16);padding:8px}.panel--right{border-left:1px solid rgba(148,163,184,.16);padding:12px}.library{display:flex;flex-direction:column;gap:8px;margin-top:10px}.library-card{display:grid;grid-template-columns:52px 1fr auto;align-items:center;gap:8px;padding:9px;border:1px solid rgba(100,116,139,.25);border-radius:10px;background:#0b1929;cursor:grab}.library-card:hover{border-color:#38bdf8}.library-card strong,.library-card small,.library-card p{display:block}.library-card small{font-size:10px;color:#7dd3fc}.library-card p{margin:3px 0 0;font-size:10px;color:#7890a8}.library-icon{width:48px;height:42px;display:grid;place-items:center;border-radius:8px;background:#101f31}.library-icon span{width:30px;height:16px;border:2px solid #67e8f9;border-radius:3px}.library-icon .symbol-turntable,.library-icon .symbol-robot{width:24px;height:24px;border-radius:50%}.library-icon .symbol-gantry{width:30px;height:24px;border-width:3px 3px 0}.scene-summary{padding:10px;display:flex;flex-direction:column;border:1px solid rgba(148,163,184,.2);border-radius:8px}.scene-summary small{color:#7890a8}.tree-list{margin-top:8px}.tree-list>div{display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:6px;padding:8px;border-radius:6px;cursor:pointer}.tree-list>div:hover,.tree-list>div.selected{background:#10263d}.tree-list small{font-size:10px;color:#7890a8}.stage-shell{position:relative;min-width:0;overflow:hidden;background:#030712}.stage-tools{position:absolute;z-index:5;top:10px;left:12px;display:flex;align-items:center;gap:12px;padding:7px 10px;border:1px solid rgba(148,163,184,.2);border-radius:10px;background:rgba(8,18,31,.9);font-size:11px}.canvas{display:block;width:100%;height:100%;user-select:none}.canvas-hint{position:absolute;right:12px;bottom:12px;padding:7px 10px;border:1px solid rgba(56,189,248,.18);border-radius:8px;background:rgba(3,10,19,.84);font-size:10px;color:#8ea6bf}.route-edge{stroke:#22c55e;stroke-width:4;stroke-dasharray:12 8}.route-point{fill:#0f172a;stroke:#fbbf24;stroke-width:3}.scene-object{cursor:move}.scene-object.is-fault{filter:drop-shadow(0 0 9px #ef4444)}.scene-object.is-stale{filter:grayscale(.5) drop-shadow(0 0 7px #8b5cf6)}.scene-object.is-running .flow-marker{animation:flow .7s linear infinite}.object-label,.label-symbol{fill:#e2e8f0;font-size:18px;font-weight:600;pointer-events:none}.runtime-badge rect{fill:#020617;stroke:#64748b}.runtime-badge text{fill:#e2e8f0;font-size:11px;font-weight:700}.resize-handle{cursor:nwse-resize}.panel-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.panel-heading>div{display:flex;flex-direction:column}.property-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.binding-list{display:flex;flex-direction:column;gap:7px}.binding-list>div{display:flex;justify-content:space-between;gap:6px;padding:8px;border:1px solid rgba(148,163,184,.2);border-radius:8px}.binding-list strong,.binding-list small{display:block}.binding-list small{color:#7890a8}.runtime-card{padding:12px;border:1px solid rgba(148,163,184,.2);border-radius:10px;background:#06101d}.runtime-card pre,.runtime-json{max-height:280px;overflow:auto;padding:10px;border-radius:8px;background:#020617;color:#bae6fd;font-size:11px}.statusbar{height:30px;display:flex;align-items:center;gap:22px;padding:0 14px;border-top:1px solid rgba(148,163,184,.15);background:#06101b;color:#7890a8;font-size:10px}.diagnostics{display:flex;flex-direction:column;gap:10px}.version-card{display:flex;flex-direction:column;gap:6px}.version-card small{color:#7890a8}@keyframes flow{to{stroke-dashoffset:-32}}
:deep(.el-tabs__item){color:#9fb4c9}:deep(.el-tabs__item.is-active){color:#38bdf8}:deep(.el-form-item__label){color:#8ea6bf}:deep(.el-input-number){width:100%}
</style>
