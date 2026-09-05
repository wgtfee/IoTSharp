import * as THREE from 'three';
import type {
	TwinRouteDefinition,
	TwinRouteEdgeDefinition,
	TwinRoutePointDefinition,
	TwinSceneManifest,
	TwinTransform,
} from '/@/digital-twin/contracts';
import type {
	TwinComponentConnectionDefinition,
	TwinV7SceneObjectDefinition,
} from '/@/digital-twin/contracts/v7-components';
import { defaultComponentRegistry } from './ComponentRegistry';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';
import { applyComponentRoutePointBindings, buildComponentProcessDefinition } from './ComponentBindingResolver';
import type {
	TwinComponentDefinition,
	TwinComponentInternalFlowDefinition,
	TwinComponentInternalFlowPointDefinition,
	TwinComponentPortDefinition,
	TwinComponentPortType,
	TwinComponentType,
	TwinResolvedComponentPort,
} from './types';

export interface TwinResolvedComponentInternalFlowPoint extends TwinComponentInternalFlowPointDefinition {
	worldPosition: THREE.Vector3;
}

export interface TwinResolvedComponentInternalFlow extends Omit<TwinComponentInternalFlowDefinition, 'points'> {
	points: TwinResolvedComponentInternalFlowPoint[];
}

export interface TwinComponentPortRef extends TwinResolvedComponentPort {
	objectId: string;
	objectName: string;
	componentType: TwinComponentType;
	transportUnitType?: string;
	conveyorSizeClass?: string;
}

export interface TwinComponentSnapCandidate {
	moving: TwinComponentPortRef;
	target: TwinComponentPortRef;
	distance: number;
	directionDot: number;
}

export interface TwinComponentSnapOptions {
	maxDistance?: number;
	maxAngleDegrees?: number;
	preferFacingPorts?: boolean;
}

export type TwinSceneTransportUnitType = 'plastic-pallet' | 'wooden-pallet' | 'carton';

export interface TwinTransportRouteSnapCandidate {
	routeId: string;
	routeName: string;
	edgeId: string;
	sectionId: string;
	conveyorObjectId?: string;
	conveyorSizeClass: 'small' | 'large';
	transportUnitType: TwinSceneTransportUnitType;
	distance: number;
	edgeProgress: number;
	routeDistanceMeters: number;
	position: TwinVector3;
	tangent: TwinVector3;
}

export type TwinSceneComponentSnapResult =
	| { kind: 'component-port'; candidate: TwinComponentSnapCandidate; connection: TwinComponentConnectionDefinition; graph?: TwinComponentGraphBuildResult }
	| { kind: 'transport-route'; candidate: TwinTransportRouteSnapCandidate };

export interface TwinComponentGraphBuildResult {
	networkId: string;
	route: TwinRouteDefinition;
	componentObjectIds: string[];
	connectionCount: number;
}

export type TwinComponentNetworkBuildResult = TwinComponentGraphBuildResult;

const DEFAULT_SNAP_DISTANCE = 0.5;
const DEFAULT_SNAP_ANGLE_DEGREES = 15;
const DEFAULT_CONNECTION_TOLERANCE = 0.08;
const LEGACY_GENERATED_ROUTE_ID = 'component-auto-route';
const asV7Objects = (manifest: TwinSceneManifest) => manifest.objects as TwinV7SceneObjectDefinition[];
const portKey = (objectId: string, portId: string) => `${objectId}::${portId}`;
const clampCapacity = (value: unknown) => Math.max(1, Math.min(9999, Math.floor(Number(value) || 1)));
const safeNumber = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const normalizeYaw = (value: number) => {
	let next = value;
	while (next > Math.PI) next -= Math.PI * 2;
	while (next < -Math.PI) next += Math.PI * 2;
	return next;
};
const safeIdPart = (value: string) => value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
const stableHash = (value: string) => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
};

export const isComponentSceneObject = (
	object: TwinV7SceneObjectDefinition | undefined | null,
): object is TwinV7SceneObjectDefinition & { component: NonNullable<TwinV7SceneObjectDefinition['component']> } =>
	Boolean(object && object.kind === 'component' && object.component?.componentType);

const toComponentDefinition = (object: TwinV7SceneObjectDefinition): TwinComponentDefinition => {
	if (!isComponentSceneObject(object)) throw new Error(`对象 ${object.objectId} 不是 V7 Component`);
	return {
		objectId: object.objectId,
		name: object.name,
		resourceKey: object.component.resourceKey,
		componentType: object.component.componentType as TwinComponentType,
		generator: object.component.generator,
		generatorVersion: object.component.generatorVersion,
		resourceId: object.resourceId || object.component.resourceKey,
		resourceVersion: object.component.generatorVersion,
		properties: object.component.properties || {},
		transform: object.transform,
		sectionId: object.component.sectionId,
		routeEdgeId: object.component.routeEdgeId,
	};
};

export const resolveComponentPorts = (object: TwinV7SceneObjectDefinition): TwinComponentPortRef[] => {
	const definition = toComponentDefinition(object);
	const built = defaultComponentRegistry.create(definition);
	try {
		built.root.updateMatrixWorld(true);
		return built.ports.map((port) => ({
			...port,
			objectId: object.objectId,
			objectName: object.name,
			componentType: definition.componentType,
			transportUnitType: typeof definition.properties.transportUnitType === 'string' ? definition.properties.transportUnitType : undefined,
			conveyorSizeClass: typeof definition.properties.conveyorSizeClass === 'string' ? definition.properties.conveyorSizeClass : undefined,
			worldPosition: new THREE.Vector3(...port.localPosition).applyMatrix4(built.root.matrixWorld),
			worldDirection: new THREE.Vector3(...port.localDirection).transformDirection(built.root.matrixWorld).normalize(),
		}));
	} finally {
		built.dispose();
	}
};

