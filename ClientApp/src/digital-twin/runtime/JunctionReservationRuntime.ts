import * as THREE from 'three';
import type { TwinRouteDefinition } from '../contracts';
import type { RouteEngine } from '../routes/RouteEngine';

interface TrafficEntity { key: string; root: THREE.Group; simulationEngine?: RouteEngine }
interface ConflictZone { points: THREE.Vector3[]; owner?: string; waiting: Map<string, number> }

/**
 * 纯物理空跑的路口空间预约。相邻短接路口合并成一个互斥区；托盘在进入前等待，
 * 不通过倒退队列或瞬移来解除碰撞。不处理 PLC、工艺互锁或设备内部动作。
 */
export class JunctionReservationRuntime {
	private readonly radius = 2.1;
	private readonly zones: ConflictZone[] = [];
	private sequence = 0;
	constructor(route: TwinRouteDefinition) {
		const nodes = route.points.filter(p => route.edges.filter(e => e.toPointId === p.pointId && e.enabled !== false).length > 1
			|| route.edges.filter(e => e.fromPointId === p.pointId && e.enabled !== false).length > 1);
		for (const node of nodes) {
			const point = new THREE.Vector3(...node.position);
			const touching = this.zones.filter(zone => zone.points.some(other => other.distanceTo(point) < this.radius * 2 + 0.2));
			const zone = { points: [point, ...touching.flatMap(z => z.points)], waiting: new Map<string, number>() };
			for (const old of touching) this.zones.splice(this.zones.indexOf(old), 1);
			this.zones.push(zone);
		}
	}
	/** 初始投放避开互斥区，防止仿真第一帧就有多个托盘占住同一路口。 */
	canSeed(position: THREE.Vector3) { return !this.zones.some(z => this.inside(z, position, 1)); }
	reset() { for (const zone of this.zones) { delete zone.owner; zone.waiting.clear(); } this.sequence = 0; }
	/** 每帧按实际到达距离预约，稳定 ID 打破同帧平局。 */
	update(entities: TrafficEntity[]) {
		const samples = entities.map(entity => {
			const engine = entity.simulationEngine!, snapshot = engine.getSnapshot();
			const positions: THREE.Vector3[] = [entity.root.position];
			for (let d = 0.2; d <= 1.01; d += 0.2) positions.push(engine.getCurve().getPointAt(((snapshot.distanceMeters + d) % snapshot.lengthMeters) / snapshot.lengthMeters));
			return { entity, positions };
		});
		for (const zone of this.zones) {
			const candidates = samples.map(sample => ({ ...sample, arrival: sample.positions.findIndex(p => this.inside(zone, p)) }))
				.filter(sample => sample.arrival >= 0).sort((a, b) => a.arrival - b.arrival || a.entity.key.localeCompare(b.entity.key));
			for (const sample of candidates) if (!zone.waiting.has(sample.entity.key)) zone.waiting.set(sample.entity.key, this.sequence++);
			for (const key of zone.waiting.keys()) if (!candidates.some(sample => sample.entity.key === key)) zone.waiting.delete(key);
			const owner = samples.find(sample => sample.entity.key === zone.owner);
			if (owner && (this.inside(zone, owner.entity.root.position, 0.2) || owner.positions.some(p => this.inside(zone, p)))) continue;
			delete zone.owner;
			candidates.sort((a, b) => zone.waiting.get(a.entity.key)! - zone.waiting.get(b.entity.key)!);
			zone.owner = candidates[0]?.entity.key;
		}
	}
	canMove(entity: TrafficEntity, candidate: THREE.Vector3) {
		return this.zones.every(zone => !this.inside(zone, candidate) || zone.owner === entity.key);
	}
	private inside(zone: ConflictZone, p: THREE.Vector3, extra = 0) { return zone.points.some(point => point.distanceToSquared(p) < (this.radius + extra) ** 2); }
}
