<template>
	<div class="component-studio" :class="`is-${mode}`" :style="studioPanelStyle">
		<header class="studio-toolbar">
			<div class="studio-brand">
				<span>IoTSharp Component Studio</span>
				<div><strong>{{ definition.name }}</strong><el-tag size="small" :type="definition.status === 'Published' ? 'success' : 'warning'">{{ definition.status }} · r{{ definition.revision }}<template v-if="definition.publishedVersion"> · v{{ definition.publishedVersion }}</template></el-tag></div>
			</div>
			<div class="studio-toolbar__actions">
				<el-button @click="newComponent">新建</el-button>
				<el-button @click="glbInput?.click()">导入 GLB</el-button>
				<input ref="glbInput" type="file" class="is-hidden" accept=".glb,model/gltf-binary" @change="importGlb" />
				<el-button :disabled="!hasLocalDraft" @click="restoreDraft">恢复本地草稿</el-button>
				<el-segmented v-model="mode" :options="modeOptions" />
				<el-button-group>
					<el-button :disabled="!canCopyStudioPart" title="Ctrl+C / Cmd+C" @click="copySelectedPart()">复制</el-button>
					<el-button :disabled="!canPasteStudioPart" title="Ctrl+V / Cmd+V" @click="pasteCopiedPart()">粘贴</el-button>
				</el-button-group>
				<el-tag v-if="selectedPartIds.length > 1" type="warning" effect="dark">已选 {{ selectedPartIds.length }} 项</el-tag>
				<el-button-group>
					<el-button :disabled="!canStudioUndo || mode !== 'design'" title="Ctrl+Z" @click="undoStudio">撤销</el-button>
					<el-button :disabled="!canStudioRedo || mode !== 'design'" title="Ctrl+Y / Ctrl+Shift+Z" @click="redoStudio">重做</el-button>
				</el-button-group>
				<el-button type="primary" plain @click="saveDraft">保存本地草稿</el-button>
				<el-button type="success" @click="publishLocal">本地发布预览</el-button>
				<el-button @click="router.push('/iot/digital-twin/workbench')">返回三维场景</el-button>
			</div>
		</header>

		<main class="studio-layout">
			<aside v-if="mode === 'design'" class="studio-panel studio-left">
				<el-tabs v-model="leftTab" stretch class="studio-left-tabs">
					<el-tab-pane label="组件库" name="library" />
					<el-tab-pane :label="`结构 ${definition.parts.length}`" name="structure" />
				</el-tabs>
				<template v-if="leftTab === 'library'">
					<div class="catalog-toolbar">
						<el-input v-model="catalogSearch" clearable size="small" placeholder="搜索辊道 / 托盘 / 旋转台…" />
						<el-button size="small" :loading="catalogLoading" @click="loadCatalogModels">刷新</el-button>
					</div>
					<div class="catalog-summary">现有组件 {{ filteredCatalogComponents.length }} / {{ catalogComponents.length }}</div>
					<div class="catalog-list">
						<div v-for="item in filteredCatalogComponents" :key="item.resourceKey" class="catalog-card">
							<div class="catalog-card__main"><strong>{{ item.name }}</strong><small>{{ item.componentType }} · {{ item.category }}</small><span>{{ item.tags.slice(0,3).join(' · ') }}</span></div>
							<div class="catalog-card__actions"><el-tag size="small" :type="item.registered ? 'success' : 'info'">{{ item.registered ? '已入库' : '内置' }}</el-tag><el-button size="small" text type="primary" :disabled="!item.canLoad" @click="loadCatalogComponent(item)">载入</el-button></div>
						</div>
						<el-empty v-if="filteredCatalogComponents.length === 0" description="没有匹配的现有组件" :image-size="52" />
					</div>
					<el-alert type="info" :closable="false" show-icon title="载入不会修改场景实例"><template #default><small>这里载入的是组件模板/资源定义。载入后先形成当前设计草稿，参数修改会实时重新生成预览。</small></template></el-alert>
				</template>
				<template v-else>
					<div class="panel-heading"><div><span>STRUCTURE</span><strong>组件结构</strong></div><el-tag size="small">{{ definition.parts.length }}</el-tag></div>
					<div class="component-tree">
						<button v-for="part in definition.parts" :key="part.id" :class="{ 'is-active': selectedPartIds.includes(part.id) }" @click="selectPart(part.id, $event)">
							<i :class="part.kind"></i><span>{{ part.name }}</span><small>{{ partKindText(part.kind) }}</small><b @click.stop="removePart(part.id)">×</b>
						</button>
						<el-empty v-if="definition.parts.length === 0" description="还没有零件" :image-size="56" />
					</div>
					<div v-if="selectedPart?.kind === 'component' && !isMultiSelect" class="generated-structure">
						<div class="generated-structure__title"><span>生成结构</span><small>{{ generatedStructure.length }} 个节点/实例</small></div>
						<div class="generated-structure__list">
							<div v-for="node in generatedStructure" :key="node.nodeKey" class="generated-node-row" :class="{ 'is-selected': selectedGeneratedNodeKey === node.nodeKey, 'is-hidden': node.hidden }" :style="{ paddingLeft: `${8 + node.depth * 12}px` }" @click="selectGeneratedNode(node)">
								<span class="generated-node-row__name">{{ node.name }}</span>
								<el-tag size="small" effect="plain">{{ node.type }}</el-tag>
								<el-button size="small" text :type="node.hidden ? 'success' : 'danger'" @click.stop="setGeneratedNodeHidden(node, !node.hidden)">{{ node.hidden ? '恢复' : '删除' }}</el-button>
							</div>
							<el-empty v-if="generatedStructure.length === 0" description="当前生成器没有可展开结构" :image-size="42" />
						</div>
						<small class="generated-structure__tip">“删除”和单节点变换都是非破坏性加工覆盖，不会修改系统内置模板。InstancedMesh 会展开到每一根滚筒/支腿实例，单个实例也可以独立移动、旋转和缩放。</small>
					</div>
					<div class="panel-heading sub"><div><span>PRIMITIVES</span><strong>基础几何体</strong></div></div>
					<div class="primitive-grid">
						<button v-for="item in primitives" :key="item.kind" @click="addPrimitive(item.kind)"><span>{{ item.symbol }}</span><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></button>
					</div>
					<el-alert type="info" :closable="false" show-icon title="工业组件建议"><template #default><small>基础结构优先用参数化几何体；厂家设备外观可导入 GLB。Port、碰撞体、遥测和动画都属于组件定义，而不是场景实例。</small></template></el-alert>
				</template>
			</aside>
			<div v-if="mode === 'design'" class="panel-resizer panel-resizer--left" title="拖动调整组件结构宽度" @pointerdown="beginPanelResize('left', $event)"></div>

			<section class="studio-stage">
				<div class="stage-toolbar">
					<template v-if="mode === 'design'">
						<el-button-group size="small" class="transform-tool-group"><el-button :type="transformMode === 'translate' ? 'primary' : 'default'" @click="setTransformMode('translate')">移动</el-button><el-button :type="transformMode === 'rotate' ? 'primary' : 'default'" @click="setTransformMode('rotate')">旋转</el-button><el-button :type="transformMode === 'scale' ? 'primary' : 'default'" @click="setTransformMode('scale')">缩放</el-button></el-button-group>
					</template>
					<el-button-group size="small"><el-button @click="viewport?.setCameraPreset('iso')">等轴</el-button><el-button @click="viewport?.setCameraPreset('front')">正视</el-button><el-button @click="viewport?.setCameraPreset('side')">侧视</el-button><el-button @click="viewport?.setCameraPreset('top')">俯视</el-button><el-button @click="viewport?.fit()">适配</el-button></el-button-group>
					<el-checkbox v-model="helpers.ports">Port</el-checkbox>
					<el-checkbox v-model="helpers.collisions">碰撞体</el-checkbox>
					<el-checkbox v-model="helpers.origin">原点</el-checkbox>
					<el-checkbox v-model="helpers.grid" :disabled="mode === 'preview'">网格</el-checkbox>
				</div>
				<div ref="viewportHost" class="studio-viewport"></div>
				<div class="stage-badge"><strong>{{ modeText }}</strong><span>{{ stageHint }}</span></div>
				<div v-if="mode === 'preview'" class="preview-watermark">FINAL COMPONENT PREVIEW</div>
			</section>
			<div v-if="mode === 'design'" class="panel-resizer panel-resizer--right" title="拖动调整组件属性宽度" @pointerdown="beginPanelResize('right', $event)"></div>

			<aside v-if="mode === 'design'" class="studio-panel studio-right">
				<div class="panel-heading"><div><span>INSPECTOR</span><strong>组件属性</strong></div></div>
				<el-tabs v-model="activeTab" stretch>
					<el-tab-pane label="属性" name="properties" />
					<el-tab-pane :label="`Port ${definition.ports.length}`" name="ports" />
					<el-tab-pane :label="`碰撞 ${definition.collisions.length}`" name="collision" />
					<el-tab-pane label="遥测" name="telemetry" />
					<el-tab-pane label="动画" name="animation" />
				</el-tabs>

				<div v-if="activeTab === 'properties'" class="inspector-scroll">
					<div class="form-card component-meta">
						<label>组件名称<el-input v-model="definition.name" /></label>
						<label>Resource Key<el-input v-model="definition.resourceKey" /></label>
						<label>分类<el-input v-model="definition.category" /></label>
						<label>说明<el-input v-model="definition.description" type="textarea" :rows="2" /></label>
					</div>
					<el-alert v-if="isMultiSelect" type="warning" :closable="false" show-icon :title="`已选择 ${selectedPartIds.length} 个零件`"><template #default><small>Ctrl / Cmd 点击可继续增减选择；多选状态支持复制、粘贴和 Delete 批量删除。为避免误改，单体属性和 Gizmo 暂时禁用。</small></template></el-alert>
					<div v-if="selectedPart && !isMultiSelect" class="form-card">
						<div class="form-card__title"><strong>{{ selectedPart.name }}</strong><el-tag size="small">{{ partKindText(selectedPart.kind) }}</el-tag></div>
						<label>零件名称<el-input v-model="selectedPart.name" /></label>
						<span class="section-label">位置 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`p${i}`" v-model="selectedPart.transform.position[i]" :step="0.1" :precision="2" controls-position="right" /></div>
						<span class="section-label">旋转 XYZ（°）</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`r${i}`" v-model="selectedPart.transform.rotation[i]" :step="5" :precision="1" controls-position="right" /></div>
						<span class="section-label">缩放 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`s${i}`" v-model="selectedPart.transform.scale[i]" :step="0.1" :min="0.01" :precision="2" controls-position="right" /></div>
						<template v-if="selectedPart.kind === 'box' || selectedPart.kind === 'plane'">
							<span class="section-label">尺寸</span><div class="triple"><el-input-number v-model="selectedPart.geometry.width" :min="0.01" :step="0.1" /><el-input-number v-if="selectedPart.kind === 'box'" v-model="selectedPart.geometry.height" :min="0.01" :step="0.1" /><el-input-number v-model="selectedPart.geometry.depth" :min="0.01" :step="0.1" /></div>
						</template>
						<template v-else-if="selectedPart.kind === 'cylinder'">
							<span class="section-label">圆柱参数</span><div class="triple"><el-input-number v-model="selectedPart.geometry.radiusTop" :min="0.01" :step="0.1" /><el-input-number v-model="selectedPart.geometry.radiusBottom" :min="0.01" :step="0.1" /><el-input-number v-model="selectedPart.geometry.height" :min="0.01" :step="0.1" /></div>
						</template>
						<template v-else-if="selectedPart.kind === 'sphere'">
							<label>半径<el-input-number v-model="selectedPart.geometry.radius" :min="0.01" :step="0.1" /></label>
						</template>
						<template v-if="selectedPart.kind === 'component' && selectedPart.source?.component">
							<el-alert type="success" :closable="false" :title="`V7 参数化组件 · ${selectedPart.source.component.generator}@${selectedPart.source.component.generatorVersion}`" />
							<div class="component-parameter-list">
								<label v-for="schema in selectedPart.source.component.propertySchema" :key="schema.key">
									<span>{{ schema.label }}<small v-if="schema.unit">{{ schema.unit }}</small></span>
									<el-input-number v-if="schema.type === 'number'" :model-value="componentNumberValue(schema.key)" :min="schema.min" :max="schema.max" :step="schema.step || 0.1" controls-position="right" @update:model-value="setComponentProperty(schema.key,$event)" />
									<el-switch v-else-if="schema.type === 'boolean'" :model-value="Boolean(componentPropertyValue(schema.key))" @update:model-value="setComponentProperty(schema.key,$event)" />
									<el-select v-else-if="schema.type === 'select'" :model-value="componentPropertyValue(schema.key)" @update:model-value="setComponentProperty(schema.key,$event)"><el-option v-for="option in schema.options || []" :key="String(option.value)" :label="option.label" :value="option.value" /></el-select>
									<el-input v-else :model-value="String(componentPropertyValue(schema.key) ?? '')" @update:model-value="setComponentProperty(schema.key,$event)" />
									<small v-if="schema.description">{{ schema.description }}</small>
								</label>
							</div>
						</template>
						<div v-if="['box','cylinder','sphere','plane'].includes(selectedPart.kind)" class="material-row"><label>颜色<el-color-picker v-model="selectedPart.material.color" /></label><label>透明度<el-slider v-model="selectedPart.material.opacity" :min="0.05" :max="1" :step="0.05" /></label></div>
						<el-alert v-if="selectedPart.kind === 'glb'" type="warning" :closable="false" :title="selectedPart.source?.transient ? '当前 GLB 仅在本次浏览器会话中加载；后续接模型资源库后改为稳定 ResourceId。' : 'GLB 外观资源'" />
					</div>
					<div v-if="selectedGeneratedNode && !isMultiSelect" class="form-card generated-node-card">
						<div class="form-card__title"><strong>生成节点 · {{ selectedGeneratedNode.name }}</strong><el-tag size="small">{{ selectedGeneratedNode.type }}</el-tag></div>
						<small class="generated-node-key">{{ selectedGeneratedNode.nodeKey }}</small>
						<template v-if="selectedGeneratedNode.canTransform && selectedGeneratedNode.transform">
							<span class="section-label">内部位置 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`gp${i}`" v-model="selectedGeneratedNode.transform.position[i]" :step="0.05" :precision="3" controls-position="right" @change="commitSelectedGeneratedTransform" /></div>
							<span class="section-label">内部旋转 XYZ（°）</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`gr${i}`" v-model="selectedGeneratedNode.transform.rotation[i]" :step="5" :precision="1" controls-position="right" @change="commitSelectedGeneratedTransform" /></div>
							<span class="section-label">内部缩放 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`gs${i}`" v-model="selectedGeneratedNode.transform.scale[i]" :step="0.05" :min="0.001" :precision="3" controls-position="right" @change="commitSelectedGeneratedTransform" /></div>
						</template>
						<el-alert v-else type="info" :closable="false" title="当前生成节点由父结构控制，暂不支持独立变换。" />
						<el-button :type="selectedGeneratedNode.hidden ? 'success' : 'danger'" plain @click="setGeneratedNodeHidden(selectedGeneratedNode, !selectedGeneratedNode.hidden)">{{ selectedGeneratedNode.hidden ? '恢复这个节点' : '删除这个节点' }}</el-button>
					</div>
					<el-empty v-if="!selectedPart" description="点击左侧零件或直接点击模型以编辑" />
				</div>

				<div v-else-if="activeTab === 'ports'" class="inspector-scroll"><div class="section-actions"><span>连接端口定义</span><el-button size="small" type="primary" @click="addPort">新增 Port</el-button></div><div v-for="port in definition.ports" :key="port.id" class="form-card"><div class="form-card__title"><el-input v-model="port.name" /><el-button text type="danger" @click="removePort(port.id)">删除</el-button></div><label>类型<el-select v-model="port.type"><el-option label="物料输入" value="material-input"/><el-option label="物料输出" value="material-output"/><el-option label="物料双向" value="material-bidirectional"/><el-option label="控制" value="control"/><el-option label="传感器" value="sensor"/><el-option label="机械" value="mechanical"/></el-select></label><span class="section-label">位置 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`pp${port.id}${i}`" v-model="port.position[i]" :step="0.1" /></div><span class="section-label">方向 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`pd${port.id}${i}`" v-model="port.direction[i]" :step="0.1" /></div></div></div>

				<div v-else-if="activeTab === 'collision'" class="inspector-scroll"><div class="section-actions"><span>碰撞体</span><el-button size="small" type="primary" @click="addCollision">新增碰撞体</el-button></div><div v-for="item in definition.collisions" :key="item.id" class="form-card"><div class="form-card__title"><el-input v-model="item.name"/><el-button text type="danger" @click="removeCollision(item.id)">删除</el-button></div><label>形状<el-select v-model="item.kind"><el-option label="Box" value="box"/><el-option label="Sphere" value="sphere"/><el-option label="Cylinder" value="cylinder"/></el-select></label><span class="section-label">位置 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`cp${item.id}${i}`" v-model="item.position[i]" :step="0.1" /></div><template v-if="item.kind === 'box'"><span class="section-label">尺寸 XYZ</span><div class="triple"><el-input-number v-for="(_,i) in 3" :key="`cs${item.id}${i}`" v-model="item.size[i]" :min="0.01" :step="0.1" /></div></template><template v-else><label>半径<el-input-number v-model="item.radius" :min="0.01" :step="0.1" /></label><label v-if="item.kind === 'cylinder'">高度<el-input-number v-model="item.height" :min="0.01" :step="0.1" /></label></template></div></div>

				<div v-else-if="activeTab === 'telemetry'" class="inspector-scroll"><div class="section-actions"><span>Telemetry Capability</span><el-button size="small" type="primary" @click="addTelemetry">新增能力</el-button></div><div v-for="item in definition.telemetry" :key="item.id" class="form-card"><div class="form-card__title"><el-input v-model="item.name"/><el-button text type="danger" @click="removeTelemetry(item.id)">删除</el-button></div><label>Telemetry Key<el-input v-model="item.key" /></label><label>驱动目标<el-select v-model="item.target"><el-option label="运行" value="run"/><el-option label="报警" value="alarm"/><el-option label="可见性" value="visible"/><el-option label="速度" value="speed"/><el-option label="颜色" value="color"/></el-select></label><label>说明<el-input v-model="item.description" type="textarea" :rows="2" /></label></div></div>

				<div v-else class="inspector-scroll"><div class="section-actions"><span>动画定义</span><el-button size="small" type="primary" @click="addAnimation">新增动画</el-button></div><div v-for="item in definition.animations" :key="item.id" class="form-card"><div class="form-card__title"><el-input v-model="item.name"/><el-button text type="danger" @click="removeAnimation(item.id)">删除</el-button></div><label>目标零件<el-select v-model="item.targetPartId"><el-option v-for="part in definition.parts" :key="part.id" :label="part.name" :value="part.id" /></el-select></label><label>动画类型<el-select v-model="item.kind"><el-option label="旋转" value="rotate"/><el-option label="显示/隐藏" value="visibility"/><el-option label="颜色" value="color"/></el-select></label><label v-if="item.kind === 'rotate'">轴<el-select v-model="item.axis"><el-option label="X" value="x"/><el-option label="Y" value="y"/><el-option label="Z" value="z"/></el-select></label><label v-if="item.kind === 'rotate'">速度 °/s<el-input-number v-model="item.speed" :step="10" /></label></div></div>
			</aside>

			<aside v-else-if="mode === 'test'" class="studio-panel studio-test-panel">
				<div class="panel-heading"><div><span>RUNTIME TEST</span><strong>运行测试</strong></div></div>
				<div class="test-state"><div><span>Run</span><el-switch v-model="runtime.run" /></div><div><span>Alarm</span><el-switch v-model="runtime.alarm" /></div><div><span>Visible</span><el-switch v-model="runtime.visible" /></div><label>Speed × {{ runtime.speedMultiplier.toFixed(1) }}<el-slider v-model="runtime.speedMultiplier" :min="0.1" :max="4" :step="0.1" /></label></div>
				<div class="test-block"><span>模拟遥测</span><div v-for="item in definition.telemetry" :key="item.id"><strong>{{ item.key }}</strong><small>→ {{ item.target }}</small></div></div>
				<div class="test-block"><span>动画</span><div v-for="item in definition.animations" :key="item.id"><strong>{{ item.name }}</strong><small>{{ item.kind }} · {{ partName(item.targetPartId) }}</small></div><el-empty v-if="!definition.animations.length" description="尚未定义动画" :image-size="50" /></div>
				<el-alert type="success" :closable="false" show-icon title="运行测试只模拟组件能力，不会发送任何 Device 控制命令。" />
			</aside>
		</main>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { digitalTwinApi, type TwinModelResource } from '/@/api/digital-twin';