/** Resolve the component-owned local material-flow graph into world coordinates. */
export const resolveComponentInternalFlows = (object: TwinV7SceneObjectDefinition): TwinResolvedComponentInternalFlow[] => {
	if (!isComponentSceneObject(object)) return [];
	const definition = toComponentDefinition(object);
	const built = defaultComponentRegistry.create(definition);
	try {
		built.root.updateMatrixWorld(true);
		return (built.internalFlows || []).map((flow) => ({
			...flow,
			points: flow.points.map((point) => ({
				...point,
				worldPosition: new THREE.Vector3(...point.localPosition).applyMatrix4(built.root.matrixWorld),
			})),
		}));
	} finally {
		built.dispose();
	}
};

export const canConnectPortTypes = (left: TwinComponentPortType, right: TwinComponentPortType) => {
	if (left === 'material-bidirectional' || right === 'material-bidirectional') return true;
	return (left === 'material-output' && right === 'material-input') || (left === 'material-input' && right === 'material-output');
};
export const areComponentPortsCompatible = (left: TwinComponentPortRef, right: TwinComponentPortRef) => {
	if (!canConnectPortTypes(left.type, right.type)) return false;
	if (left.transportUnitType && right.transportUnitType && left.transportUnitType !== right.transportUnitType) return false;
	if (left.conveyorSizeClass && right.conveyorSizeClass && left.conveyorSizeClass !== right.conveyorSizeClass) return false;
	const supportsHeightTransition = left.componentType === 'lift' || right.componentType === 'lift';
	if (!supportsHeightTransition && Math.abs(left.worldPosition.y - right.worldPosition.y) > 0.15) return false;
	return true;
};
const portsFaceEachOther = (left: TwinComponentPortRef, right: TwinComponentPortRef, maxAngleDegrees = DEFAULT_SNAP_ANGLE_DEGREES) => {
	const clamped = Math.max(0, Math.min(90, maxAngleDegrees));
	return left.worldDirection.dot(right.worldDirection) <= -Math.cos(THREE.MathUtils.degToRad(clamped));
};
const connectionUsesEndpoint = (connection: TwinComponentConnectionDefinition, objectId: string, portId: string) =>
	(connection.from.objectId === objectId && connection.from.portId === portId)
	|| (connection.to.objectId === objectId && connection.to.portId === portId);

export const findBestComponentSnap = (
	manifest: TwinSceneManifest,
	movingObjectId: string,
	options: TwinComponentSnapOptions = {},
): TwinComponentSnapCandidate | undefined => {
	const movingObject = asV7Objects(manifest).find((item) => item.objectId === movingObjectId);
	if (!isComponentSceneObject(movingObject)) return undefined;
	const maxDistance = Math.max(0.05, options.maxDistance ?? DEFAULT_SNAP_DISTANCE);
	const maxAngleDegrees = options.maxAngleDegrees ?? DEFAULT_SNAP_ANGLE_DEGREES;
	const connections = manifest.connections || [];
	const movingPorts = resolveComponentPorts(movingObject)
		.filter((port) => !connections.some((connection) => connectionUsesEndpoint(connection, movingObjectId, port.portId)));
	if (!movingPorts.length) return undefined;

	const candidates: TwinComponentSnapCandidate[] = [];
	for (const targetObject of asV7Objects(manifest)) {
		if (targetObject.objectId === movingObjectId || !isComponentSceneObject(targetObject)) continue;
		for (const target of resolveComponentPorts(targetObject)) {
			if (connections.some((connection) => connectionUsesEndpoint(connection, target.objectId, target.portId))) continue;
			for (const moving of movingPorts) {
				if (!areComponentPortsCompatible(moving, target)) continue;
				// 3D 场景设计器只允许“已经平行/共线且端口相向”的设备吸附。
				// 90° 垂直、同向或超过实例 snapAngleDegrees 的端口都不能先成为候选再被强行旋转。
				if (!portsFaceEachOther(moving, target, maxAngleDegrees)) continue;
				const distance = moving.worldPosition.distanceTo(target.worldPosition);
				if (distance > maxDistance) continue;
				candidates.push({ moving, target, distance, directionDot: moving.worldDirection.dot(target.worldDirection) });
			}
		}
	}
	candidates.sort((left, right) => {
		if (options.preferFacingPorts !== false) {
			const leftFacing = left.directionDot <= -0.65 ? 0 : 1;
			const rightFacing = right.directionDot <= -0.65 ? 0 : 1;
			if (leftFacing !== rightFacing) return leftFacing - rightFacing;
		}
		return left.distance - right.distance;
	});
	return candidates[0];
};

const orientConnection = (candidate: TwinComponentSnapCandidate): TwinComponentConnectionDefinition => {
	const movingIsOutput = candidate.moving.type === 'material-output';
	const targetIsOutput = candidate.target.type === 'material-output';
	const from = movingIsOutput || (!targetIsOutput && candidate.moving.type === 'material-bidirectional') ? candidate.moving : candidate.target;
	const to = from === candidate.moving ? candidate.target : candidate.moving;
	return {
		connectionId: `connection-${stableHash(`${from.objectId}:${from.portId}->${to.objectId}:${to.portId}`)}`,
		from: { objectId: from.objectId, portId: from.portId },
		to: { objectId: to.objectId, portId: to.portId },
		autoGenerated: true,
	};
};

