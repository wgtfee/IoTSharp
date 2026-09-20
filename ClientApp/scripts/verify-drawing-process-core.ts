import assert from 'node:assert/strict';
import * as THREE from 'three';
import { normalizeTwinRoute, validateTwinSceneManifest, type TwinRouteDefinition } from '../src/digital-twin/contracts';
import { ensureComponentActuators, migrateSilkLineInfrastructureToV7 } from '../src/digital-twin/components';
import { upgradeReferencePackagingLineLayout } from '../src/digital-twin/presets/ReferencePackagingLineManifest';
import { upgradeSilkPackagingLayout } from '../src/digital-twin/runtime/SilkPackagingLayoutMigration';
import { createDrawingPackagingProcessManifest } from '../src/digital-twin/presets/DrawingPackagingProcessManifest';
import { SceneActionFlowRuntime } from '../src/digital-twin/action-flow/runtime/SceneActionFlowRuntime';
import { RouteEngine } from '../src/digital-twin/routes/RouteEngine';
import { RouteAlignedBatchRuntime, type BatchRouteEntity } from '../src/digital-twin/runtime/RouteAlignedBatchRuntime';
import { createDrawingPackagingLineManifest } from '../src/digital-twin/presets/DrawingPackagingLineManifest';

const root = new THREE.Group();
const routes: TwinRouteDefinition[] = ['A', 'B'].map((lane, row) => ({
	routeId: lane, name: lane, type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: true, orientToPath: true,
	routingMode: 'automatic', junctionDecisions: {}, decisionRules: [], startPointId: lane + '0',
	points: [[-40, .9, row * 1.92], [0, .9, row * 1.92], [20, .9, row * 1.92], [20, .9, row * 1.92 + 20], [-40, .9, row * 1.92 + 20]].map((position, index) => ({
		pointId: lane + index, name: lane + index, position: position as [number, number, number],
		...(index === 1 ? { kind: 'processStation' as const, componentObjectId: 'robot', process: { type: 'robot-loading', batchArrivalMode: 'route-aligned' as const, batchSize: 12, batchLaneSize: 6, physicalLane: lane, behaviorCompletionGroups: ['load', 'safe'] } } : {}),
	})),
	edges: Array.from({ length: 5 }, (_, index) => ({ edgeId: lane + 'edge' + index, name: lane, fromPointId: lane + index, toPointId: lane + (index + 1) % 5, enabled: true, bidirectional: false })),
}));
const batches = new RouteAlignedBatchRuntime(routes, id => id === 'robot' ? root : undefined);
const entities: BatchRouteEntity[] = routes.flatMap(route => Array.from({ length: 6 }, (_, index) => {
	const entityRoot = new THREE.Group();
	const simulationEngine = new RouteEngine(route, entityRoot);
	simulationEngine.correctDistance(15 - index * 1.55);
	simulationEngine.setRunning(true);
	return { key: route.routeId + index, palletId: route.routeId + index, routeId: route.routeId, physicalLane: route.routeId, root: entityRoot, simulationRoute: route, simulationEngine };
}));
let ready = 0, completed = 0, previousIds = '', minimumSpacing = Infinity;
// 工位完成回写是明确的 Test Double；不代表真实机器人动作已通过。
for (let tick = 0; tick < 16000 && completed < 3; tick++) {
	batches.update(entities);
	const ids = (root.userData.stationPalletIds || []).join('|');
	if (ids && ids !== previousIds) { ready++; previousIds = ids; }
	if (!ids) previousIds = '';
	if (ids) {
		for (const e of entities) assert(Math.abs(e.root.position.z - (e.physicalLane === 'A' ? 0 : 1.92)) < 1e-8, '真实路线没有到位，不可触发动作');
		root.userData.stationCompletedGroupCounts = { load: 1, safe: tick % 20 === 19 ? 1 : 0 };
	}
	for (const entity of entities) {
		const before = entity.root.position.clone();
		entity.simulationEngine!.updateFixed(batches.limitTravel(entity, .05));
		entity.simulationEngine!.render(1);
		assert(entity.root.position.distanceTo(before) <= .050001, '批次控制不允许瞬移');
	}
	for (const lane of ['A', 'B']) {
		const z = lane === 'A' ? 0 : 1.92;
		// 本单元测试只负责工位停车/离站，拐角空间仲裁由 50 托真实 RouteSlot 回归单独验证。
		const positions = entities.filter(e => e.physicalLane === lane && e.root.position.x >= -12 && e.root.position.x <= 2 && Math.abs(e.root.position.z - z) < 1e-8).map(e => e.root.position);
		for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
			const distance = positions[i].distanceTo(positions[j]); minimumSpacing = Math.min(minimumSpacing, distance);
			assert(distance >= 1.49, '排队、释放不能重叠');
		}
	}
	completed = root.userData.completedBatchCount || 0;
}
assert.equal(completed, 3, `三批到位与逐托离站未通过：${JSON.stringify(root.userData)}`);
assert.equal(ready, 3);
batches.reset();
assert.equal(root.userData.completedBatchCount, 0);
assert.deepEqual(root.userData.stationPalletIds, []);

