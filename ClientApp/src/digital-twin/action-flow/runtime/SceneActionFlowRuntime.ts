import * as THREE from 'three';
import type { TwinBehaviorActionDefinition, TwinSceneManifest } from '../../contracts';
import { BehaviorRuntime } from '../../runtime/BehaviorRuntime';
import { JointTrajectoryPlayer, type TrajectoryAxisPort } from '../../motion/JointTrajectory';
import { applyPickPlacePreview, pickPlaceRequestErrors, plannedTransferSteps, previewPickPlace, type PickPlacePreview, type PickPlaceRequest } from '../../motion/PickPlacePlanner';
import { createSlotTargetContext, type MotionSceneAccess } from '../../motion/SceneSlotResolver';
import { deriveSlotToolTarget } from '../../motion/SlotToolTargetDeriver';
import { compileActionFlow } from '../compiler/ActionFlowCompiler';
import type { TwinActionFlowDefinitionV2, TwinActionFlowNode } from '../contracts/action-flow-v2';
import { SimulationFlowRuntime, type FlowNodeExecutionContext, type FlowNodeExecutionResult } from './SimulationFlowRuntime';

const primitives: Record<string, TwinBehaviorActionDefinition['kind']> = {
	MoveTo: 'moveTo', MovePose: 'movePose', JointMove: 'jointMove', AxisMove: 'axisMove', Home: 'home',
	GripOpen: 'gripOpen', GripClose: 'gripClose', Attach: 'attach', Detach: 'detach', Pick: 'pick', Place: 'place', PrepareSlot: 'prepareSlot',
};
interface StationLease { owner: string; actorId: string; group: string; palletIds: string[]; cycle: number }
interface FlowEntry { definition: TwinActionFlowDefinitionV2; runtime: SimulationFlowRuntime; cycles: number }
interface PlannedTransfer { planNodeId: string; preview: PickPlacePreview; program: TwinSceneManifest; steps: TwinActionFlowNode[]; nextStep: number }

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
	private readonly trajectoryPlayers = new Map<string, JointTrajectoryPlayer>();
	private readonly plannedTransfers = new Map<string, PlannedTransfer>();
	private readonly recipeOwners = new Map<string, string>();
	private readonly planningRecords: Array<{ taskId: string; sourceBinding?: string; targetBinding?: string; trajectories: TwinSceneManifest['motionTrajectories']; review: unknown }> = [];
	constructor(private readonly manifest: TwinSceneManifest, private readonly scene: THREE.Scene,
		private readonly getRoot: (id: string) => THREE.Object3D | undefined,
		private readonly reportError?: (message: string) => void,
		applyActuatorCommand?: (id: string, value: number | boolean, speedRatio?: number) => boolean,
		private readonly selectRoute?: (routeId: string, palletIds: string[], junctionId: string, edgeId: string) => void,
		private readonly holdActor?: (actorId: string) => void,
		private readonly trajectoryPort?: TrajectoryAxisPort) {
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
		this.trajectoryPlayers.clear();
		this.plannedTransfers.clear(); this.planningRecords.length = 0;
		this.recipeOwners.clear();
		this.motion.reset(options); this.leases.clear(); this.actorOwners.clear(); this.fault = undefined;
		for (const entry of this.entries) { entry.runtime.reset(); entry.cycles = 0; }
		this.setRunning(this.running);
	}
	getSnapshot(eventLimit = 0) {
		return { ...this.motion.getSnapshot(), engine: 'action-flow-v2' as const, fault: this.fault, planningRecords: eventLimit > 0 ? JSON.parse(JSON.stringify(this.planningRecords)) : undefined,
			flows: this.entries.map(entry => ({ ...entry.runtime.getSnapshot(eventLimit), name: entry.definition.name, cycles: entry.cycles })) };
	}
	getObjectDetail(id: string) { return { actionFlows: this.getSnapshot().flows.filter(f => this.entries.find(e => e.definition.flowId === f.flowId)?.definition.actorObjectIds.includes(id)) }; }
	dispose() { this.setRunning(false); for (const entry of this.entries) entry.runtime.cancel(); this.motion.dispose(); this.leases.clear(); this.actorOwners.clear(); this.trajectoryPlayers.clear(); this.plannedTransfers.clear(); this.recipeOwners.clear(); this.planningRecords.length = 0; }

	private motionScene(): MotionSceneAccess {
		return { getRoot: this.getRoot, getCollisionRoots: () => { const inventory: THREE.Object3D[] = []; this.scene.traverse(node => { if (node.userData.materialEntity) inventory.push(node); }); return inventory; }, getRuntimeOwners: () => { const owners: THREE.Object3D[] = []; this.scene.traverse(node => { if (node.userData.transportUnitType && node.userData.twinEntityId) owners.push(node); }); return owners; } };
	}
	/** 每段运动前核对被冻结的目标；持料后不重新选择来源或自动追随新托盘。 */
	private checkPlannedBinding(plan: PlannedTransfer, source = false) {
		const expected = source ? plan.preview.pick : plan.preview.place;
		const slot = this.manifest.materialSlots!.find(s => s.slotId === expected.slotId)!;
		const current = deriveSlotToolTarget(this.manifest, slot.slotId, expected.templateId, createSlotTargetContext(this.manifest, slot, this.motionScene()));
		if (current.inputSignature !== expected.inputSignature) throw new Error('本批来源/托盘身份、层位或位置已变化，必须停止并重新规划');
		if (source && plan.preview.transfer) {
			const access = this.motionScene(), binding = createSlotTargetContext(this.manifest, slot, access).resolvedSlotFrame;
			const roots = slot.runtimeOwnerType ? access.getRuntimeOwners().filter(o => binding?.ownerIds?.includes(String(o.userData.twinEntityId))) : [this.getRoot(slot.objectId)].filter(Boolean) as THREE.Object3D[];
			for (const payload of plan.preview.transfer.pickPayloads) {
				const matches = new Set<THREE.Object3D>();
				for (const root of roots) root.traverse(n => { if (n.userData.materialEntity && n.userData.twinEntityId === payload.entityId && !n.userData.materialAttachedBy) matches.add(n); });
				const part = [...matches][0]; part?.updateWorldMatrix(true, false);
				if (matches.size !== 1 || part.matrixWorld.elements.some((v, i) => Math.abs(v - payload.worldMatrix[i]) > 1e-7)) throw new Error('本批来源物料身份、归属或姿态已变化，必须停止并重新规划');
			}
		}
	}

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
		if (node.type === 'PlanPickPlace') {
			if (!root || !this.trajectoryPort) throw new Error('批次规划需要真实场景轴执行器');
			if (this.actorOwners.has(actorId) && this.actorOwners.get(actorId) !== owner) return 'waiting-resource';
			if (this.motion.hasHeldPayload(`${owner}/${actorId}`)) throw new Error('持料过程中禁止重新规划或更换目标');
			let attachedPayload = false;
			root.traverse(part => { if (part.userData.materialEntity && part.userData.materialAttachedBy) attachedPayload = true; });
			if (attachedPayload) throw new Error('设备仍挂载上一工艺的物料，需先完成持料恢复，禁止启动新的批次规划');
			const previous = this.plannedTransfers.get(owner);
			if (previous && previous.nextStep !== plannedTransferSteps.length) throw new Error('上一批尚未完成撤离，禁止开始下一批规划');
			const request = config.request as PickPlaceRequest, errors = pickPlaceRequestErrors(this.manifest, request);
			if (errors.length) throw new Error(errors.join('；'));
			this.actorOwners.set(actorId, owner);
			const preview = previewPickPlace(this.manifest, request, this.motionScene(), true, true);
			if (request.palletRecipeId) {
				const key = `${owner}/${request.palletRecipeId}`, identity = preview.place.ownerId;
				if (!identity || (this.recipeOwners.has(key) && this.recipeOwners.get(key) !== identity)) throw new Error('整托工艺中途更换了托盘身份，禁止继续码垛');
				this.recipeOwners.set(key, identity);
			}
			const flowId = `pick-place/${request.taskId}`;
			const program = applyPickPlacePreview({ ...this.manifest, actionFlows: this.manifest.actionFlows?.filter(f => f.flowId !== flowId) }, preview);
			const generated = program.actionFlows!.find(f => f.flowId === flowId)!;
			this.plannedTransfers.set(owner, { planNodeId: node.nodeId, preview, program, steps: generated.nodes.slice(1, -1), nextStep: 0 });
			this.planningRecords.push({ taskId: request.taskId, sourceBinding: preview.pick.stateRevision, targetBinding: preview.place.stateRevision, trajectories: program.motionTrajectories?.filter(t => t.trajectoryId.startsWith(`${flowId}/`)), review: generated.nodes.find(n => n.type === 'FollowTrajectory')?.config.planningReview });
			if (this.planningRecords.length > 128) this.planningRecords.shift();
			return 'success';
		}
		if (node.type === 'PlannedTransferStep') {
			const plan = this.plannedTransfers.get(owner);
			if (!plan || plan.planNodeId !== config.planNodeId || config.step !== plannedTransferSteps[plan.nextStep]) throw new Error('批次尚未规划或工艺步骤顺序被改变，禁止执行');
			if (plan.nextStep < 5) this.checkPlannedBinding(plan);
			if (plan.nextStep < 3) this.checkPlannedBinding(plan, true);
			const concrete = plan.steps[plan.nextStep];
			if (!concrete || concrete.actorObjectId !== actorId) throw new Error('规划步骤与设备不匹配');
			const result = this.execute(entry, { ...concrete, nodeId: node.nodeId, config: { ...concrete.config, interlockIds: guards } }, dt, context);
			if (result === 'success') plan.nextStep++;
			return result;
		}
		if (node.type === 'FollowTrajectory') {
			if (!root || !this.trajectoryPort) throw new Error('定时轨迹执行器或设备未接入');
			if (this.actorOwners.has(actorId) && this.actorOwners.get(actorId) !== owner) return 'waiting-resource';
			this.actorOwners.set(actorId, owner);
			const key = `${owner}/${context.executionId}`;
			let player = this.trajectoryPlayers.get(key);
			if (!player) {
				const trajectory = this.plannedTransfers.get(owner)?.program.motionTrajectories?.find(t => t.trajectoryId === config.trajectoryId) || this.manifest.motionTrajectories?.find(t => t.trajectoryId === config.trajectoryId);
				if (!trajectory || trajectory.actorObjectId !== actorId) throw new Error('轨迹引用或执行对象不匹配');
				player = new JointTrajectoryPlayer(trajectory, this.manifest, this.trajectoryPort);
				this.trajectoryPlayers.set(key, player);
			}
			if (!player.advance(dt)) return 'running';
			this.trajectoryPlayers.delete(key);
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
			const planned = this.plannedTransfers.get(owner);
			if (planned && planned.nextStep !== plannedTransferSteps.length) throw new Error('规划取放步骤尚未完整结束');
			if ([...this.leases.values()].some(l => l.owner === owner)) throw new Error('流程结束前未释放工位；必须通过 CompleteStation');
			for (const [id, current] of this.actorOwners) if (current === owner) {
				if (this.motion.hasHeldPayload(`${owner}/${id}`)) throw new Error('结束节点不可遗留夹持物料');
					this.actorOwners.delete(id);
			}
			this.plannedTransfers.delete(owner);
			for (const key of this.recipeOwners.keys()) if (key.startsWith(`${owner}/`)) this.recipeOwners.delete(key);
		}
		return undefined;
	}
}
