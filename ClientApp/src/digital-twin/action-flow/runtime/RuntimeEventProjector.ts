import type { TwinActionFlowProjection, TwinActionFlowRuntimeEvent, TwinSimulationCommandState, TwinSimulationMaterialState, TwinSimulationReservationState } from '../contracts/action-flow-v2';

export const createEmptyActionFlowProjection = (): TwinActionFlowProjection => ({
	state: 'Created', sequence: 0, activeNodeIds: [], nodeStates: {}, waitingReasons: {}, commands: {}, reservations: {}, materials: {}, alarms: [],
});

export class RuntimeEventProjector {
	private projection: TwinActionFlowProjection = createEmptyActionFlowProjection();
	reset() { this.projection = createEmptyActionFlowProjection(); }
	apply(event: TwinActionFlowRuntimeEvent) {
		if (event.sequence <= this.projection.sequence) return this.getSnapshot();
		this.projection.runId = event.runId; this.projection.sequence = event.sequence;
		const nodeId = event.nodeId;
		switch (event.type) {
			case 'RunStarted': this.projection.state = 'Running'; break;
			case 'RunPaused': this.projection.state = 'Paused'; break;
			case 'RunResumed': this.projection.state = 'Running'; break;
			case 'RunCompleted': this.projection.state = 'Completed'; this.projection.activeNodeIds = []; break;
			case 'RunFaulted': this.projection.state = 'Faulted'; break;
			case 'RunCancelled': this.projection.state = 'Cancelled'; this.projection.activeNodeIds = []; break;
			case 'StepStarted': if (nodeId) { this.projection.nodeStates[nodeId] = 'Running'; this.addActive(nodeId); delete this.projection.waitingReasons[nodeId]; } break;
			case 'StepWaiting': if (nodeId) { this.projection.nodeStates[nodeId] = 'Waiting'; this.addActive(nodeId); this.projection.waitingReasons[nodeId] = String(event.payload?.reason || 'WAITING'); } break;
			case 'StepSucceeded': if (nodeId) { this.projection.nodeStates[nodeId] = 'Succeeded'; this.removeActive(nodeId); delete this.projection.waitingReasons[nodeId]; } break;
			case 'StepFailed': case 'StepTimedOut': if (nodeId) { this.projection.nodeStates[nodeId] = 'Failed'; this.removeActive(nodeId); } break;
			case 'StepSkipped': if (nodeId) { this.projection.nodeStates[nodeId] = 'Skipped'; this.removeActive(nodeId); } break;
			case 'CommandSent': {
				const commandId = String(event.payload?.commandId || ''); if (commandId) this.projection.commands[commandId] = { commandId, nodeId: nodeId || '', bindingId: event.payload?.bindingId ? String(event.payload.bindingId) : undefined, payload: (event.payload?.payload as Record<string, unknown>) || {}, status: 'sent', correlationId: event.correlationId };
				break;
			}
			case 'CommandAcknowledged': { const command = this.projection.commands[String(event.payload?.commandId || '')]; if (command) command.status = 'acknowledged'; break; }
			case 'CommandCompleted': { const command = this.projection.commands[String(event.payload?.commandId || '')]; if (command) command.status = 'completed'; break; }
			case 'ResourceReserved': { const reservation = event.payload?.reservation as TwinSimulationReservationState | undefined; if (reservation) this.projection.reservations[reservation.reservationId] = structuredClone(reservation); break; }
			case 'ResourceReleased': case 'ResourceLeaseExpired': { const reservationId = String(event.payload?.reservationId || ''); if (reservationId) delete this.projection.reservations[reservationId]; break; }
			case 'MaterialTransferred': { const material = event.payload?.material as TwinSimulationMaterialState | undefined; if (material) this.projection.materials[material.materialInstanceId] = structuredClone(material); break; }
			case 'AlarmRaised': this.projection.alarms.push({ nodeId, code: event.payload?.code ? String(event.payload.code) : undefined, message: String(event.payload?.message || 'Alarm'), occurredAt: event.occurredAt }); break;
		}
		return this.getSnapshot();
	}
	applyMany(events: TwinActionFlowRuntimeEvent[]) { for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) this.apply(event); return this.getSnapshot(); }
	getSnapshot() { return structuredClone(this.projection); }
	private addActive(nodeId: string) { if (!this.projection.activeNodeIds.includes(nodeId)) this.projection.activeNodeIds.push(nodeId); }
	private removeActive(nodeId: string) { this.projection.activeNodeIds = this.projection.activeNodeIds.filter((item) => item !== nodeId); }
}

export const projectActionFlowEvents = (events: TwinActionFlowRuntimeEvent[]) => new RuntimeEventProjector().applyMany(events);