/** 仅处理编辑器几何吸附；运行时物料阻塞仍由 Capacity + Occupancy + Reserved 决定。 */
export const applyComponentSnap = (
	manifest: TwinSceneManifest,
	movingObjectId: string,
	candidate: TwinComponentSnapCandidate,
): TwinComponentConnectionDefinition | undefined => {
	const movingObject = asV7Objects(manifest).find((item) => item.objectId === movingObjectId);
	if (!isComponentSceneObject(movingObject)) return undefined;
	const desiredDirection = candidate.target.worldDirection.clone().multiplyScalar(-1).setY(0);
	const currentDirection = candidate.moving.worldDirection.clone().setY(0);
	if (desiredDirection.lengthSq() > 0.00001 && currentDirection.lengthSq() > 0.00001) {
		desiredDirection.normalize(); currentDirection.normalize();
		const currentAngle = Math.atan2(currentDirection.z, currentDirection.x);
		const desiredAngle = Math.atan2(desiredDirection.z, desiredDirection.x);
		// Three.js 绕 Y 正向旋转时，本地 +X 的 atan2(z,x) 世界方向角反向变化，因此必须减去方向角差。
		movingObject.transform.rotation[1] = normalizeYaw(movingObject.transform.rotation[1] - normalizeYaw(desiredAngle - currentAngle));
	}
	const refreshedPort = resolveComponentPorts(movingObject).find((port) => port.portId === candidate.moving.portId);
	if (!refreshedPort) return undefined;
	const delta = candidate.target.worldPosition.clone().sub(refreshedPort.worldPosition);
	const placementPlaneY = movingObject.transform.position[1];
	movingObject.transform.position = [
		movingObject.transform.position[0] + delta.x,
		// Port 吸附只对齐水平 X/Z。顶层设备根节点保持原工程水平面，不允许自动上下抬升。
		placementPlaneY,
		movingObject.transform.position[2] + delta.z,
	];
	const connection = orientConnection(candidate);
	manifest.connections ||= [];
	const duplicate = manifest.connections.some((item) =>
		(item.from.objectId === connection.from.objectId && item.from.portId === connection.from.portId && item.to.objectId === connection.to.objectId && item.to.portId === connection.to.portId)
		|| (item.from.objectId === connection.to.objectId && item.from.portId === connection.to.portId && item.to.objectId === connection.from.objectId && item.to.portId === connection.from.portId));
	if (!duplicate) manifest.connections.push(connection);
	return connection;
};

export const snapAndConnectNearestComponent = (manifest: TwinSceneManifest, movingObjectId: string, options: TwinComponentSnapOptions = {}) => {
	const candidate = findBestComponentSnap(manifest, movingObjectId, options);
	if (!candidate) return undefined;
	const connection = applyComponentSnap(manifest, movingObjectId, candidate);
	if (!connection) return undefined;
	return { candidate, connection, graph: upsertGeneratedComponentRoute(manifest) };
};

/** 读取 3D 场景设计器实例级吸附参数；这些参数不属于模型几何，因此不放进 Component Studio。 */
export const resolveSceneComponentSnapOptions = (object: TwinV7SceneObjectDefinition): Required<TwinComponentSnapOptions> => {
	const properties = isComponentSceneObject(object) ? object.component.properties || {} : {};
	return {
		maxDistance: THREE.MathUtils.clamp(safeNumber(properties.snapDistance, DEFAULT_SNAP_DISTANCE), 0.05, 20),
		maxAngleDegrees: THREE.MathUtils.clamp(safeNumber(properties.snapAngleDegrees, DEFAULT_SNAP_ANGLE_DEGREES), 0, 90),
		preferFacingPorts: properties.preferFacingPorts !== false,
	};
};

export const isTransportUnitSceneObject = (object: TwinV7SceneObjectDefinition | undefined | null) => {
	if (!isComponentSceneObject(object)) return false;
	const template = getBuiltInComponentTemplate(object.component.resourceKey);
	return template?.category === 'transport-unit' || template?.capabilities.includes('transport-unit') === true
		|| object.component.componentType === 'pallet' || object.component.componentType === 'carton';
};

export const resolveTransportUnitType = (object: TwinV7SceneObjectDefinition | undefined | null): TwinSceneTransportUnitType | undefined => {
	if (!isTransportUnitSceneObject(object) || !isComponentSceneObject(object)) return undefined;
	if (object.component.componentType === 'carton') return 'carton';
	return object.component.properties?.palletType === 'wooden-pallet' ? 'wooden-pallet' : 'plastic-pallet';
};

const routeSnapSizeClass = (type: TwinSceneTransportUnitType): 'small' | 'large' => type === 'plastic-pallet' ? 'small' : 'large';

const routeEdgeGeometry = (route: TwinRouteDefinition, edge: TwinRouteEdgeDefinition) => {
	const from = route.points.find((point) => point.pointId === edge.fromPointId);
	const to = route.points.find((point) => point.pointId === edge.toPointId);
	if (!from || !to) return undefined;
	const a = new THREE.Vector3(...from.position);
	const b = new THREE.Vector3(...to.position);
	const tangent = b.clone().sub(a);
	if (tangent.lengthSq() < 0.000001) return undefined;
	return { a, b, tangent };
};

