import type { GantryStackTaskDefinition, SilkLineSimulationOptions } from '/@/digital-twin/contracts';
import { PalletFlowController } from '/@/digital-twin/runtime/PalletFlowController';
import { ProcessStationManager } from '/@/digital-twin/runtime/ProcessStationManager';
import { SilkMaterialRuntime } from '/@/digital-twin/runtime/SilkMaterialRuntime';
import { StackAreaManager } from '/@/digital-twin/runtime/StackAreaManager';

export interface GantryStackSnapshot {
	gantryId: string;
	state: 'idle' | 'waiting' | 'running' | 'fault';
	task?: GantryStackTaskDefinition;
	completedCount: number;
}

export class GantryStackController {
	private task?: GantryStackTaskDefinition;
	private completedCount = 0;

	constructor(
		private readonly pallets: PalletFlowController,
		private readonly stations: ProcessStationManager,
		private readonly materials: SilkMaterialRuntime,
		private readonly stack: StackAreaManager,
		private options: SilkLineSimulationOptions,
	) {}

	updateFixed(deltaSeconds: number) {
		if (this.task) {
			this.advanceTask(deltaSeconds);
			return;
		}
		const station = this.stations.getByType('gantry-stacking');
		if (!station?.currentEntityId) return;
		const pallet = this.pallets.getMutablePallet(station.currentEntityId);
		if (!pallet?.silkCakeId) {
			this.stations.wait(station.stationId, 'NO_SILK_CAKE');
			return;
		}
		const targetPosition = this.stack.allocate(pallet.silkCakeId);
		if (!targetPosition) {
			this.stations.wait(station.stationId, 'STACK_FULL');
			return;
		}
		this.pallets.markUnloading(pallet.palletId);
		this.stations.begin(station.stationId);
		this.task = {
			taskId: `GantryTask-${Date.now()}-${this.completedCount + 1}`,
			gantryId: 'GantryStacker-01',
			palletId: pallet.palletId,
			silkCakeId: pallet.silkCakeId,
			stackId: this.stack.getSnapshot().stackId,
			targetPosition,
			state: 'pending',
			progress: 0,
		};
	}

	getSnapshot(): GantryStackSnapshot {
		const station = this.stations.getByType('gantry-stacking');
		return {
			gantryId: 'GantryStacker-01',
			state: this.task ? 'running' : station?.state === 'fault' ? 'fault' : station?.currentEntityId ? 'waiting' : 'idle',
			task: this.task ? structuredClone(this.task) : undefined,
			completedCount: this.completedCount,
		};
	}

	reset() {
		if (this.task) this.stack.releaseReservation(this.task.silkCakeId);
		this.task = undefined;
		this.completedCount = 0;
	}

	private advanceTask(deltaSeconds: number) {
		const task = this.task!;
		task.progress = Math.min(1, task.progress + deltaSeconds / Math.max(0.2, this.options.gantryCycleSeconds));
		task.state = task.progress < 0.16 ? 'approach'
			: task.progress < 0.25 ? 'lower-pick'
				: task.progress < 0.3 ? 'grip'
					: task.progress < 0.42 ? 'lift'
						: task.progress < 0.58 ? 'move-x'
							: task.progress < 0.72 ? 'move-stack'
								: task.progress < 0.8 ? 'lower-place'
									: task.progress < 0.84 ? 'release'
										: task.progress < 1 ? 'return' : 'completed';

		const cake = this.materials.getCake(task.silkCakeId);
		if (task.progress >= 0.25 && cake && ['on-pallet', 'conveying'].includes(cake.state)) this.materials.beginGantryPick(task.silkCakeId, 'GantryStacker-01-Gripper');
		const pickedCake = this.materials.getCake(task.silkCakeId);
		if (task.progress >= 0.8 && pickedCake?.state === 'gantry-picking') {
			const committed = this.stack.commit(task.silkCakeId);
			if (committed) {
				this.materials.placeCakeInStack(task.silkCakeId, task.stackId, committed);
				this.pallets.markEmptyReturn(task.palletId);
			}
		}
		if (task.progress < 1) return;
		const station = this.stations.getByType('gantry-stacking');
		if (station) this.stations.complete(station.stationId);
		this.completedCount += 1;
		this.task = undefined;
	}
}
