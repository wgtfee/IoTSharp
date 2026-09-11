import type { TwinRouteDefinition, TwinRoutePointDefinition, TwinSceneManifest } from '../contracts';
import type { TwinV7SceneObjectDefinition } from '../contracts/v7-components';
import { isComponentSceneObject, resolveComponentPorts } from '../components/ComponentConnectionEngine';
import { inferRouteEndpointRole } from './RouteSnapEngine';
import type { TwinRouteAuthoringDiagnostic } from './RouteAuthoringCompiler';

const pointDistance = (left: TwinRoutePointDefinition, right: TwinRoutePointDefinition) => Math.hypot(
	left.position[0] - right.position[0], left.position[1] - right.position[1], left.position[2] - right.position[2],
);

const directionAt = (from: TwinRoutePointDefinition, to: TwinRoutePointDefinition) => {
	const vector: [number, number, number] = [to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]];
	const length = Math.hypot(vector[0], vector[1], vector[2]);
	return length > 0.0001 ? [vector[0] / length, vector[1] / length, vector[2] / length] as [number, number, number] : undefined;
};

const angleDegrees = (left: [number, number, number], right: [number, number, number]) => {
	const dot = Math.max(-1, Math.min(1, left[0] * right[0] + left[1] * right[1] + left[2] * right[2]));
	return Math.acos(dot) * 180 / Math.PI;
};

const portAcceptsRole = (type: string, role: 'entry' | 'exit') => role === 'entry'
	? type === 'material-output' || type === 'material-bidirectional'
	: type === 'material-input' || type === 'material-bidirectional';

const validateRouteTopology = (route: TwinRouteDefinition, diagnostics: TwinRouteAuthoringDiagnostic[]) => {
	const points = new Map(route.points.map((point) => [point.pointId, point]));
	const incident = new Map(route.points.map((point) => [point.pointId, 0]));
	const pairs = new Map<string, string>();
	for (const edge of route.edges) {
		const from = points.get(edge.fromPointId);
		const to = points.get(edge.toPointId);
		if (!from || !to) {
			diagnostics.push({ severity: 'error', code: 'route.authoring.edge.dangling', message: `路线边 ${edge.edgeId} 引用了不存在的端点`, routeId: route.routeId, edgeId: edge.edgeId });
			continue;
		}
		incident.set(from.pointId, (incident.get(from.pointId) || 0) + 1);
		incident.set(to.pointId, (incident.get(to.pointId) || 0) + 1);
		const length = pointDistance(from, to);
		if (length < 0.0001) diagnostics.push({ severity: 'error', code: 'route.authoring.edge.zero-length', message: `路线边 ${edge.edgeId} 长度为 0`, routeId: route.routeId, edgeId: edge.edgeId });
		else if (length < 0.05) diagnostics.push({ severity: 'warning', code: 'route.authoring.edge.too-short', message: `路线边 ${edge.edgeId} 长度小于 0.05m`, routeId: route.routeId, edgeId: edge.edgeId });
		const pair = `${edge.fromPointId}->${edge.toPointId}`;
		if (pairs.has(pair)) diagnostics.push({ severity: 'error', code: 'route.authoring.edge.duplicate-topology', message: `重复同向路线：${pair}`, routeId: route.routeId, edgeId: edge.edgeId });
		else pairs.set(pair, edge.edgeId);
	}
	for (const [pointId, count] of incident) if (count === 0) diagnostics.push({ severity: 'warning', code: 'route.authoring.point.isolated', message: `路线点 ${pointId} 未连接任何 Edge`, routeId: route.routeId, pointId });

	// 只比较连续的“入边 -> 出边”方向；同一分流点的多个出口不互相比较。
	// 接近 180° 的 U 型折返可能合法，因此这里只提示 warning，不阻止保存或发布。
	for (const point of route.points) {
		const incoming = route.edges.filter((edge) => edge.enabled !== false && edge.toPointId === point.pointId);
		const outgoing = route.edges.filter((edge) => edge.enabled !== false && edge.fromPointId === point.pointId);
		for (const inEdge of incoming) for (const outEdge of outgoing) {
			const from = points.get(inEdge.fromPointId), to = points.get(outEdge.toPointId);
			if (!from || !to || from.pointId === to.pointId) continue;
			const incomingDirection = directionAt(from, point), outgoingDirection = directionAt(point, to);
			if (!incomingDirection || !outgoingDirection) continue;
			const angle = angleDegrees(incomingDirection, outgoingDirection);
			if (angle > 150) diagnostics.push({ severity: 'warning', code: 'route.authoring.direction.reverse', message: `路线在 ${point.name || point.pointId} 处出现 ${angle.toFixed(1)}° 近似反向折返`, routeId: route.routeId, pointId: point.pointId, edgeId: outEdge.edgeId });
		}
	}
};

