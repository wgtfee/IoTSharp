import type { SilkProcessWaitingReason } from '/@/digital-twin/contracts';

export type TwinProcessStationType = 'robot-loading' | 'gantry-stacking' | 'scan' | 'inspection';
export type TwinProcessStationState = 'idle' | 'waiting' | 'processing' | 'completed' | 'fault';

export interface TwinProcessStationRuntime {
	stationId: string;
	sectionId: string;
	type: TwinProcessStationType;
	state: TwinProcessStationState;
	currentEntityId?: string;
	canRelease: boolean;
	waitingReason?: SilkProcessWaitingReason;
}

/** 工位完成条件独立于下游容量；两者都允许时托盘才能越过 Section 边界。 */
export class ProcessStationManager {
	private readonly stations = new Map<string, TwinProcessStationRuntime>();

	constructor(definitions: Array<Pick<TwinProcessStationRuntime, 'stationId' | 'sectionId' | 'type'>>) {
		for (const definition of definitions) {
			this.stations.set(definition.stationId, { ...definition, state: 'idle', canRelease: false });
		}
	}

	get(stationId: string) {
		const station = this.stations.get(stationId);
		return station ? structuredClone(station) : undefined;
	}

	getBySection(sectionId: string) {
		const station = [...this.stations.values()].find((item) => item.sectionId === sectionId);
		return station ? structuredClone(station) : undefined;
	}

	getByType(type: TwinProcessStationType) {
		const station = [...this.stations.values()].find((item) => item.type === type);
		return station ? structuredClone(station) : undefined;
	}

	getAll() {
		return [...this.stations.values()].map((station) => structuredClone(station));
	}

	arrive(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.sectionId === sectionId);
		if (!station) return undefined;
		if (station.currentEntityId && station.currentEntityId !== entityId) return structuredClone(station);
		if (!station.currentEntityId) {
			station.currentEntityId = entityId;
			station.state = 'waiting';
			station.canRelease = false;
			station.waitingReason = station.type === 'robot-loading' ? 'PROCESS_NOT_COMPLETED' : 'PROCESS_NOT_COMPLETED';
		}
		return structuredClone(station);
	}

	begin(stationId: string) {
		const station = this.stations.get(stationId);
		if (!station?.currentEntityId || station.state === 'fault') return false;
		station.state = 'processing';
		station.canRelease = false;
		delete station.waitingReason;
		return true;
	}

	wait(stationId: string, reason: SilkProcessWaitingReason) {
		const station = this.stations.get(stationId);
		if (!station) return;
		station.state = reason === 'FAULT' ? 'fault' : 'waiting';
		station.canRelease = false;
		station.waitingReason = reason;
	}

	complete(stationId: string) {
		const station = this.stations.get(stationId);
		if (!station?.currentEntityId) return false;
		station.state = 'completed';
		station.canRelease = true;
		delete station.waitingReason;
		return true;
	}

	canRelease(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.sectionId === sectionId);
		if (!station) return { canRelease: true as const };
		if (station.currentEntityId !== entityId || !station.canRelease) {
			return { canRelease: false as const, reason: station.waitingReason || 'PROCESS_NOT_COMPLETED' as SilkProcessWaitingReason };
		}
		return { canRelease: true as const };
	}

	release(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.sectionId === sectionId);
		if (!station || station.currentEntityId !== entityId || !station.canRelease) return false;
		station.state = 'idle';
		station.canRelease = false;
		delete station.currentEntityId;
		delete station.waitingReason;
		return true;
	}

	reset() {
		for (const station of this.stations.values()) {
			station.state = 'idle';
			station.canRelease = false;
			delete station.currentEntityId;
			delete station.waitingReason;
		}
	}
}
