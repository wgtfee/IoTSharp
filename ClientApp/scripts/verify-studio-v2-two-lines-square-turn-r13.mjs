// Regression against actual SQL r12 readback and r13 candidate.
// node --experimental-strip-types scripts/verify-studio-v2-two-lines-square-turn-r13.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes as guard} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';

const before=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r12-db-readback.json',import.meta.url),'utf8'));
const after=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-two-lines-square-turn-r13-v2.json',import.meta.url),'utf8'));
const byId=(m,id)=>m.objects.find(o=>o.objectId===id);
const mainId='component-route-d045206d';
const loadedId='reference-conveyor-ref-edge-loaded-upper-right-in';
const duplicateId='studio-v2-surplus-silk-handoff-roller';
const redId='studio-v2-surplus-silk-empty-return-roller';
const turnId='studio-v2-cache-pallet-empty-u-turn';

assert(guard(before).some(s=>s.includes('第三条水平辊道')));
assert.deepEqual(guard(after),[]);
assert.equal(after.objects.length,57);
assert(!byId(after,duplicateId),'The third overlapping horizontal conveyor must be deleted');
assert.equal(byId(after,loadedId).component.componentType,'roller-conveyor');
assert.equal(byId(after,loadedId).component.properties.length,15.700000000000001);
assert.equal(byId(after,loadedId).component.properties.cacheBranchOutput,true);
assert.equal(byId(after,redId).component.componentType,'roller-conveyor');
assert.equal(byId(after,redId).component.properties.emptyPalletOnly,true);
assert.deepEqual(byId(after,loadedId).transform.position,[-2.95,0,-5.3]);
assert.deepEqual(byId(after,redId).transform.position,[-3.9,0,-3.4]);
assert.deepEqual(byId(after,turnId).transform.position,[4.9,0,-4.35]);
assert.equal(byId(after,turnId).component.componentType,'roller-conveyor');
assert.equal(byId(after,turnId).component.generator,'roller-conveyor-v1');
assert.equal(byId(after,turnId).component.properties.squareRightAngleTransfer,true);
assert.equal(byId(after,turnId).component.properties.rounded,false);
assert.equal(byId(after,turnId).component.properties.cornerGeometry,'two-square-90-degree-transfers');
assert.deepEqual(before.routes.find(r=>r.routeId===mainId),after.routes.find(r=>r.routeId===mainId));
assert.equal(after.runtime.routePalletInitializers.find(i=>i.routeId===mainId).simulationDefaultCount,108);
const blue=structuredClone(byId(after,loadedId));
delete blue.component.properties.cacheBranchOutput;
assert.deepEqual(blue,byId(before,loadedId));
const branch=after.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
const point=id=>branch.points.find(p=>p.pointId===id);
assert.deepEqual(point('surplus-a-east').position,[4.9,.9,-5.3]);
assert.deepEqual(point('surplus-b-east').position,[4.9,.9,-3.4]);
assert.equal(point('surplus-a-east').position[0],point('surplus-b-east').position[0]);
const links=after.connections;
assert(links.some(c=>c.from.objectId===loadedId&&c.from.portId==='cache-branch-output'
  &&c.to.objectId===turnId&&c.to.portId==='input'));
assert(links.some(c=>c.from.objectId===turnId&&c.from.portId==='output'
  &&c.to.objectId===redId&&c.to.portId==='input'));

const negatives=[
 ['third overlapped conveyor reappears',m=>m.objects.push(structuredClone(byId(before,duplicateId))),'第三条水平辊道'],
 ['existing loaded blue removed',m=>m.objects=m.objects.filter(o=>o.objectId!==loadedId),'蓝线必须直接复用'],
 ['red added above old blue',m=>byId(m,redId).transform.position[2]=-7.2,'红色空小托盘'],
 ['red reverse direction',m=>byId(m,redId).transform.rotation[1]=0,'红色空小托盘'],
 ['re-introduced rounded semicircle',m=>{
   const turn=byId(m,turnId);turn.component.componentType='turn-conveyor-90';
   turn.component.properties.rounded=true;
 },'两次90度直角'],
 ['square turn facing wrong axis',m=>byId(m,turnId).transform.rotation[1]=0,'两次90度直角'],
 ['square transfer not configured',m=>byId(m,turnId).component.properties.squareRightAngleTransfer=false,'两次90度直角'],
 ['branch steals existing blue output',m=>{
   m.connections.find(c=>c.connectionId==='studio-v2-cache-loaded-east-to-empty-u-input').from.portId='output';
 },'两次90度直角'],
 ['red downstream wrong tap',m=>{
   byId(m,'reference-double-small-upper-left').component.properties.routeTaps.find(t=>t.tapId==='cache-empty-lower-return').localX=-.6;
 },'竖向回流道'],
 ['blue lane wrong z coordinate',m=>byId(m,loadedId).transform.position[2]=-6.25,'蓝线必须直接复用'],
 ['branch still refers to deleted blue',m=>{
   m.routes.find(r=>r.routeId===branch.routeId).edges[0].componentObjectId=duplicateId;
 },'所属设备错误'],
];
for(const [label,change,expect] of negatives){
  const m=structuredClone(after);
  change(m);
  assert(guard(m).some(e=>e.includes(expect)),'Did not block: '+label);
}
console.log(JSON.stringify({
  passed:true,oldR12Blocked:true,newR13PhysicalErrors:0,
  exactlyTwoHorizontalRollers:true,roundedGeometryRemoved:true,
  squareTurns:2,straightTransferLength:1.9,
  originalMainRoute108Unchanged:true,negativeTests:negatives.length,
  productionPalletHandoff:'UNVERIFIED'
},null,2));
