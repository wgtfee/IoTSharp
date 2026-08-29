import * as THREE from 'three';
import type {
	TwinComponentConnectionDefinition,
	TwinRouteDefinition,
	TwinRouteEdgeDefinition,
	TwinRoutePointDefinition,
	TwinSceneManifest,
	TwinSceneObjectDefinition,
	TwinTransform,
} from '/@/digital-twin/contracts';
import { defaultComponentRegistry } from './ComponentRegistry';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';
import type {
	TwinComponentDefinition,
	TwinComponentPortDefinition,
	TwinComponentPortType,
	TwinComponentType,
	TwinResolvedComponentPort,
} from './types';

export interface TwinComponentPortRef extends TwinResolvedComponentPort {
	objectId: string;
	objectName: string;
	componentType: TwinComponentType;
}

export interface TwinComponentSnapCandidate {
	moving: TwinComponentPortRef;
	target: TwinComponentPortRef;
	distance: number;
	directionDot: number;
}

export interface TwinComponentSnapOptions {
	maxDistance?: number;
	/** 水平端口夹角仅用于排序；实际吸附时会自动旋转移动组件。 */
	preferFacingPorts?: boolean;
}

export interface TwinComponentGraphBuildResult {
	route: TwinRouteDefinition;
	componentObjectIds: string[];
	connectionCount: number;
}

const DEFAULT_SNAP_DISTANCE = 1.5;
const GENERATED_ROUTE_ID = 'component-auto-route';
const GENERATED_ROUTE_NAME = 'V7 组件自动路线';

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

export const isComponentSceneObject = (object: TwinSceneObjectDefinition | undefined | null): object is TwinSceneObjectDefinition & { component: NonNullable<TwinSceneObjectDefinition['component']> } =>
	Boolean(object && object.kind === 'component' && object.component?.componentType);

const toComponentDefinition = (object: TwinSceneObjectDefinition): TwinComponentDefinition => {
	if (!isComponentSceneObject(object)) throw new Error(`对象 ${object.objectId} 不是 V7 Component`);
	return {
		objectId: object.objectId,
		name: object.name,
		componentType: object.component.componentType as TwinComponentType,
		resourceId: object.resourceId || object.component.resourceKey,
		resourceVersion: object.component.generatorVersion,
		properties: object.component.properties || {},
		transform: object.transform,
		sectionId: object.component.sectionId,
		routeEdgeId: object.component.routeEdgeId,
	};
};

export const resolveComponentPorts = (object: TwinSceneObjectDefinition): TwinComponentPortRef[] => {
	const definition = toComponentDefinition(object);
	const built = defaultComponentRegistry.create(definition);
	try {
		built.root.updateMatrixWorld(true);
		return built.ports.map((port) => ({
			...port,
			objectId: object.objectId,
			objectName: object.name,
			componentType: definition.componentType,
			worldPosition: new THREE.Vector3(...port.localPosition).applyMatrix4(built.root.matrixWorld),
			worldDirection: new THREE.Vector3(...port.localDirection).transformDirection(built.root.matrixWorld).normalize(),
		}));
	} finally {
		built.dispose();
	}
};

const canConnectPortTypes = (left: TwinComponentPortType, right: TwinComponentPortType) => {
	if (left === 'material-bidirectional' || right === 'material-bidirectional') return true;
	return (left === 'material-output' && right === 'material-input') || (left === 'material-input' && right === 'material-output');
};

const connectionUsesEndpoint = (connection: TwinComponentConnectionDefinition, objectId: string, portId: string) =>
	(connection.from.objectId === objectId && connection.from.portId === portId)
	|| (connection.to.objectId === objectId && connection.to.portId === portId);

