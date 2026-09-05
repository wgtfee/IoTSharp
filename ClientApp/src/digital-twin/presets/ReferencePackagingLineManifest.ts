import {
	createBlankTwinSceneManifest,
	type TwinRouteDefinition,
	type TwinRouteEdgeDefinition,
	type TwinRoutePointDefinition,
	type TwinSceneManifest,
} from '../contracts';
import type { TwinV7SceneObjectDefinition } from '../contracts/v7-components';
import { getBuiltInComponentTemplate } from '../components/BuiltInComponentCatalog';
import { areComponentPortsCompatible, resolveComponentPorts, upsertGeneratedComponentRoutes } from '../components/ComponentConnectionEngine';

const SMALL_HEIGHT = 0.9;
const LARGE_HEIGHT = 0.82;
export const REFERENCE_PACKAGING_LAYOUT_VERSION = 13;

const applyReferenceV12BehaviorAndPalletInitialization = (manifest: TwinSceneManifest) => {
	manifest.workPoints = [
		{ workPointId: 'reference-v12-turntable-west-pick', name: '西侧旋转台丝锭抓取点', objectId: 'reference-turntable-west', role: 'pick', localPosition: [0, 2.15, 0] },
		{ workPointId: 'reference-v12-turntable-east-pick', name: '东侧旋转台丝锭抓取点', objectId: 'reference-turntable-east', role: 'pick', localPosition: [0, 2.15, 0] },
		{ workPointId: 'reference-v12-loading-robot-home', name: '上料机器人安全原点', objectId: 'reference-loading-robot', role: 'home', localPosition: [0, 4.6, 0] },
		{ workPointId: 'reference-v12-loading-robot-place', name: '上料机器人小托盘放置点', objectId: 'reference-loading-robot', role: 'place', localPosition: [0, 1.35, -6.2] },
		{ workPointId: 'reference-v12-gantry-yarn-source', name: '丝锭夹具取料点', objectId: 'reference-stacking-gantry', role: 'pick', localPosition: [0, 1.15, 6.0] },
		{ workPointId: 'reference-v12-gantry-pallet-stack', name: '木托码垛工作点', objectId: 'reference-stacking-gantry', role: 'stack', localPosition: [0, 1.15, 0] },
		{ workPointId: 'reference-v12-gantry-separator-buffer', name: '隔板缓存取料点', objectId: 'reference-stacking-gantry', role: 'buffer', localPosition: [0, 1.15, -5.6] },
		{ workPointId: 'reference-v12-gantry-yarn-safe', name: '丝锭夹具安全等待点', objectId: 'reference-stacking-gantry', role: 'safe', localPosition: [-1.5, 5.6, 5.8] },
		{ workPointId: 'reference-v12-gantry-separator-safe', name: '隔板夹具安全等待点', objectId: 'reference-stacking-gantry', role: 'safe', localPosition: [1.5, 5.6, -5.4] },
	];
	manifest.actuators = [
		{ actuatorId: 'reference-robot-j1', name: '上料机器人 J1', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-1', kind: 'rotary-joint', motionAxis: 'y', unit: 'rad', minValue: -Math.PI, maxValue: Math.PI, homeValue: 0, speed: 1.8 },
		{ actuatorId: 'reference-robot-j2', name: '上料机器人 J2', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-2', kind: 'rotary-joint', motionAxis: 'z', unit: 'rad', minValue: -2.6, maxValue: 1.4, homeValue: -0.48, speed: 1.6 },
		{ actuatorId: 'reference-robot-j3', name: '上料机器人 J3', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-3', kind: 'rotary-joint', motionAxis: 'z', unit: 'rad', minValue: -2.8, maxValue: 2.8, homeValue: Math.PI / 2 + 0.48, speed: 1.8 },
		{ actuatorId: 'reference-robot-j4', name: '上料机器人 J4', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-4', kind: 'rotary-joint', motionAxis: 'y', unit: 'rad', minValue: -Math.PI, maxValue: Math.PI, homeValue: 0, speed: 2.2 },
		{ actuatorId: 'reference-robot-j5', name: '上料机器人 J5', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-5', kind: 'rotary-joint', motionAxis: 'z', unit: 'rad', minValue: -2.2, maxValue: 2.2, homeValue: 0, speed: 2.2 },
		{ actuatorId: 'reference-robot-j6', name: '上料机器人 J6', objectId: 'reference-loading-robot', nodePath: 'Robot-Axis-6', kind: 'rotary-joint', motionAxis: 'y', unit: 'rad', minValue: -Math.PI * 2, maxValue: Math.PI * 2, homeValue: 0, speed: 2.6 },
		{ actuatorId: 'reference-robot-gripper', name: '上料机器人 2×6 丝锭夹具', objectId: 'reference-loading-robot', nodePath: 'RobotGridGripper-2x6', kind: 'gripper', unit: 'boolean' },
		{ actuatorId: 'reference-gantry-yarn-z', name: '丝锭夹具水平轴', objectId: 'reference-stacking-gantry', nodePath: 'Gantry-Silk-Rail-Carriage', kind: 'linear-axis', motionAxis: 'z', unit: 'meter', minValue: -6.7, maxValue: 6.7, homeValue: 1.8, speed: 3 },
		{ actuatorId: 'reference-gantry-yarn-y', name: '丝锭夹具升降轴', objectId: 'reference-stacking-gantry', nodePath: 'Gantry-Z-Slide', kind: 'linear-axis', motionAxis: 'y', unit: 'meter', minValue: -8, maxValue: 3, homeValue: 0, speed: 2.2 },
		{ actuatorId: 'reference-gantry-yarn-gripper', name: '丝锭 2×3 夹具', objectId: 'reference-stacking-gantry', nodePath: 'GantryGripper-2x3', kind: 'gripper', unit: 'boolean' },
		{ actuatorId: 'reference-gantry-separator-z', name: '隔板夹具水平轴', objectId: 'reference-stacking-gantry', nodePath: 'Gantry-Separator-Rail-Carriage', kind: 'linear-axis', motionAxis: 'z', unit: 'meter', minValue: -6.7, maxValue: 6.7, homeValue: -1.8, speed: 3 },
		{ actuatorId: 'reference-gantry-separator-y', name: '隔板夹具升降轴', objectId: 'reference-stacking-gantry', nodePath: 'Gantry-Separator-Z-Slide', kind: 'linear-axis', motionAxis: 'y', unit: 'meter', minValue: -8, maxValue: 3, homeValue: 0, speed: 2.2 },
		{ actuatorId: 'reference-gantry-separator-gripper', name: '隔板真空夹具', objectId: 'reference-stacking-gantry', nodePath: 'Gantry-Separator-Gripper', kind: 'gripper', unit: 'boolean' },
	];
	manifest.poses = [
		{ poseId: 'reference-robot-home', name: '机器人 Home', objectId: 'reference-loading-robot', targets: [
			{ actuatorId: 'reference-robot-j1', value: 0 }, { actuatorId: 'reference-robot-j2', value: -0.48 }, { actuatorId: 'reference-robot-j3', value: Math.PI / 2 + 0.48 },
			{ actuatorId: 'reference-robot-j4', value: 0 }, { actuatorId: 'reference-robot-j5', value: 0 }, { actuatorId: 'reference-robot-j6', value: 0 }, { actuatorId: 'reference-robot-gripper', value: false },
		] },
		{ poseId: 'reference-robot-pick-west', name: '机器人西旋转台取丝姿态', objectId: 'reference-loading-robot', targets: [
			{ actuatorId: 'reference-robot-j1', value: 2.65 }, { actuatorId: 'reference-robot-j2', value: -0.95 }, { actuatorId: 'reference-robot-j3', value: 1.72 }, { actuatorId: 'reference-robot-j5', value: -0.72 },
		] },
		{ poseId: 'reference-robot-pick-east', name: '机器人东旋转台取丝姿态', objectId: 'reference-loading-robot', targets: [
			{ actuatorId: 'reference-robot-j1', value: 0.05 }, { actuatorId: 'reference-robot-j2', value: -0.95 }, { actuatorId: 'reference-robot-j3', value: 1.72 }, { actuatorId: 'reference-robot-j5', value: -0.72 },
		] },
		{ poseId: 'reference-robot-place-small-pallet', name: '机器人小托盘放丝姿态', objectId: 'reference-loading-robot', targets: [
			{ actuatorId: 'reference-robot-j1', value: Math.PI / 2 }, { actuatorId: 'reference-robot-j2', value: -0.82 }, { actuatorId: 'reference-robot-j3', value: 1.62 }, { actuatorId: 'reference-robot-j5', value: -0.8 },
		] },
		{ poseId: 'reference-gantry-yarn-safe', name: '丝锭夹具安全位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-yarn-z', value: 5.8 }, { actuatorId: 'reference-gantry-yarn-y', value: -1.2 }] },
		{ poseId: 'reference-gantry-yarn-pick', name: '丝锭夹具取料位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-yarn-z', value: 6.0 }, { actuatorId: 'reference-gantry-yarn-y', value: -4.8 }] },
		{ poseId: 'reference-gantry-yarn-stack', name: '丝锭夹具码垛位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-yarn-z', value: 0 }, { actuatorId: 'reference-gantry-yarn-y', value: -5.2 }] },
		{ poseId: 'reference-gantry-separator-safe', name: '隔板夹具安全位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-separator-z', value: -5.4 }, { actuatorId: 'reference-gantry-separator-y', value: -1.2 }] },
		{ poseId: 'reference-gantry-separator-pick', name: '隔板夹具缓存取料位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-separator-z', value: -5.6 }, { actuatorId: 'reference-gantry-separator-y', value: -5.0 }] },
		{ poseId: 'reference-gantry-separator-stack', name: '隔板夹具码垛位', objectId: 'reference-stacking-gantry', targets: [{ actuatorId: 'reference-gantry-separator-z', value: 0 }, { actuatorId: 'reference-gantry-separator-y', value: -5.0 }] },
	];
	manifest.interlocks = [{
		interlockId: 'reference-v12-gantry-pallet-zone-exclusive',
		name: '桁架木托共享区互斥',
		description: '隔板夹具只有在丝锭夹具离开木托共享区后才能进入，避免双夹具在码垛位冲突。',
		conditions: [
			{ source: 'reference-stacking-gantry.yarnFixture.inPalletZone', operator: 'falsy' },
			{ source: 'reference-stacking-gantry.separatorFixture.hasMaterial', operator: 'truthy' },
		],
	}];
	manifest.behaviors = [
		{
			behaviorId: 'reference-v12-robot-pick-west', name: '机器人抓取西侧旋转台丝锭', actorObjectId: 'reference-loading-robot', enabled: true, loop: true, actions: [
				{ actionId: 'west-pick-pose', kind: 'movePose', poseId: 'reference-robot-pick-west', speedRatio: 0.7 },
				{ actionId: 'west-grip-close', kind: 'gripClose', actuatorId: 'reference-robot-gripper' },
				{ actionId: 'west-attach', kind: 'attach', workPointId: 'reference-v12-turntable-west-pick', payloadType: 'silk-cake' },
				{ actionId: 'west-place-pose', kind: 'movePose', poseId: 'reference-robot-place-small-pallet', speedRatio: 0.7 },
				{ actionId: 'west-detach', kind: 'detach', workPointId: 'reference-v12-loading-robot-place', payloadType: 'silk-cake' },
				{ actionId: 'west-grip-open', kind: 'gripOpen', actuatorId: 'reference-robot-gripper' },
				{ actionId: 'west-home', kind: 'home', poseId: 'reference-robot-home', workPointId: 'reference-v12-loading-robot-home' },
			],
		},
		{
			behaviorId: 'reference-v12-robot-pick-east', name: '机器人抓取东侧旋转台丝锭', actorObjectId: 'reference-loading-robot', enabled: true, loop: true, actions: [
				{ actionId: 'east-pick-pose', kind: 'movePose', poseId: 'reference-robot-pick-east', speedRatio: 0.7 },
				{ actionId: 'east-grip-close', kind: 'gripClose', actuatorId: 'reference-robot-gripper' },
				{ actionId: 'east-attach', kind: 'attach', workPointId: 'reference-v12-turntable-east-pick', payloadType: 'silk-cake' },
				{ actionId: 'east-place-pose', kind: 'movePose', poseId: 'reference-robot-place-small-pallet', speedRatio: 0.7 },
				{ actionId: 'east-detach', kind: 'detach', workPointId: 'reference-v12-loading-robot-place', payloadType: 'silk-cake' },
				{ actionId: 'east-grip-open', kind: 'gripOpen', actuatorId: 'reference-robot-gripper' },
				{ actionId: 'east-home', kind: 'home', poseId: 'reference-robot-home', workPointId: 'reference-v12-loading-robot-home' },
			],
		},
		{
			behaviorId: 'reference-v12-gantry-yarn-stack', name: '丝锭夹具抓取并码垛', actorObjectId: 'reference-stacking-gantry', enabled: true, loop: true, actions: [
				{ actionId: 'yarn-source', kind: 'movePose', poseId: 'reference-gantry-yarn-pick', actorNodePath: 'YarnFixture', speedRatio: 0.75 },
				{ actionId: 'yarn-grip-close', kind: 'gripClose', actuatorId: 'reference-gantry-yarn-gripper', actorNodePath: 'YarnFixture' },
				{ actionId: 'yarn-attach', kind: 'attach', workPointId: 'reference-v12-gantry-yarn-source', actorNodePath: 'YarnFixture', payloadType: 'silk-cake' },
				{ actionId: 'yarn-stack-pose', kind: 'movePose', poseId: 'reference-gantry-yarn-stack', actorNodePath: 'YarnFixture' },
				{ actionId: 'yarn-detach', kind: 'detach', workPointId: 'reference-v12-gantry-pallet-stack', actorNodePath: 'YarnFixture', payloadType: 'silk-cake' },
				{ actionId: 'yarn-grip-open', kind: 'gripOpen', actuatorId: 'reference-gantry-yarn-gripper', actorNodePath: 'YarnFixture' },
				{ actionId: 'yarn-safe', kind: 'movePose', poseId: 'reference-gantry-yarn-safe', actorNodePath: 'YarnFixture' },
			],
		},
		{
			behaviorId: 'reference-v12-gantry-separator-stack', name: '隔板夹具抓取并放置隔板', actorObjectId: 'reference-stacking-gantry', enabled: true, loop: true, interlockIds: ['reference-v12-gantry-pallet-zone-exclusive'], actions: [
				{ actionId: 'separator-buffer', kind: 'movePose', poseId: 'reference-gantry-separator-pick', actorNodePath: 'SeparatorFixture' },
				{ actionId: 'separator-grip-close', kind: 'gripClose', actuatorId: 'reference-gantry-separator-gripper', actorNodePath: 'SeparatorFixture' },
				{ actionId: 'separator-attach', kind: 'attach', workPointId: 'reference-v12-gantry-separator-buffer', actorNodePath: 'SeparatorFixture', payloadType: 'separator' },
				{ actionId: 'separator-wait', kind: 'wait', waitForInterlockId: 'reference-v12-gantry-pallet-zone-exclusive' },
				{ actionId: 'separator-stack-pose', kind: 'movePose', poseId: 'reference-gantry-separator-stack', actorNodePath: 'SeparatorFixture' },
				{ actionId: 'separator-detach', kind: 'detach', workPointId: 'reference-v12-gantry-pallet-stack', actorNodePath: 'SeparatorFixture', payloadType: 'separator' },
				{ actionId: 'separator-grip-open', kind: 'gripOpen', actuatorId: 'reference-gantry-separator-gripper', actorNodePath: 'SeparatorFixture' },
				{ actionId: 'separator-safe', kind: 'movePose', poseId: 'reference-gantry-separator-safe', actorNodePath: 'SeparatorFixture' },
			],
		},
	];
	manifest.runtime.routePalletInitializers = (manifest.routes || [])
		.filter((route) => route.routeId.startsWith('component-route-') && route.edges.some((edge) => edge.enabled !== false && edge.conveyorSizeClass === 'small' && edge.transportUnitType === 'plastic-pallet'))
		.map((route) => ({ routeId: route.routeId, telemetryKey: `PalletSlots.${route.routeId}`, simulationDefaultCount: 2, emptyValue: 0 }));
};

