import * as THREE from 'three';
import type { TwinRouteDefinition, TwinRoutePointDefinition } from '../contracts';
import type { RouteEngine } from '../routes/RouteEngine';

export interface BatchRouteEntity {
	key: string; palletId: string; routeId: string; physicalLane?: string;
	root: THREE.Group; simulationEngine?: RouteEngine; simulationRoute?: TwinRouteDefinition;
}
interface Member { entity: BatchRouteEntity; point: TwinRoutePointDefinition; offset: number; released: boolean }
interface Station { objectId: string; points: TwinRoutePointDefinition[]; members: Member[]; phase: 'collecting' | 'acting' | 'releasing'; cycle: number; elapsed: number }

/** 路线距离驱动的批次停车、到位确认与离站；不移动托盘模型、不替代设备动作执行器。 */
export class RouteAlignedBatchRuntime {
	private readonly stations: Station[];
	private readonly visited = new Map<string, Set<string>>();
	private readonly previousDistance = new Map<string, number>();
	constructor(routes: TwinRouteDefinition[], private readonly getRoot: (id: string) => THREE.Group | undefined) {
		const groups = new Map<string, TwinRoutePointDefinition[]>();
		for (const route of routes) for (const point of route.points) {
			if (point.process?.batchArrivalMode !== 'route-aligned' || !point.componentObjectId) continue;
			groups.set(point.componentObjectId, [...(groups.get(point.componentObjectId) || []), point]);
		}
		this.stations = [...groups].map(([objectId, points]) => ({ objectId, points, members: [], phase: 'collecting', cycle: 0, elapsed: 0 }));
	}
	/** 仿真初始化不占用批次区；Live 不调用。 */
	canSeed(entity: BatchRouteEntity) {
		return this.stations.every(station => station.points.every(point => {
			const distance = this.forwardTo(entity, point);
			return distance === undefined || distance > this.queueExtent(point) + 2;
		}));
	}
	reset() {
		this.visited.clear(); this.previousDistance.clear();
		for (const station of this.stations) {
			station.members = []; station.phase = 'collecting'; station.cycle = 0; station.elapsed = 0;
			const root = this.getRoot(station.objectId);
			if (root) {
				for (const key of ['stationPalletIds', 'stationWaitingPalletIds', 'stationCompletedGroups']) root.userData[key] = [];
				root.userData.stationCompletedGroupCounts = {}; root.userData.completedBatchCount = 0;
				root.userData.processActive = false; root.userData.processPhase = 'idle';
				for (const key of ['stationPalletId', 'stationLastCompletedPalletIds', 'stationLastCompletedBehaviorId', 'stationLastCompletedFlowId', 'stationFlowOwner', 'stationBehaviorRequirements', 'processProgress']) delete root.userData[key];
			}
		}
	}
	/** 将本帧行程限制到停车点，不倒退、不跳过碰撞检查。 */
	update(entities: BatchRouteEntity[], dt = .05) {
		for (const entity of entities) {
			const distance = entity.simulationEngine?.getSnapshot().distanceMeters;
			if (distance === undefined) continue;
			if ((this.previousDistance.get(entity.key) ?? distance) - distance > 10) this.visited.delete(entity.key);
			this.previousDistance.set(entity.key, distance);
		}
		for (const station of this.stations) {
			const root = this.getRoot(station.objectId);
			if (!root) continue; // 缺少设备时仍由 limitTravel 保持，不允许绕过。
			const process = station.points[0].process!;
			const requirements = { ...Object.fromEntries((process.behaviorCompletionGroups || []).map(group => [group, 1])), ...process.behaviorCompletionRequirements };
			if (station.phase === 'acting') {
				station.elapsed += dt;
				if (!root.userData.stationFlowOwner) root.userData.processProgress = Math.min(1, station.elapsed / Math.max(.05, process.cycleSeconds || 1));
				const counts = root.userData.stationCompletedGroupCounts || {};
				if (Object.keys(requirements).length
					? !Object.entries(requirements).every(([group, count]) => Number(counts[group] || 0) >= count)
					: station.elapsed < Math.max(.05, process.cycleSeconds || 1)) continue;
				station.phase = 'releasing';
				root.userData.stationLastCompletedPalletIds = station.members.map(m => m.entity.palletId);
				root.userData.stationPalletIds = []; root.userData.stationWaitingPalletIds = [];
				root.userData.completedBatchCount = ++station.cycle;
				root.userData.processActive = false; root.userData.processPhase = 'releasing';
				for (const member of station.members) {
					if (process.materialStageOnComplete) member.entity.root.traverse(node => { if (node.userData.materialEntity) { node.userData.materialStage = process.materialStageOnComplete; node.userData.processHistory = [...new Set([...(node.userData.processHistory || []), process.materialStageOnComplete])]; } });
					member.released = true;
					const visited = this.visited.get(member.entity.key) || new Set<string>();
					visited.add(station.objectId); this.visited.set(member.entity.key, visited);
				}
			}
			if (station.phase === 'releasing') {
				const cleared = station.members.every(member => {
					const forward = this.forwardTo(member.entity, member.point);
					const length = member.entity.simulationEngine?.getSnapshot().lengthMeters || 0;
					return forward === undefined || (forward > this.queueExtent(member.point) + 2 && length - forward > 1.6);
				});
				if (!cleared) continue;
				station.members = []; station.phase = 'collecting'; root.userData.processPhase = 'waiting-batch';
			}
			const required = Math.max(1, Math.floor(Number(process.batchSize || 1)));
			const candidates = entities.flatMap(entity => station.points.map(point => ({ entity, point, distance: this.forwardTo(entity, point) })))
				.filter(item => item.entity.root.visible && !this.visited.get(item.entity.key)?.has(station.objectId)
					&& this.accepts(item.entity, item.point)
					&& (!item.point.process?.physicalLane || item.point.process.physicalLane === item.entity.physicalLane)
					&& item.distance !== undefined && item.distance <= this.queueExtent(item.point) + 2)
				.sort((a, b) => a.distance! - b.distance! || a.entity.key.localeCompare(b.entity.key));
			for (const candidate of candidates) {
				if (station.members.length >= required) break;
				if (station.members.some(m => m.entity.key === candidate.entity.key)) continue;
				const laneCount = station.members.filter(m => m.point.pointId === candidate.point.pointId).length;
				if (laneCount >= (candidate.point.process?.batchLaneSize || required)) continue;
				const offset = laneCount * this.spacing(candidate.point);
				if (candidate.distance! + 0.001 < offset) continue;
				station.members.push({ entity: candidate.entity, point: candidate.point, offset, released: false });
			}
			root.userData.stationWaitingPalletIds = station.members.map(m => m.entity.palletId);
			root.userData.stationRequiredBatchSize = required;
			if (station.members.length !== required || !station.members.every(m => Math.abs((this.forwardTo(m.entity, m.point) ?? Infinity) - m.offset) < 0.001)) continue;
			station.phase = 'acting';
			station.elapsed = 0;
			// 按前后槽位交错 A/B，12 抓后的 6 件尾批也平均落到两条物理通道。
			station.members.sort((a, b) => a.offset - b.offset || String(a.entity.physicalLane).localeCompare(String(b.entity.physicalLane)));
			root.userData.stationPalletIds = station.members.map(m => m.entity.palletId);
			root.userData.stationPalletId = station.members[0].entity.palletId;
			root.userData.stationBehaviorRequirements = requirements;
			root.userData.stationCompletedGroupCounts = {}; root.userData.stationCompletedGroups = [];
			root.userData.processActive = true; root.userData.processPhase = 'waiting-behavior';
			root.userData.processType = process.type; root.userData.processProgress = 0;
		}
	}

