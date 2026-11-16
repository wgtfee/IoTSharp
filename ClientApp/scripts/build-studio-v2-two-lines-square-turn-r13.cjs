// Correct the third-overlapping-conveyor defect in Studio V2 Draft r12.
// The existing loaded conveyor is already part of the 108-pallet main loop.
// Never duplicate it. Leave Published V19 and the 108-pallet route unchanged.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=path.resolve(process.argv[2]||path.join(root,'.tmp-studio-v2-r12-db-readback.json'));
const output=path.resolve(process.argv[3]||path.join(root,'.tmp-studio-v2-two-lines-square-turn-r13-candidate.json'));
assert(source!==output&&!fs.existsSync(output),'Refusing to overwrite an existing file');
const raw=fs.readFileSync(source,'utf8');
assert.equal(crypto.createHash('sha256').update(raw,'utf16le').digest('hex').toUpperCase(),
 'B058A208D296082A6AEE6E6595DBBA01C2001C7D6209CA707A892B44C044D990');
const m=JSON.parse(raw);
assert.equal(m.sceneId.toLowerCase(),'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94');
assert.equal(m.objects.length,58);
const obj=id=>{const o=m.objects.find(x=>x.objectId===id);assert(o,id);return o};
const original='reference-conveyor-ref-edge-loaded-upper-right-in';
const duplicate='studio-v2-surplus-silk-handoff-roller';
const redId='studio-v2-surplus-silk-empty-return-roller';
const turnId='studio-v2-cache-pallet-empty-u-turn';
const leftId='reference-double-small-upper-left';
const main=m.routes.find(x=>x.routeId==='component-route-d045206d');
const branch=m.routes.find(x=>x.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
assert(main?.points.length===42&&main.edges.length===46);
const mainSnapshot=JSON.stringify(main),mainPropsSnapshot=JSON.stringify(obj(original));
const blue=obj(original),repeat=obj(duplicate),red=obj(redId),turn=obj(turnId),left=obj(leftId);
assert.equal(blue.component.componentType,'roller-conveyor');
assert.deepEqual(blue.transform.position,[-2.95,0,-5.3]);
assert(Math.abs(blue.component.properties.length-15.7)<1e-8);
assert.equal(repeat.component.componentType,'roller-conveyor');
assert.deepEqual(repeat.transform.position,[-7,0,-6.25]);
assert.deepEqual(red.transform.position,[-7,0,-4.35]);
assert.equal(turn.component.componentType,'turn-conveyor-90');
// Original loaded blue runs east across x[-10.8,+4.9] at z=-5.3 and
// retains original geometry and main output; add only one isolated cache
// branch port so that the original main output never gets stolen.
m.objects=m.objects.filter(o=>o.objectId!==duplicate);
blue.component.properties.cacheBranchOutput=true;
// The only added horizontal conveyor is the red empty return, at least
// 1.9m below original blue; extend to the left vertical return x=-12.7.
red.transform={position:[-3.9,0,-3.4],rotation:[0,Math.PI,0],scale:[1,1,1]};
red.name='机器人下方第二条（红）：空小托盘向左独立回流辊道';
red.component.properties.length=17.6;
red.component.properties.emptyLaneRole='red-westbound-below-existing-blue';
red.component.properties.emptyPalletOnly=true;
// Replace rounded semicircle component with a physically straight, square
// cross-transfer conveyor. The two 90-degree corners exist at both endpoints.
// A turntable/side transfer must grant occupancy before physically branching
// off the still-live main route: do not simulate a production handoff.
const rollerTemplate=obj('studio-v2-bag-a-outfeed-roller');
turn.resourceId=rollerTemplate.resourceId;
turn.name='右端两个 90° 直角移载 + 中间垂直短小辊道（无圆弧）';
turn.transform={position:[4.9,0,-4.35],rotation:[0,-Math.PI/2,0],scale:[1,1,1]};
turn.component={
  resourceKey:'builtin-small-roller-conveyor',
  componentType:'roller-conveyor',generator:'roller-conveyor-v1',generatorVersion:1,
  properties:{length:1.9,width:1.55,height:.9,rollerDiameter:.14,
    rollerPitch:.4,frameHeight:.16,frameThickness:.1,supportSpacing:1.1,
    conveyorSizeClass:'small',transportUnitType:'plastic-pallet',capacity:1,
    speedLimit:.7,occupancyMode:'simulation',componentOwnedRoute:false,
    emptyPalletOnly:true,openTransferSides:true,physicalHandoffRequired:true,
    squareRightAngleTransfer:true,
    cornerGeometry:'two-square-90-degree-transfers',rounded:false,
    requiresMainLoopOccupancyGrant:true},
  sectionId:'studio-v2-cache-right-square-corner',
};
// Red enters from east, exits west; the x=4.9 cross transfer runs south
// (world z increases) between existing blue z=-5.3 and red z=-3.4.
const tap=left.component.properties.routeTaps.find(t=>t.tapId==='cache-empty-lower-return');
assert(tap);tap.localX=.35;tap.purpose='red-empty-below-existing-blue-to-downstream';
const positions={
  'surplus-a-west':[-10.8,.9,-5.3],
  'surplus-a-robot':[-4,.9,-5.3],
  'surplus-a-east':[4.9,.9,-5.3],
  'surplus-b-east':[4.9,.9,-3.4],
  'surplus-b-robot':[-4,.9,-3.4],
  'surplus-b-west':[-12.7,.9,-3.4],
  'surplus-empty-downstream-main':[-12.7,.9,9],
};
for(const pt of branch.points){assert(positions[pt.pointId],pt.pointId);pt.position=positions[pt.pointId];}
branch.name='复用现有108主回路蓝色载丝线 → 右端两个90°直角 → 下方唯一红色空托回流';
for(const edge of branch.edges){
  if(edge.edgeId.startsWith('surplus-a-'))edge.componentObjectId=original;
  if(edge.edgeId==='surplus-empty-after-pick-u-turn'){
    edge.name='原蓝线右端90°转下 → 垂直直辊道 → 再90°转入红线';
    edge.componentObjectId=turnId;
    edge.squareCornerOnly=true;
    edge.rounded=false;
  }
}
const link=id=>{const c=m.connections.find(c=>c.connectionId===id);assert(c,id);return c;};
const c1=link('studio-v2-cache-loaded-east-to-empty-u-input');
const c2=link('studio-v2-cache-u-output-to-empty-return-b');
const c3=link('studio-v2-cache-red-lower-empty-return-to-left-downward-lane');
c1.from={objectId:original,portId:'cache-branch-output'};
c1.to={objectId:turnId,portId:'input'};
c1.metadata={...(c1.metadata||{}),requiresMainLoopOccupancyGrant:true,
  branchedFromExisting108Loop:true,simulationPreviewOnly:true};
c2.from={objectId:turnId,portId:'output'};
c2.to={objectId:redId,portId:'input'};
c3.from={objectId:redId,portId:'output'};
c3.to={objectId:leftId,portId:'a-cache-empty-lower-return'};
assert.equal(m.objects.length,57);
assert.equal(m.connections.length,53);
assert.equal(JSON.stringify(main),mainSnapshot,'Main 108 route was edited');
const blueWithoutAddedPort=structuredClone(obj(original));
delete blueWithoutAddedPort.component.properties.cacheBranchOutput;
assert.equal(JSON.stringify(blueWithoutAddedPort),mainPropsSnapshot,
  'Original main conveyor geometry or existing operational properties changed');
assert.equal(m.runtime.routePalletInitializers.find(i=>i.routeId===main.routeId).simulationDefaultCount,108);
fs.writeFileSync(output,JSON.stringify(m,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,objects:57,
  originalBlueObject:original,originalBlueMainLoopUntouched:true,
  deletedDuplicateObject:duplicate,
  horizontalCountAroundRobot:2,
  blueZ:-5.3,redZ:-3.4,verticalSquareConnectorX:4.9,
  physicalRoundedTurnRemoved:true,
  main108PalletsUntouched:true,
  productionHandoff:'NOT VERIFIED',
  output},null,2));
