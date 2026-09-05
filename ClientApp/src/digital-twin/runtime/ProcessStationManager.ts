import type { SilkProcessWaitingReason, TwinProcessDefinition } from '../contracts';
import { ComponentProcessStateMachine, type TwinComponentProcessSignalContext, type TwinComponentProcessSnapshot } from './ComponentProcessStateMachine';

export type TwinProcessStationType = 'robot-loading' | 'gantry-stacking' | 'scan' | 'inspection' | 'external-inspection' | 'bagging';
export type TwinProcessStationState = 'idle' | 'waiting' | 'processing' | 'completed' | 'fault';

export interface TwinProcessStationEntityRuntime {
	entityId: string;
	state: TwinProcessStationState;
	canRelease: boolean;
	waitingReason?: SilkProcessWaitingReason;
	result?: unknown;
}

export interface TwinProcessStationRuntime {
	stationId: string;
	sectionId: string;
	type: TwinProcessStationType;
	state: TwinProcessStationState;
	/** 兼容旧单工位控制器：多实体时返回最早进入的实体。 */
	currentEntityId?: string;
	entityIds: string[];
	capacity: number;
	canRelease: boolean;
	waitingReason?: SilkProcessWaitingReason;
	result?: unknown;
}

export interface TwinProcessStationDefinition extends Pick<TwinProcessStationRuntime, 'stationId' | 'sectionId' | 'type'> {
	/** Generated Process Contract；未提供时保持原有控制器手动 begin/complete 行为。 */
	process?: TwinProcessDefinition;
	dataMode?: 'simulation' | 'live';
	capacity?: number;
}

interface TwinProcessStationInternal {
	runtime: TwinProcessStationRuntime;
	definition: TwinProcessStationDefinition;
	entities: Map<string, TwinProcessStationEntityRuntime>;
	machines: Map<string, ComponentProcessStateMachine>;
}

/**
 * 工位完成条件独立于下游容量；两者都允许时物料才能越过 Section 边界。
 * Generated Process Station 支持 capacity > 1，每个实体拥有独立状态机；
 * currentEntityId 仅作为旧单工位控制器兼容视图。
 */
export class ProcessStationManager {
	private readonly stations = new Map<string, TwinProcessStationInternal>();

	constructor(definitions: TwinProcessStationDefinition[]) {
		for (const source of definitions) {
			const definition = structuredClone(source);
			const capacity = Math.max(1, Math.floor(Number(definition.capacity) || 1));
			this.stations.set(definition.stationId, {
				runtime: {
					stationId: definition.stationId,
					sectionId: definition.sectionId,
					type: definition.type,
					state: 'idle',
					entityIds: [],
					capacity,
					canRelease: false,
				},
				definition,
				entities: new Map(),
				machines: new Map(),
			});
		}
	}

	get(stationId: string) {
		const station = this.stations.get(stationId);
		return station ? structuredClone(station.runtime) : undefined;
	}

	getBySection(sectionId: string) {
		const station = [...this.stations.values()].find((item) => item.runtime.sectionId === sectionId);
		return station ? structuredClone(station.runtime) : undefined;
	}

	getByType(type: TwinProcessStationType) {
		const station = [...this.stations.values()].find((item) => item.runtime.type === type);
		return station ? structuredClone(station.runtime) : undefined;
	}

	getEntity(stationId: string, entityId: string) {
		const entity = this.stations.get(stationId)?.entities.get(entityId);
		return entity ? structuredClone(entity) : undefined;
	}

	getAll() {
		return [...this.stations.values()].map((station) => structuredClone(station.runtime));
	}

	arrive(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.runtime.sectionId === sectionId);
		if (!station) return undefined;
		if (station.entities.has(entityId)) return structuredClone(station.runtime);
		if (station.entities.size >= station.runtime.capacity) {
			station.runtime.waitingReason = 'PROCESS_NOT_COMPLETED';
			return structuredClone(station.runtime);
		}

