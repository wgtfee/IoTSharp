import type { TwinSceneManifest } from '../contracts';
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { TwinActionFlowDefinitionV2 } from '../action-flow/contracts/action-flow-v2';
import { createSlotTargetContext, exactNode, type MotionSceneAccess } from './SceneSlotResolver';
import { deriveSlotToolTargetCandidates, type DerivedSlotToolTarget } from './SlotToolTargetDeriver';
import { motionDependencySnapshot, trajectoryErrors, type TwinJointTrajectory } from './JointTrajectory';
import { ToolPoseSolver } from './ToolPoseSolver';
import { reviewCartesianCollision, type CartesianCollisionReview } from './CartesianCollisionReview';

export interface PickPlaceRequest {
	taskId: string;
	name: string;
	sourceSlotId: string;
	targetSlotId: string;
	toolFrameId: string;
	transferMaterials?: boolean;
	payloadCount?: number;
	palletRecipeId?: string;
	expectedLayer?: number;
	/** 实际轴单位每秒平方、每秒立方，由工艺维护者显式配置。 */
	axisLimits: Record<string, { velocity: number; acceleration: number; jerk: number }>;
}
export interface PickPlacePreview {
	request: PickPlaceRequest;
	dependencySnapshot: string;
	pick: DerivedSlotToolTarget;
	place: DerivedSlotToolTarget;
	trajectory?: TwinJointTrajectory;
	collisionReview?: CartesianCollisionReview;
	transfer?: { gripperActuatorId: string; pickPayloads: Array<{ entityId: string; worldMatrix: number[] }>; placePayloads: Array<{ entityId: string; worldMatrix: number[] }> };
	rejections: Array<{ candidate: string; reason: string }>;
	checks: { geometry: 'passed'; kinematics: 'passed' | 'unchecked'; timing: 'passed' | 'unchecked'; collision: 'partial' | 'unchecked'; handoff: 'unchecked' };
}

export const plannedTransferSteps = ['approach', 'close', 'attach', 'carry', 'detach', 'retreat'] as const;

/** 不依赖运行快照的工艺卡检查，供编辑器、编译器与运行入口共用。 */
export function pickPlaceRequestErrors(manifest: TwinSceneManifest, value: unknown): string[] {
	const request = value as PickPlaceRequest;
	if (!request || typeof request !== 'object' || typeof request.taskId !== 'string' || !request.taskId.trim() || typeof request.name !== 'string' || !request.name.trim()) return ['工艺名称及标识不能为空。'];
	const source = manifest.materialSlots?.find(s => s.slotId === request.sourceSlotId), target = manifest.materialSlots?.find(s => s.slotId === request.targetSlotId), tool = manifest.toolFrames?.find(f => f.toolFrameId === request.toolFrameId);
	if (!source || !target || source === target || source.role !== 'source' || !['target', 'stack', 'buffer', 'fixture'].includes(target.role) || !tool || !source.payloadType || source.payloadType !== target.payloadType || !tool.payloadTypes?.includes(source.payloadType)) return ['来源、目标、工具或物料声明不兼容。'];
	if (!source.toolTargets?.some(t => t.toolFrameId === tool.toolFrameId) || !target.toolTargets?.some(t => t.toolFrameId === tool.toolFrameId)) return ['来源和目标均需要所选工具的取放候选。'];
	if (request.transferMaterials !== true || !Number.isInteger(request.payloadCount) || request.payloadCount! < 1 || request.payloadCount! > 99) return ['按批次规划需要明确物料交接及本批数量。'];
	if (request.palletRecipeId !== undefined && (typeof request.palletRecipeId !== 'string' || !request.palletRecipeId.trim())) return ['整托配方引用不能为空。'];
	if (request.expectedLayer !== undefined && (!Number.isInteger(request.expectedLayer) || request.expectedLayer < 0 || request.expectedLayer > 63 || !request.palletRecipeId)) return ['恢复层位必须属于明确整托配方，并处于 0 至 63 层索引范围。'];
	const axes = manifest.actuators?.filter(a => a.objectId === tool.objectId && a.kind !== 'gripper' && (!tool.cartesianActuatorIds || tool.cartesianActuatorIds.includes(a.actuatorId))) || [];
	if (!axes.length || axes.some(a => { const l = request.axisLimits?.[a.actuatorId]; return !l || [l.velocity, l.acceleration, l.jerk].some(n => !Number.isFinite(n) || n <= 0) || !a.speed || l.velocity > a.speed; })) return ['实际执行轴需要完整且不超过设备速度的运动约束。'];
	return [];
}