import { ComponentStudioViewport } from '/@/digital-twin/component-studio/ComponentStudioViewport';
import {
	builtInComponentTemplates,
	defaultComponentRegistry,
	type TwinComponentBindingSlot,
	type TwinComponentPropertySchema,
	type TwinComponentType,
} from '/@/digital-twin/components';
import {
	cloneComponentStudioDefinition,
	cloneStudioPartForPaste,
	cloneStudioPartsForPaste,
	createBlankComponentStudioDefinition,
	createComponentStudioId,
	createStudioPart,
	type ComponentStudioDefinition,
	type ComponentStudioMode,
	type StudioGeneratedNodeInfo,
	type StudioGeneratedNodeTransform,
	type StudioPartDefinition,
	type StudioPrimitiveKind,
} from '/@/digital-twin/component-studio/types';

const router = useRouter();
const viewportHost = ref<HTMLDivElement>();
const glbInput = ref<HTMLInputElement>();
const viewport = ref<ComponentStudioViewport>();
const mode = ref<ComponentStudioMode>('design');
const leftTab = ref<'library' | 'structure'>('library');
const activeTab = ref('properties');
const selectedPartId = ref('');
const selectedPartIds = ref<string[]>([]);
const selectedGeneratedNodeKey = ref('');
const generatedStructure = ref<StudioGeneratedNodeInfo[]>([]);
const transformMode = ref<'translate' | 'rotate' | 'scale'>('translate');
const definition = reactive<ComponentStudioDefinition>(createBlankComponentStudioDefinition());
const studioHistory = ref<ComponentStudioDefinition[]>([]);
const studioHistoryIndex = ref(-1);
const partClipboard = ref<StudioPartDefinition[]>([]);
const canStudioUndo = computed(() => studioHistoryIndex.value > 0);
const canStudioRedo = computed(() => studioHistoryIndex.value >= 0 && studioHistoryIndex.value < studioHistory.value.length - 1);
const helpers = reactive({ ports: true, collisions: true, origin: true, grid: true });
const runtime = reactive({ run: false, alarm: false, visible: true, speedMultiplier: 1 });
const hasLocalDraft = ref(Boolean(localStorage.getItem('iotsharp.component-studio.draft')));
const catalogSearch = ref('');
const catalogLoading = ref(false);
const catalogModels = ref<TwinModelResource[]>([]);
const leftPanelWidth = ref(250);
const rightPanelWidth = ref(350);
const studioPanelStyle = computed(() => ({
	'--studio-left-width': `${leftPanelWidth.value}px`,
	'--studio-right-width': `${rightPanelWidth.value}px`,
}));
let suppressDirty = false;
let restoringStudioHistory = false;
let studioHistoryTimer: number | undefined;
let resizingPanel: 'left' | 'right' | '' = '';
let resizeStartX = 0;
let resizeStartWidth = 0;
let previousBodyCursor = '';
let previousBodyUserSelect = '';

