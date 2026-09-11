import type { TwinSceneManifest } from '../../contracts';
import {
	actionFlowNodeTypes,
	blockingActionFlowNodeTypes,
	type TwinActionFlowDefinitionV2,
	type TwinActionFlowDiagnostic,
	type TwinActionFlowEdge,
	type TwinActionFlowNode,
	type TwinPredicateDefinition,
	type TwinPredicateGroup,
} from '../contracts/action-flow-v2';

const allowedNodeTypes = new Set(actionFlowNodeTypes);
const motionNodeTypes = new Set(['MoveTo', 'MovePose', 'JointMove', 'AxisMove', 'Home']);
const actuatorNodeTypes = new Set(['JointMove', 'AxisMove', 'GripOpen', 'GripClose']);
const credentialKeyPattern = /(password|passwd|pwd|token|secret|connectionstring|api[_-]?key|clientsecret)/i;
const externalUrlPattern = /^(https?:|data:|javascript:|file:)/i;

const diag = (flow: TwinActionFlowDefinitionV2, code: string, severity: TwinActionFlowDiagnostic['severity'], message: string, patch: Partial<TwinActionFlowDiagnostic> = {}): TwinActionFlowDiagnostic => ({
	code, severity, message, flowId: flow.flowId, ...patch,
});

const configString = (node: TwinActionFlowNode, key: string) => {
	const value = node.config?.[key];
	return typeof value === 'string' ? value.trim() : '';
};
const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;

const predicateLeaves = (group: TwinPredicateGroup | undefined): TwinPredicateDefinition[] => {
	if (!group) return [];
	const result: TwinPredicateDefinition[] = [];
	for (const item of group.items || []) {
		if ('logic' in item) result.push(...predicateLeaves(item));
		else result.push(item);
	}
	return result;
};

const scanUnsafeConfig = (value: unknown, path: string, onIssue: (code: string, path: string, message: string) => void) => {
	if (value === null || value === undefined) return;
	if (typeof value === 'function') { onIssue('AF1301', path, '流程配置不允许函数或可执行表达式。'); return; }
	if (typeof value === 'string') {
		if (externalUrlPattern.test(value.trim())) onIssue('AF1302', path, '流程配置不允许直接保存外部 URL、data URL 或脚本 URL。');
		return;
	}
	if (Array.isArray(value)) { value.forEach((item, index) => scanUnsafeConfig(item, `${path}[${index}]`, onIssue)); return; }
	if (typeof value === 'object') {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (credentialKeyPattern.test(key)) onIssue('AF1303', `${path}.${key}`, '流程配置不允许保存密码、Token、Secret 或连接串。');
			scanUnsafeConfig(child, `${path}.${key}`, onIssue);
		}
	}
};

const reachableNodes = (startNodeId: string, edges: TwinActionFlowEdge[]) => {
	const visited = new Set<string>();
	const queue = [startNodeId];
	while (queue.length) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);
		for (const edge of edges.filter((item) => item.sourceNodeId === current)) queue.push(edge.targetNodeId);
	}
	return visited;
};

const hasCycle = (nodeIds: string[], edges: TwinActionFlowEdge[]) => {
	const state = new Map<string, 0 | 1 | 2>();
	const adjacency = new Map<string, string[]>();
	for (const nodeId of nodeIds) adjacency.set(nodeId, []);
	for (const edge of edges) adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
	const visit = (nodeId: string): boolean => {
		const current = state.get(nodeId) || 0;
		if (current === 1) return true;
		if (current === 2) return false;
		state.set(nodeId, 1);
		for (const next of adjacency.get(nodeId) || []) if (visit(next)) return true;
		state.set(nodeId, 2);
		return false;
	};
	return nodeIds.some((nodeId) => visit(nodeId));
};

