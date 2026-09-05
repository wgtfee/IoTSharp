import { createSilkCakeEquipmentObjectDefinitions, type TwinRouteDefinition, type TwinSceneManifest } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';

const MIGRATION_FLAG = 'silkV7Infrastructure';
const MIGRATION_VERSION_KEY = 'silkV7InfrastructureVersion';
export const SILK_V7_MIGRATION_VERSION = 2;

const createComponentObject = (
	resourceKey: string,
	objectId: string,
	name: string,
	position: [number, number, number],
	rotationY: number,
	properties: Record<string, unknown>,
	sectionId?: string,
	routeEdgeId?: string,
): TwinV7SceneObjectDefinition => {
	const template = getBuiltInComponentTemplate(resourceKey);
	if (!template) throw new Error(`V7 模板不存在: ${resourceKey}`);
	return {
		objectId,
		name,
		kind: 'component',
		component: {
			resourceKey: template.resourceKey,
			componentType: template.componentType,
			generator: template.generator,
			generatorVersion: template.generatorVersion,
			properties: {
				...structuredClone(template.defaultProperties),
				...properties,
				[MIGRATION_FLAG]: true,
				[MIGRATION_VERSION_KEY]: SILK_V7_MIGRATION_VERSION,
				routeManagedExternally: true,
			},
			sectionId,
			routeEdgeId,
		},
		transform: { position, rotation: [0, rotationY, 0], scale: [1, 1, 1] },
	};
};

const routePoint = (route: TwinRouteDefinition, pointId: string) => route.points.find((item) => item.pointId === pointId);
const createEdgeComponent = (route: TwinRouteDefinition, edge: TwinRouteDefinition['edges'][number]): TwinV7SceneObjectDefinition | undefined => {
	const from = routePoint(route, edge.fromPointId), to = routePoint(route, edge.toPointId);
	if (!from || !to) return undefined;
	const dx = to.position[0] - from.position[0], dz = to.position[2] - from.position[2];
	const length = Math.hypot(dx, dz);
	if (length < 0.35) return undefined;
	const large = edge.conveyorSizeClass === 'large';
	return createComponentObject(
		large ? 'builtin-large-roller-conveyor' : 'builtin-small-roller-conveyor',
		`v7-${edge.edgeId}`,
		`V7 ${edge.name}`,
		[(from.position[0] + to.position[0]) / 2, 0, (from.position[2] + to.position[2]) / 2],
		-Math.atan2(dz, dx),
		{
			length,
			width: large ? 2.2 : 1.55,
			height: large ? 0.82 : 0.9,
			capacity: edge.capacity ?? 1,
			occupancyMode: edge.occupancyMode ?? 'simulation',
			reservationTimeoutSeconds: edge.reservationTimeoutSeconds ?? 30,
			transportUnitType: edge.transportUnitType ?? (large ? 'wooden-pallet' : 'plastic-pallet'),
			conveyorSizeClass: large ? 'large' : 'small',
		},
		edge.edgeId,
		edge.edgeId,
	);
};

