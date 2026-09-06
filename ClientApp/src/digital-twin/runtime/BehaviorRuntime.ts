import * as THREE from 'three';
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

type ChannelStatus = 'paused' | 'moving' | 'acting' | 'waiting-station' | 'waiting-material' | 'waiting-interlock' | 'waiting-signal' | 'waiting-signal-stale' | 'completed' | 'error';

interface ChannelState {
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
	status: ChannelStatus;
	cycleCount: number;
	completedActions: number;
	interlockWaitCount: number;
	stationBatchToken?: string;
	attachedPayload?: THREE.Object3D;
	placedPayload?: THREE.Object3D;
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
				};
				this.channels.set(channelKey, channel);
			}
			channel.behaviors.push(behavior);
			this.captureActorBase(behavior.actorObjectId);
		}
		this.initializeSemanticState();
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

	reset() {
		this.clearPayloads();
		for (const poses of this.basePoses.values()) {
			for (const pose of poses) {
				pose.object.position.copy(pose.position);
				pose.object.rotation.copy(pose.rotation);
			}
		}
		for (const channel of this.channels.values()) {
			channel.behaviorIndex = 0;
			channel.actionIndex = 0;
			channel.phase = 0;
			channel.waitElapsed = 0;
			channel.waitRecordedFor = undefined;
			channel.startedActionKey = undefined;
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
			if (this.actorFilter && channel.actorObjectId !== this.actorFilter) continue;
			this.updateChannel(channel, deltaSeconds);
		}
	}

	setSignal(source: string, value: unknown) {
		if (source?.trim()) this.semanticState.set(source.trim(), value);
	}

	setBindingContext(context: { bindingValues?: Record<string, unknown>; staleBindingIds?: string[] }) {
		this.bindingValues.clear();
		this.staleBindingIds.clear();
		for (const [bindingId, value] of Object.entries(context.bindingValues || {})) this.bindingValues.set(bindingId, value);
		for (const bindingId of context.staleBindingIds || []) this.staleBindingIds.add(bindingId);
	}

	getSnapshot(): BehaviorRuntimeSnapshot {
		return {
			active: this.running && this.manifest.runtime.dataMode === 'simulation',
			dataMode: this.manifest.runtime.dataMode,
			channels: [...this.channels.values()].map((channel) => {
				const behavior = channel.behaviors[channel.behaviorIndex];
				const action = behavior?.actions[channel.actionIndex];
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
				channel.behaviorIndex = (channel.behaviorIndex + 1) % channel.behaviors.length;
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
			channel.behaviorIndex = (channel.behaviorIndex + 1) % channel.behaviors.length;
			channel.actionIndex = 0;
			channel.phase = 0;
			channel.waitElapsed = 0;
			channel.waitRecordedFor = undefined;
			channel.status = 'acting';
			return;
		}
		try {
			const actionKey = `${behavior.behaviorId}:${action.actionId}`;
			if (channel.startedActionKey !== actionKey) {
				this.applyStateAssignments(action.onStartState);
				channel.startedActionKey = actionKey;
			}
			if (this.executeAction(channel, behavior, action, actorRoot, deltaSeconds)) this.completeAction(channel, action);
		} catch (error) {
			channel.status = 'error';
			this.reportError?.(`动作 ${action.actionId} 执行失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private executeAction(channel: ChannelState, behavior: TwinBehaviorDefinition, action: TwinBehaviorActionDefinition, actorRoot: THREE.Object3D, deltaSeconds: number) {
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
				return this.moveActorToWorkPoint(actorRoot, action.actorNodePath || channel.actorNodePath, workPoint, action.approachOffset, deltaSeconds, speedRatio);
			}
			case 'home': {
				channel.status = 'moving';
				if (action.poseId) return this.movePose(actorRoot, this.requirePose(action), deltaSeconds, speedRatio);
				return this.moveActorHome(behavior.actorObjectId, actorRoot, deltaSeconds, speedRatio);
			}
			case 'axisMove': {
				channel.status = 'moving';
				if (action.actuatorId) return this.moveConfiguredActuator(actorRoot, action, deltaSeconds, speedRatio);
				return this.moveAxis(actorRoot, action, deltaSeconds, speedRatio);
			}
			case 'gripOpen':
				channel.status = 'acting';
				return this.setConfiguredGripper(actorRoot, action, false);
			case 'gripClose':
				channel.status = 'acting';
				return this.setConfiguredGripper(actorRoot, action, true);
			case 'waitSignal': {
				const bindingId = action.signalBindingId?.trim();
				if (!bindingId) throw new Error(`动作 ${action.actionId} 未配置 signalBindingId`);
				channel.waitElapsed += deltaSeconds;
				if (this.staleBindingIds.has(bindingId)) {
					channel.status = 'waiting-signal-stale';
					this.throwIfSignalTimedOut(channel, action, bindingId);
					return false;
				}
				if (!this.isSignalSatisfied(action, this.bindingValues.get(bindingId))) {
					channel.status = 'waiting-signal';
					this.throwIfSignalTimedOut(channel, action, bindingId);
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
				channel.waitElapsed += deltaSeconds;
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
		let done = true;
		for (const target of pose.targets || []) {
			if (!this.setActuatorValue(actorRoot, this.requireActuator(target.actuatorId), target.value, deltaSeconds, speedRatio)) done = false;
		}
		return done;
	}

	private moveConfiguredActuator(actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, deltaSeconds: number, speedRatio: number) {
		if (!action.actuatorId || !Number.isFinite(action.targetValue)) return true;
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

	private setActuatorValue(actorRoot: THREE.Object3D, actuator: TwinActuatorDefinition, value: number | boolean, deltaSeconds: number, speedRatio: number) {
		const node = this.findNode(actorRoot, actuator.nodePath);
		if (!node) throw new Error(`执行机构 ${actuator.actuatorId} 找不到节点 ${actuator.nodePath}`);
		if (actuator.kind === 'gripper') {
			const closed = Boolean(value);
			node.userData.gripClosed = closed;
			node.userData.gripValue = closed ? 1 : 0;
			return true;
		}
		const axis = actuator.motionAxis || 'y';
		let numeric = Number(value);
		if (!Number.isFinite(numeric)) return true;
		if (Number.isFinite(actuator.minValue)) numeric = Math.max(Number(actuator.minValue), numeric);
		if (Number.isFinite(actuator.maxValue)) numeric = Math.min(Number(actuator.maxValue), numeric);
		const speed = Math.max(0.001, Number(actuator.speed || (actuator.kind === 'rotary-joint' ? 1.8 : 3))) * Math.max(0.1, speedRatio);
		const maxStep = Math.max(0.001, deltaSeconds * speed);
		if (actuator.kind === 'rotary-joint') {
			const targetRadians = actuator.unit === 'degree' ? THREE.MathUtils.degToRad(numeric) : numeric;
			return this.moveAngle(node.rotation, axis, targetRadians, maxStep);
		}
		return this.moveScalar(node.position, axis, numeric, maxStep);
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

	private throwIfSignalTimedOut(channel: ChannelState, action: TwinBehaviorActionDefinition, bindingId: string) {
		const timeout = Number(action.timeoutSeconds || 0);
		if (timeout > 0 && channel.waitElapsed >= timeout) throw new Error(`等待信号 ${bindingId} 超时`);
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
			const resolved = this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot));
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

	private moveActorToWorkPoint(actorRoot: THREE.Object3D, actorNodePath: string | undefined, workPoint: TwinWorkPointDefinition, offset: TwinVector3 | undefined, deltaSeconds: number, speedRatio: number) {
		const targetWorld = this.resolveWorkPointWorld(workPoint, offset);
		// 六轴机械臂 IK 是内置组件运动学能力，不包含任何具体产线工艺；正式工程优先使用设计器示教 Pose。
		if (actorRoot.getObjectByName('Robot-Axis-1') && !actorNodePath) return this.moveRobotToWorld(actorRoot, targetWorld, deltaSeconds, speedRatio);
		const node = actorNodePath ? this.findNode(actorRoot, actorNodePath) : actorRoot;
		if (!node || node === actorRoot) return true;
		actorRoot.updateMatrixWorld(true);
		const targetLocal = actorRoot.worldToLocal(targetWorld.clone());
		return this.moveVector(node.position, targetLocal, deltaSeconds * 2.5 * speedRatio);
	}

	private moveRobotToWorld(actorRoot: THREE.Object3D, targetWorld: THREE.Vector3, deltaSeconds: number, speedRatio: number) {
		actorRoot.updateMatrixWorld(true);
		const target = actorRoot.worldToLocal(targetWorld.clone());
		const axis1 = actorRoot.getObjectByName('Robot-Axis-1');
		const axis2 = actorRoot.getObjectByName('Robot-Axis-2');
		const axis3 = actorRoot.getObjectByName('Robot-Axis-3');
		const axis5 = actorRoot.getObjectByName('Robot-Axis-5');
		if (!axis1 || !axis2 || !axis3) return true;
		const properties = (actorRoot.userData?.properties || {}) as Record<string, unknown>;
		const upperArm = Math.max(0.4, Number(properties.upperArmLength || 1.65));
		const forearm = Math.max(0.4, Number(properties.forearmLength || 1.45));
		const horizontal = Math.max(0.05, Math.hypot(target.x, target.z));
		const shoulderY = axis1.position.y + axis2.position.y;
		let vertical = target.y - shoulderY;
		let radial = horizontal;
		const maxReach = Math.max(0.25, upperArm + forearm - 0.04);
		const distance = Math.hypot(radial, vertical);
		if (distance > maxReach) {
			const scale = maxReach / distance;
			radial *= scale;
			vertical *= scale;
		}
		const d2 = radial * radial + vertical * vertical;
		const cosElbow = THREE.MathUtils.clamp((d2 - upperArm * upperArm - forearm * forearm) / (2 * upperArm * forearm), -1, 1);
		const elbow = Math.acos(cosElbow);
		const shoulderFromX = Math.atan2(vertical, radial) - Math.atan2(forearm * Math.sin(elbow), upperArm + forearm * Math.cos(elbow));
		const targets = [
			[axis1, Math.atan2(-target.z, target.x), 'y'],
			[axis2, shoulderFromX - Math.PI / 2, 'z'],
			[axis3, elbow, 'z'],
			...(axis5 ? [[axis5, -(shoulderFromX - Math.PI / 2 + elbow), 'z']] : []),
		] as Array<[THREE.Object3D, number, 'x' | 'y' | 'z']>;
		const maxStep = deltaSeconds * 1.8 * speedRatio;
		let done = true;
		for (const [node, targetAngle, axis] of targets) if (!this.moveAngle(node.rotation, axis, targetAngle, maxStep)) done = false;
		return done;
	}

	private moveActorHome(actorObjectId: string, actorRoot: THREE.Object3D, deltaSeconds: number, speedRatio: number) {
		const configured = [...this.actuators.values()].filter((actuator) => actuator.objectId === actorObjectId && actuator.homeValue !== undefined && actuator.kind !== 'gripper');
		if (configured.length) {
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

	private moveScalar(vectorValue: THREE.Vector3, axis: 'x' | 'y' | 'z', target: number, maxStep: number) {
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
		if (Math.abs(delta) <= Math.max(0.001, maxStep)) {
			rotation[axis] = target;
			return true;
		}
		rotation[axis] = current + Math.sign(delta) * maxStep;
		return false;
	}

	private attachPayload(channel: ChannelState, actorRoot: THREE.Object3D, action: TwinBehaviorActionDefinition, actorObjectId: string) {
		if (channel.attachedPayload) return true;
		if (channel.placedPayload) {
			this.releasePayload(channel.placedPayload);
			channel.placedPayload = undefined;
		}
		const payloadType = action.payloadType || 'payload';
		const workPoint = action.workPointId ? this.workPoints.get(action.workPointId) : undefined;
		const sourceSlotId = action.sourceSlotId || workPoint?.materialSlotId;
		const sourceSlot = sourceSlotId ? this.materialSlots.get(sourceSlotId) : undefined;
		const toolFrameId = action.toolFrameId || workPoint?.toolFrameId;
		const toolFrame = toolFrameId ? this.toolFrames.get(toolFrameId) : undefined;
		const attachNode = this.resolveAttachNode(actorRoot, action.actorNodePath || channel.actorNodePath, toolFrameId);
		const requestedCount = Math.max(1, Number(action.payloadCount || 1));
		if (sourceSlot) this.ensureSimulationMaterialTemplate(sourceSlot);
		let realEntities = sourceSlot ? this.findMaterialEntities(sourceSlot, payloadType, action.payloadEntityId, requestedCount, actorObjectId) : [];
		if (sourceSlot && realEntities.length < requestedCount && this.trySimulationMaterialReplenish(sourceSlot)) {
			realEntities = this.findMaterialEntities(sourceSlot, payloadType, action.payloadEntityId, requestedCount, actorObjectId);
		}
		let payload: THREE.Object3D;
		if (sourceSlot && realEntities.length < requestedCount) {
			channel.status = 'waiting-material';
			return false;
		}
		if (realEntities.length) {
			const carrier = new THREE.Group();
			carrier.name = `BehaviorPayloadCarrier-${payloadType}`;
			carrier.userData.behaviorPayload = true;
			carrier.userData.behaviorPayloadCarrier = true;
			carrier.userData.realMaterialPayload = true;
			carrier.userData.payloadType = payloadType;
			carrier.userData.payloadEntityIds = realEntities.map((item) => item.userData.twinEntityId);
			attachNode.add(carrier);
			carrier.position.copy(vector(toolFrame?.localPosition));
			const toolRotation = toolFrame?.localRotation || [0, 0, 0];
			carrier.rotation.set(toolRotation[0], toolRotation[1], toolRotation[2]);
			for (const entity of realEntities) {
				carrier.attach(entity);
				entity.userData.materialAttachedBy = channel.channelKey;
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
		channel.status = 'acting';
		return true;
	}

	private detachPayload(channel: ChannelState, workPoint: TwinWorkPointDefinition | undefined, action: TwinBehaviorActionDefinition) {
		const payload = channel.attachedPayload;
		if (!payload) return true;
		const targetSlotId = action.targetSlotId || workPoint?.materialSlotId;
		const targetSlot = targetSlotId ? this.materialSlots.get(targetSlotId) : undefined;
		if (targetSlot?.distributePayloadAcrossRuntimeOwners) {
			if (!this.distributePayloadAcrossStationPallets(channel, payload, targetSlot)) return false;
		} else if (targetSlot?.stackPattern) {
			this.placeStackPayload(payload, targetSlot);
		} else if (targetSlot && (targetSlot.stackPatternSlotId || String(targetSlot.metadata?.stackPatternSlotId || ''))) {
			if (!this.placeLayerMaterialPayload(payload, targetSlot)) return false;
		} else if (targetSlot) {
			const resolved = this.resolveMaterialSlotAnchor(targetSlot, this.preferredRuntimeOwnerId(targetSlot));
			resolved.anchor.add(payload);
			payload.position.copy(resolved.baseLocal).add(workPoint ? vector(workPoint.localPosition) : new THREE.Vector3());
			const rotation = targetSlot.localRotation || workPoint?.localRotation || [0, 0, 0];
			payload.rotation.set(rotation[0], rotation[1], rotation[2]);
		} else {
			this.scene.attach(payload);
		}
		if (!targetSlot && workPoint) {
			const target = this.resolveWorkPointWorld(workPoint);
			payload.position.copy(target);
		}
		payload.traverse((entity) => {
			if (entity.userData?.materialEntity) delete entity.userData.materialAttachedBy;
		});
		payload.userData.placedByBehavior = true;
		channel.placedPayload = payload;
		channel.attachedPayload = undefined;
		return true;
	}

	private distributePayloadAcrossStationPallets(channel: ChannelState, payload: THREE.Object3D, slot: TwinMaterialSlotDefinition) {
		const palletIds = this.getStationPalletIds(this.getObjectRoot(channel.actorObjectId));
		const materials = payload.children.filter((item) => item.userData?.materialEntity === true);
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
			material.rotation.set(0, 0, 0);
			delete material.userData.materialAttachedBy;
			material.userData.runtimeOwnerEntityId = palletIds[palletIndex];
			material.userData.runtimeOwnerItemIndex = level + 1;
			material.userData.runtimeOwnerItemCount = levels;
			if (slot.placedStage) material.userData.materialStage = slot.placedStage;
		}
		payload.removeFromParent();
		return true;
	}

	private placeStackPayload(payload: THREE.Object3D, slot: TwinMaterialSlotDefinition) {
		const pattern = slot.stackPattern!;
		const resolved = this.resolveMaterialSlotAnchor(slot, this.preferredRuntimeOwnerId(slot));
		const materials = payload.children.filter((item) => item.userData?.materialEntity === true);
		const perLayer = Math.max(1, pattern.columns * pattern.rows);
		const capacity = perLayer * pattern.layers;
		const current = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackItemCount || 0)));
		if (!materials.length) throw new Error(`码垛槽位 ${slot.slotId} 没有可放置的真实物料`);
		if (current + materials.length > capacity) throw new Error(`码垛槽位 ${slot.slotId} 已满：${current}/${capacity}`);

		for (let offset = 0; offset < materials.length; offset += 1) {
			const index = current + offset;
			const layer = Math.floor(index / perLayer);
			const cell = index % perLayer;
			const row = Math.floor(cell / pattern.columns);
			const column = cell % pattern.columns;
			const material = materials[offset];
			resolved.anchor.attach(material);
			material.position.set(
				Number(pattern.originX || 0) + column * pattern.spacingX,
				pattern.firstLayerY + layer * pattern.layerPitch,
				Number(pattern.originZ || 0) + row * pattern.spacingZ,
			);
			material.rotation.set(0, 0, 0);
			delete material.userData.materialAttachedBy;
			if (slot.placedStage) material.userData.materialStage = slot.placedStage;
			material.userData.stackLayer = layer + 1;
			material.userData.stackRow = row + 1;
			material.userData.stackColumn = column + 1;
			material.userData.stackSlotId = `L${layer + 1}-R${row + 1}-C${column + 1}`;
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
		const material = payload.children.find((item) => item.userData?.materialEntity === true);
		if (!material) return false;
		const perLayer = Math.max(1, pattern.columns * pattern.rows);
		const itemCount = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackItemCount || 0)));
		const layerMaterialCount = Math.max(0, Math.floor(Number(resolved.anchor.userData.stackLayerMaterialCount || 0)));
		if (layerMaterialCount >= pattern.layers) throw new Error(`层间物料槽位 ${slot.slotId} 已满`);
		if (itemCount < (layerMaterialCount + 1) * perLayer) return false;

		resolved.anchor.attach(material);
		material.position.set(0, pattern.firstLayerY + layerMaterialCount * pattern.layerPitch + Number(pattern.layerMaterialOffsetY ?? 0.21) + Number(pattern.separatorThickness || 0.05) / 2, 0);
		material.rotation.set(0, 0, 0);
		delete material.userData.materialAttachedBy;
		if (slot.placedStage) material.userData.materialStage = slot.placedStage;
		material.userData.stackLayerMaterialIndex = layerMaterialCount + 1;
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
		const candidates: Array<{ node: THREE.Object3D; distance: number }> = [];
		const searchRoot: THREE.Object3D = !slot.runtimeOwnerType && slotOwner ? slotOwner : this.scene;
		searchRoot.traverse((node) => {
			if (node.userData?.materialEntity !== true) return;
			if (node.userData?.materialAttachedBy) return;
			if (payloadType && node.userData?.payloadType !== payloadType) return;
			if (payloadEntityId && node.userData?.twinEntityId !== payloadEntityId) return;
			if (entityGroup && String(node.userData?.materialSlotGroup || '') !== entityGroup) return;
			const position = node.getWorldPosition(new THREE.Vector3());
			candidates.push({ node, distance: position.distanceTo(center) });
		});
		return candidates.sort((left, right) => left.distance - right.distance).slice(0, count).map((item) => item.node);
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

	private getStationPalletIds(actorRoot?: THREE.Object3D) {
		return actorRoot ? this.stringArray(actorRoot.userData.stationPalletIds) : [];
	}

	private preferredRuntimeOwnerId(slot: TwinMaterialSlotDefinition) {
		if (slot.runtimeOwnerSelection !== 'station-batch') return undefined;
		return this.getStationPalletIds(this.getObjectRoot(slot.objectId))[0];
	}

	private ensureSimulationMaterialTemplate(slot: TwinMaterialSlotDefinition) {
		if (this.manifest.runtime.dataMode !== 'simulation' || slot.role !== 'source' || slot.metadata?.simulationReplenish !== true) return;
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

	private stringArray(value: unknown) {
		return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
	}

	private numberRecord(value: unknown) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
		return Object.fromEntries(Object.entries(source).map(([key, count]) => [key, Math.max(0, Number(count) || 0)]));
	}

	private isInterlockSatisfied(interlockId: string) {
		const interlock = this.interlocks.get(interlockId);
		if (!interlock) return false;
		const evaluate = (condition: TwinInterlockDefinition['conditions'][number]) => {
			const current = this.resolveSemanticValue(condition.source);
			switch (condition.operator) {
				case 'truthy': return Boolean(current);
				case 'falsy': return !Boolean(current);
				case 'equals': return current === condition.value;
				case 'notEquals': return current !== condition.value;
				default: return false;
			}
		};
		return interlock.mode === 'any' ? interlock.conditions.some(evaluate) : interlock.conditions.every(evaluate);
	}

	private resolveSemanticValue(source: string) {
		for (const slot of this.materialSlots.values()) {
			if (slot.runtimeOwnerSelection !== 'station-batch' || !source.startsWith(`${slot.slotId}.`)) continue;
			const field = source.slice(slot.slotId.length + 1);
			if (!['complete', 'itemCount', 'layerMaterialCount'].includes(field)) continue;
			const preferredId = this.preferredRuntimeOwnerId(slot);
			if (!preferredId) break;
			const resolved = this.resolveMaterialSlotAnchor(slot, preferredId);
			if (String(resolved.owner.userData?.twinEntityId || '') !== preferredId) break;
			if (field === 'complete') return resolved.owner.userData.stackComplete === true;
			if (field === 'itemCount') return Number(resolved.anchor.userData.stackItemCount || 0);
			return Number(resolved.anchor.userData.stackLayerMaterialCount || 0);
		}
		return this.semanticState.get(source);
	}

	private applyStateAssignments(assignments?: TwinBehaviorActionDefinition['onStartState']) {
		for (const assignment of assignments || []) {
			const source = assignment.source?.trim();
			if (source) this.semanticState.set(source, assignment.value);
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