interface StudioCatalogComponent {
	resourceKey: string;
	resourceId?: string;
	name: string;
	componentType: TwinComponentType;
	generator: string;
	generatorVersion: number;
	category: string;
	tags: string[];
	properties: Record<string, unknown>;
	propertySchema: TwinComponentPropertySchema[];
	bindingSlots: TwinComponentBindingSlot[];
	registered: boolean;
	canLoad: boolean;
}

const apiData = <T,>(response: any): T => response.data as T;
const clampPanelWidth = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const studioHistorySnapshot = () => cloneComponentStudioDefinition(definition);
const studioHistoryKey = (value: ComponentStudioDefinition) => {
	const copy = cloneComponentStudioDefinition(value);
	copy.revision = 0;
	copy.publishedVersion = 0;
	copy.status = 'Draft';
	return JSON.stringify(copy);
};
const resetStudioHistory = () => {
	if (studioHistoryTimer !== undefined) window.clearTimeout(studioHistoryTimer);
	studioHistoryTimer = undefined;
	studioHistory.value = [studioHistorySnapshot()];
	studioHistoryIndex.value = 0;
};
const pushStudioHistory = () => {
	if (restoringStudioHistory || mode.value !== 'design') return;
	const next = studioHistorySnapshot();
	const current = studioHistoryIndex.value >= 0 ? studioHistory.value[studioHistoryIndex.value] : undefined;
	if (current && studioHistoryKey(current) === studioHistoryKey(next)) return;
	studioHistory.value = studioHistory.value.slice(0, studioHistoryIndex.value + 1);
	studioHistory.value.push(next);
	if (studioHistory.value.length > 80) studioHistory.value.shift();
	studioHistoryIndex.value = studioHistory.value.length - 1;
};
const scheduleStudioHistory = () => {
	if (restoringStudioHistory || mode.value !== 'design') return;
	if (studioHistoryTimer !== undefined) window.clearTimeout(studioHistoryTimer);
	studioHistoryTimer = window.setTimeout(() => { studioHistoryTimer = undefined; pushStudioHistory(); }, 180);
};
const restoreStudioHistory = (index: number) => {
	const snapshot = studioHistory.value[index];
	if (!snapshot) return;
	if (studioHistoryTimer !== undefined) window.clearTimeout(studioHistoryTimer);
	studioHistoryTimer = undefined;
	restoringStudioHistory = true;
	const next = cloneComponentStudioDefinition(snapshot);
	next.revision = definition.revision;
	next.publishedVersion = definition.publishedVersion;
	next.status = definition.status;
	replaceDefinition(next);
	studioHistoryIndex.value = index;
	nextTick(() => { restoringStudioHistory = false; });
};
const undoStudio = () => { if (canStudioUndo.value) restoreStudioHistory(studioHistoryIndex.value - 1); };
const redoStudio = () => { if (canStudioRedo.value) restoreStudioHistory(studioHistoryIndex.value + 1); };

