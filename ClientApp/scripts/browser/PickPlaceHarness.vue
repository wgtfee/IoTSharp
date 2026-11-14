<script setup lang="ts">
// 独立的浏览器回归夹具，使用真实工艺组件/规划器/执行轴；不调用账户或数据库接口。
import { ref } from 'vue';
import { Group, Scene } from 'three';
import PickPlaceDesigner from '../../src/digital-twin/motion/PickPlaceDesigner.vue';
import { SceneActionFlowRuntime } from '../../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { ActuatorRuntime } from '../../src/digital-twin/runtime/ActuatorRuntime';
import type { TwinSceneManifest } from '../../src/digital-twin/contracts';
import fixture from './pick-place.fixture.json';
import stackingFixture from './stacking.fixture.json';
const makeManifest=()=>{const m=JSON.parse(JSON.stringify(fixture)) as TwinSceneManifest;m.motionTrajectories=[];m.actionFlows=[];return m;};
const manifest=ref(makeManifest()),open=ref(false),status=ref('尚未保存'),previewCount=ref(0);
const scene=new Scene(),root=new Group(),source=new Group(),target=new Group(),x=new Group(),y=new Group(),z=new Group();
root.userData.twinObjectId='actor';x.name='x';y.name='y';z.name='z';root.add(x);x.add(y);y.add(z);scene.add(root,source,target);
const access={getRoot:(id:string)=>({actor:root,source,target}[id]),getRuntimeOwners:()=>[]};
const apply=(value:TwinSceneManifest)=>{manifest.value=value;localStorage.setItem('pick-place-browser-draft',JSON.stringify(value));status.value=`已保存 ${value.actionFlows?.length||0} 个工艺`;};
const reopen=()=>{manifest.value=JSON.parse(localStorage.getItem('pick-place-browser-draft')!);status.value=`重开成功：${manifest.value.motionTrajectories?.length||0} 条轨迹`;};
const invalidate=()=>{manifest.value.objects[1].transform.position[0]+=.01;};
const loadStacking=()=>{manifest.value=JSON.parse(JSON.stringify(stackingFixture));status.value='已载入码垛配置样例';};
const run=()=>{try{const m=JSON.parse(JSON.stringify(manifest.value)) as TwinSceneManifest;m.actionFlows![0].enabled=true;const axes=new ActuatorRuntime(m,access.getRoot);const runtime=new SceneActionFlowRuntime(m,scene,access.getRoot,undefined,(id,v)=>axes.applyActionFlow(id,v),undefined,id=>axes.holdActor(id),{read:id=>axes.getState(id)?.currentValue as number,write:(actor,targets)=>axes.applyTrajectoryFrame(actor,targets)});runtime.setRunning(true);for(let i=0;i<5000&&runtime.getSnapshot().flows[0].state!=='Completed'&&!runtime.getFault();i++)runtime.updateFixed(.01);status.value=runtime.getFault()||`${runtime.getSnapshot().flows[0].state==='Completed'?'仿真执行完成':'仿真未完成'}：X=${x.position.x.toFixed(4)} Y=${y.position.y.toFixed(4)}`;runtime.dispose();axes.dispose();}catch(e){status.value=String(e);}};
(window as any).invalidateMotionFixture=invalidate;
</script>
<template><main><h1>取放工艺浏览器回归</h1><p>独立测试场景 · 实际 Vue 配置组件与仿真执行器 · 不连接数据库</p><div class="buttons"><el-button @click="open=true">配置取放工艺</el-button><el-button @click="reopen">重开已保存草稿</el-button><el-button @click="run">执行已保存轨迹</el-button><el-button @click="loadStacking">载入码垛配置样例</el-button></div><p role="status">{{status}}</p><p>预览回调：{{previewCount}}</p><PickPlaceDesigner v-model="open" :manifest="manifest" :get-scene="()=>access" @apply="apply" @preview="value=>{if(value)previewCount++}" /></main></template>
<style scoped>main{max-width:1100px;margin:40px auto;padding:24px;font-family:system-ui;color:#303133}.buttons{display:flex;gap:12px}p{line-height:1.8;color:#606266}</style>
