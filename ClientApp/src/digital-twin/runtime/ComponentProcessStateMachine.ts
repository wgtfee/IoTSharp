import type { TwinProcessDefinition } from '/@/digital-twin/contracts';

export type TwinComponentProcessState = 'Idle' | 'WaitingReady' | 'WaitingAck' | 'WaitingBusy' | 'Processing' | 'WaitingComplete' | 'Completed' | 'Fault';
export type TwinComponentProcessWaitingReason =
	| 'PROCESS_NOT_READY'
	| 'PROCESS_NOT_ACKNOWLEDGED'
	| 'PROCESS_NOT_BUSY'
	| 'PROCESS_NOT_COMPLETED'
	| 'PROCESS_SIGNAL_STALE'
	| 'PROCESS_TIMEOUT'
	| 'FAULT';

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
const sameCycle = (left: unknown, right: unknown) => left === right || String(left ?? '') === String(right ?? '');
const defaultLiveTimeoutSeconds = 300;

/** Simulation 与 Live 共用的标准工艺状态机；Live 信号 stale 时只能等待和报警，绝不假定完成。 */
export class ComponentProcessStateMachine {
	private state: TwinComponentProcessState = 'Idle';
	private elapsedSeconds = 0;
	private waitingReason?: TwinComponentProcessWaitingReason;
	private result?: unknown;
	private arrivalCompleteHigh = false;
	private completeLowObserved = false;
	private busyObserved = false;
	private arrivalCycleId?: unknown;

	constructor(private readonly definition: TwinProcessDefinition, private readonly dataMode: 'simulation' | 'live' = 'simulation') {}

	arrive(context: TwinComponentProcessSignalContext = {}) {
		this.state = 'WaitingReady';
		this.elapsedSeconds = 0;
		this.waitingReason = 'PROCESS_NOT_READY';
		this.result = undefined;
		const values = context.bindingValues || {};
		this.arrivalCompleteHigh = Boolean(this.definition.completeBindingId && signalIsTrue(values[this.definition.completeBindingId]));
		this.completeLowObserved = !this.arrivalCompleteHigh;
		this.busyObserved = false;
		this.arrivalCycleId = this.definition.cycleIdBindingId ? values[this.definition.cycleIdBindingId] : undefined;
		return this.getSnapshot();
	}

	update(deltaSeconds: number, context: TwinComponentProcessSignalContext = {}) {
		if (this.state === 'Idle' || this.state === 'Completed' || this.state === 'Fault') return this.getSnapshot();
		const values = context.bindingValues || {};
		const stale = new Set(context.staleBindingIds || []);
		this.elapsedSeconds += Math.max(0, deltaSeconds);
		if (this.isTimedOut()) {
			this.state = 'Fault';
			this.waitingReason = 'PROCESS_TIMEOUT';
			return this.getSnapshot();
		}
		if (this.requiredFreshBindingIds().some((bindingId) => stale.has(bindingId))) {
			this.waitingReason = 'PROCESS_SIGNAL_STALE';
			return this.getSnapshot();
		}
		if (this.definition.faultBindingId && signalIsTrue(values[this.definition.faultBindingId])) {
			this.state = 'Fault';
			this.waitingReason = 'FAULT';
			return this.getSnapshot();
		}

		if (this.dataMode === 'simulation') {
			this.state = 'Processing';
			this.waitingReason = undefined;
			if (this.elapsedSeconds >= Math.max(0.1, this.definition.cycleSeconds || 1)) this.complete(values);
			return this.getSnapshot();
		}

		if (this.definition.completeBindingId && !signalIsTrue(values[this.definition.completeBindingId])) this.completeLowObserved = true;
		if (this.definition.busyBindingId && signalIsTrue(values[this.definition.busyBindingId])) this.busyObserved = true;

		if (this.state === 'WaitingReady') {
			if (this.definition.readyBindingId && !signalIsTrue(values[this.definition.readyBindingId])) {
				this.waitingReason = 'PROCESS_NOT_READY';
				return this.getSnapshot();
			}
			this.enterPostReadyState(values);
		}

		if (this.state === 'WaitingAck') {
			if (this.definition.ackBindingId && !signalIsTrue(values[this.definition.ackBindingId])) {
				this.waitingReason = 'PROCESS_NOT_ACKNOWLEDGED';
				return this.getSnapshot();
			}
			this.enterPostAckState(values);
		}

		if (this.state === 'WaitingBusy') {
			if (this.definition.busyBindingId && !signalIsTrue(values[this.definition.busyBindingId])) {
				this.waitingReason = 'PROCESS_NOT_BUSY';
				return this.getSnapshot();
			}
			this.busyObserved = true;
			this.state = 'Processing';
			this.waitingReason = undefined;
		}

		if (this.state === 'Processing' || this.state === 'WaitingComplete') {
			if (this.requiredFreshBindingIds().some((bindingId) => stale.has(bindingId))) {
				this.state = 'WaitingComplete';
				this.waitingReason = 'PROCESS_SIGNAL_STALE';
				return this.getSnapshot();
			}
			if (this.isCompletionSatisfied(values)) {
				if (this.definition.resultBindingId && stale.has(this.definition.resultBindingId)) {
					this.state = 'WaitingComplete';
					this.waitingReason = 'PROCESS_SIGNAL_STALE';
					return this.getSnapshot();
				}
				this.complete(values);
			} else {
				this.state = 'WaitingComplete';
				this.waitingReason = 'PROCESS_NOT_COMPLETED';
			}
		}
		return this.getSnapshot();
	}

