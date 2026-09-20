import * as THREE from 'three';
import { parseMaterialStateRef } from '../action-flow/contracts/material-state';
import { isKnownSignal, signalBoolean, isReadOnlyStateRef } from '../action-flow/contracts/signal-state';
import { actuatorTargetError, readActuatorNodeValue, writeActuatorNodeValue } from './ActuatorRuntime';
import type {
	TwinActuatorDefinition,
	TwinBehaviorActionDefinition,
	TwinBehaviorDefinition,
	TwinInterlockDefinition,
	TwinMaterialSlotDefinition,
	TwinPoseDefinition,
	TwinSceneManifest,
	TwinToolFrameDefinition,
	TwinVector3,
	TwinWorkPointDefinition,
} from '/@/digital-twin/contracts';

type ChannelStatus = 'paused' | 'moving' | 'acting' | 'waiting-station' | 'waiting-material' | 'waiting-contact' | 'waiting-interlock' | 'waiting-signal' | 'waiting-signal-stale' | 'completed' | 'error';

interface ChannelState {
	/** 外部图解释器独占调度此通道；V1 的顺序/循环调度不能同时介入。 */
	externallyManaged?: boolean;
	currentPrimitive?: TwinBehaviorActionDefinition;
	channelKey: string;
	actorObjectId: string;
	actorNodePath?: string;
	behaviors: TwinBehaviorDefinition[];
	behaviorIndex: number;
	actionIndex: number;
	phase: number;
	waitElapsed: number;
	waitRecordedFor?: string;
	startedActionKey?: string;
	actionEffectComplete?: boolean;
	status: ChannelStatus;
	cycleCount: number;
	completedActions: number;
	interlockWaitCount: number;
	stationBatchToken?: string;
	attachedPayload?: THREE.Object3D;
	heldToolFrameId?: string;
	placedPayload?: THREE.Object3D;
	/** 平滑加权轮询积分；仅影响同一 actor/channel 下 Behavior 的下一次选择。 */
	behaviorSelectionCredits: Record<string, number>;
}

interface BasePose {
	object: THREE.Object3D;
	position: THREE.Vector3;
	rotation: THREE.Euler;
}

interface SimulationMaterialTemplate {
	parent: THREE.Object3D;
	template: THREE.Object3D;
	sourceEntityId: string;
}

export interface BehaviorRuntimeChannelSnapshot {
	channelKey: string;
	actorObjectId: string;
	actorNodePath?: string;
	behaviorId?: string;
	behaviorName?: string;
	actionId?: string;
	actionKind?: TwinBehaviorActionDefinition['kind'];
	status: ChannelStatus;
	cycleCount: number;
	completedActions: number;
	interlockWaitCount: number;
	attachedPayloadType?: string;
}

export interface BehaviorRuntimeSnapshot {
	active: boolean;
	dataMode: TwinSceneManifest['runtime']['dataMode'];
	channels: BehaviorRuntimeChannelSnapshot[];
	interlocks: Array<{ interlockId: string; name: string; satisfied: boolean }>;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const vector = (value?: TwinVector3) => new THREE.Vector3(value?.[0] || 0, value?.[1] || 0, value?.[2] || 0);
const normalizedAngleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
// BehaviorRuntime 只在 simulation 模式执行；老场景的码垛闭环可持续数千秒。
// 未显式配置时仍给出有限上限，但不用设备级 300 秒默认值误杀长周期仿真。
const DEFAULT_SIMULATION_BLOCKING_ACTION_TIMEOUT_SECONDS = 7200;

/**
 * 声明式设备动作执行器。
 * - 只解释结构化 workPoint / behavior / interlock，不执行脚本或表达式。
 * - simulation 模式可自动运行；live 模式完全停用动作生成，PLC/Telemetry 保持权威。
 * - 工作点永远由 objectId + localPosition 求世界坐标，动作不持久化世界坐标。
 */
export class BehaviorRuntime {
	private manifest: TwinSceneManifest;
	private readonly workPoints = new Map<string, TwinWorkPointDefinition>();
	private readonly materialSlots = new Map<string, TwinMaterialSlotDefinition>();
	private readonly toolFrames = new Map<string, TwinToolFrameDefinition>();
	private readonly actuators = new Map<string, TwinActuatorDefinition>();
	private readonly poses = new Map<string, TwinPoseDefinition>();
	private readonly interlocks = new Map<string, TwinInterlockDefinition>();
	private readonly channels = new Map<string, ChannelState>();
	private readonly semanticState = new Map<string, unknown>();
	private readonly basePoses = new Map<string, BasePose[]>();
	private readonly bindingValues = new Map<string, unknown>();
	private readonly staleBindingIds = new Set<string>();
	private readonly simulationMaterialTemplates = new Map<string, SimulationMaterialTemplate[]>();
	private readonly simulationMaterialRefillCounts = new Map<string, number>();
	private running = false;
	private actorFilter?: string;
	private disposed = false;

