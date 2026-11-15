// Studio V2 isolated UI smoke: real Vue + ThreeEditor + TwinRuntime in headless Edge.
// All API traffic is mocked inside Playwright; never writes a real scene or sends PLC commands.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.STUDIO_V2_PLAYWRIGHT_PATH || path.join(os.homedir(), '.ccpulse/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, '.studio-v2-e2e.html');
const output = path.resolve(process.env.STUDIO_V2_E2E_OUTPUT || path.join(os.tmpdir(), 'iotsharp-studio-v2-e2e'));
const port = Number(process.env.STUDIO_V2_E2E_PORT || 5191);
if (fs.existsSync(fixture)) throw new Error('已存在 Studio V2 测试入口，避免覆盖其他文件');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(fixture, [
	'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
	'<title>IoTSharp Studio V2 UI E2E</title></head><body style="margin:0"><div id="app"></div><script type="module">',
	"import { createApp } from 'vue';",
	"import { createRouter, createWebHistory } from 'vue-router';",
	"import ElementPlus from 'element-plus';",
	"import 'element-plus/dist/index.css';",
	"import StudioV2 from '/src/views/iot/digital-twin/studio-v2/index.vue';",
	"const router = createRouter({ history: createWebHistory('/iot/'), routes: [{ path: '/.studio-v2-e2e.html', component: StudioV2 }] });",
	"createApp(StudioV2).use(router).use(ElementPlus).mount('#app');",
	'</script></body></html>',
].join('\n'), 'utf8');

