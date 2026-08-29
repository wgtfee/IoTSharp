import { createSilkCakeLineTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { ProceduralPackagingLine } from '../src/digital-twin/runtime/ProceduralPackagingLine';
import { resolveGantryPose } from '../src/digital-twin/runtime/GantryPoseResolver';
import { TwinSectionManager } from '../src/digital-twin/runtime/TwinMaterialFlowRuntime';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const manifest = createSilkCakeLineTwinSceneManifest();
const route = manifest.routes[0];
const simulation = manifest.runtime.silkLineSimulation!;
const errors = validateTwinSceneManifest(manifest).filter((item) => item.severity === 'error');
assert(errors.length === 0, `V6 Manifest 校验失败：${errors.map((item) => item.message).join('；')}`);
assert(manifest.objects[0]?.procedural?.preset === 'silk-cake-packaging-line', '模板未使用 V6 完整工艺预设');
assert(simulation.silkCakesPerCart === 36, 'V6 丝车必须为 A/B 两面共 36 个丝饼');
assert(simulation.stackRows === 2 && simulation.stackColumns === 3 && simulation.stackLayers === 8, 'V6 木托盘必须为 2×3×8');
assert(simulation.palletPopulationMode === 'closed-loop', 'V6 必须使用全在线闭环托盘模式');
assert(route.points.some((point) => point.pointId === 'silk-external-inspection' && point.process?.type === 'external-inspection'), 'V6 缺少外检 Process Station');
assert(route.points.some((point) => point.pointId === 'silk-bagging' && point.process?.type === 'bagging'), 'V6 缺少套袋 Process Station');
assert(route.points.some((point) => point.pointId === 'silk-buffer' && point.kind === 'diverter'), '外检前缺少空托检测岔口');
assert(route.edges.some((edge) => edge.edgeId === 'silk-edge-empty-return-drop' && edge.fromPointId === 'silk-buffer'), '空托检测岔口没有接入短回流');
assert(route.edges.some((edge) => edge.edgeId === 'silk-edge-empty-return-rise' && edge.toPointId === 'silk-source'), '空托短回流没有在机器人前汇入');
assert(route.decisionRules?.some((rule) => rule.ruleId === 'silk-rule-empty-return' && rule.payloadKey === 'hasSilkCake' && rule.operator === 'falsy'), '空托分流缺少 hasSilkCake 硬规则');
assert(route.edges.some((edge) => edge.edgeId === 'silk-edge-diverter-in' && edge.fromPointId === 'silk-bagging-out-buffer' && edge.toPointId === 'silk-diverter'), 'A/B 分流不是位于套袋机之后');
assert(manifest.routes.flatMap((item) => item.points).filter((point) => point.kind === 'processStation').every((point) => Boolean(point.process?.type)), 'V6 存在缺少 process.type 的加工工位，会导致工作台渲染失败');
assert(route.edges.find((edge) => edge.edgeId === 'silk-edge-external-inspection')?.capacity === 1, '外检工位容量必须为 1');
assert(route.edges.find((edge) => edge.edgeId === 'silk-edge-bagging')?.capacity === 1, '套袋工位容量必须为 1');
assert(route.edges.every((edge) => edge.conveyorSizeClass === 'small' && edge.transportUnitType === 'plastic-pallet'), '塑料托盘循环线必须全部为小辊道 + 塑料托盘');
const woodRoute = manifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route');
assert(woodRoute?.edges.every((edge) => edge.conveyorSizeClass === 'large' && edge.transportUnitType === 'wooden-pallet'), '木托盘后包装线必须全部为大辊道 + 木托盘');

const unitTypeSections = new TwinSectionManager([
	{ edgeId: 'small', fromPointId: 'a', toPointId: 'b', bidirectional: false, enabled: true, capacity: 2, conveyorSizeClass: 'small', transportUnitType: 'plastic-pallet' },
	{ edgeId: 'large', fromPointId: 'b', toPointId: 'c', bidirectional: false, enabled: true, capacity: 2, conveyorSizeClass: 'large', transportUnitType: 'wooden-pallet' },
	{ edgeId: 'carton', fromPointId: 'c', toPointId: 'd', bidirectional: false, enabled: true, capacity: 2, conveyorSizeClass: 'large', transportUnitType: 'carton' },
]);
assert(unitTypeSections.canAccept('small', 'plastic-1', Date.now(), 'plastic-pallet').canAccept, 'Small + Plastic Pallet 应允许');
assert(!unitTypeSections.canAccept('small', 'wood-1', Date.now(), 'wooden-pallet').canAccept, 'Small + Wooden Pallet 必须拒绝');
assert(unitTypeSections.canAccept('large', 'wood-1', Date.now(), 'wooden-pallet').canAccept, 'Large + Wooden Pallet 应允许');
assert(unitTypeSections.canAccept('carton', 'carton-1', Date.now(), 'carton').canAccept, 'Large + Carton 应允许');
const layerZeroPose = resolveGantryPose(0.78, 0);
const layerSevenPose = resolveGantryPose(0.78, 7);
assert(layerSevenPose.placeCarriageY - layerZeroPose.placeCarriageY > 3.2, '桁架放置高度没有随 8 层堆叠动态递增');
assert(resolveGantryPose(0.5, 7).carriage.y >= layerSevenPose.safeCarriageY, '第 8 层水平转运没有保持安全高度');

const runtime = new ProceduralPackagingLine(route, 80, {
	...simulation,
	robotCycleSeconds: 0.2,
	gantryCycleSeconds: 0.2,
	inspectionCycleSeconds: 0.2,
	inspectionNgRate: 0,
	baggingCycleSeconds: 0.2,
	cartChangeDelaySeconds: 0.15,
	coverCycleSeconds: 0.12,
	labelCycleSeconds: 0.12,
	wrappingCycleSeconds: 0.16,
	warehouseInboundCycleSeconds: 0.12,
	emptyWoodPalletFeedSeconds: 0.08,
});

const countByName = (name: string) => {
	let count = 0;
	runtime.group.traverse((object) => {
		if (object.name === name) count += 1;
	});
	return count;
};

const requiredObjects = [
	'双面丝车旋转供料单元',
	'丝车',
	'1×6上料机器人',
	'RobotRowGripper-1x6',
	'外检机',
	'套袋机',
	'外检机输送段',
	'套袋机输送段',
	'空托检测分流段',
	'外检前空托短回流',
	'空托短回流机器人前接入段',
	'2×3丝饼码垛桁架',
	'GantryGripper-2x3',
	'Gantry-Lane-A-3位',
	'Gantry-Lane-B-3位',
	'Gantry-Wood-Pallet-Lane',
	'满托后包装辊道',
	'盖板桁架工位',
	'贴标工位',
	'缠膜工位',
	'立体库入库口',
];
for (const name of requiredObjects) assert(runtime.group.getObjectByName(name), `V5 场景缺少对象：${name}`);
assert(countByName('Gantry-Lane-A-3位') === 1, '桁架 A 线被重复绘制');
assert(countByName('Gantry-Lane-B-3位') === 1, '桁架 B 线被重复绘制');
assert(countByName('Gantry-Wood-Pallet-Lane') === 1, '木托盘大辊道被重复绘制');

const laneA = runtime.group.getObjectByName('Gantry-Lane-A-3位')!;
const laneB = runtime.group.getObjectByName('Gantry-Lane-B-3位')!;
const woodLane = runtime.group.getObjectByName('Gantry-Wood-Pallet-Lane')!;
const postLane = runtime.group.getObjectByName('满托后包装辊道')!;
const rotaryCell = runtime.group.getObjectByName('双面丝车旋转供料单元')!;
const emptyReturnLane = runtime.group.getObjectByName('外检前空托短回流')!;
assert(woodLane.position.z < laneA.position.z && woodLane.position.z < laneB.position.z, '木托盘大辊道没有移动到 A/B 线的上方');
assert(Math.abs(woodLane.position.z - postLane.position.z) < 0.000001, '木托盘线与后包装线不在同一直线上');

const routePoints = new Map(route.points.map((point) => [point.pointId, point.position]));
const sourcePoint = routePoints.get('silk-source')!;
const southWestPoint = routePoints.get('silk-return-southwest')!;
const loadBufferPoint = routePoints.get('silk-buffer')!;
const returnEntryLane = runtime.group.getObjectByName('空托盘回流入口')!;
const robotMainLane = runtime.group.getObjectByName('机器人上料及主输送')!;
assert(rotaryCell.position.z < loadBufferPoint[2]
	&& emptyReturnLane.position.z >= loadBufferPoint[2] + 4,
`空托短回流没有位于主线反侧，丝车进场通道可能被占用：旋转台 z=${rotaryCell.position.z}，主线 z=${loadBufferPoint[2]}，回流 z=${emptyReturnLane.position.z}`);
assert(Math.hypot(returnEntryLane.position.x - (southWestPoint[0] + sourcePoint[0]) / 2, returnEntryLane.position.z - (southWestPoint[2] + sourcePoint[2]) / 2) < 0.001, '机器人侧回流辊道与回流路线端点不一致');
assert(Math.hypot(robotMainLane.position.x - (sourcePoint[0] + loadBufferPoint[0]) / 2, robotMainLane.position.z - (sourcePoint[2] + loadBufferPoint[2]) / 2) < 0.001, '机器人主辊道与路线中心线不一致');

const plasticPalletIds: string[] = [];
const plasticPalletObjects = new Map<string, any>();
runtime.group.traverse((object: any) => {
	if (object.userData?.twinEntityType === 'plastic-pallet') {
		plasticPalletIds.push(object.userData.twinEntityId);
		plasticPalletObjects.set(object.userData.twinEntityId, object);
	}
});
assert(plasticPalletIds.length === 80, `场景应包含 80 个塑料托盘，实际 ${plasticPalletIds.length}`);
assert(runtime.getSnapshot().plasticPallets.sourceQueue === 0, '启动后 SourceQueue 必须为 0，80 个托盘都应在物理线体中');

let sawRobotBatch = false;
let sawCartSideB = false;
let sawGantryBatch = false;
let sawInspection = false;
let sawBagging = false;
let sawLayerEight = false;
let sawCovered = false;
let sawLabeled = false;
let sawWrapped = false;
let sawReturning = false;
let sawReturnedToLoading = false;
let sawDistinctMergedConvoy = false;
let sawEmptyBypass = false;
let minimumPalletGap = Number.POSITIVE_INFINITY;
const returningIds = new Set<string>();
const cycledIds = new Set<string>();
const assertPalletSeparation = (tick: number, phase: string) => {
	const spatialCells = new Map<string, string[]>();
	for (const palletId of plasticPalletIds) {
		const position = plasticPalletObjects.get(palletId)!.position;
		const cellX = Math.floor(position.x / 1.5);
		const cellZ = Math.floor(position.z / 1.5);
		for (let offsetX = -1; offsetX <= 1; offsetX += 1) for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
			for (const otherId of spatialCells.get(`${cellX + offsetX}:${cellZ + offsetZ}`) || []) {
				const other = plasticPalletObjects.get(otherId)!;
				const gap = Math.hypot(position.x - other.position.x, position.z - other.position.z);
				minimumPalletGap = Math.min(minimumPalletGap, gap);
				assert(gap >= 1.5 - 0.001, `${phase}托盘发生重叠/穿越：tick=${tick}，${palletId} 与 ${otherId} 中心距=${gap.toFixed(4)}m`);
			}
		}
		const cellKey = `${cellX}:${cellZ}`;
		spatialCells.set(cellKey, [...(spatialCells.get(cellKey) || []), palletId]);
	}
};

