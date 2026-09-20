import type { TwinProcessDefinition, TwinRouteDefinition, TwinSceneManifest, TwinVector3 } from '../contracts';
import { createDrawingPackagingActionFlows } from './DrawingPackagingActionFlows';
import type { TwinV7SceneManifest } from '../contracts/v7-components';
import { ensureComponentActuators } from '../components/ComponentActuatorSync';
import { persistCompiledRouteGraph } from '../routes/RouteAuthoringCompiler';
import { createDrawingPackagingLineManifest, drawingWorld } from './DrawingPackagingLineManifest';
import { validateActionFlows } from '../action-flow/validation/ActionFlowValidator';

const ROBOT = 'drawing-loading-robot', GANTRY = 'drawing-stacking-gantry', WOOD = 'drawing-stacking-pallet';
const aid = (id: string) => `${ROBOT}:${id}`;
const gid = (id: string) => `${GANTRY}:${id}`;

/** 保留确认图的所有实体辊道，只在中心线上增设到位工作点。 */
function station(route: TwinRouteDefinition, pixel: [number, number], objectId: string, process: TwinProcessDefinition) {
	const position = drawingWorld(pixel, route.routeId.endsWith('wood-line') ? .82 : .9);
	let point = route.points.find(p => p.position.every((value, i) => Math.abs(value - position[i]) < 1e-6));
	if (!point) {
		const edge = route.edges.find(e => {
			const a = route.points.find(p => p.pointId === e.fromPointId)!.position, b = route.points.find(p => p.pointId === e.toPointId)!.position;
			const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
			return Math.abs(Math.hypot(position[0] - a[0], position[2] - a[2]) + Math.hypot(b[0] - position[0], b[2] - position[2]) - length) < 1e-6;
		});
		if (!edge) throw new Error(`工作点 ${pixel.join(',')} 不在真实辊道中心线上`);
		point = { pointId: `drawing-p-${pixel.join('-')}`, name: `${objectId} 到位 ${process.physicalLane || ''}`, position };
		route.points.push(point);
		route.edges.push({ ...edge, edgeId: edge.edgeId + '-exit', fromPointId: point.pointId, authoring: { mode: 'manual', locked: false } });
		edge.toPointId = point.pointId;
	}
	point.kind = 'processStation'; point.componentObjectId = objectId;
	point.process = { batchArrivalMode: 'route-aligned', batchSize: 1, batchLaneSize: 1, ...process };
}