/** 在现有动作图中展开批次规划和六个原语步骤；没有独立调度器。 */
export function createBatchPickPlaceFlow(manifest: TwinSceneManifest, request: PickPlaceRequest): TwinSceneManifest {
	const errors = pickPlaceRequestErrors(manifest, request);
	if (errors.length) throw new Error(errors.join('；'));
	const actorObjectId = manifest.toolFrames!.find(t => t.toolFrameId === request.toolFrameId)!.objectId, flowId = `pick-place/${request.taskId}`;
	if (manifest.actionFlows?.some(f => f.flowId === flowId)) throw new Error('工艺已存在，不能覆盖手动修改。');
	const labels = ['接近取料', '夹具闭合', '确认接触并抓取', '保持抓取关系搬运', '确认到位并放料', '放料后撤离'];
	const flow: TwinActionFlowDefinitionV2 = { flowId, key: flowId, name: `${request.name}（按批次规划）`, contractVersion: '2.0', actorObjectIds: [actorObjectId], variables: [], enabled: false, revision: 1, status: 'Draft',
		policies: { executionTarget: 'scene', allowedRuntimeModes: ['simulation'], defaultTimeoutSeconds: 300 },
		nodes: [{ nodeId: 'start', type: 'Start', name: '开始', config: {} }, { nodeId: 'plan', type: 'PlanPickPlace', name: '绑定当前批次并规划', actorObjectId, config: { request: JSON.parse(JSON.stringify(request)) } },
			...plannedTransferSteps.map((step, i) => ({ nodeId: step, type: 'PlannedTransferStep' as const, name: labels[i], actorObjectId, config: { planNodeId: 'plan', step } })), { nodeId: 'end', type: 'End', name: '结束', config: {} }], edges: [] };
	flow.nodes.forEach((node, i) => node.editor = { x: 80 + i * 240, y: 100 });
	flow.edges = flow.nodes.slice(1).map((node, i) => ({ edgeId: `${flow.nodes[i].nodeId}-${node.nodeId}`, sourceNodeId: flow.nodes[i].nodeId, sourcePort: 'success', targetNodeId: node.nodeId }));
	const result: TwinSceneManifest = JSON.parse(JSON.stringify(manifest)); result.actionFlows = [...(result.actionFlows || []), flow]; return result;
}

