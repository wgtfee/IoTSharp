'use strict';
// Patch the Studio V2 clone only. Source is a read-only SQL export; this script never writes SQL.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || path.join(root,'.tmp-studio-v2-surplus-layout-r6-live.json'));
const output = path.resolve(process.argv[3] || path.join(root,'.tmp-studio-v2-blue-arrows-r7-candidate.json'));
if (input === output || fs.existsSync(output)) throw Error('Refusing to overwrite input or an existing candidate');
const scene = JSON.parse(fs.readFileSync(input,'utf8'));
assert.equal(scene.sceneId.toLowerCase(),'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94','Only Studio V2 clone may change');
assert.equal(scene.objects.length,52,'Expected latest Studio V2 r6 before physical route migration');
assert.equal(scene.connections.length,47);
const route = scene.routes.find(r=>r.routeId==='component-route-d045206d');
assert(route && route.loop && route.points.length===38 && route.edges.length===42);
const byId=id=>{const result=scene.objects.find(o=>o.objectId===id);assert(result,'Missing component '+id);return result};
const mainPoint=id=>{const result=route.points.find(p=>p.pointId===id);assert(result,'Missing point '+id);return result};
const edge=id=>{const result=route.edges.find(e=>e.edgeId===id);assert(result,'Missing edge '+id);return result};
const same=(a,b)=>assert(Math.abs(a-b)<1e-8,`Unexpected physical coordinate ${a} vs ${b}`);
const exemplar=byId('reference-conveyor-ref-edge-bag-a-right-in');
const rightDouble=byId('reference-double-small-upper-right');
// Bag A joins the descending B lane midway at z=-12.9, not at the lane's
// far-away start at z=-17.7. Connect to its real mid-span material port.
assert.deepEqual(rightDouble.component.properties.routeTaps,[]);
rightDouble.component.properties.routeTaps=[{
  tapId:'bag-a-outfeed',lane:'B',localX:1.4,terminal:false,
  side:'positive',localDirection:[0,0,1],
}];
const connectivity=[];
for(const spec of [
  {lane:'a',bagId:'reference-bagging-a',bagPoint:'ref-bag-a',
    upstream:'ref-bag-a-right',downstream:'ref-a-bag-left',upstreamComp:'reference-conveyor-ref-edge-bag-a-right-in',
    downComp:'reference-double-small-upper-right',downPort:'b-bag-a-outfeed',inEdge:'ref-edge-bag-a',outEdge:'ref-edge-bag-a-out',
    machineX:15,entryX:20,downstreamX:6.8,z:-12.9},
  {lane:'b',bagId:'reference-bagging-b',bagPoint:'ref-bag-b',
    upstream:'ref-bag-b-right',downstream:'ref-b-bag-left',upstreamComp:'reference-conveyor-ref-edge-diverter-b',
    downComp:'reference-bag-merger',downPort:'input-a',inEdge:'ref-edge-bag-b',outEdge:'ref-edge-bag-b-out',
    machineX:14.5,entryX:20,downstreamX:6.8,z:-5.5},
]){
  const bag=byId(spec.bagId);
  same(bag.transform.position[0],spec.machineX);same(bag.transform.position[2],spec.z);
  same(bag.transform.rotation[1],0);
  const length=bag.component.properties.length;
  same(length,6.4);
  // Bagging process flows physically RIGHT -> LEFT. The component's local input
  // sits at -length/2 and output at +length/2; rotate Y=PI to align ports.
  bag.transform.rotation[1]=Math.PI;
  const physicalInputX=spec.machineX+length/2, physicalOutputX=spec.machineX-length/2;
  same(mainPoint(spec.upstream).position[0],spec.entryX);
  same(mainPoint(spec.downstream).position[0],spec.downstreamX);
  const inId=`studio-v2-bag-${spec.lane}-infeed-roller`;
  const outId=`studio-v2-bag-${spec.lane}-outfeed-roller`;
  const inLength=spec.entryX-physicalInputX, outLength=physicalOutputX-spec.downstreamX;
  assert(inLength>0.3 && outLength>0.3,'Cannot bridge nonpositive physical gap');
  for(const [id,name,xA,xB,transportEdge] of [
    [inId,`套袋 ${spec.lane.toUpperCase()} 入机衔接辊道（向左）`,physicalInputX,spec.entryX,`ref-edge-bag-${spec.lane}-infeed-roller`],
    [outId,`套袋 ${spec.lane.toUpperCase()} 出机衔接辊道（向左）`,spec.downstreamX,physicalOutputX,spec.outEdge],
  ]){
    const candidate=JSON.parse(JSON.stringify(exemplar));
    candidate.objectId=id;candidate.name=name;
    candidate.transform.position=[(xA+xB)/2,0,spec.z];
    candidate.transform.rotation=[0,Math.PI,0];
    candidate.component.properties.length=xB-xA;
    candidate.component.properties.capacity=3;
    candidate.component.properties.openTransferSides=true;
    candidate.component.properties.componentOwnedRoute=false;
    candidate.component.properties.referenceDrawingLine=true;
    candidate.component.properties.physicalHandoffRequired=true;
    candidate.component.sectionId=`studio-v2-bag-${spec.lane}-${id===inId?'infeed':'outfeed'}`;
    delete candidate.component.routeEdgeId;
    scene.objects.push(candidate);
  }
  const intakePoint=`studio-v2-bag-${spec.lane}-physical-input`;
  const outtakePoint=`studio-v2-bag-${spec.lane}-physical-output`;
  for(const [pointId,x,label] of [
    [intakePoint,physicalInputX,'入口'],
    [outtakePoint,physicalOutputX,'出口'],
  ]) route.points.push({pointId,name:`套袋 ${spec.lane.toUpperCase()} 设备物理${label}`,kind:'buffer',
    position:[x,0.9,spec.z],authoring:{mode:'manual',generatedKey:pointId,locked:false,convertedFromGenerated:true}});
  const incoming=edge(spec.inEdge),outgoing=edge(spec.outEdge);
  assert.equal(incoming.fromPointId,spec.upstream);assert.equal(incoming.toPointId,spec.bagPoint);
  assert.equal(outgoing.fromPointId,spec.bagPoint);assert.equal(outgoing.toPointId,spec.downstream);
  incoming.toPointId=intakePoint;
  incoming.componentObjectId=inId;
  incoming.name=`套袋 ${spec.lane.toUpperCase()} 入口衔接辊道`;
  outgoing.fromPointId=outtakePoint;
  outgoing.componentObjectId=outId;
  outgoing.name=`套袋 ${spec.lane.toUpperCase()} 出口衔接辊道`;
  for(const [newId,from,to,componentId,name] of [
    [`ref-edge-bag-${spec.lane}-in-machine`,intakePoint,spec.bagPoint,spec.bagId,`套袋 ${spec.lane.toUpperCase()} 内部入口至工位`],
    [`ref-edge-bag-${spec.lane}-out-machine`,spec.bagPoint,outtakePoint,spec.bagId,`套袋 ${spec.lane.toUpperCase()} 工位至内部出口`],
  ]){
    const e=JSON.parse(JSON.stringify(incoming));
    e.edgeId=newId;e.fromPointId=from;e.toPointId=to;e.componentObjectId=componentId;
    e.name=name;e.authoring.generatedKey=newId;
    route.edges.push(e);
  }
  // Rewire visual engineering ports instead of leaving a fake direct handoff.
  const oldInput=scene.connections.find(c=>c.from.objectId===spec.upstreamComp && c.to.objectId===spec.bagId);
  const oldOutput=scene.connections.find(c=>c.from.objectId===spec.bagId && c.to.objectId===spec.downComp);
  assert(oldInput && oldOutput,'Missing original bagging connector');
  assert.equal(oldInput.to.portId,'input');assert.equal(oldOutput.from.portId,'output');
  scene.connections=scene.connections.filter(c=>c!==oldInput && c!==oldOutput);
  const link=(fromId,fromPort,toId,toPort)=>({
    connectionId:`studio-v2-r7-physical-${fromId}-${fromPort}-${toId}-${toPort}`,
    from:{objectId:fromId,portId:fromPort},to:{objectId:toId,portId:toPort},
    autoGenerated:false,metadata:{topologyBridge:true,source:'studio-v2-r7-verified-physical-handoff'},
  });
  scene.connections.push(
    link(spec.upstreamComp,oldInput.from.portId,inId,'input'),
    link(inId,'output',spec.bagId,'input'),
    link(spec.bagId,'output',outId,'input'),
    link(outId,'output',spec.downComp,spec.downPort),
  );
  connectivity.push({lane:spec.lane,physicalInputX,physicalOutputX,infeedMeters:inLength,outfeedMeters:outLength});
}
// Blue arrows are canonical; both must remain directed along the real conveyor.
assert.equal(edge('ref-edge-loaded-upper-right-in').fromPointId,'ref-loaded-inner-up');
assert.equal(edge('ref-edge-loaded-upper-right-in').toPointId,'ref-loaded-upper-right-in');
assert.equal(edge('ref-edge-loaded-upper-right').fromPointId,'ref-loaded-upper-right-in');
assert.equal(edge('ref-edge-loaded-upper-right').toPointId,'ref-loaded-upper-right-out');
const upperRight=byId('reference-double-small-upper-right');
assert.equal(upperRight.component.properties.laneAReverse,false);
assert.equal(upperRight.component.properties.laneBReverse,true);
assert.equal(scene.objects.length,56);
assert.equal(scene.connections.length,51);
assert.equal(route.points.length,42);
assert.equal(route.edges.length,46);
fs.writeFileSync(output,JSON.stringify(scene,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({passed:true,input,output,sceneId:scene.sceneId,objects:scene.objects.length,
  connections:scene.connections.length,mainPoints:route.points.length,mainEdges:route.edges.length,
  blueArrowRightward:true,blueArrowUpward:true,physicalConveyorsAdded:4,connectivity},null,2));
