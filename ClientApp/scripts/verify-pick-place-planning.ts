import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Box3, BoxGeometry, Group, Mesh, Scene, Vector3 } from 'three';
import { createBlankTwinSceneManifest, validateTwinSceneManifest, type TwinSceneManifest } from '../src/digital-twin/contracts';
import { ActuatorRuntime } from '../src/digital-twin/runtime/ActuatorRuntime';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { JointTrajectoryPlayer, evaluateJointTrajectory, motionDependencySnapshot, trajectoryErrors, type TwinJointTrajectory } from '../src/digital-twin/motion/JointTrajectory';
import { applyPickPlacePreview, createBatchPickPlaceFlow, createStackingRecipeFlow, previewPickPlace } from '../src/digital-twin/motion/PickPlacePlanner';
import { createSlotTargetContext, exactNode } from '../src/digital-twin/motion/SceneSlotResolver';
import { ToolPoseSolver } from '../src/digital-twin/motion/ToolPoseSolver';
import { translatingBoxesOverlap } from '../src/digital-twin/motion/CartesianCollisionReview';
import { SimulationFlowRuntime } from '../src/digital-twin/action-flow/runtime/SimulationFlowRuntime';
import { compileActionFlow } from '../src/digital-twin/action-flow/compiler/ActionFlowCompiler';

const close = (a: number[], b: number[], tolerance = 1e-7) => assert(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tolerance), `${a} != ${b}`);
function fixture() {
	const manifest = createBlankTwinSceneManifest(); manifest.runtime.dataMode = 'simulation'; manifest.behaviors = []; manifest.actionFlows = []; manifest.routes = [];
	manifest.objects = ['actor', 'source', 'target'].map(objectId => ({ objectId, name: objectId, kind: 'visual', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }));
	manifest.actuators = ['x', 'y', 'z'].map(axis => ({ actuatorId: axis, objectId: 'actor', name: axis, nodePath: axis, kind: 'linear-axis', motionAxis: axis as 'x'|'y'|'z', unit: 'meter', minValue: -2, maxValue: 2, speed: 1, homeValue: 0 }));
	manifest.toolFrames = [{ toolFrameId: 'tcp', name: '工具', objectId: 'actor', nodePath: 'z', localPosition: [0, 0, 0], localRotation: [0, 0, 0], approachDirectionLocal: [0, -1, 0], payloadTypes: ['box'], cartesianActuatorIds: ['x', 'y', 'z'] }];
	manifest.materialSlots = ['source', 'target'].map((slotId, i) => ({ slotId, name: slotId, objectId: slotId, role: i ? 'target' : 'source', localPosition: [i ? -.4 : .4, .2, 0], contactNormalLocal: [0, 1, 0], payloadType: 'box',
		toolTargets: [{ contractVersion: 'slot-tool-target/1', templateId: 'top', toolFrameId: 'tcp', payloadType: 'box', tcpOffset: [0, 0, 0], tcpRotation: [0, 0, 0], approachDistance: .1, retreatDistance: .15 }] }));
	const scene = new Scene(), root = new Group(), x = new Group(), y = new Group(), z = new Group(), source = new Group(), target = new Group();
	root.userData.twinObjectId = 'actor'; x.name = 'x'; y.name = 'y'; z.name = 'z'; root.add(x); x.add(y); y.add(z); scene.add(root, source, target);
	const access = { getRoot: (id: string) => ({ actor: root, source, target }[id]), getRuntimeOwners: () => [] as Group[] };
	const request = { taskId: 'test-transfer', name: '静态取放', sourceSlotId: 'source', targetSlotId: 'target', toolFrameId: 'tcp', axisLimits: Object.fromEntries(['x', 'y', 'z'].map(id => [id, { velocity: 1, acceleration: 2, jerk: 10 }])) };
	return { manifest, scene, root, x, y, z, source, target, access, request };
}

