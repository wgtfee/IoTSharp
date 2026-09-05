import * as THREE from 'three';
import { createSilkCakeLineTwinSceneManifest, validateTwinSceneManifest } from '../src/digital-twin/contracts';
import { ProceduralPackagingLine } from '../src/digital-twin/runtime/ProceduralPackagingLine';
import { upgradeSilkPackagingLayout } from '../src/digital-twin/runtime/SilkPackagingLayoutMigration';
import { migrateSilkLineInfrastructureToV7 } from '../src/digital-twin/components/SilkV7ComponentMigration';
import { PACKAGING_WOOD_PALLET_LENGTH, PACKAGING_WOOD_PALLET_WIDTH } from '../src/digital-twin/components/PackagingLineDimensions';
import { resolveGantryPose } from '../src/digital-twin/runtime/GantryPoseResolver';
import { silkLineLayout } from '../src/digital-twin/runtime/SilkLineLayout';
import { TwinSectionManager } from '../src/digital-twin/runtime/TwinMaterialFlowRuntime';

const assert = (condition: unknown, message: string) => {
	if (!condition) throw new Error(message);
};

const manifest = createSilkCakeLineTwinSceneManifest();
const legacyManifest = createSilkCakeLineTwinSceneManifest();
const legacyWoodRoute = legacyManifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route')!;
for (const point of legacyWoodRoute.points) {
	if (point.pointId === 'silk-cover') point.position = [33, 0.72, -11];
	if (point.pointId === 'silk-label') point.position = [37.5, 0.72, -11];
	if (point.pointId === 'silk-wrap') point.position = [42, 0.72, -11];
	if (point.pointId === 'silk-inbound') point.position = [48, 0.72, -11];
}
legacyWoodRoute.edges = legacyWoodRoute.edges.filter((edge) => edge.edgeId !== 'silk-wood-edge-wrap');
const legacyCoverEdge = legacyWoodRoute.edges.find((edge) => edge.edgeId === 'silk-wood-edge-cover')!;
legacyCoverEdge.toPointId = 'silk-label';
legacyCoverEdge.name = '盖板后输送段';
legacyWoodRoute.edges.push({ edgeId: 'silk-wood-edge-label', fromPointId: 'silk-label', toPointId: 'silk-wrap', name: '贴标后输送段', bidirectional: false, enabled: true, capacity: 1, occupancyMode: 'simulation', reservationTimeoutSeconds: 60, conveyorSizeClass: 'large', transportUnitType: 'wooden-pallet' });
const legacyInboundEdge = legacyWoodRoute.edges.find((edge) => edge.edgeId === 'silk-wood-edge-post-process')!;
legacyInboundEdge.fromPointId = 'silk-wrap';
legacyInboundEdge.name = '缠膜入库段';
assert(upgradeSilkPackagingLayout(legacyManifest), '旧 SQL/发布场景没有触发布局迁移');
const migratedWoodRoute = legacyManifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route')!;
const migratedPosition = (pointId: string) => migratedWoodRoute.points.find((point) => point.pointId === pointId)!.position[0];
assert(migratedPosition('silk-cover') === 40 && migratedPosition('silk-wrap') === 50 && migratedPosition('silk-label') === 60 && migratedPosition('silk-inbound') === 70, '旧场景后包装工位没有迁移到草图版大辊道坐标');
assert(migratedWoodRoute.edges.some((edge) => edge.edgeId === 'silk-wood-edge-cover' && edge.fromPointId === 'silk-cover' && edge.toPointId === 'silk-wrap'), '旧场景没有迁移成天盖→缠膜');
assert(migratedWoodRoute.edges.some((edge) => edge.edgeId === 'silk-wood-edge-wrap' && edge.fromPointId === 'silk-wrap' && edge.toPointId === 'silk-label'), '旧场景没有迁移成缠膜→贴标');
assert(!migratedWoodRoute.edges.some((edge) => edge.edgeId === 'silk-wood-edge-label'), '旧场景反向的贴标→缠膜边迁移后仍残留');
const migratedEquipmentPositions = new Map(legacyManifest.objects.filter((item) => item.kind === 'equipment' && item.equipment)
	.map((item) => [item.equipment!.equipmentType, item.transform.position[0]]));
const migratedGantryEquipment = legacyManifest.objects.find((item) => item.kind === 'equipment' && item.equipment?.equipmentType === 'gantry-stacker');
assert(migratedGantryEquipment?.transform.position[0] === 26 && migratedGantryEquipment?.transform.position[2] === -11, '旧发布场景的丝锭桁架设备根节点没有迁移到木托码垛中心 X=26,Z=-11');
assert(migratedEquipmentPositions.get('cover-applicator') === 40, '旧场景天盖设备根节点仍停在旧坐标');
assert(migratedEquipmentPositions.get('wrapper') === 50, '旧场景缠膜设备根节点仍停在旧坐标');
assert(migratedEquipmentPositions.get('labeler') === 60, '旧场景贴标设备根节点仍停在旧坐标');
assert(migratedEquipmentPositions.get('inbound-lift') === 70, '旧场景入库提升机根节点仍停在旧坐标');

// 回归线上 V12：桁架整机曾在专业编辑中被单独拖动，导致内部夹具/暂存台与木托码垛位失去同轴。
const driftedPublishedManifest = createSilkCakeLineTwinSceneManifest();
const driftedGantry = driftedPublishedManifest.objects.find((item) => item.kind === 'equipment' && item.equipment?.equipmentType === 'gantry-stacker')!;
driftedGantry.transform.position = [27.337860411128, 0, -12.4406179801199];
assert(upgradeSilkPackagingLayout(driftedPublishedManifest), '偏离中心线的发布版桁架没有触发同轴校正');
const alignedGantry = driftedPublishedManifest.objects.find((item) => item.kind === 'equipment' && item.equipment?.equipmentType === 'gantry-stacker')!;
const alignedWoodStack = driftedPublishedManifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route')!
	.points.find((point) => point.pointId === 'silk-wood-stack')!;
assert(alignedGantry.transform.position[0] === alignedWoodStack.position[0]
	&& alignedGantry.transform.position[2] === alignedWoodStack.position[2],
'最新发布版桁架没有与木托停留位恢复到同一条 Z 向中心线');

