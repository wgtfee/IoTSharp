import * as THREE from 'three';
import { normalizeTwinRoute, type TwinRouteDefinition } from '/@/digital-twin/contracts';

export interface TwinSectionGeometry {
	sectionId: string;
	edgeId: string;
	fromPointId: string;
	toPointId: string;
	curve: any;
	length: number;
}

/** RouteEdge 到物理 Section 曲线的唯一映射，业务位置使用 sectionId + progress 表达。 */
export class TwinSectionGeometryResolver {
	private route: TwinRouteDefinition;
	private readonly geometries = new Map<string, TwinSectionGeometry>();

	constructor(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(route);
		this.rebuild();
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = normalizeTwinRoute(route);
		this.rebuild();
	}

	get(sectionId: string) {
		return this.geometries.get(sectionId);
	}

	getAll() {
		return [...new Map([...this.geometries.values()].map((geometry) => [geometry.edgeId, geometry])).values()];
	}

	getPose(sectionId: string, progress: number) {
		const geometry = this.geometries.get(sectionId);
		if (!geometry) return undefined;
		const t = THREE.MathUtils.clamp(progress, 0, 1);
		return {
			position: geometry.curve.getPointAt(t),
			tangent: geometry.curve.getTangentAt(t),
		};
	}

	private rebuild() {
		this.geometries.clear();
		const points = new Map(this.route.points.map((point) => [point.pointId, point]));
		for (const edge of this.route.edges) {
			const from = points.get(edge.fromPointId);
			const to = points.get(edge.toPointId);
			if (!from || !to) continue;
			const curve = new THREE.LineCurve3(new THREE.Vector3(...from.position), new THREE.Vector3(...to.position));
			const sectionId = edge.sectionId || edge.edgeId;
			const geometry: TwinSectionGeometry = {
				sectionId,
				edgeId: edge.edgeId,
				fromPointId: edge.fromPointId,
				toPointId: edge.toPointId,
				curve,
				length: Math.max(0.001, curve.getLength()),
			};
			// 运行时 Section 当前以 edgeId 为键；V7 工程对象也可通过显式 sectionId 查询同一几何。
			this.geometries.set(edge.edgeId, geometry);
			this.geometries.set(sectionId, geometry);
		}
	}
}
