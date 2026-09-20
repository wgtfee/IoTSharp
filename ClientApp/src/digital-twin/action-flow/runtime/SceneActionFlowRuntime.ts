import * as THREE from 'three';
import type { TwinBehaviorActionDefinition, TwinSceneManifest } from '../../contracts';
import { BehaviorRuntime } from '../../runtime/BehaviorRuntime';
import { compileActionFlow } from '../compiler/ActionFlowCompiler';
import type { TwinActionFlowDefinitionV2, TwinActionFlowNode } from '../contracts/action-flow-v2';
import { SimulationFlowRuntime, type FlowNodeExecutionContext, type FlowNodeExecutionResult } from './SimulationFlowRuntime';

const primitives: Record<string, TwinBehaviorActionDefinition['kind']> = {
	MoveTo: 'moveTo', MovePose: 'movePose', JointMove: 'jointMove', AxisMove: 'axisMove', Home: 'home',
	GripOpen: 'gripOpen', GripClose: 'gripClose', Attach: 'attach', Detach: 'detach', Pick: 'pick', Place: 'place', PrepareSlot: 'prepareSlot',
};
interface StationLease { owner: string; actorId: string; group: string; palletIds: string[]; cycle: number }
interface FlowEntry { definition: TwinActionFlowDefinitionV2; runtime: SimulationFlowRuntime; cycles: number }

/**
 * 三维场景图执行桥。图解释器唯一决定下一节点；旧 Behavior 调度完全禁用。
 * 底层只复用运动学、物料挂接、库存恢复原语，不识别产线名/设备 ID/工艺顺序。
 */
export class SceneActionFlowRuntime {
	private readonly motion: BehaviorRuntime;
	private readonly entries: FlowEntry[] = [];
	private readonly leases = new Map<string, StationLease>();
	private readonly actorOwners = new Map<string, string>();
	private running = false;
	private fault?: string;
	private actorFilter?: string;
	constructor(private readonly manifest: TwinSceneManifest, private readonly scene: THREE.Scene,
		private readonly getRoot: (id: string) => THREE.Object3D | undefined,
		private readonly reportError?: (message: string) => void,
		applyActuatorCommand?: (id: string, value: number | boolean, speedRatio?: number) => boolean,
		private readonly selectRoute?: (routeId: string, palletIds: string[], junctionId: string, edgeId: string) => void,
		private readonly holdActor?: (actorId: string) => void) {
		if (applyActuatorCommand && !holdActor) throw new Error('接入外部执行轴时必须提供保持/停止接口，禁止仅停止流程却继续运动');
		this.motion = new BehaviorRuntime({ ...manifest, behaviors: [] }, scene, getRoot, reportError, applyActuatorCommand);
		for (const definition of manifest.actionFlows || []) {
			if (definition.enabled === false || definition.policies.executionTarget !== 'scene') continue;
			const plan = compileActionFlow(definition, manifest);
			const entry = { definition: structuredClone(definition), cycles: 0 } as FlowEntry;
			entry.runtime = new SimulationFlowRuntime(plan, {
				executeNode: (node, dt, context) => this.execute(entry, node, dt, context),
				resolveValue: (source, ref) => source === 'binding' ? this.motion.readSemanticValue(`binding:${ref}`) : this.readValue(entry, ref),
				onNodeInterrupted: node => { if(node.actorObjectId && this.actorOwners.get(node.actorObjectId)?.startsWith(`${definition.flowId}/`)) this.holdActor?.(node.actorObjectId); },
			});
			this.entries.push(entry);
		}
	}
	setRunning(value: boolean) {
		this.running = value && !this.fault && this.manifest.runtime.dataMode === 'simulation';
		this.motion.setRunning(this.running);
		for (const entry of this.entries) {
			if (this.running) { entry.runtime.start(); entry.runtime.resume(); }
			else entry.runtime.pause();
		}
	}
	setActorFilter(id?: string) { this.actorFilter = id; this.motion.setActorFilter(id); }
	getFault() { return this.fault; }
	setBindingContext(context: Parameters<BehaviorRuntime['setBindingContext']>[0]) { this.motion.setBindingContext(context); this.prepareMotionTick(); }
	/** 必须在外部轴插值之前调用，防止联锁撤销后仍走一个旧目标步长。 */
	prepareMotionTick() {
		for (const entry of this.entries) for (const id of entry.runtime.getExecutionState().activeNodeIds) {
			const node = entry.definition.nodes.find(n=>n.nodeId===id), actor = node?.actorObjectId;
			if (!actor || !this.actorOwners.get(actor)?.startsWith(`${entry.definition.flowId}/`)) continue;
			const guards = Array.isArray(node!.config.interlockIds) ? node!.config.interlockIds.map(String) : [];
			if (guards.some(id=>!this.motion.checkInterlock(id))) this.holdActor?.(actor);
		}
	}
	updateFixed(dt: number) {
		if (!this.running || !Number.isFinite(dt) || dt <= 0) return;
		for (const entry of this.entries) {
			if (this.actorFilter && !entry.definition.actorObjectIds.includes(this.actorFilter)) continue;
			entry.runtime.tick(dt);
			const state = entry.runtime.getExecutionState();
			if (state.state === 'Faulted') {
				this.fault = `${entry.definition.name}：${state.fault}`;
				for (const actor of this.actorOwners.keys()) this.holdActor?.(actor);
				this.setRunning(false); this.reportError?.(this.fault); return;
			}
		}
		this.motion.updateFixed(dt);
	}
	reset(options: { restoreMaterials?: boolean } = {}) {
		this.motion.reset(options); this.leases.clear(); this.actorOwners.clear(); this.fault = undefined;
		for (const entry of this.entries) { entry.runtime.reset(); entry.cycles = 0; }
		this.setRunning(this.running);
	}
	getSnapshot(eventLimit = 0) {
		return { ...this.motion.getSnapshot(), engine: 'action-flow-v2' as const, fault: this.fault,
			flows: this.entries.map(entry => ({ ...entry.runtime.getSnapshot(eventLimit), name: entry.definition.name, cycles: entry.cycles })) };
	}
	getObjectDetail(id: string) { return { actionFlows: this.getSnapshot().flows.filter(f => this.entries.find(e => e.definition.flowId === f.flowId)?.definition.actorObjectIds.includes(id)) }; }
	dispose() { this.setRunning(false); for (const entry of this.entries) entry.runtime.cancel(); this.motion.dispose(); this.leases.clear(); this.actorOwners.clear(); }