/** 图纸复刻的离线工艺版；不连接 PLC，不覆盖已发布 V19，不假定图纸比例是现场机械尺寸。 */
export function createDrawingPackagingProcessManifest(): TwinSceneManifest {
	const manifest = createDrawingPackagingLineManifest() as TwinV7SceneManifest;
	manifest.sceneId = 'drawing-0911-process-new-scene';
	manifest.name = '参考图双套袋环形包装产线 · 全动作流 V3';
	manifest.description = '全动作流 V3：七套可编辑节点图控制 50 小托盘、双排抓丝、外检、双套袋、空回流、2×3×8 码垛与隔板、木托出料。工艺顺序、条件和节拍存入场景，不运行旧动作序列；比例参数仅用于离线仿真，不代表现场尺寸或 PLC 验收。';
	const object = (id: string) => manifest.objects.find(o => o.objectId === id)!;
	// 比例图中丝车到机器人约 10m；仅调整参数化机械臂的仿真臂展，不移动已确认设备中心。
	Object.assign(object(ROBOT).component!.properties, { upperArmLength: 6.4, forearmLength: 5.8, adaptiveGridGripper: true, gripperMaxSpan: 10.4, gripperMaxDepth: 3.2 });
	Object.assign(object(GANTRY).component!.properties, { silkGripColumnSpacing: 1.55, silkGripRowSpacing: 1.76, separatorLength: 5.6, separatorWidth: 2.8 });
	Object.assign(object(WOOD).component!.properties, { semanticOnly: true, length: 5.6, width: 2.8, height: .18 });
	const small = manifest.routes[0], wood = manifest.routes[1];
	small.replanUpcomingJunctions = true;
	manifest.runtime.routePalletInitializers![0].simulationPayloadTemplates = [{ drawingProfile: 'main', materialCount: 0 }];
	manifest.runtime.routePalletInitializers!.push({ routeId: wood.routeId, telemetryKey: 'drawing0911WoodPallets', simulationDefaultCount: 0, emptyValue: 0, simulationAutoFeed: true, simulationAutoFeedMaxActive: 1,
		transportUnitProperties: { length: 5.6, width: 2.8, height: .18 }, simulationHideAtExit: true });
	for (const [lane, y] of [['A', 861], ['B', 885]] as const) station(small, [875.4375, y], ROBOT, {
		type: 'robot-loading', batchSize: 12, batchLaneSize: 6, physicalLane: lane, materialAdmission: 'empty', behaviorCompletionGroups: ['load'],
		batchLayout: { rows: 2, columns: 6, columnSpacingMeters: 1.55, rowSpacingMeters: 1.92 },
	});
	for (const [lane, x] of [['A', 521], ['B', 543]] as const) station(small, [x, 328.375], GANTRY, {
		type: 'gantry-stacking', batchSize: 6, batchLaneSize: 3, physicalLane: lane, materialAdmission: 'loaded', behaviorCompletionGroups: ['stack'],
		batchLayout: { rows: 2, columns: 3, columnSpacingMeters: 1.55, rowSpacingMeters: 1.76 },
	});
	station(small, [925, 728], 'drawing-inspection', { type: 'external-inspection', behaviorCompletionGroups: ['process'] });
	station(small, [1170, 270], 'drawing-bag-a', { type: 'bagging', materialAdmission: 'loaded', behaviorCompletionGroups: ['process'] });
	station(small, [1104, 448], 'drawing-bag-b', { type: 'bagging', materialAdmission: 'loaded', behaviorCompletionGroups: ['process'] });
	station(wood, [445, 309], WOOD, { type: 'wood-stack-ready', behaviorCompletionGroups: ['ready'] });
	// 分流判定在岔口前完成；只增设中心线停车点，不增加辊道、移动模型或冻结已走路段。
	const router = 'drawing-transfer-drawing-p-1320-554';
	station(small, [1320, 579], router, { type: 'scan', behaviorCompletionGroups: ['route'] });
	small.decisionRules = small.decisionRules.filter(rule => !['drawing-p-1320-554', 'drawing-p-1320-432'].includes(rule.junctionPointId));
	ensureComponentActuators(manifest as TwinSceneManifest, [ROBOT, GANTRY]);
	manifest.workPoints = []; manifest.behaviors = []; manifest.interlocks = [];
	const robotFrame = manifest.toolFrames!.find(f => f.objectId === ROBOT)!;
	robotFrame.approachDirectionLocal = [0, 1, 0];
	for (const [tool, axes] of [['gantry-yarn-tcp', ['gantry-yarn-z', 'gantry-yarn-y']], ['gantry-separator-tcp', ['gantry-separator-z', 'gantry-separator-y']]] as const) {
		manifest.toolFrames!.find(f => f.toolFrameId === gid(tool))!.cartesianActuatorIds = axes.map(gid);
	}
	manifest.materialSlots = [
		...(['left', 'right'] as const).map(side => ({ slotId: `drawing-cart-${side}`, name: `${side === 'left' ? '左' : '右'}旋转丝车实际可取面`, objectId: `drawing-turntable-${side}`, role: 'source' as const,
			localPosition: [0, 2.475, side === 'left' ? 1.47 : -1.47] as TwinVector3, contactNormalLocal: [0, 0, side === 'left' ? 1 : -1] as TwinVector3, contactTolerance: .025, payloadType: 'silk-cake', capacity: 36,
			metadata: { adaptiveGridGripper: true, contactFromMaterials: true, contactBatchSize: 12, contactSurfaceOffset: .21, entityGroups: side === 'left' ? ['A', 'B'] : ['B', 'A'], presentationAngles: side === 'left' ? { A: 0, B: Math.PI } : { A: Math.PI, B: 0 }, rotationNodePath: 'RotatingDeck', minimumBatch: 1, simulationReplenish: true, simulationReplenishLimit: 5, selectionOrder: 'grid-row-major' } })),
		{ slotId: 'drawing-loading-target', name: '机器人当前双排 12 托', objectId: ROBOT, role: 'target', localPosition: [0, 1.35, -9.28], payloadType: 'silk-cake', capacity: 12,
			runtimeOwnerType: 'plastic-pallet', runtimeOwnerNodePath: 'SilkCakeAnchor', runtimeOwnerSelection: 'station-batch', distributePayloadAcrossRuntimeOwners: true,
			runtimeOwnerDistributionMode: 'one-per-owner', allowPartialRuntimeOwnerDistribution: true, placedStage: 'loaded', localRotation: [-Math.PI / 2, 0, 0], metadata: { precisePlacement: true } },
		{ slotId: 'drawing-gantry-source', name: '桁架当前双排 6 托', objectId: GANTRY, role: 'source', localPosition: [0, 1.35, 10.72], payloadType: 'silk-cake', capacity: 6,
			runtimeOwnerType: 'plastic-pallet', runtimeOwnerNodePath: 'SilkCakeAnchor', runtimeOwnerSelection: 'station-batch', distributePayloadAcrossRuntimeOwners: true, metadata: { contactFromMaterials: true } },
		{ slotId: 'drawing-stack', name: '当前木托 2×3×8', objectId: WOOD, role: 'stack', localPosition: [0, 0, 0], payloadType: 'silk-cake', capacity: 48,
			runtimeOwnerType: 'wooden-pallet', runtimeOwnerNodePath: 'StackAnchor', runtimeOwnerSelection: 'station-batch', placedStage: 'stacked',
			stackPattern: { rows: 2, columns: 3, layers: 8, spacingX: 1.55, spacingZ: 1.76, originX: -1.55, originZ: -.88, firstLayerY: .218, layerPitch: .47, separatorThickness: .025, layerMaterialOffsetY: .218, layerMaterialRequired: true },
			metadata: { dynamicStackApproach: true, precisePlacement: true } },
		{ slotId: 'drawing-separator-source', name: '隔板 A 库存', objectId: GANTRY, role: 'source', nodePath: 'SeparatorFeeder-A', localPosition: [0, 1.18, 0], payloadType: 'separator', capacity: 5,
			contactTolerance: .02, metadata: { entityGroup: 'A', entityGroups: ['A'], minimumBatch: 1, contactFromMaterials: true, contactBatchSize: 1, contactSurfaceOffset: .0125, simulationReplenish: true, simulationReplenishLimit: 30 } },
		{ slotId: 'drawing-separator-target', name: '当前木托层间隔板', objectId: WOOD, role: 'target', localPosition: [0, 0, 0], payloadType: 'separator', stackPatternSlotId: 'drawing-stack',
			runtimeOwnerType: 'wooden-pallet', runtimeOwnerNodePath: 'StackAnchor', runtimeOwnerSelection: 'station-batch', metadata: { dynamicStackApproach: true, precisePlacement: true } },
	];
	const wp = (workPointId: string, objectId: string, role: 'pick' | 'place' | 'safe', materialSlotId: string | undefined, toolFrameId: string, localPosition: TwinVector3) => {
		manifest.workPoints!.push({ workPointId, name: workPointId, objectId, role, materialSlotId, toolFrameId, localPosition }); return workPointId;
	};
	for (const side of ['left', 'right']) wp(`drawing-pick-${side}`, `drawing-turntable-${side}`, 'pick', `drawing-cart-${side}`, robotFrame.toolFrameId, [0, 0, 0]);
	wp('drawing-load-place', ROBOT, 'place', 'drawing-loading-target', robotFrame.toolFrameId, [0, .21, 0]);
	wp('drawing-gantry-pick', GANTRY, 'pick', 'drawing-gantry-source', gid('gantry-yarn-tcp'), [0, .21, 0]);
	wp('drawing-gantry-place', WOOD, 'place', 'drawing-stack', gid('gantry-yarn-tcp'), [0, .21, 0]);
	wp('drawing-gantry-safe', GANTRY, 'safe', undefined, gid('gantry-yarn-tcp'), [0, 5.5, 10.72]);
	wp('drawing-separator-pick', GANTRY, 'pick', 'drawing-separator-source', gid('gantry-separator-tcp'), [0, 0, 0]);
	wp('drawing-separator-place', WOOD, 'place', 'drawing-separator-target', gid('gantry-separator-tcp'), [0, .0125, 0]);
	wp('drawing-separator-safe', GANTRY, 'safe', undefined, gid('gantry-separator-tcp'), [0, 5.8, -7.76]);
	manifest.poses!.push({ poseId: 'drawing-robot-wrist', name: '抓丝面朝向 J4/J6', objectId: ROBOT, targets: [{ actuatorId: aid('robot-j4'), value: 0 }, { actuatorId: aid('robot-j6'), value: -Math.PI / 2 }] });
	manifest.interlocks!.push(
		{ interlockId: 'drawing-wood-arrived', name: '码垛木托已到位且未满', mode: 'all', conditions: [{ source: 'drawing-stack.present', operator: 'truthy' }, { source: 'drawing-stack.complete', operator: 'falsy' }] },
		{ interlockId: 'drawing-gantry-retreated', name: '桁架两夹具已安全退回', conditions: [{ source: 'drawing-gantry.safeToDispatch', operator: 'truthy' }] },
		{ interlockId: 'drawing-wood-complete', name: '48 丝锭及 8 隔板完成且夹具已退回', mode: 'all', conditions: [{ source: 'drawing-stack.complete', operator: 'truthy' }, { source: 'drawing-gantry.safeToDispatch', operator: 'truthy' }] },
	);
	manifest.actionFlows = createDrawingPackagingActionFlows(ROBOT, GANTRY, WOOD, router, robotFrame.toolFrameId, small.routeId);
	// 与设计器重载一致：组件的可编辑轴/槽位一次补全，避免首次打开草稿才发生隐式增量。
	ensureComponentActuators(manifest as TwinSceneManifest);
	persistCompiledRouteGraph(manifest as TwinSceneManifest);
	return manifest as TwinSceneManifest;
}

