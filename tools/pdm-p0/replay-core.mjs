// PdM P0 contract replay. Synthetic test data only; not production inference.
import { createHash } from 'node:crypto';

const MINUTE_MS = 60_000;
export function createReadings(scenario, clock = '2026-11-12T08:15:00.000Z') {
  const endMs = Date.parse(clock);
  const intervalMs = (scenario.intervalSeconds ?? 60) * 1000;
  const count = scenario.sampleCount ?? 15;
  const omitted = new Set(scenario.missingIndices ?? []);
  const data = [];
  for (let i = 0; i < count; i++) {
    if (omitted.has(i)) continue;
    data.push({
      tenantId: 'synthetic-tenant',
      deviceId: 'synthetic-motor-001',
      key: 'bearing_temperature',
      unit: (scenario.wrongUnitIndices ?? []).includes(i) ? 'F' : '°C',
      eventTimeUtc: new Date(endMs - (count - i) * intervalMs).toISOString(),
      value: Number((scenario.base ?? 52) + (scenario.slopePerMinute ?? 0.02) * i)
    });
  }
  if (scenario.conflictingDuplicate && data.length > 2) {
    data.push({ ...data[2], value: data[2].value + 20 });
  } else if (scenario.duplicate && data.length > 2) {
    data.push({ ...data[2] });
  }
  if (scenario.invalid && data.length > 3) data[3].value = Number.NaN;
  const stateRecords = [{
    tenantId: 'synthetic-tenant', deviceId: 'synthetic-motor-001',
    key: 'run_state', unit: 'bool',
    eventTimeUtc: new Date(endMs - intervalMs).toISOString(),
    value: scenario.stopped ? 0 : 1
  }];
  return { data, stateRecords, endUtc: clock };
}

function unknown(status, coverage, count, expected, reason) {
  return {
    quality: status, coverageRatio: coverage, sampleCount: count,
    expectedSamples: expected, healthScore: null, riskLevel: 'Unknown',
    anomalyScore: null, slopePerMinute: null,
    failureProbability: null, remainingUsefulLife: null, reasons: [reason]
  };
}

export function evaluateWindow(data, stateRecords, endUtc, {
  intervalSeconds = 60, windowMinutes = 15,
  pointKey = 'bearing_temperature', expectedUnit = '°C',
  minValue = -50, maxValue = 180, minCoverage = 0.8,
  trendThresholdPerMinute = 0.4, online = true
} = {}) {
  const end = Date.parse(endUtc);
  const start = end - windowMinutes * MINUTE_MS;
  const expected = Math.floor(windowMinutes * 60 / intervalSeconds);
  if (!Number.isFinite(end) || expected <= 0) throw new Error('invalid UTC window or interval');

  const samples = data.filter(r => r.key === pointKey)
    .filter(r => Number.isFinite(Date.parse(r.eventTimeUtc)))
    .filter(r => Date.parse(r.eventTimeUtc) >= start && Date.parse(r.eventTimeUtc) < end)
    .sort((a, b) => Date.parse(a.eventTimeUtc) - Date.parse(b.eventTimeUtc));
  const byTime = new Map();
  let conflict = false;
  for (const row of samples) {
    const time = Date.parse(row.eventTimeUtc);
    const prev = byTime.get(time);
    if (prev && (prev.value !== row.value || prev.unit !== row.unit)) conflict = true;
    else if (!prev) byTime.set(time, row);
  }
  const unique = [...byTime.values()];
  const coverage = Math.min(1, unique.length / expected);
  const reject = (status, reason) => unknown(status, coverage, unique.length, expected, reason);
  if (!online) return reject('Offline', '设备采集链离线');
  const states = stateRecords.filter(r => r.key === 'run_state' &&
    Number.isFinite(Date.parse(r.eventTimeUtc)) &&
    Date.parse(r.eventTimeUtc) >= start && Date.parse(r.eventTimeUtc) < end);
  if (!states.length) return reject('Insufficient', '缺少运行/停机工况信号');
  if (states.some(r => r.value !== 1)) return reject('NotRunning', '检测到停机或不可信工况');
  if (conflict) return reject('Invalid', '重复时间戳的数值冲突');
  if (unique.some(r => r.unit !== expectedUnit)) return reject('UnitMismatch', '单位不一致');
  if (unique.some(r => typeof r.value !== 'number' || !Number.isFinite(r.value))) return reject('Invalid', '无效数值');
  if (unique.some(r => r.value < minValue || r.value > maxValue)) return reject('OutOfRange', '值超出物理范围');
  if (coverage < minCoverage) return reject('Insufficient', '有效数据覆盖率不足');
  if (!unique.length || end - Date.parse(unique.at(-1).eventTimeUtc) > intervalSeconds * 2500) {
    return reject('Stale', '最新样本已过期');
  }
  const xs = unique.map(r => (Date.parse(r.eventTimeUtc) - start) / MINUTE_MS);
  const ys = unique.map(r => r.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const dx2 = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  const slope = dx2 ? xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) / dx2 : 0;
  const last = ys.slice(-3);
  const trending = last.length === 3 && last[0] < last[1] && last[1] < last[2] && slope >= trendThresholdPerMinute;
  return {
    quality: 'Good', coverageRatio: coverage, sampleCount: unique.length,
    expectedSamples: expected, mean: Number(meanY.toFixed(5)),
    slopePerMinute: Number(slope.toFixed(5)),
    riskLevel: trending ? 'Attention' : 'Normal',
    healthScore: null, anomalyScore: null,
    failureProbability: null, remainingUsefulLife: null,
    reasons: trending ? ['持续上升且趋势斜率超过配置门槛'] : []
  };
}
export function makeEventKey({ tenantId, deviceId, riskType, version, episodeId }) {
  if (![tenantId, deviceId, riskType, version, episodeId].every(Boolean)) throw new Error('missing event key dimension');
  return createHash('sha256').update(JSON.stringify([tenantId, deviceId, riskType, version, episodeId])).digest('hex');
}