const f = fixture(), before = JSON.stringify(f.manifest);
const preview = previewPickPlace(f.manifest, f.request, f.access, true);
assert(preview.trajectory); assert.equal(preview.checks.collision, 'unchecked'); assert.equal(preview.checks.handoff, 'unchecked');
assert.equal(JSON.stringify(f.manifest), before); close(f.z.getWorldPosition(f.z.position.clone()).toArray(), [0, 0, 0]);
close(preview.pick.contact, [.4, .2, 0]); close(preview.place.contact, [-.4, .2, 0]);
assert.deepEqual(trajectoryErrors(preview.trajectory, f.manifest), []);
const saved = applyPickPlacePreview(f.manifest, preview), restored = JSON.parse(JSON.stringify(saved)) as TwinSceneManifest;
assert.equal(saved.actionFlows![0].enabled, false); assert.equal(f.manifest.actionFlows!.length, 0);
assert.deepEqual(restored.motionTrajectories, saved.motionTrajectories);
assert(!validateTwinSceneManifest(restored).some(d => d.severity === 'error'), JSON.stringify(validateTwinSceneManifest(restored)));
assert.throws(() => applyPickPlacePreview(saved, preview), /已经保存/);
const orphan = structuredClone(saved); orphan.actionFlows = []; orphan.motionTrajectories![0].trajectoryId += '/持料搬运';
assert.throws(() => applyPickPlacePreview(orphan, preview), /已经保存/);
const bypass = compileActionFlow(saved.actionFlows![0], saved); bypass.policies.executionTarget = 'standalone';
assert.throws(() => new SimulationFlowRuntime(bypass).start(), /三维执行适配器/);
const edited = structuredClone(f.manifest); edited.objects[1].transform.position[0] = .01;
assert.throws(() => applyPickPlacePreview(edited, preview), /过期/);

// 后端测试读取前端真实产物，验证同一份声明经过服务端归一化后仍可消费。
const artifactPath = path.join(os.tmpdir(), 'iotsharp-pick-place-contract-fixture.json');
fs.writeFileSync(artifactPath, JSON.stringify(saved));

// 验证最终曲线而非仅端点：过短时长、越界、错误类型、版本与失效依赖都拒绝。
const invalid: Array<(t: TwinJointTrajectory) => void> = [
	t => { t.contractVersion = 'unknown' as any; }, t => { t.validation = 'passed' as any; },
	t => { t.points[1].time = .00001; }, t => { t.points[1].time = 0; }, t => { t.points[0].time = 1; },
	t => { t.points[1].positions[0] = 5; }, t => { t.points[1].positions[0] = '1' as any; },
	t => { t.axisIds[1] = t.axisIds[0]; }, t => { t.limits[0].jerk = 0; }, t => { t.limits[0].velocity = 2; },
	t => { t.dependencySnapshot = '{}'; }, t => { t.points = null as any; }, t => { t.limits = null as any; },
];
for (const change of invalid) { const trajectory = structuredClone(preview.trajectory); change(trajectory); assert(trajectoryErrors(trajectory, f.manifest).length); }
const atomic = new ActuatorRuntime(f.manifest, f.access.getRoot);
assert.equal(atomic.applyTrajectoryFrame('actor', [{ actuatorId: 'x', value: 1 }, { actuatorId: 'y', value: 3 }]), false);
close([f.x.position.x, f.y.position.y], [0, 0]);
atomic.setDataMode('live'); assert.equal(atomic.applyTrajectoryFrame('actor', [{ actuatorId: 'x', value: 1 }]), false); atomic.dispose();

function play(parts: number[]) {
	const values = [...preview.trajectory!.points[0].positions];
	const player = new JointTrajectoryPlayer(preview.trajectory!, f.manifest, { read: id => values[preview.trajectory!.axisIds.indexOf(id)], write: (_actor, targets) => { targets.forEach((target, i) => values[i] = target.value); return true; } });
	for (const dt of parts) player.advance(dt);
	return values;
}
close(play([.5]), play(Array.from({ length: 50 }, () => .01)));
close(play([.5]), evaluateJointTrajectory(preview.trajectory, .5));
assert.throws(() => new JointTrajectoryPlayer(preview.trajectory!, f.manifest, { read: () => .2, write: () => true }), /起始轴/);