	/** 将本帧行程限制到停车点，不倒退、不跳过碰撞检查。 */
	limitTravel(entity: BatchRouteEntity, requested: number) {
		let allowed = requested;
		for (const station of this.stations) {
			if (this.visited.get(entity.key)?.has(station.objectId)) continue;
			const member = station.members.find(m => m.entity.key === entity.key);
			if (member) {
				if (member.released) continue;
				allowed = Math.min(allowed, Math.max(0, (this.forwardTo(entity, member.point) ?? Infinity) - member.offset));
			} else for (const point of station.points) {
				if (!this.accepts(entity, point)) continue;
				if (point.process?.physicalLane && point.process.physicalLane !== entity.physicalLane) continue;
				const forward = this.forwardTo(entity, point);
				if (forward !== undefined && forward <= this.queueExtent(point) + 2) allowed = Math.min(allowed, Math.max(0, forward - this.queueExtent(point)));
			}
		}
		return allowed;
	}
	private accepts(entity: BatchRouteEntity, point: TwinRoutePointDefinition) {
		const condition = point.process?.materialAdmission;
		if (!condition || condition === 'any') return true;
		let count = 0;
		entity.root.traverse(node => { if (node.userData.materialEntity === true && !node.userData.materialAttachedBy) count++; });
		return condition === 'loaded' ? count > 0 : count === 0;
	}
	private spacing(point: TwinRoutePointDefinition) { return Math.max(1.55, Number(point.process?.batchLayout?.columnSpacingMeters || 1.55)); }
	private queueExtent(point: TwinRoutePointDefinition) { return (point.process?.batchLaneSize || point.process?.batchSize || 1) * this.spacing(point); }
	private forwardTo(entity: BatchRouteEntity, point: TwinRoutePointDefinition) {
		const snapshot = entity.simulationEngine?.getSnapshot(), route = entity.simulationRoute;
		if (!snapshot || !route || snapshot.lengthMeters <= 0) return undefined;
		const index = snapshot.activePointIds.indexOf(point.pointId); if (index < 0) return undefined;
		const byId = new Map(route.points.map(p => [p.pointId, p]));
		let distance = 0;
		for (let i = 1; i <= index; i++) distance += new THREE.Vector3(...byId.get(snapshot.activePointIds[i - 1])!.position).distanceTo(new THREE.Vector3(...byId.get(snapshot.activePointIds[i])!.position));
		const delta = distance - snapshot.distanceMeters;
		return delta >= -.0001 ? Math.max(0, delta) : route.loop ? (delta % snapshot.lengthMeters + snapshot.lengthMeters) % snapshot.lengthMeters : undefined;
	}
}