const route = createDrawingPackagingLineManifest().routes[0];
route.replanUpcomingJunctions = true;
route.decisionRules = route.decisionRules.filter(rule => rule.junctionPointId !== 'drawing-p-1320-554');
route.decisionRules.push(
	{ ruleId: 'empty', name: '空托回流', junctionPointId: 'drawing-p-1320-554', edgeId: 'drawing-edge-empty-1', source: 'payload', payloadKey: 'materialCount', operator: 'equals', matchValue: 0, priority: 100, enabled: true },
	{ ruleId: 'loaded', name: '载料套袋', junctionPointId: 'drawing-p-1320-554', edgeId: 'drawing-edge-right-trunk-3', source: 'payload', payloadKey: 'materialCount', operator: 'greaterThan', matchValue: 0, priority: 100, enabled: true },
);
const target = new THREE.Group();
const engine = new RouteEngine(route, target);
const context = (count: number) => ({ dataMode: 'simulation' as const, payload: { physicalLane: 'A', routeCode: 'A', drawingProfile: 'main', materialCount: count } });
engine.setRoutingContext(context(0));
engine.correctDistance(20); engine.setRunning(true);
const original = target.position.clone(), originalDistance = engine.getSnapshot().distanceMeters;
assert(engine.getSnapshot().activeEdgeIds.includes('drawing-edge-empty-1'));
engine.setRoutingContext(context(1));
assert(target.position.distanceTo(original) < 1e-8, '抓丝改变下游路线时不能瞬移');
assert.equal(engine.getSnapshot().distanceMeters, originalDistance);
assert(!engine.getSnapshot().activeEdgeIds.includes('drawing-edge-empty-1'));
assert(engine.getSnapshot().activeEdgeIds.includes('drawing-edge-bag-a-1'));
// 已进入套袋区域后卸料也不能倒回空回流路径。
while (engine.getSnapshot().currentEdgeId !== 'drawing-edge-bag-a-2') { engine.updateFixed(.05); engine.render(1); }
const past = target.position.clone();
engine.setRoutingContext(context(0));
assert(target.position.distanceTo(past) < 1e-8);
assert.equal(engine.getSnapshot().currentEdgeId, 'drawing-edge-bag-a-2');
assert(engine.getSnapshot().activeEdgeIds.includes('drawing-edge-bag-a-1'));
// 静态直线的米制逻辑距离必须等于可见移动距离。
const exact = new RouteEngine(routes[0], new THREE.Group());
exact.correctDistance(39.99);
assert(exact.getCurve().getPointAt(39.99 / exact.getSnapshot().lengthMeters).distanceTo(new THREE.Vector3(-.01, .9, 0)) < 1e-8);
const valid = createDrawingPackagingProcessManifest();
// 覆盖设计器重开草稿时的通用规范化路径，避免独立图纸场景被旧 V19 迁移重写。
const reloaded = structuredClone(valid);
reloaded.routes = reloaded.routes.map(normalizeTwinRoute);
assert.equal(upgradeReferencePackagingLineLayout(reloaded), false);
upgradeSilkPackagingLayout(reloaded); migrateSilkLineInfrastructureToV7(reloaded); ensureComponentActuators(reloaded);
const layoutFingerprint = (m: typeof valid) => ({
	objects: m.objects.map(o => ({ id: o.objectId, transform: o.transform })),
	routes: m.routes.map(r => ({ id: r.routeId, points: r.points.map(p => ({ id: p.pointId, position: p.position, process: p.process })), edges: r.edges.map(e => ({ id: e.edgeId, from: e.fromPointId, to: e.toPointId })) })),
	behaviors: m.behaviors, actionFlows: m.actionFlows, slots: m.materialSlots, toolFrames: m.toolFrames, actuators: m.actuators,
});
assert.deepEqual(layoutFingerprint(reloaded), layoutFingerprint(valid), '重开草稿不得改动图纸布局、工艺或驱动轴');
assert(!validateTwinSceneManifest(valid).some(d => d.severity === 'error'));
assert(valid.interlocks!.find(i => i.interlockId === 'drawing-wood-complete')!.conditions.some(c => c.source === 'drawing-gantry.safeToDispatch' && c.operator === 'truthy'), '木托放行必须要求夹具安全退出');
const gantrySteps = valid.actionFlows!.find(f => f.flowId === 'drawing-flow-stack')!;
assert(gantrySteps.nodes.some(n => n.type === 'SetState' && n.config.ref === 'drawing-gantry.safeToDispatch' && n.config.value === false));
assert(gantrySteps.edges.some(e => e.sourceNodeId === 'board-retreat' && e.targetNodeId === 'safe'));
const expectInvalid = (change: (m: typeof valid) => void, code: string) => { const m = structuredClone(valid); change(m); assert(validateTwinSceneManifest(m).some(d => d.code === code), code); };
expectInvalid(m => { m.toolFrames![0].cartesianActuatorIds = ['missing-axis']; }, 'twin.behavior.tool-frame.cartesian.invalid');
expectInvalid(m => { m.actionFlows![0].nodes.find(n=>n.nodeId==='left-prepare')!.config.alignPayloadGrid = true; }, 'AF1406');
expectInvalid(m => { m.actionFlows![0].nodes.find(n=>n.nodeId==='left-approach')!.config.targetSlotId = 'drawing-loading-target'; }, 'AF1406');
expectInvalid(m => { m.actionFlows![0].nodes.find(n=>n.nodeId==='left-approach')!.config.payloadCount = 13; }, 'AF1406');
expectInvalid(m => { m.routes[0].points.find(p => p.process?.batchSize === 12)!.process!.batchLaneSize = 13; }, 'twin.route.batch.size.invalid');
expectInvalid(m => { m.routes[0].points.find(p => p.process?.batchSize === 12)!.process!.batchLaneSize = 5; }, 'twin.route.batch.capacity.invalid');
expectInvalid(m => { m.runtime.routePalletInitializers![0].transportUnitProperties = { length: Infinity }; }, 'twin.runtime.transport-properties.invalid');
expectInvalid(m => { m.routes[0].points.find(p => p.process?.batchSize === 12)!.process!.materialStageOnComplete = ''; }, 'twin.route.batch.stage.invalid');
const live = structuredClone(valid); live.runtime.dataMode = 'live';
let commands = 0; const liveScene = new THREE.Scene();
const liveBehavior = new SceneActionFlowRuntime(live, liveScene, () => undefined, undefined, () => { commands++; return true; }, undefined, () => { throw new Error('Live 不应生成仿真停止命令'); });
liveBehavior.setRunning(true); for (let i = 0; i < 100; i++) liveBehavior.updateFixed(.05);
assert.equal(commands, 0, 'Live 不得执行模拟抓放命令'); assert.equal(liveBehavior.getSnapshot().active, false); liveBehavior.dispose();
console.log(JSON.stringify({ passed: true, batchCycles: completed, minimumSameLaneSpacing: minimumSpacing, dynamicPayloadRouting: true, lockedPastJunctions: true, exactDistanceSampling: true, designerReloadPreservesLayout: true, invalidContractCases: 8, liveGeneratedCommands: commands, equipmentCompletion: 'test-double-only' }, null, 2));
