import { createBlankTwinSceneManifest, type TwinRouteDefinition, type TwinSceneManifest, type TwinVector3 } from '../contracts';
import type { TwinV7SceneManifest, TwinV7SceneObjectDefinition } from '../contracts/v7-components';
import { getBuiltInComponentTemplate } from '../components/BuiltInComponentCatalog';

/** 2026-09-11 用户确认图的像素标定；等比例，不冒充现场测量尺寸。 */
export const drawingCalibration = { imageWidth: 1423, imageHeight: 1105, metersPerPixel: 0.08, origin: [800, 570] as [number, number], rollerWidthPixels: 14 };
export type DrawingPixel = [number, number];
export const drawingWorld = ([x, y]: DrawingPixel, elevation = 0): TwinVector3 => [
	Number(((x - drawingCalibration.origin[0]) * drawingCalibration.metersPerPixel).toFixed(5)), elevation,
	Number(((y - drawingCalibration.origin[1]) * drawingCalibration.metersPerPixel).toFixed(5)),
];
export type DrawingSpan = { id: string; name: string; from: DrawingPixel; to: DrawingPixel; zone: string; machine?: string; large?: boolean };
const H = 0.9;
const WIDTH = drawingCalibration.rollerWidthPixels * drawingCalibration.metersPerPixel;
const pointId = ([x, y]: DrawingPixel) => `drawing-p-${x}-${y}`;
const smallRouteId = 'drawing-0911-small-loop';

/** 单一中心线清单同时生成可编辑路线和实体辊道；不继承 V19 迁移标记。 */
export function getDrawingSpans(): DrawingSpan[] {
	const result: DrawingSpan[] = [];
	const path = (id: string, name: string, zone: string, points: DrawingPixel[], large = false) => points.slice(1).forEach((to, i) => result.push({ id: `${id}-${i + 1}`, name, zone, from: points[i], to, large }));
	path('top', '顶部回送：向左', 'upper-return', [[978, 164], [914, 164], [543, 164], [521, 164]]);
	path('left-a', '桁架下双排 A：向抓丝机器人', 'left-double', [[521, 164], [521, 448], [521, 509], [521, 710]]);
	path('left-b', '桁架下双排 B：向抓丝机器人', 'left-double', [[543, 164], [543, 448], [543, 509], [543, 710]]);
	path('left-merge-a', '回流 A 接底部', 'left-return', [[521, 710], [532, 728]]);
	path('left-merge-b', '回流 B 接底部', 'left-return', [[543, 710], [532, 728]]);
	path('bottom-feed', '空托盘进入抓丝区', 'robot-double', [[532, 728], [532, 861], [532, 885]]);
	path('robot-a', '抓丝区双排 A：向外检', 'robot-double', [[532, 861], [1130, 861]]);
	path('robot-b', '抓丝区双排 B：向外检', 'robot-double', [[532, 885], [1130, 885]]);
	path('inspection-entry', '右侧合流后只进入外检', 'inspection', [[1130, 885], [1130, 861], [1130, 728], [1000, 728], [925, 728], [850, 728], [722, 728]]);
	path('inspection-exit', '外检后左转向上分双排', 'inspection', [[722, 728], [722, 624], [722, 605]]);
	path('loaded-a', '外检上方载料 A：向套袋', 'loaded-double', [[722, 605], [1320, 605]]);
	path('loaded-b', '外检上方载料 B：向套袋', 'loaded-double', [[722, 624], [1320, 624]]);
	path('right-trunk', '套袋区公共上行干线', 'bag-feed', [[1320, 624], [1320, 605], [1320, 554], [1320, 432], [1320, 248]]);
	path('empty', '最上方单排空回流：向左、再回抓丝机器人', 'empty-return', [[1320, 554], [623, 554], [623, 728], [532, 728]]);
	path('bag-a', '套袋 A：由右向左', 'bag-a', [[1320, 248], [1268, 248], [1250, 270], [1230, 270], [1170, 270], [1110, 270], [978, 270]]);
	path('bag-b', '套袋 B：由右向左', 'bag-b', [[1320, 432], [1216, 432], [1198, 448], [1164, 448], [1104, 448], [1044, 448], [978, 448]]);
	path('bag-return', '套袋后汇合向上回送', 'upper-return', [[978, 448], [978, 270], [978, 164]]);
	path('inner', '中央框右侧下行、底部左行', 'inner-return', [[914, 164], [914, 448], [775, 448], [596, 448], [543, 448]]);
	path('inner-buffer', '中央下方矩形缓存回流', 'inner-buffer', [[775, 448], [775, 509], [596, 509], [543, 509]]);
	path('inner-link', '缓存短接回左侧', 'inner-buffer', [[596, 448], [596, 509]]);
	path('wood', '左侧大辊道 L 形独立线', 'large-roller', [[445, 591], [445, 309], [445, 200], [277, 200], [277, 125]], true);
	for (const span of result) {
		if (span.zone === 'bag-a' && span.from[1] === 270 && span.to[0] >= 1110 && span.from[0] <= 1230) span.machine = 'drawing-bag-a';
		if (span.zone === 'bag-b' && span.from[1] === 448 && span.to[0] >= 1044 && span.from[0] <= 1164) span.machine = 'drawing-bag-b';
		if (span.zone === 'inspection' && span.from[1] === 728 && span.to[1] === 728 && span.from[0] <= 1000 && span.to[0] >= 850) span.machine = 'drawing-inspection';
	}
	return result;
}