const legacyV7Manifest = createSilkCakeLineTwinSceneManifest();
const legacyV7WoodRoute = legacyV7Manifest.routes.find((item) => item.routeId === 'silk-wood-packaging-route')!;
for (const point of legacyV7WoodRoute.points) {
	if (point.pointId === 'silk-cover') point.position = [33, 0.72, -11];
	if (point.pointId === 'silk-label') point.position = [37.5, 0.72, -11];
	if (point.pointId === 'silk-wrap') point.position = [42, 0.72, -11];
	if (point.pointId === 'silk-inbound') point.position = [48, 0.72, -11];
}
migrateSilkLineInfrastructureToV7(legacyV7Manifest);
upgradeSilkPackagingLayout(legacyV7Manifest);
migrateSilkLineInfrastructureToV7(legacyV7Manifest);
const migratedCoverConveyor = (legacyV7Manifest.objects as any[]).find((item) => item.objectId === 'v7-silk-wood-edge-cover');
assert(migratedCoverConveyor?.transform?.position?.[0] === 45, '旧 V7 天盖→缠膜大辊道没有跟随草图版路线移动');
assert(Number(migratedCoverConveyor?.component?.properties?.length || 0) === 10, '旧 V7 天盖→缠膜大辊道长度没有扩展到 10m');
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
const woodPoints = new Map((woodRoute?.points || []).map((point) => [point.pointId, point]));
const woodStackX = Number(woodPoints.get('silk-wood-stack')?.position[0]);
const coverX = Number(woodPoints.get('silk-cover')?.position[0]);
const wrapX = Number(woodPoints.get('silk-wrap')?.position[0]);
const labelX = Number(woodPoints.get('silk-label')?.position[0]);
const inboundX = Number(woodPoints.get('silk-inbound')?.position[0]);
assert(woodStackX < coverX && coverX < wrapX && wrapX < labelX && labelX < inboundX, '木托后包装工位顺序必须是码垛→天盖→缠膜→贴标→入库');
assert(coverX - woodStackX >= 8 && wrapX - coverX >= 7 && labelX - wrapX >= 7 && inboundX - labelX >= 7, '后包装工位间距不足，大辊道缓冲段仍然太短');
assert(woodRoute?.edges.some((edge) => edge.edgeId === 'silk-wood-edge-cover' && edge.fromPointId === 'silk-cover' && edge.toPointId === 'silk-wrap'), '天盖后路线没有进入缠膜工位');
assert(woodRoute?.edges.some((edge) => edge.edgeId === 'silk-wood-edge-wrap' && edge.fromPointId === 'silk-wrap' && edge.toPointId === 'silk-label'), '缠膜后路线没有进入贴标工位');
assert(woodRoute?.edges.some((edge) => edge.edgeId === 'silk-wood-edge-post-process' && edge.fromPointId === 'silk-label' && edge.toPointId === 'silk-inbound'), '贴标后路线没有进入入库工位');

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
const gantryPickPose = resolveGantryPose(0.26, 0);
const gantryTransferPose = resolveGantryPose(0.52, 0);
const gantryPlacePose = resolveGantryPose(0.79, 0);
assert(Math.abs(gantryPickPose.carriage.x - silkLineLayout.woodPalletX) < 0.001, '丝锭抓取中心没有与木托码垛中心落在同一条 Z 向中心线');
assert(Math.abs(gantryTransferPose.carriage.x - silkLineLayout.woodPalletX) < 0.001, '丝锭夹具沿 Z 轴转运时仍存在 X 向漂移');
assert(Math.abs(gantryPlacePose.carriage.x - silkLineLayout.woodPalletX) < 0.001, '木托码垛位置没有与丝锭抓取中心保持同一 X 中心');

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
	'RobotAxis1-BaseYaw',
	'RobotAxis2-ShoulderPitch',
	'RobotAxis3-ElbowPitch',
	'RobotAxis4-WristRoll',
	'RobotAxis5-WristPitch',
	'RobotAxis6-ToolYaw',
	'RobotRowGripper-1x6',
	'外检机',
	'套袋机',
	'外检机输送段',
	'套袋机输送段',
	'空托检测分流段',
	'外检前空托短回流',
	'空托短回流机器人前接入段',
	'2×3丝饼码垛桁架',
	'Gantry-Z-Travel-Rail-A',
	'Gantry-Z-Travel-Rail-B',
	'Gantry-Silk-Rail-Carriage',
	'Gantry-Silk-Bridge',
	'Gantry-Silk-Rail-Shoe-1',
	'Gantry-Silk-Trolley',
	'Gantry-Separator-Rail-Carriage',
	'Gantry-Separator-Bridge',
	'Gantry-Separator-Rail-Shoe-1',
	'Gantry-Separator-Trolley',
	'Gantry-Z-Guide',
	'Gantry-Z-Slide',
	'GantryGripper-2x3',
	'Gantry-Separator-Z-Guide',
	'Gantry-Separator-Z-Slide',
	'Gantry-Separator-Gripper',
	'Gantry-Separator-Gripper-Backplate',
	'Gantry-Separator-Stock-Platform',
	'Gantry-Separator-Stock-Platform-02',
	'SeparatorFeeder-A',
	'SeparatorFeeder-B',
	'Gantry-Lane-A-3位',
	'Gantry-Lane-B-3位',
	'Gantry-Wood-Pallet-Lane',
	'满托后包装辊道',
	'天盖安装机',
	'TopCover-Gantry-Rail-L',
	'TopCover-Gantry-Rail-R',
	'TopCover-Gantry-Bridge',
	'TopCover-Gantry-Trolley',
	'TopCover-Gantry-Z-Slide',
	'TopCover-Gantry-Gripper',
	'TopCover-Stock-Table',
	'贴标机',
	'缠膜机',
	'入库提升机',
];
for (const name of requiredObjects) assert(runtime.group.getObjectByName(name), `V5 场景缺少对象：${name}`);

const silkCarriage = runtime.group.getObjectByName('Gantry-Silk-Rail-Carriage')!;
const gantryTrolley = runtime.group.getObjectByName('Gantry-Silk-Trolley')!;
const separatorCarriage = runtime.group.getObjectByName('Gantry-Separator-Rail-Carriage')!;
const separatorTrolley = runtime.group.getObjectByName('Gantry-Separator-Trolley')!;
const gantrySlide = runtime.group.getObjectByName('Gantry-Z-Slide')!;
const gantryGripper = runtime.group.getObjectByName('GantryGripper-2x3')!;
const separatorSlide = runtime.group.getObjectByName('Gantry-Separator-Z-Slide')!;
const separatorGripper = runtime.group.getObjectByName('Gantry-Separator-Gripper')!;
const gantryRoot = runtime.group.getObjectByName('2×3丝饼码垛桁架')!;
runtime.group.updateMatrixWorld(true);

// 场景必须直接复用组件设计器的最终丝锭桁架，而不是保留另一套旧运行时几何。
assert(gantryRoot.userData.runtimeModelSource === 'builtin-silk-gantry', '包装线场景没有直接复用组件设计器丝锭桁架模型');
assert(gantryRoot.userData.travelAxis === 'z', '丝锭桁架运行时轨道方向必须是 Z');
const gantryWorld = gantryRoot.getWorldPosition(new THREE.Vector3());
assert(Math.abs(gantryWorld.x - silkLineLayout.woodPalletX) < 0.001 && Math.abs(gantryWorld.z - (-11)) < 0.001, `丝锭桁架整机没有安装在木托码垛位：x=${gantryWorld.x.toFixed(3)} z=${gantryWorld.z.toFixed(3)}`);