const handlePanelResizeMove = (event: PointerEvent) => {
	if (!resizingPanel) return;
	const delta = event.clientX - resizeStartX;
	if (resizingPanel === 'left') leftPanelWidth.value = clampPanelWidth(resizeStartWidth + delta, 180, 520);
	else rightPanelWidth.value = clampPanelWidth(resizeStartWidth - delta, 260, 600);
};

const stopPanelResize = () => {
	if (!resizingPanel) return;
	resizingPanel = '';
	window.removeEventListener('pointermove', handlePanelResizeMove);
	window.removeEventListener('pointerup', stopPanelResize);
	window.removeEventListener('pointercancel', stopPanelResize);
	document.body.style.cursor = previousBodyCursor;
	document.body.style.userSelect = previousBodyUserSelect;
};

const beginPanelResize = (side: 'left' | 'right', event: PointerEvent) => {
	event.preventDefault();
	stopPanelResize();
	resizingPanel = side;
	resizeStartX = event.clientX;
	resizeStartWidth = side === 'left' ? leftPanelWidth.value : rightPanelWidth.value;
	previousBodyCursor = document.body.style.cursor;
	previousBodyUserSelect = document.body.style.userSelect;
	document.body.style.cursor = 'col-resize';
	document.body.style.userSelect = 'none';
	window.addEventListener('pointermove', handlePanelResizeMove);
	window.addEventListener('pointerup', stopPanelResize);
	window.addEventListener('pointercancel', stopPanelResize);
};

