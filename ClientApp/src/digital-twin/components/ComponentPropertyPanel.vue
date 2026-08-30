<template>
	<section v-if="object && template" class="v7-component-panel">
		<header>
			<div><span>V7 COMPONENT</span><strong>{{ object.name }}</strong></div>
			<el-tag size="small" type="success">{{ template.componentType }}</el-tag>
		</header>

		<div class="v7-component-panel__summary">
			<small>{{ template.resourceKey }}</small>
			<small>{{ template.generator }} · v{{ template.generatorVersion }}</small>
		</div>

		<el-collapse v-model="activeGroups">
			<el-collapse-item v-for="group in schemaGroups" :key="group.key" :name="group.key" :title="group.label">
				<div class="v7-component-panel__fields">
					<label v-for="field in group.fields" :key="field.key">
						<span>{{ field.label }}<em v-if="field.unit">{{ field.unit }}</em></span>
						<el-input-number
							v-if="field.type === 'number'"
							:model-value="numberValue(field.key, field.defaultValue)"
							:min="field.min"
							:max="field.max"
							:step="field.step || 1"
							:precision="numberPrecision(field.step)"
							controls-position="right"
							@change="updateProperty(field.key, $event)"
						/>
						<el-select
							v-else-if="field.type === 'select'"
							:model-value="propertyValue(field.key, field.defaultValue)"
							@change="updateProperty(field.key, $event)"
						>
							<el-option v-for="option in field.options || []" :key="String(option.value)" :label="option.label" :value="option.value" />
						</el-select>
						<el-switch
							v-else-if="field.type === 'boolean'"
							:model-value="Boolean(propertyValue(field.key, field.defaultValue))"
							@change="updateProperty(field.key, $event)"
						/>
						<el-input
							v-else
							:model-value="String(propertyValue(field.key, field.defaultValue) ?? '')"
							@change="updateProperty(field.key, $event)"
						/>
						<small v-if="field.description">{{ field.description }}</small>
					</label>
				</div>
			</el-collapse-item>
		</el-collapse>

		<div class="v7-component-panel__connection-title">
			<strong>端口连接</strong>
			<el-tag size="small">{{ ports.length }} Ports</el-tag>
		</div>
		<div class="v7-component-panel__ports">
			<div v-for="port in ports" :key="port.portId">
				<i :class="port.type"></i>
				<span>{{ port.name }}</span>
				<small>{{ port.portId }}</small>
				<el-tag size="small" :type="isPortConnected(port.portId) ? 'success' : 'info'">{{ isPortConnected(port.portId) ? '已连接' : '空闲' }}</el-tag>
			</div>
		</div>

		<div class="v7-component-panel__actions">
			<el-button size="small" type="primary" @click="snapNearest">吸附最近端口</el-button>
			<el-button size="small" @click="rebuildRoute">重建 Section / Route</el-button>
		</div>

		<div v-if="connections.length" class="v7-component-panel__connections">
			<div v-for="connection in connections" :key="connection.connectionId">
				<div>
					<strong>{{ endpointLabel(connection.from) }}</strong>
					<small>→ {{ endpointLabel(connection.to) }}</small>
				</div>
				<el-button text type="danger" size="small" @click="removeConnection(connection.connectionId)">断开</el-button>
			</div>
		</div>
		<small v-else class="v7-component-panel__empty">移动组件到目标附近，再点击“吸附最近端口”；吸附后自动生成物理 Connection 与运行 Route/Section。</small>
	</section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import type { TwinComponentConnectionEndpoint, TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import {
	getBuiltInComponentTemplate,
	isComponentSceneObject,
	revalidateComponentConnections,
	removeComponentConnection,
	resolveComponentPorts,
	snapAndConnectNearestComponent,
	upsertGeneratedComponentRoute,
	type TwinComponentPropertySchema,
} from '/@/digital-twin/components';

const props = defineProps<{ manifest: TwinSceneManifest; objectId: string }>();
const emit = defineEmits<{
	(e: 'changed'): void;
	(e: 'reload-component', objectId: string): void;
	(e: 'reload-all'): void;
}>();

const activeGroups = ref(['geometry', 'runtime', 'process', 'connection']);
const objects = computed(() => props.manifest.objects as TwinV7SceneObjectDefinition[]);
const object = computed(() => {
	const candidate = objects.value.find((item) => item.objectId === props.objectId);
	return isComponentSceneObject(candidate) ? candidate : undefined;
});
const template = computed(() => object.value ? getBuiltInComponentTemplate(object.value.component.resourceKey) : undefined);
const ports = computed(() => object.value ? resolveComponentPorts(object.value) : []);
const connections = computed(() => (props.manifest.connections || []).filter((item) => item.from.objectId === props.objectId || item.to.objectId === props.objectId));
const categoryLabels: Record<string, string> = { geometry: '几何参数', runtime: '运行参数', process: '工艺参数', connection: '连接参数' };
const schemaGroups = computed(() => {
	const schema = template.value?.propertySchema || [];
	return ['geometry', 'runtime', 'process', 'connection'].map((key) => ({
		key,
		label: categoryLabels[key],
		fields: schema.filter((field) => field.category === key),
	})).filter((group) => group.fields.length > 0);
});

const propertyValue = (key: string, fallback: unknown) => object.value?.component.properties?.[key] ?? fallback;
const numberValue = (key: string, fallback: unknown) => {
	const value = Number(propertyValue(key, fallback));
	return Number.isFinite(value) ? value : Number(fallback) || 0;
};
const numberPrecision = (step?: number) => {
	if (!step || Number.isInteger(step)) return 0;
	const text = String(step);
	return Math.min(6, text.includes('.') ? text.split('.')[1].length : 0);
};
const updateProperty = (key: string, value: unknown) => {
	if (!object.value) return;
	object.value.component.properties ||= {};
	object.value.component.properties[key] = value;
	const removed = revalidateComponentConnections(props.manifest);
	upsertGeneratedComponentRoute(props.manifest);
	emit('reload-component', object.value.objectId);
	emit('changed');
	if (removed.length) ElMessage.warning(`参数变化后 ${removed.length} 条端口连接已失效，请重新吸附`);
};
const isPortConnected = (portId: string) => connections.value.some((item) =>
	(item.from.objectId === props.objectId && item.from.portId === portId)
	|| (item.to.objectId === props.objectId && item.to.portId === portId));
const endpointLabel = (endpoint: TwinComponentConnectionEndpoint) => {
	const target = objects.value.find((item) => item.objectId === endpoint.objectId);
	return `${target?.name || endpoint.objectId}.${endpoint.portId}`;
};
const snapNearest = () => {
	if (!object.value) return;
	const result = snapAndConnectNearestComponent(props.manifest, object.value.objectId, { maxDistance: 0.5, maxAngleDegrees: 15, preferFacingPorts: true });
	if (!result) { ElMessage.warning('0.5 米范围内没有方向相向且输送对象兼容的空闲端口'); return; }
	emit('reload-all');
	emit('changed');
	ElMessage.success(`已吸附：${result.candidate.moving.name} ↔ ${result.candidate.target.objectName}.${result.candidate.target.name}`);
};
const removeConnection = (connectionId: string) => {
	if (!removeComponentConnection(props.manifest, connectionId)) return;
	emit('reload-all'); emit('changed');
	ElMessage.success('连接已断开，组件路线已重新生成');
};
const rebuildRoute = () => {
	const result = upsertGeneratedComponentRoute(props.manifest);
	emit('reload-all'); emit('changed');
	ElMessage.success(result ? `已生成 ${result.route.edges.length} 个 Section / RouteEdge` : '当前没有组件可生成路线');
};
</script>

<style scoped lang="scss">
.v7-component-panel{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid rgba(56,189,248,.25);border-radius:9px;background:rgba(7,17,31,.96);color:#dbeafe}.v7-component-panel header{display:flex;align-items:center;justify-content:space-between;gap:8px}.v7-component-panel header>div{display:flex;flex-direction:column;gap:2px}.v7-component-panel header span{font-size:9px;letter-spacing:.14em;color:#38bdf8}.v7-component-panel header strong{font-size:12px}.v7-component-panel__summary{display:flex;justify-content:space-between;gap:8px;color:#64748b}.v7-component-panel__summary small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.v7-component-panel :deep(.el-collapse){border:0}.v7-component-panel :deep(.el-collapse-item__header){height:30px;border-color:rgba(148,163,184,.16);color:#cbd5e1;background:transparent;font-size:10px}.v7-component-panel :deep(.el-collapse-item__wrap){border-color:rgba(148,163,184,.12);background:transparent}.v7-component-panel :deep(.el-collapse-item__content){padding:8px 0;color:inherit}.v7-component-panel__fields{display:grid;grid-template-columns:1fr;gap:8px}.v7-component-panel__fields label{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:7px}.v7-component-panel__fields label>span{font-size:10px;color:#94a3b8}.v7-component-panel__fields label>span em{margin-left:4px;color:#475569;font-style:normal}.v7-component-panel__fields label>small{grid-column:2;font-size:9px;color:#64748b}.v7-component-panel__fields :deep(.el-input-number),.v7-component-panel__fields :deep(.el-select){width:100%}.v7-component-panel__connection-title{display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(148,163,184,.15);padding-top:9px}.v7-component-panel__connection-title strong{font-size:10px}.v7-component-panel__ports,.v7-component-panel__connections{display:flex;flex-direction:column;gap:4px}.v7-component-panel__ports>div{display:grid;grid-template-columns:8px 1fr auto auto;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;background:rgba(15,23,42,.75)}.v7-component-panel__ports i{width:7px;height:7px;border-radius:50%;background:#f59e0b}.v7-component-panel__ports i.material-input{background:#38bdf8}.v7-component-panel__ports i.material-output{background:#22c55e}.v7-component-panel__ports span{font-size:10px}.v7-component-panel__ports small{font-size:9px;color:#64748b}.v7-component-panel__actions{display:flex;gap:6px}.v7-component-panel__connections>div{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px;border:1px solid rgba(148,163,184,.12);border-radius:6px}.v7-component-panel__connections>div>div{display:flex;min-width:0;flex-direction:column}.v7-component-panel__connections strong,.v7-component-panel__connections small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.v7-component-panel__connections small{color:#64748b}.v7-component-panel__empty{line-height:1.5;color:#64748b;font-size:9px}
</style>
