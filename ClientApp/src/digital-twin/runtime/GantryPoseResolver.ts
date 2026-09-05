import * as THREE from 'three';
import { silkLineLayout } from './SilkLineLayout';

export type GantryMotionPhase = 'approach-pick' | 'descend-pick' | 'grip' | 'lift-pick' | 'transfer' | 'descend-place' | 'release' | 'lift-place' | 'return-home';

export interface GantryResolvedPose {
	phase: GantryMotionPhase;
	carriage: THREE.Vector3;
	safeCarriageY: number;
	pickCarriageY: number;
	placeCarriageY: number;
	attachAt: number;
	placeAt: number;
	patternCompression: number;
}

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const smooth = (value: number) => {
	const t = clamp01(value);
	return t * t * (3 - 2 * t);
};
const segment = (progress: number, from: number, to: number) => smooth((progress - from) / Math.max(0.0001, to - from));

/**
 * V5 桁架空间轨迹解析器。
 *
 * 小车先升到统一安全平面再做水平运动；放置高度随目标层递增，禁止使用固定下降量。
 * 数值按当前程序化模型的世界坐标计算：夹具中心比小车低 2.2m，丝饼中心挂在夹具下 0.3m。
 */
export const resolveGantryPose = (progress: number, targetLayer: number): GantryResolvedPose => {
	const p = clamp01(progress);
	const layer = Math.max(0, Math.min(7, Math.floor(targetLayer)));
	const pick = new THREE.Vector3(silkLineLayout.woodPalletX, 4.34, -5.9);
	const place = new THREE.Vector3(silkLineLayout.woodPalletX, 3.82 + layer * 0.46, -11);
	// 第 8 层放置前，已有码垛最高点约 4.29m；安全平面下的丝饼底部约 4.69m，净空 0.40m。
	const safeY = Math.max(7.45, place.y + 0.65);
	const home = new THREE.Vector3(silkLineLayout.woodPalletX, safeY, -5.9);
	const carriage = home.clone();
	let phase: GantryMotionPhase = 'approach-pick';

	if (p < 0.1) {
		carriage.lerp(new THREE.Vector3(pick.x, safeY, pick.z), segment(p, 0, 0.1));
	} else if (p < 0.22) {
		phase = 'descend-pick';
		carriage.set(pick.x, THREE.MathUtils.lerp(safeY, pick.y, segment(p, 0.1, 0.22)), pick.z);
	} else if (p < 0.3) {
		phase = 'grip';
		carriage.copy(pick);
	} else if (p < 0.42) {
		phase = 'lift-pick';
		carriage.set(pick.x, THREE.MathUtils.lerp(pick.y, safeY, segment(p, 0.3, 0.42)), pick.z);
	} else if (p < 0.62) {
		phase = 'transfer';
		carriage.set(THREE.MathUtils.lerp(pick.x, place.x, segment(p, 0.42, 0.62)), safeY, THREE.MathUtils.lerp(pick.z, place.z, segment(p, 0.42, 0.62)));
	} else if (p < 0.76) {
		phase = 'descend-place';
		carriage.set(place.x, THREE.MathUtils.lerp(safeY, place.y, segment(p, 0.62, 0.76)), place.z);
	} else if (p < 0.82) {
		phase = 'release';
		carriage.copy(place);
	} else if (p < 0.91) {
		phase = 'lift-place';
		carriage.set(place.x, THREE.MathUtils.lerp(place.y, safeY, segment(p, 0.82, 0.91)), place.z);
	} else {
		phase = 'return-home';
		carriage.set(THREE.MathUtils.lerp(place.x, home.x, segment(p, 0.91, 1)), safeY, THREE.MathUtils.lerp(place.z, home.z, segment(p, 0.91, 1)));
	}

	return {
		phase,
		carriage,
		safeCarriageY: safeY,
		pickCarriageY: pick.y,
		placeCarriageY: place.y,
		attachAt: 0.24,
		placeAt: 0.78,
		patternCompression: segment(p, 0.44, 0.68),
	};
};
