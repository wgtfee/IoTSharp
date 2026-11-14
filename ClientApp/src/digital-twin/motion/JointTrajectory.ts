import type { TwinSceneManifest, TwinValidationDiagnostic } from '../contracts';

/** 轴单位沿用执行机构声明；每段采用端点速度、加速度均为零的五次曲线。 */
export interface TwinJointTrajectory {
	contractVersion: 'joint-trajectory/1';
	trajectoryId: string;
	name: string;
	actorObjectId: string;
	interpolation: 'quintic-stop';
	/** 当前产物只允许隔离仿真，不构成正式发布或现场执行证明。 */
	validation: 'simulation-only';
	testOnly?: boolean;
	dependencySnapshot: string;
	axisIds: string[];
	limits: Array<{ velocity: number; acceleration: number; jerk: number }>;
	points: Array<{ time: number; positions: number[] }>;
}

/** 对全部规划环境取保守快照；新增障碍或父级变换也会令旧产物失效。 */
export function motionDependencySnapshot(manifest: TwinSceneManifest): string {
	return JSON.stringify({ world: manifest.world, resources: manifest.resources || [], objects: manifest.objects || [], slots: manifest.materialSlots || [],
		tools: manifest.toolFrames || [], axes: manifest.actuators || [], routes: manifest.routes || [], bindings: manifest.bindings || [], interlocks: manifest.interlocks || [] });
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 检查最终执行曲线的行程及速度、加速度、加加速度解析上界，不将端点可达当作碰撞检查。 */
export function trajectoryErrors(value: TwinJointTrajectory, manifest: TwinSceneManifest): string[] {
	const errors: string[] = [];
	if (!value || typeof value !== 'object') return ['轨迹必须是对象。'];
	if (value.contractVersion !== 'joint-trajectory/1' || value.interpolation !== 'quintic-stop' || value.validation !== 'simulation-only') errors.push('轨迹版本、插值方式或验证范围不受支持。');
	if (typeof value.trajectoryId !== 'string' || !value.trajectoryId.trim() || typeof value.name !== 'string' || !value.name.trim()) errors.push('轨迹名称和标识不能为空。');
	if (manifest.objects.filter(o => o.objectId === value.actorObjectId).length !== 1) errors.push('轨迹必须引用唯一执行对象。');
	if (value.dependencySnapshot !== motionDependencySnapshot(manifest)) errors.push('场景依赖已变化，请重新生成轨迹。');
	if (!Array.isArray(value.axisIds) || !value.axisIds.length || value.axisIds.length > 16 || new Set(value.axisIds).size !== value.axisIds.length) return [...errors, '轨迹轴必须为 1 至 16 个不重复的执行轴。'];
	if (!Array.isArray(value.limits) || value.limits.length !== value.axisIds.length || value.limits.some(l => !l || !positive(l.velocity) || !positive(l.acceleration) || !positive(l.jerk))) return [...errors, '每个轴必须显式提供正的速度、加速度和加加速度约束。'];
	if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > 4096 || value.points.some(p => !p || !finite(p.time) || !Array.isArray(p.positions) || p.positions.length !== value.axisIds.length || !p.positions.every(finite))) return [...errors, '轨迹必须包含 2 至 4096 个有限的定时轴位置。'];
	if (value.points[0].time !== 0 || value.points.some((p, i) => i > 0 && p.time <= value.points[i - 1].time)) return [...errors, '轨迹时间必须从零开始且严格递增。'];
	for (const [axisIndex, id] of value.axisIds.entries()) {
		const matches = manifest.actuators?.filter(a => a.actuatorId === id) || [];
		const axis = matches[0];
		if (matches.length !== 1 || axis.objectId !== value.actorObjectId || !['linear-axis', 'rotary-joint'].includes(axis.kind) || !finite(axis.minValue) || !finite(axis.maxValue) || axis.minValue >= axis.maxValue) { errors.push(`执行轴 ${id} 缺少有效机构归属或有限行程。`); continue; }
		const limit = value.limits[axisIndex];
		if (!positive(axis.speed) || limit.velocity > axis.speed) errors.push(`执行轴 ${id} 的轨迹速度不能超过设备速度声明。`);
		for (const [i, point] of value.points.entries()) {
			if (point.positions[axisIndex] < axis.minValue || point.positions[axisIndex] > axis.maxValue) errors.push(`执行轴 ${id} 第 ${i + 1} 个目标超出行程。`);
			if (!i) continue;
			const previous = value.points[i - 1], duration = point.time - previous.time, distance = Math.abs(point.positions[axisIndex] - previous.positions[axisIndex]);
			// 五次 smoothstep 的导数峰值分别为 15/8、10/√3、60。
			if (1.875 * distance / duration > limit.velocity * (1 + 1e-10) || 10 / Math.sqrt(3) * distance / duration ** 2 > limit.acceleration * (1 + 1e-10) || 60 * distance / duration ** 3 > limit.jerk * (1 + 1e-10)) errors.push(`执行轴 ${id} 第 ${i} 段超过时间/轴约束。`);
		}
	}
	return errors;
}

