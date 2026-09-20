import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ActuatorRuntime } from '../src/digital-twin/runtime/ActuatorRuntime';
import { BehaviorRuntime } from '../src/digital-twin/runtime/BehaviorRuntime';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { createBlankTwinSceneManifest, type TwinActuatorDefinition, type TwinSceneManifest } from '../src/digital-twin/contracts';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { defaultComponentRegistry } from '../src/digital-twin/components';
import type { TwinV7SceneManifest } from '../src/digital-twin/contracts/v7-components';
import type { TwinActionFlowNode } from '../src/digital-twin/action-flow/contracts/action-flow-v2';

// 使用生产执行器/动作图和真实组件，不用定时完成信号代替到位。
let rejectedCommands = 0;
function axisFixture(overrides: Partial<TwinActuatorDefinition> = {}) {
	const manifest = createBlankTwinSceneManifest(); manifest.runtime.dataMode = 'simulation'; manifest.behaviors = [];
	const root = new THREE.Group(), node = new THREE.Group(); root.userData.twinObjectId = 'actor'; node.name = 'axis'; root.add(node);
	manifest.objects = [{ objectId: 'actor', name: '滑台', kind: 'visual', transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } }];
	manifest.actuators = [{ actuatorId: 'axis', objectId: 'actor', name: '测试轴', nodePath: 'axis', kind: 'linear-axis', motionAxis: 'x', unit: 'meter', minValue: -1, maxValue: 1, speed: 1, homeValue: 0, ...overrides }];
	const errors: string[] = [], runtime = new ActuatorRuntime(manifest, () => root, message => errors.push(message));
	return { manifest, root, node, errors, runtime };
}
for (const source of ['behavior','action-flow','manual-test','telemetry'] as const) {
	const f = axisFixture(); if (source === 'telemetry') f.runtime.setDataMode('live');
	assert(f.runtime.apply({actuatorId:'axis',value:.25,source,immediate:true}));
	for (const value of [1.00001,-1.00001,NaN,Infinity,-Infinity]) {
		assert.equal(f.runtime.apply({actuatorId:'axis',value,source,immediate:true}),false);
		const state = f.runtime.getState('axis')!; assert(state.fault && state.error?.includes('测试轴'));
		assert.equal(state.currentValue,.25); assert.equal(state.targetValue,.25); f.runtime.tick(10); assert.equal(f.node.position.x,.25); rejectedCommands++;
	}
	for (const value of [-1,1]) assert(f.runtime.apply({actuatorId:'axis',value,source,immediate:true}),'准确边界应可到达');
	assert.equal(f.runtime.getState('axis')!.fault,false); f.runtime.dispose();
}
for (const [unit, kind, max] of [['millimeter','linear-axis',1000],['degree','rotary-joint',90]] as const) {
	const f=axisFixture({unit,kind,minValue:0,maxValue:max});
	assert(f.runtime.applyManualTest('axis',max));
	assert(Math.abs((kind === 'rotary-joint' ? f.node.rotation.x : f.node.position.x) - (unit === 'degree' ? Math.PI/2 : 1)) < 1e-9);
	assert.equal(f.runtime.applyActionFlow('axis',max+.001),false); assert.equal(f.runtime.getState('axis')!.targetValue,max); rejectedCommands++;
	f.runtime.dispose();
}
const bounded=axisFixture({kind:'rotary-joint',unit:'rad',minValue:-3,maxValue:3,speed:1});
assert(bounded.runtime.applyManualTest('axis',2.9)); assert(bounded.runtime.applyActionFlow('axis',-2.9));
let crossedZero=false;
for(let i=0;i<120;i++){bounded.runtime.tick(.05);const value=Number(bounded.runtime.getState('axis')!.currentValue);assert(value>=-3&&value<=3);if(Math.abs(value)<.03)crossedZero=true;}
assert(crossedZero);assert.equal(bounded.runtime.getState('axis')!.currentValue,-2.9);assert.equal(bounded.runtime.getState('axis')!.moving,false);bounded.runtime.dispose();
const continuous=axisFixture({kind:'rotary-joint',unit:'rad',minValue:undefined,maxValue:undefined});
continuous.runtime.applyManualTest('axis',2.9);continuous.runtime.applyActionFlow('axis',-2.9);continuous.runtime.tick(.05);assert(Number(continuous.runtime.getState('axis')!.currentValue)>2.9);continuous.runtime.dispose();
const noTeleport=axisFixture({telemetryInterpolation:{enabled:false}});noTeleport.runtime.applyActionFlow('axis',1);noTeleport.runtime.tick(.05);assert.equal(noTeleport.node.position.x,.05,'遥测无插值配置不能让动作流瞬移');noTeleport.runtime.dispose();
const badHome=axisFixture({homeValue:2});badHome.runtime.reset();assert(badHome.runtime.getState('axis')!.fault);assert.equal(badHome.node.position.x,0);badHome.runtime.dispose();
const missing=axisFixture({nodePath:'missing'});assert.equal(missing.runtime.applyManualTest('axis',1),false);assert.equal(missing.root.position.x,0);missing.runtime.dispose();

