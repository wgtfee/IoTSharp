// 依赖外部共享 Playwright，不给业务项目增加浏览器测试包。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.MOTION_PLAYWRIGHT_PATH || path.join(os.homedir(), '.ccpulse/e2e/node_modules/playwright'));
const assert = require('node:assert/strict');
const output = path.resolve(process.env.MOTION_BROWSER_OUTPUT || '../runtime-logs/pick-place-browser');
fs.mkdirSync(output, { recursive: true });
(async () => {
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [], steps = [];page.on('pageerror', error => errors.push(error.message));
	const step = async (title, work) => { try { await work();steps.push({title,status:'passed',screenshot:`${steps.length+1}.png`}); } catch(error){steps.push({title,status:'failed',error:String(error),screenshot:`${steps.length+1}.png`});throw error;} finally {await page.screenshot({path:path.join(output,`${steps.length}.png`),fullPage:true});} };
	let failure;
	try {
		await step('打开工艺卡并验证缺项提示',async()=>{await page.goto(process.env.MOTION_BROWSER_URL || 'http://127.0.0.1:5186/iot/scripts/browser/pick-place.html');await page.getByRole('button',{name:'配置取放工艺',exact:true}).click();await page.getByRole('button',{name:'预览取放位置',exact:true}).click();await page.getByRole('alert').filter({hasText:'请选择不同的来源'}).waitFor();});
		await step('选择来源目标工具并预览世界位置',async()=>{for(const [label,value] of [['取料来源','source'],['放料目标','target'],['取放工具','actor · 工具']]){await page.getByRole('combobox',{name:label,exact:true}).press('Enter');await page.getByRole('option',{name:value,exact:true}).click();}await page.getByRole('button',{name:'预览取放位置',exact:true}).click();await page.getByText('0.4000 / 0.2000 / 0.0000',{exact:true}).waitFor();await page.getByText('机构未检查',{exact:true}).waitFor();});
		await step('填写实际轴约束并生成定时轨迹',async()=>{await page.getByRole('button',{name:'轴运动约束',exact:true}).click();for(const axis of ['x','y','z'])for(const [label,value] of [['速度','1'],['加速度','2'],['加加速度','10']])await page.getByLabel(`${axis} ${label}`,{exact:true}).fill(value);await page.getByRole('button',{name:'生成空载轨迹',exact:true}).click();await page.getByText('机构与时间约束通过',{exact:true}).waitFor();});
		await step('保存工艺并从 JSON 草稿重开',async()=>{await page.getByRole('button',{name:'保存为空载试运行工艺',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存 1 个工艺'}).waitFor();await page.getByRole('button',{name:'重开已保存草稿',exact:true}).click();await page.getByRole('status').filter({hasText:'重开成功：1 条轨迹'}).waitFor();});
		await step('重开的同一轨迹驱动实际仿真轴',async()=>{await page.getByRole('button',{name:'执行已保存轨迹',exact:true}).click();await page.getByRole('status').filter({hasText:'仿真执行完成：X=-0.4000 Y=0.3500'}).waitFor();});
		await step('外部场景修改使未提交工艺失效',async()=>{await page.getByRole('button',{name:'配置取放工艺',exact:true}).click();await page.evaluate(()=>window.invalidateMotionFixture());await page.getByText('场景已变化，请关闭后重新打开工艺卡。',{exact:true}).waitFor();});
		await step('配置桁架整托及层间隔板',async()=>{
			await page.getByRole('button',{name:'Close this dialog'}).click();await page.getByRole('button',{name:'载入码垛配置样例',exact:true}).click();await page.getByRole('button',{name:'配置取放工艺',exact:true}).click();
			for(const [label,value] of [['取料来源','source'],['放料目标','target'],['取放工具','actor · 工具']]){await page.getByRole('combobox',{name:label,exact:true}).press('Enter');await page.getByRole('option',{name:value,exact:true}).click();}
			await page.getByText('包含实际仿真物料交接',{exact:true}).click();assert(await page.getByRole('checkbox',{name:'包含实际仿真物料交接',exact:true}).isChecked());await page.getByLabel('本批物料数量',{exact:true}).fill('6');await page.getByText('按配方生成完整托盘工艺',{exact:true}).click();assert(await page.getByRole('checkbox',{name:'按配方生成完整托盘工艺',exact:true}).isChecked());
			for(const [label,value] of [['隔板策略','仅层间（8 层用 7 张）'],['隔板来源','隔板来源'],['隔板目标','层间隔板'],['隔板工具','隔板 TCP']]){await page.getByRole('combobox',{name:label,exact:true}).press('Enter');await page.getByRole('option',{name:value,exact:true}).click();}
			await page.getByRole('button',{name:'轴运动约束',exact:true}).click();for(const axis of ['x','y','z','bx','by','bz'])for(const [label,value] of [['速度','1'],['加速度','2'],['加加速度','10']])await page.getByLabel(`${axis} ${label}`,{exact:true}).fill(value);
		});
		await step('从第三层待补隔板处保存恢复工艺并重开',async()=>{
			await page.getByRole('button',{name:'从完整层边界恢复',exact:true}).click();await page.getByLabel('已完成主物料层数',{exact:true}).fill('3');await page.getByText('最后一个已完成层还需补隔板',{exact:true}).click();assert(await page.getByRole('checkbox',{name:'最后一个已完成层还需补隔板',exact:true}).isChecked());
			await page.getByRole('button',{name:'保存整托码垛工艺',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存 1 个工艺'}).waitFor();await page.getByRole('button',{name:'重开已保存草稿',exact:true}).click();await page.getByRole('status').filter({hasText:'重开成功：0 条轨迹'}).waitFor();
			const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('pick-place-browser-draft')));const flow=saved.actionFlows[0],plans=flow.nodes.filter(n=>n.type==='PlanPickPlace');
			assert.equal(flow.enabled,false);assert.equal(plans.length,10);assert.equal(plans[0].config.request.toolFrameId,'board-tcp');assert.equal(plans[0].config.request.expectedLayer,2);assert.equal(saved.materialSlots.find(s=>s.slotId==='target').stackPattern.separatorMode,'between-layers');
		});
		assert.deepEqual(errors,[]);
	} catch(error) {failure=error;}
	finally {
		await browser.close();
		fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({title:'取放工艺真实浏览器回归',tests:[{title:'配置、规划、保存重开与执行',status:failure?'failed':'passed',error:failure?String(failure):undefined,steps}],pageErrors:errors,databaseWritten:false},null,2));
		const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
		fs.writeFileSync(path.join(output,'report.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取放工艺浏览器回归</title><style>body{max-width:1000px;margin:auto;padding:24px;font:16px/1.7 system-ui;color:#253146;background:#f4f6f8}figure{margin:24px 0;padding:16px;background:white;border:1px solid #d7dde4;border-radius:8px}img{display:block;width:100%;height:auto}figcaption{font-weight:600;margin-bottom:12px}pre{white-space:pre-wrap;color:#a52a2a}</style><h1>取放工艺浏览器回归</h1><p>${failure?'未通过':'通过'} · ${steps.filter(s=>s.status==='passed').length}/${steps.length} 步 · ${new Date().toISOString()}</p><p>真实 Vue 工艺组件、规划器和仿真执行轴；隔离合成场景，使用本地 JSON 草稿。未连接数据库或现场设备。</p>${steps.map(s=>`<figure><figcaption>${escape(s.title)} · ${escape(s.status)}</figcaption>${s.error?`<pre>${escape(s.error)}</pre>`:''}<img src="${escape(s.screenshot)}" alt="${escape(s.title)}"></figure>`).join('')}</html>`);
	}
	if(failure)throw failure;console.log(JSON.stringify({passed:true,steps:steps.length,pageErrors:errors,report:path.join(output,'results.json'),databaseWritten:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
