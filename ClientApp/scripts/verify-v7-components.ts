import { createDefaultTwinSceneManifest, createSilkCakeLineTwinSceneManifest, type TwinSceneManifest } from '../src/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '../src/digital-twin/contracts/v7-components';
import { ComponentProcessStateMachine } from '../src/digital-twin/runtime/ComponentProcessStateMachine';
import { ProcessStationManager } from '../src/digital-twin/runtime/ProcessStationManager';
import {
	buildComponentFromTemplate,
	buildComponentGraphRoutes,
	builtInComponentResourceRegistrations,
	builtInComponentTemplates,
	ComponentMigrationRegistry,
	createComponentDefinitionFromTemplate,
	defaultComponentRegistry,
	findBestComponentSnap,
	hasCompleteSilkV7Infrastructure,
	migrateSilkLineInfrastructureToV7,
	revalidateComponentConnections,
	SILK_V7_MIGRATION_VERSION,
	snapAndConnectNearestComponent,
	upsertGeneratedComponentRoute,
	validateV7ComponentManifest,
} from '../src/digital-twin/components';

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

assert(builtInComponentTemplates.length === 9, `V7 内置组件应为 9 个，实际 ${builtInComponentTemplates.length}`);
assert(builtInComponentResourceRegistrations.length === 9, '组件数据库注册清单与内置组件目录数量不一致');
for (const template of builtInComponentTemplates) {
	const built = buildComponentFromTemplate(template.resourceKey, { objectId: `verify-${template.resourceKey}` });
	try {
		assert(built.root.children.length > 0, `${template.name} 没有生成 Three.js 几何对象`);
		assert(built.ports.length > 0, `${template.name} 没有物料端口`);
		assert(built.ports.every((port) => port.localPosition.every(Number.isFinite) && port.localDirection.every(Number.isFinite)), `${template.name} 存在无效端口坐标`);
	} finally {
		built.dispose();
	}
	const registration = builtInComponentResourceRegistrations.find((item) => item.resourceKey === template.resourceKey);
	assert(registration?.ports.length, `${template.name} 的数据库注册元数据缺少 ports`);
	assert(Array.isArray(registration?.bindingSlots), `${template.name} 的数据库注册元数据缺少 bindingSlots 数组`);
}

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
assert(!findBestComponentSnap(wrongAngleManifest, 'rotated', { maxDistance: 0.5, maxAngleDegrees: 15 }), '方向夹角超过 15° 不应自动连接');

const moving = connectedManifest.objects.find((item) => item.objectId === 'Conveyor03')!;
moving.transform.position = [20, 0, 0];
const revalidation = revalidateComponentConnections(connectedManifest);
assert(revalidation.length === 1, '组件移开后应清理一条失效 Connection');
assert(connectedManifest.connections?.length === 1, '失效 Connection 清理后仍有幽灵连接');

moving.transform.scale = [2, 1, 1];
const scaleDiagnostics = validateV7ComponentManifest(connectedManifest);
assert(scaleDiagnostics.some((item) => item.code === 'twin.component.scale.locked'), '组件 Scale 锁定校验未生效');

console.info(`V7 component verification passed: templates=${builtInComponentTemplates.length}, connections=${connectedManifest.connections?.length}, sections=${graph?.route.edges.length}`);
