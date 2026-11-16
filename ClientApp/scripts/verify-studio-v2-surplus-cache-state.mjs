// node --experimental-strip-types scripts/verify-studio-v2-surplus-cache-state.mjs
import assert from 'node:assert/strict';
import { SurplusSilkCacheStore } from '../src/digital-twin/runtime/SurplusSilkCacheStore.ts';

const slotIds = Array.from({ length: 100 }, (_, i) => `L${String(Math.floor(i / 20) + 1).padStart(2, '0')}-C${String(i % 20 + 1).padStart(2, '0')}`);
const store = new SurplusSilkCacheStore(slotIds);
assert.throws(() => new SurplusSilkCacheStore(['A', 'A']), /重复/);
assert.throws(() => store.reserveStore({bobbinId:'', batchNo:'B', originalTaskNo:'T'}), /必须/);
for (let i = 0; i < 100; i++) {
  const bobbin = { bobbinId: `S-${i}`, batchNo: i % 2 ? 'B02' : 'B01', originalTaskNo: `OLD-${i}` };
  assert.equal(store.reserveStore(bobbin), slotIds[i]);
  assert.throws(() => store.reserveStore(bobbin), /重复入库/);
  store.commitStored(slotIds[i], bobbin.bobbinId);
  assert.throws(() => store.commitStored(slotIds[i], bobbin.bobbinId), /禁止跳步/);
}
assert.equal(store.snapshot().occupied, 100);
assert.equal(store.snapshot().free, 0);
assert.throws(() => store.reserveStore({ bobbinId:'OVER', batchNo:'B01', originalTaskNo:'OLD' }), /全部/);
assert.equal(store.reserveReuse('NO-SUCH-BATCH'), null);
const first = store.reserveReuse('B01');
assert.equal(first?.slotId, 'L01-C01');
assert.equal(store.snapshot().reservedOut, 1);
assert.equal(store.reserveReuse('B01')?.slotId, 'L01-C03');
assert.throws(() => store.commitReused(first.slotId, 'WRONG'), /不处于/);
store.cancel(first.slotId, first.bobbin.bobbinId);
assert.equal(store.snapshot().occupied, 99);
assert.equal(store.reserveReuse('B01')?.slotId, first.slotId);
assert.equal(store.commitReused(first.slotId, first.bobbin.bobbinId).originalTaskNo, 'OLD-0');
assert.equal(store.snapshot().free, 1);
assert.throws(() => store.commitReused(first.slotId, first.bobbin.bobbinId), /禁止跳步/);
const next = store.reserveStore({ bobbinId:'NEXT', batchNo:'B02', originalTaskNo:'NEXT-TASK' });
assert.equal(next, first.slotId);
store.cancel(next, 'NEXT');
assert.equal(store.snapshot().free, 1);
assert.equal(new Set(store.snapshot().slots.filter(x => x.bobbin).map(x => x.bobbin.bobbinId)).size, 99);
console.log(JSON.stringify({passed:true, capacity:100, duplicateStoreBlocked:true, duplicateReuseBlocked:true, wrongBatchNotReused:true, fullRackBlocked:true, cancellationVerified:true, releasedSlotReusable:true}));