const componentObject = (
	resourceKey: string,
	objectId: string,
	name: string,
	position: [number, number, number],
	rotationY = 0,
	properties: Record<string, unknown> = {},
	sectionId?: string,
): TwinV7SceneObjectDefinition => {
	const template = getBuiltInComponentTemplate(resourceKey);
	if (!template) throw new Error(`参考图产线缺少组件模板：${resourceKey}`);
	return {
		objectId,
		name,
		kind: 'component',
		transform: { position, rotation: [0, rotationY, 0], scale: [1, 1, 1] },
		component: {
			resourceKey: template.resourceKey,
			componentType: template.componentType,
			generator: template.generator,
			generatorVersion: template.generatorVersion,
			properties: {
				...structuredClone(template.defaultProperties),
				...properties,
				referenceDrawingLine: true,
				componentOwnedRoute: template.capabilities.includes('material-flow'),
			},
			sectionId,
		},
	};
};

/**
 * V11 参考产线只持久化真正空间相接的物料端口 Connection。
 * 普通输送 Route 由组件 internalFlows + Connection 自动派生，避免再次维护重复坐标路线。
 */
type ReferenceConnection = NonNullable<TwinSceneManifest['connections']>[number];

const connectionEndpointKey = (objectId: string, portId: string) => `${objectId}:${portId}`;