const checkPort = () => new Promise((resolve) => {
	const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
	socket.setTimeout(250);
	socket.on('timeout', () => { socket.destroy(); resolve(false); });
	socket.on('error', () => resolve(false));
});
const waitForServer = async (server) => {
	for (let i = 0; i < 120; i++) {
		if (await checkPort()) return;
		if (server.exitCode !== null) throw new Error('Vite 提前退出：' + server.exitCode);
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error('Vite 未在规定时间内启动');
};

(async () => {
	if (await checkPort()) throw new Error('测试端口已占用，不能借用或停止已有服务');
	const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
		cwd: root, windowsHide: true, env: { ...process.env, VITE_PORT: String(port), VITE_OPEN: 'false', VITE_OPEN_CDN: 'false', VITE_PUBLIC_PATH: '/iot/' }, stdio: ['ignore', 'pipe', 'pipe'],
	});
	const logs = [];
	server.stdout.on('data', data => logs.push(String(data)));
	server.stderr.on('data', data => logs.push(String(data)));
	let browser, failure;
	const steps = [], errors = [];
	const state = { scene: undefined, versions: [], models: [] };
	const respond = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: 10000, data }) });
	try {
		await waitForServer(server);
		browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
		const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 });
		page.setDefaultTimeout(30000);
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
		page.on('requestfailed', request => errors.push('request: ' + request.url() + ': ' + (request.failure()?.errorText || 'unknown')));
		await page.route('**/api/**', async (route) => {
			const request = route.request(), url = new URL(request.url()), originalPath = url.pathname.toLowerCase(), method = request.method();
			// Vite source modules at /iot/src/api/** must never be intercepted as backend API.
			if (!originalPath.startsWith('/api/') && !originalPath.startsWith('/iot/api/')) return route.continue();
			const pathname = originalPath.replace(/^\/api\/iot(?=\/)/, '/api').replace(/^\/iot\/api(?=\/)/, '/api');
			if (pathname === '/api/asset/list') return respond(route, { rows: [{ id: 'test-asset-001', name: '测试包装产线资产' }], total: 1 });
			if (pathname === '/api/digital-twin/model-resources' && method === 'GET') return respond(route, state.models);
			if (pathname.endsWith('/model-resources/components/upsert') && method === 'POST') {
				const data = request.postDataJSON();
				const model = { id: 'test-model-' + state.models.length, resourceKey: data.resourceKey, name: data.name, originalFileName: '', runtimeFormat: 'procedural-component', processingStatus: 'Ready', modelMetadata: { resourceType: 'procedural-component' } };
				state.models.push(model); return respond(route, model);
			}
			if (pathname.endsWith('/model-resources/components/batch') && method === 'POST') {
				const models = request.postDataJSON().map(item => {
					const existing = state.models.find(model => model.resourceKey === item.resourceKey);
					if (existing) return existing;
					const model = { id: 'test-model-' + state.models.length, resourceKey: item.resourceKey, name: item.name, originalFileName: '', runtimeFormat: 'procedural-component', processingStatus: 'Ready', modelMetadata: { resourceType: 'procedural-component' } };
					state.models.push(model); return model;
				});
				return respond(route, models);
			}
			if (pathname === '/api/digital-twin/scenes' && method === 'GET') return respond(route, state.scene ? [state.scene] : []);
			if (pathname === '/api/digital-twin/scenes' && method === 'POST') {
				const data = request.postDataJSON();
				state.scene = { id: 'test-scene-001', sceneKey: 'test-scene-001', name: data.name, description: data.description || '', rootAssetId: data.rootAssetId, rootAssetName: '测试包装产线资产', status: 'Draft', revision: 1, draftPayload: data.draftPayload, bindings: [], routes: [], actionFlows: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
				return respond(route, state.scene);
			}
			if (pathname === '/api/digital-twin/scenes/test-scene-001' && method === 'GET') return respond(route, state.scene);
			if (pathname.endsWith('/draft') && method === 'PUT' && state.scene) {
				const data = request.postDataJSON();
				if (data.revision !== state.scene.revision) return respond(route, { message: 'revision conflict' }, 409);
				state.scene.revision++; state.scene.draftPayload = data.payload; return respond(route, state.scene);
			}
			if (pathname.endsWith('/validate') && method === 'POST') return respond(route, { valid: true, diagnostics: [] });
			if (pathname.endsWith('/publish') && method === 'POST' && state.scene) {
				state.scene.publishedVersion = 1; state.scene.publishedSourceRevision = state.scene.revision; state.scene.status = 'Published';
				state.versions = [{ id: 'version-1', sceneId: state.scene.id, version: 1, sourceDraftRevision: state.scene.revision, isCurrent: true, manifestHash: 'mock-hash-not-production', changeSummary: 'Studio V2 test', createdAt: new Date().toISOString() }];
				return respond(route, { id: 'version-1', version: 1 });
			}
			if (pathname.endsWith('/versions') && method === 'GET') return respond(route, state.versions);
			if (pathname.endsWith('/versions/1') && method === 'GET') return respond(route, { version: 1, manifest: state.scene.draftPayload });
			if (pathname === '/api/digital-twin/runtime/snapshot' && method === 'POST') return respond(route, { updates: [], serverTimestamp: new Date().toISOString() });
			return respond(route, []);
		});
		const step = async (label, callback) => {
			let error;
			try { await callback(page); }
			catch (exception) { error = exception; throw exception; }
			finally {
				const screenshot = String(steps.length + 1).padStart(2, '0') + '.png';
				try { await page.screenshot({ path: path.join(output, screenshot), fullPage: true }); }
				catch { /* Browser may have closed; retain the test error. */ }
				steps.push({ label, passed: !error, error: error && String(error), screenshot });
			}
		};
		await step('加载独立 Vue 工作台与真实 WebGL 画布', async () => {
			await page.goto('http://127.0.0.1:' + port + '/iot/.studio-v2-e2e.html', { waitUntil: 'domcontentloaded' });
			try { await page.locator('.studio-v2').waitFor({ timeout: 30000 }); }
			catch (error) {
				throw new Error('Studio root not visible: url=' + page.url() + ', title=' + await page.title() + ', body=' + (await page.locator('body').innerText()).slice(0,1000) + ', errors=' + JSON.stringify(errors).slice(0,1200) + ', head=' + (await page.content()).slice(0,500) + ', original=' + error);
			}
			await page.locator('.studio-viewport canvas').first().waitFor({ timeout: 45000 });
			assert.equal(await page.locator('.studio-modes button').count(), 3);
			assert(await page.getByText('Digital Twin Studio', { exact: false }).count() > 0);
		});
		await step('新建场景并使用 IoTSharp 原有 API 契约', async () => {
			await page.getByRole('button', { name: '新建场景' }).click();
			await page.getByRole('dialog').getByRole('button', { name: '创建工程' }).click();
			await page.getByText('草稿 r1').waitFor();
			assert.equal(state.scene.rootAssetId, 'test-asset-001');
		});
		await step('参数化组件入库并进入 3D 场景', async () => {
			await page.locator('.studio-resource-tile').first().click();
			await page.getByText('1 对象', { exact: false }).waitFor();
			assert.equal(state.models.length, 1);
			assert.equal(state.scene.draftPayload.objects.length, 0, '尚未保存时数据库草稿不可被悄悄修改');
		});
		await step('工程诊断与仿真隔离', async () => {
			await page.getByRole('button', { name: '发布前校验' }).last().click();
			await page.getByText('尚未执行服务端校验').waitFor();
			await page.locator('.studio-modes button').filter({ hasText: '仿真运行' }).click();
			await page.locator('.studio-viewport-side').getByText('SIMULATION VIEW').waitFor();
			await page.locator('.studio-modes button').filter({ hasText: '实时监控' }).click();
			assert(await page.locator('.studio-viewport-side').getByText('SIMULATION VIEW').isVisible(), '未发布时不能切换 Live');
		});
		await step('返回设计并保存真实 Manifest 草稿', async () => {
			await page.locator('.studio-modes button').filter({ hasText: '设计编辑' }).click();
			await page.locator('.studio-viewport-side').getByText('ENGINEERING VIEW').waitFor();
			await page.locator('.studio-topbar').getByRole('button', { name: '保存草稿' }).click();
			try { await page.locator('.studio-topbar').getByText('草稿 r2', { exact: true }).waitFor({ timeout: 12000 }); }
			catch (error) { throw new Error('Save did not commit: backend revision=' + state.scene.revision + ', diagnostics=' + (await page.locator('.studio-quality-panel').innerText()).slice(0,1800) + ', alerts=' + (await page.locator('.el-message').allTextContents()).join('|') + ', status=' + (await page.locator('.studio-topbar').innerText()).slice(0,500) + '; ' + error); }
			assert.equal(state.scene.draftPayload.objects.length, 1, '组件必须通过草稿 API 持久化');
			assert.equal(state.scene.revision, 2, '草稿修订版本应原子增加');
		});
		await step('未完成路线保留草稿，但阻断服务端验收与发布', async () => {
			await page.getByRole('button', { name: '保存并运行服务端校验' }).click();
			await page.getByText('服务端未通过').waitFor();
			assert.equal(state.versions.length, 0);
		});
		await step('在独立编辑画布绘制路线控制点', async () => {
			await page.getByRole('button', { name: '编辑路线', exact: true }).click();
			await page.getByRole('button', { name: '绘制路线点' }).click();
			const canvas = page.locator('.studio-viewport canvas').first();
			const box = await canvas.boundingBox();
			assert(box && box.width > 100 && box.height > 100);
			await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.68);
			await page.mouse.click(box.x + box.width * 0.66, box.y + box.height * 0.62);
			await page.getByRole('button', { name: '结束绘制' }).click();
			await page.getByRole('button', { name: '结束路线编辑' }).click();
			assert(await page.locator('.studio-topbar').getByText('本地草稿未保存').isVisible());
		});
		await step('保存已完成拓扑并再次执行服务端工程校验', async () => {
			await page.locator('.studio-topbar').getByRole('button', { name: '保存草稿' }).click();
			await page.locator('.studio-topbar').getByText('草稿 r3', { exact: true }).waitFor();
			assert(state.scene.draftPayload.routes[0].points.length >= 2, '应真实创建至少 2 个路线控制点');
			await page.getByRole('button', { name: '保存并运行服务端校验' }).click();
			await page.getByText('服务端通过').waitFor();
		});
		await step('执行发布前校验并发布不可变版本', async () => {
			await page.locator('.studio-topbar').getByRole('button', { name: '校验并发布' }).click();
			await page.locator('.el-message-box .el-button--primary').click();
			await page.getByText('v1', { exact: true }).waitFor({ state: 'attached' });
			assert.equal(state.scene.publishedVersion, 1);
			assert.equal(state.versions.length, 1);
		});
		await step('Live 读取已发布 Manifest，并保持只读', async () => {
			await page.locator('.studio-modes button').filter({ hasText: '实时监控' }).click();
			await page.locator('.studio-viewport-side').getByText('LIVE VIEW / READ ONLY').waitFor();
			assert(await page.locator('.studio-topbar').getByRole('button', { name: '保存草稿' }).isDisabled());
			assert.equal(await page.locator('.studio-viewport canvas').count(), 1);
		});
		await step('历史版本回读', async () => {
			await page.locator('.studio-rail button[title="版本管理"]').click();
			await page.getByText('版本 v1').waitFor();
		});
		assert.deepEqual(errors, []);
		console.log(JSON.stringify({ passed: true, steps: steps.length, pageErrors: errors, output, mockedApis: true, realPlcCommands: 0 }, null, 2));
	} catch (error) { failure = error; throw error; }
	finally {
		if (browser) await browser.close();
		server.kill();
		fs.rmSync(fixture, { force: true });
		fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: !failure, steps, pageErrors: errors, mockedApis: true, databaseWritten: false, realPlcCommands: 0, failure: failure && String(failure), viteOutput: logs.slice(-10).join('').slice(-1500) }, null, 2));
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
