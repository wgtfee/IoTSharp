import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPdmP3Evidence } from '../../../ClientApp/src/views/iot/pdm/Batch3P3EvidencePolicy.ts';

const good = () => ({
  deviceId: '11111111-2222-3333-4444-555555555555',
  profileId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  profileVersion: 2,
  state: 'StatisticsOnly',
  windowEndUtc: '2026-11-13T10:00:00Z',
  explanation: 'isolated statistics only',
  pointKey: 'bearing.rms',
  unit: 'mm/s',
  operatingMode: 'Running',
  robustDeviationScore: 2.3,
  baselineMedian: 2,
  baselineMad: 0.2,
  experimentSha256: 'a'.repeat(64),
  readOnly: true,
  isAlertDelivered: false,
  isWorkOrderCreated: false,
  failureProbability: null,
  remainingUsefulLifeHours: null,
});

test('verified read-only statistical payload may display statistics but not predictions', () => {
  const res=checkPdmP3Evidence(good());
  assert.equal(res.trustedStatistics,true);
  assert.equal(res.report?.robustDeviationScore,2.3);
});

test('a server payload carrying RUL or probability is never rendered as trustworthy', () => {
  for(const altered of [
    {...good(), failureProbability:0.99},
    {...good(), remainingUsefulLifeHours:24},
    {...good(), isWorkOrderCreated:true},
    {...good(), isAlertDelivered:true},
    {...good(), readOnly:false},
  ]) {
    const res=checkPdmP3Evidence(altered);
    assert.equal(res.trustedStatistics,false);
    assert.equal(res.report,null);
  }
});

test('missing provenance, non UTC, NaN or unknown status hides statistics', () => {
  for(const changed of [
    {...good(), experimentSha256:null},
    {...good(), operatingMode:null},
    {...good(), windowEndUtc:'2026-11-13T10:00:00+08:00'},
    {...good(), baselineMad:NaN},
    {...good(), robustDeviationScore:-4},
    {...good(), state:'FailurePredicted'},
  ]) {
    const res=checkPdmP3Evidence(changed);
    assert.equal(res.trustedStatistics,false);
    assert.equal(res.report,null);
  }
});

test('unverified payload removes any numerical metrics and experiment hash', () => {
  const res=checkPdmP3Evidence({...good(),state:'Unverified'});
  assert.equal(res.trustedStatistics,false);
  assert.equal(res.report?.robustDeviationScore,null);
  assert.equal(res.report?.baselineMedian,null);
  assert.equal(res.report?.experimentSha256,null);
});

