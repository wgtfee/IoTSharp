import type { TwinSceneManifest } from '../../contracts';

/** 物料条件使用只读命名空间，不能由 SetState 伪造夹紧、库存或接触信号。 */
export const materialStateRef = (kind: string, ...parts: string[]) => ['material', kind, ...parts.map(encodeURIComponent)].join('/');
export const parseMaterialStateRef = (ref: string): string[] | undefined => {
	if (!ref.startsWith('material/')) return undefined;
	try { return ref.split('/').slice(1).map(decodeURIComponent); } catch { return []; }
};
export function validMaterialStateRef(ref: string, manifest: TwinSceneManifest): boolean {
	const parts = parseMaterialStateRef(ref); if (!parts) return true;
	const [kind, id, field, extra] = parts;
	if (kind === 'slot') return parts.length === 3 && Boolean(manifest.materialSlots?.some(s => s.slotId === id)) && ['present','availableCount','freeCapacity','occupied'].includes(field);
	if (kind === 'tool') return parts.length === 3 && Boolean(manifest.toolFrames?.some(f => f.toolFrameId === id)) && ['empty','heldCount'].includes(field);
	if (kind === 'gripper') return parts.length === 3 && Boolean(manifest.actuators?.some(a => a.actuatorId === id && a.kind === 'gripper')) && field === 'closed';
	return kind === 'contact' && parts.length === 4 && extra === 'ready' && Boolean(manifest.toolFrames?.some(f => f.toolFrameId === id)) && Boolean(manifest.materialSlots?.some(s => s.slotId === field));
}
/** 编辑器只列出当前清单中存在的状态引用，标签用业务名称。 */
export function materialStateOptions(manifest: TwinSceneManifest) {
	const result: Array<{ value: string; label: string }> = [];
	for (const slot of manifest.materialSlots || []) for (const [field, label] of [['present','载体已到位'],['availableCount','可取物料数'],['freeCapacity','剩余容量'],['occupied','已有物料']])
		result.push({ value: materialStateRef('slot', slot.slotId, field), label: `${slot.name} · ${label}` });
	for (const frame of manifest.toolFrames || []) {
		for (const [field,label] of [['empty','工具空闲'],['heldCount','挂载数量']]) result.push({ value: materialStateRef('tool',frame.toolFrameId,field), label: `${frame.name} · ${label}` });
		for (const slot of manifest.materialSlots || []) result.push({ value: materialStateRef('contact',frame.toolFrameId,slot.slotId,'ready'), label: `${frame.name} → ${slot.name} · 接触到位` });
	}
	for (const axis of manifest.actuators || []) if (axis.kind === 'gripper') result.push({ value: materialStateRef('gripper',axis.actuatorId,'closed'), label: `${axis.name} · 已夹紧` });
	return result;
}
