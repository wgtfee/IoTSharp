/**
 * 2D 场景数据属于纯 JSON 合约。Vue 会把编辑中的对象包装成 Proxy，
 * 浏览器 structuredClone 不能直接克隆这些 Proxy，因此所有历史快照、
 * 拖动起始状态和保存载荷统一经过 JSON 快照转换。
 */
export const cloneTwin2DState = <T>(value: T): T => {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? value : JSON.parse(serialized) as T;
};