/** 将整托配方展开为同一动作图；双工具依次执行，每批重新规划，保留 0/层间/每层隔板策略。 */
export function createStackingRecipeFlow(manifest: TwinSceneManifest, main: PickPlaceRequest, separator?: PickPlaceRequest,
	resume: { completedLayers: number; pendingSeparator: boolean } = { completedLayers: 0, pendingSeparator: false }): TwinSceneManifest {
	const target = manifest.materialSlots?.find(s => s.slotId === main.targetSlotId), pattern = target?.stackPattern;
	if (!pattern || !Number.isInteger(pattern.layers) || pattern.layers < 1 || pattern.layers > 64 || main.payloadCount !== pattern.rows * pattern.columns) throw new Error('整托配方需要明确的 1 至 64 层及与夹具批量一致的层格位。');
	const mode = pattern.separatorMode || (pattern.layerMaterialRequired ? 'every-layer' : 'none');
	const separators = mode === 'none' ? 0 : mode === 'between-layers' ? pattern.layers - 1 : pattern.layers;
	if (!Number.isInteger(resume.completedLayers) || resume.completedLayers < 0 || resume.completedLayers > pattern.layers || typeof resume.pendingSeparator !== 'boolean'
		|| (resume.pendingSeparator && (resume.completedLayers < 1 || resume.completedLayers > separators))) throw new Error('恢复必须位于完整层边界；待补隔板需属于该配方的已完成主物料层。');
	if (resume.completedLayers === pattern.layers && !resume.pendingSeparator) throw new Error('此托盘配方已完成，请换托后创建新工艺。');
	if (separators && (!separator || separator.payloadCount !== 1 || manifest.materialSlots?.find(s => s.slotId === separator.targetSlotId)?.stackPatternSlotId !== target!.slotId || manifest.toolFrames?.find(t => t.toolFrameId === main.toolFrameId)?.objectId !== manifest.toolFrames?.find(t => t.toolFrameId === separator.toolFrameId)?.objectId || main.toolFrameId === separator.toolFrameId)) throw new Error('隔板配方需要同一桁架的独立工具、单张批量和对应的层间目标。');
	const result: TwinSceneManifest = JSON.parse(JSON.stringify(manifest)), flowId = `stack-recipe/${main.taskId}`;
	if (result.actionFlows?.some(f => f.flowId === flowId)) throw new Error('整托工艺已经存在，不能静默覆盖。');
	const nodes: TwinActionFlowDefinitionV2['nodes'] = [{ nodeId: 'start', type: 'Start', name: '开始整托工艺', config: {} }];
	for (let layer = 0; layer < pattern.layers; layer++) {
		for (const [kind, original] of [['material', main], ...(layer < separators ? [['separator', separator!]] : [])] as Array<[string, PickPlaceRequest]>) {
			if (layer < resume.completedLayers && !(kind === 'separator' && resume.pendingSeparator && layer === resume.completedLayers - 1)) continue;
			const prefix = `layer-${layer + 1}-${kind}`;
			const request = { ...original, taskId: `${main.taskId}/${prefix}`, palletRecipeId: flowId, expectedLayer: layer };
			const added = createBatchPickPlaceFlow(result, request).actionFlows!.at(-1)!;
			for (const node of added.nodes.slice(1, -1)) nodes.push({ ...node, nodeId: `${prefix}/${node.nodeId}`, name: `第 ${layer + 1} 层 · ${node.name}`, config: { ...node.config, ...(node.type === 'PlannedTransferStep' ? { planNodeId: `${prefix}/plan` } : {}) } });
		}
	}
	nodes.push({ nodeId: 'end', type: 'End', name: '整托完成并撤离', config: {} });
	nodes.forEach((node, i) => node.editor = { x: 80 + i % 8 * 240, y: 100 + Math.floor(i / 8) * 150 });
	const actorObjectId = manifest.toolFrames!.find(t => t.toolFrameId === main.toolFrameId)!.objectId;
	result.actionFlows = [...(result.actionFlows || []), { flowId, key: flowId, name: `${main.name} · ${pattern.layers} 层 / ${separators} 张隔板${resume.completedLayers ? `（从已完成 ${resume.completedLayers} 层恢复）` : ''}`, contractVersion: '2.0', actorObjectIds: [actorObjectId], variables: [], nodes,
		edges: nodes.slice(1).map((node, i) => ({ edgeId: `step-${i}`, sourceNodeId: nodes[i].nodeId, sourcePort: 'success', targetNodeId: node.nodeId })), policies: { executionTarget: 'scene', allowedRuntimeModes: ['simulation'], defaultTimeoutSeconds: 300 }, enabled: false, revision: 1, status: 'Draft' }];
	return result;
}

