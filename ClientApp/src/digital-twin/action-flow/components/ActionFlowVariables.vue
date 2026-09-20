<template>
	<el-button size="small" @click="open">流程变量</el-button>
	<el-dialog v-model="visible" title="流程变量与初始值" width="700px" append-to-body>
		<p>变量属于当前动作图；重新运行或复位后恢复初始值。条件节点和设置状态节点可引用变量名。</p>
		<div v-for="(row,index) in rows" :key="index" class="af-variable-row">
			<el-input v-model="row.name" :aria-label="`变量 ${index+1} 名称`" placeholder="变量名"/>
			<el-select v-model="row.type" :aria-label="`变量 ${index+1} 类型`"><el-option v-for="type in ['boolean','number','string','json']" :key="type" :label="type" :value="type"/></el-select>
			<el-input v-model="row.value" :aria-label="`变量 ${index+1} 初始值`" placeholder="初始值"/>
			<el-button type="danger" plain :aria-label="`删除变量 ${row.name||index+1}`" @click="rows.splice(index,1)">删除</el-button>
		</div>
		<el-button @click="rows.push({name:'',type:'boolean',value:'false'})">新增变量</el-button>
		<p>boolean 填 true/false，number 填数字，string 直接填文本，json 填合法 JSON。</p>
		<template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" @click="apply">应用变量</el-button></template>
	</el-dialog>
</template>
<script setup lang="ts">
import {ref} from 'vue';
import {ElMessage} from 'element-plus';
import type {TwinFlowVariableDefinition} from '../contracts/action-flow-v2';
const props=defineProps<{variables:TwinFlowVariableDefinition[]}>();
const emit=defineEmits<{(e:'update',variables:TwinFlowVariableDefinition[]):void}>();
const visible=ref(false), rows=ref<Array<{name:string;type:TwinFlowVariableDefinition['type'];value:string;required?:boolean}>>([]);
const open=()=>{rows.value=props.variables.map(v=>({name:v.name,type:v.type,value:v.type==='string'?String(v.initialValue??''):JSON.stringify(v.initialValue??null),required:v.required}));visible.value=true;};
const apply=()=>{
	try {
		const names=new Set<string>();
		const variables=rows.value.map(row=>{
			const name=row.name.trim();if(!name||names.has(name)||['__proto__','constructor','prototype'].includes(name))throw new Error('变量名不能为空、重复或使用保留名称');names.add(name);
			const initialValue=row.type==='string'?row.value:JSON.parse(row.value);
			if(row.type!=='json'&&typeof initialValue!==row.type)throw new Error(`变量 ${name} 的初始值必须符合 ${row.type} 类型`);
			return {name,type:row.type,initialValue,required:row.required};
		});
		emit('update',variables);visible.value=false;
	}catch(error){ElMessage.error(error instanceof Error?error.message:'变量初始值无效');}
};
</script>
<style scoped>
.af-variable-row{display:grid;grid-template-columns:1fr 120px 1fr auto;gap:8px;margin-bottom:10px}p{margin:0 0 14px;color:var(--el-text-color-secondary)}
</style>
