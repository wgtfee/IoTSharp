import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from '@microsoft/signalr';
import { digitalTwinApi, type TwinActionFlowEvent, type TwinActionFlowRun } from '/@/api/digital-twin';
import { Session } from '/@/utils/storage';
import type {
	TwinActionFlowRuntimeEvent,
	TwinActionFlowRunState,
	TwinActionFlowStepState,
	TwinSimulationCommandState,
	TwinSimulationMaterialState,
	TwinSimulationReservationState,
} from '../contracts/action-flow-v2';
import type { SimulationFlowRuntimeSnapshot } from './SimulationFlowRuntime';

export type LiveConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export interface LiveFlowRuntimeSnapshot extends SimulationFlowRuntimeSnapshot {
	connectionState: LiveConnectionState;
	persistedFlowId: string;
}

export interface LiveFlowRuntimeClientOptions {
	persistedFlowId: string;
	semanticFlowId: string;
	onChanged?: (snapshot: LiveFlowRuntimeSnapshot) => void;
	onError?: (error: unknown) => void;
}

const apiData = <T>(response: any): T => (response?.data ?? response) as T;
const terminalStates = new Set<TwinActionFlowRunState>(['Completed', 'Faulted', 'Cancelled']);
const asRunState = (value: string): TwinActionFlowRunState => {
	const allowed: TwinActionFlowRunState[] = ['Created', 'Ready', 'Running', 'WaitingSignal', 'WaitingResource', 'Paused', 'Recovering', 'Completed', 'Faulted', 'Cancelled'];
	return allowed.includes(value as TwinActionFlowRunState) ? value as TwinActionFlowRunState : 'Created';
};
const asStepState = (value: string): TwinActionFlowStepState => {
	const allowed: TwinActionFlowStepState[] = ['Pending', 'Ready', 'Running', 'Waiting', 'Succeeded', 'Failed', 'Compensating', 'Compensated', 'Skipped'];
	return allowed.includes(value as TwinActionFlowStepState) ? value as TwinActionFlowStepState : 'Pending';
};
const commandStatus = (value: string): TwinSimulationCommandState['status'] => {
	if (value === 'Acknowledged' || value === 'Busy') return 'acknowledged';
	if (value === 'Completed') return 'completed';
	if (value === 'Faulted' || value === 'Cancelled') return 'faulted';
	return 'sent';
};
const materialState = (value: string): TwinSimulationMaterialState['state'] => {
	if (value === 'Reserved') return 'reserved';
	if (value === 'InTransit') return 'inTransit';
	if (value === 'Placed') return 'placed';
	if (value === 'Blocked') return 'blocked';
	return 'unknown';
};
const materialOwnerType = (value: string): TwinSimulationMaterialState['ownerType'] => {
	return ['route', 'slot', 'tool', 'buffer', 'external'].includes(value) ? value as TwinSimulationMaterialState['ownerType'] : 'external';
};
const poseSource = (value: string): TwinSimulationMaterialState['poseSource'] => {
	return ['telemetry', 'kinematic', 'interpolated'].includes(value) ? value as TwinSimulationMaterialState['poseSource'] : 'telemetry';
};

export class LiveFlowRuntimeClient {
	private readonly options: LiveFlowRuntimeClientOptions;
	private connection?: HubConnection;
	private run?: TwinActionFlowRun;
	private events: TwinActionFlowRuntimeEvent[] = [];
	private eventIds = new Set<string>();
	private connectionState: LiveConnectionState = 'disconnected';
	private refreshTimer?: number;
	private disposed = false;

	constructor(options: LiveFlowRuntimeClientOptions) { this.options = options; }

	get runId() { return this.run?.id; }
	getRunDetail() { return this.run ? structuredClone(this.run) : undefined; }
	getSnapshot(): LiveFlowRuntimeSnapshot | undefined { return this.run ? this.projectSnapshot() : undefined; }

