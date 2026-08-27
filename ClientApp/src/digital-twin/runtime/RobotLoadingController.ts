import type { RobotPickAndPlaceTaskDefinition, SilkLineSimulationOptions } from '/@/digital-twin/contracts';
import { PalletFlowController } from '/@/digital-twin/runtime/PalletFlowController';
import { ProcessStationManager } from '/@/digital-twin/runtime/ProcessStationManager';
import { RotaryTableController } from '/@/digital-twin/runtime/RotaryTableController';
import { SilkMaterialRuntime } from '/@/digital-twin/runtime/SilkMaterialRuntime';

export interface RobotLoadingSnapshot {
	robotId: string;
	state: 'idle' | 'waiting' | 'running' | 'fault';
	task?: RobotPickAndPlaceTaskDefinition;
	completedCount: number;
}

export class RobotLoadingController {
	private task?: RobotPickAndPlaceTaskDefinition;
	private pendingSlotId?: string;
	private completedCount = 0;

	constructor(
		private readonly pallets: PalletFlowController,
		private readonly stations: ProcessStationManager,
		private readonly materials: SilkMaterialRuntime,
		private readonly rotary: RotaryTableController,
		private options: SilkLineSimulationOptions,
	) {}

	updateFixed(deltaSeconds: number) {
		const cart = this.materials.getCart();
		this.rotary.setCart(cart?.cartId);
		if (this.task) {
			this.advanceTask(deltaSeconds);
			return;
		}
		const station = this.stations.getByType('robot-loading');
		if (!station?.currentEntityId) return;
		const pallet = this.pallets.getMutablePallet(station.currentEntityId);
		if (!pallet) return;
		if (pallet.silkCakeId) {
			this.stations.complete(station.stationId);
			return;
		}
		if (!cart || cart.remainingCount <= 0) {
			this.pendingSlotId = undefined;
			this.stations.wait(station.stationId, 'CART_EMPTY');
			return;
		}

		let slot = this.pendingSlotId ? this.materials.getSlots().find((item) => item.slotId === this.pendingSlotId) : undefined;
		if (!slot) {
			slot = this.materials.peekNextOccupiedSlot();
			if (!slot || !this.materials.reserveSlot(slot.slotId)) {
				this.stations.wait(station.stationId, 'CART_EMPTY');
				return;
			}
			this.pendingSlotId = slot.slotId;
			slot = this.materials.getSlots().find((item) => item.slotId === slot!.slotId);
		}
		if (!slot?.silkCakeId) return;
		const slotIndex = Math.max(0, cart.slotIds.indexOf(slot.slotId));
		this.rotary.requestSlot(slot.slotId, slotIndex, cart.slotIds.length);
		if (!this.rotary.isReady(slot.slotId)) {
			this.stations.wait(station.stationId, 'PROCESS_NOT_COMPLETED');
			return;
		}
		this.materials.markCartReady(slot.slotId);
		this.rotary.lock();
		this.pallets.markLoading(pallet.palletId);
		this.stations.begin(station.stationId);
		this.task = {
			taskId: `RobotTask-${Date.now()}-${this.completedCount + 1}`,
			robotId: 'LoadingRobot-01',
			cartId: cart.cartId,
			sourceSlotId: slot.slotId,
			silkCakeId: slot.silkCakeId,
			targetPalletId: pallet.palletId,
			state: 'pending',
			progress: 0,
			startedAt: Date.now(),
		};
	}

	getSnapshot(): RobotLoadingSnapshot {
		const station = this.stations.getByType('robot-loading');
		return {
			robotId: 'LoadingRobot-01',
			state: this.task ? 'running' : station?.state === 'fault' ? 'fault' : station?.currentEntityId ? 'waiting' : 'idle',
			task: this.task ? structuredClone(this.task) : undefined,
			completedCount: this.completedCount,
		};
	}

	reset() {
		this.task = undefined;
		this.pendingSlotId = undefined;
		this.completedCount = 0;
		this.rotary.release();
	}

	private advanceTask(deltaSeconds: number) {
		const task = this.task!;
		task.progress = Math.min(1, task.progress + deltaSeconds / Math.max(0.2, this.options.robotCycleSeconds));
		task.state = task.progress < 0.15 ? 'approach-pick'
			: task.progress < 0.25 ? 'lower-pick'
				: task.progress < 0.3 ? 'grip'
					: task.progress < 0.4 ? 'lift'
						: task.progress < 0.65 ? 'transfer'
							: task.progress < 0.78 ? 'lower-place'
								: task.progress < 0.82 ? 'release'
									: task.progress < 1 ? 'return-home' : 'completed';

		const cake = this.materials.getCake(task.silkCakeId);
		if (task.progress >= 0.25 && cake?.state === 'on-cart') this.materials.pickReservedCake(task.sourceSlotId, 'LoadingRobot-01-Gripper');
		const pickedCake = this.materials.getCake(task.silkCakeId);
		if (task.progress >= 0.78 && pickedCake?.state === 'robot-picking') {
			this.materials.placeCakeOnPallet(task.silkCakeId, task.targetPalletId);
			this.pallets.markLoaded(task.targetPalletId, task.silkCakeId);
		}
		if (task.progress < 1) return;
		task.completedAt = Date.now();
		const station = this.stations.getByType('robot-loading');
		if (station) this.stations.complete(station.stationId);
		this.rotary.release();
		this.pendingSlotId = undefined;
		this.completedCount += 1;
		this.task = undefined;
	}
}
