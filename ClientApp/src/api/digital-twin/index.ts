import request from '/@/utils/request';
import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import type { TwinComponentResourceRegistrationPayload } from '/@/digital-twin/components/ComponentResourceRegistration';
import type { TwinActionFlowDefinitionV2 } from '/@/digital-twin/action-flow/contracts/action-flow-v2';

export interface DigitalTwinSceneSummary {
	id: string;
	sceneKey: string;
	name: string;
	description: string;
	rootAssetId: string;
	rootAssetName: string;
	status: 'Draft' | 'Published' | 'Archived' | 'Orphaned';
	publishedVersionId?: string;
	publishedVersion?: number;
	publishedSourceRevision?: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface DigitalTwinSceneDetail extends DigitalTwinSceneSummary {
	draftPayload: TwinSceneManifest;
	bindings: TwinPersistedBinding[];
	routes: Array<{ id: string; routeKey: string; revision: number }>;
	actionFlows: TwinPersistedActionFlow[];
}

export interface TwinPersistedActionFlow {
	id: string;
	sceneId: string;
	sceneVersionId?: string;
	flowKey: string;
	name: string;
	contractVersion: string;
	actorScope: unknown;
	graphPayload: unknown;
	graphHash: string;
	compiledPayload: unknown;
	compiledPlanHash: string;
	revision: number;
	enabled: boolean;
}

export interface TwinActionFlowRunStep {
	id: string;
	stepInstanceId: string;
	nodeId: string;
	attempt: number;
	status: string;
	input: unknown;
	output: unknown;
	errorCode?: string;
	errorMessage?: string;
	deadlineAt?: string;
	startedAt?: string;
	endedAt?: string;
	lastSequence: number;
}

export interface TwinActionFlowDeviceCommand {
	id: string;
	commandId: string;
	correlationId: string;
	bindingKey: string;
	status: string;
	deviceCycleId?: string;
	sentAt?: string;
	acknowledgedAt?: string;
	busyAt?: string;
	completedAt?: string;
	lastError?: string;
}

export interface TwinActionFlowReservation {
	reservationId: string;
	resourceType: string;
	resourceId: string;
	ownerRunId: string;
	status: string;
	leaseUntil: string;
	revision: number;
}

export interface TwinActionFlowMaterialRuntime {
	materialInstanceId: string;
	transportUnitId?: string;
	materialType?: string;
	ownerType: string;
	ownerId: string;
	poseSource: string;
	status: string;
	revision: number;
	lastEventSequence: number;
}

export interface TwinActionFlowRun {
	id: string;
	sceneId: string;
	sceneVersionId: string;
	actionFlowId: string;
	flowKey: string;
	idempotencyKey: string;
	status: string;
	input: unknown;
	runtime: Record<string, unknown>;
	currentSequence: number;
	concurrencyVersion: number;
	graphHash: string;
	compiledPlanHash: string;
	faultCode?: string;
	faultMessage?: string;
	startedAt?: string;
	endedAt?: string;
	createdAt: string;
	updatedAt: string;
	steps: TwinActionFlowRunStep[];
	commands: TwinActionFlowDeviceCommand[];
	reservations: TwinActionFlowReservation[];
	materials: TwinActionFlowMaterialRuntime[];
}

export interface TwinActionFlowEvent {
	id: string;
	runId: string;
	sequence: number;
	eventType: string;
	nodeId?: string;
	stepInstanceId?: string;
	correlationId: string;
	source: string;
	payload: Record<string, unknown>;
	occurredAt: string;
}

export interface TwinBindingDeviceOption {
	id: string;
	name: string;
	assetRelated: boolean;
}

export interface TwinPersistedBinding {
	id: string;
	sceneId: string;
	sceneVersionId?: string;
	bindingKey: string;
	objectId: string;
	nodePath?: string;
	modelResourceId?: string;
	assetId?: string;
	deviceId?: string;
	semanticId?: string;
	sourceKind: string;
	sourceKey?: string;
	targetKind: string;
	targetPath?: string;
	transformKind: string;
	transformConfig: Record<string, unknown>;
	priority: number;
	staleAfterMs: number;
	enabled: boolean;
}

export interface TwinModelResource {
	id: string;
	resourceKey: string;
	name: string;
	sourceType: string;
	runtimeFormat: string;
	originalFileName: string;
	fileSize: number;
	contentHash: string;
	nodeIndex: { nodes?: Array<{ index: number; name: string; mesh?: number; children: number[] }> };
	modelMetadata: {
		nodeCount?: number;
		meshCount?: number;
		triangleCount?: number;
		materialCount?: number;
		textureCount?: number;
		animationCount?: number;
		resourceKey?: string;
		resourceType?: 'procedural-component' | 'smart-model';
		componentType?: string;
		generator?: string;
		generatorVersion?: number;
		category?: string;
		tags?: string[];
		capabilities?: string[];
		defaultProperties?: Record<string, unknown>;
		componentSchema?: { properties?: Array<Record<string, unknown>> };
		ports?: Array<Record<string, unknown>>;
		bindingSlots?: Array<Record<string, unknown>>;
	};
	processingStatus: string;
	license: {
		licenseType: string;
		licenseTextUrl?: string;
		sourceUrl?: string;
		author?: string;
		commercialUseAllowed: boolean;
	};
	createdAt: string;
	updatedAt: string;
}

export type TwinModelGenerationStatus = 'WaitingForWorker' | 'Queued' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled';

export interface TwinModelGenerationCapabilities {
	provider: string;
	configured: boolean;
	acceptsReferenceImage: boolean;
	acceptsTextOnly: boolean;
	outputFormat: string;
	maxReferenceImageMb: number;
	message: string;
}

export interface TwinModelGenerationJob {
	id: string;
	jobKey: string;
	name: string;
	provider: string;
	prompt: string;
	qualityProfile: string;
	animationReady: boolean;
	referenceImageName: string;
	referenceImageSize: number;
	status: TwinModelGenerationStatus;
	progress: number;
	stage: string;
	errorMessage: string;
	attemptCount: number;
	resultModelResourceId?: string;
	resultModelResource?: TwinModelResource;
	startedAt?: string;
	completedAt?: string;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
}

export interface TwinSceneVersion {
	id: string;
	sceneId: string;
	version: number;
	sourceDraftRevision: number;
	schemaVersion: string;
	manifestHash: string;
	changeSummary: string;
	validationReport: { valid: boolean; diagnostics: TwinValidationDiagnostic[] };
	manifest?: TwinSceneManifest;
	createdAt: string;
	createdBy: string;
	isCurrent: boolean;
}

export interface TwinDataUpdate {
	bindingId: string;
	bindingKey: string;
	objectId: string;
	deviceId?: string;
	kind: string;
	key: string;
	value: unknown;
	sourceTimestamp: string;
	quality: 'good' | 'stale' | 'missing' | 'bad';
	stale: boolean;
}

export interface TwinRuntimeSnapshot {
	sceneId: string;
	serverTimestamp: string;
	updates: TwinDataUpdate[];
}

export const digitalTwinApi = {
	listScenes: (params: { rootAssetId?: string; name?: string; status?: string } = {}) =>
		request({ url: '/api/digital-twin/scenes', method: 'get', params }),
	listBindingDevices: (rootAssetId: string) =>
		request({ url: '/api/digital-twin/scenes/binding-devices', method: 'get', params: { rootAssetId } }),
	getScene: (id: string) => request({ url: `/api/digital-twin/scenes/${id}`, method: 'get' }),
	createScene: (data: { sceneKey?: string; name: string; description?: string; rootAssetId: string; draftPayload?: TwinSceneManifest }) =>
		request({ url: '/api/digital-twin/scenes', method: 'post', data }),
	updateScene: (id: string, data: { name: string; description?: string; rootAssetId: string }) =>
		request({ url: `/api/digital-twin/scenes/${id}`, method: 'put', data }),
	saveDraft: (id: string, revision: number, payload: TwinSceneManifest) =>
		request({ url: `/api/digital-twin/scenes/${id}/draft`, method: 'put', data: { revision, name: payload.name, description: payload.description, rootAssetId: payload.rootAssetId, payload }, timeout: 120000 }),
	validateScene: (id: string, forPublish = false) =>
		request({ url: `/api/digital-twin/scenes/${id}/validate`, method: 'post', params: { forPublish }, timeout: 120000 }),
	publishScene: (id: string, revision: number, changeSummary: string) =>
		request({ url: `/api/digital-twin/scenes/${id}/publish`, method: 'post', data: { revision, changeSummary }, timeout: 120000 }),
	deleteScene: (id: string) => request({ url: `/api/digital-twin/scenes/${id}`, method: 'delete' }),
	listVersions: (id: string) => request({ url: `/api/digital-twin/scenes/${id}/versions`, method: 'get' }),
	getVersion: (id: string, version: number) => request({ url: `/api/digital-twin/scenes/${id}/versions/${version}`, method: 'get' }),
	rollback: (id: string, version: number) => request({ url: `/api/digital-twin/scenes/${id}/rollback/${version}`, method: 'post' }),

	listModels: (params: { name?: string; status?: string } = {}) =>
		request({ url: '/api/digital-twin/model-resources', method: 'get', params }),
	uploadModel: (data: FormData) =>
		request({ url: '/api/digital-twin/model-resources/upload', method: 'post', data, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 }),
	downloadModel: (id: string) =>
		request({ url: `/api/digital-twin/model-resources/${id}/content`, method: 'get', responseType: 'arraybuffer', timeout: 120000 }),
	updateModelLicense: (id: string, data: Record<string, unknown>) =>
		request({ url: `/api/digital-twin/model-resources/${id}/license`, method: 'put', data }),
	upsertComponentResource: (data: TwinComponentResourceRegistrationPayload) =>
		request({ url: '/api/digital-twin/model-resources/components/upsert', method: 'post', data }),
	registerComponentResources: (data: TwinComponentResourceRegistrationPayload[]) =>
		request({ url: '/api/digital-twin/model-resources/components/batch', method: 'post', data }),

	modelGenerationCapabilities: () => request({ url: '/api/digital-twin/model-generation/capabilities', method: 'get' }),
	listModelGenerationJobs: () => request({ url: '/api/digital-twin/model-generation/jobs', method: 'get' }),
	createModelGenerationJob: (data: FormData) =>
		request({ url: '/api/digital-twin/model-generation/jobs', method: 'post', data, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 }),
	getModelGenerationReference: (id: string) =>
		request({ url: `/api/digital-twin/model-generation/jobs/${id}/reference`, method: 'get', responseType: 'blob' }),
	cancelModelGenerationJob: (id: string) => request({ url: `/api/digital-twin/model-generation/jobs/${id}/cancel`, method: 'post' }),
	retryModelGenerationJob: (id: string) => request({ url: `/api/digital-twin/model-generation/jobs/${id}/retry`, method: 'post' }),

	snapshot: (sceneId: string, version?: number, sinceTimestamp?: string) =>
		request({ url: '/api/digital-twin/runtime/snapshot', method: 'post', data: { sceneId, version, sinceTimestamp } }),

	validateActionFlow: (sceneId: string, flow: TwinActionFlowDefinitionV2) =>
		request({ url: '/api/digital-twin/action-flows/validate', method: 'post', data: { sceneId, flow } }),
	compileActionFlow: (sceneId: string, flow: TwinActionFlowDefinitionV2) =>
		request({ url: '/api/digital-twin/action-flows/compile', method: 'post', data: { sceneId, flow } }),
	getActionFlow: (flowId: string) => request({ url: `/api/digital-twin/action-flows/${flowId}`, method: 'get' }),
	startActionFlowRun: (flowId: string, idempotencyKey: string, input: Record<string, unknown> = {}) =>
		request({ url: `/api/digital-twin/action-flows/${flowId}/runs`, method: 'post', data: { idempotencyKey, runtimeMode: 'live', input } }),
	getActionFlowRun: (runId: string) => request({ url: `/api/digital-twin/action-flows/runs/${runId}`, method: 'get' }),
	getActionFlowRunEvents: (runId: string, afterSequence = 0, take = 500) =>
		request({ url: `/api/digital-twin/action-flows/runs/${runId}/events`, method: 'get', params: { afterSequence, take } }),
	pauseActionFlowRun: (runId: string, reason = '') => request({ url: `/api/digital-twin/action-flows/runs/${runId}/pause`, method: 'post', data: { reason } }),
	resumeActionFlowRun: (runId: string, reason = '') => request({ url: `/api/digital-twin/action-flows/runs/${runId}/resume`, method: 'post', data: { reason } }),
	cancelActionFlowRun: (runId: string, reason: string) => request({ url: `/api/digital-twin/action-flows/runs/${runId}/cancel`, method: 'post', data: { reason } }),
	retryActionFlowStep: (runId: string, stepInstanceId: string, reason = '') => request({ url: `/api/digital-twin/action-flows/runs/${runId}/steps/${encodeURIComponent(stepInstanceId)}/retry`, method: 'post', data: { reason } }),
	manualConfirmActionFlowRun: (runId: string, stepInstanceId: string, reason: string, output: Record<string, unknown> = {}) =>
		request({ url: `/api/digital-twin/action-flows/runs/${runId}/manual-confirm`, method: 'post', data: { stepInstanceId, reason, output } }),
	sendActionFlowSignal: (runId: string, bindingId: string, value: unknown, cycleId?: string) =>
		request({ url: `/api/digital-twin/action-flows/runs/${runId}/signals`, method: 'post', data: { bindingId, value, cycleId } }),
	sendActionFlowCommandFeedback: (runId: string, data: { commandId: string; correlationId: string; cycleId?: string; status: string; payload?: unknown }) =>
		request({ url: `/api/digital-twin/action-flows/runs/${runId}/command-feedback`, method: 'post', data }),
};
