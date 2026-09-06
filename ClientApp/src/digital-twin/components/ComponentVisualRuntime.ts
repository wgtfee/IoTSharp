import * as THREE from 'three';

export interface TwinVisualSpinDefinition {
	axis?: [number, number, number];
	speedDegPerSecond?: number;
}

export type TwinComponentAnimationTrigger = 'run' | 'process';
export type TwinComponentAnimationKind = 'rotate' | 'translate' | 'scale' | 'visibility' | 'color';
export type TwinComponentAnimationAxis = 'x' | 'y' | 'z';

/** 固定设备内部动画轨道。process 轨道统一使用 0~1 工艺进度。 */
export interface TwinComponentAnimationDefinition {
	id?: string;
	name?: string;
	targetNodePath?: string;
	trigger?: TwinComponentAnimationTrigger;
	kind: TwinComponentAnimationKind;
	axis?: TwinComponentAnimationAxis;
	speedDegPerSecond?: number;
	from?: number;
	to?: number;
	startProgress?: number;
	endProgress?: number;
	relative?: boolean;
	fromColor?: string | number;
	toColor?: string | number;
}

export interface TwinComponentAnimationRuntimeOptions {
	animations?: TwinComponentAnimationDefinition[];
	processProgress?: number;
	processActive?: boolean;
	resolveTarget?: (definition: TwinComponentAnimationDefinition) => THREE.Object3D | undefined;
}

interface VisualBaseState {
	position: THREE.Vector3;
	rotation: THREE.Euler;
	scale: THREE.Vector3;
	visible: boolean;
	color?: THREE.Color;
}

const visualBaseStates = new WeakMap<THREE.Object3D, VisualBaseState>();

const resolveAxis = (value: unknown) => {
	const source = Array.isArray(value) && value.length >= 3 ? value : [0, 1, 0];
	const axis = new THREE.Vector3(Number(source[0]) || 0, Number(source[1]) || 0, Number(source[2]) || 0);
	if (axis.lengthSq() < 0.000001) axis.set(0, 1, 0);
	return axis.normalize();
};

const materialColor = (object: THREE.Object3D) => {
	if (!(object instanceof THREE.Mesh)) return undefined;
	const material = Array.isArray(object.material) ? object.material[0] : object.material;
	return (material as THREE.MeshStandardMaterial | undefined)?.color;
};

const captureBaseState = (object: THREE.Object3D) => {
	let base = visualBaseStates.get(object);
	if (base) return base;
	base = {
		position: object.position.clone(),
		rotation: object.rotation.clone(),
		scale: object.scale.clone(),
		visible: object.visible,
		color: materialColor(object)?.clone(),
	};
	visualBaseStates.set(object, base);
	return base;
};

const resetToBaseState = (object: THREE.Object3D) => {
	const base = captureBaseState(object);
	object.position.copy(base.position);
	object.rotation.copy(base.rotation);
	object.scale.copy(base.scale);
	object.visible = base.visible;
	const color = materialColor(object);
	if (color && base.color) color.copy(base.color);
};

const resolveNodeByPath = (root: THREE.Object3D, path?: string) => {
	if (!path) return root;
	const byName = root.getObjectByName(path);
	if (byName) return byName;
	const segments = path.split('/').filter(Boolean);
	let current: THREE.Object3D = root;
	for (let index = 0; index < segments.length; index += 1) {
		const match = segments[index].match(/^(.*)\[(\d+)\]$/);
		if (!match) continue;
		const name = match[1];
		const occurrence = Number(match[2]);
		const candidates = current.children.filter((child) => (child.name || child.type || 'Object3D') === name);
		const next = candidates[occurrence];
		if (!next) {
			if (index === 0) continue;
			return undefined;
		}
		current = next;
	}
	return current === root ? undefined : current;
};

const timelineProgress = (definition: TwinComponentAnimationDefinition, progress: number) => {
	const start = THREE.MathUtils.clamp(Number(definition.startProgress ?? 0), 0, 1);
	const end = THREE.MathUtils.clamp(Number(definition.endProgress ?? 1), 0, 1);
	if (end <= start) return progress >= end ? 1 : 0;
	return THREE.MathUtils.clamp((progress - start) / (end - start), 0, 1);
};

const applyProcessTrack = (object: THREE.Object3D, definition: TwinComponentAnimationDefinition, progress: number) => {
	const base = captureBaseState(object);
	const t = timelineProgress(definition, progress);
	const from = Number(definition.from ?? 0);
	const to = Number(definition.to ?? 0);
	const value = THREE.MathUtils.lerp(from, to, t);
	const relative = definition.relative !== false;
	const axis = definition.axis || 'y';
	if (definition.kind === 'translate') {
		if (relative) object.position[axis] += value;
		else object.position[axis] = value;
		return;
	}
	if (definition.kind === 'rotate') {
		if (relative) object.rotation[axis] += THREE.MathUtils.degToRad(value);
		else object.rotation[axis] = THREE.MathUtils.degToRad(value);
		return;
	}
	if (definition.kind === 'scale') {
		if (relative) object.scale[axis] = Math.max(0.001, object.scale[axis] + value);
		else object.scale[axis] = Math.max(0.001, value);
		return;
	}
	if (definition.kind === 'visibility') {
		object.visible = value >= 0.5;
		return;
	}
	if (definition.kind === 'color') {
		const color = materialColor(object);
		if (!color) return;
		const fromColor = new THREE.Color(definition.fromColor ?? base.color ?? '#ffffff');
		const toColor = new THREE.Color(definition.toColor ?? definition.fromColor ?? base.color ?? '#ffffff');
		color.copy(fromColor).lerp(toColor, t);
	}
};