assert(gantryGripper.parent === gantrySlide && gantrySlide.parent === gantryTrolley && gantryTrolley.parent === silkCarriage, '丝锭夹具机械层级错误');
assert(separatorGripper.parent === separatorSlide && separatorSlide.parent === separatorTrolley && separatorTrolley.parent === separatorCarriage, '隔板夹具机械层级错误');
assert(silkCarriage.parent === gantryRoot && separatorCarriage.parent === gantryRoot, '两个桥式夹具小车没有挂在同一套桁架根节点');
assert(silkCarriage.userData.railCarriage === true && separatorCarriage.userData.railCarriage === true, '丝锭/隔板没有建模成共享双轨上的独立小车');
assert(silkCarriage.userData.sharedRailPairId === separatorCarriage.userData.sharedRailPairId && silkCarriage.userData.sharedRailPairId === gantryRoot.userData.sharedRailPairId, '丝锭/隔板没有共享同一对 Z 向橙色轨道');
assert(silkCarriage.userData.servoAxisId === 'Gantry-Silk-Z-Travel' && separatorCarriage.userData.servoAxisId === 'Gantry-Separator-Z-Travel', '两个夹具没有使用独立 Z 轴伺服');
assert(silkCarriage.position.z > 0 && separatorCarriage.position.z < 0, '初始位置应为丝锭夹具 Z+、隔板夹具 Z-');

const silkBridge = runtime.group.getObjectByName('Gantry-Silk-Bridge')!;
const separatorBridge = runtime.group.getObjectByName('Gantry-Separator-Bridge')!;
assert(silkBridge.parent === silkCarriage && separatorBridge.parent === separatorCarriage, '两个桥式横梁没有分别挂在各自小车上');
const bridgeSizes = [silkBridge, separatorBridge].map((beam) => new THREE.Box3().setFromObject(beam).getSize(new THREE.Vector3()));
assert(bridgeSizes.every((size) => size.x > size.z * 8), '桥式小车没有沿 X 跨越两根 Z 轨');
assert(!runtime.group.getObjectByName('Gantry-X-Travel-Rail-A') && !runtime.group.getObjectByName('Gantry-X-Travel-Rail-B'), '运行时仍残留旧 X 向桁架轨道');
assert(!runtime.group.getObjectByName('Gantry-Silk-Travel-Beam') && !runtime.group.getObjectByName('Gantry-Separator-Travel-Beam'), '运行时仍残留旧的 Z 跨向 travel beam');

const orangeRails = ['Gantry-Z-Travel-Rail-A', 'Gantry-Z-Travel-Rail-B'].map((name) => runtime.group.getObjectByName(name)!);
assert(orangeRails.every((rail) => rail.userData.longitudinalRail === true && rail.userData.fixedSharedRail === true && rail.userData.sharedOrangeRail === true), '码垛桁架两根 Z 轨没有保持橙色共享轨道身份');
assert(orangeRails.every((rail) => rail.userData.travelAxis === 'z' && rail.userData.sharedRailPairId === gantryRoot.userData.sharedRailPairId), '两根橙色轨道没有形成同一 Z 向 railPair');
const railSizes = orangeRails.map((rail) => new THREE.Box3().setFromObject(rail).getSize(new THREE.Vector3()));
assert(railSizes.every((size) => size.z > 26 && size.z > size.x * 50), 'Z 向橙色轨道跨度没有保持约 27m');
const orangeRailMaterialColors = orangeRails.map((rail: any) => (Array.isArray(rail.material) ? rail.material[0] : rail.material)?.color?.getHex?.());
assert(orangeRailMaterialColors.every((color) => color === 0xf97316), '运行时真正轨道必须是橙色');
const railCenters = orangeRails.map((rail) => new THREE.Box3().setFromObject(rail).getCenter(new THREE.Vector3())).sort((a,b)=>a.x-b.x);
const silkShoes = [1, 2].map((index) => runtime.group.getObjectByName(`Gantry-Silk-Rail-Shoe-${index}`)!);
const separatorShoes = [1, 2].map((index) => runtime.group.getObjectByName(`Gantry-Separator-Rail-Shoe-${index}`)!);
for (const [label, shoes] of [['丝锭', silkShoes], ['隔板', separatorShoes]] as Array<[string, THREE.Object3D[]]>) {
	const centers = shoes.map((shoe) => new THREE.Box3().setFromObject(shoe).getCenter(new THREE.Vector3())).sort((a,b)=>a.x-b.x);
	assert(centers.every((center, index) => Math.abs(center.x - railCenters[index].x) < 0.001), `${label}桥式小车没有同时挂到两根 Z 向橙色轨道上`);
}

const silkFootprint = new THREE.Box3().setFromObject(runtime.group.getObjectByName('Gantry-Silk-Gripper-2x3')!).getSize(new THREE.Vector3());
assert(Math.abs(silkFootprint.x - 4.2) < 0.001 && Math.abs(silkFootprint.z - 4.0) < 0.001, '丝锭 2×3 夹具平面必须是 4.2m×4.0m');
const separatorBackplate = runtime.group.getObjectByName('Gantry-Separator-Gripper-Backplate')!;
const separatorBackplateSize = new THREE.Box3().setFromObject(separatorBackplate).getSize(new THREE.Vector3());
assert(Math.abs(separatorBackplateSize.x - 4.2) < 0.001 && Math.abs(separatorBackplateSize.z - 4.0) < 0.001, '隔板夹具实体背板必须与 2×3 码垛平面一致');
const vacuumCups: THREE.Object3D[] = [];
separatorGripper.traverse((node) => { if (node.userData.vacuumCup === true) vacuumCups.push(node); });
assert(vacuumCups.length === 6, '隔板夹具实体背板下必须有 6 个真空吸盘');