const routeDistanceBeforeEdge = (route: TwinRouteDefinition, targetEdgeId: string) => {
	let distance = 0;
	for (const edge of route.edges || []) {
		if (edge.edgeId === targetEdgeId) break;
		const geometry = routeEdgeGeometry(route, edge);
		if (geometry) distance += geometry.a.distanceTo(geometry.b);
	}
	return distance;
};

/**
 * 运输单元不参与 Component Port 网络，而是吸附到已生成/手工输送 Route 的 Section 中心线。
 * 业务约束：小托盘只自动进入 small；木托盘与纸箱只自动进入 large。
 */
export const findBestTransportRouteSnap = (
	manifest: TwinSceneManifest,
	objectId: string,
	options: { maxDistance?: number } = {},
): TwinTransportRouteSnapCandidate | undefined => {
	const object = asV7Objects(manifest).find((item) => item.objectId === objectId);
	const transportUnitType = resolveTransportUnitType(object);
	if (!object || !transportUnitType) return undefined;
	const expectedSizeClass = routeSnapSizeClass(transportUnitType);
	const properties = isComponentSceneObject(object) ? object.component.properties || {} : {};
	const maxDistance = THREE.MathUtils.clamp(safeNumber(options.maxDistance ?? properties.routeSnapDistance, 1.6), 0.05, 20);
	const source = new THREE.Vector3(...object.transform.position);
	const candidates: TwinTransportRouteSnapCandidate[] = [];

	for (const route of manifest.routes || []) {
		for (const edge of route.edges || []) {
			const conveyorSizeClass = edge.conveyorSizeClass === 'large' ? 'large' : 'small';
			if (conveyorSizeClass !== expectedSizeClass) continue;
			const geometry = routeEdgeGeometry(route, edge);
			if (!geometry) continue;
			const planarA = geometry.a.clone().setY(0);
			const planarB = geometry.b.clone().setY(0);
			const planarSource = source.clone().setY(0);
			const segment = planarB.clone().sub(planarA);
			const segmentLengthSq = segment.lengthSq();
			if (segmentLengthSq < 0.000001) continue;
			const edgeProgress = THREE.MathUtils.clamp(planarSource.clone().sub(planarA).dot(segment) / segmentLengthSq, 0, 1);
			const planarClosest = planarA.clone().add(segment.multiplyScalar(edgeProgress));
			const distance = planarClosest.distanceTo(planarSource);
			if (distance > maxDistance) continue;
			const closest = geometry.a.clone().lerp(geometry.b, edgeProgress);
			const tangent = geometry.tangent.normalize();
			candidates.push({
				routeId: route.routeId,
				routeName: route.name,
				edgeId: edge.edgeId,
				sectionId: edge.sectionId || edge.edgeId,
				conveyorObjectId: edge.conveyorObjectId || edge.componentObjectId,
				conveyorSizeClass,
				transportUnitType,
				distance,
				edgeProgress,
				routeDistanceMeters: routeDistanceBeforeEdge(route, edge.edgeId) + geometry.a.distanceTo(geometry.b) * edgeProgress,
				position: [closest.x, closest.y, closest.z],
				tangent: [tangent.x, tangent.y, tangent.z],
			});
		}
	}
	candidates.sort((left, right) => left.distance - right.distance || left.routeId.localeCompare(right.routeId) || left.edgeId.localeCompare(right.edgeId));
	return candidates[0];
};

export const clearTransportRouteAttachment = (object: TwinV7SceneObjectDefinition | undefined | null) => {
	if (!isTransportUnitSceneObject(object) || !isComponentSceneObject(object)) return false;
	const hadAttachment = Boolean(object.component.routeId || object.component.routeEdgeId || object.component.sectionId);
	delete object.component.routeId;
	delete object.component.routeEdgeId;
	delete object.component.routeProgress;
	delete object.component.routeDistanceMeters;
	delete object.component.sectionId;
	return hadAttachment;
};

export const applyTransportRouteSnap = (
	manifest: TwinSceneManifest,
	objectId: string,
	candidate: TwinTransportRouteSnapCandidate,
) => {
	const object = asV7Objects(manifest).find((item) => item.objectId === objectId);
	if (!isTransportUnitSceneObject(object) || !isComponentSceneObject(object)) return false;
	object.transform.position = [...candidate.position];
	const tangent = new THREE.Vector3(...candidate.tangent).setY(0);
	if (tangent.lengthSq() > 0.000001) object.transform.rotation[1] = -Math.atan2(tangent.z, tangent.x);
	object.component.routeId = candidate.routeId;
	object.component.routeEdgeId = candidate.edgeId;
	object.component.sectionId = candidate.sectionId;
	object.component.routeProgress = candidate.edgeProgress;
	object.component.routeDistanceMeters = candidate.routeDistanceMeters;
	object.component.properties ||= {};
	object.component.properties.routeManagedExternally = true;
	return true;
};

export const snapTransportUnitToRoute = (
	manifest: TwinSceneManifest,
	objectId: string,
	options: { maxDistance?: number } = {},
) => {
	const candidate = findBestTransportRouteSnap(manifest, objectId, options);
	if (!candidate || !applyTransportRouteSnap(manifest, objectId, candidate)) return undefined;
	return { candidate };
};

