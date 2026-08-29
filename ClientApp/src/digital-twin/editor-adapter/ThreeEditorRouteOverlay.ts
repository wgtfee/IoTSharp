import * as THREE from 'three';
import { createRouteEdge, createRoutePoint, type TwinRouteDefinition, type TwinRoutePointDefinition, type TwinSceneManifest, type TwinVector3 } from '/@/digital-twin/contracts';

const disposeMaterial = (material?: THREE.Material | THREE.Material[]) => {
	if (Array.isArray(material)) material.forEach((item) => item.dispose());
	else material?.dispose();
};

const disposeObject = (object: THREE.Object3D) => {
	object.traverse((child: any) => {
		child.geometry?.dispose?.();
		disposeMaterial(child.material);
	});
};

const pointColor = (point: TwinRoutePointDefinition) => {
	switch (point.kind) {
		case 'diverter': return 0xf59e0b;
		case 'merger': return 0xa855f7;
		case 'processStation': return 0xec4899;
		case 'sensor': return 0x22c55e;
		case 'buffer': return 0x3b82f6;
		case 'station': return 0x14b8a6;
		case 'junction': return 0xf97316;
		default: return 0x38bdf8;
	}
};

/**
 * threejs-editor 场景内的工程路线覆盖层。
 *
 * 重要约束：该 Overlay 与 GLB / V7 Component 共用 editor.viewer.scene、camera 与世界坐标，
 * 因此路线编辑不会再依赖 TwinRuntime 的第二张 Scene。
 */
export class ThreeEditorRouteOverlay {
	readonly root = new THREE.Group();
	private readonly edgeGroup = new THREE.Group();
	private readonly pointGroup = new THREE.Group();
	private readonly pointMeshes = new Map<string, THREE.Mesh>();
	private manifest: TwinSceneManifest;
	private selectedPointId?: string;
	private visible = true;

