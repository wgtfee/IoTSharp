import type { TwinSceneManifest } from '/@/digital-twin/contracts';
import { isSafeTwin2DSvg } from './svg';

export type Twin2DSymbolKey =
	| 'conveyor-small'
	| 'conveyor-large'
	| 'turntable'
	| 'robot'
	| 'gantry'
	| 'buffer'
	| 'inspection'
	| 'bagging'
	| 'pallet'
	| 'carton'
	| 'agv'
	| 'station'
	| 'label'
	| 'custom-svg';

export const twin2DSymbolKeys: ReadonlySet<Twin2DSymbolKey> = new Set([
	'conveyor-small', 'conveyor-large', 'turntable', 'robot', 'gantry', 'buffer',
	'inspection', 'bagging', 'pallet', 'carton', 'agv', 'station', 'label', 'custom-svg',
]);

export interface Twin2DCanvasDefinition {
	width: number;
	height: number;
	background: string;
	gridSize: number;
	showGrid: boolean;
	snapToGrid: boolean;
}

export interface Twin2DObjectView {
	id: string;
	name: string;
	symbolKey: Twin2DSymbolKey;
	businessObjectId?: string;
	resourceKey?: string;
	componentType?: string;
	layerId?: string;
	customSvg?: string;
	properties?: Record<string, unknown>;
	componentSchema?: { properties?: Array<Record<string, unknown>> };
	ports?: Array<Record<string, unknown>>;
	bindingSlots?: Array<Record<string, unknown>>;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	zIndex: number;
	fill?: string;
	stroke?: string;
	opacity?: number;
	locked?: boolean;
	hidden?: boolean;
}

export interface Twin2DLayerDefinition {
	id: string;
	name: string;
	visible: boolean;
	locked: boolean;
	zIndex: number;
}

export interface Twin2DRoutePointView {
	x: number;
	y: number;
}

export interface Twin2DViewDefinition {
	version: 1;
	canvas: Twin2DCanvasDefinition;
	objects: Twin2DObjectView[];
	routePoints: Record<string, Twin2DRoutePointView>;
	layers?: Twin2DLayerDefinition[];
	showMinimap?: boolean;
}

export type TwinSceneManifestWith2D = TwinSceneManifest & { view2d?: Twin2DViewDefinition };

export interface Twin2DValidationDiagnostic {
	severity: 'error' | 'warning' | 'info';
	code: string;
	message: string;
	path?: string;
}

export const createDefaultTwin2DView = (): Twin2DViewDefinition => ({
	version: 1,
	canvas: { width: 4800, height: 3000, background: '#07111f', gridSize: 20, showGrid: true, snapToGrid: true },
	objects: [],
	routePoints: {},
	layers: [
		{ id: 'background', name: '背景', visible: true, locked: false, zIndex: 0 },
		{ id: 'production', name: '生产设备', visible: true, locked: false, zIndex: 100 },
		{ id: 'material-flow', name: '物流对象', visible: true, locked: false, zIndex: 200 },
		{ id: 'labels', name: '标签', visible: true, locked: false, zIndex: 300 },
		{ id: 'alarms', name: '告警覆盖层', visible: true, locked: false, zIndex: 400 },
	],
	showMinimap: true,
});

const symbolForObject = (item: any): Twin2DSymbolKey => {
	const source = `${item?.name || ''} ${item?.equipment?.equipmentType || ''} ${item?.component?.componentType || ''} ${item?.procedural?.preset || ''}`.toLowerCase();
	if (source.includes('turntable') || source.includes('旋转')) return 'turntable';
	if (source.includes('robot') || source.includes('机器人')) return 'robot';
	if (source.includes('gantry') || source.includes('桁架')) return 'gantry';
	if (source.includes('inspection') || source.includes('外检')) return 'inspection';
	if (source.includes('bagging') || source.includes('套袋')) return 'bagging';
	if (source.includes('buffer') || source.includes('缓存') || source.includes('暂存')) return 'buffer';
	if (source.includes('carton') || source.includes('纸箱')) return 'carton';
	if (source.includes('agv') || source.includes('amr')) return 'agv';
	if (source.includes('pallet') || source.includes('托盘')) return 'pallet';
	if (source.includes('large')) return 'conveyor-large';
	if (source.includes('conveyor') || source.includes('辊道') || source.includes('输送')) return 'conveyor-small';
	return 'station';
};

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const ensureTwin2DView = (manifest: TwinSceneManifestWith2D): Twin2DViewDefinition => {
	if (manifest.view2d?.version === 1 && manifest.view2d.canvas && Array.isArray(manifest.view2d.objects)) {
		manifest.view2d.routePoints ||= {};
		manifest.view2d.layers ||= createDefaultTwin2DView().layers;
		manifest.view2d.showMinimap ??= true;
		for (const item of manifest.view2d.objects) item.layerId ||= item.symbolKey === 'label' ? 'labels' : ['pallet', 'carton', 'agv'].includes(item.symbolKey) ? 'material-flow' : 'production';
		return structuredClone(manifest.view2d);
	}
	const view = createDefaultTwin2DView();
	const objects = (manifest.objects || []) as any[];
	objects.forEach((item, index) => {
		const position = item?.transform?.position || [0, 0, 0];
		view.objects.push({
			id: `view-${item.objectId}`,
			name: item.name || item.objectId,
			symbolKey: symbolForObject(item),
			businessObjectId: item.objectId,
			resourceKey: item?.component?.resourceKey,
			componentType: item?.component?.componentType,
			layerId: ['pallet', 'carton', 'agv'].includes(symbolForObject(item)) ? 'material-flow' : 'production',
			x: 700 + finite(position[0], index * 3) * 55,
			y: 600 + finite(position[2], 0) * 55,
			width: 220,
			height: 90,
			rotation: 0,
			zIndex: index + 1,
		});
	});
	for (const route of manifest.routes || []) {
		for (const point of route.points || []) {
			view.routePoints[point.pointId] ||= {
				x: 700 + finite(point.position?.[0], 0) * 55,
				y: 600 + finite(point.position?.[2], 0) * 55,
			};
		}
	}
	return view;
};

