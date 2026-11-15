<template>
	<div class="studio-v2" v-loading="busy">
		<header class="studio-topbar">
			<div class="studio-brand"><div class="studio-brand-mark">◆</div><div><strong>IoTSharp <span>Digital Twin Studio</span></strong><small>INDUSTRIAL ENGINEERING WORKSPACE · V2</small></div></div>
			<div class="studio-divider"></div>
			<div class="studio-project"><span>工程项目</span><el-select v-model="selectedSceneId" filterable placeholder="选择或创建场景" @change="loadScene"><el-option v-for="scene in scenes" :key="scene.id" :label="scene.name" :value="scene.id" /></el-select></div>
			<el-tag size="small" :type="dirty ? 'warning' : 'success'" effect="plain">{{ dirty ? '本地草稿未保存' : currentScene ? '草稿 r' + currentScene.revision : '未入库工作区' }}</el-tag>
			<div class="studio-spacer"></div>
			<el-button size="small" @click="openCreate">新建场景</el-button>
			<el-button size="small" :disabled="!currentScene || !dirty || mode !== 'design'" :loading="saving" @click="saveDraft">保存草稿</el-button>
			<el-button size="small" type="primary" :disabled="!currentScene || mode !== 'design'" :loading="publishing" @click="publishScene">校验并发布</el-button>
			<el-button size="small" text @click="router.push({path:'/iot/digital-twin/workbench',query:currentScene ? {sceneId:currentScene.id} : {}})">旧版编辑器</el-button>
		</header>

		<div class="studio-body">
			<nav class="studio-rail" aria-label="工作台导航">
				<button :class="{active:sideTab==='library'}" title="资源库" @click="sideTab='library'"><span>▦</span>资源</button>
				<button :class="{active:sideTab==='tree'}" title="场景树" @click="sideTab='tree'"><span>♧</span>场景</button>
				<button :class="{active:bottomTab==='flow'}" title="动作流" @click="bottomTab='flow'"><span>◇</span>动作</button>
				<button :class="{active:mode==='simulation'}" title="仿真运行" @click="changeMode('simulation')"><span>▷</span>仿真</button>
				<button :class="{active:mode==='live'}" title="实时监控" @click="changeMode('live')"><span>◉</span>监控</button>
				<button :class="{active:bottomTab==='quality'}" title="工程校验" @click="bottomTab='quality'"><span>✓</span>校验</button>
				<button title="版本管理" @click="openVersions"><span>▤</span>版本</button>
			</nav>

			<div class="studio-main">
				<section class="studio-commandbar">
					<div class="studio-modes" role="tablist" aria-label="运行模式">
						<button :class="{active:mode==='design'}" @click="changeMode('design')">设计编辑</button>
						<button :class="{active:mode==='simulation'}" @click="changeMode('simulation')">仿真运行</button>
						<button :class="{active:mode==='live'}" @click="changeMode('live')">实时监控</button>
					</div>
					<div class="studio-command-divider"></div>
					<div class="studio-tools">
						<el-button-group size="small">
							<el-button :disabled="mode!=='design'" :type="tool==='select' ? 'primary':'default'" @click="selectTool('select')">选择</el-button>
							<el-button :disabled="mode!=='design'" :type="tool==='move' ? 'primary':'default'" @click="selectTool('move')">移动</el-button>
							<el-button :disabled="mode!=='design'" :type="tool==='rotate' ? 'primary':'default'" @click="selectTool('rotate')">旋转</el-button>
							<el-button :disabled="mode!=='design'" :type="tool==='multi' ? 'primary':'default'" @click="selectTool('multi')">框选</el-button>
						</el-button-group>
						<el-button size="small" :disabled="mode!=='design'" :type="routeEdit?'warning':'default'" @click="toggleRouteEdit">{{ routeEdit?'结束路线编辑':'编辑路线' }}</el-button>
						<el-button size="small" :disabled="mode!=='design'||!routeEdit" :type="routeDraw?'primary':'default'" @click="toggleRouteDraw">{{ routeDraw?'结束绘制':'绘制路线点' }}</el-button>
						<el-button size="small" :disabled="mode!=='design'" @click="editor?.undo(); onChanged()">撤销</el-button>
						<el-button size="small" :disabled="mode!=='design'" @click="editor?.redo(); onChanged()">重做</el-button>
						<el-checkbox v-model="showGrid" :disabled="mode!=='design'" @change="editor?.setGrid(Boolean($event))">网格</el-checkbox>
						<el-checkbox v-model="showPorts" :disabled="mode!=='design'" @change="editor?.setEngineeringOverlayVisible('ports',Boolean($event))">端口</el-checkbox>
						<el-checkbox v-model="showRoute" :disabled="mode!=='design'" @change="editor?.setRouteOverlayVisible(Boolean($event))">路线</el-checkbox>
						<el-button size="small" @click="editor?.fitScene()">适配视图</el-button>
					</div>
					<div class="studio-spacer"></div>
					<el-tag size="small" effect="plain" type="info">{{ mode==='design'?'工程坐标':mode==='live'?'只读遥测':'隔离仿真' }}</el-tag>
				</section>

				<div class="studio-layout">
					<aside class="studio-library">
						<div class="studio-pane-heading"><div><small>PROJECT RESOURCES</small><strong>{{ sideTab==='library'?'工业资源库':'场景结构' }}</strong></div><el-tag size="small" round>{{ sideTab==='library'?builtInComponentTemplates.length+models.length:manifest.objects.length }}</el-tag></div>
						<el-input v-model="search" size="small" clearable placeholder="搜索设备、组件或场景对象" class="studio-search" />
						<template v-if="sideTab==='library'">
							<div class="studio-library-meta">参数化工业组件 <span>拖放至 3D 工程画布</span></div>
							<div class="studio-resource-grid">
								<button v-for="item in filteredTemplates" :key="item.resourceKey" class="studio-resource-tile" :disabled="mode!=='design' || placing" :draggable="mode==='design'" :title="item.name+' · '+item.componentType" @dragstart="dragComponent($event,item.resourceKey)" @dragend="dragging=false" @click="placeComponent(item.resourceKey)">
									<span class="studio-resource-icon">{{ componentGlyph(item.componentType) }}</span>
									<strong>{{ item.name }}</strong><small>{{ item.category }}</small>
								</button>
							</div>
							<div class="studio-library-meta">GLB 模型资源 <span>{{ readyModels.length }} 个可用</span></div>
							<div class="studio-model-list"><button v-for="item in filteredModels" :key="item.id" :disabled="mode!=='design'||placing" :draggable="mode==='design'" @dragstart="dragModel($event,item.id)" @dragend="dragging=false" @click="placeModel(item.id)"><span>⬡</span><div><strong>{{ item.name }}</strong><small>{{ item.originalFileName || '模型资源' }}</small></div><em>放入</em></button></div>
							<el-empty v-if="!filteredTemplates.length&&!filteredModels.length" description="暂无匹配资源" :image-size="55" />
							<div class="studio-library-footer"><el-button size="small" plain :disabled="mode!=='design'" @click="loadReferenceTemplate">参考产线模板</el-button><el-button size="small" plain @click="router.push('/iot/digital-twin/component-studio')">组件设计器</el-button><el-button size="small" plain @click="refreshModels">刷新模型</el-button></div>
						</template>
						<template v-else>
							<div class="studio-tree-title">{{ manifest.name }}</div>
							<div class="studio-object-list">
								<button v-for="item in filteredObjects" :key="item.objectId" :class="{selected:selectedObjectId===item.objectId}" @click="selectObject(item.objectId)"><span>⬡</span><div><strong>{{ item.name }}</strong><small>{{ item.kind }} · {{ item.objectId }}</small></div></button>
							</div>
							<div class="studio-tree-title">工艺路线（{{ manifest.routes.length }}）</div>
							<div v-for="item in manifest.routes" :key="item.routeId" class="studio-tree-detail">⌁ {{ item.name }} · {{ item.edges.length }} 段</div>
						</template>
					</aside>

					<section class="studio-scene-area">
						<div class="studio-viewport" @dragover.prevent="dragOver" @drop.prevent="dropOnViewport">
							<div v-if="mode==='design'" ref="designViewport" class="studio-viewport-content"></div>
							<div v-else ref="runtimeViewport" class="studio-viewport-content"></div>
							<div ref="guiViewport" class="studio-hidden-gui"></div>
							<div class="studio-viewport-info"><div><span class="studio-led"></span><strong>{{ manifest.name }}</strong></div><small>{{ summary.objects }} 对象 · {{ summary.components }} 组件 · {{ summary.connections }} 连接 · {{ summary.routes }} 路线</small></div>
							<div class="studio-viewport-side">{{ mode==='design'?'ENGINEERING VIEW':mode==='live'?'LIVE VIEW / READ ONLY':'SIMULATION VIEW' }}</div>
							<div v-if="dragging && mode==='design'" class="studio-drop-hint">释放到此位置 · 自动放置并校验</div>
							<div v-if="!manifest.objects.length && mode==='design'" class="studio-empty-hero"><div>◇</div><strong>开始构建工业场景</strong><p>从左侧拖入组件，或加载包装线参考模板</p><el-button type="primary" size="small" @click.stop="loadReferenceTemplate">加载双套袋参考产线</el-button></div>
						</div>
						<div class="studio-viewport-footer"><span>场景对象 {{ summary.objects }} · 绑定 {{ summary.bindings }} · 动作图 {{ summary.flows }}</span><span v-if="runtimeMetrics">FPS {{ runtimeMetrics.fps }} · Draw Calls {{ runtimeMetrics.drawCalls }} · Triangles {{ runtimeMetrics.triangles.toLocaleString() }}</span><span v-else>渲染指标：进入仿真或实时视图后采集</span></div>
					</section>

					<aside class="studio-inspector">
						<div class="studio-pane-heading"><div><small>ENGINEERING INSPECTOR</small><strong>对象属性与连接</strong></div></div>
						<div class="studio-inspector-tabs"><button v-for="tab in inspectorTabs" :key="tab.value" :class="{active:inspectorTab===tab.value}" @click="inspectorTab=tab.value">{{ tab.label }}</button></div>
						<div v-if="selectedObject" class="studio-inspector-content">
							<div class="studio-object-identity"><div class="studio-object-avatar">⬡</div><div><strong>{{ selectedObject.name }}</strong><small>{{ selectedObject.kind }} · {{ selectedObject.objectId }}</small></div><el-tag size="small" type="info">{{ mode==='design'?'编辑中':'只读' }}</el-tag></div>
							<template v-if="inspectorTab==='properties'">
								<div class="studio-field-caption">基本属性</div>
								<el-form size="small" label-position="top" class="studio-attributes">
									<el-form-item label="名称"><el-input v-model="selectedObject.name" :disabled="mode!=='design'" @change="updateObjectName" /></el-form-item>
									<el-form-item label="对象 ID"><el-input :model-value="selectedObject.objectId" disabled /></el-form-item>
									<el-form-item label="位置 XYZ · m"><div class="studio-vector"><el-input-number v-for="(_,i) in selectedObject.transform.position" :key="'p'+i" v-model="selectedObject.transform.position[i]" :step="0.1" :precision="2" :controls="false" :disabled="mode!=='design'" @change="applyTransform" /></div></el-form-item>
									<el-form-item label="旋转 XYZ · rad"><div class="studio-vector"><el-input-number v-for="(_,i) in selectedObject.transform.rotation" :key="'r'+i" v-model="selectedObject.transform.rotation[i]" :step="0.1" :precision="2" :controls="false" :disabled="mode!=='design'" @change="applyTransform" /></div></el-form-item>
									<el-form-item label="缩放 XYZ"><div class="studio-vector"><el-input-number v-for="(_,i) in selectedObject.transform.scale" :key="'s'+i" v-model="selectedObject.transform.scale[i]" :step="0.1" :min="0.01" :precision="2" :controls="false" :disabled="mode!=='design'||selectedObject.kind==='component'" @change="applyTransform" /></div></el-form-item>
								</el-form>
								<template v-if="selectedComponent && mode==='design'"><div class="studio-field-caption">参数化设备配置</div><ComponentPropertyPanel :manifest="manifest" :object-id="selectedComponent.objectId" @changed="onChanged" @reload-component="reloadComponent" @reload-all="editor?.reloadAllComponents()" @transform-changed="applyTransformById" /></template>
								<el-button size="small" type="danger" plain :disabled="mode!=='design'" @click="removeSelected">从场景中移除</el-button>
							</template>
							<template v-if="inspectorTab==='connections'"><div class="studio-field-caption">组件接口 / 连接关系</div><div v-for="port in selectedPorts" :key="port.portId" class="studio-port-row"><span class="studio-port-dot"></span><div><strong>{{ port.name }}</strong><small>{{ port.type }} · {{ port.portId }}</small></div></div><el-empty v-if="!selectedPorts.length" :image-size="55" description="该对象没有参数化 Port" /><div class="studio-field-caption">场景连接</div><div v-for="connection in selectedConnections" :key="connection.connectionId" class="studio-connect-row">{{ connection.from.objectId }}.{{ connection.from.portId }} → {{ connection.to.objectId }}.{{ connection.to.portId }}</div><el-empty v-if="!selectedConnections.length" :image-size="45" description="尚未连接" /></template>
							<template v-if="inspectorTab==='binding'"><div class="studio-field-caption">遥测与设备绑定</div><div v-for="item in selectedBindings" :key="item.bindingId" class="studio-binding-row"><strong>{{ item.bindingId }}</strong><small>{{ item.source.kind }} → {{ item.target.kind }}</small></div><el-empty v-if="!selectedBindings.length" :image-size="55" description="当前设备暂无数据绑定" /><el-alert type="info" :closable="false" title="实时模式仅订阅已发布场景的绑定快照；不会向 PLC 写入指令。" /></template>
							<template v-if="inspectorTab==='actions'"><div class="studio-field-caption">设备动作 / 联锁</div><p class="studio-panel-note">设备的动作、联锁及材料槽统一在下方 Action Flow V2 编排，避免重复配置。</p><el-button size="small" type="primary" plain @click="bottomTab='flow'">打开动作流工作台</el-button></template>
						</div>
						<el-empty v-else description="选择场景内设备以查看工程属性" :image-size="88" />
					</aside>
				</div>

				<section class="studio-dock" :class="{expanded:bottomTab==='flow'}">
					<div class="studio-dock-tabs"><button v-for="tab in bottomTabs" :key="tab.value" :class="{active:bottomTab===tab.value}" @click="bottomTab=tab.value">{{ tab.label }}</button><div class="studio-spacer"></div><span class="studio-dock-caption">工程诊断基于真实 Manifest / 运行时指标</span></div>
					<div v-show="bottomTab==='overview'" class="studio-dock-grid">
						<div class="studio-dock-card"><div class="studio-dock-heading">仿真控制</div><div class="studio-run-controls"><el-button size="small" type="primary" :disabled="mode!=='simulation'" @click="setSimulationRunning(true)">运行</el-button><el-button size="small" :disabled="mode!=='simulation'" @click="setSimulationRunning(false)">暂停</el-button><el-button size="small" :disabled="mode!=='simulation'" @click="resetSimulation">重置</el-button></div><div class="studio-dock-note">Simulation 与 Live 完全隔离，不会触发真实设备命令。</div></div>
						<div class="studio-dock-card"><div class="studio-dock-heading">工程规模</div><div class="studio-mini-stats"><div><strong>{{ summary.components }}</strong><small>参数化组件</small></div><div><strong>{{ summary.connections }}</strong><small>组件连接</small></div><div><strong>{{ summary.flows }}</strong><small>动作图</small></div><div><strong>{{ summary.bindings }}</strong><small>数据绑定</small></div></div></div>
						<div class="studio-dock-card"><div class="studio-dock-heading">质量闸口</div><div class="studio-quality-line"><span>本地结构校验</span><strong :class="localErrorCount?'is-error':'is-success'">{{ localErrorCount ? localErrorCount+' 项错误':'无结构错误' }}</strong></div><div class="studio-quality-line"><span>警告信息</span><strong>{{ localWarningCount }} 项</strong></div><el-button size="small" text type="primary" @click="bottomTab='quality'">查看完整检查报告</el-button></div>
						<div class="studio-dock-card"><div class="studio-dock-heading">版本治理</div><div class="studio-quality-line"><span>当前草稿</span><strong>{{ currentScene?'r'+currentScene.revision:'未创建' }}</strong></div><div class="studio-quality-line"><span>线上版本</span><strong>{{ currentScene?.publishedVersion?'v'+currentScene.publishedVersion:'未发布' }}</strong></div><el-button size="small" text type="primary" @click="openVersions">历史版本 / 回滚</el-button></div>
					</div>
					<div v-if="bottomTab==='flow'" class="studio-dock-flow"><ActionFlowDesigner :key="manifest.sceneId" :flows="manifest.actionFlows||[]" :manifest="manifest" :persisted-flows="currentScene?.actionFlows||[]" :scene-id="currentScene?.id" :published-version-id="currentScene?.publishedVersionId" :scene-revision="currentScene?.revision" :published-source-revision="currentScene?.publishedSourceRevision" :authoring-disabled="mode!=='design'" :live-execution-available="false" :scene-execution-available="false" @update:flows="updateFlows" @changed="onChanged" /></div>
					<div v-show="bottomTab==='performance'" class="studio-dock-grid">
						<div v-for="item in performanceCards" :key="item.label" class="studio-dock-card studio-perf-card"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></div>
					</div>
					<div v-show="bottomTab==='quality'" class="studio-quality-panel">
						<div class="studio-quality-summary"><div><strong>发布前工程校验</strong><small>前端结构检查与服务端发布检查分开统计；未执行不视为通过。</small></div><el-button size="small" :disabled="!currentScene" :loading="verifying" @click="verifyOnServer">保存并运行服务端校验</el-button><el-tag :type="serverCheck==='passed'?'success':serverCheck==='failed'?'danger':'info'">{{ serverCheck==='passed'?'服务端通过':serverCheck==='failed'?'服务端未通过':'尚未执行服务端校验' }}</el-tag></div>
						<div class="studio-diagnostic-list"><div v-for="(item,i) in diagnostics" :key="item.code+i" :class="'studio-diagnostic is-'+item.severity"><span>{{ item.severity==='error'?'错误':item.severity==='warning'?'警告':'信息' }}</span><div><strong>{{ item.message }}</strong><small>{{ item.code }}{{ item.path?' · '+item.path:'' }}</small></div></div><el-empty v-if="diagnostics.length===0" :image-size="48" description="本地工程结构未发现错误或警告" /></div>
					</div>
				</section>
			</div>
		</div>

		<el-dialog v-model="createVisible" title="创建企业工程场景" width="560px" destroy-on-close><el-form :model="createForm" label-position="top"><el-form-item label="场景名称"><el-input v-model="createForm.name" maxlength="80" /></el-form-item><el-form-item label="根资产（必选）"><el-select v-model="createForm.assetId" filterable placeholder="选择生产线根资产" style="width:100%"><el-option v-for="asset in assets" :key="asset.id" :label="asset.name" :value="asset.id" /></el-select></el-form-item><el-form-item label="初始模板"><el-radio-group v-model="createForm.template"><el-radio value="blank">空白工程</el-radio><el-radio value="reference">双套袋参考包装线</el-radio></el-radio-group></el-form-item><el-alert type="info" :closable="false" title="新版独立页面与旧版共用 IoTSharp Scene Manifest 和数据库版本。新建场景不会改变现有场景。" /></el-form><template #footer><el-button @click="createVisible=false">取消</el-button><el-button type="primary" :loading="creating" @click="createScene">创建工程</el-button></template></el-dialog>
		<el-drawer v-model="versionsVisible" title="工程版本与回滚" size="520px"><el-empty v-if="!versions.length" description="当前场景尚无已发布版本" /><el-timeline v-else><el-timeline-item v-for="item in versions" :key="item.id" :timestamp="item.createdAt" :type="item.isCurrent?'success':'primary'"><div class="studio-version-card"><strong>版本 v{{ item.version }} <el-tag v-if="item.isCurrent" size="small" type="success">线上</el-tag></strong><p>{{ item.changeSummary }}</p><small>Manifest SHA: {{ item.manifestHash.slice(0,16) }}</small><el-button v-if="!item.isCurrent" size="small" @click="rollback(item.version)">创建回退草稿</el-button></div></el-timeline-item></el-timeline></el-drawer>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { assetApi } from '/@/api/asset';
