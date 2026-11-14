import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { TwinSceneManifest, TwinVector3 } from '../contracts';
import { finiteTargetVector, validateSlotToolTargets } from '../contracts/slot-tool-targets';

export interface SlotTargetContext {
	/** 必须解析准确的对象/子节点；找不到时返回 undefined，禁止退回根节点。 */
	resolveAnchorWorld: (objectId: string, nodePath?: string) => Matrix4 | undefined;
	/** 动态槽位由调用方绑定本批身份与状态，并提供已经解析的完整槽位坐标系。 */
	resolvedSlotFrame?: { slotId: string; ownerId: string; ownerIds?: string[]; materialIds?: string[]; stateRevision: string; worldMatrix: Matrix4 };
}

export interface DerivedSlotToolTarget {
	candidateId: string;
	slotId: string;
	templateId: string;
	toolFrameId: string;
	status: 'geometry-only';
	/** 仅用于输入变化比较和诊断，不是签名或发布授权。 */
	inputSignature: string;
	ownerId?: string;
	stateRevision?: string;
	contact: TwinVector3;
	approach: TwinVector3;
	retreat: TwinVector3;
	/** 世界坐标下的 TCP 姿态，四元数顺序 x/y/z/w。 */
	tcpQuaternion: [number, number, number, number];
	approachDirection: TwinVector3;
	checks: { kinematics: 'unchecked'; collision: 'unchecked'; timing: 'unchecked'; handoff: 'unchecked' };
}

export class SlotTargetDerivationError extends Error {
	constructor(public readonly code: string, message: string) { super(message); this.name = 'SlotTargetDerivationError'; }
}

export interface SlotToolTargetCandidates {
	status: 'geometry-only';
	candidates: DerivedSlotToolTarget[];
	rejected: Array<{ templateId: string; code: string; message: string }>;
}

/** 按稳定标识枚举指定工具的全部候选；单个几何候选失败不会隐藏其余候选。 */
export function deriveSlotToolTargetCandidates(manifest: TwinSceneManifest, slotId: string, toolFrameId: string, context: SlotTargetContext): SlotToolTargetCandidates {
	const slots = (manifest.materialSlots || []).filter(slot => slot.slotId === slotId);
	if (slots.length !== 1) throw new SlotTargetDerivationError('slot.invalid', '需要唯一的来源或目标槽位。');
	const diagnostics = validateSlotToolTargets({ ...manifest, materialSlots: slots });
	if (diagnostics.length) throw new SlotTargetDerivationError(diagnostics[0].code, diagnostics[0].message);
	const templates = (slots[0].toolTargets || []).filter(target => target.toolFrameId === toolFrameId)
		.slice().sort((a, b) => a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0);
	if (!templates.length) throw new SlotTargetDerivationError('definition.missing', '该槽位没有适用于所选工具的取放候选。');
	const result: SlotToolTargetCandidates = { status: 'geometry-only', candidates: [], rejected: [] };
	for (const target of templates) {
		try { result.candidates.push(deriveSlotToolTarget(manifest, slotId, target.templateId, context)); }
		catch (error) {
			if (!(error instanceof SlotTargetDerivationError)) throw error;
			result.rejected.push({ templateId: target.templateId, code: error.code, message: error.message });
		}
	}
	return result;
}

/** 第一版只接受刚体坐标系，避免缩放、镜像、剪切改变米制距离和方向。 */
function assertRigid(matrix: Matrix4) {
	const e = matrix.elements;
	const axes = [new Vector3(e[0], e[1], e[2]), new Vector3(e[4], e[5], e[6]), new Vector3(e[8], e[9], e[10])];
	const tolerance = 1e-8; // 数值正交误差，不作为工艺净空或接触容差。
	if (e.length !== 16 || !e.every(Number.isFinite) || Math.abs(e[3]) > tolerance || Math.abs(e[7]) > tolerance || Math.abs(e[11]) > tolerance || Math.abs(e[15] - 1) > tolerance || axes.some(axis => Math.abs(axis.lengthSq() - 1) > tolerance) || Math.abs(axes[0].dot(axes[1])) > tolerance || Math.abs(axes[0].dot(axes[2])) > tolerance || Math.abs(axes[1].dot(axes[2])) > tolerance || Math.abs(matrix.determinant() - 1) > tolerance) {
		throw new SlotTargetDerivationError('transform.unsupported', '自动派生暂只支持无缩放、无镜像、无剪切的刚体坐标系。');
	}
}

/** 避免 Three.js 默认平方求模在极大或极小有限方向上溢出/下溢。 */
function unitDirection(value: TwinVector3) {
	const length = Math.hypot(...value);
	return new Vector3(value[0] / length, value[1] / length, value[2] / length);
}