export const snap2DValue = (value: number, view: Twin2DViewDefinition) => {
	if (!view.canvas.snapToGrid) return value;
	const size = Math.max(1, view.canvas.gridSize || 20);
	return Math.round(value / size) * size;
};

export const validateTwin2DView = (view: Twin2DViewDefinition, manifest: TwinSceneManifest): Twin2DValidationDiagnostic[] => {
	const diagnostics: Twin2DValidationDiagnostic[] = [];
	if (![view.canvas.width, view.canvas.height, view.canvas.gridSize].every((value) => Number.isFinite(value) && value > 0)) {
		diagnostics.push({ severity: 'error', code: 'twin2d.canvas.invalid', message: '2D 画布宽、高和网格尺寸必须是大于 0 的有限数值。', path: 'view2d.canvas' });
	}
	const layerIds = new Set<string>();
	for (const [index, layer] of (view.layers || []).entries()) {
		if (!layer.id || layerIds.has(layer.id)) diagnostics.push({ severity: 'error', code: 'twin2d.layer.id', message: '2D 图层 ID 为空或重复。', path: `view2d.layers[${index}].id` });
		layerIds.add(layer.id);
	}
	const ids = new Set<string>();
	const businessIds = new Set((manifest.objects || []).map((item) => item.objectId));
	const mappedBusinessIds = new Set<string>();
	for (const [index, item] of view.objects.entries()) {
		if (!item.id || ids.has(item.id)) diagnostics.push({ severity: 'error', code: 'twin2d.object.id', message: '2D 对象 ID 为空或重复。', path: `view2d.objects[${index}].id` });
		ids.add(item.id);
		if (!(item.width > 0) || !(item.height > 0)) diagnostics.push({ severity: 'error', code: 'twin2d.object.size', message: `${item.name} 的宽高必须大于 0。`, path: `view2d.objects[${index}]` });
		if (![item.x, item.y, item.width, item.height, item.rotation].every(Number.isFinite)) diagnostics.push({ severity: 'error', code: 'twin2d.object.transform', message: `${item.name} 存在无效二维坐标。`, path: `view2d.objects[${index}]` });
		if (!twin2DSymbolKeys.has(item.symbolKey)) diagnostics.push({ severity: 'error', code: 'twin2d.object.symbol', message: `${item.name} 使用了未注册的 2D 图元 ${item.symbolKey}。`, path: `view2d.objects[${index}].symbolKey` });
		if (item.symbolKey === 'custom-svg' && !isSafeTwin2DSvg(item.customSvg || '')) diagnostics.push({ severity: 'error', code: 'twin2d.object.svg.invalid', message: `${item.name} 的自定义 SVG 为空或包含不安全内容。`, path: `view2d.objects[${index}].customSvg` });
		if (item.layerId && layerIds.size && !layerIds.has(item.layerId)) diagnostics.push({ severity: 'warning', code: 'twin2d.object.layer.missing', message: `${item.name} 所属图层不存在。`, path: `view2d.objects[${index}].layerId` });
		if (item.x + item.width < 0 || item.y + item.height < 0 || item.x > view.canvas.width || item.y > view.canvas.height) diagnostics.push({ severity: 'warning', code: 'twin2d.object.outside', message: `${item.name} 完全位于画布范围之外。`, path: `view2d.objects[${index}]` });
		if (item.businessObjectId) {
			mappedBusinessIds.add(item.businessObjectId);
			if (!businessIds.has(item.businessObjectId)) diagnostics.push({ severity: 'warning', code: 'twin2d.object.business.missing', message: `${item.name} 关联的业务对象不存在。`, path: `view2d.objects[${index}].businessObjectId` });
		}
	}
	for (const item of manifest.objects || []) {
		if (!mappedBusinessIds.has(item.objectId)) diagnostics.push({ severity: 'warning', code: 'twin2d.business.view.missing', message: `${item.name} 尚未配置 2D 视图对象。`, path: `objects.${item.objectId}` });
	}
	for (const [routeIndex, route] of (manifest.routes || []).entries()) {
		const routePointIds = new Set((route.points || []).map((point) => point.pointId));
		for (const [pointIndex, point] of (route.points || []).entries()) {
			const position = view.routePoints[point.pointId];
			if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) diagnostics.push({ severity: 'error', code: 'twin2d.route.point.view', message: `${route.name} 的节点 ${point.name} 缺少有效 2D 坐标。`, path: `view2d.routePoints.${point.pointId}` });
			if (!point.pointId) diagnostics.push({ severity: 'error', code: 'twin2d.route.point.id', message: `${route.name} 存在空节点 ID。`, path: `routes[${routeIndex}].points[${pointIndex}]` });
		}
		for (const [edgeIndex, edge] of (route.edges || []).entries()) {
			if (!routePointIds.has(edge.fromPointId) || !routePointIds.has(edge.toPointId)) diagnostics.push({ severity: 'error', code: 'twin2d.route.edge.reference', message: `${route.name} 的路线边引用了不存在的节点。`, path: `routes[${routeIndex}].edges[${edgeIndex}]` });
		}
	}
	if (view.objects.length === 0) diagnostics.push({ severity: 'warning', code: 'twin2d.scene.empty', message: '当前 2D 场景没有任何图元。', path: 'view2d.objects' });
	return diagnostics;
};