/** 仅识别上一版独立图纸工艺场景，不能靠名称把 V19 或其它用户场景误升级。 */
export function drawingActionFlowUpgradeIssue(manifest: TwinSceneManifest): string | undefined {
	if (manifest.actionFlows?.some(f => f.policies.executionTarget === 'scene')) return '当前场景已有三维动作图，不覆盖已编辑图。';
	const required = [ROBOT, GANTRY, WOOD, 'drawing-inspection', 'drawing-bag-a', 'drawing-bag-b', 'drawing-transfer-drawing-p-1320-554'];
	if (required.some(id => !manifest.objects.some(o => o.objectId === id)) || !manifest.routes.some(r => r.routeId === 'drawing-0911-small-loop') || !manifest.routes.some(r => r.routeId === 'drawing-0911-wood-line')) return '这不是已标定的独立图纸工艺场景，不能按名称套用升级。';
	if (!manifest.materialSlots?.some(s => s.slotId === 'drawing-stack') || !manifest.workPoints?.some(p => p.workPointId === 'drawing-load-place')) return '当前场景尚未配置图纸工艺工作点和物料槽，请先使用全动作流 V3 新建入口。';
	if (manifest.behaviors?.some(b => b.enabled !== false && ![ROBOT, GANTRY, WOOD].includes(b.actorObjectId))) return '存在其它设备的旧动作，请先处理这些动作再整体升级，避免静默停用。';
	return undefined;
}