const transportCandidateFromAttachment = (manifest: TwinSceneManifest, object: TwinV7SceneObjectDefinition): TwinTransportRouteSnapCandidate | undefined => {
	if (!isComponentSceneObject(object) || !isTransportUnitSceneObject(object) || !object.component.routeEdgeId) return undefined;
	const transportUnitType = resolveTransportUnitType(object);
	if (!transportUnitType) return undefined;
	const expectedSizeClass = routeSnapSizeClass(transportUnitType);
	const route = (object.component.routeId ? manifest.routes.find((item) => item.routeId === object.component!.routeId && item.edges.some((edge) => edge.edgeId === object.component!.routeEdgeId)) : undefined)
		|| manifest.routes.find((item) => item.edges.some((edge) => edge.edgeId === object.component!.routeEdgeId));
	const edge = route?.edges.find((item) => item.edgeId === object.component!.routeEdgeId);
	if (!route || !edge || (edge.conveyorSizeClass === 'large' ? 'large' : 'small') !== expectedSizeClass) return undefined;
	const geometry = routeEdgeGeometry(route, edge);
	if (!geometry) return undefined;
	const edgeProgress = THREE.MathUtils.clamp(safeNumber(object.component.routeProgress, 0), 0, 1);
	const closest = geometry.a.clone().lerp(geometry.b, edgeProgress);
	const tangent = geometry.tangent.normalize();
	return {
		routeId: route.routeId, routeName: route.name, edgeId: edge.edgeId, sectionId: edge.sectionId || edge.edgeId,
		conveyorObjectId: edge.conveyorObjectId || edge.componentObjectId, conveyorSizeClass: expectedSizeClass, transportUnitType, distance: 0, edgeProgress,
		routeDistanceMeters: routeDistanceBeforeEdge(route, edge.edgeId) + geometry.a.distanceTo(geometry.b) * edgeProgress,
		position: [closest.x, closest.y, closest.z], tangent: [tangent.x, tangent.y, tangent.z],
	};
};

/** Route/Connection 重建后，让已挂接运输单元继续跟随原 RouteEdge，而不是留在旧世界坐标。 */
export const refreshAttachedTransportUnits = (manifest: TwinSceneManifest) => {
	let refreshed = 0;
	for (const object of asV7Objects(manifest)) {
		if (!isTransportUnitSceneObject(object) || !isComponentSceneObject(object) || !object.component.routeEdgeId) continue;
		const candidate = transportCandidateFromAttachment(manifest, object);
		if (candidate && applyTransportRouteSnap(manifest, object.objectId, candidate)) { refreshed += 1; continue; }
		if (object.component.properties?.autoSnap === false) continue;
		const rebound = snapTransportUnitToRoute(manifest, object.objectId);
		if (rebound) refreshed += 1;
		else clearTransportRouteAttachment(object);
	}
	return refreshed;
};

/** 3D 场景设计器统一吸附入口：设备走 Port Connection，运输单元走 Route/Section。 */
export const snapSceneComponent = (
	manifest: TwinSceneManifest,
	objectId: string,
	options: { force?: boolean; maxDistance?: number; maxAngleDegrees?: number; preferFacingPorts?: boolean } = {},
): TwinSceneComponentSnapResult | undefined => {
	const object = asV7Objects(manifest).find((item) => item.objectId === objectId);
	if (!isComponentSceneObject(object)) return undefined;
	if (!options.force && object.component.properties?.autoSnap === false) return undefined;
	if (isTransportUnitSceneObject(object)) {
		const routeResult = snapTransportUnitToRoute(manifest, objectId, { maxDistance: options.maxDistance });
		return routeResult ? { kind: 'transport-route', candidate: routeResult.candidate } : undefined;
	}
	const configured = resolveSceneComponentSnapOptions(object);
	const portResult = snapAndConnectNearestComponent(manifest, objectId, {
		maxDistance: options.maxDistance ?? configured.maxDistance,
		maxAngleDegrees: options.maxAngleDegrees ?? configured.maxAngleDegrees,
		preferFacingPorts: options.preferFacingPorts ?? configured.preferFacingPorts,
	});
	return portResult ? { kind: 'component-port', ...portResult } : undefined;
};

export const removeComponentConnection = (manifest: TwinSceneManifest, connectionId: string) => {
	const before = manifest.connections?.length || 0;
	manifest.connections = (manifest.connections || []).filter((item) => item.connectionId !== connectionId);
	if (before !== manifest.connections.length) upsertGeneratedComponentRoute(manifest);
	return before !== manifest.connections.length;
};
export const removeConnectionsForObject = (manifest: TwinSceneManifest, objectId: string) => {
	manifest.connections = (manifest.connections || []).filter((item) => item.from.objectId !== objectId && item.to.objectId !== objectId);
	upsertGeneratedComponentRoute(manifest);
};

/**
 * 组件移动、旋转或重建后重新校验物理 Connection。失去端口、输送对象不兼容、
 * 方向不再相向或端口已经分离的连接会被删除，避免 Route 继续沿用“幽灵连接”。
 */
