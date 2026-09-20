import { CurvePath, Vector3 } from 'three';

/** CurvePath.getPoint 已按各段长度取点；再次用 Curve.getPointAt 的采样表会产生拐角距离误差。 */
export class DistancePolylineCurve extends CurvePath<Vector3> {
	getPointAt(u: number, target = new Vector3()): Vector3 {
		return target.copy(super.getPoint(Math.min(1, Math.max(0, u))) || new Vector3());
	}
	getTangentAt(u: number, target = new Vector3()): Vector3 {
		const lengths = this.getCurveLengths();
		const distance = Math.min(1, Math.max(0, u)) * this.getLength();
		const index = lengths.findIndex(length => length > distance + 1e-8);
		const segment = this.curves[index < 0 ? this.curves.length - 1 : index];
		return segment ? segment.getTangentAt(0.5, target) : target.set(1, 0, 0);
	}
}
