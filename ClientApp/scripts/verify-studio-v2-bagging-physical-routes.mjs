// Node 22+ --experimental-strip-types; test actual SQL r6 export and candidate r7.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectStudioV2PhysicalRoutes} from '../src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const original=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-surplus-layout-r6-live.json',import.meta.url),'utf8'));
const candidate=JSON.parse(fs.readFileSync(new URL('../.tmp-studio-v2-blue-arrows-r7-v2.json',import.meta.url),'utf8'));
const before=inspectStudioV2PhysicalRoutes(original);
assert(before.length>=2,'The old r6 with reversed bagging ports and missing physical rollers must NOT be allowed to run');
assert.equal(inspectStudioV2PhysicalRoutes(candidate).length,0);
const clone=()=>structuredClone(candidate);
const missingOut=clone();
missingOut.objects=missingOut.objects.filter(o=>o.objectId!=='studio-v2-bag-a-outfeed-roller');
assert(inspectStudioV2PhysicalRoutes(missingOut).some(e=>e.includes('没有实体辊道')),'Missing outgoing roller must block');
const wrongLength=clone();
wrongLength.objects.find(o=>o.objectId==='studio-v2-bag-b-outfeed-roller').component.properties.length=1;
assert(inspectStudioV2PhysicalRoutes(wrongLength).some(e=>e.includes('长度')),'Short roller must block');
const reverseArrow=clone();
const edge=reverseArrow.routes.find(r=>r.routeId==='component-route-d045206d').edges.find(e=>e.edgeId==='ref-edge-loaded-upper-right');
[edge.fromPointId,edge.toPointId]=[edge.toPointId,edge.fromPointId];
assert(inspectStudioV2PhysicalRoutes(reverseArrow).some(e=>e.includes('方向')),'Reversed blue arrow must block');
const reverseMachine=clone();
reverseMachine.objects.find(o=>o.objectId==='reference-bagging-a').transform.rotation[1]=0;
assert(inspectStudioV2PhysicalRoutes(reverseMachine).some(e=>e.includes('从右向左')),'Wrong bagging port must block');
assert.equal(candidate.objects.length,56);
assert.equal(candidate.connections.length,51);
assert.equal(candidate.routes.find(r=>r.routeId==='component-route-d045206d').edges.length,46);
console.log(JSON.stringify({passed:true,oldScenePhysicalViolations:before.length,
  candidatePhysicalViolations:0,missingRollerBlocked:true,shortRollerBlocked:true,
  blueArrowReverseBlocked:true,baggingPortReverseBlocked:true,objects:56,connections:51,mainRouteEdges:46},null,2));
