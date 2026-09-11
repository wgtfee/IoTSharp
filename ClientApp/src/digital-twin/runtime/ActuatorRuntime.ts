import * as THREE from 'three';
import type { TwinActuatorDefinition, TwinDataUpdate, TwinSceneManifest } from '../contracts';

export type TwinActuatorControlSource = 'telemetry' | 'behavior' | 'action-flow' | 'manual-test';
export type TwinActuatorQuality = 'good' | 'stale' | 'missing' | 'bad';

export interface TwinActuatorRuntimeCommand {
	actuatorId: string;
	value: number | boolean;
	source: TwinActuatorControlSource;
	timestamp?: number;
	immediate?: boolean;
	quality?: TwinActuatorQuality;
}

export interface TwinActuatorRuntimeState {
	actuatorId: string;
	objectId: string;
	name: string;
	kind: TwinActuatorDefinition['kind'];
	currentValue: number | boolean;
	targetValue: number | boolean;
	source?: TwinActuatorControlSource;
	quality: TwinActuatorQuality;
	stale: boolean;
	fault: boolean;
	moving: boolean;
	lastUpdatedAt?: number;
}

const nowMs = () => Date.now();
const finite = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Number(value) : undefined;
const asBoolean = (value: unknown) => typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : ['true', '1', 'yes', 'on', 'closed', 'close'].includes(String(value ?? '').trim().toLowerCase());
const clamp = (value: number, actuator: TwinActuatorDefinition) => Math.min(actuator.maxValue ?? Number.POSITIVE_INFINITY, Math.max(actuator.minValue ?? Number.NEGATIVE_INFINITY, value));
const toNodeValue = (value: number, actuator: TwinActuatorDefinition) => actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.degToRad(value) : actuator.unit === 'millimeter' ? value / 1000 : value;
const fromNodeValue = (value: number, actuator: TwinActuatorDefinition) => actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.radToDeg(value) : actuator.unit === 'millimeter' ? value * 1000 : value;
const shortestAngleDelta = (from: number, to: number) => THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;

export class ActuatorRuntime {
	private manifest: TwinSceneManifest;
	private readonly states = new Map<string, TwinActuatorRuntimeState>();
	private readonly actuatorById = new Map<string, TwinActuatorDefinition>();
	private dataMode: 'simulation' | 'live';

	constructor(
		manifest: TwinSceneManifest,
		private readonly getObjectRoot: (objectId: string) => THREE.Object3D | undefined,
		private readonly reportError?: (message: string) => void,
	) {
		this.manifest = manifest;
		this.dataMode = manifest.runtime.dataMode;
		this.setManifest(manifest);
	}

	setManifest(manifest: TwinSceneManifest) {
		this.manifest = manifest;
		this.dataMode = manifest.runtime.dataMode;
		this.actuatorById.clear();
		for (const actuator of manifest.actuators || []) this.actuatorById.set(actuator.actuatorId, actuator);
		for (const actuatorId of [...this.states.keys()]) if (!this.actuatorById.has(actuatorId)) this.states.delete(actuatorId);
		for (const actuator of manifest.actuators || []) this.ensureState(actuator);
	}

	setDataMode(mode: 'simulation' | 'live') { this.dataMode = mode; }

	apply(command: TwinActuatorRuntimeCommand): boolean {
		const actuator = this.actuatorById.get(command.actuatorId);
		if (!actuator) { this.reportError?.(`执行机构 ${command.actuatorId} 不存在。`); return false; }
		if (!this.canControl(actuator, command.source)) return false;
		const state = this.ensureState(actuator);
		const quality = command.quality || 'good';
		state.source = command.source;
		state.quality = quality;
		state.stale = quality === 'stale' || quality === 'missing';
		state.fault = quality === 'bad';
		state.lastUpdatedAt = command.timestamp || nowMs();
		if (state.stale || state.fault) {
			state.moving = false;
			return false;
		}
		if (actuator.kind === 'gripper') {
			const value = asBoolean(command.value);
			state.targetValue = value;
			state.currentValue = value;
			state.moving = false;
			this.writeValue(actuator, value);
			return true;
		}
		const numeric = finite(command.value);
		if (numeric === undefined) return false;
		state.targetValue = clamp(numeric, actuator);
		if (command.immediate) {
			state.currentValue = state.targetValue;
			state.moving = false;
			this.writeValue(actuator, Number(state.currentValue));
		}
		return true;
	}

	applyTelemetry(actuatorId: string, value: unknown, timestamp?: number, stale = false, quality: TwinActuatorQuality = stale ? 'stale' : 'good') {
		return this.apply({ actuatorId, value: value as number | boolean, source: 'telemetry', timestamp, quality });
	}

	applyTelemetryUpdate(actuatorId: string, update: TwinDataUpdate) {
		const quality = (update.quality || (update.stale ? 'stale' : 'good')) as TwinActuatorQuality;
		return this.applyTelemetry(actuatorId, update.value, update.sourceTimestamp ? Date.parse(update.sourceTimestamp) : undefined, Boolean(update.stale), quality);
	}

