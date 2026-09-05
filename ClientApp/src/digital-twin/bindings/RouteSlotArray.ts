export interface RouteSlotValue {
	palletId: string;
	slotIndex: number;
	slotCount: number;
	progress: number;
	rawValue: unknown;
}

/**
 * 将 PLC/IoT 离散槽位数组解析成托盘位置事实。
 * 例如 [12,23,0,0] => 托盘 12 在槽位 0，托盘 23 在槽位 1，0 为空位。
 */
export const parseRouteSlotArray = (value: unknown, emptyValue: unknown = 0): RouteSlotValue[] => {
	let arrayValue = value;
	if (typeof arrayValue === 'string') {
		const text = arrayValue.trim();
		if (!text) return [];
		try { arrayValue = JSON.parse(text); } catch { return []; }
	}
	if (!Array.isArray(arrayValue)) return [];
	const slotCount = arrayValue.length;
	const emptyText = String(emptyValue ?? 0);
	const result: RouteSlotValue[] = [];
	const seen = new Set<string>();
	for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
		const rawValue = arrayValue[slotIndex];
		if (rawValue === null || rawValue === undefined || String(rawValue) === emptyText) continue;
		const palletId = String(rawValue).trim();
		if (!palletId || seen.has(palletId)) continue;
		seen.add(palletId);
		result.push({
			palletId,
			slotIndex,
			slotCount,
			progress: slotCount <= 1 ? 0 : slotIndex / (slotCount - 1),
			rawValue,
		});
	}
	return result;
};

export const routeSlotProgress = (slotIndex: number, slotCount: number, loop: boolean) => {
	if (slotCount <= 1) return 0;
	return loop ? slotIndex / slotCount : slotIndex / (slotCount - 1);
};
