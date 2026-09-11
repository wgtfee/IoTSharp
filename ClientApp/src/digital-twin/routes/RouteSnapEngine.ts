import type { TwinRouteDefinition, TwinRouteEndpointAttachment, TwinRoutePointDefinition, TwinSceneManifest } from '../contracts';
import type { TwinV7SceneObjectDefinition } from '../contracts/v7-components';
import { isComponentSceneObject, resolveComponentPorts, type TwinComponentPortRef } from '../components/ComponentConnectionEngine';

export interface TwinRoutePortSnapOption {
	objectId: string;
	objectName: string;
	portId: string;
	portName: string;
	portType: string;
	distance: number;
}

export interface TwinRoutePortSnapOptions {
	maxDistance?: number;
	maxAngleDegrees?: number;
}

export const inferRouteEndpointRole = (route: TwinRouteDefinition, pointId: string): 'entry' | 'exit' | undefined => {
	const incoming = route.edges.filter((edge) => edge.enabled !== false && edge.toPointId === pointId);
	const outgoing = route.edges.filter((edge) => edge.enabled !== false && edge.fromPointId === pointId);
	if (outgoing.length > 0 && incoming.length === 0) return 'entry';
	if (incoming.length > 0 && outgoing.length === 0) return 'exit';
	return undefined;
};

const portMatchesRole = (port: TwinComponentPortRef, role: 'entry' | 'exit') => role === 'entry'
	? port.type === 'material-output' || port.type === 'material-bidirectional'
	: port.type === 'material-input' || port.type === 'material-bidirectional';

const pointTangent = (route: TwinRouteDefinition, point: TwinRoutePointDefinition, role: 'entry' | 'exit') => {
	const edge = role === 'entry'
		? route.edges.find((item) => item.enabled !== false && item.fromPointId === point.pointId)
		: route.edges.find((item) => item.enabled !== false && item.toPointId === point.pointId);
	if (!edge) return undefined;
	const otherId = role === 'entry' ? edge.toPointId : edge.fromPointId;
	const other = route.points.find((item) => item.pointId === otherId);
	if (!other) return undefined;
	const dx = role === 'entry' ? other.position[0] - point.position[0] : point.position[0] - other.position[0];
	const dz = role === 'entry' ? other.position[2] - point.position[2] : point.position[2] - other.position[2];
	const length = Math.hypot(dx, dz);
	return length > 0.0001 ? { x: dx / length, z: dz / length } : undefined;
};

const portInUse = (manifest: TwinSceneManifest, objectId: string, portId: string, routeId: string, pointId: string) => {
	if ((manifest.connections || []).some((connection) =>
		(connection.from.objectId === objectId && connection.from.portId === portId)
		|| (connection.to.objectId === objectId && connection.to.portId === portId))) return true;
	return manifest.routes.some((route) => route.points.some((point) => point.pointId !== pointId && point.attachment?.objectId === objectId && point.attachment.portId === portId));
};

const resolveRoutePoint = (manifest: TwinSceneManifest, routeId: string, pointId: string) => {
	const route = manifest.routes.find((item) => item.routeId === routeId);
	const point = route?.points.find((item) => item.pointId === pointId);
	return route && point ? { route, point } : undefined;
};

