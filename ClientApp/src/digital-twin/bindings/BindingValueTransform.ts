import type { TwinObjectBindingDefinition } from '../contracts';

/** PLC 常见布尔字符串必须按值解释，不能把 "false" 当作真。 */
export const telemetryBoolean = (value: unknown): boolean => {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['false', '0', 'off', 'stopped', ''].includes(normalized)) return false;
		if (['true', '1', 'on', 'running'].includes(normalized)) return true;
	}
	return Boolean(value);
};

/** 2D/3D 共用的声明式绑定转换，不执行场景提交的脚本。 */
export const transformTwinBindingValue = (binding: TwinObjectBindingDefinition, value: unknown): unknown => {
	const config = binding.transform as Record<string, any>;
	switch (config.kind) {
		case 'booleanVisibility': return telemetryBoolean(value);
		case 'booleanColor': return telemetryBoolean(value) ? config.trueColor || '#22c55e' : config.falseColor || '#ef4444';
		case 'rangeColor': {
			const number = Number(value);
			const stops = Array.isArray(config.stops) ? [...config.stops].sort((left, right) => Number(left.max) - Number(right.max)) : [];
			return stops.find(stop => number <= Number(stop.max))?.color || config.defaultColor || '#38bdf8';
		}
		case 'numberScale':
		case 'numberRotation': return Math.min(Number(config.max ?? Infinity), Math.max(Number(config.min ?? -Infinity), Number(value) * Number(config.factor ?? 1)));
		case 'enumMap': return config.map?.[String(value)] ?? config.defaultValue ?? value;
		case 'formatText': return String(config.template || '{value}').replace('{value}', String(value ?? ''));
		case 'alarmSeverityStyle': {
			const severity = typeof value === 'object' && value ? String((value as Record<string, unknown>).severity ?? '') : String(value ?? '');
			return config.map?.[severity] ?? config.defaultColor ?? '#f59e0b';
		}
		case 'booleanAnimation': return telemetryBoolean(value) ? Number(config.trueValue?.speed ?? 1) : Number(config.falseValue?.speed ?? 0);
		case 'routeProgress':
		case 'routeDistance': return Number(value) * Number(config.factor ?? 1) + Number(config.offset ?? 0);
		default: return value;
	}
};
