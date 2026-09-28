/**
 * 编译真实 Vue SFC 的 setup，使用真实 Vue 响应式验证编辑器状态机。
 * 仅 API、权限和浏览器生命周期为替身；不代表浏览器或 SQL Server 集成验收。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const vue = require('vue');
const fixture = {
  api: {}, messages: [], confirm: async () => 'confirm',
  user: { userInfos: { roles: ['admin'], authBtnList: [] } },
  route: vue.reactive({query:{}}),
};
globalThis.__twin2dTest = fixture;
const originalWindow = globalThis.window;
globalThis.window = { setInterval: () => 1, clearInterval() {} };
const mocks = {
  '/@/api/digital-twin': 'export const digitalTwinApi = globalThis.__twin2dTest.api;',
  '/@/api/asset': 'export const assetApi = () => ({relations: async () => ({data:{rows:[]}})});',
  '/@/stores/userInfo': 'export const useUserInfo = () => globalThis.__twin2dTest.user;',
  'vue-router': 'export const useRoute = () => globalThis.__twin2dTest.route; export const useRouter = () => ({push(){}}); export const onBeforeRouteLeave = () => {};',
  'element-plus': `export const ElMessage = Object.fromEntries(['success','error','warning','info'].map(level => [level, message => globalThis.__twin2dTest.messages.push({level,message})]));
    export const ElMessageBox = {confirm: (...args) => globalThis.__twin2dTest.confirm(...args)};`,
};
const compileComponent = async (filename) => {
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
const script = compileScript(descriptor, { id: 'twin2d-regression' });
const result = await build({
  stdin: { contents: script.content, loader: 'ts', resolveDir: path.dirname(filename), sourcefile: filename + '.ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vue'],
  plugins: [{
    name: 'component-test-boundaries',
    setup(context) {
      context.onResolve({ filter: /.*/ }, args => {
        if (mocks[args.path]) return { path: args.path, namespace: 'test-mock' };
        if (args.path.endsWith('.vue')) return { path: args.path, namespace: 'test-child' };
        if (args.path.startsWith('/@/')) {
          const base = path.resolve('src', args.path.slice(3));
          return { path: [base + '.ts', path.join(base, 'index.ts')].find(fs.existsSync) || base };
        }
      });
      context.onLoad({ filter: /.*/, namespace: 'test-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
      context.onLoad({ filter: /.*/, namespace: 'test-child' }, () => ({ contents: 'export default {};', loader: 'js' }));
    },
  }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  name => name === 'vue' ? { ...vue, onMounted() {}, onBeforeUnmount() {} } : require(name), module, module.exports
);
return module.exports.default;
};
const designerComponent=await compileComponent(path.resolve('src/digital-twin-2d/components/Twin2DProfessionalDesigner.vue'));
const viewerComponent=await compileComponent(path.resolve('src/views/iot/digital-twin/2d-viewer.vue'));
const scopes = [];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 6; i++) await vue.nextTick(); };
const clone = value => JSON.parse(JSON.stringify(value));
const setup = () => {
  fixture.messages.length = 0;
  fixture.route=vue.reactive({query:{}});
  fixture.confirm = async () => 'confirm';
  for (const key of Object.keys(fixture.api)) delete fixture.api[key];
  fixture.api.snapshot = async () => ({data:{updates:[]}});
  fixture.api.validateScene = async () => ({data:{diagnostics:[]}});
  const scope = vue.effectScope(); scopes.push(scope);
  const c = scope.run(() => designerComponent.setup({}, { expose() {} }));
  const manifest = clone(c.manifest.value);
  Object.assign(manifest, {name:'2D regression', rootAssetId:'11111111-1111-4111-8111-111111111111', objects:[], resources:[], routes:[], bindings:[], connections:[], actionFlows:[], materialSlots:[], interlocks:[]});
  const scene = {id:'scene-a', name:manifest.name, rootAssetId:manifest.rootAssetId, revision:4, publishedVersion:2, draftPayload:manifest};
  c.currentScene.value = clone(scene); c.selectedSceneId.value = scene.id;
  c.manifest.value = clone(manifest); c.resetHistory();
  return {c, scene};
};
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