	constructor(scene: THREE.Scene, manifest: TwinSceneManifest) {
		this.manifest = manifest;
		this.root.name = 'IoTSharp Route Overlay';
		this.root.userData = { iotsharpTwinHelper: true, iotsharpRouteOverlay: true };
		this.edgeGroup.name = 'Route Edges';
		this.pointGroup.name = 'Route Points';
		this.root.add(this.edgeGroup, this.pointGroup);
		scene.add(this.root);
		this.rebuild(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		this.manifest = manifest;
		this.rebuild(manifest);
	}

	setVisible(visible: boolean) {
		this.visible = visible;
		this.root.visible = visible;
	}

	getVisible() { return this.visible; }

	rebuild(manifest = this.manifest) {
		this.manifest = manifest;
		for (const child of [...this.edgeGroup.children]) { this.edgeGroup.remove(child); disposeObject(child); }
		for (const child of [...this.pointGroup.children]) { this.pointGroup.remove(child); disposeObject(child); }
		this.pointMeshes.clear();

		for (const route of manifest.routes || []) this.buildRoute(route);
		this.root.visible = this.visible;
		this.setSelectedPoint(this.selectedPointId);
	}

	private buildRoute(route: TwinRouteDefinition) {
		const points = new Map(route.points.map((point) => [point.pointId, point]));
		for (const edge of route.edges || []) {
			const from = points.get(edge.fromPointId);
			const to = points.get(edge.toPointId);
			if (!from || !to) continue;
			const geometry = new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(...from.position),
				new THREE.Vector3(...to.position),
			]);
			const color = edge.blocked ? 0xef4444 : edge.enabled === false ? 0x64748b : route.routeId === 'v7-component-route' ? 0x06b6d4 : 0x38bdf8;
			const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: edge.enabled === false ? 0.35 : 0.9, depthTest: false, depthWrite: false });
			const line = new THREE.Line(geometry, material);
			line.name = edge.name || edge.edgeId;
			line.renderOrder = 950;
			line.userData = { iotsharpTwinHelper: true, iotsharpRouteEdge: true, routeId: route.routeId, edgeId: edge.edgeId };
			this.edgeGroup.add(line);
		}

		for (let index = 0; index < route.points.length; index += 1) {
			const point = route.points[index];
			const geometry = new THREE.SphereGeometry(0.18, 18, 12);
			const material = new THREE.MeshBasicMaterial({ color: pointColor(point), transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.set(...point.position);
			mesh.name = point.name || point.pointId;
			mesh.renderOrder = 1000;
			mesh.userData = { iotsharpTwinHelper: true, iotsharpRoutePoint: true, routeId: route.routeId, pointId: point.pointId, routePointIndex: index };
			this.pointMeshes.set(point.pointId, mesh);
			this.pointGroup.add(mesh);
		}
	}

	pickPoint(event: MouseEvent, camera: THREE.Camera, domElement: HTMLElement) {
		if (!this.visible) return undefined;
		const rect = domElement.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return undefined;
		const pointer = new THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1,
		);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, camera);
		const hit = raycaster.intersectObjects([...this.pointMeshes.values()], false)[0]?.object as THREE.Mesh | undefined;
		if (!hit) return undefined;
		return {
			mesh: hit,
			routeId: String(hit.userData.routeId || ''),
			pointId: String(hit.userData.pointId || ''),
			index: Number(hit.userData.routePointIndex ?? -1),
		};
	}

	worldPointFromEvent(event: MouseEvent, camera: THREE.Camera, domElement: HTMLElement, y: number) {
		const rect = domElement.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return undefined;
		const pointer = new THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1,
		);
		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(pointer, camera);
		const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
		const point = new THREE.Vector3();
		return raycaster.ray.intersectPlane(plane, point) ? point : undefined;
	}

	getPointMesh(pointId: string) { return this.pointMeshes.get(pointId); }

	setSelectedPoint(pointId?: string) {
		this.selectedPointId = pointId;
		for (const [id, mesh] of this.pointMeshes) {
			const material = mesh.material as THREE.MeshBasicMaterial;
			mesh.scale.setScalar(id === pointId ? 1.45 : 1);
			material.opacity = id === pointId ? 1 : 0.88;
		}
	}

	updatePointFromMesh(pointId: string) {
		const mesh = this.pointMeshes.get(pointId);
		if (!mesh) return undefined;
		for (const route of this.manifest.routes || []) {
			const point = route.points.find((candidate) => candidate.pointId === pointId);
			if (!point) continue;
			point.position = [mesh.position.x, mesh.position.y, mesh.position.z];
			this.rebuild(this.manifest);
			return route;
		}
		return undefined;
	}

	updatePoint(routeIndex: number, pointIndex: number, position: TwinVector3) {
		const route = this.manifest.routes?.[routeIndex];
		const point = route?.points?.[pointIndex];
		if (!route || !point) return undefined;
		point.position = [...position] as TwinVector3;
		this.rebuild(this.manifest);
		return route;
	}

	addPoint(position?: TwinVector3, routeIndex = 0) {
		const route = this.manifest.routes?.[routeIndex];
		if (!route) return undefined;
		const last = route.points[route.points.length - 1];
		const target = position || ([
			(last?.position?.[0] ?? 0) + 2,
			last?.position?.[1] ?? 0.72,
			last?.position?.[2] ?? 0,
		] as TwinVector3);
		const point = createRoutePoint([...target] as TwinVector3, route.points.length);
		route.points.push(point);
		if (last) route.edges.push(createRouteEdge(last.pointId, point.pointId, route.edges.length));
		this.rebuild(this.manifest);
		this.setSelectedPoint(point.pointId);
		return { route, point };
	}

	removePoint(pointId: string) {
		for (const route of this.manifest.routes || []) {
			const index = route.points.findIndex((point) => point.pointId === pointId);
			if (index < 0) continue;
			if (route.points.length <= 2) return undefined;
			const removed = route.points[index];
			const removedEdgeIds = new Set(route.edges.filter((edge) => edge.fromPointId === removed.pointId || edge.toPointId === removed.pointId).map((edge) => edge.edgeId));
			route.points.splice(index, 1);
			route.edges = route.edges.filter((edge) => !removedEdgeIds.has(edge.edgeId));
			route.decisionRules = (route.decisionRules || []).filter((rule) => rule.junctionPointId !== removed.pointId && !removedEdgeIds.has(rule.edgeId));
			if (route.startPointId === removed.pointId) route.startPointId = route.points[0]?.pointId;
			for (const [junctionPointId, edgeId] of Object.entries(route.junctionDecisions || {})) {
				if (junctionPointId === removed.pointId || removedEdgeIds.has(edgeId)) delete route.junctionDecisions[junctionPointId];
			}
			this.selectedPointId = undefined;
			this.rebuild(this.manifest);
			return route;
		}
		return undefined;
	}

	getPreferredDrawHeight(routeIndex = 0) {
		const route = this.manifest.routes?.[routeIndex];
		return route?.points?.[route.points.length - 1]?.position?.[1] ?? 0.72;
	}

	dispose() {
		this.root.parent?.remove(this.root);
		disposeObject(this.root);
		this.pointMeshes.clear();
	}
}
