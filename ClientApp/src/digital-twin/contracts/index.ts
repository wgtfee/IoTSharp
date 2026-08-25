export const twinSceneSchemaVersion = 'iotsharp-twin-scene/v1' as const;

export type TwinVector3 = [number, number, number];

export interface TwinTransform {
	position: TwinVector3;
	rotation: TwinVector3;
	scale: TwinVector3;
}

export interface TwinWorldDefinition {
	unit: 'meter';
	upAxis: 'Y';
	background: string;
}

export interface TwinModelResourceReference {
	resourceId: string;
	name: string;
	sourceFileName?: string;
	status: 'local-poc' | 'ready';
}

export type TwinBindingSourceKind = 'telemetry' | 'attribute' | 'alarm' | 'connectivity' | 'commandFeedback' | 'constant' | 'simulation';
export type TwinBindingTargetKind = 'visible' | 'color' | 'emissive' | 'opacity' | 'text' | 'number' | 'position' | 'rotation' | 'scale' | 'animation' | 'routeProgress' | 'customProperty';

export interface TwinObjectBindingDefinition {
	bindingId: string;
	objectId: string;
	nodePath?: string;
	source: {
		kind: TwinBindingSourceKind;
		assetId?: string;
		deviceId?: string;
		semanticId?: string;
		key?: string;
	};
	target: {
		kind: TwinBindingTargetKind;
		property?: string;
		path?: string;
	};
	transform: {
		kind: 'identity' | 'booleanVisibility' | 'booleanColor' | 'rangeColor' | 'numberScale' | 'numberRotation' | 'enumMap' | 'formatText' | 'alarmSeverityStyle' | 'booleanAnimation' | 'routeProgress' | 'routeEvent';
		[key: string]: unknown;
	};
	priority?: number;
	staleAfterMs: number;
	enabled?: boolean;
}

export interface TwinSceneObjectDefinition {
	objectId: string;
	name: string;
	kind: 'procedural' | 'model';
	resourceId?: string;
	assetId?: string;
	transform: TwinTransform;
}

export type TwinRoutePointKind = 'waypoint' | 'junction' | 'station' | 'diverter' | 'merger' | 'buffer' | 'processStation' | 'sensor';
export type TwinRouteRuleOperator = 'equals' | 'notEquals' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | 'contains' | 'truthy' | 'falsy';

export interface TwinRoutePointDefinition {
	pointId: string;
	name: string;
	position: TwinVector3;
	kind?: TwinRoutePointKind;
	stopDurationSeconds?: number;
	actuatorBindingId?: string;
	sensorBindingId?: string;
}

export interface TwinRouteEdgeDefinition {
	edgeId: string;
	fromPointId: string;
	toPointId: string;
	name?: string;
	bidirectional: boolean;
	enabled: boolean;
	blocked?: boolean;
	priority?: number;
	speedLimit?: number;
	capacity?: number;
	conveyorObjectId?: string;
	occupancyBindingId?: string;
	blockedBindingId?: string;
}

export interface TwinRouteDecisionRule {
	ruleId: string;
	name: string;
	junctionPointId: string;
	edgeId: string;
	source: 'payload' | 'binding';
	payloadKey?: string;
	bindingId?: string;
	operator: TwinRouteRuleOperator;
	matchValue?: string | number | boolean;
	priority: number;
	enabled: boolean;
}

export interface TwinRouteDefinition {
	routeId: string;
	name: string;
	type: 'conveyor';
	curveKind: 'line' | 'catmullRom';
	defaultSpeed: number;
	loop: boolean;
	orientToPath: boolean;
	points: TwinRoutePointDefinition[];
	edges: TwinRouteEdgeDefinition[];
	startPointId?: string;
	/** 交叉口 pointId -> 要采用的出边 edgeId。 */
	junctionDecisions: Record<string, string>;
	routingMode: 'manual' | 'automatic';
	decisionRules: TwinRouteDecisionRule[];
}

export interface TwinRuntimeDefinition {
	dataMode: 'simulation' | 'live';
	maxPixelRatio: number;
	showGrid: boolean;
}

export interface ThreeEditorModelSnapshot {
	rootInfo: {
		type: 'GLTF';
		iotsharpObjectId: string;
		iotsharpResourceId?: string;
		name?: string;
	};
	group?: Record<string, unknown>;
}

