import type { TwinRouteDefinition, TwinSceneManifest } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';

const MIGRATION_FLAG = 'silkV7Infrastructure';
const EXCLUDED_EDGE_IDS = new Set([
	// 这三条由桁架单元内部继续负责视觉和机械动画，避免与现有 Gantry 模型重复。
	'silk-edge-left-b',
	'silk-edge-right-b',
	'silk-wood-edge-stack',
]);

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
	if (EXCLUDED_EDGE_IDS.has(edge.edgeId)) return undefined;
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
	const hasSilkRuntime = manifest.objects.some((item) => ['silk-cake-line', 'silk-cake-packaging-line', 'packaging-line'].includes(item.procedural?.preset || ''));
	if (!route || !hasSilkRuntime) return { migrated: false, componentCount: 0 };

	const objects = manifest.objects as TwinV7SceneObjectDefinition[];
	const existing = objects.filter((candidate) => candidate.kind === 'component' && candidate.component?.properties?.[MIGRATION_FLAG] === true);
	if (existing.length > 0) {
		manifest.connections ||= [];
		return { migrated: false, componentCount: existing.length };
	}

	const migrated: TwinV7SceneObjectDefinition[] = [];
	for (const edge of route.edges) {
		const component = createEdgeComponent(route, edge);
		if (component) migrated.push(component);
	}
	addSmartStation(migrated, route, 'silk-external-inspection', 'builtin-external-inspection', 'V7 外检机');
	addSmartStation(migrated, route, 'silk-bagging', 'builtin-bagging-machine', 'V7 套袋机');

	// 岔口/汇流加入智能模型，PLC/规则绑定能力由组件保留；原路线仍是运行权威，避免迁移时改变已验证选路。
	const diverter = routePoint(route, 'silk-diverter');
	if (diverter) migrated.push(createComponentObject('builtin-diverter-conveyor', 'v7-silk-diverter', 'V7 丝饼分流器', [diverter.position[0], 0, diverter.position[2]], 0, { capacity: 1, transportUnitType: 'plastic-pallet' }, 'silk-diverter'));
	const merger = routePoint(route, 'silk-merger');
	if (merger) migrated.push(createComponentObject('builtin-merger-conveyor', 'v7-silk-merger', 'V7 空托汇流器', [merger.position[0], 0, merger.position[2]], 0, { capacity: 1, transportUnitType: 'plastic-pallet' }, 'silk-merger'));

	objects.push(...migrated);
	manifest.connections ||= [];
	return { migrated: true, componentCount: migrated.length };
};

export const hasSilkV7Infrastructure = (manifest: TwinSceneManifest) =>
	(manifest.objects as TwinV7SceneObjectDefinition[]).some((item) => item.kind === 'component' && item.component?.properties?.[MIGRATION_FLAG] === true);