import { digitalTwinApi, type DigitalTwinSceneDetail, type DigitalTwinSceneSummary, type TwinModelResource, type TwinRuntimeSnapshot, type TwinSceneVersion } from '/@/api/digital-twin';
import { createBlankTwinSceneManifest, type TwinSceneManifest, type TwinSceneObjectDefinition, type TwinVector3 } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { builtInComponentTemplates, builtInComponentResourceRegistrations, ensureComponentActuators, snapSceneComponent, upsertGeneratedComponentRoute, removeConnectionsForObject, resolveComponentPorts } from '/@/digital-twin/components';
import { createReferencePackagingLineTwinSceneManifest } from '/@/digital-twin/presets/ReferencePackagingLineManifest';
import { ThreeEditorCoreHost } from '/@/digital-twin/editor-adapter/ThreeEditorCoreHost';
import { TwinRuntime, type TwinRuntimeMetrics, type TwinSelectionInfo } from '/@/digital-twin/runtime/TwinRuntime';
import { inspectStudioManifest, normalizeStudioManifest, createStudioRuntimeManifest, studioSummary, type StudioMode } from './studioScene';
import ComponentPropertyPanel from '/@/digital-twin/components/ComponentPropertyPanel.vue';
import ActionFlowDesigner from '/@/digital-twin/action-flow/components/ActionFlowDesigner.vue';
import type { TwinActionFlowDefinitionV2 } from '/@/digital-twin/action-flow/contracts/action-flow-v2';

