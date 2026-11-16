// Node 22 --experimental-strip-types. Exact SQL r11 baseline vs r12 candidate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectStudioV2PhysicalRoutes as guard } from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const r11=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r11-db-readback.json',import.meta.url),'utf8'));
const r12=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-cache-independent-r12-candidate.json',import.meta.url),'utf8'));
const oldErrors=guard(r11);
assert(oldErrors.some(e=>e.includes('删除缓存机器人下错误的双排组件')));
assert.deepEqual(guard(r12),[],'r12 source may not contain any physical-route failure');
const obj=(m,id)=>m.objects.find(o=>o.objectId===id);
const blue='studio-v2-surplus-silk-handoff-roller';
const red='studio-v2-surplus-silk-empty-return-roller';
const blueR=obj(r12,blue),redR=obj(r12,red);
assert.equal(blueR.component.componentType,'roller-conveyor');
assert.equal(redR.component.componentType,'roller-conveyor');
assert.equal(r12.objects.length,58);
assert.equal(r12.connections.length,53);
assert.equal(blueR.transform.position[2],-6.25,'former lower of r11 double must be blue');
assert.equal(redR.transform.position[2],-4.35,'red must be below former lower blue');
assert(Math.abs(redR.transform.position[2]-blueR.transform.position[2]-1.9)<1e-6);
assert.equal(blueR.transform.rotation[1],0);
assert(Math.abs(Math.abs(redR.transform.rotation[1])-Math.PI)<1e-8);
assert.equal(r12.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff').transportUnitResourceKey,'builtin-small-pallet');
assert.deepEqual(r11.routes.find(r=>r.routeId==='component-route-d045206d'),
  r12.routes.find(r=>r.routeId==='component-route-d045206d'));
assert.equal(r12.runtime.routePalletInitializers.find(i=>i.routeId==='component-route-d045206d').simulationDefaultCount,108);
const negative=[
  ['integrated double falsely reappears', m=>obj(m,blue).component.componentType='double-small-roller-conveyor', '必须删除'],
  ['new red conveyor deleted',m=>m.objects=m.objects.filter(o=>o.objectId!==red),'红色空小托盘'],
  ['blue moved back to old top lane',m=>obj(m,blue).transform.position[2]=-8.15,'蓝色载丝线'],
  ['red erroneously above blue',m=>obj(m,red).transform.position[2]=-8.15,'红色空小托盘'],
  ['red reversed to go right',m=>obj(m,red).transform.rotation[1]=0,'红色空小托盘'],
  ['blue reversed to go left',m=>obj(m,blue).transform.rotation[1]=Math.PI,'蓝色载丝线'],
  ['old U-turn location',m=>obj(m,'studio-v2-cache-pallet-empty-u-turn').transform.position[2]=-7.2,'180 度 U'],
  ['U output incorrectly targets blue',m=>{
    m.connections.find(c=>c.connectionId==='studio-v2-cache-u-output-to-empty-return-b').to.objectId=blue;
  },'180 度 U'],
  ['red output disconnected from left return',m=>{
    m.connections=m.connections.filter(c=>c.connectionId!=='studio-v2-cache-red-lower-empty-return-to-left-downward-lane');
  },'竖向回流道'],
  ['old red track location retained',m=>{
    m.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff').points
      .find(p=>p.pointId==='surplus-b-west').position[2]=-6.25;
  },'脱离蓝/红'],
  ['red returns on blue component edge',m=>{
    m.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff').edges
      .find(e=>e.edgeId==='surplus-b-robot-to-west').componentObjectId=blue;
  },'所属设备错误'],
];
for(const [name,change,message] of negative){
  const m=structuredClone(r12);
  change(m);
  assert(guard(m).some(e=>e.includes(message)),String(name));
}
console.log(JSON.stringify({passed:true,oldDoubleBlocked:true,newIndependentRollerCount:2,
  blue:{formerLowerZ:-6.25,loaded:true,direction:'right'},
  red:{newLowerZ:-4.35,emptyOnly:true,direction:'left'},turnZ:-5.3,
  leftReturnTapLocalX:-.6,negativeTests:negative.length,
  mainRoute108Untouched:true,downstreamMainPalletAcceptance:'NOT_VERIFIED'},null,2));