export const validateActionFlow = (flow: TwinActionFlowDefinitionV2, manifest?: TwinSceneManifest, allFlows: TwinActionFlowDefinitionV2[] = [flow]) => {
	const diagnostics: TwinActionFlowDiagnostic[] = [];
	const nodeIds = new Set<string>();
	const edgeIds = new Set<string>();
	const objectIds = new Set((manifest?.objects || []).map((item) => item.objectId));
	const workPointIds = new Set((manifest?.workPoints || []).map((item) => item.workPointId));
	const poseIds = new Set((manifest?.poses || []).map((item) => item.poseId));
	const actuatorIds = new Set((manifest?.actuators || []).map((item) => item.actuatorId));
	const toolFrameIds = new Set((manifest?.toolFrames || []).map((item) => item.toolFrameId));
	const slotIds = new Set((manifest?.materialSlots || []).map((item) => item.slotId));
	const bindingIds = new Set((manifest?.bindings || []).map((item) => item.bindingId));
	const routeIds = new Set((manifest?.routes || []).map((item) => item.routeId));
	const interlockIds = new Set((manifest?.interlocks || []).map((item) => item.interlockId));
	const flowIds = new Set(allFlows.map((item) => item.flowId));

	if (!flow.flowId?.trim() || !flow.key?.trim()) diagnostics.push(diag(flow, 'AF1001', 'error', 'flowId 和 key 均不能为空。', { propertyPath: 'flowId/key' }));
	if (flow.contractVersion !== '2.0') diagnostics.push(diag(flow, 'AF1304', 'error', `不支持的 Action Flow 合同版本：${String(flow.contractVersion)}`, { propertyPath: 'contractVersion' }));
	if ((flow.nodes || []).length > 2000 || (flow.edges || []).length > 5000) diagnostics.push(diag(flow, 'AF1305', 'error', '流程节点或边数量超过安全上限。'));

	for (const [index, node] of (flow.nodes || []).entries()) {
		if (!node.nodeId?.trim() || nodeIds.has(node.nodeId)) diagnostics.push(diag(flow, 'AF1002', 'error', '节点 ID 不能为空且必须唯一。', { nodeId: node.nodeId, propertyPath: `nodes[${index}].nodeId` }));
		nodeIds.add(node.nodeId);
		if (!allowedNodeTypes.has(node.type)) diagnostics.push(diag(flow, 'AF1006', 'error', `未注册节点类型 ${String(node.type)}。`, { nodeId: node.nodeId, propertyPath: `nodes[${index}].type` }));
		if (node.actorObjectId && manifest && !objectIds.has(node.actorObjectId)) diagnostics.push(diag(flow, 'AF1101', 'error', 'actorObjectId 不存在。', { nodeId: node.nodeId, propertyPath: `nodes[${index}].actorObjectId` }));
		if (node.compensationNodeId && !flow.nodes.some((item) => item.nodeId === node.compensationNodeId)) diagnostics.push(diag(flow, 'AF1005', 'error', '补偿节点引用不存在。', { nodeId: node.nodeId, propertyPath: `nodes[${index}].compensationNodeId` }));
		if (node.retryPolicy && (!Number.isInteger(node.retryPolicy.maxAttempts) || node.retryPolicy.maxAttempts < 1)) diagnostics.push(diag(flow, 'AF1205', 'error', '重试次数必须是大于等于 1 的整数。', { nodeId: node.nodeId, propertyPath: `nodes[${index}].retryPolicy.maxAttempts` }));
		if (node.timeoutPolicy && !positive(node.timeoutPolicy.seconds)) diagnostics.push(diag(flow, 'AF1202', 'error', '超时秒数必须大于 0。', { nodeId: node.nodeId, propertyPath: `nodes[${index}].timeoutPolicy.seconds` }));
		if (blockingActionFlowNodeTypes.has(node.type) && !node.timeoutPolicy && !positive(flow.policies?.defaultTimeoutSeconds)) diagnostics.push(diag(flow, 'AF1202', 'error', `${node.type} 是阻塞节点，必须配置有限超时策略或流程默认超时。`, { nodeId: node.nodeId }));
		if (motionNodeTypes.has(node.type) && manifest && !node.actorObjectId) diagnostics.push(diag(flow, 'AF1101', 'error', `${node.type} 必须配置执行 Actor。`, { nodeId: node.nodeId }));
		if (node.type === 'MoveTo' && manifest && !workPointIds.has(configString(node, 'workPointId'))) diagnostics.push(diag(flow, 'AF1103', 'error', 'MoveTo 必须引用有效 WorkPoint。', { nodeId: node.nodeId, propertyPath: 'config.workPointId' }));
		if (node.type === 'MovePose' && manifest && !poseIds.has(configString(node, 'poseId'))) diagnostics.push(diag(flow, 'AF1103', 'error', 'MovePose 必须引用有效 Pose。', { nodeId: node.nodeId, propertyPath: 'config.poseId' }));
		if (actuatorNodeTypes.has(node.type) && manifest && !actuatorIds.has(configString(node, 'actuatorId'))) diagnostics.push(diag(flow, 'AF1103', 'error', `${node.type} 必须引用有效 Actuator。`, { nodeId: node.nodeId, propertyPath: 'config.actuatorId' }));
		if (['Attach', 'Detach'].includes(node.type) && manifest) {
			const slotId = configString(node, node.type === 'Attach' ? 'sourceSlotId' : 'targetSlotId');
			if (slotId && !slotIds.has(slotId)) diagnostics.push(diag(flow, 'AF1103', 'error', `${node.type} 引用的 MaterialSlot 不存在。`, { nodeId: node.nodeId }));
			const frameId = configString(node, 'toolFrameId');
			if (frameId && !toolFrameIds.has(frameId)) diagnostics.push(diag(flow, 'AF1103', 'error', `${node.type} 引用的 ToolFrame 不存在。`, { nodeId: node.nodeId }));
		}
		if (['PrepareSlot', 'ReserveSlot', 'ReleaseSlot'].includes(node.type) && manifest && !slotIds.has(configString(node, 'slotId'))) diagnostics.push(diag(flow, 'AF1103', 'error', `${node.type} 必须引用有效 MaterialSlot。`, { nodeId: node.nodeId, propertyPath: 'config.slotId' }));
		if (['WaitSignal', 'WaitAck', 'WriteCommand'].includes(node.type) && manifest && !bindingIds.has(configString(node, 'bindingId'))) diagnostics.push(diag(flow, 'AF1104', 'error', `${node.type} 必须引用已入库 Binding。`, { nodeId: node.nodeId, propertyPath: 'config.bindingId' }));
		if (['ReserveSection', 'EnterSection', 'LeaveSection', 'SelectRoute'].includes(node.type) && manifest) {
			const routeId = configString(node, 'routeId');
			if (routeId && !routeIds.has(routeId)) diagnostics.push(diag(flow, 'AF1106', 'error', `${node.type} 引用的路线不存在。`, { nodeId: node.nodeId, propertyPath: 'config.routeId' }));
		}
		if (node.type === 'Subflow') {
			const subflowId = configString(node, 'flowId');
			if (!subflowId || !flowIds.has(subflowId)) diagnostics.push(diag(flow, 'AF1105', 'error', 'Subflow 必须引用已存在流程。', { nodeId: node.nodeId, propertyPath: 'config.flowId' }));
			if (subflowId === flow.flowId) diagnostics.push(diag(flow, 'AF1105', 'error', 'Subflow 不允许直接递归调用自身。', { nodeId: node.nodeId }));
		}
		const guardIds = Array.isArray(node.config?.interlockIds) ? node.config.interlockIds.map(String) : [];
		if (manifest) for (const interlockId of guardIds) if (!interlockIds.has(interlockId)) diagnostics.push(diag(flow, 'AF1103', 'error', `联锁 ${interlockId} 不存在。`, { nodeId: node.nodeId, propertyPath: 'config.interlockIds' }));
		if (node.type === 'WriteCommand' && flow.policies?.requireInterlockForCommands !== false && guardIds.length === 0) diagnostics.push(diag(flow, 'AF1201', 'error', 'WriteCommand 必须配置结构化安全联锁。', { nodeId: node.nodeId, suggestion: '在节点 config.interlockIds 中选择已发布联锁。' }));
		if (motionNodeTypes.has(node.type) && guardIds.length === 0) diagnostics.push(diag(flow, 'AF1201', 'warning', `${node.type} 未配置节点级联锁；请确认流程 Start Guard 已覆盖安全条件。`, { nodeId: node.nodeId }));
		if (['MoveTo', 'MovePose', 'JointMove', 'AxisMove'].includes(node.type)) {
			const speedRatio = node.config?.speedRatio;
			if (speedRatio !== undefined && (!positive(speedRatio) || Number(speedRatio) > 2)) diagnostics.push(diag(flow, 'AF1204', 'error', '运动速度倍率必须大于 0 且不超过 2。', { nodeId: node.nodeId, propertyPath: 'config.speedRatio' }));
		}
		scanUnsafeConfig(node.config, `nodes[${index}].config`, (code, propertyPath, message) => diagnostics.push(diag(flow, code, 'error', message, { nodeId: node.nodeId, propertyPath })));
	}

	for (const [index, edge] of (flow.edges || []).entries()) {
		if (!edge.edgeId?.trim() || edgeIds.has(edge.edgeId)) diagnostics.push(diag(flow, 'AF1002', 'error', '边 ID 不能为空且必须唯一。', { edgeId: edge.edgeId, propertyPath: `edges[${index}].edgeId` }));
		edgeIds.add(edge.edgeId);
		if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) diagnostics.push(diag(flow, 'AF1005', 'error', '流程边引用了不存在的节点。', { edgeId: edge.edgeId, propertyPath: `edges[${index}]` }));
		for (const predicate of predicateLeaves(edge.predicate)) {
			if (!predicate.ref?.trim()) diagnostics.push(diag(flow, 'AF1005', 'error', '条件谓词必须引用 binding/variable/material/runtime 字段。', { edgeId: edge.edgeId, propertyPath: `edges[${index}].predicate` }));
			if (predicate.source === 'binding' && manifest && !bindingIds.has(predicate.ref)) diagnostics.push(diag(flow, 'AF1104', 'error', `条件引用的 Binding ${predicate.ref} 不存在。`, { edgeId: edge.edgeId }));
			if (predicate.source === 'variable' && !flow.variables.some((item) => item.name === predicate.ref)) diagnostics.push(diag(flow, 'AF1005', 'error', `条件引用的变量 ${predicate.ref} 未声明。`, { edgeId: edge.edgeId }));
		}
	}

	const startNodes = flow.nodes.filter((item) => item.type === 'Start');
	if (startNodes.length !== 1) diagnostics.push(diag(flow, 'AF1003', 'error', '流程必须且只能包含一个 Start 节点。'));
	if (startNodes.length === 1) {
		const reachable = reachableNodes(startNodes[0].nodeId, flow.edges);
		if (!flow.nodes.some((item) => item.type === 'End' && reachable.has(item.nodeId))) diagnostics.push(diag(flow, 'AF1004', 'error', 'Start 不存在可达 End。'));
		for (const node of flow.nodes) if (!reachable.has(node.nodeId)) diagnostics.push(diag(flow, 'AF1007', 'warning', `节点 ${node.name || node.nodeId} 不可达。`, { nodeId: node.nodeId }));
	}
	if (hasCycle([...nodeIds], flow.edges) && !positive(flow.policies?.maxLoopIterations)) diagnostics.push(diag(flow, 'AF1008', 'error', '流程存在循环但没有配置有限 maxLoopIterations。', { propertyPath: 'policies.maxLoopIterations' }));
	for (const node of flow.nodes.filter((item) => item.type === 'ParallelFork')) {
		const outgoing = flow.edges.filter((edge) => edge.sourceNodeId === node.nodeId);
		if (outgoing.length < 2) diagnostics.push(diag(flow, 'AF1009', 'error', 'ParallelFork 至少需要两个输出分支。', { nodeId: node.nodeId }));
	}
	for (const node of flow.nodes.filter((item) => item.type === 'ParallelJoin')) {
		const incoming = flow.edges.filter((edge) => edge.targetNodeId === node.nodeId);
		if (incoming.length < 2) diagnostics.push(diag(flow, 'AF1009', 'error', 'ParallelJoin 至少需要两个输入分支。', { nodeId: node.nodeId }));
	}
	return diagnostics;
};

export const validateActionFlows = (flows: TwinActionFlowDefinitionV2[] = [], manifest?: TwinSceneManifest) => {
	const diagnostics: TwinActionFlowDiagnostic[] = [];
	const flowIds = new Set<string>();
	const keys = new Set<string>();
	for (const flow of flows) {
		if (flowIds.has(flow.flowId) || keys.has(flow.key)) diagnostics.push(diag(flow, 'AF1001', 'error', 'flowId/key 在场景内必须唯一。'));
		flowIds.add(flow.flowId); keys.add(flow.key);
		diagnostics.push(...validateActionFlow(flow, manifest, flows));
	}
	return diagnostics;
};
