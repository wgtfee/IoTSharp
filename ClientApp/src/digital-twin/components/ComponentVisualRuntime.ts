import * as THREE from 'three';

export interface TwinVisualSpinDefinition {
	axis?: [number, number, number];
	speedDegPerSecond?: number;
}

const resolveAxis = (value: unknown) => {
	const source = Array.isArray(value) && value.length >= 3 ? value : [0, 1, 0];
	const axis = new THREE.Vector3(Number(source[0]) || 0, Number(source[1]) || 0, Number(source[2]) || 0);
	if (axis.lengthSq() < 0.000001) axis.set(0, 1, 0);
	return axis.normalize();
};

/**
 * Advances declarative visual-only animations embedded by procedural components.
 * These animations never write PLC/device state; they only make Run/Test visually meaningful.
 */
export const advanceComponentVisualRuntime = (root: THREE.Object3D, deltaSeconds: number, speedMultiplier = 1) => {
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
};
