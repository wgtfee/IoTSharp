import { Box3, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import type { TwinSceneManifest } from '../contracts';
import type { TwinJointTrajectory } from './JointTrajectory';
import { exactNode, type MotionSceneAccess } from './SceneSlotResolver';
import { ToolPoseSolver } from './ToolPoseSolver';

export interface CartesianCollisionReview {
	method: 'joint-swept-aabb/1';
	status: 'clear-within-scope' | 'blocked' | 'unchecked';
	checkedPairs: number;
	limitations: string[];
	conflict?: { segment: number; moving: string; obstacle: string };
}

/**
 * 同一五次进度驱动的直线轴使刚体包围盒作平移。以相对位移解三个 slab 的交集，
 * 覆盖整段连续曲线，不会漏掉两个采样帧之间的薄障碍。包围盒交叠只表示不能证明净空。
 */
export function translatingBoxesOverlap(a: Box3, aEnd: Box3, b: Box3, bEnd: Box3): boolean {
	let enter = 0, leave = 1;
	const epsilon = 1e-8;
	for (const axis of ['x', 'y', 'z'] as const) {
		const velocity = aEnd.min[axis] - a.min[axis] - (bEnd.min[axis] - b.min[axis]);
		const low = b.min[axis] - a.max[axis] + epsilon, high = b.max[axis] - a.min[axis] - epsilon;
		if (Math.abs(velocity) < 1e-14) { if (low >= 0 || high <= 0) return false; continue; }
		const t0 = low / velocity, t1 = high / velocity;
		enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1));
		if (enter >= leave) return false;
	}
	return enter < leave;
}

/** 计算一个刚体绕固定世界轴任意角度旋转的完整圆柱包围盒，宁可保守拒绝。 */
function fullRevolutionEnvelope(box: Box3, pivot: Vector3, axis: Vector3): Box3 {
	const minProjection = new Vector3(0, 0, 0), maxProjection = new Vector3(0, 0, 0);
	let minAlong = Infinity, maxAlong = -Infinity, radius = 0;
	for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
		const offset = new Vector3(x, y, z).sub(pivot), along = offset.dot(axis);
		minAlong = Math.min(minAlong, along); maxAlong = Math.max(maxAlong, along);
		radius = Math.max(radius, offset.addScaledVector(axis, -along).length());
	}
	for (const component of ['x', 'y', 'z'] as const) {
		const extent = radius * Math.sqrt(Math.max(0, 1 - axis[component] ** 2));
		const alongA = pivot[component] + axis[component] * minAlong, alongB = pivot[component] + axis[component] * maxAlong;
		minProjection[component] = Math.min(alongA, alongB) - extent;
		maxProjection[component] = Math.max(alongA, alongB) + extent;
	}
	return new Box3(minProjection, maxProjection);
}

interface Shape { node: Mesh; name: string; local: Box3 }
const contains = (root: Object3D, node: Object3D) => { for (let n: Object3D | null = node; n; n = n.parent) if (n === root) return true; return false; };

/**
 * 对当前已加载的刚性网格做保守连续包围体检查。仅作为候选拒绝依据；
 * 未覆盖的旋转、自碰撞、模型误差和接触豁免保持未验证，不能产生正式发布证书。
 */
