import type { Twin2DObjectView, Twin2DSymbolKey } from './types';

export interface Twin2DLibraryItem {
	resourceKey: string;
	modelResourceId?: string;
	name: string;
	category: string;
	symbolKey: Twin2DSymbolKey;
	width: number;
	height: number;
	description: string;
	origin?: 'builtin' | 'database' | 'custom';
	componentType?: string;
	generator?: string;
	generatorVersion?: number;
	componentSchema?: { properties?: Array<Record<string, unknown>> };
	ports?: Array<Record<string, unknown>>;
	bindingSlots?: Array<Record<string, unknown>>;
	customSvg?: string;
	defaultProperties?: Record<string, unknown>;
}

export const twin2DBuiltInLibrary: Twin2DLibraryItem[] = [
	{ resourceKey: '2d-small-conveyor', name: '小型辊道', category: '输送设备', symbolKey: 'conveyor-small', width: 240, height: 80, description: '塑料托盘 / 小件输送' },
	{ resourceKey: '2d-large-conveyor', name: '大型辊道', category: '输送设备', symbolKey: 'conveyor-large', width: 280, height: 110, description: '木托盘 / 大件输送' },
	{ resourceKey: '2d-turntable', name: '旋转台', category: '输送设备', symbolKey: 'turntable', width: 130, height: 130, description: '转向、丝车旋转单元' },
	{ resourceKey: '2d-robot', name: '工业机器人', category: '机器人', symbolKey: 'robot', width: 150, height: 150, description: '抓取、上下料、搬运' },
	{ resourceKey: '2d-gantry', name: '桁架机械手', category: '机器人', symbolKey: 'gantry', width: 300, height: 150, description: '码垛、移载桁架' },
	{ resourceKey: '2d-buffer', name: '缓存区', category: '物流设备', symbolKey: 'buffer', width: 220, height: 150, description: '缓存、暂存、占用显示' },
	{ resourceKey: '2d-inspection', name: '外检机', category: '工艺设备', symbolKey: 'inspection', width: 180, height: 130, description: '外观检测工位' },
	{ resourceKey: '2d-bagging', name: '套袋机', category: '工艺设备', symbolKey: 'bagging', width: 180, height: 130, description: '套袋包装工位' },
	{ resourceKey: '2d-pallet', name: '托盘', category: '物流对象', symbolKey: 'pallet', width: 90, height: 65, description: '塑料托盘 / 木托盘' },
	{ resourceKey: '2d-carton', name: '纸箱', category: '物流对象', symbolKey: 'carton', width: 70, height: 55, description: '包装纸箱 / 周转箱' },
	{ resourceKey: '2d-agv', name: 'AGV / AMR', category: '物流设备', symbolKey: 'agv', width: 130, height: 90, description: '移动机器人 / 无人搬运车' },
	{ resourceKey: '2d-station', name: '通用工位', category: '通用图形', symbolKey: 'station', width: 190, height: 120, description: '可绑定任意设备或工位' },
	{ resourceKey: '2d-label', name: '文本标签', category: '通用图形', symbolKey: 'label', width: 220, height: 70, description: '场景说明、区域标注' },
];

export const createTwin2DLibraryObject = (item: Twin2DLibraryItem, x: number, y: number, zIndex: number): Twin2DObjectView => ({
	id: `2d-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
	name: item.name,
	symbolKey: item.symbolKey,
	resourceKey: item.resourceKey,
	componentType: item.componentType,
	customSvg: item.customSvg,
	componentSchema: item.componentSchema,
	ports: item.ports,
	bindingSlots: item.bindingSlots,
	properties: structuredClone(item.defaultProperties || {}),
	layerId: ['pallet', 'carton', 'agv'].includes(item.symbolKey) ? 'material-flow' : item.symbolKey === 'label' ? 'labels' : 'production',
	x,
	y,
	width: item.width,
	height: item.height,
	rotation: 0,
	zIndex,
	fill: '#1d4ed8',
	stroke: '#7dd3fc',
	opacity: 1,
});