	reset() {
		this.state = 'Idle'; this.elapsedSeconds = 0; this.waitingReason = undefined; this.result = undefined;
		this.arrivalCompleteHigh = false; this.completeLowObserved = false; this.busyObserved = false; this.arrivalCycleId = undefined;
	}

	getSnapshot(): TwinComponentProcessSnapshot {
		return { state: this.state, elapsedSeconds: this.elapsedSeconds, canRelease: this.state === 'Completed', waitingReason: this.waitingReason, result: this.result };
	}

	private complete(values: Record<string, unknown>) {
		this.state = 'Completed';
		this.waitingReason = undefined;
		if (this.definition.resultBindingId) this.result = values[this.definition.resultBindingId];
	}

	private enterPostReadyState(values: Record<string, unknown>) {
		if (this.definition.ackBindingId && !signalIsTrue(values[this.definition.ackBindingId])) {
			this.state = 'WaitingAck';
			this.waitingReason = 'PROCESS_NOT_ACKNOWLEDGED';
			return;
		}
		this.enterPostAckState(values);
	}

	private enterPostAckState(values: Record<string, unknown>) {
		if (this.definition.busyBindingId && !signalIsTrue(values[this.definition.busyBindingId])) {
			this.state = 'WaitingBusy';
			this.waitingReason = 'PROCESS_NOT_BUSY';
			return;
		}
		if (this.definition.busyBindingId) this.busyObserved = true;
		this.state = 'Processing';
		this.waitingReason = undefined;
	}

	/** Live 完成必须属于本次到站周期，不能消费到站前已经为 true 的残留完成位。 */
	private isCompletionSatisfied(values: Record<string, unknown>) {
		const completeBindingId = this.definition.completeBindingId;
		if (!completeBindingId || !signalIsTrue(values[completeBindingId])) return false;
		if (this.definition.cycleIdBindingId) {
			const currentCycleId = values[this.definition.cycleIdBindingId];
			return currentCycleId !== undefined && !sameCycle(currentCycleId, this.arrivalCycleId);
		}
		if (this.definition.busyBindingId && !this.busyObserved) return false;
		return !this.arrivalCompleteHigh || this.completeLowObserved || this.busyObserved;
	}

	/** 只检查当前状态推进真正依赖的信号，避免尚未使用的 result 信号 stale 提前阻塞整个工艺。 */
	private requiredFreshBindingIds() {
		const ids = [this.definition.faultBindingId];
		if (this.state === 'WaitingReady') ids.push(this.definition.readyBindingId);
		if (this.state === 'WaitingAck') ids.push(this.definition.ackBindingId);
		if (this.state === 'WaitingBusy') ids.push(this.definition.busyBindingId);
		if (this.state === 'Processing' || this.state === 'WaitingComplete') {
			ids.push(this.definition.completeBindingId, this.definition.cycleIdBindingId);
		}
		return ids.filter((value): value is string => Boolean(value));
	}

	private isTimedOut() {
		const configured = Number(this.definition.timeoutSeconds);
		if (Number.isFinite(configured) && configured > 0) return this.elapsedSeconds > configured;
		return this.dataMode === 'live' && this.elapsedSeconds > defaultLiveTimeoutSeconds;
	}
}
