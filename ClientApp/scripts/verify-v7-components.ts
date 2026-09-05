import * as THREE from 'three';
import { createDefaultTwinSceneManifest, createSilkCakeLineTwinSceneManifest, type TwinSceneManifest } from '../src/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '../src/digital-twin/contracts/v7-components';
import { ComponentProcessStateMachine } from '../src/digital-twin/runtime/ComponentProcessStateMachine';
import { ProcessStationManager } from '../src/digital-twin/runtime/ProcessStationManager';
import { ComponentProcessRuntime } from '../src/digital-twin/runtime/ComponentProcessRuntime';
import {
	buildComponentFromTemplate,
	buildComponentGraphRoutes,
	builtInComponentResourceRegistrations,
	builtInComponentTemplates,
	ComponentMigrationRegistry,
	createComponentDefinitionFromTemplate,
	defaultComponentRegistry,
	findBestComponentSnap,
	findBestTransportRouteSnap,
	hasCompleteSilkV7Infrastructure,
	migrateSilkLineInfrastructureToV7,
	revalidateComponentConnections,
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
import { createReferencePackagingLineTwinSceneManifest, REFERENCE_PACKAGING_LAYOUT_VERSION, upgradeReferencePackagingLineLayout } from '../src/digital-twin/presets/ReferencePackagingLineManifest';
import { resolveRoutePath, RouteEngine } from '../src/digital-twin/routes/RouteEngine';
import { resolveRouteTransportUnitResourceKey } from '../src/digital-twin/runtime/TwinRuntime';
import { RouteSlotArrayRuntime } from '../src/digital-twin/runtime/RouteSlotArrayRuntime';
import { BehaviorRuntime } from '../src/digital-twin/runtime/BehaviorRuntime';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const resourceId = '11111111-1111-4111-8111-111111111111';
const smallTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-small-roller-conveyor')!;
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

const smallPalletTemplate = builtInComponentTemplates.find((item) => item.resourceKey === 'builtin-small-pallet');
assert(smallPalletTemplate?.name === '小托盘', '组件库缺少独立绿色小托盘资源');
const smallPalletBuilt = defaultComponentRegistry.create(createComponentDefinitionFromTemplate('builtin-small-pallet', { objectId: 'verify-small-pallet' }));
try {
	assert(smallPalletBuilt.root.userData?.transportUnitType === 'plastic-pallet', '绿色小托盘必须继续使用 plastic-pallet 兼容物流类型');
	assert(smallPalletBuilt.root.userData?.transportUnitVariant === 'small-pallet', '绿色小托盘缺少 small-pallet 物理载具标记');
	assert(Boolean(smallPalletBuilt.root.getObjectByName('SmallPallet-Base')) && Boolean(smallPalletBuilt.root.getObjectByName('SmallPallet-CenterColumn')), '绿色小托盘没有保持圆形底盘 + 中心柱结构');
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
const routeSlotRuntime = new RouteSlotArrayRuntime(routeSlotScene, routeSlotManifest);
try {
	routeSlotRuntime.apply(smallSlotBinding, [12, 0, 23], false);
	routeSlotRuntime.apply(cartonSlotBinding, [88, 0], false);
	const runtimeEntities: THREE.Object3D[] = [];
	routeSlotScene.traverse((node) => { if (node.userData?.twinEntityType === 'route-slot-pallet' && node.parent?.name === 'IoTSharp Route Slot Array Runtime') runtimeEntities.push(node); });
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
	const authoritativeManifest = structuredClone(simulationSlotManifest);
	authoritativeManifest.bindings = [smallSlotBinding];
	simulationSlotRuntime.setManifest(authoritativeManifest);
	assert(simulationEntities().length === 0, '已有真实 routeSlotArray 绑定时仍错误生成 simulation 默认托盘');
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
	assert(referenceLineV11.name === `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`, '参考图当前 Manifest 名称没有同步布局版本');
	const referenceObjectsV11 = referenceLineV11.objects as TwinV7SceneObjectDefinition[];
	const referenceComponentsV11 = referenceObjectsV11.filter((item) => item.kind === 'component');
	for (const component of referenceComponentsV11) component.resourceId = resourceId;
	assert(referenceLineV11.runtime.referencePackagingLayoutVersion === REFERENCE_PACKAGING_LAYOUT_VERSION, '参考图 V11 Manifest 缺少当前布局版本标记');
	assert(referenceLineV11.routes.length > 0 && referenceLineV11.routes.every((item) => item.routeId.startsWith('component-route-')), '参考图 V11 仍在持久化旧手工 Route，而不是组件自动 Route');
	assert(!referenceLineV11.routes.some((item) => item.routeId.startsWith('reference-') || item.routeId === 'reference-bottom-lane-b'), '参考图 V11 仍残留旧 reference-* 手工路线');
	assert((referenceLineV11.connections?.length || 0) > 0, '参考图 V11 没有持久化组件 Port Connection');
	const referenceV12WorkPointIds = new Set((referenceLineV11.workPoints || []).map((item) => item.workPointId));
	for (const workPointId of [
		'reference-v12-turntable-west-pick',
		'reference-v12-turntable-east-pick',
		'reference-v12-loading-robot-home',
		'reference-v12-loading-robot-place',
		'reference-v12-gantry-yarn-source',
		'reference-v12-gantry-pallet-stack',
		'reference-v12-gantry-separator-buffer',
		'reference-v12-gantry-yarn-safe',
		'reference-v12-gantry-separator-safe',
	]) assert(referenceV12WorkPointIds.has(workPointId), `参考图 V12 缺少语义工作点 ${workPointId}`);
	for (const workPoint of referenceLineV11.workPoints || []) {
		assert(referenceObjectsV11.some((item) => item.objectId === workPoint.objectId), `参考图 V12 工作点 ${workPoint.workPointId} 引用了不存在的组件 ${workPoint.objectId}`);
		assert(workPoint.localPosition.every(Number.isFinite), `参考图 V12 工作点 ${workPoint.workPointId} 不是合法局部坐标`);
	}
	const referenceV12Behaviors = new Map((referenceLineV11.behaviors || []).map((item) => [item.behaviorId, item]));
	for (const behaviorId of ['reference-v12-robot-pick-west', 'reference-v12-robot-pick-east', 'reference-v12-gantry-yarn-stack', 'reference-v12-gantry-separator-stack']) {
		assert(referenceV12Behaviors.has(behaviorId), `参考图 V12 缺少动作编排 ${behaviorId}`);
	}
	for (const behaviorId of ['reference-v12-robot-pick-west', 'reference-v12-robot-pick-east']) {
		const behavior = referenceV12Behaviors.get(behaviorId)!;
		assert(behavior.actorObjectId === 'reference-loading-robot', `${behaviorId} 没有绑定底部上料机器人`);
		assert(behavior.actions.some((item) => item.kind === 'pick' && item.workPointId?.includes('turntable')), `${behaviorId} 没有语义旋转台抓取动作`);
		assert(behavior.actions.some((item) => item.kind === 'place' && item.workPointId === 'reference-v12-loading-robot-place'), `${behaviorId} 没有语义放置点`);
		assert(behavior.actions.every((item) => !item.workPointId || referenceV12WorkPointIds.has(item.workPointId)), `${behaviorId} 引用了不存在的工作点`);
	}
	const separatorBehaviorV12 = referenceV12Behaviors.get('reference-v12-gantry-separator-stack')!;
	assert(separatorBehaviorV12.actorObjectId === 'reference-stacking-gantry', '隔板动作没有绑定 V12 码垛桁架');
	assert(separatorBehaviorV12.interlockIds?.includes('reference-v12-gantry-pallet-zone-exclusive') === true, '隔板动作没有绑定木托共享区互锁');
	assert(separatorBehaviorV12.actions.some((item) => item.kind === 'wait' && item.waitForInterlockId === 'reference-v12-gantry-pallet-zone-exclusive'), '隔板夹具进入木托区前没有等待共享区互锁');
	const gantryInterlockV12 = (referenceLineV11.interlocks || []).find((item) => item.interlockId === 'reference-v12-gantry-pallet-zone-exclusive');
	assert(Boolean(gantryInterlockV12), '参考图 V12 缺少桁架木托共享区互锁');
	assert((gantryInterlockV12?.conditions.length || 0) >= 2, '桁架木托共享区互锁条件不完整');
	const expectedPalletInitializerRoutes = referenceLineV11.routes.filter((route) => route.routeId.startsWith('component-route-')
		&& route.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'small' && edge.transportUnitType === 'plastic-pallet'));
	const palletInitializersV12 = referenceLineV11.runtime.routePalletInitializers || [];
	assert(expectedPalletInitializerRoutes.length > 0, '参考图 V12 没有可初始化的小托盘自动路线');
	assert(palletInitializersV12.length === expectedPalletInitializerRoutes.length, '参考图 V12 小托盘初始化配置没有覆盖全部自动小托盘路线');
	for (const initializer of palletInitializersV12) {
		const route = referenceLineV11.routes.find((item) => item.routeId === initializer.routeId);
		assert(Boolean(route) && initializer.routeId.startsWith('component-route-'), `托盘初始化引用了不存在或非组件自动路线 ${initializer.routeId}`);
		assert(route?.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'small' && edge.transportUnitType === 'plastic-pallet') === true, `${initializer.routeId} 不是小托盘路线却配置了托盘初始化`);
		assert(initializer.simulationDefaultCount === 2, `${initializer.routeId} 仿真默认托盘数不是 V12 约定的 2`);
		assert(initializer.telemetryKey === `PalletSlots.${initializer.routeId}`, `${initializer.routeId} PLC 托盘数组语义键不稳定`);
	}

	// V12 声明式动作必须真正驱动现有组件节点，而不是只停留在 Manifest 配置。
	const behaviorSceneV12 = new THREE.Scene();
	const behaviorRootsV12 = new Map<string, THREE.Object3D>();
	const behaviorBuiltV12: Array<{ root: THREE.Group; dispose: () => void }> = [];
	for (const objectId of ['reference-loading-robot', 'reference-turntable-west', 'reference-turntable-east', 'reference-stacking-gantry']) {
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
	const behaviorRuntimeV12 = new BehaviorRuntime(referenceLineV11, behaviorSceneV12, (objectId) => behaviorRootsV12.get(objectId));
	try {
		const robotAxis1 = behaviorRootsV12.get('reference-loading-robot')!.getObjectByName('Robot-Axis-1')!;
		const robotStartYaw = robotAxis1.rotation.y;
		let sawBehaviorPayload = false;
		let sawSeparatorWaiting = false;
		let sawSeparatorReleased = false;
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 3600; index += 1) {
			behaviorRuntimeV12.updateFixed(1 / 60);
			if (index % 10 === 0) {
				behaviorSceneV12.traverse((node) => { if (node.userData?.behaviorPayload) sawBehaviorPayload = true; });
				const separator = behaviorRuntimeV12.getSnapshot().channels.find((item) => item.actorNodePath === 'SeparatorFixture');
				if (separator?.status === 'waiting-interlock') sawSeparatorWaiting = true;
				if (sawSeparatorWaiting && separator && separator.status !== 'waiting-interlock' && separator.completedActions >= 3) sawSeparatorReleased = true;
			}
		}
		const behaviorSnapshot = behaviorRuntimeV12.getSnapshot();
		assert(behaviorSnapshot.active === true && behaviorSnapshot.dataMode === 'simulation', 'V12 BehaviorRuntime 没有在 simulation 模式启动');
		const robotChannel = behaviorSnapshot.channels.find((item) => item.actorObjectId === 'reference-loading-robot');
		assert(Boolean(robotChannel) && robotChannel!.completedActions >= 4, 'V12 机器人没有真正执行工作点动作');
		assert(Math.abs(robotAxis1.rotation.y - robotStartYaw) > 0.02 || robotChannel!.cycleCount > 0, 'V12 机器人 J1 没有被 BehaviorRuntime 驱动');
		const yarnChannel = behaviorSnapshot.channels.find((item) => item.actorNodePath === 'YarnFixture');
		const separatorChannel = behaviorSnapshot.channels.find((item) => item.actorNodePath === 'SeparatorFixture');
		assert(Boolean(yarnChannel) && yarnChannel!.completedActions >= 3, 'V12 丝锭夹具没有独立执行动作通道');
		assert(Boolean(separatorChannel) && separatorChannel!.interlockWaitCount > 0 && sawSeparatorWaiting, 'V12 隔板夹具没有真实等待木托共享区联锁');
		assert(sawSeparatorReleased, 'V12 丝锭夹具离开共享区后，隔板联锁没有释放');
		assert(sawBehaviorPayload, 'V12 BehaviorRuntime 没有产生抓取/放置的可视物料');
		const gantryDetail = behaviorRuntimeV12.getObjectDetail('reference-stacking-gantry') as any;
		assert(gantryDetail?.behaviorRuntime?.channels?.length === 2, '桁架运行状态没有暴露丝锭/隔板两个动作通道');

		const liveManifest = structuredClone(referenceLineV11);
		liveManifest.runtime.dataMode = 'live';
		behaviorRuntimeV12.setManifest(liveManifest);
		behaviorRuntimeV12.setRunning(true);
		for (let index = 0; index < 120; index += 1) behaviorRuntimeV12.updateFixed(1 / 60);
		assert(behaviorRuntimeV12.getSnapshot().active === false, 'Live 模式仍在自行生成机器人/桁架动作，破坏 PLC/Telemetry 权威');
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
	assert(validateV7ComponentManifest(referenceLineV11).every((item) => item.severity !== 'error'), '参考图 V11 组件/自动路线校验存在错误');

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
	for (let head = 1; head <= 12; head += 1) assert(Boolean(gridGripper.getObjectByName('RobotGripperHead-' + head)), '2×6 丝锭夹具缺少抓头 ' + head);
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
const bottomLaneBMaxZ = 14.7 + 1.55 / 2;
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
assert(robotOut.position[0] === 0 && robotOut.position[2] === 12.8, '机器人上料位坐标偏离底部双排小辊道 A 排');
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
assertDoubleLaneWorldCenters('reference-double-small-bottom', { axis: 'z', value: 12.8 }, { axis: 'z', value: 14.7 });

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
assert(referenceObjects.some((item) => item.objectId === 'moving-package'), '参考图产线缺少运行预览移动物料对象');
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
	const runtime = new ComponentProcessRuntime({ route: processRoute, routeEngine: engine, getComponentRoot: (objectId) => roots.get(objectId)?.root, getRoutingContext: () => ({ payload: { routeCode }, bindingValues: {}, staleBindingIds: [] }) });
	runtime.setRunning(true);
	const activeStations = new Set<string>();
	const inspectionPhases = new Set<string>();
	const baggingPhases = new Set<string>();
	for (let index = 0; index < 1200; index += 1) {
		const allow = runtime.updateFixed(1 / 30);
		if (allow) engine.updateFixed(1 / 30);
		const snapshot = runtime.getSnapshot();
		if (snapshot.activeStationId) activeStations.add(snapshot.activeStationId);
		const inspectionRoot = roots.get('reference-external-inspection')!.root;
		if (inspectionRoot.userData.processActive) inspectionPhases.add(String(inspectionRoot.userData.processPhase));
		const bagRoot = roots.get(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b')!.root;
		if (bagRoot.userData.processActive) baggingPhases.add(String(bagRoot.userData.processPhase));
		if (snapshot.processedStationIds.includes('reference-external-inspection') && snapshot.processedStationIds.includes(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b')) break;
	}
	assert(activeStations.has('reference-external-inspection'), '参考图 ' + routeCode + ' 前行线没有在外检机内部停车');
	assert(activeStations.has(routeCode === 'A' ? 'reference-bagging-a' : 'reference-bagging-b'), '参考图 ' + routeCode + ' 前行线没有进入对应侧封膜机');
	assert(inspectionPhases.has('positioning') && inspectionPhases.has('rotate-scan') && inspectionPhases.has('release'), '外检机内部流程阶段不完整');
	assert(baggingPhases.has('positioning') && baggingPhases.has('film-feed') && baggingPhases.has('side-seal') && baggingPhases.has('cut'), '侧封膜机内部流程阶段不完整');
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
assert(validateV7ComponentManifest(connectedManifest).every((item) => item.severity !== 'error'), '合法 V7 组件场景未通过前端校验');

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
const completedProcess = liveProcess.update(0.1, { bindingValues: { 'binding-ready': true, 'binding-complete': true, 'binding-result': 'PASS' }, staleBindingIds: [] });
assert(completedProcess.canRelease && completedProcess.result === 'PASS', 'Live 工艺 Complete/Result Binding 未正确驱动状态机');
const processStations = new ProcessStationManager([{
	stationId: 'Inspection01', sectionId: 'section-Inspection01', type: 'external-inspection', process: process!, dataMode: 'live',
}]);
processStations.arrive('section-Inspection01', 'pallet-01');
processStations.update('Inspection01', 0.1, { bindingValues: {}, staleBindingIds: ['binding-ready'] });
assert(processStations.canRelease('section-Inspection01', 'pallet-01').reason === 'PROCESS_SIGNAL_STALE', 'ProcessStationManager 未继承 stale 阻塞语义');
processStations.update('Inspection01', 0.1, { bindingValues: { 'binding-ready': true }, staleBindingIds: [] });
processStations.update('Inspection01', 0.1, { bindingValues: { 'binding-ready': true, 'binding-complete': true, 'binding-result': 'PASS' }, staleBindingIds: [] });
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
	const processSnapshot = genericProcessRuntime.getSnapshot();
	if (processSnapshot.activeStationId === 'InspectionAuto01') {
		observedAutoStop = true;
		stoppedDistance = genericRouteEngine.getSnapshot().distanceMeters;
		if (Math.abs(genericGripper.rotation.y - genericGripperBaseRotation) > 0.05) observedInspectionMotion = true;
	}
}
assert(observedAutoStop, '普通 V7 组件场景没有在外检工艺组件中自动停车');
assert(Math.abs(stoppedDistance - 5) < 0.15, '工艺停车位置必须位于外检组件内部中点，实际 ' + stoppedDistance.toFixed(2) + 'm');
assert(observedInspectionMotion, '外检工艺运行时没有驱动旋转检测夹具动画');
assert(genericProcessRuntime.getSnapshot().processedStationIds.includes('InspectionAuto01'), 'cycleSeconds 完成后没有记录工艺完成');
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

console.info(`V7 component verification passed: templates=${builtInComponentTemplates.length}, connections=${connectedManifest.connections?.length}, sections=${graph?.route.edges.length}`);
