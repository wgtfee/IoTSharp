import type { SilkLineSimulationOptions } from '/@/digital-twin/contracts';

export interface SilkCakeStackRuntime {
	stackId: string;
	name: string;
	rows: number;
	columns: number;
	maxLayers: number;
	occupied: number;
	capacity: number;
	silkCakeIds: string[];
	state: 'available' | 'full' | 'completed' | 'fault';
	nextPosition?: { layer: number; row: number; column: number };
}

/** 先列、后行、再层分配永久可见的码垛位置，并防止任务重复占用同一格。 */
export class StackAreaManager {
	private snapshot: SilkCakeStackRuntime;
	private reservation?: { silkCakeId: string; position: { layer: number; row: number; column: number } };

	constructor(options: SilkLineSimulationOptions, stackId = 'Stack-A') {
		this.snapshot = this.createSnapshot(options, stackId);
	}

	getSnapshot() {
		return structuredClone(this.snapshot);
	}

	allocate(silkCakeId: string) {
		if (this.reservation?.silkCakeId === silkCakeId) return { ...this.reservation.position };
		if (this.reservation || this.snapshot.state === 'full' || !this.snapshot.nextPosition) return undefined;
		this.reservation = { silkCakeId, position: { ...this.snapshot.nextPosition } };
		return { ...this.reservation.position };
	}

	commit(silkCakeId: string) {
		if (!this.reservation || this.reservation.silkCakeId !== silkCakeId) return undefined;
		const position = { ...this.reservation.position };
		this.reservation = undefined;
		this.snapshot.silkCakeIds.push(silkCakeId);
		this.snapshot.occupied = this.snapshot.silkCakeIds.length;
		this.snapshot.state = this.snapshot.occupied >= this.snapshot.capacity ? 'full' : 'available';
		this.snapshot.nextPosition = this.snapshot.state === 'full' ? undefined : this.indexToPosition(this.snapshot.occupied);
		return position;
	}

	releaseReservation(silkCakeId: string) {
		if (this.reservation?.silkCakeId === silkCakeId) this.reservation = undefined;
	}

	reset(options: SilkLineSimulationOptions) {
		this.reservation = undefined;
		this.snapshot = this.createSnapshot(options, this.snapshot.stackId);
	}

	private createSnapshot(options: SilkLineSimulationOptions, stackId: string): SilkCakeStackRuntime {
		const rows = Math.max(1, Math.floor(options.stackRows));
		const columns = Math.max(1, Math.floor(options.stackColumns));
		const maxLayers = Math.max(1, Math.floor(options.stackLayers));
		return {
			stackId,
			name: '丝饼码垛区 A',
			rows,
			columns,
			maxLayers,
			occupied: 0,
			capacity: rows * columns * maxLayers,
			silkCakeIds: [],
			state: 'available',
			nextPosition: { layer: 0, row: 0, column: 0 },
		};
	}

	private indexToPosition(index: number) {
		const perLayer = this.snapshot.rows * this.snapshot.columns;
		return {
			layer: Math.floor(index / perLayer),
			row: Math.floor(index % perLayer / this.snapshot.columns),
			column: index % this.snapshot.columns,
		};
	}
}