// 实际动作图 + 实际执行轴，覆盖联锁撤销、暂停恢复和最终到位。
const runtimeFixture = fixture(), runtimeManifest = applyPickPlacePreview(runtimeFixture.manifest, preview);
runtimeManifest.interlocks = [{ interlockId: 'permit', name: '允许运动', mode: 'all', conditions: [{ source: 'permit', operator: 'truthy' }] }];
runtimeManifest.motionTrajectories![0].dependencySnapshot = motionDependencySnapshot(runtimeManifest);
runtimeManifest.actionFlows![0].enabled = true; runtimeManifest.actionFlows![0].nodes[1].config.interlockIds = ['permit'];
const axis = new ActuatorRuntime(runtimeManifest, runtimeFixture.access.getRoot);
const flow = new SceneActionFlowRuntime(runtimeManifest, runtimeFixture.scene, runtimeFixture.access.getRoot, undefined,
	(id, value) => axis.applyActionFlow(id, value), undefined, id => axis.holdActor(id),
	{ read: id => axis.getState(id)?.currentValue as number, write: (actor, targets) => axis.applyTrajectoryFrame(actor, targets) });
flow.setBindingContext({ bindingValues: { permit: true } }); flow.setRunning(true);
for (let i = 0; i < 20; i++) flow.updateFixed(.01);
const paused = axis.getSnapshot().map(s => Number(s.currentValue)); assert(paused.some(v => Math.abs(v) > 0));
flow.setBindingContext({ bindingValues: { permit: false } }); for (let i = 0; i < 20; i++) { flow.prepareMotionTick(); axis.tick(.01); flow.updateFixed(.01); }
close(axis.getSnapshot().map(s => Number(s.currentValue)), paused);
flow.setRunning(false); flow.setBindingContext({ bindingValues: { permit: true } }); for (let i = 0; i < 20; i++) flow.updateFixed(.01);
close(axis.getSnapshot().map(s => Number(s.currentValue)), paused);
flow.setRunning(true); for (let i = 0; i < 5000 && flow.getSnapshot().flows[0].state !== 'Completed'; i++) flow.updateFixed(.01);
assert.equal(flow.getFault(), undefined); assert.equal(flow.getSnapshot().flows[0].state, 'Completed');
close(axis.getSnapshot().map(s => Number(s.currentValue)), preview.trajectory.points.at(-1)!.positions);
flow.dispose(); axis.dispose();

// 真实物料取放闭环：按同一抓取关系搬运，交接保留世界位姿，不生成替代物料。
const materialFixture = fixture(), grip = new Group(), payload = new Group();
grip.name = 'grip'; materialFixture.z.add(grip);
materialFixture.manifest.actuators!.push({ actuatorId: 'grip', name: '夹具', objectId: 'actor', nodePath: 'grip', kind: 'gripper', unit: 'boolean' });
materialFixture.manifest.materialSlots![1].capacity = 1;
payload.userData = { materialEntity: true, payloadType: 'box', twinEntityId: 'box-1' }; payload.position.set(.4, .2, 0); materialFixture.source.add(payload);
const materialPreview = previewPickPlace(materialFixture.manifest, { ...materialFixture.request, transferMaterials: true, payloadCount: 1 }, materialFixture.access, true);
assert(materialPreview.transfer);
const materialManifest = applyPickPlacePreview(materialFixture.manifest, materialPreview); materialManifest.actionFlows![0].enabled = true;
assert(!validateTwinSceneManifest(materialManifest).some(d => d.severity === 'error'), JSON.stringify(validateTwinSceneManifest(materialManifest)));
const materialAxis = new ActuatorRuntime(materialManifest, materialFixture.access.getRoot);
const materialFlow = new SceneActionFlowRuntime(materialManifest, materialFixture.scene, materialFixture.access.getRoot, undefined,
	(id, value) => materialAxis.applyActionFlow(id, value), undefined, id => materialAxis.holdActor(id),
	{ read: id => materialAxis.getState(id)?.currentValue as number, write: (actor, targets) => materialAxis.applyTrajectoryFrame(actor, targets) });
materialFlow.setRunning(true);
for(let i=0;i<5000 && materialFlow.getSnapshot().flows[0].state!=='Completed' && !materialFlow.getFault();i++)materialFlow.updateFixed(.01);
assert.equal(materialFlow.getFault(), undefined); assert.equal(materialFlow.getSnapshot().flows[0].state,'Completed');
assert.equal(payload.parent, materialFixture.target); assert.equal(payload.userData.materialAttachedBy, undefined);
close(payload.getWorldPosition(payload.position.clone()).toArray(), [-.4,.2,0], 1e-4);
assert.equal(materialAxis.getState('grip')!.currentValue, false);
materialFlow.dispose(); materialAxis.dispose();