const buildReferenceTopologyConnections = (manifest: TwinSceneManifest, routes: TwinRouteDefinition[]) => {
	const objects = (manifest.objects as TwinV7SceneObjectDefinition[]).filter((item) => item.kind === 'component' && item.component);
	const byObjectId = new Map(objects.map((item) => [item.objectId, item]));
	const bySectionId = new Map(objects.filter((item) => item.component?.sectionId).map((item) => [item.component!.sectionId!, item]));
	const used = new Set<string>();
	const connections: ReferenceConnection[] = [];
	const pointComponent = (point?: TwinRoutePointDefinition) => point
		? (point.componentObjectId ? byObjectId.get(point.componentObjectId) : undefined) || bySectionId.get(point.pointId)
		: undefined;
	const edgeComponent = (edge: TwinRouteEdgeDefinition) => bySectionId.get(edge.edgeId);
	const endpointObject = (route: TwinRouteDefinition, edge: TwinRouteEdgeDefinition, pointId: string) => {
		const direct = edgeComponent(edge);
		if (direct) return direct;
		const oppositePointId = edge.fromPointId === pointId ? edge.toPointId : edge.fromPointId;
		return pointComponent(route.points.find((item) => item.pointId === oppositePointId));
	};
	const connectObjects = (fromObject?: TwinV7SceneObjectDefinition, toObject?: TwinV7SceneObjectDefinition) => {
		if (!fromObject || !toObject || fromObject.objectId === toObject.objectId) return;
		const fromPorts = resolveComponentPorts(fromObject).filter((port) => port.type === 'material-output' || port.type === 'material-bidirectional');
		const toPorts = resolveComponentPorts(toObject).filter((port) => port.type === 'material-input' || port.type === 'material-bidirectional');
		const candidates = fromPorts.flatMap((from) => toPorts
			.filter((to) => areComponentPortsCompatible(from, to))
			.map((to) => ({ from, to, distance: from.worldPosition.distanceTo(to.worldPosition) })))
			.filter((candidate) => !used.has(connectionEndpointKey(candidate.from.objectId, candidate.from.portId)) && !used.has(connectionEndpointKey(candidate.to.objectId, candidate.to.portId)))
			.sort((left, right) => left.distance - right.distance);
		const best = candidates[0];
		if (!best) return;
		const fromKey = connectionEndpointKey(best.from.objectId, best.from.portId);
		const toKey = connectionEndpointKey(best.to.objectId, best.to.portId);
		connections.push({
			connectionId: `reference-topology-${best.from.objectId}-${best.from.portId}-${best.to.objectId}-${best.to.portId}`,
			from: { objectId: best.from.objectId, portId: best.from.portId },
			to: { objectId: best.to.objectId, portId: best.to.portId },
			autoGenerated: true,
			metadata: { topologyBridge: true, source: 'reference-layout-scaffold' },
		});
		used.add(fromKey);
		used.add(toKey);
	};

	for (const route of routes) {
		for (const routePoint of route.points) {
			const center = pointComponent(routePoint);
			const incoming = route.edges.filter((edge) => edge.toPointId === routePoint.pointId).map((edge) => endpointObject(route, edge, routePoint.pointId)).filter(Boolean) as TwinV7SceneObjectDefinition[];
			const outgoing = route.edges.filter((edge) => edge.fromPointId === routePoint.pointId).map((edge) => endpointObject(route, edge, routePoint.pointId)).filter(Boolean) as TwinV7SceneObjectDefinition[];
			if (center) {
				for (const source of incoming) connectObjects(source, center);
				for (const target of outgoing) connectObjects(center, target);
				continue;
			}
			for (const source of incoming) for (const target of outgoing) connectObjects(source, target);
		}
	}
	return connections;
};

const buildReferenceTouchingConnections = (manifest: TwinSceneManifest, maxDistance = 0.18, reservedConnections: ReferenceConnection[] = []) => {
	const components = (manifest.objects as TwinV7SceneObjectDefinition[]).filter((item) => {
		if (item.kind !== 'component' || !item.component) return false;
		if (item.component.properties?.referenceDrawingLine !== true) return false;
		return getBuiltInComponentTemplate(item.component.resourceKey)?.capabilities.includes('material-flow') === true;
	});
	const ports = components.flatMap((object) => resolveComponentPorts(object));
	const candidates: Array<{ left: (typeof ports)[number]; right: (typeof ports)[number]; distance: number }> = [];
	for (let leftIndex = 0; leftIndex < ports.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < ports.length; rightIndex += 1) {
			const left = ports[leftIndex], right = ports[rightIndex];
			if (left.objectId === right.objectId || !areComponentPortsCompatible(left, right)) continue;
			if (left.worldDirection.dot(right.worldDirection) > -0.965) continue;
			const distance = left.worldPosition.distanceTo(right.worldPosition);
			if (distance <= maxDistance) candidates.push({ left, right, distance });
		}
	}
	candidates.sort((left, right) => left.distance - right.distance
		|| `${left.left.objectId}:${left.left.portId}`.localeCompare(`${right.left.objectId}:${right.left.portId}`));
	const used = new Set<string>();
	for (const connection of reservedConnections) {
		used.add(connectionEndpointKey(connection.from.objectId, connection.from.portId));
		used.add(connectionEndpointKey(connection.to.objectId, connection.to.portId));
	}
	const connections = [] as NonNullable<TwinSceneManifest['connections']>;
	for (const candidate of candidates) {
		const leftKey = `${candidate.left.objectId}:${candidate.left.portId}`;
		const rightKey = `${candidate.right.objectId}:${candidate.right.portId}`;
		if (used.has(leftKey) || used.has(rightKey)) continue;
		const leftIsOutput = candidate.left.type === 'material-output';
		const rightIsOutput = candidate.right.type === 'material-output';
		const from = leftIsOutput || (!rightIsOutput && leftKey < rightKey) ? candidate.left : candidate.right;
		const to = from === candidate.left ? candidate.right : candidate.left;
		connections.push({
			connectionId: `reference-connection-${from.objectId}-${from.portId}-${to.objectId}-${to.portId}`,
			from: { objectId: from.objectId, portId: from.portId },
			to: { objectId: to.objectId, portId: to.portId },
			autoGenerated: true,
		});
		used.add(leftKey);
		used.add(rightKey);
	}
	return connections;
};