const separatorStock1 = runtime.group.getObjectByName('Gantry-Separator-Stock-Platform')!;
const separatorStock2 = runtime.group.getObjectByName('Gantry-Separator-Stock-Platform-02')!;
const separatorFeederA = runtime.group.getObjectByName('SeparatorFeeder-A')!;
const separatorFeederB = runtime.group.getObjectByName('SeparatorFeeder-B')!;
assert(separatorStock1.userData.separatorCategory === 'A' && separatorStock2.userData.separatorCategory === 'B', '两个隔板暂存台必须分别只存 A/B 一类隔板');
assert(separatorFeederA.parent === separatorStock1 && separatorFeederB.parent === separatorStock2, 'A/B 隔板料堆没有分别放在两个暂存台上');
const stock1World = separatorStock1.getWorldPosition(new THREE.Vector3());
const stock2World = separatorStock2.getWorldPosition(new THREE.Vector3());
assert(stock1World.z < gantryWorld.z && stock2World.z < stock1World.z, '两个隔板暂存台必须从码垛位向 Z- 排列');
for (const [stock, feeder, category] of [[separatorStock1, separatorFeederA, 'A'], [separatorStock2, separatorFeederB, 'B']] as Array<[THREE.Object3D, THREE.Object3D, string]>) {
	const sheets: THREE.Object3D[] = [];
	feeder.traverse((node) => { if (node.name.startsWith('SeparatorSheet-')) sheets.push(node); });
	assert(sheets.length === 5 && sheets.every((sheet) => sheet.userData.separatorCategory === category), `暂存台 ${category} 只能存在一类隔板`);
	assert(sheets.every((sheet) => { const size = new THREE.Box3().setFromObject(sheet).getSize(new THREE.Vector3()); return Math.abs(size.x - PACKAGING_WOOD_PALLET_LENGTH) < 0.001 && Math.abs(size.z - PACKAGING_WOOD_PALLET_WIDTH) < 0.001; }), `暂存台 ${category} 的隔板尺寸没有与木托盘一致`);
}
const railZMin = Math.min(...orangeRails.map((rail) => new THREE.Box3().setFromObject(rail).min.z));
const railZMax = Math.max(...orangeRails.map((rail) => new THREE.Box3().setFromObject(rail).max.z));
for (const stock of [separatorStock1, separatorStock2]) {
	const box = new THREE.Box3().setFromObject(stock);
	assert(box.min.z >= railZMin - 0.001 && box.max.z <= railZMax + 0.001, `${stock.name} 没有完整落在 Z 向橙色轨道行程下方`);
}

// 独立伺服只改变各自桥式小车的 Z 行走位置。
runtime.setGantryServoPositions();
const initialSilkZ = silkCarriage.position.z;
const initialSeparatorZ = separatorCarriage.position.z;
const rootZ = gantryRoot.getWorldPosition(new THREE.Vector3()).z;
runtime.setGantryServoPositions({ silkZ: rootZ + initialSilkZ + 0.55 });
assert(Math.abs(silkCarriage.position.z - (initialSilkZ + 0.55)) < 0.001 && Math.abs(separatorCarriage.position.z - initialSeparatorZ) < 0.001, '丝锭桥没有在 Z 轨上独立伺服驱动');
runtime.setGantryServoPositions({ separatorZ: rootZ + initialSeparatorZ - 0.45 });
assert(Math.abs(separatorCarriage.position.z - (initialSeparatorZ - 0.45)) < 0.001 && Math.abs(silkCarriage.position.z - (initialSilkZ + 0.55)) < 0.001, '隔板桥没有在 Z 轨上独立伺服驱动');
runtime.setGantryServoPositions();
assert(Math.abs(silkCarriage.position.z - initialSilkZ) < 0.001 && Math.abs(separatorCarriage.position.z - initialSeparatorZ) < 0.001, '清除 Z 轴伺服覆盖后没有恢复离线仿真位置');

const horizontalBoxGap = (left: THREE.Box3, right: THREE.Box3) => {
	const gapX = left.min.x > right.max.x ? left.min.x - right.max.x : right.min.x > left.max.x ? right.min.x - left.max.x : 0;
	const gapZ = left.min.z > right.max.z ? left.min.z - right.max.z : right.min.z > left.max.z ? right.min.z - left.max.z : 0;
	return Math.hypot(gapX, gapZ);
};

const coverGantry = runtime.group.getObjectByName('天盖安装机')!;
assert(coverGantry.userData.doubleRail === true, '天盖安装机不是独立双轨桁架');
assert(coverGantry.userData.runtimeModelSource === 'builtin-top-cover-gantry', '场景天盖桁架没有复用组件设计器模型');
const coverGantryWorld = coverGantry.getWorldPosition(new THREE.Vector3());
assert(Math.abs(coverGantryWorld.x - coverX) < 0.001 && Math.abs(coverGantryWorld.z - (-11)) < 0.001,
	`替换天盖模型后原有工位位置发生变化: x=${coverGantryWorld.x.toFixed(3)} z=${coverGantryWorld.z.toFixed(3)}`);