export const revalidateComponentConnections = (
	manifest: TwinSceneManifest,
	options: { maxDistance?: number; maxAngleDegrees?: number } = {},
) => {
	const maxDistance = Math.max(0.001, options.maxDistance ?? DEFAULT_CONNECTION_TOLERANCE);
	const maxAngleDegrees = options.maxAngleDegrees ?? DEFAULT_SNAP_ANGLE_DEGREES;
	const index = new Map<string, TwinComponentPortRef>();
	for (const object of asV7Objects(manifest)) {
		if (!isComponentSceneObject(object)) continue;
		for (const port of resolveComponentPorts(object)) index.set(portKey(object.objectId, port.portId), port);
	}
	const removedConnectionIds: string[] = [];
	manifest.connections = (manifest.connections || []).filter((connection) => {
		const from = index.get(portKey(connection.from.objectId, connection.from.portId));
		const to = index.get(portKey(connection.to.objectId, connection.to.portId));
		if (connection.metadata?.topologyBridge === true) {
			const validBridge = Boolean(from && to && areComponentPortsCompatible(from, to));
			if (!validBridge) removedConnectionIds.push(connection.connectionId);
			return validBridge;
		}
		const valid = Boolean(from && to
			&& areComponentPortsCompatible(from, to)
			&& portsFaceEachOther(from, to, maxAngleDegrees)
			&& from.worldPosition.distanceTo(to.worldPosition) <= maxDistance);
		if (!valid) removedConnectionIds.push(connection.connectionId);
		return valid;
	});
	if (removedConnectionIds.length) upsertGeneratedComponentRoute(manifest);
	return removedConnectionIds;
};

class UnionFind {
	private readonly parent = new Map<string, string>();
	add(value: string) { if (!this.parent.has(value)) this.parent.set(value, value); }
	find(value: string): string {
		this.add(value); const parent = this.parent.get(value)!;
		if (parent === value) return value;
		const root = this.find(parent); this.parent.set(value, root); return root;
	}
	union(left: string, right: string) {
		const a = this.find(left), b = this.find(right); if (a === b) return;
		this.parent.set(a < b ? b : a, a < b ? a : b);
	}
}

interface FlowPair { fromPortId: string; toPortId: string; bidirectional?: boolean }
const flowPairsFor = (componentType: TwinComponentType, ports: TwinComponentPortDefinition[]): FlowPair[] => {
	const has = (portId: string) => ports.some((port) => port.portId === portId);
	if (componentType === 'diverter-conveyor') return ['output-a', 'output-b'].filter(has).map((toPortId) => ({ fromPortId: 'input', toPortId }));
	if (componentType === 'merger-conveyor') return ['input-a', 'input-b'].filter(has).map((fromPortId) => ({ fromPortId, toPortId: 'output' }));
	if (componentType === 'lift') return [
		{ fromPortId: 'input-lower', toPortId: 'output-upper' },
		{ fromPortId: 'input-upper', toPortId: 'output-lower' },
	].filter((pair) => has(pair.fromPortId) && has(pair.toPortId));
	if (componentType === 'turntable') return [
		{ fromPortId: 'input', toPortId: 'output' },
		{ fromPortId: 'input', toPortId: 'side-a', bidirectional: true },
		{ fromPortId: 'input', toPortId: 'side-b', bidirectional: true },
		{ fromPortId: 'side-a', toPortId: 'output', bidirectional: true },
		{ fromPortId: 'side-b', toPortId: 'output', bidirectional: true },
		{ fromPortId: 'side-a', toPortId: 'side-b', bidirectional: true },
	].filter((pair) => has(pair.fromPortId) && has(pair.toPortId));
	const inputs = ports.filter((port) => port.type === 'material-input');
	const outputs = ports.filter((port) => port.type === 'material-output');
	if (inputs.length && outputs.length) return inputs.flatMap((input) => outputs.map((output) => ({ fromPortId: input.portId, toPortId: output.portId })));
	const bidirectional = ports.filter((port) => port.type === 'material-bidirectional');
	return bidirectional.slice(1).map((port) => ({ fromPortId: bidirectional[0].portId, toPortId: port.portId, bidirectional: true }));
};

const pointKindForMembers = (members: TwinComponentPortRef[]): Pick<TwinRoutePointDefinition, 'kind' | 'process'> =>
	members.some((member) => member.componentType === 'lift') ? { kind: 'station' } : { kind: 'buffer' };
const resolveObjectProperties = (object: TwinV7SceneObjectDefinition) => isComponentSceneObject(object) ? object.component.properties || {} : {};

const getComponentNetworks = (manifest: TwinSceneManifest) => {
	const components = asV7Objects(manifest).filter((item) => {
		if (!isComponentSceneObject(item) || item.component.properties?.routeManagedExternally === true) return false;
		const template = getBuiltInComponentTemplate(item.component.resourceKey);
		return template?.capabilities.includes('material-flow') === true;
	});
	const byId = new Map(components.map((item) => [item.objectId, item]));
	const union = new UnionFind();
	for (const component of components) union.add(component.objectId);
	for (const connection of manifest.connections || []) {
		if (byId.has(connection.from.objectId) && byId.has(connection.to.objectId)) union.union(connection.from.objectId, connection.to.objectId);
	}
	const groups = new Map<string, TwinV7SceneObjectDefinition[]>();
	for (const component of components) {
		const root = union.find(component.objectId);
		groups.set(root, [...(groups.get(root) || []), component]);
	}
	return [...groups.values()]
		.map((items) => items.sort((left, right) => left.objectId.localeCompare(right.objectId)))
		.sort((left, right) => left[0].objectId.localeCompare(right[0].objectId));
};