export interface ThreeEditorSnapshot {
	/** three-editor-cores 生成的场景、相机、灯光、后期处理和编辑器设置。 */
	sceneParams: Record<string, unknown>;
	/** 模型材质、子节点、动画和变换设置；模型二进制仍由 resourceId 从数据库读取。 */
	modelParams: ThreeEditorModelSnapshot[];
	upstream: {
		repository: 'z2586300277/threejs-editor';
		editorCommit: string;
		coreRepository: 'z2586300277/three-editor-cores';
		coreCommit: string;
		license: 'Apache-2.0';
	};
}

export interface TwinSceneManifest {
	schemaVersion: typeof twinSceneSchemaVersion;
	sceneId: string;
	name: string;
	description: string;
	rootAssetId: string | null;
	world: TwinWorldDefinition;
	resources: TwinModelResourceReference[];
	objects: TwinSceneObjectDefinition[];
	bindings: TwinObjectBindingDefinition[];
	routes: TwinRouteDefinition[];
	runtime: TwinRuntimeDefinition;
	editorExtension: {
		source: 'iotsharp-threejs-editor-adapter' | 'threejs-editor';
		payloadVersion: 1 | 2;
		threeEditor?: ThreeEditorSnapshot;
	};
}

export interface TwinValidationDiagnostic {
	severity: 'error' | 'warning';
	code: string;
	message: string;
	path?: string;
}

const createId = (prefix: string) => {
	const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return `${prefix}-${randomId}`;
};

const defaultTransform = (): TwinTransform => ({
	position: [0, 0, 0],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
});

export const createDefaultTwinSceneManifest = (): TwinSceneManifest => ({
	schemaVersion: twinSceneSchemaVersion,
	sceneId: createId('scene'),
	name: '输送线数字孪生 Phase 0',
	description: '用于验证模型加载、节点选择、路线编辑、确定性运动和资源释放的前端垂直原型。',
	rootAssetId: null,
	world: {
		unit: 'meter',
		upAxis: 'Y',
		background: '#07111f',
	},
	resources: [],
	objects: [
		{
			objectId: 'phase0-procedural-conveyor',
			name: '程序化输送线',
			kind: 'procedural',
			transform: defaultTransform(),
		},
		{
			objectId: 'phase0-moving-package',
			name: '路线测试物料',
			kind: 'procedural',
			transform: defaultTransform(),
		},
	],
	bindings: [],
	routes: [
		{
			routeId: 'phase0-conveyor-main',
			name: '主输送路线',
			type: 'conveyor',
			curveKind: 'catmullRom',
			defaultSpeed: 1.2,
			loop: true,
			orientToPath: true,
			points: [
				{ pointId: 'route-point-1', name: '入口', position: [-6, 0.72, -2], kind: 'station' },
				{ pointId: 'route-point-2', name: '转弯前', position: [-1.5, 0.72, -2], kind: 'waypoint' },
				{ pointId: 'route-point-3', name: '包装分流器', position: [2.5, 0.72, 1.8], kind: 'diverter' },
				{ pointId: 'route-point-4', name: '主线出口', position: [6, 0.72, 1.8], kind: 'station' },
				{ pointId: 'route-point-5', name: '支线出口', position: [4.5, 0.72, 5], kind: 'station' },
				{ pointId: 'route-point-6', name: '包装汇流器', position: [-4, 0.72, 4], kind: 'merger' },
			],
			edges: [
				{ edgeId: 'route-edge-1', fromPointId: 'route-point-1', toPointId: 'route-point-2', name: '入口段', bidirectional: false, enabled: true, priority: 0, capacity: 4 },
				{ edgeId: 'route-edge-2', fromPointId: 'route-point-2', toPointId: 'route-point-3', name: '进分流器', bidirectional: false, enabled: true, priority: 0, capacity: 2 },
				{ edgeId: 'route-edge-3', fromPointId: 'route-point-3', toPointId: 'route-point-4', name: '主包装线', bidirectional: false, enabled: true, priority: 10, capacity: 3 },
				{ edgeId: 'route-edge-4', fromPointId: 'route-point-3', toPointId: 'route-point-5', name: '支包装线', bidirectional: false, enabled: true, priority: 0, capacity: 3 },
				{ edgeId: 'route-edge-5', fromPointId: 'route-point-4', toPointId: 'route-point-6', name: '主线汇流', bidirectional: false, enabled: true, priority: 0, capacity: 2 },
				{ edgeId: 'route-edge-6', fromPointId: 'route-point-5', toPointId: 'route-point-6', name: '支线汇流', bidirectional: false, enabled: true, priority: 0, capacity: 2 },
				{ edgeId: 'route-edge-7', fromPointId: 'route-point-6', toPointId: 'route-point-1', name: '回流入口', bidirectional: false, enabled: true, priority: 0, capacity: 4 },
			],
			startPointId: 'route-point-1',
			junctionDecisions: { 'route-point-3': 'route-edge-3' },
			routingMode: 'automatic',
			decisionRules: [
				{ ruleId: 'route-rule-sku-b', name: 'SKU-B 进入支包装线', junctionPointId: 'route-point-3', edgeId: 'route-edge-4', source: 'payload', payloadKey: 'sku', operator: 'equals', matchValue: 'B', priority: 100, enabled: true },
			],
		},
	],
	runtime: {
		dataMode: 'simulation',
		maxPixelRatio: 2,
		showGrid: true,
	},
	editorExtension: {
		source: 'threejs-editor',
		payloadVersion: 2,
	},
});