/** 只替换工艺控制，保留场景 ID、全部模型变换、绑定、轴、槽位、工作点和路线几何。 */
export function upgradeDrawingPackagingActionFlows(current: TwinSceneManifest): TwinSceneManifest {
	const issue = drawingActionFlowUpgradeIssue(current); if (issue) throw new Error(issue);
	const manifest = structuredClone(current);
	const small = manifest.routes.find(r => r.routeId === 'drawing-0911-small-loop')!;
	const frame = manifest.toolFrames?.find(f => f.objectId === ROBOT); if (!frame) throw new Error('抓丝机器人缺少已标定 TCP，不能安全升级');
	const router = 'drawing-transfer-drawing-p-1320-554';
	const flows = createDrawingPackagingActionFlows(ROBOT, GANTRY, WOOD, router, frame.toolFrameId, small.routeId);
	if ((manifest.actionFlows || []).some(f => flows.some(n => n.flowId === f.flowId || n.key === f.key))) throw new Error('已有同名动作图，拒绝覆盖，请先导出并处理冲突');
	for (const [actorId, flowId] of [['drawing-inspection','drawing-inspection-flow'],['drawing-bag-a','drawing-bag-a-flow'],['drawing-bag-b','drawing-bag-b-flow']]) {
		const point = small.points.find(p => p.componentObjectId === actorId && p.process);
		if (!point?.process) throw new Error(`${actorId} 缺少原工位，不改动路线代替标定`);
		const flow = flows.find(f => f.flowId === flowId)!;
		const delay = flow.nodes.find(n => n.type === 'Delay')!;
		if (point.process.cycleSeconds !== undefined) delay.config.durationSeconds = point.process.cycleSeconds;
		if (point.process.materialStageOnComplete) flow.nodes.find(n => n.type === 'MarkMaterial')!.config.stage = point.process.materialStageOnComplete;
		delete point.process.cycleSeconds; delete point.process.materialStageOnComplete;
		delete point.process.behaviorCompletionRequirements; point.process.behaviorCompletionGroups = ['process'];
	}
	station(small, [1320,579], router, {type:'scan', behaviorCompletionGroups:['route']});
	small.replanUpcomingJunctions = true;
	small.decisionRules = small.decisionRules.filter(r => !['drawing-p-1320-554','drawing-p-1320-432'].includes(r.junctionPointId));
	manifest.behaviors = (manifest.behaviors || []).filter(b => ![ROBOT, GANTRY, WOOD].includes(b.actorObjectId));
	manifest.actionFlows = [...(manifest.actionFlows || []), ...flows];
	const errors = validateActionFlows(manifest.actionFlows, manifest).filter(d => d.severity === 'error');
	if (errors.length) throw new Error(`升级前置校验未通过：${errors.map(d=>d.message).join('；')}`);
	persistCompiledRouteGraph(manifest);
	return manifest;
}
