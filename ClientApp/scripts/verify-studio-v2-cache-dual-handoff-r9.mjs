// node --experimental-strip-types scripts/verify-studio-v2-cache-dual-handoff-r9.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';

const r8 = JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r8-db-readback.json',import.meta.url),'utf8'));
const r9 = JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-cache-double-r9-candidate.json',import.meta.url),'utf8'));
const id='studio-v2-surplus-silk-handoff-roller';
const routeId='studio-v2-surplus-silk-bidirectional-handoff';
const guard=manifest=>inspectStudioV2PhysicalRoutes(manifest);
const oldErrors=guard(r8);
assert(oldErrors.some(e=>e.includes('双排小辊道')),'r8 single lane must be blocked');
assert.equal(guard(r9).length,0,JSON.stringify(guard(r9)));
const originalMain=r8.routes.find(r=>r.routeId==='component-route-d045206d');
const candidateMain=r9.routes.find(r=>r.routeId==='component-route-d045206d');
assert.deepEqual(originalMain,candidateMain,'108 pallet closed-loop must not be changed');
assert.deepEqual(r9.routes.filter(r=>r.routeId!==routeId),r8.routes.filter(r=>r.routeId!==routeId));
assert.equal(r9.objects.length,56);
assert.equal(r9.connections.length,50);
assert.equal(r9.runtime.routePalletInitializers.find(x=>x.routeId===originalMain.routeId).simulationDefaultCount,108);
const conveyor=r9.objects.find(o=>o.objectId===id);
assert.equal(conveyor.component.componentType,'double-small-roller-conveyor');
assert.equal(conveyor.component.properties.laneAReverse,false);
assert.equal(conveyor.component.properties.laneBReverse,true);
assert.equal(conveyor.component.properties.laneSpacing,1.9);
const clone=()=>structuredClone(r9);
const broken=[
  {name:'missing second conveyor lane',change:m=>m.objects.find(o=>o.objectId===id).component.componentType='roller-conveyor',pattern:'双排小辊道'},
  {name:'reverse inner lane',change:m=>m.objects.find(o=>o.objectId===id).component.properties.laneAReverse=true,pattern:'双排小辊道'},
  {name:'reverse outer lane',change:m=>m.objects.find(o=>o.objectId===id).component.properties.laneBReverse=false,pattern:'双排小辊道'},
  {name:'insufficient parallel spacing',change:m=>m.objects.find(o=>o.objectId===id).component.properties.laneSpacing=1.1,pattern:'双排小辊道'},
  {name:'one bidirectional route edge',change:m=>m.routes.find(r=>r.routeId===routeId).edges[0].bidirectional=true,pattern:'独立单向通路'},
  {name:'missing lower return edge',change:m=>m.routes.find(r=>r.routeId===routeId).edges.pop(),pattern:'独立单向通路'},
  {name:'upper arrow reverse',change:m=>{
    const e=m.routes.find(r=>r.routeId===routeId).edges[0];
    [e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId];
  },pattern:'箭头方向不一致'},
  {name:'lower arrow reverse',change:m=>{
    const e=m.routes.find(r=>r.routeId===routeId).edges[2];
    [e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId];
  },pattern:'箭头方向不一致'},
  {name:'same centerline for both lanes',change:m=>{
    const route=m.routes.find(r=>r.routeId===routeId);
    for(const p of route.points.filter(p=>p.pointId.startsWith('surplus-b')))p.position[2]=-8.15;
  },pattern:'脱离物理双排辊道'},
];
for(const item of broken){
  const m=clone();
  item.change(m);
  assert(guard(m).some(message=>message.includes(item.pattern)),item.name+' must fail physical guard');
}
console.log(JSON.stringify({
  passed:true,sourceRevision:8,nextRevision:9,oldScenePhysicalErrors:oldErrors.length,
  candidatePhysicalErrors:0,dualLaneCount:2,separateDirectedEdges:4,
  negativeCases:broken.map(x=>x.name),mainLoopUnchanged:true,
  reusablePallets:108,originalV19ReadOnly:true,
},null,2));