// 动态码垛在每批开始时使用当前轴姿态和托盘层位规划，不复用上一批冻结目标。
function stackingFixture() {
	const f = fixture(), grip = new Group(), pallet = new Group(), anchor = new Group();
	grip.name='grip';f.z.add(grip);anchor.name='StackAnchor';pallet.add(anchor);pallet.position.x=-.4;pallet.userData={twinEntityId:'wood-A',transportUnitType:'wooden-pallet'};f.scene.add(pallet);
	f.target.userData.stationPalletIds=['wood-A'];
	f.manifest.actuators!.push({actuatorId:'grip',name:'夹具',objectId:'actor',nodePath:'grip',kind:'gripper',unit:'boolean'});
	Object.assign(f.manifest.materialSlots![1],{role:'stack',capacity:2,runtimeOwnerType:'wooden-pallet',runtimeOwnerSelection:'station-batch',runtimeOwnerNodePath:'StackAnchor',metadata:{precisePlacement:true},stackPattern:{rows:1,columns:1,layers:2,spacingX:1,spacingZ:1,originX:0,originZ:0,firstLayerY:.2,layerPitch:.5}});
	const refill=(id:string)=>{const p=new Group();p.position.set(.4,.2,0);p.userData={materialEntity:true,payloadType:'box',twinEntityId:id};f.source.add(p);return p;};
	const request={...f.request,transferMaterials:true,payloadCount:1};
	const manifest=createBatchPickPlaceFlow(f.manifest,request);manifest.actionFlows![0].enabled=true;
	const axis=new ActuatorRuntime(manifest,f.access.getRoot);
	const runtime=()=>new SceneActionFlowRuntime(manifest,f.scene,f.access.getRoot,undefined,(id,value)=>axis.applyActionFlow(id,value),undefined,id=>axis.holdActor(id),{read:id=>axis.getState(id)?.currentValue as number,write:(actor,targets)=>axis.applyTrajectoryFrame(actor,targets)});
	return {...f,manifest,pallet,anchor,refill,axis,runtime};
}
const stacking=stackingFixture();
fs.writeFileSync(path.join(os.tmpdir(),'iotsharp-batch-planning-contract-fixture.json'),JSON.stringify(stacking.manifest));
for(let layer=0;layer<2;layer++) {
	const p=stacking.refill(`stack-box-${layer}`), runtime=stacking.runtime();runtime.setRunning(true);
	for(let i=0;i<5000&&runtime.getSnapshot().flows[0].state!=='Completed'&&!runtime.getFault();i++)runtime.updateFixed(.01);
	assert.equal(runtime.getFault(),undefined);assert.equal(runtime.getSnapshot().flows[0].state,'Completed');assert.equal(stacking.anchor.userData.stackItemCount,layer+1);
	close(p.getWorldPosition(p.position.clone()).toArray(),[-.4,.2+layer*.5,0],1e-4);
	assert.equal(p.parent,stacking.anchor);assert.equal(runtime.getSnapshot(1).planningRecords.length,1);
	runtime.dispose();
}
assert.equal(stacking.pallet.userData.stackComplete,true);
stacking.axis.dispose();

const swapped=stackingFixture();swapped.refill('swap-box');const swapRuntime=swapped.runtime();swapRuntime.setRunning(true);
for(let i=0;i<30;i++)swapRuntime.updateFixed(.01);
const beforeSwap=swapped.axis.getSnapshot().map(s=>s.currentValue);
swapped.target.userData.stationPalletIds=['wood-B'];swapRuntime.updateFixed(.01);
assert(swapRuntime.getFault()?.includes('载体缺失'));assert.deepEqual(swapped.axis.getSnapshot().map(s=>s.currentValue),beforeSwap);
swapRuntime.dispose();swapped.axis.dispose();