const baggingOutEdge = route.edges.find((edge) => edge.edgeId === 'silk-edge-bagging-out-buffer')!;
baggingOutEdge.blockedBindingId = 'verify-bagging-out-blocked';
runtime.setRoute(route);
runtime.setSpeed(24);
runtime.setRoutingContext({ payload: {}, bindingValues: { 'verify-bagging-out-blocked': true }, edgeOccupancy: {}, staleBindingIds: [] });
runtime.setRunning(true);
for (let tick = 0; tick < 900; tick += 1) {
	runtime.updateFixed(1 / 30);
	assertPalletSeparation(tick, '封锁阶段');
}
const blockedSnapshot = runtime.getSnapshot();
assert(blockedSnapshot.sections.find((section) => section.sectionId === 'silk-edge-bagging-out-buffer')?.state === 'blocked', '套袋后段封锁信号没有生效');
assert(blockedSnapshot.preProcess.bagging.state === 'completed', '下游封锁时套袋机没有保持“已完成待放行”状态');
assert((blockedSnapshot.sections.find((section) => section.sectionId === 'silk-edge-inspection-out-buffer')?.occupancy || 0) > 0, '套袋下游封锁没有向外检后缓存传播');
runtime.setRoutingContext({ payload: {}, bindingValues: { 'verify-bagging-out-blocked': false }, edgeOccupancy: {}, staleBindingIds: [] });
// 下置空回流比首版 V6.1 路径更长，保留足够的仿真时窗验证 80 个托盘全部闭环。
for (let tick = 0; tick < 7_000; tick += 1) {
	runtime.updateFixed(1 / 30);
	const current = runtime.getSnapshot();
	sawEmptyBypass ||= current.preProcess.emptyBypassCount > 0;
	sawRobotBatch ||= current.robot.state === 'picking' && current.robot.batchSize === 6 && current.robot.emptyPalletsReady === 6;
	sawCartSideB ||= current.silkCart.activeSide === 'B';
	sawGantryBatch ||= current.gantry.state === 'picking' && current.gantry.laneA === 3 && current.gantry.laneB === 3;
	sawInspection ||= current.preProcess.inspection.state === 'processing' || current.preProcess.inspection.passed > 0;
	sawBagging ||= current.preProcess.bagging.state === 'processing' || current.preProcess.bagging.completed > 0;
	sawLayerEight ||= current.woodenPallet.layer === 8;
	sawCovered ||= current.postProcess.covered > 0;
	sawLabeled ||= current.postProcess.labeled > 0;
	sawWrapped ||= current.postProcess.wrapped > 0;
	const returningNow: Array<{ palletId: string; progress: number }> = [];
	for (const palletId of plasticPalletIds) {
		const detail = runtime.getEntityDetail('plastic-pallet', palletId);
		if (Number(detail?.cycleCount || 0) > 0) cycledIds.add(palletId);
		if (detail?.state === 'empty-return') {
			sawReturning = true;
			returningIds.add(palletId);
			returningNow.push({ palletId, progress: Number(detail.progress || 0) });
		}
		if (detail?.stage === 'gantry-a' || detail?.stage === 'gantry-b') {
			const cake = runtime.getEntityDetail('silk-cake', String(detail.silkCakeId || ''));
			assert(cake?.quality === 'normal', `${palletId} 未通过质量门禁却进入 Gantry`);
			assert((cake?.appearanceInspection as any)?.state === 'completed' && (cake?.appearanceInspection as any)?.result === 'pass', `${palletId} 未完成外检却进入 Gantry`);
			assert((cake?.bagging as any)?.state === 'completed' && (cake?.bagging as any)?.bagged === true, `${palletId} 未套袋却进入 Gantry`);
		}
		if (['to-external-inspection', 'external-inspection', 'to-bagging', 'bagging', 'to-diverter', 'to-gantry-a', 'to-gantry-b'].includes(String(detail?.stage || ''))) {
			assert(Boolean(detail?.silkCakeId), `${palletId} 空托盘错误进入外检/套袋/A-B 分流主工艺`);
		}
		if (returningIds.has(palletId) && detail?.state === 'loading') sawReturnedToLoading = true;
	}
	assertPalletSeparation(tick, '运行阶段');
	if (returningNow.length >= 6) {
		const uniquePositions = new Set(returningNow.map(({ palletId }) => {
			const position = plasticPalletObjects.get(palletId)!.position;
			return `${position.x.toFixed(3)},${position.z.toFixed(3)}`;
		}));
		sawDistinctMergedConvoy ||= uniquePositions.size === returningNow.length;
	}
	for (const section of current.sections) {
		assert(section.occupancy + section.reserved <= section.capacity, `${section.sectionId} 超出容量：${section.occupancy}+${section.reserved}>${section.capacity}`);
		if (section.sectionId === 'silk-edge-external-inspection' || section.sectionId === 'silk-edge-bagging') assert(section.occupancy <= 1, `${section.sectionId} 工位同时进入多个托盘`);
	}
	if (current.postProcess.stored > 0 && cycledIds.size === plasticPalletIds.length) break;
}

