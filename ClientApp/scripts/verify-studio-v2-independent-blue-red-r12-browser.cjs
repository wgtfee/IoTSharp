// SQL r11-derived candidate r12; REAL Edge/Vite/Three.js and actual small pallet generator.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.STUDIO_V2_PLAYWRIGHT_PATH||path.join(os.homedir(),'.ccpulse/e2e/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
const candidate=path.resolve(process.env.STUDIO_V2_R12_MANIFEST||path.join(root,'.tmp-studio-v2-cache-independent-r12-candidate.json'));
const previous=path.join(root,'.tmp-studio-v2-r11-db-readback.json');
const output=path.resolve(process.env.STUDIO_V2_R12_OUTPUT||path.join(root,'.tmp-studio-v2-cache-independent-r12-edge'));
const fixture=path.join(root,'.studio-v2-cache-small-pallet-r12-e2e.html');
const upload=path.join(root,'public','__studio_v2_cache_small_pallet_r12.json');
const baseline=path.join(root,'public','__studio_v2_cache_small_pallet_r11.json');
const host=process.env.STUDIO_V2_BASE_URL||'http://127.0.0.1:5173';
assert(!fs.existsSync(fixture)&&!fs.existsSync(upload)&&!fs.existsSync(baseline),'Temporary path occupied');
fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(candidate,upload,fs.constants.COPYFILE_EXCL);
fs.copyFileSync(previous,baseline,fs.constants.COPYFILE_EXCL);
const html=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>body{margin:0;background:#0b1424;color:#e6f4ff;font:14px Arial}#viewport{position:absolute;inset:0}#hud{position:absolute;left:18px;top:16px;max-width:430px;padding:16px;border-radius:12px;background:rgba(7,25,44,.93);pointer-events:none;border:1px solid #3677a2}h2{font-size:18px;margin:0 0 9px;color:#aee6ff}p{margin:8px 0}b{color:#72eccb}</style></head>
<body><div id="viewport"></div><div id="hud"><h2>STUDIO V2 · 两条独立小辊道，不是双排辊道</h2>
<p><b>蓝：原双排下面一条 → 改为独立载丝单辊道 → 向右</b></p>
<p><b>红：蓝线再下面新增加独立空托回流单辊道 → 向左</b></p>
<p>机器人抓丝后，小托盘 U 型折返，红线左端接向下的回流道</p>
<p id="status">SQL r12 候选加载中...</p><p id="carrier">小托盘等待中</p><p id="pallets">108 主闭环托盘保持原样</p>
<small>隔离 Simulation；左侧主回流线实体接驳已建，主线托盘接收联锁待验收</small></div>
<script type="module">
import {TwinRuntime} from '/src/digital-twin/runtime/TwinRuntime.ts';
import {inspectStudioManifest,createStudioRuntimeManifest} from '/src/views/iot/digital-twin/studio-v2/studioScene.ts';
import {inspectStudioV2PhysicalRoutes} from '/src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const errors=[];window.__r12={ready:false,errors};
try{
 const [manifest,oldManifest]=await Promise.all(['r12','r11'].map(async v=>{
   const response=await fetch('/iot/__studio_v2_cache_small_pallet_'+v+'.json',{cache:'no-store'});
   if(!response.ok)throw Error(v+' request '+response.status);
   return response.json();
 }));
 const oldViolations=inspectStudioV2PhysicalRoutes(oldManifest);
 const violations=inspectStudioV2PhysicalRoutes(manifest);
 const diagnostics=inspectStudioManifest(manifest);
 let oldRejection='';
 const oldRt=new TwinRuntime(document.createElement('div'),createStudioRuntimeManifest(oldManifest,'simulation'),
   {onError:e=>{oldRejection=String(e)}},{readOnly:true});
 oldRt.setRunning(true);const oldBlocked=!oldRt.runtimeRunning;oldRt.dispose();
 const rt=new TwinRuntime(document.getElementById('viewport'),createStudioRuntimeManifest(manifest,'simulation'),
   {onError:e=>errors.push(e)},{readOnly:true});
 rt.camera.position.set(-6,17,4);
 rt.orbitControls.target.set(-7,0,-7);
 rt.orbitControls.update();
 rt.setRunning(true);
 const turn=rt.componentModels.get('studio-v2-cache-pallet-empty-u-turn')?.root;
 const leftReturn=rt.componentModels.get('reference-double-small-upper-left')?.root;
 window.__r12={ready:true,errors,oldBlocked,oldRejection,oldViolations,violations,diagnostics,rt,
  turnPresent:Boolean(turn),physicalTurnRollers:Boolean(turn?.getObjectByName('Rollers')),
  leftReturnPort:Boolean(leftReturn),
  initialMain:rt.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d').map(p=>p.palletId).sort(),
 };
 function display(){
   const cache=rt.getMaterialFlowSnapshot().surplusSilkCache;
   const carrier=cache?.carrier;
   document.getElementById('status').innerHTML='实体 U 型折返与左侧接驳：'+(turn&&leftReturn?' <b>已实例化</b>':'缺失')+' / 缓存余丝 '+(cache?.occupied??0);
   document.getElementById('carrier').textContent='托盘：'+(carrier?.palletId||'无')+' / '+(carrier?.materialState||'无')+' / '+(carrier?.state||'无');
   document.getElementById('pallets').textContent='主闭环托盘：'+rt.routeSlotArrayRuntime.getDiagnostics().plasticPallets;
   requestAnimationFrame(display);
 }
 display();
}catch(error){errors.push(String(error));document.getElementById('status').textContent=String(error)}
</script></body></html>`;
fs.writeFileSync(fixture,html,'utf8');
const report={host,source:process.env.STUDIO_V2_R12_SOURCE_LABEL||'SQL Draft r11-derived r12 independent single roller candidate (not yet committed to SQL)',
  shots:[],events:[],errors:[]};
let browser,server;
const port=Number(new URL(host).port||5173);
const checkPort=()=>new Promise(resolve=>{
 const socket=net.connect(port,'127.0.0.1',()=>{socket.destroy();resolve(true)});
 socket.setTimeout(400);socket.on('timeout',()=>{socket.destroy();resolve(false)});
 socket.on('error',()=>resolve(false));
});
const ensureVite=async()=>{
 if(await checkPort())return;
 const logs=[];
 server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{
  cwd:root,windowsHide:true,env:{...process.env,VITE_PUBLIC_PATH:'/iot/',VITE_OPEN:'false',VITE_OPEN_CDN:'false'},
  stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',data=>logs.push(String(data)));
 server.stderr.on('data',data=>logs.push(String(data)));
 for(let i=0;i<100;i++){
  if(await checkPort())return;
  if(server.exitCode!==null)throw Error('Vite failed '+logs.join('').slice(-1200));
  await new Promise(resolve=>setTimeout(resolve,350));
 }
 throw Error('Vite not ready '+logs.join('').slice(-1200));
};
(async()=>{
 await ensureVite();
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1760,height:1040},deviceScaleFactor:1});
 page.setDefaultTimeout(75000);
 page.on('pageerror',e=>report.errors.push('pageerror '+e.message));
 page.on('response',r=>{if(r.status()>=400)report.errors.push('http '+r.status()+' '+r.url())});
 await page.goto(host+'/iot/.studio-v2-cache-small-pallet-r12-e2e.html',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__r12?.ready===true,{timeout:60000});
 const init=await page.evaluate(()=>{
  const a=window.__r12;
  return {oldBlocked:a.oldBlocked,oldViolations:a.oldViolations,violations:a.violations,
   errors:a.errors,turnPresent:a.turnPresent,physicalTurnRollers:a.physicalTurnRollers,
   structureErrors:a.diagnostics.filter(x=>x.severity==='error'),
   warnings:a.diagnostics.filter(x=>x.severity==='warning').length,
   running:a.rt.runtimeRunning,
   mainCount:a.initialMain.length,
  };
 });
 report.init=init;
 assert(init.oldBlocked,'Old r11 double integrated conveyor MUST fail before r12 independent blue/red lines');
 assert.equal(init.violations.length,0,JSON.stringify(init.violations));
 assert.equal(init.structureErrors.length,0,JSON.stringify(init.structureErrors));
 assert(init.running);
 assert(init.turnPresent && init.physicalTurnRollers);
 assert.equal(init.mainCount,108);
 const geometry=await page.evaluate(()=>{
   const rt=window.__r12.rt;
   const left=rt.componentModels.get('reference-double-small-upper-left')?.root;
   const double=rt.componentModels.get('studio-v2-surplus-silk-handoff-roller')?.root;
   const blue=rt.componentModels.get('studio-v2-surplus-silk-handoff-roller')?.root;
   const red=rt.componentModels.get('studio-v2-surplus-silk-empty-return-roller')?.root;
   return {
     leftTapPortConfigured:left?.userData.properties?.routeTaps?.some(x=>x.tapId==='cache-empty-lower-return'&&x.lane==='A'&&Math.abs(x.localX+.6)<.001),
     blueModel:Boolean(blue),redModel:Boolean(red),
     blueGenerator:blue?.userData.generator,redGenerator:red?.userData.generator,
     blueDoubleLanePresent:Boolean(blue?.getObjectByName('DoubleSmall-Lane-A')||blue?.getObjectByName('DoubleSmall-Lane-B')),
     blueCenter:blue?.position.toArray(),redCenter:red?.position.toArray(),
     blueLength:blue?.userData.properties?.length,redLength:red?.userData.properties?.length,
     blueZ:blue?.position.z,redZ:red?.position.z,
     blueYaw:blue?.rotation.y,redYaw:red?.rotation.y,
     blueFlow:'east',redFlow:'west',
     physicalConnections:rt.manifest.connections.filter(c=>c.connectionId==='studio-v2-cache-red-lower-empty-return-to-left-downward-lane').length
   };
 });
 report.geometry=geometry;
 assert(geometry.leftTapPortConfigured);
 assert(geometry.blueModel&&geometry.redModel,'Both independent conveyor meshes must exist');
 assert.equal(geometry.blueGenerator,'roller-conveyor-v1');
 assert.equal(geometry.redGenerator,'roller-conveyor-v1');
 assert.equal(geometry.blueDoubleLanePresent,false,'Wrong one-piece double conveyor still exists');
 assert.equal(geometry.blueLength,11.4);
 assert.equal(geometry.redLength,11.4);
 assert(Math.abs(geometry.blueZ+6.25)<.001);
 assert(Math.abs(geometry.redZ+4.35)<.001);
 assert(Math.abs(geometry.blueYaw)<.001);
 assert(Math.abs(Math.abs(geometry.redYaw)-Math.PI)<.001);
 assert.equal(geometry.physicalConnections,1);
 assert(Math.abs(geometry.redZ-geometry.blueZ-1.9)<.001,'Red separate conveyor must be below former lower blue lane');
 const shot1=path.join(output,'01-independent-blue-former-lower-and-red-new-lower-rollers.png');
 await page.screenshot({path:shot1,fullPage:true});report.shots.push(shot1);
 await page.evaluate(()=>window.__r12.rt.queueSurplusBobbin({
   bobbinId:'R12-EXAMPLE-BOBBIN',batchNo:'R12-BATCH',originalTaskNo:'R12-GANTRY-BATCH',
   carrierPalletId:'R12-ISOLATED-TEST-CARRIER',
 }));
 const before=await page.evaluate(()=>window.__r12.rt.getMaterialFlowSnapshot().surplusSilkCache);
 assert.equal(before.carrier.materialState,'loaded');
 assert.equal(before.carrier.state,'loaded-arrival');
 assert.equal(before.carrier.previewOnly,true,'This is a local preview carrier, not one of the adopted 108 RouteSlot entities');
 const palletGeometry=await page.evaluate(()=>{
   const c=window.__r12.rt.scene.getObjectByName('SurplusCarrier-R12-ISOLATED-TEST-CARRIER');
   return {exists:Boolean(c),variant:c?.userData.transportUnitVariant,
     resourceKey:c?.userData.componentResourceKey,
     type:c?.userData.transportUnitType,
     greenRoundBase:Boolean(c?.getObjectByName('SmallPallet-Base')),
     supportSeat:Boolean(c?.getObjectByName('SmallPallet-SupportSeat')),
     locatingPost:Boolean(c?.getObjectByName('SmallPallet-LocatingPost')),
     brownSquareDeck:Boolean(c?.getObjectByName('CacheCarrier-PhysicalPalletDeck')),
     carrierPosition:c?.position.toArray()};
 });
 report.palletGeometry=palletGeometry;
 assert(palletGeometry.exists&&palletGeometry.greenRoundBase&&palletGeometry.supportSeat&&palletGeometry.locatingPost);
 assert.equal(palletGeometry.variant,'small-pallet');
 assert.equal(palletGeometry.resourceKey,'builtin-small-pallet');
 assert.equal(palletGeometry.type,'plastic-pallet');
 assert.equal(palletGeometry.brownSquareDeck,false,'Old wooden-looking square deck must be absent');
 const shot2=path.join(output,'02-real-green-small-pallet-on-blue-independent-loaded-roller.png');
 await page.screenshot({path:shot2,fullPage:true});report.shots.push(shot2);
 await page.waitForFunction(()=>window.__r12.rt.getMaterialFlowSnapshot().surplusSilkCache.carrier?.state==='empty-return',{timeout:65000});
 const grabbed=await page.evaluate(()=>window.__r12.rt.getMaterialFlowSnapshot().surplusSilkCache);
 assert.equal(grabbed.carrier.materialState,'empty');
 report.events.push({state:'picked',carrier:grabbed.carrier});
 const shot3=path.join(output,'03-robot-removes-silk-pallet-empty-on-blue-independent.png');
 await page.screenshot({path:shot3,fullPage:true});report.shots.push(shot3);
 // Advance the authentic cache runtime at its fixed 30Hz logic step in-browser;
 // this is accelerated logic testing, not realtime throughput or hardware.
 const progress=await page.evaluate(()=>{
  const rt=window.__r12.rt;
  rt.setRunning(false);
  rt.surplusCache.setRunning(true);
  const trace=[];
  for(let i=0;i<1200;i++){
   rt.surplusCache.tick(1/30);
   if(i%12===0){
    const c=rt.getMaterialFlowSnapshot().surplusSilkCache.carrier;
    trace.push({step:i,state:c?.state,material:c?.materialState,position:c?.position});
   }
  }
  rt.renderer.render(rt.scene,rt.camera);
  return {trace,cache:rt.getMaterialFlowSnapshot().surplusSilkCache,
   main:rt.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d').map(p=>p.palletId).sort(),
   missingRealGantryEvent:!rt.getMaterialFlowSnapshot().surplusSilkCache.carrier?.previewOnly};
 });
 report.trace=progress.trace;
 report.end=progress.cache;
 assert.equal(progress.cache.carrier.state,'awaiting-empty-return-acceptance');
 assert.equal(progress.cache.carrier.materialState,'empty');
 const seenU=progress.trace.some(x=>x.position && x.position[0]>-1.3 && x.position[2]>-6.25 && x.position[2]<-4.35);
 const seenB=progress.trace.some(x=>x.position && x.position[2]>-4.37 && x.position[2]<-4.33 && x.position[0]<-2);
 assert(seenU,'No carrier traversed the physical U-turn');
 assert(seenB,'No empty small pallet travelled west on independent red conveyor below former lower blue');
 assert(progress.trace.some(x=>x.position&&x.position[0]<-12.5&&Math.abs(x.position[2]+4.35)<0.02),
   'Empty green small pallet did not reach left downward junction via independent red conveyor');
 assert.equal(progress.cache.occupied,1,'Robot must commit stored bobbin to rack');
 assert.equal(progress.cache.free,99);
 assert.equal(progress.main.length,108);
 const sameIds=await page.evaluate(ids=>ids.every((id,i)=>id===window.__r12.initialMain[i]),progress.main);
 assert(sameIds);
 report.seenPhysicalUTurn=true;report.seenEmptyBWestbound=true;
 report.main108Unchanged=true;
 const shot4=path.join(output,'04-empty-green-small-pallet-on-independent-red-awaiting-left-return.png');
 await page.screenshot({path:shot4,fullPage:true});report.shots.push(shot4);
 const rejection=await page.evaluate(()=>{
  try{window.__r12.rt.queueSurplusBobbin({bobbinId:'DUP',batchNo:'R12-BATCH',originalTaskNo:'R12-TASK'});return null}catch(e){return String(e)}
 });
 assert(rejection?.includes('空托盘'),'Pallet exit occupancy must block next material');
 report.nextPalletRejectedUntilAck=true;
 const ackRejected=await page.evaluate(()=>{
  try{window.__r12.rt.acknowledgeSurplusEmptyPallet('OTHER-ID');return null}catch(e){return String(e)}
 });
 assert(ackRejected?.includes('下游'),'Wrong pallet acceptance must be rejected');
 report.wrongPalletAckRejected=true;
 await page.evaluate(()=>window.__r12.rt.acknowledgeSurplusEmptyPallet('R12-ISOLATED-TEST-CARRIER'));
 assert.equal(await page.evaluate(()=>window.__r12.rt.getMaterialFlowSnapshot().surplusSilkCache.carrier),null);
 report.acknowledgedRemovalByExplicitSimulationCommand=true;
 report.errors.push(...init.errors);
 assert.equal(report.errors.length,0,report.errors.join('; '));
 report.passed=true;
})().catch(error=>{report.passed=false;report.error=String(error?.stack||error);process.exitCode=1}).finally(async()=>{
 try{await browser?.close()}catch{}
 if(server){server.kill();await new Promise(resolve=>setTimeout(resolve,150))}
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 for(const file of [fixture,upload,baseline]){try{fs.unlinkSync(file)}catch{}}
 console.log(JSON.stringify({passed:report.passed,error:report.error,source:report.source,
  physicalTurn:report.seenPhysicalUTurn,emptyBWestbound:report.seenEmptyBWestbound,
  main108Unchanged:report.main108Unchanged,warningCount:report.init?.warnings,
  shots:report.shots,report:path.join(output,'report.json')},null,2));
});
