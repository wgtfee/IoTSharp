// Studio V2 Draft r11 -> isolated r12 candidate. Read-only SQL snapshot input.
// User correction: REMOVE the combined double conveyor; its FORMER LOWER lane
// is now an independent blue loaded line, with a NEW independent red empty
// return line farther below it, westbound to the existing downward return.
'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=path.resolve(process.argv[2]||path.join(root,'.tmp-studio-v2-r11-db-readback.json'));
const target=path.resolve(process.argv[3]||path.join(root,'.tmp-studio-v2-cache-independent-r12-candidate.json'));
assert(source!==target&&!fs.existsSync(target),'Do not overwrite reviewed or existing files');
const raw=fs.readFileSync(source,'utf8');
assert.equal(crypto.createHash('sha256').update(raw,'utf16le').digest('hex').toUpperCase(),
  '6C14270B559563EFB590EC971D08B506E3A83CD7A0E06FD7449894BBE59CA81C',
  'Actual r11 snapshot mismatch; refuse migration');
const m=JSON.parse(raw);
assert.equal(m.sceneId.toLowerCase(),'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94');
assert.equal(m.objects.length,57);assert.equal(m.connections.length,53);assert.equal(m.routes.length,5);
const obj=id=>{const o=m.objects.find(x=>x.objectId===id);assert(o,id);return o};
const branch=m.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
const main=m.routes.find(r=>r.routeId==='component-route-d045206d');
assert(branch && branch.points.length===7 && branch.edges.length===6);
assert(main && main.points.length===42 && main.edges.length===46);
const immutableMain=JSON.stringify(main);
const oldDouble=obj('studio-v2-surplus-silk-handoff-roller');
assert.equal(oldDouble.component.componentType,'double-small-roller-conveyor');
assert.deepEqual(oldDouble.transform.position,[-7,0,-7.2]);
assert.equal(oldDouble.component.properties.length,11.4);
const straight=obj('studio-v2-bag-a-outfeed-roller');
assert.equal(straight.component.componentType,'roller-conveyor');
const blueId=oldDouble.objectId, redId='studio-v2-surplus-silk-empty-return-roller';
assert(!m.objects.some(o=>o.objectId===redId));
// Its former lower lane B (world z=-6.25) becomes the single BLUE line.
// The red return is a genuinely separate conveyor 1.9m farther down (z=-4.35).
const base=structuredClone(straight);
const props={
  length:11.4,width:1.55,height:.9,rollerDiameter:.14,rollerPitch:.55,
  frameHeight:.16,frameThickness:.1,supportSpacing:2,conveyorSizeClass:'small',
  transportUnitType:'plastic-pallet',capacity:3,speedLimit:.7,occupancyMode:'simulation',
  componentOwnedRoute:false,physicalHandoffRequired:true,referenceDrawingLine:true,
};
const assign=(o,id,name,z,rotation,role)=>{
  o.objectId=id;o.name=name;
  o.resourceId=straight.resourceId;
  o.transform={position:[-7,0,z],rotation:[0,rotation,0],scale:[1,1,1]};
  o.component.resourceKey=straight.component.resourceKey;
  o.component.componentType='roller-conveyor';
  o.component.generator='roller-conveyor-v1';
  o.component.generatorVersion=1;
  o.component.properties={...props};
  o.component.sectionId=role;
  return o;
};
assign(oldDouble,blueId,'蓝色载丝单排小辊道 · 原双排下排 · 向右',-6.25,0,'studio-v2-surplus-loaded-blue');
oldDouble.component.properties.robotPickupLocalX=3;
oldDouble.component.properties.loadedLaneRole='blue-eastbound-former-lower-lane';
oldDouble.component.properties.surplusSilkHandoff=true;
const red=assign(base,redId,'红色独立空小托盘回流辊道 · 蓝线更下方 · 向左',-4.35,
  Math.PI,'studio-v2-surplus-empty-red-return');