const point = (pointId: string, name: string, x: number, z: number, kind: TwinRoutePointDefinition['kind'] = 'waypoint'): TwinRoutePointDefinition => ({
	pointId,
	name,
	position: [x, SMALL_HEIGHT, z],
	kind,
});

const edge = (
	edgeId: string,
	fromPointId: string,
	toPointId: string,
	name: string,
	options: Partial<TwinRouteEdgeDefinition> = {},
): TwinRouteEdgeDefinition => {
	const conveyorSizeClass = options.conveyorSizeClass || 'small';
	const transportUnitType = options.transportUnitType || 'plastic-pallet';
	const transportUnitResourceKey = options.transportUnitResourceKey
		|| (transportUnitType === 'carton'
			? 'builtin-carton'
			: transportUnitType === 'wooden-pallet'
				? 'builtin-wooden-pallet'
				: conveyorSizeClass === 'small' ? 'builtin-small-pallet' : 'builtin-plastic-pallet');
	return {
		edgeId,
		fromPointId,
		toPointId,
		name,
		bidirectional: false,
		enabled: true,
		priority: 0,
		capacity: 4,
		occupancyMode: 'simulation',
		reservationTimeoutSeconds: 30,
		conveyorSizeClass,
		transportUnitType,
		transportUnitResourceKey,
		...options,
	};
};

const straightComponentForEdge = (
	route: TwinRouteDefinition,
	routeEdge: TwinRouteEdgeDefinition,
): TwinV7SceneObjectDefinition | undefined => {
	const from = route.points.find((candidate) => candidate.pointId === routeEdge.fromPointId);
	const to = route.points.find((candidate) => candidate.pointId === routeEdge.toPointId);
	if (!from || !to) return undefined;
	const dx = to.position[0] - from.position[0];
	const dz = to.position[2] - from.position[2];
	const length = Math.hypot(dx, dz);
	if (length < 0.5) return undefined;
	const large = routeEdge.conveyorSizeClass === 'large';
	return componentObject(
		large ? 'builtin-large-roller-conveyor' : 'builtin-small-roller-conveyor',
		`reference-conveyor-${routeEdge.edgeId}`,
		`${large ? '大辊道' : '小辊道'} · ${routeEdge.name}`,
		[(from.position[0] + to.position[0]) / 2, 0, (from.position[2] + to.position[2]) / 2],
		-Math.atan2(dz, dx),
		{
			length,
			width: large ? 2.4 : 1.55,
			height: large ? LARGE_HEIGHT : SMALL_HEIGHT,
			capacity: routeEdge.capacity ?? (large ? 1 : 4),
			conveyorSizeClass: large ? 'large' : 'small',
			transportUnitType: large ? (routeEdge.transportUnitType || 'carton') : 'plastic-pallet',
			occupancyMode: 'simulation',
		},
		routeEdge.edgeId,
	);
};

/**
 * V7 将外检后的前行线与空托回流彻底拆开：
 * - 前行：机器人上料 -> 外检 -> 独立输送到双套袋；
 * - 回流：套袋汇流后从另一条物理路线回机器人，只在套袋末端/机器人上料区做工艺交接。
 * 外检出口到套袋之间与回流线不共享点、不交叉、不汇流。
 */
const createSmallMainRoute = (): TwinRouteDefinition => ({
	routeId: 'reference-small-pallet-main',
	name: '参考图小托盘前行线（机器人→外检右进左出→一分二→双套袋→上行）',
	type: 'conveyor',
	curveKind: 'line',
	defaultSpeed: 1.0,
	loop: false,
	orientToPath: true,
	points: [
		{ ...point('ref-robot-out', '底部机器人上料位', 0, 12.8, 'processStation'), componentObjectId: 'reference-loading-robot', process: { type: 'robot-loading', cycleSeconds: 2 } },
		point('ref-robot-east', '机器人前行线右端', 13, 12.8, 'buffer'),
		point('ref-inspection-east-turn', '外检回路右下转角', 13, 6.8, 'buffer'),
		point('ref-inspection-right', '外检机右侧入口', 8, 6.8, 'buffer'),
		{ ...point('ref-inspection', '外检机内部检测位', 4.6, 6.8, 'processStation'), componentObjectId: 'reference-external-inspection', process: { type: 'external-inspection', cycleSeconds: 2 } },
		point('ref-inspection-left', '外检机左侧出口', 1.2, 6.8, 'buffer'),
		point('ref-inspection-diverter', '外检后一分二分流位', -10.8, 6.8, 'diverter'),

		point('ref-a-left-entry', 'A 路左侧双排入口', -12.7, 6.8, 'buffer'),
		point('ref-a-middle-west', 'A 路上层横线西端', -12.7, -0.8, 'buffer'),
		point('ref-a-middle-east', 'A 路上层横线东端', 6.8, -0.8, 'buffer'),
		point('ref-a-bag-left', '套袋 A 左侧入口', 6.8, -12.9, 'buffer'),
		{ ...point('ref-bag-a', '套袋机 A 内部工位', 15, -12.9, 'processStation'), componentObjectId: 'reference-bagging-a', process: { type: 'bagging', cycleSeconds: 3 } },
		point('ref-bag-a-right', '套袋 A 右侧出口', 20, -12.9, 'buffer'),
		point('ref-bag-a-merge-turn', '套袋 A 汇流转接', 21.5, -12.9, 'buffer'),

		point('ref-b-middle-west', 'B 路中部双排西端', -10.8, 1.1, 'buffer'),
		point('ref-b-middle-east', 'B 路中部双排东端', 6.8, 1.1, 'buffer'),
		point('ref-b-bag-left', '套袋 B 左侧入口', 6.8, -5.5, 'buffer'),
		{ ...point('ref-bag-b', '套袋机 B 内部工位', 14.5, -5.5, 'processStation'), componentObjectId: 'reference-bagging-b', process: { type: 'bagging', cycleSeconds: 3 } },
		point('ref-bag-b-right', '套袋 B 右侧出口', 20, -5.5, 'buffer'),

		point('ref-post-bag-merge', '双套袋后二合一汇流位', 21.5, -5.5, 'merger'),
		point('ref-post-bag-east', '套袋后右侧纵向转接', 21.5, -0.8, 'buffer'),
		point('ref-post-bag-up', '套袋后中部回流交接位', 21.5, 3, 'station'),
	],
	edges: [
		edge('ref-edge-robot-east', 'ref-robot-out', 'ref-robot-east', '机器人至外检前行横段', { capacity: 8 }),
		edge('ref-edge-inspection-right-rise', 'ref-robot-east', 'ref-inspection-east-turn', '外检右侧进料纵段', { capacity: 5 }),
		edge('ref-edge-inspection-right-in', 'ref-inspection-east-turn', 'ref-inspection-right', '外检右侧入口横段', { capacity: 3 }),
		edge('ref-edge-inspection-in', 'ref-inspection-right', 'ref-inspection', '外检右进', { capacity: 3 }),
		edge('ref-edge-inspection-out', 'ref-inspection', 'ref-inspection-left', '外检左出', { capacity: 3 }),
		edge('ref-edge-inspection-to-diverter', 'ref-inspection-left', 'ref-inspection-diverter', '外检左出至一分二', { capacity: 5 }),

		edge('ref-edge-diverter-a', 'ref-inspection-diverter', 'ref-a-left-entry', '一分二 A 路', { priority: 10, capacity: 2 }),
		edge('ref-edge-a-left-up', 'ref-a-left-entry', 'ref-a-middle-west', 'A 路左侧双排段', { priority: 10, capacity: 8 }),
		edge('ref-edge-a-middle-east', 'ref-a-middle-west', 'ref-a-middle-east', 'A 路中部双排段', { priority: 10, capacity: 12 }),
		edge('ref-edge-a-bag-up', 'ref-a-middle-east', 'ref-a-bag-left', 'A 路套袋入口上行段', { priority: 10, capacity: 5 }),
		edge('ref-edge-bag-a', 'ref-a-bag-left', 'ref-bag-a', '套袋 A 入口', { priority: 10, capacity: 1 }),
		edge('ref-edge-bag-a-out', 'ref-bag-a', 'ref-bag-a-right', '套袋 A 出口', { priority: 10, capacity: 1 }),
		edge('ref-edge-bag-a-merge-x', 'ref-bag-a-right', 'ref-bag-a-merge-turn', '套袋 A 汇流横段', { priority: 10, capacity: 2 }),
		edge('ref-edge-bag-a-merge-z', 'ref-bag-a-merge-turn', 'ref-post-bag-merge', '套袋 A 汇流纵段', { priority: 10, capacity: 3 }),

		edge('ref-edge-diverter-b', 'ref-inspection-diverter', 'ref-b-middle-west', '一分二 B 路', { capacity: 8 }),
		edge('ref-edge-b-middle-east', 'ref-b-middle-west', 'ref-b-middle-east', 'B 路中部双排段', { capacity: 12 }),
		edge('ref-edge-b-bag-up', 'ref-b-middle-east', 'ref-b-bag-left', 'B 路套袋入口上行段', { capacity: 5 }),
		edge('ref-edge-bag-b', 'ref-b-bag-left', 'ref-bag-b', '套袋 B 入口', { capacity: 1 }),
		edge('ref-edge-bag-b-out', 'ref-bag-b', 'ref-bag-b-right', '套袋 B 出口', { capacity: 1 }),
		edge('ref-edge-bag-b-merge', 'ref-bag-b-right', 'ref-post-bag-merge', '套袋 B 汇流横段', { capacity: 2 }),

		edge('ref-edge-post-bag-east', 'ref-post-bag-merge', 'ref-post-bag-east', '双套袋汇流后横段', { capacity: 4 }),
		edge('ref-edge-post-bag-up', 'ref-post-bag-east', 'ref-post-bag-up', '套袋后向上小辊道', { capacity: 8 }),
	],
	startPointId: 'ref-robot-out',
	junctionDecisions: { 'ref-inspection-diverter': 'ref-edge-diverter-a' },
	routingMode: 'automatic',
	decisionRules: [{
		ruleId: 'ref-rule-bag-b',
		name: 'B 类产品进入套袋机 B',
		junctionPointId: 'ref-inspection-diverter',
		edgeId: 'ref-edge-diverter-b',
		source: 'payload',
		payloadKey: 'routeCode',
		operator: 'equals',
		matchValue: 'B',
		priority: 100,
		enabled: true,
	}],
});

