import type { TwinVector3 } from '/@/digital-twin/contracts';

export type TwinRotationAxis = 0 | 1 | 2;

export const radiansToDegrees = (radians: number) => radians * 180 / Math.PI;
export const degreesToRadians = (degrees: number) => degrees * Math.PI / 180;

export const normalizeDegrees = (degrees: number) => {
	if (!Number.isFinite(degrees)) return 0;
	const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
	return Math.abs(normalized) < 1e-9 ? 0 : normalized;
};

export const rotationDegrees = (rotation: TwinVector3, axis: TwinRotationAxis) => normalizeDegrees(radiansToDegrees(rotation[axis] || 0));

export const isVerticalYRotation = (rotation: TwinVector3) => Math.abs(Math.abs(rotationDegrees(rotation, 1)) - 90) <= 0.5;

export const withRotationDegrees = (rotation: TwinVector3, axis: TwinRotationAxis, degrees: number): TwinVector3 => {
	const next = [...rotation] as TwinVector3;
	next[axis] = degreesToRadians(normalizeDegrees(degrees));
	return next;
};

export const withVerticalYRotation = (rotation: TwinVector3, vertical: boolean): TwinVector3 => withRotationDegrees(rotation, 1, vertical ? 90 : 0);
