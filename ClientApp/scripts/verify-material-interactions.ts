import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BehaviorRuntime } from '../src/digital-twin/runtime/BehaviorRuntime';
import { createBlankTwinSceneManifest, type TwinBehaviorActionDefinition, type TwinSceneManifest } from '../src/digital-twin/contracts';
import { materialStateRef, validMaterialStateRef } from '../src/digital-twin/action-flow/contracts/material-state';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { compileActionFlow } from '../src/digital-twin/action-flow/compiler/ActionFlowCompiler';

// 真实 Three.js 对象及生产交接原语；不伪造 Attach/Place 完成信号。
function fixture(batch = false, configure?: (manifest: TwinSceneManifest)=>void) {
	const manifest=createBlankTwinSceneManifest(); manifest.runtime.dataMode='simulation'; manifest.behaviors=[];
	const scene=new THREE.Scene(), roots=new Map<string,THREE.Group>();
	for(const id of ['actor','stock','target']){const root=new THREE.Group();root.name=id;root.userData.twinObjectId=id;roots.set(id,root);scene.add(root);}
	manifest.objects=[...roots].map(([id])=>({objectId:id,name:id,kind:'visual' as const,transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}}));
	const actor=roots.get('actor')!,stock=roots.get('stock')!,target=roots.get('target')!;
	target.position.x=2;
	const tcp=new THREE.Group();tcp.name='tcp';actor.add(tcp);
	manifest.toolFrames=[{toolFrameId:'tcp/1',name:'TCP',objectId:'actor',nodePath:'tcp',localPosition:[0,0,0]}];
	manifest.actuators=[{actuatorId:'grip:1',name:'夹具',objectId:'actor',nodePath:'tcp',kind:'gripper',unit:'boolean'}];
	manifest.materialSlots=[{slotId:'source',name:'来源',objectId:'stock',role:'source',localPosition:[0,0,0],payloadType:'part',capacity:2},{slotId:'target',name:'目标',objectId:'target',role:'target',localPosition:[0,0,0],payloadType:'part',capacity:1}];
	manifest.workPoints=[{workPointId:'place',name:'放料',objectId:'target',role:'place',materialSlotId:'target',toolFrameId:'tcp/1',localPosition:[0,0,0]}];
	const items:Array<THREE.Group>=[];
	for(let i=0;i<(batch?2:1);i++){const material=new THREE.Group();material.position.x=batch?i-.5:0;material.position.y=.058;material.add(new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1),new THREE.MeshBasicMaterial()));material.userData={materialEntity:true,payloadType:'part',twinEntityId:`part-${i}`};stock.add(material);items.push(material);}
	if(batch){
		actor.userData.stationPalletIds=['p1','p2'];
		for(let i=0;i<2;i++){const pallet=new THREE.Group();pallet.position.x=1.5+i;pallet.userData={transportUnitType:'plastic-pallet',twinEntityId:`p${i+1}`,smallPalletSupportSurfaceY:0};const anchor=new THREE.Group();anchor.name='anchor';pallet.add(anchor);scene.add(pallet);}
		Object.assign(manifest.materialSlots[1],{objectId:'actor',capacity:2,runtimeOwnerType:'plastic-pallet',runtimeOwnerNodePath:'anchor',runtimeOwnerSelection:'station-batch',distributePayloadAcrossRuntimeOwners:true,runtimeOwnerDistributionMode:'one-per-owner',metadata:{precisePlacement:true}});
		manifest.workPoints[0].objectId='actor';
	}
	configure?.(manifest);
	const runtime=new BehaviorRuntime(manifest,scene,id=>roots.get(id));runtime.setRunning(true);
	let sequence=0;
	const run=(kind:TwinBehaviorActionDefinition['kind'],extra:Partial<TwinBehaviorActionDefinition>={},channel='flow/actor')=>runtime.executePrimitive(channel,'actor',`execution-${++sequence}`,{actionId:`action-${sequence}`,kind,...extra},.05);
	const attach=()=>run('attach',{sourceSlotId:'source',toolFrameId:'tcp/1',payloadType:'part',payloadCount:batch?2:1});
	const detach=()=>run('detach',{targetSlotId:'target',toolFrameId:'tcp/1',workPointId:'place'});
	const read=(kind:string,...parts:string[])=>runtime.readSemanticValue(materialStateRef(kind,...parts));
	return {manifest,scene,actor,tcp,stock,target,items,runtime,run,attach,detach,read};
}

