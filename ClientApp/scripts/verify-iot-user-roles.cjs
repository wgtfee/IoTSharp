// Standalone zero-browser regression for Identity roles vs legacy route aliases.
// Run: node scripts/verify-iot-user-roles.cjs (from ClientApp).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const typescript = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../src/utils/iotRoles.ts'), 'utf8'
);
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const moduleObject = { exports: {} };
new Function('module', 'exports', compiled)(
  moduleObject, moduleObject.exports
);
const normalize = moduleObject.exports.normalizeIoTUserRoles;

assert.deepEqual(normalize('NormalUser'), ['normaluser', 'common']);
assert.deepEqual(normalize(['NormalUser,TenantAdmin']),
  ['normaluser', 'tenantadmin', 'common']);
assert.deepEqual(normalize('SystemAdmin,NormalUser'),
  ['systemadmin', 'normaluser', 'admin', 'common']);
assert.deepEqual(normalize('MaintenanceOperator'),
  ['maintenanceoperator', 'common']);
assert.deepEqual(normalize('ADMIN,COMMON,NormalUser'),
  ['normaluser', 'common']);
assert.deepEqual(normalize('admin,common'), []);
assert.deepEqual(normalize(null), []);
assert.deepEqual(normalize(''), []);
assert.deepEqual(normalize(['NormalUser', 'SystemAdmin', 'normaluser']),
  ['normaluser', 'systemadmin', 'admin', 'common']);
console.log('P1 Identity roles -> route aliases: 9 checks passed');