const coverGripper = runtime.group.getObjectByName('TopCover-Gantry-Gripper')!;
const readyCover = coverGripper.getObjectByName('TopCover-Ready')!;
const readyCoverSize = new THREE.Box3().setFromObject(readyCover).getSize(new THREE.Vector3());
assert(Math.abs(readyCoverSize.x - PACKAGING_WOOD_PALLET_LENGTH) < 0.001
	&& Math.abs(readyCoverSize.z - PACKAGING_WOOD_PALLET_WIDTH) < 0.001,
'天盖尺寸没有与木托盘一致');
const readyCoverMaterial: any = Array.isArray((readyCover as any).material) ? (readyCover as any).material[0] : (readyCover as any).material;
assert(readyCoverMaterial?.color?.getHex?.() === 0x9b6a3c, '场景中的天盖没有使用棕色纸壳材质');
assert((readyCoverMaterial?.metalness ?? 1) <= 0.001 && (readyCoverMaterial?.roughness ?? 0) >= 0.9, '场景中的天盖仍呈现金属质感');
const initialWoodPalletId = runtime.getSnapshot().woodenPallet.id!;
const initialWoodPallet = runtime.group.getObjectByName(initialWoodPalletId)!;
const initialWoodPalletSize = new THREE.Box3().setFromObject(initialWoodPallet).getSize(new THREE.Vector3());
assert(Math.abs(initialWoodPalletSize.x - PACKAGING_WOOD_PALLET_LENGTH) < 0.001
	&& Math.abs(initialWoodPalletSize.z - PACKAGING_WOOD_PALLET_WIDTH) < 0.001,
'包装线木托盘实体尺寸与标准承载面不一致');
assert(Math.abs(initialWoodPalletSize.x - readyCoverSize.x) < 0.001
	&& Math.abs(initialWoodPalletSize.z - readyCoverSize.z) < 0.001,
'天盖与木托盘外轮廓不一致');
const coverStockTable = runtime.group.getObjectByName('TopCover-Stock-Table')!;
assert(Boolean(coverGripper.getObjectByName('TopCover-Ready')), '天盖桁架初始没有预抓一块天盖等待');
const coverRailL = runtime.group.getObjectByName('TopCover-Gantry-Rail-L')!;
const coverRailR = runtime.group.getObjectByName('TopCover-Gantry-Rail-R')!;
assert(coverRailL.userData.travelAxis === 'z' && coverRailR.userData.travelAxis === 'z', '天盖双轨必须沿 Z 轴运行');
const coverRailSizes = [coverRailL, coverRailR].map((rail) => new THREE.Box3().setFromObject(rail).getSize(new THREE.Vector3()));
assert(coverRailSizes.every((size) => size.z > size.x * 8), '天盖橙色双轨没有沿 Z 方向拉长');
for (const rail of [coverRailL, coverRailR] as any[]) {
	const material = Array.isArray(rail.material) ? rail.material[0] : rail.material;
	assert(material?.color?.getHex?.() === 0xf97316, '天盖真实轨道必须保持橙色');
}
const coverBridge = runtime.group.getObjectByName('TopCover-Gantry-Bridge')!;
const coverBridgeSize = new THREE.Box3().setFromObject(coverBridge.getObjectByName('TopCover-Gantry-Bridge-Beam')!).getSize(new THREE.Vector3());
assert(coverBridge.userData.travelAxis === 'z' && coverBridgeSize.x > coverBridgeSize.z * 8, '天盖桥式小车没有跨双轨并沿 Z 运行');
const coverShoes = [1, 2].map((index) => runtime.group.getObjectByName(`TopCover-Gantry-Rail-Shoe-${index}`)!);
assert(coverShoes.every((shoe) => shoe?.userData?.railMounted === true), '天盖桥式小车没有同时挂到两根橙色轨道');
runtime.group.updateMatrixWorld(true);
const coverRailBoxes = [coverRailL, coverRailR].map((rail) => new THREE.Box3().setFromObject(rail));
const coverCorridorZMin = Math.min(...coverRailBoxes.map((box) => box.min.z));
const coverCorridorZMax = Math.max(...coverRailBoxes.map((box) => box.max.z));
const coverStockBox = new THREE.Box3().setFromObject(coverStockTable);
assert(coverStockTable.userData.underSharedRails === true && coverStockTable.userData.zNegativeStock === true, '天盖暂存台没有放到 Z- 延长区轨道下方');
assert(coverStockBox.min.z >= coverCorridorZMin - 0.001 && coverStockBox.max.z <= coverCorridorZMax + 0.001, '天盖暂存台超出 Z 向轨道覆盖范围');
const coverStockWorld = coverStockTable.getWorldPosition(new THREE.Vector3());
assert(coverStockWorld.z < coverGantryWorld.z - 3.0, '天盖暂存台没有向 Z- 拉开，仍可能与大辊道碰撞');
const coverSupportPosts: THREE.Object3D[] = [];
coverGantry.traverse((object) => { if (object.userData.gantrySupportPost === true) coverSupportPosts.push(object); });
assert(coverSupportPosts.length === 4, '天盖桁架没有识别到四根固定支柱');
for (const post of coverSupportPosts) {
	const gap = horizontalBoxGap(coverStockBox, new THREE.Box3().setFromObject(post));
	assert(gap >= 0.15, `天盖暂存台与固定支柱净距不足：${post.name} gap=${gap.toFixed(3)}m`);
}
const gantryBox = new THREE.Box3().setFromObject(gantryRoot);
const coverGantryBox = new THREE.Box3().setFromObject(coverGantry);
assert(gantryBox.max.x < coverGantryBox.min.x - 0.25, `天盖桁架仍与码垛桁架重叠：stackMaxX=${gantryBox.max.x.toFixed(2)}, coverMinX=${coverGantryBox.min.x.toFixed(2)}`);

const wrapperStation = runtime.group.getObjectByName('缠膜机')!;
const labelStation = runtime.group.getObjectByName('贴标机')!;
const inboundStation = runtime.group.getObjectByName('入库提升机')!;
assert(wrapperStation.userData.runtimeModelSource === 'builtin-wrapper-machine', '场景缠膜机没有复用组件设计器模型');
assert(wrapperStation.userData.wrapperType === 'rotary-arm' && wrapperStation.userData.loadStationary === true, '场景缠膜机不是静止货物的悬臂/旋臂式结构');
const wrapperWorld = wrapperStation.getWorldPosition(new THREE.Vector3());
assert(Math.abs(wrapperWorld.x - wrapX) < 0.001 && Math.abs(wrapperWorld.z - (-11)) < 0.001, `替换缠膜模型后原有工位位置发生变化: x=${wrapperWorld.x.toFixed(3)} z=${wrapperWorld.z.toFixed(3)}`);
assert(!runtime.group.getObjectByName('WrapperRing'), '场景仍残留旧圆环式 WrapperRing');
const wrapperRotaryArm = runtime.group.getObjectByName('Wrapper-Rotary-Arm') as THREE.Group;
const wrapperFilmCarriage = runtime.group.getObjectByName('Wrapper-Film-Carriage') as THREE.Group;
assert(Boolean(wrapperRotaryArm) && wrapperRotaryArm.userData.rotationAxis === 'y', '场景悬臂没有挂接 Y 轴回转运动');
assert(Boolean(wrapperFilmCarriage) && wrapperFilmCarriage.userData.travelAxis === 'y', '场景膜车没有挂接竖直 Y 轴升降运动');
assert(coverGantry.position.x < wrapperStation.position.x && wrapperStation.position.x < labelStation.position.x && labelStation.position.x < inboundStation.position.x, '3D 后包装设备顺序不是天盖→缠膜→贴标→入库');
assert(wrapperStation.position.x - coverGantry.position.x >= 7 && labelStation.position.x - wrapperStation.position.x >= 7 && inboundStation.position.x - labelStation.position.x >= 7, '3D 后包装设备间距不足，设备仍可能重叠');
const postProcessRoot = runtime.group.getObjectByName('木托盘后包装与立库入库线')!;
const largeConveyorStartX = Number(postProcessRoot.userData.largeConveyorStartX || 0);
const largeConveyorEndX = Number(postProcessRoot.userData.largeConveyorEndX || 0);
assert(largeConveyorEndX - largeConveyorStartX >= 30, `后包装大辊道没有真正加长：length=${(largeConveyorEndX - largeConveyorStartX).toFixed(2)}m`);