const router=useRouter(), route=useRoute();
const scenes=ref<DigitalTwinSceneSummary[]>([]), selectedSceneId=ref('');
const currentScene=ref<DigitalTwinSceneDetail>(), manifest=ref<TwinSceneManifest>(normalizeStudioManifest(createBlankTwinSceneManifest()));
const models=ref<TwinModelResource[]>([]), assets=ref<{id:string;name:string}[]>([]);
const mode=ref<StudioMode>('design'), sideTab=ref<'library'|'tree'>('library'), bottomTab=ref('overview'), inspectorTab=ref('properties');
const search=ref(''), dragging=ref(false), placing=ref(false), dirty=ref(false), busy=ref(false), saving=ref(false), publishing=ref(false), verifying=ref(false), creating=ref(false);
const createVisible=ref(false), versionsVisible=ref(false), versions=ref<TwinSceneVersion[]>([]);
const createForm=reactive({name:'新建工业数字孪生场景',assetId:'',template:'blank'});
const selected=ref<TwinSelectionInfo|null>(null), selectedObjectId=ref('');
const publishedView=shallowRef<TwinSceneManifest>();
const designViewport=ref<HTMLDivElement>(), runtimeViewport=ref<HTMLDivElement>(), guiViewport=ref<HTMLDivElement>();
const editor=shallowRef<ThreeEditorCoreHost>(), runtimeMetrics=ref<TwinRuntimeMetrics>();
const diagnostics=ref(inspectStudioManifest(manifest.value)), serverCheck=ref<'idle'|'passed'|'failed'>('idle');
const showGrid=ref(true), showRoute=ref(true), showPorts=ref(false), tool=ref('move'), routeEdit=ref(false), routeDraw=ref(false);
const inspectorTabs=[{value:'properties',label:'属性'},{value:'connections',label:'连接'},{value:'binding',label:'绑定'},{value:'actions',label:'动作'}];
const bottomTabs=[{value:'overview',label:'工程总览'},{value:'flow',label:'动作流'},{value:'performance',label:'渲染性能'},{value:'quality',label:'发布前校验'}];
let runtime:TwinRuntime|undefined, liveTimer:number|undefined, generation=0;
const modelCache=new Map<string,{fileName:string;buffer:ArrayBuffer}>();
const viewManifest=computed(()=>mode.value==='live'&&publishedView.value?publishedView.value:manifest.value);
const summary=computed(()=>studioSummary(viewManifest.value));
const readyModels=computed(()=>models.value.filter(item=>item.processingStatus==='Ready' && item.runtimeFormat !== 'procedural-component' && item.modelMetadata?.resourceType!=='procedural-component'));
const filteredModels=computed(()=>readyModels.value.filter(item=>(item.name+' '+item.originalFileName).toLowerCase().includes(search.value.toLowerCase())));
const filteredTemplates=computed(()=>builtInComponentTemplates.filter(item=>(item.name+' '+item.tags.join(' ')).toLowerCase().includes(search.value.toLowerCase())));
const filteredObjects=computed(()=>viewManifest.value.objects.filter(item=>(item.name+' '+item.objectId).toLowerCase().includes(search.value.toLowerCase())));
const selectedObject=computed(()=>viewManifest.value.objects.find(item=>item.objectId===selectedObjectId.value) as TwinV7SceneObjectDefinition|undefined);
const selectedComponent=computed(()=>selectedObject.value?.kind==='component'?selectedObject.value:undefined);
const selectedPorts=computed(()=>selectedComponent.value?resolveComponentPorts(selectedComponent.value):[]);
const selectedConnections=computed(()=>viewManifest.value.connections?.filter(item=>item.from.objectId===selectedObjectId.value||item.to.objectId===selectedObjectId.value)||[]);
const selectedBindings=computed(()=>viewManifest.value.bindings.filter(item=>item.objectId===selectedObjectId.value));
const localErrorCount=computed(()=>diagnostics.value.filter(item=>item.severity==='error').length);
const localWarningCount=computed(()=>diagnostics.value.filter(item=>item.severity==='warning').length);
const performanceCards=computed(()=>[
	{label:'帧率 FPS',value:runtimeMetrics.value?String(runtimeMetrics.value.fps):'—',note:'运行态实测'},
	{label:'Draw Calls',value:runtimeMetrics.value?String(runtimeMetrics.value.drawCalls):'—',note:'Three.js renderer.info'},
	{label:'Triangles',value:runtimeMetrics.value?runtimeMetrics.value.triangles.toLocaleString():'—',note:'实际绘制三角面'},
	{label:'Geometries',value:runtimeMetrics.value?String(runtimeMetrics.value.geometries):'—',note:'GPU 几何资源计数'},
	{label:'Textures',value:runtimeMetrics.value?String(runtimeMetrics.value.textures):'—',note:'GPU 纹理资源计数'},
]);
const apiData=<T,>(response:any):T=>response.data as T;
const errorText=(error:any,fallback:string)=>error?.message||error?.msg||fallback;
const componentGlyph=(type:string)=>({conveyor:'▱',pallet:'▧',robot:'♜',turntable:'◎',bagging:'▣',inspection:'◈'} as Record<string,string>)[type]||'⬡';
const onChanged=()=>{if(mode.value!=='design')return;dirty.value=true;serverCheck.value='idle';diagnostics.value=inspectStudioManifest(manifest.value);};
const updateObjectName=()=>{if(selectedObject.value)editor.value?.renameObject(selectedObject.value.objectId,selectedObject.value.name);onChanged();};
const applyTransformById=(id:string)=>{editor.value?.applyObjectTransform(id);onChanged();};
const applyTransform=()=>{if(selectedObject.value)applyTransformById(selectedObject.value.objectId);};
const reloadComponent=(id:string)=>{editor.value?.reloadComponent(id);onChanged();};
const selectObject=(id:string)=>{selectedObjectId.value=id;editor.value?.selectObject(id);};
const selectTool=(next:string)=>{tool.value=next;if(next==='multi')editor.value?.setSelectionMode('multi');else if(next==='select')editor.value?.setSelectionMode('select');else{editor.value?.setSelectionMode('root');editor.value?.setTransformMode(next==='rotate'?'rotate':'translate');}};
const toggleRouteEdit=()=>{routeEdit.value=!routeEdit.value;if(!routeEdit.value)routeDraw.value=false;editor.value?.setRouteEditMode(routeEdit.value);editor.value?.setRouteDrawMode(routeDraw.value);};
const toggleRouteDraw=()=>{routeDraw.value=!routeDraw.value;editor.value?.setRouteDrawMode(routeDraw.value);};
const updateFlows=(flows:TwinActionFlowDefinitionV2[])=>{manifest.value.actionFlows=flows;onChanged();};

