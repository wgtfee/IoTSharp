import type { TwinProcessDefinition } from '/@/digital-twin/contracts';

export type TwinComponentProcessState = 'Idle' | 'WaitingReady' | 'Processing' | 'WaitingComplete' | 'Completed' | 'Fault';
export type TwinComponentProcessWaitingReason = 'PROCESS_NOT_READY' | 'PROCESS_NOT_COMPLETED' | 'PROCESS_SIGNAL_STALE' | 'FAULT';

export interface TwinComponentProcessSignalContext {
	bindingValues?: Record<string, unknown>;
	staleBindingIds?: string[];
}

export interface TwinComponentProcessSnapshot {
	state: TwinComponentProcessState;
	elapsedSeconds: number;
	canRelease: boolean;
	waitingReason?: TwinComponentProcessWaitingReason;
	result?: unknown;
}

const signalIsTrue = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
const processBindingIds = (definition: TwinProcessDefinition) => [
	definition.readyBindingId,
	definition.busyBindingId,
	definition.completeBindingId,
	definition.resultBindingId,
	definition.faultBindingId,
].filter((value): value is string => Boolean(value));

/** Simulation 与 Live 共用的标准工艺状态机；Live 信号 stale 时只能等待和报警，绝不假定完成。 */
export class ComponentProcessStateMachine {
	private state: TwinComponentProcessState = 'Idle';
	private elapsedSeconds = 0;
	private waitingReason?: TwinComponentProcessWaitingReason;
	private result?: unknown;

	constructor(private readonly definition: TwinProcessDefinition, private readonly dataMode: 'simulation' | 'live' = 'simulation') {}

	arrive() {
		this.state = 'WaitingReady';
		this.elapsedSeconds = 0;
		this.waitingReason = 'PROCESS_NOT_READY';
		this.result = undefined;
		return this.getSnapshot();
	}

	update(deltaSeconds: number, context: TwinComponentProcessSignalContext = {}) {
		if (this.state === 'Idle' || this.state === 'Completed' || this.state === 'Fault') return this.getSnapshot();
		const values = context.bindingValues || {};
		const stale = new Set(context.staleBindingIds || []);
		if (processBindingIds(this.definition).some((bindingId) => stale.has(bindingId))) {
			this.waitingReason = 'PROCESS_SIGNAL_STALE';
			return this.getSnapshot();
		}
		if (this.definition.faultBindingId && signalIsTrue(values[this.definition.faultBindingId])) {
			this.state = 'Fault';
			this.waitingReason = 'FAULT';
			return this.getSnapshot();
		}

		if (this.state === 'WaitingReady') {
			if (this.dataMode === 'live' && this.definition.readyBindingId && !signalIsTrue(values[this.definition.readyBindingId])) {
				this.waitingReason = 'PROCESS_NOT_READY';
				return this.getSnapshot();
			}
			this.state = 'Processing';
			this.waitingReason = undefined;
		}

		if (this.state === 'Processing') {
			this.elapsedSeconds += Math.max(0, deltaSeconds);
			if (this.dataMode === 'simulation') {
				if (this.elapsedSeconds >= Math.max(0.1, this.definition.cycleSeconds || 1)) this.complete(values);
				return this.getSnapshot();
			}
			if (this.definition.completeBindingId && signalIsTrue(values[this.definition.completeBindingId])) this.complete(values);
			else {
				this.state = 'WaitingComplete';
				this.waitingReason = 'PROCESS_NOT_COMPLETED';
			}
			return this.getSnapshot();
		}

		if (this.state === 'WaitingComplete') {
			this.elapsedSeconds += Math.max(0, deltaSeconds);
			if (this.definition.completeBindingId && signalIsTrue(values[this.definition.completeBindingId])) this.complete(values);
			else this.waitingReason = 'PROCESS_NOT_COMPLETED';
		}
		return this.getSnapshot();
	}

	reset() {
		this.state = 'Idle'; this.elapsedSeconds = 0; this.waitingReason = undefined; this.result = undefined;
	}

	getSnapshot(): TwinComponentProcessSnapshot {
		return { state: this.state, elapsedSeconds: this.elapsedSeconds, canRelease: this.state === 'Completed', waitingReason: this.waitingReason, result: this.result };
	}

	private complete(values: Record<string, unknown>) {
		this.state = 'Completed';
		this.waitingReason = undefined;
		if (this.definition.resultBindingId) this.result = values[this.definition.resultBindingId];
	}
}