// 失败必须发生在下一次轴写入之前，不能以重新取最近物料或跳步骤补救。
for(const scenario of ['source-pose','step-order','held-payload','fake-layer'] as const){
	const invalid=stackingFixture(),part=invalid.refill(`negative-${scenario}`);
	if(scenario==='step-order')invalid.manifest.actionFlows![0].nodes.find(n=>n.type==='PlannedTransferStep')!.config.step='carry';
	if(scenario==='held-payload'){part.userData.materialAttachedBy='older-flow';invalid.z.attach(part);}
	if(scenario==='fake-layer'){
		invalid.manifest.actionFlows![0].nodes.find(n=>n.type==='PlanPickPlace')!.config.request={...invalid.request,transferMaterials:true,payloadCount:1,expectedLayer:1,palletRecipeId:'recover'};
		invalid.anchor.userData.stackItemCount=1;
	}
	const flow=invalid.runtime();flow.setRunning(true);
	if(scenario==='source-pose'){for(let i=0;i<30;i++)flow.updateFixed(.01);part.rotation.y=.1;}
	const before=invalid.axis.getSnapshot().map(s=>s.currentValue);
	for(let i=0;i<5&&!flow.getFault();i++)flow.updateFixed(.01);
	assert(flow.getFault(),scenario);assert.deepEqual(invalid.axis.getSnapshot().map(s=>s.currentValue),before,scenario);
	assert(!invalid.anchor.children.includes(part),scenario);flow.dispose();invalid.axis.dispose();
}