red.component.properties.emptyPalletOnly=true;
red.component.properties.emptyLaneRole='red-westbound-below-blue';
red.component.properties.surplusSilkEmptyReturn=true;
m.objects.push(red);
// Existing physical U-turn must align to blue z=-6.25 / red z=-4.35;
// its geometric center moves 1.9 metres toward the lower side.
const turn=obj('studio-v2-cache-pallet-empty-u-turn');
assert.deepEqual(turn.transform.position,[-1.3,0,-7.2]);
assert.equal(turn.component.properties.radius,.95);
turn.transform.position=[-1.3,0,-5.3];
turn.name='蓝线载丝托盘取丝后右端实体 U 型折返至更下方红色空托线';
const left=obj('reference-double-small-upper-left');
assert.deepEqual(left.transform.position,[-13.65,0,-3.75]);
const tap=left.component.properties.routeTaps.find(x=>x.tapId==='cache-empty-lower-return');
assert(tap&&tap.lane==='A'&&tap.localX===-2.5);
tap.localX=-.6; // maps to world z=-4.35, NOT old blue z=-6.25
tap.purpose='red-empty-below-blue-to-downstream';
const positions={
  'surplus-a-west':[-12.7,.9,-6.25],
  'surplus-a-robot':[-4,.9,-6.25],
  'surplus-a-east':[-1.3,.9,-6.25],
  'surplus-b-east':[-1.3,.9,-4.35],
  'surplus-b-robot':[-4,.9,-4.35],
  'surplus-b-west':[-12.7,.9,-4.35],
  'surplus-empty-downstream-main':[-12.7,.9,9],
};
for(const p of branch.points){
  assert(positions[p.pointId],'Unexpected branch point '+p.pointId);
  p.position=positions[p.pointId];
}
branch.name='原双排下排改蓝色载丝单线向右 → 机器人抓丝 → 单独下方红色空托线向左回流';
branch.transportUnitResourceKey='builtin-small-pallet';
for(const e of branch.edges){
  if(e.edgeId.startsWith('surplus-b-'))e.componentObjectId=redId;
  e.name=e.edgeId.startsWith('surplus-a-')?'蓝色单排载丝小托盘向右':e.edgeId.startsWith('surplus-b-')?'红色独立下方空托回流向左':e.name;
}
const c1=m.connections.find(c=>c.connectionId==='studio-v2-cache-loaded-east-to-empty-u-input');
const c2=m.connections.find(c=>c.connectionId==='studio-v2-cache-u-output-to-empty-return-b');
const c3=m.connections.find(c=>c.connectionId==='studio-v2-cache-red-lower-empty-return-to-left-downward-lane');
assert(c1 && c2 && c3);
assert(c1.from.objectId===blueId && c1.from.portId==='a-output');
assert(c2.to.objectId===blueId && c2.to.portId==='b-input');
assert(c3.from.objectId===blueId && c3.from.portId==='b-output');
c1.from.portId='output'; // blue east end
c2.to={objectId:redId,portId:'input'}; // red east input, facing west
c3.from={objectId:redId,portId:'output'}; // red west output
assert.equal(m.objects.length,58);
assert.equal(m.connections.length,53);
assert.equal(m.routes.length,5);
assert.equal(JSON.stringify(main),immutableMain,'108 main-pallet route changed');
assert.equal(m.runtime.routePalletInitializers.find(i=>i.routeId===main.routeId).simulationDefaultCount,108);
fs.writeFileSync(target,JSON.stringify(m,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,sourceHashVerified:true,objects:58,connections:53,
  deletedWrongDouble:true,blue:{componentType:oldDouble.component.componentType,
    formerLowerZ:-6.25,flow:'west to east'},red:{componentType:red.component.componentType,
    newLowerZ:-4.35,flow:'east to west'},leftTapLocalX:-.6,
  turnCenter:[-1.3,-5.3],main108Unchanged:true,mainLoopHandoff:'NOT VERIFIED',
  output:target},null,2));