const createSmallReturnRoute = (): TwinRouteDefinition => ({
	routeId: 'reference-small-pallet-return',
	name: '参考图单独单回流小辊道',
	type: 'conveyor',
	curveKind: 'line',
	defaultSpeed: 1.0,
	loop: false,
	orientToPath: true,
	points: [
		point('ref-return-start', '套袋后单回流接入口', 21.5, 3, 'station'),
		point('ref-return-east-top', '中部回流东端', 20, 3, 'buffer'),
		point('ref-return-east-bottom', '中部回流西端', -8.9, 3, 'buffer'),
		point('ref-return-west-bottom', '左侧单回流下端', -8.9, 14.7, 'buffer'),
		point('ref-return-robot', '机器人回流接收位', 0, 14.7, 'station'),
	],
	edges: [
		edge('ref-return-edge-top-east', 'ref-return-start', 'ref-return-east-top', '套袋后进入中部回流', { capacity: 4 }),
		edge('ref-return-edge-east-down', 'ref-return-east-top', 'ref-return-east-bottom', '中部双排回流线', { capacity: 14 }),
		edge('ref-return-edge-bottom-west', 'ref-return-east-bottom', 'ref-return-west-bottom', '左侧单回流纵段', { capacity: 14 }),
		edge('ref-return-edge-robot', 'ref-return-west-bottom', 'ref-return-robot', '底部双排回到机器人', { capacity: 8 }),
	],
	startPointId: 'ref-return-start',
	junctionDecisions: {},
	routingMode: 'manual',
	decisionRules: [],
});

const createGantryMergeRoute = (): TwinRouteDefinition => ({
	routeId: 'reference-gantry-merge-feed',
	name: '桁架后二合一小辊道',
	type: 'conveyor',
	curveKind: 'line',
	defaultSpeed: 0.8,
	loop: false,
	orientToPath: true,
	points: [
		point('ref-gantry-in-a', '桁架来料 A', -12.7, -18.8, 'station'),
		point('ref-gantry-a-turn', '桁架 A 转接', -12.7, -17.7, 'buffer'),
		point('ref-gantry-in-b', '桁架来料 B', -10.8, -18.8, 'station'),
		point('ref-gantry-merger', '桁架后二合一汇流位', -10.8, -17.7, 'merger'),
		point('ref-gantry-merged-out', '桁架汇流后单线', -8, -17.7, 'station'),
	],
	edges: [
		edge('ref-gantry-edge-a-down', 'ref-gantry-in-a', 'ref-gantry-a-turn', '桁架 A 路接入', { capacity: 3 }),
		edge('ref-gantry-edge-a-merge', 'ref-gantry-a-turn', 'ref-gantry-merger', '桁架 A 路汇流', { capacity: 2 }),
		edge('ref-gantry-edge-b-merge', 'ref-gantry-in-b', 'ref-gantry-merger', '桁架 B 路汇流', { capacity: 3 }),
		edge('ref-gantry-edge-out', 'ref-gantry-merger', 'ref-gantry-merged-out', '桁架二合一后单线', { capacity: 4 }),
	],
	startPointId: 'ref-gantry-in-a',
	junctionDecisions: {},
	routingMode: 'manual',
	decisionRules: [],
});

const createLargeRoute = (): TwinRouteDefinition => ({
	routeId: 'reference-large-pallet-line',
	name: '左侧纸箱大辊道',
	type: 'conveyor', curveKind: 'line', defaultSpeed: 0.65, loop: false, orientToPath: true,
	points: [
		{ ...point('ref-large-in', '纸箱大辊道上端', -15.7, -18.8, 'station'), position: [-15.7, LARGE_HEIGHT, -18.8] },
		{ ...point('ref-large-stack', '码垛桁架纸箱停留位', -15.7, -11, 'processStation'), position: [-15.7, LARGE_HEIGHT, -11], componentObjectId: 'reference-stacking-gantry', process: { type: 'gantry-stacking', cycleSeconds: 5 } },
		{ ...point('ref-large-mid', '纸箱大辊道缓存', -15.7, -5, 'buffer'), position: [-15.7, LARGE_HEIGHT, -5] },
		{ ...point('ref-large-out', '纸箱输出口', -15.7, 1.8, 'station'), position: [-15.7, LARGE_HEIGHT, 1.8] },
	],
	edges: [
		edge('ref-large-edge-in', 'ref-large-in', 'ref-large-stack', '码垛前大辊道', { capacity: 2, conveyorSizeClass: 'large', transportUnitType: 'carton' }),
		edge('ref-large-edge-a', 'ref-large-stack', 'ref-large-mid', '码垛后大辊道', { capacity: 2, conveyorSizeClass: 'large', transportUnitType: 'carton' }),
		edge('ref-large-edge-b', 'ref-large-mid', 'ref-large-out', '纸箱输出大辊道', { capacity: 2, conveyorSizeClass: 'large', transportUnitType: 'carton' }),
	],
	startPointId: 'ref-large-in', junctionDecisions: {}, routingMode: 'manual', decisionRules: [],
});

