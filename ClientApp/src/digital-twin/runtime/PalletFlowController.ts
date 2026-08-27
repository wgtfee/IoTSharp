import type { PlasticPalletDefinition, SilkLineSimulationOptions, SilkProcessWaitingReason, TwinFlowWaitingCode, TwinRouteDefinition } from '/@/digital-twin/contracts';
import type { TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';
import { ProcessStationManager } from '/@/digital-twin/runtime/ProcessStationManager';
import { SilkMaterialRuntime } from '/@/digital-twin/runtime/SilkMaterialRuntime';
import { TwinMaterialFlowRuntime } from '/@/digital-twin/runtime/TwinMaterialFlowRuntime';
import { TwinSectionGeometryResolver } from '/@/digital-twin/runtime/TwinSectionGeometryResolver';

export interface PalletFlowSnapshot {
	pallets: PlasticPalletDefinition[];
	sourceQueue: string[];
	onlineCount: number;
	loadedCount: number;
	emptyCount: number;
	waitingCount: number;
}

/**
 * 塑料托盘的唯一运动控制器。业务位置不是整圈 distance，而是 Section + Progress；
 * 边界只通过现有 TwinMaterialFlowRuntime 原子转移，满位后保持在 1.0 并自动重试。
 */
export class PalletFlowController {
	private route: TwinRouteDefinition;
	private readonly pallets = new Map<string, PlasticPalletDefinition>();
	private readonly sourceQueue: string[] = [];
	private routingContext: TwinRouteRoutingContext = {};
	private speed: number;
	private running = false;
	private releaseElapsed = Number.POSITIVE_INFINITY;
	private simulatedNow = Date.now();
	private allowSourceAgainstReturn = false;
	private readonly minimumGapMeters = 0.95;

	constructor(
		route: TwinRouteDefinition,
		private readonly flow: TwinMaterialFlowRuntime,
		private readonly geometry: TwinSectionGeometryResolver,
		private readonly stations: ProcessStationManager,
		private readonly materials: SilkMaterialRuntime,
		private options: SilkLineSimulationOptions,
	) {
		this.route = structuredClone(route);
		this.speed = route.defaultSpeed;
		this.createPallets();
	}

	setRunning(running: boolean) {
		this.running = running;
	}

	setSpeed(speed: number) {
		if (Number.isFinite(speed) && speed > 0) this.speed = speed;
	}

	setRoutingContext(context: TwinRouteRoutingContext) {
		this.routingContext = {
			payload: { ...(context.payload || {}) },
			bindingValues: { ...(context.bindingValues || {}) },
			edgeOccupancy: { ...(context.edgeOccupancy || {}) },
			staleBindingIds: [...(context.staleBindingIds || [])],
		};
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = structuredClone(route);
		this.speed = route.defaultSpeed;
	}

	getPallet(palletId: string) {
		const pallet = this.pallets.get(palletId);
		return pallet ? structuredClone(pallet) : undefined;
	}

	/** 仅供同一业务 Runtime 内的工位 Controller 进行原子状态提交。 */
	getMutablePallet(palletId: string) {
		return this.pallets.get(palletId);
	}

	getSnapshot(): PalletFlowSnapshot {
		const pallets = [...this.pallets.values()].map((pallet) => structuredClone(pallet));
		return {
			pallets,
			sourceQueue: [...this.sourceQueue],
			onlineCount: pallets.filter((pallet) => pallet.currentSectionId).length,
			loadedCount: pallets.filter((pallet) => Boolean(pallet.silkCakeId)).length,
			emptyCount: pallets.filter((pallet) => !pallet.silkCakeId).length,
			waitingCount: pallets.filter((pallet) => pallet.state === 'waiting' || pallet.state === 'waiting-load').length,
		};
	}

	updateFixed(deltaSeconds: number) {
		if (!this.running || deltaSeconds <= 0) return;
		this.simulatedNow += deltaSeconds * 1000;
		this.releaseElapsed += deltaSeconds;
		this.injectFromSourceQueue();

		const bySection = new Map<string, PlasticPalletDefinition[]>();
		for (const pallet of this.pallets.values()) {
			if (!pallet.currentSectionId) continue;
			bySection.set(pallet.currentSectionId, [...(bySection.get(pallet.currentSectionId) || []), pallet]);
		}

		for (const [sectionId, sectionPallets] of bySection) {
			const section = this.geometry.get(sectionId);
			if (!section) continue;
			sectionPallets.sort((left, right) => right.sectionProgress - left.sectionProgress || left.palletId.localeCompare(right.palletId));
			let aheadProgress = Number.POSITIVE_INFINITY;
			const normalizedGap = Math.min(0.45, this.minimumGapMeters / section.length);
			for (const pallet of sectionPallets) {
				let desired = pallet.sectionProgress + this.speed * deltaSeconds / section.length;
				if (Number.isFinite(aheadProgress)) desired = Math.min(desired, Math.max(0, aheadProgress - normalizedGap));
				pallet.sectionProgress = Math.min(1, Math.max(pallet.sectionProgress, desired));
				aheadProgress = pallet.sectionProgress;
				if (pallet.sectionProgress >= 1 - 0.000001) this.tryCrossBoundary(pallet);
				else {
					pallet.state = pallet.silkCakeId ? 'moving' : pallet.cycleCount > 0 ? 'empty-return' : 'empty';
					delete pallet.waitingReason;
					delete pallet.waitingForSectionId;
					if (pallet.silkCakeId) this.materials.markConveying(pallet.silkCakeId, sectionId);
				}
			}
		}
	}

	markLoading(palletId: string) {
		const pallet = this.pallets.get(palletId);
		if (!pallet || pallet.silkCakeId) return false;
		pallet.state = 'loading';
		delete pallet.waitingReason;
		return true;
	}

	markLoaded(palletId: string, silkCakeId: string) {
		const pallet = this.pallets.get(palletId);
		if (!pallet || pallet.silkCakeId) return false;
		pallet.silkCakeId = silkCakeId;
		pallet.state = 'loaded';
		delete pallet.waitingReason;
		return true;
	}

	markUnloading(palletId: string) {
		const pallet = this.pallets.get(palletId);
		if (!pallet?.silkCakeId) return false;
		pallet.state = 'unloading';
		return true;
	}

	markEmptyReturn(palletId: string) {
		const pallet = this.pallets.get(palletId);
		if (!pallet) return false;
		delete pallet.silkCakeId;
		pallet.state = 'empty-return';
		return true;
	}

	reset() {
		this.flow.resetState();
		this.stations.reset();
		this.pallets.clear();
		this.sourceQueue.length = 0;
		this.releaseElapsed = Number.POSITIVE_INFINITY;
		this.simulatedNow = Date.now();
		this.allowSourceAgainstReturn = false;
		this.createPallets();
	}

	private createPallets() {
		const count = Math.min(200, Math.max(1, Math.floor(this.options.palletCount)));
		for (let index = 0; index < count; index += 1) {
			const palletId = `PlasticPallet-${String(index + 1).padStart(3, '0')}`;
			this.pallets.set(palletId, {
				palletId,
				sectionProgress: 0,
				state: 'queued',
				cycleCount: 0,
				routeCode: index % 2 === 0 ? 'A' : 'B',
			});
			this.sourceQueue.push(palletId);
		}
	}

	private injectFromSourceQueue() {
		if (!this.sourceQueue.length || this.releaseElapsed < this.options.palletReleaseIntervalSeconds) return;
		const startPointId = this.route.startPointId || this.route.points[0]?.pointId;
		// 回流空托盘优先于新载具上线，否则 SourceQueue 会长期抢占单容量上料段并造成循环载具饥饿。
		const returnWaiting = [...this.pallets.values()].some((pallet) => {
			if (!pallet.currentSectionId || pallet.sectionProgress < 0.999) return false;
			return this.geometry.get(pallet.currentSectionId)?.toPointId === startPointId;
		});
		if (returnWaiting && !this.allowSourceAgainstReturn) return;
		const startSection = this.route.edges.find((edge) => edge.enabled !== false && edge.fromPointId === startPointId);
		if (!startSection) return;
		const palletId = this.sourceQueue[0];
		const transfer = this.flow.sections.tryTransfer(palletId, undefined, startSection.edgeId, this.simulatedNow);
		if (!transfer.canAccept) return;
		this.sourceQueue.shift();
		const pallet = this.pallets.get(palletId)!;
		pallet.currentSectionId = startSection.edgeId;
		pallet.nextSectionId = undefined;
		pallet.sectionProgress = 0;
		pallet.state = 'empty';
		this.flow.entities.resume(palletId, startSection.edgeId, this.simulatedNow);
		this.releaseElapsed = 0;
		this.allowSourceAgainstReturn = false;
	}

	private tryCrossBoundary(pallet: PlasticPalletDefinition) {
		const currentSectionId = pallet.currentSectionId;
		if (!currentSectionId) return;
		const sectionGeometry = this.geometry.get(currentSectionId);
		if (!sectionGeometry) return;

		const station = this.stations.getBySection(currentSectionId);
		if (station) {
			this.stations.arrive(currentSectionId, pallet.palletId);
			if (station.type === 'robot-loading' && !pallet.silkCakeId && pallet.state !== 'loading') pallet.state = 'waiting-load';
			if (station.type === 'gantry-stacking' && pallet.silkCakeId && pallet.state !== 'unloading') pallet.state = 'waiting';
			const guard = this.stations.canRelease(currentSectionId, pallet.palletId);
			if (!guard.canRelease) {
				this.waitForProcess(pallet, guard.reason || 'PROCESS_NOT_COMPLETED');
				return;
			}
		}

		const outgoing = this.route.edges
			.filter((edge) => edge.enabled !== false && edge.fromPointId === sectionGeometry.toPointId)
			.sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.edgeId.localeCompare(right.edgeId));
		if (!outgoing.length) {
			pallet.state = 'completed';
			return;
		}

		let targetSectionId: string | undefined;
		let waitingReason: TwinFlowWaitingCode | undefined;
		if (outgoing.length > 1) {
			const result = this.flow.tryAdvanceAtJunction({
				entityId: pallet.palletId,
				currentSectionId,
				junctionPointId: sectionGeometry.toPointId,
				context: { ...this.routingContext, payload: { ...(this.routingContext.payload || {}), routeCode: pallet.routeCode, palletId: pallet.palletId } },
				now: this.simulatedNow,
			});
			targetSectionId = result.decision?.targetSectionId;
			waitingReason = result.waitingReason;
		} else {
			targetSectionId = outgoing[0].edgeId;
			const transfer = this.flow.sections.tryTransfer(pallet.palletId, currentSectionId, targetSectionId, this.simulatedNow);
			if (!transfer.canAccept) waitingReason = transfer.reason === 'full' ? 'TARGET_SECTION_FULL' : transfer.reason === 'signal-stale' ? 'TARGET_SECTION_SIGNAL_STALE' : 'TARGET_SECTION_BLOCKED';
			else this.flow.entities.resume(pallet.palletId, targetSectionId, this.simulatedNow);
		}

		if (!targetSectionId || waitingReason) {
			pallet.state = 'waiting';
			pallet.waitingReason = waitingReason || 'ROUTE_NOT_READY';
			pallet.waitingForSectionId = targetSectionId;
			pallet.nextSectionId = targetSectionId;
			if (waitingReason) this.flow.entities.wait(pallet.palletId, waitingReason, targetSectionId, this.simulatedNow);
			return;
		}

		this.stations.release(currentSectionId, pallet.palletId);
		pallet.currentSectionId = targetSectionId;
		pallet.nextSectionId = undefined;
		pallet.sectionProgress = 0;
		delete pallet.waitingReason;
		delete pallet.waitingForSectionId;
		if (targetSectionId === 'silk-edge-loading') {
			pallet.cycleCount += 1;
			pallet.state = 'empty';
			this.allowSourceAgainstReturn = true;
		} else pallet.state = pallet.silkCakeId ? 'moving' : 'empty-return';
		if (pallet.silkCakeId) this.materials.markConveying(pallet.silkCakeId, targetSectionId);
	}

	private waitForProcess(pallet: PlasticPalletDefinition, reason: SilkProcessWaitingReason) {
		pallet.waitingReason = reason;
		pallet.waitingForSectionId = pallet.currentSectionId;
		if (pallet.state !== 'loading' && pallet.state !== 'unloading' && pallet.state !== 'waiting-load') pallet.state = 'waiting';
	}
}
