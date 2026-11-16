// Real Edge + Vite + Three.js, with manifest derived from actual SQL Server Draft r6.
// No API mocks, PLC writes, MES writes or remote equipment commands.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.STUDIO_V2_PLAYWRIGHT_PATH||path.join(os.homedir(),'.ccpulse/e2e/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
const candidate=path.resolve(process.env.STUDIO_V2_BLUE_MANIFEST || path.join(root,'.tmp-studio-v2-blue-arrows-r7-v2.json'));
const original=path.join(root,'.tmp-studio-v2-surplus-layout-r6-live.json');
const output=path.join(root,'.tmp-studio-v2-blue-arrows-r7-browser');
const fixture=path.join(root,'.studio-v2-blue-arrows-r7-e2e.html');
const upload=path.join(root,'public','__studio_v2_blue_arrows_r7.json');
const baseline=path.join(root,'public','__studio_v2_blue_arrows_r6.json');
const host=process.env.STUDIO_V2_BASE_URL||'http://127.0.0.1:5173';
assert(!fs.existsSync(fixture)&&!fs.existsSync(upload)&&!fs.existsSync(baseline),'Temporary paths are occupied, refusing to overwrite');
fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(candidate,upload,fs.constants.COPYFILE_EXCL);
fs.copyFileSync(original,baseline,fs.constants.COPYFILE_EXCL);
const html=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Studio V2 按蓝箭头调整套袋实体辊道 · Edge</title>
<style>body{margin:0;background:#0f172a;color:white;font:13px Arial}#viewport{position:absolute;inset:0}#info{position:absolute;left:14px;top:14px;background:rgba(5,23,44,.91);padding:14px;border-radius:8px;border:1px solid #438dbe;width:360px;pointer-events:none}h2{font-size:16px;margin:0 0 10px;color:#80d9ff}p{margin:8px 0}b{color:#74e8a1}</style></head>
<body><div id="viewport"></div><section id="info"><h2>STUDIO V2 · 蓝箭头物理输送复核</h2><p>套袋机 A/B：右入左出，四段真实连接辊道</p><p id="guard">物理互锁：正在检查</p><p id="counts">设备和路线：正在初始化</p><p id="pallets">108 循环托盘：正在初始化</p><p>仅 Simulation / 原 V19 场景只读</p></section>
<script type="module">
import {TwinRuntime} from '/src/digital-twin/runtime/TwinRuntime.ts';
import {inspectStudioManifest,createStudioRuntimeManifest} from '/src/views/iot/digital-twin/studio-v2/studioScene.ts';
import {inspectStudioV2PhysicalRoutes} from '/src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts';
const errors=[],samples=[];
window.__blue={ready:false,errors,samples};
try {
 const [candidate,original]=await Promise.all(['r7','r6'].map(async name=>{
   const response=await fetch('/iot/__studio_v2_blue_arrows_'+name.replace('r7','r7').replace('r6','r6')+'.json',{cache:'no-store'});
   if(!response.ok)throw Error(name+' fetch '+response.status);
   return response.json();
 }));
 const originalViolations=inspectStudioV2PhysicalRoutes(original);
 const correctedViolations=inspectStudioV2PhysicalRoutes(candidate);
 const diagnostics=inspectStudioManifest(candidate);
 const rt=new TwinRuntime(document.getElementById('viewport'),createStudioRuntimeManifest(candidate,'simulation'),
   {onError:e=>errors.push(e)},{readOnly:true});
 rt.camera.position.set(22,24,1);
 rt.orbitControls.target.set(11,0,-9);
 rt.orbitControls.update();
 const originalRuntime=new TwinRuntime(document.createElement('div'),createStudioRuntimeManifest(original,'simulation'),
   {onError:e=>window.__blue.legacyError=e},{readOnly:true});
 originalRuntime.setRunning(true);
 const legacyBlocked=originalRuntime.runtimeRunning===false;
 originalRuntime.dispose();
 rt.setRunning(true);
 const connected=rt.runtimeRunning===true;
 window.__blue={ready:true,errors,samples,rt,originalViolations,correctedViolations,diagnostics,legacyBlocked,connected};
 const ids=['studio-v2-bag-a-infeed-roller','studio-v2-bag-a-outfeed-roller',
   'studio-v2-bag-b-infeed-roller','studio-v2-bag-b-outfeed-roller'];
 window.__blue.rollers=ids.map(id=>{
   const obj=rt.componentModels.get(id)?.root;
   return {id,exists:Boolean(obj),position:obj?.position.toArray(),length:obj?.userData.properties.length};
 });
 document.getElementById('guard').innerHTML='物理互锁：<b>'+(legacyBlocked&&connected&&correctedViolations.length===0?'旧版阻断 / 修正版可运行':'不通过')+'</b>';
 document.getElementById('counts').textContent='场景 '+candidate.objects.length+' 台 / '+candidate.connections.length+' 连线 / 4 段补齐';
 function sample(){
   const ps=rt.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d');
   let min=Infinity,pairs=0;
   for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
     const d=Math.hypot(ps[i].position[0]-ps[j].position[0],ps[i].position[2]-ps[j].position[2]);
     min=Math.min(min,d);if(d<1.5-0.0001)pairs++;
   }
   if(samples.length<100)samples.push({at:performance.now(),count:ps.length,min,pairs,
     ids:ps.map(p=>p.palletId).sort(),loops:ps.reduce((n,p)=>n+p.completedLoops,0)});
   document.getElementById('pallets').textContent='托盘：'+ps.length+' 个 / 采样重叠 '+pairs+' 对';
   requestAnimationFrame(sample);
 }
 sample();
}catch(e){errors.push(String(e));document.getElementById('guard').textContent=String(e)}
</script></body></html>`;
// The file is published at Vite base /iot/. Filename mapping below matches the two public JSON files.
fs.writeFileSync(fixture,html,'utf8');
let browser,server;const report={host,source:process.env.STUDIO_V2_BLUE_MANIFEST?
  'SQL Server V2 Draft r7 readback (real database)' : 'SQL Server V2 Draft r6 derived physical candidate',
  shots:[],errors:[]};
const port=Number(new URL(host).port||5173);
const checkPort=()=>new Promise(resolve=>{
  const socket=net.connect(port,'127.0.0.1',()=>{socket.destroy();resolve(true)});
  socket.setTimeout(350);socket.on('timeout',()=>{socket.destroy();resolve(false)});
  socket.on('error',()=>resolve(false));
});
const ensureVite=async()=>{
  if(await checkPort())return;
  const logs=[];
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{
    cwd:root,windowsHide:true,
    env:{...process.env,VITE_PUBLIC_PATH:'/iot/',VITE_OPEN:'false',VITE_OPEN_CDN:'false'},
    stdio:['ignore','pipe','pipe'],
  });
  server.stdout.on('data',data=>logs.push(String(data)));
  server.stderr.on('data',data=>logs.push(String(data)));
  for(let attempt=0;attempt<100;attempt++){
    if(await checkPort())return;
    if(server.exitCode!==null)throw Error('Vite exited: '+logs.join('').slice(-1200));
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw Error('Vite did not listen on '+port+': '+logs.join('').slice(-1200));
};
(async()=>{
 await ensureVite();
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1760,height:1040},deviceScaleFactor:1});
 page.setDefaultTimeout(55000);
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('response',response=>{if(response.status()>=400)report.errors.push('HTTP '+response.status()+': '+response.url())});
 await page.goto(host+'/iot/.studio-v2-blue-arrows-r7-e2e.html',{waitUntil:'domcontentloaded',timeout:50000});
 await page.waitForFunction(()=>window.__blue?.ready===true,{timeout:50000});
 await page.waitForTimeout(4500);
 const result=await page.evaluate(()=>({
   errors:window.__blue.errors,
   originalViolations:window.__blue.originalViolations,
   correctedViolations:window.__blue.correctedViolations,
   legacyBlocked:window.__blue.legacyBlocked,connected:window.__blue.connected,
   rollers:window.__blue.rollers,
   diagnostics:window.__blue.diagnostics,
   samples:window.__blue.samples,
 }));
 report.legacyPhysicalViolationCount=result.originalViolations?.length;
 report.candidatePhysicalViolationCount=result.correctedViolations?.length;
 report.legacySimulationBlocked=result.legacyBlocked;
 report.correctedSimulationRunning=result.connected;
 report.rollers=result.rollers;
 report.structureErrors=result.diagnostics.filter(x=>x.severity==='error');
 report.warningCount=result.diagnostics.filter(x=>x.severity==='warning').length;
 report.sampleCount=result.samples.length;
 report.minimumCenterDistanceMeters=Math.min(...result.samples.map(s=>s.min));
 report.maxOverlapPairs=Math.max(...result.samples.map(s=>s.pairs));
 report.palletIdentityStable=result.samples.every(s=>s.count===108&&s.ids.join('|')===result.samples[0].ids.join('|'));
 report.errors.push(...result.errors);
 const filename=path.join(output,'studio-v2-blue-arrow-bagging-physical-rollers.png');
 await page.screenshot({path:filename,fullPage:true});report.shots.push(filename);
 assert.equal(result.correctedViolations.length,0);
 assert(result.legacyBlocked,'Old V2 r6 without rollers was allowed to run!');
 assert(result.connected,'Corrected scene cannot run even with actual rollers');
 assert.equal(result.rollers.length,4);
 assert(result.rollers.every(x=>x.exists),'Some physical rollers missing in Three.js scene');
 assert.equal(report.structureErrors.length,0,'Studio structural validation failed: '+JSON.stringify(report.structureErrors));
 assert(report.palletIdentityStable,'108 pallet identities changed');
 assert.equal(report.maxOverlapPairs,0,'Pallets overlap after physical route correction');
 assert.equal(report.errors.length,0,report.errors.join('; '));
 report.passed=true;
})().catch(error=>{report.passed=false;report.error=String(error?.stack||error);process.exitCode=1}).finally(async()=>{
 try{await browser?.close()}catch{}
 if(server){server.kill();await new Promise(resolve=>setTimeout(resolve,150))}
 try{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))}catch{}
 for(const pathname of [fixture,upload,baseline]){try{fs.unlinkSync(pathname)}catch{}}
 console.log(JSON.stringify(report,null,2));
});