const syncExistingRouteManagedEdgeComponents = (objects: TwinV7SceneObjectDefinition[], routes: TwinRouteDefinition[]) => {
	const desired = new Map<string, TwinV7SceneObjectDefinition>();
	const activeRouteEdgeIds = new Set<string>();
	for (const route of routes) {
		for (const edge of route.edges) {
			activeRouteEdgeIds.add(edge.edgeId);
			const component = createEdgeComponent(route, edge);
			if (component) desired.set(component.objectId, component);
		}
	}
	let changed = false;
	for (let index = objects.length - 1; index >= 0; index -= 1) {
		const object = objects[index];
		if (object.kind !== 'component' || object.component?.properties?.[MIGRATION_FLAG] !== true || object.component.properties.routeManagedExternally !== true) continue;
		const routeEdgeId = object.component.routeEdgeId;
		if (!routeEdgeId) continue;
		const next = desired.get(object.objectId);
		if (!next) {
			if (!activeRouteEdgeIds.has(routeEdgeId)) {
				objects.splice(index, 1);
				changed = true;
			}
			continue;
		}
		const before = JSON.stringify({ name: object.name, transform: object.transform, properties: object.component.properties, sectionId: object.component.sectionId, routeEdgeId: object.component.routeEdgeId });
		object.name = next.name;
		object.transform = structuredClone(next.transform);
		object.component.resourceKey = next.component!.resourceKey;
		object.component.componentType = next.component!.componentType;
		object.component.generator = next.component!.generator;
		object.component.generatorVersion = next.component!.generatorVersion;
		object.component.sectionId = next.component!.sectionId;
		object.component.routeEdgeId = next.component!.routeEdgeId;
		object.component.properties = { ...object.component.properties, ...structuredClone(next.component!.properties) };
		const after = JSON.stringify({ name: object.name, transform: object.transform, properties: object.component.properties, sectionId: object.component.sectionId, routeEdgeId: object.component.routeEdgeId });
		if (before !== after) changed = true;
	}
	return changed;
};

const addSmartStation = (objects: TwinV7SceneObjectDefinition[], route: TwinRouteDefinition, pointId: string, resourceKey: string, name: string) => {
	const point = routePoint(route, pointId);
	if (!point) return;
	objects.push(createComponentObject(resourceKey, `v7-${pointId}`, name, [point.position[0], 0, point.position[2]], 0, {
		capacity: 1,
		cycleSeconds: point.process?.cycleSeconds ?? (pointId === 'silk-bagging' ? 3 : 2),
		transportUnitType: 'plastic-pallet',
	}, pointId));
};

/**
 * 将旧 V6 中由 ProceduralPackagingLine 硬编码绘制的塑料托盘输送基础设施迁成 V7 Component Instance。
 * 机器人、丝车、桁架动作、托盘实体和工艺状态机保持原 Runtime，不在本迁移中重写。
 */