/**
 * 图纸中上部的内环不是 360° 圆环，而是底部开口的约 270° 马蹄形缓存。
 * 保留旧 routeId reference-central-ring，确保 V1 发布版本可无损迁移。
 */
const createCentralBufferRoute = (): TwinRouteDefinition => {
	const centerX = -4, centerZ = -10, radius = 4.2;
	const angles = [135, 180, 225, 270, 315, 360, 405].map((degrees) => degrees * Math.PI / 180);
	const points = angles.map((angle, index) => point(
		`ref-ring-${index + 1}`,
		`中央马蹄形缓存 ${index + 1}`,
		centerX + Math.cos(angle) * radius,
		centerZ + Math.sin(angle) * radius,
		index === 0 || index === angles.length - 1 ? 'station' : 'buffer',
	));
	return {
		routeId: 'reference-central-ring', name: '中央马蹄形缓存辊道', type: 'conveyor', curveKind: 'catmullRom', defaultSpeed: 0.8, loop: false, orientToPath: true,
		points,
		edges: points.slice(0, -1).map((item, index) => edge(`ref-ring-edge-${index + 1}`, item.pointId, points[index + 1].pointId, `马蹄形缓存 ${index + 1}`, { capacity: 2 })),
		startPointId: points[0].pointId, junctionDecisions: {}, routingMode: 'manual', decisionRules: [],
	};
};

/** 中央马蹄形缓存外侧的矩形辊道框，与图纸上方矩形框对应。 */
const createUpperFrameRoute = (): TwinRouteDefinition => ({
	routeId: 'reference-upper-frame',
	name: '中央缓存外层矩形辊道框（按图校准）',
	type: 'conveyor', curveKind: 'line', defaultSpeed: 0.8, loop: true, orientToPath: true,
	points: [
		point('ref-upper-frame-nw', '外框左上', -12.7, -17.7, 'buffer'),
		point('ref-upper-frame-ne', '外框右上', 6.8, -17.7, 'buffer'),
		point('ref-upper-frame-se', '外框右下', 6.8, -5.3, 'buffer'),
		point('ref-upper-frame-se-inner', '外框右下内收', 4.9, -5.3, 'buffer'),
		point('ref-upper-frame-sw', '外框左下内端', -8.9, -5.3, 'buffer'),
		point('ref-upper-frame-sw-outer', '外框左下外端', -12.7, -5.3, 'buffer'),
	],
	edges: [
		edge('ref-upper-frame-north', 'ref-upper-frame-nw', 'ref-upper-frame-ne', '外框上横段', { capacity: 10 }),
		edge('ref-upper-frame-east', 'ref-upper-frame-ne', 'ref-upper-frame-se', '外框右竖段', { capacity: 10 }),
		edge('ref-upper-frame-south-east', 'ref-upper-frame-se', 'ref-upper-frame-se-inner', '外框右下短接段', { capacity: 2 }),
		edge('ref-upper-frame-south', 'ref-upper-frame-se-inner', 'ref-upper-frame-sw', '外框下横段', { capacity: 10 }),
		edge('ref-upper-frame-south-west', 'ref-upper-frame-sw', 'ref-upper-frame-sw-outer', '外框左下短接段', { capacity: 3 }),
		edge('ref-upper-frame-west', 'ref-upper-frame-sw-outer', 'ref-upper-frame-nw', '外框左竖段', { capacity: 10 }),
	],
	startPointId: 'ref-upper-frame-nw', junctionDecisions: {}, routingMode: 'manual', decisionRules: [],
});

/**
 * 依据用户提供的最新标注图创建独立的组件化 3D 产线 V11。
 * 以中央机器人 (-4,-10) 为标定原点，按约 0.06m/像素校准主要设备和辊道锚点。
 */