const completePallets: Array<{ mode:string; materials:number; separators:number; recovered:boolean }> = [];
for(const [mode,recover] of [['none',false],['between-layers',false],['every-layer',false],['between-layers',true],['every-layer',true]] as const) {
	const f=stackingFixture(), boardSource=new Group(), bx=new Group(), by=new Group(), bz=new Group(), boardGrip=new Group();
	bx.name='bx';by.name='by';bz.name='bz';boardGrip.name='board-grip';f.root.add(bx);bx.add(by);by.add(bz);bz.add(boardGrip);f.scene.add(boardSource);
	f.manifest.objects.push({objectId:'board-source',name:'隔板库',kind:'visual',transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}});
	for(const [id,axis] of [['bx','x'],['by','y'],['bz','z']] as const)f.manifest.actuators!.push({actuatorId:id,name:id,objectId:'actor',nodePath:id,kind:'linear-axis',motionAxis:axis,unit:'meter',minValue:-2,maxValue:2,speed:1,homeValue:0});
	f.manifest.actuators!.push({actuatorId:'board-grip',name:'隔板夹具',objectId:'actor',nodePath:'board-grip',kind:'gripper',unit:'boolean'});
	f.manifest.toolFrames!.push({toolFrameId:'board-tcp',name:'隔板 TCP',objectId:'actor',nodePath:'bz',localPosition:[0,0,0],approachDirectionLocal:[0,-1,0],payloadTypes:['separator'],cartesianActuatorIds:['bx','by','bz']});
	Object.assign(f.manifest.materialSlots![0],{capacity:6,metadata:{contactFromMaterials:true,contactBatchSize:6,contactSurfaceOffset:0,selectionOrder:'grid-row-major'}});
	Object.assign(f.manifest.materialSlots![1],{capacity:48,stackPattern:{rows:2,columns:3,layers:8,spacingX:.1,spacingZ:.1,originX:-.1,originZ:-.05,firstLayerY:.2,layerPitch:.15,separatorMode:mode,separatorThickness:.01,layerMaterialOffsetY:.07}});
	const boardTargets=[{contractVersion:'slot-tool-target/1' as const,templateId:'board-top',toolFrameId:'board-tcp',payloadType:'separator',tcpOffset:[0,0,0] as [number,number,number],tcpRotation:[0,0,0] as [number,number,number],approachDistance:.1,retreatDistance:.1}];
	f.manifest.materialSlots!.push({slotId:'board-source',name:'隔板来源',objectId:'board-source',role:'source',localPosition:[.6,.2,0],payloadType:'separator',capacity:1,contactNormalLocal:[0,1,0],toolTargets:boardTargets},
		{slotId:'board-target',name:'层间隔板',objectId:'target',role:'target',localPosition:[0,0,0],payloadType:'separator',capacity:8,contactNormalLocal:[0,1,0],runtimeOwnerType:'wooden-pallet',runtimeOwnerNodePath:'StackAnchor',runtimeOwnerSelection:'station-batch',stackPatternSlotId:'target',metadata:{precisePlacement:true},toolTargets:structuredClone(boardTargets)});
	const axisLimits=Object.fromEntries(['x','y','z','bx','by','bz'].map(id=>[id,{velocity:1,acceleration:2,jerk:10}]));
	const main={...f.request,axisLimits,transferMaterials:true,payloadCount:6},board={...main,taskId:'board',name:'隔板',sourceSlotId:'board-source',targetSlotId:'board-target',toolFrameId:'board-tcp',payloadCount:1};
	const manifest=createStackingRecipeFlow({...f.manifest,actionFlows:[]},main,mode==='none'?undefined:board);manifest.actionFlows![0].enabled=true;
	const errors=validateTwinSceneManifest(manifest).filter(d=>d.severity==='error');assert.equal(errors.length,0,JSON.stringify(errors));
	if(mode==='every-layer')fs.writeFileSync(path.join(os.tmpdir(),'iotsharp-stacking-recipe-contract-fixture.json'),JSON.stringify(manifest));
	const access={getRoot:(id:string)=>id==='board-source'?boardSource:f.access.getRoot(id)};
	const axes=new ActuatorRuntime(manifest,access.getRoot);
	const createRuntime=(m:TwinSceneManifest)=>new SceneActionFlowRuntime(m,f.scene,access.getRoot,undefined,(id,value)=>axes.applyActionFlow(id,value),undefined,id=>axes.holdActor(id),{read:id=>axes.getState(id)?.currentValue as number,write:(actor,targets)=>axes.applyTrajectoryFrame(actor,targets)});
	let runtime=createRuntime(manifest),recovered=false;
	const retained = new Map<Group,number[]>();
	let fedLayers=0,fedBoards=0;const boardCount=mode==='none'?0:mode==='between-layers'?7:8;
	const feed=()=>{
		if(!f.source.children.some(n=>n.userData.materialEntity)&&fedLayers<8){for(let i=0;i<6;i++){const p=new Group();p.position.set(.4-.1+i%3*.1,.2,-.05+Math.floor(i/3)*.1);p.userData={materialEntity:true,payloadType:'box',twinEntityId:`${mode}-box-${fedLayers*6+i}`,materialGridRow:Math.floor(i/3)+1,materialGridColumn:i%3+1};f.source.add(p);}fedLayers++;}
		if(!boardSource.children.some(n=>n.userData.materialEntity)&&fedBoards<boardCount){const p=new Group();p.position.set(.6,.2,0);p.userData={materialEntity:true,payloadType:'separator',twinEntityId:`${mode}-board-${fedBoards++}`};boardSource.add(p);}
	};
	feed();runtime.setRunning(true);
	for(let i=0;i<20000&&runtime.getSnapshot().flows[0].state!=='Completed'&&!runtime.getFault();i++){
		runtime.updateFixed(.05);feed();
		if(recover&&!recovered&&f.anchor.userData.stackItemCount===18&&(f.anchor.userData.stackLayerMaterialCount||0)===(mode==='between-layers'?2:3)){
			let held=false;f.root.traverse(n=>{if(n.userData.materialAttachedBy)held=true;});if(held)continue;
			f.anchor.traverse(n=>{if(n.userData.materialEntity){n.updateWorldMatrix(true,false);retained.set(n as Group,[...n.matrixWorld.elements]);}});
			runtime.dispose();
			const next=createStackingRecipeFlow({...manifest,actionFlows:[]},{...main,taskId:'recover'},board,{completedLayers:3,pendingSeparator:mode==='between-layers'});
			next.actionFlows![0].enabled=true;runtime=createRuntime(next);runtime.setRunning(true);recovered=true;
		}
	}
	assert.equal(runtime.getFault(),undefined,mode);assert.equal(runtime.getSnapshot().flows[0].state,'Completed',mode);assert.equal(f.anchor.userData.stackItemCount,48);assert.equal(f.anchor.userData.stackLayerMaterialCount||0,boardCount);assert.equal(f.pallet.userData.stackComplete,true);
	const ids:string[]=[];f.anchor.traverse(n=>{if(n.userData.materialEntity){ids.push(n.userData.twinEntityId);assert(!n.userData.materialAttachedBy);assert((n.userData.materialHandoffMaxDelta||0)<=1e-7);}});assert.equal(new Set(ids).size,48+boardCount);
	assert.equal(recovered,recover);for(const [node,matrix] of retained){node.updateWorldMatrix(true,false);close(node.matrixWorld.elements,matrix);}
	completePallets.push({mode,materials:48,separators:boardCount,recovered});runtime.dispose();axes.dispose();f.axis.dispose();
}