/** connections 描述物理端口；Section/RouteEdge 描述组件内部可占用输送段。 */
const buildComponentNetworkRoute = (manifest: TwinSceneManifest, objects: TwinV7SceneObjectDefinition[]): TwinComponentNetworkBuildResult => {
	const objectIds = new Set(objects.map((item) => item.objectId));
	const sortedObjectIds = [...objectIds].sort();
	const networkHash = stableHash(sortedObjectIds.join('|'));
	const networkId = `component-network-${networkHash}`;
	const portsByObject = new Map<string, TwinComponentPortRef[]>();
	const portIndex = new Map<string, TwinComponentPortRef>();
	const union = new UnionFind();
	for (const object of objects) {
		const ports = resolveComponentPorts(object); portsByObject.set(object.objectId, ports);
		for (const port of ports) { const key = portKey(object.objectId, port.portId); portIndex.set(key, port); union.add(key); }
	}
	const networkConnections = (manifest.connections || []).filter((connection) => objectIds.has(connection.from.objectId) && objectIds.has(connection.to.objectId));
	for (const connection of networkConnections) {
		const fromKey = portKey(connection.from.objectId, connection.from.portId);
		const toKey = portKey(connection.to.objectId, connection.to.portId);
		if (portIndex.has(fromKey) && portIndex.has(toKey)) union.union(fromKey, toKey);
	}
	const groups = new Map<string, TwinComponentPortRef[]>();
	for (const [key, port] of portIndex) { const root = union.find(key); groups.set(root, [...(groups.get(root) || []), port]); }
	const pointIdByPort = new Map<string, string>();
	const points: TwinRoutePointDefinition[] = [];
	for (const members of groups.values()) {
		const sortedKeys = members.map((member) => portKey(member.objectId, member.portId)).sort();
		const pointId = `component-point-${stableHash(sortedKeys.join('|'))}`;
		for (const member of members) pointIdByPort.set(portKey(member.objectId, member.portId), pointId);
		const position = members.reduce((sum, member) => sum.add(member.worldPosition), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, members.length));
		const kind = pointKindForMembers(members);
		const sourceMember = members[0];
		const point: TwinRoutePointDefinition = {
			pointId,
			name: members.length > 1 ? members.map((member) => `${member.objectName}.${member.name}`).join(' ↔ ') : `${members[0].objectName}.${members[0].name}`,
			position: [position.x, position.y, position.z],
			kind: kind.kind,
			process: kind.process ? { ...kind.process } : undefined,
			componentObjectId: sourceMember?.objectId,
			componentPortId: sourceMember?.portId,
		};
		const source = objects.find((item) => item.objectId === sourceMember?.objectId);
		if (point.process && source) {
			point.process = buildComponentProcessDefinition(manifest, source, point.process.type);
		}
		if (source) applyComponentRoutePointBindings(manifest, source, point);
		points.push(point);
	}
	const edges: TwinRouteEdgeDefinition[] = [];
	for (const object of objects) {
		const ports = portsByObject.get(object.objectId) || [];
		const properties = resolveObjectProperties(object);
		const internalFlows = resolveComponentInternalFlows(object);
		if (internalFlows.length) {
			for (const flow of internalFlows) {
				const routePointIds = new Map<string, string>();
				for (const internalPoint of flow.points) {
					let routePointId = internalPoint.portId
						? pointIdByPort.get(portKey(object.objectId, internalPoint.portId))
						: undefined;
					if (!routePointId) {
						routePointId = `component-point-${safeIdPart(object.objectId)}-${safeIdPart(flow.flowId)}-${safeIdPart(internalPoint.pointId)}`;
						const routePoint: TwinRoutePointDefinition = {
							pointId: routePointId,
							name: `${object.name} · ${internalPoint.name}`,
							position: [internalPoint.worldPosition.x, internalPoint.worldPosition.y, internalPoint.worldPosition.z],
							kind: internalPoint.kind || 'buffer',
							componentObjectId: object.objectId,
							componentPortId: internalPoint.portId,
						};
						if (internalPoint.processType) {
							routePoint.kind = 'processStation';
							routePoint.process = buildComponentProcessDefinition(manifest, object, internalPoint.processType as any);
						}
						applyComponentRoutePointBindings(manifest, object, routePoint);
						points.push(routePoint);
					}
					routePointIds.set(internalPoint.pointId, routePointId);
				}
				for (const internalEdge of flow.edges) {
					const fromPointId = routePointIds.get(internalEdge.fromPointId);
					const toPointId = routePointIds.get(internalEdge.toPointId);
					if (!fromPointId || !toPointId || fromPointId === toPointId) continue;
					const conveyorSizeClass = flow.conveyorSizeClass || (properties.conveyorSizeClass === 'large' ? 'large' : 'small');
					const transportUnitType = flow.transportUnitType || (properties.transportUnitType === 'wooden-pallet' ? 'wooden-pallet' : properties.transportUnitType === 'carton' ? 'carton' : 'plastic-pallet');
					edges.push({
						edgeId: `component-edge-${safeIdPart(object.objectId)}-${safeIdPart(flow.flowId)}-${safeIdPart(internalEdge.edgeId)}`,
						fromPointId,
						toPointId,
						name: internalEdge.name || `${object.name} · ${flow.name}`,
						bidirectional: internalEdge.bidirectional === true,
						enabled: true,
						priority: 0,
						capacity: clampCapacity(internalEdge.capacity ?? properties.capacity),
						occupancyMode: properties.occupancyMode === 'live' ? 'live' : properties.occupancyMode === 'calculated' ? 'calculated' : 'simulation',
						reservationTimeoutSeconds: Math.max(1, safeNumber(properties.reservationTimeoutSeconds, 30)),
						speedLimit: Math.max(0.01, safeNumber(internalEdge.speedLimit ?? properties.speedLimit, 1.2)),
						conveyorSizeClass,
						transportUnitType,
						transportUnitResourceKey: transportUnitType === 'plastic-pallet' && conveyorSizeClass === 'small' ? 'builtin-small-pallet' : undefined,
						conveyorObjectId: object.objectId,
						componentObjectId: object.objectId,
						sectionId: object.component.sectionId || `section-${object.objectId}`,
					});
				}
			}
			continue;
		}
		// Compatibility fallback for old component generators that do not yet expose internalFlows.
		for (const pair of flowPairsFor(object.component.componentType as TwinComponentType, ports)) {
			const fromPointId = pointIdByPort.get(portKey(object.objectId, pair.fromPortId));
			const toPointId = pointIdByPort.get(portKey(object.objectId, pair.toPortId));
			if (!fromPointId || !toPointId || fromPointId === toPointId) continue;
			edges.push({
				edgeId: `component-edge-${safeIdPart(object.objectId)}-${safeIdPart(pair.fromPortId)}-${safeIdPart(pair.toPortId)}`,
				fromPointId, toPointId,
				name: `${object.name} · ${pair.fromPortId} → ${pair.toPortId}`,
				bidirectional: pair.bidirectional === true,
				enabled: true, priority: 0,
				capacity: clampCapacity(properties.capacity),
				occupancyMode: properties.occupancyMode === 'live' ? 'live' : properties.occupancyMode === 'calculated' ? 'calculated' : 'simulation',
				reservationTimeoutSeconds: Math.max(1, safeNumber(properties.reservationTimeoutSeconds, 30)),
				speedLimit: Math.max(0.01, safeNumber(properties.speedLimit, 1.2)),
				conveyorSizeClass: properties.conveyorSizeClass === 'large' ? 'large' : 'small',
				transportUnitType: properties.transportUnitType === 'wooden-pallet' ? 'wooden-pallet' : properties.transportUnitType === 'carton' ? 'carton' : 'plastic-pallet',
				conveyorObjectId: object.objectId,
				componentObjectId: object.objectId,
				sectionId: object.component.sectionId || `section-${object.objectId}`,
			});
		}
	}
	const incoming = new Set(edges.map((edge) => edge.toPointId));
	const route: TwinRouteDefinition = {
		routeId: `component-route-${networkHash}`,
		name: `V7 组件自动路线 · ${objects.map((item) => item.name).slice(0, 2).join(' / ')}${objects.length > 2 ? ` 等 ${objects.length} 台` : ''}`,
		type: 'conveyor', curveKind: 'line', defaultSpeed: 1.2, loop: false, orientToPath: true,
		points, edges,
		startPointId: points.find((point) => !incoming.has(point.pointId))?.pointId || points[0]?.pointId,
		junctionDecisions: {}, routingMode: 'automatic', decisionRules: [], generatedBy: 'component-connections', componentNetworkId: networkId,
	};
	return { networkId, route, componentObjectIds: sortedObjectIds, connectionCount: networkConnections.length };
};

