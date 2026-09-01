import {
	createRouteEdge,
	createRoutePoint,
	type TwinRouteDefinition,
	type TwinRouteEdgeDefinition,
	type TwinRoutePointDefinition,
	type TwinSceneManifest,
} from '/@/digital-twin/contracts';
import type { Twin2DObjectView, Twin2DRoutePointView, Twin2DViewDefinition } from './types';

export type Twin2DRoutePointKind = 'waypoint' | 'junction' | 'station' | 'diverter' | 'merger' | 'buffer' | 'processStation' | 'sensor';
export interface Twin2DPortVisual { objectId: string; portId: string; type: string; name: string; x: number; y: number }
export interface Twin2DConnectionVisual { connectionId: string; from: Twin2DPortVisual; to: Twin2DPortVisual }

const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

export const ensureRoutePointView = (view: Twin2DViewDefinition, pointId: string, fallback: Twin2DRoutePointView) => {
	view.routePoints[pointId] ||= { ...fallback };
	return view.routePoints[pointId];
};

export const add2DRoutePoint = (
	route: TwinRouteDefinition,
	view: Twin2DViewDefinition,
	kind: Twin2DRoutePointKind,
	x: number,
	y: number,
): TwinRoutePointDefinition => {
	const point = createRoutePoint([0, 0, 0], route.points.length);
	point.pointId = id('point');
	point.name = `${kind}-${route.points.length + 1}`;
	point.kind = kind;
	if (kind === 'diverter' || kind === 'junction' || kind === 'merger') point.decisionMode = 'plc';
	if (kind === 'processStation') point.process = { type: 'scan' } as any;
	route.points.push(point);
	view.routePoints[point.pointId] = { x, y };
	return point;
};

export const add2DRouteEdge = (
	route: TwinRouteDefinition,
	fromPointId: string,
	toPointId: string,
): TwinRouteEdgeDefinition => {
	if (fromPointId === toPointId) throw new Error('路线起点和终点不能相同。');
	const duplicate = route.edges.find((item) => item.fromPointId === fromPointId && item.toPointId === toPointId);
	if (duplicate) return duplicate;
	const edge = createRouteEdge(fromPointId, toPointId, route.edges.length);
	edge.edgeId = id('edge');
	edge.capacity = edge.capacity || 1;
	edge.enabled = edge.enabled !== false;
	edge.occupancyMode ||= 'live';
	edge.reservationTimeoutSeconds ||= 30;
	route.edges.push(edge);
	return edge;
};

export const remove2DRoutePoint = (route: TwinRouteDefinition, view: Twin2DViewDefinition, pointId: string) => {
	route.points = route.points.filter((item) => item.pointId !== pointId);
	route.edges = route.edges.filter((item) => item.fromPointId !== pointId && item.toPointId !== pointId);
	if (route.decisionRules) route.decisionRules = route.decisionRules.filter((item: any) => item.pointId !== pointId);
	delete view.routePoints[pointId];
};

export const remove2DRouteEdge = (route: TwinRouteDefinition, edgeId: string) => {
	route.edges = route.edges.filter((item) => item.edgeId !== edgeId);
	if (route.decisionRules) route.decisionRules = route.decisionRules.filter((item: any) => item.edgeId !== edgeId);
};

export const move2DRoutePoint = (view: Twin2DViewDefinition, pointId: string, x: number, y: number) => {
	view.routePoints[pointId] = { x, y };
};

const businessObject = (manifest: TwinSceneManifest, viewObject: Twin2DObjectView) =>
	(manifest.objects || []).find((item) => item.objectId === viewObject.businessObjectId) as any;

const metadataPorts = (resource: any) => resource?.modelMetadata?.ports || resource?.ports || [];

export const resolve2DPorts = (manifest: TwinSceneManifest, viewObject: Twin2DObjectView, resource?: any): Twin2DPortVisual[] => {
	const object = businessObject(manifest, viewObject);
	const ports = metadataPorts(resource);
	if (!ports.length && !object?.component) return [];
	const source = ports.length ? ports : [
		{ portId: 'input', name: 'IN', type: 'material-input', localPosition: [-1, 0, 0] },
		{ portId: 'output', name: 'OUT', type: 'material-output', localPosition: [1, 0, 0] },
	];
	return source.map((port: any, index: number) => {
		const local = Array.isArray(port.localPosition) ? port.localPosition : [index ? 1 : -1, 0, 0];
		const horizontal = Number(local[0] || 0);
		const vertical = Number(local[2] || local[1] || 0);
		const px = viewObject.x + viewObject.width * (horizontal < -0.25 ? 0 : horizontal > 0.25 ? 1 : 0.5);
		const py = viewObject.y + viewObject.height * (vertical < -0.25 ? 0 : vertical > 0.25 ? 1 : 0.5);
		return { objectId: object?.objectId || viewObject.businessObjectId || viewObject.id, portId: port.portId || `port-${index}`, type: port.type || 'material-bidirectional', name: port.name || port.portId || `P${index + 1}`, x: px, y: py };
	});
};

