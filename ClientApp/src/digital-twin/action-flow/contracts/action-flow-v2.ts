export const twinActionFlowContractVersion = '2.0' as const;

export type TwinActionFlowNodeType =
	| 'Start' | 'End' | 'Merge'
	| 'Condition' | 'Switch'
	| 'ParallelFork' | 'ParallelJoin'
	| 'MoveTo' | 'MovePose' | 'JointMove' | 'AxisMove' | 'Home'
	| 'GripOpen' | 'GripClose' | 'Attach' | 'Detach'
	| 'PrepareSlot' | 'ReserveSlot' | 'TransferMaterial' | 'ReleaseSlot'
	| 'ReserveSection' | 'EnterSection' | 'LeaveSection' | 'SelectRoute'
	| 'WaitSignal' | 'WriteCommand' | 'WaitAck'
	| 'Delay' | 'Deadline'
	| 'Subflow'
	| 'ManualConfirm' | 'RaiseAlarm' | 'Compensate';

export type TwinActionFlowPort = 'success' | 'failure' | 'timeout' | 'true' | 'false' | string;
export type TwinPredicateOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'changed' | 'risingEdge' | 'truthy' | 'falsy';
export type TwinPredicateSource = 'binding' | 'variable' | 'material' | 'runtime';

export interface TwinPredicateDefinition {
	source: TwinPredicateSource;
	ref: string;
	operator: TwinPredicateOperator;
	value?: string | number | boolean | Array<string | number> | null;
}

export interface TwinPredicateGroup {
	logic: 'and' | 'or';
	items: Array<TwinPredicateGroup | TwinPredicateDefinition>;
}

export interface TwinFlowVariableDefinition {
	name: string;
	type: 'string' | 'number' | 'boolean' | 'json';
	initialValue?: unknown;
	required?: boolean;
}

export interface TwinRetryPolicy {
	maxAttempts: number;
	backoffSeconds?: number;
	backoffMultiplier?: number;
	retryableErrors?: string[];
}

export interface TwinTimeoutPolicy {
	seconds: number;
	onTimeout: 'fault' | 'retry' | 'compensate' | 'manualConfirm' | 'skip';
	targetNodeId?: string;
}

export interface TwinActionFlowPolicies {
	defaultTimeoutSeconds?: number;
	maxLoopIterations?: number;
	allowedRuntimeModes?: Array<'simulation' | 'live'>;
	requireInterlockForCommands?: boolean;
	selectionWeight?: number;
}

export interface TwinActionFlowNode {
	nodeId: string;
	type: TwinActionFlowNodeType;
	name: string;
	actorObjectId?: string;
	config: Record<string, unknown>;
	retryPolicy?: TwinRetryPolicy;
	timeoutPolicy?: TwinTimeoutPolicy;
	compensationNodeId?: string;
	editor?: { x: number; y: number; collapsed?: boolean; group?: string };
}

export interface TwinActionFlowEdge {
	edgeId: string;
	sourceNodeId: string;
	sourcePort: TwinActionFlowPort;
	targetNodeId: string;
	priority?: number;
	isDefault?: boolean;
	predicate?: TwinPredicateGroup;
}

export interface TwinActionFlowDefinitionV2 {
	flowId: string;
	key: string;
	name: string;
	contractVersion: typeof twinActionFlowContractVersion;
	actorObjectIds: string[];
	variables: TwinFlowVariableDefinition[];
	nodes: TwinActionFlowNode[];
	edges: TwinActionFlowEdge[];
	policies: TwinActionFlowPolicies;
	enabled: boolean;
	revision: number;
	status?: 'Draft' | 'Validated' | 'Published' | 'Retired';
	graphHash?: string;
	compiledPlanHash?: string;
	legacyBehaviorId?: string;
}

export interface TwinActionFlowDiagnostic {
	code: string;
	severity: 'error' | 'warning' | 'info';
	message: string;
	flowId?: string;
	nodeId?: string;
	edgeId?: string;
	propertyPath?: string;
	suggestion?: string;
}

export interface TwinCompiledActionFlowPlan {
	flowId: string;
	key: string;
	name: string;
	contractVersion: typeof twinActionFlowContractVersion;
	revision: number;
	entryNodeId: string;
	nodes: TwinActionFlowNode[];
	edges: TwinActionFlowEdge[];
	policies: Required<Pick<TwinActionFlowPolicies, 'defaultTimeoutSeconds' | 'maxLoopIterations' | 'requireInterlockForCommands'>> & TwinActionFlowPolicies;
	graphHash: string;
	compiledPlanHash: string;
}

export type TwinActionFlowRunState = 'Created' | 'Ready' | 'Running' | 'WaitingSignal' | 'WaitingResource' | 'Paused' | 'Recovering' | 'Completed' | 'Faulted' | 'Cancelled';
export type TwinActionFlowStepState = 'Pending' | 'Ready' | 'Running' | 'Waiting' | 'Succeeded' | 'Failed' | 'Compensating' | 'Compensated' | 'Skipped';

export interface TwinActionFlowRuntimeEvent {
	runId: string;
	flowId: string;
	sequence: number;
	type: string;
	occurredAt: number;
	correlationId: string;
	nodeId?: string;
	stepInstanceId?: string;
	payload?: Record<string, unknown>;
}

export interface TwinSimulationCommandState {
	commandId: string;
	nodeId: string;
	bindingId?: string;
	payload?: Record<string, unknown>;
	status: 'sent' | 'acknowledged' | 'completed' | 'faulted';
	correlationId: string;
}

export interface TwinSimulationReservationState {
	reservationId: string;
	resourceType: 'actor' | 'slot' | 'section' | 'material';
	resourceId: string;
	ownerTokenId: string;
	leaseUntil: number;
}

export interface TwinSimulationMaterialState {
	materialInstanceId: string;
	transportUnitId?: string;
	ownerType: 'route' | 'slot' | 'tool' | 'buffer' | 'external';
	ownerId: string;
	poseSource: 'telemetry' | 'kinematic' | 'interpolated';
	state: 'reserved' | 'inTransit' | 'placed' | 'blocked' | 'unknown';
	revision: number;
}

export interface TwinActionFlowProjection {
	runId?: string;
	state: TwinActionFlowRunState;
	sequence: number;
	activeNodeIds: string[];
	nodeStates: Record<string, TwinActionFlowStepState>;
	waitingReasons: Record<string, string>;
	commands: Record<string, TwinSimulationCommandState>;
	reservations: Record<string, TwinSimulationReservationState>;
	materials: Record<string, TwinSimulationMaterialState>;
	alarms: Array<{ nodeId?: string; code?: string; message: string; occurredAt: number }>;
}

export const actionFlowNodeTypes: TwinActionFlowNodeType[] = [
	'Start', 'End', 'Merge', 'Condition', 'Switch', 'ParallelFork', 'ParallelJoin',
	'MoveTo', 'MovePose', 'JointMove', 'AxisMove', 'Home', 'GripOpen', 'GripClose', 'Attach', 'Detach',
	'PrepareSlot', 'ReserveSlot', 'TransferMaterial', 'ReleaseSlot', 'ReserveSection', 'EnterSection', 'LeaveSection', 'SelectRoute',
	'WaitSignal', 'WriteCommand', 'WaitAck', 'Delay', 'Deadline', 'Subflow', 'ManualConfirm', 'RaiseAlarm', 'Compensate',
];

export const blockingActionFlowNodeTypes = new Set<TwinActionFlowNodeType>([
	'ReserveSlot', 'ReserveSection', 'WaitSignal', 'WaitAck', 'ManualConfirm', 'Deadline', 'WriteCommand',
]);
