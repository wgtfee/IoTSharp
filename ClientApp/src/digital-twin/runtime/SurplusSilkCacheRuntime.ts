import * as THREE from 'three';
import { SurplusSilkCacheStore, type SurplusSilkBobbin } from './SurplusSilkCacheStore';

interface RackSlotGeometry { slotId: string; localPosition: [number, number, number] }
type HandoffPhase = 'conveyor-in' | 'approach' | 'grab' | 'lift' | 'transfer' | 'lower' | 'release' | 'retract' | 'conveyor-out';
interface MotionStep {
  phase: HandoffPhase;
  duration: number;
  gripperFrom: THREE.Vector3;
  gripperTo: THREE.Vector3;
  bobbinFrom?: THREE.Vector3;
  bobbinTo?: THREE.Vector3;
  carrying?: boolean;
  completion?: 'grab' | 'release' | 'out';
}
interface MotionJob {
  kind: 'store' | 'reuse';
  slotId: string;
  bobbin: SurplusSilkBobbin;
  targetTaskNo?: string;
  model: THREE.Group;
  steps: MotionStep[];
  stepIndex: number;
  elapsed: number;
  carrying: boolean;
}

/**
 * Studio V2 余丝缓存独立 Simulation 运行时。
 * 任务需由调用方明确提交丝锭/批号；不连接现场 PLC/MES，也不制造虚构结批事件。
 * 同一个丝锭模型沿交接辊道、机器人抓手、挂杆连续运动，库存变更在动作完成后提交。
 */
export class SurplusSilkCacheRuntime {
  readonly store: SurplusSilkCacheStore;
  private readonly root = new THREE.Group();
  private readonly slots = new Map<string, THREE.Vector3>();
  private readonly bobbinModels = new Map<string, THREE.Group>();
  private readonly pending: MotionJob[] = [];
  private active?: MotionJob;
  private readonly base: THREE.Vector3;
  private readonly standby: THREE.Vector3;
  private readonly storePickup: THREE.Vector3;
  private readonly reuseDrop: THREE.Vector3;
  private readonly inbound: THREE.Vector3;
  private readonly outbound: THREE.Vector3;
  private readonly armUpper: THREE.Mesh;
  private readonly armLower: THREE.Mesh;
  private readonly gripper: THREE.Group;
  private running = false;
  private completedStores = 0;
  private completedReuses = 0;
  private readonly events: string[] = [];

