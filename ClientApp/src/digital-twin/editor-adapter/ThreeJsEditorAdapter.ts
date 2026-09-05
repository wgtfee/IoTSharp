import type { TwinRouteDefinition, TwinSceneManifest, TwinVector3 } from '/@/digital-twin/contracts';
import type { TwinDataUpdate } from '/@/api/digital-twin';
import { TwinRuntime, type TwinRuntimeEvents } from '/@/digital-twin/runtime/TwinRuntime';
import type { TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';

/**
 * IoTSharp 与 threejs-editor 之间的稳定边界。
 * Phase 0 先代理 IoTSharp 自有运行时；接入上游编辑器后，页面 API 保持不变。
 */
export class ThreeJsEditorAdapter {
	private readonly runtime: TwinRuntime;

	constructor(container: HTMLDivElement, manifest: TwinSceneManifest, events: TwinRuntimeEvents = {}) {
		this.runtime = new TwinRuntime(container, manifest, events);
	}

	setRunning(running: boolean) {
		this.runtime.setRunning(running);
	}

	setSpeed(speed: number) {
		this.runtime.setSpeed(speed);
	}

	resetRoute() {
		this.runtime.resetRoute();
	}

	correctRouteDistance(distanceMeters: number) {
		this.runtime.correctRouteDistance(distanceMeters);
	}

	setRouteDrawMode(enabled: boolean) {
		this.runtime.setRouteDrawMode(enabled);
	}

	setRouteCurveKind(curveKind: TwinRouteDefinition['curveKind']) {
		this.runtime.setRouteCurveKind(curveKind);
	}

	setRouteLoop(loop: boolean) {
		this.runtime.setRouteLoop(loop);
	}

	updateRoutePoint(index: number, position: TwinVector3) {
		this.runtime.updateRoutePoint(index, position);
	}

	setRoute(route: TwinRouteDefinition) {
		this.runtime.setRoute(route);
	}

	setRouteRoutingContext(context: TwinRouteRoutingContext) {
		this.runtime.setRouteRoutingContext(context);
	}

	addRoutePoint(position?: TwinVector3) {
		this.runtime.addRoutePoint(position);
	}

	removeRoutePoint(index: number) {
		this.runtime.removeRoutePoint(index);
	}

	loadManifest(manifest: TwinSceneManifest) {
		this.runtime.loadManifest(manifest);
	}

	getRoute() {
		return this.runtime.getRoute();
	}

	getMaterialFlowSnapshot() {
		return this.runtime.getMaterialFlowSnapshot();
	}

	loadLocalGlb(file: File) {
		return this.runtime.loadLocalGlb(file);
	}

	loadGlbBuffer(objectId: string, fileName: string, buffer: ArrayBuffer) {
		return this.runtime.loadGlbBuffer(objectId, fileName, buffer);
	}

	applyDataUpdates(updates: TwinDataUpdate[]) {
		this.runtime.applyDataUpdates(updates);
	}

	getSelectionScreenAnchor() {
		return this.runtime.getSelectionScreenAnchor();
	}

	focusSelected() {
		this.runtime.focusSelected();
	}

	dispose() {
		this.runtime.dispose();
	}
}