	async start(input: Record<string, unknown> = {}) {
		this.ensureNotDisposed();
		this.connectionState = 'connecting';
		this.notify();
		const idempotencyKey = `designer-${this.options.persistedFlowId}-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
		this.run = apiData<TwinActionFlowRun>(await digitalTwinApi.startActionFlowRun(this.options.persistedFlowId, idempotencyKey, input));
		await this.connectAndRepair();
		await this.refreshRun();
		return this.getSnapshot();
	}

	async attach(runId: string) {
		this.ensureNotDisposed();
		this.run = apiData<TwinActionFlowRun>(await digitalTwinApi.getActionFlowRun(runId));
		this.events = [];
		this.eventIds.clear();
		await this.connectAndRepair();
		await this.refreshRun();
		return this.getSnapshot();
	}

	async pause(reason = '设计器实时调试暂停') { return this.control(() => digitalTwinApi.pauseActionFlowRun(this.requireRunId(), reason)); }
	async resume(reason = '设计器实时调试继续') { return this.control(() => digitalTwinApi.resumeActionFlowRun(this.requireRunId(), reason)); }
	async cancel(reason = '设计器实时调试停止') { return this.control(() => digitalTwinApi.cancelActionFlowRun(this.requireRunId(), reason)); }
	async retry(stepInstanceId: string, reason = '设计器人工重试') { return this.control(() => digitalTwinApi.retryActionFlowStep(this.requireRunId(), stepInstanceId, reason)); }
	async manualConfirm(stepInstanceId: string, reason: string, output: Record<string, unknown> = {}) { return this.control(() => digitalTwinApi.manualConfirmActionFlowRun(this.requireRunId(), stepInstanceId, reason, output)); }
	async signal(bindingId: string, value: unknown, cycleId?: string) { return this.control(() => digitalTwinApi.sendActionFlowSignal(this.requireRunId(), bindingId, value, cycleId)); }

	async repair() {
		if (!this.run) return;
		await this.syncEvents();
		await this.refreshRun();
	}

	async dispose() {
		this.disposed = true;
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		const connection = this.connection;
		this.connection = undefined;
		if (connection) {
			try { if (connection.state === HubConnectionState.Connected && this.run?.id) await connection.invoke('Unsubscribe', this.run.id); } catch { /* best effort */ }
			try { await connection.stop(); } catch { /* best effort */ }
		}
		this.connectionState = 'disconnected';
	}

	private async control(action: () => Promise<any>) {
		this.run = apiData<TwinActionFlowRun>(await action());
		await this.syncEvents();
		await this.refreshRun();
		return this.getSnapshot();
	}

	private async connectAndRepair() {
		if (!this.run) throw new Error('Live Run 尚未创建。');
		await this.syncEvents();
		if (!this.connection) this.connection = this.createConnection();
		if (this.connection.state === HubConnectionState.Disconnected) await this.connection.start();
		this.connectionState = 'connected';
		await this.connection.invoke('Subscribe', this.run.id);
		// Close the REST→Hub subscription race window.
		await this.syncEvents();
		this.notify();
	}

	private createConnection() {
		const configuredApi = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
		const serverBase = configuredApi.replace(/\/api$/i, '');
		const hubUrl = `${serverBase}/hubs/digital-twin/action-flows` || '/hubs/digital-twin/action-flows';
		const connection = new HubConnectionBuilder()
			.withUrl(hubUrl, { accessTokenFactory: () => String(Session.get('token') || '') })
			.withAutomaticReconnect([0, 1000, 3000, 10000])
			.configureLogging(LogLevel.Warning)
			.build();
		connection.on('runEvent', (event: TwinActionFlowEvent) => this.acceptServerEvent(event));
		connection.onreconnecting(() => { this.connectionState = 'reconnecting'; this.notify(); });
		connection.onreconnected(async () => {
			try {
				this.connectionState = 'connected';
				await this.syncEvents();
				if (this.run?.id) await connection.invoke('Subscribe', this.run.id);
				await this.syncEvents();
				await this.refreshRun();
			} catch (error) { this.options.onError?.(error); }
		});
		connection.onclose(() => { this.connectionState = 'disconnected'; this.notify(); });
		return connection;
	}

	private async syncEvents() {
		if (!this.run) return;
		let afterSequence = this.events.length ? Math.max(...this.events.map(item => item.sequence)) : 0;
		for (let page = 0; page < 20; page++) {
			const items = apiData<TwinActionFlowEvent[]>(await digitalTwinApi.getActionFlowRunEvents(this.run.id, afterSequence, 500));
			if (!items.length) break;
			for (const item of items) this.acceptServerEvent(item, false);
			afterSequence = Math.max(afterSequence, ...items.map(item => item.sequence));
			if (items.length < 500) break;
		}
		this.notify();
	}

	private acceptServerEvent(serverEvent: TwinActionFlowEvent, scheduleRefresh = true) {
		if (!this.run || serverEvent.runId !== this.run.id || this.eventIds.has(serverEvent.id)) return;
		this.eventIds.add(serverEvent.id);
		this.events.push({
			runId: serverEvent.runId,
			flowId: this.options.semanticFlowId,
			sequence: serverEvent.sequence,
			type: serverEvent.eventType,
			occurredAt: Date.parse(serverEvent.occurredAt) || Date.now(),
			correlationId: serverEvent.correlationId,
			nodeId: serverEvent.nodeId,
			stepInstanceId: serverEvent.stepInstanceId,
			payload: serverEvent.payload || {},
		});
		this.events.sort((a, b) => a.sequence - b.sequence);
		if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
		this.notify();
		if (scheduleRefresh) this.scheduleRefresh();
	}

	private scheduleRefresh() {
		if (this.refreshTimer !== undefined) return;
		this.refreshTimer = window.setTimeout(async () => {
			this.refreshTimer = undefined;
			try { await this.refreshRun(); } catch (error) { this.options.onError?.(error); }
		}, 80);
	}

	private async refreshRun() {
		if (!this.run) return;
		this.run = apiData<TwinActionFlowRun>(await digitalTwinApi.getActionFlowRun(this.run.id));
		this.notify();
	}

	private projectSnapshot(): LiveFlowRuntimeSnapshot {
		const run = this.run!;
		const latestStepByNode = new Map<string, TwinActionFlowRun['steps'][number]>();
		for (const step of run.steps || []) {
			const current = latestStepByNode.get(step.nodeId);
			if (!current || step.attempt > current.attempt || (step.attempt === current.attempt && String(step.startedAt || '') >= String(current.startedAt || ''))) latestStepByNode.set(step.nodeId, step);
		}
		const nodeStates: Record<string, TwinActionFlowStepState> = {};
		const activeNodeIds: string[] = [];
		for (const [nodeId, step] of latestStepByNode) {
			nodeStates[nodeId] = asStepState(step.status);
			if (step.status === 'Running' || step.status === 'Waiting' || step.status === 'Ready') activeNodeIds.push(nodeId);
		}
		const reservations: TwinSimulationReservationState[] = (run.reservations || [])
			.filter(item => item.status === 'Active')
			.map(item => ({ reservationId: item.reservationId, resourceType: item.resourceType as TwinSimulationReservationState['resourceType'], resourceId: item.resourceId, ownerTokenId: item.ownerRunId, leaseUntil: (Date.parse(item.leaseUntil) || 0) / 1000 }));
		const materials: TwinSimulationMaterialState[] = (run.materials || []).map(item => ({
			materialInstanceId: item.materialInstanceId, transportUnitId: item.transportUnitId, ownerType: materialOwnerType(item.ownerType), ownerId: item.ownerId,
			poseSource: poseSource(item.poseSource), state: materialState(item.status), revision: item.revision,
		}));
		const commands: TwinSimulationCommandState[] = (run.commands || []).map(item => ({
			commandId: item.commandId, nodeId: '', bindingId: item.bindingKey, status: commandStatus(item.status), correlationId: item.correlationId,
		}));
		const runtime = run.runtime || {};
		return {
			runId: run.id,
			flowId: this.options.semanticFlowId,
			persistedFlowId: this.options.persistedFlowId,
			state: asRunState(run.status),
			sequence: run.currentSequence,
			clockSeconds: run.startedAt ? Math.max(0, (Date.now() - Date.parse(run.startedAt)) / 1000) : 0,
			speed: 1,
			activeNodeIds,
			nodeStates,
			variables: (runtime.variables as Record<string, unknown>) || {},
			signals: (runtime.lastSignals as Record<string, unknown>) || {},
			reservations,
			materials,
			commands,
			events: [...this.events],
			fault: run.faultMessage || run.faultCode,
			connectionState: this.connectionState,
		};
	}

	private notify() { if (this.run) this.options.onChanged?.(this.projectSnapshot()); }
	private requireRunId() { if (!this.run?.id) throw new Error('Live Run 尚未创建。'); return this.run.id; }
	private ensureNotDisposed() { if (this.disposed) throw new Error('Live runtime client 已释放。'); }
}