	applyBehavior(actuatorId: string, value: number | boolean, immediate = false) {
		return this.apply({ actuatorId, value, source: 'behavior', immediate });
	}

	applyActionFlow(actuatorId: string, value: number | boolean, immediate = false) {
		return this.apply({ actuatorId, value, source: 'action-flow', immediate });
	}

	applyManualTest(actuatorId: string, value: number | boolean, immediate = true) {
		return this.apply({ actuatorId, value, source: 'manual-test', immediate });
	}

	tick(deltaSeconds: number) {
		for (const actuator of this.actuatorById.values()) {
			const state = this.ensureState(actuator);
			if (state.stale || state.fault || actuator.kind === 'gripper') continue;
			const current = Number(state.currentValue);
			const target = Number(state.targetValue);
			if (!Number.isFinite(current) || !Number.isFinite(target)) continue;
			const nodeCurrent = toNodeValue(current, actuator);
			const nodeTarget = toNodeValue(target, actuator);
			const interpolation = actuator.telemetryInterpolation;
			if (interpolation?.enabled === false) {
				state.currentValue = state.targetValue;
				state.moving = false;
				this.writeValue(actuator, state.currentValue);
				continue;
			}
			const speed = Math.max(0.001, Number(actuator.speed || (actuator.kind === 'rotary-joint' ? 1.8 : 1)));
			const maxStep = (actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.degToRad(speed) : actuator.unit === 'millimeter' ? speed / 1000 : speed) * deltaSeconds;
			const useShortestAngle = actuator.kind === 'rotary-joint' && (interpolation?.mode || 'shortest-angle') === 'shortest-angle';
			const delta = useShortestAngle ? shortestAngleDelta(nodeCurrent, nodeTarget) : nodeTarget - nodeCurrent;
			const done = Math.abs(delta) <= Math.max(1e-6, maxStep);
			const nextNodeValue = done ? nodeTarget : nodeCurrent + Math.sign(delta) * maxStep;
			const next = clamp(fromNodeValue(nextNodeValue, actuator), actuator);
			state.currentValue = next;
			state.moving = !done;
			this.writeValue(actuator, next);
		}
	}

	getState(actuatorId: string) { const state = this.states.get(actuatorId); return state ? { ...state } : undefined; }
	getSnapshot() { return [...this.states.values()].map(state => ({ ...state })); }
	reset() {
		for (const actuator of this.actuatorById.values()) {
			const value = actuator.kind === 'gripper' ? false : Number(actuator.homeValue || 0);
			const state = this.ensureState(actuator);
			state.currentValue = value;
			state.targetValue = value;
			state.source = undefined;
			state.quality = 'good'; state.stale = false; state.fault = false; state.moving = false;
			this.writeValue(actuator, value);
		}
	}
	dispose() { this.states.clear(); this.actuatorById.clear(); }

	private canControl(actuator: TwinActuatorDefinition, source: TwinActuatorControlSource) {
		if (source === 'manual-test') return true;
		const telemetryOwned = Boolean(actuator.bindings?.positionBindingId || actuator.bindings?.openBindingId || actuator.bindings?.closeBindingId);
		if (this.dataMode === 'live' && telemetryOwned) return source === 'telemetry';
		if (this.dataMode === 'live') return source !== 'behavior' || !telemetryOwned;
		return source !== 'telemetry';
	}

	private ensureState(actuator: TwinActuatorDefinition) {
		let state = this.states.get(actuator.actuatorId);
		if (state) return state;
		const initial = this.readValue(actuator) ?? (actuator.kind === 'gripper' ? false : Number(actuator.homeValue || 0));
		state = { actuatorId: actuator.actuatorId, objectId: actuator.objectId, name: actuator.name, kind: actuator.kind, currentValue: initial, targetValue: initial, quality: 'good', stale: false, fault: false, moving: false };
		this.states.set(actuator.actuatorId, state);
		return state;
	}

	private resolveNode(actuator: TwinActuatorDefinition) {
		const root = this.getObjectRoot(actuator.objectId);
		if (!root) return undefined;
		if (!actuator.nodePath) return root;
		return root.getObjectByName(actuator.nodePath) || root;
	}

	private readValue(actuator: TwinActuatorDefinition): number | boolean | undefined {
		const node = this.resolveNode(actuator); if (!node) return undefined;
		if (actuator.kind === 'gripper') return Boolean(node.userData?.closed ?? node.userData?.gripped ?? false);
		const axis = actuator.motionAxis || 'x';
		const raw = actuator.kind === 'rotary-joint' ? node.rotation[axis] : node.position[axis];
		return fromNodeValue(raw, actuator);
	}

	private writeValue(actuator: TwinActuatorDefinition, value: number | boolean) {
		const node = this.resolveNode(actuator); if (!node) return;
		if (actuator.kind === 'gripper') {
			node.userData.closed = asBoolean(value);
			node.userData.gripped = asBoolean(value);
			return;
		}
		const axis = actuator.motionAxis || 'x';
		const nodeValue = toNodeValue(Number(value), actuator);
		if (actuator.kind === 'rotary-joint') node.rotation[axis] = nodeValue;
		else node.position[axis] = nodeValue;
	}
}