export const migrateSilkLineInfrastructureToV7 = (manifest: TwinSceneManifest) => {
	const route = manifest.routes.find((item) => item.routeId === 'silk-cake-line-main');
	const woodRoute = manifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route');
	const hasSilkRuntime = manifest.objects.some((item) => ['silk-cake-line', 'silk-cake-packaging-line', 'packaging-line'].includes(item.procedural?.preset || ''));
	if (!route || !hasSilkRuntime) return { migrated: false, componentCount: 0 };

	const objects = manifest.objects as TwinV7SceneObjectDefinition[];
	const completedMigrationVersion = Number(manifest.runtime.silkV7InfrastructureMigrationVersion ?? 0);
	if (completedMigrationVersion >= SILK_V7_MIGRATION_VERSION) {
		const synchronized = syncExistingRouteManagedEdgeComponents(objects, [route, woodRoute].filter((item): item is TwinRouteDefinition => Boolean(item)));
		const existingCount = objects.filter((candidate) => candidate.kind === 'component' && candidate.component?.properties?.[MIGRATION_FLAG] === true).length;
		return { migrated: synchronized, componentCount: existingCount, migrationVersion: completedMigrationVersion };
	}
	const proceduralRoot = manifest.objects.find((item) => item.kind === 'procedural'
		&& ['silk-cake-line', 'silk-cake-packaging-line', 'packaging-line'].includes(item.procedural?.preset || ''));
	const existingIds = new Set(objects.map((item) => item.objectId));
	const equipmentAdditions = proceduralRoot
		? createSilkCakeEquipmentObjectDefinitions(proceduralRoot.objectId).filter((item) => !existingIds.has(item.objectId))
		: [];
	objects.push(...equipmentAdditions as TwinV7SceneObjectDefinition[]);
	const existing = objects.filter((candidate) => candidate.kind === 'component' && candidate.component?.properties?.[MIGRATION_FLAG] === true);
	let upgraded = false;
	for (const component of existing) {
		if (component.component!.properties[MIGRATION_VERSION_KEY] !== SILK_V7_MIGRATION_VERSION) upgraded = true;
		component.component!.properties[MIGRATION_VERSION_KEY] = SILK_V7_MIGRATION_VERSION;
	}

	const migrated: TwinV7SceneObjectDefinition[] = [];
	for (const targetRoute of [route, woodRoute].filter((item): item is TwinRouteDefinition => Boolean(item))) {
		for (const edge of targetRoute.edges) {
			const component = createEdgeComponent(targetRoute, edge);
			if (component) migrated.push(component);
		}
	}
	addSmartStation(migrated, route, 'silk-external-inspection', 'builtin-external-inspection', 'V7 外检机');
	addSmartStation(migrated, route, 'silk-bagging', 'builtin-bagging-machine', 'V7 套袋机');

	// 岔口/汇流加入智能模型，PLC/规则绑定能力由组件保留；原路线仍是运行权威，避免迁移时改变已验证选路。
	const diverter = routePoint(route, 'silk-diverter');
	if (diverter) migrated.push(createComponentObject('builtin-diverter-conveyor', 'v7-silk-diverter', 'V7 丝饼分流器', [diverter.position[0], 0, diverter.position[2]], 0, { capacity: 1, transportUnitType: 'plastic-pallet' }, 'silk-diverter'));
	const merger = routePoint(route, 'silk-merger');
	if (merger) migrated.push(createComponentObject('builtin-merger-conveyor', 'v7-silk-merger', 'V7 空托汇流器', [merger.position[0], 0, merger.position[2]], 0, { capacity: 1, transportUnitType: 'plastic-pallet' }, 'silk-merger'));

	const allExistingIds = new Set(objects.map((item) => item.objectId));
	const additions = migrated.filter((item) => !allExistingIds.has(item.objectId));
	objects.push(...additions);
	const synchronized = syncExistingRouteManagedEdgeComponents(objects, [route, woodRoute].filter((item): item is TwinRouteDefinition => Boolean(item)));
	manifest.connections ||= [];
	// 这是一次性、版本化迁移标记。后续 normalize/load/save 不得把用户主动删除的
	// V7 组件误判为“旧场景缺失”并重新补回；只有未来迁移版本提升时才允许再次迁移。
	manifest.runtime.silkV7InfrastructureMigrationVersion = SILK_V7_MIGRATION_VERSION;
	return { migrated: additions.length > 0 || equipmentAdditions.length > 0 || upgraded || synchronized, componentCount: existing.length + additions.length, migrationVersion: SILK_V7_MIGRATION_VERSION };
};

export const hasSilkV7Infrastructure = (manifest: TwinSceneManifest) =>
	(manifest.objects as TwinV7SceneObjectDefinition[]).some((item) => item.kind === 'component' && item.component?.properties?.[MIGRATION_FLAG] === true);

export const hasCompleteSilkV7Infrastructure = (manifest: TwinSceneManifest) => {
	const migratedComponents = new Map(
		(manifest.objects as TwinV7SceneObjectDefinition[])
			.filter((item) => item.kind === 'component'
				&& item.component?.properties?.[MIGRATION_FLAG] === true
				&& Number(item.component.properties[MIGRATION_VERSION_KEY]) >= SILK_V7_MIGRATION_VERSION)
			.map((item) => [item.objectId, item]),
	);
	const routeIds = new Set(['silk-cake-line-main', 'silk-wood-packaging-route']);
	const requiredIds = manifest.routes
		.filter((route) => routeIds.has(route.routeId))
		.flatMap((route) => route.edges.map((edge) => `v7-${edge.edgeId}`));
	requiredIds.push('v7-silk-external-inspection', 'v7-silk-bagging', 'v7-silk-diverter', 'v7-silk-merger');
	return requiredIds.length > 4 && requiredIds.every((objectId) => migratedComponents.has(objectId));
};
