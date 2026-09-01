import type { Twin2DObjectView } from './types';
import { cloneTwin2DState } from './clone';

export interface Twin2DPoint { x: number; y: number }
export interface Twin2DRect { x: number; y: number; width: number; height: number }
export type Twin2DAlignMode = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';
export type Twin2DDistributeMode = 'horizontal' | 'vertical';
export interface Twin2DAlignmentGuides { vertical: number[]; horizontal: number[] }

const clone = cloneTwin2DState;
const right = (item: Twin2DObjectView) => item.x + item.width;
const bottom = (item: Twin2DObjectView) => item.y + item.height;

export const normalizeRect = (start: Twin2DPoint, end: Twin2DPoint): Twin2DRect => ({
	x: Math.min(start.x, end.x),
	y: Math.min(start.y, end.y),
	width: Math.abs(end.x - start.x),
	height: Math.abs(end.y - start.y),
});

export const objectIntersectsRect = (item: Twin2DObjectView, rect: Twin2DRect) =>
	!item.hidden
	&& right(item) >= rect.x
	&& item.x <= rect.x + rect.width
	&& bottom(item) >= rect.y
	&& item.y <= rect.y + rect.height;

export const objectsInMarquee = (objects: Twin2DObjectView[], rect: Twin2DRect) =>
	objects.filter((item) => objectIntersectsRect(item, rect)).map((item) => item.id);

export const selectionBounds = (objects: Twin2DObjectView[]): Twin2DRect | undefined => {
	if (!objects.length) return undefined;
	const x = Math.min(...objects.map((item) => item.x));
	const y = Math.min(...objects.map((item) => item.y));
	const x2 = Math.max(...objects.map(right));
	const y2 = Math.max(...objects.map(bottom));
	return { x, y, width: x2 - x, height: y2 - y };
};

/** 将移动中的选择框吸附到其他对象的边缘或中心线，并返回画布辅助线。 */
export const snapObjectsToAlignmentGuides = (
	moving: Twin2DObjectView[],
	stationary: Twin2DObjectView[],
	threshold = 6,
): { objects: Twin2DObjectView[]; guides: Twin2DAlignmentGuides } => {
	const bounds = selectionBounds(moving);
	if (!bounds || !stationary.length) return { objects: moving.map(clone), guides: { vertical: [], horizontal: [] } };
	const movingX = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
	const movingY = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
	let bestX: { delta: number; guide: number } | undefined;
	let bestY: { delta: number; guide: number } | undefined;
	for (const item of stationary) {
		const targetsX = [item.x, item.x + item.width / 2, item.x + item.width];
		const targetsY = [item.y, item.y + item.height / 2, item.y + item.height];
		for (const source of movingX) for (const target of targetsX) {
			const delta = target - source;
			if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, guide: target };
		}
		for (const source of movingY) for (const target of targetsY) {
			const delta = target - source;
			if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, guide: target };
		}
	}
	return {
		objects: moveObjects(moving, bestX?.delta || 0, bestY?.delta || 0),
		guides: { vertical: bestX ? [bestX.guide] : [], horizontal: bestY ? [bestY.guide] : [] },
	};
};

export const alignObjects = (objects: Twin2DObjectView[], mode: Twin2DAlignMode): Twin2DObjectView[] => {
	if (objects.length < 2) return objects.map(clone);
	const result = objects.map(clone);
	const bounds = selectionBounds(result)!;
	for (const item of result) {
		if (item.locked) continue;
		switch (mode) {
			case 'left': item.x = bounds.x; break;
			case 'center-x': item.x = bounds.x + bounds.width / 2 - item.width / 2; break;
			case 'right': item.x = bounds.x + bounds.width - item.width; break;
			case 'top': item.y = bounds.y; break;
			case 'center-y': item.y = bounds.y + bounds.height / 2 - item.height / 2; break;
			case 'bottom': item.y = bounds.y + bounds.height - item.height; break;
		}
	}
	return result;
};

export const distributeObjects = (objects: Twin2DObjectView[], mode: Twin2DDistributeMode): Twin2DObjectView[] => {
	if (objects.length < 3) return objects.map(clone);
	const result = objects.map(clone);
	if (mode === 'horizontal') {
		const ordered = [...result].sort((a, b) => a.x - b.x);
		const start = ordered[0].x;
		const end = right(ordered[ordered.length - 1]);
		const total = ordered.reduce((sum, item) => sum + item.width, 0);
		const gap = Math.max(0, (end - start - total) / (ordered.length - 1));
		let cursor = start;
		for (const item of ordered) { if (!item.locked) item.x = cursor; cursor += item.width + gap; }
	} else {
		const ordered = [...result].sort((a, b) => a.y - b.y);
		const start = ordered[0].y;
		const end = bottom(ordered[ordered.length - 1]);
		const total = ordered.reduce((sum, item) => sum + item.height, 0);
		const gap = Math.max(0, (end - start - total) / (ordered.length - 1));
		let cursor = start;
		for (const item of ordered) { if (!item.locked) item.y = cursor; cursor += item.height + gap; }
	}
	return result;
};

export const moveObjects = (objects: Twin2DObjectView[], dx: number, dy: number) => objects.map((item) => ({
	...clone(item),
	x: item.locked ? item.x : item.x + dx,
	y: item.locked ? item.y : item.y + dy,
}));

export const resizeObjectFromCorner = (item: Twin2DObjectView, pointer: Twin2DPoint, minSize = 20): Twin2DObjectView => ({
	...clone(item),
	width: item.locked ? item.width : Math.max(minSize, pointer.x - item.x),
	height: item.locked ? item.height : Math.max(minSize, pointer.y - item.y),
});

export const rotationFromPointer = (item: Twin2DObjectView, pointer: Twin2DPoint) => {
	const centerX = item.x + item.width / 2;
	const centerY = item.y + item.height / 2;
	return Math.round((Math.atan2(pointer.y - centerY, pointer.x - centerX) * 180) / Math.PI + 90);
};

export const duplicateObjects = (objects: Twin2DObjectView[], offset = 30): Twin2DObjectView[] => objects.map((item, index) => ({
	...clone(item),
	id: `2d-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`}`,
	name: `${item.name} 副本`,
	x: item.x + offset,
	y: item.y + offset,
	zIndex: item.zIndex + 1,
	businessObjectId: undefined,
}));

export const replaceObjectsById = (all: Twin2DObjectView[], changed: Twin2DObjectView[]) => {
	const map = new Map(changed.map((item) => [item.id, item]));
	return all.map((item) => map.get(item.id) ?? item);
};

export const bringSelectionToFront = (all: Twin2DObjectView[], selectedIds: string[]) => {
	let z = Math.max(0, ...all.map((item) => item.zIndex));
	return all.map((item) => selectedIds.includes(item.id) ? { ...item, zIndex: ++z } : item);
};

export const sendSelectionToBack = (all: Twin2DObjectView[], selectedIds: string[]) => {
	let z = Math.min(0, ...all.map((item) => item.zIndex));
	return all.map((item) => selectedIds.includes(item.id) ? { ...item, zIndex: --z } : item);
};