try {
  await test('saving keeps edits made while request is pending and adopts server revision', async () => {
    const {c,scene} = setup(), pending = deferred(); let gets = 0;
    fixture.api.saveDraft = () => pending.promise;
    fixture.api.getScene = async () => { gets++; return {data:clone(scene)}; };
    const saving = c.saveDraft();
    c.manifest.value.name = 'newer local edit'; c.commit();
    c.selectedSceneId.value = 'scene-b'; await c.requestSceneChange('scene-b');
    assert.equal(c.selectedSceneId.value, 'scene-a');
    pending.resolve({data:{...clone(scene),revision:5}}); await saving;
    assert.equal(c.currentScene.value.revision, 5);
    assert.equal(c.manifest.value.name, 'newer local edit');
    assert.equal(c.dirty.value, true); assert.equal(gets,0);
    fixture.api.saveDraft = async (_id,rev,payload) => {
      assert.equal(rev,5); return {data:{...clone(scene),revision:6,draftPayload:clone(payload)}};
    };
    await c.saveDraft(); assert.equal(c.dirty.value,false);
    assert.equal(c.currentScene.value.revision,6);
  });
  await test('late scene response cannot replace a newer scene', async () => {
    const {c,scene} = setup(), a=deferred(), b=deferred();
    fixture.api.getScene = id => id==='scene-a' ? a.promise : b.promise;
    const loadA=c.loadScene(); c.selectedSceneId.value='scene-b'; const loadB=c.loadScene();
    b.resolve({data:{...clone(scene),id:'scene-b',draftPayload:{...clone(scene.draftPayload),name:'B'}}});
    await loadB;
    a.resolve({data:clone(scene)}); await loadA;
    assert.equal(c.currentScene.value.id,'scene-b'); assert.equal(c.manifest.value.name,'B');
    assert.equal(c.loading.value,false);
  });
  await test('published preview is read only and restores unsaved draft', async () => {
    const {c,scene} = setup();
    c.manifest.value.name='unsaved draft'; c.commit();
    fixture.api.getVersion=async () => ({data:{manifest:{...clone(scene.draftPayload),name:'published'}}});
    c.mode.value='runtime'; await flush();
    assert.equal(c.manifest.value.name,'published'); assert.equal(c.canEditScene.value,false);
    c.addLibraryItem(c.allLibrary.value[0],100,100); assert.equal(c.view.value.objects.length,0);
    c.mode.value='design'; await flush();
    assert.equal(c.manifest.value.name,'unsaved draft'); assert.equal(c.dirty.value,true);
    assert.equal(c.runtimeLoading.value,false);
    c.stopPolling();
  });
  await test('cancelling preview does not clear the next scene loading state', async () => {
    const {c,scene}=setup(), preview=deferred(), loading=deferred();
    fixture.api.getVersion=() => preview.promise;
    c.mode.value='runtime'; await flush(); assert.equal(c.runtimeLoading.value,true);
    fixture.api.getScene=() => loading.promise;
    c.selectedSceneId.value='scene-b'; const next=c.loadScene(); await flush();
    assert.equal(c.loading.value,true); assert.equal(c.runtimeLoading.value,false);
    preview.resolve({data:{manifest:{...clone(scene.draftPayload),name:'obsolete preview'}}}); await flush();
    assert.equal(c.loading.value,true);
    loading.resolve({data:{...clone(scene),id:'scene-b'}}); await next;
    assert.equal(c.currentScene.value.id,'scene-b'); assert.equal(c.loading.value,false);
  });
  await test('invalid import leaves current draft unchanged', async () => {
    const {c}=setup(), before=JSON.stringify(c.snapshot());
    await c.importManifest({target:{value:'file.json',files:[{text:async ()=>'{"objects":"broken"}'}]}});
    assert.equal(JSON.stringify(c.snapshot()),before);
    assert(fixture.messages.some(item=>item.level==='error'));
  });
  await test('delayed import cannot replace edits made while file is read', async () => {
    const {c,scene}=setup(), file=deferred();
    const importing=c.importManifest({target:{value:'file.json',files:[{text:()=>file.promise}]}});
    c.manifest.value.name='keep this edit'; c.commit();
    file.resolve(JSON.stringify(scene.draftPayload)); await importing;
    assert.equal(c.manifest.value.name,'keep this edit'); assert.equal(c.dirty.value,true);
  });
  await test('dialog shortcuts do not delete canvas objects and canvas Delete still works', async () => {
    const {c}=setup();
    c.addLibraryItem(c.allLibrary.value[0],500,600);
    assert.deepEqual(clone(c.manifest.value.objects[0].transform.position),[0,0,0]);
    c.designerRoot.value={contains:()=>true};
    const event={key:'Delete',target:{tagName:'DIV',closest:()=>null},preventDefault(){},stopPropagation(){}};
    c.flowDesignerVisible.value=true; c.onKey(event);
    assert.equal(c.view.value.objects.length,1);
    c.flowDesignerVisible.value=false; c.onKey(event);
    assert.equal(c.view.value.objects.length,0);
  });
  await test('multi-selection drag retains the group and respects locks', async () => {
    const {c}=setup();
    c.addLibraryItem(c.allLibrary.value[0],100,100);
    c.addLibraryItem(c.allLibrary.value[0],400,100);
    c.selectedObjectIds.value=c.view.value.objects.map(item=>item.id);
    c.canvas.value={focus(){},setPointerCapture(){},getScreenCTM:()=>({inverse:()=>({})}),createSVGPoint:()=>({x:0,y:0,matrixTransform(){return {x:this.x,y:this.y};}})};
    c.onObjectDown({button:0,pointerId:1,clientX:100,clientY:100,preventDefault(){}},c.view.value.objects[0]);
    assert.equal(c.interaction.value.objects.length,2); assert.equal(c.selectedObjectIds.value.length,2);
    const originalX=c.view.value.objects.map(item=>item.x);
    c.onCanvasMove({pointerId:1,clientX:140,clientY:100});
    assert.equal(c.view.value.objects[0].x-originalX[0],c.view.value.objects[1].x-originalX[1]);
    c.finishInteraction();
    c.view.value.objects[1].locked=true;
    c.onObjectDown({button:0,pointerId:2,clientX:100,clientY:100,preventDefault(){}},c.view.value.objects[0]);
    assert.equal(c.interaction.value.objects.length,1);
    c.finishInteraction();
  });
  await test('publish rejects a manifest changed after validation', async () => {
    const {c}=setup(); let published=0;
    fixture.api.publishScene=async()=>{published++;};
    fixture.confirm=async()=>{c.manifest.value.name='changed during confirmation'; return 'confirm';};
    await c.publishScene();
    assert.equal(published,0); assert.equal(c.publishing.value,false);
    assert(fixture.messages.some(item=>item.level==='warning' && item.message.includes('场景在校验后发生修改')));
  });
  await test('snapshot failure marks data stale and polling recovers', async () => {
    const {c}=setup();
    c.polling.value=true;
    c.runtimeUpdates.value=[{bindingId:'id',bindingKey:'run',quality:'good',stale:false,value:true}];
    fixture.api.snapshot=async()=>{throw new Error('offline');};
    await c.pollSnapshot();
    assert.equal(c.polling.value,true); assert.equal(c.runtimeUpdates.value[0].stale,true);
    fixture.api.snapshot=async()=>({data:{updates:[{bindingKey:'run',quality:'good',stale:false,value:false}]}});
    await c.pollSnapshot(); assert.equal(c.pollError.value,''); assert.equal(c.runtimeUpdates.value[0].stale,false);
    c.stopPolling();
  });
  await test('Viewer switches version in-place and ignores obsolete published response', async () => {
    const {scene}=setup(), old=deferred();
    fixture.route.query={sceneId:'scene-a',version:'2'};
    fixture.api.getScene=async()=>({data:clone(scene)});
    fixture.api.getVersion=(_id,version)=>version===2 ? old.promise : Promise.resolve({data:{manifest:{...clone(scene.draftPayload),name:'Version 3'}}});
    const scope=vue.effectScope(); scopes.push(scope);
    const v=scope.run(()=>viewerComponent.setup({}, {expose(){}}));
    const initial=v.load(); await flush();
    fixture.route.query.version='3'; await flush();
    assert.equal(v.versionNo.value,3); assert.equal(v.title.value,'Version 3');
    old.resolve({data:{manifest:{...clone(scene.draftPayload),name:'obsolete Version 2'}}}); await initial;
    assert.equal(v.versionNo.value,3); assert.equal(v.title.value,'Version 3');
    fixture.route.query.version='invalid'; await flush();
    assert.equal(v.manifest.value,undefined); assert.equal(v.polling.value,false);
    assert(v.errorText.value.includes('正整数'));
    v.stopPolling();
  });
  console.log('IoTSharp 2D component regression PASS: ' + passed + ' cases (mock API, real Vue setup).');
} finally {
  for (const scope of scopes) scope.stop();
  globalThis.window=originalWindow;
  delete globalThis.__twin2dTest;
}