const snapshot = runtime.getSnapshot();
const returningDebug = plasticPalletIds.map((palletId) => {
	const detail = runtime.getEntityDetail('plastic-pallet', palletId);
	const position = plasticPalletObjects.get(palletId)!.position;
	return { palletId, ...detail, position: [Number(position.x.toFixed(2)), Number(position.z.toFixed(2))] };
}).filter((item) => item.state === 'empty-return');
const incompleteCycleDebug = plasticPalletIds.map((palletId) => {
	const detail = runtime.getEntityDetail('plastic-pallet', palletId);
	const position = plasticPalletObjects.get(palletId)!.position;
	return { palletId, ...detail, position: [Number(position.x.toFixed(2)), Number(position.z.toFixed(2))] };
}).filter((item) => Number(item.cycleCount || 0) < 1);
assert(sawRobotBatch, '机器人没有按 1×6 整排批次抓取');
assert(sawCartSideB, `丝车 A 面完成后没有旋转到 B 面：${JSON.stringify({ snapshot, returningDebug })}`);
assert(sawGantryBatch, '桁架没有在 A/B 各 3 托盘就绪后执行 2×3 抓取');
assert(sawInspection, '托盘没有在外检机停止并执行外检');
assert(sawBagging, '外检 PASS 后没有执行套袋');
assert(sawEmptyBypass, '仿真没有产生空托盘，也没有验证外检前短回流');
assert(sawLayerEight, '木托盘没有完成 8 层码垛');
assert(sawCovered && sawLabeled && sawWrapped, '盖板、贴标、缠膜后处理没有全部执行');
assert(snapshot.postProcess.stored > 0, '完整木托盘没有进入立体库');
assert(sawReturning && sawReturnedToLoading, '空塑料托盘没有优先回到机器人上料位形成闭环');
assert(sawDistinctMergedConvoy, '六个空塑料托盘在汇流后发生视觉重合');
assert(snapshot.plasticPallets.sourceQueue === 0, '运行过程中 SourceQueue 不应重新出现离线托盘');
assert(cycledIds.size === plasticPalletIds.length, `并非所有塑料托盘都完成过闭环，已完成 ${cycledIds.size}/${plasticPalletIds.length}：${JSON.stringify({ incompleteCycleDebug, sections: snapshot.sections, preProcess: snapshot.preProcess })}`);