const isFiniteVector = (value: unknown): value is TwinVector3 =>
	Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component));

export const validateTwinSceneManifest = (manifest: TwinSceneManifest): TwinValidationDiagnostic[] => {
	const diagnostics: TwinValidationDiagnostic[] = [];
	const allowedPointKinds: TwinRoutePointKind[] = ['waypoint', 'junction', 'station', 'diverter', 'merger', 'buffer', 'processStation', 'sensor'];
	const allowedRuleOperators: TwinRouteRuleOperator[] = ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'contains', 'truthy', 'falsy'];
	if (manifest.schemaVersion !== twinSceneSchemaVersion) {
		diagnostics.push({ severity: 'error', code: 'twin.schema.unsupported', message: `不支持的场景合同版本：${manifest.schemaVersion}` });
	}
	if (!manifest.sceneId?.trim()) diagnostics.push({ severity: 'error', code: 'twin.scene.id.required', message: '场景 ID 不能为空。' });
	if (!manifest.name?.trim()) diagnostics.push({ severity: 'error', code: 'twin.scene.name.required', message: '场景名称不能为空。' });
	if (manifest.rootAssetId === null) {
		diagnostics.push({ severity: 'warning', code: 'twin.scene.asset.pending', message: 'Phase 0 场景尚未绑定根 Asset，接入后端前必须补齐。' });
	}

	const routeIds = new Set<string>();
	const objectIds = new Set<string>();
	for (const [objectIndex, sceneObject] of manifest.objects.entries()) {
		if (!sceneObject.objectId?.trim() || objectIds.has(sceneObject.objectId)) {
			diagnostics.push({ severity: 'error', code: 'twin.object.id.invalid', message: '对象 ID 为空或重复。', path: `objects[${objectIndex}].objectId` });
		}
		objectIds.add(sceneObject.objectId);
		if (sceneObject.kind === 'model' && !sceneObject.resourceId) {
			diagnostics.push({ severity: 'error', code: 'twin.object.resource.required', message: '模型对象必须选择资源库模型。', path: `objects[${objectIndex}].resourceId` });
		}
	}

	const bindingIds = new Set<string>();
	const routeBindingIds = new Set<string>();
	for (const [bindingIndex, binding] of manifest.bindings.entries()) {
		if (!binding.bindingId?.trim() || bindingIds.has(binding.bindingId)) {
			diagnostics.push({ severity: 'error', code: 'twin.binding.id.invalid', message: '绑定 ID 为空或重复。', path: `bindings[${bindingIndex}].bindingId` });
		}
		bindingIds.add(binding.bindingId);
		if (binding.transform.kind === 'routeEvent') routeBindingIds.add(binding.bindingId);
		if (!objectIds.has(binding.objectId)) diagnostics.push({ severity: 'error', code: 'twin.binding.object.invalid', message: '绑定对象不存在。', path: `bindings[${bindingIndex}].objectId` });
		if (['telemetry', 'attribute', 'connectivity', 'commandFeedback'].includes(binding.source.kind) && !binding.source.deviceId) {
			diagnostics.push({ severity: 'error', code: 'twin.binding.device.required', message: '设备数据绑定必须选择 Device。', path: `bindings[${bindingIndex}].source.deviceId` });
		}
	}
	for (const [routeIndex, route] of manifest.routes.entries()) {
		if (!route.routeId?.trim() || routeIds.has(route.routeId)) {
			diagnostics.push({ severity: 'error', code: 'twin.route.id.invalid', message: '路线 ID 为空或重复。', path: `routes[${routeIndex}].routeId` });
		}
		routeIds.add(route.routeId);
		if (!Number.isFinite(route.defaultSpeed) || route.defaultSpeed <= 0) {
			diagnostics.push({ severity: 'error', code: 'twin.route.speed.invalid', message: '路线速度必须大于 0。', path: `routes[${routeIndex}].defaultSpeed` });
		}
		if (!['manual', 'automatic'].includes(route.routingMode || 'manual')) diagnostics.push({ severity: 'error', code: 'twin.route.routing-mode.invalid', message: '分流方式只能是手动或自动规则。', path: `routes[${routeIndex}].routingMode` });
		if (route.points.length < 2) {
			diagnostics.push({ severity: 'error', code: 'twin.route.points.insufficient', message: '一条路线至少需要两个控制点。', path: `routes[${routeIndex}].points` });
		}
		const pointIds = new Set<string>();
		for (const [pointIndex, point] of route.points.entries()) {
			if (!point.pointId?.trim() || pointIds.has(point.pointId)) {
				diagnostics.push({ severity: 'error', code: 'twin.route.point.id.invalid', message: '路线控制点 ID 为空或重复。', path: `routes[${routeIndex}].points[${pointIndex}]` });
			}
			pointIds.add(point.pointId);
			if (!isFiniteVector(point.position)) {
				diagnostics.push({ severity: 'error', code: 'twin.route.point.position.invalid', message: '路线控制点坐标必须是三个有限数值。', path: `routes[${routeIndex}].points[${pointIndex}].position` });
			}
			if (point.kind && !allowedPointKinds.includes(point.kind)) diagnostics.push({ severity: 'error', code: 'twin.route.point.kind.invalid', message: '路线节点类型不受支持。', path: `routes[${routeIndex}].points[${pointIndex}].kind` });
		}
		if (route.startPointId && !pointIds.has(route.startPointId)) {
			diagnostics.push({ severity: 'error', code: 'twin.route.start.invalid', message: '路线起点不存在。', path: `routes[${routeIndex}].startPointId` });
		}
		const edgeIds = new Set<string>();
		const edgeIndex = new Map<string, TwinRouteEdgeDefinition>();
		const incidentCount = new Map<string, number>();
		const incomingCount = new Map<string, number>();
		const outgoingCount = new Map<string, number>();
		for (const [index, edge] of (route.edges || []).entries()) {
			if (!edge.edgeId?.trim() || edgeIds.has(edge.edgeId)) {
				diagnostics.push({ severity: 'error', code: 'twin.route.edge.id.invalid', message: '路线边 ID 为空或重复。', path: `routes[${routeIndex}].edges[${index}].edgeId` });
			}
			edgeIds.add(edge.edgeId);
			edgeIndex.set(edge.edgeId, edge);
			if (!pointIds.has(edge.fromPointId) || !pointIds.has(edge.toPointId)) {
				diagnostics.push({ severity: 'error', code: 'twin.route.edge.reference.invalid', message: '路线边引用了不存在的控制点。', path: `routes[${routeIndex}].edges[${index}]` });
			}
			if (edge.fromPointId === edge.toPointId) {
				diagnostics.push({ severity: 'error', code: 'twin.route.edge.self.invalid', message: '路线边不允许连接到自身。', path: `routes[${routeIndex}].edges[${index}]` });
			}
			if (edge.capacity !== undefined && (!Number.isInteger(edge.capacity) || edge.capacity <= 0)) {
				diagnostics.push({ severity: 'error', code: 'twin.route.edge.capacity.invalid', message: '输送段容量必须是大于 0 的整数。', path: `routes[${routeIndex}].edges[${index}].capacity` });
			}
			for (const [property, bindingId] of [['occupancyBindingId', edge.occupancyBindingId], ['blockedBindingId', edge.blockedBindingId]] as const) {
				if (bindingId && !routeBindingIds.has(bindingId)) diagnostics.push({ severity: 'error', code: 'twin.route.edge.binding.invalid', message: '输送段必须引用 routeEvent 数据绑定。', path: `routes[${routeIndex}].edges[${index}].${property}` });
			}
			if (edge.conveyorObjectId && !objectIds.has(edge.conveyorObjectId)) diagnostics.push({ severity: 'error', code: 'twin.route.edge.object.invalid', message: '输送段引用的场景对象不存在。', path: `routes[${routeIndex}].edges[${index}].conveyorObjectId` });
			if (edge.enabled !== false) {
				incidentCount.set(edge.fromPointId, (incidentCount.get(edge.fromPointId) || 0) + 1);
				incidentCount.set(edge.toPointId, (incidentCount.get(edge.toPointId) || 0) + 1);
				outgoingCount.set(edge.fromPointId, (outgoingCount.get(edge.fromPointId) || 0) + 1);
				incomingCount.set(edge.toPointId, (incomingCount.get(edge.toPointId) || 0) + 1);
				if (edge.bidirectional) {
					outgoingCount.set(edge.toPointId, (outgoingCount.get(edge.toPointId) || 0) + 1);
					incomingCount.set(edge.fromPointId, (incomingCount.get(edge.fromPointId) || 0) + 1);
				}
			}
		}
		for (const [pointId, edgeId] of Object.entries(route.junctionDecisions || {})) {
			const edge = edgeIndex.get(edgeId);
			const canLeave = edge && (edge.fromPointId === pointId || (edge.bidirectional && edge.toPointId === pointId));
			if (!pointIds.has(pointId) || !canLeave) {
				diagnostics.push({ severity: 'error', code: 'twin.route.junction.decision.invalid', message: '交叉口转向规则没有指向该节点可用的出边。', path: `routes[${routeIndex}].junctionDecisions.${pointId}` });
			}
		}
		for (const [pointIndex, point] of route.points.entries()) {
			if (['junction', 'diverter', 'merger'].includes(point.kind || '') && (incidentCount.get(point.pointId) || 0) < 3) {
				diagnostics.push({ severity: 'error', code: 'twin.route.junction.degree.invalid', message: '交叉口至少需要连接三条路线边。', path: `routes[${routeIndex}].points[${pointIndex}]` });
			}
			if (point.kind === 'diverter' && (outgoingCount.get(point.pointId) || 0) < 2) diagnostics.push({ severity: 'error', code: 'twin.route.diverter.outgoing.invalid', message: '分流器至少需要两条可用出边。', path: `routes[${routeIndex}].points[${pointIndex}]` });
			if (point.kind === 'merger' && (incomingCount.get(point.pointId) || 0) < 2) diagnostics.push({ severity: 'error', code: 'twin.route.merger.incoming.invalid', message: '汇流器至少需要两条可用入边。', path: `routes[${routeIndex}].points[${pointIndex}]` });
			for (const [property, bindingId] of [['actuatorBindingId', point.actuatorBindingId], ['sensorBindingId', point.sensorBindingId]] as const) {
				if (bindingId && !routeBindingIds.has(bindingId)) diagnostics.push({ severity: 'error', code: 'twin.route.point.binding.invalid', message: '路线节点必须引用 routeEvent 数据绑定。', path: `routes[${routeIndex}].points[${pointIndex}].${property}` });
			}
		}
		const ruleIds = new Set<string>();
		for (const [ruleIndex, rule] of (route.decisionRules || []).entries()) {
			const rulePath = `routes[${routeIndex}].decisionRules[${ruleIndex}]`;
			const edge = edgeIndex.get(rule.edgeId);
			const canLeave = edge && (edge.fromPointId === rule.junctionPointId || (edge.bidirectional && edge.toPointId === rule.junctionPointId));
			if (!rule.ruleId?.trim() || ruleIds.has(rule.ruleId)) diagnostics.push({ severity: 'error', code: 'twin.route.rule.id.invalid', message: '自动选路规则 ID 不能为空且必须唯一。', path: `${rulePath}.ruleId` });
			ruleIds.add(rule.ruleId);
			if (!pointIds.has(rule.junctionPointId) || !canLeave) diagnostics.push({ severity: 'error', code: 'twin.route.rule.reference.invalid', message: '自动选路规则没有指向交叉口的有效出边。', path: rulePath });
			if (!['payload', 'binding'].includes(rule.source)) diagnostics.push({ severity: 'error', code: 'twin.route.rule.source.invalid', message: '自动选路规则来源不受支持。', path: `${rulePath}.source` });
			if (!allowedRuleOperators.includes(rule.operator)) diagnostics.push({ severity: 'error', code: 'twin.route.rule.operator.invalid', message: '自动选路规则操作符不受支持。', path: `${rulePath}.operator` });
			if (rule.source === 'payload' && !rule.payloadKey?.trim()) diagnostics.push({ severity: 'error', code: 'twin.route.rule.payload-key.required', message: '物料属性规则必须填写属性 Key。', path: `${rulePath}.payloadKey` });
			if (rule.source === 'binding' && (!rule.bindingId || !routeBindingIds.has(rule.bindingId))) diagnostics.push({ severity: 'error', code: 'twin.route.rule.binding.invalid', message: '设备信号规则必须引用 routeEvent 数据绑定。', path: `${rulePath}.bindingId` });
		}
	}

	if (manifest.resources.some((resource) => resource.status === 'local-poc')) {
		diagnostics.push({ severity: 'warning', code: 'twin.resource.local', message: '场景包含仅在当前浏览器有效的本地模型，发布前需要上传到 IoTSharp 模型资源中心。' });
	}
	return diagnostics;
};

