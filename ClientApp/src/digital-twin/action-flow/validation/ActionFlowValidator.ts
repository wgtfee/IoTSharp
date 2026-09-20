import type { TwinSceneManifest } from '../../contracts';
import { validMaterialStateRef } from '../contracts/material-state';
import { isReadOnlyStateRef } from '../contracts/signal-state';
import {
	actionFlowNodeTypes,
	blockingActionFlowNodeTypes,
	sceneActionFlowNodeTypes,
	sceneSafetyNodeTypes,
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
	if (!group || !Array.isArray(group.items)) return [];
	const result: TwinPredicateDefinition[] = [];
	for (const item of group.items || []) {
		if (!item || typeof item !== 'object') continue;
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
	const sceneFlow = flow.policies?.executionTarget === 'scene';
	if (sceneFlow && (flow.policies.allowedRuntimeModes?.length !== 1 || flow.policies.allowedRuntimeModes[0] !== 'simulation')) diagnostics.push(diag(flow, 'AF1401', 'error', '三维联动节点仅允许 simulation；真实设备必须另行绑定命令和 ACK。'));
	if (sceneFlow && manifest?.behaviors?.some(b => b.enabled !== false)) diagnostics.push(diag(flow, 'AF1402', 'error', '三维动作流场景不能混用启用中的 V1 动作序列，请先完整迁移或停用旧序列。'));
	const variables = new Set<string>();
	for (const variable of flow.variables || []) {
		if (!variable.name?.trim() || variables.has(variable.name) || ['__proto__','prototype','constructor'].includes(variable.name) || !['string','number','boolean','json'].includes(variable.type) || (variable.initialValue !== undefined && variable.type !== 'json' && typeof variable.initialValue !== variable.type)) diagnostics.push(diag(flow, 'AF1408', 'error', '变量名必须唯一且非保留名，初始值必须符合声明类型。', {propertyPath:'variables'}));
		variables.add(variable.name);
	}
	const validatePredicate = (group: unknown, patch: Partial<TwinActionFlowDiagnostic>) => {
		const visit = (value: any, depth = 0): boolean => Boolean(value && typeof value === 'object' && depth < 32 && ['and','or'].includes(value.logic) && Array.isArray(value.items) && (!sceneFlow || value.items.length) && value.items.every((item: any) => item && typeof item === 'object' && ('logic' in item ? visit(item, depth+1) : ['binding','variable','material','runtime'].includes(item.source) && ['eq','ne','gt','gte','lt','lte','in','changed','risingEdge','truthy','falsy'].includes(item.operator) && typeof item.ref === 'string' && item.ref.trim())));
		if (!visit(group)) { diagnostics.push(diag(flow, 'AF1409', 'error', '条件必须包含有效数据来源、字段和比较方式，三维条件不能为空。', patch)); return; }
		for (const predicate of predicateLeaves(group as TwinPredicateGroup)) {
			if (sceneFlow && manifest && ['runtime','material'].includes(predicate.source) && !validMaterialStateRef(predicate.ref,manifest)) diagnostics.push(diag(flow,'AF1410','error','物料条件引用的槽位、TCP、夹具或状态字段不存在。',patch));
			if (predicate.source === 'binding' && manifest && !bindingIds.has(predicate.ref)) diagnostics.push(diag(flow, 'AF1104', 'error', `条件引用的 Binding ${predicate.ref} 不存在。`, patch));
			if (predicate.source === 'variable' && !variables.has(predicate.ref)) diagnostics.push(diag(flow, 'AF1005', 'error', `条件引用的变量 ${predicate.ref} 未声明。`, patch));
		}
	};

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
		if (node.type === 'Condition') validatePredicate(node.config?.predicate, {nodeId:node.nodeId, propertyPath:`nodes[${index}].config.predicate`});
		if (sceneFlow) {
			if (sceneSafetyNodeTypes.has(node.type) && ((node.timeoutPolicy && (node.timeoutPolicy.onTimeout || 'fault') !== 'fault') || (node.retryPolicy?.maxAttempts || 1) > 1 || node.compensationNodeId || flow.edges.some(e=>e.sourceNodeId===node.nodeId && ['failure','timeout'].includes(e.sourcePort)))) diagnostics.push(diag(flow,'AF1414','error','安全动作只允许超时/失败停机，禁止跳过、自动重试或错误分支绕行。',{nodeId:node.nodeId}));
			for (const key of ['onStartState','onCompleteState']) if (Array.isArray(node.config[key]) && (node.config[key] as Array<{source?:string}>).some(a=>isReadOnlyStateRef(String(a?.source || ''),bindingIds))) diagnostics.push(diag(flow,'AF1411','error','绑定、物料及工位状态只读，禁止动作赋值。',{nodeId:node.nodeId}));
			if (manifest && actuatorNodeTypes.has(node.type)) {
				const axis = manifest.actuators?.find(a=>a.actuatorId===configString(node,'actuatorId')), value = node.config.targetValue;
				if (axis && (axis.objectId !== node.actorObjectId || (['GripOpen','GripClose'].includes(node.type) && axis.kind !== 'gripper') || (['AxisMove','JointMove'].includes(node.type) && (typeof value !== 'number' || !Number.isFinite(value) || value < (axis.minValue ?? -Infinity) || value > (axis.maxValue ?? Infinity))))) diagnostics.push(diag(flow,'AF1413','error','执行轴必须属于当前设备，夹具类型及运动目标必须符合声明行程。',{nodeId:node.nodeId}));
			}
			if (node.type === 'SetState' && configString(node,'scope') === 'semantic' && isReadOnlyStateRef(configString(node,'ref'),bindingIds)) diagnostics.push(diag(flow,'AF1411','error','绑定、物料及工位状态只读，禁止写入。',{nodeId:node.nodeId}));
			if (manifest && ['Attach','Detach','Pick','Place'].includes(node.type)) {
				const pick = ['Attach','Pick'].includes(node.type), point = manifest.workPoints?.find(p=>p.workPointId===configString(node,'workPointId'));
				const slot = manifest.materialSlots?.find(s=>s.slotId===configString(node,pick?'sourceSlotId':'targetSlotId'));
				const frame = manifest.toolFrames?.find(f=>f.toolFrameId===(configString(node,'toolFrameId') || point?.toolFrameId));
				const payloadType = configString(node,'payloadType') || (pick ? slot?.payloadType : '');
				if (payloadType && ((slot?.payloadType && slot.payloadType!==payloadType) || (frame?.payloadTypes?.length && !frame.payloadTypes.includes(payloadType)))) diagnostics.push(diag(flow,'AF1412','error','物料类型必须与槽位及工具允许类型一致。',{nodeId:node.nodeId}));
				if (!slot || !frame || frame.objectId !== node.actorObjectId || (point && (point.materialSlotId !== slot.slotId || point.toolFrameId !== frame.toolFrameId)) || (pick ? slot.role === 'target' : slot.role === 'source')) diagnostics.push(diag(flow,'AF1412','error','物料交接必须引用角色正确的槽位、当前设备 TCP 和一致的工作点。',{nodeId:node.nodeId}));
				if (node.config.payloadCount !== undefined && (!Number.isInteger(node.config.payloadCount) || Number(node.config.payloadCount) < 1)) diagnostics.push(diag(flow,'AF1412','error','抓取数量必须为正整数。',{nodeId:node.nodeId}));
			}
			if (!sceneActionFlowNodeTypes.has(node.type)) diagnostics.push(diag(flow, 'AF1403', 'error', `${node.type} 尚无完整三维执行适配器，不能以计时假完成。`, { nodeId: node.nodeId }));
			if (['WaitStation','CompleteStation','MarkMaterial','SelectRoute','Pick','Place','Attach','Detach','PrepareSlot'].includes(node.type) && !node.actorObjectId) diagnostics.push(diag(flow, 'AF1101', 'error', `${node.type} 必须指定执行设备。`, { nodeId: node.nodeId }));
			if (['WaitStation','CompleteStation'].includes(node.type)) {
				const group = configString(node, 'completionGroup');
				if (!group || (manifest && !manifest.routes.some(r => r.points.some(p => p.componentObjectId === node.actorObjectId && (p.process?.behaviorCompletionGroups?.includes(group) || p.process?.behaviorCompletionRequirements?.[group]))))) diagnostics.push(diag(flow, 'AF1404', 'error', '到位/放行节点必须引用设备工位已有的完成组。', { nodeId: node.nodeId }));
			}
			if (node.type === 'WaitInterlock' && manifest && !interlockIds.has(configString(node, 'interlockId'))) diagnostics.push(diag(flow, 'AF1103', 'error', '等待联锁引用不存在。', { nodeId: node.nodeId }));
			if (['Pick','Place'].includes(node.type) && manifest && (!workPointIds.has(configString(node, 'workPointId')) || !slotIds.has(configString(node, node.type === 'Pick' ? 'sourceSlotId' : 'targetSlotId')))) diagnostics.push(diag(flow, 'AF1103', 'error', '抓放节点必须引用有效工作点和物料槽位。', { nodeId: node.nodeId }));
			if (node.type === 'SetState' && (!['variable','semantic'].includes(configString(node,'scope')) || !configString(node, 'ref') || ['__proto__','constructor','prototype'].includes(configString(node,'ref')) || !Object.prototype.hasOwnProperty.call(node.config,'value') || (node.config.scope === 'variable' && !flow.variables.some(v => v.name === configString(node, 'ref'))))) diagnostics.push(diag(flow, 'AF1405', 'error', '状态节点需要有效范围、语义键或已声明变量以及状态值。', { nodeId: node.nodeId }));
			if (node.type === 'MarkMaterial' && !configString(node, 'stage')) diagnostics.push(diag(flow, 'AF1405', 'error', '工艺标记不能为空。', { nodeId: node.nodeId }));
			if (node.type === 'SelectRoute' && manifest && !manifest.routes.find(r => r.routeId === configString(node, 'routeId'))?.edges.some(e => e.edgeId === configString(node, 'edgeId') && e.fromPointId === configString(node, 'junctionPointId') && e.enabled !== false)) diagnostics.push(diag(flow, 'AF1106', 'error', '必须选择路线中真实存在的岔口出边。', { nodeId: node.nodeId }));
			if (node.config.alignPayloadGrid === true && (node.type !== 'MoveTo' || Boolean(configString(node, 'sourceSlotId')) === Boolean(configString(node, 'targetSlotId')) || Number(node.config.payloadCount || 1) > 12)) diagnostics.push(diag(flow, 'AF1406', 'error', '变距必须配置唯一来源或目标槽位，批次不能超过夹具 12 抓位。', { nodeId: node.nodeId }));
			for (const key of ['payloadCount','minimumPayloadCount','durationSeconds']) if (node.config[key] !== undefined && (typeof node.config[key] !== 'number' || !Number.isFinite(node.config[key]) || Number(node.config[key]) < 0)) diagnostics.push(diag(flow, 'AF1406', 'error', `${key} 必须为有限非负数。`, { nodeId: node.nodeId }));
		}
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
		if (edge.predicate !== undefined) validatePredicate(edge.predicate, {edgeId:edge.edgeId,propertyPath:`edges[${index}].predicate`});
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
	if (sceneFlow) for (const node of flow.nodes) {
		const edges = flow.edges.filter(e => e.sourceNodeId === node.nodeId);
		const requiredPorts = node.type === 'End' ? [] : node.type === 'Condition' ? ['true','false'] : node.type === 'Loop' ? ['repeat','done'] : ['success'];
		for (const port of requiredPorts) if (!edges.some(e => e.sourcePort === port)) diagnostics.push(diag(flow, 'AF1407', 'error', `节点缺少 ${port} 连线，禁止断图假完成。`, { nodeId: node.nodeId }));
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
