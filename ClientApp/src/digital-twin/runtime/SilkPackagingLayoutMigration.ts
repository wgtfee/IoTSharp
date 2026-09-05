import { createSilkCakeEquipmentObjectDefinitions, createSilkCakeLineTwinSceneManifest, type TwinRouteEdgeDefinition, type TwinRoutePointDefinition, type TwinSceneManifest, type TwinVector3 } from '/@/digital-twin/contracts';

const WOOD_ROUTE_ID = 'silk-wood-packaging-route';
const GANTRY_EQUIPMENT_TYPE = 'gantry-stacker';
const builtInPointXs: Record<string, number[]> = {
	'silk-wood-stack': [26],
	'silk-cover': [33, 35, 40],
	'silk-wrap': [42, 43, 50],
	'silk-label': [37.5, 51, 60],
	'silk-inbound': [48, 59, 70],
};
const legacyEdgeIds = new Set(['silk-wood-edge-stack', 'silk-wood-edge-cover', 'silk-wood-edge-label', 'silk-wood-edge-wrap', 'silk-wood-edge-post-process']);
const bindingFields = ['occupancyBindingId', 'fullBindingId', 'blockedBindingId', 'conveyorObjectId'] as const;

const near = (left: number, right: number) => Math.abs(left - right) < 0.001;
const samePosition = (left: TwinVector3, right: TwinVector3) => left.every((value, index) => near(value, right[index]));

const looksLikeBuiltInWoodRoute = (route: { points: TwinRoutePointDefinition[] }) => Object.entries(builtInPointXs).every(([pointId, allowedXs]) => {
	const point = route.points.find((item) => item.pointId === pointId);
	if (!point) return false;
	return allowedXs.some((x) => near(point.position[0], x)) && near(point.position[1], 0.72) && near(point.position[2], -11);
});

const mergeEdge = (canonical: TwinRouteEdgeDefinition, previous?: TwinRouteEdgeDefinition): TwinRouteEdgeDefinition => {
	const merged = structuredClone(canonical);
	if (!previous) return merged;
	for (const field of bindingFields) {
		const value = previous[field];
		if (value !== undefined) (merged as any)[field] = value;
	}
	if (previous.occupancyMode) merged.occupancyMode = previous.occupancyMode;
	if (previous.reservationTimeoutSeconds !== undefined) merged.reservationTimeoutSeconds = previous.reservationTimeoutSeconds;
	if (previous.speedLimit !== undefined) merged.speedLimit = previous.speedLimit;
	if (previous.blocked !== undefined) merged.blocked = previous.blocked;
	return merged;
};

/**
 * Upgrade only the built-in silk packaging wood route. User-authored/custom wood routes with
 * non-template coordinates are intentionally left untouched.
 */
export const upgradeSilkPackagingLayout = (manifest: TwinSceneManifest): boolean => {
	const proceduralRoot = manifest.objects.find((item) => item.procedural?.preset === 'silk-cake-packaging-line');
	const isSilkPackaging = Boolean(proceduralRoot);
	if (!isSilkPackaging) return false;
	let changed = false;
	const oldEquipmentPositions = new Map<string, TwinVector3[]>([
		// Older built-in manifests stored the gantry equipment root at the origin.
		// TwinRuntime reapplies equipment transforms after ProceduralPackagingLine builds,
		// so [0,0,0] would move the correctly positioned gantry away from the wood stack.
		['gantry-stacker', [[0, 0, 0]]],
		['cover-applicator', [[33, 0, -11], [35, 0, -11]]],
		['labeler', [[37.5, 0, -11], [51, 0, -11]]],
		['wrapper', [[42, 0, -11], [43, 0, -11]]],
		['inbound-lift', [[48, 0, -11], [59, 0, -11]]],
	]);
	const canonicalEquipment = new Map(createSilkCakeEquipmentObjectDefinitions(proceduralRoot!.objectId)
		.filter((item) => item.equipment)
		.map((item) => [item.equipment!.equipmentType, item]));
	for (const object of manifest.objects.filter((item) => item.kind === 'equipment' && item.equipment?.parentObjectId === proceduralRoot!.objectId)) {
		const oldPositions = oldEquipmentPositions.get(object.equipment!.equipmentType);
		const canonicalObject = canonicalEquipment.get(object.equipment!.equipmentType);
		if (!oldPositions || !canonicalObject || !oldPositions.some((oldPosition) => samePosition(object.transform.position, oldPosition))) continue;
		object.transform.position = [...canonicalObject.transform.position] as TwinVector3;
		changed = true;
	}
	const canonical = createSilkCakeLineTwinSceneManifest().routes.find((item) => item.routeId === WOOD_ROUTE_ID);
	if (!canonical) return false;
	const existing = manifest.routes.find((item) => item.routeId === WOOD_ROUTE_ID);
	if (!existing) {
		manifest.routes.push(structuredClone(canonical));
		return true;
	}
	if (!looksLikeBuiltInWoodRoute(existing)) return changed;

	// 内置丝饼产线的整机设备坐标是程序化机构的世界安装基准，并不是可以独立于工艺路线
	// 任意移动的装饰模型。桁架一旦被单独拖动，其内部丝锭夹具、隔板夹具和隔板暂存台
	// 会整体偏离木托盘码垛位。以木托盘码垛点作为 Z 向行程中心线的安装基准，保证：
	// 丝锭 2×3 阵列中心、两套夹具中心、木托盘停留位和暂存台中心始终共用同一 X 中心。
	const woodStackPoint = existing.points.find((point) => point.pointId === 'silk-wood-stack');
	const gantryEquipment = manifest.objects.find((item) => item.kind === 'equipment'
		&& item.equipment?.parentObjectId === proceduralRoot!.objectId
		&& item.equipment.equipmentType === GANTRY_EQUIPMENT_TYPE);
	if (woodStackPoint && gantryEquipment) {
		const alignedPosition: TwinVector3 = [woodStackPoint.position[0], 0, woodStackPoint.position[2]];
		if (!samePosition(gantryEquipment.transform.position, alignedPosition)) {
			gantryEquipment.transform.position = alignedPosition;
			changed = true;
		}
	}

	const before = JSON.stringify(existing);
	const existingPoints = new Map(existing.points.map((point) => [point.pointId, point]));
	const canonicalPointIds = new Set(canonical.points.map((point) => point.pointId));
	existing.points = [
		...canonical.points.map((point) => {
			const previous = existingPoints.get(point.pointId);
			if (!previous) return structuredClone(point);
			return {
				...previous,
				name: point.name,
				position: [...point.position] as [number, number, number],
				kind: point.kind,
				process: previous.process ? structuredClone(previous.process) : point.process ? structuredClone(point.process) : undefined,
			};
		}),
		...existing.points.filter((point) => !canonicalPointIds.has(point.pointId)),
	];

	const existingEdges = new Map(existing.edges.map((edge) => [edge.edgeId, edge]));
	const canonicalEdgeIds = new Set(canonical.edges.map((edge) => edge.edgeId));
	existing.edges = [
		...canonical.edges.map((edge) => mergeEdge(edge, existingEdges.get(edge.edgeId))),
		...existing.edges.filter((edge) => !canonicalEdgeIds.has(edge.edgeId) && !legacyEdgeIds.has(edge.edgeId)),
	];
	existing.name = canonical.name;
	existing.type = canonical.type;
	existing.curveKind = canonical.curveKind;
	existing.loop = canonical.loop;
	existing.orientToPath = canonical.orientToPath;
	existing.startPointId = canonical.startPointId;
	existing.defaultSpeed = canonical.defaultSpeed;
	return changed || JSON.stringify(existing) !== before;
};
