import type { TwinValidationDiagnostic, TwinSceneManifest, TwinVector3 } from './index';

/** 槽位模板中的 TCP 候选；米、弧度、XYZ 欧拉角，相对槽位完整坐标系。 */
export interface TwinSlotToolTargetDefinition {
	contractVersion: 'slot-tool-target/1';
	templateId: string;
	toolFrameId: string;
	payloadType: string;
	/** TCP 在槽位坐标系中的位置，不是夹具根节点位置。 */
	tcpOffset: TwinVector3;
	tcpRotation: TwinVector3;
	/** 沿接触外法向的接近/退出距离，由模板显式提供。 */
	approachDistance: number;
	retreatDistance: number;
}

export const finiteTargetVector = (value: unknown): value is TwinVector3 =>
	Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));

/** 方向只要求有限、非零，求值时归一化，不接受零向量和溢出长度。 */
export const validTargetDirection = (value: unknown): value is TwinVector3 =>
	finiteTargetVector(value) && Math.hypot(...value) > 0 && Number.isFinite(Math.hypot(...value));

/** 校验显式启用的模板；旧槽位未声明 toolTargets 时保持原校验语义。 */
export function validateSlotToolTargets(manifest: TwinSceneManifest): TwinValidationDiagnostic[] {
	const diagnostics: TwinValidationDiagnostic[] = [];
	const add = (kind: string, message: string, path: string) => diagnostics.push({ severity: 'error', code: `twin.motion.target.${kind}`, message, path });
	const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
	for (const [slotIndex, slot] of (manifest.materialSlots || []).entries()) {
		const pattern = slot.stackPattern;
		if (pattern?.separatorMode !== undefined && (!['none', 'between-layers', 'every-layer'].includes(pattern.separatorMode) || [pattern.rows, pattern.columns, pattern.layers].some(v => !Number.isInteger(v) || v < 1) || pattern.layers > 64 || [pattern.spacingX, pattern.spacingZ, pattern.layerPitch].some(v => !Number.isFinite(v) || v <= 0) || !Number.isFinite(pattern.firstLayerY) || (pattern.separatorMode !== 'none' && [pattern.separatorThickness, pattern.layerMaterialOffsetY].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)))) add('stack.invalid', '码垛配方需要有效的层数、格位、间距、层高及显式隔板参数。', `materialSlots[${slotIndex}].stackPattern`);
		if (slot.toolTargets === undefined) continue;
		const path = `materialSlots[${slotIndex}].toolTargets`;
		if (!Array.isArray(slot.toolTargets) || slot.toolTargets.length > 32) { add('list.invalid', '取放候选必须是最多 32 项的数组。', path); continue; }
		if (!slot.toolTargets.length) continue;
		if (!validTargetDirection(slot.contactNormalLocal)) add('normal.invalid', '自动派生需要有限且非零的槽位接触外法向。', `materialSlots[${slotIndex}].contactNormalLocal`);
		const ids = new Set<string>();
		for (const [index, target] of slot.toolTargets.entries()) {
			const itemPath = `${path}[${index}]`;
			if (!target || typeof target !== 'object' || Array.isArray(target)) { add('definition.invalid', '取放候选必须是对象。', itemPath); continue; }
			if (target.contractVersion !== 'slot-tool-target/1') add('version.invalid', '不支持的取放候选合同版本。', `${itemPath}.contractVersion`);
			if (!text(target.templateId) || ids.has(target.templateId)) add('id.invalid', '同一槽位的候选标识必须非空且唯一。', `${itemPath}.templateId`);
			ids.add(target.templateId);
			const frames = (manifest.toolFrames || []).filter(frame => frame.toolFrameId === target.toolFrameId);
			const frame = frames.length === 1 ? frames[0] : undefined;
			if (!text(target.toolFrameId) || !frame) add('tool.invalid', '取放候选必须引用唯一的工具 TCP。', `${itemPath}.toolFrameId`);
			else if (!validTargetDirection(frame.approachDirectionLocal)) add('approach.invalid', '自动派生需要有限且非零的工具接近方向。', `${itemPath}.toolFrameId`);
			if (!text(target.payloadType) || target.payloadType !== slot.payloadType || (frame && (!Array.isArray(frame.payloadTypes) || !frame.payloadTypes.includes(target.payloadType)))) add('payload.invalid', '候选物料必须与槽位和工具显式允许的物料一致。', `${itemPath}.payloadType`);
			for (const key of ['tcpOffset', 'tcpRotation'] as const) if (!finiteTargetVector(target[key])) add(`${key}.invalid`, 'TCP 位姿必须是三个有限数值。', `${itemPath}.${key}`);
			for (const key of ['approachDistance', 'retreatDistance'] as const) if (typeof target[key] !== 'number' || !Number.isFinite(target[key]) || target[key] <= 0) add(`${key}.invalid`, '接近和退出距离必须显式配置为正的有限米数。', `${itemPath}.${key}`);
		}
	}
	return diagnostics;
}