const movingPallet = plasticPalletIds.map((palletId) => plasticPalletObjects.get(palletId)).find(Boolean);
const beforePause = movingPallet?.position.clone();
runtime.setRunning(false);
for (let tick = 0; tick < 30; tick += 1) runtime.updateFixed(1 / 30);
if (movingPallet && beforePause) assert(movingPallet.position.distanceTo(beforePause) < 0.000001, '暂停后托盘仍在移动');

console.log(JSON.stringify({
	manifest: manifest.name,
	preset: manifest.objects[0]?.procedural?.preset,
	plasticPallets: snapshot.plasticPallets.total,
	robotBatch: '1×6',
	gantryBatch: '2×3',
	externalInspection: `PASS ${snapshot.preProcess.inspection.passed} / NG ${snapshot.preProcess.inspection.ng}`,
	bagging: `Completed ${snapshot.preProcess.bagging.completed}`,
	woodPallet: '2×3×8 = 48',
	storedWoodPallets: snapshot.postProcess.stored,
	emptyPalletClosedLoop: sawReturnedToLoading,
	emptyPalletBypassCount: snapshot.preProcess.emptyBypassCount,
	cycledPallets: `${cycledIds.size}/${plasticPalletIds.length}`,
	distinctPalletsAfterMerger: sawDistinctMergedConvoy,
	minimumPalletGapMeters: Number(minimumPalletGap.toFixed(3)),
	robotReturnRouteAligned: true,
	woodLanePosition: 'above A/B lanes',
	duplicateGantryLanes: false,
	status: 'PASS',
}, null, 2));
