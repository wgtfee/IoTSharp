<template>
	<aside class="af-palette">
		<el-input v-model="search" clearable size="small" placeholder="搜索流程节点" />
		<div v-for="group in filteredGroups" :key="group.name" class="af-palette__group">
			<strong>{{ group.name }}</strong>
			<button v-for="item in group.items" :key="item.type" type="button" draggable="true" @dragstart="onDrag($event, item.type)" @click="$emit('add', item.type)">
				<span>{{ item.label }}</span><small>{{ item.type }}</small>
			</button>
		</div>
	</aside>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TwinActionFlowNodeType } from '../contracts/action-flow-v2';
defineEmits<{ (e:'add', type:TwinActionFlowNodeType):void }>();
const search=ref('');
const groups:Array<{name:string;items:Array<{type:TwinActionFlowNodeType;label:string}>}>=[
	{name:'控制',items:[{type:'Start',label:'开始'},{type:'End',label:'结束'},{type:'Merge',label:'汇合'},{type:'Condition',label:'条件'},{type:'Switch',label:'多路选择'},{type:'ParallelFork',label:'并行分叉'},{type:'ParallelJoin',label:'并行汇合'}]},
	{name:'运动/夹具',items:[{type:'MoveTo',label:'移动到工作点'},{type:'MovePose',label:'移动到 Pose'},{type:'JointMove',label:'关节运动'},{type:'AxisMove',label:'轴运动'},{type:'Home',label:'回 Home'},{type:'GripOpen',label:'夹具打开'},{type:'GripClose',label:'夹具闭合'},{type:'Attach',label:'抓取/归属工具'},{type:'Detach',label:'放置/归属槽位'}]},
	{name:'物料/输送',items:[{type:'PrepareSlot',label:'准备物料槽'},{type:'ReserveSlot',label:'预留槽位'},{type:'TransferMaterial',label:'转移物料归属'},{type:'ReleaseSlot',label:'释放槽位'},{type:'ReserveSection',label:'预占路线区段'},{type:'EnterSection',label:'进入区段'},{type:'LeaveSection',label:'离开区段'},{type:'SelectRoute',label:'选择路线'}]},
	{name:'设备握手',items:[{type:'WaitSignal',label:'等待信号'},{type:'WriteCommand',label:'下发命令'},{type:'WaitAck',label:'等待 Ack'},{type:'Delay',label:'延时'},{type:'Deadline',label:'截止时间'}]},
	{name:'复用/运维',items:[{type:'Subflow',label:'子流程'},{type:'ManualConfirm',label:'人工确认'},{type:'RaiseAlarm',label:'触发告警'},{type:'Compensate',label:'补偿'}]},
];
const filteredGroups=computed(()=>{const q=search.value.trim().toLowerCase(); if(!q)return groups; return groups.map(g=>({...g,items:g.items.filter(i=>`${i.label} ${i.type}`.toLowerCase().includes(q))})).filter(g=>g.items.length);});
const onDrag=(event:DragEvent,type:TwinActionFlowNodeType)=>event.dataTransfer?.setData('application/x-iotsharp-action-node',type);
</script>
<style scoped>
.af-palette{width:210px;min-width:190px;padding:10px;border-right:1px solid var(--el-border-color);overflow:auto;background:var(--el-bg-color)}.af-palette__group{display:grid;gap:6px;margin-top:12px}.af-palette__group>strong{font-size:12px;color:var(--el-text-color-secondary)}.af-palette button{display:flex;justify-content:space-between;gap:6px;text-align:left;padding:7px 8px;border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-fill-color-blank);cursor:grab;color:var(--el-text-color-primary)}.af-palette button:hover{border-color:var(--el-color-primary)}.af-palette small{color:var(--el-text-color-secondary)}
</style>
