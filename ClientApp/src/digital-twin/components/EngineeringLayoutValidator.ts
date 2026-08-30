import * as THREE from 'three';
import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { defaultComponentRegistry } from './ComponentRegistry';
import { isComponentSceneObject } from './ComponentConnectionEngine';
import type { TwinComponentDefinition } from './types';

interface ComponentBounds {
	object: TwinV7SceneObjectDefinition;
	body: THREE.Box3;
}

export const resolveComponentBodyBounds = (object: TwinV7SceneObjectDefinition) => {
	if (!isComponentSceneObject(object)) return undefined;
	const definition: TwinComponentDefinition = {
		objectId: object.objectId,
		name: object.name,
		resourceKey: object.component.resourceKey,
		componentType: object.component.componentType as TwinComponentDefinition['componentType'],
		generator: object.component.generator,
		generatorVersion: object.component.generatorVersion,
		resourceId: object.resourceId,
		properties: object.component.properties || {},
		transform: object.transform,
		sectionId: object.component.sectionId,
		routeEdgeId: object.component.routeEdgeId,
	};
	const built = defaultComponentRegistry.create(definition);
	try {
		const body = built.bounds.clone();
		// Port Marker 半径为 0.12m；向内收口后只比较设备主体，不把允许的接口接触当作碰撞。
		body.min.addScalar(0.13);
		body.max.addScalar(-0.13);
		return body;
	} finally { built.dispose(); }
};

/** 编辑态工程校验：只产生诊断，不反向移动组件或修改工程坐标。 */
export const validateEngineeringLayout = (manifest: TwinSceneManifest): TwinValidationDiagnostic[] => {
	const diagnostics: TwinValidationDiagnostic[] = [];
	const components: ComponentBounds[] = [];
	for (const object of manifest.objects as TwinV7SceneObjectDefinition[]) {
		if (!isComponentSceneObject(object)) continue;
		try {
			const body = resolveComponentBodyBounds(object);
			if (body && !body.isEmpty()) components.push({ object, body });
		} catch { /* Generator 错误由 ComponentManifestValidator 提供更精确诊断。 */ }
	}

	for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
			const left = components[leftIndex], right = components[rightIndex];
			const overlap = left.body.clone().intersect(right.body);
			if (overlap.isEmpty()) continue;
			const size = overlap.getSize(new THREE.Vector3());
			if (size.x * size.y * size.z < 0.025) continue;
			diagnostics.push({
				severity: 'warning',
				code: 'twin.layout.body-overlap',
				message: `设备主体严重重叠：${left.object.name} / ${right.object.name}。`,
				path: `objects.${left.object.objectId}`,
			});
		}
	}

	const boundsByObjectId = new Map(components.map((item) => [item.object.objectId, item.body]));
	for (const route of manifest.routes.filter((item) => item.generatedBy === 'component-connections')) {
		const points = new Map(route.points.map((point) => [point.pointId, point]));
		for (const edge of route.edges) {
			const from = points.get(edge.fromPointId), to = points.get(edge.toPointId);
			if (!from || !to) continue;
			const start = new THREE.Vector3(...from.position), end = new THREE.Vector3(...to.position);
			const length = start.distanceTo(end);
			const samples = Math.max(3, Math.ceil(length / 0.25));
			for (const [objectId, bounds] of boundsByObjectId) {
				if (objectId === edge.componentObjectId) continue;
				let intersects = false;
				for (let sample = 1; sample < samples; sample += 1) {
					if (bounds.containsPoint(start.clone().lerp(end, sample / samples))) { intersects = true; break; }
				}
				if (!intersects) continue;
				diagnostics.push({ severity: 'warning', code: 'twin.layout.route-clearance', message: `路线 ${edge.name || edge.edgeId} 穿过设备主体 ${objectId}。`, path: `routes.${route.routeId}.edges.${edge.edgeId}` });
			}
		}
	}
	return diagnostics;
};
