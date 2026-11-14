import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { TwinMaterialSlotDefinition, TwinSceneManifest } from '../contracts';
import type { SlotTargetContext } from './SlotToolTargetDeriver';

/** 严格解析唯一名称或逐层节点路径；模型缺项不能退回设备根节点。 */
export function exactNode(root: Object3D, path?: string): Object3D | undefined {
	if (!path) return root;
	if (path.includes('/')) return path.split('/').filter(Boolean).reduce<Object3D | undefined>((parent, name) => {
		const matches = parent?.children.filter(child => child.name === name) || [];
		return matches.length === 1 ? matches[0] : undefined;
	}, root);
	const matches: Object3D[] = [];
	root.traverse(node => { if (node.name === path) matches.push(node); });
	return matches.length === 1 ? matches[0] : undefined;
}

export interface MotionSceneAccess {
	getRoot: (objectId: string) => Object3D | undefined;
	/** 只枚举当前场景中真实存在的运行载体。 */
	getRuntimeOwners: () => Object3D[];
	/** 补充已释放等运行物料的根节点；编辑器辅助网格不能混入工艺障碍。 */
	getCollisionRoots?: () => Object3D[];
}

/** 从已绑定工位批次解析完整槽位快照；不猜测最近载体，不更改库存或模型。 */
export function createSlotTargetContext(manifest: TwinSceneManifest, slot: TwinMaterialSlotDefinition, scene: MotionSceneAccess): SlotTargetContext {
	const resolveAnchorWorld = (objectId: string, path?: string) => {
		const root = scene.getRoot(objectId), node = root && exactNode(root, path);
		if (!node) return undefined;
		node.updateWorldMatrix(true, false);
		return node.matrixWorld.clone();
	};
	const context: SlotTargetContext = { resolveAnchorWorld };
	if (!(slot.runtimeOwnerType || slot.stackPattern || slot.stackPatternSlotId || slot.metadata?.contactFromMaterials)) return context;
	if (slot.runtimeOwnerSelection === 'nearest') throw new Error(`槽位“${slot.name}”需要工位批次绑定，不能按最近距离取载体。`);
	const root = scene.getRoot(slot.objectId);
	if (!root) throw new Error(`槽位“${slot.name}”的设备尚未加载。`);
	const patternSlot = slot.stackPatternSlotId ? manifest.materialSlots?.find(s => s.slotId === slot.stackPatternSlotId) : slot;
	if (slot.stackPatternSlotId && !patternSlot?.stackPattern) throw new Error('隔板槽位缺少对应的码垛配方。');
	let owners = [root];
	if (slot.runtimeOwnerType) {
		const bindingRoot = patternSlot ? scene.getRoot(patternSlot.objectId) : root;
		const ids: unknown = bindingRoot?.userData.stationPalletIds;
		if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error(`槽位“${slot.name}”尚无明确工位批次。`);
		owners = ids.map(id => {
			const matches = scene.getRuntimeOwners().filter(o => o.userData.twinEntityId === id && o.userData.transportUnitType === slot.runtimeOwnerType);
			if (matches.length !== 1) throw new Error(`槽位“${slot.name}”绑定的载体缺失或身份重复。`);
			return matches[0];
		});
		if (owners.length > 1 && !slot.distributePayloadAcrossRuntimeOwners) throw new Error(`槽位“${slot.name}”存在多个载体，必须明确成组工艺。`);
	}
	const anchors = owners.map(owner => {
		const node = exactNode(owner, slot.runtimeOwnerType ? slot.runtimeOwnerNodePath : slot.nodePath);
		if (!node) throw new Error(`槽位“${slot.name}”的准确参考节点不存在。`);
		node.updateWorldMatrix(true, false);
		return node;
	});
	const world = anchors[0].matrixWorld.clone();
	// 成组载体共用一个 TCP 朝向，不能悄悄沿用第一个载体掩盖其余载体的旋转/缩放。
	if (anchors.some(anchor => anchor.matrixWorld.elements.some((value, i) => ![12, 13, 14].includes(i) && Math.abs(value - world.elements[i]) > 1e-8))) throw new Error('成组载体的参考朝向或缩放不一致，不能派生共同抓取姿态。');
	const slotRotation = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromEuler(new Euler(...(slot.localRotation || [0, 0, 0]), 'XYZ')));
	const position = new Vector3();
	const materials: Object3D[] = [];
	if (slot.role === 'source' && slot.metadata?.contactFromMaterials) {
		const group = slot.metadata.entityGroup || root.userData.activeMaterialGroup;
		for (const owner of owners) owner.traverse(node => {
			if (node.userData.materialEntity && !node.userData.materialAttachedBy && node.userData.payloadType === slot.payloadType && (!group || node.userData.materialSlotGroup === group)) materials.push(node);
		});
		const count = Number(slot.metadata.contactBatchSize ?? slot.capacity);
		if (!Number.isInteger(count) || count <= 0 || materials.length < count) throw new Error(`槽位“${slot.name}”缺少声明数量的可取物料。`);
		materials.sort((a, b) => Number(a.userData.materialGridRow || 0) - Number(b.userData.materialGridRow || 0) || Number(a.userData.materialGridColumn || 0) - Number(b.userData.materialGridColumn || 0) || String(a.userData.twinEntityId).localeCompare(String(b.userData.twinEntityId)));
		materials.splice(count);
		if (materials.some(m => !m.userData.twinEntityId) || new Set(materials.map(m => m.userData.twinEntityId)).size !== materials.length) throw new Error('来源物料需要唯一身份。');
		for (const material of materials) position.add(material.getWorldPosition(new Vector3()));
		position.divideScalar(materials.length);
		const surfaceOffset = slot.metadata.contactSurfaceOffset;
		if (typeof surfaceOffset !== 'number' || !Number.isFinite(surfaceOffset) || !slot.contactNormalLocal) throw new Error('物料接触面必须明确声明偏移和外法向。');
		position.addScaledVector(new Vector3(...slot.contactNormalLocal).transformDirection(world.clone().multiply(slotRotation)), surfaceOffset);
	} else if (patternSlot?.stackPattern) {
		if (anchors.length !== 1) throw new Error('码垛层位必须绑定唯一托盘。');
		const p = patternSlot.stackPattern, count = Number(anchors[0].userData.stackItemCount ?? 0), boardCount = Number(anchors[0].userData.stackLayerMaterialCount ?? 0);
		const perLayer = p.rows * p.columns;
		if (![count, boardCount].every(n => Number.isInteger(n) && n >= 0) || count % perLayer !== 0) throw new Error('当前码垛库存不是完整层边界，需先完成恢复。');
		const allowedBoards = p.separatorMode === 'none' ? 0 : p.separatorMode === 'between-layers' ? Math.max(0, p.layers - 1) : p.separatorMode === 'every-layer' || p.layerMaterialRequired ? p.layers : 0;
		if (count > perLayer * p.layers || boardCount > Math.min(count / perLayer, allowedBoards)) throw new Error('托盘主物料与隔板库存不符合配方，不能恢复运行。');
		const level = slot.stackPatternSlotId ? boardCount : count / perLayer;
		const layerLimit = slot.stackPatternSlotId ? p.separatorMode === 'none' ? 0 : p.separatorMode === 'between-layers' ? Math.max(0, p.layers - 1) : p.layers : p.layers;
		if (level >= layerLimit) throw new Error('当前托盘已满，需换托后重新规划。');
		if (slot.stackPatternSlotId && count < (boardCount + 1) * perLayer) throw new Error('当前主物料层尚未完成，不能规划隔板。');
		if (!slot.stackPatternSlotId && level > 0 && (p.separatorMode === 'between-layers' || p.separatorMode === 'every-layer' || (!p.separatorMode && p.layerMaterialRequired)) && boardCount < level) throw new Error('上一层隔板未完成，不能规划下一层主物料。');
		position.set((p.originX ?? 0) + (p.columns - 1) * p.spacingX / 2,
			p.firstLayerY + level * p.layerPitch + (slot.stackPatternSlotId ? (p.layerMaterialOffsetY ?? 0) + (p.separatorThickness ?? 0) / 2 : 0),
			(p.originZ ?? 0) + (p.rows - 1) * p.spacingZ / 2).applyMatrix4(world);
	} else {
		for (const anchor of anchors) position.add(anchor.getWorldPosition(new Vector3()));
		position.divideScalar(anchors.length);
	}
	// 动态位置已是完整槽位原点；旋转仍按明确的槽位朝向组合，保留缩放供派生器拒绝。
	world.setPosition(position).multiply(slotRotation);
	const ownerIds = owners.map(o => String(o.userData.twinEntityId || slot.objectId));
	context.resolvedSlotFrame = { slotId: slot.slotId, ownerId: JSON.stringify(ownerIds), ownerIds, materialIds: materials.map(m => String(m.userData.twinEntityId)),
		stateRevision: JSON.stringify({ owners: owners.map((o, i) => [o.userData.twinEntityId, o.userData.completedBatchCount, anchors[i].userData.stackItemCount, anchors[i].userData.stackLayerMaterialCount, anchors[i].matrixWorld.elements]), materials: materials.map(m => { m.updateWorldMatrix(true, false); return [m.userData.twinEntityId, m.matrixWorld.elements]; }), matrix: world.elements }), worldMatrix: world };
	return context;
}
