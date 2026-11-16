// Read-only SQL Server r6 draft -> real running Vite + Edge + Three.js TwinRuntime.
// No mocked API, no SQL writes, no PLC/MES/equipment commands.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require(process.env.STUDIO_V2_PLAYWRIGHT_PATH || path.join(os.homedir(), '.ccpulse/e2e/node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, '.studio-v2-surplus-r7-e2e.html');
const payload = path.join(root, 'public', '__studio_surplus_r7_live_sql.json');
const output = path.join(root, '.tmp-studio-v2-surplus-r7-e2e');
const host = process.env.STUDIO_V2_R7_HOST || 'http://127.0.0.1:5173';
const sceneId = 'd7c2dfdf-39bf-4e69-a2c4-587cfaf63c94';
if (fs.existsSync(fixture) || fs.existsSync(payload)) throw Error('Temporary browser fixture already exists, refusing to overwrite');
fs.mkdirSync(output, {recursive:true});

const sql = [
  "$ErrorActionPreference='Stop'",
  "$cn=[System.Data.SqlClient.SqlConnection]::new('Server=DESKTOP-2ALRK02\\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')",
  "try{$cn.Open();$cmd=$cn.CreateCommand();$cmd.CommandText=\"SELECT DraftPayload FROM dbo.DigitalTwinScenes WHERE Id=@id AND Deleted=0 AND Status='Draft' AND Revision=6\"",
  "$null=$cmd.Parameters.Add('@id',[System.Data.SqlDbType]::UniqueIdentifier);$cmd.Parameters['@id'].Value=[guid]'"+sceneId+"'",
  "$data=[string]$cmd.ExecuteScalar();if([string]::IsNullOrWhiteSpace($data)){throw 'Live SQL Draft r6 not found, abort without altering data'}",
  "[IO.File]::WriteAllText('"+payload.replaceAll("'","''")+"',$data,[Text.UTF8Encoding]::new($false))}finally{$cn.Dispose()}",
].join(';');
const exportResult = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', sql], {cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
if (exportResult.status !== 0 || !fs.existsSync(payload)) throw Error('Live SQL read-only export failed: '+(exportResult.stderr||exportResult.stdout||exportResult.error||'unknown'));
const manifest = JSON.parse(fs.readFileSync(payload,'utf8'));
assert.equal(manifest.sceneId.toLowerCase(), sceneId);
assert.equal(manifest.runtime.routePalletInitializers.find(x=>x.routeId==='component-route-d045206d').simulationDefaultCount,108);
assert.equal(manifest.objects.find(x=>x.objectId==='studio-v2-surplus-silk-arc-rack').component.properties.layers*
  manifest.objects.find(x=>x.objectId==='studio-v2-surplus-silk-arc-rack').component.properties.columns,100);
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Studio V2 余丝缓存 r7 · SQL Server + Three.js</title>
<style>body{margin:0;background:#0e1726;color:#e6effc;font:13px Arial}#viewport{position:absolute;inset:0}#hud{position:absolute;top:12px;left:14px;width:340px;background:rgba(11,28,49,.91);padding:16px;border:1px solid #42719c;border-radius:12px;box-shadow:0 10px 34px #0007;pointer-events:none}h3{margin:0 0 10px;color:#cde9ff}p{margin:6px 0}b{color:#72e2b5}small{color:#aabdd7}</style></head>
<body><div id="viewport"></div><aside id="hud"><h3>STUDIO V2 · 100 杆余丝缓存联调</h3><p>来源：本地 SQL Server · Draft r6</p><p id="stage">初始化中...</p><p id="stock"></p><p id="process"></p><p id="pallets"></p><small>纯 Simulation，未向 PLC/MES 发送任何动作指令</small></aside>
<script type="module">
import {TwinRuntime} from '/src/digital-twin/runtime/TwinRuntime.ts';
import {inspectStudioManifest} from '/src/views/iot/digital-twin/studio-v2/studioScene.ts';
const errors=[],samples=[],palletSamples=[];
window.__r7={ready:false,errors,samples,palletSamples};
try {
  const response=await fetch('/iot/__studio_surplus_r7_live_sql.json',{cache:'no-store'});
  if(!response.ok)throw Error('SQL export HTTP '+response.status);
  const manifest=await response.json();
  if(manifest.sceneId.toLowerCase()!=='${sceneId}')throw Error('Wrong scene ID');
  const diagnostics=inspectStudioManifest(manifest);
  let metric;
  const runtime=new TwinRuntime(document.getElementById('viewport'),manifest,{
    onMetrics(value){metric=value},
    onError(message){errors.push(message)},
  },{readOnly:true});
  runtime.camera.position.set(1,13,0);
  runtime.orbitControls.target.set(-4,1.4,-10);
  runtime.orbitControls.update();
  runtime.setRunning(true);
  window.__r7={ready:true,errors,samples,palletSamples,runtime,diagnostics, get metrics(){return metric}};
  let lastPalletSampleAt=0;
  function sample(){
    const cache=runtime.getMaterialFlowSnapshot().surplusSilkCache;
    const bobbin=runtime.scene.getObjectByName('SurplusBobbin-R7-SILK-001');
    if(bobbin && samples.length<2000)samples.push({at:performance.now(),xyz:bobbin.position.toArray(),phase:cache?.active?.phase||'idle'});
    if(performance.now()-lastPalletSampleAt>=750){
      lastPalletSampleAt=performance.now();
      const all=runtime.routeSlotArrayRuntime.getSimulationSnapshot().filter(p=>p.routeId==='component-route-d045206d');
      let minSpacing=Infinity,overlapPairs=0;
      const collisions=[];
      for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
        const d=Math.hypot(all[i].position[0]-all[j].position[0],all[i].position[2]-all[j].position[2]);
        minSpacing=Math.min(minSpacing,d);
        if(d<1.5-0.0001){
          overlapPairs++;
          if(collisions.length<5)collisions.push({palletA:all[i],palletB:all[j],distance:d});
        }
      }
      palletSamples.push({at:performance.now(),ids:all.map(p=>p.palletId).sort(),minSpacing,overlapPairs,collisions,
        completedLoops:all.reduce((n,p)=>n+p.completedLoops,0)});
      if(collisions.length && !window.__r7.firstCollisionDetails){
        const robot=runtime.componentModels.get('reference-loading-robot')?.root;
        window.__r7.firstCollisionDetails={
          robotState:robot && {
            stationPalletIds:robot.userData.stationPalletIds,stationWaitingPalletIds:robot.userData.stationWaitingPalletIds,
            stationReleasedPalletIds:robot.userData.stationReleasedPalletIds,
            stationPhysicalReleasePalletIds:robot.userData.stationPhysicalReleasePalletIds,
            processPhase:robot.userData.processPhase,
          },
          entities:collisions.flatMap(c=>[c.palletA.palletId,c.palletB.palletId]).map(id=>{
            const e=[...runtime.routeSlotArrayRuntime.entities.values()].find(item=>item.palletId===id);
            return e&&{id,slotIndex:e.slotIndex,originalLaneOrdinal:e.physicalLaneOrdinal,actualPosition:e.root.position.toArray(),
              data:{stationBatchVisual:e.root.userData.stationBatchVisual,stationQueueVisual:e.root.userData.stationQueueVisual,
                stationReleaseVisual:e.root.userData.stationReleaseVisual,stationQueueIndex:e.root.userData.stationQueueIndex,
                collisionHeld:e.root.userData.collisionHeld,routeHandoffComplete:e.root.userData.routeHandoffComplete},
              process:e.simulationProcess?.getSnapshot()};
          }),
        };
      }
    }
    document.getElementById('stage').textContent='机器人：'+(cache?.active?cache.active.kind+' / '+cache.active.phase:'待机')+' · 队列 '+cache?.queued;
    document.getElementById('stock').innerHTML='挂杆：<b>'+(cache?.occupied??0)+'</b> 已占 / '+(cache?.free??0)+' 空闲 / '+(cache?.reservedIn??0)+' 入库预约 / '+(cache?.reservedOut??0)+' 出库预约';
    document.getElementById('process').textContent='完成入库 '+(cache?.completedStores??0)+' 次 / 同批取回 '+(cache?.completedReuses??0)+' 次';
    document.getElementById('pallets').textContent='循环托盘：'+(metric?.routeSlots?.plasticPallets??'...')+' / 已完成圈数 '+(metric?.routeSlots?.completedPlasticLoops??0);
    requestAnimationFrame(sample);
  }
  sample();
} catch(error){errors.push(String(error));document.getElementById('stage').textContent=String(error)}
</script></body></html>`;
fs.writeFileSync(fixture,html,'utf8');
let browser;
const result={source:'SQL Server integrated auth (read-only)',sceneId,revision:6,host,stages:[],errors:[],shots:[],geometrySamples:0};
(async()=>{
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1760,height:1040},deviceScaleFactor:1});
  page.setDefaultTimeout(60000);
  page.on('pageerror',error=>result.errors.push('pageerror: '+error.message));
  page.on('response',response=>{if(response.status()>=400)result.errors.push('http '+response.status()+': '+response.url())});
  page.on('console',msg=>{if(msg.type()==='error')result.errors.push('console: '+msg.text())});
  await page.goto(host+'/iot/.studio-v2-surplus-r7-e2e.html',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.__r7?.ready===true,{timeout:60000});
  const initial=await page.evaluate(()=>{
    const a=window.__r7,c=a.runtime.getMaterialFlowSnapshot().surplusSilkCache;
    return {cache:c,palletCount:a.runtime.routeSlotArrayRuntime.getDiagnostics().plasticPallets};
  });
  assert.equal(initial.cache.capacity,100);
  assert.equal(initial.cache.free,100);
  assert.equal(initial.palletCount,108);
  const geometry = await page.evaluate(()=>window.__r7.diagnostics);
  result.structureErrors=geometry.filter(item=>item.severity==='error');
  result.geometryWarnings=geometry.filter(item=>item.severity==='warning').map(item=>({code:item.code,path:item.path,message:item.message}));
  result.warningBreakdown=Object.entries(result.geometryWarnings.reduce((counts,item)=>(counts[item.code]=(counts[item.code]||0)+1,counts),{})).map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count);
  result.stages.push({initialFree:initial.cache.free,initialPallets:initial.palletCount});
  await page.evaluate(()=>window.__r7.runtime.queueSurplusBobbin({bobbinId:'R7-SILK-001',batchNo:'R7-BATCH-01',originalTaskNo:'R7-OLD-TASK'}));
  const reserved=await page.evaluate(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache);
  assert.equal(reserved.reservedIn,1);
  assert.equal(reserved.occupied,0);
  await page.waitForFunction(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache.active?.phase==='transfer',{timeout:40000});
  const shot1=path.join(output,'01-robot-store-in-motion.png');
  await page.screenshot({path:shot1,fullPage:true});result.shots.push(shot1);
  await page.waitForFunction(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache.completedStores===1,{timeout:50000});
  const stored=await page.evaluate(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache);
  assert.equal(stored.occupied,1);
  assert.equal(stored.slots.find(s=>s.bobbin?.bobbinId==='R7-SILK-001').bobbin.originalTaskNo,'R7-OLD-TASK');
  result.stages.push({stored:true,occupied:stored.occupied,reservedIn:stored.reservedIn});
  const shot2=path.join(output,'02-stored-on-real-rack.png');
  await page.screenshot({path:shot2,fullPage:true});result.shots.push(shot2);
  assert.equal(await page.evaluate(()=>window.__r7.runtime.queueSurplusReuse('WRONG-BATCH','R7-NEW-TASK')),null);
  const reuse=await page.evaluate(()=>window.__r7.runtime.queueSurplusReuse('R7-BATCH-01','R7-NEW-TASK'));
  assert.equal(reuse.bobbin.bobbinId,'R7-SILK-001');
  const duplicate=await page.evaluate(()=>window.__r7.runtime.queueSurplusReuse('R7-BATCH-01','R7-DUPLICATE-TASK'));
  assert.equal(duplicate,null);
  await page.waitForFunction(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache.active?.kind==='reuse'&&window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache.active?.phase==='transfer',{timeout:50000});
  const shot3=path.join(output,'03-robot-retrieve-in-motion.png');
  await page.screenshot({path:shot3,fullPage:true});result.shots.push(shot3);
  await page.waitForFunction(()=>window.__r7.runtime.getMaterialFlowSnapshot().surplusSilkCache.completedReuses===1,{timeout:50000});
  const final=await page.evaluate(()=>{
    const a=window.__r7;
    return {cache:a.runtime.getMaterialFlowSnapshot().surplusSilkCache, samples:a.samples,palletSamples:a.palletSamples,
      palletCount:a.runtime.routeSlotArrayRuntime.getDiagnostics().plasticPallets,
      palletDiagnostics:a.runtime.routeSlotArrayRuntime.getDiagnostics(),
      firstCollisionDetails:a.firstCollisionDetails,errors:a.errors};
  });
  assert.equal(final.cache.occupied,0);
  assert.equal(final.cache.free,100);
  assert.equal(final.cache.completedStores,1);
  assert.equal(final.cache.completedReuses,1);
  assert.equal(final.palletCount,108);
  assert(final.palletSamples.length>=2,'Not enough 108-pallet collision samples');
  const baselineIds=final.palletSamples[0].ids;
  assert.equal(new Set(baselineIds).size,108,'Duplicate initial pallet IDs');
  for(const pallet of final.palletSamples) {
    assert.equal(pallet.ids.length,108,'Lost or newly manufactured loop pallets');
    assert.deepEqual(pallet.ids,baselineIds,'Loop pallet identity mutated');
  }
  result.palletIdentityChecks=final.palletSamples.length;
  result.minSampledPalletSpacingMeters=Math.min(...final.palletSamples.map(p=>p.minSpacing));
  result.maxSampledOverlapPairs=Math.max(...final.palletSamples.map(p=>p.overlapPairs));
  result.collisionSamples=final.palletSamples.filter(p=>p.overlapPairs>0).map(({at,minSpacing,collisions})=>({at,minSpacing,collisions}));
  result.firstCollisionDetails=final.firstCollisionDetails;
  result.completedPlasticLoops=final.palletDiagnostics.completedPlasticLoops||0;
  result.reusedPlasticPallets=final.palletDiagnostics.reusedPlasticPallets||0;
  assert.equal(result.maxSampledOverlapPairs,0,'Detected center spacing <1.5m during browser simulation');
  assert.equal(final.errors.length,0,'TwinRuntime errors: '+final.errors.join('; '));
  assert.equal(result.errors.length,0,'Browser errors: '+result.errors.join('; '));
  const moving=final.samples.map((s,i)=>i?Math.hypot(...s.xyz.map((p,j)=>p-final.samples[i-1].xyz[j])):0);
  const travel=moving.reduce((a,b)=>a+b,0);
  assert(travel>4,'Robot bobbin did not physically travel far enough: '+travel);
  assert(Math.max(...moving)<1.2,'Bobbin jumped between frames: '+Math.max(...moving));
  result.geometrySamples=final.samples.length;
  result.maxSampleDisplacementMeters=Math.max(...moving);
  result.totalTravelMeters=travel;
  result.stages.push({reused:true,finalFree:final.cache.free,finalPallets:final.palletCount});
  const shot4=path.join(output,'04-reused-returned-to-handoff.png');
  await page.screenshot({path:shot4,fullPage:true});result.shots.push(shot4);
  result.passed=true;
})().catch(error=>{result.passed=false;result.error=String(error?.stack||error);process.exitCode=1}).finally(async()=>{
  try{await browser?.close()}catch{}
  try{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2))}catch{}
  try{fs.unlinkSync(fixture)}catch{}
  try{fs.unlinkSync(payload)}catch{}
  console.log(JSON.stringify(result,null,2));
});