export function reviewCartesianCollision(manifest: TwinSceneManifest, trajectory: TwinJointTrajectory, scene: MotionSceneAccess,
	solver: ToolPoseSolver, payload?: { pickMatrix: Matrix4; ids: string[] }): CartesianCollisionReview {
	const review: CartesianCollisionReview = { method: 'joint-swept-aabb/1', status: 'unchecked', checkedPairs: 0,
		limitations: ['只覆盖当前加载刚性网格的世界包围体；未验证全部自碰撞、模型误差、净空公差及工艺接触豁免。'] };
	if (payload && trajectory.points.length !== 7) { review.limitations.push('持料检查要求完整六段取放链。'); return review; }
	const original = scene.getRoot(trajectory.actorObjectId);
	if (!original) return review;
	const shapes = (roots: Object3D[], exclude: (node: Object3D) => boolean = () => false) => {
		const result: Shape[] = [], visited = new Set<Object3D>();
		for (const root of roots) { root.updateWorldMatrix(true, true); root.traverse(node => {
			if (visited.has(node) || exclude(node)) return; visited.add(node);
			const mesh = node as Mesh;
			if (!mesh.isMesh) return;
			if ((mesh as any).isSkinnedMesh || (mesh as any).isInstancedMesh || mesh.morphTargetInfluences?.some(v => v !== 0)) { review.limitations.push(`网格 ${node.name || node.type} 含蒙皮、实例或形变，未检查。`); return; }
			if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
			const local = mesh.geometry.boundingBox;
			if (!local || local.isEmpty() || [...local.min.toArray(), ...local.max.toArray()].some(v => !Number.isFinite(v))) { review.limitations.push(`网格 ${node.name || node.type} 无有效包围体。`); return; }
			result.push({ node: mesh, name: node.name || node.type, local: local.clone() });
		}); }
		return result;
	};
	const roots = [...manifest.objects.map(o => scene.getRoot(o.objectId)).filter(Boolean) as Object3D[], ...scene.getRuntimeOwners(), ...(scene.getCollisionRoots?.() || [])];
	const payloadRoots: Object3D[] = [];
	const seen = new Set<Object3D>();
	for (const root of roots) root.traverse(node => { if (payload?.ids.includes(String(node.userData.twinEntityId)) && !seen.has(node)) { seen.add(node); payloadRoots.push(node); } });
	const moving = shapes([solver.root]);
	const environment = shapes(roots, node => contains(original, node) || payloadRoots.some(p => contains(p, node)));
	const carried = shapes(payloadRoots);
	const localPayload = carried.map(s => payload!.pickMatrix.clone().invert().multiply(s.node.matrixWorld));
	if (manifest.objects.some(o => !scene.getRoot(o.objectId))) review.limitations.push('部分场景对象尚未加载。');
	if (!moving.length) review.limitations.push('执行机构没有可检查的刚性网格。');
	if (payload && !carried.length) review.limitations.push('本批物料没有可检查的刚性网格。');
	if (!moving.length && !carried.length) return review;
	const world = environment.map(s => s.local.clone().applyMatrix4(s.node.matrixWorld));
	const rotaryAxes = solver.axes.filter(axis => axis.kind === 'rotary-joint');
	const snapshots = trajectory.points.map((point, i) => {
		solver.write(point.positions);
		const pose = solver.pose(), tcp = new Matrix4().compose(pose.position, pose.rotation, new Vector3(1, 1, 1));
		const boxes = moving.map(s => s.local.clone().applyMatrix4(s.node.matrixWorld));
		const rotary = rotaryAxes.map(axis => {
			const node = exactNode(solver.root, axis.nodePath), parent = node?.parent;
			if (!node || !parent || !axis.motionAxis) return undefined;
			const axisVector = new Vector3().setComponent(({ x: 0, y: 1, z: 2 } as const)[axis.motionAxis], 1);
			return { actuatorId: axis.actuatorId, node, pivot: node.getWorldPosition(new Vector3()), direction: axisVector.transformDirection(parent.matrixWorld).normalize() };
		});
		// 取料接触是第 2 个目标，放料接触是第 5 个目标；撤离时库存保留放置位姿。
		const materialMatrix = i < 2 ? payload?.pickMatrix : tcp;
		return { boxes, rotary, payloads: carried.map((s, j) => s.local.clone().applyMatrix4(materialMatrix!.clone().multiply(localPayload[j]))) };
	});
	if (payload && snapshots.length === 7) snapshots[6].payloads = snapshots[5].payloads.map(box => box.clone());
	const names = [...moving.map(s => s.name), ...carried.map(s => s.name)];
	let unsupportedSegment = false;
	for (let i = 1; i < snapshots.length; i++) {
		const start = [...snapshots[i - 1].boxes, ...snapshots[i - 1].payloads], end = [...snapshots[i].boxes, ...snapshots[i].payloads];
		const previous = trajectory.points[i - 1].positions, current = trajectory.points[i].positions;
		const changedRotary = rotaryAxes.filter(axis => { const index = trajectory.axisIds.indexOf(axis.actuatorId); return Math.abs(previous[index] - current[index]) > 1e-10; });
		const changedOther = solver.axes.filter(axis => axis.kind !== 'rotary-joint' || !changedRotary.includes(axis)).some(axis => {
			const index = trajectory.axisIds.indexOf(axis.actuatorId); return Math.abs(previous[index] - current[index]) > 1e-10;
		});
		if (changedRotary.length > 1 || (changedRotary.length === 1 && changedOther)) {
			review.limitations.push(`第 ${i} 段同时改变多个轴，当前扫掠界限无法保守包络该组合。`); unsupportedSegment = true; continue;
		}
		let rotationAxis: { pivot: Vector3; direction: Vector3; node: Object3D } | undefined;
		if (changedRotary.length === 1) {
			const actuatorId = changedRotary[0].actuatorId;
			const resolved = snapshots[i - 1].rotary.find(axis => axis?.actuatorId === actuatorId);
			if (!resolved) { review.limitations.push(`旋转轴 ${actuatorId} 缺少准确轴节点。`); unsupportedSegment = true; continue; }
			rotationAxis = resolved;
		}
		for (let m = 0; m < start.length; m++) {
			const isRotatingPayload = m >= moving.length && i >= 3 && i <= 5;
			const rotates = rotationAxis && (m < moving.length ? contains(rotationAxis.node, moving[m].node) : isRotatingPayload);
			const movingEnvelope = rotates
				? fullRevolutionEnvelope(start[m], rotationAxis!.pivot, rotationAxis!.direction) : start[m];
			// 抓取之前和释放之后，静止库存仍与运动中的机构做检查。
			const obstacleBoxes = [...world, ...(m < moving.length && (i <= 2 || i === 6) ? snapshots[i - 1].payloads : [])];
			for (let e = 0; e < obstacleBoxes.length; e++) {
				if (++review.checkedPairs > 200000) { review.status = 'unchecked'; review.limitations.push('碰撞检查预算耗尽。'); return review; }
				const collision = rotates
					? movingEnvelope.intersectsBox(obstacleBoxes[e])
					: translatingBoxesOverlap(start[m], end[m], obstacleBoxes[e], obstacleBoxes[e]);
				if (collision) {
					review.status = 'blocked'; review.conflict = { segment: i, moving: names[m], obstacle: environment[e]?.name || '本批物料' }; return review;
				}
			}
		}
	}
	if (unsupportedSegment || !moving.length || !review.checkedPairs) review.status = 'unchecked';
	else review.status = 'clear-within-scope';
	return review;
}