/** 取放工艺的只读规划入口；枚举完整几何链，执行轨迹明确限于空载仿真。 */
export function previewPickPlace(manifest: TwinSceneManifest, request: PickPlaceRequest, scene: MotionSceneAccess, solveMotion = false, bindCurrentBatch = false): PickPlacePreview {
	if (!request.taskId.trim() || !request.name.trim()) throw new Error('请输入工艺名称。');
	const source = manifest.materialSlots?.find(s => s.slotId === request.sourceSlotId), target = manifest.materialSlots?.find(s => s.slotId === request.targetSlotId);
	const frame = manifest.toolFrames?.find(t => t.toolFrameId === request.toolFrameId);
	if (!source || !target || source.slotId === target.slotId || !frame) throw new Error('请选择不同的来源、目标和明确工具。');
	if (source.role !== 'source' || !['target', 'stack', 'buffer', 'fixture'].includes(target.role) || !source.payloadType || source.payloadType !== target.payloadType) throw new Error('来源/目标的角色或物料类型不兼容。');
	const picks = deriveSlotToolTargetCandidates(manifest, source.slotId, frame.toolFrameId, createSlotTargetContext(manifest, source, scene));
	const places = deriveSlotToolTargetCandidates(manifest, target.slotId, frame.toolFrameId, createSlotTargetContext(manifest, target, scene));
	const rejections = [...picks.rejected.map(r => ({ candidate: `取料/${r.templateId}`, reason: r.message })), ...places.rejected.map(r => ({ candidate: `放料/${r.templateId}`, reason: r.message }))];
	const dependencySnapshot = motionDependencySnapshot(manifest);
	if (request.expectedLayer !== undefined) {
		const context = createSlotTargetContext(manifest, target, scene), ids = context.resolvedSlotFrame?.ownerIds;
		const owner = ids?.length === 1 ? scene.getRuntimeOwners().find(o => o.userData.twinEntityId === ids[0]) : undefined;
		const anchor = owner && exactNode(owner, target.runtimeOwnerNodePath);
		const pattern = target.stackPattern || manifest.materialSlots?.find(s => s.slotId === target.stackPatternSlotId)?.stackPattern;
		const layer = anchor && pattern ? target.stackPatternSlotId ? Number(anchor.userData.stackLayerMaterialCount ?? 0) : Number(anchor.userData.stackItemCount ?? 0) / (pattern.rows * pattern.columns) : undefined;
		if (!Number.isInteger(request.expectedLayer) || layer !== request.expectedLayer) throw new Error('托盘实际层位与整托配方不符，请先完成恢复或绑定空托盘。');
		const mainSlot = target.stackPatternSlotId ? manifest.materialSlots!.find(s => s.slotId === target.stackPatternSlotId)! : target;
		const boardSlot = manifest.materialSlots?.find(s => s.stackPatternSlotId === mainSlot.slotId);
		let actualItems = 0, actualBoards = 0;
		anchor!.traverse(node => { if (node.userData.materialEntity && !node.userData.materialAttachedBy) {
			if (node.userData.payloadType === mainSlot.payloadType) actualItems++;
			if (boardSlot && node.userData.payloadType === boardSlot.payloadType) actualBoards++;
		} });
		if (actualItems !== Number(anchor!.userData.stackItemCount ?? 0) || actualBoards !== Number(anchor!.userData.stackLayerMaterialCount ?? 0)) throw new Error('托盘实际物料与库存计数不一致，不能仅修改层数恢复运行。');
	}
	let tried = 0;
	for (const pick of picks.candidates) for (const place of places.candidates) {
		if (++tried > 64) throw new Error(`候选预算 64 组已用完；已拒绝 ${rejections.length} 组，请缩小模板候选范围。`);
		const result: PickPlacePreview = { request: JSON.parse(JSON.stringify(request)), dependencySnapshot, pick, place, rejections,
			checks: { geometry: 'passed', kinematics: 'unchecked', timing: 'unchecked', collision: 'unchecked', handoff: 'unchecked' } };
		if (!solveMotion) return result;
		try {
			// 动态目标的执行需要批次边界冻结与复核；静态产物不能伪装成动态计划。
			if (!bindCurrentBatch && (pick.stateRevision || place.stateRevision)) throw new Error('动态目标需在批次开始时规划；请保存为按批次规划工艺。');
			const root = scene.getRoot(frame.objectId);
			if (!root) throw new Error('执行设备尚未加载。');
			const solver = new ToolPoseSolver(manifest, root, frame), positions = [solver.read()];
			const limits = solver.axes.map(axis => {
				const value = request.axisLimits[axis.actuatorId];
				if (!value || [value.velocity, value.acceleration, value.jerk].some(v => !Number.isFinite(v) || v <= 0)) throw new Error(`请为“${axis.name}”配置速度、加速度和加加速度。`);
				return { ...value };
			});
			for (const [position, rotation] of [[pick.approach, pick.tcpQuaternion], [pick.contact, pick.tcpQuaternion], [pick.retreat, pick.tcpQuaternion], [place.approach, place.tcpQuaternion], [place.contact, place.tcpQuaternion], [place.retreat, place.tcpQuaternion]]) positions.push(solver.solve(position, rotation));
			let time = 0;
			const points = positions.map((values, i) => {
				if (i) time += Math.max(0.01, ...values.map((v, a) => { const distance = Math.abs(v - positions[i - 1][a]), l = limits[a]; return Math.max(1.875 * distance / l.velocity, Math.sqrt(10 / Math.sqrt(3) * distance / l.acceleration), Math.cbrt(60 * distance / l.jerk)); }));
				return { time, positions: values };
			});
			const trajectory: TwinJointTrajectory = { contractVersion: 'joint-trajectory/1', trajectoryId: `pick-place/${request.taskId}`, name: request.name, actorObjectId: frame.objectId,
				interpolation: 'quintic-stop', validation: 'simulation-only', dependencySnapshot, axisIds: solver.axes.map(a => a.actuatorId), limits, points };
			const errors = trajectoryErrors(trajectory, manifest);
			if (errors.length) throw new Error(errors.join('；'));
			if (request.transferMaterials) {
				const tool = exactNode(root, frame.nodePath);
				const contains = (parent: Object3D, child: Object3D) => { for (let n: Object3D | null = child; n; n = n.parent) if (n === parent) return true; return false; };
				const grippers = manifest.actuators?.filter(a => a.objectId === frame.objectId && a.kind === 'gripper').filter(a => { const node = exactNode(root, a.nodePath); return node && tool && (contains(node, tool) || contains(tool, node)); }) || [];
				if (grippers.length !== 1) throw new Error('物料取放需要与所选 TCP 对应的唯一夹具。');
				if (!Number.isInteger(request.payloadCount) || request.payloadCount! <= 0 || request.payloadCount! > 99) throw new Error('必须显式填写本批抓取数量。');
				const sourceRoot = scene.getRoot(source.objectId), targetRoot = scene.getRoot(target.objectId);
				if (!sourceRoot || !targetRoot) throw new Error('来源或目标模型尚未加载。');
				const materials: Object3D[] = [], occupied: Object3D[] = [];
				const runtimeRoots = (slot: typeof source, fallback: Object3D) => {
					if (!slot.runtimeOwnerType) return [fallback];
					const ids = createSlotTargetContext(manifest, slot, scene).resolvedSlotFrame!.ownerIds!;
					return ids.map(id => scene.getRuntimeOwners().find(o => o.userData.twinEntityId === id)!);
				};
				const sourceRoots = runtimeRoots(source, sourceRoot), targetRoots = runtimeRoots(target, targetRoot);
				const selectedIds = createSlotTargetContext(manifest, source, scene).resolvedSlotFrame?.materialIds;
				for (const owner of sourceRoots) owner.traverse(node => { if (node.userData.materialEntity && !node.userData.materialAttachedBy && node.userData.payloadType === source.payloadType && (!source.metadata?.entityGroup || node.userData.materialSlotGroup === source.metadata.entityGroup) && (!selectedIds?.length || selectedIds.includes(String(node.userData.twinEntityId)))) materials.push(node); });
				for (const owner of targetRoots) owner.traverse(node => { if (node.userData.materialEntity && (!target.stackPattern && !target.stackPatternSlotId || node.userData.payloadType === target.payloadType)) occupied.push(node); });
				if (materials.length !== request.payloadCount || materials.some(m => !m.userData.twinEntityId) || new Set(materials.map(m => m.userData.twinEntityId)).size !== materials.length) throw new Error('来源物料数量或身份不明确，请绑定完整批次；不会按最近距离猜测待抓物料。');
				if (!Number.isInteger(target.capacity) || occupied.length + materials.length > target.capacity!) throw new Error('目标缺少容量声明或已无足够空位。');
				// 同一个物料相对 TCP 的关系贯穿取与放，禁止在释放时重新排列。
				const pose = (position: number[], rotation: number[]) => new Matrix4().compose(new Vector3(...position), new Quaternion(...rotation), new Vector3(1, 1, 1));
				const transfer = pose(place.contact, place.tcpQuaternion).multiply(pose(pick.contact, pick.tcpQuaternion).invert());
				const pickPayloads = materials.map(material => { material.updateWorldMatrix(true, false); return { entityId: String(material.userData.twinEntityId), worldMatrix: [...material.matrixWorld.elements] }; });
				const placePayloads = pickPayloads.map(p => ({ entityId: p.entityId, worldMatrix: transfer.clone().multiply(new Matrix4().fromArray(p.worldMatrix)).toArray() }));
				if ((target.runtimeOwnerType || target.stackPattern || target.stackPatternSlotId) && target.metadata?.precisePlacement !== true) throw new Error('动态目标必须启用精确交接，不允许释放后重新排列物料。');
				if (target.stackPattern) {
					const pattern = target.stackPattern, owner = targetRoots[0], anchor = exactNode(owner, target.runtimeOwnerNodePath);
					if (!anchor || targetRoots.length !== 1 || materials.length !== pattern.rows * pattern.columns) throw new Error('当前码垛工艺需要唯一托盘和完整的一层抓取批次。');
					const current = Number(anchor.userData.stackItemCount ?? 0), level = current / (pattern.rows * pattern.columns);
					const cells = Array.from({ length: materials.length }, (_, i) => anchor.localToWorld(new Vector3((pattern.originX ?? 0) + i % pattern.columns * pattern.spacingX, pattern.firstLayerY + level * pattern.layerPitch, (pattern.originZ ?? 0) + Math.floor(i / pattern.columns) * pattern.spacingZ)));
					for (const p of placePayloads) { const position = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(p.worldMatrix)); const index = cells.findIndex(cell => cell.distanceTo(position) <= 1e-4); if (index < 0) throw new Error('实际夹具抓位与码垛格位不匹配，禁止落料时重新排列。'); cells.splice(index, 1); }
				}
				result.transfer = { gripperActuatorId: grippers[0].actuatorId, pickPayloads, placePayloads };
			}
			const payload = result.transfer ? { ids: result.transfer.pickPayloads.map(p => p.entityId), pickMatrix: new Matrix4().compose(new Vector3(...pick.contact), new Quaternion(...pick.tcpQuaternion), new Vector3(1, 1, 1)) } : undefined;
			result.collisionReview = reviewCartesianCollision(manifest, trajectory, scene, solver, payload);
			if (result.collisionReview.status === 'blocked') {
				const conflict = result.collisionReview.conflict!;
				throw new Error(`第 ${conflict.segment} 段“${conflict.moving}”与“${conflict.obstacle}”的连续包围体冲突；当前候选无法证明净空。`);
			}
			if (result.collisionReview.status === 'clear-within-scope') result.checks.collision = 'partial';
			result.trajectory = trajectory; result.checks.kinematics = 'passed'; result.checks.timing = 'passed';
			return result;
		} catch (error) { rejections.push({ candidate: `${pick.templateId} → ${place.templateId}`, reason: error instanceof Error ? error.message : String(error) }); }
	}
	throw new Error(rejections.length ? rejections.map(r => `${r.candidate}：${r.reason}`).join('\n') : '没有可用的取放候选，请补齐模板声明。');
}

