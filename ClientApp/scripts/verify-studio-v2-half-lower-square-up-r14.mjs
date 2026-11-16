// Test actual SQL r13 readback vs r14 candidate, including rejected regressions.
// Run: node --experimental-strip-types scripts/verify-studio-v2-half-lower-square-up-r14.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes as guard} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';

const old=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r13-db-readback.json',import.meta.url),'utf8'));
const next=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-half-lower-square-up-r14-candidate.json',import.meta.url),'utf8'));
const byId=(m,id)=>m.objects.find(o=>o.objectId===id);
const mainId='component-route-d045206d';
const blueId='reference-conveyor-ref-edge-loaded-upper-right-in';
const redId='studio-v2-surplus-silk-empty-return-roller';
const leftUpId='studio-v2-cache-empty-left-square-up';
const branchId='studio-v2-surplus-silk-bidirectional-handoff';
const blue=byId(next,blueId),red=byId(next,redId),leftUp=byId(next,leftUpId);
assert(guard(old).some(e=>e.includes('一半长')));
assert.deepEqual(guard(next),[]);
assert.equal(next.objects.length,58);
assert.equal(next.connections.length,54);
assert.equal(blue.component.properties.cacheReturnEntry,true);
assert.equal(red.component.properties.halfOfBlue,true);
assert(Math.abs(red.component.properties.length-blue.component.properties.length/2)<1e-8);
assert(Math.abs(red.component.properties.length-7.85)<1e-8);
assert(Math.abs(red.transform.position[0]-.975)<1e-8);
assert.equal(red.transform.position[2],-3.4);
assert.deepEqual(leftUp.transform.position,[-2.95,0,-4.35]);
assert(Math.abs(leftUp.transform.rotation[1]-Math.PI/2)<1e-8);
assert.equal(leftUp.component.properties.squareRightAngleTransfer,true);
assert.equal(leftUp.component.properties.rounded,false);
assert(!next.connections.some(c=>c.connectionId==='studio-v2-cache-red-lower-empty-return-to-left-downward-lane'));
assert(next.connections.some(c=>c.from.objectId===redId&&c.to.objectId===leftUpId));
assert(next.connections.some(c=>c.from.objectId===leftUpId&&c.to.objectId===blueId&&c.to.portId==='cache-return-entry'));
assert.deepEqual(next.routes.find(r=>r.routeId===mainId),old.routes.find(r=>r.routeId===mainId));
assert.equal(next.runtime.routePalletInitializers.find(i=>i.routeId===mainId).simulationDefaultCount,108);
const branch=next.routes.find(r=>r.routeId===branchId);
assert.deepEqual(branch.points.find(p=>p.pointId==='surplus-b-west').position,[-2.95,.9,-3.4]);
assert.deepEqual(branch.points.find(p=>p.pointId==='surplus-empty-downstream-main').position,[-2.95,.9,-5.3]);
assert.equal(branch.edges.find(e=>e.edgeId==='surplus-empty-return-left-square-up').componentObjectId,leftUpId);
const negative=[
 ['red length accidentally restored full length',m=>byId(m,redId).component.properties.length=17.6,'一半长'],
 ['red shortened to less than half',m=>byId(m,redId).component.properties.length=6.5,'一半长'],
 ['red shifted left',m=>byId(m,redId).transform.position[0]=-1,'一半长'],
 ['red shifted above blue',m=>byId(m,redId).transform.position[2]=-7.2,'一半长'],
 ['red reverse direction',m=>byId(m,redId).transform.rotation[1]=0,'一半长'],
 ['missing left upward vertical',m=>m.objects=m.objects.filter(o=>o.objectId!==leftUpId),'90度直角向上'],
 ['left vertical rounded',m=>byId(m,leftUpId).component.properties.rounded=true,'90度直角向上'],
 ['left square turn mis-rotated',m=>byId(m,leftUpId).transform.rotation[1]=-Math.PI/2,'90度直角向上'],
 ['left join disconnected',m=>m.connections=m.connections.filter(c=>c.connectionId!=='studio-v2-cache-left-square-up-to-main-blue'),'90度直角向上'],
 ['old long return reconnected',m=>m.connections.push({connectionId:'studio-v2-cache-red-lower-empty-return-to-left-downward-lane',
   from:{objectId:redId,portId:'output'},to:{objectId:'reference-double-small-upper-left',portId:'a-cache-empty-lower-return'}}),'90度直角向上'],
 ['red misses blue midspan',m=>m.routes.find(r=>r.routeId===branchId).points.find(p=>p.pointId==='surplus-empty-downstream-main').position[0]=-12.7,'脱离蓝/红'],
 ['old third conveyor reinstated',m=>m.objects.push({objectId:'studio-v2-surplus-silk-handoff-roller',kind:'component',
   component:{componentType:'roller-conveyor',properties:{}},transform:{position:[-7,0,-6.25],rotation:[0,0,0]}}),'第三条水平辊道'],
];
for(const [name,mutate,expectedMessage] of negative){
 const m=structuredClone(next); mutate(m);
 const errors=guard(m);
 assert(errors.some(e=>e.includes(expectedMessage)),'Missing regression detection: '+name);
}
console.log(JSON.stringify({passed:true,previousR13Rejected:true,correctedR14GuardErrors:0,
 blueLength:blue.component.properties.length,redLength:red.component.properties.length,
 halfRatio:red.component.properties.length/blue.component.properties.length,
 leftSquareVertical:true,oldLongLeftConnectionRemoved:true,
 negativeCases:negative.length,main108RouteUntouched:true,
 mainOccupancyHandoff:'NOT VERIFIED'},null,2));
