// Real SQL-derived V2 r9 candidate + Vite + Edge + Three.js; simulation-only.
// All files below are temporary; no API mocks or PLC/MES/equipment commands.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.STUDIO_V2_PLAYWRIGHT_PATH||path.join(os.homedir(),'.ccpulse/e2e/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
const source=path.resolve(process.env.STUDIO_V2_R9_MANIFEST||path.join(root,'.tmp-studio-v2-cache-double-r9-candidate.json'));
const previous=path.join(root,'.tmp-studio-v2-r8-db-readback.json');
const output=path.resolve(process.env.STUDIO_V2_R9_OUTPUT||path.join(root,'.tmp-studio-v2-cache-double-r9-edge'));
const fixture=path.join(root,'.studio-v2-cache-double-r9-e2e.html');
const upload=path.join(root,'public','__studio_v2_cache_double_r9.json');
const baseline=path.join(root,'public','__studio_v2_cache_double_r8.json');
const host=process.env.STUDIO_V2_BASE_URL||'http://127.0.0.1:5173';
assert(!fs.existsSync(fixture)&&!fs.existsSync(upload)&&!fs.existsSync(baseline),'Temporary path exists; refusing overwrite');
fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(source,upload,fs.constants.COPYFILE_EXCL);
fs.copyFileSync(previous,baseline,fs.constants.COPYFILE_EXCL);
const html=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Studio V2 r9 双排机器人交接 · Edge</title>
<style>body{margin:0;background:#0b1424;color:#e6f4ff;font:14px Arial}#viewport{position:absolute;inset:0}
#hud{position:absolute;left:16px;top:16px;max-width:430px;padding:16px;border:1px solid #4882ba;border-radius:12px;background:rgba(8,25,43,.91);pointer-events:none}
h2{font-size:17px;margin:0 0 9px;color:#bce4ff}p{margin:8px 0}b{color:#77e6bc}</style></head>
<body><div id="viewport"></div><div id="hud"><h2>STUDIO V2 · 缓存机器人下方双排输送</h2>
<p>A 内排：<b>向右 →</b> 入库交接；B 外排：<b>← 向左</b> 余丝复用回流</p>
<p id="status">加载 SQL 场景候选...</p><p id="job">机器人等待中</p><p id="inventory">挂杆 0 / 100</p>
<p id="pallet">108 循环托盘</p><small>开发隔离 Simulation，未向 PLC / MES / 机器人下发指令</small></div>
<script type="module">
import {TwinRuntime} from '/src/digital-twin/runtime/TwinRuntime.ts';
import {inspectStudioManifest,createStudioRuntimeManifest} from '/src/views/iot/digital-twin/studio-v2/studioScene.ts';
import {inspectStudioV2PhysicalRoutes} from '/src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const errors=[],samples=[],palletSamples=[];
window.__dual={ready:false,errors,samples,palletSamples};
try{
  const responses=await Promise.all(['r9','r8'].map(async ver=>{
    const response=await fetch('/iot/__studio_v2_cache_double_'+ver+'.json',{cache:'no-store'});
    if(!response.ok)throw Error('Failed '+ver+' '+response.status);
    return response.json();
  }));
  const [manifest,original]=responses;
  const currentGuard=inspectStudioV2PhysicalRoutes(manifest);
  const oldGuard=inspectStudioV2PhysicalRoutes(original);
  const diagnostics=inspectStudioManifest(manifest);
  let oldMessage='';
  const oldRt=new TwinRuntime(document.createElement('div'),createStudioRuntimeManifest(original,'simulation'),{
    onError:e=>oldMessage=e
  },{readOnly:true});
  oldRt.setRunning(true);
  const oldBlocked=oldRt.runtimeRunning===false;
  oldRt.dispose();
  const rt=new TwinRuntime(document.getElementById('viewport'),createStudioRuntimeManifest(manifest,'simulation'),{
    onError:e=>errors.push(e)
  },{readOnly:true});
  rt.camera.position.set(-3,18,4);
  rt.orbitControls.target.set(-4,0,-9);
  rt.orbitControls.update();
  rt.setRunning(true);
  const handoff=rt.componentModels.get('studio-v2-surplus-silk-handoff-roller')?.root;
  const cache=rt.getMaterialFlowSnapshot().surplusSilkCache;
  const lanes=handoff && {
    count:handoff.userData.laneCount,
    parallel:handoff.userData.parallelLanes,
    properties:{...handoff.userData.properties},
    a:handoff.getObjectByName('DoubleSmall-Lane-A')?.name,
    b:handoff.getObjectByName('DoubleSmall-Lane-B')?.name,
  };
  const state={ready:true,errors,samples,palletSamples,rt,lanes,
    oldBlocked,oldMessage,currentGuard,oldGuard,diagnostics,initialCache:cache,
    connected:rt.runtimeRunning===true};
  window.__dual=state;
  let lastPalletAt=0;
  function sample(){
    const snapshot=rt.getMaterialFlowSnapshot().surplusSilkCache;
    const model=rt.scene.getObjectByName('SurplusBobbin-R9-SILK-001');
    if(model&&samples.length<2500)samples.push({at:performance.now(),xyz:model.position.toArray(),phase:snapshot?.active?.phase||'idle',kind:snapshot?.active?.kind||'idle'});
    if(performance.now()-lastPalletAt>850){
      lastPalletAt=performance.now();
      const ps=rt.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d');
      let min=Infinity,pairs=0;
      for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
        const d=Math.hypot(ps[i].position[0]-ps[j].position[0],ps[i].position[2]-ps[j].position[2]);
        min=Math.min(min,d);
        if(d<1.5-0.0001)pairs++;
      }
      palletSamples.push({ids:ps.map(p=>p.palletId).sort(),min,pairs,count:ps.length});
    }
    document.getElementById('status').innerHTML='实体双排：'+(lanes?.a&&lanes?.b?'<b>2 排均存在</b>':'错误');
    document.getElementById('job').textContent='机器人：'+(snapshot?.active?snapshot.active.kind+' · '+snapshot.active.phase:'待机');
    document.getElementById('inventory').textContent='缓存挂杆：'+(snapshot?.occupied??0)+'/100，已入库 '+(snapshot?.completedStores??0)+'，已复用 '+(snapshot?.completedReuses??0);
    document.getElementById('pallet').textContent='初始托盘 '+(palletSamples.at(-1)?.count??0)+' 个';
    requestAnimationFrame(sample);
  }
  sample();
}catch(e){errors.push(String(e));document.getElementById('status').textContent=String(e)}
</script></body></html>`;
fs.writeFileSync(fixture,html,'utf8');
const report={source:process.env.STUDIO_V2_R9_MANIFEST?'SQL Server Draft r9 readback':'SQL Server Draft r8 derived r9 candidate',
  host,shots:[],errors:[],stages:[]};
let browser,server;
const port=Number(new URL(host).port||5173);
const checkPort=()=>new Promise(resolve=>{
 const sock=net.connect(port,'127.0.0.1',()=>{sock.destroy();resolve(true)});
 sock.setTimeout(350);sock.on('timeout',()=>{sock.destroy();resolve(false)});
 sock.on('error',()=>resolve(false));
});
const ensureVite=async()=>{
 if(await checkPort())return;
 const logs=[];
 server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{
   cwd:root,windowsHide:true,env:{...process.env,VITE_PUBLIC_PATH:'/iot/',VITE_OPEN:'false',VITE_OPEN_CDN:'false'},
   stdio:['ignore','pipe','pipe'],
 });
 server.stdout.on('data',data=>logs.push(String(data)));
 server.stderr.on('data',data=>logs.push(String(data)));
 for(let i=0;i<100;i++){
   if(await checkPort())return;
   if(server.exitCode!==null)throw Error('Vite exited '+logs.join('').slice(-1300));
   await new Promise(resolve=>setTimeout(resolve,350));
 }
 throw Error('Vite 5173 timeout '+logs.join('').slice(-1300));
};
(async()=>{
 await ensureVite();
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1760,height:1040},deviceScaleFactor:1});
 page.setDefaultTimeout(60000);
 page.on('pageerror',e=>report.errors.push('pageerror '+e.message));
 page.on('response',r=>{if(r.status()>=400)report.errors.push('http '+r.status()+' '+r.url())});
 await page.goto(host+'/iot/.studio-v2-cache-double-r9-e2e.html',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__dual?.ready===true,{timeout:60000});
 const init=await page.evaluate(()=>{
   const s=window.__dual;return {
     lanes:s.lanes,oldBlocked:s.oldBlocked,oldViolations:s.oldGuard,
     violations:s.currentGuard,structureErrors:s.diagnostics.filter(i=>i.severity==='error'),
     warnings:s.diagnostics.filter(i=>i.severity==='warning').length,
     connected:s.connected,cache:s.initialCache,errors:s.errors,
   };
 });
 report.initial={...init,cache:undefined,initialCapacity:init.cache?.capacity,
   handoffLanes:init.cache?.handoffLanes};
 assert.equal(init.violations.length,0);
 assert(init.oldBlocked,'Old r8 single physical lane was allowed to simulate');
 assert(init.oldViolations.some(e=>e.includes('双排小辊道')));
 assert(init.connected,'Dual-lane candidate cannot start');
 assert.equal(init.structureErrors.length,0,'New r9 structure errors: '+JSON.stringify(init.structureErrors));
 assert.equal(init.lanes.count,2);
 assert.equal(init.lanes.parallel,true);
 assert.equal(init.lanes.a,'DoubleSmall-Lane-A');
 assert.equal(init.lanes.b,'DoubleSmall-Lane-B');
 assert.equal(init.lanes.properties.laneAReverse,false);
 assert.equal(init.lanes.properties.laneBReverse,true);
 assert.equal(init.cache.capacity,100);
 assert.equal(init.cache.free,100);
 assert.equal(init.cache.handoffLanes.laneA.direction,'east');
 assert.equal(init.cache.handoffLanes.laneB.direction,'west');
 assert(Math.abs(init.cache.handoffLanes.laneA.robot[2]-init.cache.handoffLanes.laneB.robot[2])>=1.8);
 report.stages.push({laneCount:2,oldBlocked:true,structureErrors:0});
 const shot0=path.join(output,'01-two-real-conveyor-lanes.png');
 await page.screenshot({path:shot0,fullPage:true});report.shots.push(shot0);
 await page.evaluate(()=>window.__dual.rt.queueSurplusBobbin({bobbinId:'R9-SILK-001',batchNo:'R9-BATCH-01',originalTaskNo:'R9-OLD-001'}));
 await page.waitForFunction(()=>window.__dual.rt.getMaterialFlowSnapshot().surplusSilkCache.active?.phase==='transfer',{timeout:50000});
 const shot1=path.join(output,'02-robot-grabs-from-inner-eastbound-lane.png');
 await page.screenshot({path:shot1,fullPage:true});report.shots.push(shot1);
 await page.waitForFunction(()=>window.__dual.rt.getMaterialFlowSnapshot().surplusSilkCache.completedStores===1,{timeout:50000});
 const stored=await page.evaluate(()=>window.__dual.rt.getMaterialFlowSnapshot().surplusSilkCache);
 assert.equal(stored.occupied,1);
 assert.equal(stored.reservedIn,0);
 report.stages.push({storedBobbinId:'R9-SILK-001',occupied:1});
 assert.equal(await page.evaluate(()=>window.__dual.rt.queueSurplusReuse('WRONG-BATCH','R9-NEW')),null);
 const reused=await page.evaluate(()=>window.__dual.rt.queueSurplusReuse('R9-BATCH-01','R9-NEW'));
 assert.equal(reused.bobbin.bobbinId,'R9-SILK-001');
 assert.equal(await page.evaluate(()=>window.__dual.rt.queueSurplusReuse('R9-BATCH-01','R9-DUP')),null);
 await page.waitForFunction(()=>window.__dual.rt.getMaterialFlowSnapshot().surplusSilkCache.active?.phase==='conveyor-out',{timeout:55000});
 const shot2=path.join(output,'03-robot-returns-to-outer-westbound-lane.png');
 await page.screenshot({path:shot2,fullPage:true});report.shots.push(shot2);
 await page.waitForFunction(()=>window.__dual.rt.getMaterialFlowSnapshot().surplusSilkCache.completedReuses===1,{timeout:55000});
 const finish=await page.evaluate(()=>{
   const s=window.__dual;
   return {cache:s.rt.getMaterialFlowSnapshot().surplusSilkCache,
     samples:s.samples,pallets:s.palletSamples,errors:s.errors,
     palletCount:s.rt.routeSlotArrayRuntime.getDiagnostics().plasticPallets};
 });
 assert.equal(finish.cache.free,100);
 assert.equal(finish.cache.occupied,0);
 assert.equal(finish.palletCount,108);
 assert(finish.pallets.length>=2,'Insufficient pallet samples');
 const ids=finish.pallets[0].ids;
 assert.equal(new Set(ids).size,108);
 assert(finish.pallets.every(p=>p.count===108&&p.pairs===0&&p.ids.join('|')===ids.join('|')),
   '108 pallet count, identity or 1.5m spacing changed');
 const inSamples=finish.samples.filter(s=>s.kind==='store'&&s.phase==='conveyor-in');
 const outSamples=finish.samples.filter(s=>s.kind==='reuse'&&s.phase==='conveyor-out');
 assert(inSamples.length>0,'No physically animated inner-lane incoming bobbin');
 assert(outSamples.length>0,'No physically animated outer-lane outgoing bobbin');
 assert(inSamples.every(s=>Math.abs(s.xyz[2]+8.15)<0.02),'Inbound silk did not use inner A lane');
 assert(outSamples.every(s=>Math.abs(s.xyz[2]+6.25)<0.02),'Reuse silk did not use outer B lane');
 report.stages.push({completedStores:1,completedReuses:1,finalFree:100,remainingPallets:108});
 report.geometry={inboundSamples:inSamples.length,outboundSamples:outSamples.length,
   inboundXRange:[Math.min(...inSamples.map(s=>s.xyz[0])),Math.max(...inSamples.map(s=>s.xyz[0]))],
   outboundXRange:[Math.min(...outSamples.map(s=>s.xyz[0])),Math.max(...outSamples.map(s=>s.xyz[0]))],
   innerZ:-8.15,outerZ:-6.25};
 report.palletSamples=finish.pallets.length;
 report.minPalletCenterSpacing=Math.min(...finish.pallets.map(p=>p.min));
 report.maxOverlappingPairs=Math.max(...finish.pallets.map(p=>p.pairs));
 report.errors.push(...finish.errors);
 assert.equal(report.errors.length,0,report.errors.join('; '));
 const shot3=path.join(output,'04-two-lanes-robot-idle-after-reuse.png');
 await page.screenshot({path:shot3,fullPage:true});report.shots.push(shot3);
 report.passed=true;
})().catch(e=>{report.passed=false;report.error=String(e?.stack||e);process.exitCode=1}).finally(async()=>{
 try{await browser?.close()}catch{}
 if(server){server.kill();await new Promise(resolve=>setTimeout(resolve,120))}
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 for(const file of [fixture,upload,baseline]){try{fs.unlinkSync(file)}catch{}}
 console.log(JSON.stringify(report,null,2));
});
