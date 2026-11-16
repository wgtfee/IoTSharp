// Read-only transformation of the exact SQL Server Studio V2 Draft r8.
// The Published V19 scene is never read for modification or written here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || path.join(root, '.tmp-studio-v2-r8-db-readback.json'));
const output = path.resolve(process.argv[3] || path.join(root, '.tmp-studio-v2-cache-double-r9-candidate.json'));
assert.notEqual(input, output);
assert(!fs.existsSync(output), 'Do not overwrite an existing candidate or SQL snapshot');
const source = fs.readFileSync(input, 'utf8');
assert.equal(crypto.createHash('sha256').update(source, 'utf16le').digest('hex').toUpperCase(),
  '40E6031C6B3D7F89ADE91510C5BA755384B0988251EDE7F4F453118B71C77339',
  'SQL r8 source has changed; refuse non-reviewed edits');
const manifest = JSON.parse(source);
assert.equal(manifest.sceneId.toLowerCase(), 'd7c2dfdf-39bf-4e69-a2c4-587cfaf63c94');
assert.equal(manifest.objects.length, 56);
assert.equal(manifest.routes.length, 5);
const handoffId = 'studio-v2-surplus-silk-handoff-roller';
const rack = manifest.objects.find(o => o.objectId === 'studio-v2-surplus-silk-arc-rack');
const handoff = manifest.objects.find(o => o.objectId === handoffId);
const doubleExample = manifest.objects.find(o => o.objectId === 'reference-double-small-middle');
assert(rack && handoff && doubleExample);
assert.equal(handoff.component.componentType, 'roller-conveyor', 'Already dual; refuse duplicate upgrade');
assert.deepEqual(handoff.transform.position, [-4, 0, -7.2]);
assert.deepEqual(handoff.transform.rotation, [0, 0, 0]);
assert.equal(handoff.component.properties.length, 5.4);
assert.equal(rack.component.properties.layers * rack.component.properties.columns, 100);

const route = manifest.routes.find(r => r.routeId === 'studio-v2-surplus-silk-bidirectional-handoff');
assert(route && route.points.length === 3 && route.edges.length === 2);
assert(route.edges.every(edge => edge.bidirectional === true && edge.componentObjectId === handoffId));

// Geometry: A nearest to the robot/rack (north) -> EAST; B on outside (south) -> WEST.
// This is exactly the two opposite arrows beneath the cache robot in the marked floor plan.
handoff.name = '余丝缓存机器人下方 · 双排独立小辊道（内排向右 / 外排向左）';
handoff.resourceId = doubleExample.resourceId;
handoff.component.resourceKey = doubleExample.component.resourceKey;
handoff.component.componentType = 'double-small-roller-conveyor';
handoff.component.generator = 'double-small-roller-conveyor-v1';
handoff.component.generatorVersion = 1;
handoff.component.properties = {
  length: 5.4, laneWidth: 1.55, laneSpacing: 1.9, height: 0.9,
  rollerDiameter: 0.14, rollerPitch: 0.55, frameHeight: 0.16,
  frameThickness: 0.1, supportSpacing: 2, capacityPerLane: 3, speedLimit: 0.7,
  conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet',
  occupancyMode: 'simulation', laneAReverse: false, laneBReverse: true,
  routeTaps: [], componentOwnedRoute: false,
  surplusSilkHandoff: true, engineeringOnly: true,
  physicalLanesIndependent: true,
  laneAUsage: 'rack-inbound', laneBUsage: 'rack-reuse-outbound',
};
handoff.component.sectionId = 'ref-surplus-cache-dual-handoff';

const xWest = -6.7, xRobot = -4, xEast = -1.3;
const y = 0.9, zA = -7.2 - 1.9/2, zB = -7.2 + 1.9/2;
route.name = '余丝缓存机器人双排交接：靠缓存架 A 排向右入库、外侧 B 排向左复用回流';
route.startPointId = 'surplus-a-west';
route.points = [
  {pointId:'surplus-a-west',name:'A 排左侧接入（向右）',kind:'buffer',position:[xWest,y,zA]},
  {pointId:'surplus-a-robot',name:'A 排机器人入缓存取料位',kind:'buffer',position:[xRobot,y,zA]},
  {pointId:'surplus-a-east',name:'A 排向右接出预留端',kind:'buffer',position:[xEast,y,zA]},
  {pointId:'surplus-b-east',name:'B 排右侧接入（向左）',kind:'buffer',position:[xEast,y,zB]},
  {pointId:'surplus-b-robot',name:'B 排机器人缓存复用放料位',kind:'buffer',position:[xRobot,y,zB]},
  {pointId:'surplus-b-west',name:'B 排向左回流预留端',kind:'buffer',position:[xWest,y,zB]},
];
const makeEdge = (edgeId, fromPointId, toPointId, lane, capacity) => ({
  edgeId, fromPointId, toPointId,
  name: `余丝交接 ${lane} 排 ${lane === 'A' ? '向右入库' : '向左复用'}`,
  bidirectional: false, enabled: true,
  capacity, speedLimit: 0.7, occupancyMode: 'simulation',
  reservationTimeoutSeconds: 30, conveyorSizeClass: 'small',
  transportUnitType: 'plastic-pallet', componentObjectId: handoffId,
  sectionId: `surplus-cache-lane-${lane.toLowerCase()}`,
  authoring:{mode:'manual',generatedKey:edgeId,locked:false,convertedFromGenerated:true},
});
route.edges = [
  makeEdge('surplus-a-west-to-robot','surplus-a-west','surplus-a-robot','A',1),
  makeEdge('surplus-a-robot-to-east','surplus-a-robot','surplus-a-east','A',1),
  makeEdge('surplus-b-east-to-robot','surplus-b-east','surplus-b-robot','B',1),
  makeEdge('surplus-b-robot-to-west','surplus-b-robot','surplus-b-west','B',1),
];

const primary = manifest.routes.find(r => r.routeId === 'component-route-d045206d');
assert(primary && primary.edges.length === 46 && primary.points.length === 42);
assert.equal(manifest.connections.length, 50);
assert.equal(manifest.runtime.routePalletInitializers.find(x => x.routeId === primary.routeId).simulationDefaultCount, 108);
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
console.log(JSON.stringify({
  passed:true,sceneId:manifest.sceneId,objects:manifest.objects.length,connections:manifest.connections.length,
  primaryEdges:primary.edges.length,dualHandoffEdges:4,dualHandoffPoints:6,
  laneA:{direction:'east',z:zA},laneB:{direction:'west',z:zB},
  roboticPickupLanes:'separate',sourceR8HashVerified:true,candidate:output,
},null,2));