function motionFixture() {
	const f=axisFixture(), scene=new THREE.Scene();scene.add(f.root);f.runtime.dispose();
	const y=new THREE.Group();y.name='y';f.node.add(y);
	f.manifest.actuators!.push({...f.manifest.actuators![0],actuatorId:'y',name:'Y轴',nodePath:'y',motionAxis:'y'});
	f.manifest.toolFrames=[{toolFrameId:'tcp',name:'TCP',objectId:'actor',nodePath:'y',localPosition:[0,0,0],cartesianActuatorIds:['axis','y']}];
	f.manifest.workPoints=[{workPointId:'point',name:'越程工作点',objectId:'actor',role:'safe',toolFrameId:'tcp',localPosition:[.5,5,0]}];
	f.manifest.poses=[{poseId:'pose',name:'越程姿态',objectId:'actor',targets:[{actuatorId:'axis',value:.5},{actuatorId:'y',value:5}]}];
	return {...f,scene,y};
}
function graph(manifest: TwinSceneManifest, type: TwinActionFlowNode['type'], actor: string, config: Record<string,unknown>) {
	manifest.actionFlows=[{flowId:'limits',key:'limits',name:'行程保护',contractVersion:'2.0',actorObjectIds:[actor],variables:[],enabled:true,revision:1,
		policies:{executionTarget:'scene',allowedRuntimeModes:['simulation'],defaultTimeoutSeconds:30,maxLoopIterations:10},
		nodes:[{nodeId:'s',type:'Start',name:'开始',config:{}},{nodeId:'motion',type,name:'待测动作',actorObjectId:actor,config},{nodeId:'e',type:'End',name:'完成',config:{}}],
		edges:[{edgeId:'a',sourceNodeId:'s',sourcePort:'success',targetNodeId:'motion'},{edgeId:'b',sourceNodeId:'motion',sourcePort:'success',targetNodeId:'e'}]}];
}
function expectImmediateFault(manifest: TwinSceneManifest, scene: THREE.Scene, roots: Map<string,THREE.Group>, message: RegExp) {
	let commands=0;const errors:string[]=[];
	const axes=new ActuatorRuntime(manifest,id=>roots.get(id),m=>errors.push(m)), before=axes.getSnapshot();
	const runtime=new SceneActionFlowRuntime(manifest,scene,id=>roots.get(id),m=>errors.push(m),(id,value,speedRatio)=>{commands++;const accepted=axes.apply({actuatorId:id,value,speedRatio,source:'action-flow'});if(!accepted)throw new Error(axes.getState(id)?.error);return axes.getState(id)!.currentValue===value;},undefined,id=>axes.holdActor(id));
	runtime.setRunning(true);for(let i=0;i<5;i++)runtime.updateFixed(.05);
	const snapshot=runtime.getSnapshot(100);assert.equal(snapshot.flows[0].state,'Faulted');assert.match(snapshot.fault!,message);assert(snapshot.flows[0].clockSeconds<.3,'必须立即明确故障，不是等待30秒超时');
	assert.equal(commands,0,'整组目标失败时不可下发部分轴');assert.deepEqual(axes.getSnapshot(),before);assert(errors.length===1);runtime.dispose();axes.dispose();
}
for(const type of ['MovePose','MoveTo','Home'] as const){const f=motionFixture();if(type==='Home')f.manifest.actuators![1].homeValue=5;graph(f.manifest,type,'actor',type==='MovePose'?{poseId:'pose'}:type==='MoveTo'?{workPointId:'point'}:{});expectImmediateFault(f.manifest,f.scene,new Map([['actor',f.root]]),/超出行程/);}
// 不接统一轴回调的旧原语入口也不能偷偷截断或把 NaN 判成到位。
const direct=motionFixture(), primitives=new BehaviorRuntime(direct.manifest,direct.scene,()=>direct.root);primitives.setRunning(true);
assert.throws(()=>primitives.executePrimitive('test','actor','bad',{actionId:'bad',kind:'axisMove',actuatorId:'axis',targetValue:2},.05),/超出行程/);assert.equal(direct.node.position.x,0);primitives.dispose();
const bypass=motionFixture();bypass.manifest.toolFrames![0].cartesianActuatorIds=[];graph(bypass.manifest,'MoveTo','actor',{workPointId:'point',actorNodePath:'y'});expectImmediateFault(bypass.manifest,bypass.scene,new Map([['actor',bypass.root]]),/禁止直接拖动节点绕过行程限制/);
for(const restricted of [false,true]) {
	const manifest=createDrawingPackagingProcessManifest(), object=(manifest as TwinV7SceneManifest).objects.find(o=>o.objectId==='drawing-loading-robot')!;
	object.transform={position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
	const built=defaultComponentRegistry.create({...object.component!,objectId:object.objectId,name:object.name,resourceId:object.resourceId,transform:object.transform});
	const scene=new THREE.Scene();scene.add(built.root);manifest.objects=[object];manifest.behaviors=[];manifest.routes=[];manifest.materialSlots=[];manifest.interlocks=[];
	manifest.actuators=manifest.actuators!.filter(a=>a.objectId===object.objectId);manifest.toolFrames=manifest.toolFrames!.filter(f=>f.objectId===object.objectId);
	if(restricted)for(const a of manifest.actuators.filter(a=>a.kind==='rotary-joint')){const node=built.root.getObjectByName(a.nodePath)!;a.minValue=a.maxValue=node.rotation[a.motionAxis!];}
	manifest.workPoints=[{workPointId:'unreachable',name:'不可达点',objectId:object.objectId,role:'safe',toolFrameId:manifest.toolFrames[0].toolFrameId,localPosition:restricted?[4,3,1]:[100,100,100]}];
	graph(manifest,'MoveTo',object.objectId,{workPointId:'unreachable'});expectImmediateFault(manifest,scene,new Map([[object.objectId,built.root]]),/目标不可达.*关节行程/);
}
console.log(JSON.stringify({passed:true,rejectedCommands,allFourSources:true,unitsAndExactBoundaries:true,boundedRotationStaysInTravel:true,invalidHomeRejected:true,missingNodeRejected:true,atomicPoseCartesianHome:true,unreachableIkFaultsImmediately:true,configuredJointLimitsHonored:true,noSilentClamp:true,databaseWritten:false},null,2));