const coveredPackageTop = 0.72 + 0.45 + 8 * 0.46 + 0.06;
assert(labelStation.userData.runtimeModelSource === 'builtin-labeling-machine', '场景贴标机没有复用组件设计器模型');
assert(labelStation.userData.labelerType === 'pallet-print-apply' && labelStation.userData.loadStationary === true, '场景贴标机不是停托盘后执行的打印贴标机');
const labelWorld = labelStation.getWorldPosition(new THREE.Vector3());
assert(Math.abs(labelWorld.x - labelX) < 0.001 && Math.abs(labelWorld.z - (-11)) < 0.001, `替换贴标模型后原工位位置发生变化: x=${labelWorld.x.toFixed(3)} z=${labelWorld.z.toFixed(3)}`);
assert(!runtime.group.getObjectByName('LabelPortal') && !runtime.group.getObjectByName('LabelHead') && !runtime.group.getObjectByName('贴标执行头'), '场景仍残留旧门架/固定贴标头');
const labelJoint1 = runtime.group.getObjectByName('Labeler-Arm-Joint-1') as THREE.Group;
const labelJoint2 = runtime.group.getObjectByName('Labeler-Arm-Joint-2') as THREE.Group;
const labelJoint3 = runtime.group.getObjectByName('Labeler-Arm-Joint-3') as THREE.Group;
const labelTampPad = runtime.group.getObjectByName('Labeler-Tamp-Pad') as THREE.Group;
assert(Boolean(labelJoint1) && Boolean(labelJoint2) && Boolean(labelJoint3), '场景贴标机三关节电动臂没有完整加载');
assert(labelJoint2.parent === labelJoint1 && labelJoint3.parent === labelJoint2, '场景贴标机三关节机械链断开');
assert(Boolean(labelTampPad) && labelTampPad.userData.applyMethod === 'electric-tamp', '场景贴标机缺少电动 Tamp 贴标板');
assert(Boolean(runtime.group.getObjectByName('Labeler-Printer-Module')) && Boolean(runtime.group.getObjectByName('Labeler-Label-Supply-Roll')), '场景贴标机缺少打印机本体或标签卷');
assert(Boolean(runtime.group.getObjectByName('Labeler-Code-Verification-Camera')), '场景贴标机缺少 1D/2D 校验摄像头');
const labelStand = runtime.group.getObjectByName('Labeler-Floor-Stand')!;
const labelStandBox = new THREE.Box3().setFromObject(labelStand);
assert(labelStandBox.min.z > labelWorld.z + PACKAGING_WOOD_PALLET_WIDTH / 2, '贴标机机身/落地架侵入大辊道满托通行包络');
const wrapperPosts: THREE.Object3D[] = [];
wrapperStation.traverse((object) => { if (object.userData.wrapperSupportPost === true) wrapperPosts.push(object); });
assert(wrapperPosts.length === 4, '场景四立柱悬臂缠膜机没有完整复用四根固定立柱');
assert(wrapperPosts.filter((post) => post.userData.conveyorSide === 'negative-z').length === 2
  && wrapperPosts.filter((post) => post.userData.conveyorSide === 'positive-z').length === 2,
  '场景缠膜机四根立柱没有在大辊道两侧各布置两根');
const wrapperLongitudinals: THREE.Object3D[] = [];
const wrapperCrosses: THREE.Object3D[] = [];
wrapperStation.traverse((object) => {
  if (object.userData.topFrameLongitudinal === true) wrapperLongitudinals.push(object);
  if (object.userData.topFrameCross === true) wrapperCrosses.push(object);
});
assert(wrapperLongitudinals.length === 2 && wrapperCrosses.length === 2, '场景缠膜机顶部没有形成完整矩形四边刚架');
const wrapperHubBridge = runtime.group.getObjectByName('Wrapper-Frame-Hub-Bridge')!;
assert(Boolean(wrapperHubBridge) && wrapperHubBridge.userData.hubSupportBeam === true, '场景缠膜机缺少中央回转承力梁');
const coverRailBottom = Math.min(new THREE.Box3().setFromObject(coverRailL).min.y, new THREE.Box3().setFromObject(coverRailR).min.y);
assert(coverRailBottom - coveredPackageTop >= 0.55, `天盖双轨桁架净空不足：railBottom=${coverRailBottom.toFixed(3)} packageTop=${coveredPackageTop.toFixed(3)}`);
const wrapperTopFrameBottom = Math.min(...[...wrapperLongitudinals, ...wrapperCrosses].map((beam) => new THREE.Box3().setFromObject(beam).min.y));
assert(wrapperTopFrameBottom - coveredPackageTop >= 0.55, `悬臂缠膜机顶部刚架净空不足: frameBottom=${wrapperTopFrameBottom.toFixed(3)} packageTop=${coveredPackageTop.toFixed(3)}`);
const inboundLift = runtime.group.getObjectByName('入库提升机')!;
assert(Number(inboundLift.userData.clearanceHalfX || 0) > 2.35, '入库提升机 X 向导轨会穿过满托');
assert(Number(inboundLift.userData.clearanceHalfZ || 0) > 1.24, '入库提升机 Z 向导轨会穿过满托');
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
assert(plasticPalletIds.length === 80, `场景应包含 80 个绿色小托盘，实际 ${plasticPalletIds.length}`);
assert(runtime.getSnapshot().plasticPallets.sourceQueue === 0, '启动后 SourceQueue 必须为 0，80 个托盘都应在物理线体中');

