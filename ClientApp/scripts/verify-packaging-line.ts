import { createSilkCakeLineTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { ProceduralPackagingLine } from '../src/digital-twin/runtime/ProceduralPackagingLine';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const manifest = createSilkCakeLineTwinSceneManifest();
const route = manifest.routes[0];
const simulation = manifest.runtime.silkLineSimulation!;
const errors = validateTwinSceneManifest(manifest).filter((item) => item.severity === 'error');
assert(errors.length === 0, `V4 Manifest 校验失败：${errors.map((item) => item.message).join('；')}`);
assert(manifest.objects[0]?.procedural?.preset === 'silk-cake-packaging-line', '模板未使用 V4 完整工艺预设');
assert(simulation.silkCakesPerCart === 36, 'V4 丝车必须为 A/B 两面共 36 个丝饼');
assert(simulation.stackRows === 2 && simulation.stackColumns === 3 && simulation.stackLayers === 8, 'V4 木托盘必须为 2×3×8');

const runtime = new ProceduralPackagingLine(route, 50, {
	...simulation,
	robotCycleSeconds: 0.2,
	gantryCycleSeconds: 0.2,
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
for (const name of requiredObjects) assert(runtime.group.getObjectByName(name), `V4 场景缺少对象：${name}`);
assert(countByName('Gantry-Lane-A-3位') === 1, '桁架 A 线被重复绘制');
assert(countByName('Gantry-Lane-B-3位') === 1, '桁架 B 线被重复绘制');
assert(countByName('Gantry-Wood-Pallet-Lane') === 1, '木托盘大辊道被重复绘制');

const laneA = runtime.group.getObjectByName('Gantry-Lane-A-3位')!;
const laneB = runtime.group.getObjectByName('Gantry-Lane-B-3位')!;
const woodLane = runtime.group.getObjectByName('Gantry-Wood-Pallet-Lane')!;
const postLane = runtime.group.getObjectByName('满托后包装辊道')!;
assert(woodLane.position.z < laneA.position.z && woodLane.position.z < laneB.position.z, '木托盘大辊道没有移动到 A/B 线的上方');
assert(Math.abs(woodLane.position.z - postLane.position.z) < 0.000001, '木托盘线与后包装线不在同一直线上');

const routePoints = new Map(route.points.map((point) => [point.pointId, point.position]));
const sourcePoint = routePoints.get('silk-source')!;
const westPoint = routePoints.get('silk-return-west')!;
const diverterPoint = routePoints.get('silk-diverter')!;
const returnEntryLane = runtime.group.getObjectByName('空托盘回流入口')!;
const robotMainLane = runtime.group.getObjectByName('机器人上料及主输送')!;
assert(Math.hypot(returnEntryLane.position.x - (westPoint[0] + sourcePoint[0]) / 2, returnEntryLane.position.z - (westPoint[2] + sourcePoint[2]) / 2) < 0.001, '机器人侧回流辊道与回流路线端点不一致');
assert(Math.hypot(robotMainLane.position.x - (sourcePoint[0] + diverterPoint[0]) / 2, robotMainLane.position.z - (sourcePoint[2] + diverterPoint[2]) / 2) < 0.001, '机器人主辊道与路线中心线不一致');

const plasticPalletIds: string[] = [];
const plasticPalletObjects = new Map<string, any>();
runtime.group.traverse((object: any) => {
	if (object.userData?.twinEntityType === 'plastic-pallet') {
		plasticPalletIds.push(object.userData.twinEntityId);
		plasticPalletObjects.set(object.userData.twinEntityId, object);
	}
});
assert(plasticPalletIds.length === 50, `场景应包含 50 个塑料托盘，实际 ${plasticPalletIds.length}`);

let sawRobotBatch = false;
let sawCartSideB = false;
let sawGantryBatch = false;
let sawLayerEight = false;
let sawCovered = false;
let sawLabeled = false;
let sawWrapped = false;
let sawReturning = false;
let sawReturnedToLoading = false;
let sawDistinctMergedConvoy = false;
let minimumPalletGap = Number.POSITIVE_INFINITY;
const returningIds = new Set<string>();

runtime.setSpeed(24);
runtime.setRunning(true);
for (let tick = 0; tick < 30_000; tick += 1) {
	runtime.updateFixed(1 / 30);
	const current = runtime.getSnapshot();
	sawRobotBatch ||= current.robot.state === 'picking' && current.robot.batchSize === 6 && current.robot.emptyPalletsReady === 6;
	sawCartSideB ||= current.silkCart.activeSide === 'B';
	sawGantryBatch ||= current.gantry.state === 'picking' && current.gantry.laneA === 3 && current.gantry.laneB === 3;
	sawLayerEight ||= current.woodenPallet.layer === 8;
	sawCovered ||= current.postProcess.covered > 0;
	sawLabeled ||= current.postProcess.labeled > 0;
	sawWrapped ||= current.postProcess.wrapped > 0;
	const returningNow: Array<{ palletId: string; progress: number }> = [];
	for (const palletId of plasticPalletIds) {
		const detail = runtime.getEntityDetail('plastic-pallet', palletId);
		if (detail?.state === 'empty-return') {
			sawReturning = true;
			returningIds.add(palletId);
			returningNow.push({ palletId, progress: Number(detail.progress || 0) });
		}
		if (returningIds.has(palletId) && detail?.state === 'loading') sawReturnedToLoading = true;
	}
	for (let leftIndex = 0; leftIndex < plasticPalletIds.length; leftIndex += 1) {
		const leftId = plasticPalletIds[leftIndex];
		const left = plasticPalletObjects.get(leftId)!;
		for (let rightIndex = leftIndex + 1; rightIndex < plasticPalletIds.length; rightIndex += 1) {
			const rightId = plasticPalletIds[rightIndex];
			const right = plasticPalletObjects.get(rightId)!;
			const gap = Math.hypot(left.position.x - right.position.x, left.position.z - right.position.z);
			minimumPalletGap = Math.min(minimumPalletGap, gap);
			assert(gap >= 1.5 - 0.001, `托盘发生重叠/穿越：tick=${tick}，${leftId} 与 ${rightId} 中心距=${gap.toFixed(4)}m`);
		}
	}
	if (returningNow.length === 6 && returningNow.every((item) => item.progress > 0.45 && item.progress < 0.9)) {
		const uniquePositions = new Set(returningNow.map(({ palletId }) => {
			const position = plasticPalletObjects.get(palletId)!.position;
			return `${position.x.toFixed(3)},${position.z.toFixed(3)}`;
		}));
		sawDistinctMergedConvoy ||= uniquePositions.size === 6;
	}
	for (const section of current.sections) {
		assert(section.occupancy + section.reserved <= section.capacity, `${section.sectionId} 超出容量：${section.occupancy}+${section.reserved}>${section.capacity}`);
	}
	if (current.postProcess.stored > 0 && sawReturnedToLoading) break;
}

const snapshot = runtime.getSnapshot();
const returningDebug = plasticPalletIds.map((palletId) => {
	const detail = runtime.getEntityDetail('plastic-pallet', palletId);
	const position = plasticPalletObjects.get(palletId)!.position;
	return { palletId, ...detail, position: [Number(position.x.toFixed(2)), Number(position.z.toFixed(2))] };
}).filter((item) => item.state === 'empty-return');
assert(sawRobotBatch, '机器人没有按 1×6 整排批次抓取');
assert(sawCartSideB, `丝车 A 面完成后没有旋转到 B 面：${JSON.stringify({ snapshot, returningDebug })}`);
assert(sawGantryBatch, '桁架没有在 A/B 各 3 托盘就绪后执行 2×3 抓取');
assert(sawLayerEight, '木托盘没有完成 8 层码垛');
assert(sawCovered && sawLabeled && sawWrapped, '盖板、贴标、缠膜后处理没有全部执行');
assert(snapshot.postProcess.stored > 0, '完整木托盘没有进入立体库');
assert(sawReturning && sawReturnedToLoading, '空塑料托盘没有优先回到机器人上料位形成闭环');
assert(sawDistinctMergedConvoy, '六个空塑料托盘在汇流后发生视觉重合');

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
	woodPallet: '2×3×8 = 48',
	storedWoodPallets: snapshot.postProcess.stored,
	emptyPalletClosedLoop: sawReturnedToLoading,
	distinctPalletsAfterMerger: sawDistinctMergedConvoy,
	minimumPalletGapMeters: Number(minimumPalletGap.toFixed(3)),
	robotReturnRouteAligned: true,
	woodLanePosition: 'above A/B lanes',
	duplicateGantryLanes: false,
	status: 'PASS',
}, null, 2));