/** 在指定图纸位置创建现有库组件，属性随清单保存，可在专业编辑器整体选中。 */
function component(key: string, id: string, name: string, pixel: DrawingPixel, yaw = 0, properties: Record<string, unknown> = {}): TwinV7SceneObjectDefinition {
	const template = getBuiltInComponentTemplate(key);
	if (!template) throw new Error(`组件库未登记 ${key}`);
	return { objectId: id, name, kind: 'component', transform: { position: drawingWorld(pixel), rotation: [0, yaw, 0], scale: [1, 1, 1] }, component: {
		resourceKey: key, componentType: template.componentType, generator: template.generator, generatorVersion: template.generatorVersion,
		properties: { ...template.defaultProperties, componentOwnedRoute: false, drawingCalibrationId: 'user-confirmed-0911', ...properties }, sectionId: String(properties.drawingZone || id),
	} };
}

/** 根据图纸创建独立新场景；没有复制旧流程、隐藏旁路或旧版本升级元数据。 */
export function createDrawingPackagingLineManifest(): TwinSceneManifest {
	const manifest = createBlankTwinSceneManifest() as TwinV7SceneManifest;
	manifest.sceneId = 'drawing-0911-new-scene';
	manifest.name = '参考图双套袋环形包装产线 · 图纸重建 V1';
	manifest.description = '按 2026-09-11 确认图等比例重建：外检上方双排载料向右，另有上方单排空回流向左；桁架下及抓丝区双排。图纸像素标定 0.08m/px，非现场测量尺寸。此版本仅确认实体和有向路线，未配置 PLC 或设备工艺动作。';
	manifest.world.background = '#e8eef3';
	manifest.runtime = { dataMode: 'simulation', initialView: 'top', maxPixelRatio: 1.5, showGrid: false, primarySmallPalletRouteId: smallRouteId,
		routePalletInitializers: [{ routeId: smallRouteId, telemetryKey: 'drawing0911SmallPallets', simulationDefaultCount: 0, emptyValue: 0 }] };
	const spans = getDrawingSpans();
	const objects: TwinV7SceneObjectDefinition[] = [];
	const allNodes = new Map<string, { pixel: DrawingPixel; spans: DrawingSpan[] }>();
	for (const span of spans) for (const pixel of [span.from, span.to]) {
		const key = pointId(pixel); const node = allNodes.get(key) || { pixel, spans: [] }; node.spans.push(span); allNodes.set(key, node);
	}
	const isMachineNode = (key: string) => allNodes.get(key)!.spans.some((s) => s.machine);
	const needsTransferNode = (key: string) => {
		const node = allNodes.get(key)!;
		if (isMachineNode(key) || node.spans.length <= 1) return false;
		if (node.spans.length > 2) return true;
		const vectors = node.spans.map((span) => {
			const other = pointId(span.from) === key ? span.to : span.from;
			const dx = other[0] - node.pixel[0], dy = other[1] - node.pixel[1];
			const length = Math.hypot(dx, dy) || 1;
			return [dx / length, dy / length] as const;
		});
		const dot = vectors[0][0] * vectors[1][0] + vectors[0][1] * vectors[1][1];
		return dot > -0.995;
	};
	const half = (span: DrawingSpan) => span.large ? 1.4 : WIDTH / 2;
	const trim = (span: DrawingSpan, pixel: DrawingPixel) => needsTransferNode(pointId(pixel)) ? half(span) : 0;
	const used = new Set<string>();
	for (const span of spans) {
		if (used.has(span.id) || span.machine) continue;
		const a = drawingWorld(span.from), b = drawingWorld(span.to);
		const dx = b[0] - a[0], dz = b[2] - a[2]; const fullLength = Math.hypot(dx, dz);
		const t0 = trim(span, span.from), t1 = trim(span, span.to);
		const midpoint: DrawingPixel = [(span.from[0] + span.to[0]) / 2 + (t0 - t1) * dx / fullLength / 0.16, (span.from[1] + span.to[1]) / 2 + (t0 - t1) * dz / fullLength / 0.16];
		const pair = spans.find((other) => !used.has(other.id) && other.id !== span.id && other.zone === span.zone && !other.machine && (
			(span.zone === 'left-double' && other.from[1] === span.from[1] && other.to[1] === span.to[1] && Math.abs(other.from[0] - span.from[0]) === 22) ||
			(['loaded-double', 'robot-double'].includes(span.zone) && dx !== 0 && other.from[0] === span.from[0] && other.to[0] === span.to[0] && other.from[1] === other.to[1])
		));
		const properties = { length: Number((fullLength - t0 - t1).toFixed(5)), width: span.large ? 2.8 : WIDTH, height: span.large ? 0.82 : H, rollerPitch: 0.48, drawingZone: span.zone, drawingSpanIds: [span.id], capacity: Math.max(1, Math.floor(fullLength / 1.8)) };
		if (pair) {
			used.add(pair.id); const gap = Math.hypot(pair.from[0] - span.from[0], pair.from[1] - span.from[1]) * 0.08;
			midpoint[0] += (pair.from[0] - span.from[0]) / 2; midpoint[1] += (pair.from[1] - span.from[1]) / 2;
			objects.push(component('builtin-double-small-roller-conveyor', `drawing-bed-${span.id}`, `${span.name} / 双排组件`, midpoint, -Math.atan2(dz, dx), { ...properties, laneWidth: WIDTH, laneSpacing: gap, laneAReverse: false, laneBReverse: false, drawingSpanIds: [span.id, pair.id] }));
		} else objects.push(component(span.large ? 'builtin-large-roller-conveyor' : 'builtin-small-roller-conveyor', `drawing-bed-${span.id}`, span.name, midpoint, -Math.atan2(dz, dx), properties));
		used.add(span.id);
	}
	// 一处交叉点只有一张移载辊床，不用多条实体穿插。设备自身内置辊床占用区间不再重复铺设。
	for (const [key, node] of allNodes) {
		if (!needsTransferNode(key)) continue;
		const large = node.spans.some((s) => s.large); const width = large ? 2.8 : WIDTH;
		objects.push(component(large ? 'builtin-large-roller-conveyor' : 'builtin-small-roller-conveyor', `drawing-transfer-${key}`, `接驳位 ${node.pixel.join(',')}`, node.pixel, 0, { length: width, width, height: large ? 0.82 : H, openTransferSides: true, drawingZone: 'transfer', drawingPixel: node.pixel, capacity: 1 }));
	}
	objects.push(
		component('builtin-bagging-machine', 'drawing-bag-a', '套袋机 A（上）', [1170, 270], Math.PI, { length: 9.6, width: 5.4, conveyorWidth: WIDTH, conveyorHeight: H, machineHeight: 3.8 }),
		component('builtin-bagging-machine', 'drawing-bag-b', '套袋机 B（下）', [1104, 448], Math.PI, { length: 9.6, width: 5.4, conveyorWidth: WIDTH, conveyorHeight: H, machineHeight: 3.8 }),
		component('builtin-external-inspection', 'drawing-inspection', '外检机（出口在左侧）', [925, 728], Math.PI, { length: 12, chamberLength: 11.4, width: 6.6, conveyorWidth: WIDTH, conveyorHeight: H, machineHeight: 3.8 }),
		component('builtin-industrial-robot', 'drawing-center-robot', '中央缓存机器人', [727, 351], 0, { upperArmLength: 3.7, forearmLength: 3.7 }),
		component('builtin-industrial-robot', 'drawing-loading-robot', '抓丝机器人', [827, 989], 0, { toolType: 'silk-grid-2x6', gripperSpan: 6.6, gripperRowSpacing: 1.15, upperArmLength: 3.8, forearmLength: 3.8, axis1HomeYaw: 0, axis2HomePitch: -0.48, axis3HomePitch: Math.PI / 2 + 0.48 }),
		component('builtin-turntable', 'drawing-turntable-left', '抓丝机器人左旋转台', [694, 989], Math.PI / 2, { deckLength: 11.2, width: 2.8, height: H, baseRadius: 5.7, withSilkCart: true, silkCartLoaded: true }),
		component('builtin-turntable', 'drawing-turntable-right', '抓丝机器人右旋转台', [965, 989], Math.PI / 2, { deckLength: 11.2, width: 2.8, height: H, baseRadius: 5.7, withSilkCart: true, silkCartLoaded: true }),
		component('builtin-silk-gantry', 'drawing-stacking-gantry', '左侧码垛桁架与双暂存台', [398, 309], Math.PI / 2, { length: 9.2, width: 25.6, height: 7.2, firstStockZ: -3.04, stockSpacingZ: 4.72, stockDeckWidthX: 8.5, stockDeckDepth: 3.2 }),
		component('builtin-wooden-pallet', 'drawing-stacking-pallet', '大辊道码垛木托', [445, 309], Math.PI / 2, { length: 5.6, width: 2.4 }),
	);
	objects.at(-1)!.transform.position[1] = 0.82;
	for (const [i, degrees] of [120, 40, -40].entries()) objects.push(component('builtin-turn-conveyor-90', `drawing-horseshoe-${i}`, `马蹄形缓存 ${i + 1}/3`, [727, 350], degrees * Math.PI / 180, { radius: 8.96, width: WIDTH, height: H, rollerPitch: 0.48, sweepDegrees: 80, turnDirection: 'left' }));
	manifest.objects = objects;
	manifest.connections = [];
	manifest.routes = [false, true].map((large): TwinRouteDefinition => {
		const selected = spans.filter((s) => Boolean(s.large) === large), ids = new Set(selected.flatMap((s) => [pointId(s.from), pointId(s.to)]));
		return { routeId: large ? 'drawing-0911-wood-line' : smallRouteId, name: large ? '左侧大辊道独立路线' : '0911 图纸小辊道有向路网', type: 'conveyor', curveKind: 'line', defaultSpeed: 0.9, loop: !large, orientToPath: true,
			startPointId: large ? pointId([445, 591]) : pointId([532, 861]), routingMode: 'automatic', junctionDecisions: {}, decisionRules: [],
			sections: [...new Set(selected.map((s) => s.zone))].map((id) => ({ sectionId: id, name: selected.find((s) => s.zone === id)!.name, enabled: true })),
			points: [...ids].map((id) => ({ pointId: id, name: id.replace('drawing-p-', '图纸 '), position: drawingWorld(allNodes.get(id)!.pixel, large ? 0.82 : H), kind: selected.filter((s) => pointId(s.from) === id).length > 1 ? 'diverter' : 'waypoint', authoring: { mode: 'manual', locked: false } })),
			edges: selected.map((s) => ({ edgeId: `drawing-edge-${s.id}`, name: s.name, fromPointId: pointId(s.from), toPointId: pointId(s.to), bidirectional: false, enabled: true, sectionId: s.zone,
				capacity: Math.max(1, Math.floor(Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) * 0.08 / 1.8)), occupancyMode: 'simulation', conveyorSizeClass: large ? 'large' : 'small', transportUnitType: large ? 'wooden-pallet' : 'plastic-pallet', transportUnitResourceKey: large ? 'builtin-wooden-pallet' : 'builtin-small-pallet',
				conveyorObjectId: s.machine || objects.find((o) => (o.component?.properties.drawingSpanIds as string[] | undefined)?.includes(s.id))?.objectId,
				authoring: { mode: 'manual', locked: false }, reservationTimeoutSeconds: 30 })),
		};
	});
	return manifest as TwinSceneManifest;
}
