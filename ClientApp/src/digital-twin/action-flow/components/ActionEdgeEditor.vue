<template>
	<section v-if="nodeId" class="af-edge-editor" aria-label="所选节点输出连线">
		<strong>输出连线</strong>
		<div v-for="edge in outgoing" :key="edge.edgeId">
			<el-select :model-value="edge.sourcePort" aria-label="输出条件端口" size="small" filterable allow-create @change="update(edge, 'sourcePort', $event)"><el-option v-for="port in ports" :key="port" :label="port" :value="port" /></el-select>
			<el-select :model-value="edge.targetNodeId" aria-label="连线目标节点" size="small" filterable @change="update(edge, 'targetNodeId', $event)"><el-option v-for="node in flow.nodes" :key="node.nodeId" :label="node.name" :value="node.nodeId" /></el-select>
			<el-button size="small" text type="danger" :aria-label="`删除 ${edge.sourcePort} 连线`" @click="$emit('remove',edge.edgeId)">删除</el-button>
		</div>
		<small v-if="!outgoing.length">从节点右侧连线按钮连接目标节点；完成后可在此修改分支端口和目标。</small>
	</section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { TwinActionFlowDefinitionV2, TwinActionFlowEdge } from '../contracts/action-flow-v2';
const props=defineProps<{flow:TwinActionFlowDefinitionV2;nodeId?:string}>();
const emit=defineEmits<{(e:'update',edge:TwinActionFlowEdge):void;(e:'remove',edgeId:string):void}>();
const outgoing=computed(()=>props.flow.edges.filter(e=>e.sourceNodeId===props.nodeId));
const ports=['success','true','false','repeat','done','failure','timeout'];
const update=(edge:TwinActionFlowEdge,key:'sourcePort'|'targetNodeId',value:string)=>emit('update',{...edge,[key]:value});
</script>
<style scoped>.af-edge-editor{border-top:1px solid var(--el-border-color);padding:8px;max-height:160px;overflow:auto;display:grid;gap:6px}.af-edge-editor strong,.af-edge-editor small{font-size:12px}.af-edge-editor>div{display:grid;grid-template-columns:130px minmax(160px,1fr) 50px;gap:8px}</style>
