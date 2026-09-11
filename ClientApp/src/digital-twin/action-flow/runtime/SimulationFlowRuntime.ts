import {
	type TwinActionFlowNode,
	type TwinActionFlowRuntimeEvent,
	type TwinActionFlowRunState,
	type TwinActionFlowStepState,
	type TwinCompiledActionFlowPlan,
	type TwinPredicateDefinition,
	type TwinPredicateGroup,
	type TwinSimulationCommandState,
	type TwinSimulationMaterialState,
	type TwinSimulationReservationState,
} from '../contracts/action-flow-v2';

interface TokenState {
	tokenId: string;
	nodeId: string;
	stepState: TwinActionFlowStepState;
	elapsed: number;
	attempt: number;
	readyAt: number;
	parallelStack: string[];
	loopCounts: Record<string, number>;
	started: boolean;
}

export interface SimulationFlowRuntimeOptions {
	runId?: string;
	signals?: Record<string, unknown>;
	runtimeValues?: Record<string, unknown>;
	materials?: TwinSimulationMaterialState[];
	onEvent?: (event: TwinActionFlowRuntimeEvent) => void;
}

export interface SimulationFlowRuntimeSnapshot {
	runId: string;
	flowId: string;
	state: TwinActionFlowRunState;
	sequence: number;
	clockSeconds: number;
	speed: number;
	activeNodeIds: string[];
	nodeStates: Record<string, TwinActionFlowStepState>;
	variables: Record<string, unknown>;
	signals: Record<string, unknown>;
	reservations: TwinSimulationReservationState[];
	materials: TwinSimulationMaterialState[];
	commands: TwinSimulationCommandState[];
	events: TwinActionFlowRuntimeEvent[];
	fault?: string;
}

const actionNodes = new Set(['MoveTo', 'MovePose', 'JointMove', 'AxisMove', 'Home', 'GripOpen', 'GripClose', 'Attach', 'Detach', 'PrepareSlot', 'EnterSection', 'SelectRoute', 'Subflow', 'Compensate']);
const actorLockNodes = new Set(['MoveTo', 'MovePose', 'JointMove', 'AxisMove', 'Home', 'GripOpen', 'GripClose', 'Attach', 'Detach', 'WriteCommand']);