/** 将固定设备内部动画声明挂到组件根节点。 */
export const attachComponentAnimations = (root: THREE.Object3D, animations: TwinComponentAnimationDefinition[]) => {
	root.userData.componentAnimations = animations.map((item) => ({ ...item }));
};

const publishedAnimationStorageKey = (resourceKey: string) => `iotsharp.component-animation.${encodeURIComponent(resourceKey)}`;

/**
 * Component Studio 当前仍是浏览器本地发布，因此动画覆盖也使用同一浏览器存储。
 * 后续接入不可变组件版本表时只需要替换这个存储边界，运行时解释器无需改变。
 */
export const setPublishedComponentAnimationOverride = (resourceKey: string, animations: TwinComponentAnimationDefinition[]) => {
	if (!resourceKey?.trim()) return false;
	try {
		globalThis.localStorage?.setItem(publishedAnimationStorageKey(resourceKey), JSON.stringify(animations.map((item) => ({ ...item }))));
		return Boolean(globalThis.localStorage);
	} catch {
		return false;
	}
};

/** 读取 Component Studio 已发布的本地动画覆盖；undefined 表示没有发布覆盖，空数组表示明确关闭默认动画。 */
export const getPublishedComponentAnimationOverride = (resourceKey: string): TwinComponentAnimationDefinition[] | undefined => {
	if (!resourceKey?.trim()) return undefined;
	try {
		const raw = globalThis.localStorage?.getItem(publishedAnimationStorageKey(resourceKey));
		if (raw === null || raw === undefined) return undefined;
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed as TwinComponentAnimationDefinition[] : undefined;
	} catch {
		return undefined;
	}
};

/**
 * 推进组件内部视觉动画。这里永远不判断外检、套袋、贴标、缠膜等业务类型。
 * 场景 Runtime 只提供 processActive/processProgress，组件自己解释内部动作。
 */
export const advanceComponentVisualRuntime = (
	root: THREE.Object3D,
	deltaSeconds: number,
	speedMultiplier = 1,
	options: TwinComponentAnimationRuntimeOptions = {},
) => {
	if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || !root) return;
	const multiplier = Math.max(0, Number(speedMultiplier) || 0);
	if (multiplier <= 0) return;
	root.traverse((object: any) => {
		const spin = object.userData?.runtimeSpin as TwinVisualSpinDefinition | undefined;
		if (spin && Number.isFinite(Number(spin.speedDegPerSecond))) {
			const angle = THREE.MathUtils.degToRad(Number(spin.speedDegPerSecond) * multiplier) * deltaSeconds;
			object.rotateOnAxis(resolveAxis(spin.axis), angle);
		}
		const instanceSpin = object.userData?.runtimeSpinInstances as TwinVisualSpinDefinition | undefined;
		if (!(object instanceof THREE.InstancedMesh) || !instanceSpin || !Number.isFinite(Number(instanceSpin.speedDegPerSecond))) return;
		const angle = THREE.MathUtils.degToRad(Number(instanceSpin.speedDegPerSecond) * multiplier) * deltaSeconds;
		const spinQuaternion = new THREE.Quaternion().setFromAxisAngle(resolveAxis(instanceSpin.axis), angle);
		const matrix = new THREE.Matrix4();
		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3();
		for (let index = 0; index < object.count; index += 1) {
			object.getMatrixAt(index, matrix);
			matrix.decompose(position, quaternion, scale);
			quaternion.multiply(spinQuaternion);
			matrix.compose(position, quaternion, scale);
			object.setMatrixAt(index, matrix);
		}
		object.instanceMatrix.needsUpdate = true;
	});

	const hosts: Array<{ root: THREE.Object3D; animations: TwinComponentAnimationDefinition[] }> = [];
	if (options.animations) hosts.push({ root, animations: options.animations });
	else root.traverse((candidate) => {
		const animations = candidate.userData?.componentAnimations;
		if (Array.isArray(animations) && animations.length) hosts.push({ root: candidate, animations: animations as TwinComponentAnimationDefinition[] });
	});
	for (const host of hosts) {
		const resolveTarget = host.root === root && options.resolveTarget
			? options.resolveTarget
			: (definition: TwinComponentAnimationDefinition) => resolveNodeByPath(host.root, definition.targetNodePath);
		const processTracks = host.animations.filter((item) => (item.trigger || 'run') === 'process');
		const processTargets = new Set<THREE.Object3D>();
		for (const definition of processTracks) {
			const target = resolveTarget(definition);
			if (target) processTargets.add(target);
		}
		for (const target of processTargets) resetToBaseState(target);
		const processActive = host.root === root && options.processActive !== undefined
			? options.processActive
			: host.root.userData?.processActive === true;
		const processProgress = THREE.MathUtils.clamp(Number(
			host.root === root && options.processProgress !== undefined ? options.processProgress : host.root.userData?.processProgress ?? 0,
		), 0, 1);
		if (processActive) {
			for (const definition of processTracks) {
				const target = resolveTarget(definition);
				if (target) applyProcessTrack(target, definition, processProgress);
			}
		}

		for (const definition of host.animations.filter((item) => (item.trigger || 'run') === 'run')) {
			if (definition.kind !== 'rotate' || !Number.isFinite(Number(definition.speedDegPerSecond))) continue;
			const target = resolveTarget(definition);
			if (!target) continue;
			const axis = definition.axis || 'y';
			target.rotation[axis] += THREE.MathUtils.degToRad(Number(definition.speedDegPerSecond) * multiplier) * deltaSeconds;
		}
	}
};
