import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createBlankTwinSceneManifest, createDefaultTwinSceneManifest, createRouteEdge, createRoutePoint, createSilkCakeLineTwinSceneManifest, normalizeTwinRoute, validateTwinSceneManifest, type TwinSceneManifest } from '../src/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '../src/digital-twin/contracts/v7-components';
import { ComponentProcessStateMachine } from '../src/digital-twin/runtime/ComponentProcessStateMachine';
import { ProcessStationManager } from '../src/digital-twin/runtime/ProcessStationManager';
import { ComponentProcessRuntime } from '../src/digital-twin/runtime/ComponentProcessRuntime';
import {
	advanceComponentVisualRuntime,
	applyComponentSnap,
	buildComponentFromTemplate,
	buildComponentGraphRoutes,
	builtInComponentResourceRegistrations,
	builtInComponentTemplates,
	ComponentMigrationRegistry,
	createComponentDefinitionFromTemplate,
	defaultComponentRegistry,
	ensureComponentActuators,
	findBestComponentSnap,
	findBestTransportRouteSnap,
	hasCompleteSilkV7Infrastructure,
	migrateSilkLineInfrastructureToV7,
	revalidateComponentConnections,
	resolveComponentPorts,
	resolveSceneComponentSnapOptions,
	snapSceneComponent,
	SILK_V7_MIGRATION_VERSION,
	snapAndConnectNearestComponent,
	upsertGeneratedComponentRoute,
	upsertGeneratedComponentRoutes,
	validateV7ComponentManifest,
} from '../src/digital-twin/components';
import { cloneStudioPartForPaste, cloneStudioPartsForPaste, createStudioPart } from '../src/digital-twin/component-studio/types';
import { PACKAGING_WOOD_PALLET_LENGTH, PACKAGING_WOOD_PALLET_WIDTH } from '../src/digital-twin/components/PackagingLineDimensions';
import { buildReferencePackagingLineTwinSceneManifest, createReferencePackagingLineTwinSceneManifest, REFERENCE_PACKAGING_LAYOUT_VERSION, upgradeReferencePackagingLineLayout } from '../src/digital-twin/presets/ReferencePackagingLineManifest';
import { resolveRoutePath, RouteEngine } from '../src/digital-twin/routes/RouteEngine';
import { compileRouteAuthoringGraph, createCompiledRuntimeManifest, createPublishedRuntimeManifest, persistCompiledRouteGraph } from '../src/digital-twin/routes/RouteAuthoringCompiler';
import { attachRoutePointToPort, detachRoutePointFromPort, listRouteEndpointPortSnapOptions } from '../src/digital-twin/routes/RouteSnapEngine';
import { convertGeneratedRouteToManual, ensureRouteSection, renameRouteSection } from '../src/digital-twin/routes/RouteAuthoringTools';
import { validateRouteAuthoringManifest } from '../src/digital-twin/routes/RouteAuthoringValidator';
import { resolveRuntimeRouteEdgeOverlayState } from '../src/digital-twin/routes/RouteRuntimeOverlay';
import { ROUTE_DEBUG_MIN_SAFETY_DISTANCE_METERS, runDiverterRouteDebug, runMergeRouteDebug, runSingleRouteDebug } from '../src/digital-twin/routes/RouteDebugRunner';
import { applyTwinRuntimeDataUpdates, resolveRouteTransportUnitResourceKey } from '../src/digital-twin/runtime/TwinRuntime';
import { RouteSlotArrayRuntime } from '../src/digital-twin/runtime/RouteSlotArrayRuntime';
import { BehaviorRuntime } from '../src/digital-twin/runtime/BehaviorRuntime';
import { ActuatorRuntime } from '../src/digital-twin/runtime/ActuatorRuntime';
import { BindingEngine } from '../src/digital-twin/bindings/BindingEngine';
import {
	addActuatorDefinition,
	addBehaviorActionDefinition,
	addBehaviorDefinition,
	addInterlockDefinition,
	addMaterialSlotDefinition,
	addPoseDefinition,
	addToolFrameDefinition,
	addWorkPointDefinition,
	exportTwinOrchestration,
	importTwinOrchestration,
	moveBehaviorActionDefinition,
	removeMaterialSlotDefinition,
	removeWorkPointDefinition,
} from '../src/digital-twin/orchestration/TwinOrchestrationDesigner';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

// 架构边界回归：固定设备内部节点只允许出现在组件定义/组件设计器，跨对象业务别名不得进入通用 BehaviorRuntime。
const componentProcessRuntimeSource = readFileSync('src/digital-twin/runtime/ComponentProcessRuntime.ts', 'utf8');
for (const forbidden of ['Inspection-Rotary-Gripper', 'Bagging-', 'VacuumTuck-', 'Wrapper-Rotary-Arm', 'Labeler-Arm-Joint']) {
	assert(!componentProcessRuntimeSource.includes(forbidden), `ComponentProcessRuntime 重新硬编码了固定设备内部节点: ${forbidden}`);
}
assert(!componentProcessRuntimeSource.includes('hasLiveBindings'), '工艺运行模式不得再根据 Binding 存在性隐式推断');
assert(componentProcessRuntimeSource.includes("dataMode: 'simulation' | 'live'"), '工艺运行时没有显式接收 SceneManifest dataMode');
const behaviorRuntimeSource = readFileSync('src/digital-twin/runtime/BehaviorRuntime.ts', 'utf8');
for (const forbidden of ['YarnFixture', 'SeparatorFixture', 'readyForSeparator', 'inPalletZone']) {
	assert(!behaviorRuntimeSource.includes(forbidden), `BehaviorRuntime 重新引入了参考包装线业务别名: ${forbidden}`);
}
const routeSlotRuntimeSource = readFileSync('src/digital-twin/runtime/RouteSlotArrayRuntime.ts', 'utf8');
for (const forbidden of ['reference-loading-robot', 'reference-double-small-bottom']) {
	assert(!routeSlotRuntimeSource.includes(forbidden), `RouteSlotArrayRuntime 重新硬编码了参考包装线对象 ID: ${forbidden}`);
}
assert(!behaviorRuntimeSource.includes('executeRobotPlacePath') && !behaviorRuntimeSource.includes('robotPlacePath'), 'BehaviorRuntime 重新引入了机器人专用放料路径，动作路径必须由设计器普通步骤组成');
const referenceManifestSource = readFileSync('src/digital-twin/presets/ReferencePackagingLineManifest.ts', 'utf8');
assert(!referenceManifestSource.includes('reference-packaging-actions-v17'), '参考包装线又依赖独立动作预置 JSON');
assert(!referenceManifestSource.includes('applyReferenceActionPreset'), '参考包装线又在 Builder 中注入动作编排');
assert(referenceManifestSource.includes('reference-packaging-v19.scene.json'), '参考包装线没有使用设计器导出的完整 V19 SceneManifest 资产');
assert(!behaviorRuntimeSource.includes('spreadAttachedSilkPayload') && !behaviorRuntimeSource.includes('setRobotGridGripperSpread') && !behaviorRuntimeSource.includes('robotPlaceSpread'), '机器人搬运仍存在丝锭间距/夹具 scale 插值逻辑');
const sceneTreeSource = readFileSync('src/digital-twin/components/ThreeJsEditorHost.vue', 'utf8');
const editorCoreSource = readFileSync('src/digital-twin/editor-adapter/ThreeEditorCoreHost.ts', 'utf8');
const twinRuntimeSelectionSource = readFileSync('src/digital-twin/runtime/TwinRuntime.ts', 'utf8');
assert(sceneTreeSource.includes('startTreeRename') && sceneTreeSource.includes('commitTreeRename'), '3D 场景树没有提供对象名称内联修改能力');
assert(editorCoreSource.includes('renameObject(objectId: string, name: string)') && editorCoreSource.includes('loaded.root.name = trimmed'), 'threejs-editor 改名没有同步到已加载对象');
assert(twinRuntimeSelectionSource.includes('objectDefinition?.name || selected.name'), 'Runtime 点击显示没有优先使用 Manifest 场景对象名称');

// 设计器共用的纯数据 API 必须能从空动作区创建、排序、保存、重新加载完整编排，不允许测试绕过 UI 数据模型直接写专用 Runtime 代码。
const designerOrchestrationManifest = createDefaultTwinSceneManifest();
designerOrchestrationManifest.workPoints = [];
designerOrchestrationManifest.materialSlots = [];
designerOrchestrationManifest.toolFrames = [];
designerOrchestrationManifest.actuators = [];
designerOrchestrationManifest.poses = [];
designerOrchestrationManifest.behaviors = [];
designerOrchestrationManifest.interlocks = [];
const designerActorId = 'designer-zero-code-actor';
const designerSource = addMaterialSlotDefinition(designerOrchestrationManifest, designerActorId, {
	name: '双面物料源', role: 'source', payloadType: 'payload', capacity: 36,
	metadata: { entityGroups: ['A', 'B'], presentationAngles: { A: 0, B: Math.PI }, rotationNodePath: 'Deck', minimumBatch: 12, simulationReplenish: true, simulationReplenishLimit: 2 },
});
const designerStack = addMaterialSlotDefinition(designerOrchestrationManifest, designerActorId, {
	name: '码垛目标', role: 'stack', payloadType: 'payload', capacity: 48, runtimeOwnerType: 'wooden-pallet', runtimeOwnerSelection: 'station-batch', runtimeOwnerNodePath: 'StackAnchor',
	stackPattern: { rows: 2, columns: 3, layers: 8, spacingX: 0.5, spacingZ: 0.5, firstLayerY: 0.2, layerPitch: 0.4, layerMaterialRequired: true, layerMaterialOffsetY: 0.05 },
});
const designerTcp = addToolFrameDefinition(designerOrchestrationManifest, designerActorId, { name: 'TCP', nodePath: 'Tool', payloadTypes: ['payload'] });
const designerActuator = addActuatorDefinition(designerOrchestrationManifest, designerActorId, { name: 'Axis', nodePath: 'Axis', kind: 'linear-axis', motionAxis: 'x', unit: 'meter', homeValue: 0, speed: 1.5 });
const designerWorkPoint = addWorkPointDefinition(designerOrchestrationManifest, designerActorId, { name: 'Pick', role: 'pick', materialSlotId: designerSource.slotId, toolFrameId: designerTcp.toolFrameId, localPosition: [1, 2, 3] });
const designerPose = addPoseDefinition(designerOrchestrationManifest, designerActorId, { name: 'PickPose', workPointId: designerWorkPoint.workPointId, toolFrameId: designerTcp.toolFrameId, targets: [{ actuatorId: designerActuator.actuatorId, value: 1.25 }] });
const designerInterlock = addInterlockDefinition(designerOrchestrationManifest, { name: 'StackReady', mode: 'all', conditions: [{ source: `${designerStack.slotId}.complete`, operator: 'equals', value: false }] });
const designerBehavior = addBehaviorDefinition(designerOrchestrationManifest, designerActorId, { name: 'DesignerFlow', interlockIds: [designerInterlock.interlockId], stationCompletionGroup: 'designer', stationRequiredCycles: 2, selectionWeight: 3, loop: true });
const designerMove = addBehaviorActionDefinition(designerBehavior, { kind: 'movePose', poseId: designerPose.poseId, speedRatio: 0.75 });
const designerAttach = addBehaviorActionDefinition(designerBehavior, { kind: 'attach', sourceSlotId: designerSource.slotId, toolFrameId: designerTcp.toolFrameId, payloadType: 'payload', payloadCount: 12 });
addBehaviorActionDefinition(designerBehavior, { kind: 'detach', targetSlotId: designerStack.slotId, toolFrameId: designerTcp.toolFrameId, payloadType: 'payload', payloadCount: 6 });
assert(moveBehaviorActionDefinition(designerBehavior, 1, -1) && designerBehavior.actions[0].actionId === designerAttach.actionId && designerBehavior.actions[1].actionId === designerMove.actionId, '设计器动作排序 API 未生效');
const designerSnapshot = exportTwinOrchestration(designerOrchestrationManifest);
const designerRoundTrip = JSON.parse(JSON.stringify(designerSnapshot));
const designerReloaded = createDefaultTwinSceneManifest();
importTwinOrchestration(designerReloaded, designerRoundTrip);
assert(designerReloaded.materialSlots?.find((item) => item.slotId === designerSource.slotId)?.metadata?.simulationReplenish === true, '设计器 MaterialSlot Simulation 补料配置保存/加载丢失');
assert((designerReloaded.materialSlots?.find((item) => item.slotId === designerSource.slotId)?.metadata?.entityGroups as string[])?.join(',') === 'A,B', '设计器双面物料源分组保存/加载丢失');
assert(designerReloaded.behaviors?.[0]?.actions[0]?.actionId === designerAttach.actionId && designerReloaded.behaviors?.[0]?.interlockIds?.[0] === designerInterlock.interlockId, '设计器 Behavior/Interlock 保存/加载丢失');
assert(designerReloaded.behaviors?.[0]?.selectionWeight === 3, '设计器 Behavior 调度权重保存/加载丢失');
assert(designerReloaded.poses?.[0]?.targets?.[0]?.value === 1.25 && designerReloaded.actuators?.[0]?.speed === 1.5, '设计器 Pose/Actuator 保存/加载丢失');
removeWorkPointDefinition(designerReloaded, designerWorkPoint.workPointId);
assert(!designerReloaded.poses?.[0]?.workPointId, '删除 WorkPoint 后 Pose 引用未清理');
removeMaterialSlotDefinition(designerReloaded, designerSource.slotId);
assert(!designerReloaded.behaviors?.[0]?.actions.some((action) => action.sourceSlotId === designerSource.slotId), '删除 MaterialSlot 后动作引用未清理');

// 同一机器人多来源放丝必须支持确定性权重调度；3:1 在 8 个循环中稳定得到 6:2，不允许随机导致回归不可复现。
{
	const weightedManifest = createBlankTwinSceneManifest();
	weightedManifest.runtime.dataMode = 'simulation';
	weightedManifest.objects = [{ objectId: 'weighted-actor', name: 'WeightedActor', kind: 'component', component: { resourceKey: 'test', componentType: 'custom', generator: 'test', generatorVersion: 1, properties: {} }, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] as any;
	weightedManifest.behaviors = [
		{ behaviorId: 'weighted-west', name: 'West', actorObjectId: 'weighted-actor', selectionWeight: 3, actions: [{ actionId: 'wait-west', kind: 'wait', waitSeconds: 0 }], enabled: true, loop: true },
		{ behaviorId: 'weighted-east', name: 'East', actorObjectId: 'weighted-actor', selectionWeight: 1, actions: [{ actionId: 'wait-east', kind: 'wait', waitSeconds: 0 }], enabled: true, loop: true },
	];
	const weightedRoot = new THREE.Group();
	const weightedRuntime = new BehaviorRuntime(weightedManifest, new THREE.Scene(), (objectId) => objectId === 'weighted-actor' ? weightedRoot : undefined);
	try {
		weightedRuntime.setRunning(true);
		const completed: string[] = [];
		let previousCycles = 0;
		for (let index = 0; index < 100 && completed.length < 8; index += 1) {
			const before = weightedRuntime.getSnapshot().channels[0];
			weightedRuntime.updateFixed(0.01);
			const after = weightedRuntime.getSnapshot().channels[0];
			if (after.cycleCount > previousCycles) { completed.push(before.behaviorId || ''); previousCycles = after.cycleCount; }
		}
		assert(completed.filter((item) => item === 'weighted-west').length === 6 && completed.filter((item) => item === 'weighted-east').length === 2, 'Behavior 3:1 权重没有稳定得到 6:2：' + completed.join(','));
	} finally { weightedRuntime.dispose(); }
}

// Behavior 级联锁必须在执行任何动作前阻塞，并在 Binding 恢复后继续原动作。
{
	const interlockManifest = createBlankTwinSceneManifest();
	interlockManifest.runtime.dataMode = 'simulation';
	interlockManifest.objects = [{ objectId: 'interlock-actor', name: 'InterlockActor', kind: 'component', component: { resourceKey: 'test', componentType: 'custom', generator: 'test', generatorVersion: 1, properties: {} }, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] as any;
	interlockManifest.bindings = [{ bindingId: 'binding-safe', objectId: 'interlock-actor', source: { kind: 'simulation', key: 'safe' }, target: { kind: 'customProperty', property: 'safe' }, transform: { kind: 'direct' }, staleAfterMs: 5000 }];
	interlockManifest.interlocks = [{ interlockId: 'guard-safe', name: '安全门允许', mode: 'all', conditions: [{ source: 'binding-safe', operator: 'truthy' }] }];
	interlockManifest.behaviors = [{ behaviorId: 'guarded-flow', name: '联锁流程', actorObjectId: 'interlock-actor', interlockIds: ['guard-safe'], actions: [{ actionId: 'guarded-wait', kind: 'wait', waitSeconds: 0.1, timeoutSeconds: 1 }], enabled: true, loop: false }];
	const interlockRoot = new THREE.Group();
	const interlockRuntime = new BehaviorRuntime(interlockManifest, new THREE.Scene(), (objectId) => objectId === 'interlock-actor' ? interlockRoot : undefined);
	try {
		interlockRuntime.setBindingContext({ bindingValues: { 'binding-safe': false }, staleBindingIds: [] });
		interlockRuntime.setRunning(true);
		interlockRuntime.updateFixed(0.2);
		let snapshot = interlockRuntime.getSnapshot().channels[0];
		assert(snapshot.status === 'waiting-interlock' && snapshot.completedActions === 0 && snapshot.interlockWaitCount === 1, 'Behavior 级联锁没有在动作前阻塞');
		interlockRuntime.updateFixed(0.2);
		snapshot = interlockRuntime.getSnapshot().channels[0];
		assert(snapshot.interlockWaitCount === 1, '同一次联锁等待被重复计数');
		interlockRuntime.setBindingContext({ bindingValues: { 'binding-safe': true }, staleBindingIds: [] });
		interlockRuntime.updateFixed(0.1);
		snapshot = interlockRuntime.getSnapshot().channels[0];
		assert(snapshot.completedActions === 1 && snapshot.status === 'acting', '联锁恢复后没有继续并完成原动作');
		interlockRuntime.updateFixed(0.01);
		assert(interlockRuntime.getSnapshot().channels[0].status === 'completed', '单次 Behavior 完成后没有进入 completed');
	} finally { interlockRuntime.dispose(); }
}

// 旋转关节跨越 ±π 时必须保持连续角；179° -> -179° 的等价目标只能走 2°，禁止 UI/轴值跳 360°。
{
	const jointManifest = createBlankTwinSceneManifest();
	jointManifest.runtime.dataMode = 'simulation';
	jointManifest.objects = [{ objectId: 'joint-actor', name: 'JointActor', kind: 'component', component: { resourceKey: 'test', componentType: 'custom', generator: 'test', generatorVersion: 1, properties: {} }, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] as any;
	jointManifest.actuators = [{ actuatorId: 'joint-j1', name: 'J1', objectId: 'joint-actor', nodePath: 'J1', kind: 'rotary-joint', motionAxis: 'y', unit: 'degree', speed: 100, minValue: -720, maxValue: 720 }];
	jointManifest.behaviors = [{ behaviorId: 'joint-flow', name: 'JointFlow', actorObjectId: 'joint-actor', actions: [{ actionId: 'joint-move', kind: 'jointMove', actuatorId: 'joint-j1', targetValue: -179 }], enabled: true, loop: false }];
	const jointRoot = new THREE.Group(); const joint1 = new THREE.Group(); joint1.name = 'J1'; joint1.rotation.y = THREE.MathUtils.degToRad(179); jointRoot.add(joint1);
	const jointRuntime = new BehaviorRuntime(jointManifest, new THREE.Scene(), (objectId) => objectId === 'joint-actor' ? jointRoot : undefined);
	try {
		jointRuntime.setRunning(true);
		let previous = joint1.rotation.y, travel = 0, maxFrameDelta = 0;
		for (let index = 0; index < 10; index += 1) { jointRuntime.updateFixed(0.1); const delta = joint1.rotation.y - previous; travel += Math.abs(delta); maxFrameDelta = Math.max(maxFrameDelta, Math.abs(delta)); previous = joint1.rotation.y; }
		const finalDegree = THREE.MathUtils.radToDeg(joint1.rotation.y);
		assert(Math.abs(finalDegree - 181) < 0.01 && THREE.MathUtils.radToDeg(travel) < 3 && THREE.MathUtils.radToDeg(maxFrameDelta) < 3, 'J1 跨 ±π 仍发生整圈/数值跳变：final=' + finalDegree.toFixed(3) + ', travel=' + THREE.MathUtils.radToDeg(travel).toFixed(3));
	} finally { jointRuntime.dispose(); }
}

// 自动交叉口允许同优先级规则按权重稳定分流；未配置 weight 的旧场景必须保持原首规则行为。
{
	const weightedRoute = {
		routeId: 'weighted-route', name: 'WeightedRoute', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true, startPointId: 'weighted-junction',
		points: [{ pointId: 'weighted-junction', name: 'Junction', position: [0, 0, 0], kind: 'junction', decisionMode: 'simulation' }, { pointId: 'weighted-a', name: 'A', position: [1, 0, 0] }, { pointId: 'weighted-b', name: 'B', position: [0, 0, 1] }],
		edges: [{ edgeId: 'weighted-edge-a', fromPointId: 'weighted-junction', toPointId: 'weighted-a', bidirectional: false, enabled: true, priority: 0 }, { edgeId: 'weighted-edge-b', fromPointId: 'weighted-junction', toPointId: 'weighted-b', bidirectional: false, enabled: true, priority: 0 }],
		junctionDecisions: {}, routingMode: 'automatic',
		decisionRules: [{ ruleId: 'weighted-rule-a', name: 'A', junctionPointId: 'weighted-junction', edgeId: 'weighted-edge-a', source: 'payload', payloadKey: 'eligible', operator: 'truthy', weight: 3, priority: 100, enabled: true }, { ruleId: 'weighted-rule-b', name: 'B', junctionPointId: 'weighted-junction', edgeId: 'weighted-edge-b', source: 'payload', payloadKey: 'eligible', operator: 'truthy', weight: 1, priority: 100, enabled: true }],
	} as any;
	let weightedA = 0, weightedB = 0;
	for (let index = 1; index <= 400; index += 1) {
		const edgeId = resolveRoutePath(weightedRoute, { payload: { eligible: true, palletId: 'P' + index } }).edgeIds[0];
		if (edgeId === 'weighted-edge-a') weightedA += 1; else if (edgeId === 'weighted-edge-b') weightedB += 1;
	}
	const weightedRatio = weightedA / Math.max(1, weightedA + weightedB);
	assert(weightedRatio >= 0.68 && weightedRatio <= 0.82, '交叉口 3:1 权重分流偏离范围：' + weightedA + ':' + weightedB);
	const legacyWeightedRoute = structuredClone(weightedRoute); delete legacyWeightedRoute.decisionRules[0].weight; delete legacyWeightedRoute.decisionRules[1].weight;
	for (let index = 1; index <= 20; index += 1) assert(resolveRoutePath(legacyWeightedRoute, { payload: { eligible: true, palletId: 'P' + index } }).edgeIds[0] === 'weighted-edge-a', '未配置 weight 的旧路线被权重逻辑改变了默认出口');
}

const resourceId = '11111111-1111-4111-8111-111111111111';
const smallTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-small-roller-conveyor')!;
const proxyDoubleSmallTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-double-small-roller-conveyor')!;

// 浏览器 Workbench 中 Manifest/组件 properties 是 Vue Proxy；Proxy 不能直接 structuredClone。
// 双排小辊道必须在组件边界把 routeTaps 转成普通 DTO，否则带中间接驳点的底部双排辊道会整组件加载失败。
const proxyRouteTapA = new Proxy({ tapId: 'robot-out', lane: 'A', localX: 0.4, localDirection: [0, 0, -1] }, {});
const proxyRouteTapB = new Proxy({ tapId: 'robot-return', lane: 'B', localX: -0.4, terminal: false, localDirection: [0, 0, 1] }, {});
const proxyRouteTaps = new Proxy([proxyRouteTapA, proxyRouteTapB], {});
const proxyDoubleDefinition = createComponentDefinitionFromTemplate(proxyDoubleSmallTemplate.resourceKey, {
	objectId: 'verify-double-small-proxy-route-taps',
	name: 'Proxy routeTaps 双排小辊道',
	properties: {
		...proxyDoubleSmallTemplate.defaultProperties,
		length: 8,
		routeTaps: proxyRouteTaps as any,
	},
});
const proxyDoubleBuilt = defaultComponentRegistry.create(proxyDoubleDefinition);
try {
	assert(Boolean(proxyDoubleBuilt.ports.find((item) => item.portId === 'a-robot-out')), 'Proxy routeTaps 没有生成 A 排中间接驳端口');
	assert(Boolean(proxyDoubleBuilt.ports.find((item) => item.portId === 'b-robot-return')), 'Proxy routeTaps 没有生成 B 排中间接驳端口');
	const normalizedRouteTaps = proxyDoubleBuilt.root.userData.properties?.routeTaps;
	assert(Array.isArray(normalizedRouteTaps) && normalizedRouteTaps.length === 2, 'Proxy routeTaps 没有转换为普通 DTO');
	structuredClone(normalizedRouteTaps);
} finally {
	proxyDoubleBuilt.dispose();
}
const createSmallRoller = (objectId: string, x: number, transportUnitType = 'plastic-pallet'): TwinV7SceneObjectDefinition => ({
	objectId,
	name: objectId,
	kind: 'component',
	resourceId,
	transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
	component: {
		resourceKey: smallTemplate.resourceKey,
		componentType: smallTemplate.componentType,
		generator: smallTemplate.generator,
		generatorVersion: smallTemplate.generatorVersion,
		properties: { ...smallTemplate.defaultProperties, transportUnitType },
		sectionId: `section-${objectId}`,
	},
});

const createManifest = (...objects: TwinV7SceneObjectDefinition[]) => {
	const manifest = createDefaultTwinSceneManifest() as TwinSceneManifest;
	manifest.resources = [{ resourceId, name: smallTemplate.name, status: 'ready' }];
	manifest.objects = objects as any;
	manifest.connections = [];
	manifest.routes = [];
	return manifest;
};

assert(builtInComponentTemplates.length > 0, 'V7 内置组件目录不能为空');
assert(builtInComponentResourceRegistrations.length === builtInComponentTemplates.length, '组件数据库注册清单与内置组件目录数量不一致');
for (const template of builtInComponentTemplates) {
	const built = buildComponentFromTemplate(template.resourceKey, { objectId: `verify-${template.resourceKey}` });
	try {
		assert(built.root.children.length > 0, `${template.name} 没有生成 Three.js 几何对象`);
		if (template.capabilities.includes('material-flow')) assert(built.ports.length > 0, `${template.name} 没有物料端口`);
		else assert(Array.isArray(built.ports), `${template.name} ports 不是数组`);
		assert(built.ports.every((port) => port.localPosition.every(Number.isFinite) && port.localDirection.every(Number.isFinite)), `${template.name} 存在无效端口坐标`);
	} finally {
		built.dispose();
	}
	const registration = builtInComponentResourceRegistrations.find((item) => item.resourceKey === template.resourceKey);
	assert(Boolean(registration), `${template.name} 缺少数据库注册元数据`);
	assert(Array.isArray(registration?.ports), `${template.name} 的数据库注册元数据缺少 ports 数组`);
	if (template.capabilities.includes('material-flow')) assert(Boolean(registration?.ports.length), `${template.name} 的数据库注册元数据缺少物料 ports`);
	assert(Array.isArray(registration?.bindingSlots), `${template.name} 的数据库注册元数据缺少 bindingSlots 数组`);
}

const chainTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-chain-conveyor');
assert(chainTemplate?.name === '链式输送机', '组件库缺少链式输送机');
const chainBuilt = buildComponentFromTemplate('builtin-chain-conveyor', { objectId: 'verify-chain-conveyor' });
try {
	assert(chainBuilt.ports.some((item) => item.portId === 'input') && chainBuilt.ports.some((item) => item.portId === 'output'), '链式输送机缺少入口/出口');
	assert(Boolean(chainBuilt.root.getObjectByName('Chain-Sprocket-In-L')) && Boolean(chainBuilt.root.getObjectByName('Chain-Sprocket-Out-R')), '链式输送机没有生成双链条链轮');
	assert(Number(chainBuilt.root.getObjectByName('Chain-Sprocket-In-L')?.userData?.runtimeSpin?.speedDegPerSecond || 0) > 0, '链式输送机 Run 缺少链轮动画 metadata');
} finally { chainBuilt.dispose(); }

for (const [resourceKey, stationCount] of [['builtin-rgv-single', 1], ['builtin-rgv-double', 2]] as const) {
	const template = builtInComponentTemplates.find((item) => item.resourceKey === resourceKey);
	assert(Boolean(template), `${stationCount} 工位 RGV 没有进入组件库`);
	const built = buildComponentFromTemplate(resourceKey, { objectId: `verify-rgv-${stationCount}` });
	try {
		assert(Boolean(built.root.getObjectByName('RGV-Carriage')), `${stationCount} 工位 RGV 缺少轨道移动载台`);
		assert(built.ports.length === stationCount * 2, `${stationCount} 工位 RGV 物料端口数量错误`);
		assert(built.root.userData?.actuatorDefinitions?.some((item: any) => item.actuatorId === 'rgv-x' && item.kind === 'linear-axis'), `${stationCount} 工位 RGV 缺少 rgv-x 行走轴`);
	} finally { built.dispose(); }
}

const cartonRobotTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-carton-palletizing-robot');
assert(cartonRobotTemplate?.name === '码垛纸箱机器人' && cartonRobotTemplate.defaultProperties.toolType === 'carton-gripper', '组件库缺少码垛纸箱机器人或没有默认纸箱夹具');
const cartonRobotBuilt = buildComponentFromTemplate('builtin-carton-palletizing-robot', { objectId: 'verify-carton-robot' });
try {
	assert(Boolean(cartonRobotBuilt.root.getObjectByName('Robot-Carton-Gripper')), '码垛纸箱机器人没有生成纸箱夹具');
	assert(Boolean(cartonRobotBuilt.root.getObjectByName('Carton-Gripper-Jaw-L')) && Boolean(cartonRobotBuilt.root.getObjectByName('Carton-Gripper-Jaw-R')), '纸箱夹具缺少左右夹板');
	assert(cartonRobotBuilt.root.getObjectByName('Robot-Carton-Gripper')?.userData?.actuator?.kind === 'gripper', '纸箱夹具没有 gripper actuator');
} finally { cartonRobotBuilt.dispose(); }

const rollerVisualBuilt = buildComponentFromTemplate('builtin-small-roller-conveyor', { objectId: 'verify-roller-visual' });
try {
	const rollers = rollerVisualBuilt.root.getObjectByName('Rollers') as THREE.InstancedMesh;
	assert(Boolean(rollers?.isInstancedMesh && rollers.userData?.runtimeSpinInstances), '小辊道没有 Run 滚筒动画 metadata');
	assert(Boolean(rollerVisualBuilt.root.getObjectByName('RollerRotationMarkers')), '小辊道缺少可见滚筒旋转标记，Component Studio Run 肉眼无法判断是否运行');
	const before = new THREE.Matrix4(); const after = new THREE.Matrix4();
	rollers.getMatrixAt(0, before);
	advanceComponentVisualRuntime(rollerVisualBuilt.root, 0.25, 1);
	rollers.getMatrixAt(0, after);
	assert(before.elements.some((value, index) => Math.abs(value - after.elements[index]) > 0.000001), '组件设计器 Run 的可视运行时没有真正旋转滚筒实例');
	const outputStopper = rollerVisualBuilt.root.getObjectByName('OutputStopper-output') as any;
	const outputSensor = rollerVisualBuilt.root.getObjectByName('OutputSensor-output') as any;
	assert(outputStopper?.userData?.retractableStopper === true && outputStopper?.userData?.outputPortId === 'output', '普通小辊道出口没有自带升降挡停气缸');
	assert(outputSensor?.userData?.palletSensor === true && outputSensor?.userData?.outputPortId === 'output', '普通小辊道出口没有自带托盘检测传感器');
	assert(rollerVisualBuilt.root.userData?.actuatorDefinitions?.some((item: any) => item.actuatorId === 'stopper-output' && item.kind === 'linear-axis'), '小辊道出口挡停器没有标准 linear-axis actuator');
} finally { rollerVisualBuilt.dispose(); }
const smallRollerTemplateWithStopper = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-small-roller-conveyor')!;
for (const slotId of ['output-stopperUp', 'output-stopperDown', 'output-palletPresent', 'output-stopperFault']) assert(smallRollerTemplateWithStopper.bindingSlots?.some((slot) => slot.slotId === slotId), `小辊道缺少标准挡停 Telemetry Slot ${slotId}`);

const doubleStopperBuilt = buildComponentFromTemplate('builtin-double-small-roller-conveyor', { objectId: 'verify-double-stopper' });
try {
	const stoppers: THREE.Object3D[] = [];
	doubleStopperBuilt.root.traverse((node) => { if (node.userData?.retractableStopper === true) stoppers.push(node); });
	assert(stoppers.length === 2, '双排小辊道两个出口没有各自独立的升降挡停器');
	assert(new Set(stoppers.map((item) => item.userData.outputPortId)).size === 2, '双排小辊道挡停器没有按输出 Port 独立绑定');
} finally { doubleStopperBuilt.dispose(); }

const manualSnapManifest = createManifest(createSmallRoller('manual-snap-a', 0), createSmallRoller('manual-snap-b', 20));
const manualFromObject = (manualSnapManifest.objects as TwinV7SceneObjectDefinition[])[0];
const manualToObject = (manualSnapManifest.objects as TwinV7SceneObjectDefinition[])[1];
const manualFrom = resolveComponentPorts(manualFromObject).find((item) => item.portId === 'output')!;
const manualTo = resolveComponentPorts(manualToObject).find((item) => item.portId === 'input')!;
const manualConnection = applyComponentSnap(manualSnapManifest, 'manual-snap-a', { moving: manualFrom, target: manualTo, distance: manualFrom.worldPosition.distanceTo(manualTo.worldPosition), directionDot: manualFrom.worldDirection.dot(manualTo.worldDirection) });
assert(Boolean(manualConnection), '端口下拉等价的指定端口连接没有自动移动吸附');
const manualAfterFrom = resolveComponentPorts(manualFromObject).find((item) => item.portId === 'output')!;
const manualAfterTo = resolveComponentPorts(manualToObject).find((item) => item.portId === 'input')!;
assert(manualAfterFrom.worldPosition.distanceTo(manualAfterTo.worldPosition) < 0.001 && manualAfterFrom.worldDirection.dot(manualAfterTo.worldDirection) < -0.999, '指定端口连接后设备没有真正吸附到目标端口');

const createActuatorSyncComponent = (resourceKey: string, objectId: string): TwinV7SceneObjectDefinition => {
	const template = builtInComponentTemplates.find((item) => item.resourceKey === resourceKey)!;
	return {
		objectId,
		name: template.name,
		kind: 'component',
		resourceId,
		transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
		component: {
			resourceKey: template.resourceKey,
			componentType: template.componentType,
			generator: template.generator,
			generatorVersion: template.generatorVersion,
			properties: { ...template.defaultProperties },
			sectionId: `section-${objectId}`,
		},
	};
};

const actuatorSyncManifest = createDefaultTwinSceneManifest();
actuatorSyncManifest.objects = [
	createActuatorSyncComponent('builtin-industrial-robot', 'auto-robot'),
	createActuatorSyncComponent('builtin-silk-gantry', 'auto-gantry'),
	createActuatorSyncComponent('builtin-small-roller-conveyor', 'auto-conveyor'),
] as any;
actuatorSyncManifest.actuators = [];
actuatorSyncManifest.poses = [];
const actuatorSyncFirst = ensureComponentActuators(actuatorSyncManifest);
const autoRobotActuators = (actuatorSyncManifest.actuators || []).filter((item) => item.objectId === 'auto-robot');
const autoGantryActuators = (actuatorSyncManifest.actuators || []).filter((item) => item.objectId === 'auto-gantry');
assert(autoRobotActuators.length >= 7, '新拖入工业机器人没有自动生成 J1~J6 + gripper 执行机构');
assert(autoRobotActuators.every((item) => item.actuatorId.startsWith('auto-robot:')), '机器人自动执行机构 ID 没有按场景 objectId 稳定命名');
assert(autoRobotActuators.some((item) => item.nodePath === 'Robot-Axis-1') && autoRobotActuators.some((item) => item.kind === 'gripper'), '机器人自动执行机构缺少 J1 或夹具');
assert(autoGantryActuators.length >= 6, '新拖入丝锭桁架没有自动生成两套横移/升降/夹具执行机构');
assert(autoGantryActuators.some((item) => item.nodePath === 'Gantry-Silk-Rail-Carriage')
	&& autoGantryActuators.some((item) => item.nodePath === 'Gantry-Z-Slide')
	&& autoGantryActuators.some((item) => item.nodePath === 'GantryGripper-2x3')
	&& autoGantryActuators.some((item) => item.nodePath === 'Gantry-Separator-Rail-Carriage')
	&& autoGantryActuators.some((item) => item.nodePath === 'Gantry-Separator-Z-Slide')
	&& autoGantryActuators.some((item) => item.nodePath === 'Gantry-Separator-Gripper'), '丝锭桁架自动执行机构节点不完整');
assert(!(actuatorSyncManifest.actuators || []).some((item) => item.objectId === 'auto-conveyor'), '无动作小辊道错误生成了执行机构');
assert(actuatorSyncFirst.addedPoseIds.includes('auto-robot:home') && actuatorSyncFirst.addedPoseIds.includes('auto-gantry:home'), '新工业组件没有自动生成 Home Pose');
assert(actuatorSyncFirst.addedToolFrameIds.some((id) => id === 'auto-robot:robot-tcp') && actuatorSyncFirst.addedToolFrameIds.some((id) => id === 'auto-gantry:gantry-yarn-tcp'), '新拖入机器人/桁架没有自动同步 TCP/ToolFrame');
assert(actuatorSyncFirst.addedMaterialSlotIds.some((id) => id === 'auto-gantry:separator-stock-a'), '新拖入丝锭桁架没有自动同步隔板 MaterialSlot');
const actuatorCountAfterFirstSync = actuatorSyncManifest.actuators.length;
const poseCountAfterFirstSync = actuatorSyncManifest.poses.length;
const actuatorSyncSecond = ensureComponentActuators(actuatorSyncManifest);
assert(actuatorSyncSecond.addedActuatorIds.length === 0 && actuatorSyncSecond.addedPoseIds.length === 0, '执行机构自动同步不是幂等的');
assert(actuatorSyncSecond.addedMaterialSlotIds.length === 0 && actuatorSyncSecond.addedToolFrameIds.length === 0, 'MaterialSlot/TCP 自动同步不是幂等的');
assert(actuatorSyncManifest.actuators.length === actuatorCountAfterFirstSync && actuatorSyncManifest.poses.length === poseCountAfterFirstSync, '二次执行机构同步产生了重复项');
const customizedActuator = actuatorSyncManifest.actuators.find((item) => item.objectId === 'auto-robot' && item.nodePath === 'Robot-Axis-1')!;
customizedActuator.name = '用户自定义 J1';
customizedActuator.minValue = -9;
customizedActuator.maxValue = 9;
const removedActuator = actuatorSyncManifest.actuators.find((item) => item.objectId === 'auto-robot' && item.actuatorId !== customizedActuator.actuatorId)!;
actuatorSyncManifest.actuators = actuatorSyncManifest.actuators.filter((item) => item.actuatorId !== removedActuator.actuatorId);
const actuatorRepair = ensureComponentActuators(actuatorSyncManifest, ['auto-robot']);
const customizedAfterRepair = actuatorSyncManifest.actuators.find((item) => item.actuatorId === customizedActuator.actuatorId)!;
assert(customizedAfterRepair.name === '用户自定义 J1' && customizedAfterRepair.minValue === -9 && customizedAfterRepair.maxValue === 9, '自动同步覆盖了用户已修改的执行机构配置');
assert(actuatorSyncManifest.actuators.some((item) => item.actuatorId === removedActuator.actuatorId) && actuatorRepair.addedActuatorIds.includes(removedActuator.actuatorId), '自动同步没有只补回缺失执行机构');

const smallPalletTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-small-pallet');
assert(smallPalletTemplate?.name === '小托盘', '组件库缺少独立绿色小托盘资源');
const smallPalletBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-small-pallet', { objectId: 'verify-small-pallet' }));
try {
	assert(smallPalletBuilt.root.userData?.transportUnitType === 'plastic-pallet', '绿色小托盘必须继续使用 plastic-pallet 兼容物流类型');
	assert(smallPalletBuilt.root.userData?.transportUnitVariant === 'small-pallet', '绿色小托盘缺少 small-pallet 物理载具标记');
	const supportSeatNode = smallPalletBuilt.root.getObjectByName('SmallPallet-SupportSeat');
	const locatingPostNode = smallPalletBuilt.root.getObjectByName('SmallPallet-LocatingPost');
	assert(Boolean(smallPalletBuilt.root.getObjectByName('SmallPallet-Base')) && Boolean(supportSeatNode) && Boolean(locatingPostNode), '绿色小托盘没有形成圆形底盘 + 大承托中心座 + 小定位柱两级结构');
	const smallSupportY = Number(smallPalletBuilt.root.userData.smallPalletSupportSurfaceY);
	const smallBaseRingY = Number(smallPalletBuilt.root.userData.smallPalletBaseRingSurfaceY);
	const smallCakeCenterY = Number(smallPalletBuilt.root.userData.smallPalletCakeCenterY);
	const supportSeat = smallPalletBuilt.root.userData.smallPalletSupportSeat as { diameter?: number; height?: number; topY?: number } | undefined;
	const locatingPost = smallPalletBuilt.root.userData.smallPalletLocatingPost as { diameter?: number; boreDiameter?: number; clearance?: number } | undefined;
	assert(smallSupportY > 0.65 && smallSupportY > smallBaseRingY + 0.4, '绿色小托盘丝锭仍被压在底部环面，没有保持 V6 上方放置高度');
	assert(Math.abs(smallCakeCenterY - (smallSupportY + Number(smallPalletBuilt.root.userData.silkCakeAxialDepth) / 2)) < 0.001, '绿色小托盘 SilkCakeAnchor 高度与丝锭轴向厚度不一致');
	assert(Math.abs(Number(supportSeat?.topY) - smallSupportY) < 0.001 && Math.abs(Number(supportSeat?.height) + Number(smallPalletBuilt.root.userData.properties?.baseHeight) - smallSupportY) < 0.001, '丝锭承托面没有直接取大承托中心座顶面');
	assert(Number(supportSeat?.diameter) > Number(locatingPost?.boreDiameter), '大承托中心座直径没有大于丝锭中孔，无法真正承托底面');
	assert(Number(locatingPost?.diameter) < Number(locatingPost?.boreDiameter) && Number(locatingPost?.clearance) > 0, '小定位柱没有按丝锭中孔留配合间隙');
	assert(!smallPalletBuilt.root.getObjectByName('Deck_1'), '绿色小托盘错误退化成蓝色塑料母托盘');
} finally { smallPalletBuilt.dispose(); }
const motherPalletTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-plastic-pallet');
assert(motherPalletTemplate?.name === '塑料母托盘', '蓝色 builtin-plastic-pallet 必须显示为塑料母托盘');
const motherPalletBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-plastic-pallet', { objectId: 'verify-mother-pallet' }));
try {
	assert(Boolean(motherPalletBuilt.root.getObjectByName('Deck_1')) && Boolean(motherPalletBuilt.root.getObjectByName('Runner_1')), '塑料母托盘必须保持蓝色 Deck/Runner 结构');
} finally { motherPalletBuilt.dispose(); }
const cartonTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-carton');
assert(cartonTemplate?.name === '纸箱' && cartonTemplate.componentType === 'carton', '组件设计库缺少独立纸箱运输单元');
const cartonBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-carton', { objectId: 'verify-carton' }));
try {
	assert(cartonBuilt.root.userData?.transportUnitType === 'carton', '纸箱组件 transportUnitType 必须是 carton');
	assert(Boolean(cartonBuilt.root.getObjectByName('Carton-Body')), '纸箱组件缺少实体箱体');
} finally { cartonBuilt.dispose(); }
const standardSmallTransportProperty = smallTemplate.propertySchema.find((property) => property.key === 'transportUnitType');
const standardSmallTransportValues = new Set((standardSmallTransportProperty?.options || []).map((option) => option.value));
assert(standardSmallTransportValues.size === 1 && standardSmallTransportValues.has('plastic-pallet'), '标准小辊道必须只允许小托盘，不能再提供纸箱');
const largeConveyorTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-large-roller-conveyor')!;
const largeTransportProperty = largeConveyorTemplate.propertySchema.find((property) => property.key === 'transportUnitType');
const largeTransportValues = new Set((largeTransportProperty?.options || []).map((option) => option.value));
assert(largeTransportValues.has('wooden-pallet') && largeTransportValues.has('carton'), '大辊道必须允许木托盘和纸箱');
assert(!largeTransportValues.has('plastic-pallet'), '大辊道不能把小托盘作为标准运输对象');

// V7 PLC 槽位数组运行时必须复用真实运输单元组件，不能再把小辊道托盘画成橙色方盒/纸箱。
const routeSlotScene = new THREE.Scene();
const routeSlotManifest = createDefaultTwinSceneManifest();
const routeSlotOwnerId = routeSlotManifest.objects[0]?.objectId || 'route-slot-owner';
const routeSlotSmallRoute = {
	routeId: 'verify-v7-small-slot-route', name: 'V7 小辊道槽位测试', type: 'conveyor' as const, curveKind: 'line' as const,
	defaultSpeed: 1, loop: false, orientToPath: true, routingMode: 'manual' as const, junctionDecisions: {}, decisionRules: [],
	startPointId: 'slot-small-p0',
	points: [
		{ pointId: 'slot-small-p0', name: '入口', position: [0, 0.9, 0] as [number, number, number], kind: 'buffer' as const },
		{ pointId: 'slot-small-p1', name: '出口', position: [4, 0.9, 0] as [number, number, number], kind: 'buffer' as const },
	],
	edges: [{ edgeId: 'slot-small-e0', fromPointId: 'slot-small-p0', toPointId: 'slot-small-p1', bidirectional: false, enabled: true, capacity: 4, conveyorSizeClass: 'small' as const, transportUnitType: 'plastic-pallet' as const }],
};
const routeSlotCartonRoute = {
	routeId: 'verify-v7-carton-slot-route', name: 'V7 大辊道纸箱槽位测试', type: 'conveyor' as const, curveKind: 'line' as const,
	defaultSpeed: 1, loop: false, orientToPath: true, routingMode: 'manual' as const, junctionDecisions: {}, decisionRules: [],
	startPointId: 'slot-carton-p0',
	points: [
		{ pointId: 'slot-carton-p0', name: '入口', position: [0, 0.82, 4] as [number, number, number], kind: 'buffer' as const },
		{ pointId: 'slot-carton-p1', name: '出口', position: [4, 0.82, 4] as [number, number, number], kind: 'buffer' as const },
	],
	edges: [{ edgeId: 'slot-carton-e0', fromPointId: 'slot-carton-p0', toPointId: 'slot-carton-p1', bidirectional: false, enabled: true, capacity: 2, conveyorSizeClass: 'large' as const, transportUnitType: 'carton' as const }],
};
const smallSlotBinding = {
	bindingId: 'verify-v7-small-slot-binding', objectId: routeSlotOwnerId,
	source: { kind: 'telemetry' as const, deviceId: 'verify-device', key: 'smallSlots' },
	target: { kind: 'customProperty' as const, property: 'routeSlots:verify-v7-small-slot-route' },
	transform: { kind: 'routeSlotArray' as const, routeId: 'verify-v7-small-slot-route' }, staleAfterMs: 5000,
};
const cartonSlotBinding = {
	bindingId: 'verify-v7-carton-slot-binding', objectId: routeSlotOwnerId,
	source: { kind: 'telemetry' as const, deviceId: 'verify-device', key: 'cartonSlots' },
	target: { kind: 'customProperty' as const, property: 'routeSlots:verify-v7-carton-slot-route' },
	transform: { kind: 'routeSlotArray' as const, routeId: 'verify-v7-carton-slot-route' }, staleAfterMs: 5000,
};
routeSlotManifest.routes = [routeSlotSmallRoute, routeSlotCartonRoute];
routeSlotManifest.bindings = [smallSlotBinding, cartonSlotBinding];
routeSlotManifest.runtime.dataMode = 'live';
routeSlotManifest.runtime.routePalletInitializers = [{ routeId: routeSlotSmallRoute.routeId, telemetryKey: 'smallSlots', liveBindingId: smallSlotBinding.bindingId, simulationDefaultCount: 99, emptyValue: 0 }];
const routeSlotRuntime = new RouteSlotArrayRuntime(routeSlotScene, routeSlotManifest);
try {
	routeSlotRuntime.apply(smallSlotBinding, '[12,23,0,0,0,0]', false);
	routeSlotRuntime.apply(cartonSlotBinding, [88, 0], false);
	const runtimeEntities: THREE.Object3D[] = [];
	routeSlotScene.traverse((node) => { if (node.userData?.twinEntityType === 'route-slot-pallet' && node.parent?.name === 'IoTSharp Route Slot Array Runtime') runtimeEntities.push(node); });
	const liveSmallPallets = runtimeEntities.filter((node) => node.userData?.transportUnitType === 'plastic-pallet');
	assert(liveSmallPallets.length === 2 && new Set(liveSmallPallets.map((node) => node.userData?.twinEntityId)).size === 2, 'Live [12,23,0,0,0,0] 必须只显示两个有效小托盘，且不能受 Simulation 初始化数量影响');
	const smallRuntimePallet = runtimeEntities.find((node) => node.userData?.twinEntityId === '12');
	assert(smallRuntimePallet?.userData?.transportUnitType === 'plastic-pallet', 'V7 小辊道槽位数组没有生成 plastic-pallet 小托盘');
	assert(Boolean(smallRuntimePallet?.getObjectByName('Deck_1')) && Boolean(smallRuntimePallet?.getObjectByName('Runner_1')), 'V7 小辊道槽位数组仍未复用真实小托盘 Deck/Runner 结构');
	assert(!smallRuntimePallet?.getObjectByName('Carton-Body'), 'V7 小辊道槽位数组错误生成了纸箱模型');
	assert(smallRuntimePallet?.userData?.componentResourceKey === 'builtin-plastic-pallet', 'V7 小辊道槽位数组没有使用 builtin-plastic-pallet');
	const cartonRuntimeUnit = runtimeEntities.find((node) => node.userData?.twinEntityId === '88');
	assert(cartonRuntimeUnit?.userData?.transportUnitType === 'carton' && Boolean(cartonRuntimeUnit?.getObjectByName('Carton-Body')), 'V7 大辊道 carton 槽位没有保持纸箱模型');
} finally {
	routeSlotRuntime.dispose();
}

// simulation 模式允许按每条小辊道配置默认托盘数；切 live 后必须清掉，且真实 routeSlotArray 绑定优先。
const simulationSlotManifest = createDefaultTwinSceneManifest();
simulationSlotManifest.routes = [routeSlotSmallRoute];
simulationSlotManifest.bindings = [];
simulationSlotManifest.runtime.dataMode = 'simulation';
simulationSlotManifest.runtime.routePalletInitializers = [{ routeId: routeSlotSmallRoute.routeId, telemetryKey: 'PalletSlots.verify', simulationDefaultCount: 2, emptyValue: 0 }];
const simulationSlotScene = new THREE.Scene();
const simulationSlotRuntime = new RouteSlotArrayRuntime(simulationSlotScene, simulationSlotManifest);
try {
	const simulationEntities = () => {
		const items: THREE.Object3D[] = [];
		simulationSlotScene.traverse((node) => { if (node.userData?.twinEntityType === 'route-slot-pallet' && node.parent?.name === 'IoTSharp Route Slot Array Runtime') items.push(node); });
		return items;
	};
	assert(simulationEntities().length === 2, 'simulation 路线默认托盘数没有生成 2 个小托盘');
	const liveManifest = structuredClone(simulationSlotManifest);
	liveManifest.runtime.dataMode = 'live';
	simulationSlotRuntime.setManifest(liveManifest);
	assert(simulationEntities().length === 0, '切换 live 后仍残留 simulation 默认托盘');
	const simulationWithRealBinding = structuredClone(simulationSlotManifest);
	simulationWithRealBinding.bindings = [smallSlotBinding];
	simulationSlotRuntime.setManifest(simulationWithRealBinding);
	assert(simulationEntities().length === 2, 'Simulation 被真实 routeSlotArray 绑定压掉，默认托盘没有生成');
	simulationSlotRuntime.apply(smallSlotBinding, [77, 0], false);
	assert(simulationEntities().length === 2 && !simulationEntities().some((item) => item.userData?.twinEntityId === '77'), 'Simulation 错误接收了 Live routeSlotArray 数据');
	const liveWithRealBinding = structuredClone(simulationWithRealBinding);
	liveWithRealBinding.runtime.dataMode = 'live';
	simulationSlotRuntime.setManifest(liveWithRealBinding);
	assert(simulationEntities().length === 0, '切换 Live 后仍残留 Simulation 默认托盘');
	simulationSlotRuntime.apply(smallSlotBinding, [77, 0], false);
	assert(simulationEntities().length === 1 && simulationEntities()[0].userData?.twinEntityId === '77', 'Live 模式没有由真实 routeSlotArray 接管托盘实体');
} finally {
	simulationSlotRuntime.dispose();
}

// 双排小辊道必须是组件库中的独立双线机械组件，不能退化成两只外观盒子或单排辊道。
const doubleSmallTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-double-small-roller-conveyor');
assert(Boolean(doubleSmallTemplate), '组件设计库缺少双排小辊道');
assert(doubleSmallTemplate?.name === '双排小辊道', '双排小辊道组件名称错误');
assert(doubleSmallTemplate?.componentType === 'double-small-roller-conveyor', '双排小辊道没有独立 componentType');
assert(doubleSmallTemplate?.defaultProperties?.conveyorSizeClass === 'small' && doubleSmallTemplate?.defaultProperties?.transportUnitType === 'plastic-pallet', '双排小辊道必须固定为 small + plastic-pallet');
const doubleSmallBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-double-small-roller-conveyor', { objectId: 'verify-double-small-roller' }));
try {
	assert(doubleSmallBuilt.root.userData?.laneCount === 2 && doubleSmallBuilt.root.userData?.parallelLanes === true, '双排小辊道没有声明两条平行车道');
	assert(doubleSmallBuilt.root.userData?.conveyorSizeClass === 'small' && doubleSmallBuilt.root.userData?.transportUnitType === 'plastic-pallet', '双排小辊道根节点运输语义错误');
	const laneA = doubleSmallBuilt.root.getObjectByName('DoubleSmall-Lane-A') as THREE.Object3D;
	const laneB = doubleSmallBuilt.root.getObjectByName('DoubleSmall-Lane-B') as THREE.Object3D;
	assert(Boolean(laneA) && Boolean(laneB), '双排小辊道没有生成 A/B 两排独立根节点');
	const laneAWorld = laneA.getWorldPosition(new THREE.Vector3());
	const laneBWorld = laneB.getWorldPosition(new THREE.Vector3());
	assert(Math.abs(Math.abs(laneBWorld.z - laneAWorld.z) - 1.9) < 0.001, '双排小辊道默认两排中心距不是 1.9m');
	for (const laneId of ['A', 'B']) {
		assert(Boolean(doubleSmallBuilt.root.getObjectByName(`DoubleSmall-Lane-${laneId}-Rollers`)), `双排小辊道 ${laneId} 排缺少真实辊筒`);
		assert(Boolean(doubleSmallBuilt.root.getObjectByName(`DoubleSmall-Lane-${laneId}-Frame_Left`)) && Boolean(doubleSmallBuilt.root.getObjectByName(`DoubleSmall-Lane-${laneId}-Frame_Right`)), `双排小辊道 ${laneId} 排缺少双边梁`);
		assert(Boolean(doubleSmallBuilt.root.getObjectByName(`DoubleSmall-Lane-${laneId}-Supports`)), `双排小辊道 ${laneId} 排缺少支腿`);
		assert(Boolean(doubleSmallBuilt.root.getObjectByName(`DoubleSmall-Lane-${laneId}-DriveMotor`)), `双排小辊道 ${laneId} 排缺少独立驱动电机`);
	}
	assert(!doubleSmallBuilt.root.getObjectByName('Rollers'), '双排小辊道退化成了未分车道的单排 Rollers');
	assert(doubleSmallBuilt.ports.length === 4, '双排小辊道必须提供 A/B 两排共 4 个物流端口');
	const portMap = new Map(doubleSmallBuilt.ports.map((port) => [port.portId, port]));
	for (const [id, expectedX, expectedZ, expectedDirection] of [
		['a-input', -4, -0.95, -1], ['a-output', 4, -0.95, 1],
		['b-input', -4, 0.95, -1], ['b-output', 4, 0.95, 1],
	] as const) {
		const port = portMap.get(id);
		assert(Boolean(port), `双排小辊道缺少端口 ${id}`);
		assert(Math.abs((port?.localPosition[0] || 0) - expectedX) < 0.001 && Math.abs((port?.localPosition[1] || 0) - 0.9) < 0.001 && Math.abs((port?.localPosition[2] || 0) - expectedZ) < 0.001, `双排小辊道端口 ${id} 坐标错误`);
		assert(port?.localDirection[0] === expectedDirection && port?.localDirection[1] === 0 && port?.localDirection[2] === 0, `双排小辊道端口 ${id} 朝向错误`);
	}
} finally { doubleSmallBuilt.dispose(); }

// 真实完整丝饼场景必须直接支持 Workbench 运输单元吸附，不能只在构造测试路线中成立。
const realSilkSnapManifest = createSilkCakeLineTwinSceneManifest() as TwinSceneManifest;
migrateSilkLineInfrastructureToV7(realSilkSnapManifest);
const realSilkObjects = realSilkSnapManifest.objects as TwinV7SceneObjectDefinition[];
const realSmallConveyor = realSilkObjects.find((item) => item.objectId === 'v7-silk-edge-loading');
assert(Boolean(realSmallConveyor), '真实丝饼场景迁移后缺少 v7-silk-edge-loading 小辊道');
const realSmallPallet: TwinV7SceneObjectDefinition = {
	objectId: 'verify-real-silk-small-pallet', name: '真实场景小托盘', kind: 'component', resourceId,
	transform: { position: [realSmallConveyor!.transform.position[0], 0, realSmallConveyor!.transform.position[2] + 0.65], rotation: [0, 0, 0], scale: [1, 1, 1] },
	component: {
		resourceKey: smallPalletTemplate!.resourceKey, componentType: smallPalletTemplate!.componentType,
		generator: smallPalletTemplate!.generator, generatorVersion: smallPalletTemplate!.generatorVersion,
		properties: { ...smallPalletTemplate!.defaultProperties, routeSnapDistance: 1.6 },
	},
};
realSilkObjects.push(realSmallPallet);
const realSmallSnap = snapSceneComponent(realSilkSnapManifest, realSmallPallet.objectId);
assert(realSmallSnap?.kind === 'transport-route', '真实完整丝饼场景中的小托盘没有吸附到 Route');
assert(realSmallPallet.component?.routeId === 'silk-cake-line-main', '真实完整丝饼场景小托盘没有挂到 silk-cake-line-main');
assert(realSmallPallet.component?.routeEdgeId === 'silk-edge-loading', '真实完整丝饼场景小托盘没有挂到视觉所在的小辊道 Edge');
assert(Math.abs(realSmallPallet.transform.position[2] - realSmallConveyor!.transform.position[2]) < 0.001, '真实场景小托盘吸附后没有落到 V7 小辊道中心线');

const realLargeConveyor = realSilkObjects.find((item) => item.objectId === 'v7-silk-wood-edge-stack');
assert(Boolean(realLargeConveyor), '真实丝饼场景迁移后缺少 v7-silk-wood-edge-stack 大辊道');
const woodenTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-wooden-pallet')!;
assert(Number(woodenTemplate.defaultProperties?.length) === PACKAGING_WOOD_PALLET_LENGTH && Number(woodenTemplate.defaultProperties?.width) === PACKAGING_WOOD_PALLET_WIDTH, `包装线木托组件库默认尺寸必须是 ${PACKAGING_WOOD_PALLET_LENGTH}m × ${PACKAGING_WOOD_PALLET_WIDTH}m`);
const verifyWoodTemplateBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-wooden-pallet', { objectId: 'verify-packaging-wood-size' }));
try {
	const verifyWoodSize = new THREE.Box3().setFromObject(verifyWoodTemplateBuilt.root).getSize(new THREE.Vector3());
	assert(Math.abs(verifyWoodSize.x - PACKAGING_WOOD_PALLET_LENGTH) < 0.001 && Math.abs(verifyWoodSize.z - PACKAGING_WOOD_PALLET_WIDTH) < 0.001, '运行时木托组件几何仍被 PalletComponent 尺寸上限截断');
} finally { verifyWoodTemplateBuilt.dispose(); }
const realWoodPallet: TwinV7SceneObjectDefinition = {
	objectId: 'verify-real-silk-wood-pallet', name: '真实场景木托盘', kind: 'component', resourceId,
	transform: { position: [realLargeConveyor!.transform.position[0], 0, realLargeConveyor!.transform.position[2] + 0.85], rotation: [0, 0, 0], scale: [1, 1, 1] },
	component: { resourceKey: woodenTemplate.resourceKey, componentType: woodenTemplate.componentType, generator: woodenTemplate.generator, generatorVersion: woodenTemplate.generatorVersion, properties: { ...woodenTemplate.defaultProperties, routeSnapDistance: 1.6 } },
};
realSilkObjects.push(realWoodPallet);
const realWoodSnap = snapSceneComponent(realSilkSnapManifest, realWoodPallet.objectId);
assert(realWoodSnap?.kind === 'transport-route', '真实完整丝饼场景中的木托盘没有吸附到大辊道 Route');
assert(realWoodPallet.component?.routeId === 'silk-wood-packaging-route' && realWoodPallet.component?.routeEdgeId === 'silk-wood-edge-stack', '真实完整丝饼场景木托盘没有挂到对应大辊道 Edge');

if (REFERENCE_PACKAGING_LAYOUT_VERSION >= 11) {
	const referenceLineV11 = createReferencePackagingLineTwinSceneManifest();
	const referenceActuatorIdsBeforeSync = (referenceLineV11.actuators || []).map((item) => item.actuatorId).sort();
	const referencePoseIdsBeforeSync = (referenceLineV11.poses || []).map((item) => item.poseId).sort();
	const referenceActuatorSync = ensureComponentActuators(referenceLineV11);
	const referenceActuatorIdsAfterSync = new Set((referenceLineV11.actuators || []).map((item) => item.actuatorId));
	const referencePoseIdsAfterSync = new Set((referenceLineV11.poses || []).map((item) => item.poseId));
	assert(referenceActuatorIdsBeforeSync.every((id) => referenceActuatorIdsAfterSync.has(id)), 'V12 自动同步破坏了已有显式执行机构 ID');
	assert(referencePoseIdsBeforeSync.every((id) => referencePoseIdsAfterSync.has(id)), 'V12 自动同步破坏了已有显式 Pose ID');
	const explicitIndustrialObjectIds = new Set(['reference-loading-robot', 'reference-stacking-gantry']);
	const duplicateExplicitActuators = referenceActuatorSync.addedActuatorIds
		.map((id) => (referenceLineV11.actuators || []).find((item) => item.actuatorId === id))
		.filter((item) => item && explicitIndustrialObjectIds.has(item.objectId));
	const duplicateExplicitPoses = referenceActuatorSync.addedPoseIds
		.map((id) => (referenceLineV11.poses || []).find((item) => item.poseId === id))
		.filter((item) => item && explicitIndustrialObjectIds.has(item.objectId));
	assert(duplicateExplicitActuators.length === 0, `V12 自动同步重复生成了已有工业对象执行机构：${duplicateExplicitActuators.map((item) => item!.actuatorId).join(',')}`);
	assert(duplicateExplicitPoses.length === 0, `V12 自动同步重复生成了已有工业对象 Pose：${duplicateExplicitPoses.map((item) => item!.poseId).join(',')}`);
	assert(referenceActuatorSync.addedActuatorIds.some((id) => id.startsWith('reference-center-robot:')), 'V12 未配置动作的中心机器人没有被自动补齐执行机构');
	assert(referenceLineV11.name === `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`, '参考图当前 Manifest 名称没有同步布局版本');
	const referenceObjectsV11 = referenceLineV11.objects as TwinV7SceneObjectDefinition[];
	const referenceComponentsV11 = referenceObjectsV11.filter((item) => item.kind === 'component');
	for (const component of referenceComponentsV11) component.resourceId = resourceId;
	const assertReferenceLaneFlow = (
		objectId: string,
		lane: 'a' | 'b',
		expectedAxis: 'x' | 'z',
		expectedSign: -1 | 1,
		expectedCenter: number,
	) => {
		const definition = referenceComponentsV11.find((item) => item.objectId === objectId)!;
		assert(Boolean(definition), `V19 缺少双排小辊道 ${objectId}`);
		const built = defaultComponentRegistry.create({ objectId: definition.objectId, name: definition.name, resourceKey: definition.component!.resourceKey, componentType: definition.component!.componentType as any, generator: definition.component!.generator, generatorVersion: definition.component!.generatorVersion, resourceId: definition.resourceId, properties: definition.component!.properties, transform: definition.transform, sectionId: definition.component!.sectionId });
		try {
			built.root.updateMatrixWorld(true);
			const input = built.ports.find((item) => item.portId === `${lane}-input`)!;
			const output = built.ports.find((item) => item.portId === `${lane}-output`)!;
			const inputWorld = new THREE.Vector3(...input.localPosition).applyMatrix4(built.root.matrixWorld);
			const outputWorld = new THREE.Vector3(...output.localPosition).applyMatrix4(built.root.matrixWorld);
			const travel = outputWorld.clone().sub(inputWorld);
			const along = expectedAxis === 'x' ? travel.x : travel.z;
			const center = expectedAxis === 'x' ? inputWorld.z : inputWorld.x;
			assert(along * expectedSign > 0.5, `${definition.name} ${lane.toUpperCase()} 排流向与最终标注图不一致`);
			assert(Math.abs(center - expectedCenter) < 0.001, `${definition.name} ${lane.toUpperCase()} 排中心线偏离最终标注图：actual=${center.toFixed(3)}, expected=${expectedCenter.toFixed(3)}`);
		} finally { built.dispose(); }
	};
	// V9 布局基线：桁架下两排都向机器人，中部上排向左/下排向套袋，机器人下两排都向外检。
	assertReferenceLaneFlow('reference-double-small-upper-left', 'a', 'z', 1, -12.7);
	assertReferenceLaneFlow('reference-double-small-upper-left', 'b', 'z', 1, -10.8);
	assertReferenceLaneFlow('reference-double-small-middle', 'a', 'x', -1, 1.1);
	assertReferenceLaneFlow('reference-double-small-middle', 'b', 'x', 1, 3);
	assertReferenceLaneFlow('reference-double-small-bottom', 'a', 'x', 1, 12.8);
	assertReferenceLaneFlow('reference-double-small-bottom', 'b', 'x', 1, 14.7);
	assert(!referenceComponentsV11.some((item) => item.component?.sectionId === 'ref-return-edge-outer-top'), '桁架下双排回流仍叠加旧单排辊道');
	assert(referenceLineV11.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, '参考图 V11 Manifest 缺少当前布局版本标记');
	assert(referenceLineV11.routes.length > 0 && referenceLineV11.routes.every((item) => item.routeId.startsWith('component-route-')), '参考图 V11 仍在持久化旧手工 Route，而不是组件自动 Route');
	assert(!referenceLineV11.routes.some((item) => item.routeId.startsWith('reference-') || item.routeId === 'reference-bottom-lane-b'), '参考图 V11 仍残留旧 reference-* 手工路线');
	assert((referenceLineV11.connections?.length || 0) > 0, '参考图 V11 没有持久化组件 Port Connection');
	assert((referenceLineV11.connections || []).some((item) => item.metadata?.topologyBridge === true), '参考图当前版本没有 topologyBridge，跨设备物流网络会重新碎片化');
	const referenceSmallRoutes = referenceLineV11.routes.filter((route) => route.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'small' && edge.transportUnitType === 'plastic-pallet'));
	assert(referenceSmallRoutes.some((route) => route.edges.length >= 10), '参考图小托盘 Route 仍全部碎片化，没有形成可连续运行的主工艺网络');
	const referenceSmallProcessRouteV19 = referenceLineV11.routes.find((route) => route.routeId === referenceLineV11.runtime.primarySmallPalletRouteId)!;
	assert(Boolean(referenceSmallProcessRouteV19), 'V9 主小托盘运行路线不存在');
	assert(!referenceSmallProcessRouteV19.points.some((point) => point.componentObjectId?.startsWith('reference-ring-quarter-')), 'V9 primarySmallPalletRouteId 错误指向中央马蹄缓存');
	const v9LoadingEntries = referenceSmallProcessRouteV19.points.filter((point) => point.process?.simulationEntry === true && point.componentObjectId === 'reference-loading-robot');
	assert(v9LoadingEntries.length === 2, `V9 机器人下方必须有 A/B 两个 Simulation Entry，实际 ${v9LoadingEntries.length}`);
	const v9EntryA = v9LoadingEntries.find((point) => point.process?.physicalLane === 'A')!;
	const v9EntryB = v9LoadingEntries.find((point) => point.process?.physicalLane === 'B')!;
	assert(Boolean(v9EntryA && v9EntryB), 'V9 机器人下方缺少 A/B 物理车道入口');
	assert(Math.abs(v9EntryA.position[2] - 12.8) < 0.001 && Math.abs(v9EntryB.position[2] - 14.7) < 0.001, `V9 托盘入口没有落在底部双排中心线：A=${v9EntryA.position[2]} B=${v9EntryB.position[2]}`);
	assert(v9EntryA.process?.batchLayout?.columns === 6 && v9EntryB.process?.batchLayout?.columns === 6 && Math.abs(Number(v9EntryA.process?.batchLayout?.columnSpacingMeters || 0) - 1.55) < 0.001, 'V9 机器人下方 12 托盘没有保持 A/B 各 1×6 排列');
	const robotCrossForwardRuleV19 = referenceSmallProcessRouteV19.decisionRules.find((rule) => rule.ruleId === 'reference-bottom-lane-b-forward')!;
	const robotCrossAcrossRuleV19 = referenceSmallProcessRouteV19.decisionRules.find((rule) => rule.ruleId === 'reference-bottom-lane-a-return-cross')!;
	assert(robotCrossForwardRuleV19.source === 'payload' && robotCrossAcrossRuleV19.source === 'payload'
		&& robotCrossForwardRuleV19.operator === 'truthy' && robotCrossAcrossRuleV19.operator === 'truthy'
		&& Number(robotCrossForwardRuleV19.weight) > 0 && Number(robotCrossAcrossRuleV19.weight) > 0,
		'V19 机器人下直角交叉口 Simulation 没有改成纯 weight 分流规则');
	const robotCrossForwardEdgeV19 = referenceSmallProcessRouteV19.edges.find((edge) => edge.edgeId === robotCrossForwardRuleV19.edgeId)!;
	const robotCrossAcrossEdgeV19 = referenceSmallProcessRouteV19.edges.find((edge) => edge.edgeId === robotCrossAcrossRuleV19.edgeId)!;
	for (const [label, edge] of [['B直行', robotCrossForwardEdgeV19], ['A横移', robotCrossAcrossEdgeV19]] as const) {
		assert(Boolean(edge.releasePermitBindingId && edge.readyBindingId && edge.blockedBindingId && edge.fullBindingId), `${label} 出边没有完整 ReleasePermit/Ready/Blocked/Full 互锁`);
		for (const bindingId of [edge.releasePermitBindingId, edge.readyBindingId, edge.blockedBindingId, edge.fullBindingId]) {
			assert(referenceLineV11.bindings.some((binding) => binding.bindingId === bindingId && binding.transform.kind === 'routeEvent'), `${label} 互锁 ${bindingId} 没有 routeEvent Binding`);
		}
	}
	const robotCrossJunctionV19 = referenceSmallProcessRouteV19.points.find((point) => point.pointId === robotCrossForwardRuleV19.junctionPointId)!;
	assert(robotCrossJunctionV19.decisionMode === 'simulation', 'V19 交叉口没有保留 Simulation 权重模式');
	const robotCrossRouteV19 = structuredClone(referenceSmallProcessRouteV19);
	robotCrossRouteV19.startPointId = robotCrossJunctionV19.pointId;
	const simulationCrossV19 = resolveRoutePath(robotCrossRouteV19, { dataMode: 'simulation', payload: { palletId: 'SIM-WEIGHT-01' }, bindingValues: {}, staleBindingIds: [] });
	assert([robotCrossForwardEdgeV19.edgeId, robotCrossAcrossEdgeV19.edgeId].includes(simulationCrossV19.edgeIds[0]), 'Simulation 因缺少 PLC 互锁错误停在机器人下交叉口');
	const balancedRobotCrossSelectionsV19 = Array.from({ length: 12 }, (_, weightSequence) => resolveRoutePath(robotCrossRouteV19, {
		dataMode: 'simulation', payload: { palletId: `SIM-WEIGHT-${weightSequence + 1}`, weightSequence }, bindingValues: {}, staleBindingIds: [],
	}).edgeIds[0]);
	assert(balancedRobotCrossSelectionsV19.filter((edgeId) => edgeId === robotCrossForwardEdgeV19.edgeId).length === 6
		&& balancedRobotCrossSelectionsV19.filter((edgeId) => edgeId === robotCrossAcrossEdgeV19.edgeId).length === 6,
		`V19 机器人下交叉口 1:1 权重没有稳定形成 6:6：${JSON.stringify(balancedRobotCrossSelectionsV19)}`);
	const liveBOnlyValuesV19: Record<string, unknown> = {
		[robotCrossForwardEdgeV19.releasePermitBindingId!]: true,
		[robotCrossForwardEdgeV19.readyBindingId!]: true,
		[robotCrossForwardEdgeV19.blockedBindingId!]: false,
		[robotCrossForwardEdgeV19.fullBindingId!]: false,
		[robotCrossAcrossEdgeV19.releasePermitBindingId!]: false,
		[robotCrossAcrossEdgeV19.readyBindingId!]: true,
		[robotCrossAcrossEdgeV19.blockedBindingId!]: false,
		[robotCrossAcrossEdgeV19.fullBindingId!]: false,
	};
	const liveBOnlyV19 = resolveRoutePath(robotCrossRouteV19, { dataMode: 'live', payload: { palletId: 'LIVE-01' }, bindingValues: liveBOnlyValuesV19, staleBindingIds: [] });
	assert(liveBOnlyV19.edgeIds[0] === robotCrossForwardEdgeV19.edgeId, 'Live 仍受 Simulation weight 影响，没有按 B 侧互锁许可放行');
	const liveNeitherValuesV19 = { ...liveBOnlyValuesV19, [robotCrossForwardEdgeV19.releasePermitBindingId!]: false };
	const liveNeitherV19 = resolveRoutePath(robotCrossRouteV19, { dataMode: 'live', payload: { palletId: 'LIVE-WAIT' }, bindingValues: liveNeitherValuesV19, staleBindingIds: [] });
	assert(liveNeitherV19.edgeIds.length === 0 && liveNeitherV19.unresolvedJunctionPointId === robotCrossJunctionV19.pointId, 'Live 两侧都不允许时没有保持交叉口等待');
	const liveBlockedValuesV19 = { ...liveBOnlyValuesV19, [robotCrossForwardEdgeV19.blockedBindingId!]: true };
	const liveBlockedV19 = resolveRoutePath(robotCrossRouteV19, { dataMode: 'live', payload: { palletId: 'LIVE-BLOCKED' }, bindingValues: liveBlockedValuesV19, staleBindingIds: [] });
	assert(liveBlockedV19.edgeIds.length === 0 && liveBlockedV19.unresolvedJunctionPointId === robotCrossJunctionV19.pointId, 'Live Blocked=true 时仍错误放行');
	const referenceV12WorkPointIds = new Set((referenceLineV11.workPoints || []).map((item) => item.workPointId));
	for (const workPointId of [
		'reference-v12-turntable-west-pick',
		'reference-v12-turntable-east-pick',
		'reference-v12-loading-robot-home',
		'reference-v12-loading-robot-place',
		'reference-v12-gantry-yarn-source',
		'reference-v12-gantry-pallet-stack',
		'reference-v12-gantry-separator-buffer',
		'reference-v14-gantry-separator-stack',
		'reference-v12-gantry-yarn-safe',
		'reference-v12-gantry-separator-safe',
	]) assert(referenceV12WorkPointIds.has(workPointId), `参考图 V12 缺少语义工作点 ${workPointId}`);
	for (const workPoint of referenceLineV11.workPoints || []) {
		assert(referenceObjectsV11.some((item) => item.objectId === workPoint.objectId), `参考图 V12 工作点 ${workPoint.workPointId} 引用了不存在的组件 ${workPoint.objectId}`);
		assert(workPoint.localPosition.every(Number.isFinite), `参考图 V12 工作点 ${workPoint.workPointId} 不是合法局部坐标`);
	}
	const referenceV12ActuatorIds = new Set((referenceLineV11.actuators || []).map((item) => item.actuatorId));
	for (const actuatorId of ['reference-robot-j1', 'reference-robot-j6', 'reference-robot-gripper', 'reference-gantry-yarn-z', 'reference-gantry-yarn-y', 'reference-gantry-yarn-gripper', 'reference-gantry-separator-z', 'reference-gantry-separator-y', 'reference-gantry-separator-gripper']) {
		assert(referenceV12ActuatorIds.has(actuatorId), `参考图 V12 缺少执行机构 ${actuatorId}`);
	}
	for (const actuator of referenceLineV11.actuators || []) {
		assert(referenceObjectsV11.some((item) => item.objectId === actuator.objectId), `执行机构 ${actuator.actuatorId} 引用了不存在对象 ${actuator.objectId}`);
		assert(Boolean(actuator.nodePath) && Boolean(actuator.kind) && Boolean(actuator.unit), `执行机构 ${actuator.actuatorId} 定义不完整`);
	}
	const referenceV12PoseIds = new Set((referenceLineV11.poses || []).map((item) => item.poseId));
	for (const poseId of ['reference-robot-home', 'reference-robot-pick-west', 'reference-robot-pick-east', 'reference-robot-place-small-pallet', 'reference-gantry-yarn-safe', 'reference-gantry-yarn-pick', 'reference-gantry-yarn-stack', 'reference-gantry-separator-safe', 'reference-gantry-separator-pick', 'reference-gantry-separator-stack']) {
		assert(referenceV12PoseIds.has(poseId), `参考图 V12 缺少 Pose ${poseId}`);
	}
	for (const pose of referenceLineV11.poses || []) {
		assert(pose.targets.length > 0 && pose.targets.every((item) => referenceV12ActuatorIds.has(item.actuatorId)), `Pose ${pose.poseId} 存在无效执行机构目标`);
	}
	const referenceV12Behaviors = new Map((referenceLineV11.behaviors || []).map((item) => [item.behaviorId, item]));
	for (const behaviorId of ['reference-v12-robot-pick-west', 'reference-v12-robot-pick-east', 'reference-v12-gantry-yarn-stack', 'reference-v12-gantry-separator-stack']) {
		assert(referenceV12Behaviors.has(behaviorId), `参考图 V12 缺少动作编排 ${behaviorId}`);
	}
	for (const behaviorId of ['reference-v12-robot-pick-west', 'reference-v12-robot-pick-east']) {
		const behavior = referenceV12Behaviors.get(behaviorId)!;
		assert(behavior.actorObjectId === 'reference-loading-robot', `${behaviorId} 没有绑定底部上料机器人`);
		assert(behavior.actions.some((item) => item.kind === 'movePose' && Boolean(item.poseId)), `${behaviorId} 仍未使用声明式 Pose`);
		assert(behavior.actions.some((item) => item.kind === 'gripClose' && item.actuatorId === 'reference-robot-gripper'), `${behaviorId} 没有声明式夹具闭合动作`);
		assert(behavior.actions.some((item) => item.kind === 'attach' && item.workPointId?.includes('turntable')), `${behaviorId} 没有语义旋转台抓取 Attach 动作`);
		assert(behavior.actions.some((item) => item.kind === 'place' && item.workPointId === 'reference-v12-loading-robot-place' && item.targetSlotId === 'reference-robot-small-pallet-target' && Array.isArray(item.approachOffset)), `${behaviorId} 没有 TCP 到位后再放料的语义 Place 动作`);
		const safeTransferIndex = behavior.actions.findIndex((item) => item.kind === 'moveTo'
			&& item.workPointId === 'reference-v12-loading-robot-place'
			&& Array.isArray(item.approachOffset)
			&& Number(item.approachOffset?.[1] || 0) >= 1.5);
		const placeIndex = behavior.actions.findIndex((item) => item.kind === 'place' && item.workPointId === 'reference-v12-loading-robot-place');
		assert(safeTransferIndex >= 0 && placeIndex > safeTransferIndex, `${behaviorId} 缺少设计器配置的安全过渡 moveTo，或安全过渡没有位于 Place 之前`);
		assert(behavior.actions.some((item) => item.kind === 'gripOpen' && item.actuatorId === 'reference-robot-gripper'), `${behaviorId} 没有声明式夹具打开动作`);
		assert(behavior.actions.every((item) => !item.workPointId || referenceV12WorkPointIds.has(item.workPointId)), `${behaviorId} 引用了不存在的工作点`);
	}
	for (const behaviorId of ['reference-v12-robot-pick-west', 'reference-v12-robot-pick-east']) {
		const behavior = referenceV12Behaviors.get(behaviorId)!;
		assert(!behavior.actions.some((item) => item.kind === 'pick'), `${behaviorId} 仍依赖旧 pick 复合动作；抓取必须由 Pose/夹具/Attach 普通步骤组成`);
	}
	for (const behaviorId of ['reference-v12-gantry-yarn-stack', 'reference-v12-gantry-separator-stack']) {
		const behavior = referenceV12Behaviors.get(behaviorId)!;
		assert(!behavior.actions.some((item) => item.kind === 'moveTo' || item.kind === 'pick' || item.kind === 'place'), `${behaviorId} 仍依赖旧 moveTo/pick/place 运动，不满足 V12 声明式工业动作要求`);
	}
	const yarnBehaviorV12 = referenceV12Behaviors.get('reference-v12-gantry-yarn-stack')!;
	assert(yarnBehaviorV12.actions.some((item) => item.kind === 'attach' && item.workPointId === 'reference-v12-gantry-yarn-source'), '丝锭夹具没有在语义取料点 Attach');
	assert(yarnBehaviorV12.actions.some((item) => item.kind === 'detach' && item.workPointId === 'reference-v12-gantry-pallet-stack'), '丝锭夹具没有在木托码垛点 Detach');
	const separatorBehaviorV12 = referenceV12Behaviors.get('reference-v12-gantry-separator-stack')!;
	assert(separatorBehaviorV12.actorObjectId === 'reference-stacking-gantry', '隔板动作没有绑定 V12 码垛桁架');
	assert(separatorBehaviorV12.actions.some((item) => item.kind === 'wait' && item.waitForInterlockId === 'reference-v12-gantry-pallet-zone-exclusive'), '隔板夹具进入木托区前没有等待共享区互锁');
	assert(separatorBehaviorV12.actions.some((item) => item.kind === 'attach' && item.workPointId === 'reference-v12-gantry-separator-buffer'), '隔板夹具没有在缓存取料点 Attach');
	assert(separatorBehaviorV12.actions.some((item) => item.kind === 'attach' && item.sourceSlotId === 'reference-gantry-separator-source-slot' && item.toolFrameId === 'reference-gantry-separator-tcp'), 'V14 隔板夹具没有从真实 MaterialSlot/TCP 抓取');
	assert(separatorBehaviorV12.actions.some((item) => item.kind === 'detach' && item.workPointId === 'reference-v14-gantry-separator-stack' && item.targetSlotId === 'reference-gantry-separator-stack-slot'), 'V14 隔板夹具没有放到木托隔板 MaterialSlot');
	const gantryInterlockV12 = (referenceLineV11.interlocks || []).find((item) => item.interlockId === 'reference-v12-gantry-pallet-zone-exclusive');
	assert(Boolean(gantryInterlockV12), '参考图 V12 缺少桁架木托共享区互锁');
	assert((gantryInterlockV12?.conditions.length || 0) >= 2, '桁架木托共享区互锁条件不完整');
	const palletInitializersV12 = referenceLineV11.runtime.routePalletInitializers || [];
	const primarySmallRouteIdV15 = referenceLineV11.runtime.primarySmallPalletRouteId;
	const primaryWoodenRouteIdV18 = referenceLineV11.runtime.primaryWoodenPalletRouteId;
	assert(Boolean(primarySmallRouteIdV15), '参考图 V15 没有记录主小托盘工艺闭环');
	assert(Boolean(primaryWoodenRouteIdV18), '参考图 V18 没有记录主木托后包装路线');
	assert(palletInitializersV12.length === 2
		&& new Set(palletInitializersV12.map((item) => item.routeId)).size === 2
		&& palletInitializersV12.some((item) => item.routeId === primarySmallRouteIdV15)
		&& palletInitializersV12.some((item) => item.routeId === primaryWoodenRouteIdV18), '参考图 V18 RouteSlot 初始化必须且只能包含主小托盘闭环和主木托后包装路线');
	const smallPalletInitializerV18 = palletInitializersV12.find((item) => item.routeId === primarySmallRouteIdV15)!;
	const woodenPalletInitializerV18 = palletInitializersV12.find((item) => item.routeId === primaryWoodenRouteIdV18)!;
	assert(smallPalletInitializerV18.simulationDefaultCount >= 12, '参考图 V18 主工艺闭环仿真默认小托盘少于 12 个');
	assert(smallPalletInitializerV18.telemetryKey === '托盘数组', '参考图 V19 主小托盘路线没有使用托盘数组 Telemetry 语义键');
	assert(woodenPalletInitializerV18.simulationDefaultCount === 0 && woodenPalletInitializerV18.simulationAutoFeed === true && woodenPalletInitializerV18.simulationAutoFeedMaxActive === 1 && woodenPalletInitializerV18.telemetryKey === `PalletSlots.${primaryWoodenRouteIdV18}`, '参考图 V18 必须 0 木托初始化，并在 Simulation 启动后按需自动进 1 块木托');
	const stackStationDefinitionV18 = referenceComponentsV11.find((item) => item.objectId === 'reference-stacking-pallet')!;
	assert(stackStationDefinitionV18.component?.properties?.semanticOnly === true && Math.abs(stackStationDefinitionV18.transform.rotation[1] - Math.PI / 2) < 0.001, '参考图 V18 固定码垛对象仍显示木托实体或没有旋转 90°');
	const semanticStackBuilt = defaultComponentRegistry.create({ objectId: stackStationDefinitionV18.objectId, name: stackStationDefinitionV18.name, resourceKey: stackStationDefinitionV18.component!.resourceKey, componentType: stackStationDefinitionV18.component!.componentType as any, generator: stackStationDefinitionV18.component!.generator, generatorVersion: stackStationDefinitionV18.component!.generatorVersion, properties: stackStationDefinitionV18.component!.properties, transform: stackStationDefinitionV18.transform, sectionId: stackStationDefinitionV18.component!.sectionId });
	try {
		assert(!semanticStackBuilt.root.getObjectByName('Deck_1') && Boolean(semanticStackBuilt.root.getObjectByName('StackAnchor')), '码垛语义工位仍画出固定木托或丢失 StackAnchor');
	} finally { semanticStackBuilt.dispose(); }
	const primarySmallRouteV15 = referenceLineV11.routes.find((route) => route.routeId === primarySmallRouteIdV15)!;
	assert(Boolean(primarySmallRouteV15) && primarySmallRouteV15.loop === true, '参考图 V15 主小托盘路线不是闭环');
	for (const routeCode of ['A', 'B'] as const) {
		const routeForDebug = structuredClone(primarySmallRouteV15);
		routeForDebug.startPointId = routeForDebug.points.find((point) => point.process?.simulationEntry === true && point.process?.physicalLane === routeCode)?.pointId;
		const resolved = resolveRoutePath(routeForDebug, { dataMode: 'simulation', payload: { routeCode, physicalLane: routeCode, palletId: 'debug', weightSequence: routeCode === 'A' ? 0 : 1 }, bindingValues: {}, edgeOccupancy: {}, staleBindingIds: [] });
		assert(resolved.closed === true, `参考图 V15 ${routeCode} 分支没有回到机器人形成闭环`);
		const processTypes = resolved.points.filter((point) => point.kind === 'processStation' && point.process).map((point) => point.process!.type);
		const robotIndex = processTypes.indexOf('robot-loading');
		const inspectionIndex = processTypes.indexOf('external-inspection');
		const bagIndex = processTypes.indexOf('bagging');
		const gantryIndex = processTypes.indexOf('gantry-stacking');
		assert(robotIndex >= 0 && inspectionIndex > robotIndex && bagIndex > inspectionIndex && gantryIndex > bagIndex, `参考图 V15 ${routeCode} 分支工艺顺序不是 机器人→外检→套袋→桁架`);
	}
	const v15PalletScene = new THREE.Scene();
	const v15PalletRuntime = new RouteSlotArrayRuntime(v15PalletScene, referenceLineV11);
	try {
		const before = v15PalletRuntime.getSimulationSnapshot();
		const beforeSmall = before.filter((item) => item.routeId === primarySmallRouteIdV15);
		const beforeWood = before.filter((item) => item.routeId === primaryWoodenRouteIdV18);
		assert(beforeSmall.length >= 6 && new Set(beforeSmall.map((item) => item.palletId)).size === beforeSmall.length, '参考图 V18 没有创建至少 6 个稳定 ID 的仿真小托盘');
		assert(beforeWood.length === 0, '参考图 V18 构造/初始化阶段不允许提前出现木托');
		assert(beforeSmall.some((item) => item.routeCode === 'A') && beforeSmall.some((item) => item.routeCode === 'B'), '参考图 V18 仿真小托盘没有交替分配 A/B 套袋分支');
		const initialProgresses = [...beforeSmall].map((item) => item.progress).sort((left, right) => left - right);
		assert(initialProgresses.every((progress) => progress < 0.01), '参考图 V18 默认小托盘没有在逻辑上统一初始化到机器人批次工位');
		v15PalletRuntime.setRunning(true);
		const startedWood = v15PalletRuntime.getSimulationSnapshot().filter((item) => item.routeId === primaryWoodenRouteIdV18);
		assert(startedWood.length === 1 && startedWood[0].progress < 0.01, '参考图 V18 点击模拟运行后没有按需从大辊道入口送入第 1 块空木托');
		let rotatedWoodRoot: THREE.Object3D | undefined;
		v15PalletScene.traverse((node) => { if (node.userData?.transportUnitType === 'wooden-pallet' && node.userData?.twinEntityId) rotatedWoodRoot ||= node; });
		assert(Math.abs(Number(rotatedWoodRoot?.userData?.routeYawOffsetRadians) - Math.PI / 2) < 0.001, '运行时木托没有相对路线方向旋转 90°');
		for (let tick = 0; tick < 240; tick += 1) v15PalletRuntime.tick(1 / 30);
		const after = v15PalletRuntime.getSimulationSnapshot();
		const afterSmall = after.filter((item) => item.routeId === primarySmallRouteIdV15);
		assert(afterSmall.map((item) => item.palletId).join('|') === beforeSmall.map((item) => item.palletId).join('|'), '参考图 V18 小托盘运行后稳定 ID 发生变化');
		const moved = afterSmall.filter((item, index) => new THREE.Vector3(...item.position).distanceTo(new THREE.Vector3(...beforeSmall[index].position)) > 0.05);
		assert(moved.length >= 4, `参考图 V15 多托盘运行失败，8 秒内只有 ${moved.length} 个托盘发生有效位移`);
	} finally {
		v15PalletRuntime.dispose();
	}

	// V12 声明式动作必须真正驱动现有组件节点，而不是只停留在 Manifest 配置。
	const v15IntegratedScene = new THREE.Scene();
	const v15IntegratedRoots = new Map<string, THREE.Group>();
	const v15IntegratedBuilt: Array<{ root: THREE.Group; dispose: () => void }> = [];
	for (const item of referenceComponentsV11) {
		const built = defaultComponentRegistry.create({
			objectId: item.objectId,
			name: item.name,
			resourceKey: item.component!.resourceKey,
			componentType: item.component!.componentType as any,
			generator: item.component!.generator,
			generatorVersion: item.component!.generatorVersion,
			properties: item.component!.properties,
			transform: item.transform,
			sectionId: item.component!.sectionId,
		});
		v15IntegratedScene.add(built.root);
		v15IntegratedRoots.set(item.objectId, built.root);
		v15IntegratedBuilt.push(built);
	}
	const v15IntegratedSlots = new RouteSlotArrayRuntime(v15IntegratedScene, referenceLineV11, undefined, (objectId) => v15IntegratedRoots.get(objectId));
	const v15IntegratedBehavior = new BehaviorRuntime(referenceLineV11, v15IntegratedScene, (objectId) => v15IntegratedRoots.get(objectId));
	try {
		const loadingRoot = v15IntegratedRoots.get('reference-loading-robot')!;
		const gantryRoot = v15IntegratedRoots.get('reference-stacking-gantry')!;
		const stackRoot = v15IntegratedRoots.get('reference-stacking-pallet')!;
		const robotAxis1 = loadingRoot.getObjectByName('Robot-Axis-1')!;
		const robotStartYaw = robotAxis1.rotation.y;
		let robotPreviousYaw = robotStartYaw, robotFirstPlaceJ1Travel = 0, robotFirstPlaceMaxFrameDelta = 0;
		let sawLoadingBatch = false;
		let sawLoadingBatchSeparated = false;
		let sawRobotMotion = false;
		let sawTwelvePalletsWithOneCake = false;
		let sawGantryBatch = false;
		let sawGantryMotion = false;
		let sawFirstStackLayer = false;
		v15IntegratedSlots.setRunning(true);
		v15IntegratedBehavior.setRunning(true);
		for (let tick = 0; tick < 36000; tick += 1) {
			v15IntegratedSlots.tick(1 / 60);
			v15IntegratedBehavior.updateFixed(1 / 60);
			if (!sawTwelvePalletsWithOneCake) {
				const frameDelta = Math.abs(robotAxis1.rotation.y - robotPreviousYaw);
				robotFirstPlaceJ1Travel += frameDelta;
				robotFirstPlaceMaxFrameDelta = Math.max(robotFirstPlaceMaxFrameDelta, frameDelta);
			}
			robotPreviousYaw = robotAxis1.rotation.y;
			const loadingIds = Array.isArray(loadingRoot.userData.stationPalletIds) ? loadingRoot.userData.stationPalletIds : [];

			const gantryIds = Array.isArray(gantryRoot.userData.stationPalletIds) ? gantryRoot.userData.stationPalletIds : [];
			if (loadingIds.length === 12) sawLoadingBatch = true;
			if (Math.abs(robotAxis1.rotation.y - robotStartYaw) > 0.02) sawRobotMotion = true;
			if (gantryIds.length === 6) sawGantryBatch = true;
			const yarnChannel = v15IntegratedBehavior.getSnapshot().channels.find((item) => item.actorNodePath === 'Gantry-Silk-Rail-Carriage');
			if (yarnChannel && (yarnChannel.completedActions > 0 || yarnChannel.status === 'moving' || yarnChannel.status === 'acting')) sawGantryMotion = true;
			const runtimePallets: THREE.Object3D[] = [];
			const runtimeWoodPallets: THREE.Object3D[] = [];
			v15IntegratedScene.traverse((node) => {
				if (node.userData?.twinEntityType !== 'route-slot-pallet' || node.parent?.name !== 'IoTSharp Route Slot Array Runtime') return;
				if (node.userData?.transportUnitType === 'plastic-pallet') runtimePallets.push(node);
				else if (node.userData?.transportUnitType === 'wooden-pallet') runtimeWoodPallets.push(node);
			});
			if (runtimePallets.length === 12 && runtimePallets.every((pallet) => {
				let count = 0;
				pallet.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') count += 1; });
				return count === 1;
			})) sawTwelvePalletsWithOneCake = true;
			if (loadingIds.length === 12 && runtimePallets.length === 12) {
				let minimumDistance = Number.POSITIVE_INFINITY;
				for (let left = 0; left < runtimePallets.length; left += 1) for (let right = left + 1; right < runtimePallets.length; right += 1) {
					minimumDistance = Math.min(minimumDistance, runtimePallets[left].position.distanceTo(runtimePallets[right].position));
				}
				if (minimumDistance > 0.5) sawLoadingBatchSeparated = true;
			}
			if (runtimeWoodPallets.some((pallet) => Number(pallet.userData?.stackedItemCount || 0) >= 6)) sawFirstStackLayer = true;
			if (sawLoadingBatch && sawLoadingBatchSeparated && sawRobotMotion && sawTwelvePalletsWithOneCake && sawGantryBatch && sawGantryMotion && sawFirstStackLayer) break;
		}
		const integratedPalletSnapshot = v15IntegratedSlots.getSimulationSnapshot();
		const integratedBehaviorSnapshot = v15IntegratedBehavior.getSnapshot();
		const integratedPalletRoots = new Map<string, THREE.Object3D>();
		v15IntegratedScene.traverse((node) => {
			if (node.userData?.twinEntityType !== 'route-slot-pallet' || node.parent?.name !== 'IoTSharp Route Slot Array Runtime') return;
			if (typeof node.userData?.twinEntityId === 'string') integratedPalletRoots.set(node.userData.twinEntityId, node);
		});
		assert(sawLoadingBatch, `V15 integrated runtime did not form loading batch: ${JSON.stringify(integratedPalletSnapshot)}`);
		assert(sawLoadingBatchSeparated, `V15 integrated runtime loading batch visually overlapped into one pallet: ${JSON.stringify(integratedPalletSnapshot)}`);
		assert(sawRobotMotion, `V15 integrated runtime robot did not move: ${JSON.stringify(integratedBehaviorSnapshot.channels.filter((item) => item.actorObjectId === 'reference-loading-robot'))}`);
		assert(THREE.MathUtils.radToDeg(robotFirstPlaceJ1Travel) < 140 && THREE.MathUtils.radToDeg(robotFirstPlaceMaxFrameDelta) < 2, 'V18 第一批放料 J1 仍存在绕圈/跳变：travel=' + THREE.MathUtils.radToDeg(robotFirstPlaceJ1Travel).toFixed(3) + '°, maxFrame=' + THREE.MathUtils.radToDeg(robotFirstPlaceMaxFrameDelta).toFixed(3) + '°');
		assert(sawTwelvePalletsWithOneCake, `V18 integrated runtime did not distribute 12 cakes one-per-pallet across 12 pallets: ${JSON.stringify(integratedPalletSnapshot)}`);
		assert(sawGantryBatch, `V15 integrated runtime did not form gantry batch: ${JSON.stringify({ gantry: { waiting: gantryRoot.userData.stationWaitingPalletIds, active: gantryRoot.userData.stationPalletIds, released: gantryRoot.userData.stationReleasedPalletIds, physical: gantryRoot.userData.stationPhysicalReleasePalletIds, phase: gantryRoot.userData.processPhase }, snapshot: integratedPalletSnapshot.map((item) => { const root = integratedPalletRoots.get(item.palletId); return { id: item.palletId, position: item.position, edge: item.currentEdgeId, state: item.state, active: item.activeProcessComponentObjectId, flags: root ? { collisionHeld: root.userData?.collisionHeld, collisionBlockerPalletId: root.userData?.collisionBlockerPalletId, collisionBlockerEdgeId: root.userData?.collisionBlockerEdgeId, collisionBlockerPosition: root.userData?.collisionBlockerPosition, collisionCandidatePosition: root.userData?.collisionCandidatePosition, collisionRequiredDistance: root.userData?.collisionRequiredDistance, mergeYieldSeconds: root.userData?.mergeYieldSeconds, stationBatchVisual: root.userData?.stationBatchVisual, stationQueueVisual: root.userData?.stationQueueVisual, stationReleaseVisual: root.userData?.stationReleaseVisual } : undefined }; }) })}`);
		assert(sawGantryMotion, `V15 integrated runtime gantry did not move: ${JSON.stringify(integratedBehaviorSnapshot.channels.filter((item) => item.actorObjectId === 'reference-stacking-gantry'))}`);
		assert(sawFirstStackLayer, `V15 integrated runtime did not stack first layer: stack=${Number(stackRoot.userData.stackedItemCount || 0)}`);
	} finally {
		v15IntegratedBehavior.dispose();
		v15IntegratedSlots.dispose();
		for (const built of v15IntegratedBuilt) built.dispose();
	}

	// V18 标准引擎多循环长跑：禁止 ProceduralPackagingLine；同一 Runtime 不 reset、不重建场景，
	// 必须连续完成 3 个不同木托：48 丝锭 + 8 隔板 -> 天盖桁架 -> 缠膜 -> 贴标 -> 成品出库。
	const v18FullManifest = structuredClone(referenceLineV11);
	for (const route of v18FullManifest.routes) {
		route.defaultSpeed = Math.max(3, Number(route.defaultSpeed) || 0);
		for (const point of route.points) if (point.process && ['wrapping', 'labeling'].includes(point.process.type)) point.process.cycleSeconds = 0.8;
	}
	assert(!v18FullManifest.objects.some((item) => item.kind === 'procedural' && ['packaging-line', 'silk-cake-line', 'silk-cake-packaging-line'].includes(item.procedural?.preset || '')), 'V18 参考线仍依赖 ProceduralPackagingLine');
	const v18SmallRoute = v18FullManifest.routes.find((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId)!;
	const v18WoodRoute = v18FullManifest.routes.find((item) => item.routeId === v18FullManifest.runtime.primaryWoodenPalletRouteId)!;
	const v18LargeConveyors = (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).filter((item) => item.objectId.startsWith('reference-conveyor-ref-large-edge-'));
	assert(v18LargeConveyors.length === 5, `V18 大辊道必须保持 5 段，实际 ${v18LargeConveyors.length}`);
	assert(v18LargeConveyors.every((item) => Math.abs(item.transform.position[0] + 19.0) < 0.001 && Math.abs(item.transform.rotation[1] - Math.PI / 2) < 0.001), 'V18 大辊道没有沿图纸 Y 轴（Three.js Z）纵向布置');
	const v18WoodXs = v18WoodRoute.points.map((item) => item.position[0]);
	const v18WoodZs = v18WoodRoute.points.map((item) => item.position[2]);
	assert(Math.max(...v18WoodXs) - Math.min(...v18WoodXs) < 0.01 && Math.max(...v18WoodZs) - Math.min(...v18WoodZs) > 50, 'V18 木托后包装路线仍错误平行 X 轴');
	const v18LoadingPoints = v18SmallRoute.points.filter((item) => item.componentObjectId === 'reference-loading-robot' && item.process);
	const v18LoadingProcesses = v18LoadingPoints.map((item) => item.process!);
	const v18SmallInitializer = v18FullManifest.runtime.routePalletInitializers?.find((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId);
	assert(v18LoadingProcesses.length === 2 && v18LoadingProcesses.every((process) => process.batchSize === 12) && v18SmallInitializer?.simulationDefaultCount === 12, 'V18 机器人上料必须由 A/B 两条真实辊道共同组成 2×6=12 托批次');
	const v18GantryPoint = v18SmallRoute.points.find((point) => point.process?.type === 'gantry-stacking');
	assert(Number(v18GantryPoint?.process?.behaviorCompletionRequirements?.yarn || 0) === 1
		&& Number(v18GantryPoint?.process?.behaviorCompletionRequirements?.separator || 0) === 1,
		'V18 一个 6 托桁架批次必须只完成 1 次丝锭层和 1 次隔板');
	assert(new Set(v18LoadingProcesses.map((process) => process.physicalLane)).size === 2 && ['A', 'B'].every((lane) => v18LoadingProcesses.some((process) => process.physicalLane === lane)), 'V18 A/B 两排上料工位没有永久 physicalLane');
	assert(v18LoadingProcesses.every((process) => process.batchLayout?.rows === 1 && process.batchLayout.columns === 6 && Math.abs(Number(process.batchLayout.columnSpacingMeters) - 1.55) < 0.001), 'V18 每条小辊道必须各自保持 1×6、1.55m 物理中心距');
	assert(v18LoadingPoints.every((point) => point.process?.simulationEntry === true
		&& Boolean(point.process.releaseEdgeId)
		&& v18SmallRoute.edges.some((edge) => edge.edgeId === point.process?.releaseEdgeId && edge.fromPointId === point.pointId)), 'V19 机器人上料工位没有通过设计器配置 Simulation 入口或物理离站 Edge');
	assert(v18SmallRoute.generatedBy !== 'component-connections' && v18SmallRoute.edges.some((item) => item.edgeId === 'ref-edge-robot-east-b'), 'V19 B 排机器人上料后仍没有自己的可编辑物理后续辊道');
	assert(v18SmallRoute.edges.some((item) => item.edgeId === 'ref-edge-bottom-b-merge'), 'V19 B 排没有按最终标注图并入外检');
	assert(v18SmallRoute.decisionRules.some((item) => item.ruleId === 'reference-bottom-lane-b-forward'
		&& item.payloadKey === 'palletId' && item.operator === 'truthy' && Number(item.weight) > 0),
		'V19 B 侧交叉口缺少 Simulation 正权重放行规则');
	const loadingRobotDefV18 = (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === 'reference-loading-robot')!;
	assert(Number(loadingRobotDefV18.component?.properties?.gripperSpan || 0) === 6.6, 'V18 2×6 夹具列间距没有与丝车 1.1m 节距对齐');
	assert(v18SmallRoute.edges.some((item) => item.edgeId === 'ref-empty-return-down')
		&& v18SmallRoute.edges.some((item) => item.edgeId === 'ref-empty-return-merge')
		&& v18SmallRoute.decisionRules.some((item) => item.ruleId === 'reference-empty-return-rule' && item.payloadKey === 'materialCount' && item.matchValue === 0),
		'V18 缺少外检后空托直回流支路或 materialCount=0 分流规则');
	const v18FullScene = new THREE.Scene();
	const v18FullRoots = new Map<string, THREE.Group>();
	const v18FullBuilt: Array<{ root: THREE.Group; dispose: () => void }> = [];
	for (const item of (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).filter((candidate) => candidate.kind === 'component' && candidate.component)) {
		const built = defaultComponentRegistry.create({ objectId: item.objectId, name: item.name, resourceKey: item.component!.resourceKey, componentType: item.component!.componentType as any, generator: item.component!.generator, generatorVersion: item.component!.generatorVersion, resourceId: item.resourceId, properties: item.component!.properties, transform: item.transform, sectionId: item.component!.sectionId });
		v18FullScene.add(built.root);
		v18FullRoots.set(item.objectId, built.root);
		v18FullBuilt.push(built);
	}
	const v18FullSlots = new RouteSlotArrayRuntime(v18FullScene, v18FullManifest, undefined, (objectId) => v18FullRoots.get(objectId));
	const v18FullBehavior = new BehaviorRuntime(v18FullManifest, v18FullScene, (objectId) => v18FullRoots.get(objectId));
	try {
		const loadingRoot = v18FullRoots.get('reference-loading-robot')!;
		const gantryRoot = v18FullRoots.get('reference-stacking-gantry')!;
		const stackStationRoot = v18FullRoots.get('reference-stacking-pallet')!;
		const topCoverRoot = v18FullRoots.get('reference-top-cover-gantry')!;
		const wrapperRoot = v18FullRoots.get('reference-wrapper')!;
		const labelRoot = v18FullRoots.get('reference-labeling')!;
		assert(Boolean(loadingRoot && gantryRoot && stackStationRoot && topCoverRoot && wrapperRoot && labelRoot), 'V18 整线组件没有全部实例化');
		const largeClearanceDefV18 = (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === 'reference-conveyor-ref-large-edge-cover')!;
		const nearestSmallDefV18 = (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === 'reference-conveyor-ref-return-edge-outer-down')!;
		const physicalXGapV18 = Math.abs(largeClearanceDefV18.transform.position[0] - nearestSmallDefV18.transform.position[0]) - Number(largeClearanceDefV18.component?.properties?.width || 2.4) / 2 - Number(nearestSmallDefV18.component?.properties?.width || 1.55) / 2;
		assert(physicalXGapV18 > 1, 'V18 大辊道仍与左侧小辊道实体重叠，X 净间距=' + physicalXGapV18.toFixed(3) + 'm');
		const robotFrameV18 = (v18FullManifest.toolFrames || []).find((item) => item.toolFrameId === 'reference-robot-tcp')!;
		const actuatorMapV18 = new Map((v18FullManifest.actuators || []).map((item) => [item.actuatorId, item]));
		const poseMapV18 = new Map((v18FullManifest.poses || []).map((item) => [item.poseId, item]));
		const slotMapV18 = new Map((v18FullManifest.materialSlots || []).map((item) => [item.slotId, item]));
		const robotGripperV18 = loadingRoot.getObjectByName('RobotGridGripper-2x6')!;
		const applyRobotPoseV18 = (poseId: string) => {
			const pose = poseMapV18.get(poseId)!;
			assert((pose.targets || []).filter((item) => String(item.actuatorId).startsWith('reference-robot-j')).length === 6, poseId + ' 没有完整示教 J1~J6');
			for (const target of pose.targets || []) {
				const actuator = actuatorMapV18.get(target.actuatorId);
				if (!actuator || actuator.kind !== 'rotary-joint') continue;
				const node = loadingRoot.getObjectByName(actuator.nodePath)!;
				const value = Number(target.value);
				if (actuator.motionAxis === 'x') node.rotation.x = value;
				else if (actuator.motionAxis === 'y') node.rotation.y = value;
				else node.rotation.z = value;
			}
			loadingRoot.updateMatrixWorld(true);
		};
		const assertRobotContactV18 = (poseId: string, slotId: string, turntableId: string, label: string) => {
			applyRobotPoseV18(poseId);
			const turntable = v18FullRoots.get(turntableId)!;
			const slot = slotMapV18.get(slotId)!;
			turntable.updateMatrixWorld(true);
			const tcpWorld = robotGripperV18.localToWorld(new THREE.Vector3(...(robotFrameV18.localPosition || [0, 0, 0])));
			const faceWorld = turntable.localToWorld(new THREE.Vector3(...slot.localPosition));
			const approach = new THREE.Vector3(...(robotFrameV18.approachDirectionLocal || [0, 1, 0])).transformDirection(robotGripperV18.matrixWorld).normalize();
			const normal = new THREE.Vector3(...(slot.contactNormalLocal || [0, 0, 1])).transformDirection(turntable.matrixWorld).normalize();
			assert(tcpWorld.distanceTo(faceWorld) < 0.025, label + '取丝 TCP 没有贴合丝锭端面：' + tcpWorld.distanceTo(faceWorld).toFixed(4) + 'm');
			assert(approach.dot(normal) < -0.995, label + '夹具没有横向正对丝锭端面');
			assert(Math.abs(approach.y) < 0.01, label + '夹具接近方向仍然是竖直方向');
		};
		assertRobotContactV18('reference-robot-pick-west', 'reference-turntable-west-silk-source', 'reference-turntable-west', 'V18 西侧');
		assertRobotContactV18('reference-robot-pick-east', 'reference-turntable-east-silk-source', 'reference-turntable-east', 'V18 东侧');
		const westRootForGridV18 = v18FullRoots.get('reference-turntable-west')!;
		westRootForGridV18.userData.activeMaterialGroup = 'A';
		const westSlotForGridV18 = slotMapV18.get('reference-turntable-west-silk-source')!;
		assert(westSlotForGridV18.metadata?.selectionOrder === 'grid-row-major', 'V18 丝车来源槽没有按行优先取料');
		const firstGridPickV18 = (v18FullBehavior as any).findMaterialEntities(westSlotForGridV18, 'silk-cake', undefined, 12, 'reference-loading-robot') as THREE.Object3D[];
		assert(firstGridPickV18.length === 12 && new Set(firstGridPickV18.map((item) => item.userData.materialGridRow)).size === 2
			&& firstGridPickV18.every((item) => [1, 2].includes(Number(item.userData.materialGridRow)))
			&& new Set(firstGridPickV18.map((item) => item.userData.materialGridColumn)).size === 6, 'V18 机器人首抓不是严格 2×6，而仍可能形成 3×4');
		for (const item of firstGridPickV18) item.userData.materialAttachedBy = 'verify-grid';
		const secondGridPickV18 = (v18FullBehavior as any).findMaterialEntities(westSlotForGridV18, 'silk-cake', undefined, 12, 'reference-loading-robot') as THREE.Object3D[];
		assert(secondGridPickV18.length === 6 && secondGridPickV18.every((item) => Number(item.userData.materialGridRow) === 3)
			&& new Set(secondGridPickV18.map((item) => item.userData.materialGridColumn)).size === 6, 'V18 机器人第二次没有只抓剩余 1×6 尾批');
		for (const item of firstGridPickV18) delete item.userData.materialAttachedBy;
		for (const definition of (v18FullManifest.objects as TwinV7SceneObjectDefinition[]).filter((item) => item.kind === 'component' && item.component?.properties?.referenceDrawingLine === true
			&& (item.component.properties.conveyorSizeClass === 'small' || ['double-small-roller-conveyor', 'turn-conveyor-90', 'diverter-conveyor', 'merger-conveyor'].includes(String(item.component.componentType || ''))))) {
			assert(Math.abs(definition.transform.position[1]) < 0.001 && Math.abs(Number(definition.component?.properties?.height || 0.9) - 0.9) < 0.001, definition.objectId + ' 小辊道根高度/辊面高度不统一');
			const root = v18FullRoots.get(definition.objectId);
			if (root) assert(new THREE.Box3().setFromObject(root).min.y <= 0.02, definition.objectId + ' 小辊道仍悬空，没有落地支撑');
		}

		const coverBridge = topCoverRoot.getObjectByName('TopCover-Gantry-Bridge')!;
		const wrapperArm = wrapperRoot.getObjectByName('Wrapper-Rotary-Arm')!;
		const labelJoint = labelRoot.getObjectByName('Labeler-Apply-Joint-1') || labelRoot.getObjectByName('Labeler-Arm-Joint-1');
		const coverStartZ = coverBridge.position.z;
		const wrapperStartY = wrapperArm.rotation.y;
		const labelStartRotation = labelJoint?.rotation.clone();
		const woodenPallets = new Map<string, THREE.Object3D>();
		const smallPallets = new Map<string, THREE.Object3D>();
		v18FullScene.traverse((node) => {
			if (node.userData?.twinEntityType === 'route-slot-pallet' && node.userData?.transportUnitType === 'wooden-pallet') woodenPallets.set(String(node.userData.twinEntityId), node);
			if (node.userData?.twinEntityType === 'route-slot-pallet' && node.userData?.transportUnitType === 'plastic-pallet') smallPallets.set(String(node.userData.twinEntityId), node);
		});
		assert(woodenPallets.size === 0, `V19 木托必须从 0 初始化并按需自动进料，启动前实际 ${woodenPallets.size}`);
		assert(smallPallets.size === 12, `V18 双排机器人上料位必须初始化 12 个小托盘，实际 ${smallPallets.size}`);
		const initialSmallSnapshotsV18 = v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId);
		const immutableLaneByPalletV18 = new Map(initialSmallSnapshotsV18.map((item) => [item.palletId, item.physicalLane]));
		assert(initialSmallSnapshotsV18.filter((item) => item.physicalLane === 'A').length === 6 && initialSmallSnapshotsV18.filter((item) => item.physicalLane === 'B').length === 6, 'V18 必须永久分配 6 个 A 排托盘和 6 个 B 排托盘');
		assert(new Set(initialSmallSnapshotsV18.filter((item) => item.physicalLane === 'A').map((item) => item.physicalLaneOrdinal)).size === 6
			&& new Set(initialSmallSnapshotsV18.filter((item) => item.physicalLane === 'B').map((item) => item.physicalLaneOrdinal)).size === 6, 'V18 A/B 每排没有 6 个独立纵向槽位');
		const palletForGeometryV18 = [...smallPallets.values()][0];
		const cakeSourceV18 = v18FullRoots.get('reference-turntable-west')!.getObjectByName('SilkCakeEntity-A-R1-C1')!;
		const placedCakeV18 = cakeSourceV18.clone(true);
		const palletAnchorV18 = palletForGeometryV18.getObjectByName('SilkCakeAnchor')!;
		palletAnchorV18.add(placedCakeV18);
		placedCakeV18.position.set(0, 0, 0);
		placedCakeV18.rotation.set(-Math.PI / 2, 0, 0);
		palletForGeometryV18.updateMatrixWorld(true);
		const cakeMeshV18 = placedCakeV18.getObjectByName('SilkCake-A-R1-C1') as THREE.Mesh;
		const shapesV18 = (cakeMeshV18.geometry as any).parameters?.shapes;
		const shapeV18 = Array.isArray(shapesV18) ? shapesV18[0] : shapesV18;
		assert(cakeMeshV18.geometry.type === 'ExtrudeGeometry' && (shapeV18?.holes?.length || 0) === 1, 'V18 丝锭没有真实中心孔，仍会穿入小托盘中心柱');
		const cakeBoundsV18 = new THREE.Box3().setFromObject(cakeMeshV18);
		const palletBaseWorldYV18 = palletForGeometryV18.getWorldPosition(new THREE.Vector3()).y;
		const supportSurfaceYV18 = Number(palletForGeometryV18.userData.smallPalletSupportSurfaceY || 0);
		assert(supportSurfaceYV18 > 0.18 && palletAnchorV18.position.y > supportSurfaceYV18, 'V18 小托盘放丝锚点没有位于支撑环上方');
		assert(Math.abs(cakeBoundsV18.min.y - (palletBaseWorldYV18 + supportSurfaceYV18)) < 0.01, 'V18 丝锭底面没有贴合小托盘最高支撑面，仍存在嵌入或悬空');
		const smallPalletPropsV18 = palletForGeometryV18.userData.properties || {};
		assert(Number(smallPalletPropsV18.supportSeatDiameter || 0) > Number(smallPalletPropsV18.silkCakeInnerHoleDiameter || 0), 'V19 大承托中心座没有跨过丝锭中孔，无法承托丝锭底面');
		assert(Number(smallPalletPropsV18.locatingPostDiameter || 0) < Number(smallPalletPropsV18.silkCakeInnerHoleDiameter || 0), 'V19 小定位柱直径没有小于丝锭中孔，仍会发生穿模');
		placedCakeV18.removeFromParent();
		const silkCountOnPallet = (pallet: THREE.Object3D | undefined) => {
			let count = 0;
			pallet?.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') count += 1; });
			return count;
		};
		const materialCounts = (pallet: THREE.Object3D) => {
			let silk = 0, separator = 0, cover = 0;
			pallet.traverse((node) => {
				if (node.userData?.materialEntity !== true) return;
				if (node.userData?.payloadType === 'silk-cake') silk += 1;
				else if (node.userData?.payloadType === 'separator') separator += 1;
				else if (node.userData?.payloadType === 'top-cover') cover += 1;
			});
			return { silk, separator, cover };
		};
		const createWoodCycleState = () => ({
			initialStackChecked: false,
			visitedCover: false,
			visitedWrapper: false,
			visitedLabel: false,
			coverMotion: false,
			wrapperMotion: false,
			labelMotion: false,
			completed: false,
		});
		const cycleState = new Map<string, ReturnType<typeof createWoodCycleState>>();
		const completedPalletIds: string[] = [];
		let loadingBatchCount = 0, gantryBatchCount = 0;
		let loadingBatchActive = false, gantryBatchActive = false;
		let sawFullTwelveLoad = false, sawPartialSixLoad = false, sawSixEmptyReturn = false;
		const observedEmptyReturnPalletIds = new Set<string>();
		let previousGantryStationIds = new Set<string>();
		let sawTwoBySixPalletLayout = false, sawStopperLowered = false, sawStopperRaisedAfterPass = false, sawStopperSensor = false;
		let sawRobotPlaceContact = false, sawActualPalletSupport = false, sawStaggeredRelease = false;
		let previousLoadingSilkCount = 0;
		const loweredStopperKeys = new Set<string>();
		let onePerPalletViolation = false, emptyReturnEnteredGantry = false, releaseOverlapViolation = false, physicalLaneViolation = false, palletOverlapViolation = false;
		const stationArrayKeys = ['stationPalletIds', 'stationWaitingPalletIds', 'stationReadyToReleasePalletIds', 'stationReleasedPalletIds'];
		v18FullSlots.setRunning(true);
		v18FullBehavior.setRunning(true);
		// 保持 6000 秒总仿真覆盖，但用 10 Hz 固定步代替旧 30 Hz/180000 次 Three.js 全场景扫描。
		// 连续 3 成品、重叠、工位动作和物料流断言不变，只降低回归本身的 CPU 开销。
		const integrationDeltaSeconds = 0.1;
		for (let tick = 0; tick < 60000; tick += 1) {
			v18FullSlots.tick(integrationDeltaSeconds);
			v18FullBehavior.updateFixed(integrationDeltaSeconds);
			for (const root of v18FullRoots.values()) advanceComponentVisualRuntime(root, integrationDeltaSeconds, 1);
			const frameWoodSnapshotsV18 = v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primaryWoodenPalletRouteId);
			for (const snapshot of frameWoodSnapshotsV18) {
				if (woodenPallets.has(snapshot.palletId)) continue;
				let pallet: THREE.Object3D | undefined;
				v18FullScene.traverse((node) => {
					if (!pallet && node.userData?.twinEntityType === 'route-slot-pallet' && String(node.userData.twinEntityId) === snapshot.palletId) pallet = node;
				});
				if (pallet) {
					woodenPallets.set(snapshot.palletId, pallet);
					cycleState.set(snapshot.palletId, createWoodCycleState());
				}
			}
			const frameSmallSnapshotsV18 = v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId);
			for (const snapshot of frameSmallSnapshotsV18) {
				if (immutableLaneByPalletV18.get(snapshot.palletId) !== snapshot.physicalLane) physicalLaneViolation = true;
				const pallet = smallPallets.get(snapshot.palletId)!;
				if (snapshot.currentEdgeId?.includes('reference-double-small-bottom-lane-a') && Math.abs(pallet.position.z - 13.3) > 0.04) physicalLaneViolation = true;
				if (snapshot.currentEdgeId?.includes('reference-double-small-bottom-lane-b') && Math.abs(pallet.position.z - 15.2) > 0.04) physicalLaneViolation = true;
			}
			const visibleSmallPalletsV18 = [...smallPallets.values()].filter((pallet) => pallet.visible);
			const snapshotByPalletIdV18 = new Map(frameSmallSnapshotsV18.map((item) => [item.palletId, item]));
			const stationMembershipV18 = (palletId: string) => {
				const collect = (root: THREE.Object3D, label: string) => stationArrayKeys
					.filter((key) => Array.isArray(root.userData?.[key]) && root.userData[key].map(String).includes(palletId))
					.map((key) => `${label}.${key}`);
				return [...collect(loadingRoot, 'loading'), ...collect(gantryRoot, 'gantry')];
			};
			for (let left = 0; left < visibleSmallPalletsV18.length; left += 1) for (let right = left + 1; right < visibleSmallPalletsV18.length; right += 1) {
				const leftPallet = visibleSmallPalletsV18[left], rightPallet = visibleSmallPalletsV18[right];
				const a = leftPallet.position, b = rightPallet.position;
				const centerDistance = Math.hypot(a.x - b.x, a.z - b.z);
				if (centerDistance < 1.50 - 0.001) palletOverlapViolation = true;
				assert(centerDistance >= 1.50 - 0.001, 'V18 小托盘发生物理重叠：distance=' + centerDistance.toFixed(3) + 'm, left=' + JSON.stringify({
					id: String(leftPallet.userData.twinEntityId), position: [a.x, a.z], snapshot: snapshotByPalletIdV18.get(String(leftPallet.userData.twinEntityId)), membership: stationMembershipV18(String(leftPallet.userData.twinEntityId)), flags: { collisionHeld: leftPallet.userData.collisionHeld, stationBatchVisual: leftPallet.userData.stationBatchVisual, stationQueueVisual: leftPallet.userData.stationQueueVisual, stationReleaseVisual: leftPallet.userData.stationReleaseVisual, routeHandoffComplete: leftPallet.userData.routeHandoffComplete },
				}) + ', right=' + JSON.stringify({
					id: String(rightPallet.userData.twinEntityId), position: [b.x, b.z], snapshot: snapshotByPalletIdV18.get(String(rightPallet.userData.twinEntityId)), membership: stationMembershipV18(String(rightPallet.userData.twinEntityId)), flags: { collisionHeld: rightPallet.userData.collisionHeld, stationBatchVisual: rightPallet.userData.stationBatchVisual, stationQueueVisual: rightPallet.userData.stationQueueVisual, stationReleaseVisual: rightPallet.userData.stationReleaseVisual, routeHandoffComplete: rightPallet.userData.routeHandoffComplete },
				}));
			}
			const loadingIds = Array.isArray(loadingRoot.userData.stationPalletIds) ? loadingRoot.userData.stationPalletIds : [];
			if (loadingIds.length === 12) {
				const loadingPallets = loadingIds.map((id: string) => smallPallets.get(String(id))!).filter(Boolean);
				const byRow = new Map<number, THREE.Object3D[]>();
				for (const pallet of loadingPallets) { const key = Math.round(pallet.position.z * 100) / 100; byRow.set(key, [...(byRow.get(key) || []), pallet]); }
				if (byRow.size === 2 && [...byRow.values()].every((row) => row.length === 6 && new Set(row.map((pallet) => Math.round(pallet.position.x * 100) / 100)).size === 6)) sawTwoBySixPalletLayout = true;

				const loadingSilkCount = loadingPallets.reduce((total, pallet) => total + silkCountOnPallet(pallet), 0);
				if (loadingSilkCount > previousLoadingSilkCount) {
					const anchors = loadingPallets.map((pallet) => pallet.getObjectByName('SilkCakeAnchor')).filter(Boolean) as THREE.Object3D[];
					const targetCenter = anchors.reduce((total, anchor) => total.add(anchor.getWorldPosition(new THREE.Vector3())), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, anchors.length));
					loadingRoot.updateMatrixWorld(true);
					const tcpWorld = robotGripperV18.localToWorld(new THREE.Vector3(...(robotFrameV18.localPosition || [0, 0, 0])));
					const contactDistance = tcpWorld.distanceTo(targetCenter);
					assert(contactDistance <= 0.16, 'V18 丝锭在机器人 TCP 到位前已经瞬移到小托盘：distance=' + contactDistance.toFixed(3) + 'm');
					sawRobotPlaceContact = true;
				}
				previousLoadingSilkCount = loadingSilkCount;

				for (const pallet of loadingPallets) {
					const supportSurfaceY = Number(pallet.userData.smallPalletSupportSurfaceY);
					let silkEntity: THREE.Object3D | undefined;
					pallet.traverse((node) => { if (!silkEntity && node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') silkEntity = node; });
					if (!silkEntity || !Number.isFinite(supportSurfaceY)) continue;
					pallet.updateMatrixWorld(true);
					const supportWorldY = pallet.localToWorld(new THREE.Vector3(0, supportSurfaceY, 0)).y;
					const bounds = new THREE.Box3().setFromObject(silkEntity);
					assert(bounds.min.y >= supportWorldY - 0.004 && bounds.min.y <= supportWorldY + 0.03, 'V18 丝锭仍嵌入或悬浮在小托盘：bottom=' + bounds.min.y.toFixed(3) + ', support=' + supportWorldY.toFixed(3));
					sawActualPalletSupport = true;
				}

				const releasedIds = Array.isArray(loadingRoot.userData.stationReleasedPalletIds) ? loadingRoot.userData.stationReleasedPalletIds.map(String) : [];
				if (releasedIds.length > 0 && releasedIds.length < 12) {
					const positions = loadingPallets.map((pallet) => pallet.getWorldPosition(new THREE.Vector3()));
					const uniquePositions = new Set(positions.map((position) => Math.round(position.x * 20) + ',' + Math.round(position.z * 20)));
					if (uniquePositions.size < 12) releaseOverlapViolation = true;
					assert(uniquePositions.size === 12, 'V18 机器人放料后 12 个小托盘释放时必须始终保持 12 个独立物理位置：released=' + releasedIds.length + ', unique=' + uniquePositions.size);
					sawStaggeredRelease = true;
				}
			}
			for (const [objectId, root] of v18FullRoots) for (const definition of (Array.isArray(root.userData?.outputStoppers) ? root.userData.outputStoppers : [])) {
				const stopper = root.getObjectByName(String(definition.nodePath || ''));
				const sensor = root.getObjectByName(String(definition.sensorNodePath || ''));
				const key = objectId + ':' + String(definition.portId || '');
				if (sensor?.userData?.palletPresent === true) sawStopperSensor = true;
				if (stopper?.userData?.stopperRaised === false) { sawStopperLowered = true; loweredStopperKeys.add(key); }
				else if (loweredStopperKeys.has(key)) sawStopperRaisedAfterPass = true;
			}
			const gantryIds = Array.isArray(gantryRoot.userData.stationPalletIds) ? gantryRoot.userData.stationPalletIds : [];
			if (loadingIds.length === 12 && !loadingBatchActive) { loadingBatchCount += 1; loadingBatchActive = true; }
			if (!loadingIds.length) loadingBatchActive = false;
			if (gantryIds.length === 6 && !gantryBatchActive) { gantryBatchCount += 1; gantryBatchActive = true; }
			if (!gantryIds.length) gantryBatchActive = false;
			for (const pallet of smallPallets.values()) if (silkCountOnPallet(pallet) > 1) onePerPalletViolation = true;
			const loadCounts = loadingRoot.userData.stationCompletedGroupCounts as Record<string, number> | undefined;
			if (loadingIds.length === 12 && Number(loadCounts?.load || 0) >= 1) {
				const counts = loadingIds.map((id: string) => silkCountOnPallet(smallPallets.get(String(id))));
				if (counts.every((count) => count === 1)) sawFullTwelveLoad = true;
				if (counts.filter((count) => count === 1).length === 6 && counts.filter((count) => count === 0).length === 6) sawPartialSixLoad = true;
			}
			const smallSnapshots = v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId);
			// V19 按图纸把外检后的空托回流组件化为“一分二空托出口 + 独立回流辊道 + 后段汇流”。
			// 独立辊道单段不需要、也不一定能同时容纳 6 个 >=1.50m 间距的托盘；
			// 验收的是 6 个不同尾批空托都确实进入了这条专用支路，而不是要求它们同帧挤在同一 Edge。
			const emptyReturnSnapshots = smallSnapshots.filter((item) => item.currentEdgeId === 'ref-empty-return-down'
				|| item.currentEdgeId === 'ref-empty-return-merge');
			for (const item of emptyReturnSnapshots) {
				if (silkCountOnPallet(smallPallets.get(item.palletId)) === 0) observedEmptyReturnPalletIds.add(item.palletId);
			}
			if (observedEmptyReturnPalletIds.size >= 6) sawSixEmptyReturn = true;
			const gantryStationIds = new Set([
				...(Array.isArray(gantryRoot.userData.stationPalletIds) ? gantryRoot.userData.stationPalletIds.map(String) : []),
				...(Array.isArray(gantryRoot.userData.stationWaitingPalletIds) ? gantryRoot.userData.stationWaitingPalletIds.map(String) : []),
			]);
			// 同一个物理小托盘完成空托回流后会再次在机器人处装丝；后续作为有料托盘
			// 进入桁架属于正常下一循环。桁架 Detach 后它会在工位内再次变为 0 锭，
			// 因此只能在“新进入桁架工位”的瞬间检查入站物料，不能用工位内任意时刻的当前值。
			for (const palletId of gantryStationIds) {
				if (!previousGantryStationIds.has(palletId)
					&& observedEmptyReturnPalletIds.has(palletId)
					&& silkCountOnPallet(smallPallets.get(palletId)) === 0) emptyReturnEnteredGantry = true;
			}
			previousGantryStationIds = new Set(gantryStationIds);

			for (const snapshot of frameWoodSnapshotsV18) {
				const pallet = woodenPallets.get(snapshot.palletId)!;
				const state = cycleState.get(snapshot.palletId)!;
				if (!pallet || !state) continue;
				const active = snapshot.activeProcessComponentObjectId;
				if (active === 'reference-stacking-pallet' && !state.initialStackChecked) {
					const counts = materialCounts(pallet);
					const anchor = pallet.getObjectByName('StackAnchor');
					assert(counts.silk === 0 && counts.separator === 0 && counts.cover === 0
						&& Number(anchor?.userData.stackItemCount || 0) === 0
						&& Number(anchor?.userData.stackLayerMaterialCount || 0) === 0
						&& pallet.userData.stackComplete !== true,
					`V18 木托 ${snapshot.palletId} 继承了上一托码垛状态：${JSON.stringify(counts)}`);
					state.initialStackChecked = true;
				}
				if (active === 'reference-top-cover-gantry') {
					state.visitedCover = true;
					if (Math.abs(coverBridge.position.z - coverStartZ) > 0.05) state.coverMotion = true;
				}
				if (active === 'reference-wrapper') {
					state.visitedWrapper = true;
					if (wrapperRoot.userData.processActive === true && Math.abs(wrapperArm.rotation.y - wrapperStartY) > 0.08) state.wrapperMotion = true;
				}
				if (active === 'reference-labeling') {
					state.visitedLabel = true;
					if (labelRoot.userData.processActive === true && labelJoint && labelStartRotation
						&& Math.abs(labelJoint.rotation.x - labelStartRotation.x) + Math.abs(labelJoint.rotation.y - labelStartRotation.y) + Math.abs(labelJoint.rotation.z - labelStartRotation.z) > 0.03) state.labelMotion = true;
				}
				if (pallet.userData.routeCompleted === true && !state.completed) {
					const counts = materialCounts(pallet);
					assert(counts.silk === 48 && counts.separator === 8 && counts.cover === 1 && pallet.userData.stackComplete === true,
						`V18 成品木托 ${snapshot.palletId} 物料不完整：${JSON.stringify(counts)}, stackComplete=${String(pallet.userData.stackComplete)}`);
					assert(state.initialStackChecked && state.visitedCover && state.visitedWrapper && state.visitedLabel,
						`V18 成品木托 ${snapshot.palletId} 跳过工位：${JSON.stringify(state)}`);
					assert(state.coverMotion && state.wrapperMotion && state.labelMotion,
						`V18 成品木托 ${snapshot.palletId} 后包装设备没有真实动作：${JSON.stringify(state)}`);
					for (const root of v18FullRoots.values()) for (const key of stationArrayKeys) {
						const ids = Array.isArray(root.userData?.[key]) ? root.userData[key].map(String) : [];
						assert(!ids.includes(snapshot.palletId), `V18 成品木托 ${snapshot.palletId} 出库后仍残留在 ${root.name}.${key}`);
					}
					state.completed = true;
					completedPalletIds.push(snapshot.palletId);
				}
			}
			if (completedPalletIds.length >= 3) break;
		}
		const fullBehaviorSnapshot = v18FullBehavior.getSnapshot();
		const finalSmallSnapshots = v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primarySmallPalletRouteId);
		const finalStationMembershipV18 = (palletId: string) => {
			const collect = (root: THREE.Object3D, label: string) => stationArrayKeys
				.filter((key) => Array.isArray(root.userData?.[key]) && root.userData[key].map(String).includes(palletId))
				.map((key) => `${label}.${key}`);
			return [...collect(loadingRoot, 'loading'), ...collect(gantryRoot, 'gantry')];
		};
		const finalSmallDiagnostics = finalSmallSnapshots.map((item) => {
			const pallet = smallPallets.get(item.palletId);
			return {
				...item,
				silkCount: silkCountOnPallet(pallet),
				membership: finalStationMembershipV18(item.palletId),
				flags: pallet ? {
					collisionHeld: pallet.userData.collisionHeld,
					collisionBlockerPalletId: pallet.userData.collisionBlockerPalletId,
					collisionBlockerEdgeId: pallet.userData.collisionBlockerEdgeId,
					collisionBlockerPosition: pallet.userData.collisionBlockerPosition,
					collisionCandidatePosition: pallet.userData.collisionCandidatePosition,
					collisionRequiredDistance: pallet.userData.collisionRequiredDistance,
					mergeYieldSeconds: pallet.userData.mergeYieldSeconds,
					stationBatchVisual: pallet.userData.stationBatchVisual,
					stationQueueVisual: pallet.userData.stationQueueVisual,
					stationReleaseVisual: pallet.userData.stationReleaseVisual,
					routeHandoffCompletePointId: pallet.userData.routeHandoffCompletePointId,
				} : undefined,
			};
		});
		assert(completedPalletIds.length === 3 && new Set(completedPalletIds).size === 3,
			`V18 连续 3 成品失败：completed=${JSON.stringify(completedPalletIds)}, wood=${JSON.stringify(v18FullSlots.getSimulationSnapshot().filter((item) => item.routeId === v18FullManifest.runtime.primaryWoodenPalletRouteId))}, small=${JSON.stringify(finalSmallDiagnostics)}, loadingStation=${JSON.stringify({ active: loadingRoot.userData.stationPalletIds, waiting: loadingRoot.userData.stationWaitingPalletIds, physicalRelease: loadingRoot.userData.stationPhysicalReleasePalletIds, released: loadingRoot.userData.stationReleasedPalletIds })}, gantryStation=${JSON.stringify({ active: gantryRoot.userData.stationPalletIds, waiting: gantryRoot.userData.stationWaitingPalletIds, physicalRelease: gantryRoot.userData.stationPhysicalReleasePalletIds, released: gantryRoot.userData.stationReleasedPalletIds })}, behavior=${JSON.stringify(fullBehaviorSnapshot.channels)}`);
		assert(loadingBatchCount >= 16, `V18 3 个成品跨 18 锭/面尾批至少需要 16 次机器人批次，实际 ${loadingBatchCount}`);
		assert(gantryBatchCount >= 24, `V18 3 个成品 2×3×8 至少需要 24 次桁架 6 托批次，实际 ${gantryBatchCount}`);
		assert(sawFullTwelveLoad && sawPartialSixLoad, `V18 没有同时观察到 12 锭整批和 6 锭尾批：full=${sawFullTwelveLoad}, partial=${sawPartialSixLoad}`);
		assert(!onePerPalletViolation, 'V18 机器人上料出现单个小托盘超过 1 锭，违反一爪一丝锭/一锭一托');
		assert(sawTwoBySixPalletLayout, 'V18 机器人上料的 12 个小托盘没有保持双排 2×6，而是发生重叠/合并');
		assert(sawRobotPlaceContact, 'V18 没有观察到机器人 TCP 真正到位后才放丝，仍可能存在提前瞬移');
		assert(sawActualPalletSupport, 'V18 没有验证到真实丝锭底面贴合小托盘支撑面');
		assert(sawStaggeredRelease && !releaseOverlapViolation, 'V18 机器人放料后的 12 个小托盘没有执行错峰释放，仍可能瞬间重叠');
		assert(!physicalLaneViolation, 'V18 小托盘发生跨辊道/physicalLane 改变，违反每托固定物理辊道原则');
		assert(!palletOverlapViolation, 'V18 小托盘全流程出现实体重叠，违反托盘不可重叠底线');
		assert(sawStopperLowered && sawStopperRaisedAfterPass && sawStopperSensor, `V18 小辊道阻挡器没有随托盘通过执行升→降→升：down=${sawStopperLowered}, up=${sawStopperRaisedAfterPass}, sensor=${sawStopperSensor}`);
		assert(sawSixEmptyReturn && !emptyReturnEnteredGantry, `V18 6 个尾批空托没有从外检后直回流或误入桁架：return=${sawSixEmptyReturn}, enteredGantry=${emptyReturnEnteredGantry}`);
		assert(finalSmallSnapshots.length === 12 && finalSmallSnapshots.every((item) => item.state !== 'error'), 'V18 多循环后 12 个小托盘没有保持双排闭环运行');
		assert(Number(v18FullRoots.get('reference-turntable-west')?.userData.simulationMaterialRefillCount || 0) >= 1
			&& Number(v18FullRoots.get('reference-turntable-east')?.userData.simulationMaterialRefillCount || 0) >= 1,
			'V18 三成品没有触发声明式丝车 Simulation 补料，无法证明跨库存周期运行');
		console.log(`V${REFERENCE_PACKAGING_LAYOUT_VERSION} multi-cycle PASS: products=${completedPalletIds.join(',')}; robotBatches=${loadingBatchCount}; gantryBatches=${gantryBatchCount}; load=12+6; emptyReturn=6; refills=west:${Number(v18FullRoots.get('reference-turntable-west')?.userData.simulationMaterialRefillCount || 0)},east:${Number(v18FullRoots.get('reference-turntable-east')?.userData.simulationMaterialRefillCount || 0)},separator:${Number(v18FullRoots.get('reference-stacking-gantry')?.userData.simulationMaterialRefillCount || 0)}`);
	} finally {
		v18FullBehavior.dispose();
		v18FullSlots.dispose();
		for (const built of v18FullBuilt) built.dispose();
	}

	const behaviorSceneV12 = new THREE.Scene();
	const behaviorRootsV12 = new Map<string, THREE.Object3D>();
	const behaviorBuiltV12: Array<{ root: THREE.Group; dispose: () => void }> = [];
	for (const objectId of ['reference-loading-robot', 'reference-turntable-west', 'reference-turntable-east', 'reference-stacking-gantry', 'reference-stacking-pallet']) {
		const item = referenceComponentsV11.find((candidate) => candidate.objectId === objectId)!;
		assert(Boolean(item), `BehaviorRuntime 回归缺少 V12 对象 ${objectId}`);
		const built = defaultComponentRegistry.create({
			objectId: item.objectId,
			name: item.name,
			resourceKey: item.component!.resourceKey,
			componentType: item.component!.componentType as any,
			generator: item.component!.generator,
			generatorVersion: item.component!.generatorVersion,
			properties: item.component!.properties,
			transform: item.transform,
			sectionId: item.component!.sectionId,
		});
		behaviorSceneV12.add(built.root);
		behaviorRootsV12.set(item.objectId, built.root);
		behaviorBuiltV12.push(built);
	}
	const behaviorStationPalletIds = Array.from({ length: 12 }, (_, index) => `V18-STATION-PALLET-${index + 1}`);
	const behaviorStationPalletRoots: THREE.Group[] = [];
	const behaviorLoadingStations = referenceLineV11.routes
		.flatMap((route) => route.points)
		.filter((point) => point.componentObjectId === 'reference-loading-robot' && point.process?.type === 'robot-loading');
	const behaviorLoadingStationA = behaviorLoadingStations.find((point) => point.process?.physicalLane === 'A');
	const behaviorLoadingStationB = behaviorLoadingStations.find((point) => point.process?.physicalLane === 'B');
	assert(Boolean(behaviorLoadingStationA && behaviorLoadingStationB), 'V15 测试夹具缺少机器人 A/B 两排真实上料工位');
	for (let index = 0; index < behaviorStationPalletIds.length; index += 1) {
		const built = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-small-pallet', { objectId: `verify-v15-station-pallet-${index + 1}` }));
		built.root.userData.twinEntityId = behaviorStationPalletIds[index];
		built.root.userData.twinEntityType = 'route-slot-pallet';
		const station = index < 6 ? behaviorLoadingStationA! : behaviorLoadingStationB!;
		const layout = station.process?.batchLayout;
		const columns = Math.max(1, Math.floor(Number(layout?.columns) || 6));
		const spacing = Math.max(1.50, Number(layout?.columnSpacingMeters || 1.55));
		const column = index % 6;
		const centeredColumn = column - (columns - 1) / 2;
		const position = new THREE.Vector3(...station.position);
		if (layout?.columnAxis === 'z') position.z += centeredColumn * spacing;
		else position.x += centeredColumn * spacing;
		built.root.position.copy(position);
		behaviorSceneV12.add(built.root);
		behaviorStationPalletRoots.push(built.root);
		behaviorBuiltV12.push(built);
	}
	const robotMetadataRoot = behaviorRootsV12.get('reference-loading-robot')!;
	assert(robotMetadataRoot.getObjectByName('Robot-Axis-1')?.userData?.actuator?.kind === 'rotary-joint', '工业机器人 J1 缺少标准 rotary-joint actuator metadata');
	assert(robotMetadataRoot.getObjectByName('RobotGridGripper-2x6')?.userData?.actuator?.kind === 'gripper', '工业机器人 2×6 夹具缺少标准 gripper actuator metadata');
	assert((robotMetadataRoot.userData?.actuatorDefinitions?.length || 0) >= 7, '工业机器人根节点没有汇总 6 轴 + 夹具 actuator metadata');
	const gantryMetadataRoot = behaviorRootsV12.get('reference-stacking-gantry')!;
	assert(gantryMetadataRoot.getObjectByName('Gantry-Silk-Rail-Carriage')?.userData?.actuator?.kind === 'linear-axis', '丝锭夹具水平轴缺少标准 linear-axis metadata');
	assert(gantryMetadataRoot.getObjectByName('Gantry-Separator-Z-Slide')?.userData?.actuator?.kind === 'linear-axis', '隔板夹具升降轴缺少标准 linear-axis metadata');
	assert((gantryMetadataRoot.userData?.actuatorDefinitions?.length || 0) >= 6, '双轨桁架根节点没有汇总两套水平/升降/夹具 actuator metadata');
	assert(robotMetadataRoot.userData?.toolFrames?.some((item: any) => item.toolFrameId === 'robot-tcp' && item.nodePath === 'RobotGridGripper-2x6'), '工业机器人没有标准 TCP metadata');
	assert(gantryMetadataRoot.userData?.toolFrames?.some((item: any) => item.toolFrameId === 'gantry-yarn-tcp'), '丝锭桁架没有标准丝锭夹具 TCP metadata');
	const initialSilkEntityIds = new Set<string>();
	behaviorSceneV12.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') initialSilkEntityIds.add(String(node.userData.twinEntityId || '')); });
	assert(initialSilkEntityIds.size === 72, 'V14 两台双面丝车必须生成 72 个带稳定 ID 的真实丝锭实体');
	const initialSeparatorEntityIds = new Set<string>();
	behaviorSceneV12.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'separator') initialSeparatorEntityIds.add(String(node.userData.twinEntityId || '')); });
	assert(initialSeparatorEntityIds.size === 10, 'V14 丝锭桁架两类隔板库存没有生成 10 个稳定 ID 的真实隔板实体');
	const behaviorRuntimeV12 = new BehaviorRuntime(referenceLineV11, behaviorSceneV12, (objectId) => behaviorRootsV12.get(objectId));
	try {
		const robotAxis1 = behaviorRootsV12.get('reference-loading-robot')!.getObjectByName('Robot-Axis-1')!;
		const robotStartYaw = robotAxis1.rotation.y;
		const loadingStationRoot = behaviorRootsV12.get('reference-loading-robot')!;
		const gantryStationRoot = behaviorRootsV12.get('reference-stacking-gantry')!;
		const activateV15StationBatch = () => {
			loadingStationRoot.userData.stationPalletIds = [...behaviorStationPalletIds];
			loadingStationRoot.userData.stationBehaviorRequirements = { load: 1 };
			loadingStationRoot.userData.stationCompletedGroupCounts = {};
			loadingStationRoot.userData.stationCompletedGroups = [];
			gantryStationRoot.userData.stationPalletIds = behaviorStationPalletIds.slice(0, 6);
			gantryStationRoot.userData.stationBehaviorRequirements = { yarn: 1, separator: 1 };
			gantryStationRoot.userData.stationCompletedGroupCounts = {};
			gantryStationRoot.userData.stationCompletedGroups = [];
		};
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 60; index += 1) behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().channels.filter((item) => ['reference-loading-robot', 'reference-stacking-gantry'].includes(item.actorObjectId)).every((item) => item.status === 'waiting-station'), 'V15 没有托盘到位时机器人/桁架仍自行执行');
		assert(Math.abs(robotAxis1.rotation.y - robotStartYaw) < 0.001, 'V15 没有托盘到位时机器人 J1 仍发生运动');
		activateV15StationBatch();
		let sawBehaviorPayload = false;
		let sawRealMaterialCarrier = false;
		let sawRealSeparatorCarrier = false;
		let sawLegacySyntheticSilk = false;
		let sawLegacySyntheticSeparator = false;
		let realEntityIdsStayedStable = true;
		let sawSeparatorWaiting = false;
		let sawSeparatorReleased = false;
		let firstBatchCompleted = false;
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 12000; index += 1) {
			behaviorRuntimeV12.updateFixed(1 / 60);
			if (index % 10 === 0) {
				behaviorSceneV12.traverse((node) => {
					if (node.userData?.behaviorPayload) sawBehaviorPayload = true;
					if (node.userData?.realMaterialPayload === true && node.userData?.payloadType === 'silk-cake') {
						sawRealMaterialCarrier = true;
						for (const entityId of node.userData.payloadEntityIds || []) if (!initialSilkEntityIds.has(String(entityId))) realEntityIdsStayedStable = false;
					}
					if (node.userData?.realMaterialPayload === true && node.userData?.payloadType === 'separator') {
						sawRealSeparatorCarrier = true;
						for (const entityId of node.userData.payloadEntityIds || []) if (!initialSeparatorEntityIds.has(String(entityId))) realEntityIdsStayedStable = false;
					}
					if (node.userData?.legacySyntheticPayload === true && node.userData?.payloadType === 'silk-cake') sawLegacySyntheticSilk = true;
					if (node.userData?.legacySyntheticPayload === true && node.userData?.payloadType === 'separator') sawLegacySyntheticSeparator = true;
				});
				const separator = behaviorRuntimeV12.getSnapshot().channels.find((item) => item.actorNodePath === 'Gantry-Separator-Rail-Carriage');
				if (separator?.status === 'waiting-interlock') sawSeparatorWaiting = true;
				if (sawSeparatorWaiting && separator && separator.status !== 'waiting-interlock' && separator.completedActions >= 3) sawSeparatorReleased = true;
			}
			const loadCounts = loadingStationRoot.userData.stationCompletedGroupCounts as Record<string, number> | undefined;
			const gantryCounts = gantryStationRoot.userData.stationCompletedGroupCounts as Record<string, number> | undefined;
			if (Number(loadCounts?.load || 0) >= 1 && Number(gantryCounts?.yarn || 0) >= 1 && Number(gantryCounts?.separator || 0) >= 1) {
				firstBatchCompleted = true;
				break;
			}
		}
		assert(firstBatchCompleted, `V15 第一批 2×6 在超时前没有完成两轮 2×3 + 两次隔板：groups=${JSON.stringify(gantryStationRoot.userData.stationCompletedGroupCounts || {})}, channels=${JSON.stringify(behaviorRuntimeV12.getSnapshot().channels.filter((item) => item.actorObjectId === 'reference-stacking-gantry'))}, robot=${JSON.stringify(behaviorRuntimeV12.getSnapshot().channels.filter((item) => item.actorObjectId === 'reference-loading-robot'))}, gantry=${JSON.stringify({ stationPalletIds: gantryStationRoot.userData.stationPalletIds, completedGroups: gantryStationRoot.userData.stationCompletedGroups, silkCounts: (Array.isArray(gantryStationRoot.userData.stationPalletIds) ? gantryStationRoot.userData.stationPalletIds : []).map((id: string) => { const root = behaviorStationPalletRoots.find((item) => String(item.userData.twinEntityId) === String(id)); let silk = 0; root?.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') silk += 1; }); return { id, silk }; }) })}`);
		const behaviorSnapshot = behaviorRuntimeV12.getSnapshot();
		assert(behaviorSnapshot.active === true && behaviorSnapshot.dataMode === 'simulation', 'V12 BehaviorRuntime 没有在 simulation 模式启动');
		const robotChannel = behaviorSnapshot.channels.find((item) => item.actorObjectId === 'reference-loading-robot');
		assert(Boolean(robotChannel) && robotChannel!.completedActions >= 4, 'V12 机器人没有真正执行工作点动作');
		assert(Math.abs(robotAxis1.rotation.y - robotStartYaw) > 0.02 || robotChannel!.cycleCount > 0, 'V12 机器人 J1 没有被 BehaviorRuntime 驱动');
		const yarnChannel = behaviorSnapshot.channels.find((item) => item.actorNodePath === 'Gantry-Silk-Rail-Carriage');
		const separatorChannel = behaviorSnapshot.channels.find((item) => item.actorNodePath === 'Gantry-Separator-Rail-Carriage');
		assert(Boolean(yarnChannel) && yarnChannel!.completedActions >= 3, 'V12 丝锭夹具没有独立执行动作通道');
		assert(Boolean(separatorChannel) && separatorChannel!.interlockWaitCount > 0 && sawSeparatorWaiting, 'V12 隔板夹具没有真实等待木托共享区联锁');
		assert(sawSeparatorReleased, 'V12 丝锭夹具离开共享区后，隔板联锁没有释放');
		assert(sawBehaviorPayload, 'V12 BehaviorRuntime 没有产生抓取/放置的可视物料');
		assert(sawRealMaterialCarrier && realEntityIdsStayedStable, 'V14 机器人/桁架没有抓取同一批稳定 ID 的真实丝锭实体');
		assert(!sawLegacySyntheticSilk, 'V14 丝锭抓取仍退回 createPayload synthetic 丝锭');
		assert(sawRealSeparatorCarrier, 'V14 隔板夹具没有抓取稳定 ID 的真实隔板实体');
		assert(!sawLegacySyntheticSeparator, 'V14 隔板抓取仍退回 createPayload synthetic 隔板');
		const gantryDetail = behaviorRuntimeV12.getObjectDetail('reference-stacking-gantry') as any;
		assert(gantryDetail?.behaviorRuntime?.channels?.length === 2, '桁架运行状态没有暴露丝锭/隔板两个动作通道');

		const stackPalletRoot = behaviorRootsV12.get('reference-stacking-pallet')!;
		assert(Number(stackPalletRoot.userData.stackedItemCount || 0) === 6 && Number(stackPalletRoot.userData.stackedLayerMaterialCount || 0) === 1,
			'V18 前 6 个有料托没有形成第一层 2×3 + 1 张隔板');

		// 同一个 12 托机器人批次的后 6 托作为第二个桁架 2×3 批次。
		gantryStationRoot.userData.stationPalletIds = [];
		behaviorRuntimeV12.updateFixed(1 / 60);
		gantryStationRoot.userData.stationPalletIds = behaviorStationPalletIds.slice(6, 12);
		gantryStationRoot.userData.stationBehaviorRequirements = { yarn: 1, separator: 1 };
		gantryStationRoot.userData.stationCompletedGroupCounts = {};
		gantryStationRoot.userData.stationCompletedGroups = [];
		let secondGantryBatchCompleted = false;
		for (let tick = 0; tick < 7200; tick += 1) {
			behaviorRuntimeV12.updateFixed(1 / 60);
			const counts = gantryStationRoot.userData.stationCompletedGroupCounts as Record<string, number> | undefined;
			if (Number(counts?.yarn || 0) >= 1 && Number(counts?.separator || 0) >= 1) { secondGantryBatchCompleted = true; break; }
		}
		assert(secondGantryBatchCompleted, 'V18 后 6 个有料托没有完成第二轮 2×3 + 1 张隔板');
		assert(Number(stackPalletRoot.userData.stackedItemCount || 0) === 12 && Number(stackPalletRoot.userData.stackedLayerMaterialCount || 0) === 2,
			'V18 12 个有料托没有形成两层共 12 锭 + 2 张隔板');

		const stackAnchorV15 = stackPalletRoot.getObjectByName('StackAnchor')!;
		const stackedSilkV15: THREE.Object3D[] = [];
		const stackedSeparatorsV15: THREE.Object3D[] = [];
		stackAnchorV15.traverse((node) => {
			if (node.userData?.materialEntity !== true) return;
			if (node.userData?.payloadType === 'silk-cake') stackedSilkV15.push(node);
			if (node.userData?.payloadType === 'separator') stackedSeparatorsV15.push(node);
		});
		assert(stackedSilkV15.length === 12, `V18 两个 6 托桁架批次最终不是 12 个真实丝锭，而是 ${stackedSilkV15.length}`);
		assert(stackedSeparatorsV15.length === 2, `V18 两层最终不是 2 张真实隔板，而是 ${stackedSeparatorsV15.length}`);
		assert(new Set(stackedSilkV15.map((node) => String(node.userData.twinEntityId))).size === 12, 'V18 12 个码垛丝锭没有保持唯一稳定 twinEntityId');
		assert(stackedSilkV15.every((node) => initialSilkEntityIds.has(String(node.userData.twinEntityId))), 'V18 木托出现了不是来自原始丝车的 synthetic 丝锭');
		assert(new Set(stackedSilkV15.map((node) => String(node.userData.stackSlotId))).size === 12, 'V18 前两层 StackSlot 出现重复占位');
		assert(stackedSilkV15.every((node) => String(node.userData.runtimeOwnerEntityId || '') === String(stackPalletRoot.userData.twinEntityId || '')), 'V18 码垛后的丝锭 runtimeOwnerEntityId 没有切换为当前木托');
		assert(stackedSilkV15.every((node) => node.userData.runtimeOwnerType === 'wooden-pallet'), 'V18 码垛后的丝锭 runtimeOwnerType 不是 wooden-pallet');
		assert(new Set(stackedSilkV15.map((node) => `${node.position.x.toFixed(3)},${node.position.y.toFixed(3)},${node.position.z.toFixed(3)}`)).size === 12, 'V18 12 个丝锭实际落点没有形成 12 个唯一坐标');
		for (let layer = 1; layer <= 2; layer += 1) {
			assert(stackedSilkV15.filter((node) => Number(node.userData.stackLayer) === layer).length === 6, `V18 第 ${layer} 层不是 2×3 共 6 锭`);
			assert(stackedSeparatorsV15.filter((node) => Number(node.userData.stackLayerMaterialIndex) === layer).length === 1, `V18 第 ${layer} 层没有唯一隔板`);
		}
		assert(stackPalletRoot.userData.stackComplete !== true, 'V18 只有两层时木托不应提前进入满托状态');
		assert(behaviorStationPalletRoots.every((root) => {
			let count = 0;
			root.getObjectByName('SilkCakeAnchor')?.traverse((node) => { if (node.userData?.materialEntity === true && node.userData?.payloadType === 'silk-cake') count += 1; });
			return count === 0;
		}), 'V18 两个 6 托桁架批次完成后仍有丝锭残留在 12 个小托盘');

		const liveManifest = structuredClone(referenceLineV11);
		liveManifest.runtime.dataMode = 'live';
		behaviorRuntimeV12.setManifest(liveManifest);
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 120; index += 1) behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().active === false, 'Live 模式仍在自行生成机器人/桁架动作，破坏 PLC/Telemetry 权威');

		const signalManifest = structuredClone(referenceLineV11);
		signalManifest.runtime.dataMode = 'simulation';
		signalManifest.behaviors = [{
			behaviorId: 'verify-wait-signal', name: '等待 PLC Ready', actorObjectId: 'reference-loading-robot', enabled: true, loop: false,
			actions: [{ actionId: 'wait-ready', kind: 'waitSignal', signalBindingId: 'verify-ready-binding', signalOperator: 'truthy', timeoutSeconds: 1 }],
		}];
		behaviorRuntimeV12.setManifest(signalManifest);
		behaviorRuntimeV12.setBindingContext({ bindingValues: { 'verify-ready-binding': false }, staleBindingIds: ['verify-ready-binding'] });
		behaviorRuntimeV12.setRunning(true);
		behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().channels[0]?.status === 'waiting-signal-stale', 'waitSignal 没有区分 stale PLC/Telemetry 信号');
		behaviorRuntimeV12.setBindingContext({ bindingValues: { 'verify-ready-binding': false }, staleBindingIds: [] });
		behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().channels[0]?.status === 'waiting-signal', 'waitSignal 对未满足条件没有进入等待状态');
		behaviorRuntimeV12.setBindingContext({ bindingValues: { 'verify-ready-binding': true }, staleBindingIds: [] });
		behaviorRuntimeV12.updateFixed(1 / 60);
		behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().channels[0]?.status === 'completed', 'waitSignal 条件满足后没有完成动作');

		const timeoutManifest = structuredClone(signalManifest);
		timeoutManifest.behaviors![0].actions[0].timeoutSeconds = 0.05;
		behaviorRuntimeV12.setManifest(timeoutManifest);
		behaviorRuntimeV12.setBindingContext({ bindingValues: { 'verify-ready-binding': false }, staleBindingIds: [] });
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 10; index += 1) behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().channels[0]?.status === 'error', 'waitSignal 超时没有进入 error/fault 状态');
	} finally {
		behaviorRuntimeV12.dispose();
		for (const built of behaviorBuiltV12) built.dispose();
	}

	const smallSurfaceResourceKeys = [
		'builtin-small-roller-conveyor',
		'builtin-double-small-roller-conveyor',
		'builtin-turn-conveyor-90',
		'builtin-diverter-conveyor',
		'builtin-merger-conveyor',
		'builtin-external-inspection',
		'builtin-bagging-machine',
		'builtin-single-to-double-conveyor',
		'builtin-double-to-single-conveyor',
		'builtin-right-angle-single-to-double-conveyor',
		'builtin-right-angle-double-to-single-conveyor',
	] as const;
	for (const resourceKey of smallSurfaceResourceKeys) {
		const template = builtInComponentTemplates.find((item) => item.resourceKey === resourceKey);
		assert(Boolean(template), '组件库缺少小辊道平面校验资源 ' + resourceKey);
		const built = defaultComponentRegistry.create(createComponentDefinitionFromTemplate(resourceKey, { objectId: `verify-surface-${resourceKey}` }));
		try {
			const materialPorts = built.ports.filter((port) => port.type === 'material-input' || port.type === 'material-output' || port.type === 'material-bidirectional');
			assert(materialPorts.length > 0 && materialPorts.every((port) => Math.abs(port.localPosition[1] - 0.9) < 0.001), resourceKey + ' 的物流端口没有统一到 0.9m 辊面');
			const surfaces: Array<{ surface: number; center?: number; radius?: number }> = [];
			built.root.traverse((node: any) => {
				if (Number.isFinite(Number(node.userData?.conveyorSurfaceHeight))) surfaces.push({
					surface: Number(node.userData.conveyorSurfaceHeight),
					center: Number.isFinite(Number(node.userData?.rollerCenterY)) ? Number(node.userData.rollerCenterY) : undefined,
					radius: Number.isFinite(Number(node.userData?.rollerRadius)) ? Number(node.userData.rollerRadius) : undefined,
				});
			});
			assert(surfaces.length > 0 && surfaces.every((item) => Math.abs(item.surface - 0.9) < 0.001), resourceKey + ' 的真实输送接触面没有统一到 0.9m');
			for (const item of surfaces.filter((candidate) => candidate.center !== undefined && candidate.radius !== undefined)) {
				assert(Math.abs((item.center! + item.radius!) - item.surface) < 0.001, resourceKey + ' 仍把 height 当成滚筒中心而不是滚筒顶面');
			}
		} finally { built.dispose(); }
	}

	const splitBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-single-to-double-conveyor', { objectId: 'verify-single-to-double' }));
	try {
		const outA = splitBuilt.ports.find((item) => item.portId === 'output-a')!;
		const outB = splitBuilt.ports.find((item) => item.portId === 'output-b')!;
		assert(Math.abs(Math.abs(outA.localPosition[2] - outB.localPosition[2]) - 1.9) < 0.001, '一分二小辊道两个出口中心距没有严格匹配双排小辊道 1.9m');
		const junction = splitBuilt.internalFlows[0]?.points.find((item) => item.kind === 'diverter');
		assert(Boolean(junction) && Math.abs(junction!.localPosition[2]) < 0.001, '一分二分流中心没有位于中线 Z=0');
		const expectedAngle = THREE.MathUtils.radToDeg(Math.atan2(1.9 / 2, 2.8));
		assert(Math.abs(Number(splitBuilt.root.userData?.transitionAngleDegrees) - expectedAngle) < 0.001, '一分二角度没有由双排中心距和过渡长度自动计算');
		assert((splitBuilt.root.userData?.outputStoppers?.length || 0) === 2, '一分二两个输出 Port 没有各自挡停器');
	} finally { splitBuilt.dispose(); }

	const mergeBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-double-to-single-conveyor', { objectId: 'verify-double-to-single' }));
	try {
		const inA = mergeBuilt.ports.find((item) => item.portId === 'input-a')!;
		const inB = mergeBuilt.ports.find((item) => item.portId === 'input-b')!;
		assert(Math.abs(Math.abs(inA.localPosition[2] - inB.localPosition[2]) - 1.9) < 0.001, '二合一小辊道两个入口中心距没有严格匹配双排小辊道 1.9m');
		const mergePoint = mergeBuilt.internalFlows[0]?.points.find((item) => item.kind === 'merger');
		assert(Boolean(mergePoint) && Math.abs(mergePoint!.localPosition[2]) < 0.001 && mergeBuilt.root.userData?.mergeAtCenter === true, '二合一没有在两排正中间 Z=0 汇合');
		const output = mergeBuilt.ports.find((item) => item.portId === 'output')!;
		assert(Math.abs(output.localPosition[2]) < 0.001, '二合一单排出口没有从中间中心线输出');
		assert((mergeBuilt.root.userData?.outputStoppers?.length || 0) === 1, '二合一输出 Port 没有唯一挡停器');
	} finally { mergeBuilt.dispose(); }

	const rightAngleSplitTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-right-angle-single-to-double-conveyor');
	assert(rightAngleSplitTemplate?.name === '直角一分二小辊道', '组件库缺少直角一分二小辊道');
	const rightAngleSplit = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-right-angle-single-to-double-conveyor', { objectId: 'verify-right-angle-split' }));
	try {
		const input = rightAngleSplit.ports.find((item) => item.portId === 'input')!;
		const outputA = rightAngleSplit.ports.find((item) => item.portId === 'output-a')!;
		const outputB = rightAngleSplit.ports.find((item) => item.portId === 'output-b')!;
		assert(input.localDirection[0] === 0 && input.localDirection[2] === -1, '直角一分二上方入口方向错误');
		assert(outputA.localDirection[0] === 1 && outputA.localDirection[2] === 0 && outputB.localDirection[0] === 1 && outputB.localDirection[2] === 0, '直角一分二右侧两个出口方向错误');
		assert(Math.abs(Math.abs(outputA.localPosition[2] - outputB.localPosition[2]) - 1.9) < 0.001, '直角一分二两个右侧出口中心距没有匹配 1.9m 双排小辊道');
		assert(Math.abs(input.localPosition[0]) < 0.001 && outputA.localPosition[0] > 0 && outputB.localPosition[0] > 0, '直角一分二没有形成上进右出布局');
		const flow = rightAngleSplit.internalFlows[0];
		const diverter = flow?.points.find((item) => item.kind === 'diverter');
		assert(Boolean(diverter) && flow.edges.filter((item) => item.fromPointId === diverter!.pointId).length === 2, '直角一分二内部路线没有真实一分二节点');
		assert(Boolean(rightAngleSplit.root.getObjectByName('RightAngleSplit-Trunk')) && Boolean(rightAngleSplit.root.getObjectByName('RightAngleSplit-Output-A')) && Boolean(rightAngleSplit.root.getObjectByName('RightAngleSplit-Output-B')), '直角一分二几何没有按草图形成一根竖干线和两条右出支线');
		assert((rightAngleSplit.root.userData?.outputStoppers?.length || 0) === 2, '直角一分二两个出口没有各自挡停器');
	} finally { rightAngleSplit.dispose(); }

	const rightAngleMergeTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-right-angle-double-to-single-conveyor');
	assert(rightAngleMergeTemplate?.name === '直角二合一小辊道', '组件库缺少直角二合一小辊道');
	const rightAngleMerge = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-right-angle-double-to-single-conveyor', { objectId: 'verify-right-angle-merge' }));
	try {
		const inputA = rightAngleMerge.ports.find((item) => item.portId === 'input-a')!;
		const inputB = rightAngleMerge.ports.find((item) => item.portId === 'input-b')!;
		const output = rightAngleMerge.ports.find((item) => item.portId === 'output')!;
		assert(inputA.localDirection[0] === -1 && inputA.localDirection[2] === 0 && inputB.localDirection[0] === -1 && inputB.localDirection[2] === 0, '直角二合一左侧两个入口方向错误');
		assert(output.localDirection[0] === 0 && output.localDirection[2] === -1, '直角二合一上方出口方向错误');
		assert(Math.abs(Math.abs(inputA.localPosition[2] - inputB.localPosition[2]) - 1.9) < 0.001, '直角二合一两个左侧入口中心距没有匹配 1.9m 双排小辊道');
		assert(Math.abs(output.localPosition[0]) < 0.001 && inputA.localPosition[0] < 0 && inputB.localPosition[0] < 0, '直角二合一没有形成左进上出布局');
		const flow = rightAngleMerge.internalFlows[0];
		const merge = flow?.points.find((item) => item.kind === 'merger');
		assert(Boolean(merge) && flow.edges.filter((item) => item.toPointId === merge!.pointId).length === 2, '直角二合一内部路线没有真实二合一节点');
		assert(rightAngleMerge.root.userData?.mergeOnSharedTrunk === true, '直角二合一没有在右侧公共竖向干线上汇流');
		assert(Boolean(rightAngleMerge.root.getObjectByName('RightAngleMerge-Input-A')) && Boolean(rightAngleMerge.root.getObjectByName('RightAngleMerge-Input-B')) && Boolean(rightAngleMerge.root.getObjectByName('RightAngleMerge-Trunk')), '直角二合一几何没有按草图形成两条左进入口和一根右侧竖干线');
		assert((rightAngleMerge.root.userData?.outputStoppers?.length || 0) === 1, '直角二合一输出没有唯一挡停器');
	} finally { rightAngleMerge.dispose(); }

	const referenceDoubleSmallV11 = referenceComponentsV11.filter((item) => item.component?.resourceKey === 'builtin-double-small-roller-conveyor');
	assert(referenceDoubleSmallV11.length === 4 && referenceDoubleSmallV11.every((item) => Math.abs(Number(item.component?.properties?.laneSpacing) - 1.9) < 0.001), '参考图 V11 四处双排小辊道中心距没有统一为 1.9m');
	const referenceFlowComponentsV11 = referenceComponentsV11.filter((item) => {
		if (item.component?.properties?.referenceDrawingLine !== true) return false;
		const template = builtInComponentTemplates.find((candidate) => candidate.resourceKey === item.component?.resourceKey);
		return template?.capabilities.includes('material-flow') === true;
	});
	assert(referenceFlowComponentsV11.length > 0 && referenceFlowComponentsV11.every((item) => Math.abs(Number(item.transform.position[1] || 0)) < 0.001), '参考图 V11 辊道/工艺输送组件根节点没有统一放在 Y=0 工程基准面');
	const reportedNonCoplanarSections = new Set([
		'ref-edge-inspection-right-in',
		'ref-edge-inspection-to-diverter',
		'ref-edge-post-bag-up',
	]);
	for (const item of referenceFlowComponentsV11) {
		const expectedSurface = item.component?.resourceKey === 'builtin-large-roller-conveyor' ? 0.82 : 0.9;
		const built = defaultComponentRegistry.create({
			objectId: item.objectId,
			name: item.name,
			resourceKey: item.component!.resourceKey,
			componentType: item.component!.componentType as any,
			generator: item.component!.generator,
			generatorVersion: item.component!.generatorVersion,
			properties: item.component!.properties,
			transform: item.transform,
			sectionId: item.component!.sectionId,
		});
		try {
			built.root.updateMatrixWorld(true);
			const actualSurfaces: number[] = [];
			built.root.traverse((node: any) => {
				if (!Number.isFinite(Number(node.userData?.conveyorSurfaceHeight))) return;
				const world = node.getWorldPosition(new THREE.Vector3());
				actualSurfaces.push(world.y + Number(node.userData.conveyorSurfaceHeight));
			});
			assert(actualSurfaces.length > 0, item.name + ' 没有可验证的真实输送接触面');
			assert(actualSurfaces.every((surface) => Math.abs(surface - expectedSurface) < 0.001), item.name + ' 实际辊面不在统一标高 ' + expectedSurface.toFixed(2) + 'm: ' + actualSurfaces.map((surface) => surface.toFixed(3)).join(','));
			const materialPorts = built.ports.filter((port) => port.type === 'material-input' || port.type === 'material-output' || port.type === 'material-bidirectional');
			assert(materialPorts.every((port) => Math.abs(new THREE.Vector3(...port.localPosition).applyMatrix4(built.root.matrixWorld).y - expectedSurface) < 0.001), item.name + ' 的真实物流端口与统一辊面标高不一致');
			if (reportedNonCoplanarSections.has(String(item.component?.sectionId || ''))) {
				assert(Math.abs(built.root.getWorldPosition(new THREE.Vector3()).y) < 0.001, item.name + ' 根节点没有位于 Y=0 工程基准面');
				const rollerNodes: THREE.Object3D[] = [];
				built.root.traverse((node) => {
					if (node.name === 'Rollers' || node.name.endsWith('-Rollers')) rollerNodes.push(node);
				});
				assert(rollerNodes.length > 0, item.name + ' 没有找到真实滚筒 Mesh');
				for (const rollerNode of rollerNodes) {
					const rollerBounds = new THREE.Box3().setFromObject(rollerNode);
					assert(Math.abs(rollerBounds.max.y - 0.9) < 0.001, item.name + ' 滚筒实体顶面不是 Y=0.900m，而是 ' + rollerBounds.max.y.toFixed(3));
				}
			}
		} finally { built.dispose(); }
	}
	const referenceV7Diagnostics = validateV7ComponentManifest(referenceLineV11);
	assert(referenceV7Diagnostics.every((item) => item.severity !== 'error'), '参考图当前组件/自动路线校验存在错误：' + referenceV7Diagnostics.filter((item) => item.severity === 'error').map((item) => `${item.code}:${item.message}`).join(' | '));

	// 已经保存成组件化 V11 的场景也必须继续升级到 V12；这正是旧草稿中少数辊道高度无法被后续修正刷新的场景。
	const savedComponentizedV11 = structuredClone(referenceLineV11);
	savedComponentizedV11.name = '参考图双套袋环形包装产线 V11';
	savedComponentizedV11.runtime.referencePackagingLayoutVersion = 11;
	const savedV11Objects = savedComponentizedV11.objects as TwinV7SceneObjectDefinition[];
	for (const sectionId of reportedNonCoplanarSections) {
		const stale = savedV11Objects.find((item) => item.kind === 'component' && item.component?.sectionId === sectionId)!;
		assert(Boolean(stale), 'V11 迁移测试缺少场景辊道 ' + sectionId);
		stale.transform.position[1] = 0.2;
		stale.component!.properties.height = 0.55;
	}
	assert(upgradeReferencePackagingLineLayout(savedComponentizedV11) === true, '已组件化 V11 参考场景没有继续执行 V12 迁移');
	assert(savedComponentizedV11.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, 'V11->V12 迁移没有写入当前布局版本');
	assert(savedComponentizedV11.name === `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`, 'V11->V12 迁移没有同步参考图名称');
	const assertReferenceV18Migration = (sourceVersion: 15 | 16 | 17) => {
		const saved = structuredClone(referenceLineV11);
		saved.runtime.referencePackagingLayoutVersion = sourceVersion;
		saved.name = `参考图双套袋环形包装产线 V${sourceVersion}`;
		(saved.runtime as any).userCustomRuntimeFlag = `keep-v${sourceVersion}`;
		saved.runtime.primaryWoodenPalletRouteId = undefined;
		saved.runtime.routePalletInitializers = saved.runtime.routePalletInitializers?.filter((item) => item.routeId === saved.runtime.primarySmallPalletRouteId) || [];
		if (saved.runtime.routePalletInitializers[0]) saved.runtime.routePalletInitializers[0].simulationDefaultCount = 1;
		saved.workPoints = [...(saved.workPoints || []), { workPointId: `custom-work-${sourceVersion}`, name: '用户工作点', objectId: 'reference-loading-robot', role: 'home', localPosition: [0, 0, 0] }];
		saved.materialSlots = [...(saved.materialSlots || []), { slotId: `custom-slot-${sourceVersion}`, name: '用户物料槽', objectId: 'reference-loading-robot', role: 'source', localPosition: [0, 0, 0], payloadType: 'custom', capacity: 1 }];
		saved.toolFrames = [...(saved.toolFrames || []), { toolFrameId: `custom-tcp-${sourceVersion}`, name: '用户 TCP', objectId: 'reference-loading-robot', nodePath: 'RobotGridGripper-2x6', localPosition: [0, 0, 0] }];
		saved.actuators = [...(saved.actuators || []), { actuatorId: `custom-axis-${sourceVersion}`, name: '用户轴', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-1', kind: 'rotary-joint', motionAxis: 'y', unit: 'radian', homeValue: 0 }];
		saved.poses = [...(saved.poses || []), { poseId: `custom-pose-${sourceVersion}`, name: '用户姿态', objectId: 'reference-loading-robot', targets: [{ actuatorId: `custom-axis-${sourceVersion}`, value: 0.25 }] }];
		saved.behaviors = [...(saved.behaviors || []), { behaviorId: `custom-behavior-${sourceVersion}`, name: '用户动作', actorObjectId: 'reference-loading-robot', enabled: false, actions: [{ actionId: `custom-action-${sourceVersion}`, kind: 'wait', durationSeconds: 0.1 }] }];
		saved.interlocks = [...(saved.interlocks || []), { interlockId: `custom-interlock-${sourceVersion}`, name: '用户互锁', mode: 'all', conditions: [{ source: 'custom.ready', operator: 'truthy' }] }];
		assert(upgradeReferencePackagingLineLayout(saved) === true, `已保存 V${sourceVersion} 没有迁移到 V18`);
		assert(saved.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 没有刷新布局版本`);
		assert(saved.name === `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 没有同步场景名称`);
		assert(saved.runtime.primarySmallPalletRouteId === referenceLineV11.runtime.primarySmallPalletRouteId, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 主小托盘路线 ID 未刷新`);
		assert(saved.runtime.primaryWoodenPalletRouteId === referenceLineV11.runtime.primaryWoodenPalletRouteId, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 主木托路线 ID 未刷新`);
		const smallInit = saved.runtime.routePalletInitializers?.find((item) => item.routeId === saved.runtime.primarySmallPalletRouteId);
		const woodInit = saved.runtime.routePalletInitializers?.find((item) => item.routeId === saved.runtime.primaryWoodenPalletRouteId);
		assert(smallInit?.simulationDefaultCount === 12 && woodInit?.simulationDefaultCount === 0 && woodInit?.simulationAutoFeed === true, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 没有迁移 12 小托 + 0 初始木托/按需进料`);
		const woodRoute = saved.routes.find((item) => item.routeId === saved.runtime.primaryWoodenPalletRouteId)!;
		const woodProcesses = woodRoute.points.filter((item) => item.kind === 'processStation' && item.process).map((item) => item.process!.type);
		assert(['wood-stack-ready', 'top-cover', 'wrapping', 'labeling'].every((type) => woodProcesses.includes(type)), `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 后包装路线不完整`);
		assert(saved.behaviors?.some((item) => item.behaviorId === 'reference-top-cover-place-behavior'), `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 缺天盖 Behavior`);
		assert(saved.materialSlots?.some((item) => item.slotId === 'reference-top-cover-target-slot'), `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 缺天盖 MaterialSlot`);
		assert(saved.interlocks?.some((item) => item.interlockId === 'reference-wood-stack-complete'), `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 缺满托 Interlock`);
		assert(saved.workPoints?.some((item) => item.workPointId === `custom-work-${sourceVersion}`)
			&& saved.materialSlots?.some((item) => item.slotId === `custom-slot-${sourceVersion}`)
			&& saved.toolFrames?.some((item) => item.toolFrameId === `custom-tcp-${sourceVersion}`)
			&& saved.actuators?.some((item) => item.actuatorId === `custom-axis-${sourceVersion}`)
			&& saved.poses?.some((item) => item.poseId === `custom-pose-${sourceVersion}`)
			&& saved.behaviors?.some((item) => item.behaviorId === `custom-behavior-${sourceVersion}`)
			&& saved.interlocks?.some((item) => item.interlockId === `custom-interlock-${sourceVersion}`), `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 误删用户自定义动作定义`);
		assert((saved.runtime as any).userCustomRuntimeFlag === `keep-v${sourceVersion}`, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 误覆盖用户 runtime 扩展字段`);
		const snapshot = JSON.stringify(saved);
		assert(upgradeReferencePackagingLineLayout(saved) === false && JSON.stringify(saved) === snapshot, `V${sourceVersion}->V${REFERENCE_PACKAGING_LAYOUT_VERSION} 迁移不是幂等操作`);
	};
	for (const version of [15, 16, 17] as const) assertReferenceV18Migration(version);

	const brokenV18 = structuredClone(referenceLineV11);
	brokenV18.runtime.referencePackagingLayoutVersion = REFERENCE_PACKAGING_LAYOUT_VERSION;
	brokenV18.runtime.primaryWoodenPalletRouteId = undefined;
	brokenV18.runtime.routePalletInitializers = brokenV18.runtime.routePalletInitializers?.filter((item) => item.routeId === brokenV18.runtime.primarySmallPalletRouteId) || [];
	brokenV18.behaviors = brokenV18.behaviors?.filter((item) => item.behaviorId !== 'reference-top-cover-place-behavior');
	assert(upgradeReferencePackagingLineLayout(brokenV18) === true, '已标记 V18 但结构不完整的旧场景没有执行自修复');
	assert(brokenV18.runtime.primaryWoodenPalletRouteId === referenceLineV11.runtime.primaryWoodenPalletRouteId
		&& brokenV18.runtime.routePalletInitializers?.some((item) => item.routeId === brokenV18.runtime.primaryWoodenPalletRouteId && item.simulationDefaultCount === 0 && item.simulationAutoFeed === true)
		&& brokenV18.behaviors?.some((item) => item.behaviorId === 'reference-top-cover-place-behavior'), '损坏 V18 自修复没有补齐关键结构');
	const repairedV18Snapshot = JSON.stringify(brokenV18);
	assert(upgradeReferencePackagingLineLayout(brokenV18) === false && JSON.stringify(brokenV18) === repairedV18Snapshot, '损坏 V18 修复后不具备幂等性');

	const staleVisualV18 = structuredClone(referenceLineV11);
	const weightedBehaviorBeforeUpgrade = staleVisualV18.behaviors?.find((item) => item.behaviorId === 'reference-v12-robot-pick-west');
	if (weightedBehaviorBeforeUpgrade) weightedBehaviorBeforeUpgrade.selectionWeight = 3;
	const staleVisualSmallRoute = staleVisualV18.routes.find((item) => item.routeId === staleVisualV18.runtime.primarySmallPalletRouteId)!;
	for (const point of staleVisualSmallRoute.points.filter((item) => item.componentObjectId === 'reference-loading-robot' && item.process)) { delete (point.process as any).physicalLane; delete (point.process as any).batchLayout; }
	staleVisualSmallRoute.edges = staleVisualSmallRoute.edges.filter((edge) => edge.edgeId !== 'component-edge-reference-double-small-bottom-lane-b-segment-2' && edge.componentObjectId !== 'reference-bottom-b-to-inspection-merge');
	const staleVisualWood = (staleVisualV18.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === 'reference-stacking-pallet')!;
	staleVisualWood.component!.properties!.length = 4.0; staleVisualWood.component!.properties!.width = 3.4;
	assert(upgradeReferencePackagingLineLayout(staleVisualV18) === true, '同为 V18 但仍是旧 A/B 路线/旧木托尺寸的场景没有被强制升级');
	const repairedVisualRoute = staleVisualV18.routes.find((item) => item.routeId === staleVisualV18.runtime.primarySmallPalletRouteId)!;
	const repairedVisualLoads = repairedVisualRoute.points.filter((item) => item.componentObjectId === 'reference-loading-robot' && item.process).map((item) => item.process!);
	assert(repairedVisualLoads.length === 2 && ['A', 'B'].every((lane) => repairedVisualLoads.some((process) => process.physicalLane === lane && process.batchLayout?.rows === 1 && process.batchLayout?.columns === 6 && Math.abs(Number(process.batchLayout.columnSpacingMeters) - 1.55) < 0.001)), '旧 V18 自修复后没有恢复 A/B 各自 1×6 物理上料布局');
	const repairedVisualWood = (staleVisualV18.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === 'reference-stacking-pallet')!;
	assert(Number(repairedVisualWood.component?.properties?.length) === PACKAGING_WOOD_PALLET_LENGTH && Number(repairedVisualWood.component?.properties?.width) === PACKAGING_WOOD_PALLET_WIDTH, '旧 V18 自修复后木托尺寸没有恢复包装线标准');
	assert(staleVisualV18.behaviors?.find((item) => item.behaviorId === 'reference-v12-robot-pick-west')?.selectionWeight === 3, '参考线升级覆盖了用户配置的机器人放丝权重');
	const staleLoadingPositionV18 = structuredClone(referenceLineV11);
	const staleLoadingPositionRoute = staleLoadingPositionV18.routes.find((item) => item.routeId === staleLoadingPositionV18.runtime.primarySmallPalletRouteId)!;
	for (const point of staleLoadingPositionRoute.points.filter((item) => item.componentObjectId === 'reference-loading-robot' && item.process)) point.position[2] -= 0.5;
	assert(upgradeReferencePackagingLineLayout(staleLoadingPositionV18) === true, '同为 V18 且 A/B 语义正确但仍使用旧上料坐标的场景没有被强制升级');
	const repairedPositionRoute = staleLoadingPositionV18.routes.find((item) => item.routeId === staleLoadingPositionV18.runtime.primarySmallPalletRouteId)!;
	const repairedPositionByLane = new Map(repairedPositionRoute.points.filter((item) => item.componentObjectId === 'reference-loading-robot' && item.process).map((item) => [item.process!.physicalLane, item.position[2]]));
	assert(Math.abs(Number(repairedPositionByLane.get('A')) - 13.3) < 0.001 && Math.abs(Number(repairedPositionByLane.get('B')) - 15.2) < 0.001, '旧 V18 上料坐标自修复后没有恢复 A=13.3/B=15.2');

	const staleCurrentVersionName = structuredClone(referenceLineV11);
	staleCurrentVersionName.name = '参考图双套袋环形包装产线 V10';
	assert(upgradeReferencePackagingLineLayout(staleCurrentVersionName) === true, '当前布局版本的旧 V10 名称没有被规范到 V12');
	assert(staleCurrentVersionName.name === `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`, '当前布局版本名称规范失败');
	assert(upgradeReferencePackagingLineLayout(staleCurrentVersionName) === false, '名称规范后迁移不具备幂等性');
	const migratedSavedV11Objects = savedComponentizedV11.objects as TwinV7SceneObjectDefinition[];
	for (const sectionId of reportedNonCoplanarSections) {
		const migrated = migratedSavedV11Objects.find((item) => item.kind === 'component' && item.component?.sectionId === sectionId)!;
		assert(Math.abs(migrated.transform.position[1]) < 0.001, sectionId + ' V11->V12 后根节点没有恢复 Y=0');
		assert(Math.abs(Number(migrated.component?.properties?.height) - 0.9) < 0.001, sectionId + ' V11->V12 后辊面高度没有恢复 0.9m');
	}

	const legacyReferenceV11 = structuredClone(referenceLineV11);
	legacyReferenceV11.name = '参考图双套袋环形包装产线 V9';
	legacyReferenceV11.runtime.referencePackagingLayoutVersion = 9;
	const legacyRouteStub = (routeId: string, name: string): TwinRouteDefinition => ({
		routeId, name, type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
		points: [{ pointId: `${routeId}-p0`, name: '旧路线占位点', position: [0, 0.9, 0], kind: 'buffer' }],
		edges: [], startPointId: `${routeId}-p0`, junctionDecisions: {}, routingMode: 'manual', decisionRules: [],
	});
	legacyReferenceV11.routes.push(
		legacyRouteStub('reference-small-pallet-main', 'V9 小托盘主线'),
		legacyRouteStub('reference-large-pallet-line', 'V9 大辊道'),
		legacyRouteStub('reference-central-ring', 'V9 中央缓存'),
	);
	const legacyObjectsV11 = legacyReferenceV11.objects as TwinV7SceneObjectDefinition[];
	const legacyBagAV11 = legacyObjectsV11.find((item) => item.objectId === 'reference-bagging-a')!;
	legacyBagAV11.resourceId = 'legacy-bag-a-resource';
	legacyBagAV11.component!.bindings = { ready: 'legacy-ready-binding' };
	const customReferenceObjectV11 = structuredClone(legacyObjectsV11.find((item) => item.objectId === 'reference-loading-robot')!);
	customReferenceObjectV11.objectId = 'user-custom-reference-robot';
	customReferenceObjectV11.name = '用户额外机器人';
	customReferenceObjectV11.component!.properties.referenceDrawingLine = false;
	legacyObjectsV11.push(customReferenceObjectV11);
	assert(upgradeReferencePackagingLineLayout(legacyReferenceV11) === true, '旧参考图没有执行 V11 组件路线迁移');
	assert(legacyReferenceV11.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, '旧参考图迁移后没有写入 V11 版本');
	assert(legacyReferenceV11.routes.length > 0 && legacyReferenceV11.routes.every((item) => item.routeId.startsWith('component-route-')), '旧参考图迁移后没有重建组件自动 Route');
	const migratedObjectsV11 = legacyReferenceV11.objects as TwinV7SceneObjectDefinition[];
	const migratedBagAV11 = migratedObjectsV11.find((item) => item.objectId === 'reference-bagging-a')!;
	assert(migratedBagAV11.resourceId === 'legacy-bag-a-resource' && migratedBagAV11.component?.bindings?.ready === 'legacy-ready-binding', 'V11 迁移没有保留套袋机资源/Binding');
	assert(migratedObjectsV11.some((item) => item.objectId === 'user-custom-reference-robot'), 'V11 迁移误删用户额外对象');
	const migratedSnapshotV11 = JSON.stringify(legacyReferenceV11);
	assert(upgradeReferencePackagingLineLayout(legacyReferenceV11) === false && JSON.stringify(legacyReferenceV11) === migratedSnapshotV11, 'V11 迁移不是幂等操作');

	// 数据库真实旧场景不是“当前 canonical 改版本号”：V10 没有 primary/initializer，也没有后来新增的 B 排桥接。
	// 迁移后 runtime 指向的 routeId 必须真实存在，否则 Simulation 会静默得到 0 托盘。
	const databasePublishedV10 = structuredClone(referenceLineV11);
	databasePublishedV10.name = '参考图双套袋环形包装产线 V18';
	databasePublishedV10.runtime.referencePackagingLayoutVersion = 10;
	databasePublishedV10.runtime.primarySmallPalletRouteId = undefined;
	databasePublishedV10.runtime.primaryWoodenPalletRouteId = undefined;
	databasePublishedV10.runtime.routePalletInitializers = [];
	databasePublishedV10.connections = (databasePublishedV10.connections || []).filter((item) => !['reference-physical-bottom-b-output-to-merge', 'reference-physical-bottom-b-merge-to-inspection'].includes(item.connectionId));
	databasePublishedV10.routes.push(
		legacyRouteStub('reference-small-pallet-main', '数据库 V10 小托盘主线'),
		legacyRouteStub('reference-large-pallet-line', '数据库 V10 大辊道'),
		legacyRouteStub('reference-central-ring', '数据库 V10 中央缓存'),
	);
	assert(upgradeReferencePackagingLineLayout(databasePublishedV10) === true, '数据库 V10 参考场景没有执行当前布局迁移');
	const databaseV10SmallRouteId = databasePublishedV10.runtime.primarySmallPalletRouteId;
	const databaseV10WoodRouteId = databasePublishedV10.runtime.primaryWoodenPalletRouteId;
	assert(Boolean(databaseV10SmallRouteId && databasePublishedV10.routes.some((item) => item.routeId === databaseV10SmallRouteId)), '数据库 V10 迁移后 primarySmallPalletRouteId 指向不存在的 Route');
	assert(Boolean(databaseV10WoodRouteId && databasePublishedV10.routes.some((item) => item.routeId === databaseV10WoodRouteId)), '数据库 V10 迁移后 primaryWoodenPalletRouteId 指向不存在的 Route');
	assert((databasePublishedV10.runtime.routePalletInitializers || []).every((item) => databasePublishedV10.routes.some((route) => route.routeId === item.routeId)), '数据库 V10 迁移后 initializer 指向不存在的 Route');
	const databaseV10Scene = new THREE.Scene();
	databasePublishedV10.runtime.dataMode = 'simulation';
	const databaseV10Slots = new RouteSlotArrayRuntime(databaseV10Scene, databasePublishedV10);
	try {
		const databaseV10Small = databaseV10Slots.getSimulationSnapshot().filter((item) => item.routeId === databaseV10SmallRouteId);
		assert(databaseV10Small.length === 12, '数据库 V10 迁移后的 Simulation 没有真实创建 12 个小托盘');
	} finally { databaseV10Slots.dispose(); }
} else {
const referenceLine = createReferencePackagingLineTwinSceneManifest();
const referenceObjects = referenceLine.objects as TwinV7SceneObjectDefinition[];
const referenceComponents = referenceObjects.filter((item) => item.kind === 'component');
for (const component of referenceComponents) component.resourceId = resourceId;
assert(referenceLine.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, '参考图 V10 Manifest 缺少当前布局版本标记');
assert(referenceLine.routes.length === 6, '参考图 V10 必须包含前行线、单回流、桁架二合一、大辊道、马蹄缓存、上方辅助框六条路线');
assert(!referenceLine.routes.some((item) => item.routeId.startsWith('reference-double-') || item.routeId === 'reference-bottom-lane-b'), '参考图 V10 仍保留旧的孤立/临时双排 Route');
const referenceSmallRoute = referenceLine.routes.find((item) => item.routeId === 'reference-small-pallet-main')!;
const referenceReturnRoute = referenceLine.routes.find((item) => item.routeId === 'reference-small-pallet-return')!;
const referenceGantryMergeRoute = referenceLine.routes.find((item) => item.routeId === 'reference-gantry-merge-feed')!;
const referenceLargeRoute = referenceLine.routes.find((item) => item.routeId === 'reference-large-pallet-line')!;
const referenceHorseshoeRoute = referenceLine.routes.find((item) => item.routeId === 'reference-central-ring')!;
const referenceUpperFrameRoute = referenceLine.routes.find((item) => item.routeId === 'reference-upper-frame')!;
assert(referenceSmallRoute.loop === false && referenceReturnRoute.loop === false && referenceGantryMergeRoute.loop === false, '参考图 V10 前行/回流/桁架汇流必须保持独立非闭环 Route');
assert(referenceSmallRoute.edges.length >= 21, '参考图 V10 外检右进左出、一分二、双套袋、套袋后回到中部拓扑不完整');
assert(referenceReturnRoute.edges.length === 4, '参考图 V10 单回流必须且只能由四段单线组成');
assert(referenceGantryMergeRoute.edges.length === 4, '参考图 V10 桁架后二合一 Route 不完整');
for (const route of [referenceSmallRoute, referenceReturnRoute, referenceGantryMergeRoute]) {
	assert(resolveRouteTransportUnitResourceKey(route) === 'builtin-small-pallet', route.name + ' 没有解析成绿色小托盘');
	assert(route.edges.every((item) => item.transportUnitType === 'plastic-pallet' && item.conveyorSizeClass === 'small' && item.transportUnitResourceKey === 'builtin-small-pallet'), route.name + ' 没有全程绑定绿色小托盘资源');
}
assert(resolveRouteTransportUnitResourceKey(referenceLargeRoute) === 'builtin-carton', '参考图大辊道运行预览没有解析成纸箱');
assert(referenceSmallRoute.decisionRules.some((rule) => rule.edgeId === 'ref-edge-diverter-b' && rule.junctionPointId === 'ref-inspection-diverter'), '参考图 V10 外检后一分二缺少 B 支路分流规则');

// 参考图底部供料单元必须是“旋转台+双面丝车”与“六轴机器人+2×6丝锭夹具”，不能退化成空转台/裸机器人。
for (const objectId of ['reference-turntable-west', 'reference-turntable-east']) {
	const turntableObject = referenceComponents.find((item) => item.objectId === objectId)!;
	assert(Boolean(turntableObject), objectId + ' 缺少旋转台组件');
	assert(turntableObject.component?.properties?.withSilkCart === true, objectId + ' 没有启用双面丝车');
	const builtTurntable = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-turntable', {
		objectId: 'verify-' + objectId,
		properties: turntableObject.component?.properties || {},
	}));
	try {
		const rotatingDeck = builtTurntable.root.getObjectByName('RotatingDeck');
		const cart = builtTurntable.root.getObjectByName('SilkCart');
		assert(Boolean(builtTurntable.root.getObjectByName('Turntable-Chain-Deck')), objectId + ' 旋转台载台仍不是链式输送结构');
		assert(Boolean(rotatingDeck && cart), objectId + ' 没有生成 RotatingDeck 下的 SilkCart');
		assert(cart?.parent === rotatingDeck, objectId + ' 丝车没有挂在旋转盘下，转台旋转时不会跟随');
		assert(cart?.userData?.doubleSided === true && cart?.userData?.rows === 3 && cart?.userData?.columnsPerSide === 6, objectId + ' 丝车不是双面 3×6 结构');
		assert(Boolean(cart?.getObjectByName('SilkCake-A-R1-C1')) && Boolean(cart?.getObjectByName('SilkCake-B-R3-C6')), objectId + ' 丝车没有预装 A/B 两面丝锭');
	} finally { builtTurntable.dispose(); }
}
const loadingRobotObject = referenceComponents.find((item) => item.objectId === 'reference-loading-robot')!;
assert(loadingRobotObject.component?.properties?.toolType === 'silk-grid-2x6', '参考图底部机器人没有配置 2×6 丝锭夹具');
const builtLoadingRobot = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-industrial-robot', {
	objectId: 'verify-reference-loading-robot',
	properties: loadingRobotObject.component?.properties || {},
}));
try {
	for (let axis = 1; axis <= 6; axis += 1) assert(Boolean(builtLoadingRobot.root.getObjectByName('Robot-Axis-' + axis)), '底部机器人缺少 Robot-Axis-' + axis);
	const axis6 = builtLoadingRobot.root.getObjectByName('Robot-Axis-6')!;
	const toolFlange = builtLoadingRobot.root.getObjectByName('Robot-Tool-Flange')!;
	const flangeMount = builtLoadingRobot.root.getObjectByName('RobotGridGripper-FlangeMount')!;
	const gridGripper = builtLoadingRobot.root.getObjectByName('RobotGridGripper-2x6')!;
	assert(Boolean(axis6 && toolFlange && flangeMount && gridGripper), '底部机器人缺少 J6 / 法兰安装座 / 2×6夹具');
	assert(flangeMount.parent === toolFlange && gridGripper.parent === flangeMount, '2×6 夹具没有正装在 J6 法兰上');
	assert(!builtLoadingRobot.root.getObjectByName('RobotGridGripper-RightAngleMount'), '2×6 夹具仍错误保留 90° 弯折吸附结构');
	assert(Number(flangeMount.userData?.mountAngleDegrees) === 0, '2×6 夹具板面没有保持垂直于 J6 轴');
	assert(gridGripper.userData?.gripperRows === 2 && gridGripper.userData?.gripperColumns === 6 && gridGripper.userData?.gripperHeadCount === 12, '2×6 丝锭夹具行列/夹爪数量错误');
	assert(Math.abs(Number(gridGripper.userData?.contactPlaneOffset) - 0.54) < 0.001, '2×6 夹具 TCP 没有落在吸盘真实接触平面');
	for (let head = 1; head <= 12; head += 1) {
		const headNode = gridGripper.getObjectByName('RobotGripperHead-' + head);
		const payloadAnchor = gridGripper.getObjectByName('RobotPayloadAnchor-' + head);
		assert(Boolean(headNode), '2×6 丝锭夹具缺少抓头 ' + head);
		assert(Boolean(payloadAnchor) && payloadAnchor?.parent === headNode && payloadAnchor?.userData?.robotPayloadAnchor === true, '2×6 丝锭夹具缺少固定抓位锚点 ' + head);
		assert(Math.abs(Number(payloadAnchor?.position.x || 0)) < 0.0001 && Math.abs(Number(payloadAnchor?.position.z || 0)) < 0.0001, '固定抓位锚点没有与对应抓头同轴 ' + head);
	}
	builtLoadingRobot.root.updateMatrixWorld(true);
	const q6 = axis6.getWorldQuaternion(new THREE.Quaternion());
	const qGrip = gridGripper.getWorldQuaternion(new THREE.Quaternion());
	const cup = builtLoadingRobot.root.getObjectByName('RobotGripperCup-1')!;
	const qCup = cup.getWorldQuaternion(new THREE.Quaternion());
	const j6Axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q6).normalize();
	const gripperPlaneNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(qGrip).normalize();
	const cupApproach = new THREE.Vector3(0, 1, 0).applyQuaternion(qCup).normalize();
	assert(j6Axis.dot(cupApproach) > 0.999, '吸盘轴没有与机器人第六轴保持平行同向');
	assert(gripperPlaneNormal.dot(cupApproach) > 0.999, '吸盘轴没有垂直于 2×6 夹具板面');
	const westTurntableObject = referenceComponents.find((item) => item.objectId === 'reference-turntable-west')!;
	const builtWestTurntable = defaultComponentRegistry.create({
		objectId: 'verify-west-turntable-contact', name: westTurntableObject.name,
		resourceKey: westTurntableObject.component!.resourceKey, componentType: westTurntableObject.component!.componentType as any,
		generator: westTurntableObject.component!.generator, generatorVersion: westTurntableObject.component!.generatorVersion,
		properties: westTurntableObject.component!.properties, transform: westTurntableObject.transform, sectionId: westTurntableObject.component!.sectionId,
	});
	try {
		builtWestTurntable.root.updateMatrixWorld(true);
		const cake = builtWestTurntable.root.getObjectByName('SilkCake-A-R1-C1')!;
		const cakeOutwardNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(cake.getWorldQuaternion(new THREE.Quaternion())).normalize();
		assert(Math.abs(Math.abs(gripperPlaneNormal.dot(cakeOutwardNormal)) - 1) < 0.001, '2×6 吸盘工作面没有与丝锭端面保持平行');
		assert(cupApproach.dot(cakeOutwardNormal) < -0.999, '吸盘伸出方向没有从机器人正对西侧丝车端面');
	} finally { builtWestTurntable.dispose(); }
} finally { builtLoadingRobot.dispose(); }

const bottomDouble = referenceComponents.find((item) => item.objectId === 'reference-double-small-bottom')!;
const bottomLaneBMaxZ = 15.2 + 1.55 / 2;
for (const objectId of ['reference-turntable-west', 'reference-turntable-east']) {
	const turntable = referenceComponents.find((item) => item.objectId === objectId)!;
	const centerZ = turntable.transform.position[2];
	const cartHalfAlongWorldZ = 7.2 / 2;
	assert(centerZ - cartHalfAlongWorldZ > bottomLaneBMaxZ + 0.5, objectId + ' 的丝车仍侵入底部双排小辊道包络');
}
assert(loadingRobotObject.transform.position[2] - 0.72 > bottomLaneBMaxZ + 0.5, '底部机器人底座仍侵入双排小辊道');
assert(Boolean(bottomDouble), '底部双排小辊道组件缺失');

const referencePointMap = new Map(referenceSmallRoute.points.map((item) => [item.pointId, item]));
const referenceReturnPointMap = new Map(referenceReturnRoute.points.map((item) => [item.pointId, item]));
const referenceGantryPointMap = new Map(referenceGantryMergeRoute.points.map((item) => [item.pointId, item]));
for (const route of [referenceSmallRoute, referenceReturnRoute, referenceGantryMergeRoute]) {
	const pointMap = new Map(route.points.map((item) => [item.pointId, item]));
	for (const routeEdge of route.edges) {
		const from = pointMap.get(routeEdge.fromPointId)!;
		const to = pointMap.get(routeEdge.toPointId)!;
		assert(Boolean(from && to), route.name + ' 存在悬空 Edge：' + routeEdge.edgeId);
		const dx = Math.abs(to.position[0] - from.position[0]);
		const dz = Math.abs(to.position[2] - from.position[2]);
		assert(dx < 0.001 || dz < 0.001, route.name + ' 存在斜向/无法物理连接的输送段：' + routeEdge.edgeId);
	}
}

// 逐段对图：机器人必须从外检机右边进入，并从左边出来，然后立刻进入一分二。
const robotOut = referencePointMap.get('ref-robot-out')!;
const inspectionRight = referencePointMap.get('ref-inspection-right')!;
const inspectionPoint = referencePointMap.get('ref-inspection')!;
const inspectionLeft = referencePointMap.get('ref-inspection-left')!;
const inspectionDiverter = referencePointMap.get('ref-inspection-diverter')!;
assert(robotOut.position[0] === 0 && robotOut.position[2] === 13.3, '机器人上料位坐标偏离底部双排小辊道 A 排');
assert(inspectionRight.position[0] > inspectionPoint.position[0] && inspectionLeft.position[0] < inspectionPoint.position[0], '外检机没有形成右进左出');
assert(Math.abs(inspectionRight.position[2] - inspectionPoint.position[2]) < 0.001 && Math.abs(inspectionLeft.position[2] - inspectionPoint.position[2]) < 0.001, '外检机右进左出的三点没有在同一条小辊道中心线上');
assert(referenceSmallRoute.edges.some((item) => item.edgeId === 'ref-edge-inspection-in' && item.fromPointId === 'ref-inspection-right' && item.toPointId === 'ref-inspection'), '外检右侧入口 Edge 方向错误');
assert(referenceSmallRoute.edges.some((item) => item.edgeId === 'ref-edge-inspection-out' && item.fromPointId === 'ref-inspection' && item.toPointId === 'ref-inspection-left'), '外检左侧出口 Edge 方向错误');
assert(inspectionDiverter.kind === 'diverter' && referenceSmallRoute.edges.filter((item) => item.fromPointId === 'ref-inspection-diverter').length === 2, '外检机左出后没有真实一分二 Route');
const inspectionDiverterComponent = referenceComponents.find((item) => item.objectId === 'reference-inspection-diverter')!;
assert(inspectionDiverterComponent?.component?.resourceKey === 'builtin-diverter-conveyor' && inspectionDiverterComponent.component.sectionId === 'ref-inspection-diverter', '外检后一分二没有绑定真实分流辊道组件');

const bagAPoint = referencePointMap.get('ref-bag-a')!;
const bagBPoint = referencePointMap.get('ref-bag-b')!;
assert(inspectionPoint.kind === 'processStation' && inspectionPoint.process?.type === 'external-inspection' && inspectionPoint.componentObjectId === 'reference-external-inspection', '外检机工艺点没有绑定到外检组件');
assert(bagAPoint.kind === 'processStation' && bagAPoint.process?.type === 'bagging' && bagAPoint.componentObjectId === 'reference-bagging-a', '套袋机 A 工艺点没有绑定到设备组件');
assert(bagBPoint.kind === 'processStation' && bagBPoint.process?.type === 'bagging' && bagBPoint.componentObjectId === 'reference-bagging-b', '套袋机 B 工艺点没有绑定到设备组件');

// 套袋后二合一后必须沿图纸右侧纵线回到中部回流交接位。
const postBagMerge = referencePointMap.get('ref-post-bag-merge')!;
const postBagEast = referencePointMap.get('ref-post-bag-east')!;
const postBagUp = referencePointMap.get('ref-post-bag-up')!;
assert(postBagMerge.kind === 'merger', '双套袋后缺少二合一汇流点');
assert(referenceSmallRoute.edges.filter((item) => item.toPointId === 'ref-post-bag-merge').length === 2, '双套袋后的两个出口没有真正二合一');
const bagMergerComponent = referenceComponents.find((item) => item.objectId === 'reference-bag-merger')!;
assert(bagMergerComponent?.component?.resourceKey === 'builtin-merger-conveyor' && bagMergerComponent.component.sectionId === 'ref-post-bag-merge', '双套袋后二合一没有绑定真实汇流辊道组件');
assert(referenceSmallRoute.edges.some((item) => item.edgeId === 'ref-edge-post-bag-up' && item.fromPointId === 'ref-post-bag-east' && item.toPointId === 'ref-post-bag-up'), '套袋机之后缺少右侧纵向回流 Route');
assert(postBagEast.position[0] === postBagUp.position[0] && postBagUp.position[2] > postBagEast.position[2], '套袋后的右侧纵线没有回到图纸中部');
assert(referenceComponents.some((item) => item.component?.sectionId === 'ref-edge-post-bag-up' && item.component.resourceKey === 'builtin-small-roller-conveyor'), '套袋后右侧纵向 Route 没有生成真实小辊道模型');

// 桁架侧必须是真实二合一，不是装饰模型。
const gantryMergerPoint = referenceGantryPointMap.get('ref-gantry-merger')!;
assert(gantryMergerPoint.kind === 'merger' && referenceGantryMergeRoute.edges.filter((item) => item.toPointId === 'ref-gantry-merger').length === 2, '桁架过来后没有形成二合一 Route');
assert(referenceGantryMergeRoute.edges.filter((item) => item.fromPointId === 'ref-gantry-merger').length === 1, '桁架二合一后没有变成一条单线');
const gantryMergerComponent = referenceComponents.find((item) => item.objectId === 'reference-gantry-merger')!;
assert(gantryMergerComponent?.component?.resourceKey === 'builtin-merger-conveyor' && gantryMergerComponent.component.sectionId === 'ref-gantry-merger', '桁架后二合一没有绑定真实汇流辊道组件');

// 外检/套袋后的回流只能是一条独立单回流，不能再借用双排第二排。
assert(referenceReturnRoute.points.every((item) => !item.pointId.includes('inspection') && !item.pointId.includes('bag-a') && !item.pointId.includes('bag-b')), '单回流错误穿过外检或套袋内部工位');
assert(!referenceReturnRoute.points.some((item) => item.pointId.includes('lane-b') || item.pointId.includes('double')), '单回流仍错误依赖双排第二排');
const forwardPointIds = new Set(referenceSmallRoute.points.map((item) => item.pointId));
assert(referenceReturnRoute.points.every((item) => !forwardPointIds.has(item.pointId)), '前行线和单回流仍共享 RoutePoint ID');
assert(referenceReturnPointMap.get('ref-return-start')!.position[0] === postBagUp.position[0] && referenceReturnPointMap.get('ref-return-start')!.position[2] === postBagUp.position[2], '套袋后上行线与单回流的工艺交接位置不一致');
assert(referenceReturnPointMap.has('ref-return-robot'), '单回流没有回到机器人侧接收位');

// 正交线段交叉检查：只允许套袋后交接点和机器人工作区发生接触。
const routeSegments = (route: TwinRouteDefinition) => {
	const map = new Map(route.points.map((item) => [item.pointId, item]));
	return route.edges.map((routeEdge) => ({ id: routeEdge.edgeId, a: map.get(routeEdge.fromPointId)!.position, b: map.get(routeEdge.toPointId)!.position }));
};
const allowedHandoffs = [[21.5, 3], [-8.9, 6.8]] as const;
const isAllowedPoint = (x: number, z: number) => allowedHandoffs.some(([ax, az]) => Math.abs(x - ax) < 0.001 && Math.abs(z - az) < 0.001);
const rangeContains = (value: number, a: number, b: number) => value >= Math.min(a, b) - 0.001 && value <= Math.max(a, b) + 0.001;
for (const forward of routeSegments(referenceSmallRoute)) {
	for (const returning of routeSegments(referenceReturnRoute)) {
		const fh = Math.abs(forward.a[2] - forward.b[2]) < 0.001;
		const rh = Math.abs(returning.a[2] - returning.b[2]) < 0.001;
		if (fh !== rh) {
			const h = fh ? forward : returning;
			const v = fh ? returning : forward;
			const x = v.a[0], z = h.a[2];
			if (rangeContains(x, h.a[0], h.b[0]) && rangeContains(z, v.a[2], v.b[2])) assert(isAllowedPoint(x, z), '前行线与单回流发生错误交叉：' + forward.id + ' × ' + returning.id + ' @ ' + x + ',' + z);
		} else if (fh && Math.abs(forward.a[2] - returning.a[2]) < 0.001) {
			const lo = Math.max(Math.min(forward.a[0], forward.b[0]), Math.min(returning.a[0], returning.b[0]));
			const hi = Math.min(Math.max(forward.a[0], forward.b[0]), Math.max(returning.a[0], returning.b[0]));
			assert(hi < lo - 0.001 || (Math.abs(hi - lo) < 0.001 && isAllowedPoint(lo, forward.a[2])), '前行线与单回流水平重叠：' + forward.id + ' / ' + returning.id);
		} else if (!fh && !rh && Math.abs(forward.a[0] - returning.a[0]) < 0.001) {
			const lo = Math.max(Math.min(forward.a[2], forward.b[2]), Math.min(returning.a[2], returning.b[2]));
			const hi = Math.min(Math.max(forward.a[2], forward.b[2]), Math.max(returning.a[2], returning.b[2]));
			assert(hi < lo - 0.001 || (Math.abs(hi - lo) < 0.001 && isAllowedPoint(forward.a[0], lo)), '前行线与单回流纵向重叠：' + forward.id + ' / ' + returning.id);
		}
	}
}

for (const routeCode of ['A', 'B'] as const) {
	const resolved = resolveRoutePath(referenceSmallRoute, { payload: { routeCode }, bindingValues: {}, staleBindingIds: [] });
	const pointIds = new Set(resolved.points.map((item) => item.pointId));
	assert(resolved.closed === false, '参考图 ' + routeCode + ' 前行线不应伪装成闭环');
	assert(pointIds.has('ref-inspection-right') && pointIds.has('ref-inspection') && pointIds.has('ref-inspection-left') && pointIds.has('ref-inspection-diverter'), '参考图 ' + routeCode + ' 没有按右进左出经过外检并进入一分二');
	assert(pointIds.has(routeCode === 'A' ? 'ref-bag-a' : 'ref-bag-b'), '参考图 ' + routeCode + ' 没有进入对应套袋机');
	assert(pointIds.has('ref-post-bag-merge') && pointIds.has('ref-post-bag-up'), '参考图 ' + routeCode + ' 套袋后没有经过二合一和向上小辊道');
	assert(![...pointIds].some((id) => id.startsWith('ref-return-')), '参考图 ' + routeCode + ' 前行线错误混入单回流点');
}

assert(referenceHorseshoeRoute.loop === false, '中央缓存必须是底部开口马蹄形，不能继续闭合成 360° 圆环');
assert(referenceHorseshoeRoute.points.length === 7 && referenceHorseshoeRoute.edges.length === 6, '中央马蹄形缓存必须使用 7 个采样点/6 段开放路径');
const horseshoeFirst = referenceHorseshoeRoute.points[0].position;
const horseshoeLast = referenceHorseshoeRoute.points[referenceHorseshoeRoute.points.length - 1].position;
assert(horseshoeFirst[2] > -10 && horseshoeLast[2] > -10 && horseshoeFirst[0] < -4 && horseshoeLast[0] > -4, '中央马蹄形缓存的开口没有朝图纸下方（世界 Z+）');
assert(referenceUpperFrameRoute.loop === true && referenceUpperFrameRoute.points.length === 6 && referenceUpperFrameRoute.edges.length === 6, '中央缓存外层矩形辊道框不完整');
const upperFramePoints = new Map(referenceUpperFrameRoute.points.map((item) => [item.pointId, item]));
for (const frameEdge of referenceUpperFrameRoute.edges) {
	const from = upperFramePoints.get(frameEdge.fromPointId)!;
	const to = upperFramePoints.get(frameEdge.toPointId)!;
	assert(Math.abs(from.position[0] - to.position[0]) < 0.001 || Math.abs(from.position[2] - to.position[2]) < 0.001, '外层矩形辊道框出现非正交边');
}
assert(referenceLargeRoute.edges.length >= 3 && referenceLargeRoute.edges.every((item) => item.conveyorSizeClass === 'large' && item.transportUnitType === 'carton'), '参考图左侧大辊道必须固定输送纸箱');
assert(referenceLargeRoute.points.find((item) => item.pointId === 'ref-large-stack')?.componentObjectId === 'reference-stacking-gantry', '大辊道码垛工艺点没有绑定码垛桁架');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-bagging-machine').length === 2, '参考图产线必须包含两台侧封膜机');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-turntable').length === 2, '参考图底部必须包含左右两台旋转台，中央不能再放旋转台');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-industrial-robot').length === 2, '参考图必须包含中央机器人和底部机器人两台六轴机器人');
assert(Boolean(referenceComponents.find((item) => item.objectId === 'reference-center-robot')), '马蹄形缓存中央缺少机器人');
assert(!referenceComponents.some((item) => item.objectId === 'reference-center-turntable'), '马蹄形缓存中央仍错误保留旋转台');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-silk-gantry').length === 1, '参考图产线缺少码垛桁架和暂存台组件');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-turn-conveyor-90').length === 3, '中央马蹄形缓存必须且只能由三个 90° 标准转弯辊道组成');
assert(referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-large-roller-conveyor').length >= 3, '左侧大辊道必须至少分成三段可管理组件');
const referenceDoubleSmall = referenceComponents.filter((item) => item.component?.resourceKey === 'builtin-double-small-roller-conveyor');
assert(referenceDoubleSmall.length === 4, '标注图中的左上、右上、中部、底部四处必须全部使用双排小辊道组件');
for (const item of referenceDoubleSmall) {
	assert(item.component?.properties?.conveyorSizeClass === 'small' && item.component?.properties?.transportUnitType === 'plastic-pallet', item.name + ' 必须固定输送小托盘');
	assert(Math.abs(Number(item.component?.properties?.laneSpacing) - 1.9) < 0.001, item.name + ' 两排中心距必须为 1.9m');
}
const assertDoubleLaneWorldCenters = (objectId: string, expectedA: { axis: 'x' | 'z'; value: number }, expectedB: { axis: 'x' | 'z'; value: number }) => {
	const item = referenceComponents.find((candidate) => candidate.objectId === objectId)!;
	const built = defaultComponentRegistry.create({ objectId: item.objectId, name: item.name, resourceKey: item.component!.resourceKey, componentType: item.component!.componentType as any, generator: item.component!.generator, generatorVersion: item.component!.generatorVersion, properties: item.component!.properties, transform: item.transform, sectionId: item.component!.sectionId });
	try {
		built.root.updateMatrixWorld(true);
		for (const [portId, expected] of [['a-input', expectedA], ['b-input', expectedB]] as const) {
			const port = built.ports.find((candidate) => candidate.portId === portId)!;
			const world = new THREE.Vector3(...port.localPosition).applyMatrix4(built.root.matrixWorld);
			const actual = expected.axis === 'x' ? world.x : world.z;
			assert(Math.abs(actual - expected.value) < 0.001, item.name + ' ' + portId + ' 没有落到对应主 Route 中心线');
		}
	} finally { built.dispose(); }
};
assertDoubleLaneWorldCenters('reference-double-small-upper-left', { axis: 'x', value: -12.7 }, { axis: 'x', value: -10.8 });
assertDoubleLaneWorldCenters('reference-double-small-upper-right', { axis: 'x', value: 4.9 }, { axis: 'x', value: 6.8 });
assertDoubleLaneWorldCenters('reference-double-small-middle', { axis: 'z', value: 1.1 }, { axis: 'z', value: 3 });
assertDoubleLaneWorldCenters('reference-double-small-bottom', { axis: 'z', value: 13.3 }, { axis: 'z', value: 15.2 });

const allReferencePoints = referenceLine.routes.flatMap((route) => route.points);
assert(Math.max(...allReferencePoints.map((item) => item.position[0])) <= 21.5, '参考图 V10 仍存在超出图纸右边界的幽灵路线');
assert(Math.max(...allReferencePoints.map((item) => item.position[2])) <= 19.8, '参考图 V10 仍存在超出底部机器人区域的幽灵路线');
assert(referenceLine.routes.find((item) => item.routeId === 'reference-large-pallet-line')?.points.find((item) => item.pointId === 'ref-large-out')?.position[2] === 1.8, '大辊道下端没有收回到图纸中部');
assert(referenceSmallRoute.points.find((item) => item.pointId === 'ref-inspection')?.position[0] === 4.6
	&& referenceSmallRoute.points.find((item) => item.pointId === 'ref-inspection')?.position[2] === 6.8, '外检机没有落在参考图下部回路中心');
assert(referenceComponents.find((item) => item.objectId === 'reference-loading-robot')?.transform.position[2] === 19.8, '底部机器人没有与双旋转台处于图纸底部同一工位带');
assert(referenceComponents.filter((item) => item.objectId === 'reference-turntable-west' || item.objectId === 'reference-turntable-east').every((item) => item.transform.position[2] === 19.8), '底部双旋转台没有与机器人按图对齐');
const upperLeftDouble = referenceComponents.find((item) => item.objectId === 'reference-double-small-upper-left')!;
const upperLeftLength = Number(upperLeftDouble.component?.properties?.length || 0);
const upperLeftCenterZ = upperLeftDouble.transform.position[2];
assert(Math.abs(upperLeftCenterZ - upperLeftLength / 2 - (-17.7)) <= 0.001
	&& Math.abs(upperLeftCenterZ + upperLeftLength / 2 - 6.8) <= 0.001, '左上竖向双排没有严格止于上框和外检分流带');
const embeddedSectionIds = new Set(['ref-edge-inspection-in', 'ref-edge-inspection-out', 'ref-edge-bag-a', 'ref-edge-bag-a-out', 'ref-edge-bag-b', 'ref-edge-bag-b-out']);
assert(!referenceComponents.some((item) => item.kind === 'component' && embeddedSectionIds.has(String(item.component?.sectionId || ''))), '套袋机或外检机内部仍叠加了自动直线辊道');
const referenceStackCarton = referenceComponents.find((item) => item.objectId === 'reference-stacking-pallet');
assert(referenceStackCarton?.component?.resourceKey === 'builtin-carton', '大辊道码垛位必须放纸箱，不能继续放木托盘');
const referenceGantry = referenceComponents.find((item) => item.objectId === 'reference-stacking-gantry')!;
assert(Math.abs(referenceGantry.transform.rotation[1] - Math.PI / 2) < 0.001, '码垛桁架没有旋转 90°，暂存台无法落到大辊道左侧');
assert(!referenceObjects.some((item) => item.objectId === 'moving-package'), '参考图 V15 仍保留旧单一 moving-package，运行时会与多托盘重复');
for (const item of referenceComponents) {
	const built = defaultComponentRegistry.create({ objectId: item.objectId, name: item.name, resourceKey: item.component!.resourceKey, componentType: item.component!.componentType as any, generator: item.component!.generator, generatorVersion: item.component!.generatorVersion, resourceId: item.resourceId, properties: item.component!.properties, transform: item.transform, sectionId: item.component!.sectionId });
	try { assert(!built.bounds.isEmpty(), '参考图组件 ' + item.name + ' 没有有效三维边界'); } finally { built.dispose(); }
}
const referenceErrors = validateV7ComponentManifest(referenceLine).filter((item) => item.severity === 'error');
assert(referenceErrors.length === 0, '参考图产线组件校验失败：' + referenceErrors.map((item) => item.message).join('；'));

// 真正用参考图 V7 前行线驱动外检和两台套袋机，验证“外检 -> 对应套袋 -> 放行”；回流由独立 Route 承担。
for (const routeCode of ['A', 'B'] as const) {
	const processRoute = structuredClone(referenceSmallRoute);
	processRoute.defaultSpeed = 30;
	processRoute.points.find((item) => item.pointId === 'ref-inspection')!.process!.cycleSeconds = 0.30;
	processRoute.points.find((item) => item.pointId === 'ref-bag-a')!.process!.cycleSeconds = 0.35;
	processRoute.points.find((item) => item.pointId === 'ref-bag-b')!.process!.cycleSeconds = 0.35;
	const target = new THREE.Group();
	const engine = new RouteEngine(processRoute, target);
	engine.setRoutingContext({ payload: { routeCode }, bindingValues: {}, staleBindingIds: [] });
	const roots = new Map<string, ReturnType<typeof defaultComponentRegistry.create>>();
	for (const objectId of ['reference-external-inspection', 'reference-bagging-a', 'reference-bagging-b']) {
		const item = referenceComponents.find((candidate) => candidate.objectId === objectId)!;
		roots.set(objectId, defaultComponentRegistry.create({ objectId: item.objectId, name: item.name, resourceKey: item.component!.resourceKey, componentType: item.component!.componentType as any, generator: item.component!.generator, generatorVersion: item.component!.generatorVersion, properties: item.component!.properties, transform: item.transform, sectionId: item.component!.sectionId }));
	}
	const runtime = new ComponentProcessRuntime({ route: processRoute, routeEngine: engine, dataMode: 'simulation', getComponentRoot: (objectId) => roots.get(objectId)?.root, getRoutingContext: () => ({ payload: { routeCode }, bindingValues: {}, staleBindingIds: [] }) });
	runtime.setRunning(true);
	const activeStations = new Set<string>();
	let sawInspectionTimeline = false;
	let sawBaggingTimeline = false;
	const inspectionRoot = roots.get('reference-external-inspection')!.root;
	const inspectionGripper = inspectionRoot.getObjectByName('Inspection-Rotary-Gripper')!;
	const inspectionBaseRotation = inspectionGripper.rotation.y;
	const bagRoot = roots.get(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b')!.root;
	const bagFeedRoller = bagRoot.getObjectByName('Bagging-Film-Guide-Roller-1')!;
	const bagFeedBaseRotation = bagFeedRoller.rotation.y;
	for (let index = 0; index < 1200; index += 1) {
		const allow = runtime.updateFixed(1 / 30);
		if (allow) engine.updateFixed(1 / 30);
		for (const built of roots.values()) advanceComponentVisualRuntime(built.root, 1 / 30, 1);
		const snapshot = runtime.getSnapshot();
		if (snapshot.activeStationId) activeStations.add(snapshot.activeStationId);
		if (inspectionRoot.userData.processActive && Math.abs(inspectionGripper.rotation.y - inspectionBaseRotation) > 0.05) sawInspectionTimeline = true;
		if (bagRoot.userData.processActive && Math.abs(bagFeedRoller.rotation.y - bagFeedBaseRotation) > 0.05) sawBaggingTimeline = true;
		if (snapshot.processedStationIds.includes('reference-external-inspection') && snapshot.processedStationIds.includes(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b')) break;
	}
	assert(activeStations.has('reference-external-inspection'), '参考图 ' + routeCode + ' 前行线没有在外检机内部停车');
	assert(activeStations.has(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b'), '参考图 ' + routeCode + ' 前行线没有进入对应侧封膜机');
	assert(Array.isArray(inspectionRoot.userData.componentAnimations) && inspectionRoot.userData.componentAnimations.length >= 5 && sawInspectionTimeline, '外检机没有通过组件内部 Process 时间轴执行固定动画');
	assert(Array.isArray(bagRoot.userData.componentAnimations) && bagRoot.userData.componentAnimations.length >= 10 && sawBaggingTimeline, '侧封膜机没有通过组件内部 Process 时间轴执行固定动画');
	runtime.dispose(); for (const built of roots.values()) built.dispose();
}

// 已保存/已发布 V9 参考图必须在内存中升级到按最新标注图校准的 V10。
const legacyReference = structuredClone(referenceLine);
legacyReference.name = '参考图双套袋环形包装产线 V9';
legacyReference.runtime.referencePackagingLayoutVersion = 9;
const legacySmall = legacyReference.routes.find((item) => item.routeId === 'reference-small-pallet-main')!;
for (const point of legacySmall.points.filter((item) => item.kind === 'processStation')) delete point.componentObjectId;
legacyReference.routes = legacyReference.routes.filter((item) => item.routeId !== 'reference-small-pallet-return' && item.routeId !== 'reference-gantry-merge-feed');
legacyReference.routes.push({ routeId: 'reference-bottom-lane-b', name: 'V8 旧临时底部B排路线', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true, points: [{ pointId: 'v8-b0', name: 'B0', position: [-12, 0.9, 18.9], kind: 'buffer' }, { pointId: 'v8-b1', name: 'B1', position: [12, 0.9, 18.9], kind: 'buffer' }], edges: [{ edgeId: 'v8-b-edge', fromPointId: 'v8-b0', toPointId: 'v8-b1', name: 'V8临时B排', bidirectional: false, enabled: true, priority: 0, capacity: 12, occupancyMode: 'simulation', reservationTimeoutSeconds: 30, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet', transportUnitResourceKey: 'builtin-small-pallet' }], startPointId: 'v8-b0', junctionDecisions: {}, routingMode: 'manual', decisionRules: [] });
const legacyReferenceObjects = legacyReference.objects as TwinV7SceneObjectDefinition[];
const legacyBagA = legacyReferenceObjects.find((item) => item.objectId === 'reference-bagging-a')!;
legacyBagA.resourceId = 'legacy-bag-a-resource'; legacyBagA.component!.bindings = { ready: 'legacy-ready-binding' };
const customReferenceObject = structuredClone(legacyReferenceObjects.find((item) => item.objectId === 'reference-loading-robot')!);
customReferenceObject.objectId = 'user-custom-reference-robot'; customReferenceObject.name = '用户额外机器人'; customReferenceObject.component!.properties.referenceDrawingLine = false; legacyReferenceObjects.push(customReferenceObject);
legacyReference.rootAssetId = 'legacy-reference-root-asset';
assert(upgradeReferencePackagingLineLayout(legacyReference) === true, 'V9 参考图发布 Manifest 没有执行 V10 布局迁移');
assert(legacyReference.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, '参考图迁移后没有写入 V10 版本标记');
assert(legacyReference.routes.length === 6 && !legacyReference.routes.some((item) => item.routeId.startsWith('reference-double-') || item.routeId === 'reference-bottom-lane-b') && legacyReference.routes.some((item) => item.routeId === 'reference-small-pallet-return') && legacyReference.routes.some((item) => item.routeId === 'reference-gantry-merge-feed'), 'V9->V10 迁移没有正确重建前行/单回流/桁架二合一');
const migratedSmall = legacyReference.routes.find((item) => item.routeId === 'reference-small-pallet-main')!;
assert(migratedSmall.points.find((item) => item.pointId === 'ref-inspection')?.componentObjectId === 'reference-external-inspection', 'V9->V10 迁移后外检工位仍未绑定组件');
assert(migratedSmall.points.some((item) => item.pointId === 'ref-inspection-diverter') && migratedSmall.edges.some((item) => item.edgeId === 'ref-edge-post-bag-up'), 'V9->V10 迁移后没有得到外检一分二或套袋后上行段');
const migratedReferenceObjects = legacyReference.objects as TwinV7SceneObjectDefinition[];
const migratedBagA = migratedReferenceObjects.find((item) => item.objectId === 'reference-bagging-a')!;
assert(migratedBagA.resourceId === 'legacy-bag-a-resource' && migratedBagA.component?.bindings?.ready === 'legacy-ready-binding', '参考图迁移没有保留已有套袋机资源/Binding');
assert(migratedReferenceObjects.some((item) => item.objectId === 'reference-inspection-diverter' && item.component?.resourceKey === 'builtin-diverter-conveyor'), 'V9->V10 迁移没有补上外检后一分二组件');
assert(migratedReferenceObjects.some((item) => item.objectId === 'reference-gantry-merger' && item.component?.resourceKey === 'builtin-merger-conveyor'), 'V9->V10 迁移没有补上桁架后二合一组件');
assert(migratedReferenceObjects.some((item) => item.objectId === 'user-custom-reference-robot'), '参考图迁移误删了用户额外对象');
assert(legacyReference.rootAssetId === 'legacy-reference-root-asset', '参考图迁移误改了场景根 Asset');
const migratedReferenceSnapshot = JSON.stringify(legacyReference);
assert(upgradeReferencePackagingLineLayout(legacyReference) === false && JSON.stringify(legacyReference) === migratedReferenceSnapshot, '参考图 V10 迁移不是幂等操作');
}

const packagingTemplates = [
	['builtin-external-inspection', '化纤外检机'],
	['builtin-silk-gantry', '丝锭桁架'],
	['builtin-top-cover-gantry', '天盖桁架'],
	['builtin-wrapper-machine', '缠膜机'],
	['builtin-labeling-machine', '贴标机'],
	['builtin-bagging-machine', '化纤侧封膜机'],
	['builtin-vacuum-film-tuck-station', '化纤真空吸膜工位'],
] as const;
for (const [resourceKey, expectedName] of packagingTemplates) {
	const template = builtInComponentTemplates.find((item) => item.resourceKey === resourceKey);
	assert(template?.name === expectedName, `组件设计库缺少 ${expectedName}`);
	const definition = createComponentDefinitionFromTemplate(resourceKey, { objectId: `verify-${resourceKey}` });
	const replayDefinition = JSON.parse(JSON.stringify(definition));
	assert(replayDefinition.resourceKey === resourceKey && replayDefinition.componentType === definition.componentType && replayDefinition.generator === definition.generator, `${expectedName} 序列化后组件身份丢失`);
	const built = defaultComponentRegistry.create(replayDefinition);
	try {
		assert(built.root.userData.resourceKey === resourceKey, `${expectedName} 实例根节点缺少 resourceKey`);
		assert(built.root.userData.componentType === definition.componentType, `${expectedName} 实例根节点 componentType 错误`);
		if (resourceKey === 'builtin-external-inspection') {
			assert(built.root.userData?.inspectionType === 'chemical-fiber-appearance', '外检机没有升级成化纤丝饼外观检测工作站');
			assert(built.root.userData?.darkChamber === true, '化纤外检机缺少封闭暗室语义');
			assert(built.root.userData?.cameraCount === 3, '化纤外检机必须包含顶部+双侧共三套相机');
			const conveyor = built.root.getObjectByName('InspectionConveyor') as any;
			assert(Boolean(conveyor) && conveyor.userData?.throughConveyor === true, '化纤外检机缺少贯穿式检测辊道');
			assert(Boolean(built.root.getObjectByName('Inspection-Chamber')), '化纤外检机缺少封闭视觉检测舱');
			const cameras = ['Inspection-Top-Camera', 'Inspection-Side-Camera-ZN', 'Inspection-Side-Camera-ZP'].map((name) => built.root.getObjectByName(name) as any);
			assert(cameras.every((camera) => camera?.userData?.visionCamera === true), '化纤外检机三套视觉相机结构不完整');
			const lights: any[] = [];
			built.root.traverse((node: any) => { if (node.userData?.inspectionLight === true) lights.push(node); });
			assert(lights.length >= 3, '化纤外检机缺少顶部/侧面检测光源');
			const rotary = built.root.getObjectByName('Inspection-Rotary-Gripper') as any;
			assert(rotary?.userData?.rotaryInspectionGripper === true && rotary?.userData?.rotationAxis === 'y', '化纤外检机缺少顶部 360° 旋转检测夹具');
			const jaws: any[] = [];
			rotary?.traverse((node: any) => { if (node.userData?.gripperJaw === true) jaws.push(node); });
			assert(jaws.length === 2, '顶部旋转检测夹具缺少成对夹爪');
			const stopper = built.root.getObjectByName('Inspection-Positioning-Stopper') as any;
			assert(stopper?.userData?.retractableStopper === true, '化纤外检机缺少托盘定位挡停机构');
			assert(Boolean(built.root.getObjectByName('Inspection-Control-Cabinet')), '化纤外检机缺少电控柜');
			assert(Boolean(built.root.getObjectByName('Inspection-HMI-Screen')), '化纤外检机缺少 HMI 屏幕');
			assert(Boolean(built.root.getObjectByName('Inspection-Stack-Light-Red'))
				&& Boolean(built.root.getObjectByName('Inspection-Stack-Light-Amber'))
				&& Boolean(built.root.getObjectByName('Inspection-Stack-Light-Green')), '化纤外检机缺少红黄绿三色灯');
			assert(!built.root.getObjectByName('InspectionShell'), '化纤外检机仍残留旧的单一半透明外壳模型');
		}
		if (resourceKey === 'builtin-silk-gantry') {
			const orangeRails: any[] = [];
			const orangeMeshes: any[] = [];
			const yellowMeshes: any[] = [];
			built.root.traverse((node: any) => {
				if (node.userData?.sharedOrangeRail === true || node.userData?.fixedSharedRail === true) orangeRails.push(node);
				const material = Array.isArray(node.material) ? node.material[0] : node.material;
				const color = material?.color?.getHex?.();
				if (color === 0xf97316) orangeMeshes.push(node);
				if (color === 0xfacc15) yellowMeshes.push(node);
			});
			assert(orangeRails.length === 2, '丝锭桁架必须且只能有两根共享橙色轨道');
			assert(orangeMeshes.length === 2, '丝锭桁架中橙色只允许用于两根 Z 向真实轨道');
			assert(yellowMeshes.length === 0, '丝锭桁架组件不应保留黄色结构件');
			assert(Boolean(built.root.getObjectByName('Gantry-Z-Travel-Rail-A')) && Boolean(built.root.getObjectByName('Gantry-Z-Travel-Rail-B')), 'Z 轴橙色双轨命名或结构缺失');
			assert(orangeRails.every((rail) => rail.userData?.travelAxis === 'z'), '橙色真实轨道必须沿 Z 轴行走');
			const railBoxes = orangeRails.map((rail) => new THREE.Box3().setFromObject(rail));
			const railSizes = railBoxes.map((box) => box.getSize(new THREE.Vector3()));
			assert(railSizes.every((size) => size.z > size.x * 8), '橙色真实轨道几何必须明显沿 Z 轴延伸');
			assert(railSizes.every((size) => size.z >= 26.0), 'Z 向轨道长度不足以覆盖两个木托盘规格的隔板暂存台');
			const railCenters = railBoxes.map((box) => box.getCenter(new THREE.Vector3()));
			assert(Math.abs(railCenters[0].x - railCenters[1].x) > 1.0, '两根 Z 向橙色轨道必须位于不同 X 位置');

			const mainBeams: any[] = [];
			built.root.traverse((node: any) => { if (node.userData?.fixedMainBeam === true) mainBeams.push(node); });
			assert(mainBeams.length === 2, '丝锭桁架组件必须包含两根固定主梁');
			const supportMainBeams = [built.root.getObjectByName('SilkGantry-Rail-Support-MainBeam-A'), built.root.getObjectByName('SilkGantry-Rail-Support-MainBeam-B')] as any[];
			assert(supportMainBeams.every(Boolean), 'X 向深色轨道支撑主梁缺失');
			assert(supportMainBeams.every((beam) => beam.userData?.isRail === false), 'X 向深色主梁不能再被标记为轨道');

			const silkCarriage = built.root.getObjectByName('Gantry-Silk-Rail-Carriage') as any;
			const separatorCarriage = built.root.getObjectByName('Gantry-Separator-Rail-Carriage') as any;
			assert(silkCarriage?.position.z > 0, '丝锭夹具总成没有移动到 Z+');
			assert(separatorCarriage?.position.z < 0, '隔板夹具总成没有移动到 Z-');
			assert(silkCarriage?.userData?.travelAxis === 'z' && separatorCarriage?.userData?.travelAxis === 'z', '两个夹具小车必须沿 Z 轴轨道运行');

			const silkBridge = built.root.getObjectByName('Gantry-Silk-Bridge') as any;
			const separatorBridge = built.root.getObjectByName('Gantry-Separator-Bridge') as any;
			assert(Boolean(silkBridge) && Boolean(separatorBridge), '丝锭/隔板桥式小车缺失');
			const silkBridgeBox = new THREE.Box3().setFromObject(silkBridge);
			const railMinX = Math.min(...railCenters.map((center) => center.x));
			const railMaxX = Math.max(...railCenters.map((center) => center.x));
			assert(silkBridgeBox.min.x <= railMinX && silkBridgeBox.max.x >= railMaxX, '丝锭桥没有在 X 方向同时跨过两根 Z 向橙色轨道');

			const silkShoes = [1, 2].map((index) => built.root.getObjectByName(`Gantry-Silk-Rail-Shoe-${index}`) as any);
			const separatorShoes = [1, 2].map((index) => built.root.getObjectByName(`Gantry-Separator-Rail-Shoe-${index}`) as any);
			for (const [label, shoes] of [['丝锭夹具', silkShoes], ['隔板夹具', separatorShoes]] as const) {
				assert(shoes.every((shoe) => shoe?.userData?.railMounted === true), `${label} 两个滑靴没有全部挂到 Z 向橙色轨道`);
				assert(shoes.every((shoe) => shoe?.userData?.sharedRailPairId === built.root.userData.sharedRailPairId), `${label} 没有共用同一 railPair`);
				for (let index = 0; index < 2; index += 1) {
					const shoeBox = new THREE.Box3().setFromObject(shoes[index]);
					const shoeCenter = shoeBox.getCenter(new THREE.Vector3());
					const railBox = railBoxes[index];
					const railCenter = railCenters[index];
					const verticalGap = Math.abs(shoeBox.min.y - railBox.max.y);
					assert(Math.abs(shoeCenter.x - railCenter.x) <= 0.001, `${label} 第 ${index + 1} 个滑靴没有对准对应 Z 轨道的 X 中心`);
					assert(verticalGap <= 0.011, `${label} 第 ${index + 1} 个滑靴与橙色 Z 轨道存在悬空间隙: ${verticalGap.toFixed(3)}m`);
				}
			}

			assert(!built.root.getObjectByName('Gantry-Silk-Hanger-A') && !built.root.getObjectByName('Gantry-Silk-Hanger-B'), '旧的斜向丝锭吊挂结构必须移除');
			const silkFootprintMesh = built.root.getObjectByName('Gantry-Silk-Gripper-2x3') as any;
			const silkFootprintSize = new THREE.Box3().setFromObject(silkFootprintMesh).getSize(new THREE.Vector3());
			assert(Math.abs(silkFootprintSize.x - 4.2) <= 0.001 && Math.abs(silkFootprintSize.z - 4.0) <= 0.001, '丝锭 2×3 码垛平面基准必须保持 4.2m × 4.0m');
			assert(Boolean(built.root.getObjectByName('GantryGripper-2x3')), '丝锭夹具缺失');
			assert(Boolean(built.root.getObjectByName('Gantry-Separator-Gripper')), '隔板夹具缺失');
			const separatorGripper = built.root.getObjectByName('Gantry-Separator-Gripper') as any;
			const separatorBackplate = separatorGripper?.getObjectByName('Gantry-Separator-Gripper-Backplate') as any;
			assert(separatorBackplate instanceof THREE.Mesh && separatorBackplate.geometry instanceof THREE.BoxGeometry, '隔板夹具必须包含实体 Box 背板');
			const separatorBackplateBox = new THREE.Box3().setFromObject(separatorBackplate);
			const separatorBackplateSize = separatorBackplateBox.getSize(new THREE.Vector3());
			assert(separatorBackplateSize.x >= 4.19 && separatorBackplateSize.z >= 3.99, '隔板夹具实体背板必须覆盖 2×3 码垛的 4.2m × 4.0m 平面');
			const separatorBackplateMaterial = Array.isArray(separatorBackplate.material) ? separatorBackplate.material[0] : separatorBackplate.material;
			assert((separatorBackplateMaterial?.opacity ?? 1) === 1 && separatorBackplateMaterial?.transparent !== true, '隔板夹具实体背板不能透明或镂空');
			assert(Boolean(separatorGripper?.getObjectByName('Gantry-Separator-Gripper-Center-Mount')), '隔板夹具缺少中心承力连接座');
			const separatorReinforcements: any[] = [];
			const separatorCupMounts: any[] = [];
			const separatorVacuumCups: any[] = [];
			separatorGripper?.traverse((node: any) => {
				if (node.userData?.separatorGripperReinforcement === true) separatorReinforcements.push(node);
				if (node.userData?.vacuumCupMount === true) separatorCupMounts.push(node);
				if (node.userData?.vacuumCup === true) separatorVacuumCups.push(node);
			});
			assert(separatorReinforcements.length >= 2, '隔板夹具实体背板缺少加强筋');
			assert(separatorCupMounts.length === 6 && separatorVacuumCups.length === 6, '隔板夹具必须保留 6 个吸盘及其安装座');
			for (let index = 0; index < separatorVacuumCups.length; index += 1) {
				const cupBox = new THREE.Box3().setFromObject(separatorVacuumCups[index]);
				const mountBox = new THREE.Box3().setFromObject(separatorCupMounts[index]);
				assert(cupBox.max.y <= separatorBackplateBox.min.y + 0.02, '隔板吸盘必须安装在实体背板下方');
				assert(mountBox.max.y >= separatorBackplateBox.min.y - 0.02 && mountBox.min.y <= cupBox.max.y + 0.02, '隔板吸盘安装座没有形成背板到吸盘的连续连接');
			}
			const separatorStock1 = built.root.getObjectByName('Gantry-Separator-Stock-Platform') as any;
			const separatorStock2 = built.root.getObjectByName('Gantry-Separator-Stock-Platform-02') as any;
			assert(Boolean(separatorStock1) && Boolean(separatorStock2), '隔板暂存台必须有两个');
			assert(Math.abs(separatorStock1.position.z - (-5.6)) <= 0.001, '第一个隔板暂存台没有按要求向 Z- 移动 2m');
			assert(separatorStock2.position.z < separatorStock1.position.z, '第二个隔板暂存台必须位于第一个暂存台的 Z- 方向');
			const stockFeeders = [separatorStock1, separatorStock2].map((stock) => stock.children.filter((child: any) => child.userData?.separatorFeeder === true));
			assert(stockFeeders.every((feeders) => feeders.length === 1), '每个隔板暂存台只能有一类隔板/一组料堆');
			assert(separatorStock1.userData?.separatorCategory === 'A' && separatorStock2.userData?.separatorCategory === 'B', '两个暂存台必须分别存放隔板 A / B');
			assert(separatorStock1.userData?.separatorCategory !== separatorStock2.userData?.separatorCategory, '两个隔板暂存台不能存放同一类别');
			for (const [index, stock] of [separatorStock1, separatorStock2].entries()) {
				const feeder = stockFeeders[index][0] as any;
				assert(Math.abs(feeder.position.x) <= 0.001 && Math.abs(feeder.position.z) <= 0.001, `第 ${index + 1} 个隔板料堆没有居中放在暂存台上`);
				const sheets: any[] = [];
				feeder.traverse((node: any) => { if (node.name?.startsWith('SeparatorSheet-')) sheets.push(node); });
				assert(sheets.length === 5, `第 ${index + 1} 个暂存台应该只有一组 5 张隔板`);
				assert(sheets.every((sheet) => sheet.userData?.separatorCategory === stock.userData?.separatorCategory), `第 ${index + 1} 个暂存台混入了其他类别隔板`);
				for (const sheet of sheets) {
					const sheetSize = new THREE.Box3().setFromObject(sheet).getSize(new THREE.Vector3());
					assert(Math.abs(sheetSize.x - PACKAGING_WOOD_PALLET_LENGTH) <= 0.001 && Math.abs(sheetSize.z - PACKAGING_WOOD_PALLET_WIDTH) <= 0.001, `第 ${index + 1} 个暂存台的隔板尺寸必须与木托盘 ${PACKAGING_WOOD_PALLET_LENGTH}m × ${PACKAGING_WOOD_PALLET_WIDTH}m 一致`);
				}
				const feederBase = feeder.getObjectByName(`FeederBase-${stock.userData?.separatorCategory}`) as any;
				const feederBaseSize = new THREE.Box3().setFromObject(feederBase).getSize(new THREE.Vector3());
				assert(feederBaseSize.x >= PACKAGING_WOOD_PALLET_LENGTH && feederBaseSize.z >= PACKAGING_WOOD_PALLET_WIDTH, `第 ${index + 1} 个暂存台底座不能小于隔板本体`);
			}
			assert(separatorStock1.userData?.underSharedRails === true && separatorStock2.userData?.underSharedRails === true, '两个隔板暂存台都必须位于共享 Z 轨道下方');
			const stockBox1 = new THREE.Box3().setFromObject(separatorStock1);
			const stockBox2 = new THREE.Box3().setFromObject(separatorStock2);
			assert(stockBox2.max.z < stockBox1.min.z + 0.001, '两个隔板暂存台在 Z 方向发生重叠');
			const sharedRailMinZ = Math.min(...railBoxes.map((box) => box.min.z));
			const sharedRailMaxZ = Math.max(...railBoxes.map((box) => box.max.z));
			for (const [index, stockBox] of [stockBox1, stockBox2].entries()) {
				assert(stockBox.min.z >= sharedRailMinZ - 0.001 && stockBox.max.z <= sharedRailMaxZ + 0.001, `第 ${index + 1} 个隔板暂存台超出 Z 轨道覆盖范围`);
			}
		}

		if (resourceKey === 'builtin-top-cover-gantry') {
			const rails: any[] = [];
			const orangeMeshes: any[] = [];
			const yellowMeshes: any[] = [];
			built.root.traverse((node: any) => {
				if (node.userData?.sharedOrangeRail === true || node.userData?.fixedSharedRail === true) rails.push(node);
				const material = Array.isArray(node.material) ? node.material[0] : node.material;
				const color = material?.color?.getHex?.();
				if (color === 0xf97316) orangeMeshes.push(node);
				if (color === 0xfacc15) yellowMeshes.push(node);
			});
			assert(rails.length === 2, '天盖桁架必须且只能有两根共享橙色轨道');
			assert(orangeMeshes.length === 2, '天盖桁架中橙色只能表示两根真实轨道');
			assert(yellowMeshes.length === 0, '天盖桁架不应保留旧黄色轨道或黄色结构');
			assert(rails.every((rail) => rail.userData?.travelAxis === 'z'), '天盖桁架真实轨道必须沿 Z 轴');
			const railBoxes = rails.map((rail) => new THREE.Box3().setFromObject(rail));
			const railSizes = railBoxes.map((box) => box.getSize(new THREE.Vector3()));
			assert(railSizes.every((size) => size.z > size.x * 8), '天盖桁架橙色轨道几何必须明显沿 Z 轴延伸');
			const railCenters = railBoxes.map((box) => box.getCenter(new THREE.Vector3()));
			assert(Math.abs(railCenters[0].x - railCenters[1].x) > 1.0, '天盖桁架两根橙色轨道必须位于不同 X 位置');

			const mainBeams: any[] = [];
			built.root.traverse((node: any) => { if (node.userData?.fixedMainBeam === true) mainBeams.push(node); });
			assert(mainBeams.length === 2, '天盖桁架必须包含两根固定主梁');
			const supportBeams = [built.root.getObjectByName('TopCover-Rail-Support-MainBeam-A'), built.root.getObjectByName('TopCover-Rail-Support-MainBeam-B')] as any[];
			assert(supportBeams.every(Boolean), '天盖桁架缺少深色轨道支撑主梁');
			assert(supportBeams.every((beam) => beam.userData?.isRail === false), '天盖桁架深色主梁不能被标记为轨道');

			const bridge = built.root.getObjectByName('TopCover-Gantry-Bridge') as any;
			const bridgeBeam = built.root.getObjectByName('TopCover-Gantry-Bridge-Beam') as any;
			assert(bridge?.userData?.railMounted === true && bridge?.userData?.travelAxis === 'z', '天盖桥式小车没有挂在 Z 向双轨上');
			const bridgeBox = new THREE.Box3().setFromObject(bridgeBeam);
			const railMinX = Math.min(...railCenters.map((center) => center.x));
			const railMaxX = Math.max(...railCenters.map((center) => center.x));
			assert(bridgeBox.min.x <= railMinX && bridgeBox.max.x >= railMaxX, '天盖桥式小车没有在 X 方向同时跨过两根 Z 向轨道');
			const shoes = [1, 2].map((index) => built.root.getObjectByName(`TopCover-Gantry-Rail-Shoe-${index}`) as any);
			assert(shoes.every((shoe) => shoe?.userData?.railMounted === true), '天盖桥式小车缺少双轨滑靴');
			for (let index = 0; index < 2; index += 1) {
				const shoeBox = new THREE.Box3().setFromObject(shoes[index]);
				const shoeCenter = shoeBox.getCenter(new THREE.Vector3());
				const railCenter = railCenters[index];
				const verticalGap = Math.abs(shoeBox.min.y - railBoxes[index].max.y);
				assert(Math.abs(shoeCenter.x - railCenter.x) <= 0.001, `天盖第 ${index + 1} 个滑靴没有对准对应轨道 X 中心`);
				assert(verticalGap <= 0.011, `天盖第 ${index + 1} 个滑靴与轨道存在悬空间隙: ${verticalGap.toFixed(3)}m`);
			}

			const gripper = built.root.getObjectByName('TopCover-Gantry-Gripper') as any;
			assert(Boolean(gripper), '天盖桁架缺少天盖夹具');
			const backplate = gripper?.getObjectByName('TopCover-Vacuum-Backplate') as any;
			assert(backplate instanceof THREE.Mesh && backplate.geometry instanceof THREE.BoxGeometry, '天盖夹具必须使用实体真空背板');
			const cups: any[] = [];
			const mounts: any[] = [];
			gripper?.traverse((node: any) => {
				if (node.userData?.vacuumCup === true) cups.push(node);
				if (node.userData?.vacuumCupMount === true) mounts.push(node);
			});
			assert(cups.length === 6 && mounts.length === 6, '天盖夹具必须包含 6 个吸盘及其安装座');
			const readyCover = gripper?.getObjectByName('TopCover-Ready') as any;
			assert(Boolean(readyCover), '天盖夹具初始应预抓一块天盖');
			const readyCoverSize = new THREE.Box3().setFromObject(readyCover).getSize(new THREE.Vector3());
			assert(Math.abs(readyCoverSize.x - PACKAGING_WOOD_PALLET_LENGTH) <= 0.001 && Math.abs(readyCoverSize.z - PACKAGING_WOOD_PALLET_WIDTH) <= 0.001, `天盖尺寸必须与木托盘 ${PACKAGING_WOOD_PALLET_LENGTH}m × ${PACKAGING_WOOD_PALLET_WIDTH}m 一致`);
			const topCoverReady = built.root.getObjectByName('TopCover-Ready') as any;
			const topCoverMaterial = Array.isArray(topCoverReady?.material) ? topCoverReady.material[0] : topCoverReady?.material;
			assert(topCoverMaterial?.color?.getHex?.() === 0x9b6a3c, '天盖本体必须是棕色牛皮纸壳');
			assert((topCoverMaterial?.metalness ?? 0) <= 0.01 && (topCoverMaterial?.roughness ?? 0) >= 0.9, '天盖纸壳材质不能呈现金属质感');
			const guide = built.root.getObjectByName('TopCover-Gantry-Z-Guide') as any;
			const slideBar = built.root.getObjectByName('TopCover-Gantry-Z-Slide-Bar') as any;
			const gripperWorldY = gripper.getWorldPosition(new THREE.Vector3()).y;
			assert(new THREE.Box3().setFromObject(guide).min.y > gripperWorldY, '天盖夹具导向轴穿过夹具安装平面');
			assert(new THREE.Box3().setFromObject(slideBar).min.y > gripperWorldY, '天盖夹具升降轴穿过夹具安装平面');

			const stock = built.root.getObjectByName('TopCover-Stock-Table') as any;
			assert(Boolean(stock) && stock.userData?.underSharedRails === true, '天盖暂存台必须位于 Z 向双轨下方');
			const stockBox = new THREE.Box3().setFromObject(stock);
			const railMinZ = Math.min(...railBoxes.map((box) => box.min.z));
			const railMaxZ = Math.max(...railBoxes.map((box) => box.max.z));
			assert(built.root.userData?.zExtensionDirection === 'negative', '天盖桁架必须只向 Z- 方向扩展');
			assert(railMinZ <= -7.3 && railMaxZ <= 2.56, `天盖桁架 Z- 拉伸范围不正确: [${railMinZ.toFixed(2)}, ${railMaxZ.toFixed(2)}]`);
			const stockCenterZ = stockBox.getCenter(new THREE.Vector3()).z;
			assert(stockCenterZ < -4.5, `天盖暂存台没有移到 Z- 延长区: z=${stockCenterZ.toFixed(2)}`);
			assert(stockBox.min.z >= railMinZ - 0.001 && stockBox.max.z <= railMaxZ + 0.001, '天盖暂存台超出 Z 向轨道覆盖范围');
			assert(stockBox.max.y < Math.min(...railBoxes.map((box) => box.min.y)), '天盖暂存台没有真正位于轨道下方');
		}
		if (resourceKey === 'builtin-wrapper-machine') {
			assert(built.root.userData?.wrapperType === 'rotary-arm', '缠膜机必须是悬臂/旋臂式结构');
			assert(built.root.userData?.loadStationary === true, '悬臂缠膜机必须保持托盘货物静止');
			assert(!built.root.getObjectByName('WrapperRing'), '悬臂缠膜机不应保留旧环式 WrapperRing');
			const fixedPosts: any[] = [];
			const topLongitudinals: any[] = [];
			const topCrosses: any[] = [];
			built.root.traverse((node: any) => {
				if (node.userData?.wrapperSupportPost === true) fixedPosts.push(node);
				if (node.userData?.topFrameLongitudinal === true) topLongitudinals.push(node);
				if (node.userData?.topFrameCross === true) topCrosses.push(node);
			});
			assert(built.root.userData?.fourPostFrame === true, '悬臂缠膜机必须使用四立柱刚架');
			assert(fixedPosts.length === 4 && fixedPosts.every((post) => post.userData?.fixedFrame === true), '悬臂缠膜机必须且只能有四根固定立柱');
			const negativeSidePosts = fixedPosts.filter((post) => post.position.z < 0);
			const positiveSidePosts = fixedPosts.filter((post) => post.position.z > 0);
			assert(negativeSidePosts.length === 2 && positiveSidePosts.length === 2, '四根立柱必须在大辊道 Z-/Z+ 两侧各布置两根');
			assert(fixedPosts.every((post) => Math.abs(post.position.z) > PACKAGING_WOOD_PALLET_WIDTH / 2 + 0.30), '悬臂缠膜机立柱侵入大辊道/满托通行包络');
			assert(new Set(negativeSidePosts.map((post) => Math.sign(post.position.x))).size === 2
				&& new Set(positiveSidePosts.map((post) => Math.sign(post.position.x))).size === 2,
			'大辊道每一侧的两根立柱必须分别位于 X- 和 X+ 两端');
			assert(topLongitudinals.length === 2 && topCrosses.length === 2, '四立柱顶部必须形成两纵梁+两横梁的矩形刚架');
			assert(Boolean(built.root.getObjectByName('Wrapper-Frame-Hub-Bridge')), '顶部矩形刚架缺少中央回转中心承力梁');
			const arm = built.root.getObjectByName('Wrapper-Rotary-Arm') as any;
			const cantilever = built.root.getObjectByName('Wrapper-Cantilever-Beam') as any;
			assert(arm?.userData?.rotaryArm === true && arm?.userData?.rotationAxis === 'y', '悬臂没有围绕 Y 轴回转');
			assert(cantilever?.userData?.cantileverArm === true, '悬臂缠膜机缺少真实水平悬臂梁');
			assert(Boolean(built.root.getObjectByName('Wrapper-Rotary-Hub')), '悬臂缠膜机缺少顶部回转驱动中心');
			const mast = built.root.getObjectByName('Wrapper-Film-Mast') as any;
			const carriage = built.root.getObjectByName('Wrapper-Film-Carriage') as any;
			assert(mast?.userData?.orbitsLoad === true, '悬臂末端膜架没有随旋臂绕货物公转');
			assert(carriage?.userData?.travelAxis === 'y' && carriage?.userData?.preStretch === true, '预拉伸膜车必须沿竖直 Y 轴升降');
			assert(Boolean(carriage?.getObjectByName('Wrapper-Film-Roll')), '膜车缺少缠绕膜卷');
			const preStretchRollers: any[] = [];
			carriage?.traverse((node: any) => { if (node.userData?.preStretchRoller === true) preStretchRollers.push(node); });
			assert(preStretchRollers.length === 2, '预拉伸膜车必须包含两根预拉伸辊');
			assert(Boolean(built.root.getObjectByName('Wrapper-Film-Cut-Clamp')), '自动悬臂缠膜机缺少夹膜/断膜单元');
		}
		if (resourceKey === 'builtin-bagging-machine') {
			assert(built.root.userData?.baggingType === 'chemical-fiber-side-seal-film', '套袋机必须升级为化纤连续膜侧封结构');
			assert(built.root.userData?.loadStationary === true && built.root.userData?.sideSeal === true, '侧封膜工位必须定位静止并执行纵向侧封');
			assert(built.root.userData?.nextProcess === 'vacuum-film-tuck', '侧封膜机后续工艺必须明确指向独立真空吸膜工位');
			assert(Array.isArray(built.root.userData?.processSequence) && built.root.userData.processSequence.join(',') === 'positioning,film-feed,wrap,side-seal,cut,release', '侧封膜机内部工艺顺序不完整');
			const baggingConveyor = built.root.getObjectByName('BaggingConveyor') as any;
			assert(Boolean(baggingConveyor) && baggingConveyor.userData?.throughConveyor === true && baggingConveyor.userData?.smallPalletConveyor === true, '侧封膜机缺少贯穿式小托盘辊道');
			const supportPosts: any[] = [];
			built.root.traverse((node: any) => { if (node.userData?.baggingSupportPost === true) supportPosts.push(node); });
			assert(supportPosts.length === 4, '侧封膜机必须使用四立柱主机架');
			const supply = built.root.getObjectByName('Bagging-Film-Supply') as any;
			assert(supply?.userData?.continuousFilmSupply === true, '侧封膜机缺少连续膜供料总成');
			const rolls: any[] = [];
			supply?.traverse((node: any) => { if (node.userData?.filmSupplyRoll === true) rolls.push(node); });
			assert(rolls.length === 2, '连续膜供料必须包含两只膜卷');
			const feed = built.root.getObjectByName('Bagging-Film-Feed-Assembly') as any;
			const guideRollers: any[] = [];
			feed?.traverse((node: any) => { if (node.userData?.filmGuideRoller === true) guideRollers.push(node); });
			assert(feed?.userData?.filmFeedAssembly === true && guideRollers.length === 2, '侧封膜机缺少导膜/送膜辊组');
			assert(Boolean(built.root.getObjectByName('Bagging-Wrap-Guide')) && Boolean(built.root.getObjectByName('Bagging-Film-Sleeve-Preview')), '侧封膜机缺少包覆导向和薄膜预览');
			const seal = built.root.getObjectByName('Bagging-Side-Seal-Unit') as any;
			const sealJaws: any[] = [];
			seal?.traverse((node: any) => { if (node.userData?.sideSealJaw === true) sealJaws.push(node); });
			assert(seal?.userData?.sideSealUnit === true && seal?.userData?.sealDirection === 'longitudinal' && sealJaws.length === 2, '纵向侧封机构必须包含成对封刀');
			assert((built.root.getObjectByName('Bagging-Cut-Knife') as any)?.userData?.filmCutKnife === true, '侧封膜机缺少独立切膜刀');
			assert(Boolean(built.root.getObjectByName('Bagging-Positioning-Stopper')), '侧封膜位缺少到位挡停机构');
			const centering = built.root.getObjectByName('Bagging-Centering-Pusher') as any;
			const centeringPads: any[] = [];
			centering?.traverse((node: any) => { if (node.userData?.centeringPad === true) centeringPads.push(node); });
			assert(centering?.userData?.centeringPusher === true && centeringPads.length === 2, '侧封膜位必须用两侧推板对小托盘/丝饼居中');
			assert(!built.root.getObjectByName('Bagging-Bag-Magazine') && !built.root.getObjectByName('Bagging-Vacuum-Pickup') && !built.root.getObjectByName('Bagging-Bag-Opening-Unit'), '侧封膜机仍残留旧预制袋/真空取袋/四边张袋结构');
			assert(Boolean(built.root.getObjectByName('Bagging-Control-Cabinet')) && Boolean(built.root.getObjectByName('Bagging-HMI')) && Boolean(built.root.getObjectByName('Bagging-Stack-Light')), '侧封膜机缺少电控柜/HMI/三色灯');
		}
		if (resourceKey === 'builtin-vacuum-film-tuck-station') {
			assert(built.root.userData?.stationType === 'vacuum-film-tuck', '吸膜后处理工位语义错误');
			assert(built.root.userData?.palletRemainsOnConveyor === true, '吸膜时小托盘必须留在辊道上');
			assert(built.root.userData?.cakeLiftedFromPallet === true && built.root.userData?.returnCakeToSamePallet === true, '吸膜工位必须把丝饼提起后重新放回同一小托盘');
			const conveyor = built.root.getObjectByName('VacuumTuck-Conveyor') as any;
			assert(conveyor?.userData?.smallPalletConveyor === true, '吸膜工位缺少贯穿式小辊道');
			const lift = built.root.getObjectByName('VacuumTuck-Cake-Lift') as any;
			assert(lift?.userData?.travelAxis === 'y' && lift?.userData?.liftsCakeOnly === true, '丝饼提升机构必须沿 Y 轴只提升丝饼');
			const gripper = built.root.getObjectByName('VacuumTuck-Core-Gripper') as any;
			assert(gripper?.userData?.gripMethod === 'internal-core-expansion' && gripper?.userData?.jawCount === 3, '丝饼必须使用纸管内孔三爪涨紧夹具');
			const jaws: any[] = [];
			gripper?.traverse((node: any) => { if (node.userData?.coreExpansionJaw === true) jaws.push(node); });
			assert(jaws.length === 3, '内孔夹具必须有 3 个涨紧夹爪');
			const vacuum = built.root.getObjectByName('VacuumTuck-Vacuum-System') as any;
			assert(vacuum?.userData?.negativePressureFilmSuction === true, '吸膜工位缺少下方负压吸膜系统');
			const mouth = vacuum?.getObjectByName('VacuumTuck-Suction-Mouth') as any;
			assert(mouth?.userData?.vacuumMouth === true && mouth?.userData?.suctionDirection === 'downward-inward', '真空吸膜口必须从丝饼下方向内抽吸薄膜');
			assert(mouth?.userData?.requiresPalletCenterPassThrough === true, '吸膜口必须与小托盘中心真空通道对正');
			assert(Boolean(vacuum?.getObjectByName('VacuumTuck-Vacuum-Blower')), '吸膜工位缺少真空泵/风机箱');
			assert(Boolean(built.root.getObjectByName('VacuumTuck-Pallet-Stopper')), '吸膜工位缺少小托盘定位挡停');
			assert(Boolean(built.root.getObjectByName('VacuumTuck-Control-Cabinet')) && Boolean(built.root.getObjectByName('VacuumTuck-HMI')) && Boolean(built.root.getObjectByName('VacuumTuck-Stack-Light')), '吸膜工位缺少电控柜/HMI/三色灯');
		}
		if (resourceKey === 'builtin-labeling-machine') {
			assert(built.root.userData?.labelerType === 'pallet-print-apply', '贴标机必须是托盘打印贴标机结构');
			assert(built.root.userData?.loadStationary === true, '托盘贴标时货物必须保持静止');
			assert(built.root.userData?.articulatedArmJoints === 3, '托盘贴标机必须使用三关节电动臂');
			assert(!built.root.getObjectByName('LabelPortal') && !built.root.getObjectByName('LabelHead'), '贴标机仍残留旧门架/固定贴标头结构');
			assert(Boolean(built.root.getObjectByName('Labeler-Floor-Stand')), '托盘贴标机缺少落地支架');
			const printer = built.root.getObjectByName('Labeler-Printer-Module') as any;
			assert(Boolean(printer?.getObjectByName('Labeler-Printer-Body')), '托盘贴标机缺少打印机主体');
			assert(Boolean(printer?.getObjectByName('Labeler-Label-Supply-Roll')), '托盘贴标机缺少标签卷');
			assert(Boolean(printer?.getObjectByName('Labeler-HMI-Screen')), '托盘贴标机缺少操作屏');
			const joints = [1, 2, 3].map((index) => built.root.getObjectByName(`Labeler-Arm-Joint-${index}`) as any);
			assert(joints.every(Boolean), '托盘贴标机三关节电动臂结构不完整');
			assert(joints.every((joint, index) => joint.userData?.electricJoint === true && joint.userData?.jointIndex === index + 1), '托盘贴标机电动关节语义错误');
			assert(joints.every((joint) => joint.userData?.collisionDetection === true), '托盘贴标机三关节臂没有碰撞检测语义');
			const pad = built.root.getObjectByName('Labeler-Tamp-Pad') as any;
			assert(pad?.userData?.applyMethod === 'electric-tamp', '托盘贴标机末端不是电动 Tamp 贴标板');
			assert(Boolean(pad?.getObjectByName('Labeler-Ready-Label')), '贴标板上没有待贴标签');
			const camera = pad?.getObjectByName('Labeler-Code-Verification-Camera') as any;
			assert(camera?.userData?.codeVerification === '1d-2d', '贴标板缺少 1D/2D 码校验摄像头');
			assert(Array.isArray(built.root.userData?.supportedLabelSides) && built.root.userData.supportedLabelSides.length === 3, '托盘贴标机没有支持前/侧/后三面贴标');
			assert(Number(built.root.userData?.maxProductDistanceMeters || 0) >= 0.59, '托盘贴标机机械臂伸出距离不足 600mm 级别');
		}
	} finally { built.dispose(); }
}

const copySource = createStudioPart('component', 0);
copySource.name = '复制测试组件';
copySource.transform.position = [1, 2, 3];
copySource.source = { component: {
	resourceKey: 'builtin-silk-gantry',
	componentType: 'silk-gantry',
	generator: 'silk-gantry-v1',
	generatorVersion: 1,
	properties: { length: 8.2, nested: { value: 1 } },
	propertySchema: [],
	structuralOverrides: { hiddenNodeKeys: ['node-a'], nodeTransforms: {} },
} };
const pastedCopy = cloneStudioPartForPaste(copySource);
assert(pastedCopy.id !== copySource.id, '组件设计器粘贴后必须生成新的 part.id');
assert(pastedCopy.name === '复制测试组件 副本', '组件设计器粘贴副本名称错误');
assert(pastedCopy.transform.position[0] === 1.3 && pastedCopy.transform.position[1] === 2 && pastedCopy.transform.position[2] === 3.3, '组件设计器粘贴后没有按约定错开位置');
assert(pastedCopy.source?.component?.resourceKey === 'builtin-silk-gantry', '组件设计器复制后丢失 component resourceKey');
(pastedCopy.source!.component!.properties.nested as any).value = 9;
assert((copySource.source!.component!.properties.nested as any).value === 1, '组件设计器复制没有深拷贝 component properties');
pastedCopy.source!.component!.structuralOverrides!.hiddenNodeKeys.push('node-b');
assert(copySource.source!.component!.structuralOverrides!.hiddenNodeKeys.length === 1, '组件设计器复制没有深拷贝 generated-node overrides');
const multiSourceA = createStudioPart('box', 0);
multiSourceA.transform.position = [1, 0, 2];
const multiSourceB = createStudioPart('box', 1);
multiSourceB.transform.position = [4, 0, 7];
const multiCopies = cloneStudioPartsForPaste([multiSourceA, multiSourceB]);
assert(multiCopies.length === 2, '组件设计器批量粘贴数量错误');
assert(multiCopies[0].id !== multiSourceA.id && multiCopies[1].id !== multiSourceB.id && multiCopies[0].id !== multiCopies[1].id, '组件设计器批量粘贴必须为每个零件生成独立新 ID');
assert(multiCopies[0].transform.position[0] === 1.3 && multiCopies[0].transform.position[2] === 2.3 && multiCopies[1].transform.position[0] === 4.3 && multiCopies[1].transform.position[2] === 7.3, '组件设计器批量粘贴没有统一应用 0.3m 偏移');
assert((multiCopies[1].transform.position[0] - multiCopies[0].transform.position[0]) === 3 && (multiCopies[1].transform.position[2] - multiCopies[0].transform.position[2]) === 5, '组件设计器批量粘贴破坏了零件相对位置');
multiCopies[0].geometry.width = 99;
assert(multiSourceA.geometry.width !== 99, '组件设计器批量粘贴不是深拷贝');

const versionedDefinition = createComponentDefinitionFromTemplate('builtin-small-roller-conveyor', { objectId: 'version-replay' });
const replayA = defaultComponentRegistry.create(versionedDefinition);
const replayB = defaultComponentRegistry.create(structuredClone(versionedDefinition));
try {
	const snapshot = (built: typeof replayA) => JSON.stringify({
		ports: built.ports,
		size: [built.bounds.max.x - built.bounds.min.x, built.bounds.max.y - built.bounds.min.y, built.bounds.max.z - built.bounds.min.z],
	});
	assert(snapshot(replayA) === snapshot(replayB), '同一 Generator 版本重放必须生成相同 Port / Bounds');
} finally { replayA.dispose(); replayB.dispose(); }
let unsupportedGeneratorRejected = false;
try { defaultComponentRegistry.create({ ...versionedDefinition, generatorVersion: 999 }); }
catch (error) { unsupportedGeneratorRejected = String(error).includes('@999'); }
assert(unsupportedGeneratorRejected, '不存在的 GeneratorVersion 必须明确拒绝');

const migrationRegistry = new ComponentMigrationRegistry().register({
	generator: smallTemplate.generator,
	fromVersion: 1,
	toVersion: 2,
	migrate: (properties) => ({ ...properties, migratedToV2: true }),
});
assert(migrationRegistry.migrate(smallTemplate.generator, 1, 2, {}).migratedToV2 === true, '组件属性显式迁移链未生效');

const silkManifest = createSilkCakeLineTwinSceneManifest();
const silkMigration = migrateSilkLineInfrastructureToV7(silkManifest);
assert(silkMigration.migrated && silkMigration.migrationVersion === SILK_V7_MIGRATION_VERSION, '丝饼线 V2 基础设施迁移未执行');
const silkComponentIds = new Set(silkManifest.objects.filter((item) => item.kind === 'component').map((item) => item.objectId));
for (const route of silkManifest.routes.filter((item) => ['silk-cake-line-main', 'silk-wood-packaging-route'].includes(item.routeId))) {
	for (const edge of route.edges) assert(silkComponentIds.has(`v7-${edge.edgeId}`), `丝饼线输送段未完成组件化: ${edge.edgeId}`);
}
assert(hasCompleteSilkV7Infrastructure(silkManifest), '丝饼线 V7 基础设施完整性检查未通过');
const silkObjectCount = silkManifest.objects.length;
const repeatedSilkMigration = migrateSilkLineInfrastructureToV7(silkManifest);
assert(!repeatedSilkMigration.migrated && silkManifest.objects.length === silkObjectCount, '丝饼线 V2 迁移必须幂等');

const connectedManifest = createManifest(
	createSmallRoller('Conveyor01', 0),
	createSmallRoller('Conveyor02', 3.3),
	createSmallRoller('Conveyor03', 20),
);
const firstCandidate = findBestComponentSnap(connectedManifest, 'Conveyor02', { maxDistance: 0.5, maxAngleDegrees: 15 });
assert(firstCandidate, '0.5m / 15° 范围内未找到吸附候选');
assert(snapAndConnectNearestComponent(connectedManifest, 'Conveyor02', { maxDistance: 0.5, maxAngleDegrees: 15 }), 'Conveyor01 → Conveyor02 自动吸附失败');
connectedManifest.objects[2].transform.position = [6.3, 0, 0];
const thirdCandidate = findBestComponentSnap(connectedManifest, 'Conveyor03', { maxDistance: 0.5, maxAngleDegrees: 15 });
assert(thirdCandidate, `Conveyor02 → Conveyor03 未找到吸附候选：${JSON.stringify(connectedManifest.objects.map((item) => ({ id: item.objectId, position: item.transform.position })))}`);
assert(snapAndConnectNearestComponent(connectedManifest, 'Conveyor03', { maxDistance: 0.5, maxAngleDegrees: 15 }), 'Conveyor02 → Conveyor03 自动吸附失败');
assert(connectedManifest.connections?.length === 2, '三段辊道应持久化两条 Connection');
const graph = upsertGeneratedComponentRoute(connectedManifest);
assert(graph?.route.generatedBy === 'component-connections', '自动路线没有 generatedBy 只读标识');
assert(graph?.route.edges.length === 3, 'C1 → C2 → C3 应生成三个独立 Section');
assert(graph?.route.points.length === 4, '三段串联辊道应将相接端口合并成四个路线节点');
assert(graph?.route.points.every((point) => point.authoring?.mode === 'generated' && point.authoring.locked === true), '组件自动 RoutePoint 没有 generated/locked authoring 标识');
assert(graph?.route.edges.every((edge) => edge.authoring?.mode === 'generated' && edge.authoring.locked === true), '组件自动 RouteEdge 没有 generated/locked authoring 标识');

// 双路线 Phase 1：旧路线缺少 authoring 仍按 generated 归一；新手工段可与自动段共存，并在组件 Route 重建后稳定保留。
const legacyAuthoringRoute = structuredClone(graph!.route);
for (const point of legacyAuthoringRoute.points) delete point.authoring;
for (const edge of legacyAuthoringRoute.edges) delete edge.authoring;
const normalizedLegacyAuthoringRoute = normalizeTwinRoute(legacyAuthoringRoute);
assert(normalizedLegacyAuthoringRoute.points.every((point) => point.authoring?.mode === 'generated'), '旧 RoutePoint 缺少 authoring 时没有兼容为 generated');
assert(normalizedLegacyAuthoringRoute.edges.every((edge) => edge.authoring?.mode === 'generated'), '旧 RouteEdge 缺少 authoring 时没有兼容为 generated');

const generatedRouteWithManual = connectedManifest.routes.find((item) => item.generatedBy === 'component-connections')!;
const outgoingGeneratedPointIds = new Set(generatedRouteWithManual.edges.filter((edge) => edge.authoring?.mode === 'generated').map((edge) => edge.fromPointId));
const generatedTail = generatedRouteWithManual.points.find((point) => point.authoring?.mode === 'generated' && !outgoingGeneratedPointIds.has(point.pointId))!;
assert(Boolean(generatedTail), '双路线 Phase 1 未找到组件自动路线末端');
const manualPoint = createRoutePoint([generatedTail.position[0] + 2, generatedTail.position[1], generatedTail.position[2]], generatedRouteWithManual.points.length);
manualPoint.name = 'Phase1 Manual Bridge';
manualPoint.authoring = { mode: 'manual', locked: false };
const manualEdge = createRouteEdge(generatedTail.pointId, manualPoint.pointId, generatedRouteWithManual.edges.length);
manualEdge.name = 'Phase1 Manual Edge';
manualEdge.authoring = { mode: 'manual', locked: false };
generatedRouteWithManual.points.push(manualPoint);
generatedRouteWithManual.edges.push(manualEdge);
const manualPointSnapshot = structuredClone(manualPoint);
upsertGeneratedComponentRoutes(connectedManifest);
const rebuiltMixedRoute = connectedManifest.routes.find((item) => item.routeId === generatedRouteWithManual.routeId)!;
assert(rebuiltMixedRoute.points.some((point) => point.pointId === manualPoint.pointId && point.authoring?.mode === 'manual'), '组件自动路线重建删除了 Manual RoutePoint');
assert(rebuiltMixedRoute.edges.some((edge) => edge.edgeId === manualEdge.edgeId && edge.authoring?.mode === 'manual'), '组件自动路线重建删除了 Manual RouteEdge');
assert(JSON.stringify(rebuiltMixedRoute.points.find((point) => point.pointId === manualPoint.pointId)) === JSON.stringify(manualPointSnapshot), '组件自动路线重建改变了 Manual RoutePoint ID/几何/元数据');
const rebuiltMixedPath = resolveRoutePath({ ...rebuiltMixedRoute, startPointId: graph!.route.startPointId }, {});
assert(rebuiltMixedPath.edgeIds.includes(manualEdge.edgeId), 'RouteEngine 没有沿统一 Route Graph 从 Generated 段继续进入 Manual 段');

// 纯数据编译验收：Generated A.Output → Manual Route → Generated B.Input/内部段最终仍是一张标准 Route Graph。
const phase1A = { ...createRoutePoint([0, 0.8, 0], 0), pointId: 'phase1-a-output', name: 'Conveyor A.Output', authoring: { mode: 'generated' as const, sourceObjectId: 'ConveyorA', sourcePortId: 'output', locked: true } };
const phase1Manual = { ...createRoutePoint([2, 0.8, 0], 1), pointId: 'phase1-manual', name: 'Manual Route Point', authoring: { mode: 'manual' as const, locked: false } };
const phase1B = { ...createRoutePoint([4, 0.8, 0], 2), pointId: 'phase1-b-input', name: 'Conveyor B.Input', authoring: { mode: 'generated' as const, sourceObjectId: 'ConveyorB', sourcePortId: 'input', locked: true } };
const phase1BExit = { ...createRoutePoint([6, 0.8, 0], 3), pointId: 'phase1-b-output', name: 'Conveyor B.Output', authoring: { mode: 'generated' as const, sourceObjectId: 'ConveyorB', sourcePortId: 'output', locked: true } };
const phase1ManualA = { ...createRouteEdge(phase1A.pointId, phase1Manual.pointId, 0), edgeId: 'phase1-manual-a', authoring: { mode: 'manual' as const, locked: false } };
const phase1ManualB = { ...createRouteEdge(phase1Manual.pointId, phase1B.pointId, 1), edgeId: 'phase1-manual-b', authoring: { mode: 'manual' as const, locked: false } };
const phase1GeneratedB = { ...createRouteEdge(phase1B.pointId, phase1BExit.pointId, 2), edgeId: 'phase1-generated-b', authoring: { mode: 'generated' as const, sourceObjectId: 'ConveyorB', sourceInternalFlowId: 'main', locked: true } };
const phase1Compiled = compileRouteAuthoringGraph([{
	routeId: 'phase1-unified', name: 'Phase1 Unified Route', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [phase1A, phase1Manual, phase1B, phase1BExit], edges: [phase1ManualA, phase1ManualB, phase1GeneratedB], startPointId: phase1A.pointId,
	junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
}]);
assert(phase1Compiled.diagnostics.every((item) => item.severity !== 'error'), `双路线 Phase 1 编译出现错误：${JSON.stringify(phase1Compiled.diagnostics)}`);
assert(phase1Compiled.sourceMap.filter((item) => item.authoringMode === 'manual').length === 2 && phase1Compiled.sourceMap.some((item) => item.authoringMode === 'generated'), 'RouteAuthoringCompiler 没有保留 Generated/Manual SourceMap');
const phase1Resolved = resolveRoutePath(phase1Compiled.routes[0], {});
assert(phase1Resolved.edgeIds.join('|') === 'phase1-manual-a|phase1-manual-b|phase1-generated-b', `Generated → Manual → Generated 没有形成统一运行路径：${phase1Resolved.edgeIds.join('|')}`);

// 双路线 Phase 2：Manual Route 两端可吸附 Component Port，组件移动只带动 hard-attached Endpoint，中间手工点保持不动。
const phase2Manifest = createManifest(createSmallRoller('Phase2ConveyorA', 0), createSmallRoller('Phase2ConveyorB', 8));
upsertGeneratedComponentRoutes(phase2Manifest);
const phase2ObjectA = phase2Manifest.objects.find((item) => item.objectId === 'Phase2ConveyorA') as TwinV7SceneObjectDefinition;
const phase2ObjectB = phase2Manifest.objects.find((item) => item.objectId === 'Phase2ConveyorB') as TwinV7SceneObjectDefinition;
const phase2OutputA = resolveComponentPorts(phase2ObjectA).find((port) => port.type === 'material-output')!;
const phase2InputB = resolveComponentPorts(phase2ObjectB).find((port) => port.type === 'material-input')!;
assert(Boolean(phase2OutputA && phase2InputB), 'Phase2 测试辊道缺少 input/output Port');
const phase2Start = { ...createRoutePoint([phase2OutputA.worldPosition.x + 0.15, phase2OutputA.worldPosition.y, phase2OutputA.worldPosition.z], 0), pointId: 'phase2-manual-start', authoring: { mode: 'manual' as const, locked: false } };
const phase2Middle = { ...createRoutePoint([(phase2OutputA.worldPosition.x + phase2InputB.worldPosition.x) / 2, phase2OutputA.worldPosition.y, phase2OutputA.worldPosition.z], 1), pointId: 'phase2-manual-middle', authoring: { mode: 'manual' as const, locked: false } };
const phase2End = { ...createRoutePoint([phase2InputB.worldPosition.x - 0.15, phase2InputB.worldPosition.y, phase2InputB.worldPosition.z], 2), pointId: 'phase2-manual-end', authoring: { mode: 'manual' as const, locked: false } };
const phase2EdgeA = { ...createRouteEdge(phase2Start.pointId, phase2Middle.pointId, 0), edgeId: 'phase2-manual-edge-a', authoring: { mode: 'manual' as const, locked: false } };
const phase2EdgeB = { ...createRouteEdge(phase2Middle.pointId, phase2End.pointId, 1), edgeId: 'phase2-manual-edge-b', authoring: { mode: 'manual' as const, locked: false } };
phase2Manifest.routes.push({
	routeId: 'phase2-manual-route', name: 'Phase2 Manual Route', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [phase2Start, phase2Middle, phase2End], edges: [phase2EdgeA, phase2EdgeB], startPointId: phase2Start.pointId,
	junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
});
const phase2StartOptions = listRouteEndpointPortSnapOptions(phase2Manifest, 'phase2-manual-route', phase2Start.pointId);
const phase2EndOptions = listRouteEndpointPortSnapOptions(phase2Manifest, 'phase2-manual-route', phase2End.pointId);
assert(phase2StartOptions.some((item) => item.objectId === phase2ObjectA.objectId && item.portId === phase2OutputA.portId), 'Phase2 Port 下拉没有为 Manual 起点列出 Conveyor A.Output');
assert(phase2EndOptions.some((item) => item.objectId === phase2ObjectB.objectId && item.portId === phase2InputB.portId), 'Phase2 Port 下拉没有为 Manual 终点列出 Conveyor B.Input');
assert(Boolean(attachRoutePointToPort(phase2Manifest, 'phase2-manual-route', phase2Start.pointId, phase2ObjectA.objectId, phase2OutputA.portId)), 'Phase2 Manual 起点吸附 Conveyor A.Output 失败');
assert(Boolean(attachRoutePointToPort(phase2Manifest, 'phase2-manual-route', phase2End.pointId, phase2ObjectB.objectId, phase2InputB.portId)), 'Phase2 Manual 终点吸附 Conveyor B.Input 失败');
const phase2RouteBeforeMove = phase2Manifest.routes.find((item) => item.routeId === 'phase2-manual-route')!;
const phase2AttachedStartBefore = structuredClone(phase2RouteBeforeMove.points.find((item) => item.pointId === phase2Start.pointId)!);
const phase2AttachedEndBefore = structuredClone(phase2RouteBeforeMove.points.find((item) => item.pointId === phase2End.pointId)!);
const phase2MiddleBefore = structuredClone(phase2RouteBeforeMove.points.find((item) => item.pointId === phase2Middle.pointId)!);
phase2ObjectB.transform.position[0] += 1;
upsertGeneratedComponentRoutes(phase2Manifest);
const phase2RouteAfterMove = phase2Manifest.routes.find((item) => item.routeId === 'phase2-manual-route')!;
const phase2AttachedStartAfter = phase2RouteAfterMove.points.find((item) => item.pointId === phase2Start.pointId)!;
const phase2AttachedEndAfter = phase2RouteAfterMove.points.find((item) => item.pointId === phase2End.pointId)!;
const phase2MiddleAfter = phase2RouteAfterMove.points.find((item) => item.pointId === phase2Middle.pointId)!;
assert(Math.abs(phase2AttachedStartAfter.position[0] - phase2AttachedStartBefore.position[0]) < 0.0001, '移动 Conveyor B 时错误带动了吸附在 Conveyor A.Output 的 Manual 起点');
assert(Math.abs((phase2AttachedEndAfter.position[0] - phase2AttachedEndBefore.position[0]) - 1) < 0.0001, 'Conveyor B 移动 1m 后 Manual 终点没有跟随 B.Input 移动 1m');
assert(JSON.stringify(phase2MiddleAfter.position) === JSON.stringify(phase2MiddleBefore.position), '组件移动错误改变了 Manual Route 中间节点');
assert(phase2AttachedEndAfter.attachment?.objectId === phase2ObjectB.objectId && phase2AttachedEndAfter.attachment?.portId === phase2InputB.portId && phase2AttachedEndAfter.attachment?.snapMode === 'hard', '组件重建后 Manual Endpoint Attachment 丢失');
assert(phase2AttachedEndAfter.pointId === phase2End.pointId && phase2RouteAfterMove.edges.some((edge) => edge.edgeId === phase2EdgeB.edgeId), '组件移动后 Manual Route 稳定 ID 被改变');
assert(detachRoutePointFromPort(phase2Manifest, 'phase2-manual-route', phase2End.pointId), 'Phase2 Manual Endpoint 解除 Port 吸附失败');
assert(!phase2RouteAfterMove.points.find((item) => item.pointId === phase2End.pointId)?.attachment, 'Phase2 解除吸附后 attachment 仍残留');

// 双路线 Phase 3：Generated → Manual 转换保持全部 Runtime ID / Binding / Section，不再被组件重建覆盖。
const phase3Manifest = createManifest(createSmallRoller('Phase3A', 0), createSmallRoller('Phase3B', 3.3));
assert(snapAndConnectNearestComponent(phase3Manifest, 'Phase3B', { maxDistance: 0.5, maxAngleDegrees: 15 }), 'Phase3 两段辊道自动连接失败');
const phase3Graph = upsertGeneratedComponentRoute(phase3Manifest)!.route;
const phase3EdgeBefore = phase3Graph.edges[0];
phase3EdgeBefore.releasePermitBindingId = 'phase3-release-permit';
phase3EdgeBefore.readyBindingId = 'phase3-ready';
phase3EdgeBefore.sectionId = 'phase3-section-stable';
const phase3IdsBefore = { routeId: phase3Graph.routeId, pointIds: phase3Graph.points.map((item) => item.pointId), edgeIds: phase3Graph.edges.map((item) => item.edgeId) };
const phase3Converted = convertGeneratedRouteToManual(phase3Graph);
phase3Manifest.routes.splice(phase3Manifest.routes.findIndex((item) => item.routeId === phase3Graph.routeId), 1, phase3Converted.route);
assert(phase3Converted.route.routeId === phase3IdsBefore.routeId, 'Generated→Manual 转换改变了 routeId');
assert(JSON.stringify(phase3Converted.route.points.map((item) => item.pointId)) === JSON.stringify(phase3IdsBefore.pointIds), 'Generated→Manual 转换改变了 pointId');
assert(JSON.stringify(phase3Converted.route.edges.map((item) => item.edgeId)) === JSON.stringify(phase3IdsBefore.edgeIds), 'Generated→Manual 转换改变了 edgeId');
const phase3ConvertedEdge = phase3Converted.route.edges.find((item) => item.edgeId === phase3EdgeBefore.edgeId)!;
assert(phase3ConvertedEdge.authoring?.mode === 'manual' && phase3ConvertedEdge.authoring.convertedFromGenerated === true && phase3ConvertedEdge.authoring.locked === false, '转换后的 generated Edge 没有成为可编辑 Manual override');
assert(phase3ConvertedEdge.releasePermitBindingId === 'phase3-release-permit' && phase3ConvertedEdge.readyBindingId === 'phase3-ready' && phase3ConvertedEdge.sectionId === 'phase3-section-stable', '转换时丢失 Binding/Section');
const phase3GeometryBefore = JSON.stringify(phase3Converted.route.points.map((item) => item.position));
(phase3Manifest.objects.find((item) => item.objectId === 'Phase3B') as TwinV7SceneObjectDefinition).transform.position[0] += 1;
upsertGeneratedComponentRoutes(phase3Manifest);
const phase3AfterRebuild = phase3Manifest.routes.find((item) => item.routeId === phase3IdsBefore.routeId)!;
assert(JSON.stringify(phase3AfterRebuild.points.map((item) => item.position)) === phase3GeometryBefore, 'Converted Manual Route 又被组件移动/自动重建覆盖');
assert(phase3AfterRebuild.edges.find((item) => item.edgeId === phase3EdgeBefore.edgeId)?.releasePermitBindingId === 'phase3-release-permit', 'Converted Manual Route 重建后 Binding 丢失');

// Route Section：名称可变、ID 稳定；Edge 永远引用稳定 sectionId。
const phase4Section = ensureRouteSection(phase3AfterRebuild, '外检空托回流', 'section-empty-return-stable');
const phase4SectionId = phase4Section.sectionId;
assert(renameRouteSection(phase3AfterRebuild, phase4SectionId, '外检后空托独立回流'), 'Route Section 改名失败');
assert(phase3AfterRebuild.sections?.find((item) => item.sectionId === phase4SectionId)?.name === '外检后空托独立回流' && phase4SectionId === 'section-empty-return-stable', 'Route Section 改名改变了稳定 ID');

// Phase 4：三个独立 Authoring Route 通过 hard Port Attachment 编译成一张统一 Runtime Graph。
const phase4GeneratedA: TwinRouteDefinition = {
	routeId: 'phase4-generated-a', name: 'Generated A', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([0, 0.8, 0], 0), pointId: 'phase4-a-in', authoring: { mode: 'generated', sourceObjectId: 'P4A', sourcePortId: 'input', locked: true } },
		{ ...createRoutePoint([2, 0.8, 0], 1), pointId: 'phase4-a-out', authoring: { mode: 'generated', sourceObjectId: 'P4A', sourcePortId: 'output', locked: true } },
	],
	edges: [{ ...createRouteEdge('phase4-a-in', 'phase4-a-out', 0), edgeId: 'phase4-edge-a', authoring: { mode: 'generated', sourceObjectId: 'P4A', sourceInternalFlowId: 'main', locked: true } }],
	startPointId: 'phase4-a-in', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
};
const phase4Manual: TwinRouteDefinition = {
	routeId: 'phase4-manual', name: 'Manual Bridge', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([2, 0.8, 0], 0), pointId: 'phase4-manual-start', attachment: { objectId: 'P4A', portId: 'output', role: 'entry', snapMode: 'hard' } },
		{ ...createRoutePoint([4, 0.8, 1], 1), pointId: 'phase4-manual-mid' },
		{ ...createRoutePoint([6, 0.8, 0], 2), pointId: 'phase4-manual-end', attachment: { objectId: 'P4B', portId: 'input', role: 'exit', snapMode: 'hard' } },
	],
	edges: [
		{ ...createRouteEdge('phase4-manual-start', 'phase4-manual-mid', 0), edgeId: 'phase4-manual-edge-1' },
		{ ...createRouteEdge('phase4-manual-mid', 'phase4-manual-end', 1), edgeId: 'phase4-manual-edge-2' },
	],
	startPointId: 'phase4-manual-start', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
};
const phase4GeneratedB: TwinRouteDefinition = {
	routeId: 'phase4-generated-b', name: 'Generated B', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([6, 0.8, 0], 0), pointId: 'phase4-b-in', authoring: { mode: 'generated', sourceObjectId: 'P4B', sourcePortId: 'input', locked: true } },
		{ ...createRoutePoint([8, 0.8, 0], 1), pointId: 'phase4-b-out', authoring: { mode: 'generated', sourceObjectId: 'P4B', sourcePortId: 'output', locked: true } },
	],
	edges: [{ ...createRouteEdge('phase4-b-in', 'phase4-b-out', 0), edgeId: 'phase4-edge-b', authoring: { mode: 'generated', sourceObjectId: 'P4B', sourceInternalFlowId: 'main', locked: true } }],
	startPointId: 'phase4-b-in', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
};
const phase4Compile = compileRouteAuthoringGraph([phase4GeneratedA, phase4Manual, phase4GeneratedB]);
assert(phase4Compile.diagnostics.every((item) => item.severity !== 'error'), `Phase4 Graph Merge 出现错误：${JSON.stringify(phase4Compile.diagnostics)}`);
assert(phase4Compile.routes.length === 1, `Port Attachment 没有把三条 Authoring Route 合并成一张 Runtime Graph：${phase4Compile.routes.length}`);
const phase4RuntimeRoute = phase4Compile.routes[0];
assert(!phase4RuntimeRoute.points.some((item) => item.pointId === 'phase4-manual-start' || item.pointId === 'phase4-manual-end'), 'Endpoint Merge 后重复 Manual Port Point 仍留在 Runtime Graph');
assert(phase4RuntimeRoute.edges.find((item) => item.edgeId === 'phase4-manual-edge-1')?.fromPointId === 'phase4-a-out' && phase4RuntimeRoute.edges.find((item) => item.edgeId === 'phase4-manual-edge-2')?.toPointId === 'phase4-b-in', 'Endpoint Merge 没有把 Manual Edge 归一到 Generated Port Point');
assert(phase4Compile.routeAliases['phase4-manual'] === 'phase4-generated-a' && phase4Compile.routeAliases['phase4-generated-b'] === 'phase4-generated-a', '跨 Route 合并没有生成稳定 route alias');
const phase4Resolved = resolveRoutePath(phase4RuntimeRoute, {});
assert(phase4Resolved.edgeIds.join('|') === 'phase4-edge-a|phase4-manual-edge-1|phase4-manual-edge-2|phase4-edge-b', `统一 Runtime Graph 不能连续通过 Generated→Manual→Generated：${phase4Resolved.edgeIds.join('|')}`);
assert(phase4Compile.sourceMap.some((item) => item.runtimeEdgeId === 'phase4-manual-edge-1' && item.authoringMode === 'manual') && phase4Compile.sourceMap.some((item) => item.runtimeEdgeId === 'phase4-edge-b' && item.authoringMode === 'generated'), 'Phase4 SourceMap 没有保留 Generated/Manual 来源');

// routeGraph 随草稿固化；发布 Runtime 使用固化副本，不受随后 authoring route 临时变化影响。
const phase4PersistManifest = createDefaultTwinSceneManifest();
phase4PersistManifest.routes = [phase4GeneratedA, phase4Manual, phase4GeneratedB];
const phase4PersistCompile = persistCompiledRouteGraph(phase4PersistManifest);
assert(phase4PersistManifest.routeGraph?.compilerVersion === 1 && phase4PersistManifest.routeGraph.routes.length === 1, 'Compiled routeGraph 没有随 Manifest 固化');
phase4PersistManifest.routes[0].edges[0].name = 'authoring-after-publish-change';
const phase4PublishedRuntime = createPublishedRuntimeManifest(phase4PersistManifest).manifest;
assert(phase4PublishedRuntime.routes[0].edges[0].name !== 'authoring-after-publish-change', 'Published Runtime 又临时从 Authoring Route 重编译，没有使用不可变 routeGraph');
const phase4DraftRuntime = createCompiledRuntimeManifest(phase4PersistManifest).manifest;
assert(phase4DraftRuntime.routes.length === phase4PersistCompile.routes.length, 'Draft Runtime 没有使用统一 RouteAuthoringCompiler');

// Authoring Validator：普通 Input 被多个外部流占用必须报错；不能静默生成错误拓扑。
const phase4InvalidManifest = createManifest(createSmallRoller('Phase4Target', 10));
const phase4Target = phase4InvalidManifest.objects[0] as TwinV7SceneObjectDefinition;
const phase4TargetInput = resolveComponentPorts(phase4Target).find((item) => item.type === 'material-input')!;
const duplicateExitRoute = (routeId: string, suffix: string, z: number): TwinRouteDefinition => ({
	routeId, name: routeId, type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([6, phase4TargetInput.worldPosition.y, z], 0), pointId: `phase4-${suffix}-start` },
		{ ...createRoutePoint([phase4TargetInput.worldPosition.x, phase4TargetInput.worldPosition.y, phase4TargetInput.worldPosition.z], 1), pointId: `phase4-${suffix}-end`, attachment: { objectId: phase4Target.objectId, portId: phase4TargetInput.portId, role: 'exit', snapMode: 'hard' } },
	],
	edges: [{ ...createRouteEdge(`phase4-${suffix}-start`, `phase4-${suffix}-end`, 0), edgeId: `phase4-${suffix}-edge` }],
	startPointId: `phase4-${suffix}-start`, junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
});
phase4InvalidManifest.routes = [duplicateExitRoute('phase4-invalid-a', 'invalid-a', 0), duplicateExitRoute('phase4-invalid-b', 'invalid-b', 1)];
assert(validateRouteAuthoringManifest(phase4InvalidManifest).some((item) => item.code === 'route.authoring.port.input-multiple' && item.severity === 'error'), 'RouteAuthoringValidator 没有阻止普通 Input 多路占用');

// 不属于组件生成来源的旧自由路线必须保持可编辑 manual，而不是误判成 generated。
const phase4LegacyManual = structuredClone(duplicateExitRoute('phase4-legacy-manual', 'legacy', 2));
for (const point of phase4LegacyManual.points) { delete point.authoring; delete point.attachment; }
for (const edge of phase4LegacyManual.edges) delete edge.authoring;
const phase4LegacyNormalized = normalizeTwinRoute(phase4LegacyManual);
assert(phase4LegacyNormalized.points.every((item) => item.authoring?.mode === 'manual') && phase4LegacyNormalized.edges.every((item) => item.authoring?.mode === 'manual'), '旧自由路线被错误迁移成 generated');
assert(validateV7ComponentManifest(connectedManifest).every((item) => item.severity !== 'error'), '合法 V7 组件场景未通过前端校验');

// Phase 4/6/7 双路线收尾严格验收：方向、Section、Manifest roundtrip、Runtime Overlay 与单路线调试。
const phase4DirectionManifest = createDefaultTwinSceneManifest();
phase4DirectionManifest.objects = [];
phase4DirectionManifest.connections = [];
phase4DirectionManifest.routes = [{
	routeId: 'phase4-direction', name: '方向折返告警', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([0, 0.8, 0], 0), pointId: 'direction-p0' },
		{ ...createRoutePoint([2, 0.8, 0], 1), pointId: 'direction-p1' },
		{ ...createRoutePoint([0.2, 0.8, 0], 2), pointId: 'direction-p2' },
	],
	edges: [
		{ ...createRouteEdge('direction-p0', 'direction-p1', 0), edgeId: 'direction-e0' },
		{ ...createRouteEdge('direction-p1', 'direction-p2', 1), edgeId: 'direction-e1' },
	],
	startPointId: 'direction-p0', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
}];
assert(validateRouteAuthoringManifest(phase4DirectionManifest).some((item) => item.code === 'route.authoring.direction.reverse' && item.severity === 'warning'), 'RouteAuthoringValidator 没有对 >150° 连续反向路线给出 warning');

const phase4Roundtrip = JSON.parse(JSON.stringify(phase4PersistManifest)) as TwinSceneManifest;
const phase4RoundtripManual = phase4Roundtrip.routes.find((item) => item.routeId === 'phase4-manual');
assert(Boolean(phase4RoundtripManual?.points.find((item) => item.pointId === 'phase4-manual-start')?.attachment), 'Manifest JSON roundtrip 丢失 Manual Endpoint Attachment');
assert(phase4RoundtripManual?.edges.every((item) => item.authoring?.mode === 'manual'), 'Manifest JSON roundtrip 丢失 Manual authoring 数据');
assert(Boolean(phase4Roundtrip.routeGraph?.routes?.length) && Boolean(phase4Roundtrip.routeGraph?.sourceMap?.length), 'Manifest JSON roundtrip 丢失固化 routeGraph');
assert(phase4Roundtrip.routeGraph?.sourceMap.some((item) => item.runtimeEdgeId === 'phase4-manual-edge-1' && item.sourceRouteId === 'phase4-manual'), 'routeGraph SourceMap 没有保存 sourceRouteId');
assert(phase4Roundtrip.routeGraph?.routes[0].edges.some((item) => item.edgeId === 'phase4-manual-edge-1'), 'Manifest roundtrip 后 routeGraph Runtime Edge 丢失');
// Manifest 生命周期必须保存完整 JSON，而不是只保存路线 DTO 白名单。
const routeLifecycleWorkbenchSource = readFileSync('src/views/iot/digital-twin/workbench.vue', 'utf8');
const routeLifecycleDtoSource = readFileSync('../IoTSharp.Contracts/DigitalTwinDtos.cs', 'utf8');
const routeLifecycleServiceSource = readFileSync('../IoTSharp/Services/DigitalTwin/DigitalTwinSceneService.cs', 'utf8');
const routeLifecycleInspectorSource = readFileSync('../IoTSharp/Services/DigitalTwin/TwinManifestInspector.cs', 'utf8');
assert(routeLifecycleWorkbenchSource.includes('persistCompiledRouteGraph(manifest.value)') && routeLifecycleWorkbenchSource.indexOf('persistCompiledRouteGraph(manifest.value)') < routeLifecycleWorkbenchSource.indexOf('digitalTwinApi.saveDraft'), '保存草稿没有先固化统一 routeGraph');
assert(routeLifecycleWorkbenchSource.includes('manifest.value = normalizeManifest(detail.draftPayload)'), '回滚没有从完整 draftPayload 恢复 Manifest');
assert(routeLifecycleDtoSource.includes('public JsonElement DraftPayload') && routeLifecycleDtoSource.includes('public JsonElement Payload'), 'DigitalTwin DTO 改成了细粒度 Payload，可能丢失 authoring/attachment/routeGraph');
assert(routeLifecycleServiceSource.includes('JsonNode.Parse(request.Payload.GetRawText())') && routeLifecycleServiceSource.includes('Manifest = inspection.NormalizedPayload') && routeLifecycleServiceSource.includes('JsonDocument.Parse(scene.DraftPayload)'), '服务端保存/发布没有沿完整 Manifest JSON 快照处理');
assert(routeLifecycleInspectorSource.includes('root = JsonNode.Parse(payload.GetRawText())') && routeLifecycleInspectorSource.includes('result.NormalizedPayload = root.ToJsonString'), 'TwinManifestInspector 没有在原始 JSON Root 上归一，未知 authoring 字段可能被裁剪');

const phase6BaseRoute = normalizeTwinRoute({
	routeId: 'phase6-overlay', name: 'Runtime Overlay', type: 'conveyor', curveKind: 'line', defaultSpeed: 1, loop: false, orientToPath: true,
	points: [{ ...createRoutePoint([0, 0.8, 0], 0), pointId: 'overlay-p0' }, { ...createRoutePoint([2, 0.8, 0], 1), pointId: 'overlay-p1' }],
	edges: [{ ...createRouteEdge('overlay-p0', 'overlay-p1', 0), edgeId: 'overlay-edge', capacity: 2, sectionId: 'overlay-section' }],
	sections: [{ sectionId: 'overlay-section', name: 'Overlay Section', enabled: true }], startPointId: 'overlay-p0', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
});
const overlayStatus = (edgePatch: Record<string, unknown>, context: any = {}) => {
	const edge = { ...phase6BaseRoute.edges[0], ...edgePatch } as any;
	const candidate = { ...phase6BaseRoute, edges: [edge] };
	return resolveRuntimeRouteEdgeOverlayState(candidate, edge, context).status;
};
assert(overlayStatus({}, { dataMode: 'simulation', edgeOccupancy: {} }) === 'ready', 'Runtime Overlay Ready 状态错误');
assert(overlayStatus({ capacity: 2 }, { dataMode: 'simulation', edgeOccupancy: { 'overlay-edge': 1 } }) === 'occupied', 'Runtime Overlay Occupied 状态错误');
assert(overlayStatus({ blocked: true }, { dataMode: 'simulation' }) === 'blocked', 'Runtime Overlay Blocked 状态错误');
assert(overlayStatus({ capacity: 1 }, { dataMode: 'simulation', edgeOccupancy: { 'overlay-edge': 1 } }) === 'full', 'Runtime Overlay Full 状态错误');
assert(overlayStatus({ readyBindingId: 'overlay-ready' }, { dataMode: 'live', bindingValues: { 'overlay-ready': false } }) === 'not-ready', 'Runtime Overlay NotReady 状态错误');
assert(overlayStatus({ enabled: false }, { dataMode: 'simulation' }) === 'disabled', 'Runtime Overlay Disabled 状态错误');
assert(overlayStatus({ readyBindingId: 'overlay-ready' }, { dataMode: 'live', bindingValues: { 'overlay-ready': true }, staleBindingIds: ['overlay-ready'] }) === 'stale', 'Runtime Overlay Stale 状态错误');

const phase7Route = normalizeTwinRoute({
	routeId: 'phase7-debug', name: 'Phase7 Debug', type: 'conveyor', curveKind: 'line', defaultSpeed: 5, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([0, 0.8, 0], 0), pointId: 'debug-start' },
		{ ...createRoutePoint([1, 0.8, 0], 1), pointId: 'debug-junction', kind: 'diverter' },
		{ ...createRoutePoint([3, 0.8, -1], 2), pointId: 'debug-a' },
		{ ...createRoutePoint([3, 0.8, 1], 3), pointId: 'debug-b' },
	],
	edges: [
		{ ...createRouteEdge('debug-start', 'debug-junction', 0), edgeId: 'debug-entry' },
		{ ...createRouteEdge('debug-junction', 'debug-a', 1), edgeId: 'debug-a-edge', priority: 20 },
		{ ...createRouteEdge('debug-junction', 'debug-b', 2), edgeId: 'debug-b-edge', priority: 10 },
	],
	startPointId: 'debug-start', junctionDecisions: { 'debug-junction': 'debug-a-edge' }, routingMode: 'manual', decisionRules: [],
});
const phase7Single = runSingleRouteDebug(phase7Route);
assert(phase7Single.state === 'completed' && phase7Single.activeEdgeIds.includes('debug-a-edge'), 'Phase7 单路线 Run 没有复用 RouteEngine 完成路径');
const phase7A = runDiverterRouteDebug(phase7Route, 'debug-junction', 'debug-a-edge');
const phase7B = runDiverterRouteDebug(phase7Route, 'debug-junction', 'debug-b-edge');
assert(phase7A.activeEdgeIds.includes('debug-a-edge') && !phase7A.activeEdgeIds.includes('debug-b-edge'), 'Phase7 分流 A 调试没有锁定 A 支路');
assert(phase7B.activeEdgeIds.includes('debug-b-edge') && !phase7B.activeEdgeIds.includes('debug-a-edge'), 'Phase7 分流 B 调试没有锁定 B 支路');
const phase7MergeRoute = normalizeTwinRoute({
	routeId: 'phase7-merge', name: 'Phase7 Merge', type: 'conveyor', curveKind: 'line', defaultSpeed: 2, loop: false, orientToPath: true,
	points: [
		{ ...createRoutePoint([0, 0.8, -1], 0), pointId: 'merge-a' }, { ...createRoutePoint([0, 0.8, 1], 1), pointId: 'merge-b' },
		{ ...createRoutePoint([2, 0.8, 0], 2), pointId: 'merge-point', kind: 'merger' }, { ...createRoutePoint([4, 0.8, 0], 3), pointId: 'merge-out' },
	],
	edges: [
		{ ...createRouteEdge('merge-a', 'merge-point', 0), edgeId: 'merge-a-edge', priority: 30 },
		{ ...createRouteEdge('merge-b', 'merge-point', 1), edgeId: 'merge-b-edge', priority: 10 },
		{ ...createRouteEdge('merge-point', 'merge-out', 2), edgeId: 'merge-out-edge' },
	],
	startPointId: 'merge-a', junctionDecisions: {}, routingMode: 'automatic', decisionRules: [],
});
const phase7Merge = runMergeRouteDebug(phase7MergeRoute, 'merge-a-edge', 'merge-b-edge', 0.25);
assert(phase7Merge.valid && phase7Merge.winnerEdgeId === 'merge-a-edge', 'Phase7 合流调试没有按现有 Edge priority 产生稳定判定');
assert(phase7Merge.safetyDistanceMeters === ROUTE_DEBUG_MIN_SAFETY_DISTANCE_METERS && phase7Merge.safetyDistanceMeters >= 1.5, 'Phase7 合流调试降低了 1.50m 安全距离');
const routeDebugRunnerSource = readFileSync('src/digital-twin/routes/RouteDebugRunner.ts', 'utf8');
assert(routeDebugRunnerSource.includes('new RouteEngine(') && !routeDebugRunnerSource.includes('class RouteDebugRuntime'), 'Phase7 调试器没有复用现有 RouteEngine，疑似创建第二套 Runtime');

const phase5Reference = createReferencePackagingLineTwinSceneManifest();
const phase5Route = phase5Reference.routes.find((item) => item.routeId === phase5Reference.runtime.primarySmallPalletRouteId)!;
const phase5EmptyDown = phase5Route.edges.find((item) => item.edgeId === 'ref-empty-return-down')!;
const phase5EmptyMerge = phase5Route.edges.find((item) => item.edgeId === 'ref-empty-return-merge')!;
const phase5GantryThrough = phase5Route.edges.find((item) => item.edgeId === 'ref-gantry-merger-through')!;
assert(phase5EmptyDown.authoring?.mode === 'manual' && phase5EmptyDown.authoring.convertedFromGenerated === true && phase5EmptyDown.authoring.locked === false, 'V19 外检后空托下行没有正式迁移为 Manual Route');
assert(phase5EmptyMerge.authoring?.mode === 'manual' && phase5EmptyMerge.authoring.convertedFromGenerated === true && phase5EmptyMerge.authoring.locked === false, 'V19 外检后空托合流段没有正式迁移为 Manual Route');
assert(phase5EmptyDown.sectionId === 'EmptyReturnAfterInspection' && phase5EmptyMerge.sectionId === 'EmptyReturnAfterInspection', 'V19 外检后空托独立回流没有使用稳定语义 Section');
assert(phase5Route.sections?.some((item) => item.sectionId === 'EmptyReturnAfterInspection') && phase5Route.sections?.some((item) => item.sectionId === 'GantryEmptyReturn'), 'V19 缺少 EmptyReturnAfterInspection / GantryEmptyReturn Section 定义');
for (const edgeId of ['ref-gantry-edge-a-merge', 'ref-gantry-edge-out', 'ref-return-edge-outer-top', 'ref-gantry-merger-through']) assert(phase5Route.edges.find((item) => item.edgeId === edgeId)?.sectionId === 'GantryEmptyReturn', `V19 桁架空托段没有归入 GantryEmptyReturn: ${edgeId}`);
assert(phase5EmptyMerge.toPointId === phase5GantryThrough.toPointId && phase5Route.edges.some((item) => item.fromPointId === phase5EmptyMerge.toPointId && item.edgeId === 'ref-return-edge-outer-down'), 'V19 外检空托与桁架空托没有在同一汇流点后沿统一方向进入公共回流');
const phase5CompiledReference = createCompiledRuntimeManifest(phase5Reference).manifest;
const phase5CompiledRoute = phase5CompiledReference.routes.find((item) => item.routeId === phase5CompiledReference.runtime.primarySmallPalletRouteId)!;
assert(phase5CompiledRoute.edges.find((item) => item.edgeId === 'ref-empty-return-down')?.sectionId === 'EmptyReturnAfterInspection' && phase5CompiledRoute.sections?.some((item) => item.sectionId === 'EmptyReturnAfterInspection'), 'Phase 5 编译后语义 Section 丢失');
assert(phase5CompiledRoute.edges.find((item) => item.edgeId === 'ref-gantry-merger-through')?.sectionId === 'GantryEmptyReturn', 'Phase 5 编译后 GantryEmptyReturn Section 丢失');
const phase5BuilderReference = buildReferencePackagingLineTwinSceneManifest();
const phase5BuilderRoute = phase5BuilderReference.routes.find((item) => item.routeId === phase5BuilderReference.runtime.primarySmallPalletRouteId)!;
for (const edgeId of ['ref-empty-return-down', 'ref-empty-return-merge']) {
	const assetEdge = phase5Route.edges.find((item) => item.edgeId === edgeId)!;
	const builderEdge = phase5BuilderRoute.edges.find((item) => item.edgeId === edgeId)!;
	assert(builderEdge.sectionId === assetEdge.sectionId && builderEdge.authoring?.mode === assetEdge.authoring?.mode && builderEdge.authoring?.convertedFromGenerated === true, `ReferencePackagingLineManifest Builder 与 V19 资产的 Manual/Section 不一致: ${edgeId}`);
}
assert(phase5BuilderRoute.edges.find((item) => item.edgeId === 'ref-gantry-merger-through')?.sectionId === 'GantryEmptyReturn', 'ReferencePackagingLineManifest Builder 没有同步 GantryEmptyReturn Section');

const multipleNetworkManifest = createManifest(
	createSmallRoller('A1', 0), createSmallRoller('A2', 3.3),
	createSmallRoller('B1', 20), createSmallRoller('B2', 23.3),
);
assert(snapAndConnectNearestComponent(multipleNetworkManifest, 'A2', { maxDistance: 0.5, maxAngleDegrees: 15 }), 'Network A 连接失败');
assert(snapAndConnectNearestComponent(multipleNetworkManifest, 'B2', { maxDistance: 0.5, maxAngleDegrees: 15 }), 'Network B 连接失败');
const networks = buildComponentGraphRoutes(multipleNetworkManifest);
assert(networks.length === 2, `两个不连通 Component Network 应生成两条路线，实际 ${networks.length}`);
assert(new Set(networks.map((item) => item.route.routeId)).size === 2, '多个 Network 的 RouteId 必须唯一');
const networkB = networks.find((item) => item.componentObjectIds.includes('B1'))!;
const networkBRouteSnapshot = JSON.stringify(networkB.route);
(multipleNetworkManifest.objects[0] as TwinV7SceneObjectDefinition).component!.properties.capacity = 9;
const rebuiltNetworks = buildComponentGraphRoutes(multipleNetworkManifest);
assert(rebuiltNetworks.find((item) => item.componentObjectIds.includes('B1'))?.route.routeId === networkB.route.routeId, '修改 Network A 不应改变 Network B 的稳定 RouteId');
assert(JSON.stringify(rebuiltNetworks.find((item) => item.componentObjectIds.includes('B1'))?.route) === networkBRouteSnapshot, '修改 Network A 不应污染 Network B 路线');

const dualInspectionTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-external-inspection-dual');
assert(Boolean(dualInspectionTemplate), '组件设计库缺少双工位化纤外检机');
assert(dualInspectionTemplate?.name === '双工位化纤外检机', '双工位外检机组件名称错误');
const dualInspectionDefinition = createComponentDefinitionFromTemplate('builtin-external-inspection-dual', { objectId: 'verify-dual-external-inspection' });
const dualInspectionBuilt = defaultComponentRegistry.create(dualInspectionDefinition);
try {
	assert(dualInspectionBuilt.root.userData?.simultaneousInspection === true, '双工位化纤外检机必须支持两个丝饼同时检测');
	assert(Number(dualInspectionBuilt.root.userData?.simultaneousCapacity || 0) === 2 && Number(dualInspectionBuilt.root.userData?.capacity || 0) === 2, '双工位化纤外检机并行容量必须固定为 2');
	assert(Number(dualInspectionBuilt.root.userData?.conveyorCount || 0) === 1, '双工位化纤外检机只能有一条小辊道');
	assert(Number(dualInspectionBuilt.root.userData?.stationCount || 0) === 2, '一条小辊道上必须布置两个检测位');
	const inlineConveyor = dualInspectionBuilt.root.getObjectByName('Inspection-Dual-Inline-Conveyor') as any;
	assert(Boolean(inlineConveyor) && inlineConveyor.userData?.singleConveyorForTwoStations === true, '双工位外检机没有使用一条贯穿两个检测位的小辊道');
	const stations = ['A', 'B'].map((name) => dualInspectionBuilt.root.getObjectByName(`Inspection-Dual-Station-${name}`) as any);
	assert(stations.every(Boolean), '双工位外检机缺少 A/B 两个串列检测位');
	const stationCenters = stations.map((station) => station.getWorldPosition(new THREE.Vector3()));
	assert(Math.abs(stationCenters[0].z - stationCenters[1].z) < 0.001, '两个检测位必须在同一条小辊道中心线上');
	assert(Math.abs(stationCenters[0].x - stationCenters[1].x) > 1.2, '同一小辊道上的两个检测位在 X 方向间距不足');
	const dualCameras: any[] = [];
	const dualRotaryGrippers: any[] = [];
	const dualStoppers: any[] = [];
	dualInspectionBuilt.root.traverse((node: any) => {
		if (node.userData?.visionCamera === true) dualCameras.push(node);
		if (node.userData?.rotaryInspectionGripper === true) dualRotaryGrippers.push(node);
		if (node.userData?.retractableStopper === true) dualStoppers.push(node);
	});
	assert(dualCameras.length === 6, '两个检测位必须共配置 6 台视觉相机');
	assert(dualRotaryGrippers.length === 2, '两个检测位必须各有一套顶部 360° 旋转检测夹具');
	assert(new Set(dualRotaryGrippers.map((item) => item.userData?.inspectionStation)).size === 2, '两套旋转夹具没有分别绑定 A/B 检测位');
	assert(dualStoppers.length === 2, '同一小辊道上的两个检测位必须各有一套定位挡停机构');
	assert(Boolean(dualInspectionBuilt.root.getObjectByName('Inspection-Dual-Control-Cabinet')), '双工位化纤外检机缺少共用电控柜');
	assert(Boolean(dualInspectionBuilt.root.getObjectByName('Inspection-Dual-HMI')), '双工位化纤外检机缺少共用 HMI');
	assert(!dualInspectionBuilt.root.getObjectByName('InspectionShell'), '双工位化纤外检机不能退回旧半透明盒子结构');
} finally { dualInspectionBuilt.dispose(); }

const inspectionTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-external-inspection')!;
const bindingManifest = createManifest({
	objectId: 'Inspection01', name: '外检机', kind: 'component', resourceId,
	transform: { position: [40, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
	component: {
		resourceKey: inspectionTemplate.resourceKey,
		componentType: inspectionTemplate.componentType,
		generator: inspectionTemplate.generator,
		generatorVersion: inspectionTemplate.generatorVersion,
		properties: { ...inspectionTemplate.defaultProperties },
		bindings: { ready: 'binding-ready', busy: 'binding-busy', complete: 'binding-complete', result: 'binding-result', fault: 'binding-fault' },
	},
});
bindingManifest.bindings = ['ready', 'busy', 'complete', 'result', 'fault'].map((slot) => ({
	bindingId: `binding-${slot}`, objectId: 'Inspection01',
	source: { kind: 'simulation', key: slot }, target: { kind: 'customProperty', property: slot },
	transform: { kind: 'routeEvent' }, staleAfterMs: 5000,
}));
const inspectionRoute = buildComponentGraphRoutes(bindingManifest)[0].route;
const process = inspectionRoute.points.find((point) => point.process?.type === 'external-inspection')?.process;
assert(process?.readyBindingId === 'binding-ready' && process.busyBindingId === 'binding-busy'
	&& process.completeBindingId === 'binding-complete' && process.resultBindingId === 'binding-result'
	&& process.faultBindingId === 'binding-fault', 'Smart Model 生成工艺点未继承标准 Binding Slot');
assert(validateV7ComponentManifest(bindingManifest).every((item) => item.severity !== 'error'), '合法 Smart Model Binding Slot 未通过校验');
const liveProcess = new ComponentProcessStateMachine(process!, 'live');
liveProcess.arrive();
const staleProcess = liveProcess.update(0.1, { bindingValues: {}, staleBindingIds: ['binding-ready'] });
assert(staleProcess.waitingReason === 'PROCESS_SIGNAL_STALE' && !staleProcess.canRelease, 'stale 工艺信号必须阻止错误放行');
liveProcess.update(0.1, { bindingValues: { 'binding-ready': true }, staleBindingIds: [] });
liveProcess.update(0.1, { bindingValues: { 'binding-ready': true, 'binding-busy': true }, staleBindingIds: [] });
const completedProcess = liveProcess.update(0.1, { bindingValues: { 'binding-ready': true, 'binding-busy': true, 'binding-complete': true, 'binding-result': 'PASS' }, staleBindingIds: [] });
assert(completedProcess.canRelease && completedProcess.result === 'PASS', 'Live 工艺 Complete/Result Binding 未正确驱动状态机');
const residualCompleteProcess = new ComponentProcessStateMachine({ type: 'scan', completeBindingId: 'done', timeoutSeconds: 5 }, 'live');
residualCompleteProcess.arrive({ bindingValues: { done: true } });
assert(!residualCompleteProcess.update(0.1, { bindingValues: { done: true } }).canRelease, '到站前残留的 Complete 高电平不能完成新周期');
residualCompleteProcess.update(0.1, { bindingValues: { done: false } });
assert(residualCompleteProcess.update(0.1, { bindingValues: { done: true } }).canRelease, 'Complete 出现低到高新沿后应完成当前周期');
const timedOutProcess = new ComponentProcessStateMachine({ type: 'scan', completeBindingId: 'done', timeoutSeconds: 0.15 }, 'live');
timedOutProcess.arrive({ bindingValues: { done: false } });
assert(timedOutProcess.update(0.2, { bindingValues: { done: false } }).waitingReason === 'PROCESS_TIMEOUT', 'Live 工艺超过 timeoutSeconds 后必须进入明确故障状态');
const processStations = new ProcessStationManager([{
	stationId: 'Inspection01', sectionId: 'section-Inspection01', type: 'external-inspection', process: process!, dataMode: 'live',
}]);
processStations.arrive('section-Inspection01', 'pallet-01');
processStations.update('Inspection01', 0.1, { bindingValues: {}, staleBindingIds: ['binding-ready'] });
assert(processStations.canRelease('section-Inspection01', 'pallet-01').reason === 'PROCESS_SIGNAL_STALE', 'ProcessStationManager 未继承 stale 阻塞语义');
processStations.update('Inspection01', 0.1, { bindingValues: { 'binding-ready': true }, staleBindingIds: [] });
processStations.update('Inspection01', 0.1, { bindingValues: { 'binding-ready': true, 'binding-busy': true }, staleBindingIds: [] });
processStations.update('Inspection01', 0.1, { bindingValues: { 'binding-ready': true, 'binding-busy': true, 'binding-complete': true, 'binding-result': 'PASS' }, staleBindingIds: [] });
assert(processStations.canRelease('section-Inspection01', 'pallet-01').canRelease, 'ProcessStationManager 未按 Generated Process Contract 放行');

const dualProcessManager = new ProcessStationManager([{
	stationId: 'DualInspection01', sectionId: 'section-dual-inspection', type: 'external-inspection',
	process: { type: 'external-inspection', cycleSeconds: 0.2 }, dataMode: 'simulation', capacity: 2,
}]);
dualProcessManager.arrive('section-dual-inspection', 'pallet-a');
dualProcessManager.arrive('section-dual-inspection', 'pallet-b');
assert(dualProcessManager.get('DualInspection01')?.entityIds.length === 2, '双工位 ProcessStationManager 必须同时接收两个实体');
assert(!dualProcessManager.canAccept('section-dual-inspection', 'pallet-c'), '双工位已占满时第三个实体必须被阻止');
dualProcessManager.updateEntity('DualInspection01', 'pallet-a', 0.25);
dualProcessManager.updateEntity('DualInspection01', 'pallet-b', 0.10);
assert(dualProcessManager.canRelease('section-dual-inspection', 'pallet-a').canRelease, '双工位实体 A 应能独立完成');
assert(!dualProcessManager.canRelease('section-dual-inspection', 'pallet-b').canRelease, '双工位实体 B 未完成时不能随 A 一起放行');
dualProcessManager.updateEntity('DualInspection01', 'pallet-b', 0.15);
assert(dualProcessManager.canRelease('section-dual-inspection', 'pallet-b').canRelease, '双工位实体 B 应能独立完成');
assert(dualProcessManager.release('section-dual-inspection', 'pallet-a'), '双工位实体 A 释放失败');
assert(dualProcessManager.get('DualInspection01')?.entityIds.length === 1, '释放 A 后工位应只保留 B');
assert(dualProcessManager.release('section-dual-inspection', 'pallet-b'), '双工位实体 B 释放失败');
assert(dualProcessManager.get('DualInspection01')?.entityIds.length === 0, '双工位全部释放后应恢复空闲');

const genericProcessRoute = {
	routeId: 'verify-component-process-route', name: '组件工艺自动停车测试', type: 'conveyor' as const, curveKind: 'line' as const,
	defaultSpeed: 2, loop: false, orientToPath: true, routingMode: 'automatic' as const, junctionDecisions: {}, decisionRules: [],
	startPointId: 'p0',
	points: [
		{ pointId: 'p0', name: '入口', position: [0, 0.9, 0] as [number, number, number], kind: 'buffer' as const },
		{ pointId: 'p1', name: '外检入口', position: [3, 0.9, 0] as [number, number, number], kind: 'processStation' as const, componentObjectId: 'InspectionAuto01', componentPortId: 'input', process: { type: 'external-inspection' as const, cycleSeconds: 0.25 } },
		{ pointId: 'p2', name: '外检出口', position: [7, 0.9, 0] as [number, number, number], kind: 'buffer' as const },
		{ pointId: 'p3', name: '末端', position: [10, 0.9, 0] as [number, number, number], kind: 'buffer' as const },
	],
	edges: [
		{ edgeId: 'e0', fromPointId: 'p0', toPointId: 'p1', bidirectional: false, enabled: true, capacity: 1, transportUnitType: 'plastic-pallet' as const, conveyorSizeClass: 'small' as const },
		{ edgeId: 'e1', fromPointId: 'p1', toPointId: 'p2', bidirectional: false, enabled: true, capacity: 1, transportUnitType: 'plastic-pallet' as const, conveyorSizeClass: 'small' as const, componentObjectId: 'InspectionAuto01', sectionId: 'section-InspectionAuto01' },
		{ edgeId: 'e2', fromPointId: 'p2', toPointId: 'p3', bidirectional: false, enabled: true, capacity: 1, transportUnitType: 'plastic-pallet' as const, conveyorSizeClass: 'small' as const },
	],
};
const genericTarget = new THREE.Group();
const genericRouteEngine = new RouteEngine(genericProcessRoute, genericTarget);
const genericInspection = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-external-inspection', { objectId: 'InspectionAuto01', name: '自动外检机' }));
const genericProcessRuntime = new ComponentProcessRuntime({
	route: genericProcessRoute,
	routeEngine: genericRouteEngine,
	dataMode: 'simulation',
	getComponentRoot: (objectId) => objectId === 'InspectionAuto01' ? genericInspection.root : undefined,
	getRoutingContext: () => ({ payload: {}, bindingValues: {}, staleBindingIds: [] }),
});
genericProcessRuntime.setRunning(true);
let observedAutoStop = false;
let observedInspectionMotion = false;
let stoppedDistance = -1;
const genericGripper = genericInspection.root.getObjectByName('Inspection-Rotary-Gripper')!;
const genericGripperBaseRotation = genericGripper.rotation.y;
for (let index = 0; index < 240; index += 1) {
	const allowRoute = genericProcessRuntime.updateFixed(1 / 30);
	if (allowRoute) genericRouteEngine.updateFixed(1 / 30);
	advanceComponentVisualRuntime(genericInspection.root, 1 / 30, 1);
	const processSnapshot = genericProcessRuntime.getSnapshot();
	if (processSnapshot.activeComponentObjectId === 'InspectionAuto01') {
		observedAutoStop = true;
		stoppedDistance = genericRouteEngine.getSnapshot().distanceMeters;
		if (Math.abs(genericGripper.rotation.y - genericGripperBaseRotation) > 0.05) observedInspectionMotion = true;
	}
}
assert(observedAutoStop, '普通 V7 组件场景没有在外检工艺组件中自动停车');
assert(Math.abs(stoppedDistance - 5) < 0.15, '工艺停车位置必须位于外检组件内部中点，实际 ' + stoppedDistance.toFixed(2) + 'm');
assert(observedInspectionMotion, '外检工位没有通过组件内部时间轴驱动旋转检测夹具动画');
assert(genericProcessRuntime.getSnapshot().processedStationIds.some((stationId) => stationId === 'InspectionAuto01' || stationId.startsWith('InspectionAuto01:')), 'cycleSeconds 完成后没有记录工艺完成');
assert(genericRouteEngine.getSnapshot().distanceMeters > 5.2, '工艺完成后路线没有自动恢复放行');
genericProcessRuntime.dispose();
genericInspection.dispose();
const diverterTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-diverter-conveyor')!;
const diverterManifest = createManifest({
	objectId: 'Diverter01', name: '分流器', kind: 'component', resourceId,
	transform: { position: [50, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
	component: {
		resourceKey: diverterTemplate.resourceKey, componentType: diverterTemplate.componentType,
		generator: diverterTemplate.generator, generatorVersion: diverterTemplate.generatorVersion,
		properties: { ...diverterTemplate.defaultProperties }, bindings: { routeCode: 'binding-route-code', inPosition: 'binding-in-position' },
	},
});
diverterManifest.bindings = ['route-code', 'in-position'].map((key) => ({
	bindingId: `binding-${key}`, objectId: 'Diverter01', source: { kind: 'simulation', key },
	target: { kind: 'customProperty', property: key }, transform: { kind: 'routeEvent' }, staleAfterMs: 5000,
}));
const diverterPoint = buildComponentGraphRoutes(diverterManifest)[0].route.points.find((point) => point.kind === 'diverter');
assert(diverterPoint?.decisionMode === 'plc' && diverterPoint.sensorBindingId === 'binding-route-code'
	&& diverterPoint.actuatorBindingId === 'binding-in-position', '分流组件未将 RouteCode / InPosition 继承到岔口工艺合同');

const incompatibleManifest = createManifest(createSmallRoller('plastic', 0), createSmallRoller('wood', 3.3, 'wooden-pallet'));
assert(!findBestComponentSnap(incompatibleManifest, 'wood', { maxDistance: 0.5, maxAngleDegrees: 15 }), '不同输送对象类型不应自动连接');

const heightMismatchManifest = createManifest(createSmallRoller('low', 0), createSmallRoller('high', 3.3));
heightMismatchManifest.objects[1].transform.position[1] = 0.25;
assert(!findBestComponentSnap(heightMismatchManifest, 'high', { maxDistance: 0.5, maxAngleDegrees: 15 }), '普通辊道高差超过 0.15m 不应直接吸附');

const wrongAngleManifest = createManifest(createSmallRoller('fixed', 0), createSmallRoller('rotated', 1.5));
wrongAngleManifest.objects[1].transform.rotation = [0, Math.PI / 2, 0];
const perpendicularCandidate = findBestComponentSnap(wrongAngleManifest, 'rotated', { maxDistance: 2.0, maxAngleDegrees: 15 });
assert(!perpendicularCandidate, '3D 场景设计器错误允许 90° 垂直端口成为吸附候选');
assert(!snapAndConnectNearestComponent(wrongAngleManifest, 'rotated', { maxDistance: 2.0, maxAngleDegrees: 15 }), '3D 场景设计器错误把垂直设备强制旋转后吸附');
assert((wrongAngleManifest.connections?.length || 0) === 0, '垂直吸附被错误持久化为 Connection');

const parallelSnapManifest = createManifest(createSmallRoller('parallel-fixed', 0), createSmallRoller('parallel-moving', 3.3));
const parallelCandidate = findBestComponentSnap(parallelSnapManifest, 'parallel-moving', { maxDistance: 0.5, maxAngleDegrees: 15 });
assert(Boolean(parallelCandidate), '已经平行且端口相向的辊道没有产生吸附候选');
assert(Boolean(snapAndConnectNearestComponent(parallelSnapManifest, 'parallel-moving', { maxDistance: 0.5, maxAngleDegrees: 15 })), '已经平行且端口相向的辊道吸附失败');
assert(parallelSnapManifest.connections?.length === 1, '平行吸附没有持久化 Connection');

// 3D 场景设计器必须真正使用实例吸附参数，而不是固定 0.5m / 15°。
const configurableSnapManifest = createManifest(createSmallRoller('SnapFixed', 0), createSmallRoller('SnapMoving', 3.8));
assert(!findBestComponentSnap(configurableSnapManifest, 'SnapMoving', { maxDistance: 0.5, maxAngleDegrees: 15 }), '0.8m 端口间距不应被旧 0.5m 默认值吸附');
const configurableMoving = configurableSnapManifest.objects.find((item) => item.objectId === 'SnapMoving') as TwinV7SceneObjectDefinition;
configurableMoving.component!.properties.snapDistance = 0.9;
configurableMoving.component!.properties.snapAngleDegrees = 15;
const resolvedSnapConfig = resolveSceneComponentSnapOptions(configurableMoving);
assert(Math.abs(resolvedSnapConfig.maxDistance - 0.9) < 0.0001, '3D 场景属性 snapDistance 没有进入吸附引擎');
const configurableSnap = snapSceneComponent(configurableSnapManifest, 'SnapMoving');
assert(configurableSnap?.kind === 'component-port', '3D 场景设计器修改吸附距离后仍未产生端口吸附');
assert(configurableSnapManifest.connections?.length === 1, '自动端口吸附没有持久化 Connection');

const largeTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-large-roller-conveyor')!;
const transportObject = (resourceKey: string, objectId: string, position: [number, number, number]): TwinV7SceneObjectDefinition => {
	const template = builtInComponentTemplates.find((item) => item.resourceKey === resourceKey)!;
	return {
		objectId, name: objectId, kind: 'component', resourceId,
		transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
		component: {
			resourceKey: template.resourceKey, componentType: template.componentType, generator: template.generator, generatorVersion: template.generatorVersion,
			properties: { ...template.defaultProperties },
		},
	};
};
const routeFollowManifest = createManifest(
	createSmallRoller('FollowSmallRoute', 0),
	transportObject('builtin-plastic-pallet', 'FollowSmallPallet', [0.4, 0, 0.4]),
);
upsertGeneratedComponentRoutes(routeFollowManifest);
const followPallet = routeFollowManifest.objects.find((item) => item.objectId === 'FollowSmallPallet') as TwinV7SceneObjectDefinition;
assert(snapSceneComponent(routeFollowManifest, followPallet.objectId)?.kind === 'transport-route', '跟随测试小托盘初始路线吸附失败');
const followProgress = followPallet.component!.routeProgress!;
const followConveyor = routeFollowManifest.objects.find((item) => item.objectId === 'FollowSmallRoute') as TwinV7SceneObjectDefinition;
followConveyor.transform.position[2] = 2.5;
upsertGeneratedComponentRoutes(routeFollowManifest);
assert(Math.abs(followPallet.component!.routeProgress! - followProgress) < 0.0001, 'Route 重建后运输单元 Edge Progress 被改变');
assert(Math.abs(followPallet.transform.position[2] - 2.5) < 0.001, '辊道平移并重建 Route 后，小托盘没有跟随原 RouteEdge');

const transportSnapManifest = createManifest(
	createSmallRoller('SmallRoute', 0),
	{
		objectId: 'LargeRoute', name: 'LargeRoute', kind: 'component', resourceId,
		transform: { position: [0, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
		component: { resourceKey: largeTemplate.resourceKey, componentType: largeTemplate.componentType, generator: largeTemplate.generator, generatorVersion: largeTemplate.generatorVersion, properties: { ...largeTemplate.defaultProperties }, sectionId: 'section-LargeRoute' },
	},
	transportObject('builtin-plastic-pallet', 'SmallPalletRouteUnit', [0.2, 0, 0.55]),
	transportObject('builtin-wooden-pallet', 'WoodPalletRouteUnit', [0.2, 0, 4.55]),
	transportObject('builtin-carton', 'CartonRouteUnit', [0.2, 0, 0.15]),
);
upsertGeneratedComponentRoutes(transportSnapManifest);
const smallPallet = transportSnapManifest.objects.find((item) => item.objectId === 'SmallPalletRouteUnit') as TwinV7SceneObjectDefinition;
const woodPallet = transportSnapManifest.objects.find((item) => item.objectId === 'WoodPalletRouteUnit') as TwinV7SceneObjectDefinition;
const carton = transportSnapManifest.objects.find((item) => item.objectId === 'CartonRouteUnit') as TwinV7SceneObjectDefinition;
carton.component!.properties.routeSnapDistance = 5; // 即使 small 更近，也必须按业务规则选 large。

const smallRouteCandidate = findBestTransportRouteSnap(transportSnapManifest, smallPallet.objectId);
assert(smallRouteCandidate?.conveyorSizeClass === 'small', '小托盘没有限定吸附到小辊道路线');
const smallPalletSnap = snapSceneComponent(transportSnapManifest, smallPallet.objectId);
assert(smallPalletSnap?.kind === 'transport-route' && smallPalletSnap.candidate.conveyorSizeClass === 'small', '小托盘未自动吸附小辊道 Route');
assert(Boolean(smallPallet.component?.routeId && smallPallet.component.routeEdgeId && smallPallet.component.sectionId), '小托盘吸附后没有持久化 Route / Edge / Section');
assert(Number.isFinite(smallPallet.component?.routeProgress) && (smallPallet.component?.routeProgress || 0) >= 0 && (smallPallet.component?.routeProgress || 0) <= 1, '小托盘没有持久化合法 Route Progress');
assert(Math.abs(smallPallet.transform.position[1] - 0.9) < 0.001, '小托盘吸附后没有落在小辊道辊面高度');

const woodPalletSnap = snapSceneComponent(transportSnapManifest, woodPallet.objectId);
assert(woodPalletSnap?.kind === 'transport-route' && woodPalletSnap.candidate.conveyorSizeClass === 'large', '木托盘未自动吸附大辊道 Route');
assert(Math.abs(woodPallet.transform.position[1] - 0.82) < 0.001, '木托盘吸附后没有落在大辊道辊面高度');

const cartonCandidate = findBestTransportRouteSnap(transportSnapManifest, carton.objectId);
assert(cartonCandidate?.conveyorSizeClass === 'large', '纸箱自动吸附错误地选择了更近的小辊道');
const cartonSnap = snapSceneComponent(transportSnapManifest, carton.objectId);
assert(cartonSnap?.kind === 'transport-route' && cartonSnap.candidate.conveyorSizeClass === 'large', '纸箱未按要求自动吸附大辊道 Route');
assert(Boolean(carton.component?.routeId && carton.component.routeEdgeId && carton.component.sectionId), '纸箱吸附后没有持久化 Route / Edge / Section');
const attachedTransportDiagnostics = validateV7ComponentManifest(transportSnapManifest);
assert(!attachedTransportDiagnostics.some((item) => item.code.startsWith('twin.transport-route.') && item.severity === 'error'), '合法运输单元路线挂接被发布前校验错误拒绝');
const cartonRouteId = carton.component!.routeId!;
const cartonRoute = transportSnapManifest.routes.find((item) => item.routeId === cartonRouteId)!;
const smallEdgeForNegativeTest = transportSnapManifest.routes.flatMap((item) => item.edges).find((edge) => edge.conveyorSizeClass === 'small')!;
carton.component!.routeId = transportSnapManifest.routes.find((item) => item.edges.some((edge) => edge.edgeId === smallEdgeForNegativeTest.edgeId))!.routeId;
carton.component!.routeEdgeId = smallEdgeForNegativeTest.edgeId;
carton.component!.sectionId = smallEdgeForNegativeTest.sectionId;
carton.component!.routeProgress = 0.5;
assert(validateV7ComponentManifest(transportSnapManifest).some((item) => item.code === 'twin.transport-route.size.invalid'), '纸箱误挂小辊道时发布前校验没有阻止');
// 恢复合法挂接，避免后续通用校验受负例污染。
const restoredCarton = snapSceneComponent(transportSnapManifest, carton.objectId, { force: true, maxDistance: 5 });
assert(restoredCarton?.kind === 'transport-route' && restoredCarton.candidate.routeId === cartonRouteId, '纸箱负例后未恢复大辊道挂接');

const moving = connectedManifest.objects.find((item) => item.objectId === 'Conveyor03')!;
moving.transform.position = [20, 0, 0];
const revalidation = revalidateComponentConnections(connectedManifest);
assert(revalidation.length === 1, '组件移开后应清理一条失效 Connection');
assert(connectedManifest.connections?.length === 1, '失效 Connection 清理后仍有幽灵连接');

moving.transform.scale = [2, 1, 1];
const scaleDiagnostics = validateV7ComponentManifest(connectedManifest);
assert(scaleDiagnostics.some((item) => item.code === 'twin.component.scale.locked'), '组件 Scale 锁定校验未生效');

// Telemetry -> TwinRuntime.applyDataUpdates seam -> BindingEngine -> ActuatorRuntime -> Three.js 专项闭环。
const actuatorManifest = createBlankTwinSceneManifest();
actuatorManifest.runtime.dataMode = 'live';
actuatorManifest.objects.push({ objectId: 'ActuatorHost', name: 'Actuator Host', kind: 'visual', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
const actuatorRoot = new THREE.Group();
const linearNode = new THREE.Group(); linearNode.name = 'LinearAxis'; actuatorRoot.add(linearNode);
const rotaryNode = new THREE.Group(); rotaryNode.name = 'RotaryAxis'; rotaryNode.rotation.y = THREE.MathUtils.degToRad(179); actuatorRoot.add(rotaryNode);
const gripperNode = new THREE.Group(); gripperNode.name = 'Gripper'; actuatorRoot.add(gripperNode);
actuatorManifest.actuators = [
	{ actuatorId: 'verify-linear', name: '验证直线轴', objectId: 'ActuatorHost', nodePath: 'LinearAxis', kind: 'linear-axis', motionAxis: 'x', unit: 'meter', minValue: 0, maxValue: 10, homeValue: 0, speed: 20, bindings: { positionBindingId: 'verify-linear-binding' }, telemetryInterpolation: { enabled: true, mode: 'linear' } },
	{ actuatorId: 'verify-rotary', name: '验证旋转轴', objectId: 'ActuatorHost', nodePath: 'RotaryAxis', kind: 'rotary-joint', motionAxis: 'y', unit: 'degree', minValue: -180, maxValue: 180, homeValue: 179, speed: 360, bindings: { positionBindingId: 'verify-rotary-binding' }, telemetryInterpolation: { enabled: true, mode: 'shortest-angle' } },
	{ actuatorId: 'verify-gripper', name: '验证夹具', objectId: 'ActuatorHost', nodePath: 'Gripper', kind: 'gripper', unit: 'boolean', bindings: { positionBindingId: 'verify-gripper-binding' } },
];
actuatorManifest.bindings = [
	{ bindingId: 'verify-linear-binding', objectId: 'ActuatorHost', source: { kind: 'telemetry', deviceId: '00000000-0000-0000-0000-000000000001', key: 'AxisX' }, target: { kind: 'actuator', actuatorId: 'verify-linear' }, transform: { kind: 'identity' }, staleAfterMs: 3000, enabled: true },
	{ bindingId: 'verify-rotary-binding', objectId: 'ActuatorHost', source: { kind: 'telemetry', deviceId: '00000000-0000-0000-0000-000000000001', key: 'J1' }, target: { kind: 'actuator', actuatorId: 'verify-rotary' }, transform: { kind: 'identity' }, staleAfterMs: 3000, enabled: true },
	{ bindingId: 'verify-gripper-binding', objectId: 'ActuatorHost', source: { kind: 'telemetry', deviceId: '00000000-0000-0000-0000-000000000001', key: 'Grip' }, target: { kind: 'actuator', actuatorId: 'verify-gripper' }, transform: { kind: 'identity' }, staleAfterMs: 3000, enabled: true },
];
const actuatorRuntime = new ActuatorRuntime(actuatorManifest, (objectId) => objectId === 'ActuatorHost' ? actuatorRoot : undefined);
const actuatorBindingEngine = new BindingEngine(actuatorManifest, (objectId) => objectId === 'ActuatorHost' ? actuatorRoot : undefined, () => {}, undefined, undefined, undefined, undefined,
	(binding, value, update) => actuatorRuntime.applyTelemetryUpdate(binding.target.actuatorId!, { ...update, value }));
const sourceTimestamp = new Date().toISOString();
applyTwinRuntimeDataUpdates([{ bindingId: 'server-linear', bindingKey: 'verify-linear-binding', objectId: 'ActuatorHost', kind: 'telemetry', key: 'AxisX', value: 2.5, sourceTimestamp, quality: 'good', stale: false } as any], actuatorBindingEngine);
for (let index = 0; index < 10; index += 1) actuatorRuntime.tick(1 / 60);
assert(linearNode.position.x > 0 && linearNode.position.x <= 2.5, 'Telemetry 没有通过 TwinRuntime 数据入口/BindingEngine/ActuatorRuntime 驱动 linear-axis');
assert(actuatorRuntime.applyBehavior('verify-linear', 8) === false, 'Live telemetry-owned Actuator 错误接受了 Behavior 控制权');
const frozenLinear = linearNode.position.x;
actuatorRuntime.applyTelemetry('verify-linear', 5, Date.now(), true, 'stale');
for (let index = 0; index < 5; index += 1) actuatorRuntime.tick(1 / 60);
assert(Math.abs(linearNode.position.x - frozenLinear) < 1e-6 && actuatorRuntime.getState('verify-linear')?.stale === true, 'stale Actuator 没有冻结最后位置');
actuatorRuntime.applyTelemetry('verify-rotary', -179, Date.now(), false, 'good');
const beforeRotary = rotaryNode.rotation.y;
actuatorRuntime.tick(1 / 60);
const rotaryDelta = Math.abs(THREE.MathUtils.euclideanModulo(rotaryNode.rotation.y - beforeRotary + Math.PI, Math.PI * 2) - Math.PI);
assert(rotaryDelta < THREE.MathUtils.degToRad(10), 'shortest-angle 发生错误整圈旋转');
actuatorRuntime.applyTelemetry('verify-gripper', true, Date.now(), false, 'good');
assert(gripperNode.userData.closed === true && actuatorRuntime.getState('verify-gripper')?.currentValue === true, 'Telemetry 没有驱动 gripper boolean');
assert(!validateTwinSceneManifest(actuatorManifest).some((item) => item.code.startsWith('twin.actuator.binding.') && item.severity === 'error'), '合法 Actuator Telemetry Binding 被错误拒绝');
const conflictingActuatorManifest = structuredClone(actuatorManifest);
conflictingActuatorManifest.bindings.push({ ...structuredClone(conflictingActuatorManifest.bindings[0]), bindingId: 'verify-linear-binding-duplicate' });
assert(validateTwinSceneManifest(conflictingActuatorManifest).some((item) => item.code === 'twin.actuator.binding.conflict'), '重复 Actuator 实时位置 Binding 没有被阻止');
const liveControlManifest = structuredClone(actuatorManifest);
liveControlManifest.behaviors = [{ behaviorId: 'verify-live-conflict', name: 'Live conflict', actorObjectId: 'ActuatorHost', enabled: true, actions: [{ actionId: 'move-axis', kind: 'axisMove', actuatorId: 'verify-linear', targetValue: 3 }] }];
assert(validateTwinSceneManifest(liveControlManifest).some((item) => item.code === 'twin.actuator.live-control.conflict'), 'Live Telemetry/Behavior 控制权冲突没有诊断');
actuatorBindingEngine.dispose();
actuatorRuntime.dispose();

// 文档性能基线：100 Binding / 30 motion Actuator。这里验收 Runtime CPU update+tick，
// 不把 Node CPU 耗时冒充浏览器 WebGL FPS；真实 FPS 继续由 Runtime metrics 在浏览器验收。
{
	const perfManifest = createBlankTwinSceneManifest();
	perfManifest.runtime.dataMode = 'live';
	perfManifest.objects.push({ objectId: 'PerfHost', name: 'Telemetry Perf Host', kind: 'visual', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
	const perfRoot = new THREE.Group();
	perfManifest.actuators = [];
	perfManifest.bindings = [];
	for (let index = 0; index < 30; index += 1) {
		const node = new THREE.Group();
		node.name = `PerfAxis-${index}`;
		perfRoot.add(node);
		const actuatorId = `perf-actuator-${index}`;
		const bindingId = `perf-actuator-binding-${index}`;
		perfManifest.actuators.push({ actuatorId, name: `Perf Axis ${index}`, objectId: 'PerfHost', nodePath: node.name, kind: 'linear-axis', motionAxis: 'x', unit: 'meter', minValue: -1000, maxValue: 1000, homeValue: 0, speed: 1000, bindings: { positionBindingId: bindingId }, telemetryInterpolation: { enabled: true, mode: 'linear' } });
		perfManifest.bindings.push({ bindingId, objectId: 'PerfHost', source: { kind: 'telemetry', deviceId: '00000000-0000-0000-0000-000000000001', key: `Axis${index}` }, target: { kind: 'actuator', actuatorId }, transform: { kind: 'identity' }, staleAfterMs: 3000, enabled: true });
	}
	for (let index = 30; index < 100; index += 1) {
		perfManifest.bindings.push({ bindingId: `perf-visual-binding-${index}`, objectId: 'PerfHost', source: { kind: 'telemetry', deviceId: '00000000-0000-0000-0000-000000000001', key: `Visual${index}` }, target: { kind: 'customProperty', property: `perfValue${index}` }, transform: { kind: 'identity' }, staleAfterMs: 3000, enabled: true });
	}
	assert(perfManifest.bindings.length === 100 && perfManifest.actuators.length === 30, 'Telemetry 性能场景没有形成 100 Binding / 30 Actuator');
	const perfActuatorRuntime = new ActuatorRuntime(perfManifest, (objectId) => objectId === 'PerfHost' ? perfRoot : undefined);
	const perfBindingEngine = new BindingEngine(perfManifest, (objectId) => objectId === 'PerfHost' ? perfRoot : undefined, () => {}, undefined, undefined, undefined, undefined,
		(binding, value, update) => perfActuatorRuntime.applyTelemetryUpdate(binding.target.actuatorId!, { ...update, value }));
	const makePerfUpdates = (round: number) => perfManifest.bindings.map((binding, index) => ({
		bindingId: `server-${binding.bindingId}`,
		bindingKey: binding.bindingId,
		objectId: binding.objectId,
		kind: 'telemetry',
		key: binding.source.key,
		value: round + index / 100,
		sourceTimestamp: new Date(1_700_000_000_000 + round * 300).toISOString(),
		quality: 'good',
		stale: false,
	} as any));
	for (let round = 0; round < 10; round += 1) {
		applyTwinRuntimeDataUpdates(makePerfUpdates(round), perfBindingEngine);
		perfActuatorRuntime.tick(1 / 60);
	}
	const perfSamples: number[] = [];
	for (let round = 0; round < 120; round += 1) {
		const startedAt = performance.now();
		applyTwinRuntimeDataUpdates(makePerfUpdates(round + 10), perfBindingEngine);
		perfActuatorRuntime.tick(1 / 60);
		perfSamples.push(performance.now() - startedAt);
	}
	const sortedPerfSamples = [...perfSamples].sort((left, right) => left - right);
	const perfAverage = perfSamples.reduce((sum, value) => sum + value, 0) / perfSamples.length;
	const perfP95 = sortedPerfSamples[Math.min(sortedPerfSamples.length - 1, Math.ceil(sortedPerfSamples.length * 0.95) - 1)];
	assert(perfActuatorRuntime.getSnapshot().length === 30, 'Telemetry 性能场景没有维持 30 个 Actuator Runtime State');
	assert(perfP95 < 25, `Telemetry 100 Binding / 30 Actuator CPU update+tick P95 ${perfP95.toFixed(2)}ms 超过 25ms 门禁`);
	console.info(`Telemetry actuator performance PASS: bindings=100, actuators=30, rounds=${perfSamples.length}, avg=${perfAverage.toFixed(2)}ms, p95=${perfP95.toFixed(2)}ms (CPU update+tick)`);
	perfBindingEngine.dispose();
	perfActuatorRuntime.dispose();
}

console.info(`V7 component verification passed: templates=${builtInComponentTemplates.length}, connections=${connectedManifest.connections?.length}, sections=${graph?.route.edges.length}`);