/** 原子应用预览产物；需要重新生成的旧结果或已经编辑过的同名工艺不会被静默覆盖。 */
export function applyPickPlacePreview(manifest: TwinSceneManifest, preview: PickPlacePreview): TwinSceneManifest {
	if (!preview.trajectory || preview.dependencySnapshot !== motionDependencySnapshot(manifest)) throw new Error('预览未生成轨迹或已过期，请重新预览。');
	if (trajectoryErrors(preview.trajectory, manifest).length) throw new Error('轨迹校验失败。');
	const id = `pick-place/${preview.request.taskId}`;
	if (manifest.motionTrajectories?.some(t => t.trajectoryId === id || t.trajectoryId.startsWith(`${id}/`)) || manifest.actionFlows?.some(f => f.flowId === id)) throw new Error('该工艺已经保存；请先撤销或另建工艺，避免覆盖手动修改。');
	const result: TwinSceneManifest = JSON.parse(JSON.stringify(manifest));
	const flow: TwinActionFlowDefinitionV2 = { flowId: id, key: id, name: `${preview.request.name}（${preview.transfer ? '物料取放' : '空载'}试运行）`, contractVersion: '2.0', actorObjectIds: [preview.trajectory.actorObjectId], variables: [],
		nodes: [{ nodeId: 'start', type: 'Start', name: '开始', config: {}, editor: { x: 80, y: 100 } },
			{ nodeId: 'motion', type: 'FollowTrajectory', name: '空载取放路径', actorObjectId: preview.trajectory.actorObjectId, config: { trajectoryId: id, planningRequest: preview.request }, editor: { x: 320, y: 100 } },
			{ nodeId: 'end', type: 'End', name: '结束', config: {}, editor: { x: 560, y: 100 } }],
		edges: [{ edgeId: 'start-motion', sourceNodeId: 'start', sourcePort: 'success', targetNodeId: 'motion' }, { edgeId: 'motion-end', sourceNodeId: 'motion', sourcePort: 'success', targetNodeId: 'end' }],
		policies: { executionTarget: 'scene', allowedRuntimeModes: ['simulation'], defaultTimeoutSeconds: Math.ceil(preview.trajectory.points.at(-1)!.time) + 30 }, enabled: false, revision: 1, status: 'Draft' };
	result.motionTrajectories = [...(result.motionTrajectories || []), JSON.parse(JSON.stringify(preview.trajectory))];
	if (preview.transfer) {
		const actorObjectId = preview.trajectory.actorObjectId, binding = preview.transfer;
		const makeSegment = (suffix: string, start: number, end: number) => ({ ...JSON.parse(JSON.stringify(preview.trajectory!)), trajectoryId: `${id}/${suffix}`, name: `${preview.request.name} · ${suffix}`,
			points: preview.trajectory!.points.slice(start, end + 1).map(p => ({ positions: [...p.positions], time: p.time - preview.trajectory!.points[start].time })) } as TwinJointTrajectory);
		const parts = [makeSegment('接近取料', 0, 2), makeSegment('持料搬运', 2, 5), makeSegment('放料撤离', 5, 6)];
		result.motionTrajectories.pop(); result.motionTrajectories.push(...parts);
		const common = { actorObjectId, editor: { x: 0, y: 100 } };
		flow.nodes = [flow.nodes[0],
			{ ...common, nodeId: 'approach', type: 'FollowTrajectory', name: '接近取料', config: { trajectoryId: parts[0].trajectoryId, planningRequest: preview.request } },
			{ ...common, nodeId: 'close', type: 'GripClose', name: '夹具闭合', config: { actuatorId: binding.gripperActuatorId } },
			{ ...common, nodeId: 'attach', type: 'Attach', name: '确认接触并抓取', config: { sourceSlotId: preview.request.sourceSlotId, toolFrameId: preview.request.toolFrameId, targetTemplateId: preview.pick.templateId, payloadCount: binding.pickPayloads.length, expectedPayloads: binding.pickPayloads } },
			{ ...common, nodeId: 'carry', type: 'FollowTrajectory', name: '保持抓取关系搬运', config: { trajectoryId: parts[1].trajectoryId } },
			{ ...common, nodeId: 'detach', type: 'Detach', name: '确认到位并放料', config: { targetSlotId: preview.request.targetSlotId, toolFrameId: preview.request.toolFrameId, targetTemplateId: preview.place.templateId, expectedPayloads: binding.placePayloads } },
			{ ...common, nodeId: 'retreat', type: 'FollowTrajectory', name: '放料后撤离', config: { trajectoryId: parts[2].trajectoryId } }, flow.nodes.at(-1)!];
		flow.nodes.forEach((node, index) => node.editor = { x: 80 + index * 240, y: 100 });
		flow.edges = flow.nodes.slice(1).map((node, i) => ({ edgeId: `${flow.nodes[i].nodeId}-${node.nodeId}`, sourceNodeId: flow.nodes[i].nodeId, sourcePort: 'success', targetNodeId: node.nodeId }));
	}
	const firstMotion = flow.nodes.find(node => node.type === 'FollowTrajectory')!;
	firstMotion.config.planningReview = JSON.parse(JSON.stringify({ pickCandidateId: preview.pick.candidateId, placeCandidateId: preview.place.candidateId,
		checks: preview.checks, collisionReview: preview.collisionReview, rejections: preview.rejections }));
	result.actionFlows = [...(result.actionFlows || []), flow];
	return result;
}
