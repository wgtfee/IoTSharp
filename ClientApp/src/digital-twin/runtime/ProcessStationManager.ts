import type { SilkProcessWaitingReason, TwinProcessDefinition } from '../contracts';
import { ComponentProcessStateMachine, type TwinComponentProcessSignalContext, type TwinComponentProcessSnapshot } from './ComponentProcessStateMachine';

export type TwinProcessStationType = 'robot-loading' | 'gantry-stacking' | 'scan' | 'inspection' | 'external-inspection' | 'bagging';
export type TwinProcessStationState = 'idle' | 'waiting' | 'processing' | 'completed' | 'fault';

export interface TwinProcessStationRuntime {
	stationId: string;
	sectionId: string;
	type: TwinProcessStationType;
	state: TwinProcessStationState;
	currentEntityId?: string;
	canRelease: boolean;
	waitingReason?: SilkProcessWaitingReason;
	result?: unknown;
}

export interface TwinProcessStationDefinition extends Pick<TwinProcessStationRuntime, 'stationId' | 'sectionId' | 'type'> {
	/** Generated Process Contract；未提供时保持原有控制器手动 begin/complete 行为。 */
	process?: TwinProcessDefinition;
	dataMode?: 'simulation' | 'live';
}

/** 工位完成条件独立于下游容量；两者都允许时托盘才能越过 Section 边界。 */
export class ProcessStationManager {
	private readonly stations = new Map<string, TwinProcessStationRuntime>();
	private readonly stateMachines = new Map<string, ComponentProcessStateMachine>();

	constructor(definitions: TwinProcessStationDefinition[]) {
		for (const definition of definitions) {
			this.stations.set(definition.stationId, {
				stationId: definition.stationId,
				sectionId: definition.sectionId,
				type: definition.type,
				state: 'idle',
				canRelease: false,
			});
			if (definition.process) this.stateMachines.set(
				definition.stationId,
				new ComponentProcessStateMachine(structuredClone(definition.process), definition.dataMode || 'simulation'),
			);
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
			const machine = this.stateMachines.get(station.stationId);
			if (machine) this.applyProcessSnapshot(station, machine.arrive());
			else {
				station.state = 'waiting';
				station.canRelease = false;
				station.waitingReason = 'PROCESS_NOT_COMPLETED';
			}
		}
		return structuredClone(station);
	}

	/** 驱动 Generated Process Contract。Live 模式下 stale/fault 信号会保持阻塞。 */
	update(stationId: string, deltaSeconds: number, context: TwinComponentProcessSignalContext = {}) {
		const station = this.stations.get(stationId);
		const machine = this.stateMachines.get(stationId);
		if (!station || !machine || !station.currentEntityId) return station ? structuredClone(station) : undefined;
		this.applyProcessSnapshot(station, machine.update(deltaSeconds, context));
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
		delete station.result;
		this.stateMachines.get(station.stationId)?.reset();
		return true;
	}

	reset() {
		for (const station of this.stations.values()) {
			station.state = 'idle';
			station.canRelease = false;
			delete station.currentEntityId;
			delete station.waitingReason;
			delete station.result;
		}
		for (const machine of this.stateMachines.values()) machine.reset();
	}

	private applyProcessSnapshot(station: TwinProcessStationRuntime, snapshot: TwinComponentProcessSnapshot) {
		station.state = snapshot.state === 'Idle' ? 'idle'
			: snapshot.state === 'Processing' ? 'processing'
				: snapshot.state === 'Completed' ? 'completed'
					: snapshot.state === 'Fault' ? 'fault' : 'waiting';
		station.canRelease = snapshot.canRelease;
		station.waitingReason = snapshot.waitingReason;
		station.result = snapshot.result;
	}
}
