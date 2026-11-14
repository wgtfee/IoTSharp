import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createReadings, evaluateWindow, makeEventKey } from './replay-core.mjs';

const suite = JSON.parse(readFileSync(new URL('./fixtures/pilot-motor.synthetic.json', import.meta.url), 'utf8'));
const scenario = id => suite.scenarios.find(item => item.id === id).input;

function replayFromIsolatedSqlite(config, { reverse = false } = {}) {
  const records = createReadings(config);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE telemetry (tenant_id TEXT NOT NULL, device_id TEXT NOT NULL, key_name TEXT NOT NULL, event_utc TEXT NOT NULL, unit TEXT NOT NULL, reading REAL)');
    const insert = db.prepare('INSERT INTO telemetry VALUES (?,?,?,?,?,?)');
    const rows = reverse ? [...records.data].reverse() : records.data;
    for (const r of rows) insert.run(r.tenantId, r.deviceId, r.key, r.eventTimeUtc, r.unit, r.value);
    const loaded = db.prepare("SELECT tenant_id,device_id,key_name,event_utc,unit,reading FROM telemetry WHERE tenant_id=? AND device_id=?")
      .all('synthetic-tenant', 'synthetic-motor-001')
      .map(r => ({
        tenantId: r.tenant_id, deviceId: r.device_id, key: r.key_name,
        eventTimeUtc: r.event_utc, unit: r.unit, value: r.reading
      }));
    return evaluateWindow(loaded, records.stateRecords, records.endUtc);
  } finally { db.close(); }
}

test('P0 fixture has explicit synthetic provenance and stable UTC clock', () => {
  assert.equal(suite.provenance, 'synthetic-only');
  assert.equal(suite.clockUtc, '2026-11-12T08:15:00.000Z');
  assert.ok(suite.scenarios.length >= 6);
});

test('DQ-01: 15-minute normal window is good and traceable via isolated SQLite', () => {
  const result = replayFromIsolatedSqlite(scenario('DQ-01'));
  assert.equal(result.quality, 'Good');
  assert.equal(result.riskLevel, 'Normal');
  assert.equal(result.sampleCount, 15);
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.failureProbability, null);
  assert.equal(result.remainingUsefulLife, null);
});

test('DQ-02: missing readings never imply healthy', () => {
  const result = replayFromIsolatedSqlite(scenario('DQ-02'));
  assert.equal(result.quality, 'Insufficient');
  assert.equal(result.riskLevel, 'Unknown');
});

test('DQ-02: unit mismatch is explicitly blocked', () => {
  const r = createReadings({ ...scenario('DQ-01'), wrongUnitIndices: [5] });
  assert.equal(evaluateWindow(r.data, r.stateRecords, r.endUtc).quality, 'UnitMismatch');
});

test('DQ-02: NaN is invalid, and offline state overrides numeric data', () => {
  const r = createReadings({ ...scenario('DQ-01'), invalid: true });
  assert.equal(evaluateWindow(r.data, r.stateRecords, r.endUtc).quality, 'Invalid');
  assert.equal(evaluateWindow(r.data, r.stateRecords, r.endUtc, { online: false }).quality, 'Offline');
});

test('DQ-03: out-of-order and exact replay duplicates are deterministic', () => {
  const config = scenario('DQ-03');
  const reordered = replayFromIsolatedSqlite(config, { reverse: true });
  const ordered = replayFromIsolatedSqlite(config);
  assert.deepEqual(reordered, ordered);
  assert.equal(ordered.sampleCount, 15);
  assert.equal(ordered.quality, 'Good');
});

test('DQ-03: conflicting duplicates are Invalid rather than silently overwritten', () => {
  const r = createReadings({ ...scenario('DQ-01'), conflictingDuplicate: true });
  assert.equal(evaluateWindow(r.data, r.stateRecords, r.endUtc).quality, 'Invalid');
});

test('DQ-04: stopped equipment does not become falsely healthy', () => {
  const result = replayFromIsolatedSqlite(scenario('DQ-04'));
  assert.equal(result.quality, 'NotRunning');
  assert.equal(result.riskLevel, 'Unknown');
  assert.equal(result.healthScore, null);
});

test('DQ-04: without running-state signal there is insufficient evidence', () => {
  const r = createReadings(scenario('DQ-01'));
  assert.equal(evaluateWindow(r.data, [], r.endUtc).quality, 'Insufficient');
});

test('ALG-01: 15-minute persistent warming emits explainable trend attention', () => {
  const result = replayFromIsolatedSqlite(scenario('ALG-01'));
  assert.equal(result.quality, 'Good');
  assert.equal(result.riskLevel, 'Attention');
  assert.ok(result.slopePerMinute >= 0.4);
  assert.match(result.reasons.join('|'), /趋势|上升/);
});

test('EVT-01: repeated inference upserts a single event in isolated SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE pdm_risk_event (event_key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, occurrence_count INTEGER NOT NULL)');
    const key = makeEventKey({
      tenantId: 'synthetic-tenant', deviceId: 'synthetic-motor-001',
      riskType: 'temperature-trend', version: 'p0-contract-v1', episodeId: 'episode-0001'
    });
    const upsert = db.prepare('INSERT INTO pdm_risk_event VALUES (?,?,1) ON CONFLICT(event_key) DO UPDATE SET occurrence_count=occurrence_count+1');
    for (let i = 0; i < 5; i++) upsert.run(key, 'synthetic-tenant');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pdm_risk_event').get().count, 1);
    assert.equal(db.prepare('SELECT occurrence_count AS count FROM pdm_risk_event').get().count, 5);
  } finally { db.close(); }
});

test('EVT-01: changing episode changes idempotency key', () => {
  const base = { tenantId: 'a', deviceId: 'd', riskType: 'temperature-trend', version: 'v1' };
  assert.notEqual(makeEventKey({ ...base, episodeId: 'run1' }), makeEventKey({ ...base, episodeId: 'run2' }));
});

