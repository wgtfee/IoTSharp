<template>
	<section ref="host" class="af-canvas" @dragover.prevent @drop.prevent="dropNode">
		<svg class="af-canvas__edges" :width="canvasSize.width" :height="canvasSize.height">
			<defs><marker id="af-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
			<g v-for="edge in flow.edges" :key="edge.edgeId" class="af-edge">
				<path :d="edgePath(edge)" marker-end="url(#af-arrow)" />
				<text :x="edgeLabel(edge).x" :y="edgeLabel(edge).y">{{ edge.sourcePort }}</text>
			</g>
		</svg>
		<article v-for="node in flow.nodes" :key="node.nodeId" class="af-node" :class="nodeClasses(node)" :style="nodeStyle(node)" draggable="true" @dragstart="dragNodeId=node.nodeId" @dragend="moveNode($event,node)" @click.stop="$emit('select',node.nodeId)" @dblclick.stop="$emit('focus-actor',nodeObjectId(node))">
			<header><b>{{ node.name }}</b><small>{{ node.type }}</small></header>
			<div><span v-if="node.actorObjectId">Actor: {{ actorName(node.actorObjectId) }}</span><span v-else>无 Actor</span></div>
			<button class="af-node__in" title="作为连线目标" @click.stop="completeLink(node.nodeId)"></button>
			<button class="af-node__out" title="开始连线" @click.stop="beginLink(node.nodeId)"></button>
			<i v-if="breakpoints.includes(node.nodeId)" class="af-node__breakpoint" title="断点"></i>
		</article>
		<div v-if="linkSource" class="af-link-hint">从 {{ nodeName(linkSource) }} 选择目标节点 · Esc/点击空白取消</div>
	</section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TwinSceneManifest } from '../../contracts';