const modeOptions = [{ label: '设计', value: 'design' }, { label: '预览', value: 'preview' }, { label: '运行测试', value: 'test' }];
const primitives: Array<{ kind: StudioPrimitiveKind; label: string; symbol: string; hint: string }> = [
	{ kind: 'box', label: 'Box', symbol: '▣', hint: '机架 / 箱体' },
	{ kind: 'cylinder', label: 'Cylinder', symbol: '●', hint: '滚筒 / 电机' },
	{ kind: 'sphere', label: 'Sphere', symbol: '◉', hint: '指示 / 关节' },
	{ kind: 'plane', label: 'Plane', symbol: '▱', hint: '面板 / 地板' },
];
const selectedPart = computed(() => definition.parts.find((item) => item.id === selectedPartId.value));
const selectedGeneratedNode = computed(() => generatedStructure.value.find((item) => item.nodeKey === selectedGeneratedNodeKey.value));
const isMultiSelect = computed(() => selectedPartIds.value.length > 1);
const canCopyStudioPart = computed(() => mode.value === 'design' && selectedPartIds.value.length > 0 && Boolean(selectedPart.value));
const canPasteStudioPart = computed(() => mode.value === 'design' && partClipboard.value.length > 0);
const catalogComponents = computed<StudioCatalogComponent[]>(() => {
	const byKey = new Map<string, StudioCatalogComponent>();
	for (const template of builtInComponentTemplates) {
		const registered = catalogModels.value.find((model) => model.resourceKey === template.resourceKey);
		byKey.set(template.resourceKey, {
			resourceKey: template.resourceKey,
			resourceId: registered?.id,
			name: template.name,
			componentType: template.componentType,
			generator: template.generator,
			generatorVersion: template.generatorVersion,
			category: template.category,
			tags: [...template.tags],
			properties: JSON.parse(JSON.stringify(template.defaultProperties)),
			propertySchema: JSON.parse(JSON.stringify(template.propertySchema)),
			bindingSlots: JSON.parse(JSON.stringify(template.bindingSlots || [])),
			registered: Boolean(registered),
			canLoad: defaultComponentRegistry.has(template.generator, template.generatorVersion),
		});
	}
	for (const model of catalogModels.value.filter((item) => item.runtimeFormat === 'application/vnd.iotsharp.twin-component+json')) {
		const metadata = model.modelMetadata || {};
		const existing = byKey.get(model.resourceKey);
		if (existing) {
			existing.resourceId = model.id;
			existing.registered = true;
			continue;
		}
		if (!metadata.componentType || !metadata.generator || !metadata.generatorVersion) continue;
		byKey.set(model.resourceKey, {
			resourceKey: model.resourceKey,
			resourceId: model.id,
			name: model.name,
			componentType: metadata.componentType as TwinComponentType,
			generator: metadata.generator,
			generatorVersion: metadata.generatorVersion,
			category: metadata.category || 'custom',
			tags: [...(metadata.tags || [])],
			properties: JSON.parse(JSON.stringify(metadata.defaultProperties || {})),
			propertySchema: JSON.parse(JSON.stringify(metadata.componentSchema?.properties || [])) as TwinComponentPropertySchema[],
			bindingSlots: JSON.parse(JSON.stringify(metadata.bindingSlots || [])) as TwinComponentBindingSlot[],
			registered: true,
			canLoad: defaultComponentRegistry.has(metadata.generator, metadata.generatorVersion),
		});
	}
	return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
});
const filteredCatalogComponents = computed(() => {
	const keyword = catalogSearch.value.trim().toLocaleLowerCase();
	if (!keyword) return catalogComponents.value;
	return catalogComponents.value.filter((item) => `${item.name} ${item.resourceKey} ${item.componentType} ${item.category} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(keyword));
});
const modeText = computed(() => mode.value === 'design' ? '设计模式' : mode.value === 'preview' ? '最终组件预览' : '运行测试');
const stageHint = computed(() => mode.value === 'design' ? '点击零件或画布对象后，可用 Gizmo 和右侧参数加工模型。' : mode.value === 'preview' ? '编辑辅助已隐藏；当前显示的就是组件放入场景后的外观。' : '使用右侧模拟遥测测试动画、报警和可见性。');

const partKindText = (kind: StudioPrimitiveKind) => kind === 'box' ? 'Box' : kind === 'cylinder' ? 'Cylinder' : kind === 'sphere' ? 'Sphere' : kind === 'plane' ? 'Plane' : kind === 'component' ? 'V7 组件' : 'GLB';
const partName = (partId: string) => definition.parts.find((item) => item.id === partId)?.name || '未选择';
const componentPropertyValue = (key: string) => selectedPart.value?.source?.component?.properties[key];
const componentNumberValue = (key: string) => {
	const value = Number(componentPropertyValue(key));
	return Number.isFinite(value) ? value : 0;
};
const setComponentProperty = (key: string, value: unknown) => {
	const component = selectedPart.value?.source?.component;
	if (component) component.properties[key] = value;
};

const loadCatalogModels = async () => {
	catalogLoading.value = true;
	try { catalogModels.value = apiData<TwinModelResource[]>(await digitalTwinApi.listModels({})) || []; }
	catch { catalogModels.value = []; ElMessage.warning('数据库组件资源读取失败，仍可使用内置 V7 组件'); }
	finally { catalogLoading.value = false; }
};

const loadCatalogComponent = (item: StudioCatalogComponent) => {
	if (!item.canLoad) { ElMessage.error(`当前前端没有注册生成器 ${item.generator}@${item.generatorVersion}`); return; }
	const part = createStudioPart('component', 0);
	part.name = item.name;
	part.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
	part.source = { component: {
		resourceKey: item.resourceKey,
		resourceId: item.resourceId,
		componentType: item.componentType,
		generator: item.generator,
		generatorVersion: item.generatorVersion,
		properties: JSON.parse(JSON.stringify(item.properties)),
		propertySchema: JSON.parse(JSON.stringify(item.propertySchema)),
		structuralOverrides: { hiddenNodeKeys: [], nodeTransforms: {} },
	} };
	const built = defaultComponentRegistry.create({
		objectId: part.id,
		name: item.name,
		resourceKey: item.resourceKey,
		resourceId: item.resourceId,
		componentType: item.componentType,
		generator: item.generator,
		generatorVersion: item.generatorVersion,
		properties: JSON.parse(JSON.stringify(item.properties)),
	});
	const ports = built.ports.map((port) => ({
		id: createComponentStudioId('port'),
		name: port.name,
		type: port.type,
		position: [...port.localPosition] as [number, number, number],
		direction: [...port.localDirection] as [number, number, number],
		color: port.type === 'material-input' ? '#22c55e' : port.type === 'material-output' ? '#38bdf8' : '#f59e0b',
	}));
	built.dispose();
	const next = createBlankComponentStudioDefinition();
	next.componentId = createComponentStudioId('component');
	next.resourceKey = item.resourceKey;
	next.name = item.name;
	next.category = item.category;
	next.description = `从现有组件库载入：${item.tags.join('、') || item.componentType}`;
	next.parts = [part];
	next.ports = ports;
	next.collisions = [];
	next.telemetry = item.bindingSlots.map((slot) => ({
		id: createComponentStudioId('telemetry'),
		name: slot.name,
		key: slot.slotId,
		target: slot.semantic === 'fault' ? 'alarm' : 'run',
		description: `${slot.direction} · ${slot.dataType} · ${slot.semantic}${slot.description ? ` · ${slot.description}` : ''}`,
	}));
	next.animations = [];
	replaceDefinition(next);
	mode.value = 'design';
	leftTab.value = 'structure';
	activeTab.value = 'properties';
	nextTick(resetStudioHistory);
	ElMessage.success(`${item.name} 已载入设计器，原参数和 Port 已保留`);
};

const replaceDefinition = (next: ComponentStudioDefinition) => {
	suppressDirty = true;
	for (const key of Object.keys(definition) as Array<keyof ComponentStudioDefinition>) delete (definition as any)[key];
	Object.assign(definition, cloneComponentStudioDefinition(next));
	selectedPartId.value = definition.parts[0]?.id || '';
	selectedPartIds.value = selectedPartId.value ? [selectedPartId.value] : [];
	selectedGeneratedNodeKey.value = '';
	nextTick(() => { viewport.value?.setDefinition(definition); viewport.value?.selectPart(selectedPartId.value); viewport.value?.fit(); refreshGeneratedStructure(); suppressDirty = false; });
};

const newComponent = async () => {
	if (definition.parts.length > 0) {
		const ok = await ElMessageBox.confirm('新建组件会清空当前未保存的页面内容，本地历史草稿不会自动删除。', '新建组件', { type: 'warning' }).then(() => true).catch(() => false);
		if (!ok) return;
	}
	replaceDefinition(createBlankComponentStudioDefinition());
	mode.value = 'design';
	nextTick(resetStudioHistory);
};

const refreshGeneratedStructure = () => {
	const part = selectedPart.value;
	generatedStructure.value = part?.kind === 'component' ? (viewport.value?.getGeneratedStructure(part.id) || []) : [];
	if (selectedGeneratedNodeKey.value && !generatedStructure.value.some((item) => item.nodeKey === selectedGeneratedNodeKey.value)) selectedGeneratedNodeKey.value = '';
};

const ensureStructuralOverrides = () => {
	const component = selectedPart.value?.source?.component;
	if (!component) return undefined;
	component.structuralOverrides ||= { hiddenNodeKeys: [], nodeTransforms: {} };
	component.structuralOverrides.hiddenNodeKeys ||= [];
	component.structuralOverrides.nodeTransforms ||= {};
	return component.structuralOverrides;
};

const syncViewportSelection = () => {
	viewport.value?.setSelectedParts([...selectedPartIds.value], selectedPartId.value);
	nextTick(refreshGeneratedStructure);
};

const applyPartSelection = (partId: string, additive = false) => {
	selectedGeneratedNodeKey.value = '';
	if (!additive) {
		selectedPartIds.value = partId ? [partId] : [];
		selectedPartId.value = partId;
		viewport.value?.selectPart(partId);
		nextTick(refreshGeneratedStructure);
		return;
	}
	const next = new Set(selectedPartIds.value);
	if (next.has(partId)) next.delete(partId); else next.add(partId);
	selectedPartIds.value = [...next];
	selectedPartId.value = next.has(partId) ? partId : (selectedPartIds.value[selectedPartIds.value.length - 1] || '');
	syncViewportSelection();
};

const selectPart = (partId: string, event?: MouseEvent | PointerEvent) =>
	applyPartSelection(partId, Boolean(event && (event.ctrlKey || event.metaKey)));

const selectGeneratedNode = (node: StudioGeneratedNodeInfo) => {
	selectedPartIds.value = [node.partId];
	selectedPartId.value = node.partId;
	selectedGeneratedNodeKey.value = node.nodeKey;
	activeTab.value = 'properties';
	viewport.value?.selectGeneratedNode(node.partId, node.nodeKey);
};
const setGeneratedNodeHidden = (node: StudioGeneratedNodeInfo, hidden: boolean) => {
	if (selectedPartId.value !== node.partId) selectedPartId.value = node.partId;
	selectedPartIds.value = [node.partId];
	const overrides = ensureStructuralOverrides();
	if (!overrides) return;
	const keys = new Set(overrides.hiddenNodeKeys);
	if (hidden) keys.add(node.nodeKey); else keys.delete(node.nodeKey);
	overrides.hiddenNodeKeys = [...keys];
	if (hidden && selectedGeneratedNodeKey.value === node.nodeKey) selectedGeneratedNodeKey.value = '';
	nextTick(refreshGeneratedStructure);
};
const writeGeneratedNodeTransform = (partId: string, nodeKey: string, transform: StudioGeneratedNodeTransform) => {
	selectedPartIds.value = [partId];
	selectedPartId.value = partId;
	const part = definition.parts.find((item) => item.id === partId);
	const component = part?.source?.component;
	if (!component) return;
	component.structuralOverrides ||= { hiddenNodeKeys: [], nodeTransforms: {} };
	component.structuralOverrides.nodeTransforms[nodeKey] = JSON.parse(JSON.stringify(transform));
	selectedGeneratedNodeKey.value = nodeKey;
	nextTick(refreshGeneratedStructure);
};
const commitSelectedGeneratedTransform = () => {
	const node = selectedGeneratedNode.value;
	if (!node?.transform) return;
	writeGeneratedNodeTransform(node.partId, node.nodeKey, node.transform);
};

const copySelectedPart = (notify = true) => {
	if (mode.value !== 'design' || !selectedPart.value || selectedPartIds.value.length === 0) return false;
	const generated = selectedGeneratedNode.value;
	if (generated && selectedPartIds.value.length === 1) {
		const generatedPart = viewport.value?.snapshotGeneratedNodeAsPart(generated.partId, generated.nodeKey);
		if (generatedPart) {
			partClipboard.value = [generatedPart];
			if (notify) ElMessage.success(`已复制内部零件 ${generated.name}`);
			return true;
		}
		if (notify) ElMessage.warning('当前生成节点不是可独立复制的几何体，已复制所属组件');
	}
	const selected = definition.parts.filter((part) => selectedPartIds.value.includes(part.id));
	partClipboard.value = JSON.parse(JSON.stringify(selected)) as StudioPartDefinition[];
	if (notify) ElMessage.success(selected.length > 1 ? `已复制 ${selected.length} 个零件` : `已复制 ${selected[0]?.name || ''}`);
	return selected.length > 0;
};

const makeUniquePartName = (baseName: string, reserved: Set<string>) => {
	let nextName = baseName;
	let suffix = 2;
	while (reserved.has(nextName)) nextName = `${baseName} ${suffix++}`;
	reserved.add(nextName);
	return nextName;
};

const pasteCopiedPart = (notify = true) => {
	const sources = partClipboard.value;
	if (!sources.length || mode.value !== 'design') return false;
	const pastedParts = cloneStudioPartsForPaste(sources);
	const names = new Set(definition.parts.map((item) => item.name));
	for (const pasted of pastedParts) pasted.name = makeUniquePartName(pasted.name, names);
	definition.parts.push(...pastedParts);
	for (let index = 0; index < pastedParts.length; index += 1) {
		const pasted = pastedParts[index];
		const source = sources[index];
		if (pasted.kind === 'glb') viewport.value?.cloneGlbSource(source.id, pasted.id);
	}
	selectedGeneratedNodeKey.value = '';
	selectedPartIds.value = pastedParts.map((part) => part.id);
	selectedPartId.value = pastedParts[pastedParts.length - 1]?.id || '';
	leftTab.value = 'structure';
	activeTab.value = 'properties';
	nextTick(() => {
		viewport.value?.setSelectedParts(selectedPartIds.value, selectedPartId.value);
		refreshGeneratedStructure();
		pushStudioHistory();
	});
	if (notify) ElMessage.success(pastedParts.length > 1 ? `已粘贴 ${pastedParts.length} 个零件` : `已粘贴 ${pastedParts[0]?.name || ''}`);
	return true;
};

const addPrimitive = (kind: StudioPrimitiveKind) => {
	const part = createStudioPart(kind, definition.parts.length);
	definition.parts.push(part);
	selectPart(part.id);
	ElMessage.success(`${part.name} 已加入组件`);
};

const removeParts = (partIds: string[]) => {
	const ids = new Set(partIds);
	if (!ids.size) return;
	definition.parts = definition.parts.filter((item) => !ids.has(item.id));
	definition.animations = definition.animations.filter((item) => !ids.has(item.targetPartId));
	selectedGeneratedNodeKey.value = '';
	const nextPart = definition.parts[0];
	selectedPartIds.value = nextPart ? [nextPart.id] : [];
	selectedPartId.value = nextPart?.id || '';
	nextTick(() => {
		viewport.value?.setSelectedParts(selectedPartIds.value, selectedPartId.value);
		refreshGeneratedStructure();
		pushStudioHistory();
	});
};

const removePart = (partId: string) => removeParts([partId]);

const isEditableDeleteTarget = (target: EventTarget | null) => {
	const element = target instanceof HTMLElement ? target : null;
	if (!element) return false;
	if (element.isContentEditable) return true;
	return Boolean(element.closest('input, textarea, select, [contenteditable="true"], .el-input, .el-textarea, .el-select, .el-input-number, .el-slider, .el-color-picker, .el-date-editor'));
};

const handleStudioDeleteKey = (event: KeyboardEvent) => {
	if (mode.value !== 'design' || isEditableDeleteTarget(event.target)) return;
	const ctrl = event.ctrlKey || event.metaKey;
	const key = event.key.toLowerCase();
	if (ctrl && !event.altKey && key === 'c' && canCopyStudioPart.value) {
		event.preventDefault(); event.stopPropagation(); copySelectedPart(false); return;
	}
	if (ctrl && !event.altKey && key === 'v' && canPasteStudioPart.value) {
		event.preventDefault(); event.stopPropagation(); pasteCopiedPart(false); return;
	}
	if (ctrl && (key === 'y' || (event.shiftKey && key === 'z'))) {
		event.preventDefault(); event.stopPropagation(); redoStudio(); return;
	}
	if (ctrl && !event.shiftKey && key === 'z') {
		event.preventDefault(); event.stopPropagation(); undoStudio(); return;
	}
	if (event.key !== 'Delete' || ctrl || event.altKey) return;
	if (selectedPartIds.value.length > 1) {
		event.preventDefault();
		event.stopPropagation();
		removeParts([...selectedPartIds.value]);
		return;
	}
	const generated = selectedGeneratedNode.value;
	if (generated && !generated.hidden) {
		event.preventDefault();
		event.stopPropagation();
		setGeneratedNodeHidden(generated, true);
		selectedGeneratedNodeKey.value = '';
		nextTick(() => {
			viewport.value?.selectPart(generated.partId);
			refreshGeneratedStructure();
		});
		return;
	}
	if (!selectedPartIds.value.length) return;
	event.preventDefault();
	event.stopPropagation();
	removeParts([...selectedPartIds.value]);
};

const importGlb = async (event: Event) => {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0]; input.value = '';
	if (!file) return;
	if (!file.name.toLowerCase().endsWith('.glb')) { ElMessage.error('第一版组件设计器只接收单文件 GLB'); return; }
	const part = createStudioPart('glb', definition.parts.length);
	part.name = file.name.replace(/\.glb$/i, '');
	part.source = { fileName: file.name, fileSize: file.size, transient: true };
	part.transform.position = [0, 0, 0];
	definition.parts.push(part);
	selectedPartId.value = part.id;
	selectedPartIds.value = [part.id];
	try { await nextTick(); await viewport.value?.loadGlb(part.id, await file.arrayBuffer()); ElMessage.success(`${file.name} 已导入当前组件并可直接预览`); }
	catch { definition.parts = definition.parts.filter((item) => item.id !== part.id); }
};

const addPort = () => definition.ports.push({ id: createComponentStudioId('port'), name: `PORT_${definition.ports.length + 1}`, type: 'material-output', position: [0, 0.5, 0], direction: [1, 0, 0], color: '#38bdf8' });
const removePort = (id: string) => { definition.ports = definition.ports.filter((item) => item.id !== id); };
const addCollision = () => definition.collisions.push({ id: createComponentStudioId('collision'), name: `碰撞体 ${definition.collisions.length + 1}`, kind: 'box', position: [0, 0.5, 0], size: [1, 1, 1], radius: 0.5, height: 1 });
const removeCollision = (id: string) => { definition.collisions = definition.collisions.filter((item) => item.id !== id); };
const addTelemetry = () => definition.telemetry.push({ id: createComponentStudioId('telemetry'), name: `能力 ${definition.telemetry.length + 1}`, key: `TelemetryKey${definition.telemetry.length + 1}`, target: 'run', description: '' });
const removeTelemetry = (id: string) => { definition.telemetry = definition.telemetry.filter((item) => item.id !== id); };
const addAnimation = () => definition.animations.push({ id: createComponentStudioId('animation'), name: `动画 ${definition.animations.length + 1}`, targetPartId: selectedPartId.value || definition.parts[0]?.id || '', kind: 'rotate', axis: 'y', speed: 30 });
const removeAnimation = (id: string) => { definition.animations = definition.animations.filter((item) => item.id !== id); };

const persistDraft = (notify: boolean) => {
	definition.revision += 1;
	definition.status = 'Draft';
	localStorage.setItem('iotsharp.component-studio.draft', JSON.stringify(cloneComponentStudioDefinition(definition)));
	hasLocalDraft.value = true;
	if (notify) ElMessage.success(`本地草稿 r${definition.revision} 已保存`);
};
const saveDraft = () => persistDraft(true);
const restoreDraft = () => {
	try { const raw = localStorage.getItem('iotsharp.component-studio.draft'); if (!raw) return; replaceDefinition(JSON.parse(raw)); nextTick(resetStudioHistory); ElMessage.success('本地组件草稿已恢复'); }
	catch { ElMessage.error('本地草稿格式无效'); }
};
const publishLocal = () => {
	suppressDirty = true;
	persistDraft(false);
	definition.publishedVersion += 1;
	definition.status = 'Published';
	localStorage.setItem('iotsharp.component-studio.published', JSON.stringify(cloneComponentStudioDefinition(definition)));
	localStorage.setItem('iotsharp.component-studio.draft', JSON.stringify(cloneComponentStudioDefinition(definition)));
	ElMessage.success(`本地预览版本 v${definition.publishedVersion} 已发布；后续接数据库后这里会改为不可变组件版本`);
	mode.value = 'preview';
	nextTick(() => { suppressDirty = false; });
};

const setTransformMode = (value: 'translate' | 'rotate' | 'scale') => { transformMode.value = value; viewport.value?.setTransformMode(value); };

watch(definition, () => {
	viewport.value?.setDefinition(definition);
	nextTick(refreshGeneratedStructure);
	if (!suppressDirty && definition.status === 'Published') definition.status = 'Draft';
	scheduleStudioHistory();
}, { deep: true });
watch(selectedPartId, (value) => { if (selectedPartIds.value.length <= 1 && !selectedGeneratedNodeKey.value) viewport.value?.selectPart(value); nextTick(refreshGeneratedStructure); });
watch(mode, (value) => { viewport.value?.setMode(value); if (value === 'preview') helpers.grid = false; else if (value === 'design') helpers.grid = true; });
watch(helpers, (value) => viewport.value?.setHelpers({ ...value }), { deep: true });
watch(runtime, (value) => viewport.value?.setRuntimeState({ ...value }), { deep: true });

onMounted(() => {
	if (!viewportHost.value) return;
	selectedPartId.value = definition.parts[0]?.id || '';
	selectedPartIds.value = selectedPartId.value ? [selectedPartId.value] : [];
	viewport.value = new ComponentStudioViewport(viewportHost.value, definition, {
		onSelectPart: (partId, additive) => { applyPartSelection(partId, Boolean(additive)); activeTab.value = 'properties'; },
		onSelectGeneratedNode: (partId, node, additive) => {
			if (additive) { applyPartSelection(partId, true); activeTab.value = 'properties'; return; }
			selectedPartIds.value = [partId]; selectedPartId.value = partId; selectedGeneratedNodeKey.value = node.nodeKey; activeTab.value = 'properties'; nextTick(refreshGeneratedStructure);
		},
		onTransformPart: (partId, transform) => { const part = definition.parts.find((item) => item.id === partId); if (part) part.transform = transform; },
		onTransformGeneratedNode: (partId, nodeKey, transform) => writeGeneratedNodeTransform(partId, nodeKey, transform),
		onError: (message) => ElMessage.error(message),
	});
	viewport.value.setSelectedParts(selectedPartIds.value, selectedPartId.value);
	viewport.value.setHelpers({ ...helpers });
	refreshGeneratedStructure();
	resetStudioHistory();
	void loadCatalogModels();
	window.addEventListener('keydown', handleStudioDeleteKey);
});

onBeforeUnmount(() => {
	window.removeEventListener('keydown', handleStudioDeleteKey);
	if (studioHistoryTimer !== undefined) window.clearTimeout(studioHistoryTimer);
	stopPanelResize();
	viewport.value?.dispose();
});
</script>

<style scoped lang="scss">
.component-studio{--panel:#0a1524;--panel2:#0d1b2c;--border:rgba(148,163,184,.2);height:calc(100vh - 88px);min-height:680px;overflow:hidden;color:#dbeafe;background:#050b13}.studio-toolbar{height:66px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 14px;border-bottom:1px solid var(--border);background:#081421}.studio-brand{display:flex;min-width:240px;flex-direction:column;gap:4px}.studio-brand>span{font-size:9px;font-weight:800;letter-spacing:.18em;color:#38bdf8;text-transform:uppercase}.studio-brand>div{display:flex;align-items:center;gap:8px}.studio-brand strong{max-width:260px;overflow:hidden;font-size:15px;text-overflow:ellipsis;white-space:nowrap}.studio-toolbar__actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;min-width:0;overflow-x:auto;white-space:nowrap}.is-hidden{display:none}.studio-layout{display:grid;grid-template-columns:250px minmax(420px,1fr) 350px;height:calc(100% - 66px)}.component-studio.is-preview .studio-layout{grid-template-columns:1fr}.component-studio.is-test .studio-layout{grid-template-columns:minmax(420px,1fr) 330px}.studio-panel{min-width:0;background:var(--panel);overflow:auto}.studio-left{border-right:1px solid var(--border);padding:12px}.studio-right,.studio-test-panel{border-left:1px solid var(--border);padding:12px}.panel-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.panel-heading>div{display:flex;flex-direction:column;gap:2px}.panel-heading span{font-size:9px;font-weight:800;letter-spacing:.14em;color:#38bdf8}.panel-heading strong{font-size:13px}.panel-heading.sub{margin-top:16px;padding-top:13px;border-top:1px solid var(--border)}.component-tree{display:flex;flex-direction:column;gap:5px}.component-tree button{display:grid;grid-template-columns:10px minmax(0,1fr) auto 24px;align-items:center;gap:7px;width:100%;padding:8px;border:1px solid transparent;border-radius:8px;color:#cbd5e1;background:#0d1b2c;text-align:left;cursor:pointer}.component-tree button:hover,.component-tree button.is-active{border-color:rgba(56,189,248,.45);background:rgba(14,165,233,.11)}.component-tree button i{width:8px;height:8px;border-radius:2px;background:#2563eb}.component-tree button i.cylinder{border-radius:50%;background:#64748b}.component-tree button i.sphere{border-radius:50%;background:#0ea5e9}.component-tree button i.plane{background:#8b5cf6}.component-tree button i.glb{background:#22c55e}.component-tree button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.component-tree button small{font-size:9px;color:#64748b}.component-tree button b{display:grid;place-items:center;color:#64748b;font-size:14px}.component-tree button b:hover{color:#f87171}.primitive-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.primitive-grid button{display:flex;min-height:90px;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;padding:10px;border:1px solid var(--border);border-radius:9px;color:#cbd5e1;background:#0d1b2c;cursor:pointer}.primitive-grid button:hover{border-color:#38bdf8;transform:translateY(-1px)}.primitive-grid button>span{font-size:24px;color:#38bdf8}.primitive-grid strong{font-size:11px}.primitive-grid small{font-size:9px;color:#64748b}.studio-stage{position:relative;min-width:0;background:#050b13}.studio-viewport{position:absolute;inset:0}.stage-toolbar{position:absolute;top:12px;left:50%;z-index:5;display:flex;align-items:center;gap:7px;max-width:calc(100% - 36px);padding:6px 8px;border:1px solid var(--border);border-radius:10px;transform:translateX(-50%);background:rgba(8,20,33,.9);box-shadow:0 12px 30px rgba(0,0,0,.25);white-space:nowrap}.stage-toolbar :deep(.el-checkbox__label){font-size:10px;color:#cbd5e1}.stage-badge{position:absolute;left:14px;bottom:14px;z-index:4;display:flex;max-width:560px;flex-direction:column;gap:3px;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:rgba(7,17,31,.86);pointer-events:none}.stage-badge strong{font-size:10px;color:#7dd3fc}.stage-badge span{font-size:9px;color:#94a3b8}.preview-watermark{position:absolute;right:16px;bottom:16px;font-size:9px;font-weight:800;letter-spacing:.14em;color:rgba(125,211,252,.48);pointer-events:none}.studio-right :deep(.el-tabs__item){font-size:11px}.inspector-scroll{display:flex;flex-direction:column;gap:9px;padding-bottom:30px}.form-card{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.form-card label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:#94a3b8}.form-card__title{display:flex;align-items:center;justify-content:space-between;gap:8px}.form-card__title>.el-input{flex:1}.section-label{font-size:9px;color:#64748b}.triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.triple :deep(.el-input-number){width:100%}.material-row{display:grid;grid-template-columns:90px 1fr;gap:8px}.material-row label{justify-content:space-between}.section-actions{display:flex;align-items:center;justify-content:space-between;padding:3px 1px;font-size:11px}.test-state{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--panel2)}.test-state>div{display:flex;align-items:center;justify-content:space-between}.test-state label{display:flex;flex-direction:column;gap:6px;font-size:10px;color:#94a3b8}.test-block{display:flex;flex-direction:column;gap:7px;margin-top:12px;padding:11px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.test-block>span{font-size:9px;font-weight:800;letter-spacing:.12em;color:#38bdf8}.test-block>div{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px;border-radius:6px;background:rgba(15,31,52,.75)}.test-block strong{font-size:10px}.test-block small{font-size:9px;color:#64748b}.studio-test-panel>.el-alert{margin-top:12px}@media(max-width:1350px){.studio-layout{grid-template-columns:220px minmax(360px,1fr) 310px}.studio-toolbar{align-items:flex-start;height:auto;min-height:66px;padding:8px 12px}.studio-toolbar__actions{flex-wrap:wrap}.studio-layout{height:calc(100% - 82px)}}

.stage-toolbar{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden}
.stage-toolbar :deep(.el-button-group){display:inline-flex!important;flex:0 0 auto!important;flex-direction:row!important;flex-wrap:nowrap!important;vertical-align:middle}
.stage-toolbar :deep(.el-button-group .el-button){float:none!important;flex:0 0 auto!important;width:auto!important}
.transform-tool-group{display:inline-flex!important;flex:0 0 auto!important;flex-direction:row!important;flex-wrap:nowrap!important}
.generated-structure{margin-top:12px;padding-top:10px;border-top:1px solid var(--border)}
.generated-structure__title{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.generated-structure__title span{font-size:10px;font-weight:700;color:#7dd3fc}.generated-structure__title small{font-size:9px;color:#64748b}
.generated-structure__list{display:flex;max-height:330px;flex-direction:column;gap:3px;overflow:auto}
.generated-node-row{display:grid;grid-template-columns:minmax(0,1fr) auto 42px;align-items:center;gap:5px;min-height:29px;padding-top:4px;padding-right:3px;padding-bottom:4px;border:1px solid transparent;border-radius:6px;background:rgba(15,31,52,.62);cursor:pointer}
.generated-node-row:hover,.generated-node-row.is-selected{border-color:rgba(56,189,248,.45);background:rgba(14,165,233,.12)}.generated-node-row.is-hidden{opacity:.52}.generated-node-row__name{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.generated-node-row :deep(.el-tag){height:19px;font-size:8px}.generated-node-row :deep(.el-button){padding:2px 4px;font-size:9px}
.generated-structure__tip{display:block;margin-top:7px;line-height:1.5;color:#64748b;font-size:9px}.generated-node-key{overflow-wrap:anywhere;color:#64748b;font-size:9px}.generated-node-card{border-color:rgba(56,189,248,.3)}
.studio-left-tabs{margin-top:-4px}.studio-left-tabs :deep(.el-tabs__item){font-size:11px}.catalog-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.catalog-summary{padding:8px 1px 6px;font-size:9px;color:#64748b}.catalog-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}.catalog-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.catalog-card:hover{border-color:rgba(56,189,248,.45)}.catalog-card__main{display:flex;min-width:0;flex-direction:column;gap:2px}.catalog-card__main strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.catalog-card__main small,.catalog-card__main span{overflow:hidden;font-size:9px;color:#64748b;text-overflow:ellipsis;white-space:nowrap}.catalog-card__actions{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:2px}.component-tree button i.component{background:#f59e0b}.component-parameter-list{display:flex;flex-direction:column;gap:8px;padding-top:2px}.component-parameter-list>label{display:grid;grid-template-columns:minmax(90px,.8fr) minmax(0,1.2fr);align-items:center;gap:7px}.component-parameter-list>label>span{display:flex;min-width:0;align-items:center;gap:4px;color:#cbd5e1}.component-parameter-list>label>span small{font-size:8px;color:#64748b}.component-parameter-list>label>small{grid-column:1/-1;font-size:8px;color:#64748b}.component-parameter-list :deep(.el-input-number),.component-parameter-list :deep(.el-select){width:100%}
.component-studio.is-design .studio-layout{grid-template-columns:var(--studio-left-width) 6px minmax(360px,1fr) 6px var(--studio-right-width)}
.panel-resizer{position:relative;z-index:7;min-width:6px;cursor:col-resize;background:rgba(15,31,52,.9);touch-action:none}
.panel-resizer::after{position:absolute;top:0;bottom:0;left:2px;width:2px;content:'';background:rgba(148,163,184,.18);transition:background .15s ease}
.panel-resizer:hover::after{background:#38bdf8}
@media(max-width:1350px){.component-studio.is-design .studio-layout{grid-template-columns:var(--studio-left-width) 6px minmax(360px,1fr) 6px var(--studio-right-width)}}
</style>