let sawRobotBatch = false;
let sawSpindleParallelRobotPickup = false;
let sawCartSideB = false;
let sawGantryBatch = false;
let sawSeparatorCycle = false;
let sawSeparatorPlaced = false;
let sawCoverReload = false;
let sawCoverReturnedReady = false;
let sawInspection = false;
let sawBagging = false;
let sawLayerEight = false;
let sawCovered = false;
let sawLabeled = false;
let sawWrapped = false;
let sawLabelArmMotion = false;
let sawWrapperArmMotion = false;
let sawWrapperFilmLift = false;
let lastWrapperArmAngle = wrapperRotaryArm.rotation.y;
let lastWrapperCarriageY = wrapperFilmCarriage.position.y;
let sawReturning = false;
let sawReturnedToLoading = false;
let sawDistinctMergedConvoy = false;
let sawEmptyBypass = false;
let sawRobotTcpTracking = false;
let sawRobotSafeTransfer = false;
let sawRobotBaseClearanceSwing = false;
let sawRobotAngularSwing = false;
let sawSideBOrderedPickup = false;
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
	const gantryDetail = runtime.getEntityDetail('gantry-stacker', 'GantryStacker-01') as any;
	const gantryTask = gantryDetail?.task;
	if (gantryTask?.state === 'separator') {
		sawSeparatorCycle = true;
		const silkTrolleyWorldZ = gantryTrolley.getWorldPosition(new THREE.Vector3()).z;
		assert(Math.abs(silkTrolleyWorldZ - (-5.9)) < 0.05, `隔板夹具进入木托作业时，丝锭夹具没有先回到小辊道取丝侧：z=${silkTrolleyWorldZ.toFixed(3)}`);
		const separatorGuideBox = new THREE.Box3().setFromObject(runtime.group.getObjectByName('Gantry-Separator-Z-Guide')!);
		const separatorSlideBar = runtime.group.getObjectByName('Gantry-Separator-Z-Slide-Bar')!;
		const separatorSlideBox = new THREE.Box3().setFromObject(separatorSlideBar);
		assert(separatorSlideBar.userData.axisContinuous === true
			&& separatorSlideBox.max.y >= separatorGuideBox.min.y - 0.001,
		`隔板夹爪牵引轴出现断层：guideBottom=${separatorGuideBox.min.y.toFixed(3)}, slideTop=${separatorSlideBox.max.y.toFixed(3)}`);
	}
	if (current.woodenPallet.id) {
		const activeWoodDetail = runtime.getEntityDetail('wooden-pallet', current.woodenPallet.id) as any;
		const activeWoodRoot = runtime.group.getObjectByName(current.woodenPallet.id);
		if (activeWoodDetail && activeWoodRoot) {
			let boardCount = 0;
			activeWoodRoot.traverse((object) => { if (object.userData.separatorBoard === true) boardCount += 1; });
			assert(boardCount === Number(activeWoodDetail.separatorCount || 0), `木托盘隔板实体数量与运行状态不一致：mesh=${boardCount}, state=${activeWoodDetail.separatorCount}`);
			if (gantryTask?.state === 'picking' && Number(gantryTask.progress || 0) < 0.08) {
				assert(Number(activeWoodDetail.separatorCount || 0) === Number(activeWoodDetail.layer || 0), '上一层隔板未放置完成就启动了下一层丝锭抓取');
			}
			if (Number(activeWoodDetail.separatorCount || 0) > 0) sawSeparatorPlaced = true;
		}
	}
	const coverState = String(coverGantry.userData.coverGantryState || '');
	if (coverState === 'reload-to-stock' || coverState === 'reload-pick' || coverState === 'reload-return') sawCoverReload = true;
	if (Number(coverStockTable.userData.pickCount || 0) > 0 && coverState === 'waiting' && Boolean(coverGripper.getObjectByName('TopCover-Ready'))) sawCoverReturnedReady = true;
	const robotDetail = runtime.getEntityDetail('loading-robot', 'LoadingRobot-01') as any;
	const robotTask = robotDetail?.task;
	const robotGripper = runtime.group.getObjectByName('RobotRowGripper-1x6');
	if (current.robot.state === 'picking' && robotGripper) {
		const tcpError = Number(robotGripper.userData?.tcpErrorMeters ?? Number.POSITIVE_INFINITY);
		assert(tcpError < 0.015, `机器人 TCP 未跟随工艺轨迹：error=${tcpError.toFixed(4)}m`);
		sawRobotTcpTracking = true;
		if (robotTask?.progress >= 0.38 && robotTask?.progress <= 0.64) {
			const tcpWorld = robotGripper.getWorldPosition(new THREE.Vector3());
			assert(tcpWorld.y >= 4.45, `机器人横向转运高度不足，可能穿过丝饼：Y=${tcpWorld.y.toFixed(3)}`);
			sawRobotSafeTransfer = true;
		}
		if (robotTask?.progress >= 0.48 && robotTask?.progress <= 0.62) {
			const baseDistance = Number(robotGripper.userData?.transferBaseDistanceMeters ?? 0);
			const clearanceRadius = Number(robotGripper.userData?.transferBaseClearanceRadiusMeters ?? 3.75);
			const swingRadius = Number(robotGripper.userData?.transferSwingRadiusMeters ?? 4.10);
			const angleDelta = Math.abs(Number(robotGripper.userData?.transferAngleDeltaRadians ?? 0));
			const startAngle = Number(robotGripper.userData?.transferStartAngleRadians ?? 0);
			const currentAngle = Number(robotGripper.userData?.transferCurrentAngleRadians ?? startAngle);
			const observedAngleDelta = Math.abs(Math.atan2(Math.sin(currentAngle - startAngle), Math.cos(currentAngle - startAngle)));
			assert(baseDistance >= clearanceRadius - 0.02, `机器人高位换向切入基座禁区：radius=${baseDistance.toFixed(3)}m < ${clearanceRadius.toFixed(3)}m`);
			assert(Math.abs(baseDistance - swingRadius) < 0.03, `机器人高位换向没有保持固定绕行半径：radius=${baseDistance.toFixed(3)}m`);
			sawRobotBaseClearanceSwing = true;
			if (angleDelta > 0.10 && observedAngleDelta > 0.05) sawRobotAngularSwing = true;
		}
		if (robotTask?.side === 'B' && robotTask?.attachedAtPick && !robotTask?.attachedAtPlace && Array.isArray(robotTask?.silkCakeIds)) {
			const xs = robotTask.silkCakeIds.map((id: string) => runtime.group.getObjectByName(id)?.getWorldPosition(new THREE.Vector3()).x ?? Number.NaN);
			assert(xs.every((value: number) => Number.isFinite(value)), 'B 面机器人抓取期间存在找不到的丝饼对象');
			assert(xs.every((value: number, index: number) => index === 0 || value > xs[index - 1] - 0.001), `B 面丝饼发生左右反转/交叉：${JSON.stringify(xs)}`);
			sawSideBOrderedPickup = true;
		}
	}
	sawEmptyBypass ||= current.preProcess.emptyBypassCount > 0;
	sawRobotBatch ||= current.robot.state === 'picking' && current.robot.batchSize === 6 && current.robot.emptyPalletsReady === 6;
	if (current.robot.state === 'picking') {
		const robotDetail = runtime.getEntityDetail('loading-robot', 'LoadingRobot-01') as any;
		const task = robotDetail?.task;
		const gripper = runtime.group.getObjectByName('RobotRowGripper-1x6');
		if (task?.pickCenterWorld && task?.pickApproachWorld && gripper && task.progress >= 0.14 && task.progress <= 0.22) {
			const pickCenter = new THREE.Vector3(task.pickCenterWorld.x, task.pickCenterWorld.y, task.pickCenterWorld.z);
			const approach = new THREE.Vector3(task.pickApproachWorld.x, task.pickApproachWorld.y, task.pickApproachWorld.z).normalize();
			const tcp = gripper.getWorldPosition(new THREE.Vector3());
			const contactCenterDistance = Number(gripper.userData?.contactCenterDistanceMeters || 0.59);
			const pickTcp = pickCenter.clone().addScaledVector(approach, contactCenterDistance);
			const offset = tcp.clone().sub(pickTcp);
			const alongAxis = approach.clone().multiplyScalar(offset.dot(approach));
			const perpendicularError = offset.clone().sub(alongAxis).length();
			assert(Math.abs(tcp.y - pickTcp.y) < 0.015, `机器人取丝仍在上下偏移，TCP 未与丝锭轴线等高：${Math.abs(tcp.y - pickTcp.y).toFixed(4)}m`);
			assert(perpendicularError < 0.02, `机器人取丝接近轨迹未平行丝锭轴线，垂直偏差 ${perpendicularError.toFixed(4)}m`);
			sawSpindleParallelRobotPickup = true;
		}
		if (task?.pickApproachWorld && task?.attachedAtPick && !task?.attachedAtPlace && task.progress >= 0.22 && task.progress <= 0.30) {
			const approach = new THREE.Vector3(task.pickApproachWorld.x, task.pickApproachWorld.y, task.pickApproachWorld.z).normalize();
			const contactCenterDistance = Number(gripper.userData?.contactCenterDistanceMeters || 0.59);
			const expectedGap = Number(gripper.userData?.contactGapMeters || 0.02);
			const firstHead = runtime.group.getObjectByName('RobotGripperHead-1');
			const firstCakeId = Array.isArray(task.silkCakeIds) ? task.silkCakeIds[0] : undefined;
			const firstCake = firstCakeId ? runtime.group.getObjectByName(firstCakeId) : undefined;
			if (firstHead && firstCake) {
				const headWorld = firstHead.getWorldPosition(new THREE.Vector3());
				const cakeWorld = firstCake.getWorldPosition(new THREE.Vector3());
				const centerDelta = headWorld.clone().sub(cakeWorld);
				const along = centerDelta.dot(approach);
				const perpendicular = centerDelta.clone().addScaledVector(approach, -along).length();
				const headAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(firstHead.getWorldQuaternion(new THREE.Quaternion())).normalize();
				assert(Math.abs(Math.abs(headAxis.dot(approach)) - 1) < 0.002, '机器人抓头轴线没有与丝锭轴线平行');
				assert(perpendicular < 0.02, `机器人抓头中心没有对准丝锭轴线：${perpendicular.toFixed(4)}m`);
				assert(Math.abs(along - contactCenterDistance) < 0.02, `机器人抓头与丝锭中心距错误，存在穿模风险：${along.toFixed(4)}m`);
				const headTipReach = Number(firstHead.userData?.headTipReachMeters || 0.36);
				const surfaceGap = along - headTipReach - 0.21;
				assert(surfaceGap >= expectedGap - 0.01, `机器人抓头已经穿入丝锭：gap=${surfaceGap.toFixed(4)}m`);
			}
		}
	}
	sawCartSideB ||= current.silkCart.activeSide === 'B';
	sawGantryBatch ||= current.gantry.state === 'picking' && current.gantry.laneA === 3 && current.gantry.laneB === 3;
	sawInspection ||= current.preProcess.inspection.state === 'processing' || current.preProcess.inspection.passed > 0;
	sawBagging ||= current.preProcess.bagging.state === 'processing' || current.preProcess.bagging.completed > 0;
	sawLayerEight ||= current.woodenPallet.layer === 8;
	sawCovered ||= current.postProcess.covered > 0;
	sawLabeled ||= current.postProcess.labeled > 0;
	sawWrapped ||= current.postProcess.wrapped > 0;
	if (Number(labelStation.userData.armApplyFactor || 0) > 0.35) sawLabelArmMotion = true;
	if (wrapperStation.userData.wrapperState === 'wrapping') {
		if (Math.abs(wrapperRotaryArm.rotation.y - lastWrapperArmAngle) > 0.001) sawWrapperArmMotion = true;
		if (Math.abs(wrapperFilmCarriage.position.y - lastWrapperCarriageY) > 0.001) sawWrapperFilmLift = true;
	}
	lastWrapperArmAngle = wrapperRotaryArm.rotation.y;
	lastWrapperCarriageY = wrapperFilmCarriage.position.y;
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
assert(sawSpindleParallelRobotPickup, '机器人没有执行与丝锭轴线平行的水平取丝轨迹');
assert(sawRobotTcpTracking, '机器人六轴 TCP 轨迹没有进入验证窗口');
assert(sawRobotSafeTransfer, '机器人没有经过安全抬升后的水平转运段');
assert(sawRobotBaseClearanceSwing, '机器人没有在安全半径外绕 J1 基座完成高位换向');
assert(sawRobotAngularSwing, '机器人从丝车到辊道没有先发生明显 J1 角向旋转，仍可能直穿机器人本体');
assert(sawSideBOrderedPickup, '未验证到 B 面 1×6 抓取的世界坐标顺序');
assert(sawCartSideB, `丝车 A 面完成后没有旋转到 B 面：${JSON.stringify({ snapshot, returningDebug })}`);
assert(sawGantryBatch, '桁架没有在 A/B 各 3 托盘就绪后执行 2×3 抓取');
assert(sawSeparatorCycle && sawSeparatorPlaced, '桁架没有在每层丝锭后执行右侧夹具隔板工序');
assert(sawInspection, '托盘没有在外检机停止并执行外检');
assert(sawBagging, '外检 PASS 后没有执行套袋');
assert(sawEmptyBypass, '仿真没有产生空托盘，也没有验证外检前短回流');
assert(sawLayerEight, '木托盘没有完成 8 层码垛');
assert(sawCovered && sawLabeled && sawWrapped, '盖板、贴标、缠膜后处理没有全部执行');
assert(sawLabelArmMotion, '贴标周期中没有观察到三关节贴标臂实际伸出动作');
assert(sawWrapperArmMotion, '悬臂缠膜机运行时没有观察到旋臂绕 Y 轴转动');
assert(sawWrapperFilmLift, '悬臂缠膜机运行时没有观察到膜车沿 Y 轴升降');
assert(sawCoverReload, '天盖放置后没有立即去右侧存货台补抓下一块天盖');
assert(sawCoverReturnedReady, '天盖补抓后没有回到大辊道上方带盖等待');
assert(snapshot.postProcess.stored > 0, '完整木托盘没有进入立体库');

