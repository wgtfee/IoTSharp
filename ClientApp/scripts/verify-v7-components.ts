import { createDefaultTwinSceneManifest, type TwinSceneManifest } from '../src/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '../src/digital-twin/contracts/v7-components';
import {
	buildComponentFromTemplate,
	builtInComponentResourceRegistrations,
	builtInComponentTemplates,
	findBestComponentSnap,
	revalidateComponentConnections,
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
}

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

const incompatibleManifest = createManifest(createSmallRoller('plastic', 0), createSmallRoller('wood', 3.3, 'wooden-pallet'));
assert(!findBestComponentSnap(incompatibleManifest, 'wood', { maxDistance: 0.5, maxAngleDegrees: 15 }), '不同输送对象类型不应自动连接');

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
