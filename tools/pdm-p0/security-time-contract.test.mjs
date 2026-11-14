import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = readFileSync(new URL('../../IoTSharp/Controllers/AlarmController.cs', import.meta.url), 'utf8');

function methodExcerpt(name) {
  const marker = 'public async Task<ApiResult<bool>> ' + name + '([FromBody] AlarmStatusDto m)';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, name + ' action must exist');
  const next = source.indexOf('public async Task<ApiResult<bool>>', start + marker.length);
  return source.slice(start, next < 0 ? undefined : next);
}

for (const method of ['AckAlarm', 'ClearAlarm']) {
  test('SEC-01: ' + method + ' explicitly requires authorization', () => {
    const marker = 'public async Task<ApiResult<bool>> ' + method;
    const signature = source.indexOf(marker);
    const leading = source.slice(Math.max(0, signature - 75), signature);
    assert.match(leading, /\[HttpPost\]\s*\[Authorize\]\s*$/);
  });
  test('SEC-02: ' + method + ' enforces Tenant and Customer in the database lookup', () => {
    const body = methodExcerpt(method);
    assert.match(body, /var profile = this\.GetUserProfile\(\);/);
    assert.match(body, /_context\.Alarms\.SingleOrDefaultAsync\(c => c\.Id == m\.Id\s*&& c\.Customer\.Id == profile\.Customer && c\.Tenant\.Id == profile\.Tenant\)/);
  });
}

test('SEC-03: isolated DB denies foreign tenant and customer, allows correct scope', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE alarm (id TEXT PRIMARY KEY, tenant TEXT, customer TEXT, status TEXT)');
    const insert = db.prepare('INSERT INTO alarm VALUES (?,?,?,?)');
    insert.run('own', 'tenant-A', 'customer-A', 'Active_UnAck');
    insert.run('foreign-tenant', 'tenant-B', 'customer-A', 'Active_UnAck');
    insert.run('foreign-customer', 'tenant-A', 'customer-B', 'Active_UnAck');
    const update = db.prepare('UPDATE alarm SET status = ? WHERE id = ? AND tenant = ? AND customer = ?');
    assert.equal(update.run('Active_Ack', 'own', 'tenant-A', 'customer-A').changes, 1);
    assert.equal(update.run('Active_Ack', 'foreign-tenant', 'tenant-A', 'customer-A').changes, 0);
    assert.equal(update.run('Active_Ack', 'foreign-customer', 'tenant-A', 'customer-A').changes, 0);
    assert.deepEqual(db.prepare('SELECT id FROM alarm WHERE status=?').all('Active_Ack').map(x => x.id), ['own']);
  } finally {
    db.close();
  }
});

test('TIME-01: UTC [begin,end) includes start but excludes end during DST', () => {
  const begin = Date.parse('2026-03-08T09:55:00.000Z');
  const end = Date.parse('2026-03-08T10:10:00.000Z');
  const stamps = ['2026-03-08T09:54:59.999Z','2026-03-08T09:55:00.000Z',
    '2026-03-08T10:00:00.000Z','2026-03-08T10:09:59.999Z',
    '2026-03-08T10:10:00.000Z'];
  const inRange = stamps.filter(s => Date.parse(s) >= begin && Date.parse(s) < end);
  assert.deepEqual(inRange, stamps.slice(1, 4));
});

test('TIME-02: local offset and UTC values refer to the same instant', () => {
  assert.equal(Date.parse('2026-11-12T08:00:00Z'), Date.parse('2026-11-12T16:00:00+08:00'));
});

test('TIME-03: do not accept ambiguous local time in proposed Provider adapter', () => {
  const isUtc = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
  assert.equal(isUtc('2026-11-12T08:00:00.000Z'), true);
  assert.equal(isUtc('2026-11-12T08:00:00'), false);
  assert.equal(isUtc('2026-11-12T16:00:00+08:00'), false);
});

