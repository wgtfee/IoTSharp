import type {
	TwinActuatorDefinition,
	TwinBehaviorActionDefinition,
	TwinBehaviorDefinition,
	TwinInterlockDefinition,
	TwinMaterialSlotDefinition,
	TwinPoseDefinition,
	TwinSceneManifest,
	TwinToolFrameDefinition,
	TwinWorkPointDefinition,
} from '../contracts';

export type TwinOrchestrationSnapshot = Pick<TwinSceneManifest,
	'workPoints' | 'materialSlots' | 'toolFrames' | 'actuators' | 'poses' | 'behaviors' | 'interlocks'>;

const clone = <T>(value: T): T => typeof structuredClone === 'function'
	? structuredClone(value)
	: JSON.parse(JSON.stringify(value)) as T;

export const createOrchestrationId = (prefix: string) => {
	const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${id}`;
};

export const exportTwinOrchestration = (manifest: TwinSceneManifest): TwinOrchestrationSnapshot => ({
	workPoints: clone(manifest.workPoints || []),
	materialSlots: clone(manifest.materialSlots || []),
	toolFrames: clone(manifest.toolFrames || []),
	actuators: clone(manifest.actuators || []),
	poses: clone(manifest.poses || []),
	behaviors: clone(manifest.behaviors || []),
	interlocks: clone(manifest.interlocks || []),
});

export const importTwinOrchestration = (manifest: TwinSceneManifest, snapshot: TwinOrchestrationSnapshot) => {
	manifest.workPoints = clone(snapshot.workPoints || []);
	manifest.materialSlots = clone(snapshot.materialSlots || []);
	manifest.toolFrames = clone(snapshot.toolFrames || []);
	manifest.actuators = clone(snapshot.actuators || []);
	manifest.poses = clone(snapshot.poses || []);
	manifest.behaviors = clone(snapshot.behaviors || []);
	manifest.interlocks = clone(snapshot.interlocks || []);
	return manifest;
};

export const cloneTwinOrchestration = (snapshot: TwinOrchestrationSnapshot) => clone(snapshot);

export const addWorkPointDefinition = (manifest: TwinSceneManifest, objectId: string, patch: Partial<TwinWorkPointDefinition> = {}) => {
	const item: TwinWorkPointDefinition = {
		workPointId: patch.workPointId || createOrchestrationId('workpoint'),
		name: patch.name || '新工作点', role: patch.role || 'safe', localPosition: patch.localPosition || [0, 1, 0], ...patch, objectId,
	};
	(manifest.workPoints ||= []).push(item);
	return item;
};

export const removeWorkPointDefinition = (manifest: TwinSceneManifest, workPointId: string) => {
	manifest.workPoints = (manifest.workPoints || []).filter((item) => item.workPointId !== workPointId);
	for (const pose of manifest.poses || []) if (pose.workPointId === workPointId) delete pose.workPointId;
	for (const behavior of manifest.behaviors || []) for (const action of behavior.actions || []) if (action.workPointId === workPointId) delete action.workPointId;
};

export const addMaterialSlotDefinition = (manifest: TwinSceneManifest, objectId: string, patch: Partial<TwinMaterialSlotDefinition> = {}) => {
	const item: TwinMaterialSlotDefinition = {
		slotId: patch.slotId || createOrchestrationId('material-slot'),
		name: patch.name || '新物料槽位', role: patch.role || 'buffer', localPosition: patch.localPosition || [0, 0, 0], ...patch, objectId,
	};
	(manifest.materialSlots ||= []).push(item);
	return item;
};

export const removeMaterialSlotDefinition = (manifest: TwinSceneManifest, slotId: string) => {
	manifest.materialSlots = (manifest.materialSlots || []).filter((item) => item.slotId !== slotId);
	for (const point of manifest.workPoints || []) if (point.materialSlotId === slotId) delete point.materialSlotId;
	for (const slot of manifest.materialSlots || []) if (slot.stackPatternSlotId === slotId) delete slot.stackPatternSlotId;
	for (const behavior of manifest.behaviors || []) for (const action of behavior.actions || []) {
		if (action.sourceSlotId === slotId) delete action.sourceSlotId;
		if (action.targetSlotId === slotId) delete action.targetSlotId;
	}
};

export const addToolFrameDefinition = (manifest: TwinSceneManifest, objectId: string, patch: Partial<TwinToolFrameDefinition> = {}) => {
	const item: TwinToolFrameDefinition = {
		toolFrameId: patch.toolFrameId || createOrchestrationId('tool-frame'),
		name: patch.name || '新 TCP / ToolFrame', nodePath: patch.nodePath || '', localPosition: patch.localPosition || [0, 0, 0], payloadTypes: patch.payloadTypes || [], ...patch, objectId,
	};
	(manifest.toolFrames ||= []).push(item);
	return item;
};

export const removeToolFrameDefinition = (manifest: TwinSceneManifest, toolFrameId: string) => {
	manifest.toolFrames = (manifest.toolFrames || []).filter((item) => item.toolFrameId !== toolFrameId);
	for (const point of manifest.workPoints || []) if (point.toolFrameId === toolFrameId) delete point.toolFrameId;
	for (const pose of manifest.poses || []) if (pose.toolFrameId === toolFrameId) delete pose.toolFrameId;
	for (const behavior of manifest.behaviors || []) for (const action of behavior.actions || []) if (action.toolFrameId === toolFrameId) delete action.toolFrameId;
};

export const addActuatorDefinition = (manifest: TwinSceneManifest, objectId: string, patch: Partial<TwinActuatorDefinition> = {}) => {
	const item: TwinActuatorDefinition = {
		actuatorId: patch.actuatorId || createOrchestrationId('actuator'), name: patch.name || '新执行机构',
		nodePath: patch.nodePath || '', kind: patch.kind || 'linear-axis', motionAxis: patch.motionAxis || 'y', unit: patch.unit || 'meter', homeValue: patch.homeValue ?? 0, speed: patch.speed ?? 1, ...patch,
		objectId,
	};
	(manifest.actuators ||= []).push(item);
	return item;
};

export const removeActuatorDefinition = (manifest: TwinSceneManifest, actuatorId: string) => {
	manifest.actuators = (manifest.actuators || []).filter((item) => item.actuatorId !== actuatorId);
	for (const pose of manifest.poses || []) pose.targets = pose.targets.filter((item) => item.actuatorId !== actuatorId);
	for (const behavior of manifest.behaviors || []) for (const action of behavior.actions || []) if (action.actuatorId === actuatorId) delete action.actuatorId;
};

export const addPoseDefinition = (manifest: TwinSceneManifest, objectId: string, patch: Partial<TwinPoseDefinition> = {}) => {
	const item: TwinPoseDefinition = { poseId: patch.poseId || createOrchestrationId('pose'), name: patch.name || '新 Pose', targets: patch.targets || [], ...patch, objectId };
	(manifest.poses ||= []).push(item);
	return item;
};

export const removePoseDefinition = (manifest: TwinSceneManifest, poseId: string) => {
	manifest.poses = (manifest.poses || []).filter((item) => item.poseId !== poseId);
	for (const behavior of manifest.behaviors || []) for (const action of behavior.actions || []) if (action.poseId === poseId) delete action.poseId;
};

export const addBehaviorDefinition = (manifest: TwinSceneManifest, actorObjectId: string, patch: Partial<TwinBehaviorDefinition> = {}) => {
	const item: TwinBehaviorDefinition = {
		behaviorId: patch.behaviorId || createOrchestrationId('behavior'), name: patch.name || '新动作编排',
		selectionWeight: patch.selectionWeight ?? 1, enabled: patch.enabled ?? true, loop: patch.loop ?? true, actions: patch.actions || [], ...patch, actorObjectId,
	};
	(manifest.behaviors ||= []).push(item);
	return item;
};

export const removeBehaviorDefinition = (manifest: TwinSceneManifest, behaviorId: string) => {
	manifest.behaviors = (manifest.behaviors || []).filter((item) => item.behaviorId !== behaviorId);
};

export const addBehaviorActionDefinition = (behavior: TwinBehaviorDefinition, patch: Partial<TwinBehaviorActionDefinition> = {}) => {
	const item: TwinBehaviorActionDefinition = { actionId: patch.actionId || createOrchestrationId('action'), kind: patch.kind || 'moveTo', speedRatio: patch.speedRatio ?? 1, ...patch };
	behavior.actions.push(item);
	return item;
};

export const removeBehaviorActionDefinition = (behavior: TwinBehaviorDefinition, actionId: string) => {
	behavior.actions = behavior.actions.filter((item) => item.actionId !== actionId);
};

export const moveBehaviorActionDefinition = (behavior: TwinBehaviorDefinition, index: number, offset: number) => {
	const target = index + offset;
	if (index < 0 || index >= behavior.actions.length || target < 0 || target >= behavior.actions.length) return false;
	const [action] = behavior.actions.splice(index, 1);
	behavior.actions.splice(target, 0, action);
	return true;
};

export const addInterlockDefinition = (manifest: TwinSceneManifest, patch: Partial<TwinInterlockDefinition> = {}) => {
	const item: TwinInterlockDefinition = {
		interlockId: patch.interlockId || createOrchestrationId('interlock'), name: patch.name || '新联锁', mode: patch.mode || 'all', conditions: patch.conditions || [], ...patch,
	};
	(manifest.interlocks ||= []).push(item);
	return item;
};

export const removeInterlockDefinition = (manifest: TwinSceneManifest, interlockId: string) => {
	manifest.interlocks = (manifest.interlocks || []).filter((item) => item.interlockId !== interlockId);
	for (const behavior of manifest.behaviors || []) {
		behavior.interlockIds = (behavior.interlockIds || []).filter((item) => item !== interlockId);
		for (const action of behavior.actions || []) if (action.waitForInterlockId === interlockId) delete action.waitForInterlockId;
	}
};
