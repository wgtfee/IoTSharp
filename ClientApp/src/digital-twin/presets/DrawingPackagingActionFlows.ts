import type { TwinActionFlowDefinitionV2, TwinActionFlowNode, TwinActionFlowNodeType } from '../action-flow/contracts/action-flow-v2';

/** 仅生成可编辑的默认图；执行器不导入本文件，也不依赖这些设备或节点 ID。 */
export function createDrawingPackagingActionFlows(robot: string, gantry: string, wood: string, router: string, robotFrame: string, routeId: string) {
	const flows: TwinActionFlowDefinitionV2[] = [];
	const node = (id: string, type: TwinActionFlowNodeType, name: string, actor: string, config: Record<string, unknown> = {}, timeout = 120): TwinActionFlowNode => ({
		nodeId: id, type, name, actorObjectId: actor, config, timeoutPolicy: { seconds: timeout, onTimeout: 'fault' },
	});
	const flow = (id: string, name: string, actor: string) => {
		const definition: TwinActionFlowDefinitionV2 = { flowId: id, key: id, name, contractVersion: '2.0', actorObjectIds: [actor], variables: [], nodes: [], edges: [],
			policies: { executionTarget: 'scene', allowedRuntimeModes: ['simulation'], defaultTimeoutSeconds: 7200, maxLoopIterations: 10000, requireInterlockForCommands: true }, enabled: true, revision: 1, status: 'Draft' };
		flows.push(definition); return definition;
	};
	const link = (f: TwinActionFlowDefinitionV2, from: string, to: string, port = 'success') => f.edges.push({ edgeId: `${from}-${port}-${to}`, sourceNodeId: from, sourcePort: port, targetNodeId: to });
	const chain = (f: TwinActionFlowDefinitionV2, steps: TwinActionFlowNode[], row = 0) => {
		for (const [i, step] of steps.entries()) {
			step.editor = { x: 60 + (i % 5) * 228, y: 60 + row * 140 + Math.floor(i / 5) * 140 };
			f.nodes.push(step); if (i) link(f, steps[i - 1].nodeId, step.nodeId);
		}
	};
	const wait = (actor: string, group: string) => node('arrive', 'WaitStation', '等待真实批次到位', actor, { completionGroup: group }, 7200);
	const finish = (f: TwinActionFlowDefinitionV2, actor: string, group: string, previous: string, row = 6) => {
		const steps = [node('release', 'CompleteStation', '确认完成并释放当前批次', actor, { completionGroup: group }),
			node('cycle', 'Loop', '下一批（有界循环）', actor, { maxIterations: 10000 }), node('end', 'End', '本次仿真结束', actor)];
		chain(f, steps, row); f.edges.pop(); link(f, previous, 'release'); link(f, 'cycle', 'arrive', 'repeat'); link(f, 'cycle', 'end', 'done');
	};
	const start = (actor: string) => node('start', 'Start', '开始', actor);

	const load = flow('drawing-flow-load', '抓丝机器人：左右丝车交替 → 双排小托盘', robot);
	load.variables = [{ name: 'useLeft', type: 'boolean', initialValue: true }];
	chain(load, [start(robot), wait(robot, 'load'), node('side', 'Condition', '本批使用左丝车？', robot, { predicate: { logic: 'and', items: [{ source: 'variable', ref: 'useLeft', operator: 'truthy' }] } })]);
	for (const [index, side] of ['left', 'right'].entries()) {
		const slot = `drawing-cart-${side}`, pick = `drawing-pick-${side}`, prefix = `${side}-`;
		const steps = [
			node(prefix + 'prepare', 'PrepareSlot', '丝车换面 / 准备可取库存', robot, { slotId: slot }),
			node(prefix + 'wrist', 'MovePose', '调整抓丝面朝向', robot, { poseId: 'drawing-robot-wrist' }),
			node(prefix + 'approach', 'MoveTo', '接近丝车并对齐变距夹具', robot, { workPointId: pick, sourceSlotId: slot, payloadType: 'silk-cake', payloadCount: 12, alignPayloadGrid: true }),
			node(prefix + 'close', 'GripClose', '夹紧丝锭', robot, { actuatorId: `${robot}:robot-gripper` }),
			node(prefix + 'attach', 'Attach', '挂接实际丝锭（允许尾批）', robot, { sourceSlotId: slot, workPointId: pick, toolFrameId: robotFrame, payloadType: 'silk-cake', payloadCount: 12, allowPartialPayload: true, minimumPayloadCount: 1 }),
			node(prefix + 'align', 'MoveTo', '移至双排托盘上方并变距', robot, { workPointId: 'drawing-load-place', targetSlotId: 'drawing-loading-target', toolFrameId: robotFrame, approachOffset: [0, 3, 0], alignPayloadGrid: true }),
			node(prefix + 'place', 'Place', '逐托接触放料并回撤', robot, { workPointId: 'drawing-load-place', targetSlotId: 'drawing-loading-target', toolFrameId: robotFrame, approachOffset: [0, 3, 0] }),
			node(prefix + 'open', 'GripOpen', '打开夹具', robot, { actuatorId: `${robot}:robot-gripper` }),
			node(prefix + 'home', 'Home', '回安全姿态', robot, { poseId: `${robot}:home` }),
			node(prefix + 'next', 'SetState', '下一批切换丝车', robot, { scope: 'variable', ref: 'useLeft', value: side !== 'left' }),
		];
		chain(load, steps, 2 + index * 3); link(load, 'side', steps[0].nodeId, index === 0 ? 'true' : 'false');
	}
	finish(load, robot, 'load', 'left-next', 8); link(load, 'right-next', 'release');

	const stack = flow('drawing-flow-stack', '桁架：六丝锭成层 → 隔板 → 安全回退', gantry);
	const yarnTool = `${gantry}:gantry-yarn-tcp`, boardTool = `${gantry}:gantry-separator-tcp`;
	chain(stack, [start(gantry), node('initial-safe', 'SetState', '初始化禁止木托出料', gantry, { scope: 'semantic', ref: 'drawing-gantry.safeToDispatch', value: false }), wait(gantry, 'stack'),
		node('wood-ready', 'WaitInterlock', '等待木托到位且未满', gantry, { interlockId: 'drawing-wood-arrived' }, 1200),
		node('unsafe', 'SetState', '加工中禁止木托离站', gantry, { scope: 'semantic', ref: 'drawing-gantry.safeToDispatch', value: false }),
		node('board-park', 'MoveTo', '隔板夹具安全避让', gantry, { workPointId: 'drawing-separator-safe' }),
		node('yarn-above', 'MoveTo', '丝锭夹具接近双排六托', gantry, { workPointId: 'drawing-gantry-pick', approachOffset: [0, 3, 0] }),
		node('yarn-contact', 'MoveTo', '丝锭夹具接触', gantry, { workPointId: 'drawing-gantry-pick' }),
		node('yarn-close', 'GripClose', '夹紧六丝锭', gantry, { actuatorId: `${gantry}:gantry-yarn-gripper` }),
		node('yarn-attach', 'Attach', '挂接六丝锭', gantry, { sourceSlotId: 'drawing-gantry-source', toolFrameId: yarnTool, payloadType: 'silk-cake', payloadCount: 6 }),
		node('yarn-lift', 'MoveTo', '提升六丝锭', gantry, { workPointId: 'drawing-gantry-pick', approachOffset: [0, 3, 0] }),
		node('yarn-place', 'Place', '码入当前木托目标层', gantry, { workPointId: 'drawing-gantry-place', targetSlotId: 'drawing-stack', toolFrameId: yarnTool, approachOffset: [0, 1.1, 0] }),
		node('yarn-open', 'GripOpen', '打开丝锭夹具', gantry, { actuatorId: `${gantry}:gantry-yarn-gripper` }),
		node('yarn-park', 'MoveTo', '丝锭夹具安全回退', gantry, { workPointId: 'drawing-gantry-safe' }),
		node('board-ready', 'PrepareSlot', '准备隔板库存', gantry, { slotId: 'drawing-separator-source' }),
		node('board-contact', 'MoveTo', '接触隔板', gantry, { workPointId: 'drawing-separator-pick' }),
		node('board-close', 'GripClose', '夹紧隔板', gantry, { actuatorId: `${gantry}:gantry-separator-gripper` }),
		node('board-attach', 'Attach', '挂接隔板', gantry, { sourceSlotId: 'drawing-separator-source', toolFrameId: boardTool, payloadType: 'separator', payloadCount: 1 }),
		node('board-lift', 'MoveTo', '提升隔板', gantry, { workPointId: 'drawing-separator-pick', approachOffset: [0, 3, 0] }),
		node('board-place', 'Place', '隔板覆盖当前木托层', gantry, { workPointId: 'drawing-separator-place', targetSlotId: 'drawing-separator-target', toolFrameId: boardTool, approachOffset: [0, 1, 0] }),
		node('board-open', 'GripOpen', '松开隔板', gantry, { actuatorId: `${gantry}:gantry-separator-gripper` }),
		node('board-retreat', 'MoveTo', '隔板夹具安全回退', gantry, { workPointId: 'drawing-separator-safe' }),
		node('safe', 'SetState', '两夹具退回，允许成品判断', gantry, { scope: 'semantic', ref: 'drawing-gantry.safeToDispatch', value: true }),
	]); finish(stack, gantry, 'stack', 'safe');
	const dispatch = flow('drawing-flow-dispatch', '成品木托：满 48 件及 8 隔板且安全后出料', wood);
	chain(dispatch, [start(wood), wait(wood, 'ready'), node('full-safe', 'WaitInterlock', '等待满托且夹具退回', wood, { interlockId: 'drawing-wood-complete' }, 3600)]);
	finish(dispatch, wood, 'ready', 'full-safe', 2);
	for (const [actor, name, duration, stage] of [
		['drawing-inspection', '外检', 2.4, 'inspected'], ['drawing-bag-a', '套袋 A', 3, 'bagged-a'], ['drawing-bag-b', '套袋 B', 3, 'bagged-b'],
	] as const) {
		const process = flow(`${actor}-flow`, `${name}：到位 → 模拟加工 → 记录 → 放行`, actor);
		chain(process, [start(actor), wait(actor, 'process'), node('processing', 'Delay', `${name}模拟节拍（非 PLC ACK）`, actor, { durationSeconds: duration }),
			node('mark', 'MarkMaterial', `记录${name}完成`, actor, { stage })]); finish(process, actor, 'process', 'mark', 2);
	}
	const routing = flow('drawing-flow-routing', '分流：实际空托回流 / 载丝托盘进入双套袋', router);
	const select = (id: string, name: string, junctionPointId: string, edgeId: string) => node(id, 'SelectRoute', name, router, { routeId, junctionPointId, edgeId });
	chain(routing, [start(router), wait(router, 'route'), node('loaded', 'Condition', '当前托盘上有丝锭？', router,
		{ predicate: { logic: 'and', items: [{ source: 'runtime', ref: 'station.materialCount', operator: 'gt', value: 0 }] } })]);
	chain(routing, [select('empty', '空托：最上方单排回抓丝机器人', 'drawing-p-1320-554', 'drawing-edge-empty-1')], 2); link(routing, 'loaded', 'empty', 'false');
	chain(routing, [select('bag-feed', '载丝：进入套袋公共干线', 'drawing-p-1320-554', 'drawing-edge-right-trunk-3'),
		node('bag-side', 'Condition', '托盘分组为 A？', router, { predicate: { logic: 'and', items: [{ source: 'runtime', ref: 'station.routeCode', operator: 'eq', value: 'A' }] } })], 3);
	link(routing, 'loaded', 'bag-feed', 'true');
	chain(routing, [select('to-a', '选择套袋 A', 'drawing-p-1320-432', 'drawing-edge-right-trunk-4')], 4);
	chain(routing, [select('to-b', '选择套袋 B', 'drawing-p-1320-432', 'drawing-edge-bag-b-1')], 5);
	link(routing, 'bag-side', 'to-a', 'true'); link(routing, 'bag-side', 'to-b', 'false');
	finish(routing, router, 'route', 'empty'); link(routing, 'to-a', 'release'); link(routing, 'to-b', 'release');
	return flows;
}
