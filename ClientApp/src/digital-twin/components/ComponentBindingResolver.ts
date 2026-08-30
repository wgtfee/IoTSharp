import type { TwinProcessDefinition, TwinRoutePointDefinition, TwinSceneManifest } from '/@/digital-twin/contracts';
import type { TwinV7SceneObjectDefinition } from '/@/digital-twin/contracts/v7-components';
import { getBuiltInComponentTemplate } from './BuiltInComponentCatalog';
import type { TwinComponentBindingSlot } from './types';

const processBindingProperty: Partial<Record<TwinComponentBindingSlot['semantic'], keyof TwinProcessDefinition>> = {
	ready: 'readyBindingId',
	busy: 'busyBindingId',
	complete: 'completeBindingId',
	result: 'resultBindingId',
	fault: 'faultBindingId',
};

export interface TwinResolvedComponentBindingSlot extends TwinComponentBindingSlot {
	bindingId?: string;
	bindingExists: boolean;
}

export const resolveComponentBindingSlots = (
	manifest: TwinSceneManifest,
	object: TwinV7SceneObjectDefinition,
): TwinResolvedComponentBindingSlot[] => {
	if (object.kind !== 'component' || !object.component?.componentType) return [];
	const template = getBuiltInComponentTemplate(object.component.resourceKey);
	const bindingIds = new Set(manifest.bindings.map((binding) => binding.bindingId));
	return (template?.bindingSlots || []).map((slot) => {
		const bindingId = object.component.bindings?.[slot.slotId];
		return { ...slot, bindingId, bindingExists: Boolean(bindingId && bindingIds.has(bindingId)) };
	});
};

/** Smart Model 工艺节点从 Slot 映射继承 PLC BindingId；未配置 Slot 时保持仿真节拍。 */
export const buildComponentProcessDefinition = (
	manifest: TwinSceneManifest,
	object: TwinV7SceneObjectDefinition,
	type: TwinProcessDefinition['type'],
): TwinProcessDefinition => {
	const cycleSeconds = Math.max(0.1, Number(object.component?.properties?.cycleSeconds) || 2);
	const process: TwinProcessDefinition = { type, cycleSeconds };
	for (const slot of resolveComponentBindingSlots(manifest, object)) {
		const property = processBindingProperty[slot.semantic];
		if (property && slot.bindingExists && slot.bindingId) (process as Record<string, unknown>)[property] = slot.bindingId;
	}
	const timeoutSeconds = Number(object.component?.properties?.processTimeoutSeconds);
	if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) process.timeoutSeconds = timeoutSeconds;
	return process;
};

/** 分流器 Slot 使用既有 RoutePoint 执行器/传感器合同，继续遵循 PLC 决定目标、Runtime 决定是否放行。 */
export const applyComponentRoutePointBindings = (
	manifest: TwinSceneManifest,
	object: TwinV7SceneObjectDefinition,
	point: TwinRoutePointDefinition,
) => {
	const slots = new Map(resolveComponentBindingSlots(manifest, object).filter((slot) => slot.bindingExists).map((slot) => [slot.slotId, slot.bindingId!]));
	if (object.component?.componentType === 'diverter-conveyor' && point.kind === 'diverter') {
		point.sensorBindingId = slots.get('routeCode');
		point.actuatorBindingId = slots.get('inPosition') || slots.get('actualPosition');
		if (point.sensorBindingId || point.actuatorBindingId) point.decisionMode = 'plc';
	}
	if (object.component?.componentType === 'lift') {
		point.sensorBindingId = slots.get('currentFloor');
		point.actuatorBindingId = slots.get('inPosition') || slots.get('actualPosition');
	}
	if (object.component?.componentType === 'turntable') {
		point.sensorBindingId = slots.get('actualAngle');
		point.actuatorBindingId = slots.get('inPosition') || slots.get('actualPosition');
	}
};
