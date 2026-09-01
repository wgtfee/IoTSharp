import type { TwinModelResource } from '/@/api/digital-twin';
import type { Twin2DLibraryItem } from './library';

export interface Twin2DLibraryState {
	favorites: string[];
	recent: string[];
	custom: Twin2DLibraryItem[];
}

const KEY = 'iotsharp.twin2d.library.v1';
const memory: Twin2DLibraryState = { favorites: [], recent: [], custom: [] };
const storage = () => typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? globalThis.localStorage : undefined;

export const loadTwin2DLibraryState = (): Twin2DLibraryState => {
	try {
		const raw = storage()?.getItem(KEY);
		if (!raw) return structuredClone(memory);
		const value = JSON.parse(raw) as Partial<Twin2DLibraryState>;
		return { favorites: value.favorites || [], recent: value.recent || [], custom: value.custom || [] };
	} catch { return structuredClone(memory); }
};

export const saveTwin2DLibraryState = (state: Twin2DLibraryState) => {
	memory.favorites = [...state.favorites]; memory.recent = [...state.recent]; memory.custom = structuredClone(state.custom);
	try { storage()?.setItem(KEY, JSON.stringify(state)); } catch { /* localStorage may be disabled */ }
};

export const toggleTwin2DFavorite = (state: Twin2DLibraryState, resourceKey: string) => {
	const set = new Set(state.favorites);
	set.has(resourceKey) ? set.delete(resourceKey) : set.add(resourceKey);
	state.favorites = [...set]; saveTwin2DLibraryState(state); return state.favorites.includes(resourceKey);
};

export const rememberTwin2DRecent = (state: Twin2DLibraryState, resourceKey: string, limit = 12) => {
	state.recent = [resourceKey, ...state.recent.filter((item) => item !== resourceKey)].slice(0, limit);
	saveTwin2DLibraryState(state);
};

export const upsertTwin2DCustomResource = (state: Twin2DLibraryState, item: Twin2DLibraryItem) => {
	state.custom = [...state.custom.filter((entry) => entry.resourceKey !== item.resourceKey), item];
	saveTwin2DLibraryState(state);
};

const dimension = (value: unknown, fallback: number) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	const pixels = parsed <= 12 ? parsed * 100 : parsed;
	return Math.round(Math.max(40, Math.min(1200, pixels)));
};

const symbolFromMetadata = (metadata: any, name: string): Twin2DLibraryItem['symbolKey'] => {
	const source = `${metadata?.componentType || ''} ${metadata?.category || ''} ${name}`.toLowerCase();
	if (source.includes('twin2d-custom-svg')) return 'custom-svg';
	if (source.includes('turntable') || source.includes('旋转')) return 'turntable';
	if (source.includes('robot') || source.includes('机器人')) return 'robot';
	if (source.includes('gantry') || source.includes('桁架')) return 'gantry';
	if (source.includes('conveyor') || source.includes('辊道') || source.includes('输送')) return source.includes('large') || source.includes('大') ? 'conveyor-large' : 'conveyor-small';
	if (source.includes('buffer') || source.includes('缓存')) return 'buffer';
	if (source.includes('inspection') || source.includes('外检')) return 'inspection';
	if (source.includes('bagging') || source.includes('套袋')) return 'bagging';
	if (source.includes('agv') || source.includes('amr')) return 'agv';
	if (source.includes('pallet') || source.includes('托盘')) return 'pallet';
	return 'station';
};

export const mapModelResourceTo2DLibraryItem = (resource: TwinModelResource): Twin2DLibraryItem | undefined => {
	const metadata: any = resource.modelMetadata || {};
	if (!metadata.componentType && !metadata.componentSchema && !metadata.ports) return undefined;
	const name = resource.name || metadata.resourceKey || resource.originalFileName || '组件资源';
	return {
		resourceKey: metadata.resourceKey || `component-resource:${resource.id}`,
		modelResourceId: resource.id,
		name,
		category: metadata.category || '数据库组件',
		symbolKey: symbolFromMetadata(metadata, name),
		width: dimension(metadata.defaultProperties?.length ?? metadata.defaultProperties?.width, 220),
		height: dimension(metadata.defaultProperties?.width ?? metadata.defaultProperties?.height, 100),
		description: `${metadata.componentType || 'component'} · 数据库资源`,
		origin: 'database',
		componentType: metadata.componentType,
		generator: metadata.generator,
		generatorVersion: metadata.generatorVersion,
		componentSchema: metadata.componentSchema,
		ports: metadata.ports,
		bindingSlots: metadata.bindingSlots,
		customSvg: typeof metadata.defaultProperties?.customSvg === 'string' ? metadata.defaultProperties.customSvg : undefined,
		defaultProperties: metadata.defaultProperties,
	};
};