	private pallet(id: string) {
		let found: THREE.Object3D | undefined;
		this.scene.traverse(node => { if (node.userData.twinEntityType === 'route-slot-pallet' && String(node.userData.twinEntityId) === id) found = node; });
		return found;
	}
	private readValue(entry: FlowEntry, ref: string): unknown {
		if (ref.startsWith('station.')) {
			const lease = [...this.leases.values()].find(l => l.owner.startsWith(`${entry.definition.flowId}/`));
			if (!lease) return undefined;
			const pallets = lease.palletIds.map(id => this.pallet(id)).filter(Boolean) as THREE.Object3D[];
			if (ref === 'station.routeCode') return pallets[0]?.userData.routeCode;
			if (ref === 'station.materialCount') {
				let count = 0; for (const pallet of pallets) pallet.traverse(n => { if (n.userData.materialEntity && !n.userData.materialAttachedBy) count++; }); return count;
			}
			if (ref === 'station.palletCount') return pallets.length;
		}
		return this.motion.readSemanticValue(ref);
	}
	private execute(entry: FlowEntry, node: TwinActionFlowNode, dt: number, context: FlowNodeExecutionContext): FlowNodeExecutionResult | undefined {
		const config = node.config, actorId = node.actorObjectId || '', owner = `${entry.definition.flowId}/${context.tokenId}`;
		const root = actorId ? this.getRoot(actorId) : undefined;
		const guards = Array.isArray(config.interlockIds) ? config.interlockIds.map(String) : [];
		if (guards.some(id => !this.motion.checkInterlock(id))) { if (actorId && this.actorOwners.get(actorId) === owner) this.holdActor?.(actorId); return 'waiting-signal'; }
		const lease = actorId ? this.leases.get(actorId) : undefined;
		if (node.type === 'WaitStation') {
			if (!root) throw new Error('等待到位节点缺少执行对象');
			const ids = (Array.isArray(root.userData.stationPalletIds) ? root.userData.stationPalletIds : []).map(String);
			const group = String(config.completionGroup || '');
			const needed = Number(root.userData.stationBehaviorRequirements?.[group] || 1);
			if (!ids.length || Number(root.userData.stationCompletedGroupCounts?.[group] || 0) >= needed) return 'waiting-signal';
			if ((lease && lease.owner !== owner) || (this.actorOwners.has(actorId) && this.actorOwners.get(actorId) !== owner)) return 'waiting-resource';
			this.leases.set(actorId, { owner, actorId, group, palletIds: ids, cycle: Number(root.userData.completedBatchCount || 0) });
			root.userData.stationFlowOwner = owner; root.userData.processPhase = 'action-flow';
			this.actorOwners.set(actorId, owner); return 'success';
		}
		if (['CompleteStation', 'MarkMaterial', 'SelectRoute'].includes(node.type)) {
			if (!root || !lease || lease.owner !== owner || lease.cycle !== Number(root.userData.completedBatchCount || 0)
				|| JSON.stringify(lease.palletIds) !== JSON.stringify((root.userData.stationPalletIds || []).map(String))) throw new Error('当前工位批次不属于本流程，禁止标记或放行');
			if (node.type === 'MarkMaterial') {
				for (const id of lease.palletIds) this.pallet(id)?.traverse(n => { if (n.userData.materialEntity) {
					n.userData.materialStage = String(config.stage);
					n.userData.processHistory = [...new Set([...(n.userData.processHistory || []), String(config.stage)])];
				} });
				return 'success';
			}
			if (node.type === 'SelectRoute') {
				if (!this.selectRoute) throw new Error('未接入逐托盘路线选择能力');
				this.selectRoute(String(config.routeId), lease.palletIds, String(config.junctionPointId), String(config.edgeId)); return 'success';
			}
			if (String(config.completionGroup) !== lease.group) throw new Error('到位与放行组不一致');
			if (this.motion.hasHeldPayload(`${owner}/${actorId}`)) throw new Error('夹具仍挂载物料，禁止释放当前工位');
			root.userData.stationCompletedGroupCounts ||= {};
			root.userData.stationCompletedGroupCounts[lease.group] = Number(root.userData.stationCompletedGroupCounts[lease.group] || 0) + 1;
			root.userData.stationCompletedGroups = [...new Set([...(root.userData.stationCompletedGroups || []), lease.group])];
			root.userData.stationLastCompletedFlowId = entry.definition.flowId;
			delete root.userData.stationFlowOwner; root.userData.processProgress = 1;
			this.leases.delete(actorId); this.actorOwners.delete(actorId); entry.cycles++; return 'success';
		}
		if (node.type === 'WaitInterlock') return this.motion.checkInterlock(String(config.interlockId)) ? 'success' : 'waiting-signal';
		if (node.type === 'Delay' && root && lease?.owner === owner) root.userData.processProgress = Math.min(1, context.elapsed / Math.max(.001, Number(config.durationSeconds || 0)));
		if (node.type === 'SetState') {
			if (config.scope === 'variable') context.variables[String(config.ref)] = structuredClone(config.value);
			else this.motion.setSignal(String(config.ref), structuredClone(config.value));
			return 'success';
		}
		if (primitives[node.type]) {
			if (!root) throw new Error('机械动作节点缺少 Actor');
			if (this.actorOwners.has(actorId) && this.actorOwners.get(actorId) !== owner) return 'waiting-resource';
			this.actorOwners.set(actorId, owner);
			const action = { ...config, actionId: node.nodeId, kind: primitives[node.type], sourceSlotId: config.sourceSlotId || config.slotId } as TwinBehaviorActionDefinition;
			return this.motion.executePrimitive(`${owner}/${actorId}`, actorId, context.executionId, action, dt) ? 'success' : 'running';
		}
		if (node.type === 'End') {
			if ([...this.leases.values()].some(l => l.owner === owner)) throw new Error('流程结束前未释放工位；必须通过 CompleteStation');
			for (const [id, current] of this.actorOwners) if (current === owner) {
				if (this.motion.hasHeldPayload(`${owner}/${id}`)) throw new Error('结束节点不可遗留夹持物料');
					this.actorOwners.delete(id);
			}
		}
		return undefined;
	}
}