		const entity: TwinProcessStationEntityRuntime = {
			entityId,
			state: 'waiting',
			canRelease: false,
			waitingReason: 'PROCESS_NOT_COMPLETED',
		};
		station.entities.set(entityId, entity);
		if (station.definition.process) {
			const machine = new ComponentProcessStateMachine(
				structuredClone(station.definition.process),
				station.definition.dataMode || 'simulation',
			);
			station.machines.set(entityId, machine);
			this.applyEntitySnapshot(entity, machine.arrive());
		}
		this.syncStation(station);
		return structuredClone(station.runtime);
	}

	/** 驱动旧单工位调用；多工位场景请使用 updateEntity。 */
	update(stationId: string, deltaSeconds: number, context: TwinComponentProcessSignalContext = {}) {
		const station = this.stations.get(stationId);
		const entityId = station?.runtime.currentEntityId;
		if (!station || !entityId) return station ? structuredClone(station.runtime) : undefined;
		this.updateEntity(stationId, entityId, deltaSeconds, context);
		return structuredClone(station.runtime);
	}

	/** 每个实体独立驱动 Generated Process Contract，双工位可并行更新两个实体。 */
	updateEntity(stationId: string, entityId: string, deltaSeconds: number, context: TwinComponentProcessSignalContext = {}) {
		const station = this.stations.get(stationId);
		const entity = station?.entities.get(entityId);
		const machine = station?.machines.get(entityId);
		if (!station || !entity || !machine) return entity ? structuredClone(entity) : undefined;
		this.applyEntitySnapshot(entity, machine.update(deltaSeconds, context));
		this.syncStation(station);
		return structuredClone(entity);
	}

	begin(stationId: string, entityId?: string) {
		const station = this.stations.get(stationId);
		const selectedId = entityId || station?.runtime.currentEntityId;
		const entity = selectedId ? station?.entities.get(selectedId) : undefined;
		if (!station || !entity || entity.state === 'fault') return false;
		entity.state = 'processing';
		entity.canRelease = false;
		delete entity.waitingReason;
		this.syncStation(station);
		return true;
	}

	wait(stationId: string, reason: SilkProcessWaitingReason, entityId?: string) {
		const station = this.stations.get(stationId);
		const selectedId = entityId || station?.runtime.currentEntityId;
		const entity = selectedId ? station?.entities.get(selectedId) : undefined;
		if (!station || !entity) return;
		entity.state = reason === 'FAULT' ? 'fault' : 'waiting';
		entity.canRelease = false;
		entity.waitingReason = reason;
		this.syncStation(station);
	}

	complete(stationId: string, entityId?: string) {
		const station = this.stations.get(stationId);
		const selectedId = entityId || station?.runtime.currentEntityId;
		const entity = selectedId ? station?.entities.get(selectedId) : undefined;
		if (!station || !entity) return false;
		entity.state = 'completed';
		entity.canRelease = true;
		delete entity.waitingReason;
		this.syncStation(station);
		return true;
	}

	canAccept(sectionId: string, entityId?: string) {
		const station = [...this.stations.values()].find((item) => item.runtime.sectionId === sectionId);
		if (!station) return true;
		if (entityId && station.entities.has(entityId)) return true;
		return station.entities.size < station.runtime.capacity;
	}

	canRelease(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.runtime.sectionId === sectionId);
		if (!station) return { canRelease: true as const };
		const entity = station.entities.get(entityId);
		if (!entity || !entity.canRelease) {
			return { canRelease: false as const, reason: entity?.waitingReason || station.runtime.waitingReason || 'PROCESS_NOT_COMPLETED' as SilkProcessWaitingReason };
		}
		return { canRelease: true as const };
	}

	release(sectionId: string, entityId: string) {
		const station = [...this.stations.values()].find((item) => item.runtime.sectionId === sectionId);
		const entity = station?.entities.get(entityId);
		if (!station || !entity?.canRelease) return false;
		station.entities.delete(entityId);
		station.machines.delete(entityId);
		this.syncStation(station);
		return true;
	}

	reset() {
		for (const station of this.stations.values()) {
			station.entities.clear();
			station.machines.clear();
			this.syncStation(station);
		}
	}

	private applyEntitySnapshot(entity: TwinProcessStationEntityRuntime, snapshot: TwinComponentProcessSnapshot) {
		entity.state = snapshot.state === 'Idle' ? 'idle'
			: snapshot.state === 'Processing' ? 'processing'
				: snapshot.state === 'Completed' ? 'completed'
					: snapshot.state === 'Fault' ? 'fault' : 'waiting';
		entity.canRelease = snapshot.canRelease;
		entity.waitingReason = snapshot.waitingReason as SilkProcessWaitingReason | undefined;
		entity.result = snapshot.result;
	}

	private syncStation(station: TwinProcessStationInternal) {
		const entities = [...station.entities.values()];
		station.runtime.entityIds = entities.map((entity) => entity.entityId);
		station.runtime.currentEntityId = entities[0]?.entityId;
		station.runtime.canRelease = entities.length === 1 ? entities[0].canRelease : entities.length > 0 && entities.every((entity) => entity.canRelease);
		station.runtime.result = entities.length === 1 ? entities[0].result : entities.length > 0 ? entities.map((entity) => entity.result) : undefined;
		const firstFault = entities.find((entity) => entity.state === 'fault');
		const firstWaiting = entities.find((entity) => entity.state === 'waiting');
		station.runtime.waitingReason = firstFault?.waitingReason || firstWaiting?.waitingReason;
		station.runtime.state = entities.length === 0 ? 'idle'
			: firstFault ? 'fault'
				: entities.some((entity) => entity.state === 'processing') ? 'processing'
					: entities.some((entity) => entity.state === 'waiting') ? 'waiting'
						: entities.every((entity) => entity.state === 'completed') ? 'completed' : entities[0].state;
	}
}