export const cloneTwinManifest = (manifest: TwinSceneManifest): TwinSceneManifest => JSON.parse(JSON.stringify(manifest)) as TwinSceneManifest;

export const createRoutePoint = (position: TwinVector3, index: number): TwinRoutePointDefinition => ({
	pointId: createId('route-point'),
	name: `控制点 ${index + 1}`,
	position,
	kind: 'waypoint',
});

export const createRouteEdge = (fromPointId: string, toPointId: string, index: number): TwinRouteEdgeDefinition => ({
	edgeId: createId('route-edge'),
	fromPointId,
	toPointId,
	name: `路线段 ${index + 1}`,
	bidirectional: false,
	enabled: true,
	priority: 0,
	capacity: 1,
});

export const createRouteDecisionRule = (junctionPointId: string, edgeId: string, index: number): TwinRouteDecisionRule => ({
	ruleId: createId('route-rule'),
	name: `自动选路规则 ${index + 1}`,
	junctionPointId,
	edgeId,
	source: 'payload',
	payloadKey: 'sku',
	operator: 'equals',
	matchValue: '',
	priority: 0,
	enabled: true,
});

/** 将旧版顺序控制点路线升级为路线图，保证已入库场景继续可编辑、可运行。 */
export const normalizeTwinRoute = (route: TwinRouteDefinition): TwinRouteDefinition => {
	const points = (route.points || []).map((point) => ({ ...point, kind: point.kind || 'waypoint' }));
	const configuredEdges = Array.isArray(route.edges) ? route.edges : [];
	const edges = configuredEdges.length > 0
		? configuredEdges.map((edge) => ({ ...edge, bidirectional: edge.bidirectional === true, enabled: edge.enabled !== false, priority: edge.priority ?? 0, capacity: edge.capacity ?? 1 }))
		: points.slice(1).map((point, index) => createRouteEdge(points[index].pointId, point.pointId, index));
	if (configuredEdges.length === 0 && route.loop && points.length > 2) edges.push(createRouteEdge(points[points.length - 1].pointId, points[0].pointId, edges.length));
	return {
		...route,
		points,
		edges,
		startPointId: route.startPointId && points.some((point) => point.pointId === route.startPointId) ? route.startPointId : points[0]?.pointId,
		junctionDecisions: { ...(route.junctionDecisions || {}) },
		routingMode: route.routingMode || 'manual',
		decisionRules: (route.decisionRules || []).map((rule) => ({ ...rule, enabled: rule.enabled !== false, priority: rule.priority ?? 0 })),
	};
};

export const createLocalModelResourceReference = (fileName: string): TwinModelResourceReference => ({
	resourceId: createId('local-model'),
	name: fileName.replace(/\.glb$/i, ''),
	sourceFileName: fileName,
	status: 'local-poc',
});