export const validateRouteAuthoringManifest = (manifest: TwinSceneManifest): TwinRouteAuthoringDiagnostic[] => {
	const diagnostics: TwinRouteAuthoringDiagnostic[] = [];
	for (const route of manifest.routes || []) validateRouteTopology(route, diagnostics);

	const objects = new Map((manifest.objects as TwinV7SceneObjectDefinition[]).filter(isComponentSceneObject).map((object) => [object.objectId, object]));
	const inputClaims = new Map<string, Array<{ routeId: string; pointId?: string; connectionId?: string }>>();
	const addInputClaim = (key: string, claim: { routeId: string; pointId?: string; connectionId?: string }) => inputClaims.set(key, [...(inputClaims.get(key) || []), claim]);
	for (const connection of manifest.connections || []) addInputClaim(`${connection.to.objectId}::${connection.to.portId}`, { routeId: 'component-connections', connectionId: connection.connectionId });

	for (const route of manifest.routes || []) {
		for (const point of route.points) {
			if (!point.attachment) continue;
			if (point.authoring?.mode !== 'manual') diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.generated-point', message: `只有 Manual Point 可以建立 Port Attachment：${point.pointId}`, routeId: route.routeId, pointId: point.pointId });
			const inferredRole = inferRouteEndpointRole(route, point.pointId);
			if (!inferredRole) diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.non-endpoint', message: `Port Attachment 只能用于路线端点：${point.pointId}`, routeId: route.routeId, pointId: point.pointId });
			else if (inferredRole !== point.attachment.role) diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.role-mismatch', message: `Attachment 角色与路线方向不一致：${point.pointId}`, routeId: route.routeId, pointId: point.pointId });
			const object = objects.get(point.attachment.objectId);
			if (!object) {
				diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.object-missing', message: `Attachment 组件不存在：${point.attachment.objectId}`, routeId: route.routeId, pointId: point.pointId });
				continue;
			}
			const port = resolveComponentPorts(object).find((candidate) => candidate.portId === point.attachment!.portId);
			if (!port) {
				diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.port-missing', message: `Attachment Port 不存在：${object.name}.${point.attachment.portId}`, routeId: route.routeId, pointId: point.pointId });
				continue;
			}
			if (inferredRole && !portAcceptsRole(port.type, inferredRole)) diagnostics.push({ severity: 'error', code: 'route.authoring.attachment.direction', message: `路线方向与 Port 类型不兼容：${object.name}.${port.name}`, routeId: route.routeId, pointId: point.pointId });
			if (inferredRole === 'exit' && (port.type === 'material-input' || port.type === 'material-bidirectional')) addInputClaim(`${object.objectId}::${port.portId}`, { routeId: route.routeId, pointId: point.pointId });
		}
	}
	for (const [key, claims] of inputClaims) if (claims.length > 1) diagnostics.push({ severity: 'error', code: 'route.authoring.port.input-multiple', message: `普通 Input 被多个外部连接占用：${key}`, routeId: claims.find((claim) => claim.routeId !== 'component-connections')?.routeId || 'component-connections', pointId: claims.find((claim) => claim.pointId)?.pointId });
	return diagnostics;
};