const f=fixture(),item=f.items[0],identity=item.uuid;
assert.equal(f.read('tool','tcp/1','empty'),true);
assert.equal(f.attach(),false,'夹具未闭合不可挂接');assert.equal(item.parent,f.stock);
f.run('gripClose',{actuatorId:'grip:1'});
f.actor.position.x=1;assert.equal(f.attach(),false,'未接触不可隔空抓取');assert.equal(item.parent,f.stock);
f.actor.position.x=0;const before=item.getWorldPosition(new THREE.Vector3());assert.equal(f.attach(),true);
assert.equal(f.read('slot','source','availableCount'),0);assert.equal(f.read('tool','tcp/1','heldCount'),1);
assert.equal(item.uuid,identity);assert(item.getWorldPosition(new THREE.Vector3()).distanceTo(before)<1e-9);
assert.throws(()=>f.run('gripOpen',{actuatorId:'grip:1'}),/仍持有物料/);
assert.throws(()=>f.run('attach',{sourceSlotId:'source',toolFrameId:'tcp/1',payloadType:'part'},'second/actor'),/占用/);
assert.equal(f.detach(),false,'未到放料点应等待');assert.equal(f.read('tool','tcp/1','heldCount'),1);
const blocker=new THREE.Group();blocker.userData={materialEntity:true,payloadType:'part'};f.target.add(blocker);f.actor.position.x=2;
assert.equal(f.read('slot','target','freeCapacity'),0);assert.equal(f.detach(),false,'目标满位不能覆盖或先松爪');assert.equal(f.read('gripper','grip:1','closed'),true);
blocker.removeFromParent();const heldPosition=item.getWorldPosition(new THREE.Vector3());
assert.equal(f.detach(),true);assert.equal(item.parent,f.target);assert.equal(item.uuid,identity);assert.equal(item.userData.materialAttachedBy,undefined);assert(item.getWorldPosition(new THREE.Vector3()).distanceTo(heldPosition)<1e-9);
assert.equal(f.read('gripper','grip:1','closed'),false);assert.equal(f.read('tool','tcp/1','empty'),true);assert.equal(f.read('slot','target','freeCapacity'),0);
assert.throws(()=>f.detach(),/没有物料/);assert.throws(()=>f.runtime.setSignal(materialStateRef('tool','tcp/1','empty'),true),/只读/);
f.runtime.dispose();

const empty=fixture();empty.items[0].removeFromParent();empty.run('gripClose',{actuatorId:'grip:1'});assert.equal(empty.attach(),false);assert.equal(empty.read('slot','source','availableCount'),0,'取料不能自动补出库存');empty.runtime.dispose();

const paused=fixture();paused.run('gripClose',{actuatorId:'grip:1'});paused.runtime.setRunning(false);assert.equal(paused.attach(),false);assert.equal(paused.items[0].parent,paused.stock);paused.runtime.setRunning(true);assert(paused.attach());paused.runtime.reset({restoreMaterials:true});assert.equal(paused.read('tool','tcp/1','empty'),true);assert.equal(paused.read('slot','source','availableCount'),1);paused.runtime.dispose();

const batch=fixture(true);batch.run('gripClose',{actuatorId:'grip:1'});assert(batch.attach());batch.actor.position.x=2;batch.items[1].position.z=.2;
const parents=batch.items.map(m=>m.parent), positions=batch.items.map(m=>m.getWorldPosition(new THREE.Vector3()));
assert.throws(()=>batch.detach(),/尚未与目标托盘逐件对齐/,'最后一件不贴合应阻止整批');
batch.items.forEach((m,i)=>{assert.equal(m.parent,parents[i]);assert(m.getWorldPosition(new THREE.Vector3()).distanceTo(positions[i])<1e-9);});
assert.equal(batch.read('tool','tcp/1','heldCount'),2);assert.equal(batch.read('gripper','grip:1','closed'),true);batch.items[1].position.z=0;assert(batch.detach());assert.equal(batch.read('tool','tcp/1','heldCount'),0);batch.runtime.dispose();

