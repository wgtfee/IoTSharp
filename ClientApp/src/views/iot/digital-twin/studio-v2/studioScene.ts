import type { TwinSceneManifest, TwinValidationDiagnostic } from '/@/digital-twin/contracts';
import { cloneTwinManifest, createBlankTwinSceneManifest, normalizeTwinRoute, validateTwinSceneManifest } from '/@/digital-twin/contracts';
import { ensureComponentActuators, validateV7ComponentManifest } from '/@/digital-twin/components';
import { createCompiledRuntimeManifest } from '/@/digital-twin/routes/RouteAuthoringCompiler';
import { validateRouteAuthoringManifest } from '/@/digital-twin/routes/RouteAuthoringValidator';
import type { TwinV7SceneManifest } from '/@/digital-twin/contracts/v7-components';

export type StudioMode = 'design' | 'simulation' | 'live';
export type StudioDiagnostic = TwinValidationDiagnostic;

export function normalizeStudioManifest(source: TwinSceneManifest): TwinSceneManifest {
	const value = cloneTwinManifest(source);
	value.resources ||= [];
	value.objects ||= [];
	value.bindings ||= [];
	value.actionFlows ||= [];
	value.connections ||= [];
	value.routes = (value.routes?.length ? value.routes : createBlankTwinSceneManifest().routes).map(normalizeTwinRoute);
	value.editorExtension ||= { source: 'threejs-editor', payloadVersion: 2 };
	ensureComponentActuators(value);
	return value;
}

export function inspectStudioManifest(source: TwinSceneManifest): StudioDiagnostic[] {
	const diagnostics = [
		...validateTwinSceneManifest(source),
		...validateV7ComponentManifest(source),
		...validateRouteAuthoringManifest(source),
		...createCompiledRuntimeManifest(source).compile.diagnostics,
	] as StudioDiagnostic[];
	const seen = new Set<string>();
	return diagnostics.filter((item) => {
		const key = [item.severity, item.code, item.path || '', item.message].join('|');
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function createStudioRuntimeManifest(source: TwinSceneManifest, mode: Exclude<StudioMode, 'design'>) {
	const result = createCompiledRuntimeManifest(normalizeStudioManifest(source));
	result.manifest.runtime.dataMode = mode === 'live' ? 'live' : 'simulation';
	return result.manifest;
}

export function studioSummary(source: TwinSceneManifest) {
	const typed = source as TwinV7SceneManifest;
	const uniqueResources = new Set(source.objects.map((object) => object.resourceId).filter(Boolean));
	return {
		objects: source.objects.length,
		components: typed.objects.filter((object) => object.kind === 'component').length,
		routes: source.routes.length,
		connections: typed.connections?.length || 0,
		bindings: source.bindings.length,
		flows: source.actionFlows?.length || 0,
		resources: uniqueResources.size,
	};
}

export function hasDraftChanged(source: TwinSceneManifest, persisted: TwinSceneManifest): boolean {
	return JSON.stringify(normalizeStudioManifest(source)) !== JSON.stringify(normalizeStudioManifest(persisted));
}