// 两轴桁架不能靠瞬移实现缺失的自由度；不可达首候选不会挡住后续候选。
const unreachable = fixture(); unreachable.manifest.toolFrames![0].cartesianActuatorIds = ['y', 'z'];
assert.throws(() => previewPickPlace(unreachable.manifest, unreachable.request, unreachable.access, true), /无法由当前实际轴/);
const fallback = fixture(); const candidate = fallback.manifest.materialSlots![0].toolTargets![0];
fallback.manifest.materialSlots![0].toolTargets!.unshift({ ...candidate, templateId: 'a-bad', tcpOffset: [10, 0, 0] });
const recovered = previewPickPlace(fallback.manifest, fallback.request, fallback.access, true);
assert.equal(recovered.pick.templateId, 'top'); assert(recovered.rejections.length > 0);
const solver = new ToolPoseSolver(f.manifest, f.root, f.manifest.toolFrames![0]);
assert.throws(() => solver.solve([0, 0, 0], [1, 0, 0, 0]), /无法由当前实际轴/);
const duplicateNode = new Group(); duplicateNode.name = 'z'; f.root.add(duplicateNode); assert.equal(exactNode(f.root, 'z'), undefined); f.root.remove(duplicateNode);

// 连续碰撞：薄障碍在两端之间；包围盒并集的假阳性由相对运动 slab 检查排除。
const box = (x: number, y: number, z: number, half = .01) => new Box3(new Vector3(x-half,y-half,z-half),new Vector3(x+half,y+half,z+half));
assert(translatingBoxesOverlap(box(-1,0,0),box(1,0,0),box(.123,0,0,.00001),box(.123,0,0,.00001)));
assert(!translatingBoxesOverlap(box(0,0,0),box(1,1,0),box(0,1,0),box(0,1,0)));
assert(!translatingBoxesOverlap(box(0,0,0),box(1,0,0),box(0,.02,0),box(0,.02,0)));
assert(translatingBoxesOverlap(box(-1,0,0),box(1,0,0),box(1,0,0),box(-1,0,0)));
const collision = fixture(), toolMesh = new Mesh(new BoxGeometry(.02,.02,.02)), obstacle = new Mesh(new BoxGeometry(.002,.04,.04));
toolMesh.name='实际工具';obstacle.name='薄障碍';collision.z.add(toolMesh);obstacle.position.set(0,.325,0);collision.target.add(obstacle);
assert.throws(()=>previewPickPlace(collision.manifest,collision.request,collision.access,true),/第 4 段.*连续包围体冲突/);
const collisionFallback = collision.manifest.materialSlots![0].toolTargets![0];
collision.manifest.materialSlots![0].toolTargets!.push({...collisionFallback,templateId:'z-higher',retreatDistance:.5});
const clearCandidate = previewPickPlace(collision.manifest,collision.request,collision.access,true);
assert.equal(clearCandidate.pick.templateId,'z-higher');assert.equal(clearCandidate.checks.collision,'partial');assert(clearCandidate.rejections.some(r=>r.reason.includes('连续包围体')));
assert.equal(clearCandidate.collisionReview?.status,'clear-within-scope');
const collisionSaved=applyPickPlacePreview(collision.manifest,clearCandidate);
const collisionRestored=JSON.parse(JSON.stringify(collisionSaved));
const decision=collisionRestored.actionFlows[0].nodes.find((node:any)=>node.type==='FollowTrajectory').config.planningReview;
assert.equal(decision.pickCandidateId,clearCandidate.pick.candidateId);assert.equal(decision.collisionReview.status,'clear-within-scope');assert(decision.rejections.length);
close([collision.x.position.x,collision.y.position.y,collision.z.position.z],[0,0,0]);