/** 从明确的模板候选派生世界位置；不修改场景、不创建动作、不写执行轴。 */
export function deriveSlotToolTarget(manifest: TwinSceneManifest, slotId: string, templateId: string, context: SlotTargetContext): DerivedSlotToolTarget {
	const slots = (manifest.materialSlots || []).filter(slot => slot.slotId === slotId);
	if (slots.length !== 1) throw new SlotTargetDerivationError('slot.invalid', '需要唯一的来源或目标槽位。');
	const slot = slots[0];
	const diagnostics = validateSlotToolTargets({ ...manifest, materialSlots: [slot] });
	if (diagnostics.length) throw new SlotTargetDerivationError(diagnostics[0].code, diagnostics[0].message);
	const target = slot.toolTargets?.find(item => item.templateId === templateId);
	if (!target) throw new SlotTargetDerivationError('definition.missing', '槽位尚未声明指定的工具取放候选。');
	const frame = manifest.toolFrames!.find(item => item.toolFrameId === target.toolFrameId)!;
	if (manifest.world.unit !== 'meter' || manifest.world.upAxis !== 'Y') throw new SlotTargetDerivationError('world.unsupported', '派生使用米制、Y 向上的场景坐标约定。');
	if (![slot.objectId, frame.objectId].every(id => manifest.objects.filter(object => object.objectId === id).length === 1)) throw new SlotTargetDerivationError('object.invalid', '槽位或工具引用的对象不存在或不唯一。');
	if (!finiteTargetVector(slot.localPosition) || (slot.localRotation !== undefined && !finiteTargetVector(slot.localRotation))) throw new SlotTargetDerivationError('slot.pose.invalid', '槽位位姿必须是有限的局部坐标。');
	if (!frame.nodePath?.trim() || (frame.localPosition !== undefined && !finiteTargetVector(frame.localPosition)) || (frame.localRotation !== undefined && !finiteTargetVector(frame.localRotation))) throw new SlotTargetDerivationError('tool.pose.invalid', '工具需要明确节点路径和有效的 TCP 位姿。');
	const dynamic = Boolean(slot.runtimeOwnerType || slot.stackPattern || slot.stackPatternSlotId || slot.metadata?.contactFromMaterials);
	let world: Matrix4;
	if (dynamic) {
		const binding = context.resolvedSlotFrame;
		if (slot.runtimeOwnerSelection === 'nearest' || !binding || binding.slotId !== slot.slotId || !binding.ownerId?.trim() || !binding.stateRevision?.trim()) throw new SlotTargetDerivationError('binding.required', '动态槽位需要本批明确的载体身份、状态版本和槽位坐标系，不能选择最近对象。');
		world = binding.worldMatrix.clone();
	} else {
		const anchor = context.resolveAnchorWorld(slot.objectId, slot.nodePath);
		if (!anchor) throw new SlotTargetDerivationError('anchor.missing', '找不到槽位声明的对象或子节点。');
		assertRigid(anchor);
		world = anchor.clone().multiply(new Matrix4().compose(new Vector3(...slot.localPosition), new Quaternion().setFromEuler(new Euler(...(slot.localRotation || [0, 0, 0]), 'XYZ')), new Vector3(1, 1, 1)));
	}
	assertRigid(world);
	const rotation = new Quaternion().setFromRotationMatrix(world).multiply(new Quaternion().setFromEuler(new Euler(...target.tcpRotation, 'XYZ'))).normalize();
	const normal = unitDirection(slot.contactNormalLocal!).transformDirection(world);
	// 与现有接触约定一致：TCP 坐标下的接近方向经过 TCP 目标姿态后指向工件。
	const direction = unitDirection(frame.approachDirectionLocal!).applyQuaternion(rotation);
	if (direction.dot(normal) > -1 + 1e-8) throw new SlotTargetDerivationError('orientation.incompatible', '候选 TCP 接近方向必须与槽位接触外法向相反。');
	const contact = new Vector3(...target.tcpOffset).applyMatrix4(world);
	const approach = contact.clone().addScaledVector(normal, target.approachDistance);
	const retreat = contact.clone().addScaledVector(normal, target.retreatDistance);
	if (![...contact.toArray(), ...approach.toArray(), ...retreat.toArray()].every(Number.isFinite)) throw new SlotTargetDerivationError('position.overflow', '派生位置超出有限数值范围。');
	const binding = dynamic ? context.resolvedSlotFrame : undefined;
	return {
		candidateId: `${encodeURIComponent(slotId)}/${encodeURIComponent(templateId)}`,
		slotId, templateId, toolFrameId: frame.toolFrameId, status: 'geometry-only',
		inputSignature: JSON.stringify({ version: 'slot-tool-target/1', slot, target, tool: frame, world: world.elements, ownerId: binding?.ownerId, stateRevision: binding?.stateRevision }),
		ownerId: binding?.ownerId, stateRevision: binding?.stateRevision,
		contact: contact.toArray(), approach: approach.toArray(), retreat: retreat.toArray(), tcpQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w], approachDirection: direction.toArray(),
		checks: { kinematics: 'unchecked', collision: 'unchecked', timing: 'unchecked', handoff: 'unchecked' },
	};
}