const template=createDrawingPackagingProcessManifest();
const defaults=fixture();defaults.run('gripClose',{actuatorId:'grip:1'});assert(defaults.run('attach',{sourceSlotId:'source',toolFrameId:'tcp/1'}),'未指定类型必须继承来源槽位');defaults.runtime.dispose();
const wrongTool=fixture(false,m=>{m.toolFrames![0].payloadTypes=['separator'];});wrongTool.run('gripClose',{actuatorId:'grip:1'});assert.throws(()=>wrongTool.attach(),/类型.*不匹配/);assert.equal(wrongTool.items[0].parent,wrongTool.stock);wrongTool.runtime.dispose();
const wrongTarget=fixture(false,m=>{m.materialSlots![1].payloadType='separator';});wrongTarget.run('gripClose',{actuatorId:'grip:1'});assert(wrongTarget.attach());wrongTarget.actor.position.x=2;const heldParent=wrongTarget.items[0].parent;assert.throws(()=>wrongTarget.detach(),/类型.*不匹配/);assert.equal(wrongTarget.items[0].parent,heldParent);assert.equal(wrongTarget.read('gripper','grip:1','closed'),true);wrongTarget.runtime.dispose();
const foreign=fixture();const foreignItem=new THREE.Group();foreignItem.userData={materialEntity:true,payloadType:'foreign',twinEntityId:'foreign'};foreign.target.add(foreignItem);assert.equal(foreign.read('slot','target','freeCapacity'),0,'异类实物仍占容量');foreign.runtime.dispose();
for(const mode of ['duplicate','missing','elsewhere']){const f=fixture(mode==='duplicate');if(mode==='duplicate')f.items[1].userData.twinEntityId=f.items[0].userData.twinEntityId;else if(mode==='missing')delete f.items[0].userData.twinEntityId;else{const copy=f.items[0].clone();f.target.add(copy);}f.run('gripClose',{actuatorId:'grip:1'});assert.throws(()=>f.attach(),/ID.*(缺失|重复)/);assert.equal(f.items[0].parent,f.stock);assert.equal(f.read('tool','tcp/1','heldCount'),0);f.runtime.dispose();}
const invalid=(change:(m:typeof template)=>void)=>{const m=structuredClone(template);change(m);assert.throws(()=>compileActionFlow(m.actionFlows![0],m));};
invalid(m=>{m.actionFlows![0].nodes.find(n=>n.type==='Attach')!.config.sourceSlotId='missing';});
invalid(m=>{m.actionFlows![0].nodes.find(n=>n.type==='Attach')!.config.toolFrameId=m.toolFrames!.find(t=>t.objectId==='drawing-stacking-gantry')!.toolFrameId;});
invalid(m=>{m.actionFlows![0].nodes.find(n=>n.type==='SetState')!.config={scope:'semantic',ref:'material/tool/invalid/empty',value:true};});
invalid(m=>{m.actionFlows![0].nodes.find(n=>n.type==='Condition')!.config.predicate={logic:'and',items:[{source:'runtime',ref:'material/slot/missing/occupied',operator:'truthy'}]};});
assert(validMaterialStateRef(materialStateRef('tool',template.toolFrames![0].toolFrameId,'empty'),template));
assert(!validMaterialStateRef('material/tool/%ZZ/empty',template));
console.log(JSON.stringify({passed:true,closedAndContactRequired:true,noSyntheticMaterial:true,fullTargetWaits:true,stableIdentityAndPosition:true,atomicBatchRelease:true,readOnlyConditions:true,pauseReset:true,payloadTypesEnforced:true,foreignMaterialConsumesCapacity:true,duplicateAndMissingIdsRejected:true,sourceTypeDefault:true,rejectedInvalidGraphs:4,scope:'production-material-primitives-and-compiler; full-line tested separately'},null,2));
