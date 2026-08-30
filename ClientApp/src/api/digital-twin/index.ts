import request from '/@/utils/request';
import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import type { TwinComponentResourceRegistrationPayload } from '/@/digital-twin/components/ComponentResourceRegistration';

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

	snapshot: (sceneId: string, version?: number) =>
		request({ url: '/api/digital-twin/runtime/snapshot', method: 'post', data: { sceneId, version } }),
};