export const createReferencePackagingLineTwinSceneManifest = (): TwinSceneManifest => {
	const manifest = createBlankTwinSceneManifest();
	manifest.name = '参考图双套袋环形包装产线 V13';
	manifest.description = 'V13 采用组件自带物流路线，并按工艺拓扑显式建立 Port Connection：不再依赖 0.18m 空间接触才能连通；旋转台使用链式载台。普通输送 Route 继续由组件 internalFlows 自动生成。';
	manifest.world.background = '#08111f';
	const smallRoute = createSmallMainRoute();
	const returnRoute = createSmallReturnRoute();
	const gantryMergeRoute = createGantryMergeRoute();
	const largeRoute = createLargeRoute();
	const ringRoute = createCentralBufferRoute();
	const upperFrameRoute = createUpperFrameRoute();
	// V1-V10 的 Route 构造器在 V11 只承担实体组件定位脚手架，不再作为场景持久化 Route。
	const layoutScaffoldRoutes = [smallRoute, returnRoute, gantryMergeRoute, largeRoute, ringRoute, upperFrameRoute];

	const objects: TwinV7SceneObjectDefinition[] = [];
	const doubleVisualEdges = new Set([
		// 这些 Route 已由“双排小辊道”实体的某一排承载，禁止再叠加单辊道。
		'ref-edge-robot-east',
		'ref-edge-a-left-up',
		'ref-edge-diverter-b',
		'ref-edge-b-middle-east',
		'ref-return-edge-east-down',
		'ref-return-edge-robot',
		'ref-gantry-edge-a-down',
		'ref-gantry-edge-b-merge',
		'ref-upper-frame-west',
		'ref-upper-frame-east',
	]);
	const processEmbeddedEdges = new Set([
		// 外检和套袋组件内部已经包含真实辊道，再自动生成会产生重叠和闪烁。
		'ref-edge-inspection-in',
		'ref-edge-inspection-out',
		'ref-edge-bag-a',
		'ref-edge-bag-a-out',
		'ref-edge-bag-b',
		'ref-edge-bag-b-out',
	]);
	for (const route of layoutScaffoldRoutes.filter((item) => item.routeId !== ringRoute.routeId)) {
		for (const routeEdge of route.edges) {
			if (doubleVisualEdges.has(routeEdge.edgeId) || processEmbeddedEdges.has(routeEdge.edgeId)) continue;
			const conveyor = straightComponentForEdge(route, routeEdge);
			if (conveyor) objects.push(conveyor);
		}
	}

	// 图纸的双线结构按四个实体组件落位：左上竖向、右上竖向、中部横向、底部横向。
	// 中部图形实际有三条横线：上层 A 路是单排辊道，下面两条才是双排组件。
	objects.push(
		componentObject('builtin-double-small-roller-conveyor', 'reference-double-small-upper-left', '左上竖向双排小辊道', [-11.75, 0, -5.45], Math.PI / 2, { length: 24.5, laneWidth: 1.55, laneSpacing: 1.9, height: SMALL_HEIGHT, capacityPerLane: 8 }, 'ref-double-upper-left'),
		componentObject('builtin-double-small-roller-conveyor', 'reference-double-small-upper-right', '右上竖向双排小辊道', [5.85, 0, -11.5], Math.PI / 2, { length: 12.4, laneWidth: 1.55, laneSpacing: 1.9, height: SMALL_HEIGHT, capacityPerLane: 8 }, 'ref-double-upper-right'),
		componentObject('builtin-double-small-roller-conveyor', 'reference-double-small-middle', '中部横向双排小辊道', [6.3, 0, 2.05], 0, { length: 30.4, laneWidth: 1.55, laneSpacing: 1.9, height: SMALL_HEIGHT, capacityPerLane: 12 }, 'ref-double-middle'),
		componentObject('builtin-double-small-roller-conveyor', 'reference-double-small-bottom', '底部横向双排小辊道', [1.1, 0, 13.75], 0, { length: 23.8, laneWidth: 1.55, laneSpacing: 1.9, height: SMALL_HEIGHT, capacityPerLane: 12 }, 'ref-double-bottom'),
	);

	// 内侧马蹄形只使用三个 90° 转弯辊道：135° -> 405°，在世界 +Z（图纸下方）留下 90° 开口。
	const horseshoeQuarterRotations = [3 * Math.PI / 4, Math.PI / 4, -Math.PI / 4];
	for (let quadrant = 0; quadrant < horseshoeQuarterRotations.length; quadrant += 1) {
		objects.push(componentObject(
			'builtin-turn-conveyor-90',
			`reference-ring-quarter-${quadrant + 1}`,
			`中央马蹄形缓存 ${quadrant + 1}/3`,
			[-4, 0, -10],
			horseshoeQuarterRotations[quadrant],
			{ radius: 4.2, width: 1.55, height: SMALL_HEIGHT, turnDirection: 'left', capacity: 2, transportUnitType: 'plastic-pallet' },
			`ref-ring-quarter-${quadrant + 1}`,
		));
	}

	objects.push(
		componentObject('builtin-industrial-robot', 'reference-center-robot', '中央马蹄形缓存机器人', [-4, 0, -10], 0, {}, 'ref-center-robot'),
		componentObject('builtin-bagging-machine', 'reference-bagging-a', '套袋机 A', [15, 0, -12.9], 0, { length: 6.4, cycleSeconds: 3 }, 'ref-bag-a'),
		componentObject('builtin-bagging-machine', 'reference-bagging-b', '套袋机 B', [14.5, 0, -5.5], 0, { length: 6.4, cycleSeconds: 3 }, 'ref-bag-b'),
		componentObject('builtin-external-inspection', 'reference-external-inspection', '外检机', [4.6, 0, 6.8], Math.PI, { length: 6.8, cycleSeconds: 2 }, 'ref-inspection'),
		componentObject('builtin-diverter-conveyor', 'reference-inspection-diverter', '外检后一分二辊道', [-10.8, 0, 6.8], Math.PI / 2, { capacity: 2 }, 'ref-inspection-diverter'),
		componentObject('builtin-merger-conveyor', 'reference-bag-merger', '双套袋后二合一辊道', [21.5, 0, -5.5], 0, { capacity: 2 }, 'ref-post-bag-merge'),
		componentObject('builtin-merger-conveyor', 'reference-gantry-merger', '桁架后二合一辊道', [-10.8, 0, -17.7], 0, { capacity: 2 }, 'ref-gantry-merger'),
		// 丝锭桁架内部的暂存台位于本地 Z-；Y+90° 后它落到世界 X-，即大辊道左侧，符合图纸。
		componentObject('builtin-silk-gantry', 'reference-stacking-gantry', '码垛桁架和暂存台', [-15.7, 0, -11], Math.PI / 2, { length: 7.2, width: 15, height: 7.2 }, 'ref-large-stack'),
		componentObject('builtin-carton', 'reference-stacking-pallet', '码垛位纸箱', [-15.7, LARGE_HEIGHT, -11], 0, { length: 1.4, width: 1.1, height: 1.0 }, 'ref-large-stack-pallet'),
		componentObject('builtin-industrial-robot', 'reference-loading-robot', '底部六轴机器人+2×6丝锭夹具', [0.4, 0, 19.8], 0, { toolType: 'silk-grid-2x6', gripperSpan: 6.2, gripperRowSpacing: 1.15, upperArmLength: 2.4, forearmLength: 2.2, axis1HomeYaw: 0, axis2HomePitch: -0.48, axis3HomePitch: Math.PI / 2 + 0.48 }, 'ref-robot'),
		componentObject('builtin-turntable', 'reference-turntable-west', '西侧旋转台+双面丝车', [-5.2, 0, 19.8], Math.PI / 2, { withSilkCart: true, silkCartLoaded: true, deckLength: 7.2, width: 2.8, height: SMALL_HEIGHT, baseRadius: 2.45 }, 'ref-turntable-west'),
		componentObject('builtin-turntable', 'reference-turntable-east', '东侧旋转台+双面丝车', [6, 0, 19.8], Math.PI / 2, { withSilkCart: true, silkCartLoaded: true, deckLength: 7.2, width: 2.8, height: SMALL_HEIGHT, baseRadius: 2.45 }, 'ref-turntable-east'),
	);

	objects.push({
		objectId: 'moving-package',
		name: '运行演示托盘',
		kind: 'procedural',
		transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
	});
	manifest.objects = objects as TwinSceneManifest['objects'];
	manifest.bindings = [];
	manifest.routes = [];
	const topologyConnections = buildReferenceTopologyConnections(manifest, layoutScaffoldRoutes);
	manifest.connections = [...topologyConnections, ...buildReferenceTouchingConnections(manifest, 0.18, topologyConnections)];
	upsertGeneratedComponentRoutes(manifest);
	manifest.runtime = { dataMode: 'simulation', maxPixelRatio: 2, showGrid: true, referencePackagingLayoutVersion: REFERENCE_PACKAGING_LAYOUT_VERSION };
	applyReferenceV12BehaviorAndPalletInitialization(manifest);
	return manifest;
};

const referenceRouteIds = new Set([
	'reference-small-pallet-main',
	'reference-small-pallet-return',
	'reference-gantry-merge-feed',
	'reference-bottom-lane-b',
	'reference-large-pallet-line',
	'reference-central-ring',
	'reference-upper-frame',
	// V3 曾把双排第二排拆成独立 Route；V4 迁移必须主动清掉这些历史孤立路线。
	'reference-double-upper-left-lane-b',
	'reference-double-middle-lane-b',
	'reference-double-bottom-lane-b',
]);
const stableReferenceObjectIds = [
	'reference-loading-robot',
	'reference-bagging-a',
	'reference-bagging-b',
	'reference-stacking-gantry',
];
const edgeBindingFields = ['occupancyBindingId', 'fullBindingId', 'blockedBindingId', 'conveyorObjectId'] as const;

const mergeRouteForUpgrade = (canonical: TwinRouteDefinition, previous?: TwinRouteDefinition): TwinRouteDefinition => {
	if (!previous) return structuredClone(canonical);
	const previousPoints = new Map(previous.points.map((item) => [item.pointId, item]));
	const previousEdges = new Map(previous.edges.map((item) => [item.edgeId, item]));
	const route = structuredClone(canonical);
	for (const routePoint of route.points) {
		const old = previousPoints.get(routePoint.pointId);
		if (!old) continue;
		if (old.actuatorBindingId) routePoint.actuatorBindingId = old.actuatorBindingId;
		if (old.sensorBindingId) routePoint.sensorBindingId = old.sensorBindingId;
		if (routePoint.process && old.process) {
			for (const field of ['readyBindingId', 'busyBindingId', 'completeBindingId', 'resultBindingId', 'faultBindingId'] as const) {
				if (old.process[field]) routePoint.process[field] = old.process[field];
			}
		}
	}
	for (const routeEdge of route.edges) {
		const old = previousEdges.get(routeEdge.edgeId);
		if (!old) continue;
		for (const field of edgeBindingFields) if (old[field] !== undefined) (routeEdge as any)[field] = old[field];
	}
	return route;
};

const mergeReferenceObject = (
	canonical: TwinV7SceneObjectDefinition,
	previousObjects: TwinV7SceneObjectDefinition[],
	claimedPreviousIds: Set<string>,
): TwinV7SceneObjectDefinition => {
	let previous = previousObjects.find((item) => item.objectId === canonical.objectId && !claimedPreviousIds.has(item.objectId));
	if (!previous && canonical.kind === 'component') {
		previous = previousObjects.find((item) => item.kind === 'component'
			&& !claimedPreviousIds.has(item.objectId)
			&& item.component?.sectionId === canonical.component?.sectionId
			&& item.component?.properties?.referenceDrawingLine === true);
	}
	const merged = structuredClone(canonical);
	if (!previous) return merged;
	claimedPreviousIds.add(previous.objectId);
	// 旧 V1 的 numeric conveyor objectId 可能已经被 Binding 引用；匹配到同一 section 时继续沿用旧 ID。
	merged.objectId = previous.objectId;
	if (previous.assetId) merged.assetId = previous.assetId;
	if (previous.resourceId && (!(merged.kind === 'component' && previous.kind === 'component') || previous.component?.resourceKey === merged.component?.resourceKey)) merged.resourceId = previous.resourceId;
	if (merged.kind === 'component' && previous.kind === 'component' && merged.component && previous.component) {
		merged.component.properties = {
			...structuredClone(previous.component.properties || {}),
			...structuredClone(merged.component.properties || {}),
		};
		delete (merged.component.properties as any).routeManagedExternally;
		if (previous.component.bindings) merged.component.bindings = structuredClone(previous.component.bindings);
	}
	return merged;
};

