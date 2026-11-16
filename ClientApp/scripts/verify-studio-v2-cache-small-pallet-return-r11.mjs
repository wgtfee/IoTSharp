// Run with node --experimental-strip-types: actual SQL r10 and candidate r11.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const old=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r10-db-readback.json',import.meta.url),'utf8'));
const next=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-cache-small-pallet-r11-candidate.json',import.meta.url),'utf8'));
const guard=inspectStudioV2PhysicalRoutes;
const base=old.routes.find(r=>r.routeId==='component-route-d045206d');
const main=next.routes.find(r=>r.routeId==='component-route-d045206d');
assert.deepEqual(main,base);
assert(guard(old).some(x=>x.includes('蓝箭头下方红色空托回流')));
assert.deepEqual(guard(next),[]);
const branch=next.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
const handoff=next.objects.find(o=>o.objectId==='studio-v2-surplus-silk-handoff-roller');
const left=next.objects.find(o=>o.objectId==='reference-double-small-upper-left');
const byPoint=id=>branch.points.find(p=>p.pointId===id);
assert.equal(branch.transportUnitResourceKey,'builtin-small-pallet');
assert.equal(handoff.component.properties.length,11.4);
assert.equal(handoff.transform.position[0],-7);
assert.equal(handoff.component.properties.robotPickupLocalX,3);
assert(byPoint('surplus-a-west').position[2]<byPoint('surplus-b-west').position[2]);
assert.deepEqual(byPoint('surplus-a-west').position,[-12.7,.9,-8.15]);
assert.deepEqual(byPoint('surplus-b-west').position,[-12.7,.9,-6.25]);
assert.deepEqual(byPoint('surplus-empty-downstream-main').position,[-12.7,.9,9]);
assert(left.component.properties.routeTaps.some(x=>x.tapId==='cache-empty-lower-return'&&x.lane==='A'&&x.localX===-2.5));
assert(next.connections.some(x=>x.connectionId==='studio-v2-cache-red-lower-empty-return-to-left-downward-lane'));
const negate=[
  {name:'red lower empty-return no left vertical connection',change:m=>m.connections=m.connections.filter(x=>x.connectionId!=='studio-v2-cache-red-lower-empty-return-to-left-downward-lane'),text:'竖向回流道'},
  {name:'red empty return moved above blue',change:m=>m.routes.find(r=>r.routeId===branch.routeId).points.find(p=>p.pointId==='surplus-b-west').position[2]=-9.5,text:'脱离物理双排辊道'},
  {name:'fake short lane',change:m=>m.objects.find(x=>x.objectId===handoff.objectId).component.properties.length=5.4,text:'双排小辊道'},
  {name:'reversed lower return from left to right',change:m=>{const e=m.routes.find(r=>r.routeId===branch.routeId).edges.find(e=>e.edgeId==='surplus-b-robot-to-west');[e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId]},text:'箭头方向'},
  {name:'return not going down',change:m=>m.routes.find(r=>r.routeId===branch.routeId).points.find(p=>p.pointId==='surplus-empty-downstream-main').position[2]=-17.7,text:'脱离物理双排辊道'},
];
for(const item of negate){
  const scene=structuredClone(next);
  item.change(scene);
  assert(guard(scene).some(x=>x.includes(item.text)),item.name);
}
console.log(JSON.stringify({passed:true,originalr10Blocked:true,candidater11Violations:0,
  actualSmallPalletResource:'builtin-small-pallet',
  upperBlue:'left-to-right z=-8.15',lowerRed:'right-to-left z=-6.25 (below blue)',
  leftReturn:'(-12.7,-6.25) joins existing inner downward return',
  negatives:negate.length,main108Unchanged:true,
  mainOccupancyHandshake:'NOT YET VERIFIED'},null,2));