const stopRuntime=()=>{if(liveTimer!==undefined)window.clearInterval(liveTimer);liveTimer=undefined;runtime?.dispose();runtime=undefined;runtimeMetrics.value=undefined;};
const destroySurface=()=>{++generation;stopRuntime();editor.value?.dispose();editor.value=undefined;routeEdit.value=false;routeDraw.value=false;selected.value=null;selectedObjectId.value='';};
const getModelBuffer=async(model:TwinModelResource)=>{
	const cached=modelCache.get(model.id);if(cached)return cached;
	const response:any=await digitalTwinApi.downloadModel(model.id);
	const buffer=(response?.data instanceof ArrayBuffer?response.data:response) as ArrayBuffer;
	if(!(buffer instanceof ArrayBuffer))throw new Error('模型接口未返回 GLB ArrayBuffer');
	const result={fileName:model.originalFileName||model.name+'.glb',buffer};modelCache.set(model.id,result);return result;
};
const loadGlbResources=async(serial:number,source: TwinSceneManifest)=>{
	for(const object of source.objects.filter(item=>item.kind==='model')){
		if(serial!==generation)return;
		const model=models.value.find(item=>item.id===object.resourceId);if(!model)continue;
		try{const file=await getModelBuffer(model);if(serial!==generation)return;if(mode.value==='design')await editor.value?.loadGlbBuffer(object,file.fileName,file.buffer);else await runtime?.loadGlbBuffer(object.objectId,file.fileName,file.buffer);}
		catch(error){ElMessage.warning(object.name+' 模型加载失败：'+errorText(error,'文件无效'));}
	}
};
const pollLive=async(serial:number)=>{
	if(serial!==generation||mode.value!=='live'||!currentScene.value?.publishedVersion)return;
	try{const response=apiData<TwinRuntimeSnapshot>(await digitalTwinApi.snapshot(currentScene.value.id,currentScene.value.publishedVersion));if(serial===generation)runtime?.applyDataUpdates(response.updates||[]);}
	catch(error){if(serial===generation)ElMessage.warning(errorText(error,'实时数据请求失败'));}
};
const buildSurface=async()=>{
	destroySurface();const serial=generation;await nextTick();
	try{
		if(mode.value==='design'){
			if(!designViewport.value||!guiViewport.value)return;
			const host=new ThreeEditorCoreHost(designViewport.value,guiViewport.value,manifest.value,{
				onSelectionChange:(value)=>{selected.value=value;selectedObjectId.value=value?.kind==='scene-object'?value.objectId||'':'';},
				onChanged,
				onRouteChange:()=>onChanged(),
				onError:(message)=>ElMessage.warning(message),
			});
			editor.value=host;host.setSelectionMode('root');host.setTransformMode('translate');
			host.setGrid(showGrid.value);host.setRouteOverlayVisible(showRoute.value);host.setEngineeringOverlayVisible('ports',showPorts.value);
		}else{
			if(!runtimeViewport.value)return;
			let source=manifest.value;
			if(mode.value==='live'){
				if(!currentScene.value?.publishedVersion)throw new Error('该场景尚无已发布版本');
				const version=apiData<TwinSceneVersion>(await digitalTwinApi.getVersion(currentScene.value.id,currentScene.value.publishedVersion));
				if(serial!==generation)return;
				if(!version.manifest)throw new Error('已发布版本未返回不可变 Manifest');
				source=normalizeStudioManifest(version.manifest);
				publishedView.value=source;
			}
			const compiled=createStudioRuntimeManifest(source,mode.value);
			const viewer=new TwinRuntime(runtimeViewport.value,compiled,{
				onSelectionChange:(value)=>{selected.value=value;selectedObjectId.value=value?.kind==='scene-object'?value.objectId||'':'';},
				onMetrics:(value)=>{if(serial===generation)runtimeMetrics.value=value;},
				onError:(message)=>ElMessage.warning(message),
			},{readOnly:true});
			runtime=viewer;viewer.setRunning(mode.value==='simulation');
			if(mode.value==='live'){await pollLive(serial);liveTimer=window.setInterval(()=>void pollLive(serial),3000);}
		}
		await loadGlbResources(serial,mode.value==='live'&&publishedView.value?publishedView.value:manifest.value);
	}catch(error){ElMessage.error(errorText(error,'三维视口初始化失败'));}
};
const captureDraft=()=>{if(mode.value==='design')editor.value?.captureManifest(manifest.value);upsertGeneratedComponentRoute(manifest.value);diagnostics.value=inspectStudioManifest(manifest.value);};
const changeMode=async(next:StudioMode)=>{
	if(next===mode.value)return;
	if(next==='live'&&(!currentScene.value?.publishedVersion||dirty.value)){ElMessage.warning('Live 仅能读取已发布且未修改的场景；请先保存并发布。');return;}
	if(mode.value==='design')captureDraft();
	mode.value=next;await buildSurface();
};
const setSimulationRunning=(value:boolean)=>runtime?.setRunning(value);
const resetSimulation=async()=>{if(mode.value==='simulation')await buildSurface();};
const refreshModels=async()=>{try{models.value=apiData<TwinModelResource[]>(await digitalTwinApi.listModels({}));}catch(error){ElMessage.warning(errorText(error,'资源库加载失败'));}};
const loadScenes=async()=>{scenes.value=apiData<DigitalTwinSceneSummary[]>(await digitalTwinApi.listScenes());};
const loadScene=async(id:string|number|boolean)=>{
	if(typeof id!=='string'||!id)return;
	if(dirty.value){const confirmed=await ElMessageBox.confirm('切换场景会丢弃当前未保存修改。','未保存草稿',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed){selectedSceneId.value=currentScene.value?.id||'';return;}}
	busy.value=true;try{const scene=apiData<DigitalTwinSceneDetail>(await digitalTwinApi.getScene(id));currentScene.value=scene;selectedSceneId.value=id;manifest.value=normalizeStudioManifest(scene.draftPayload);mode.value='design';dirty.value=false;serverCheck.value='idle';diagnostics.value=inspectStudioManifest(manifest.value);await refreshModels();await buildSurface();}
	catch(error){ElMessage.error(errorText(error,'场景读取失败'));}
	finally{busy.value=false;}
};
const ensureRegisteredComponents=async(target:TwinSceneManifest=manifest.value)=>{
	const objects=(target.objects as TwinV7SceneObjectDefinition[]).filter(item=>item.kind==='component');
	const keys=[...new Set(objects.map(item=>item.component?.resourceKey).filter((key):key is string=>Boolean(key)))];
	const missing=keys.filter(key=>!models.value.some(model=>model.resourceKey===key));
	if(missing.length){
		const payloads=builtInComponentResourceRegistrations.filter(item=>missing.includes(item.resourceKey));
		if(payloads.length!==missing.length)throw new Error('内置组件注册定义不完整');
		const registered=apiData<TwinModelResource[]>(await digitalTwinApi.registerComponentResources(payloads));
		models.value=[...models.value.filter(item=>!registered.some(resource=>resource.id===item.id)),...registered];
	}
	for(const object of objects){const model=models.value.find(item=>item.resourceKey===object.component?.resourceKey);if(!model)throw new Error('组件资源未入库：'+object.name);object.resourceId=model.id;}
	for(const model of models.value.filter(item=>objects.some(object=>object.resourceId===item.id))){if(!target.resources.some(item=>item.resourceId===model.id))target.resources.push({resourceId:model.id,name:model.name,status:'ready'});}
};
const saveDraft=async():Promise<boolean>=>{
	if(!currentScene.value){ElMessage.warning('请先创建或选择数据库场景');return false;}
	if(mode.value!=='design'){ElMessage.warning('请返回设计模式保存');return false;}
	saving.value=true;
	try{
		captureDraft();await ensureRegisteredComponents();
		diagnostics.value=inspectStudioManifest(manifest.value);
		const scene=apiData<DigitalTwinSceneDetail>(await digitalTwinApi.saveDraft(currentScene.value.id,currentScene.value.revision,manifest.value));
		currentScene.value=scene;dirty.value=false;serverCheck.value='idle';await loadScenes();
		if(localErrorCount.value){bottomTab.value='quality';ElMessage.warning('草稿 r'+scene.revision+' 已保存，但仍有 '+localErrorCount.value+' 项工程错误需要修复后才能发布');}
		else ElMessage.success('草稿 r'+scene.revision+' 已保存');
		return true;
	}catch(error){ElMessage.error(errorText(error,'保存失败，可能出现版本冲突；本地修改仍保留'));return false;}
	finally{saving.value=false;}
};
const verifyOnServer=async():Promise<boolean>=>{
	if(!currentScene.value)return false;
	verifying.value=true;try{
		if(dirty.value&&!(await saveDraft()))return false;
		if(localErrorCount.value){serverCheck.value='failed';bottomTab.value='quality';ElMessage.error('本地工程校验仍有 '+localErrorCount.value+' 项错误，不能通过发布闸口');return false;}
		const result=apiData<{valid:boolean;diagnostics:typeof diagnostics.value}>(await digitalTwinApi.validateScene(currentScene.value.id,false));
		serverCheck.value=result.valid?'passed':'failed';if(result.diagnostics?.length)diagnostics.value=[...diagnostics.value,...result.diagnostics];
		result.valid?ElMessage.success('服务端校验通过'):ElMessage.error('服务端校验未通过');return result.valid;
	}catch(error){serverCheck.value='failed';ElMessage.error(errorText(error,'服务端校验失败'));return false;}
	finally{verifying.value=false;}
};
const publishScene=async()=>{
	if(!currentScene.value)return;
	const confirmed=await ElMessageBox.confirm('发布会生成不可变的线上版本。请确认相关 PLC / Live 绑定已单独验收。','发布工业场景',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed)return;
	publishing.value=true;
	try{
		if(dirty.value&&!(await saveDraft()))return;
		diagnostics.value=inspectStudioManifest(manifest.value);
		if(localErrorCount.value){serverCheck.value='failed';bottomTab.value='quality';ElMessage.error('草稿存在 '+localErrorCount.value+' 项结构错误，发布已被阻止');return;}
		const validation=apiData<{valid:boolean;diagnostics:typeof diagnostics.value}>(await digitalTwinApi.validateScene(currentScene.value.id,true));
		serverCheck.value=validation.valid?'passed':'failed';if(!validation.valid){diagnostics.value=[...diagnostics.value,...validation.diagnostics];bottomTab.value='quality';ElMessage.error('发布前校验未通过');return;}
		const version=apiData<TwinSceneVersion>(await digitalTwinApi.publishScene(currentScene.value.id,currentScene.value.revision,'Studio V2 工程发布'));
		ElMessage.success('场景版本 v'+version.version+' 已发布');await loadScene(currentScene.value.id);
	}catch(error){ElMessage.error(errorText(error,'发布失败'));}
	finally{publishing.value=false;}
};
const openCreate=async()=>{if(dirty.value){const confirmed=await ElMessageBox.confirm('当前场景有未保存修改。创建新场景不会迁移这些修改，是否继续？','保存提醒',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed)return;}createForm.name='新建工业数字孪生场景';createForm.assetId=assets.value[0]?.id||'';createForm.template='blank';createVisible.value=true;};
const createScene=async()=>{
	if(!createForm.name.trim()||!createForm.assetId){ElMessage.warning('场景名称与根资产不能为空');return;}
	creating.value=true;try{
		const draft=normalizeStudioManifest(createForm.template==='reference'?createReferencePackagingLineTwinSceneManifest():createBlankTwinSceneManifest());
		draft.name=createForm.name.trim();draft.rootAssetId=createForm.assetId;for(const object of draft.objects)object.assetId=createForm.assetId;
		await ensureRegisteredComponents(draft);
		const scene=apiData<DigitalTwinSceneDetail>(await digitalTwinApi.createScene({name:draft.name,description:draft.description,rootAssetId:createForm.assetId,draftPayload:draft}));
		createVisible.value=false;dirty.value=false;await loadScenes();await loadScene(scene.id);ElMessage.success('新版场景已创建；旧版工作台未修改');
	}catch(error){ElMessage.error(errorText(error,'场景创建失败'));}
	finally{creating.value=false;}
};
const loadReferenceTemplate=async()=>{
	if(mode.value!=='design')return;
	if(manifest.value.objects.length||dirty.value){const confirmed=await ElMessageBox.confirm('将替换当前本地草稿中的全部模型和动作定义，不会自动保存到数据库。','加载参考产线',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed)return;}
	const draft=createReferencePackagingLineTwinSceneManifest();draft.sceneId=manifest.value.sceneId;draft.rootAssetId=manifest.value.rootAssetId;for(const item of draft.objects)item.assetId=draft.rootAssetId||undefined;
	manifest.value=normalizeStudioManifest(draft);dirty.value=true;serverCheck.value='idle';diagnostics.value=inspectStudioManifest(manifest.value);await buildSurface();
};
const placeComponent=async(key:string,position:TwinVector3=[0,0,0])=>{
	if(mode.value!=='design'||placing.value)return;
	const item=builtInComponentTemplates.find(template=>template.resourceKey===key);if(!item)return;
	placing.value=true;try{
		const reg=builtInComponentResourceRegistrations.find(resource=>resource.resourceKey===key);
		if(!reg)throw new Error('组件资源注册数据不存在');
		let model=models.value.find(resource=>resource.resourceKey===key);
		if(!model){model=apiData<TwinModelResource>(await digitalTwinApi.upsertComponentResource(reg));models.value=[...models.value,model];}
		const objectId='component-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36));
		const object:TwinV7SceneObjectDefinition={kind:'component',objectId,name:item.name,resourceId:model.id,assetId:manifest.value.rootAssetId||undefined,component:{resourceKey:key,componentType:item.componentType,generator:item.generator,generatorVersion:item.generatorVersion,properties:structuredClone(item.defaultProperties),sectionId:'section-'+objectId},transform:{position:[position[0],0,position[2]],rotation:[0,0,0],scale:[1,1,1]}};
		(manifest.value.objects as TwinV7SceneObjectDefinition[]).push(object);
		if(!manifest.value.resources.some(resource=>resource.resourceId===model!.id))manifest.value.resources.push({resourceId:model.id,name:model.name,status:'ready'});
		ensureComponentActuators(manifest.value,[objectId]);manifest.value.connections||=[];upsertGeneratedComponentRoute(manifest.value);
		const snapped=snapSceneComponent(manifest.value,objectId);if(snapped)editor.value?.reloadAllComponents();else editor.value?.loadComponent(object);
		editor.value?.selectObject(objectId);onChanged();sideTab.value='tree';ElMessage.success(item.name+' 已加入工程场景');
	}catch(error){ElMessage.error(errorText(error,'组件放置失败'));}
	finally{placing.value=false;}
};
const placeModel=async(id:string,position:TwinVector3=[0,0,0])=>{
	if(mode.value!=='design'||placing.value)return;const model=readyModels.value.find(item=>item.id===id);if(!model)return;
	placing.value=true;const object: TwinSceneObjectDefinition={objectId:'model-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)),name:model.name,kind:'model',resourceId:id,assetId:manifest.value.rootAssetId||undefined,transform:{position:[position[0],0,position[2]],rotation:[0,0,0],scale:[1,1,1]}};
	try{const file=await getModelBuffer(model);manifest.value.objects.push(object);if(!manifest.value.resources.some(item=>item.resourceId===id))manifest.value.resources.push({resourceId:id,name:model.name,sourceFileName:file.fileName,status:'ready'});await editor.value?.loadGlbBuffer(object,file.fileName,file.buffer);onChanged();sideTab.value='tree';}
	catch(error){manifest.value.objects=manifest.value.objects.filter(item=>item.objectId!==object.objectId);ElMessage.error(errorText(error,'GLB 模型放置失败'));}
	finally{placing.value=false;}
};
const dragComponent=(event:DragEvent,key:string)=>{event.dataTransfer?.setData('application/x-iotsharp-studio-v2','component:'+key);if(event.dataTransfer)event.dataTransfer.effectAllowed='copy';dragging.value=true;};
const dragModel=(event:DragEvent,id:string)=>{event.dataTransfer?.setData('application/x-iotsharp-studio-v2','model:'+id);if(event.dataTransfer)event.dataTransfer.effectAllowed='copy';dragging.value=true;};
const dragOver=(event:DragEvent)=>{if(mode.value==='design'&&event.dataTransfer)event.dataTransfer.dropEffect='copy';};
const dropOnViewport=async(event:DragEvent)=>{
	dragging.value=false;if(mode.value!=='design')return;
	const raw=event.dataTransfer?.getData('application/x-iotsharp-studio-v2');if(!raw)return;
	const index=raw.indexOf(':');if(index<0)return;
	const position=editor.value?.worldPositionFromClientPoint(event.clientX,event.clientY,0)||[0,0,0] as TwinVector3;
	if(raw.slice(0,index)==='component')await placeComponent(raw.slice(index+1),position);
	else if(raw.slice(0,index)==='model')await placeModel(raw.slice(index+1),position);
};
const removeSelected=async()=>{
	const object=selectedObject.value;if(!object||mode.value!=='design')return;
	const confirmed=await ElMessageBox.confirm('从当前草稿移除 '+object.name+'？相关组件连接将同步清理。','移除对象',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed)return;
	manifest.value.objects=manifest.value.objects.filter(item=>item.objectId!==object.objectId);removeConnectionsForObject(manifest.value,object.objectId);editor.value?.removeObject(object.objectId);upsertGeneratedComponentRoute(manifest.value);editor.value?.refreshRouteOverlay();selectedObjectId.value='';onChanged();
};
const openVersions=async()=>{if(!currentScene.value){ElMessage.warning('尚未创建数据库场景');return;}try{versions.value=apiData<TwinSceneVersion[]>(await digitalTwinApi.listVersions(currentScene.value.id));versionsVisible.value=true;}catch(error){ElMessage.error(errorText(error,'历史版本读取失败'));}};
const rollback=async(version:number)=>{
	if(!currentScene.value)return;const confirmed=await ElMessageBox.confirm('将从已发布 v'+version+' 创建新草稿，不覆盖当前线上版本。','版本回滚',{type:'warning'}).then(()=>true).catch(()=>false);if(!confirmed)return;
	try{await digitalTwinApi.rollback(currentScene.value.id,version);dirty.value=false;versionsVisible.value=false;await loadScene(currentScene.value.id);ElMessage.success('已创建新草稿，请复核后发布');}catch(error){ElMessage.error(errorText(error,'回滚失败'));}
};
onMounted(async()=>{try{busy.value=true;const response=await assetApi().assetList({offset:0,limit:500,name:''});assets.value=response.data.rows||[];await Promise.all([loadScenes(),refreshModels()]);const requested=String(route.query.sceneId||'');if(requested)await loadScene(requested);else await buildSurface();}catch(error){ElMessage.warning(errorText(error,'场景列表未加载，保留本地编辑草稿'));await buildSurface();}finally{busy.value=false;}});
onBeforeUnmount(destroySurface);
</script>

<style scoped lang="scss">
@use './studio.scss';
</style>
