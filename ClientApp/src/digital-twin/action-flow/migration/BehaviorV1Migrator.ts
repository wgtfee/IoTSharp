import type { TwinBehaviorActionDefinition, TwinBehaviorDefinition, TwinSceneManifest } from '../../contracts';
import type { TwinActionFlowDefinitionV2, TwinActionFlowNode, TwinActionFlowNodeType } from '../contracts/action-flow-v2';

const createId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const actionKindMap: Record<TwinBehaviorActionDefinition['kind'], TwinActionFlowNodeType> = {
	moveTo: 'MoveTo', movePose: 'MovePose', jointMove: 'JointMove', axisMove: 'AxisMove', pick: 'Attach', place: 'Detach',
	gripOpen: 'GripOpen', gripClose: 'GripClose', waitSignal: 'WaitSignal', wait: 'Delay', prepareSlot: 'PrepareSlot', home: 'Home', attach: 'Attach', detach: 'Detach',
};

const actionConfig = (action: TwinBehaviorActionDefinition) => {
	const copy = structuredClone(action) as TwinBehaviorActionDefinition & Record<string, unknown>;
	delete copy.actionId;
	delete copy.kind;
	delete copy.timeoutSeconds;
	if (action.kind === 'wait') copy.durationSeconds = Number(action.waitSeconds || action.durationSeconds || 0);
	if (action.waitForInterlockId) copy.interlockIds = [action.waitForInterlockId];
	return copy as Record<string, unknown>;
};

export interface BehaviorV1MigrationOptions {
	maxLoopIterations?: number;
	flowId?: string;
	key?: string;
}

export const migrateBehaviorV1 = (behavior: TwinBehaviorDefinition, options: BehaviorV1MigrationOptions = {}): TwinActionFlowDefinitionV2 => {
	const flowId = options.flowId || createId('action-flow');
	const startId = createId('flow-start');
	const endId = createId('flow-end');
	const nodes: TwinActionFlowNode[] = [{
		nodeId: startId, type: 'Start', name: '开始', config: { interlockIds: structuredClone(behavior.interlockIds || []), initialState: structuredClone(behavior.initialState || []) }, editor: { x: 60, y: 140 },
	}];
	for (const [index, action] of behavior.actions.entries()) {
		nodes.push({
			nodeId: `v1-${behavior.behaviorId}-${action.actionId}`,
			type: actionKindMap[action.kind],
			name: `${index + 1}. ${action.kind}`,
			actorObjectId: behavior.actorObjectId,
			config: actionConfig(action),
			timeoutPolicy: Number(action.timeoutSeconds) > 0 ? { seconds: Number(action.timeoutSeconds), onTimeout: 'fault' } : undefined,
			editor: { x: 250 + index * 190, y: 140 },
		});
	}
	const loopGateId = behavior.loop !== false ? createId('legacy-loop') : undefined;
	if (loopGateId) nodes.push({ nodeId: loopGateId, type: 'Switch', name: 'V1 有界循环', config: { legacyLoop: true, maxIterations: options.maxLoopIterations || 1000 }, editor: { x: 250 + behavior.actions.length * 190, y: 140 } });
	nodes.push({ nodeId: endId, type: 'End', name: '结束', config: {}, editor: { x: 440 + behavior.actions.length * 190, y: 140 } });
	const edges = [] as TwinActionFlowDefinitionV2['edges'];
	let previous = startId;
	for (const action of behavior.actions) {
		const nodeId = `v1-${behavior.behaviorId}-${action.actionId}`;
		edges.push({ edgeId: createId('flow-edge'), sourceNodeId: previous, sourcePort: 'success', targetNodeId: nodeId });
		previous = nodeId;
	}
	if (loopGateId && behavior.actions.length) {
		edges.push({ edgeId: createId('flow-edge'), sourceNodeId: previous, sourcePort: 'success', targetNodeId: loopGateId });
		edges.push({ edgeId: createId('flow-edge'), sourceNodeId: loopGateId, sourcePort: 'true', targetNodeId: `v1-${behavior.behaviorId}-${behavior.actions[0].actionId}` });
		edges.push({ edgeId: createId('flow-edge'), sourceNodeId: loopGateId, sourcePort: 'false', targetNodeId: endId, isDefault: true });
	} else {
		edges.push({ edgeId: createId('flow-edge'), sourceNodeId: previous, sourcePort: 'success', targetNodeId: endId });
	}
	return {
		flowId,
		key: options.key || `behavior-v1:${behavior.behaviorId}`,
		name: behavior.name,
		contractVersion: '2.0',
		actorObjectIds: [behavior.actorObjectId],
		variables: loopGateId ? [{ name: '__loopCount', type: 'number', initialValue: 0 }] : [],
		nodes,
		edges,
		policies: { defaultTimeoutSeconds: 300, maxLoopIterations: options.maxLoopIterations || 1000, requireInterlockForCommands: true, selectionWeight: Number(behavior.selectionWeight || 1) },
		enabled: behavior.enabled !== false,
		revision: 1,
		status: 'Draft',
		legacyBehaviorId: behavior.behaviorId,
	};
};

export const migrateBehaviorV1Manifest = (manifest: TwinSceneManifest, options: BehaviorV1MigrationOptions = {}) => {
	const existingLegacyIds = new Set((manifest.actionFlows || []).map((item) => item.legacyBehaviorId).filter(Boolean));
	const migrated = (manifest.behaviors || []).filter((behavior) => !existingLegacyIds.has(behavior.behaviorId)).map((behavior) => migrateBehaviorV1(behavior, options));
	manifest.actionFlows = [...(manifest.actionFlows || []), ...migrated];
	return migrated;
};
