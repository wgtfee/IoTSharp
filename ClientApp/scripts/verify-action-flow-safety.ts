import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBlankTwinSceneManifest } from '../src/digital-twin/contracts';
import { ActuatorRuntime } from '../src/digital-twin/runtime/ActuatorRuntime';
import { BehaviorRuntime } from '../src/digital-twin/runtime/BehaviorRuntime';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { SimulationFlowRuntime } from '../src/digital-twin/action-flow/runtime/SimulationFlowRuntime';
import { compileActionFlow } from '../src/digital-twin/action-flow/compiler/ActionFlowCompiler';
import type { TwinActionFlowDefinitionV2, TwinActionFlowNode } from '../src/digital-twin/action-flow/contracts/action-flow-v2';

function fixture() {
	const manifest=createBlankTwinSceneManifest(); manifest.runtime.dataMode='simulation'; manifest.behaviors=[]; manifest.routes=[];
	manifest.objects=[{objectId:'actor',name:'测试轴',kind:'visual',transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}}];
	// 专项只使用已存在的 bindingId 与注入值，不伪造 PLC 成功信号。
	manifest.bindings=[{bindingId:'permit'}] as typeof manifest.bindings;
	manifest.actuators=[{actuatorId:'slide',objectId:'actor',name:'滑台',nodePath:'slide',kind:'linear-axis',motionAxis:'x',unit:'meter',minValue:0,maxValue:10,homeValue:0,speed:1}];
	manifest.interlocks=[{interlockId:'permit',name:'许可',mode:'all',conditions:[{source:'binding:permit',operator:'truthy'}]}];
	const scene=new THREE.Scene(), root=new THREE.Group(), slide=new THREE.Group();root.userData.twinObjectId='actor';slide.name='slide';root.add(slide);scene.add(root);
	const node=(nodeId:string,type:TwinActionFlowNode['type'],config:Record<string,unknown>={}):TwinActionFlowNode=>({nodeId,type,name:nodeId,actorObjectId:'actor',config});
	const edge=(sourceNodeId:string,targetNodeId:string,sourcePort='success')=>({edgeId:`${sourceNodeId}-${sourcePort}-${targetNodeId}`,sourceNodeId,sourcePort,targetNodeId});
	const flow:TwinActionFlowDefinitionV2={flowId:'safety',key:'safety',name:'安全回归',contractVersion:'2.0',actorObjectIds:['actor'],variables:[],enabled:true,revision:1,policies:{executionTarget:'scene',allowedRuntimeModes:['simulation'],defaultTimeoutSeconds:30,maxLoopIterations:100},nodes:[node('s','Start'),node('move','AxisMove',{actuatorId:'slide',targetValue:5,interlockIds:['permit']}),node('end','End')],edges:[edge('s','move'),edge('move','end')]};
	manifest.actionFlows=[flow]; return {manifest,flow,node,edge,scene,root,slide};
}
function run(f:ReturnType<typeof fixture>) {
	const errors:string[]=[], axes=new ActuatorRuntime(f.manifest,()=>f.root,m=>errors.push(m));
	const runtime=new SceneActionFlowRuntime(f.manifest,f.scene,()=>f.root,m=>errors.push(m),(id,value,speedRatio)=>{const ok=axes.apply({actuatorId:id,value,speedRatio,source:'action-flow'});if(!ok)throw Error(axes.getState(id)?.error);return axes.getState(id)!.currentValue===value;},undefined,id=>axes.holdActor(id));
	return {runtime,axes,errors,start:(values:Record<string,unknown>={},stale:string[]=[])=>{runtime.setBindingContext({bindingValues:values,staleBindingIds:stale});runtime.setRunning(true);},step:(count=1)=>{for(let i=0;i<count;i++){runtime.prepareMotionTick();axes.tick(.05);runtime.updateFixed(.05);}},dispose:()=>{runtime.dispose();axes.dispose();}};
}
const f=fixture(), r=run(f);r.start({permit:true});r.step(4);const stopped=f.slide.position.x;
r.runtime.setBindingContext({bindingValues:{permit:false}});assert.equal(r.axes.getState('slide')!.targetValue,stopped);r.step(20);assert.equal(f.slide.position.x,stopped);assert.equal(r.runtime.getSnapshot().flows[0].state,'WaitingSignal');
r.runtime.setBindingContext({bindingValues:{permit:true}});r.step(120);assert.equal(f.slide.position.x,5);assert.equal(r.runtime.getSnapshot().flows[0].state,'Completed');assert.deepEqual(r.errors,[]);r.dispose();

for(const [operator,value,stale,allowed] of [
	['falsy',undefined,false,false],['falsy',true,true,false],['truthy','false',false,false],['truthy','0',false,false],['truthy',NaN,false,false],['falsy',null,false,false],['notEquals',undefined,false,false],
	['truthy','true',false,true],['falsy','false',false,true],['falsy',0,false,true],
] as const){const f=fixture();f.manifest.interlocks![0].conditions[0]={source:'binding:permit',operator,value:true};const r=run(f);r.start(value===undefined?{}:{permit:value},stale?['permit']:[]);r.step(10);assert.equal(f.slide.position.x>0,allowed,`${operator}/${value}/stale=${stale}`);r.dispose();}