import type { TwinActionFlowDefinitionV2, TwinActionFlowEdge, TwinActionFlowNode } from '../contracts/action-flow-v2';
const props=defineProps<{flow:TwinActionFlowDefinitionV2;manifest:TwinSceneManifest;selectedNodeId?:string;focusedObjectId?:string;nodeStates?:Record<string,string>;activeNodeIds?:string[];breakpoints?:string[]}>();
const emit=defineEmits<{(e:'select',id:string):void;(e:'move-node',id:string,x:number,y:number):void;(e:'add-node',type:string,x:number,y:number):void;(e:'connect',source:string,target:string):void;(e:'focus-actor',id?:string):void}>();
const host=ref<HTMLElement>(); const linkSource=ref(''); const dragNodeId=ref(''); const breakpoints=computed(()=>props.breakpoints||[]);
const nodeWidth=176,nodeHeight=76;
const positions=computed(()=>props.flow.nodes.map(n=>({x:Number(n.editor?.x||0),y:Number(n.editor?.y||0)})));
const canvasSize=computed(()=>({width:Math.max(1400,...positions.value.map(p=>p.x+260)),height:Math.max(780,...positions.value.map(p=>p.y+180))}));
const nodeStyle=(n:TwinActionFlowNode)=>({left:`${Number(n.editor?.x||40)}px`,top:`${Number(n.editor?.y||40)}px`});
const nodeObjectId=(n:TwinActionFlowNode)=>{if(n.actorObjectId)return n.actorObjectId;const workPointId=String(n.config?.workPointId||'');return props.manifest.workPoints?.find(point=>point.workPointId===workPointId)?.objectId;};
const nodeClasses=(n:TwinActionFlowNode)=>({'is-selected':props.selectedNodeId===n.nodeId,'is-object-related':Boolean(props.focusedObjectId&&nodeObjectId(n)===props.focusedObjectId),'is-active':props.activeNodeIds?.includes(n.nodeId),'is-succeeded':props.nodeStates?.[n.nodeId]==='Succeeded','is-failed':props.nodeStates?.[n.nodeId]==='Failed','is-waiting':props.nodeStates?.[n.nodeId]==='Waiting'});
const actorName=(id:string)=>props.manifest.objects.find(o=>o.objectId===id)?.name||id; const nodeName=(id:string)=>props.flow.nodes.find(n=>n.nodeId===id)?.name||id;
const edgePoints=(edge:TwinActionFlowEdge)=>{const a=props.flow.nodes.find(n=>n.nodeId===edge.sourceNodeId),b=props.flow.nodes.find(n=>n.nodeId===edge.targetNodeId);return {x1:Number(a?.editor?.x||0)+nodeWidth,y1:Number(a?.editor?.y||0)+nodeHeight/2,x2:Number(b?.editor?.x||0),y2:Number(b?.editor?.y||0)+nodeHeight/2};};
const edgePath=(edge:TwinActionFlowEdge)=>{const p=edgePoints(edge),dx=Math.max(50,Math.abs(p.x2-p.x1)*.45);return `M${p.x1},${p.y1} C${p.x1+dx},${p.y1} ${p.x2-dx},${p.y2} ${p.x2},${p.y2}`;};
const edgeLabel=(edge:TwinActionFlowEdge)=>{const p=edgePoints(edge);return{x:(p.x1+p.x2)/2,y:(p.y1+p.y2)/2-7};};
const moveNode=(event:DragEvent,node:TwinActionFlowNode)=>{if(!host.value)return;const r=host.value.getBoundingClientRect();emit('move-node',node.nodeId,Math.max(10,event.clientX-r.left-nodeWidth/2+host.value.scrollLeft),Math.max(10,event.clientY-r.top-nodeHeight/2+host.value.scrollTop));dragNodeId.value='';};
const dropNode=(event:DragEvent)=>{const type=event.dataTransfer?.getData('application/x-iotsharp-action-node');if(!type||!host.value)return;const r=host.value.getBoundingClientRect();emit('add-node',type,event.clientX-r.left+host.value.scrollLeft,event.clientY-r.top+host.value.scrollTop);};
const beginLink=(id:string)=>linkSource.value=id; const completeLink=(target:string)=>{if(linkSource.value&&linkSource.value!==target)emit('connect',linkSource.value,target);linkSource.value='';};
</script>
<style scoped>
.af-canvas{position:relative;min-width:0;min-height:0;flex:1 1 auto;overflow:auto;background-image:linear-gradient(var(--el-border-color-lighter) 1px,transparent 1px),linear-gradient(90deg,var(--el-border-color-lighter) 1px,transparent 1px);background-size:20px 20px;background-color:var(--el-bg-color-page)}.af-canvas__edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}.af-edge path{fill:none;stroke:var(--el-text-color-placeholder);stroke-width:2}.af-edge text{font-size:10px;fill:var(--el-text-color-secondary)}.af-canvas marker path{fill:var(--el-text-color-placeholder)}.af-node{position:absolute;width:176px;height:76px;border:2px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color);box-shadow:var(--el-box-shadow-light);cursor:move;user-select:none}.af-node header{display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid var(--el-border-color-lighter)}.af-node header b{font-size:12px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.af-node header small{font-size:9px;color:var(--el-text-color-secondary)}.af-node>div{padding:7px 8px;font-size:10px;color:var(--el-text-color-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.af-node.is-selected{border-color:var(--el-color-primary)}.af-node.is-object-related{outline:3px solid var(--el-color-primary-light-5);outline-offset:2px}.af-node.is-active{box-shadow:0 0 0 3px var(--el-color-warning-light-5)}.af-node.is-succeeded{border-color:var(--el-color-success)}.af-node.is-failed{border-color:var(--el-color-danger)}.af-node.is-waiting{border-color:var(--el-color-warning)}.af-node__in,.af-node__out{position:absolute;top:31px;width:12px;height:12px;padding:0;border-radius:50%;border:2px solid var(--el-bg-color);background:var(--el-color-primary);cursor:crosshair}.af-node__in{left:-7px}.af-node__out{right:-7px}.af-node__breakpoint{position:absolute;right:7px;bottom:5px;width:9px;height:9px;border-radius:50%;background:var(--el-color-danger)}.af-link-hint{position:sticky;left:12px;top:12px;width:max-content;padding:6px 10px;border-radius:5px;background:var(--el-color-warning-light-9);color:var(--el-color-warning-dark-2);z-index:8;font-size:12px}
</style>
