import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// 直接执行生产 API/CRUD/错误解析代码；请求和界面提示为替身，不建立真实账号。
const bundle = await build({
  stdin: { contents: `export { errorMessage } from './src/utils/errorMessage'; export { accountApi } from './src/api/user'; export { createUserListCrudOptions } from './src/views/iot/settings/crudOptions/userListCrudOptions';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'test-boundaries', setup(context) {
    context.onResolve({ filter: /^(\/@\/utils\/request|element-plus|@fast-crud\/fast-crud)$/ }, args => ({ path: args.path, namespace: 'boundary' }));
    context.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: args.path === '/@/utils/request'
      ? `export default (config) => globalThis.__frontendErrorTest.request(config);`
      : args.path === 'element-plus' ? `export const ElMessage = { error: value => globalThis.__frontendErrorTest.messages.push(value) };`
      : `export const compute = fn => ({compute: fn}); export const dict = value => value;` }));
    context.onResolve({ filter: /^\/@\// }, args => {
      const source = path.resolve('src', args.path.slice(3));
      return { path: [`${source}.ts`, path.join(source, 'index.ts')].find(file => fs.existsSync(file)) || source };
    });
  }}],
});
const calls = [], messages = [];
let failure;
globalThis.__frontendErrorTest = { messages, request(config) { calls.push(config); return failure ? Promise.reject(failure) : Promise.resolve({code:10000, data:{}}); } };
try {
  const module = {exports:{}};
  new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const {errorMessage, accountApi, createUserListCrudOptions} = module.exports;
  for (const [input, expected] of [[undefined,'操作失败，请稍后重试'],[null,'操作失败，请稍后重试'],['失败','失败'],[new Error('普通错误'),'普通错误'],[{msg:'业务失败'},'业务失败'],[{response:{data:{msg:'接口失败'}}},'接口失败'],[{response:{statusText:'Forbidden'}},'Forbidden']]) assert.equal(errorMessage(input),expected);
  const form = {userName:'test-user',email:'test@example.invalid',password:'test-only-not-a-real-password'};
  await accountApi().postAccount({...form,customerId:'test-customer'});
  assert.equal(calls[0].url,'/api/Account/PostAccount'); assert.equal(calls[0].method,'post');
  const {crudOptions} = createUserListCrudOptions({expose:{}},'test-customer');
  assert.equal(await crudOptions.form.beforeSubmit({mode:'add',form}),true);
  assert.equal(crudOptions.columns.password.addForm.component.type,'password');
  assert(crudOptions.columns.password.addForm.rules.some(rule => rule.required));
  failure = {code:10008,msg:'没有权限'};
  await assert.rejects(crudOptions.request.addRequest({form}),error => error === failure);
  await assert.rejects(crudOptions.request.editRequest({form:{...form},row:{id:'user-id'}}),error => error === failure);
  await assert.rejects(crudOptions.request.delRequest({row:{id:'user-id'}}),error => error === failure);
  assert.equal(messages.at(-1),'没有权限');
  assert.equal(calls.find(call => call.url === '/api/Account/PostAccount').data.customerId,'test-customer');
  console.log('Frontend functional error regression PASS; request/UI test doubles; no database writes');
} finally { delete globalThis.__frontendErrorTest; }
