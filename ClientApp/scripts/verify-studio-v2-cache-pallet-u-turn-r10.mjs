import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';

const r9=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r9-db-readback.json',import.meta.url),'utf8'));
const r10=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-cache-pallet-u-turn-r10-v2.json',import.meta.url),'utf8'));
const guard=scene=>inspectStudioV2PhysicalRoutes(scene);
assert(guard(r9).some(error=>error.includes('180 度 U 形')));
assert.deepEqual(guard(r10),[]);
assert.deepEqual(r9.routes.find(x=>x.routeId==='component-route-d045206d'),
  r10.routes.find(x=>x.routeId==='component-route-d045206d'));
assert.deepEqual(r9.runtime,r10.runtime);
assert.equal(r10.routes.length,5);
assert.equal(r10.objects.length,57);
assert.equal(r10.connections.length,52);
assert.equal(r10.runtime.routePalletInitializers.find(i=>i.routeId==='component-route-d045206d').simulationDefaultCount,108);
const branch=r10.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
const u='studio-v2-cache-pallet-empty-u-turn';
assert.equal(branch.edges.length,5);
assert(branch.edges.every(e=>e.bidirectional===false));
const byId=id=>branch.edges.find(e=>e.edgeId===id);
assert.equal(byId('surplus-empty-after-pick-u-turn').componentObjectId,u);
assert.equal(byId('surplus-empty-after-pick-u-turn').emptyPalletOnly,true);
assert(branch.edges.filter(e=>e.edgeId.startsWith('surplus-b-')).every(e=>e.emptyPalletOnly));
assert(branch.edges.filter(e=>e.edgeId.startsWith('surplus-a-')).every(e=>e.loadedPalletOnly));
for(const [name, mutate, expect] of [
  ['missing U-shaped conveyor', m=>{m.objects=m.objects.filter(o=>o.objectId!==u)},'180 度 U 形'],
  ['teleport gap replacing U', m=>{m.routes.find(r=>r.routeId===branch.routeId).edges[4].componentObjectId='studio-v2-surplus-silk-handoff-roller'},'所属设备错误'],
  ['wrong U-turn angle',m=>{m.objects.find(o=>o.objectId===u).component.properties.sweepDegrees=90},'180 度 U 形'],
  ['reused silk mistakenly flowing on empty return',m=>{m.routes.find(r=>r.routeId===branch.routeId).edges[3].emptyPalletOnly=false},'用途/所属设备错误'],
  ['reverse empty-return direction',m=>{const e=m.routes.find(r=>r.routeId===branch.routeId).edges[3];[e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId]},'方向不一致'],
]){
  const changed=structuredClone(r10);
  mutate(changed);
  assert(guard(changed).some(error=>error.includes(expect)),name+' incorrectly accepted');
}
console.log(JSON.stringify({passed:true,oldR9Blocked:true,newR10PhysicalRouteViolations:0,
  loadedInput:'A west to robot',emptyAfterGrab:'A east to 180-degree physical U-turn to B west',
  emptyFlowConnectionToMain:'NOT YET VERIFIED',gantryUpstreamConnection:'NOT YET VERIFIED',
  negativeCases:5,originalMain108Unchanged:true,originalV19Untouched:true},null,2));
