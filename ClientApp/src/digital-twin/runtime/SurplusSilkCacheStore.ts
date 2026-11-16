/** Studio V2 余丝缓存领域状态机；实际机器人交接前只保留预约，不提前确认库存。 */
export interface SurplusSilkBobbin {
  bobbinId: string;
  batchNo: string;
  originalTaskNo: string;
  /** A known upstream pallet ID, otherwise the preview uses a visually isolated carrier. */
  carrierPalletId?: string;
}
export type SurplusSilkSlotState = 'empty' | 'storing' | 'occupied' | 'retrieving';
export interface SurplusSilkSlot { slotId: string; state: SurplusSilkSlotState; bobbin?: SurplusSilkBobbin }

export class SurplusSilkCacheStore {
  private readonly slots: SurplusSilkSlot[];
  /** 必须使用挂杆组件提供的独立编号，重复编号不能用于库存。 */
  constructor(slotIds: readonly string[]) {
    if (!slotIds.length || new Set(slotIds).size !== slotIds.length || slotIds.some(id => !id.trim())) throw new Error('余丝缓存槽位编号为空或重复');
    this.slots = slotIds.map(slotId => ({ slotId, state: 'empty' }));
  }
  /** 同一丝锭在预约、库存和出库过程中都只能存在一次。 */
  reserveStore(bobbin: SurplusSilkBobbin): string {
    const clean = { bobbinId: bobbin.bobbinId?.trim(), batchNo: bobbin.batchNo?.trim(), originalTaskNo: bobbin.originalTaskNo?.trim() };
    if (!clean.bobbinId || !clean.batchNo || !clean.originalTaskNo) throw new Error('缓存入库必须带丝锭 ID、批号和原任务号');
    if (this.slots.some(slot => slot.bobbin?.bobbinId === clean.bobbinId)) throw new Error(`丝锭 ${clean.bobbinId} 已占位或正在交接，禁止重复入库`);
    const free = this.slots.find(slot => slot.state === 'empty');
    if (!free) throw new Error('100 个挂杆缓存位全部已被占用或预约');
    free.bobbin = clean;
    free.state = 'storing';
    return free.slotId;
  }
  /** 只有机器人完成放杆动作，才能真正占位。 */
  commitStored(slotId: string, bobbinId: string) { this.assertTransition(slotId, 'storing', bobbinId).state = 'occupied'; }
  /** 同批号先进先出；正在出库的丝锭不得重复预约。 */
  reserveReuse(batchNo: string): { slotId: string; bobbin: SurplusSilkBobbin } | null {
    if (!batchNo?.trim()) throw new Error('余丝复用必须指定新任务批号');
    const slot = this.slots.find(item => item.state === 'occupied' && item.bobbin?.batchNo === batchNo.trim());
    if (!slot?.bobbin) return null;
    slot.state = 'retrieving';
    return { slotId: slot.slotId, bobbin: { ...slot.bobbin } };
  }
  /** 取回后才释放槽位，同时保留丝锭原始任务追溯。 */
  commitReused(slotId: string, bobbinId: string): SurplusSilkBobbin {
    const slot = this.assertTransition(slotId, 'retrieving', bobbinId), bobbin = { ...slot.bobbin! };
    slot.bobbin = undefined;
    slot.state = 'empty';
    return bobbin;
  }
  /** 故障只能撤销未完成预约，不得丢弃已确认库存。 */
  cancel(slotId: string, bobbinId: string) {
    const slot = this.slots.find(item => item.slotId === slotId);
    if (!slot || slot.bobbin?.bobbinId !== bobbinId) throw new Error('待取消预约与丝锭不一致');
    if (slot.state === 'storing') { slot.state = 'empty'; slot.bobbin = undefined; }
    else if (slot.state === 'retrieving') slot.state = 'occupied';
    else throw new Error('只能撤销尚未提交的入库/取料预约');
  }
  snapshot() {
    const slots = this.slots.map(slot => ({ ...slot, bobbin: slot.bobbin ? { ...slot.bobbin } : undefined }));
    return {
      capacity: slots.length, occupied: slots.filter(slot => slot.state === 'occupied').length,
      reservedIn: slots.filter(slot => slot.state === 'storing').length,
      reservedOut: slots.filter(slot => slot.state === 'retrieving').length,
      free: slots.filter(slot => slot.state === 'empty').length, slots
    };
  }
  private assertTransition(slotId: string, expected: SurplusSilkSlotState, bobbinId: string) {
    const slot = this.slots.find(item => item.slotId === slotId);
    if (!slot || slot.state !== expected || slot.bobbin?.bobbinId !== bobbinId) throw new Error(`杆位 ${slotId} 不处于 ${expected} 预约，禁止跳步或重复提交`);
    return slot;
  }
}