/**
 * 将旧参考图草稿或不可变发布 Manifest 在内存中升级为当前 V13。
 * 只替换参考图自带 routes / referenceDrawingLine objects；用户额外放入的对象、资源和 Binding 保留。
 */
export const upgradeReferencePackagingLineLayout = (manifest: TwinSceneManifest): boolean => {
	const currentLayoutVersion = Number(manifest.runtime?.referencePackagingLayoutVersion || 0);
	if (currentLayoutVersion >= REFERENCE_PACKAGING_LAYOUT_VERSION) {
		const canonicalName = `参考图双套袋环形包装产线 V${REFERENCE_PACKAGING_LAYOUT_VERSION}`;
		if (/^参考图双套袋环形包装产线\s*V\d+$/i.test(manifest.name || '') && manifest.name !== canonicalName) {
			manifest.name = canonicalName;
			return true;
		}
		return false;
	}
	const existingRouteIds = new Set((manifest.routes || []).map((item) => item.routeId));
	const objects = (manifest.objects || []) as TwinV7SceneObjectDefinition[];
	const hasStableReferenceObjects = stableReferenceObjectIds.every((id) => objects.some((item) => item.objectId === id));
	const hasLegacyReferenceRoutes = ['reference-small-pallet-main', 'reference-large-pallet-line', 'reference-central-ring'].every((id) => existingRouteIds.has(id));
	// V11 起普通辊道路线已经由组件 internalFlows + Connection 派生，不再持久化旧 reference-* Route。
	// 因此 V11 -> V12 必须能仅凭版本标记 + 稳定参考对象 + referenceDrawingLine 身份再次迁移，
	// 否则后续修正的辊面高度等 canonical 属性无法刷新到已经保存过一次的 V11 场景。
	const hasComponentizedReferenceLayout = Number(manifest.runtime?.referencePackagingLayoutVersion || 0) >= 11
		&& objects.some((item) => item.kind === 'component' && item.component?.properties?.referenceDrawingLine === true);
	const looksLikeReferenceLayout = hasStableReferenceObjects && (hasLegacyReferenceRoutes || hasComponentizedReferenceLayout);
	if (!looksLikeReferenceLayout) return false;

	const canonical = createReferencePackagingLineTwinSceneManifest();
	const previousRoutes = [...(manifest.routes || [])];
	const previousRouteMap = new Map(previousRoutes.map((item) => [item.routeId, item]));
	const previousReferenceRoutes = previousRoutes.filter((item) => referenceRouteIds.has(item.routeId));
	// Generated component routes are always rebuilt; only user-authored non-reference routes survive directly.
	manifest.routes = previousRoutes.filter((item) => !referenceRouteIds.has(item.routeId) && item.generatedBy !== 'component-connections');

	const previousReferenceObjects = objects.filter((item) => item.objectId === 'moving-package'
		|| (item.kind === 'component' && item.component?.properties?.referenceDrawingLine === true));
	const customObjects = objects.filter((item) => !previousReferenceObjects.includes(item));
	const claimedPreviousIds = new Set<string>();
	const upgradedReferenceObjects = (canonical.objects as TwinV7SceneObjectDefinition[])
		.map((item) => mergeReferenceObject(item, previousReferenceObjects, claimedPreviousIds));
	manifest.objects = [...customObjects, ...upgradedReferenceObjects] as TwinSceneManifest['objects'];

	const existingObjectIds = new Set(manifest.objects.map((item) => item.objectId));
	const retainedConnections = (manifest.connections || []).filter((connection) =>
		existingObjectIds.has(connection.from.objectId) && existingObjectIds.has(connection.to.objectId));
	const upgradeScaffoldRoutes = [createSmallMainRoute(), createSmallReturnRoute(), createGantryMergeRoute(), createLargeRoute(), createCentralBufferRoute(), createUpperFrameRoute()];
	const topologyConnections = buildReferenceTopologyConnections(manifest, upgradeScaffoldRoutes);
	const rebuiltReferenceConnections = [...topologyConnections, ...buildReferenceTouchingConnections(manifest, 0.18, topologyConnections)];
	const connectionKeys = new Set<string>();
	manifest.connections = [...retainedConnections, ...rebuiltReferenceConnections].filter((connection) => {
		const key = `${connection.from.objectId}:${connection.from.portId}->${connection.to.objectId}:${connection.to.portId}`;
		const reverse = `${connection.to.objectId}:${connection.to.portId}->${connection.from.objectId}:${connection.from.portId}`;
		if (connectionKeys.has(key) || connectionKeys.has(reverse)) return false;
		connectionKeys.add(key);
		return true;
	});
	upsertGeneratedComponentRoutes(manifest);

	// Preserve route-side PLC/occupancy bindings from V1-V11 by matching legacy edgeId to component sectionId.
	const generatedEdges = manifest.routes.filter((item) => item.generatedBy === 'component-connections').flatMap((item) => item.edges);
	for (const legacyRoute of previousReferenceRoutes) {
		for (const legacyEdge of legacyRoute.edges) {
			const generatedEdge = generatedEdges.find((item) => item.sectionId === legacyEdge.edgeId);
			if (!generatedEdge) continue;
			for (const field of edgeBindingFields) if (legacyEdge[field] !== undefined) (generatedEdge as any)[field] = legacyEdge[field];
		}
		for (const legacyPoint of legacyRoute.points) {
			const referenceObject = (manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.kind === 'component'
				&& (item.objectId === legacyPoint.componentObjectId || item.component?.sectionId === legacyPoint.pointId));
			if (!referenceObject) continue;
			const generatedPoint = manifest.routes.filter((item) => item.generatedBy === 'component-connections').flatMap((item) => item.points)
				.find((item) => item.componentObjectId === referenceObject.objectId
					&& (item.kind === legacyPoint.kind || (legacyPoint.kind === 'processStation' && item.kind === 'processStation')));
			if (!generatedPoint) continue;
			if (legacyPoint.actuatorBindingId) generatedPoint.actuatorBindingId = legacyPoint.actuatorBindingId;
			if (legacyPoint.sensorBindingId) generatedPoint.sensorBindingId = legacyPoint.sensorBindingId;
			if (generatedPoint.process && legacyPoint.process) {
				for (const field of ['readyBindingId', 'busyBindingId', 'completeBindingId', 'resultBindingId', 'faultBindingId'] as const) {
					if (legacyPoint.process[field]) generatedPoint.process[field] = legacyPoint.process[field];
				}
			}
		}
	}
	manifest.workPoints = structuredClone(canonical.workPoints || []);
	manifest.behaviors = structuredClone(canonical.behaviors || []);
	manifest.interlocks = structuredClone(canonical.interlocks || []);
	manifest.runtime.routePalletInitializers = structuredClone(canonical.runtime.routePalletInitializers || []);
	manifest.runtime.referencePackagingLayoutVersion = REFERENCE_PACKAGING_LAYOUT_VERSION;
	if (/参考图双套袋环形包装产线\s*V\d+/i.test(manifest.name || '')) manifest.name = canonical.name;
	if ((manifest.description || '').includes('参考图') || (manifest.description || '').includes('中央环形缓存') || (manifest.description || '').includes('马蹄形缓存')) manifest.description = canonical.description;
	return true;
};
