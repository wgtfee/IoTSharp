import * as THREE from 'three';

export interface TwinScreenRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export const normalizeScreenRect = (startX: number, startY: number, endX: number, endY: number): TwinScreenRect => {
	const left = Math.min(startX, endX);
	const right = Math.max(startX, endX);
	const top = Math.min(startY, endY);
	const bottom = Math.max(startY, endY);
	return { left, top, right, bottom, width: right - left, height: bottom - top };
};

export const screenRectsIntersect = (left: TwinScreenRect, right: TwinScreenRect) =>
	left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;

/** 将世界包围盒投影成编辑器画布内的像素矩形。 */
export const projectWorldBoundsToScreen = (
	bounds: THREE.Box3,
	camera: THREE.Camera,
	viewportWidth: number,
	viewportHeight: number,
): TwinScreenRect | undefined => {
	if (bounds.isEmpty() || viewportWidth <= 0 || viewportHeight <= 0) return undefined;
	const center = bounds.getCenter(new THREE.Vector3());
	const cameraPosition = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
	const cameraDirection = new THREE.Vector3();
	camera.getWorldDirection(cameraDirection);
	if (center.clone().sub(cameraPosition).dot(cameraDirection) <= 0) return undefined;

	const corners = [
		[bounds.min.x, bounds.min.y, bounds.min.z], [bounds.min.x, bounds.min.y, bounds.max.z],
		[bounds.min.x, bounds.max.y, bounds.min.z], [bounds.min.x, bounds.max.y, bounds.max.z],
		[bounds.max.x, bounds.min.y, bounds.min.z], [bounds.max.x, bounds.min.y, bounds.max.z],
		[bounds.max.x, bounds.max.y, bounds.min.z], [bounds.max.x, bounds.max.y, bounds.max.z],
	] as const;
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const corner of corners) {
		const projected = new THREE.Vector3(...corner).project(camera);
		if (![projected.x, projected.y, projected.z].every(Number.isFinite)) continue;
		const x = (projected.x + 1) * 0.5 * viewportWidth;
		const y = (1 - projected.y) * 0.5 * viewportHeight;
		left = Math.min(left, x);
		right = Math.max(right, x);
		top = Math.min(top, y);
		bottom = Math.max(bottom, y);
	}
	if (![left, right, top, bottom].every(Number.isFinite)) return undefined;
	return { left, top, right, bottom, width: right - left, height: bottom - top };
};
