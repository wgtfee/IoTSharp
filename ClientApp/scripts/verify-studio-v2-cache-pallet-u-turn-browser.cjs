// SQL r9-derived candidate r10, real Edge+Vite+Three.js, no HTTP/API mocks or PLC/MES writes.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.STUDIO_V2_PLAYWRIGHT_PATH||path.join(os.homedir(),'.ccpulse/e2e/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
const candidate=path.resolve(process.env.STUDIO_V2_R10_MANIFEST||path.join(root,'.tmp-studio-v2-cache-pallet-u-turn-r10-candidate.json'));
const previous=path.join(root,'.tmp-studio-v2-r9-db-readback.json');
const output=path.resolve(process.env.STUDIO_V2_R10_OUTPUT||path.join(root,'.tmp-studio-v2-cache-u-turn-r10-edge'));
const fixture=path.join(root,'.studio-v2-cache-u-turn-r10-e2e.html');
const upload=path.join(root,'public','__studio_v2_cache_u_turn_r10.json');
const baseline=path.join(root,'public','__studio_v2_cache_u_turn_r9.json');
const host=process.env.STUDIO_V2_BASE_URL||'http://127.0.0.1:5173';
assert(!fs.existsSync(fixture)&&!fs.existsSync(upload)&&!fs.existsSync(baseline),'Temporary path occupied');
fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(candidate,upload,fs.constants.COPYFILE_EXCL);
fs.copyFileSync(previous,baseline,fs.constants.COPYFILE_EXCL);
const html=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>body{margin:0;background:#0b1424;color:#e6f4ff;font:14px Arial}#viewport{position:absolute;inset:0}#hud{position:absolute;left:18px;top:16px;max-width:430px;padding:16px;border-radius:12px;background:rgba(7,25,44,.93);pointer-events:none;border:1px solid #3677a2}h2{font-size:18px;margin:0 0 9px;color:#aee6ff}p{margin:8px 0}b{color:#72eccb}</style></head>
<body><div id="viewport"></div><div id="hud"><h2>STUDIO V2 · 机器人抓丝后空托 U 形回流</h2>
<p>A 排：载丝托盘向右 → 缓存机器人取丝 → 同一托盘空载右行</p>
<p>B 排：右端实体 180° 折返 → 空托盘向左回流，<b>不承载复用丝锭</b></p>
<p id="status">SQL r10 候选加载中...</p><p id="carrier">托盘等待中</p><p id="pallets">108 主闭环托盘保持原样</p>
<small>隔离 Simulation；两端主线连接尚未验收；不向 PLC/MES 发送命令</small></div>
<script type="module">
import {TwinRuntime} from '/src/digital-twin/runtime/TwinRuntime.ts';
import {inspectStudioManifest,createStudioRuntimeManifest} from '/src/views/iot/digital-twin/studio-v2/studioScene.ts';
import {inspectStudioV2PhysicalRoutes} from '/src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const errors=[];window.__r10={ready:false,errors};
try{
 const [manifest,oldManifest]=await Promise.all(['r10','r9'].map(async v=>{
   const response=await fetch('/iot/__studio_v2_cache_u_turn_'+v+'.json',{cache:'no-store'});
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
 rt.camera.position.set(-3,16,3);
 rt.orbitControls.target.set(-3,0,-8);
 rt.orbitControls.update();
 rt.setRunning(true);
 const turn=rt.componentModels.get('studio-v2-cache-pallet-empty-u-turn')?.root;
 window.__r10={ready:true,errors,oldBlocked,oldRejection,oldViolations,violations,diagnostics,rt,
  turnPresent:Boolean(turn),physicalTurnRollers:Boolean(turn?.getObjectByName('Rollers')),
  initialMain:rt.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d').map(p=>p.palletId).sort(),
 };
 function display(){
   const cache=rt.getMaterialFlowSnapshot().surplusSilkCache;
   const carrier=cache?.carrier;
   document.getElementById('status').innerHTML='实体 U 型折返：'+(turn?' <b>已实例化</b>':'缺失')+' / 缓存余丝 '+(cache?.occupied??0);
   document.getElementById('carrier').textContent='托盘：'+(carrier?.palletId||'无')+' / '+(carrier?.materialState||'无')+' / '+(carrier?.state||'无');
   document.getElementById('pallets').textContent='主闭环托盘：'+rt.routeSlotArrayRuntime.getDiagnostics().plasticPallets;
   requestAnimationFrame(display);
 }
 display();
}catch(error){errors.push(String(error));document.getElementById('status').textContent=String(error)}
</script></body></html>`;
fs.writeFileSync(fixture,html,'utf8');
const report={host,source:process.env.STUDIO_V2_R10_SOURCE_LABEL||'SQL Draft r9-derived r10 candidate (not yet committed to SQL)',
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
 await page.goto(host+'/iot/.studio-v2-cache-u-turn-r10-e2e.html',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__r10?.ready===true,{timeout:60000});
 const init=await page.evaluate(()=>{
  const a=window.__r10;
  return {oldBlocked:a.oldBlocked,oldViolations:a.oldViolations,violations:a.violations,
   errors:a.errors,turnPresent:a.turnPresent,physicalTurnRollers:a.physicalTurnRollers,
   structureErrors:a.diagnostics.filter(x=>x.severity==='error'),
   warnings:a.diagnostics.filter(x=>x.severity==='warning').length,
   running:a.rt.runtimeRunning,
   mainCount:a.initialMain.length,
  };
 });
 report.init=init;
 assert(init.oldBlocked,'r9 missing physical U turn must fail startup');
 assert.equal(init.violations.length,0,JSON.stringify(init.violations));
 assert.equal(init.structureErrors.length,0,JSON.stringify(init.structureErrors));
 assert(init.running);
 assert(init.turnPresent && init.physicalTurnRollers);
 assert.equal(init.mainCount,108);
 const shot1=path.join(output,'01-robot-cache-two-lanes-with-physical-u-turn.png');
 await page.screenshot({path:shot1,fullPage:true});report.shots.push(shot1);
 await page.evaluate(()=>window.__r10.rt.queueSurplusBobbin({
   bobbinId:'R10-EXAMPLE-BOBBIN',batchNo:'R10-BATCH',originalTaskNo:'R10-GANTRY-BATCH',
   carrierPalletId:'R10-ISOLATED-TEST-CARRIER',
 }));
 const before=await page.evaluate(()=>window.__r10.rt.getMaterialFlowSnapshot().surplusSilkCache);
 assert.equal(before.carrier.materialState,'loaded');
 assert.equal(before.carrier.state,'loaded-arrival');
 assert.equal(before.carrier.previewOnly,true,'This is a local preview carrier, not one of the adopted 108 RouteSlot entities');
 const shot2=path.join(output,'02-loaded-pallet-arrives-on-inner-lane.png');
 await page.screenshot({path:shot2,fullPage:true});report.shots.push(shot2);
 await page.waitForFunction(()=>window.__r10.rt.getMaterialFlowSnapshot().surplusSilkCache.carrier?.state==='empty-return',{timeout:45000});
 const grabbed=await page.evaluate(()=>window.__r10.rt.getMaterialFlowSnapshot().surplusSilkCache);
 assert.equal(grabbed.carrier.materialState,'empty');
 report.events.push({state:'picked',carrier:grabbed.carrier});
 const shot3=path.join(output,'03-robot-grabs-bobbin-original-pallet-empty.png');
 await page.screenshot({path:shot3,fullPage:true});report.shots.push(shot3);
 // Advance the authentic cache runtime at its fixed 30Hz logic step in-browser;
 // this is accelerated logic testing, not realtime throughput or hardware.
 const progress=await page.evaluate(()=>{
  const rt=window.__r10.rt;
  rt.setRunning(false);
  rt.surplusCache.setRunning(true);
  const trace=[];
  for(let i=0;i<900;i++){
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
 const seenU=progress.trace.some(x=>x.position && x.position[0]>-1.3 && x.position[2]>-8.15 && x.position[2]<-6.25);
 const seenB=progress.trace.some(x=>x.position && x.position[2]>-6.27 && x.position[2]<-6.23 && x.position[0]<-2);
 assert(seenU,'No carrier traversed the physical U-turn');
 assert(seenB,'No empty pallet travelled west on B lower lane');
 assert.equal(progress.cache.occupied,1,'Robot must commit stored bobbin to rack');
 assert.equal(progress.cache.free,99);
 assert.equal(progress.main.length,108);
 const sameIds=await page.evaluate(ids=>ids.every((id,i)=>id===window.__r10.initialMain[i]),progress.main);
 assert(sameIds);
 report.seenPhysicalUTurn=true;report.seenEmptyBWestbound=true;
 report.main108Unchanged=true;
 const shot4=path.join(output,'04-empty-pallet-waits-for-downstream-return-acceptance.png');
 await page.screenshot({path:shot4,fullPage:true});report.shots.push(shot4);
 const rejection=await page.evaluate(()=>{
  try{window.__r10.rt.queueSurplusBobbin({bobbinId:'DUP',batchNo:'R10-BATCH',originalTaskNo:'R10-TASK'});return null}catch(e){return String(e)}
 });
 assert(rejection?.includes('空托盘'),'Pallet exit occupancy must block next material');
 report.nextPalletRejectedUntilAck=true;
 const ackRejected=await page.evaluate(()=>{
  try{window.__r10.rt.acknowledgeSurplusEmptyPallet('OTHER-ID');return null}catch(e){return String(e)}
 });
 assert(ackRejected?.includes('下游'),'Wrong pallet acceptance must be rejected');
 report.wrongPalletAckRejected=true;
 await page.evaluate(()=>window.__r10.rt.acknowledgeSurplusEmptyPallet('R10-ISOLATED-TEST-CARRIER'));
 assert.equal(await page.evaluate(()=>window.__r10.rt.getMaterialFlowSnapshot().surplusSilkCache.carrier),null);
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
