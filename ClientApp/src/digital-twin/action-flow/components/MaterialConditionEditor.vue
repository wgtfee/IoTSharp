<template>
	<section aria-label="动作条件配置">
		<template v-if="flat">
			<el-select :model-value="group.logic" aria-label="条件组合方式" size="small" @change="setLogic"><el-option label="全部满足（AND）" value="and"/><el-option label="任意满足（OR）" value="or"/></el-select>
			<div v-for="(row,index) in rows" :key="index" class="material-condition-row">
				<el-select :model-value="row.source" :aria-label="`条件 ${index+1} 数据来源`" size="small" @change="change(index,'source',$event)"><el-option label="场景与物料实际状态" value="runtime"/><el-option label="流程变量" value="variable"/><el-option label="数据绑定" value="binding"/><el-option label="物料状态" value="material"/></el-select>
				<el-select :model-value="row.ref" filterable allow-create default-first-option :aria-label="`条件 ${index+1} 状态字段`" placeholder="选择状态或输入工艺字段" size="small" @change="change(index,'ref',$event)"><el-option v-for="option in options(row.source)" :key="option.value" :label="option.label" :value="option.value"/></el-select>
				<el-select :model-value="row.operator" :aria-label="`条件 ${index+1} 比较方式`" size="small" @change="change(index,'operator',$event)"><el-option v-for="[value,label] in operators" :key="value" :label="label" :value="value"/></el-select>
				<el-input v-if="!['truthy','falsy','changed','risingEdge'].includes(row.operator)" :model-value="JSON.stringify(row.value??null)" :aria-label="`条件 ${index+1} 比较值 JSON`" size="small" @change="setValue(index,$event)"/>
				<el-button size="small" text type="danger" :aria-label="`删除条件 ${index+1}`" @click="remove(index)">删除条件</el-button>
			</div>
			<el-button size="small" @click="add">新增条件</el-button>
			<small>物料状态由运行器只读计算。条件控制执行时机，取放时仍会强制检查接触、夹具和容量。空条件不能保存。</small>
		</template>
		<small v-else>当前使用嵌套条件，请在下方 Config JSON 编辑；不会转换或覆盖已有复杂条件。</small>
	</section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { TwinSceneManifest } from '../../contracts';
import type { TwinPredicateDefinition, TwinPredicateGroup, TwinActionFlowDefinitionV2 } from '../contracts/action-flow-v2';
import { materialStateOptions } from '../contracts/material-state';
const props=defineProps<{predicate?:unknown;manifest:TwinSceneManifest;variables:TwinActionFlowDefinitionV2['variables']}>();
const emit=defineEmits<{(e:'update',value:TwinPredicateGroup):void}>();
const group=computed(()=>props.predicate as TwinPredicateGroup);
const flat=computed(()=>group.value && ['and','or'].includes(group.value.logic) && Array.isArray(group.value.items) && group.value.items.every(i=>i && !('logic' in i)));
const rows=computed(()=>flat.value?group.value.items as TwinPredicateDefinition[]:[]);
const states=computed(()=>materialStateOptions(props.manifest));
const operators=[['truthy','为真'],['falsy','为假'],['eq','等于'],['ne','不等于'],['gt','大于'],['gte','大于等于'],['lt','小于'],['lte','小于等于'],['in','属于集合'],['changed','值发生变化'],['risingEdge','上升沿']];
const options=(source:string)=>source==='variable'?props.variables.map(v=>({value:v.name,label:v.name})):source==='binding'?props.manifest.bindings.map(b=>({value:b.bindingId,label:b.source.key||b.bindingId})):[...states.value,{value:'station.materialCount',label:'当前工位 · 物料数量'},{value:'station.palletCount',label:'当前工位 · 托盘数量'},{value:'station.routeCode',label:'当前工位 · 分流分组'}];
const write=(items:TwinPredicateDefinition[],logic=group.value.logic)=>emit('update',{logic,items});
const setLogic=(logic:'and'|'or')=>write(rows.value.map(r=>({...r})),logic);
const change=(index:number,key:string,value:unknown)=>write(rows.value.map((r,i)=>i===index?{...r,[key]:value}:({...r})));
const setValue=(index:number,value:string)=>{try{change(index,'value',JSON.parse(value));}catch{ElMessage.error('比较值需为合法 JSON，例如 true、1 或 "A"');}};
const add=()=>write([...rows.value,{source:'runtime',ref:'station.materialCount',operator:'gt',value:0}]);
const remove=(index:number)=>write(rows.value.filter((_,i)=>i!==index));
</script>
<style scoped>
.material-condition-row{display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--el-border-color);padding:8px 0}section{display:flex;flex-direction:column;gap:8px}small{font-size:11px;color:var(--el-text-color-secondary)}
</style>