export const findBestComponentSnap = (
	manifest: TwinSceneManifest,
	movingObjectId: string,
	options: TwinComponentSnapOptions = {},
): TwinComponentSnapCandidate | undefined => {
	const movingObject = manifest.objects.find((item) => item.objectId === movingObjectId);
	if (!isComponentSceneObject(movingObject)) return undefined;
	const maxDistance = Math.max(0.05, options.maxDistance ?? DEFAULT_SNAP_DISTANCE);
	const connections = manifest.connections || [];
	const movingPorts = resolveComponentPorts(movingObject)
		.filter((port) => !connections.some((connection) => connectionUsesEndpoint(connection, movingObjectId, port.portId)));
	if (!movingPorts.length) return undefined;

	const candidates: TwinComponentSnapCandidate[] = [];
	for (const targetObject of manifest.objects) {
		if (targetObject.objectId === movingObjectId || !isComponentSceneObject(targetObject)) continue;
		for (const target of resolveComponentPorts(targetObject)) {
			if (connections.some((connection) => connectionUsesEndpoint(connection, target.objectId, target.portId))) continue;
			for (const moving of movingPorts) {
				if (!canConnectPortTypes(moving.type, target.type)) continue;
				const distance = moving.worldPosition.distanceTo(target.worldPosition);
				if (distance > maxDistance) continue;
				candidates.push({
					moving,
					target,
					distance,
					directionDot: moving.worldDirection.dot(target.worldDirection),
				});
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
	const from = movingIsOutput || (!targetIsOutput && candidate.moving.type === 'material-bidirectional')
		? candidate.moving
		: candidate.target;
	const to = from === candidate.moving ? candidate.target : candidate.moving;
	return {
		connectionId: `connection-${stableHash(`${from.objectId}:${from.portId}->${to.objectId}:${to.portId}`)}`,
		from: { objectId: from.objectId, portId: from.portId },
		to: { objectId: to.objectId, portId: to.portId },
		autoGenerated: true,
	};
};

/**
 * 旋转移动组件使端口方向与目标端口相反，再做精确平移；不使用 Box3 碰撞或安全距离作为正常输送逻辑。
 */
export const applyComponentSnap = (
	manifest: TwinSceneManifest,
	movingObjectId: string,
	candidate: TwinComponentSnapCandidate,
): TwinComponentConnectionDefinition | undefined => {
	const movingObject = manifest.objects.find((item) => item.objectId === movingObjectId);
	if (!isComponentSceneObject(movingObject)) return undefined;

	const desiredDirection = candidate.target.worldDirection.clone().multiplyScalar(-1).setY(0);
	const currentDirection = candidate.moving.worldDirection.clone().setY(0);
	if (desiredDirection.lengthSq() > 0.00001 && currentDirection.lengthSq() > 0.00001) {
		desiredDirection.normalize();
		currentDirection.normalize();
		const currentAngle = Math.atan2(currentDirection.z, currentDirection.x);
		const desiredAngle = Math.atan2(desiredDirection.z, desiredDirection.x);
		movingObject.transform.rotation[1] = normalizeYaw(movingObject.transform.rotation[1] + normalizeYaw(desiredAngle - currentAngle));
	}

	const refreshedPort = resolveComponentPorts(movingObject).find((port) => port.portId === candidate.moving.portId);
	if (!refreshedPort) return undefined;
	const delta = candidate.target.worldPosition.clone().sub(refreshedPort.worldPosition);
	movingObject.transform.position = [
		movingObject.transform.position[0] + delta.x,
		movingObject.transform.position[1] + delta.y,
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

export const snapAndConnectNearestComponent = (
	manifest: TwinSceneManifest,
	movingObjectId: string,
	options: TwinComponentSnapOptions = {},
) => {
	const candidate = findBestComponentSnap(manifest, movingObjectId, options);
	if (!candidate) return undefined;
	const connection = applyComponentSnap(manifest, movingObjectId, candidate);
	if (!connection) return undefined;
	const graph = upsertGeneratedComponentRoute(manifest);
	return { candidate, connection, graph };
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

class UnionFind {
	private readonly parent = new Map<string, string>();
	add(value: string) { if (!this.parent.has(value)) this.parent.set(value, value); }
	find(value: string): string {
		this.add(value);
		const parent = this.parent.get(value)!;
		if (parent === value) return value;
		const root = this.find(parent);
		this.parent.set(value, root);
		return root;
	}
	union(left: string, right: string) {
		const a = this.find(left), b = this.find(right);
		if (a === b) return;
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
	if (componentType === 'turntable') {
		const pairs: FlowPair[] = [
			{ fromPortId: 'input', toPortId: 'output' },
			{ fromPortId: 'input', toPortId: 'side-a', bidirectional: true },
			{ fromPortId: 'input', toPortId: 'side-b', bidirectional: true },
			{ fromPortId: 'side-a', toPortId: 'output', bidirectional: true },
			{ fromPortId: 'side-b', toPortId: 'output', bidirectional: true },
			{ fromPortId: 'side-a', toPortId: 'side-b', bidirectional: true },
		];
		return pairs.filter((pair) => has(pair.fromPortId) && has(pair.toPortId));
	}
	const inputs = ports.filter((port) => port.type === 'material-input');
	const outputs = ports.filter((port) => port.type === 'material-output');
	if (inputs.length && outputs.length) return inputs.flatMap((input) => outputs.map((output) => ({ fromPortId: input.portId, toPortId: output.portId })));
	const bidirectional = ports.filter((port) => port.type === 'material-bidirectional');
	return bidirectional.slice(1).map((port) => ({ fromPortId: bidirectional[0].portId, toPortId: port.portId, bidirectional: true }));
};

const pointKindForMembers = (
	members: TwinComponentPortRef[],
): Pick<TwinRoutePointDefinition, 'kind' | 'process'> => {
	for (const member of members) {
		if (member.componentType === 'diverter-conveyor' && member.portId === 'input') return { kind: 'diverter' };
		if (member.componentType === 'merger-conveyor' && member.portId === 'output') return { kind: 'merger' };
		if (member.componentType === 'turntable') return { kind: 'junction' };
		if (member.componentType === 'external-inspection' && member.portId === 'input') return { kind: 'processStation', process: { type: 'external-inspection' } };
		if (member.componentType === 'bagging-machine' && member.portId === 'input') return { kind: 'processStation', process: { type: 'bagging' } };
		if (member.componentType === 'lift') return { kind: 'station' };
	}
	return { kind: 'buffer' };
};

const resolveObjectProperties = (object: TwinSceneObjectDefinition) => isComponentSceneObject(object) ? object.component.properties || {} : {};

/**
 * connections 只描述物理端口相连。路线采用“连接端口节点合并 + 组件内部 Section Edge”的方式生成，
 * 因此两个已吸附端口不会额外产生零长度缓存段。
 */
export const buildComponentGraphRoute = (manifest: TwinSceneManifest): TwinComponentGraphBuildResult => {
	const objects = manifest.objects.filter(isComponentSceneObject);
	const portsByObject = new Map<string, TwinComponentPortRef[]>();
	const portIndex = new Map<string, TwinComponentPortRef>();
	const union = new UnionFind();
	for (const object of objects) {
		const ports = resolveComponentPorts(object);
		portsByObject.set(object.objectId, ports);
		for (const port of ports) {
			const key = portKey(object.objectId, port.portId);
			portIndex.set(key, port);
			union.add(key);
		}
	}
	for (const connection of manifest.connections || []) {
		const fromKey = portKey(connection.from.objectId, connection.from.portId);
		const toKey = portKey(connection.to.objectId, connection.to.portId);
		if (portIndex.has(fromKey) && portIndex.has(toKey)) union.union(fromKey, toKey);
	}

	const groups = new Map<string, TwinComponentPortRef[]>();
	for (const [key, port] of portIndex) {
		const root = union.find(key);
		const members = groups.get(root) || [];
		members.push(port);
		groups.set(root, members);
	}
	const pointIdByPort = new Map<string, string>();
	const points: TwinRoutePointDefinition[] = [];
	for (const members of groups.values()) {
		const sortedKeys = members.map((member) => portKey(member.objectId, member.portId)).sort();
		const pointId = `component-point-${stableHash(sortedKeys.join('|'))}`;
		for (const member of members) pointIdByPort.set(portKey(member.objectId, member.portId), pointId);
		const position = members.reduce((sum, member) => sum.add(member.worldPosition), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, members.length));
		const kind = pointKindForMembers(members);
		const process = kind.process ? { ...kind.process } : undefined;
		if (process) {
			const sourceObject = objects.find((item) => item.objectId === members[0]?.objectId);
			const cycleSeconds = safeNumber(resolveObjectProperties(sourceObject!).cycleSeconds, 2);
			process.cycleSeconds = Math.max(0.1, cycleSeconds);
		}
		points.push({
			pointId,
			name: members.length > 1 ? members.map((member) => `${member.objectName}.${member.name}`).join(' ↔ ') : `${members[0].objectName}.${members[0].name}`,
			position: [position.x, position.y, position.z],
			kind: kind.kind,
			process,
			componentObjectId: members[0]?.objectId,
			componentPortId: members[0]?.portId,
		});
	}

	const edges: TwinRouteEdgeDefinition[] = [];
	for (const object of objects) {
		const ports = portsByObject.get(object.objectId) || [];
		const properties = resolveObjectProperties(object);
		const pairs = flowPairsFor(object.component.componentType as TwinComponentType, ports);
		for (const pair of pairs) {
			const fromPointId = pointIdByPort.get(portKey(object.objectId, pair.fromPortId));
			const toPointId = pointIdByPort.get(portKey(object.objectId, pair.toPortId));
			if (!fromPointId || !toPointId || fromPointId === toPointId) continue;
			const edgeId = `component-edge-${safeIdPart(object.objectId)}-${safeIdPart(pair.fromPortId)}-${safeIdPart(pair.toPortId)}`;
			edges.push({
				edgeId,
				fromPointId,
				toPointId,
				name: `${object.name} · ${pair.fromPortId} → ${pair.toPortId}`,
				bidirectional: pair.bidirectional === true,
				enabled: true,
				priority: 0,
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
	const startPointId = points.find((point) => !incoming.has(point.pointId))?.pointId || points[0]?.pointId;
	const route: TwinRouteDefinition = {
		routeId: GENERATED_ROUTE_ID,
		name: GENERATED_ROUTE_NAME,
		type: 'conveyor',
		curveKind: 'line',
		defaultSpeed: 1.2,
		loop: false,
		orientToPath: true,
		points,
		edges,
		startPointId,
		junctionDecisions: {},
		routingMode: 'automatic',
		decisionRules: [],
		generatedBy: 'component-connections',
	};
	return { route, componentObjectIds: objects.map((item) => item.objectId), connectionCount: manifest.connections?.length || 0 };
};

export const upsertGeneratedComponentRoute = (manifest: TwinSceneManifest): TwinComponentGraphBuildResult | undefined => {
	const components = manifest.objects.filter(isComponentSceneObject);
	const existingIndex = manifest.routes.findIndex((item) => item.generatedBy === 'component-connections' || item.routeId === GENERATED_ROUTE_ID);
	if (!components.length) {
		if (existingIndex >= 0) manifest.routes.splice(existingIndex, 1);
		return undefined;
	}
	const result = buildComponentGraphRoute(manifest);
	if (existingIndex >= 0) manifest.routes.splice(existingIndex, 1, result.route);
	else {
		const hasProcedural = manifest.objects.some((item) => item.kind === 'procedural');
		if (hasProcedural) manifest.routes.push(result.route);
		else manifest.routes.unshift(result.route);
	}
	for (const object of components) {
		const firstEdge = result.route.edges.find((edge) => edge.componentObjectId === object.objectId);
		object.component.sectionId ||= `section-${object.objectId}`;
		object.component.routeEdgeId = firstEdge?.edgeId;
	}
	return result;
};

export const getComponentTemplateForObject = (object: TwinSceneObjectDefinition | undefined) =>
	isComponentSceneObject(object) ? getBuiltInComponentTemplate(object.component.resourceKey) : undefined;

export const cloneTransform = (transform: TwinTransform): TwinTransform => ({
	position: [...transform.position],
	rotation: [...transform.rotation],
	scale: [...transform.scale],
});