	constructor(
		manifest: TwinSceneManifest,
		private readonly scene: THREE.Scene,
		private readonly getObjectRoot: (objectId: string) => THREE.Object3D | undefined,
		private readonly reportError?: (message: string) => void,
		private readonly applyActuatorCommand?: (actuatorId: string, value: number | boolean, speedRatio?: number) => boolean,
	) {
		this.manifest = structuredClone(manifest);
		this.setManifest(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		const wasRunning = this.running;
		this.clearPayloads();
		this.manifest = structuredClone(manifest);
		this.workPoints.clear();
		this.materialSlots.clear();
		this.toolFrames.clear();
		this.actuators.clear();
		this.poses.clear();
		this.interlocks.clear();
		this.channels.clear();
		this.semanticState.clear();
		this.basePoses.clear();
		this.simulationMaterialTemplates.clear();
		this.simulationMaterialRefillCounts.clear();
		for (const item of this.manifest.workPoints || []) this.workPoints.set(item.workPointId, item);
		for (const item of this.manifest.materialSlots || []) this.materialSlots.set(item.slotId, item);
		for (const item of this.manifest.toolFrames || []) this.toolFrames.set(item.toolFrameId, item);
		for (const item of this.manifest.actuators || []) this.actuators.set(item.actuatorId, item);
		for (const item of this.manifest.poses || []) this.poses.set(item.poseId, item);
		for (const item of this.manifest.interlocks || []) this.interlocks.set(item.interlockId, item);
		for (const behavior of this.manifest.behaviors || []) {
			if (behavior.enabled === false || !behavior.actions?.length) continue;
			const actorNodePath = behavior.actions.find((action) => action.actorNodePath)?.actorNodePath;
			const channelKey = `${behavior.actorObjectId}:${actorNodePath || 'default'}`;
			let channel = this.channels.get(channelKey);
			if (!channel) {
				channel = {
					channelKey,
					actorObjectId: behavior.actorObjectId,
					actorNodePath,
					behaviors: [],
					behaviorIndex: 0,
					actionIndex: 0,
					phase: 0,
					waitElapsed: 0,
					status: 'paused',
					cycleCount: 0,
					completedActions: 0,
					interlockWaitCount: 0,
					behaviorSelectionCredits: {},
				};
				this.channels.set(channelKey, channel);
			}
			channel.behaviors.push(behavior);
			this.captureActorBase(behavior.actorObjectId);
		}
		for (const channel of this.channels.values()) this.initializeBehaviorSelection(channel);
		this.initializeSemanticState();
		// 整线复位需要开机库存快照，不能等第一次取空之后才建立模板。
		if (this.manifest.routes.some(route => route.points.some(point => point.process?.batchArrivalMode === 'route-aligned'))) {
			for (const slot of this.materialSlots.values()) {
				this.ensureSimulationMaterialTemplate(slot);
				const root = this.getObjectRoot(slot.objectId);
				const node = root && slot.metadata?.rotationNodePath ? this.findNode(root, String(slot.metadata.rotationNodePath)) : undefined;
				if (node) this.basePoses.set(`source:${slot.slotId}`, [{ object: node, position: node.position.clone(), rotation: node.rotation.clone() }]);
			}
		}
		this.running = wasRunning && this.manifest.runtime.dataMode === 'simulation';
		if (!this.running) for (const channel of this.channels.values()) channel.status = 'paused';
	}

	setRunning(running: boolean) {
		this.running = Boolean(running) && this.manifest.runtime.dataMode === 'simulation';
		for (const channel of this.channels.values()) {
			const enabled = !this.actorFilter || channel.actorObjectId === this.actorFilter;
			if ((!this.running || !enabled) && channel.status !== 'completed' && channel.status !== 'error') channel.status = 'paused';
			else if (this.running && enabled && channel.status === 'paused') channel.status = 'acting';
		}
	}

	setActorFilter(objectId?: string) {
		this.actorFilter = objectId?.trim() || undefined;
		for (const channel of this.channels.values()) {
			const enabled = !this.actorFilter || channel.actorObjectId === this.actorFilter;
			if (!enabled && channel.status !== 'completed' && channel.status !== 'error') channel.status = 'paused';
			else if (this.running && enabled && channel.status === 'paused') channel.status = 'acting';
		}
	}

	reset(options: { restoreMaterials?: boolean } = {}) {
		this.clearPayloads();
		if (options.restoreMaterials && this.manifest.runtime.dataMode === 'simulation') this.restoreSimulationMaterials();
		for (const actuator of this.actuators.values()) if (actuator.kind === 'gripper') { const root = this.getObjectRoot(actuator.objectId); if (root) this.setActuatorValue(root,actuator,false,0,1); }
		for (const poses of this.basePoses.values()) {
			for (const pose of poses) {
				pose.object.position.copy(pose.position);
				pose.object.rotation.copy(pose.rotation);
			}
		}
		for (const channel of this.channels.values()) {
			channel.behaviorIndex = 0;
			this.initializeBehaviorSelection(channel);
			channel.actionIndex = 0;
			channel.phase = 0;
			channel.waitElapsed = 0;
			channel.waitRecordedFor = undefined;
			channel.startedActionKey = undefined;
			channel.actionEffectComplete = undefined;
			channel.currentPrimitive = undefined;
			channel.status = this.running && (!this.actorFilter || channel.actorObjectId === this.actorFilter) ? 'acting' : 'paused';
			channel.cycleCount = 0;
			channel.completedActions = 0;
			channel.interlockWaitCount = 0;
			channel.stationBatchToken = undefined;
		}
		this.semanticState.clear();
		this.initializeSemanticState();
		this.simulationMaterialRefillCounts.clear();
	}

	updateFixed(deltaSeconds: number) {
		if (this.disposed || !this.running || this.manifest.runtime.dataMode !== 'simulation') return;
		if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		for (const channel of this.channels.values()) {
			if (channel.externallyManaged) { this.syncGridPayloadAnchors(channel); continue; }
			if (this.actorFilter && channel.actorObjectId !== this.actorFilter) continue;
			if (channel.status === 'error') continue; // 故障保持到显式复位，不重复抓放或每帧重报。
			this.syncGridPayloadAnchors(channel);
			this.updateChannel(channel, deltaSeconds);
			this.syncGridPayloadAnchors(channel);
		}
	}

	/** 仅执行一个动作原语，不选下一步、不循环、不释放工位。动作流图负责全部控制流。 */
	executePrimitive(channelKey: string, actorObjectId: string, executionId: string, action: TwinBehaviorActionDefinition, deltaSeconds: number) {
		if (!this.running || this.manifest.runtime.dataMode !== 'simulation' || (this.actorFilter && this.actorFilter !== actorObjectId)) return false;
		let channel = this.channels.get(channelKey);
		if (!channel) {
			channel = { channelKey, actorObjectId, behaviors: [], externallyManaged: true, behaviorIndex: 0, actionIndex: 0, phase: 0, waitElapsed: 0, status: 'acting', cycleCount: 0, completedActions: 0, interlockWaitCount: 0, behaviorSelectionCredits: {} };
			this.channels.set(channelKey, channel);
			this.captureActorBase(actorObjectId);
		}
		if (!channel.externallyManaged || channel.actorObjectId !== actorObjectId) throw new Error('动作通道归属冲突');
		const actor = this.getObjectRoot(actorObjectId);
		if (!actor) throw new Error(`动作执行对象 ${actorObjectId} 不存在`);
		// 图的关节/示教目标必须真实可执行；不能依赖执行轴 clamp 后把越界命令当作成功。
		const checkTarget = (id: string, value?: number | boolean) => {
			const axis = this.requireActuator(id);
			if (axis.objectId !== actorObjectId || !this.findNode(actor,axis.nodePath)) throw new Error('执行机构不属于当前设备或缺少模型节点');
			if (value !== undefined) { const error = actuatorTargetError(axis, value); if (error) throw new Error(error); }
		};
		if (action.actuatorId) checkTarget(action.actuatorId,action.targetValue);
		if (action.poseId) { const pose = this.requirePose(action); if (pose.objectId !== actorObjectId) throw new Error('姿态不属于当前设备'); for (const target of pose.targets) checkTarget(target.actuatorId,target.value); }
		if (['moveTo','pick','place'].includes(action.kind)) {
			const point = this.requireWorkPoint(action), frame = point.toolFrameId ? this.toolFrames.get(point.toolFrameId) : undefined;
			if (!frame || frame.objectId !== actorObjectId || !this.findNode(actor,frame.nodePath)) throw new Error('机械动作必须绑定当前设备的真实 TCP');
			if (!frame.cartesianActuatorIds?.length && (!actor.getObjectByName('Robot-Axis-1') || action.actorNodePath)) throw new Error('工具必须使用已配置的运动学或执行轴，禁止直接拖动节点绕过行程限制');
		}
		if (channel.startedActionKey !== executionId) {
			channel.startedActionKey = executionId; channel.currentPrimitive = action;
			channel.phase = 0; channel.waitElapsed = 0; channel.actionEffectComplete = false;
			this.applyStateAssignments(action.onStartState);
		}
		channel.waitElapsed += deltaSeconds;
		this.syncGridPayloadAnchors(channel);
		if (!channel.actionEffectComplete) channel.actionEffectComplete = this.executeAction(channel, { actorObjectId }, action, actor, deltaSeconds);
		this.syncGridPayloadAnchors(channel);
		if (!channel.actionEffectComplete || channel.waitElapsed < Math.max(0, Number(action.durationSeconds || 0))) return false;
		this.completeAction(channel, action);
		return true;
	}

	/** 图谓词共享同一份真实物料槽位、互锁与遥测状态。 */
	readSemanticValue(source: string) { return this.resolveSemanticValue(source); }
	checkInterlock(interlockId: string) { return this.isInterlockSatisfied(interlockId); }
	hasHeldPayload(channelKey: string) { return Boolean(this.channels.get(channelKey)?.attachedPayload); }

	setSignal(source: string, value: unknown) {
		if (this.isReadOnlySignal(source)) throw new Error('绑定、物料及工位状态为只读，不能通过流程伪造');
		if (source?.trim()) this.semanticState.set(source.trim(), value);
	}

	setBindingContext(context: { bindingValues?: Record<string, unknown>; staleBindingIds?: string[] }) {
		this.bindingValues.clear();
		this.staleBindingIds.clear();
		for (const [bindingId, value] of Object.entries(context.bindingValues || {})) this.bindingValues.set(bindingId, value);
		for (const bindingId of context.staleBindingIds || []) this.staleBindingIds.add(bindingId);
	}
	private isReadOnlySignal(source: string) { return isReadOnlyStateRef(source, (this.manifest.bindings || []).map(b => b.bindingId)) || this.bindingValues.has(source.trim()); }

	getSnapshot(): BehaviorRuntimeSnapshot {
		return {
			active: this.running && this.manifest.runtime.dataMode === 'simulation',
			dataMode: this.manifest.runtime.dataMode,
			channels: [...this.channels.values()].map((channel) => {
				const behavior = channel.behaviors[channel.behaviorIndex];
				const action = channel.externallyManaged ? channel.currentPrimitive : behavior?.actions[channel.actionIndex];
				return {
					channelKey: channel.channelKey,
					actorObjectId: channel.actorObjectId,
					actorNodePath: channel.actorNodePath,
					behaviorId: behavior?.behaviorId,
					behaviorName: behavior?.name,
					actionId: action?.actionId,
					actionKind: action?.kind,
					status: channel.status,
					cycleCount: channel.cycleCount,
					completedActions: channel.completedActions,
					interlockWaitCount: channel.interlockWaitCount,
					attachedPayloadType: channel.attachedPayload?.userData?.payloadType,
				};
			}),
			interlocks: [...this.interlocks.values()].map((item) => ({ interlockId: item.interlockId, name: item.name, satisfied: this.isInterlockSatisfied(item.interlockId) })),
		};
	}

	getObjectDetail(objectId: string): Record<string, unknown> | undefined {
		const channels = this.getSnapshot().channels.filter((item) => item.actorObjectId === objectId);
		if (!channels.length) return undefined;
		const relevantInterlockIds = new Set<string>();
		for (const behavior of this.manifest.behaviors || []) {
			if (behavior.actorObjectId !== objectId) continue;
			for (const interlockId of behavior.interlockIds || []) relevantInterlockIds.add(interlockId);
			for (const action of behavior.actions || []) if (action.waitForInterlockId) relevantInterlockIds.add(action.waitForInterlockId);
		}
		return {
			behaviorRuntime: {
				mode: this.manifest.runtime.dataMode,
				running: this.running,
				channels,
				interlocks: this.getSnapshot().interlocks.filter((item) => relevantInterlockIds.has(item.interlockId)),
			},
		};
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.running = false;
		this.clearPayloads();
		this.channels.clear();
		this.workPoints.clear();
		this.materialSlots.clear();
		this.toolFrames.clear();
		this.actuators.clear();
		this.poses.clear();
		this.interlocks.clear();
		this.semanticState.clear();
		this.basePoses.clear();
		this.bindingValues.clear();
		this.staleBindingIds.clear();
		this.simulationMaterialTemplates.clear();
		this.simulationMaterialRefillCounts.clear();
	}

	private updateChannel(channel: ChannelState, deltaSeconds: number) {
		const behavior = channel.behaviors[channel.behaviorIndex];
		if (!behavior) {
			channel.status = 'completed';
			return;
		}
		const actorRoot = this.getObjectRoot(channel.actorObjectId);
		if (!actorRoot) {
			channel.status = 'error';
			this.reportError?.(`动作编排 ${behavior.name} 找不到执行对象 ${channel.actorObjectId}`);
			return;
		}
		const stationGroup = behavior.stationCompletionGroup?.trim();
		if (stationGroup) {
			const stationIds = this.getStationPalletIds(actorRoot);
			if (!stationIds.length) {
				channel.status = 'waiting-station';
				channel.stationBatchToken = undefined;
				return;
			}
			const token = stationIds.join('|');
			if (channel.stationBatchToken !== token) {
				channel.stationBatchToken = token;
				channel.actionIndex = 0;
				channel.phase = 0;
				channel.waitElapsed = 0;
				channel.waitRecordedFor = undefined;
				channel.attachedPayload = undefined;
				channel.placedPayload = undefined;
				channel.startedActionKey = undefined;
				channel.actionEffectComplete = undefined;
			}
			const requirements = this.numberRecord(actorRoot.userData.stationBehaviorRequirements);
			const counts = this.numberRecord(actorRoot.userData.stationCompletedGroupCounts);
			if ((counts[stationGroup] || 0) >= (requirements[stationGroup] || 1)) {
				channel.status = 'waiting-station';
				return;
			}
		}
		const action = behavior.actions[channel.actionIndex];
		if (!action) {
			channel.cycleCount += 1;
			if (stationGroup) {
				const requirements = this.numberRecord(actorRoot.userData.stationBehaviorRequirements);
				const counts = this.numberRecord(actorRoot.userData.stationCompletedGroupCounts);
				counts[stationGroup] = (counts[stationGroup] || 0) + 1;
				actorRoot.userData.stationCompletedGroupCounts = counts;
				const completedGroups = this.stringArray(actorRoot.userData.stationCompletedGroups);
				if (counts[stationGroup] >= (requirements[stationGroup] || 1) && !completedGroups.includes(stationGroup)) completedGroups.push(stationGroup);
				actorRoot.userData.stationCompletedGroups = completedGroups;
				actorRoot.userData.stationLastCompletedBehaviorId = behavior.behaviorId;
				channel.behaviorIndex = this.selectNextBehaviorIndex(channel);
				channel.actionIndex = 0;
				channel.phase = 0;
				channel.waitElapsed = 0;
				channel.waitRecordedFor = undefined;
				channel.status = 'waiting-station';
				return;
			}
			if (behavior.loop === false && channel.behaviors.length === 1) {
				channel.status = 'completed';
				return;
			}
			channel.behaviorIndex = this.selectNextBehaviorIndex(channel);
			channel.actionIndex = 0;
			channel.phase = 0;
			channel.waitElapsed = 0;
			channel.waitRecordedFor = undefined;
			channel.startedActionKey = undefined;
			channel.actionEffectComplete = undefined;
			channel.status = 'acting';
			return;
		}
		try {
			const blockedInterlockId = (behavior.interlockIds || []).find((interlockId) => !this.isInterlockSatisfied(interlockId));
			if (blockedInterlockId) {
				channel.status = 'waiting-interlock';
				channel.waitElapsed += deltaSeconds;
				const waitKey = `behavior:${behavior.behaviorId}:${blockedInterlockId}`;
				if (channel.waitRecordedFor !== waitKey) {
					channel.interlockWaitCount += 1;
					channel.waitRecordedFor = waitKey;
				}
				this.throwIfActionTimedOut(channel, action, `动作编排联锁 ${blockedInterlockId}`, true);
				return;
			}
			const actionKey = `${behavior.behaviorId}:${action.actionId}`;
			if (channel.startedActionKey !== actionKey) {
				this.applyStateAssignments(action.onStartState);
				channel.startedActionKey = actionKey;
				channel.actionEffectComplete = false;
				channel.waitElapsed = 0;
				channel.waitRecordedFor = undefined;
			}
			channel.waitElapsed += deltaSeconds;
			if (!channel.actionEffectComplete) channel.actionEffectComplete = this.executeAction(channel, behavior, action, actorRoot, deltaSeconds);
			if (!channel.actionEffectComplete) {
				this.throwIfActionTimedOut(channel, action, `动作 ${action.actionId}`);
				return;
			}
			const minimumDuration = Math.max(0, Number(action.durationSeconds || 0));
			if (channel.waitElapsed < minimumDuration) {
				channel.status = 'acting';
				this.throwIfActionTimedOut(channel, action, `动作 ${action.actionId}`);
				return;
			}
			this.completeAction(channel, action);
		} catch (error) {
			channel.status = 'error';
			this.reportError?.(`动作 ${action.actionId} 执行失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private behaviorWeight(behavior: TwinBehaviorDefinition) {
		const weight = Number(behavior.selectionWeight ?? 1);
		return Number.isFinite(weight) && weight > 0 ? weight : 1;
	}

	private initializeBehaviorSelection(channel: ChannelState) {
		channel.behaviorSelectionCredits = {};
		if (!channel.behaviors.length) { channel.behaviorIndex = 0; return; }
		const total = channel.behaviors.reduce((sum, behavior) => sum + this.behaviorWeight(behavior), 0);
		for (const behavior of channel.behaviors) channel.behaviorSelectionCredits[behavior.behaviorId] = this.behaviorWeight(behavior);
		// 首个 Behavior 保持历史顺序；把这次选择记入积分，后续进入平滑加权轮询。
		channel.behaviorSelectionCredits[channel.behaviors[0].behaviorId] -= total;
		channel.behaviorIndex = 0;
	}

	private selectNextBehaviorIndex(channel: ChannelState) {
		if (channel.behaviors.length <= 1) return 0;
		const total = channel.behaviors.reduce((sum, behavior) => sum + this.behaviorWeight(behavior), 0);
		let selectedIndex = 0;
		let bestCredit = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < channel.behaviors.length; index += 1) {
			const behavior = channel.behaviors[index];
			const nextCredit = Number(channel.behaviorSelectionCredits[behavior.behaviorId] || 0) + this.behaviorWeight(behavior);
			channel.behaviorSelectionCredits[behavior.behaviorId] = nextCredit;
			if (nextCredit > bestCredit) { bestCredit = nextCredit; selectedIndex = index; }
		}
		const selected = channel.behaviors[selectedIndex];
		channel.behaviorSelectionCredits[selected.behaviorId] -= total;
		return selectedIndex;
	}

	private executeAction(channel: ChannelState, behavior: Pick<TwinBehaviorDefinition, 'actorObjectId'>, action: TwinBehaviorActionDefinition, actorRoot: THREE.Object3D, deltaSeconds: number) {
		const speedRatio = Math.max(0.1, Number(action.speedRatio || 1));
		switch (action.kind) {
			case 'movePose': {
				channel.status = 'moving';
				const pose = this.requirePose(action);
				return this.movePose(actorRoot, pose, deltaSeconds, speedRatio);
			}
			case 'jointMove': {
				channel.status = 'moving';
				return this.moveConfiguredActuator(actorRoot, action, deltaSeconds, speedRatio);
			}
			case 'moveTo': {
				const workPoint = this.requireWorkPoint(action);
				channel.status = 'moving';
				if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, action.approachOffset, deltaSeconds, speedRatio)) return false;
				return !action.alignPayloadGrid || this.alignPayloadGrid(channel, actorRoot, action, deltaSeconds);
			}
			case 'home': {
				channel.status = 'moving';
				const done = action.poseId
					? this.movePose(actorRoot, this.requirePose(action), deltaSeconds, speedRatio)
					: this.moveActorHome(behavior.actorObjectId, actorRoot, deltaSeconds, speedRatio);
				return done;
			}
			case 'axisMove': {
				channel.status = 'moving';
				if (action.actuatorId) return this.moveConfiguredActuator(actorRoot, action, deltaSeconds, speedRatio);
				return this.moveAxis(actorRoot, action, deltaSeconds, speedRatio);
			}
			case 'gripOpen':
				if (channel.externallyManaged && channel.attachedPayload) throw new Error('夹具仍持有物料，请使用 Place 安全放料；不能在空中松爪');
				channel.status = 'acting';
				return this.setConfiguredGripper(actorRoot, action, false);
			case 'gripClose':
				channel.status = 'acting';
				return this.setConfiguredGripper(actorRoot, action, true);
			case 'waitSignal': {
				const bindingId = action.signalBindingId?.trim();
				if (!bindingId) throw new Error(`动作 ${action.actionId} 未配置 signalBindingId`);
				if (this.staleBindingIds.has(bindingId)) {
					channel.status = 'waiting-signal-stale';
					return false;
				}
				if (!this.isSignalSatisfied(action, this.bindingValues.get(bindingId))) {
					channel.status = 'waiting-signal';
					return false;
				}
				channel.status = 'acting';
				return true;
			}
			case 'pick': {
				const workPoint = this.requireWorkPoint(action);
				channel.status = channel.phase === 0 || channel.phase === 2 ? 'moving' : 'acting';
				if (channel.phase === 0) {
					if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, undefined, deltaSeconds, speedRatio)) return false;
					channel.phase = 1;
				}
				if (channel.phase === 1) {
					if (!this.attachPayload(channel, actorRoot, action, behavior.actorObjectId)) return false;
					channel.phase = action.liftOffset ? 2 : 3;
				}
				if (channel.phase === 2) {
					if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, action.liftOffset, deltaSeconds, speedRatio)) return false;
					channel.phase = 3;
				}
				return channel.phase >= 3;
			}
			case 'place': {
				const workPoint = this.requireWorkPoint(action);
				channel.status = channel.phase === 2 ? 'acting' : 'moving';
				if (channel.phase === 0) {
					if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, action.approachOffset, deltaSeconds, speedRatio)) return false;
					channel.phase = 1;
				}
				if (channel.phase === 1) {
					if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, undefined, deltaSeconds, speedRatio)) return false;
					channel.phase = 2;
				}
				if (channel.phase === 2) {
					if (!this.detachPayload(channel, workPoint, action)) return false;
					channel.phase = action.approachOffset ? 3 : 4;
					// 放料与回撤必须跨两个 fixed tick：释放物料的这一帧保持 TCP 在接触点，
					// 下一帧才开始回撤。该规则属于通用 Place 语义，不依赖机器人或产线类型。
					return false;
				}
				if (channel.phase === 3) {
					if (!this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, action.approachOffset, deltaSeconds, speedRatio)) return false;
					channel.phase = 4;
				}
				return channel.phase >= 4;
			}
			case 'wait': {
				const interlockId = action.waitForInterlockId;
				if (interlockId && !this.isInterlockSatisfied(interlockId)) {
					channel.status = 'waiting-interlock';
					if (channel.waitRecordedFor !== interlockId) {
						channel.interlockWaitCount += 1;
						channel.waitRecordedFor = interlockId;
					}
					return false;
				}
				channel.status = 'acting';
				channel.waitRecordedFor = undefined;
				return channel.waitElapsed >= Math.max(0, Number(action.waitSeconds ?? 0));
			}
			case 'prepareSlot': {
				const slot = action.sourceSlotId ? this.materialSlots.get(action.sourceSlotId) : undefined;
				if (!slot) throw new Error(`动作 ${action.actionId} 未引用有效来源 MaterialSlot`);
				channel.status = this.prepareMaterialSlot(slot, deltaSeconds) ? 'acting' : 'waiting-material';
				return channel.status !== 'waiting-material';
			}
			case 'attach':
				return this.attachPayload(channel, actorRoot, action, behavior.actorObjectId);
			case 'detach':
				channel.status = 'acting';
				return this.detachPayload(channel, action.workPointId ? this.workPoints.get(action.workPointId) : undefined, action);
			default:
				return true;
		}
	}

	private completeAction(channel: ChannelState, action: TwinBehaviorActionDefinition) {
		this.applyStateAssignments(action.onCompleteState);
		channel.completedActions += 1;
		channel.actionIndex += 1;
		channel.phase = 0;
		channel.waitElapsed = 0;
		channel.waitRecordedFor = undefined;
		channel.startedActionKey = undefined;
		channel.actionEffectComplete = undefined;
		channel.status = 'acting';
	}

	private requireWorkPoint(action: TwinBehaviorActionDefinition) {
		const workPoint = action.workPointId ? this.workPoints.get(action.workPointId) : undefined;
		if (!workPoint) throw new Error(`动作 ${action.actionId} 未引用有效工作点`);
		return workPoint;
	}

	private requirePose(action: TwinBehaviorActionDefinition) {
		const pose = action.poseId ? this.poses.get(action.poseId) : undefined;
		if (!pose) throw new Error(`动作 ${action.actionId} 未引用有效 Pose`);
		return pose;
	}

	private requireActuator(actuatorId: string) {
		const actuator = this.actuators.get(actuatorId);
		if (!actuator) throw new Error(`执行机构 ${actuatorId} 不存在`);
		return actuator;
	}

	private movePose(actorRoot: THREE.Object3D, pose: TwinPoseDefinition, deltaSeconds: number, speedRatio: number) {
		// 先校验整组目标，避免后面的轴越程时前面的轴已经被命令移动。
		for (const target of pose.targets || []) this.assertActuatorTarget(actorRoot, this.requireActuator(target.actuatorId), target.value);
		let done = true;
		for (const target of pose.targets || []) {
			if (!this.setActuatorValue(actorRoot, this.requireActuator(target.actuatorId), target.value, deltaSeconds, speedRatio)) done = false;
		}
		return done;
	}

	private moveConfiguredActuator(actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, deltaSeconds: number, speedRatio: number) {
		if (!action.actuatorId || !Number.isFinite(action.targetValue)) throw new Error('轴动作缺少执行机构或有效目标值');
		return this.setActuatorValue(actorRoot, this.requireActuator(action.actuatorId), Number(action.targetValue), deltaSeconds, speedRatio);
	}

	private setConfiguredGripper(actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, closed: boolean) {
		if (action.actuatorId) return this.setActuatorValue(actorRoot, this.requireActuator(action.actuatorId), closed, 0, 1);
		const fallback = action.actorNodePath ? this.findNode(actorRoot, action.actorNodePath) : this.resolveAttachNode(actorRoot, action.actorNodePath);
		if (fallback) {
			fallback.userData.gripClosed = closed;
			fallback.userData.gripValue = closed ? 1 : 0;
		}
		return true;
	}

	private assertActuatorTarget(actorRoot: THREE.Object3D, actuator: TwinActuatorDefinition, value: number | boolean) {
		const error = actuatorTargetError(actuator, value);
		if (error) throw new Error(error);
		if (actuator.objectId !== actorRoot.userData.twinObjectId) throw new Error(`执行机构 ${actuator.actuatorId} 不属于当前设备`);
		const node = this.findNode(actorRoot, actuator.nodePath);
		if (!node) throw new Error(`执行机构 ${actuator.actuatorId} 找不到节点 ${actuator.nodePath}`);
		return node;
	}

	private setActuatorValue(actorRoot: THREE.Object3D, actuator: TwinActuatorDefinition, value: number | boolean, deltaSeconds: number, speedRatio: number) {
		const node = this.assertActuatorTarget(actorRoot, actuator, value);
		if (this.applyActuatorCommand) return this.applyActuatorCommand(actuator.actuatorId, value, speedRatio);
		if (actuator.kind === 'gripper') {
			const closed = Boolean(value);
			node.userData.gripClosed = closed;
			node.userData.gripValue = closed ? 1 : 0;
			return true;
		}
		const axis = actuator.motionAxis || 'y';
		const numeric = Number(value);
		const speed = Math.max(0.001, Number(actuator.speed || (actuator.kind === 'rotary-joint' ? 1.8 : 3))) * Math.max(0.1, speedRatio);
		const maxStep = Math.max(0.000001, deltaSeconds * writeActuatorNodeValue(speed, actuator));
		if (actuator.kind === 'rotary-joint') {
			const targetRadians = writeActuatorNodeValue(numeric, actuator);
			if (actuator.minValue !== undefined || actuator.maxValue !== undefined) return this.moveScalar(node.rotation, axis, targetRadians, maxStep);
			return this.moveAngle(node.rotation, axis, targetRadians, maxStep);
		}
		return this.moveScalar(node.position, axis, writeActuatorNodeValue(numeric, actuator), maxStep);
	}

	private isSignalSatisfied(action: TwinBehaviorActionDefinition, value: unknown) {
		const isTrue = value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
		switch (action.signalOperator || 'truthy') {
			case 'truthy': return isTrue;
			case 'falsy': return !isTrue;
			case 'equals': return value === action.signalValue || String(value) === String(action.signalValue);
			case 'notEquals': return !(value === action.signalValue || String(value) === String(action.signalValue));
			default: return false;
		}
	}

	private throwIfActionTimedOut(channel: ChannelState, action: TwinBehaviorActionDefinition, label: string, blockingInterlock = false) {
		const configured = Number(action.timeoutSeconds);
		const needsSafeDefault = blockingInterlock || action.kind === 'waitSignal' || Boolean(action.waitForInterlockId);
		const timeout = Number.isFinite(configured) && configured > 0 ? configured : needsSafeDefault ? DEFAULT_SIMULATION_BLOCKING_ACTION_TIMEOUT_SECONDS : 0;
		if (timeout > 0 && channel.waitElapsed >= timeout) throw new Error(`${label} 等待超过 ${timeout} 秒`);
	}

	private prepareMaterialSlot(slot: TwinMaterialSlotDefinition, deltaSeconds: number) {
		this.ensureSimulationMaterialTemplate(slot);
		const groups = Array.isArray(slot?.metadata?.entityGroups) ? slot!.metadata!.entityGroups!.map((item) => String(item)).filter(Boolean) : [];
		if (!groups.length) return true;
		const owner = this.getObjectRoot(slot.objectId);
		if (!owner) return false;

		const minimumBatch = Math.max(1, Math.floor(Number(slot.metadata?.minimumBatch || 1)));
		const countGroups = () => {
			const counts: Record<string, number> = {};
			owner.traverse((node) => {
				if (node.userData?.materialEntity !== true || node.userData?.materialAttachedBy) return;
				if (slot.payloadType && node.userData?.payloadType !== slot.payloadType) return;
				const group = String(node.userData?.materialSlotGroup || '');
				if (group) counts[group] = (counts[group] || 0) + 1;
			});
			return counts;
		};
		let counts = countGroups();
		const currentGroup = String(owner.userData.activeMaterialGroup || '');
		let targetGroup = currentGroup && (counts[currentGroup] || 0) >= minimumBatch
			? currentGroup
			: groups.find((group) => (counts[group] || 0) >= minimumBatch);
		if (!targetGroup && this.trySimulationMaterialReplenish(slot)) {
			counts = countGroups();
			targetGroup = currentGroup && (counts[currentGroup] || 0) >= minimumBatch
				? currentGroup
				: groups.find((group) => (counts[group] || 0) >= minimumBatch);
		}
		if (!targetGroup) {
			owner.userData.materialSourceReady = false;
			owner.userData.materialSourceWaitingReason = 'INSUFFICIENT_BATCH';
			return false;
		}

		const rotationNodePath = String(slot.metadata?.rotationNodePath || '');
		const rotationNode = rotationNodePath ? this.findNode(owner, rotationNodePath) : undefined;
		const angleMap = slot.metadata?.presentationAngles && typeof slot.metadata.presentationAngles === 'object'
			? slot.metadata.presentationAngles as Record<string, unknown>
			: {};
		const targetAngle = Number(angleMap[targetGroup] ?? 0);
		owner.userData.materialSourceTargetGroup = targetGroup;
		owner.userData.materialSourceTargetAngle = targetAngle;
		if (rotationNode && !this.moveAngle(rotationNode.rotation, 'y', targetAngle, Math.max(0.001, deltaSeconds * 1.4))) {
			owner.userData.materialSourceReady = false;
			owner.userData.materialSourceState = 'rotating';
			return false;
		}
		owner.userData.activeMaterialGroup = targetGroup;
		owner.userData.materialSourceReady = true;
		owner.userData.materialSourceState = 'ready';
		delete owner.userData.materialSourceWaitingReason;
		return true;
	}

	private resolveMaterialSlotAnchor(slot: TwinMaterialSlotDefinition, preferredRuntimeOwnerId?: string) {
		const owner = this.getObjectRoot(slot.objectId);
		if (!owner) throw new Error(`物料槽位 ${slot.slotId} 的对象 ${slot.objectId} 不存在`);
		owner.updateMatrixWorld(true);
		let referenceAnchor: THREE.Object3D = slot.nodePath ? (this.findNode(owner, slot.nodePath) || owner) : owner;
		// 可变距夹具的取料中心来自当前真实剩余丝锭，尾批不能继续使用已取空的固定两排中心。
		if (slot.role === 'source' && slot.metadata?.contactFromMaterials === true && !slot.runtimeOwnerType) {
			const group = String(slot.metadata.entityGroup || owner.userData.activeMaterialGroup || '');
			const candidates: THREE.Object3D[] = [];
			owner.traverse(node => { if (node.userData.materialEntity && !node.userData.materialAttachedBy && (!slot.payloadType || node.userData.payloadType === slot.payloadType) && (!group || node.userData.materialSlotGroup === group)) candidates.push(node); });
			candidates.sort((a, b) => slot.metadata?.selectionOrder === 'grid-row-major'
				? Number(a.userData.materialGridRow || 0) - Number(b.userData.materialGridRow || 0) || Number(a.userData.materialGridColumn || 0) - Number(b.userData.materialGridColumn || 0)
				: b.getWorldPosition(new THREE.Vector3()).y - a.getWorldPosition(new THREE.Vector3()).y);
			const selected = candidates.slice(0, Math.max(1, Number(slot.metadata.contactBatchSize || 1)));
			if (selected.length) {
				const normal = vector(slot.contactNormalLocal || [0, 1, 0]).transformDirection(owner.matrixWorld);
				const world = selected.reduce((sum, node) => sum.add(node.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).multiplyScalar(1 / selected.length).addScaledVector(normal, Number(slot.metadata.contactSurfaceOffset || 0));
				return { owner, anchor: owner, world, baseLocal: owner.worldToLocal(world.clone()) };
			}
		}
		const referenceWorld = referenceAnchor.localToWorld(vector(slot.localPosition));
		if (!slot.runtimeOwnerType) return { owner, anchor: referenceAnchor, baseLocal: vector(slot.localPosition), world: referenceWorld };
		let runtimeOwner: THREE.Object3D | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		this.scene.traverse((node) => {
			if (node.userData?.transportUnitType !== slot.runtimeOwnerType || !node.userData?.twinEntityId) return;
			if (preferredRuntimeOwnerId && String(node.userData.twinEntityId) !== preferredRuntimeOwnerId) return;
			const distance = node.getWorldPosition(new THREE.Vector3()).distanceTo(referenceWorld);
			if (distance >= bestDistance) return;
			bestDistance = distance;
			runtimeOwner = node;
		});
		if (!runtimeOwner) return { owner, anchor: referenceAnchor, baseLocal: vector(slot.localPosition), world: referenceWorld };
		const anchor = slot.runtimeOwnerNodePath ? (this.findNode(runtimeOwner, slot.runtimeOwnerNodePath) || runtimeOwner) : runtimeOwner;
		anchor.updateMatrixWorld(true);
		return { owner: runtimeOwner, anchor, baseLocal: new THREE.Vector3(), world: anchor.getWorldPosition(new THREE.Vector3()) };
	}

	private resolveWorkPointWorld(workPoint: TwinWorkPointDefinition, offset?: TwinVector3) {
		if (workPoint.materialSlotId) {
			const slot = this.materialSlots.get(workPoint.materialSlotId);
			if (!slot) throw new Error(`工作点 ${workPoint.workPointId} 引用了不存在的物料槽位 ${workPoint.materialSlotId}`);
			if (slot.runtimeOwnerSelection === 'station-batch' && slot.distributePayloadAcrossRuntimeOwners) {
				if (slot.role === 'source' && slot.metadata?.contactFromMaterials === true) {
					const materials = this.findMaterialEntities(slot, slot.payloadType || '', undefined, slot.capacity || 1, slot.objectId);
					if (materials.length) return materials.reduce((sum, node) => sum.add(node.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).multiplyScalar(1 / materials.length).add(vector(workPoint.localPosition)).add(vector(offset));
				}
				const palletIds = this.getStationPalletIds(this.getObjectRoot(slot.objectId));
				const anchors = palletIds
					.map((palletId) => this.resolveMaterialSlotAnchor(slot, palletId).world)
					.filter((position) => Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z));
				if (anchors.length) {
					const center = anchors.reduce((total, position) => total.add(position), new THREE.Vector3()).multiplyScalar(1 / anchors.length);
					return center.add(vector(workPoint.localPosition)).add(vector(offset));
				}
			}
			const resolved = this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot));
			if (slot.metadata?.dynamicStackApproach === true && slot.stackPattern) {
				const pattern = slot.stackPattern;
				const level = Math.floor(Number(resolved.anchor.userData.stackItemCount || 0) / (pattern.rows * pattern.columns));
				return resolved.anchor.localToWorld(new THREE.Vector3(Number(pattern.originX || 0) + (pattern.columns - 1) * pattern.spacingX / 2,
					pattern.firstLayerY + level * pattern.layerPitch, Number(pattern.originZ || 0) + (pattern.rows - 1) * pattern.spacingZ / 2).add(vector(workPoint.localPosition)).add(vector(offset)));
			}
			if (slot.metadata?.dynamicStackApproach === true && slot.stackPatternSlotId) {
				const patternSlot = this.materialSlots.get(slot.stackPatternSlotId)!;
				const pattern = patternSlot.stackPattern!;
				const target = this.resolveMaterialSlotAnchor(patternSlot, this.preferredRuntimeOwnerId(patternSlot));
				const level = Number(target.anchor.userData.stackLayerMaterialCount || 0);
				return target.anchor.localToWorld(new THREE.Vector3(0, pattern.firstLayerY + level * pattern.layerPitch + Number(pattern.layerMaterialOffsetY || 0) + Number(pattern.separatorThickness || 0) / 2, 0).add(vector(workPoint.localPosition)).add(vector(offset)));
			}
			return resolved.anchor.localToWorld(resolved.baseLocal.clone().add(vector(workPoint.localPosition)).add(vector(offset)));
		}
		const owner = this.getObjectRoot(workPoint.objectId);
		if (!owner) throw new Error(`工作点 ${workPoint.workPointId} 的对象 ${workPoint.objectId} 不存在`);
		owner.updateMatrixWorld(true);
		let anchor: THREE.Object3D = owner;
		if (workPoint.nodePath) anchor = this.findNode(owner, workPoint.nodePath) || owner;
		const local = vector(workPoint.localPosition).add(vector(offset));
		return anchor.localToWorld(local);
	}

	/** 精确落料以夹持物真实底面和托盘支撑面计算 TCP 高度，兼容丝车正反面和尾批。 */
	private resolveToolTarget(actorRoot: THREE.Object3D, workPoint: TwinWorkPointDefinition, offset?: TwinVector3) {
		const target = this.resolveWorkPointWorld(workPoint, offset);
		const slot = workPoint.materialSlotId ? this.materialSlots.get(workPoint.materialSlotId) : undefined;
		const frame = workPoint.toolFrameId ? this.toolFrames.get(workPoint.toolFrameId) : undefined;
		const tool = frame ? actorRoot.getObjectByName(frame.nodePath) : undefined;
		if (slot?.metadata?.precisePlacement !== true || !slot.distributePayloadAcrossRuntimeOwners || !tool) return target;
		actorRoot.updateMatrixWorld(true);
		const materials: THREE.Object3D[] = [];
		tool.traverse(node => { if (node.userData.materialEntity && node.userData.materialAttachedBy) materials.push(node); });
		const ids = this.getStationPalletIds(actorRoot);
		if (!materials.length || ids.length < materials.length) return target;
		const tcpY = tool.localToWorld(vector(frame!.localPosition)).y;
		let height = 0;
		for (let i = 0; i < materials.length; i++) {
			const owner = this.resolveMaterialSlotAnchor(slot, ids[i]).owner;
			const support = owner.localToWorld(new THREE.Vector3(0, Number(owner.userData.smallPalletSupportSurfaceY || 0), 0)).y;
			height += support + .008 + tcpY - new THREE.Box3().setFromObject(materials[i]).min.y;
		}
		target.y = height / materials.length + Number(offset?.[1] || 0);
		return target;
	}

	private moveActorToWorkPoint(actorRoot: THREE.Object3D, actorNodePath: string | undefined, workPoint: TwinWorkPointDefinition, offset: TwinVector3 | undefined, deltaSeconds: number, speedRatio: number) {
		const targetWorld = this.resolveToolTarget(actorRoot, workPoint, offset);
		const configuredFrame = workPoint.toolFrameId ? this.toolFrames.get(workPoint.toolFrameId) : undefined;
		if (configuredFrame?.cartesianActuatorIds?.length) return this.moveCartesianTool(actorRoot, configuredFrame, targetWorld, deltaSeconds, speedRatio);
		// 六轴机械臂 IK 是内置组件运动学能力，不包含任何具体产线工艺；正式工程优先使用设计器示教 Pose。
		if (actorRoot.getObjectByName('Robot-Axis-1') && !actorNodePath) {
			const toolFrame = workPoint.toolFrameId ? this.toolFrames.get(workPoint.toolFrameId) : undefined;
			const slot = workPoint.materialSlotId ? this.materialSlots.get(workPoint.materialSlotId) : undefined;
			const slotOwner = slot ? this.getObjectRoot(slot.objectId) : undefined;
			const approach = slot?.metadata?.adaptiveGridGripper && slot.contactNormalLocal && slotOwner
				? vector(slot.contactNormalLocal).transformDirection(slotOwner.matrixWorld).negate() : undefined;
			if (!this.moveRobotToWorld(actorRoot, targetWorld, deltaSeconds, speedRatio, toolFrame, workPoint.role === 'place', approach)) return false;
			return toolFrame ? this.isToolFrameAtWorldTarget(actorRoot, toolFrame, targetWorld, actorRoot.userData.properties?.adaptiveGridGripper ? .003 : .12) : true;
		}
		const node = actorNodePath ? this.findNode(actorRoot, actorNodePath) : actorRoot;
		if (!node || node === actorRoot) return true;
		actorRoot.updateMatrixWorld(true);
		const targetLocal = actorRoot.worldToLocal(targetWorld.clone());
		return this.moveVector(node.position, targetLocal, deltaSeconds * 2.5 * speedRatio);
	}

	/** 使用桁架实际轴将 TCP 移到工作点，不拖动整座小车或夹具脱轨。 */
	private moveCartesianTool(actor: THREE.Object3D, frame: TwinToolFrameDefinition, target: THREE.Vector3, dt: number, speed: number) {
		const tcpNode = this.findNode(actor, frame.nodePath);
		if (!tcpNode) throw new Error(`工具 ${frame.toolFrameId} 节点不存在`);
		actor.updateMatrixWorld(true);
		let done = true;
		const commands: Array<{ definition: TwinActuatorDefinition; value: number }> = [];
		for (const id of frame.cartesianActuatorIds || []) {
			const definition = this.requireActuator(id);
			const node = this.findNode(actor, definition.nodePath);
			if (definition.objectId !== actor.userData.twinObjectId || definition.kind !== 'linear-axis' || !node?.parent) throw new Error(`工具 ${frame.toolFrameId} 平移轴 ${id} 配置无效`);
			const current = tcpNode.localToWorld(vector(frame.localPosition));
			const delta = node.parent.worldToLocal(target.clone()).sub(node.parent.worldToLocal(current));
			const axis = definition.motionAxis || 'y';
			const value = readActuatorNodeValue(node.position[axis] + delta[axis], definition);
			this.assertActuatorTarget(actor, definition, value);
			commands.push({ definition, value });
		}
		for (const { definition, value } of commands) if (!this.setActuatorValue(actor, definition, value, dt, speed)) done = false;
		actor.updateMatrixWorld(true);
		return done && this.isToolFrameAtWorldTarget(actor, frame, target, .005);
	}

	/** 变距夹具的物料挂点跟随实际吸盘节点，不能只更新装饰网格。 */
	private syncGridPayloadAnchors(channel: ChannelState) {
		const payload = channel.attachedPayload;
		const actor = this.getObjectRoot(channel.actorObjectId);
		if (!payload || !actor) return;
		actor.updateMatrixWorld(true);
		payload.traverse(node => {
			const name = node.userData.sourceGridAnchor;
			if (!name || !node.parent) return;
			const source = actor.getObjectByName(String(name));
			if (!source) return;
			node.position.copy(node.parent.worldToLocal(source.getWorldPosition(new THREE.Vector3())));
			node.quaternion.copy(node.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(source.getWorldQuaternion(new THREE.Quaternion())));
		});
		actor.updateMatrixWorld(true);
	}

	private palletMaterialTarget(slot: TwinMaterialSlotDefinition, palletId: string, material: THREE.Object3D) {
		const resolved = this.resolveMaterialSlotAnchor(slot, palletId);
		const world = resolved.world.clone();
		if (slot.metadata?.precisePlacement === true) {
			const support = Number(resolved.owner.userData.smallPalletSupportSurfaceY);
			if (Number.isFinite(support)) {
				const bounds = new THREE.Box3().setFromObject(material);
				world.y = resolved.owner.localToWorld(new THREE.Vector3(0, support, 0)).y + .008 + material.getWorldPosition(new THREE.Vector3()).y - bounds.min.y;
			}
		}
		return { ...resolved, world };
	}

	/** 按真实来源或到位托盘网格驱动 X/Z 变距轴；Y 偏差必须通过机器人姿态解决。 */
	private planGridPlacement(payload: THREE.Object3D, materials: THREE.Object3D[], palletIds: string[], slot: TwinMaterialSlotDefinition, gripper: THREE.Object3D) {
		const previous = payload.userData.gridPlacement;
		if (previous?.slotId === slot.slotId) return previous as { slotId: string; palletIds: string[]; phase: 'spread' | 'translate' };
		const count = materials.length;
		if (count > 12 || palletIds.length < count) throw new Error('变距配对缺少当前批次托盘');
		// 12 件最多 4096 个子集：求最小总行程的一对一匹配，不能用清单下标让吸盘交叉换位。
		const positions = materials.map(m => gripper.worldToLocal(m.getWorldPosition(new THREE.Vector3())));
		const targets = palletIds.slice(0, count).map(id => gripper.worldToLocal(this.palletMaterialTarget(slot, id, materials[0]).world));
		const costs = new Float64Array(1 << count); costs.fill(Infinity); costs[0] = 0;
		const chosen = new Int16Array(1 << count); chosen.fill(-1);
		for (let mask = 0; mask < costs.length; mask++) {
			let row = 0; for (let bits = mask; bits; bits &= bits - 1) row++;
			if (row >= count) continue;
			for (let column = 0; column < count; column++) if (!(mask & (1 << column))) {
				const next = mask | (1 << column);
				const cost = costs[mask] + (positions[row].x - targets[column].x) ** 2 + (positions[row].z - targets[column].z) ** 2;
				if (cost < costs[next]) { costs[next] = cost; chosen[next] = column; }
			}
		}
		const mapped = new Array<string>(count);
		for (let row = count - 1, mask = costs.length - 1; row >= 0; row--) { const column = chosen[mask]; mapped[row] = palletIds[column]; mask ^= 1 << column; }
		return payload.userData.gridPlacement = { slotId: slot.slotId, palletIds: mapped, phase: 'spread' as 'spread' | 'translate' };
	}

	/** 先形成分排安全间距，再压缩列距；物料不互穿，挂点始终随实际轴移动。 */
	private alignPayloadGrid(channel: ChannelState, actor: THREE.Object3D, action: TwinBehaviorActionDefinition, dt: number) {
		const gripper = actor.getObjectByName('RobotGridGripper-2x6');
		if (!gripper || actor.userData.properties?.adaptiveGridGripper !== true) throw new Error('当前机器人没有可变距夹具，不能执行网格对齐');
		const source = action.sourceSlotId ? this.materialSlots.get(action.sourceSlotId) : undefined;
		const target = action.targetSlotId ? this.materialSlots.get(action.targetSlotId) : undefined;
		const materials = source ? this.findMaterialEntities(source, action.payloadType || 'silk-cake', undefined, action.payloadCount || 12, channel.actorObjectId)
			: channel.attachedPayload ? this.getPayloadMaterials(channel.attachedPayload) : [];
		if (!materials.length) { channel.status = 'waiting-material'; return false; }
		const stationPalletIds = this.getStationPalletIds(actor);
		const placement = target && channel.attachedPayload ? this.planGridPlacement(channel.attachedPayload, materials, stationPalletIds, target, gripper) : undefined;
		const palletIds = placement?.palletIds || stationPalletIds;
		const sourceOwner = source ? this.getObjectRoot(source.objectId) : undefined;
		const normal = source && sourceOwner ? vector(source.contactNormalLocal || [0, 1, 0]).transformDirection(sourceOwner.matrixWorld) : undefined;
		let done = true;
		const commands: Array<{ actuator: TwinActuatorDefinition; value: number }> = [];
		actor.updateMatrixWorld(true);
		for (const [index, material] of materials.entries()) {
			const headIndex = source ? index + 1 : Number(material.userData.robotGripperAnchorIndex || index + 1);
			const head = gripper.getObjectByName(`RobotGripperHead-${headIndex}`);
			const anchor = gripper.getObjectByName(`RobotPayloadAnchor-${headIndex}`);
			if (!head || !anchor) throw new Error(`缺少抓位 ${headIndex}`);
			const desired = source
				? material.getWorldPosition(new THREE.Vector3()).addScaledVector(normal!, Number(source.metadata?.contactSurfaceOffset || 0))
				: target && palletIds[index] ? this.palletMaterialTarget(target, palletIds[index], material).world.add(vector(action.approachOffset)) : undefined;
			if (!desired) throw new Error('夹具变距没有对应的到位托盘');
			const current = source ? anchor.getWorldPosition(new THREE.Vector3()) : material.getWorldPosition(new THREE.Vector3());
			const delta = gripper.worldToLocal(desired).sub(gripper.worldToLocal(current));
			if (Math.abs(delta.y) > .04) throw new Error(`抓位 ${headIndex} 接触面高度偏差 ${delta.y.toFixed(3)}m，不能用变距轴代替机器人接近`);
			for (const axis of ['x', 'z'] as const) {
				if (placement?.phase === 'spread' && axis === 'x') continue;
				const actuator = [...this.actuators.values()].find(a => a.objectId === channel.actorObjectId && a.nodePath === head.name && a.kind === 'linear-axis' && a.motionAxis === axis);
				if (!actuator) throw new Error(`抓位 ${headIndex} 缺少 ${axis} 变距轴`);
				const value = readActuatorNodeValue(head.position[axis] + delta[axis], actuator);
				this.assertActuatorTarget(actor, actuator, value);
				commands.push({ actuator, value });
			}
		}
		for (const { actuator, value } of commands) if (!this.setActuatorValue(actor, actuator, value, dt, action.speedRatio || 1)) done = false;
		if (done && placement?.phase === 'spread') { placement.phase = 'translate'; return false; }
		return done;
	}

	private moveRobotToWorld(actorRoot: THREE.Object3D, targetWorld: THREE.Vector3, deltaSeconds: number, speedRatio: number, toolFrame?: TwinToolFrameDefinition, preferToolDown = false, requiredApproachWorld?: THREE.Vector3) {
		actorRoot.updateMatrixWorld(true);
		const target = actorRoot.worldToLocal(targetWorld.clone());
		const axis1 = actorRoot.getObjectByName('Robot-Axis-1');
		const axis2 = actorRoot.getObjectByName('Robot-Axis-2');
		const axis3 = actorRoot.getObjectByName('Robot-Axis-3');
		const axis5 = actorRoot.getObjectByName('Robot-Axis-5');
		if (!axis1 || !axis2 || !axis3) throw new Error('机械臂缺少运动学关节，不能判定到位');
		if (![target.x, target.y, target.z].every(Number.isFinite)) throw new Error('机械臂工作点目标不是有限坐标');
		const jointDefinitions = new Map<THREE.Object3D, TwinActuatorDefinition>();
		for (const [node, axis] of [[axis1, 'y'], [axis2, 'z'], [axis3, 'z'], [axis5, 'z']] as const) {
			if (!node) continue;
			const definition = [...this.actuators.values()].find(a => a.objectId === actorRoot.userData.twinObjectId && this.findNode(actorRoot, a.nodePath) === node && a.kind === 'rotary-joint' && a.motionAxis === axis);
			if (definition) jointDefinitions.set(node, definition);
		}
		// 选取行程内的等价角表示，而不是把超限角度截到边界。有限位轴按真实坐标距离评分。
		const fitJoint = (angle: number, node: THREE.Object3D, axis: 'y' | 'z', fallbackMin: number, fallbackMax: number): number | undefined => {
			const definition = jointDefinitions.get(node);
			const min = definition ? writeActuatorNodeValue(definition.minValue ?? -Infinity, definition) : fallbackMin;
			const max = definition ? writeActuatorNodeValue(definition.maxValue ?? Infinity, definition) : fallbackMax;
			const canonical = normalizedAngleDelta(0, angle), period = 2 * Math.PI;
			const first = Math.ceil((min - canonical) / period), last = Math.floor((max - canonical) / period);
			if (first > last) return undefined;
			const turn = Math.max(first, Math.min(last, Math.round((node.rotation[axis] - canonical) / period)));
			const result = canonical + turn * period;
			if (!Number.isFinite(result) || (definition && actuatorTargetError(definition, readActuatorNodeValue(result, definition)))) return undefined;
			return result;
		};
		const properties = (actorRoot.userData?.properties || {}) as Record<string, unknown>;
		const upperArm = Math.max(0.4, Number(properties.upperArmLength || 1.65));
		const forearm = Math.max(0.4, Number(properties.forearmLength || 1.45)) + Math.max(0, Number(axis5?.position.y || 0));
		const horizontal = Math.hypot(target.x, target.z);
		const shoulderY = axis1.position.y + axis2.position.y;
		const vertical = target.y - shoulderY;
		let toolTail = 0;
		const frameNode = toolFrame ? this.findNode(actorRoot, toolFrame.nodePath) : undefined;
		if (axis5 && frameNode) {
			let cursor: THREE.Object3D | null = frameNode;
			while (cursor && cursor !== axis5) {
				toolTail += Math.max(0, Number(cursor.position.y || 0));
				cursor = cursor.parent;
			}
			if (cursor === axis5) toolTail += Number(toolFrame?.localPosition?.[1] || 0);
			else toolTail = 0;
		}
		const currentPhi = (axis2.rotation.z || 0) + (axis3.rotation.z || 0) + (axis5?.rotation.z || 0);
		const desiredPhi = preferToolDown ? Math.PI : currentPhi;
		let solution: { j1: number; j2: number; j3: number; j5: number; score: number } | undefined;
		const sampleCount = toolTail > 0 ? 240 : 1;
		const baseAzimuth = Math.atan2(-target.z, target.x);
		// 六轴机器人同一 TCP 往往存在“正径向伸展”和“负径向折叠”两套等价基座解。
		// 只搜索正径向会让 J1 为了西侧目标白白旋转约 180°；示教 Pose 则可以保持 J1≈0，
		// 由 J2/J3 折叠到另一侧。两套都搜索，并把 J1 位移纳入总代价，选择连续且最短的关节解。
		for (const radialSign of [1, -1] as const) {
			const j1 = fitJoint(baseAzimuth + (radialSign < 0 ? Math.PI : 0), axis1, 'y', -Math.PI, Math.PI);
			if (j1 === undefined) continue;
			for (let sample = 0; sample <= sampleCount; sample += 1) {
				const phi = toolTail > 0 ? -Math.PI + sample / sampleCount * Math.PI * 2 : currentPhi;
				const radial = radialSign * horizontal + toolTail * Math.sin(phi);
				const wristVertical = vertical - toolTail * Math.cos(phi);
				const d2 = radial * radial + wristVertical * wristVertical;
				const cosElbow = (d2 - upperArm * upperArm - forearm * forearm) / (2 * upperArm * forearm);
				if (cosElbow < -1.000001 || cosElbow > 1.000001) continue;
				for (const elbowSign of [1, -1]) {
					const j3 = fitJoint(elbowSign * Math.acos(THREE.MathUtils.clamp(cosElbow, -1, 1)), axis3, 'z', -2.8, 2.8);
					if (j3 === undefined) continue;
					const shoulderFromX = Math.atan2(wristVertical, radial) - Math.atan2(forearm * Math.sin(j3), upperArm + forearm * Math.cos(j3));
					const j2 = fitJoint(shoulderFromX - Math.PI / 2, axis2, 'z', -2.6, 1.4);
					if (j2 === undefined) continue;
					const rawJ5 = Math.atan2(Math.sin(phi - j2 - j3), Math.cos(phi - j2 - j3));
					const j5 = axis5 ? fitJoint(rawJ5, axis5, 'z', -2.2, 2.2) : 0;
					if (j5 === undefined) continue;
					const approachTarget = requiredApproachWorld?.clone().transformDirection(actorRoot.matrixWorld.clone().invert());
					const requiredPhi = approachTarget ? Math.atan2(-(approachTarget.x * Math.cos(j1) - approachTarget.z * Math.sin(j1)), approachTarget.y) : desiredPhi;
					const orientationError = Math.abs(normalizedAngleDelta(phi, requiredPhi));
					if (approachTarget && orientationError > 0.015) continue;
					const movement = Math.abs(axis1.rotation.y - j1)
						+ Math.abs(axis2.rotation.z - j2) + Math.abs(axis3.rotation.z - j3)
						+ (axis5 ? Math.abs(axis5.rotation.z - j5) : 0);
					const score = orientationError * (preferToolDown ? 5 : 1) + movement * 0.04;
					if (!solution || score < solution.score) solution = { j1, j2, j3, j5, score };
				}
			}
		}
		if (!solution) throw new Error(`机械臂 ${actorRoot.userData.twinObjectId || actorRoot.name} 目标不可达：世界坐标 [${targetWorld.toArray().map(v => v.toFixed(3)).join(', ')}]，在配置关节行程及工具姿态约束内无解；命令已拒绝`);
		const targets = [
			[axis1, solution.j1, 'y'],
			[axis2, solution.j2, 'z'],
			[axis3, solution.j3, 'z'],
			...(axis5 ? [[axis5, solution.j5, 'z']] : []),
		] as Array<[THREE.Object3D, number, 'x' | 'y' | 'z']>;
		const maxStep = deltaSeconds * 1.8 * speedRatio;
		let done = true;
		for (const [node, angle] of targets) {
			const definition = jointDefinitions.get(node);
			if (definition) this.assertActuatorTarget(actorRoot, definition, readActuatorNodeValue(angle, definition));
		}
		for (const [node, targetAngle, axis] of targets) {
			const actuator = jointDefinitions.get(node);
			if (actuator) {
				// IK 和示教 Pose 必须共用同一个轴目标；直接写节点会被下一帧 ActuatorRuntime 的旧目标覆盖。
				const value = readActuatorNodeValue(targetAngle, actuator);
				if (!this.setActuatorValue(actorRoot, actuator, value, deltaSeconds, speedRatio)) done = false;
			} else if (!this.moveScalar(node.rotation, axis, targetAngle, maxStep)) done = false;
		}
		if (done) actorRoot.updateMatrixWorld(true);
		return done;
	}

	private isToolFrameAtWorldTarget(actorRoot: THREE.Object3D, toolFrame: TwinToolFrameDefinition, targetWorld: THREE.Vector3, tolerance: number) {
		const attachNode = this.findNode(actorRoot, toolFrame.nodePath);
		if (!attachNode) return false;
		actorRoot.updateMatrixWorld(true);
		const tcpWorld = attachNode.localToWorld(vector(toolFrame.localPosition));
		return tcpWorld.distanceTo(targetWorld) <= Math.max(0.01, tolerance);
	}

	private moveActorHome(actorObjectId: string, actorRoot: THREE.Object3D, deltaSeconds: number, speedRatio: number) {
		const configured = [...this.actuators.values()].filter((actuator) => actuator.objectId === actorObjectId && actuator.homeValue !== undefined && actuator.kind !== 'gripper');
		if (configured.length) {
			for (const actuator of configured) this.assertActuatorTarget(actorRoot, actuator, Number(actuator.homeValue));
			let done = true;
			for (const actuator of configured) if (!this.setActuatorValue(actorRoot, actuator, Number(actuator.homeValue), deltaSeconds, speedRatio)) done = false;
			return done;
		}
		const poses = this.basePoses.get(actorObjectId) || [];
		if (!poses.length) return true;
		const maxStep = deltaSeconds * 1.8 * speedRatio;
		let done = true;
		for (const pose of poses) {
			for (const axis of ['x', 'y', 'z'] as const) if (!this.moveAngle(pose.object.rotation, axis, pose.rotation[axis], maxStep)) done = false;
			if (!this.moveVector(pose.object.position, pose.position, maxStep)) done = false;
		}
		actorRoot.updateMatrixWorld(true);
		return done;
	}

	private moveAxis(actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, deltaSeconds: number, speedRatio: number) {
		if (!action.axis || !Number.isFinite(action.axisValue)) return true;
		const node = action.actorNodePath ? this.findNode(actorRoot, action.actorNodePath) : actorRoot;
		if (!node) return true;
		return this.moveScalar(node.position, action.axis, Number(action.axisValue), deltaSeconds * 3 * speedRatio);
	}

	private moveVector(current: THREE.Vector3, target: THREE.Vector3, maxStep: number) {
		const distance = current.distanceTo(target);
		if (distance <= Math.max(0.001, maxStep)) {
			current.copy(target);
			return true;
		}
		current.add(target.clone().sub(current).normalize().multiplyScalar(maxStep));
		return false;
	}

	private moveScalar(vectorValue: THREE.Vector3 | THREE.Euler, axis: 'x' | 'y' | 'z', target: number, maxStep: number) {
		const current = vectorValue[axis];
		const delta = target - current;
		if (Math.abs(delta) <= Math.max(0.001, maxStep)) {
			vectorValue[axis] = target;
			return true;
		}
		vectorValue[axis] = current + Math.sign(delta) * maxStep;
		return false;
	}

	private moveAngle(rotation: THREE.Euler, axis: 'x' | 'y' | 'z', target: number, maxStep: number) {
		const current = rotation[axis];
		const delta = normalizedAngleDelta(current, target);
		// target 可能是 [-π,π] 中的等价表示；保持连续角，禁止在到位帧产生约 360° 数值跳变。
		const continuousTarget = current + delta;
		if (Math.abs(delta) <= Math.max(0.001, maxStep)) {
			rotation[axis] = continuousTarget;
			return true;
		}
		rotation[axis] = current + Math.sign(delta) * maxStep;
		return false;
	}

	private attachPayload(channel: ChannelState, actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, actorObjectId: string) {
		if (channel.attachedPayload) {
			if (channel.externallyManaged) throw new Error('当前动作通道已持有物料，不能重复挂接');
			return true;
		}
		if (channel.placedPayload) {
			this.releasePayload(channel.placedPayload);
			channel.placedPayload = undefined;
		}
		const workPoint = action.workPointId ? this.workPoints.get(action.workPointId) : undefined;
		const sourceSlotId = action.sourceSlotId || workPoint?.materialSlotId;
		const sourceSlot = sourceSlotId ? this.materialSlots.get(sourceSlotId) : undefined;
		const payloadType = action.payloadType || sourceSlot?.payloadType || 'payload';
		const toolFrameId = action.toolFrameId || workPoint?.toolFrameId;
		const toolFrame = toolFrameId ? this.toolFrames.get(toolFrameId) : undefined;
		const attachNode = this.resolveAttachNode(actorRoot, action.actorNodePath || channel.actorNodePath, toolFrameId);
		if (channel.externallyManaged) {
			if (!sourceSlot || !toolFrame || toolFrame.objectId !== actorObjectId || !this.findNode(actorRoot, toolFrame.nodePath)) throw new Error('挂接必须配置属于当前设备的有效 TCP 和来源槽位');
			this.assertPayloadType(payloadType, sourceSlot, toolFrame);
			if (this.heldMaterials(toolFrameId!).length) throw new Error('工具已被其它动作占用，禁止重复抓取');
			if (!this.isMaterialSlotPresent(sourceSlot)) { channel.status = 'waiting-station'; return false; }
			if (!this.gripperClosed(this.toolGripper(toolFrame))) { channel.status = 'waiting-interlock'; return false; }
			if (!this.materialContact(toolFrame, sourceSlot, workPoint)) { channel.status = 'waiting-contact'; return false; }
		}
		if (sourceSlot && toolFrame && (sourceSlot.contactTolerance !== undefined || sourceSlot.contactNormalLocal) && !this.isToolFrameInContact(attachNode, toolFrame, sourceSlot)) {
			channel.status = 'waiting-contact';
			return false;
		}
		const requestedCount = Math.max(1, Number(action.payloadCount || 1));
		const minimumRequestedCount = action.allowPartialPayload === true
			? Math.min(requestedCount, Math.max(1, Math.floor(Number(action.minimumPayloadCount || 1))))
			: requestedCount;
		if (sourceSlot) this.ensureSimulationMaterialTemplate(sourceSlot, channel.externallyManaged === true);
		let realEntities = sourceSlot ? this.findMaterialEntities(sourceSlot, payloadType, action.payloadEntityId, requestedCount, actorObjectId) : [];
		if (!channel.externallyManaged && sourceSlot && realEntities.length < minimumRequestedCount && this.trySimulationMaterialReplenish(sourceSlot)) {
			realEntities = this.findMaterialEntities(sourceSlot, payloadType, action.payloadEntityId, requestedCount, actorObjectId);
		}
		let payload: THREE.Object3D;
		if (sourceSlot && realEntities.length < minimumRequestedCount) {
			channel.status = 'waiting-material';
			return false;
		}
		if (realEntities.length) {
			if (channel.externallyManaged) this.assertMaterialIdentity(realEntities);
			// 先检查整批，再改归属；同一 fixed tick 中后来的抓取会看到占用状态。
			if (new Set(realEntities).size !== realEntities.length || realEntities.some(e => e.userData.materialAttachedBy)) throw new Error('待抓物料已被占用或重复，禁止交接');
			const grid = actorRoot.getObjectByName('RobotGridGripper-2x6');
			if (channel.externallyManaged && grid && attachNode === grid) for (const [i, entity] of realEntities.entries()) {
				const index = sourceSlot?.metadata?.adaptiveGridGripper ? i + 1 : (Math.max(1, Math.min(2, Number(entity.userData.materialGridRow || (i < 6 ? 1 : 2)))) - 1) * 6 + Math.max(1, Math.min(6, Number(entity.userData.materialGridColumn || (i % 6 + 1))));
				if (!grid.getObjectByName(`RobotPayloadAnchor-${index}`)) throw new Error(`夹具缺少第 ${index} 个物料挂点`);
			}
			const carrier = new THREE.Group();
			carrier.name = `BehaviorPayloadCarrier-${payloadType}`;
			carrier.userData.behaviorPayload = true;
			carrier.userData.behaviorPayloadCarrier = true;
			carrier.userData.realMaterialPayload = true;
			carrier.userData.payloadType = payloadType;
			carrier.userData.payloadEntityIds = realEntities.map((item) => item.userData.twinEntityId);
			attachNode.add(carrier);
			carrier.position.set(0, 0, 0);
			carrier.rotation.set(0, 0, 0);
			const gridGripper = payloadType === 'silk-cake' ? actorRoot.getObjectByName('RobotGridGripper-2x6') : undefined;
			for (const [entityIndex, entity] of realEntities.entries()) {
				const beforeHandoff = entity.getWorldPosition(new THREE.Vector3());
				if (gridGripper && attachNode === gridGripper) {
					const row = Math.max(1, Math.min(2, Number(entity.userData.materialGridRow || (entityIndex < 6 ? 1 : 2))));
					const column = Math.max(1, Math.min(6, Number(entity.userData.materialGridColumn || (entityIndex % 6 + 1))));
					const adaptive = sourceSlot?.metadata?.adaptiveGridGripper === true;
					const anchorIndex = adaptive ? entityIndex + 1 : (row - 1) * 6 + column;
					const referenceAnchor = gridGripper.getObjectByName(`RobotPayloadAnchor-${anchorIndex}`);
					if (!referenceAnchor) throw new Error(`2×6 机器人夹具缺少抓位锚点 RobotPayloadAnchor-${anchorIndex}`);
					const fixedAnchor = new THREE.Group();
					fixedAnchor.name = `BehaviorRobotPayloadAnchor-${anchorIndex}`;
					gridGripper.updateMatrixWorld(true);
					referenceAnchor.updateMatrixWorld(true);
					fixedAnchor.position.copy(carrier.worldToLocal(referenceAnchor.getWorldPosition(new THREE.Vector3())));
					const worldQuaternion = referenceAnchor.getWorldQuaternion(new THREE.Quaternion());
					const parentQuaternion = carrier.getWorldQuaternion(new THREE.Quaternion()).invert();
					fixedAnchor.quaternion.copy(parentQuaternion.multiply(worldQuaternion));
					fixedAnchor.userData.robotPayloadAnchor = true;
					fixedAnchor.userData.behaviorPayloadAnchor = true;
					fixedAnchor.userData.anchorIndex = anchorIndex;
					fixedAnchor.userData.row = row;
					fixedAnchor.userData.column = column;
					carrier.add(fixedAnchor);
					if (adaptive || channel.externallyManaged) {
						fixedAnchor.userData.sourceGridAnchor = referenceAnchor.name;
						fixedAnchor.attach(entity);
					} else {
						fixedAnchor.add(entity);
						entity.position.set(0, 0, 0); entity.rotation.set(0, 0, 0); entity.scale.set(1, 1, 1);
					}
					entity.userData.robotGripperAnchorIndex = anchorIndex;
					entity.userData.robotGripperAnchorRow = row;
					entity.userData.robotGripperAnchorColumn = column;
				} else {
					carrier.attach(entity);
				}
				entity.userData.materialAttachedBy = channel.channelKey;
				delete entity.userData.runtimeOwnerEntityId;
				delete entity.userData.runtimeOwnerType;
				delete entity.userData.runtimeOwnerItemIndex;
				delete entity.userData.runtimeOwnerItemCount;
				this.recordMaterialHandoff(entity, beforeHandoff);
			}
			payload = carrier;
		} else if (sourceSlot) {
			channel.status = 'waiting-material';
			return false;
		} else {
			payload = this.createPayload(payloadType, requestedCount);
			payload.userData.legacySyntheticPayload = true;
			attachNode.add(payload);
			payload.position.set(0, 0, 0);
			payload.rotation.set(0, 0, 0);
		}
		payload.userData.payloadType = payloadType;
		payload.userData.behaviorPayload = true;
		if (!payload.userData.realMaterialPayload) {
			payload.userData.twinEntityType = 'behavior-payload';
			payload.userData.twinEntityId = `${channel.channelKey}:${channel.completedActions + 1}`;
		}
		channel.attachedPayload = payload;
		channel.heldToolFrameId = toolFrameId;
		channel.status = 'acting';
		return true;
	}

	private getPayloadMaterials(payload: THREE.Object3D) {
		const materials: THREE.Object3D[] = [];
		payload.traverse((item) => { if (item.userData?.materialEntity === true) materials.push(item); });
		return materials;
	}

	/** 条件与强制交接检查共享真实场景数据；只读，不补料、不移动物料。 */
	private materialSlotAnchors(slot: TwinMaterialSlotDefinition) {
		if (!slot.runtimeOwnerType) return [this.resolveMaterialSlotAnchor(slot)];
		const ids: Array<string | undefined> = slot.runtimeOwnerSelection === 'station-batch' ? this.getStationPalletIds(this.getObjectRoot(slot.objectId)) : [undefined];
		return ids.map(id => this.resolveMaterialSlotAnchor(slot, id)).filter(r => r.owner.userData.transportUnitType === slot.runtimeOwnerType && (!ids[0] || ids.includes(String(r.owner.userData.twinEntityId))));
	}
	private isMaterialSlotPresent(slot: TwinMaterialSlotDefinition) { return this.materialSlotAnchors(slot).length > 0; }
	private materialSlotEntities(slot: TwinMaterialSlotDefinition, allTypes = false) {
		const result = new Set<THREE.Object3D>();
		const group = String(slot.metadata?.entityGroup || (slot.role === 'source' ? this.getObjectRoot(slot.objectId)?.userData.activeMaterialGroup : '') || '');
		for (const { anchor } of this.materialSlotAnchors(slot)) anchor.traverse(node => {
			if (node.userData.materialEntity && !node.userData.materialAttachedBy && (allTypes || !slot.payloadType || node.userData.payloadType === slot.payloadType) && (!group || node.userData.materialSlotGroup === group)) result.add(node);
		});
		return [...result];
	}
	private materialSlotFreeCapacity(slot: TwinMaterialSlotDefinition) {
		if (!this.isMaterialSlotPresent(slot)) return 0;
		const pattern = slot.stackPattern || (slot.stackPatternSlotId ? this.materialSlots.get(slot.stackPatternSlotId)?.stackPattern : undefined);
		const capacity = slot.capacity ?? (pattern ? (slot.stackPattern ? pattern.rows * pattern.columns * pattern.layers : pattern.layers) : 1);
		// 共用木托的丝锭/隔板槽按各自堆叠模式计数；普通槽位计入异类实物占用。
		const count = this.materialSlotEntities(slot, !pattern).length;
		if (slot.runtimeOwnerDistributionMode === 'one-per-owner') {
			const available = this.materialSlotAnchors(slot).filter(({ anchor }) => !this.getPayloadMaterials(anchor).length).length;
			return Math.max(0, Math.min(capacity - count, available));
		}
		return Math.max(0, capacity - count);
	}
	private heldMaterials(frameId: string) {
		return [...this.channels.values()].filter(c => c.heldToolFrameId === frameId && c.attachedPayload).flatMap(c => this.getPayloadMaterials(c.attachedPayload!));
	}
	/** 多夹具设备只能使用 TCP 同节点或祖先链上的唯一夹具，不能借另一只夹具的闭合状态。 */
	private toolGripper(frame: TwinToolFrameDefinition) {
		const root = this.getObjectRoot(frame.objectId), tcp = root && this.findNode(root, frame.nodePath);
		const contains = (parent: THREE.Object3D, child: THREE.Object3D) => { for (let n: THREE.Object3D | null = child; n; n = n.parent) if (n === parent) return true; return false; };
		const candidates = [...this.actuators.values()].filter(a => a.objectId === frame.objectId && a.kind === 'gripper').filter(a => { const node = root && this.findNode(root,a.nodePath); return node && tcp && (contains(node,tcp) || contains(tcp,node)); });
		if (candidates.length !== 1) throw new Error(`TCP ${frame.name} 必须对应唯一真实夹具，当前为 ${candidates.length} 个`);
		return candidates[0];
	}
	private gripperClosed(actuator: TwinActuatorDefinition) {
		const root = this.getObjectRoot(actuator.objectId), node = root && this.findNode(root, actuator.nodePath);
		return Boolean(node && (node.userData.closed ?? node.userData.gripClosed ?? node.userData.gripped) === true);
	}
	private materialContact(frame: TwinToolFrameDefinition, slot: TwinMaterialSlotDefinition, configured?: TwinWorkPointDefinition) {
		const actor = this.getObjectRoot(frame.objectId); if (!actor || !this.isMaterialSlotPresent(slot)) return false;
		const point = configured || [...this.workPoints.values()].find(p => p.materialSlotId === slot.slotId && p.toolFrameId === frame.toolFrameId && p.role === (slot.role === 'source' ? 'pick' : 'place'));
		const target = point ? this.resolveToolTarget(actor, point) : this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot)).world;
		if (!this.isToolFrameAtWorldTarget(actor, frame, target, Math.max(.005, Math.min(.14, Number(slot.contactTolerance ?? .04))))) return false;
		const node = this.findNode(actor,frame.nodePath);
		if (slot.contactNormalLocal && frame.approachDirectionLocal && node) {
			const approach = vector(frame.approachDirectionLocal).applyEuler(new THREE.Euler(...(frame.localRotation || [0,0,0]))).transformDirection(node.matrixWorld);
			const anchor = this.resolveMaterialSlotAnchor(slot,this.preferredRuntimeOwnerId(slot)).anchor;
			const normal = vector(slot.contactNormalLocal).transformDirection(anchor.matrixWorld);
			if (approach.dot(normal) > -.94) return false;
		}
		return true;
	}
	private readMaterialState(parts: string[]): unknown {
		const [kind,id,field,extra] = parts;
		if (kind === 'slot') {
			const slot = this.materialSlots.get(id); if (!slot) return undefined;
			if (field === 'present') return this.isMaterialSlotPresent(slot);
			if (field === 'freeCapacity') return this.materialSlotFreeCapacity(slot);
			const count = this.materialSlotEntities(slot).length;
			return field === 'availableCount' ? count : field === 'occupied' ? count > 0 : undefined;
		}
		if (kind === 'tool' && this.toolFrames.has(id)) { const count = this.heldMaterials(id).length; return field === 'empty' ? count === 0 : field === 'heldCount' ? count : undefined; }
		if (kind === 'gripper') { const a = this.actuators.get(id); return a?.kind === 'gripper' && field === 'closed' ? this.gripperClosed(a) : undefined; }
		if (kind === 'contact' && extra === 'ready') { const frame = this.toolFrames.get(id), slot = this.materialSlots.get(field); return frame && slot ? this.materialContact(frame,slot) : undefined; }
		return undefined;
	}

	/** 仅记录更换父节点瞬间的位移；不把上一帧正常机械运动误报为瞬移。 */
	private recordMaterialHandoff(material: THREE.Object3D, before: THREE.Vector3) {
		material.userData.materialHandoffDistance = before.distanceTo(material.getWorldPosition(new THREE.Vector3()));
		material.userData.materialHandoffSequence = Number(material.userData.materialHandoffSequence || 0) + 1;
	}

	private detachPayload(channel: ChannelState, workPoint: TwinWorkPointDefinition | undefined, action: TwinBehaviorActionDefinition) {
		const payload = channel.attachedPayload;
		if (!payload) { if (channel.externallyManaged) throw new Error('工具没有物料，禁止将空放料当作完成'); return true; }
		const releasedMaterials = this.getPayloadMaterials(payload);
		const targetSlotId = action.targetSlotId || workPoint?.materialSlotId;
		const targetSlot = targetSlotId ? this.materialSlots.get(targetSlotId) : undefined;
		if (channel.externallyManaged) {
			const frameId = action.toolFrameId || workPoint?.toolFrameId;
			const frame = frameId ? this.toolFrames.get(frameId) : undefined;
			if (!targetSlot || !frame || frameId !== channel.heldToolFrameId) throw new Error('放料必须使用当前持料工具和有效目标槽位');
			this.assertMaterialIdentity(releasedMaterials);
			for (const material of releasedMaterials) this.assertPayloadType(String(material.userData.payloadType || ''), targetSlot, frame);
			if (!this.isMaterialSlotPresent(targetSlot)) { channel.status = 'waiting-station'; return false; }
			const count = this.getPayloadMaterials(payload).length;
			if (!count || count > this.materialSlotFreeCapacity(targetSlot)) { channel.status = 'waiting-material'; return false; }
			if (!this.materialContact(frame, targetSlot, workPoint)) { channel.status = 'waiting-contact'; return false; }
			this.toolGripper(frame);
			// Place 是接触放料复合节点：完成交接后同帧松爪，再于下一帧退回。
			// 不允许先松爪再发现目标满位而把物料留在空中。
		}
		if (workPoint?.role === 'place' && action.toolFrameId) {
			const actorRoot = this.getObjectRoot(channel.actorObjectId);
			const toolFrame = this.toolFrames.get(action.toolFrameId);
			const targetWorld = actorRoot ? this.resolveToolTarget(actorRoot, workPoint) : this.resolveWorkPointWorld(workPoint);
			// Place/Detach 的接触确认属于 ToolFrame/TCP 语义，而不是六轴机器人专属逻辑。
			// 丝锭桁架、隔板桁架和天盖桁架同样通过声明式 ToolFrame 执行放料；
			// 如果强制要求 Robot-Axis-1，这些设备永远只能停在 waiting-contact，最终超时为 error。
			if (!actorRoot || !toolFrame || !this.isToolFrameAtWorldTarget(actorRoot, toolFrame, targetWorld, 0.14)) {
				channel.status = 'waiting-contact';
				return false;
			}
		}
		if (targetSlot?.distributePayloadAcrossRuntimeOwners) {
			if (!this.distributePayloadAcrossStationPallets(channel, payload, targetSlot)) return false;
		} else if (targetSlot?.stackPattern) {
			this.placeStackPayload(payload, targetSlot);
		} else if (targetSlot && (targetSlot.stackPatternSlotId || String(targetSlot.metadata?.stackPatternSlotId || ''))) {
			if (!this.placeLayerMaterialPayload(payload, targetSlot)) return false;
		} else if (targetSlot) {
			const resolved = this.resolveMaterialSlotAnchor(targetSlot, this.preferredRuntimeOwnerId(targetSlot));
			if (channel.externallyManaged) {
				for (const material of this.getPayloadMaterials(payload)) { const before = material.getWorldPosition(new THREE.Vector3()); resolved.anchor.attach(material); this.recordMaterialHandoff(material, before); }
				payload.removeFromParent();
			} else {
				resolved.anchor.add(payload);
				payload.position.copy(resolved.baseLocal).add(workPoint ? vector(workPoint.localPosition) : new THREE.Vector3());
				const rotation = targetSlot.localRotation || workPoint?.localRotation || [0, 0, 0];
				payload.rotation.set(rotation[0], rotation[1], rotation[2]);
			}
		} else {
			this.scene.attach(payload);
		}
		if (!targetSlot && workPoint) {
			const target = this.resolveWorkPointWorld(workPoint);
			payload.position.copy(target);
		}
		if (channel.externallyManaged) {
			const frame = this.toolFrames.get(channel.heldToolFrameId!)!, grip = this.toolGripper(frame);
			this.setActuatorValue(this.getObjectRoot(frame.objectId)!, grip, false, 0, 1);
		}
		payload.traverse((entity) => {
			if (entity.userData?.materialEntity) delete entity.userData.materialAttachedBy;
		});
		for (const material of releasedMaterials) delete material.userData.materialAttachedBy;
		payload.userData.placedByBehavior = true;
		channel.placedPayload = payload;
		channel.attachedPayload = undefined;
		channel.heldToolFrameId = undefined;
		return true;
	}

	private distributePayloadAcrossStationPallets(channel: ChannelState, payload: THREE.Object3D, slot: TwinMaterialSlotDefinition) {
		const stationPalletIds = this.getStationPalletIds(this.getObjectRoot(channel.actorObjectId));
		const planned = payload.userData.gridPlacement?.slotId === slot.slotId ? payload.userData.gridPlacement.palletIds as string[] : undefined;
		if (planned && (new Set(planned).size !== planned.length || planned.some(id => !stationPalletIds.includes(id)))) throw new Error('变距目标不再属于当前到位批次，禁止错托放料');
		const palletIds = planned || stationPalletIds;
		const materials = this.getPayloadMaterials(payload);
		const distributionMode = slot.runtimeOwnerDistributionMode || 'balanced';
		if (distributionMode === 'one-per-owner') {
			const allowPartial = slot.allowPartialRuntimeOwnerDistribution === true;
			if (!palletIds.length || !materials.length || materials.length > palletIds.length || (!allowPartial && materials.length !== palletIds.length)) {
				channel.status = 'waiting-station';
				return false;
			}
			// 先验证全部目标，防止后一个目标失败时前一个已经松爪。
			const placements = materials.map((material, index) => {
				const resolved = this.resolveMaterialSlotAnchor(slot, palletIds[index]);
				const preciseTarget = slot.metadata?.precisePlacement ? this.palletMaterialTarget(slot, palletIds[index], material).world : undefined;
				if (channel.externallyManaged && this.getPayloadMaterials(resolved.anchor).length) throw new Error('目标托盘已有物料，禁止覆盖');
				if (preciseTarget && material.getWorldPosition(new THREE.Vector3()).distanceTo(preciseTarget) > .035) throw new Error(`丝锭 ${material.userData.twinEntityId} 尚未与目标托盘逐件对齐，禁止松爪`);
				return { material, resolved, preciseTarget };
			});
			for (const [index, {material, resolved, preciseTarget}] of placements.entries()) {
				const beforeHandoff = material.getWorldPosition(new THREE.Vector3());
				resolved.anchor.attach(material);
				if (preciseTarget) material.position.copy(resolved.anchor.worldToLocal(preciseTarget));
				else {
					material.position.set(0, 0, 0);
					const placedRotation = slot.localRotation || [0, 0, 0];
					material.rotation.set(placedRotation[0], placedRotation[1], placedRotation[2]);
					this.settleMaterialOnRuntimeOwner(material, resolved.owner);
				}
				delete material.userData.materialAttachedBy;
				material.userData.runtimeOwnerEntityId = palletIds[index];
				material.userData.runtimeOwnerType = resolved.owner.userData?.transportUnitType;
				material.userData.runtimeOwnerItemIndex = 1;
				material.userData.runtimeOwnerItemCount = 1;
				if (slot.placedStage) material.userData.materialStage = slot.placedStage;
				this.recordMaterialHandoff(material, beforeHandoff);
			}
			payload.removeFromParent();
			return true;
		}
		if (!palletIds.length || materials.length < palletIds.length || materials.length % palletIds.length !== 0) {
			channel.status = 'waiting-station';
			return false;
		}
		const levels = materials.length / palletIds.length;
		const itemOffset = vector(slot.runtimeOwnerItemOffset);
		for (let index = 0; index < materials.length; index += 1) {
			const palletIndex = index % palletIds.length;
			const level = Math.floor(index / palletIds.length);
			const resolved = this.resolveMaterialSlotAnchor(slot, palletIds[palletIndex]);
			const material = materials[index];
			resolved.anchor.attach(material);
			material.position.copy(itemOffset.clone().multiplyScalar(level));
			const placedRotation = slot.localRotation || [0, 0, 0];
			material.rotation.set(placedRotation[0], placedRotation[1], placedRotation[2]);
			this.settleMaterialOnRuntimeOwner(material, resolved.owner);
			delete material.userData.materialAttachedBy;
			material.userData.runtimeOwnerEntityId = palletIds[palletIndex];
			material.userData.runtimeOwnerType = resolved.owner.userData?.transportUnitType;
			material.userData.runtimeOwnerItemIndex = level + 1;
			material.userData.runtimeOwnerItemCount = levels;
			if (slot.placedStage) material.userData.materialStage = slot.placedStage;
		}
		payload.removeFromParent();
		return true;
	}

	private settleMaterialOnRuntimeOwner(material: THREE.Object3D, runtimeOwner: THREE.Object3D) {
		const supportSurfaceY = Number(runtimeOwner.userData?.smallPalletSupportSurfaceY);
		if (!Number.isFinite(supportSurfaceY)) return;
		runtimeOwner.updateMatrixWorld(true);
		material.updateMatrixWorld(true);
		const supportWorldY = runtimeOwner.localToWorld(new THREE.Vector3(0, supportSurfaceY, 0)).y;
		const bounds = new THREE.Box3().setFromObject(material);
		if (bounds.isEmpty()) return;
		const clearance = 0.008;
		const correction = supportWorldY + clearance - bounds.min.y;
		if (Number.isFinite(correction) && Math.abs(correction) > 0.0001) material.position.y += correction;
		material.userData.runtimeOwnerSupportClearance = clearance;
	}

	private placeStackPayload(payload: THREE.Object3D, slot: TwinMaterialSlotDefinition) {
		const pattern = slot.stackPattern!;
		const resolved = this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot));
		const materials = this.getPayloadMaterials(payload);
		const perLayer = Math.max(1, pattern.columns * pattern.rows);
		const capacity = perLayer * pattern.layers;
		const current = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackItemCount || 0)));
		if (!materials.length) throw new Error(`码垛槽位 ${slot.slotId} 没有可放置的真实物料`);
		if (current + materials.length > capacity) throw new Error(`码垛槽位 ${slot.slotId} 已满：${current}/${capacity}`);
		const available = materials.map((_, offset) => current + offset);

		const placements = materials.map((material, offset) => {
			const targetAt = (index: number) => new THREE.Vector3(Number(pattern.originX || 0) + index % pattern.columns * pattern.spacingX,
				pattern.firstLayerY + Math.floor(index / perLayer) * pattern.layerPitch, Number(pattern.originZ || 0) + Math.floor(index % perLayer / pattern.columns) * pattern.spacingZ);
			const materialWorld = material.getWorldPosition(new THREE.Vector3());
			const index = slot.metadata?.precisePlacement ? available.slice().sort((a, b) => resolved.anchor.localToWorld(targetAt(a)).distanceToSquared(materialWorld) - resolved.anchor.localToWorld(targetAt(b)).distanceToSquared(materialWorld))[0] : current + offset;
			available.splice(available.indexOf(index), 1);
			if (slot.metadata?.precisePlacement && resolved.anchor.localToWorld(targetAt(index)).distanceTo(materialWorld) > .04) throw new Error(`码垛丝锭 ${material.userData.twinEntityId} 未贴合目标层槽位，禁止重新摆放`);
			return { material, index, materialWorld };
		});
		for (const {material, index, materialWorld} of placements) {
			const layer = Math.floor(index / perLayer);
			const cell = index % perLayer;
			const row = Math.floor(cell / pattern.columns);
			const column = cell % pattern.columns;
			resolved.anchor.attach(material);
			material.position.set(
				Number(pattern.originX || 0) + column * pattern.spacingX,
				pattern.firstLayerY + layer * pattern.layerPitch,
				Number(pattern.originZ || 0) + row * pattern.spacingZ,
			);
			if (!slot.metadata?.precisePlacement) material.rotation.set(0, 0, 0);
			delete material.userData.materialAttachedBy;
			material.userData.runtimeOwnerEntityId = resolved.owner.userData?.twinEntityId;
			material.userData.runtimeOwnerType = resolved.owner.userData?.transportUnitType;
			delete material.userData.runtimeOwnerItemIndex;
			delete material.userData.runtimeOwnerItemCount;
			if (slot.placedStage) material.userData.materialStage = slot.placedStage;
			material.userData.stackLayer = layer + 1;
			material.userData.stackRow = row + 1;
			material.userData.stackColumn = column + 1;
			material.userData.stackSlotId = `L${layer + 1}-R${row + 1}-C${column + 1}`;
			this.recordMaterialHandoff(material, materialWorld);
		}

		const nextCount = current + materials.length;
		resolved.anchor.userData.stackItemCount = nextCount;
		resolved.owner.userData.stackedItemCount = nextCount;
		resolved.owner.userData.stackLayerCount = Math.floor(nextCount / perLayer);
		this.syncStackCompletion(resolved.owner, resolved.anchor, pattern, slot.slotId);
		payload.removeFromParent();
	}

	private placeLayerMaterialPayload(payload: THREE.Object3D, slot: TwinMaterialSlotDefinition) {
		const patternSlotId = slot.stackPatternSlotId || String(slot.metadata?.stackPatternSlotId || '');
		const patternSlot = this.materialSlots.get(patternSlotId);
		if (!patternSlot?.stackPattern) return false;
		const pattern = patternSlot.stackPattern;
		const resolved = this.resolveMaterialSlotAnchor(patternSlot, this.preferredRuntimeOwnerId(patternSlot));
		const material = this.getPayloadMaterials(payload)[0];
		if (!material) return false;
		const perLayer = Math.max(1, pattern.columns * pattern.rows);
		const itemCount = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackItemCount || 0)));
		const layerMaterialCount = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackLayerMaterialCount || 0)));
		if (layerMaterialCount >= pattern.layers) throw new Error(`层间物料槽位 ${slot.slotId} 已满`);
		if (itemCount < (layerMaterialCount + 1) * perLayer) return false;

		const beforeHandoff = material.getWorldPosition(new THREE.Vector3());
		const target = new THREE.Vector3(0, pattern.firstLayerY + layerMaterialCount * pattern.layerPitch + Number(pattern.layerMaterialOffsetY ?? 0.21) + Number(pattern.separatorThickness || 0.05) / 2, 0);
		if (slot.metadata?.precisePlacement && resolved.anchor.localToWorld(target.clone()).distanceTo(beforeHandoff) > .04) throw new Error(`隔板 ${material.userData.twinEntityId} 未贴合目标层，禁止松爪`);
		resolved.anchor.attach(material);
		material.position.copy(target);
		if (!slot.metadata?.precisePlacement) material.rotation.set(0, 0, 0);
		delete material.userData.materialAttachedBy;
		material.userData.runtimeOwnerEntityId = resolved.owner.userData?.twinEntityId;
		material.userData.runtimeOwnerType = resolved.owner.userData?.transportUnitType;
		delete material.userData.runtimeOwnerItemIndex;
		delete material.userData.runtimeOwnerItemCount;
		if (slot.placedStage) material.userData.materialStage = slot.placedStage;
		material.userData.stackLayerMaterialIndex = layerMaterialCount + 1;
		this.recordMaterialHandoff(material, beforeHandoff);
		resolved.anchor.userData.stackLayerMaterialCount = layerMaterialCount + 1;
		resolved.owner.userData.stackedLayerMaterialCount = layerMaterialCount + 1;
		this.syncStackCompletion(resolved.owner, resolved.anchor, pattern, patternSlot.slotId);
		payload.removeFromParent();
		return true;
	}

	private syncStackCompletion(owner: THREE.Object3D, anchor: THREE.Object3D, pattern: NonNullable<TwinMaterialSlotDefinition['stackPattern']>, slotId?: string) {
		const capacity = pattern.columns * pattern.rows * pattern.layers;
		const itemCount = Number(anchor.userData.stackItemCount || 0);
		const layerMaterialCount = Number(anchor.userData.stackLayerMaterialCount || 0);
		const complete = itemCount >= capacity && (!pattern.layerMaterialRequired || layerMaterialCount >= pattern.layers);
		owner.userData.stackComplete = complete;
		owner.userData.readyForPostProcess = complete;
		owner.userData.stackCapacity = capacity;
		if (slotId) {
			this.semanticState.set(`${slotId}.complete`, complete);
			this.semanticState.set(`${slotId}.itemCount`, itemCount);
			this.semanticState.set(`${slotId}.layerMaterialCount`, layerMaterialCount);
		}
	}

	private createPayload(payloadType: string, count = 1) {
		const group = new THREE.Group();
		group.name = `BehaviorPayload-${payloadType}`;
		const material = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.04 });
		for (let index = 0; index < Math.max(1, count); index += 1) {
			const preview = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), material);
			preview.name = `Behavior-Payload-Preview-${index + 1}`;
			preview.position.x = (index - (Math.max(1, count) - 1) / 2) * 0.34;
			preview.userData.materialEntity = true;
			preview.userData.payloadType = payloadType;
			group.add(preview);
		}
		return group;
	}

	private findMaterialEntities(slot: TwinMaterialSlotDefinition, payloadType: string, payloadEntityId?: string, count = 1, actorObjectId?: string) {
		if (slot.runtimeOwnerSelection === 'station-batch' && actorObjectId) {
			const actorRoot = this.getObjectRoot(actorObjectId);
			const result: THREE.Object3D[] = [];
			for (const palletId of this.getStationPalletIds(actorRoot)) {
				const resolved = this.resolveMaterialSlotAnchor(slot, palletId);
				const candidates: Array<{ node: THREE.Object3D; worldY: number }> = [];
				resolved.anchor.traverse((node) => {
					if (node.userData?.materialEntity !== true || node.userData?.materialAttachedBy) return;
					if (payloadType && node.userData?.payloadType !== payloadType) return;
					if (payloadEntityId && node.userData?.twinEntityId !== payloadEntityId) return;
					candidates.push({ node, worldY: node.getWorldPosition(new THREE.Vector3()).y });
				});
				const selected = candidates.sort((left, right) => right.worldY - left.worldY)[0]?.node;
				if (selected) result.push(selected);
				if (result.length >= count) break;
			}
			return result;
		}
		const center = this.resolveMaterialSlotAnchor(slot).world;
		const slotOwner = this.getObjectRoot(slot.objectId);
		const entityGroup = String(slot.metadata?.entityGroup || slotOwner?.userData?.activeMaterialGroup || '');
		const candidates: Array<{ node: THREE.Object3D; distance: number; gridRow: number; gridColumn: number }> = [];
		const searchRoot: THREE.Object3D = !slot.runtimeOwnerType && slotOwner ? slotOwner : this.scene;
		searchRoot.traverse((node) => {
			if (node.userData?.materialEntity !== true) return;
			if (node.userData?.materialAttachedBy) return;
			if (payloadType && node.userData?.payloadType !== payloadType) return;
			if (payloadEntityId && node.userData?.twinEntityId !== payloadEntityId) return;
			if (entityGroup && String(node.userData?.materialSlotGroup || '') !== entityGroup) return;
			const position = node.getWorldPosition(new THREE.Vector3());
			candidates.push({
				node,
				distance: position.distanceTo(center),
				gridRow: Number(node.userData?.materialGridRow || Number.MAX_SAFE_INTEGER),
				gridColumn: Number(node.userData?.materialGridColumn || Number.MAX_SAFE_INTEGER),
			});
		});
		const gridRowMajor = slot.metadata?.selectionOrder === 'grid-row-major';
		return candidates.sort((left, right) => gridRowMajor
			? left.gridRow - right.gridRow || left.gridColumn - right.gridColumn || left.distance - right.distance
			: left.distance - right.distance).slice(0, count).map((item) => item.node);
	}

	private resolveAttachNode(actorRoot: THREE.Object3D, actorNodePath?: string, toolFrameId?: string) {
		if (toolFrameId) {
			const frame = this.toolFrames.get(toolFrameId);
			if (frame && frame.objectId === actorRoot.userData?.twinObjectId) {
				const node = this.findNode(actorRoot, frame.nodePath);
				if (node) return node;
			}
		}
		return (actorNodePath ? this.findNode(actorRoot, actorNodePath) : undefined) || actorRoot;
	}

	private isToolFrameInContact(attachNode: THREE.Object3D, toolFrame: TwinToolFrameDefinition, slot: TwinMaterialSlotDefinition) {
		attachNode.updateMatrixWorld(true);
		const tcpWorld = attachNode.localToWorld(vector(toolFrame.localPosition));
		const resolvedSlot = this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot));
		const tolerance = Math.max(0.01, Number(slot.contactTolerance ?? 0.10));
		if (tcpWorld.distanceTo(resolvedSlot.world) > tolerance) return false;
		if (!slot.contactNormalLocal || !toolFrame.approachDirectionLocal) return true;
		const approach = vector(toolFrame.approachDirectionLocal).normalize();
		const localRotation = toolFrame.localRotation || [0, 0, 0];
		approach.applyEuler(new THREE.Euler(localRotation[0], localRotation[1], localRotation[2]));
		approach.transformDirection(attachNode.matrixWorld).normalize();
		const surfaceNormal = vector(slot.contactNormalLocal).normalize().transformDirection(resolvedSlot.anchor.matrixWorld).normalize();
		return approach.dot(surfaceNormal) <= -0.94;
	}

	private getStationPalletIds(actorRoot?: THREE.Object3D) {
		return actorRoot ? this.stringArray(actorRoot.userData.stationPalletIds) : [];
	}

	private preferredRuntimeOwnerId(slot: TwinMaterialSlotDefinition) {
		if (slot.runtimeOwnerSelection !== 'station-batch') return undefined;
		return this.getStationPalletIds(this.getObjectRoot(slot.objectId))[0];
	}

	private ensureSimulationMaterialTemplate(slot: TwinMaterialSlotDefinition, captureForReset = false) {
		// 普通固定来源也要能复位，但这不授予自动补料能力；动态托盘由路线运行器恢复。
		if (this.manifest.runtime.dataMode !== 'simulation' || slot.role !== 'source' || slot.runtimeOwnerType || (!captureForReset && slot.metadata?.simulationReplenish !== true)) return;
		if (this.simulationMaterialTemplates.has(slot.slotId)) return;
		const owner = this.getObjectRoot(slot.objectId);
		if (!owner) return;
		const configuredGroups = Array.isArray(slot.metadata?.entityGroups)
			? slot.metadata!.entityGroups!.map((item) => String(item)).filter(Boolean)
			: String(slot.metadata?.entityGroup || '').trim() ? [String(slot.metadata?.entityGroup)] : [];
		const templates: SimulationMaterialTemplate[] = [];
		owner.traverse((node) => {
			if (node.userData?.materialEntity !== true || !node.parent) return;
			if (slot.payloadType && node.userData?.payloadType !== slot.payloadType) return;
			if (configuredGroups.length && !configuredGroups.includes(String(node.userData?.materialSlotGroup || ''))) return;
			node.userData.behaviorSourceSlotId = slot.slotId;
			templates.push({
				parent: node.parent,
				template: node.clone(true),
				sourceEntityId: String(node.userData?.twinEntityId || `${slot.slotId}:${templates.length + 1}`),
			});
		});
		if (templates.length) this.simulationMaterialTemplates.set(slot.slotId, templates);
	}

	private trySimulationMaterialReplenish(slot: TwinMaterialSlotDefinition) {
		if (this.manifest.runtime.dataMode !== 'simulation' || slot.role !== 'source' || slot.metadata?.simulationReplenish !== true) return false;
		this.ensureSimulationMaterialTemplate(slot);
		const templates = this.simulationMaterialTemplates.get(slot.slotId) || [];
		if (!templates.length) return false;
		const refillCount = this.simulationMaterialRefillCounts.get(slot.slotId) || 0;
		const refillLimit = Math.max(0, Math.floor(Number(slot.metadata?.simulationReplenishLimit || 0)));
		if (refillCount >= refillLimit) return false;
		const nextRefill = refillCount + 1;
		for (const source of templates) {
			const clone = source.template.clone(true);
			clone.userData.twinEntityId = `${source.sourceEntityId}:sim-refill:${nextRefill}`;
			clone.userData.materialReplenishCycle = nextRefill;
			clone.traverse((node) => { if (node.userData) delete node.userData.materialAttachedBy; });
			source.parent.add(clone);
		}
		this.simulationMaterialRefillCounts.set(slot.slotId, nextRefill);
		const owner = this.getObjectRoot(slot.objectId);
		if (owner) {
			owner.userData.simulationMaterialRefillCount = nextRefill;
			owner.userData.simulationMaterialRefillSlotId = slot.slotId;
		}
		return true;
	}

	/** 仅还原本执行器记录的源库存；不改动其他组件和现场遥测实体。 */
	private restoreSimulationMaterials() {
		const remove: THREE.Object3D[] = [];
		this.scene.traverse(node => {
			if (this.simulationMaterialTemplates.has(String(node.userData.behaviorSourceSlotId || '')) || node.userData.behaviorPayloadAnchor || node.userData.behaviorPayloadCarrier) remove.push(node);
		});
		for (const node of remove) node.removeFromParent(); // 几何与原组件共享，由组件生命周期统一释放。
		for (const [slotId, templates] of this.simulationMaterialTemplates) {
			for (const source of templates) source.parent.add(source.template.clone(true));
			const root = this.getObjectRoot(this.materialSlots.get(slotId)!.objectId);
			if (root) for (const key of ['activeMaterialGroup', 'materialSourceReady', 'materialSourceWaitingReason', 'materialSourceTargetGroup', 'materialSourceTargetAngle', 'materialSourceState', 'simulationMaterialRefillCount', 'simulationMaterialRefillSlotId']) delete root.userData[key];
		}
	}

	private stringArray(value: unknown) {
		return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
	}

	private numberRecord(value: unknown) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
		return Object.fromEntries(Object.entries(source).map(([key, count]) => [key, Math.max(0, Number(count) || 0)]));
	}

	private assertPayloadType(payloadType: string, slot: TwinMaterialSlotDefinition, frame: TwinToolFrameDefinition) {
		if (!payloadType || (slot.payloadType && slot.payloadType !== payloadType) || (frame.payloadTypes?.length && !frame.payloadTypes.includes(payloadType))) throw new Error(`物料类型 ${payloadType || '(空)'} 与槽位 ${slot.slotId} 或工具 ${frame.toolFrameId} 不匹配`);
	}
	private assertMaterialIdentity(materials: THREE.Object3D[]) {
		const ids = materials.map(m => m.userData.twinEntityId);
		if (ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim()) || new Set(ids).size !== ids.length) throw new Error('物料 ID 缺失或重复，禁止交接');
		const selected = new Set(ids), seen = new Set<string>();
		this.scene.traverse(node => { if (node.userData.materialEntity && selected.has(node.userData.twinEntityId)) {
			if (seen.has(node.userData.twinEntityId)) throw new Error(`物料 ID ${node.userData.twinEntityId} 在场景中重复，禁止交接`);
			seen.add(node.userData.twinEntityId);
		} });
	}
	private isInterlockSatisfied(interlockId: string) {
		const interlock = this.interlocks.get(interlockId);
		if (!interlock || !interlock.conditions.length) return false;
		const evaluate = (condition: TwinInterlockDefinition['conditions'][number]) => {
			const current = this.resolveSemanticValue(condition.source);
			if (!isKnownSignal(current)) return false;
			switch (condition.operator) {
				case 'truthy': return signalBoolean(current) === true;
				case 'falsy': return signalBoolean(current) === false;
				case 'equals': return current === condition.value;
				case 'notEquals': return current !== condition.value;
				default: return false;
			}
		};
		return interlock.mode === 'any' ? interlock.conditions.some(evaluate) : interlock.conditions.every(evaluate);
	}

	private resolveSemanticValue(source: string) {
		const material = parseMaterialStateRef(source);
		if (material) return this.readMaterialState(material);
		for (const slot of this.materialSlots.values()) {
			if (slot.runtimeOwnerSelection !== 'station-batch' || !source.startsWith(`${slot.slotId}.`)) continue;
			const field = source.slice(slot.slotId.length + 1);
			if (!['present', 'complete', 'itemCount', 'layerMaterialCount'].includes(field)) continue;
			const preferredId = this.preferredRuntimeOwnerId(slot);
			if (!preferredId) return field === 'complete' ? false : 0;
			const resolved = this.resolveMaterialSlotAnchor(slot, preferredId);
			if (String(resolved.owner.userData?.twinEntityId || '') !== preferredId) return field === 'complete' ? false : 0;
			if (field === 'present') return true;
			if (field === 'complete') return resolved.owner.userData.stackComplete === true;
			if (field === 'itemCount') return Number(resolved.anchor.userData.stackItemCount || 0);
			return Number(resolved.anchor.userData.stackLayerMaterialCount || 0);
		}
		const bindingId = source.startsWith('binding:') ? source.slice('binding:'.length) : source;
		const isBinding = source.startsWith('binding:') || this.manifest.bindings?.some(b => b.bindingId === source) || this.bindingValues.has(source);
		if (!isBinding && this.semanticState.has(source)) return this.semanticState.get(source);
		if (this.staleBindingIds.has(bindingId)) return undefined;
		return this.bindingValues.get(bindingId);
	}

	private applyStateAssignments(assignments?: TwinBehaviorActionDefinition['onStartState']) {
		for (const assignment of assignments || []) if (this.isReadOnlySignal(assignment.source || '')) throw new Error('绑定、物料及工位状态为只读，禁止动作状态赋值');
		for (const assignment of assignments || []) {
			const source = assignment.source?.trim();
			if (source) this.setSignal(source, assignment.value);
		}
	}

	private initializeSemanticState() {
		for (const behavior of this.manifest.behaviors || []) {
			this.applyStateAssignments(behavior.initialState);
		}
	}

	private captureActorBase(actorObjectId: string) {
		if (this.basePoses.has(actorObjectId)) return;
		const root = this.getObjectRoot(actorObjectId);
		if (!root) return;
		const poses: BasePose[] = [];
		const seen = new Set<THREE.Object3D>();
		for (const actuator of this.actuators.values()) {
			if (actuator.objectId !== actorObjectId) continue;
			const object = this.findNode(root, actuator.nodePath);
			if (!object || seen.has(object)) continue;
			seen.add(object);
			poses.push({ object, position: object.position.clone(), rotation: object.rotation.clone() });
		}
		this.basePoses.set(actorObjectId, poses);
	}

	private findNode(root: THREE.Object3D, path: string) {
		if (!path) return root;
		const exact = root.getObjectByName(path);
		if (exact) return exact;
		const parts = path.split('/').map((item) => item.trim()).filter(Boolean);
		let current: THREE.Object3D | undefined = root;
		for (const part of parts) current = current?.children.find((child) => child.name === part) || current?.getObjectByName(part);
		return current;
	}

	private clearPayloads() {
		for (const channel of this.channels.values()) {
			if (channel.attachedPayload) this.releasePayload(channel.attachedPayload);
			if (channel.placedPayload) this.releasePayload(channel.placedPayload);
			channel.attachedPayload = undefined;
			channel.heldToolFrameId = undefined;
			channel.placedPayload = undefined;
		}
	}

	private releasePayload(payload: THREE.Object3D) {
		if (payload.userData?.legacySyntheticPayload === true || payload.userData?.behaviorPayloadCarrier !== true) {
			this.disposePayload(payload);
			return;
		}
		const parent = payload.parent || this.scene;
		for (const child of [...payload.children]) {
			parent.attach(child);
			if (child.userData?.materialEntity) delete child.userData.materialAttachedBy;
		}
		payload.parent?.remove(payload);
	}

	private disposePayload(payload: THREE.Object3D) {
		payload.parent?.remove(payload);
		payload.traverse((object: any) => {
			object.geometry?.dispose?.();
			const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
			for (const material of materials) material.dispose?.();
		});
	}
}
