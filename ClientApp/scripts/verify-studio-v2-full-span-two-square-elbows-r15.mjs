// Negative regressions against the real SQL r14 source + r15 candidate.
// node --experimental-strip-types scripts/verify-studio-v2-full-span-two-square-elbows-r15.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes as guard} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const previous=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-r14-db-readback.json',import.meta.url),'utf8'));
const next=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-full-span-square-elbows-r15-candidate.json',import.meta.url),'utf8'));
const id=(m,k)=>m.objects.find(o=>o.objectId===k);
const mid='component-route-d045206d';
const localid='studio-v2-surplus-silk-bidirectional-handoff';
const full='reference-conveyor-ref-empty-return-merge';
const right='reference-conveyor-ref-empty-return-down';
const left='reference-conveyor-ref-return-edge-outer-down';
const merge='reference-gantry-merger';
assert(guard(previous).some(e=>e.includes('两次90度直角')));
assert.deepEqual(guard(next),[]);
assert.deepEqual(next.routes.find(r=>r.routeId===mid),previous.routes.find(r=>r.routeId===mid));
assert.deepEqual(next.routes.find(r=>r.routeId===localid),previous.routes.find(r=>r.routeId===localid));
assert.equal(next.runtime.routePalletInitializers.find(i=>i.routeId===mid).simulationDefaultCount,108);
assert.equal(next.objects.length,previous.objects.length);
assert.equal(next.connections.length,previous.connections.length+1);
assert.equal(id(next,full).component.properties.fullSpanTwoSquareElbows,true);
assert.equal(id(next,full).component.properties.squareCornerSequence,'right-down-west-left-down');
assert.equal(id(next,merge).component.properties.emptyReturnSquareThirdInput,true);
assert.equal(id(next,full).component.properties.length,25.4);
assert.equal(id(next,right).component.properties.length,2.2);
assert(Math.abs(id(next,left).component.properties.length-6.2)<1e-8);
assert(next.connections.some(c=>c.from.objectId===right&&c.from.portId==='output'
  &&c.to.objectId===full&&c.to.portId==='square-right-input'));
assert(next.connections.some(c=>c.from.objectId===full&&c.from.portId==='output'
  &&c.to.objectId===merge&&c.to.portId==='empty-return-square-input'));
const blue=id(next,'reference-conveyor-ref-edge-loaded-upper-right-in');
const red=id(next,'studio-v2-surplus-silk-empty-return-roller');
assert(Math.abs(red.component.properties.length/blue.component.properties.length-.5)<1e-9);
assert(!id(next,'studio-v2-surplus-silk-handoff-roller'));

const negatives=[
 ['right physical 90 removed',m=>m.connections=m.connections.filter(c=>c.from.objectId!==right||c.to.objectId!==full),'实体端口连接'],
 ['right still plugged into straight input',m=>{
   m.connections.find(c=>c.from.objectId===right&&c.to.objectId===full).to.portId='input';
 },'实体端口连接'],
 ['left physical 90 removed',m=>m.connections=m.connections.filter(c=>c.from.objectId!==full||c.to.objectId!==merge),'实体端口连接'],
 ['left port is wrong',m=>{
   m.connections.find(c=>c.from.objectId===full&&c.to.objectId===merge).to.portId='input-a';
 },'实体端口连接'],
 ['two corner markers disabled',m=>id(m,full).component.properties.fullSpanTwoSquareElbows=false,'两次90度直角'],
 ['square left merger missing',m=>id(m,merge).component.properties.emptyReturnSquareThirdInput=false,'两次90度直角'],
 ['right corner displaced',m=>id(m,right).transform.position[0]=11.7,'两次90度直角'],
 ['left corner displaced',m=>id(m,left).transform.position[2]=11.2,'两次90度直角'],
 ['long span shifted',m=>id(m,full).transform.position[2]=7.4,'两次90度直角'],
 ['long span rotated wrong',m=>id(m,full).transform.rotation[1]=0,'两次90度直角'],
 ['right route arrow reversed',m=>{
   const e=m.routes.find(r=>r.routeId===mid).edges.find(e=>e.edgeId==='ref-empty-return-down');
   [e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId];
 },'路线'],
 ['cross-floor route arrow reversed',m=>{
   const e=m.routes.find(r=>r.routeId===mid).edges.find(e=>e.edgeId==='ref-empty-return-merge');
   [e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId];
 },'路线'],
 ['left downstream arrow reversed',m=>{
   const e=m.routes.find(r=>r.routeId===mid).edges.find(e=>e.edgeId==='ref-return-edge-outer-down');
   [e.fromPointId,e.toPointId]=[e.toPointId,e.fromPointId];
 },'路线'],
 ['right corner made rounded',m=>id(m,full).component.properties.squareCornerSequence='right-rounded-u-left-down','两次90度直角'],
];
for(const [name,mutate,message] of negatives){
 const broken=structuredClone(next);
 mutate(broken);
 assert(guard(broken).some(e=>e.includes(message)),'Regression not rejected: '+name);
}
console.log(JSON.stringify({passed:true,oldR14MissingTwoCornersRejected:true,
  r15PhysicalRouteErrors:0,realFullReturn:{rightDown:[10.8,6.8,9],
    westAcross:[10.8,-14.6,9],leftDown:[-14.6,9,15.2],squareCorners:2},
  localRedHalfLengthPreserved:true,
  negativeCases:negatives.length,mainRoute108Unchanged:true,
  full108MultiLapAndSharedOccupancy:'NOT_VERIFIED'},null,2));