const createRunId = () => `sim-run-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const asNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const boolValue = (value: unknown) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';

export class SimulationFlowRuntime {
	private readonly nodeMap = new Map<string, TwinActionFlowNode>();
	private readonly tokens = new Map<string, TokenState>();
	private readonly nodeStates = new Map<string, TwinActionFlowStepState>();
	private readonly events: TwinActionFlowRuntimeEvent[] = [];
	private readonly reservations = new Map<string, TwinSimulationReservationState>();
	private readonly materials = new Map<string, TwinSimulationMaterialState>();
	private readonly commands = new Map<string, TwinSimulationCommandState>();
	private readonly manualConfirmations = new Map<string, string>();
	private readonly joinArrivals = new Map<string, Set<string>>();
	private readonly breakpoints = new Set<string>();
	private readonly variables: Record<string, unknown> = {};
	private readonly signals: Record<string, unknown>;
	private readonly runtimeValues: Record<string, unknown>;
	private runId: string;
	private state: TwinActionFlowRunState = 'Created';
	private sequence = 0;
	private clockSeconds = 0;
	private speed = 1;
	private tokenSequence = 0;
	private fault?: string;
	private breakpointBypassNodeId?: string;

	constructor(private readonly plan: TwinCompiledActionFlowPlan, private readonly options: SimulationFlowRuntimeOptions = {}) {
		this.runId = options.runId || createRunId();
		this.signals = { ...(options.signals || {}) };
		this.runtimeValues = { ...(options.runtimeValues || {}) };
		for (const node of plan.nodes) { this.nodeMap.set(node.nodeId, node); this.nodeStates.set(node.nodeId, 'Pending'); }
		for (const material of options.materials || []) this.materials.set(material.materialInstanceId, structuredClone(material));
	}

	start(input: Record<string, unknown> = {}) {
		if (!['Created', 'Ready'].includes(this.state)) return;
		this.state = 'Running';
		for (const [key, value] of Object.entries(input)) this.variables[key] = value;
		this.emit('RunStarted', undefined, { graphHash: this.plan.graphHash, compiledPlanHash: this.plan.compiledPlanHash });
		this.spawnToken(this.plan.entryNodeId, []);
	}

	pause() { if (this.state === 'Running' || this.state === 'WaitingSignal' || this.state === 'WaitingResource') { this.state = 'Paused'; this.emit('RunPaused'); } }
	resume() { if (this.state === 'Paused' || this.state === 'Recovering') { this.state = 'Running'; this.emit('RunResumed'); } }
	cancel(reason = 'simulation-cancelled') { if (!['Completed', 'Faulted', 'Cancelled'].includes(this.state)) { this.state = 'Cancelled'; this.emit('RunCancelled', undefined, { reason }); this.tokens.clear(); this.releaseAllReservations(); } }
	reset() {
		this.tokens.clear(); this.events.splice(0); this.reservations.clear(); this.commands.clear(); this.manualConfirmations.clear(); this.joinArrivals.clear();
		this.sequence = 0; this.clockSeconds = 0; this.tokenSequence = 0; this.fault = undefined; this.state = 'Created';
		for (const key of Object.keys(this.variables)) delete this.variables[key];
		for (const key of this.nodeStates.keys()) this.nodeStates.set(key, 'Pending');
	}
	setSpeed(value: number) { this.speed = Math.max(0.05, Math.min(20, Number(value) || 1)); }
	setSignal(bindingId: string, value: unknown) { this.signals[bindingId] = value; this.emit('SignalInjected', undefined, { bindingId, value }); }
	setSignals(values: Record<string, unknown>) { Object.assign(this.signals, values); }
	setRuntimeValue(key: string, value: unknown) { this.runtimeValues[key] = value; }
	setBreakpoint(nodeId: string, enabled = true) { if (enabled) this.breakpoints.add(nodeId); else this.breakpoints.delete(nodeId); }
	clearBreakpoints() { this.breakpoints.clear(); }
	confirmManual(nodeId: string, reason: string) { this.manualConfirmations.set(nodeId, reason || 'confirmed'); this.emit('ManualConfirmed', nodeId, { reason: reason || 'confirmed' }); }
	acknowledgeCommand(commandId: string) { const command = this.commands.get(commandId); if (command) { command.status = 'acknowledged'; this.emit('CommandAcknowledged', command.nodeId, { commandId }); } }
	completeCommand(commandId: string) { const command = this.commands.get(commandId); if (command) { command.status = 'completed'; this.emit('CommandCompleted', command.nodeId, { commandId }); } }

	step(deltaSeconds = 0.1) {
		if (this.state === 'Paused') {
			const first = [...this.tokens.values()].sort((a, b) => a.tokenId.localeCompare(b.tokenId))[0];
			this.breakpointBypassNodeId = first?.nodeId;
			this.state = 'Running';
			this.tick(deltaSeconds);
			if (this.state === 'Running' || this.state === 'WaitingSignal' || this.state === 'WaitingResource') this.state = 'Paused';
			this.breakpointBypassNodeId = undefined;
			return;
		}
		this.tick(deltaSeconds);
	}

	tick(deltaSeconds: number) {
		if (!['Running', 'WaitingSignal', 'WaitingResource'].includes(this.state)) return;
		if (!this.tokens.size) { this.finishIfPossible(); return; }
		const delta = Math.max(0, Math.min(1, deltaSeconds || 0)) * this.speed;
		this.clockSeconds += delta;
		this.expireReservations();
		let waitingSignal = false;
		let waitingResource = false;
		const ordered = [...this.tokens.values()].sort((a, b) => a.tokenId.localeCompare(b.tokenId));
		for (const token of ordered) {
			if (!this.tokens.has(token.tokenId)) continue;
			const node = this.nodeMap.get(token.nodeId);
			if (!node) { this.failToken(token, `Node ${token.nodeId} does not exist`); continue; }
			if (this.breakpoints.has(node.nodeId) && this.breakpointBypassNodeId !== node.nodeId && !token.started) {
				this.state = 'Paused'; this.emit('BreakpointHit', node.nodeId); return;
			}
			if (token.readyAt > this.clockSeconds) { token.stepState = 'Waiting'; waitingResource = true; continue; }
			const result = this.executeToken(token, node, delta);
			if (result === 'waiting-signal') waitingSignal = true;
			if (result === 'waiting-resource') waitingResource = true;
			if (this.state === 'Faulted' || this.state === 'Paused') return;
		}
		if (!this.tokens.size) this.finishIfPossible();
		else if (waitingResource) this.state = 'WaitingResource';
		else if (waitingSignal) this.state = 'WaitingSignal';
		else this.state = 'Running';
	}

	getSnapshot(): SimulationFlowRuntimeSnapshot {
		return {
			runId: this.runId, flowId: this.plan.flowId, state: this.state, sequence: this.sequence, clockSeconds: this.clockSeconds, speed: this.speed,
			activeNodeIds: [...new Set([...this.tokens.values()].map((item) => item.nodeId))],
			nodeStates: Object.fromEntries(this.nodeStates), variables: structuredClone(this.variables), signals: structuredClone(this.signals),
			reservations: [...this.reservations.values()].map((item) => structuredClone(item)), materials: [...this.materials.values()].map((item) => structuredClone(item)),
			commands: [...this.commands.values()].map((item) => structuredClone(item)), events: this.events.map((item) => structuredClone(item)), fault: this.fault,
		};
	}

	private executeToken(token: TokenState, node: TwinActionFlowNode, delta: number): 'progress' | 'waiting-signal' | 'waiting-resource' {
		if (!token.started) {
			token.started = true; token.stepState = 'Running'; token.elapsed = 0; this.nodeStates.set(node.nodeId, 'Running');
			this.emit('StepStarted', node.nodeId, { tokenId: token.tokenId, attempt: token.attempt }, token);
		}
		token.elapsed += delta;
		const timeout = asNumber(node.timeoutPolicy?.seconds, asNumber(this.plan.policies.defaultTimeoutSeconds, 300));
		if (timeout > 0 && token.elapsed >= timeout && !['Start', 'End', 'Merge', 'Condition', 'Switch', 'ParallelFork', 'ParallelJoin'].includes(node.type)) {
			this.handleTimeout(token, node); return 'progress';
		}
		if (actorLockNodes.has(node.type) && node.actorObjectId && !this.reserve(token, 'actor', node.actorObjectId, timeout)) {
			this.markWaiting(token, node, 'RESOURCE_ACTOR_BUSY'); return 'waiting-resource';
		}
		switch (node.type) {
			case 'Start': case 'Merge': return this.succeedToken(token, node);
			case 'End': this.succeedToken(token, node, false); this.tokens.delete(token.tokenId); this.finishIfPossible(); return 'progress';
			case 'Condition': {
				const predicate = node.config?.predicate as TwinPredicateGroup | undefined;
				const port = this.evaluatePredicateGroup(predicate) ? 'true' : 'false';
				return this.succeedToken(token, node, true, port);
			}
			case 'Switch': {
				if (node.config?.legacyLoop === true) {
					const count = (token.loopCounts[node.nodeId] || 0) + 1; token.loopCounts[node.nodeId] = count; this.variables.__loopCount = count;
					const max = Math.min(this.plan.policies.maxLoopIterations, Math.max(1, asNumber(node.config.maxIterations, this.plan.policies.maxLoopIterations)));
					return this.succeedToken(token, node, true, count < max ? 'true' : 'false');
				}
				const edge = this.chooseSwitchEdge(node.nodeId);
				return this.succeedToken(token, node, true, edge?.sourcePort || 'success', edge?.edgeId);
			}
			case 'ParallelFork': this.completeStep(token, node); this.forkToken(token, node); return 'progress';
			case 'ParallelJoin': return this.joinToken(token, node);
			case 'Delay': {
				const duration = Math.max(0, asNumber(node.config.durationSeconds, 0));
				if (token.elapsed < duration) { this.markWaiting(token, node, 'DELAY'); return 'waiting-signal'; }
				return this.succeedToken(token, node);
			}
			case 'Deadline': {
				const duration = Math.max(0.001, asNumber(node.config.seconds, timeout));
				if (token.elapsed < duration) { this.markWaiting(token, node, 'DEADLINE'); return 'waiting-signal'; }
				this.handleTimeout(token, node); return 'progress';
			}
			case 'WaitSignal': case 'WaitAck': {
				const bindingId = String(node.config.bindingId || '');
				if (!this.signalSatisfied(bindingId, node.config.operator, node.config.value)) { this.markWaiting(token, node, node.type === 'WaitAck' ? 'WAITING_ACK' : 'WAITING_SIGNAL'); return 'waiting-signal'; }
				return this.succeedToken(token, node);
			}
			case 'WriteCommand': {
				const commandId = String(node.config.commandId || `cmd-${this.runId}-${node.nodeId}-${token.attempt}`);
				if (!this.commands.has(commandId)) {
					const command: TwinSimulationCommandState = { commandId, nodeId: node.nodeId, bindingId: String(node.config.bindingId || '') || undefined, payload: structuredClone((node.config.payload as Record<string, unknown>) || {}), status: 'sent', correlationId: `${this.runId}:${node.nodeId}:${token.attempt}` };
					this.commands.set(commandId, command); this.variables.lastCommandId = commandId; this.emit('CommandSent', node.nodeId, { commandId, bindingId: command.bindingId, payload: command.payload }, token);
					if (node.config.simulationAutoAck !== false) { command.status = 'acknowledged'; this.emit('CommandAcknowledged', node.nodeId, { commandId }, token); }
				}
				return this.succeedToken(token, node);
			}
			case 'ReserveSlot': {
				const id = this.resolveString(node.config.slotId); if (!id || !this.reserve(token, 'slot', id, timeout)) { this.markWaiting(token, node, 'SLOT_RESERVED'); return 'waiting-resource'; }
				return this.succeedToken(token, node);
			}
			case 'ReserveSection': {
				const id = this.resolveString(node.config.sectionId || node.config.routeId); if (!id || !this.reserve(token, 'section', id, timeout)) { this.markWaiting(token, node, 'SECTION_RESERVED'); return 'waiting-resource'; }
				return this.succeedToken(token, node);
			}
			case 'ReleaseSlot': { const id = this.resolveString(node.config.slotId); if (id) this.releaseResource('slot', id, token.tokenId); return this.succeedToken(token, node); }
			case 'LeaveSection': { const id = this.resolveString(node.config.sectionId || node.config.routeId); if (id) this.releaseResource('section', id, token.tokenId); return this.succeedToken(token, node); }
			case 'TransferMaterial': {
				const materialId = this.resolveString(node.config.materialInstanceId || node.config.materialVariable || '');
				if (!materialId) return this.failToken(token, 'TransferMaterial 缺少 materialInstanceId');
				const current = this.materials.get(materialId) || { materialInstanceId: materialId, ownerType: 'external' as const, ownerId: '', poseSource: 'kinematic' as const, state: 'unknown' as const, revision: 0 };
				current.ownerType = (String(node.config.ownerType || 'slot') as TwinSimulationMaterialState['ownerType']); current.ownerId = this.resolveString(node.config.ownerId); current.state = (String(node.config.state || 'placed') as TwinSimulationMaterialState['state']); current.revision += 1;
				if (node.config.transportUnitId) current.transportUnitId = this.resolveString(node.config.transportUnitId);
				this.materials.set(materialId, current); this.emit('MaterialTransferred', node.nodeId, { material: structuredClone(current) }, token); return this.succeedToken(token, node);
			}
			case 'ManualConfirm': {
				if (!this.manualConfirmations.has(node.nodeId)) { this.markWaiting(token, node, 'MANUAL_CONFIRM_REQUIRED'); return 'waiting-signal'; }
				return this.succeedToken(token, node);
			}
			case 'RaiseAlarm': this.emit('AlarmRaised', node.nodeId, { code: node.config.code, message: String(node.config.message || node.name) }, token); return node.config.failFlow === true ? this.failToken(token, String(node.config.message || 'Alarm')) : this.succeedToken(token, node);
			default: {
				const duration = Math.max(0, asNumber(node.config.durationSeconds, actionNodes.has(node.type) ? 0.1 : 0));
				if (token.elapsed < duration) return 'progress';
				return this.succeedToken(token, node);
			}
		}
	}

	private succeedToken(token: TokenState, node: TwinActionFlowNode, transition = true, port = 'success', preferredEdgeId?: string): 'progress' {
		this.completeStep(token, node);
		if (actorLockNodes.has(node.type) && node.actorObjectId) this.releaseResource('actor', node.actorObjectId, token.tokenId);
		if (transition) this.transition(token, node.nodeId, port, preferredEdgeId);
		return 'progress';
	}

	private failToken(token: TokenState, message: string): 'progress' {
		const node = this.nodeMap.get(token.nodeId);
		if (!node) { this.faultFlow(message); return 'progress'; }
		this.nodeStates.set(node.nodeId, 'Failed'); token.stepState = 'Failed'; this.emit('StepFailed', node.nodeId, { message, attempt: token.attempt }, token);
		if (node.actorObjectId) this.releaseResource('actor', node.actorObjectId, token.tokenId);
		const maxAttempts = Math.max(1, Math.floor(asNumber(node.retryPolicy?.maxAttempts, 1)));
		if (token.attempt < maxAttempts) {
			token.attempt += 1; token.started = false; token.elapsed = 0; token.stepState = 'Ready';
			const base = Math.max(0, asNumber(node.retryPolicy?.backoffSeconds, 0)); const multiplier = Math.max(1, asNumber(node.retryPolicy?.backoffMultiplier, 1)); token.readyAt = this.clockSeconds + base * Math.pow(multiplier, token.attempt - 2);
			this.emit('StepRetryScheduled', node.nodeId, { attempt: token.attempt, readyAt: token.readyAt }, token); return 'progress';
		}
		if (node.compensationNodeId) { token.nodeId = node.compensationNodeId; token.started = false; token.elapsed = 0; token.attempt = 1; this.nodeStates.set(node.compensationNodeId, 'Compensating'); return 'progress'; }
		const failureEdge = this.outgoing(node.nodeId).find((edge) => edge.sourcePort === 'failure');
		if (failureEdge) { token.nodeId = failureEdge.targetNodeId; token.started = false; token.elapsed = 0; token.attempt = 1; return 'progress'; }
		this.faultFlow(message); return 'progress';
	}

	private handleTimeout(token: TokenState, node: TwinActionFlowNode) {
		this.emit('StepTimedOut', node.nodeId, { elapsed: token.elapsed }, token);
		const policy = node.timeoutPolicy || { seconds: this.plan.policies.defaultTimeoutSeconds, onTimeout: 'fault' as const };
		switch (policy.onTimeout) {
			case 'retry': this.failToken(token, 'TIMEOUT'); break;
			case 'skip': this.completeStep(token, node, 'Skipped'); this.transition(token, node.nodeId, 'success'); break;
			case 'compensate': if (node.compensationNodeId || policy.targetNodeId) { token.nodeId = node.compensationNodeId || policy.targetNodeId!; token.started = false; token.elapsed = 0; } else this.faultFlow('TIMEOUT_NO_COMPENSATION'); break;
			case 'manualConfirm': if (policy.targetNodeId) { token.nodeId = policy.targetNodeId; token.started = false; token.elapsed = 0; } else { token.stepState = 'Waiting'; this.nodeStates.set(node.nodeId, 'Waiting'); this.state = 'WaitingSignal'; } break;
			default: { const timeoutEdge = this.outgoing(node.nodeId).find((edge) => edge.sourcePort === 'timeout'); if (timeoutEdge) { token.nodeId = timeoutEdge.targetNodeId; token.started = false; token.elapsed = 0; } else this.faultFlow('TIMEOUT'); }
		}
	}

	private completeStep(token: TokenState, node: TwinActionFlowNode, state: TwinActionFlowStepState = 'Succeeded') {
		token.stepState = state; this.nodeStates.set(node.nodeId, state); this.emit(state === 'Skipped' ? 'StepSkipped' : 'StepSucceeded', node.nodeId, { tokenId: token.tokenId, attempt: token.attempt }, token);
	}
	private markWaiting(token: TokenState, node: TwinActionFlowNode, reason: string) { token.stepState = 'Waiting'; this.nodeStates.set(node.nodeId, 'Waiting'); this.emitOncePerWait(token, node, reason); }
	private emitOncePerWait(token: TokenState, node: TwinActionFlowNode, reason: string) { const marker = `${node.nodeId}:${reason}:${Math.floor(token.elapsed * 10)}`; if (this.runtimeValues.__lastWaitMarker !== marker) { this.runtimeValues.__lastWaitMarker = marker; this.emit('StepWaiting', node.nodeId, { reason }, token); } }

	private transition(token: TokenState, sourceNodeId: string, port: string, preferredEdgeId?: string) {
		const candidates = this.outgoing(sourceNodeId).filter((edge) => edge.sourcePort === port || (port === 'success' && edge.sourcePort === 'success'));
		let edge = preferredEdgeId ? candidates.find((item) => item.edgeId === preferredEdgeId) : undefined;
		if (!edge) edge = candidates.filter((item) => !item.predicate || this.evaluatePredicateGroup(item.predicate)).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.edgeId.localeCompare(b.edgeId))[0];
		if (!edge && port !== 'success') edge = this.outgoing(sourceNodeId).find((item) => item.isDefault);
		if (!edge) { this.tokens.delete(token.tokenId); this.finishIfPossible(); return; }
		token.nodeId = edge.targetNodeId; token.started = false; token.elapsed = 0; token.attempt = 1; token.readyAt = 0; token.stepState = 'Ready'; this.nodeStates.set(token.nodeId, 'Ready');
	}

	private forkToken(token: TokenState, node: TwinActionFlowNode) {
		const edges = this.outgoing(node.nodeId).filter((edge) => edge.sourcePort === 'success' || edge.isDefault).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.edgeId.localeCompare(b.edgeId));
		this.tokens.delete(token.tokenId);
		const groupId = `parallel:${token.tokenId}:${node.nodeId}:${this.sequence}`;
		for (const edge of edges) this.spawnToken(edge.targetNodeId, [...token.parallelStack, groupId], token.loopCounts);
	}

	private joinToken(token: TokenState, node: TwinActionFlowNode): 'progress' | 'waiting-resource' {
		const groupId = token.parallelStack[token.parallelStack.length - 1] || `ungrouped:${node.nodeId}`;
		const key = `${groupId}:${node.nodeId}`;
		const arrivals = this.joinArrivals.get(key) || new Set<string>(); arrivals.add(token.tokenId); this.joinArrivals.set(key, arrivals);
		token.stepState = 'Waiting'; this.nodeStates.set(node.nodeId, 'Waiting');
		const incomingCount = this.plan.edges.filter((edge) => edge.targetNodeId === node.nodeId).length;
		const strategy = String(node.config.strategy || 'all'); const quorum = Math.max(1, Math.floor(asNumber(node.config.quorum, incomingCount)));
		const required = strategy === 'any' ? 1 : strategy === 'quorum' ? Math.min(incomingCount, quorum) : incomingCount;
		if (arrivals.size < required) { this.markWaiting(token, node, 'PARALLEL_JOIN'); return 'waiting-resource'; }
		const arrivalTokens = [...arrivals].map((id) => this.tokens.get(id)).filter(Boolean) as TokenState[];
		for (const item of arrivalTokens) this.tokens.delete(item.tokenId);
		this.joinArrivals.delete(key); this.nodeStates.set(node.nodeId, 'Succeeded'); this.emit('StepSucceeded', node.nodeId, { joined: arrivals.size }, token);
		const next = this.spawnToken(node.nodeId, token.parallelStack.slice(0, -1), token.loopCounts); this.transition(next, node.nodeId, 'success'); return 'progress';
	}

	private reserve(token: TokenState, resourceType: TwinSimulationReservationState['resourceType'], resourceId: string, leaseSeconds: number) {
		const key = `${resourceType}:${resourceId}`; const current = this.reservations.get(key);
		if (current && current.ownerTokenId !== token.tokenId && current.leaseUntil > this.clockSeconds) return false;
		if (!current || current.ownerTokenId !== token.tokenId) {
			const reservation: TwinSimulationReservationState = { reservationId: `res-${this.runId}-${key}-${token.tokenId}`, resourceType, resourceId, ownerTokenId: token.tokenId, leaseUntil: this.clockSeconds + Math.max(1, leaseSeconds) };
			this.reservations.set(key, reservation); this.emit('ResourceReserved', token.nodeId, { reservation: structuredClone(reservation) }, token);
		} else current.leaseUntil = this.clockSeconds + Math.max(1, leaseSeconds);
		return true;
	}
	private releaseResource(resourceType: TwinSimulationReservationState['resourceType'], resourceId: string, ownerTokenId?: string) { const key = `${resourceType}:${resourceId}`; const current = this.reservations.get(key); if (current && (!ownerTokenId || current.ownerTokenId === ownerTokenId)) { this.reservations.delete(key); this.emit('ResourceReleased', undefined, { reservationId: current.reservationId, resourceType, resourceId }); } }
	private releaseAllReservations() { for (const item of [...this.reservations.values()]) this.releaseResource(item.resourceType, item.resourceId); }
	private expireReservations() { for (const [key, item] of [...this.reservations.entries()]) if (item.leaseUntil <= this.clockSeconds) { this.reservations.delete(key); this.emit('ResourceLeaseExpired', undefined, { reservationId: item.reservationId, resourceType: item.resourceType, resourceId: item.resourceId }); } }

	private signalSatisfied(bindingId: string, operator: unknown, expected: unknown) { const value = this.signals[bindingId]; switch (String(operator || 'truthy')) { case 'equals': case 'eq': return value === expected || String(value) === String(expected); case 'notEquals': case 'ne': return !(value === expected || String(value) === String(expected)); case 'falsy': return !boolValue(value); default: return boolValue(value); } }
	private resolveSource(source: TwinPredicateDefinition['source'], ref: string) { if (source === 'binding') return this.signals[ref]; if (source === 'variable') return this.variables[ref]; if (source === 'runtime') return this.runtimeValues[ref]; if (source === 'material') { const [materialId, ...path] = ref.split('.'); let value: unknown = this.materials.get(materialId); for (const segment of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined; return value; } return undefined; }
	private evaluatePredicate(predicate: TwinPredicateDefinition) {
		const left = this.resolveSource(predicate.source, predicate.ref); const right = predicate.value;
		switch (predicate.operator) {
			case 'eq': return left === right || String(left) === String(right); case 'ne': return !(left === right || String(left) === String(right));
			case 'gt': return Number(left) > Number(right); case 'gte': return Number(left) >= Number(right); case 'lt': return Number(left) < Number(right); case 'lte': return Number(left) <= Number(right);
			case 'in': return Array.isArray(right) && right.some((item) => item === left || String(item) === String(left)); case 'truthy': return boolValue(left); case 'falsy': return !boolValue(left);
			case 'changed': return left !== this.runtimeValues[`prev:${predicate.source}:${predicate.ref}`]; case 'risingEdge': return boolValue(left) && !boolValue(this.runtimeValues[`prev:${predicate.source}:${predicate.ref}`]); default: return false;
		}
	}
	private evaluatePredicateGroup(group?: TwinPredicateGroup): boolean { if (!group || !group.items?.length) return true; const values = group.items.map((item) => 'logic' in item ? this.evaluatePredicateGroup(item) : this.evaluatePredicate(item)); return group.logic === 'or' ? values.some(Boolean) : values.every(Boolean); }
	private chooseSwitchEdge(nodeId: string) { const edges = this.outgoing(nodeId).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.edgeId.localeCompare(b.edgeId)); return edges.find((edge) => edge.predicate && this.evaluatePredicateGroup(edge.predicate)) || edges.find((edge) => edge.isDefault) || edges[0]; }
	private resolveString(value: unknown) { const text = String(value ?? ''); if (text.startsWith('$')) return String(this.variables[text.slice(1)] ?? ''); return text; }
	private outgoing(nodeId: string) { return this.plan.edges.filter((edge) => edge.sourceNodeId === nodeId); }
	private spawnToken(nodeId: string, parallelStack: string[], loopCounts: Record<string, number> = {}) { const token: TokenState = { tokenId: `token-${++this.tokenSequence}`, nodeId, stepState: 'Ready', elapsed: 0, attempt: 1, readyAt: 0, parallelStack, loopCounts: { ...loopCounts }, started: false }; this.tokens.set(token.tokenId, token); this.nodeStates.set(nodeId, 'Ready'); return token; }
	private finishIfPossible() { if (this.tokens.size || ['Faulted', 'Cancelled'].includes(this.state)) return; this.state = 'Completed'; this.releaseAllReservations(); this.emit('RunCompleted'); }
	private faultFlow(message: string) { this.fault = message; this.state = 'Faulted'; this.releaseAllReservations(); this.emit('RunFaulted', undefined, { message }); this.tokens.clear(); }
	private emit(type: string, nodeId?: string, payload?: Record<string, unknown>, token?: TokenState) { const event: TwinActionFlowRuntimeEvent = { runId: this.runId, flowId: this.plan.flowId, sequence: ++this.sequence, type, occurredAt: Math.round(this.clockSeconds * 1000), correlationId: `${this.runId}:${nodeId || 'run'}:${this.sequence}`, nodeId, stepInstanceId: token ? `${this.runId}:${token.tokenId}:${nodeId}:${token.attempt}` : undefined, payload }; this.events.push(event); this.options.onEvent?.(event); }
}