export const buildComponentGraphRoutes = (manifest: TwinSceneManifest): TwinComponentNetworkBuildResult[] =>
	getComponentNetworks(manifest).map((objects) => buildComponentNetworkRoute(manifest, objects));

/** @deprecated 使用 buildComponentGraphRoutes；保留给旧扩展的单网络兼容入口。 */
export const buildComponentGraphRoute = (manifest: TwinSceneManifest): TwinComponentGraphBuildResult => {
	const first = buildComponentGraphRoutes(manifest)[0];
	if (!first) throw new Error('当前场景没有可生成路线的 V7 Component Network');
	return first;
};

export const upsertGeneratedComponentRoutes = (manifest: TwinSceneManifest): TwinComponentNetworkBuildResult[] => {
	const components = asV7Objects(manifest).filter((item) => {
		if (!isComponentSceneObject(item) || item.component.properties?.routeManagedExternally === true) return false;
		return getBuiltInComponentTemplate(item.component.resourceKey)?.capabilities.includes('material-flow') === true;
	});
	const retainedRoutes = manifest.routes.filter((item) => item.generatedBy !== 'component-connections' && item.routeId !== LEGACY_GENERATED_ROUTE_ID);
	if (!components.length) { manifest.routes = retainedRoutes; return []; }
	const results = buildComponentGraphRoutes(manifest);
	const generatedRoutes = results.map((item) => item.route);
	manifest.routes = asV7Objects(manifest).some((item) => item.kind === 'procedural')
		? [...retainedRoutes, ...generatedRoutes]
		: [...generatedRoutes, ...retainedRoutes];
	for (const object of components) {
		const firstEdge = results.flatMap((item) => item.route.edges).find((edge) => edge.componentObjectId === object.objectId);
		object.component.sectionId ||= `section-${object.objectId}`;
		object.component.routeEdgeId = firstEdge?.edgeId;
	}
	refreshAttachedTransportUnits(manifest);
	return results;
};

/** 兼容旧调用方；内部始终重建全部独立 Network。 */
export const upsertGeneratedComponentRoute = (manifest: TwinSceneManifest): TwinComponentGraphBuildResult | undefined =>
	upsertGeneratedComponentRoutes(manifest)[0];

export const getComponentTemplateForObject = (object: TwinV7SceneObjectDefinition | undefined) =>
	isComponentSceneObject(object) ? getBuiltInComponentTemplate(object.component.resourceKey) : undefined;
export const cloneTransform = (transform: TwinTransform): TwinTransform => ({
	position: [...transform.position], rotation: [...transform.rotation], scale: [...transform.scale],
});