// 工具可通过不代表持料可通过；保留 TCP 相对抓取变换计算整批物料扫掠。
const carriedFixture=fixture(),carriedGrip=new Group(),carriedTool=new Mesh(new BoxGeometry(.02,.02,.02)),carriedBox=new Mesh(new BoxGeometry(.1,.1,.1)),lowObstacle=new Mesh(new BoxGeometry(.002,.02,.02));
carriedGrip.name='grip';carriedFixture.z.add(carriedGrip,carriedTool);carriedBox.name='实际箱体';lowObstacle.name='工具下方障碍';
carriedFixture.manifest.actuators!.push({actuatorId:'grip',name:'夹具',objectId:'actor',nodePath:'grip',kind:'gripper',unit:'boolean'});
carriedFixture.manifest.materialSlots![1].capacity=1;carriedBox.position.set(.4,.12,0);carriedBox.userData={materialEntity:true,payloadType:'box',twinEntityId:'carried-box'};carriedFixture.source.add(carriedBox);
lowObstacle.position.set(0,.245,0);carriedFixture.target.add(lowObstacle);
assert.throws(()=>previewPickPlace(carriedFixture.manifest,{...carriedFixture.request,transferMaterials:true,payloadCount:1},carriedFixture.access,true),/第 4 段.*实际箱体.*工具下方障碍/);
lowObstacle.position.z=1;
assert.equal(previewPickPlace(carriedFixture.manifest,{...carriedFixture.request,transferMaterials:true,payloadCount:1},carriedFixture.access,true).checks.collision,'partial');

// 本批物料旋转不能在动态绑定摘要中漏掉；局部接触法向须含槽位旋转。
const rotated = fixture(), sourceSlot = rotated.manifest.materialSlots![0], rotatedPayload = new Group();
rotatedPayload.position.set(.4,.2,0);rotatedPayload.userData={materialEntity:true,payloadType:'box',twinEntityId:'rotated'};rotated.source.add(rotatedPayload);
sourceSlot.metadata={contactFromMaterials:true,contactBatchSize:1,contactSurfaceOffset:.1};sourceSlot.localRotation=[0,0,Math.PI/2];
const snapshot1=createSlotTargetContext(rotated.manifest,sourceSlot,rotated.access).resolvedSlotFrame!;
close(snapshot1.worldMatrix.elements.slice(12,15),[.3,.2,0]);rotatedPayload.rotation.y=.2;
const snapshot2=createSlotTargetContext(rotated.manifest,sourceSlot,rotated.access).resolvedSlotFrame!;
assert.notEqual(snapshot1.stateRevision,snapshot2.stateRevision);

// 动态快照必须有明确批次身份、节点和库存，不能使用最近对象兜底。
const dynamic = fixture(), slot = dynamic.manifest.materialSlots![1]; slot.runtimeOwnerType = 'wooden-pallet'; slot.runtimeOwnerSelection = 'station-batch'; slot.runtimeOwnerNodePath = 'StackAnchor';
slot.stackPattern = { rows: 1, columns: 1, layers: 2, spacingX: 1, spacingZ: 1, firstLayerY: .1, layerPitch: .5 };
assert.throws(() => createSlotTargetContext(dynamic.manifest, slot, dynamic.access), /工位批次/);
const owner = new Group(), anchor = new Group(); owner.userData = { twinEntityId: 'pallet-A', transportUnitType: 'wooden-pallet' }; anchor.name = 'StackAnchor'; owner.add(anchor); dynamic.scene.add(owner); dynamic.target.userData.stationPalletIds = ['pallet-A'];
const access = { ...dynamic.access, getRuntimeOwners: () => [owner] };
const layer0 = createSlotTargetContext(dynamic.manifest, slot, access).resolvedSlotFrame!;
anchor.userData.stackItemCount = 1;
const layer1 = createSlotTargetContext(dynamic.manifest, slot, access).resolvedSlotFrame!;
assert.notEqual(layer0.stateRevision, layer1.stateRevision); assert.equal(layer1.worldMatrix.elements[13], .6);
anchor.userData.stackItemCount = 2; assert.throws(() => createSlotTargetContext(dynamic.manifest, slot, access), /已满/);
slot.runtimeOwnerSelection = 'nearest'; assert.throws(() => createSlotTargetContext(dynamic.manifest, slot, access), /最近距离/);

console.log(JSON.stringify({ passed: true, invalidTrajectories: invalid.length, actualAxisRuntime: true, pauseInterlockResume: true, atomicWrites: true, stableClock: true, actualKinematicChain: true, candidateFallback: true, dynamicIdentity: true, dynamicStackLayers:2, completePallets, midMotionPalletSwapRejected:true, jsonRoundtrip: true, backendFixture: artifactPath, continuousCartesianCollision:true, collisionCandidateFallback:true, collisionValidated: false, materialHandoffExecuted: true }));