const compatible = (from: Twin2DPortVisual, to: Twin2DPortVisual) => {
	const output = from.type.includes('output') || from.type.includes('bidirectional');
	const input = to.type.includes('input') || to.type.includes('bidirectional');
	return output && input;
};

export const nearestCompatiblePort = (source: Twin2DPortVisual, candidates: Twin2DPortVisual[], threshold = 24) => {
	let best: { port: Twin2DPortVisual; distance: number } | undefined;
	for (const port of candidates) {
		if (port.objectId === source.objectId || !compatible(source, port)) continue;
		const distance = Math.hypot(source.x - port.x, source.y - port.y);
		if (distance <= threshold && (!best || distance < best.distance)) best = { port, distance };
	}
	return best;
};

export const connectPorts2D = (manifest: TwinSceneManifest, from: Twin2DPortVisual, to: Twin2DPortVisual) => {
	if (!compatible(from, to)) throw new Error('端口方向不兼容。');
	const connections = ((manifest as any).connections ||= []);
	const existing = connections.find((item: any) => item.from?.objectId === from.objectId && item.from?.portId === from.portId && item.to?.objectId === to.objectId && item.to?.portId === to.portId);
	if (existing) return existing;
	const connection = { connectionId: id('connection'), from: { objectId: from.objectId, portId: from.portId }, to: { objectId: to.objectId, portId: to.portId }, autoGenerated: false, metadata: { source: '2d-designer' } };
	connections.push(connection);
	return connection;
};

export const removeConnection2D = (manifest: TwinSceneManifest, connectionId: string) => {
	(manifest as any).connections = ((manifest as any).connections || []).filter((item: any) => item.connectionId !== connectionId);
};

export const connectionVisuals2D = (manifest: TwinSceneManifest, allPorts: Twin2DPortVisual[]): Twin2DConnectionVisual[] => {
	const map = new Map(allPorts.map((port) => [`${port.objectId}:${port.portId}`, port]));
	return (((manifest as any).connections || []) as any[]).flatMap((item) => {
		const from = map.get(`${item.from?.objectId}:${item.from?.portId}`);
		const to = map.get(`${item.to?.objectId}:${item.to?.portId}`);
		return from && to ? [{ connectionId: item.connectionId, from, to }] : [];
	});
};

export const generateRouteFrom2DConnections = (manifest: TwinSceneManifest, view: Twin2DViewDefinition, routeName = '2D 自动连接路线') => {
	const connections = ((manifest as any).connections || []) as any[];
	if (!connections.length) return undefined;
	const route: TwinRouteDefinition = {
		routeId: id('route'), routeKey: `2d-auto-${Date.now()}`, name: routeName, routeType: 'material-flow', points: [], edges: [], decisionRules: [],
	} as any;
	const pointByObject = new Map<string, TwinRoutePointDefinition>();
	const ensurePoint = (objectId: string) => {
		let point = pointByObject.get(objectId);
		if (point) return point;
		const viewObject = view.objects.find((item) => item.businessObjectId === objectId);
		point = createRoutePoint([0, 0, 0], route.points.length);
		point.pointId = id('point'); point.name = viewObject?.name || objectId; point.kind = 'station';
		route.points.push(point); pointByObject.set(objectId, point);
		view.routePoints[point.pointId] = { x: (viewObject?.x || 0) + (viewObject?.width || 100) / 2, y: (viewObject?.y || 0) + (viewObject?.height || 80) / 2 };
		return point;
	};
	for (const connection of connections) {
		const from = ensurePoint(connection.from.objectId);
		const to = ensurePoint(connection.to.objectId);
		const edge = add2DRouteEdge(route, from.pointId, to.pointId);
		(edge as any).componentObjectId = connection.from.objectId;
	}
	(manifest.routes ||= []).push(route);
	return route;
};