let invalidGraphs=0;
function rejected(change:(f:ReturnType<typeof fixture>)=>void, code:string){const f=fixture();change(f);assert.throws(()=>compileActionFlow(f.flow,f.manifest),new RegExp(code));invalidGraphs++;}
for(const ref of ['binding:permit',' binding:permit ','permit','station.materialCount','material/tool/missing/empty']) rejected(f=>{f.flow.nodes[1]=f.node('move','SetState',{scope:'semantic',ref,value:true});},'AF1411');
for(const key of ['onStartState','onCompleteState']) rejected(f=>{f.flow.nodes[1].config[key]=[{source:'binding:permit',value:true}];},'AF1411');
for(const policy of ['skip','retry','compensate','manualConfirm'] as const) rejected(f=>{f.flow.nodes[1].timeoutPolicy={seconds:.15,onTimeout:policy};},'AF1414');
rejected(f=>{f.flow.nodes[1].retryPolicy={maxAttempts:2,backoffSeconds:.1};},'AF1414');
for(const port of ['timeout','failure'])rejected(f=>f.flow.edges.push(f.edge('move','end',port)),'AF1414');
const readonlyFixture=fixture(), primitive=new BehaviorRuntime(readonlyFixture.manifest,readonlyFixture.scene,()=>readonlyFixture.root);primitive.setBindingContext({bindingValues:{permit:false}});
for(const key of ['permit','binding:permit',' binding:permit '])assert.throws(()=>primitive.setSignal(key,true),/只读/);assert.equal(primitive.readSemanticValue('binding:permit'),false);primitive.dispose();

// 绕过编译器直接传旧计划也必须安全停机，不能把动作改成 Skipped/Completed。
for(const mode of ['timeout','error'] as const){const f=fixture(), plan=compileActionFlow(f.flow,f.manifest);const movement=plan.nodes.find(n=>n.nodeId==='move')!;movement.timeoutPolicy={seconds:.15,onTimeout:'skip'};movement.retryPolicy={maxAttempts:3,backoffSeconds:0};plan.edges.push(f.edge('move','end','failure'));
	const axes=new ActuatorRuntime(f.manifest,()=>f.root);let interrupted=0;
	const runtime=new SimulationFlowRuntime(plan,{onNodeInterrupted:()=>{interrupted++;axes.holdActor('actor');},executeNode:node=>{if(node.type!=='AxisMove')return undefined;if(mode==='error')throw Error('模拟运动故障');axes.applyActionFlow('slide',5);return 'running';}});
	runtime.start();for(let i=0;i<12;i++){axes.tick(.05);runtime.tick(.05);}assert.equal(runtime.getSnapshot().state,'Faulted');assert(interrupted>0);const stopped=f.slide.position.x;axes.tick(1);assert.equal(f.slide.position.x,stopped);assert.equal(axes.getState('slide')!.targetValue,stopped);assert(!runtime.getSnapshot().events.some(e=>['StepSkipped','RunCompleted','StepRetryScheduled'].includes(e.type)));axes.dispose();
}

function edgeRuntime(operator:'risingEdge'|'changed', initial:boolean) {
	const f=fixture();f.flow.nodes=[f.node('s','Start'),f.node('c','Condition',{predicate:{logic:'and',items:[{source:'binding',ref:'permit',operator}]}}),f.node('hit','Delay',{durationSeconds:0}),f.node('loop','Loop',{maxIterations:20}),f.node('end','End')];
	f.flow.edges=[f.edge('s','c'),f.edge('c','hit','true'),f.edge('c','loop','false'),f.edge('hit','loop'),f.edge('loop','c','repeat'),f.edge('loop','end','done')];
	const runtime=new SimulationFlowRuntime(compileActionFlow(f.flow,f.manifest),{signals:{permit:initial},executeNode:()=>undefined});runtime.start();
	const tick=()=>runtime.tick(.05), hits=()=>runtime.getSnapshot().events.filter(e=>e.type==='StepSucceeded'&&e.nodeId==='hit').length;
	const sample=(value:unknown)=>{for(let i=0;i<10&&runtime.getSnapshot().activeNodeIds[0]!=='c';i++)tick();runtime.setSignal('permit',value);tick();if(runtime.getSnapshot().activeNodeIds[0]==='hit')tick();};
	return {runtime,tick,hits,sample};
}
for(const operator of ['risingEdge','changed'] as const){const a=edgeRuntime(operator,true);for(let i=0;i<12;i++)a.tick();assert.equal(a.hits(),0,'初始高电平不应伪造边沿');
	const b=edgeRuntime(operator,false);b.tick();b.sample(true);assert.equal(b.hits(),1);for(let i=0;i<10;i++)b.tick();assert.equal(b.hits(),1,'持续高电平不得重复触发');b.sample(false);b.sample(true);assert.equal(b.hits(),operator==='changed'?3:2);
	b.runtime.reset();b.runtime.start();for(let i=0;i<6;i++)b.tick();assert.equal(b.hits(),0,'复位不能沿用前次边沿');
	const c=edgeRuntime(operator,false);c.tick();c.sample(undefined);c.sample(true);assert.equal(c.hits(),0,'失效后第一次有效值只重建基线');
}
console.log(JSON.stringify({passed:true,interlockDropHoldsPosition:true,interlockRecoveryResumes:true,unknownAndStaleFailClosed:true,stringBooleanNormalized:true,bindingReadOnly:true,unsafeTimeoutRejected:true,runtimeDefenseStopsAxes:true,edgeSamplingAndReset:true,rejectedInvalidGraphs:invalidGraphs,databaseWritten:false},null,2));
