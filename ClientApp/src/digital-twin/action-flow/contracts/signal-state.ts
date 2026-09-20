/** 未知值不能用于安全放行；尤其不能把缺失/过期值当成 false。 */
export const isKnownSignal = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'number' && !Number.isFinite(value));
export function signalBoolean(value: unknown): boolean | undefined {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'true' || normalized === '1') return true;
		if (normalized === 'false' || normalized === '0') return false;
	}
	return undefined;
}
/** 外部绑定及物料/工位反馈不属于可写流程变量。 */
export function isReadOnlyStateRef(ref: string, bindingIds: Iterable<string> = []) {
	const key = ref.trim();
	return key.startsWith('material/') || key.startsWith('binding:') || key.startsWith('station.') || [...bindingIds].includes(key);
}