  constructor(scene: THREE.Scene, rack: THREE.Group, handoff: THREE.Group, robot: THREE.Group) {
    const slotMetadata = rack.userData.cacheSlots as RackSlotGeometry[] | undefined;
    if (!slotMetadata || slotMetadata.length !== 100) throw new Error('余丝缓存机器人需要已注册的100根可寻址挂杆');
    rack.updateWorldMatrix(true, false);
    for (const slot of slotMetadata) {
      if (!Array.isArray(slot.localPosition)) throw new Error(`挂杆 ${slot.slotId} 缺少实体坐标`);
      this.slots.set(slot.slotId, rack.localToWorld(new THREE.Vector3().fromArray(slot.localPosition)));
    }
    this.store = new SurplusSilkCacheStore(slotMetadata.map(slot => slot.slotId));
    handoff.updateWorldMatrix(true, false);
    robot.updateWorldMatrix(true, false);
    const handoffProperties = handoff.userData.properties as Record<string, unknown> | undefined;
    const laneSpacing = Number(handoffProperties?.laneSpacing);
    const handoffLength = Number(handoffProperties?.length);
    if (handoff.userData.laneCount !== 2 || handoff.userData.parallelLanes !== true
      || !handoff.getObjectByName('DoubleSmall-Lane-A')
      || !handoff.getObjectByName('DoubleSmall-Lane-B')
      || handoffProperties?.laneAReverse !== false || handoffProperties?.laneBReverse !== true
      || !Number.isFinite(laneSpacing) || laneSpacing < 1.63
      || !Number.isFinite(handoffLength) || handoffLength < 4) {
      throw new Error('机器人交接必须是物理双排辊道：内排 A 向右，外排 B 向左；单条辊道禁止仿真');
    }
    // The inner lane (-Z) receives surplus from the west. The outer lane (+Z)
    // returns reused silk west, so the robot uses separate physical handoff spots.
    const laneA = -laneSpacing / 2;
    const laneB = laneSpacing / 2;
    const leftEnd = -handoffLength / 2;
    this.storePickup = handoff.localToWorld(new THREE.Vector3(0, 1.12, laneA));
    this.reuseDrop = handoff.localToWorld(new THREE.Vector3(0, 1.12, laneB));
    this.inbound = handoff.localToWorld(new THREE.Vector3(leftEnd, 1.12, laneA));
    this.outbound = handoff.localToWorld(new THREE.Vector3(leftEnd, 1.12, laneB));
    this.base = robot.localToWorld(new THREE.Vector3(0, 1.2, 0));
    this.standby = robot.localToWorld(new THREE.Vector3(0, 2.8, 0));
    this.root.name = 'Simulation-Surplus-Silk-Cache-100-Slots';
    this.root.userData.simulationOnly = true;
    scene.add(this.root);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.55, roughness: 0.42 });
    this.armUpper = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.14, 1, 12), frameMaterial);
    this.armLower = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1, 12), frameMaterial);
    this.armUpper.name = 'CacheRobot-ContinuousUpperArm';
    this.armLower.name = 'CacheRobot-ContinuousForearm';
    this.gripper = new THREE.Group();
    this.gripper.name = 'CacheRobot-ContinuousGripper';
    const jawGeometry = new THREE.BoxGeometry(0.1, 0.35, 0.13);
    for (const offset of [-0.2, 0.2]) {
      const jaw = new THREE.Mesh(jawGeometry, frameMaterial);
      jaw.position.x = offset;
      jaw.position.y = -0.14;
      this.gripper.add(jaw);
    }
    this.root.add(this.armUpper, this.armLower, this.gripper);
    this.drawArm(this.standby);
  }

  /** 桁架结批事件应提供不可重复的丝锭 ID 及真实业务批号、任务号。 */
  queueStore(bobbin: SurplusSilkBobbin) {
    const slotId = this.store.reserveStore(bobbin);
    const slotPosition = this.slots.get(slotId)!;
    const model = this.createBobbin(bobbin, this.inbound);
    try {
      this.pending.push(this.createStoreJob(slotId, { ...bobbin }, slotPosition, model));
      this.record(`余丝入库预约 ${bobbin.bobbinId} / ${slotId} / ${bobbin.batchNo}`);
      return slotId;
    } catch (error) {
      this.store.cancel(slotId, bobbin.bobbinId);
      this.removeBobbin(bobbin.bobbinId);
      throw error;
    }
  }

  /** 新任务只允许按批号复用已经完成入库的丝锭。 */
  queueReuse(batchNo: string, targetTaskNo: string) {
    if (!targetTaskNo?.trim()) throw new Error('复用余丝必须带新任务号');
    const reserved = this.store.reserveReuse(batchNo);
    if (!reserved) return null;
    const model = this.bobbinModels.get(reserved.bobbin.bobbinId);
    if (!model) {
      this.store.cancel(reserved.slotId, reserved.bobbin.bobbinId);
      throw new Error('缓存库存与实体模型不一致，已阻止无模型取料');
    }
    this.pending.push(this.createReuseJob(reserved.slotId, reserved.bobbin, targetTaskNo.trim(), this.slots.get(reserved.slotId)!, model));
    this.record(`新任务 ${targetTaskNo} 预约同批余丝 ${reserved.bobbin.bobbinId} / ${reserved.slotId}`);
    return { ...reserved, targetTaskNo: targetTaskNo.trim() };
  }

  setRunning(running: boolean) { this.running = running; }

  /** 固定逻辑步驱动运动；暂停和帧率变化不改变预约与交接顺序。 */
  tick(deltaSeconds: number) {
    if (!this.running || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    if (!this.active) this.active = this.pending.shift();
    const job = this.active;
    if (!job) { this.drawArm(this.standby); return; }
    const step = job.steps[job.stepIndex];
    if (!step) { this.active = undefined; return; }
    job.elapsed = Math.min(step.duration, job.elapsed + deltaSeconds);
    const fraction = THREE.MathUtils.smoothstep(job.elapsed / step.duration, 0, 1);
    const gripperPosition = step.gripperFrom.clone().lerp(step.gripperTo, fraction);
    this.drawArm(gripperPosition);
    if (step.bobbinFrom && step.bobbinTo) job.model.position.copy(step.bobbinFrom).lerp(step.bobbinTo, fraction);
    else if (step.carrying || job.carrying) job.model.position.copy(gripperPosition).add(new THREE.Vector3(0, -0.32, 0));
    if (job.elapsed < step.duration - 0.000001) return;
    if (step.completion === 'grab') job.carrying = true;
    if (step.completion === 'release') {
      job.carrying = false;
      job.model.position.copy(job.kind === 'store' ? this.slots.get(job.slotId)! : this.reuseDrop);
      if (job.kind === 'store') {
        this.store.commitStored(job.slotId, job.bobbin.bobbinId);
        this.completedStores++;
        this.record(`入库完成 ${job.bobbin.bobbinId} → ${job.slotId}`);
      }
    }
    if (step.completion === 'out') {
      this.store.commitReused(job.slotId, job.bobbin.bobbinId);
      this.removeBobbin(job.bobbin.bobbinId);
      this.completedReuses++;
      this.record(`同批余丝交接完成 ${job.bobbin.bobbinId} → ${job.targetTaskNo}`);
    }
    job.stepIndex++;
    job.elapsed = 0;
    if (job.stepIndex >= job.steps.length) this.active = undefined;
  }

  snapshot() {
    return {
      ...this.store.snapshot(),
      running: this.running,
      queued: this.pending.length,
      active: this.active ? {
        kind: this.active.kind, bobbinId: this.active.bobbin.bobbinId, batchNo: this.active.bobbin.batchNo,
        slotId: this.active.slotId, phase: this.active.steps[this.active.stepIndex]?.phase || 'completed',
      } : null,
      completedStores: this.completedStores,
      completedReuses: this.completedReuses,
      handoffLanes: {
        laneA: { direction: 'east', inbound: this.inbound.toArray(), robot: this.storePickup.toArray() },
        laneB: { direction: 'west', robot: this.reuseDrop.toArray(), outbound: this.outbound.toArray() },
      },
      events: [...this.events],
    };
  }

  dispose() {
    for (const job of [...this.pending, ...(this.active ? [this.active] : [])]) {
      try { this.store.cancel(job.slotId, job.bobbin.bobbinId); } catch { /* 交接已经确认的库存不回滚 */ }
    }
    this.pending.length = 0;
    this.active = undefined;
    this.root.parent?.remove(this.root);
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material.dispose());
    });
    this.bobbinModels.clear();
  }

  private createStoreJob(slotId: string, bobbin: SurplusSilkBobbin, slot: THREE.Vector3, model: THREE.Group): MotionJob {
    const pickGrip = this.storePickup.clone().add(new THREE.Vector3(0, 0.32, 0));
    const pickAbove = this.storePickup.clone().setY(Math.max(3.8, slot.y + 1.6));
    const slotGrip = slot.clone().add(new THREE.Vector3(0, 0.32, 0));
    const slotAbove = slotGrip.clone().setY(pickAbove.y);
    const steps: MotionStep[] = [
      { phase:'conveyor-in', duration:1.3, gripperFrom:this.standby, gripperTo:this.standby, bobbinFrom:this.inbound, bobbinTo:this.storePickup },
      { phase:'approach', duration:0.8, gripperFrom:this.standby, gripperTo:pickGrip },
      { phase:'grab', duration:0.2, gripperFrom:pickGrip, gripperTo:pickGrip, completion:'grab' },
      { phase:'lift', duration:0.8, gripperFrom:pickGrip, gripperTo:pickAbove, carrying:true },
      { phase:'transfer', duration:1.6, gripperFrom:pickAbove, gripperTo:slotAbove, carrying:true },
      { phase:'lower', duration:0.8, gripperFrom:slotAbove, gripperTo:slotGrip, carrying:true },
      { phase:'release', duration:0.2, gripperFrom:slotGrip, gripperTo:slotGrip, carrying:true, completion:'release' },
      { phase:'retract', duration:0.8, gripperFrom:slotGrip, gripperTo:this.standby },
    ];
    return {kind:'store',slotId,bobbin,model,steps,stepIndex:0,elapsed:0,carrying:false};
  }

  private createReuseJob(slotId: string, bobbin: SurplusSilkBobbin, targetTaskNo: string, slot: THREE.Vector3, model: THREE.Group): MotionJob {
    const pickGrip = this.reuseDrop.clone().add(new THREE.Vector3(0, 0.32, 0));
    const pickAbove = this.reuseDrop.clone().setY(Math.max(3.8, slot.y + 1.6));
    const slotGrip = slot.clone().add(new THREE.Vector3(0, 0.32, 0));
    const slotAbove = slotGrip.clone().setY(pickAbove.y);
    const steps: MotionStep[] = [
      {phase:'approach',duration:1,gripperFrom:this.standby,gripperTo:slotAbove},
      {phase:'lower',duration:0.8,gripperFrom:slotAbove,gripperTo:slotGrip},
      {phase:'grab',duration:0.2,gripperFrom:slotGrip,gripperTo:slotGrip,completion:'grab'},
      {phase:'lift',duration:0.8,gripperFrom:slotGrip,gripperTo:slotAbove,carrying:true},
      {phase:'transfer',duration:1.6,gripperFrom:slotAbove,gripperTo:pickAbove,carrying:true},
      {phase:'lower',duration:0.8,gripperFrom:pickAbove,gripperTo:pickGrip,carrying:true},
      {phase:'release',duration:0.2,gripperFrom:pickGrip,gripperTo:pickGrip,carrying:true,completion:'release'},
      {phase:'retract',duration:0.6,gripperFrom:pickGrip,gripperTo:this.standby},
      {phase:'conveyor-out',duration:1.3,gripperFrom:this.standby,gripperTo:this.standby,bobbinFrom:this.reuseDrop,bobbinTo:this.outbound,completion:'out'},
    ];
    return {kind:'reuse',slotId,bobbin,targetTaskNo,model,steps,stepIndex:0,elapsed:0,carrying:false};
  }

  private createBobbin(bobbin: SurplusSilkBobbin, position: THREE.Vector3) {
    const model = new THREE.Group();
    model.name = `SurplusBobbin-${bobbin.bobbinId}`;
    model.userData = { ...bobbin, simulationOnly:true, materialEntityType:'surplus-silk-bobbin' };
    model.position.copy(position);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.32, 18), new THREE.MeshStandardMaterial({color:0xf1f5f9,roughness:0.83}));
    body.rotation.x = Math.PI / 2;
    body.castShadow = true;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.35, 16), new THREE.MeshStandardMaterial({color:0x64748b,metalness:0.55,roughness:0.5}));
    core.rotation.x = Math.PI / 2;
    model.add(body, core);
    this.root.add(model);
    this.bobbinModels.set(bobbin.bobbinId, model);
    return model;
  }

  private removeBobbin(bobbinId: string) {
    const model = this.bobbinModels.get(bobbinId);
    if (!model) return;
    model.parent?.remove(model);
    model.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        mats.forEach(mat => mat.dispose());
      }
    });
    this.bobbinModels.delete(bobbinId);
  }

  private drawArm(target: THREE.Vector3) {
    const elbow = this.base.clone().lerp(target, 0.48);
    elbow.y += Math.max(0.22, this.base.distanceTo(target) * 0.12);
    this.positionSegment(this.armUpper, this.base, elbow);
    this.positionSegment(this.armLower, elbow, target);
    this.gripper.position.copy(target);
  }
  private positionSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
    const direction = b.clone().sub(a);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
    mesh.scale.set(1, direction.length(), 1);
  }
  private record(message: string) {
    this.events.push(message);
    if (this.events.length > 30) this.events.shift();
  }
}