const storedWoodRoots: THREE.Object3D[] = [];
runtime.group.traverse((object) => {
	if (object.userData.twinEntityType === 'wooden-pallet') {
		const detail = runtime.getEntityDetail('wooden-pallet', String(object.userData.twinEntityId || object.name)) as any;
		if (detail?.state === 'stored') storedWoodRoots.push(object);
	}
});
assert(storedWoodRoots.length > 0, '没有找到已入库木托盘实体用于隔板验收');
const firstStoredWood = storedWoodRoots[0];
const firstStoredDetail = runtime.getEntityDetail('wooden-pallet', String(firstStoredWood.userData.twinEntityId || firstStoredWood.name)) as any;
assert(Number(firstStoredDetail?.silkCakeCount || 0) === 48, '首个已入库木托盘不是 48 个丝锭');
assert(Number(firstStoredDetail?.separatorCount || 0) === 8, '首个已入库木托盘不是 8 层 8 块隔板');
const storedBoards: THREE.Object3D[] = [];
firstStoredWood.traverse((object) => { if (object.userData.separatorBoard === true) storedBoards.push(object); });
assert(storedBoards.length === 8, `首个已入库木托盘隔板实体数量错误：${storedBoards.length}`);
for (let layer = 1; layer <= 8; layer += 1) assert(Boolean(firstStoredWood.getObjectByName(`SeparatorBoard-Layer-${layer}`)), `缺少第 ${layer} 层隔板实体`);
const sourceCounts = storedBoards.reduce((map, board) => {
	const key = String(board.userData.sourceFeeder || 'unknown');
	map.set(key, (map.get(key) || 0) + 1);
	return map;
}, new Map<string, number>());
assert(sourceCounts.get('SeparatorFeeder-A') === 4 && sourceCounts.get('SeparatorFeeder-B') === 4, `两台隔板机没有按层交替 4/4 供料：${JSON.stringify(Object.fromEntries(sourceCounts))}`);
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
