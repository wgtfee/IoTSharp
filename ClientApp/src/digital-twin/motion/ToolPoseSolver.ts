import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { TwinActuatorDefinition, TwinSceneManifest, TwinToolFrameDefinition } from '../contracts';
import { readActuatorNodeValue, writeActuatorNodeValue } from '../runtime/ActuatorRuntime';
import { exactNode } from './SceneSlotResolver';

const rotationVector = (q: Quaternion) => {
	q.normalize();
	if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
	const length = Math.hypot(q.x, q.y, q.z), angle = 2 * Math.atan2(length, q.w);
	return length < 1e-12 ? [0, 0, 0] : [q.x * angle / length, q.y * angle / length, q.z * angle / length];
};

/** 小型带主元线性求解；奇异候选返回 undefined，不能伪造可达结果。 */
function solve(matrix: number[][], right: number[]): number[] | undefined {
	const a = matrix.map((row, i) => [...row, right[i]]), n = right.length;
	for (let i = 0; i < n; i++) {
		let pivot = i;
		for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
		if (Math.abs(a[pivot][i]) < 1e-14) return undefined;
		[a[i], a[pivot]] = [a[pivot], a[i]];
		const scale = a[i][i]; for (let k = i; k <= n; k++) a[i][k] /= scale;
		for (let j = 0; j < n; j++) if (j !== i) { const factor = a[j][i]; for (let k = i; k <= n; k++) a[j][k] -= factor * a[i][k]; }
	}
	return a.map(row => row[n]);
}

/** 使用模型真实父子链和轴声明进行离线数值 IK；全部计算只操作独立克隆。 */
export class ToolPoseSolver {
	readonly axes: TwinActuatorDefinition[];
	readonly root: Object3D;
	private readonly nodes: Object3D[];
	private readonly tool: Object3D;
	constructor(manifest: TwinSceneManifest, original: Object3D, private readonly frame: TwinToolFrameDefinition) {
		original.updateWorldMatrix(true, true);
		this.root = original.clone(true);
		original.matrixWorld.decompose(this.root.position, this.root.quaternion, this.root.scale);
		this.root.updateMatrixWorld(true);
		const tool = exactNode(this.root, frame.nodePath);
		if (!tool) throw new Error('工具 TCP 节点缺失或重名。');
		this.tool = tool;
		const ancestors = new Set<Object3D>(); let node: Object3D | null = tool;
		while (node) { ancestors.add(node); node = node.parent; }
		if ([...ancestors].some(n => n.scale.toArray().some(s => Math.abs(s - 1) > 1e-8))) throw new Error('运动链不支持缩放或镜像，请先完成模型标定。');
		this.axes = (manifest.actuators || []).filter(a => a.objectId === frame.objectId && ['linear-axis', 'rotary-joint'].includes(a.kind) && (frame.cartesianActuatorIds ? frame.cartesianActuatorIds.includes(a.actuatorId) : true));
		if (!this.axes.length || this.axes.length > 16) throw new Error('工具缺少受支持的实际执行轴。');
		this.nodes = this.axes.map(axis => {
			const axisNode = exactNode(this.root, axis.nodePath);
			if (!axisNode || !ancestors.has(axisNode) || !axis.motionAxis || !Number.isFinite(axis.minValue) || !Number.isFinite(axis.maxValue) || axis.minValue! >= axis.maxValue!) throw new Error(`执行轴“${axis.name}”需要准确的运动链、方向和有限行程。`);
			return axisNode;
		});
		if (new Set(this.nodes.map((node, i) => `${node.uuid}/${this.axes[i].kind}/${this.axes[i].motionAxis}`)).size !== this.nodes.length) throw new Error('多个执行轴不能改写同一节点的同一自由度。');
	}
	read(): number[] { return this.axes.map((axis, i) => readActuatorNodeValue(this.nodes[i][axis.kind === 'rotary-joint' ? 'rotation' : 'position'][axis.motionAxis!], axis)); }
	write(values: number[]) {
		this.axes.forEach((axis, i) => { this.nodes[i][axis.kind === 'rotary-joint' ? 'rotation' : 'position'][axis.motionAxis!] = writeActuatorNodeValue(values[i], axis); });
		this.root.updateMatrixWorld(true);
	}
	pose() {
		const matrix = this.tool.matrixWorld.clone().multiply(new Matrix4().compose(new Vector3(...(this.frame.localPosition || [0, 0, 0])), new Quaternion().setFromEuler(new Euler(...(this.frame.localRotation || [0, 0, 0]), 'XYZ')), new Vector3(1, 1, 1)));
		return { position: new Vector3().setFromMatrixPosition(matrix), rotation: new Quaternion().setFromRotationMatrix(matrix).normalize() };
	}
	/** 按当前克隆姿态起步，收敛后再次检查全部六维误差；失败不返回近似成功。 */
	solve(position: number[], quaternion: number[]): number[] {
		const target = new Vector3(...position), rotation = new Quaternion(...quaternion).normalize();
		let values = this.read();
		for (let iteration = 0; iteration < 240; iteration++) {
			this.write(values);
			const current = this.pose(), dp = target.clone().sub(current.position), dr = rotationVector(rotation.clone().multiply(current.rotation.clone().invert()));
			if (dp.length() <= 1e-5 && Math.hypot(...dr) <= 1e-5) return values;
			const error = [...dp.toArray(), ...dr], columns: number[][] = [];
			for (let axisIndex = 0; axisIndex < values.length; axisIndex++) {
				const axis = this.axes[axisIndex], h = axis.unit === 'degree' ? 0.001 : axis.unit === 'millimeter' ? 0.01 : 1e-5;
				const perturbed = [...values]; perturbed[axisIndex] += h; this.write(perturbed);
				const next = this.pose(), p = next.position.sub(current.position).multiplyScalar(1 / h), r = rotationVector(next.rotation.multiply(current.rotation.clone().invert())).map(v => v / h);
				columns.push([...p.toArray(), ...r]);
			}
			const normal = columns.map((a, i) => columns.map((b, j) => a.reduce((sum, v, k) => sum + v * b[k], 0) + (i === j ? 1e-8 : 0)));
			const delta = solve(normal, columns.map(column => column.reduce((sum, v, k) => sum + v * error[k], 0)));
			if (!delta || delta.some(v => !Number.isFinite(v))) break;
			values = values.map((value, i) => Math.max(this.axes[i].minValue!, Math.min(this.axes[i].maxValue!, value + Math.max(-(this.axes[i].maxValue! - this.axes[i].minValue!) / 8, Math.min((this.axes[i].maxValue! - this.axes[i].minValue!) / 8, delta[i])))));
		}
		throw new Error('目标位置或姿态无法由当前实际轴及行程实现，未生成运动。');
	}
}
