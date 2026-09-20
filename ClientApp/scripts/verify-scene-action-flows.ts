import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { createBlankTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { createDrawingPackagingProcessManifest, upgradeDrawingPackagingActionFlows } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { SimulationFlowRuntime } from '../src/digital-twin/action-flow/runtime/SimulationFlowRuntime';
import { compileActionFlow } from '../src/digital-twin/action-flow/compiler/ActionFlowCompiler';
import { ActuatorRuntime, readActuatorNodeValue } from '../src/digital-twin/runtime/ActuatorRuntime';
import type { TwinActionFlowDefinitionV2 } from '../src/digital-twin/action-flow/contracts/action-flow-v2';

const template = createDrawingPackagingProcessManifest();
assert.equal(template.behaviors?.length, 0);
assert.equal(template.actionFlows?.length, 7);
assert.deepEqual(JSON.parse(JSON.stringify(template)).actionFlows, template.actionFlows, '保存重载必须保留所有图参数及连线');
for (const flow of template.actionFlows!) {
	compileActionFlow(flow, template);
	assert.throws(() => new SimulationFlowRuntime(compileActionFlow(flow, template)).start(), /三维/);
}
assert(template.routes.every(route => route.points.filter(p => p.process).every(p => !p.process?.materialStageOnComplete && !p.process?.cycleSeconds && p.process?.behaviorCompletionGroups?.length)), '所有工位均须由图握手，不能偷跑计时放行');

// 模拟已入库 V2 工艺草稿：升级只变控制定义，不能恢复模板布局或丢掉数据库绑定。
const legacy=structuredClone(template);legacy.actionFlows=[];legacy.sceneId='persisted-draft-id';legacy.rootAssetId='persisted-asset';
legacy.objects[0].transform.position[0]+=2;legacy.objects[0].resourceId='persisted-resource';
legacy.behaviors=['drawing-loading-robot','drawing-stacking-gantry','drawing-stacking-pallet'].map(actorObjectId=>({behaviorId:`old-${actorObjectId}`,name:'旧工艺',actorObjectId,enabled:true,actions:[{actionId:'old-wait',kind:'wait'}]}));
const legacyRoute=legacy.routes[0], checkpoint='drawing-p-1320-579';
const into=legacyRoute.edges.find(e=>e.toPointId===checkpoint)!,out=legacyRoute.edges.find(e=>e.fromPointId===checkpoint)!;
into.toPointId=out.toPointId;legacyRoute.edges=legacyRoute.edges.filter(e=>e.edgeId!==out.edgeId);legacyRoute.points=legacyRoute.points.filter(p=>p.pointId!==checkpoint);
const inspection=legacyRoute.points.find(p=>p.componentObjectId==='drawing-inspection'&&p.process)!.process!;
inspection.cycleSeconds=4.2;inspection.materialStageOnComplete='custom-inspected';delete inspection.behaviorCompletionGroups;
const before=JSON.stringify(legacy), upgraded=upgradeDrawingPackagingActionFlows(legacy);
assert.equal(JSON.stringify(legacy),before,'失败或成功升级均不能原地修改原草稿');
for(const key of ['sceneId','rootAssetId','objects','resources','bindings','workPoints','materialSlots','poses','actuators','toolFrames'] as const)assert.deepEqual(upgraded[key],legacy[key],`升级必须保留 ${key}`);
for(const point of legacyRoute.points)assert.deepEqual(upgraded.routes[0].points.find(p=>p.pointId===point.pointId)!.position,point.position,'已有中心线不能移位');
const routeLength=(route:typeof legacyRoute)=>route.edges.reduce((sum,e)=>{const a=route.points.find(p=>p.pointId===e.fromPointId)!.position,b=route.points.find(p=>p.pointId===e.toPointId)!.position;return sum+Math.hypot(...a.map((v,i)=>v-b[i]));},0);
assert(Math.abs(routeLength(upgraded.routes[0])-routeLength(legacyRoute))<1e-8,'增设停车点不能改变中心线路径长度');
assert.equal(upgraded.behaviors!.length,0);assert.equal(upgraded.actionFlows!.length,7);
assert.equal(upgraded.actionFlows!.find(f=>f.flowId==='drawing-inspection-flow')!.nodes.find(n=>n.type==='Delay')!.config.durationSeconds,4.2);
assert.equal(upgraded.actionFlows!.find(f=>f.flowId==='drawing-inspection-flow')!.nodes.find(n=>n.type==='MarkMaterial')!.config.stage,'custom-inspected');
assert.throws(()=>upgradeDrawingPackagingActionFlows(upgraded),/已有三维动作图/);
assert.throws(()=>upgradeDrawingPackagingActionFlows(createBlankTwinSceneManifest()),/不是/);

const fixture = () => {
	const manifest = createBlankTwinSceneManifest(); manifest.runtime.dataMode = 'simulation';
	manifest.objects = [{ objectId:'fixture-axis', name:'真实直线轴', kind:'visual', transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]} }];
	manifest.behaviors=[]; manifest.materialSlots=[]; manifest.routes=[];
	manifest.actuators=[{actuatorId:'slide',objectId:'fixture-axis',name:'滑台 X',nodePath:'slide',kind:'linear-axis',motionAxis:'x',minValue:0,maxValue:10,speed:4,homeValue:0,unit:'meter'}];
	manifest.interlocks=[{interlockId:'permit',name:'许可',mode:'all',conditions:[{source:'permit',operator:'truthy'}]}];
	const flow:TwinActionFlowDefinitionV2={flowId:'fixture-graph',key:'fixture-graph',name:'参数修改验证',contractVersion:'2.0',actorObjectIds:['fixture-axis'],variables:[{name:'left',type:'boolean',initialValue:true}],enabled:true,revision:1,
		policies:{executionTarget:'scene',allowedRuntimeModes:['simulation'],defaultTimeoutSeconds:10,maxLoopIterations:10},nodes:[
			{nodeId:'s',type:'Start',name:'开始',config:{}},
			{nodeId:'c',type:'Condition',name:'条件',config:{predicate:{logic:'and',items:[{source:'variable',ref:'left',operator:'truthy'}]}}},
			{nodeId:'a',type:'AxisMove',name:'左目标',actorObjectId:'fixture-axis',config:{actuatorId:'slide',targetValue:2}},
			{nodeId:'b',type:'AxisMove',name:'右目标',actorObjectId:'fixture-axis',config:{actuatorId:'slide',targetValue:5}},
			{nodeId:'delay',type:'Delay',name:'节拍',config:{durationSeconds:.3}},
			{nodeId:'e',type:'End',name:'完成',config:{}},
		],edges:[['s','success','c'],['c','true','a'],['c','false','b'],['a','success','delay'],['b','success','delay'],['delay','success','e']].map(([a,p,b],i)=>({edgeId:'edge'+i,sourceNodeId:a,sourcePort:p,targetNodeId:b}))};
	manifest.actionFlows=[flow]; return manifest;
};
const run = (manifest:ReturnType<typeof fixture>, pauseTest=false) => {
	const scene=new THREE.Scene(), root=new THREE.Group(), slide=new THREE.Group(); slide.name='slide';root.userData.twinObjectId='fixture-axis';root.add(slide);scene.add(root);
	const errors:string[]=[];
	const axes=new ActuatorRuntime(manifest,()=>root,m=>errors.push(m));
	const runtime=new SceneActionFlowRuntime(manifest,scene,()=>root,m=>errors.push(m),(id,value,speedRatio)=>{axes.apply({actuatorId:id,value,speedRatio,source:'behavior'});const state=axes.getState(id)!;return state.currentValue===value;},undefined,id=>axes.holdActor(id));
	const tick=()=>{axes.tick(.05);runtime.updateFixed(.05);};
	runtime.setRunning(true); for(let i=0;i<10;i++)tick();
	if(pauseTest){runtime.setRunning(false);const position=slide.position.clone(),clock=runtime.getSnapshot().flows[0].clockSeconds;for(let i=0;i<20;i++){axes.tick(.05,false);runtime.updateFixed(.05);}assert(slide.position.equals(position));assert.equal(runtime.getSnapshot().flows[0].clockSeconds,clock);runtime.setRunning(true);}
	for(let i=0;i<500;i++){tick();const state=runtime.getSnapshot().flows[0].state;if(state==='Completed'||state==='Faulted')break;}
	const snapshot=runtime.getSnapshot(512).flows[0],position=slide.position.x;
	runtime.setRunning(false);runtime.reset({restoreMaterials:true});axes.reset();assert.equal(slide.position.x,0);assert.equal(runtime.getSnapshot().flows[0].state,'Created');
	runtime.dispose();axes.dispose(); return {snapshot,position,errors};
};
const baseline=run(fixture(),true);assert.equal(baseline.snapshot.state,'Completed');assert.equal(baseline.position,2);assert.deepEqual(baseline.errors,[]);
const slow=fixture();slow.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.speedRatio=.25;
const slower=run(slow);assert.equal(slower.position,2);assert.equal(slower.snapshot.state,'Completed');
assert(slower.snapshot.clockSeconds-baseline.snapshot.clockSeconds>1.2,'只改速度系数必须改变真实轴运动耗时');
// 姿态捕获、动作目标和真实模型单位必须一致，毫米轴不能误存为米。
const linearAxis=fixture().actuators![0];
assert.equal(readActuatorNodeValue(1.25,{...linearAxis,unit:'millimeter'}),1250);
assert.equal(readActuatorNodeValue(1.25,linearAxis),1.25);
assert.equal(readActuatorNodeValue(Math.PI/2,{...linearAxis,kind:'rotary-joint',unit:'degree'}),90);
const millimeters=fixture();millimeters.actuators![0]={...linearAxis,unit:'millimeter',maxValue:10000,speed:4000};
millimeters.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.targetValue=2000;
assert.deepEqual(validateTwinSceneManifest(millimeters).filter(d=>d.severity==='error'),[],'毫米直线轴必须通过前端草稿校验');
assert.equal(run(millimeters).position,2,'毫米动作目标必须移动到真实 2 米而不是 2000 米');
const changedDelay=fixture();changedDelay.actionFlows![0].nodes.find(n=>n.nodeId==='delay')!.config.durationSeconds=1.3;
const delayed=run(changedDelay);assert(delayed.snapshot.clockSeconds-baseline.snapshot.clockSeconds>.9, '只改 Delay 参数必须改变真实运行时间');
const changedCondition=fixture();changedCondition.actionFlows![0].variables[0].initialValue=false;
assert.equal(run(changedCondition).position,5,'只改条件变量必须选择另一真实轴目标');
const changedEdge=fixture();changedEdge.actionFlows![0].edges.find(e=>e.sourceNodeId==='c'&&e.sourcePort==='true')!.targetNodeId='b';
assert.equal(run(changedEdge).position,5,'只改连线必须改变执行节点');
const blocked=fixture();blocked.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.interlockIds=['permit'];blocked.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.timeoutPolicy={seconds:.5,onTimeout:'fault'};
const failure=run(blocked);assert.equal(failure.snapshot.state,'Faulted');assert.equal(failure.position,0);assert(failure.errors.length===1,'超时必须保持故障而非默认跳过');
const live=fixture();live.runtime.dataMode='live';const isolated=run(live);assert.equal(isolated.position,0);assert.equal(isolated.snapshot.state,'Created');
let invalid=0;
const expectInvalid=(change:(m:ReturnType<typeof fixture>)=>void)=>{const manifest=fixture();change(manifest);assert.throws(()=>compileActionFlow(manifest.actionFlows![0],manifest));invalid++;};
expectInvalid(m=>{m.actionFlows![0].edges=m.actionFlows![0].edges.filter(e=>e.sourceNodeId!=='a');});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.actuatorId='missing';});
expectInvalid(m=>{m.actionFlows![0].policies.allowedRuntimeModes=['live'];});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.type='Subflow';});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.interlockIds=['missing'];});
expectInvalid(m=>{m.behaviors=[{behaviorId:'double',name:'双控制',actorObjectId:'fixture-axis',enabled:true,actions:[{actionId:'wait',kind:'wait'}]}];});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='c')!.config.predicate={logic:'and',items:[]};});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='c')!.config.predicate={logic:'and',items:[null]};});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='c')!.config.predicate={logic:'and',items:[{source:'variable',ref:'missing',operator:'truthy'}]};});
expectInvalid(m=>{m.actionFlows![0].variables[0].name='__proto__';});
expectInvalid(m=>{m.actionFlows![0].variables[0].initialValue='true';});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.type='ParallelFork';});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.config.targetValue=1000;});
expectInvalid(m=>{m.actionFlows![0].nodes.find(n=>n.nodeId==='a')!.actorObjectId='other-actor';});
const report={passed:true,generatedAt:new Date().toISOString(),engine:'action-flow-v2-scene',flows:template.actionFlows!.length,nodes:template.actionFlows!.reduce((n,f)=>n+f.nodes.length,0),legacyBehaviors:0,realAxisExecution:true,graphParameterChangesExecution:true,graphEdgeChangesExecution:true,pauseReset:true,interlockTimeoutStops:true,liveGeneratedCommands:0,rejectedInvalidGraphs:invalid,upgradePreservesLayoutAndBindings:true,upgradePreservesProcessTiming:true,fullLineVerification:'separate verify:drawing-process',databaseWritten:false};
fs.writeFileSync('public/digital-twin/templates/drawing-action-flow-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
