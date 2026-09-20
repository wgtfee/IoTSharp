import * as THREE from 'three';
import type { TwinActuatorDefinition, TwinSceneManifest } from '../contracts';
import type { TwinDataUpdate } from '/@/api/digital-twin';

export type TwinActuatorControlSource = 'telemetry' | 'behavior' | 'action-flow' | 'manual-test';
export type TwinActuatorQuality = 'good' | 'stale' | 'missing' | 'bad';

export interface TwinActuatorRuntimeCommand {
	actuatorId: string;
	value: number | boolean;
	source: TwinActuatorControlSource;
	timestamp?: number;
	immediate?: boolean;
	quality?: TwinActuatorQuality;
	/** 当前动作的速度倍率；不改变执行机构标定的基础速度。 */
	speedRatio?: number;
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
	/** 命令被拒绝的明确原因；拒绝时不改写当前位置及上一个合法目标。 */
	error?: string;
	moving: boolean;
	lastUpdatedAt?: number;
	speedRatio?: number;
}

const nowMs = () => Date.now();
const finite = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Number(value) : undefined;
const asBoolean = (value: unknown) => typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : ['true', '1', 'yes', 'on', 'closed', 'close'].includes(String(value ?? '').trim().toLowerCase());
/** 校验原始目标，不截断到行程边界；运动学、手动和遥测入口共用。 */
export function actuatorTargetError(actuator: TwinActuatorDefinition, value: unknown): string | undefined {
	if (actuator.kind === 'gripper') return undefined;
	const label = `执行机构 ${actuator.name} (${actuator.actuatorId})`;
	if ((actuator.minValue !== undefined && !Number.isFinite(actuator.minValue)) || (actuator.maxValue !== undefined && !Number.isFinite(actuator.maxValue)) || (actuator.minValue ?? -Infinity) > (actuator.maxValue ?? Infinity)) return `${label} 行程配置无效`;
	if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) return `${label} 目标 ${String(value)} 不是有限数值`;
	const target = Number(value), min = actuator.minValue ?? -Infinity, max = actuator.maxValue ?? Infinity;
	if (target < min || target > max) return `${label} 目标 ${target} ${actuator.unit || ''} 超出行程 [${min}, ${max}]，命令已拒绝`;
	return undefined;
}
const toNodeValue = (value: number, actuator: TwinActuatorDefinition) => actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.degToRad(value) : actuator.unit === 'millimeter' ? value / 1000 : value;
const fromNodeValue = (value: number, actuator: TwinActuatorDefinition) => actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.radToDeg(value) : actuator.unit === 'millimeter' ? value * 1000 : value;
/** 将 Three.js 的米/弧度坐标还原为执行机构单位，供姿态捕获与运行反馈共用。 */
export { fromNodeValue as readActuatorNodeValue, toNodeValue as writeActuatorNodeValue };
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

	/** 取消仿真设备的旧运动目标并保持当前位置；不松爪、不改物料归属、不写 PLC。 */
	holdActor(objectId: string) {
		if (this.dataMode !== 'simulation') return;
		for (const state of this.states.values()) if (state.objectId === objectId && state.kind !== 'gripper' && (state.source === 'behavior' || state.source === 'action-flow')) {
			state.targetValue = state.currentValue; state.moving = false;
		}
	}

	apply(command: TwinActuatorRuntimeCommand): boolean {
		const actuator = this.actuatorById.get(command.actuatorId);
		if (!actuator) { this.reportError?.(`执行机构 ${command.actuatorId} 不存在。`); return false; }
		if (!this.canControl(actuator, command.source)) return false;
		if (command.speedRatio !== undefined && (!Number.isFinite(command.speedRatio) || command.speedRatio <= 0)) return false;
		const state = this.ensureState(actuator);
		const error = actuatorTargetError(actuator, command.value);
		if (error) return this.reject(state, error);
		if (!this.resolveNode(actuator)) return this.reject(state, `执行机构 ${actuator.actuatorId} 找不到模型节点 ${actuator.nodePath || actuator.objectId}`);
		state.speedRatio = command.speedRatio ?? 1;
		const quality = command.quality || 'good';
		state.source = command.source;
		state.quality = quality;
		state.stale = quality === 'stale' || quality === 'missing';
		state.fault = quality === 'bad';
		state.error = undefined;
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
		state.targetValue = numeric;
		state.moving = state.currentValue !== numeric;
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

	tick(deltaSeconds: number, simulationRunning = true) {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
		for (const actuator of this.actuatorById.values()) {
			const state = this.ensureState(actuator);
			if (!simulationRunning && this.dataMode === 'simulation' && (state.source === 'behavior' || state.source === 'action-flow')) continue;
			if (state.stale || state.fault || actuator.kind === 'gripper') continue;
			const current = Number(state.currentValue);
			const target = Number(state.targetValue);
			const error = actuatorTargetError(actuator, current) || actuatorTargetError(actuator, target);
			if (error) { this.reject(state, error); continue; }
			const nodeCurrent = toNodeValue(current, actuator);
			const nodeTarget = toNodeValue(target, actuator);
			const interpolation = actuator.telemetryInterpolation;
			if (state.source === 'telemetry' && interpolation?.enabled === false) {
				state.currentValue = state.targetValue;
				state.moving = false;
				this.writeValue(actuator, state.currentValue);
				continue;
			}
			const speed = Math.max(0.001, Number(actuator.speed || (actuator.kind === 'rotary-joint' ? 1.8 : 1))) * (state.speedRatio ?? 1);
			const maxStep = (actuator.kind === 'rotary-joint' && actuator.unit === 'degree' ? THREE.MathUtils.degToRad(speed) : actuator.unit === 'millimeter' ? speed / 1000 : speed) * deltaSeconds;
			// 有硬限位的轴按实际轴坐标运动；不能以最短角绕过限位、截断后假到位。
			const useShortestAngle = actuator.kind === 'rotary-joint' && actuator.minValue === undefined && actuator.maxValue === undefined && (interpolation?.mode || 'shortest-angle') === 'shortest-angle';
			const delta = useShortestAngle ? shortestAngleDelta(nodeCurrent, nodeTarget) : nodeTarget - nodeCurrent;
			const done = Math.abs(delta) <= Math.max(1e-6, maxStep);
			const nextNodeValue = done ? nodeTarget : nodeCurrent + Math.sign(delta) * maxStep;
			const next = done ? target : fromNodeValue(nextNodeValue, actuator);
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
			const error = actuatorTargetError(actuator, value);
			if (error) { this.reject(state, error); continue; }
			state.currentValue = value;
			state.targetValue = value;
			state.source = undefined;
			state.speedRatio = 1;
			state.quality = 'good'; state.stale = false; state.fault = false; state.moving = false; state.error = undefined;
			this.writeValue(actuator, value);
		}
	}
	dispose() { this.states.clear(); this.actuatorById.clear(); }

	private reject(state: TwinActuatorRuntimeState, message: string): false {
		const repeated = state.error === message;
		state.error = message; state.fault = true; state.quality = 'bad'; state.moving = false;
		if (!repeated) this.reportError?.(message);
		return false;
	}

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
		return root.getObjectByName(actuator.nodePath);
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