export const listRouteEndpointPortSnapOptions = (manifest: TwinSceneManifest, routeId: string, pointId: string, options: TwinRoutePortSnapOptions = {}): TwinRoutePortSnapOption[] => {
	const resolved = resolveRoutePoint(manifest, routeId, pointId);
	if (!resolved || resolved.point.authoring?.mode !== 'manual') return [];
	const role = inferRouteEndpointRole(resolved.route, pointId);
	if (!role) return [];
	const maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
	const maxAngleDegrees = Math.max(0, Math.min(90, options.maxAngleDegrees ?? 30));
	const tangent = pointTangent(resolved.route, resolved.point, role);
	const cos = Math.cos(maxAngleDegrees * Math.PI / 180);
	const result: TwinRoutePortSnapOption[] = [];
	for (const object of manifest.objects as TwinV7SceneObjectDefinition[]) {
		if (!isComponentSceneObject(object)) continue;
		for (const port of resolveComponentPorts(object)) {
			if (!portMatchesRole(port, role)) continue;
			const isCurrent = resolved.point.attachment?.objectId === object.objectId && resolved.point.attachment.portId === port.portId;
			if (!isCurrent && portInUse(manifest, object.objectId, port.portId, routeId, pointId)) continue;
			const distance = Math.hypot(port.worldPosition.x - resolved.point.position[0], port.worldPosition.y - resolved.point.position[1], port.worldPosition.z - resolved.point.position[2]);
			if (distance > maxDistance) continue;
			if (tangent) {
				const px = role === 'entry' ? port.worldDirection.x : -port.worldDirection.x;
				const pz = role === 'entry' ? port.worldDirection.z : -port.worldDirection.z;
				const plen = Math.hypot(px, pz);
				if (plen > 0.0001 && (tangent.x * px / plen + tangent.z * pz / plen) < cos) continue;
			}
			result.push({ objectId: object.objectId, objectName: object.name, portId: port.portId, portName: port.name, portType: port.type, distance });
		}
	}
	return result.sort((a, b) => a.distance - b.distance || `${a.objectName}.${a.portName}`.localeCompare(`${b.objectName}.${b.portName}`));
};

export const attachRoutePointToPort = (manifest: TwinSceneManifest, routeId: string, pointId: string, objectId: string, portId: string): TwinRouteEndpointAttachment | undefined => {
	const resolved = resolveRoutePoint(manifest, routeId, pointId);
	if (!resolved || resolved.point.authoring?.mode !== 'manual') return undefined;
	const role = inferRouteEndpointRole(resolved.route, pointId);
	if (!role) return undefined;
	const object = (manifest.objects as TwinV7SceneObjectDefinition[]).find((item) => item.objectId === objectId);
	if (!isComponentSceneObject(object)) return undefined;
	const port = resolveComponentPorts(object).find((item) => item.portId === portId);
	if (!port || !portMatchesRole(port, role)) return undefined;
	if (portInUse(manifest, objectId, portId, routeId, pointId) && !(resolved.point.attachment?.objectId === objectId && resolved.point.attachment.portId === portId)) return undefined;
	const attachment: TwinRouteEndpointAttachment = { objectId, portId, role, snapMode: 'hard' };
	resolved.point.attachment = attachment;
	resolved.point.position = [port.worldPosition.x, port.worldPosition.y, port.worldPosition.z];
	resolved.point.authoring = { ...(resolved.point.authoring || { mode: 'manual' }), mode: 'manual', sourceObjectId: objectId, sourcePortId: portId, locked: false };
	return attachment;
};

export const detachRoutePointFromPort = (manifest: TwinSceneManifest, routeId: string, pointId: string) => {
	const resolved = resolveRoutePoint(manifest, routeId, pointId);
	if (!resolved?.point.attachment) return false;
	delete resolved.point.attachment;
	if (resolved.point.authoring?.mode === 'manual') {
		delete resolved.point.authoring.sourceObjectId;
		delete resolved.point.authoring.sourcePortId;
	}
	return true;
};

export const snapRoutePointToNearestPort = (manifest: TwinSceneManifest, routeId: string, pointId: string, options: TwinRoutePortSnapOptions = {}) => {
	const candidate = listRouteEndpointPortSnapOptions(manifest, routeId, pointId, { maxDistance: options.maxDistance ?? 0.45, maxAngleDegrees: options.maxAngleDegrees ?? 30 })[0];
	if (!candidate) return undefined;
	return attachRoutePointToPort(manifest, routeId, pointId, candidate.objectId, candidate.portId);
};