/** 场景草稿允许保存合格的仿真轨迹，失效产物必须重新生成或移除。 */
export function validateJointTrajectories(manifest: TwinSceneManifest): TwinValidationDiagnostic[] {
	if (manifest.motionTrajectories === undefined) return [];
	if (!Array.isArray(manifest.motionTrajectories) || manifest.motionTrajectories.length > 256) return [{ severity: 'error', code: 'twin.motion.trajectory.invalid', message: '场景轨迹必须是最多 256 项的数组。', path: 'motionTrajectories' }];
	const ids = new Set<string>();
	return manifest.motionTrajectories.flatMap((trajectory, index) => {
		const errors = trajectoryErrors(trajectory, manifest);
		if (ids.has(trajectory?.trajectoryId)) errors.push('轨迹标识重复。');
		ids.add(trajectory?.trajectoryId);
		return errors.map(message => ({ severity: 'error' as const, code: 'twin.motion.trajectory.invalid', message, path: `motionTrajectories[${index}]` }));
	});
}

/** 与运行端共用的纯求值器；输入时间不依赖渲染帧率。调用前须通过合同检查。 */
export function evaluateJointTrajectory(trajectory: TwinJointTrajectory, seconds: number): number[] {
	if (!Number.isFinite(seconds)) throw new Error('轨迹求值时间必须有限。');
	const points = trajectory.points;
	if (seconds <= 0) return [...points[0].positions];
	const last = points[points.length - 1];
	if (seconds >= last.time) return [...last.positions];
	const endIndex = points.findIndex(p => p.time >= seconds), a = points[endIndex - 1], b = points[endIndex];
	const t = (seconds - a.time) / (b.time - a.time), s = t ** 3 * (10 + t * (-15 + 6 * t));
	return a.positions.map((v, i) => v + (b.positions[i] - v) * s);
}

export interface TrajectoryAxisPort {
	read: (axisId: string) => number | undefined;
	/** 原子校验后写入全部轴；失败时不能留下半帧运动。 */
	write: (actorId: string, targets: Array<{ actuatorId: string; value: number }>) => boolean;
}

/** 每次节点访问独立冻结产物、逻辑时钟；暂停或联锁等待时调用方不推进。 */
export class JointTrajectoryPlayer {
	private readonly trajectory: TwinJointTrajectory;
	private elapsed = 0;
	constructor(trajectory: TwinJointTrajectory, manifest: TwinSceneManifest, private readonly port: TrajectoryAxisPort) {
		const errors = trajectoryErrors(trajectory, manifest);
		if (errors.length) throw new Error(errors.join('；'));
		this.trajectory = JSON.parse(JSON.stringify(trajectory));
		this.assertPositions(this.trajectory.points[0].positions, '起始轴位置与轨迹不符，禁止跳转到起点');
	}
	private assertPositions(expected: number[], message: string) {
		if (this.trajectory.axisIds.some((id, i) => { const actual = this.port.read(id); return actual === undefined || !Number.isFinite(actual) || Math.abs(actual - expected[i]) > 1e-7; })) throw new Error(message);
	}
	advance(dt: number): boolean {
		if (!positive(dt)) throw new Error('轨迹步长必须为正的有限数值。');
		this.assertPositions(evaluateJointTrajectory(this.trajectory, this.elapsed), '执行轴被外部改写，轨迹停止');
		const next = Math.min(this.trajectory.points.at(-1)!.time, this.elapsed + dt);
		const values = evaluateJointTrajectory(this.trajectory, next);
		if (!this.port.write(this.trajectory.actorObjectId, this.trajectory.axisIds.map((actuatorId, i) => ({ actuatorId, value: values[i] })))) throw new Error('轨迹轴写入被拒绝');
		this.elapsed = next;
		return next >= this.trajectory.points.at(-1)!.time;
	}
}
